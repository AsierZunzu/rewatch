import { screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import App from './App'
import i18n from './i18n'
import type { User } from './api/types'
import { mockApi, renderWithProviders, route } from './test/render'

const me = (overrides: Partial<User> = {}): User =>
  ({
    id: 1,
    username: 'alice',
    email: 'alice@example.test',
    emailVerified: true,
    language: 'en',
    timezone: 'UTC',
    isAdmin: false,
    blocked: false,
    verifyDeadline: null,
    createdAt: '2025-01-01T00:00:00Z',
    ...overrides,
  }) as User

const emptyHome = [
  route('GET', '/api/watchlist', { body: { shows: [], movies: [], archivedMovies: [] } }),
  route('GET', '/api/legal-info', { body: { host: null, contact: null } }),
]

describe('App routing', () => {
  it('sends a visitor without a session to the login screen', async () => {
    mockApi(route('GET', '/api/auth/me', { status: 401, body: { error: 'unauthorized' } }), ...emptyHome)
    renderWithProviders(<App />, { route: '/stats' })
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/login'))
    expect(screen.getByRole('button', { name: 'Log in' })).toBeInTheDocument()
  })

  it('shows the verification gate to a blocked account', async () => {
    mockApi(route('GET', '/api/auth/me', { body: me({ blocked: true, emailVerified: false }) }), ...emptyHome)
    renderWithProviders(<App />, { route: '/' })
    expect(await screen.findByText('Verify your email to continue')).toBeInTheDocument()
  })

  it('lets a signed-in user into the app', async () => {
    mockApi(route('GET', '/api/auth/me', { body: me() }), ...emptyHome)
    renderWithProviders(<App />, { route: '/' })
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Log in' })).not.toBeInTheDocument())
    expect(screen.getByTestId('location')).toHaveTextContent(/^\/$/)
  })

  it('switches the UI to the account language', async () => {
    mockApi(route('GET', '/api/auth/me', { body: me({ language: 'fr' }) }), ...emptyHome)
    renderWithProviders(<App />, { route: '/' })
    await waitFor(() => expect(i18n.language).toBe('fr'))
    expect(document.documentElement.lang).toBe('fr')
  })

  it('redirects unknown paths home', async () => {
    mockApi(route('GET', '/api/auth/me', { body: me() }), ...emptyHome)
    renderWithProviders(<App />, { route: '/no/such/page' })
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent(/^\/$/))
  })
})
