import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { bodyOf, mockApi, renderWithProviders, route } from '../test/render'
import Login from './Login'

const legalInfo = route('GET', '/api/legal-info', { body: { host: null, contact: null } })
const methods = (password = true, oidc = { enabled: false, label: '' }) => route('GET', '/api/auth/methods', { body: { password, oidc } })
/** What every Login render fetches: legal info and the sign-in methods (password only). */
const legal = (url: string, init?: RequestInit) => legalInfo(url, init) ?? methods()(url, init)

const renderLogin = (route = '/login') => {
  const user = userEvent.setup()
  renderWithProviders(<Login />, { route })
  return user
}

describe('Login screen', () => {
  it('logs in and goes home', async () => {
    const fetchMock = mockApi(legal, route('POST', '/api/auth/login', { body: { id: 1 } }))
    const user = renderLogin()

    const submit = screen.getByRole('button', { name: 'Log in' })
    expect(submit).toBeDisabled()
    await user.type(screen.getByPlaceholderText('Username'), 'alice')
    await user.type(screen.getByPlaceholderText('Password'), 'correct-horse')
    await user.click(submit)

    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent(/^\/$/))
    const login = fetchMock.mock.calls.find(([url]) => url === '/api/auth/login')!
    expect(bodyOf(login[1])).toEqual({ username: 'alice', password: 'correct-horse' })
  })

  it.each([
    [401, 'invalid_credentials', 'Invalid credentials'],
    [429, 'http_429', 'Too many attempts — try again in a minute'],
    [400, 'invalid_input', 'Username 3-30 chars (letters, digits, _ . -), valid email, password 8 chars minimum'],
  ])('explains a %i (%s)', async (status, error, message) => {
    mockApi(legal, route('POST', '/api/auth/login', { status, body: { error } }))
    const user = renderLogin()
    await user.type(screen.getByPlaceholderText('Username'), 'alice')
    await user.type(screen.getByPlaceholderText('Password'), 'whatever1')
    await user.click(screen.getByRole('button', { name: 'Log in' }))
    expect(await screen.findByText(message)).toBeInTheDocument()
    expect(screen.getByTestId('location')).toHaveTextContent('/login')
  })

  it('registers with the browser language and timezone', async () => {
    const fetchMock = mockApi(legal, route('POST', '/api/auth/register', { status: 201, body: { id: 1 } }))
    const user = renderLogin()
    await user.click(screen.getByRole('button', { name: 'Create an account' }))

    await user.type(screen.getByPlaceholderText('Username'), 'bob')
    await user.type(screen.getByPlaceholderText('Email address'), 'bob@example.test')
    await user.type(screen.getByPlaceholderText('Password'), 'password123')
    await user.type(screen.getByPlaceholderText('Confirm password'), 'password123')
    await user.click(screen.getByRole('button', { name: "Let's go" }))

    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent(/^\/$/))
    const register = fetchMock.mock.calls.find(([url]) => url === '/api/auth/register')!
    expect(bodyOf(register[1])).toEqual({
      username: 'bob',
      email: 'bob@example.test',
      password: 'password123',
      language: 'en',
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    })
  })

  it('catches a password typo before calling the API', async () => {
    const fetchMock = mockApi(legal)
    const user = renderLogin()
    await user.click(screen.getByRole('button', { name: 'Create an account' }))
    await user.type(screen.getByPlaceholderText('Username'), 'bob')
    await user.type(screen.getByPlaceholderText('Email address'), 'bob@example.test')
    await user.type(screen.getByPlaceholderText('Password'), 'password123')
    await user.type(screen.getByPlaceholderText('Confirm password'), 'password124')
    await user.click(screen.getByRole('button', { name: "Let's go" }))

    expect(await screen.findByText("Passwords don't match")).toBeInTheDocument()
    expect(fetchMock.mock.calls.some(([url]) => url === '/api/auth/register')).toBe(false)
  })

  it.each([
    ['username_taken', 'This username is already taken'],
    ['email_taken', 'An account already exists with this address'],
    ['registration_closed', 'Signups are closed on this instance'],
  ])('explains a %s signup refusal', async (error, message) => {
    mockApi(legal, route('POST', '/api/auth/register', { status: 409, body: { error } }))
    const user = renderLogin()
    await user.click(screen.getByRole('button', { name: 'Create an account' }))
    await user.type(screen.getByPlaceholderText('Username'), 'bob')
    await user.type(screen.getByPlaceholderText('Email address'), 'bob@example.test')
    await user.type(screen.getByPlaceholderText('Password'), 'password123')
    await user.type(screen.getByPlaceholderText('Confirm password'), 'password123')
    await user.click(screen.getByRole('button', { name: "Let's go" }))
    expect(await screen.findByText(message)).toBeInTheDocument()
  })

  it('sends a reset link from the forgot-password mode', async () => {
    const fetchMock = mockApi(legal, route('POST', '/api/auth/forgot', { body: { ok: true } }))
    const user = renderLogin()
    await user.click(screen.getByRole('button', { name: 'Forgot password?' }))
    expect(screen.queryByPlaceholderText('Password')).not.toBeInTheDocument()

    await user.type(screen.getByPlaceholderText('Email address'), 'me@example.test')
    await user.click(screen.getByRole('button', { name: 'Send the link' }))

    expect(await screen.findByText(/a reset email is on its way/)).toBeInTheDocument()
    const forgot = fetchMock.mock.calls.find(([url]) => url === '/api/auth/forgot')!
    expect(bodyOf(forgot[1])).toEqual({ email: 'me@example.test' })
  })

  it('shows a network error when the API is unreachable', async () => {
    mockApi(legal, (url) => {
      if (url === '/api/auth/login') throw new TypeError('Failed to fetch')
      return undefined
    })
    const user = renderLogin()
    await user.type(screen.getByPlaceholderText('Username'), 'alice')
    await user.type(screen.getByPlaceholderText('Password'), 'password123')
    await user.click(screen.getByRole('button', { name: 'Log in' }))
    expect(await screen.findByText('Network error')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Log in' })).toBeEnabled()
    expect(screen.getByTestId('location')).toHaveTextContent('/login')
  })

  it('links the legal page only when the operator filled it in', async () => {
    mockApi(route('GET', '/api/legal-info', { body: { host: 'Jane Doe', contact: null } }), methods())
    renderLogin()
    expect(await screen.findByRole('link', { name: /legal|Legal/ })).toHaveAttribute('href', '/legal')
  })

  it('offers single sign-on when the instance has it', async () => {
    mockApi(legalInfo, methods(true, { enabled: true, label: 'Authentik' }))
    renderLogin()
    const sso = await screen.findByRole('link', { name: 'Continue with Authentik' })
    expect(sso.getAttribute('href')).toMatch(/^\/api\/auth\/oidc\/start\?lang=en&tz=/)
    expect(screen.getByPlaceholderText('Password')).toBeInTheDocument()
  })

  it('hides the password form when only single sign-on is allowed', async () => {
    mockApi(legalInfo, methods(false, { enabled: true, label: 'Authentik' }))
    renderLogin()
    expect(await screen.findByRole('link', { name: 'Continue with Authentik' })).toBeInTheDocument()
    expect(screen.queryByPlaceholderText('Password')).not.toBeInTheDocument()
  })

  it.each([
    ['oidc_cancelled', 'Sign-in was cancelled.'],
    ['something_unknown', 'Single sign-on failed. Try again.'],
  ])('explains an OIDC callback error (%s)', async (code, message) => {
    mockApi(legal)
    renderLogin(`/login?error=${code}`)
    expect(await screen.findByText(message)).toBeInTheDocument()
  })

  it('explains that password login is disabled', async () => {
    mockApi(legal, route('POST', '/api/auth/login', { status: 403, body: { error: 'password_login_disabled' } }))
    const user = renderLogin()
    await user.type(screen.getByPlaceholderText('Username'), 'alice')
    await user.type(screen.getByPlaceholderText('Password'), 'password123')
    await user.click(screen.getByRole('button', { name: 'Log in' }))
    expect(await screen.findByText('Password sign-in is disabled on this instance')).toBeInTheDocument()
  })
})
