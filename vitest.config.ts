import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

/**
 * Deliberately separate from `vite.config.ts`: the app build carries two rollup
 * entries (the main window and the mini player) that mean nothing to the tests,
 * and a test-only change should not be able to break the app build.
 *
 * `node` is environment enough - every test here targets a pure function, so
 * nothing needs a DOM. The React plugin is still required because
 * `state/settings.tsx` contains JSX.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
  },
})
