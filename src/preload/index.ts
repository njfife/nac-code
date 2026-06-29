import { contextBridge } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

// The ONLY surface the renderer can reach. Privileged capabilities (AgentRuntime, CliRegistry,
// PlatformServices, persistence, ...) get added here as typed, allowlisted IPC channels — never
// raw Node access in the renderer.
const api = {
  version: (): string => process.versions.electron
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
