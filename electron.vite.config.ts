import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: { index: resolve(__dirname, 'src/main/index.ts') } } }
  },
  preload: {
    // A sandbox:true preload cannot require node_modules at runtime, so @electron-toolkit/preload
    // must be bundled into the preload (not externalized). `electron` stays external (always available).
    plugins: [externalizeDepsPlugin({ exclude: ['@electron-toolkit/preload'] })],
    build: { rollupOptions: { input: { index: resolve(__dirname, 'src/preload/index.ts') } } }
  },
  renderer: {
    resolve: { alias: { '@renderer': resolve(__dirname, 'src/renderer/src') } },
    plugins: [react()]
  }
})
