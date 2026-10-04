import { afterEach, describe, expect, it, vi } from 'vitest'

import { ApiError, NETWORK_ERROR_MESSAGE, artifactUrl, processIdCard } from './api'
import { makeProcessingResult, stubFailingFetch } from '../test/fixtures'

/**
 * The API client (§19).
 *
 * The behaviour worth protecting here is not that `fetch` works — it is what
 * reaches the screen when it does not, and what is deliberately kept out of the
 * browser. A raw status line or a JSON body in the verification UI is a §24/§28
 * violation, so the failure paths get the same attention as the happy one.
 */

/** A `fetch` that answers 200 with the given payload. */
function stubOkFetch(payload: unknown = makeProcessingResult()) {
  const mock = vi.fn(() =>
    Promise.resolve(
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ),
  )
  vi.stubGlobal('fetch', mock)
  return mock
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('processIdCard', () => {
  it('posts the file as multipart under the field name `document`', async () => {
    const fetchMock = stubOkFetch()
    const file = new File(['x'], 'card.jpg', { type: 'image/jpeg' })

    await processIdCard(file)

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/v1/kyc/id-card/process')
    expect(init.method).toBe('POST')
    expect((init.body as FormData).get('document')).toBe(file)
  })

  it('lets the browser set the multipart boundary', async () => {
    const fetchMock = stubOkFetch()

    await processIdCard(new File(['x'], 'card.jpg', { type: 'image/jpeg' }))

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    // A hand-written Content-Type here would omit the boundary and the server
    // would see a truncated body.
    expect(init.headers).toBeUndefined()
  })

  it('returns the parsed result unchanged', async () => {
    const payload = makeProcessingResult()
    stubOkFetch(payload)

    await expect(processIdCard(new File(['x'], 'card.jpg'))).resolves.toEqual(payload)
  })

  it('surfaces the server sentence rather than the status line', async () => {
    stubFailingFetch(
      'IMAGE_TOO_LOW_RESOLUTION',
      'Image is too small. Minimum resolution is 640 × 480 pixels.',
    )

    const error = (await processIdCard(new File(['x'], 'card.jpg')).catch(
      (e: unknown) => e,
    )) as ApiError

    expect(error).toBeInstanceOf(ApiError)
    expect(error.code).toBe('IMAGE_TOO_LOW_RESOLUTION')
    expect(error.message).toBe('Image is too small. Minimum resolution is 640 × 480 pixels.')
    expect(error.message).not.toContain('422')
    expect(error.requestId).toBe('req_abc123')
  })

  it('falls back to a plain sentence when the body is not our envelope', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(new Response('<html>502 Bad Gateway</html>', { status: 502 })),
    )
    vi.stubGlobal('fetch', fetchMock)

    const error = (await processIdCard(new File(['x'], 'card.jpg')).catch(
      (e: unknown) => e,
    )) as ApiError

    expect(error.message).not.toContain('<html>')
    expect(error.message).not.toContain('502')
    expect(error.status).toBe(502)
  })

  it('reports an unreachable server as a network problem, not a rejection', async () => {
    const fetchMock = vi.fn(() => Promise.reject(new TypeError('Failed to fetch')))
    vi.stubGlobal('fetch', fetchMock)

    const error = (await processIdCard(new File(['x'], 'card.jpg')).catch(
      (e: unknown) => e,
    )) as ApiError

    expect(error.code).toBe('NETWORK_ERROR')
    expect(error.message).toBe(NETWORK_ERROR_MESSAGE)
  })
})

describe('artifactUrl', () => {
  it('dereferences an opaque handle through the artefact endpoint', () => {
    expect(artifactUrl('art_0123456789abcdef0123456789abcdef')).toBe(
      '/api/v1/kyc/artifacts/art_0123456789abcdef0123456789abcdef',
    )
  })

  it('encodes the handle so it cannot escape the path', () => {
    expect(artifactUrl('../../secret')).toBe('/api/v1/kyc/artifacts/..%2F..%2Fsecret')
  })

  it('never points the browser at a CamDX host (§30)', () => {
    // The base is our own origin or empty; there is no upstream to reach.
    expect(artifactUrl('art_abc')).toMatch(/^(\/|[^:]*:\/\/localhost)/)
  })
})