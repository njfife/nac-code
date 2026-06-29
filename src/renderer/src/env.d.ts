/// <reference types="vite/client" />
import type { ElectronAPI } from '@electron-toolkit/preload'
import type { NacApi } from '../../preload/index'

declare global {
  interface Window {
    electron: ElectronAPI
    nac: NacApi
  }
}
