import { createHash, randomBytes } from 'node:crypto'
import argon2 from 'argon2'
import type { FastifyInstance, InjectOptions } from 'fastify'
import { vi } from 'vitest'
import { buildApp } from '../../src/app.js'
import { prisma } from '../../src/lib/prisma.js'
import { loadSettings } from '../../src/lib/settings.js'

/** Empties every table (keeps the schema and the migration history). */
export async function resetDb() {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
  `
  if (tables.length > 0) {
    await prisma.$executeRawUnsafe(
      `TRUNCATE ${tables.map((t) => `"public"."${t.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`,
    )
  }
  // The settings cache outlives the rows it was loaded from.
  await loadSettings()
}

export async function startApp() {
  const app = await buildApp({ logger: false })
  await app.ready()
  return app
}

// ——— Outbound HTTP ———
//
// No test may reach a real API. Every fetch goes through this handler, which
// answers 404 unless a test registered a route for the URL. A 404 is what the
// TVmaze and Trakt clients read as "this show isn't carried", so the default is
// the quiet, deterministic outcome.

type FetchHandler = (url: URL, init?: RequestInit) => Response | Promise<Response> | undefined
const fetchHandlers: FetchHandler[] = []
export const fetchCalls: string[] = []

export function installFakeFetch() {
  fetchHandlers.length = 0
  fetchCalls.length = 0
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    fetchCalls.push(url.toString())
    for (const handler of fetchHandlers) {
      const res = await handler(url, init)
      if (res) return res
    }
    return new Response('not found', { status: 404 })
  })
}

export const onFetch = (handler: FetchHandler) => void fetchHandlers.push(handler)
export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

// ——— Users & sessions ———

let userSeq = 0

type UserOptions = {
  username?: string
  email?: string | null
  password?: string
  isAdmin?: boolean
  verified?: boolean
  language?: string
  timezone?: string
  createdAt?: Date
}

/**
 * Creates a user straight in the database plus a live session, bypassing the
 * register route (and its 5-per-minute rate limit). The returned `cookie` header
 * authenticates `call()` requests as that user.
 */
export async function createUser(opts: UserOptions = {}) {
  userSeq++
  const username = opts.username ?? `user${userSeq}`
  const password = opts.password ?? 'password123'
  const user = await prisma.user.create({
    data: {
      username,
      email: opts.email === undefined ? `${username}@example.test` : opts.email,
      emailVerifiedAt: opts.verified === false ? null : new Date(),
      passwordHash: await argon2.hash(password),
      isAdmin: opts.isAdmin ?? false,
      language: opts.language ?? 'en',
      timezone: opts.timezone ?? 'UTC',
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
    },
  })
  const token = randomBytes(32).toString('hex')
  await prisma.session.create({
    data: {
      id: createHash('sha256').update(token).digest('hex'),
      userId: user.id,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    },
  })
  return { user, password, cookie: `rewatch_session=${token}` }
}

// ——— Requests ———

let ipSeq = 0

type CallOptions = {
  cookie?: string
  body?: unknown
  /** Fixed client IP. Left out, every request gets its own, so the per-IP rate
   *  limits never trip unless a test means them to. */
  ip?: string
  headers?: Record<string, string>
}

export async function call(app: FastifyInstance, method: InjectOptions['method'], url: string, opts: CallOptions = {}) {
  ipSeq++
  const res = await app.inject({
    method,
    url,
    headers: {
      'x-forwarded-for': opts.ip ?? `10.${(ipSeq >> 16) & 255}.${(ipSeq >> 8) & 255}.${ipSeq & 255}`,
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
      ...opts.headers,
    },
    ...(opts.body !== undefined ? { payload: opts.body as InjectOptions['payload'] } : {}),
  })
  return Object.assign(res, { body: res.body, data: safeJson(res.body) })
}

function safeJson(body: string): any {
  try {
    return JSON.parse(body)
  } catch {
    return undefined
  }
}

/** A multipart/form-data body carrying one file, the way the import screen sends it. */
export function multipartFile(filename: string, content: Buffer, contentType = 'application/octet-stream') {
  const boundary = `----rewatch-test-${randomBytes(8).toString('hex')}`
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
    ),
    content,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ])
  return { payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } }
}

/** Import jobs run fire-and-forget; poll until one settles. */
export async function waitForJob(jobId: number, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const job = await prisma.importJob.findUniqueOrThrow({ where: { id: jobId } })
    if (job.status !== 'RUNNING') return job
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`import job ${jobId} still RUNNING after ${timeoutMs}ms`)
}

/** Lets fire-and-forget work (Trakt mirror, emails) settle before asserting. */
export const flush = () => new Promise((r) => setTimeout(r, 20))

export const daysFromNow = (days: number) => new Date(Date.now() + days * 24 * 60 * 60 * 1000)
/** "YYYY-MM-DD", `days` from today in UTC. */
export const isoDay = (days: number) => daysFromNow(days).toISOString().slice(0, 10)
