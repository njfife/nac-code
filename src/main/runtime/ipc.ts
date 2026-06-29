import { app, ipcMain, type BrowserWindow } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { RUN_CHANNELS, type RunRequest, type AgentEvent } from '../../shared/runtime'
import { startHarnessRun, type HarnessRun } from './harnessRunner'
import { startClaudeRun } from './claudeAdapter'

const runs = new Map<string, HarnessRun>()
let counter = 0

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
        ? startClaudeRun(runId, { prompt: req.prompt }, handler)
        : startHarnessRun(
            runId,
            {
              prompt: req.prompt,
              command: process.execPath,
              args: [stubHarnessPath(), req.prompt],
              env: { ELECTRON_RUN_AS_NODE: '1' } // run the .mjs with Electron's bundled Node
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
}
