import { afterEach, describe, expect, it, vi } from 'vitest'

import { fetchIntegrationSettings, postToCore, saveIntegrationSettings } from './api'
import type { ApiError } from './api'
import { bodyOf, makeVerifyResult } from '../test/fixtures'

/**
 * The integration client (D19): settings round-trip as one replace-all PUT,
 * the password travels only on the way in, and a post hands the server the
 * verification result as `{ payload }` — the shape the endpoint replays.
 */

function stubJson(payload: unknown, status = 200) {
  const mock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
    Promise.resolve(
      new Response(JSON.stringify(payload), {
        status,
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

describe('fetchIntegrationSettings', () => {
  it('gets the configured systems without ever asking for a password', async () => {
    const fetchMock = stubJson({
      settings: [{ id: 'set_1', url: 'https://core.example/post', apiUser: 'svc_camdx' }],
    })

    const settings = await fetchIntegrationSettings()

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/v1/integrations/settings')
    expect(settings).toEqual([
      { id: 'set_1', url: 'https://core.example/post', apiUser: 'svc_camdx' },
    ])
  })
})

describe('saveIntegrationSettings', () => {
  it('replaces the whole list in one PUT', async () => {
    const fetchMock = stubJson({ settings: [] })

    await saveIntegrationSettings([
      { id: null, url: 'https://a.example/post', apiUser: 'svc_a', apiPassword: 'Secret-1!' },
    ])

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/v1/integrations/settings')
    expect(init.method).toBe('PUT')
    expect(bodyOf<{ settings: unknown[] }>(fetchMock.mock.calls[0]!)).toEqual({
      settings: [
        { id: null, url: 'https://a.example/post', apiUser: 'svc_a', apiPassword: 'Secret-1!' },
      ],
    })
  })

  it('surfaces a row-level refusal with the failing field', async () => {
    stubJson(
      {
        error: {
          code: 'INVALID_REQUEST',
          message: 'Enter a full system URL, starting with http:// or https://.',
          fieldErrors: {
            'settings.0.url': 'Enter a full system URL, starting with http:// or https://.',
          },
          requestId: 'req_9',
        },
      },
      400,
    )

    const error = (await saveIntegrationSettings([{ url: 'nope', apiUser: 's', apiPassword: 'x' }]).catch(
      (cause: unknown) => cause,
    )) as ApiError

    expect(error.code).toBe('INVALID_REQUEST')
    expect(error.fieldErrors['settings.0.url']).toContain('starting with http')
  })
})

describe('postToCore', () => {
  it('sends the verification result as the payload and reports per-target outcomes', async () => {
    const fetchMock = stubJson({
      posted: ['https://core.example/post'],
      failed: [{ url: 'https://other.example/post', reason: 'The system timed out.' }],
    })
    const result = makeVerifyResult()

    const outcome = await postToCore(result)

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/v1/integrations/post')
    expect(init.method).toBe('POST')
    expect(bodyOf<{ payload: unknown }>(fetchMock.mock.calls[0]!)).toEqual({ payload: result })
    expect(outcome.posted).toEqual(['https://core.example/post'])
    expect(outcome.failed[0]?.reason).toBe('The system timed out.')
  })

  it('carries the "nothing configured" refusal through as the server sentence', async () => {
    stubJson(
      {
        error: {
          code: 'INVALID_REQUEST',
          message: 'There are no core systems configured yet. Add one in Post Settings first.',
          fieldErrors: {},
          requestId: 'req_1',
        },
      },
      400,
    )

    const error = (await postToCore(makeVerifyResult()).catch((cause: unknown) => cause)) as ApiError

    expect(error.status).toBe(400)
    expect(error.message).toContain('no core systems configured')
  })
})
