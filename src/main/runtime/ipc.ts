import { app, ipcMain, dialog, type BrowserWindow } from 'electron'
import { join, basename } from 'path'
import { is } from '@electron-toolkit/utils'
import { RUN_CHANNELS, DIALOG_CHANNELS, CHANGES_CHANNELS, FILES_CHANNELS, REGISTRY_CHANNELS, CAPABILITIES_CHANNELS, type RunRequest, type SummarizeRequest, type AgentEvent } from '../../shared/runtime'
import { renderContextText } from '../../shared/contextRender'
import { getChanges, getFileDiff, readFileForContext } from './changes'
import { startHarnessRun, type HarnessRun } from './harnessRunner'
import { startClaudeRun } from './claudeAdapter'
import { startCodexRun } from './codexAdapter'
import { startCopilotRun } from './copilotAdapter'
import { startOpenCodeRun } from './openCodeAdapter'
import { probeProviders } from './registry'
import { getCapabilities, invalidateCapabilities } from './capabilities'
import { getAgents } from './agents'
import { AGENTS_CHANNELS } from '../../shared/agents'
import { classifyModelRejection, isWorksEvidence } from './capabilities/ledger'
import { recordOutcome } from './capabilities/ledgerStore'
import { promptViaTransport, respondPermission as acpRespondPermission, cancelRun as acpCancelRun, disposeAll as acpDisposeAll } from './acp/sessionManager'

const runs = new Map<string, HarnessRun>()
let counter = 0

const SUMMARIZE_INSTRUCTION =
  'Summarize the following conversation so it can be used as context to continue it later. ' +
  'Preserve key facts, decisions, names, code, file paths, and open questions. Be concise but complete. ' +
  'Output only the summary, with no preamble.'

// Run a harness once and resolve with its full assistant text (no chat wiring) — powers compaction.
function runOnce(provider: string | undefined, prompt: string, model?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = ''
    const runId = `sum_${++counter}`
    const onEvent = (e: AgentEvent): void => {
      if (e.type === 'content.delta' && e.streamKind === 'assistant_text') text += e.text
      else if (e.type === 'run.completed') resolve(text.trim())
      else if (e.type === 'run.errored') reject(new Error(e.message))
    }
    if (provider === 'claude') startClaudeRun(runId, { prompt }, onEvent)
    else if (provider === 'codex') startCodexRun(runId, { prompt }, onEvent)
    else if (provider === 'copilot') startCopilotRun(runId, { prompt }, onEvent)
    else if (provider === 'opencode') startOpenCodeRun(runId, { prompt, model }, onEvent)
    else reject(new Error(`summarize unsupported for provider ${provider ?? 'unknown'}`))
  })
}

// Resolve the stub harness script (dev: project scripts/; packaged: resources/scripts/ — wired when we add electron-builder extraResources).
function stubHarnessPath(): string {
  return is.dev
    ? join(app.getAppPath(), 'scripts', 'stub-harness.mjs')
    : join(process.resourcesPath, 'scripts', 'stub-harness.mjs')
}

/**
 * Register the run lifecycle IPC. The renderer reaches this only through the typed preload bridge.
 * M0-7 tracer: the "harness" is a stub NDJSON streamer launched via Electron-as-Node; a real adapter
 * (ACP / app-server / SDK) slots in behind the same AgentEvent stream later.
 */
export function registerRuntimeIpc(getWindow: () => BrowserWindow | null): void {
  app.on('will-quit', () => acpDisposeAll())

  // Real app version for the status bar (was a hardcoded string) — same value electron-builder stamps.
  ipcMain.handle('app:version', () => app.getVersion())

  ipcMain.handle(RUN_CHANNELS.start, (_e, req: RunRequest): { runId: string } => {
    const runId = `run_${++counter}`
    const send = (event: AgentEvent): void => getWindow()?.webContents.send(RUN_CHANNELS.event, event)
    // ACP runs the account-default model; don't attribute ledger verdicts to the picked model
    // (pillar-1 limitation) — copilot never forwards the picker's model choice over ACP, and its
    // headless fallback is also default-model in practice, so gate the ledger off for copilot entirely.
    const ledgerModel = req.provider === 'copilot' ? undefined : req.model
    const handler = (event: AgentEvent): void => {
      send(event)
      // Gating ledger: learn per-account model verdicts from real outcomes (explicit model only).
      if (ledgerModel && req.provider) {
        if (event.type === 'run.errored' && classifyModelRejection(event.message)) {
          recordOutcome(req.provider, ledgerModel, 'gated', event.message)
          invalidateCapabilities(req.provider) // next loadCaps (picker mount) re-fetches + re-merges the ledger
        } else if (event.type === 'run.completed' && isWorksEvidence(event.stopReason, event.usage, event.modelMismatch)) recordOutcome(req.provider, ledgerModel, 'works')
      }
      if (event.type === 'run.completed' || event.type === 'run.errored') runs.delete(runId)
    }
    // One-shot fallback paths (fallback dispatch below + the NDJSON stub) don't get a PromptOpts.context
    // seam like the interactive transports do — they get a single flat prompt string, so context is
    // baked into it up front, text-rendered.
    const bakedPrompt = req.context ? renderContextText(req.context) + req.prompt : req.prompt
    if (req.provider === 'copilot' || req.provider === 'codex' || req.provider === 'claude' || req.provider === 'opencode') {
      // Interactive-first: persistent transport session; on { ok: false } fall back to the one-shot path.
      void promptViaTransport({ provider: req.provider, chatId: req.chatId ?? runId, runId, prompt: req.prompt, cwd: req.cwd, yolo: req.yolo, sessionId: req.sessionId, model: req.model, effort: req.effort, context: req.context, onEvent: handler }).then(({ ok }) => {
        if (!ok) {
          // Render-only notice (never content.delta — replay must stay clean).
          handler({ type: 'tool.updated', runId, toolCallId: `fallback_${runId}`, title: 'interactive session unavailable — ran headless', kind: 'notice', status: 'failed' })
          runs.set(
            runId,
            req.provider === 'codex'
              ? startCodexRun(runId, { prompt: bakedPrompt, cwd: req.cwd, yolo: req.yolo, sessionId: req.sessionId, effort: req.effort, model: req.model }, handler)
              : req.provider === 'claude'
                ? startClaudeRun(runId, { prompt: bakedPrompt, sessionId: req.sessionId, cwd: req.cwd, yolo: req.yolo, model: req.model, effort: req.effort, fast: req.fast }, handler)
                : req.provider === 'opencode'
                  ? startOpenCodeRun(runId, { prompt: bakedPrompt, model: req.model, cwd: req.cwd, yolo: req.yolo, sessionId: req.sessionId, variant: req.effort }, handler)
                  : startCopilotRun(runId, { prompt: bakedPrompt, cwd: req.cwd, yolo: req.yolo, sessionId: req.sessionId, effort: req.effort, model: req.model }, handler)
          )
        }
      })
      return { runId }
    }
    // Providers copilot, codex, claude, and opencode are handled above (interactive-first, with one-shot
    // fallback); the NDJSON stub covers the rest (until those adapters land).
    const run = startHarnessRun(
      runId,
      {
        prompt: bakedPrompt,
        command: process.execPath,
        args: [stubHarnessPath(), bakedPrompt],
        env: { ELECTRON_RUN_AS_NODE: '1' }, // run the .mjs with Electron's bundled Node
        cwd: req.cwd
      },
      handler
    )
    runs.set(runId, run)
    return { runId }
  })

  ipcMain.handle(RUN_CHANNELS.cancel, (_e, runId: string): void => {
    if (acpCancelRun(runId)) return // live interactive session: protocol-level stop
    runs.get(runId)?.cancel()
    runs.delete(runId)
  })

  ipcMain.handle(RUN_CHANNELS.respondPermission, (_e, runId: string, requestId: string, optionId: string) => acpRespondPermission(runId, requestId, optionId))

  ipcMain.handle(RUN_CHANNELS.summarize, async (_e, req: SummarizeRequest): Promise<{ summary: string }> => {
    const summary = await runOnce(req.provider, `${SUMMARIZE_INSTRUCTION}\n\n${req.text}`, req.model)
    return { summary }
  })

  // Native folder picker for binding a workspace to a project directory.
  ipcMain.handle(DIALOG_CHANNELS.pickDirectory, async (): Promise<{ path: string; name: string } | null> => {
    const win = getWindow()
    const opts: Electron.OpenDialogOptions = { properties: ['openDirectory', 'createDirectory'] }
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (res.canceled || res.filePaths.length === 0) return null
    return { path: res.filePaths[0], name: basename(res.filePaths[0]) }
  })

  // Live CLI detection for the provider-first model picker (CliRegistry v0).
  ipcMain.handle(REGISTRY_CHANNELS.providers, () => probeProviders())

  // Per-account capability discovery (M4): live model/effort data with a static floor.
  ipcMain.handle(CAPABILITIES_CHANNELS.get, (_e, provider: string, refresh?: boolean) => getCapabilities(provider, refresh === true))

  // Harness-native agent discovery (agent picker): per-provider scan/exec with a static floor.
  ipcMain.handle(AGENTS_CHANNELS.get, (_e, provider: string, cwd?: string, refresh?: boolean) => getAgents(provider, cwd, refresh === true))

  // Real working-tree changes (git) for a workspace.
  ipcMain.handle(CHANGES_CHANNELS.get, (_e, cwd: string) => getChanges(cwd))
  ipcMain.handle(CHANGES_CHANNELS.diff, (_e, cwd: string, file: string) => getFileDiff(cwd, file))

  // File picker + read, for attaching real files to a chat's context.
  ipcMain.handle(DIALOG_CHANNELS.pickFile, async (): Promise<{ path: string; name: string } | null> => {
    const win = getWindow()
    const opts: Electron.OpenDialogOptions = { properties: ['openFile'] }
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (res.canceled || res.filePaths.length === 0) return null
    return { path: res.filePaths[0], name: basename(res.filePaths[0]) }
  })
  ipcMain.handle(FILES_CHANNELS.read, (_e, path: string): Promise<string | null> => readFileForContext(path))
}
