import { app, ipcMain, dialog, type BrowserWindow } from 'electron'
import { join, basename } from 'path'
import { is } from '@electron-toolkit/utils'
import { RUN_CHANNELS, DIALOG_CHANNELS, DISCOVERY_CHANNELS, CHANGES_CHANNELS, FILES_CHANNELS, type RunRequest, type SummarizeRequest, type AgentEvent } from '../../shared/runtime'
import { discoverModels } from './discovery'
import { getChanges, getFileDiff, readFileForContext } from './changes'
import { startHarnessRun, type HarnessRun } from './harnessRunner'
import { startClaudeRun } from './claudeAdapter'
import { startCodexRun } from './codexAdapter'
import { startCopilotRun } from './copilotAdapter'
import { startOpenCodeRun } from './openCodeAdapter'

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
  ipcMain.handle(RUN_CHANNELS.start, (_e, req: RunRequest): { runId: string } => {
    const runId = `run_${++counter}`
    const send = (event: AgentEvent): void => getWindow()?.webContents.send(RUN_CHANNELS.event, event)
    const handler = (event: AgentEvent): void => {
      send(event)
      if (event.type === 'run.completed' || event.type === 'run.errored') runs.delete(runId)
    }
    // Real Claude adapter for provider 'claude'; the NDJSON stub for the rest (until those adapters land).
    const run =
      req.provider === 'claude'
        ? startClaudeRun(runId, { prompt: req.prompt, sessionId: req.sessionId, cwd: req.cwd, yolo: req.yolo, model: req.model }, handler)
        : req.provider === 'codex'
          ? startCodexRun(runId, { prompt: req.prompt, cwd: req.cwd, yolo: req.yolo, sessionId: req.sessionId }, handler)
          : req.provider === 'copilot'
            ? startCopilotRun(runId, { prompt: req.prompt, cwd: req.cwd, yolo: req.yolo, sessionId: req.sessionId }, handler)
            : req.provider === 'opencode'
              ? startOpenCodeRun(runId, { prompt: req.prompt, model: req.model, cwd: req.cwd, yolo: req.yolo, sessionId: req.sessionId }, handler)
              : startHarnessRun(
            runId,
            {
              prompt: req.prompt,
              command: process.execPath,
              args: [stubHarnessPath(), req.prompt],
              env: { ELECTRON_RUN_AS_NODE: '1' }, // run the .mjs with Electron's bundled Node
              cwd: req.cwd
            },
            handler
          )
    runs.set(runId, run)
    return { runId }
  })

  ipcMain.handle(RUN_CHANNELS.cancel, (_e, runId: string): void => {
    runs.get(runId)?.cancel()
    runs.delete(runId)
  })

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

  // Live model discovery (OpenCode only — reflects the account's real configured models).
  ipcMain.handle(DISCOVERY_CHANNELS.models, (_e, provider: string): Promise<string[]> => discoverModels(provider))

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
  ipcMain.handle(FILES_CHANNELS.read, (_e, path: string): Promise<string> => readFileForContext(path))
}
