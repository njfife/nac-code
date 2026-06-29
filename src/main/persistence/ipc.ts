import { ipcMain } from 'electron'
import { STATE_CHANNELS } from '../../shared/runtime'
import { loadPersistedState, savePersistedState } from './store'

// The renderer reaches persistence only through the typed preload bridge.
export function registerPersistenceIpc(): void {
  ipcMain.handle(STATE_CHANNELS.load, () => loadPersistedState())
  ipcMain.handle(STATE_CHANNELS.save, (_e, data: unknown) => savePersistedState(data))
}
