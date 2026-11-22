import { describe, expect, it, vi } from 'vitest'
import { api, ApiError } from './client'

const stubFetch = (response: Response) => {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response)
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('api client', () => {
  it('sends JSON bodies with a content type and same-origin credentials', async () => {
    const fetchMock = stubFetch(new Response(JSON.stringify({ ok: true })))
    await expect(api.post('/api/x', { a: 1 })).resolves.toEqual({ ok: true })
    const [path, init] = fetchMock.mock.calls[0]!
    expect(path).toBe('/api/x')
    expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin', body: '{"a":1}', headers: { 'content-type': 'application/json' } })
  })

  it('sends FormData untouched, letting the browser set the boundary', async () => {
    const fetchMock = stubFetch(new Response('{}'))
    const form = new FormData()
    await api.post('/api/upload', form)
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ body: form, headers: undefined })
  })

  it('sends no body and no content type for a GET', async () => {
    const fetchMock = stubFetch(new Response('[]'))
    await api.get('/api/list')
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ method: 'GET', body: undefined, headers: undefined })
  })

  it('turns an error reply into an ApiError carrying the server code', async () => {
    stubFetch(new Response(JSON.stringify({ error: 'username_taken' }), { status: 409 }))
    const err = await api.post('/api/auth/register', {}).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err).toMatchObject({ status: 409, code: 'username_taken' })
  })

  it('falls back to http_<status> when the error body is not JSON', async () => {
    stubFetch(new Response('<html>Bad gateway</html>', { status: 502 }))
    await expect(api.delete('/api/x')).rejects.toMatchObject({ status: 502, code: 'http_502' })
  })
})
