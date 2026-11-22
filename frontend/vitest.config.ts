import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// Kept apart from vite.config.ts on purpose: the PWA and Tailwind plugins only
// matter for the real build and would slow every test run down.
export default defineConfig({
  plugins: [react()],
  // The i18n test reads backend/src/lib/langs.ts to check both lists agree.
  server: { fs: { allow: ['.', '../backend/src/lib'] } },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['src/test/setup.ts'],
    // Pinned so date labels and Intl output don't depend on the machine.
    env: { TZ: 'UTC' },
  },
})
