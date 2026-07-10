import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import { RUN_CHANNELS, STATE_CHANNELS, DIALOG_CHANNELS, CHANGES_CHANNELS, FILES_CHANNELS, REGISTRY_CHANNELS, CAPABILITIES_CHANNELS, type RunRequest, type SummarizeRequest, type AgentEvent, type ChangesResult, type FileDiffResult, type ProviderProbe, type ProviderCapabilities } from '../shared/runtime'

// The ONLY surface the renderer can reach. Privileged capabilities are added here as typed,
// allowlisted IPC channels — never raw Node access in the renderer.
const api = {
  version: (): string => process.versions.electron,
  app: {
    version: (): Promise<string> => ipcRenderer.invoke('app:version')
  },
  runs: {
    start: (req: RunRequest): Promise<{ runId: string }> => ipcRenderer.invoke(RUN_CHANNELS.start, req),
    cancel: (runId: string): Promise<void> => ipcRenderer.invoke(RUN_CHANNELS.cancel, runId),
    summarize: (req: SummarizeRequest): Promise<{ summary: string }> => ipcRenderer.invoke(RUN_CHANNELS.summarize, req),
    respondPermission: (runId: string, requestId: string, optionId: string): Promise<void> =>
      ipcRenderer.invoke(RUN_CHANNELS.respondPermission, runId, requestId, optionId),
    // Subscribe to streamed AgentEvents; returns an unsubscribe function.
    onEvent: (cb: (event: AgentEvent) => void): (() => void) => {
      const listener = (_e: unknown, event: AgentEvent): void => cb(event)
      ipcRenderer.on(RUN_CHANNELS.event, listener)
      return () => ipcRenderer.removeListener(RUN_CHANNELS.event, listener)
    }
  },
  state: {
    load: (): Promise<unknown> => ipcRenderer.invoke(STATE_CHANNELS.load),
    save: (data: unknown): Promise<void> => ipcRenderer.invoke(STATE_CHANNELS.save, data)
  },
  dialog: {
    pickDirectory: (): Promise<{ path: string; name: string } | null> => ipcRenderer.invoke(DIALOG_CHANNELS.pickDirectory),
    pickFile: (): Promise<{ path: string; name: string } | null> => ipcRenderer.invoke(DIALOG_CHANNELS.pickFile)
  },
  files: {
    read: (path: string): Promise<string | null> => ipcRenderer.invoke(FILES_CHANNELS.read, path)
  },
  registry: {
    providers: (): Promise<ProviderProbe[]> => ipcRenderer.invoke(REGISTRY_CHANNELS.providers)
  },
  changes: {
    get: (cwd: string): Promise<ChangesResult | null> => ipcRenderer.invoke(CHANGES_CHANNELS.get, cwd),
    diff: (cwd: string, file: string): Promise<FileDiffResult> => ipcRenderer.invoke(CHANGES_CHANNELS.diff, cwd, file)
  },
  capabilities: {
    get: (provider: string, refresh?: boolean): Promise<ProviderCapabilities> => ipcRenderer.invoke(CAPABILITIES_CHANNELS.get, provider, refresh)
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('nac', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // contextIsolation is required; this branch should never execute in production.
  // @ts-ignore — fallback only
  window.electron = electronAPI
  // @ts-ignore — fallback only
  window.nac = api
}

export type NacApi = typeof api
