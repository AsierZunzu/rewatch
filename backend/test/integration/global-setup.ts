// Brings the test database to the current schema once per run.
//
// Start one with `npm run test:db` (docker-compose.test.yml), or point
// TEST_DATABASE_URL at any Postgres you don't mind being wiped.
import { execSync } from 'node:child_process'
import { TEST_DATABASE_URL as url } from '../test-db-url.js'

export default function setup() {
  // Every test file truncates every table. Refuse anything that doesn't look
  // like a throwaway database, so a mistyped URL can't empty a real instance.
  const dbName = new URL(url).pathname.slice(1)
  if (!/test/i.test(dbName)) {
    throw new Error(`Refusing to run integration tests against "${dbName}": the database name must contain "test".`)
  }

  try {
    execSync('npx prisma migrate deploy', {
      env: { ...process.env, DATABASE_URL: url },
      stdio: 'pipe',
    })
  } catch (err) {
    const output = (err as { stderr?: Buffer; stdout?: Buffer }).stderr?.toString() || String(err)
    throw new Error(
      `Could not migrate the test database at ${url}.\n` +
        'Is it running? Start one with `npm run test:db`.\n\n' +
        output,
    )
  }
}
