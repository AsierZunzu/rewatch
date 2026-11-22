// Where the integration tests run. Matches docker-compose.test.yml; override
// with TEST_DATABASE_URL (CI points it at its own service container).
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://rewatch:rewatch@localhost:55433/rewatch_test'
