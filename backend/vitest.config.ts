import { defineConfig } from 'vitest/config'
import { TEST_DATABASE_URL } from './test/test-db-url.js'

// Two suites:
//   unit        — pure logic, no database, no network. Runs anywhere.
//   integration — the real Fastify app against a real Postgres (TEST_DATABASE_URL,
//                 see test/integration/global-setup.ts). External APIs (TMDB, TVmaze,
//                 Trakt, SMTP, Web Push) are always faked.

// Every instance setting is read from the environment first (lib/settings.ts), so
// a developer's own .env values must not leak into the tests. Empty means unset.
const blankSettings = Object.fromEntries(
  [
    'TMDB_API_TOKEN',
    'TMDB_LANGUAGE',
    'APP_URL',
    'SMTP_HOST',
    'SMTP_USER',
    'SMTP_PASS',
    'VAPID_PUBLIC_KEY',
    'VAPID_PRIVATE_KEY',
    'REGISTRATION_ENABLED',
    'LEGAL_HOST',
    'LEGAL_CONTACT',
    'TRAKT_CLIENT_ID',
    'TRAKT_CLIENT_SECRET',
    'TVMAZE_API_URL',
    'TRAKT_API_URL',
    'DAILY_JOB_AT',
  ].map((key) => [key, '']),
)

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['test/unit/**/*.test.ts'],
          environment: 'node',
          env: { ...blankSettings, DATABASE_URL: 'postgresql://unit:unit@127.0.0.1:1/unit' },
        },
      },
      {
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          environment: 'node',
          env: { ...blankSettings, DATABASE_URL: TEST_DATABASE_URL },
          globalSetup: ['test/integration/global-setup.ts'],
          // One database shared by every file: run them one at a time.
          fileParallelism: false,
          testTimeout: 20_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
})
