import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  worker: { format: 'es' },
  // The matching JSEP pair is supplied by prepare:asr; avoid a second emitted WASM copy.
  resolve: { conditions: ['onnxruntime-web-use-extern-wasm', 'module', 'browser', 'development|production'] },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  build: {
    target: 'es2022',
    sourcemap: false,
    rollupOptions: {
      // two webviews: the main window and the floating mini player.
      // without the second entry the mini player window loads an empty page.
      input: {
        main: 'index.html',
        miniPlayer: 'mini-player.html',
      },
    },
  },
})
