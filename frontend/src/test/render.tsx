// Renders a component the way main.tsx mounts the app: React Query + a router.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from '@testing-library/react'
import type { ReactElement } from 'react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { vi } from 'vitest'

/** Shows the current path, so tests can assert on navigations. */
// oxlint-disable-next-line react/only-export-components -- test helper, never hot-reloaded
function LocationProbe() {
  return <div data-testid="location">{useLocation().pathname}</div>
}

export function renderWithProviders(ui: ReactElement, { route = '/', path = '*' }: { route?: string; path?: string } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[route]}>
          <Routes>
            <Route path={path} element={ui} />
            <Route path="*" element={null} />
          </Routes>
          <LocationProbe />
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  }
}

type Reply = { status?: number; body?: unknown }
type Handler = (url: string, init?: RequestInit) => Reply | undefined

/**
 * Stubs fetch with a list of handlers; the first one returning a reply wins,
 * anything unhandled is a 404. Returns the mock so tests can inspect calls.
 */
export function mockApi(...handlers: Handler[]) {
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    for (const handler of handlers) {
      const reply = handler(url, init)
      if (reply) {
        return new Response(JSON.stringify(reply.body ?? {}), {
          status: reply.status ?? 200,
          headers: { 'content-type': 'application/json' },
        })
      }
    }
    return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/** Matches a method + path (query string ignored). */
export const route =
  (method: string, path: string, reply: Reply | ((init?: RequestInit) => Reply)): Handler =>
  (url, init) => {
    if ((init?.method ?? 'GET') !== method || new URL(url, 'http://x').pathname !== path) return undefined
    return typeof reply === 'function' ? reply(init) : reply
  }

export const bodyOf = (init?: RequestInit) => JSON.parse(String(init?.body ?? '{}'))
