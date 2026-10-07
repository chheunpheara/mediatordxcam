import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  SCREEN_MODE_CHANGED,
  displayRoomMessage,
  fetchDisplayRoom,
  readScreenMode,
  writeScreenMode,
} from './displayRoom'
import { makeLivenessLink } from '../../test/fixtures'

/**
 * The dialog's screen choice, followed by the panels: which room this browser
 * joins (the counter's standby screen or this customer's link), how that
 * choice is remembered, and the sentence each way of having no room gets.
 */

function stubFetch(payload: unknown): ReturnType<typeof vi.fn> {
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

describe('the screen this browser drives', () => {
  it('defaults to a unique link and remembers a switch to standby', () => {
    expect(readScreenMode()).toBe('unique')

    writeScreenMode('static')
    expect(readScreenMode()).toBe('static')

    writeScreenMode('unique')
    expect(readScreenMode()).toBe('unique')
  })

  it('tells every open panel to follow a switch', () => {
    const listener = vi.fn()
    window.addEventListener(SCREEN_MODE_CHANGED, listener)
    try {
      writeScreenMode('static')
    } finally {
      window.removeEventListener(SCREEN_MODE_CHANGED, listener)
    }

    expect(listener).toHaveBeenCalledTimes(1)
  })
})

describe('fetchDisplayRoom', () => {
  it('takes the standby room when that screen is chosen and in service', async () => {
    writeScreenMode('static')
    const fetchMock = stubFetch({ enabled: true, sessionId: 'sess_standby_1' })

    expect(await fetchDisplayRoom()).toEqual({
      token: 'sess_standby_1',
      mode: 'static',
      reason: null,
    })
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('liveness-page')
  })

  it('reports a switched-off standby screen instead of joining it', async () => {
    writeScreenMode('static')
    stubFetch({ enabled: false, sessionId: 'sess_standby_1' })

    expect(await fetchDisplayRoom()).toEqual({
      token: null,
      mode: 'static',
      reason: 'static-off',
    })
  })

  it('takes the in-use link by default', async () => {
    const fetchMock = stubFetch({ links: [makeLivenessLink({ token: 'sess_fixed_1' })] })

    expect(await fetchDisplayRoom()).toEqual({
      token: 'sess_fixed_1',
      mode: 'unique',
      reason: null,
    })
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('liveness-links')
  })

  it('reports no room for links that have already stopped working', async () => {
    stubFetch({
      links: [
        makeLivenessLink({ id: 'lnk_old', token: 'sess_old_1', status: 'superseded' }),
        makeLivenessLink({ id: 'lnk_gone', token: 'sess_gone_1', status: 'expired' }),
      ],
    })

    expect(await fetchDisplayRoom()).toEqual({ token: null, mode: 'unique', reason: 'no-link' })
  })
})

describe('displayRoomMessage', () => {
  it('says why there is no room, in words that fit the room asked for', () => {
    expect(displayRoomMessage('static-off')).toMatch(/standby screen is turned off/i)
    expect(displayRoomMessage('no-link')).toMatch(/no liveness link is open yet/i)
    expect(displayRoomMessage('unreachable')).toMatch(/could not reach the server/i)
  })
})
