import { afterEach, describe, expect, it, vi } from 'vitest'

import { onboardingRefusalMessage, openOnboardingSocket } from './onboardingSocket'
import type { OnboardingEnvelope } from './onboardingSocket'

/**
 * The relay socket's hand-off discipline: a command written before the
 * handshake finishes (the teller's immediate `activateLiveness`) is held and
 * flushed the moment the socket opens, never dropped — the browser refuses
 * send() while CONNECTING. Messages that arrive are parsed once and handed
 * to the caller; junk is ignored.
 */

class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static last: FakeWebSocket | null = null

  readyState = FakeWebSocket.CONNECTING
  readonly sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: ((event: { readonly code: number }) => void) | null = null
  closed = false

  constructor(readonly url: string) {
    FakeWebSocket.last = this
  }

  send(raw: string): void {
    if (this.readyState !== FakeWebSocket.OPEN) {
      throw new Error('InvalidStateError: still CONNECTING')
    }
    this.sent.push(raw)
  }

  close(): void {
    this.closed = true
    this.readyState = FakeWebSocket.CLOSED
  }

  /** Test-side: the server completed the handshake. */
  finishOpen(): void {
    this.readyState = FakeWebSocket.OPEN
    this.onopen?.()
  }

  /** Test-side: the server ended the room with a close code. */
  serverClose(code: number): void {
    this.readyState = FakeWebSocket.CLOSED
    this.onclose?.({ code })
  }
}

function open(role: 'teller' | 'customer', onMessage: (envelope: OnboardingEnvelope) => void = vi.fn()) {
  vi.stubGlobal('WebSocket', FakeWebSocket)
  return openOnboardingSocket('sess_fixed_1', role, onMessage)
}

function lastSocket(): FakeWebSocket {
  if (FakeWebSocket.last === null) throw new Error('no socket opened')
  return FakeWebSocket.last
}

afterEach(() => {
  vi.unstubAllGlobals()
  FakeWebSocket.last = null
})

describe('openOnboardingSocket', () => {
  it('connects to the session room with the declared role', () => {
    open('teller')
    expect(lastSocket().url).toBe(
      `ws://${window.location.host}/ws/onboarding/sess_fixed_1?role=teller`,
    )
  })

  it('holds a command written while CONNECTING and flushes it on open', () => {
    const socket = open('teller')

    socket.send({ type: 'activateLiveness' })
    expect(lastSocket().sent).toHaveLength(0) // browser would throw; we queued instead

    lastSocket().finishOpen()
    expect(lastSocket().sent).toEqual([JSON.stringify({ type: 'activateLiveness' })])

    socket.send({ type: 'startRecording' })
    expect(lastSocket().sent).toHaveLength(2)
  })

  it('delivers parsed envelopes to the caller and ignores junk', () => {
    const received: OnboardingEnvelope[] = []
    open('customer', (envelope) => received.push(envelope))
    lastSocket().finishOpen()

    lastSocket().onmessage?.({ data: JSON.stringify({ type: 'activateLiveness' }) })
    lastSocket().onmessage?.({ data: 'not json' })
    lastSocket().onmessage?.({ data: JSON.stringify({ nope: true }) })

    expect(received).toEqual([{ type: 'activateLiveness' }])
  })

  it('drops the queue and detaches on close', () => {
    const socket = open('teller')
    socket.send({ type: 'activateLiveness' })
    socket.close()

    expect(lastSocket().closed).toBe(true)
    expect(lastSocket().onmessage).toBeNull()
    expect(lastSocket().onclose).toBeNull()
    lastSocket().finishOpen()
    expect(lastSocket().sent).toHaveLength(0)
  })

  it('hands the server close code back to the caller', () => {
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const onClose = vi.fn()
    openOnboardingSocket('sess_fixed_1', 'customer', vi.fn(), onClose)

    lastSocket().serverClose(4410)

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledWith(4410)
  })

  it('reports nothing for a close this tab performed itself', () => {
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const onClose = vi.fn()
    const socket = openOnboardingSocket('sess_fixed_1', 'teller', vi.fn(), onClose)

    socket.close()

    expect(onClose).not.toHaveBeenCalled()
  })
})

describe('onboardingRefusalMessage', () => {
  it('tells the customer to ask for a fresh link', () => {
    expect(onboardingRefusalMessage(4410, 'customer')).toMatch(/expired/i)
    expect(onboardingRefusalMessage(4411, 'customer')).toMatch(/replaced/i)
    expect(onboardingRefusalMessage(4404, 'customer')).toMatch(/ask the officer/i)
  })

  it('tells the officer what to do about the room', () => {
    expect(onboardingRefusalMessage(4410, 'teller')).toMatch(/expired/i)
    expect(onboardingRefusalMessage(4411, 'teller')).toMatch(/newer link/i)
    expect(onboardingRefusalMessage(4404, 'teller')).toMatch(/reload/i)
    expect(onboardingRefusalMessage(4403, 'teller')).toMatch(/another officer/i)
  })

  it('says nothing about an ordinary close', () => {
    expect(onboardingRefusalMessage(1000, 'teller')).toBeNull()
    expect(onboardingRefusalMessage(1006, 'customer')).toBeNull()
    expect(onboardingRefusalMessage(4403, 'customer')).toBeNull()
  })
})
