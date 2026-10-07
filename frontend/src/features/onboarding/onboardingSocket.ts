/**
 * Dual-screen onboarding (Phase 7): the two tabs don't know each other; this
 * hook is the relay. One WebSocket per tab, one message envelope kind at a
 * time — no magic string types, no mutation of the envelope in transit.
 */

/** Teller tab → customer tab (commands), customer tab → teller tab (reports). */
export type OnboardingCommand =
  | { type: 'activateLiveness' }
  | { type: 'startRecording' }
  | { type: 'cancelSession' }
  | { type: 'activateFaceCapture' }
  | { type: 'capturePhoto' }

export type OnboardingReport =
  | { type: 'customerState'; state: CustomerUiState }
  | { type: 'frame'; dataUrl: string }
  | { type: 'recordingStarted' }
  | { type: 'recordingFinished'; livenessRef: string | null }
  | { type: 'photo'; dataUrl: string }
  | { type: 'error'; message: string }

export type CustomerUiState = 'welcome' | 'liveness' | 'recording'

/** Server → room: the other side (re)connected, so re-send the current command. */
export type OnboardingNotice = { type: 'peerJoined' }

export type OnboardingEnvelope = OnboardingCommand | OnboardingReport | OnboardingNotice

export interface OnboardingSocket {
  readonly send: (envelope: OnboardingEnvelope) => void
  readonly close: () => void
}

/**
 * Why the server closed a room's socket, as one sentence for a person.
 *
 * The server accepts the handshake and then closes with one of these codes,
 * which is the only reason a tab can tell "expired" from "replaced" at all.
 * `null` means this tab has nothing to say about the code — an ordinary close
 * (1000, a page navigating away) must never surface as a problem.
 */
export function onboardingRefusalMessage(
  code: number,
  role: 'teller' | 'customer',
): string | null {
  if (role === 'customer') {
    switch (code) {
      case 4404:
        return "This link isn't recognised. Please ask the officer for a new one."
      case 4410:
        return 'This link has expired. Please ask the officer for a new one.'
      case 4411:
        return 'This link has been replaced. Please ask the officer for a new one.'
      default:
        return null
    }
  }
  switch (code) {
    case 4404:
      return 'This session has ended. Reload the page to start a new one.'
    case 4403:
      return 'This link belongs to another officer. Create your own link for this customer.'
    case 4410:
      return 'This link has expired. Create a new one to reach the customer screen.'
    case 4411:
      return 'A newer link has replaced this one. Reload your links to use it.'
    default:
      return null
  }
}

/**
 * Open the relay WebSocket for a session.
 *
 * The browser's own cookie authenticates the teller tab; the customer tab
 * is deliberately public — it only ever answers commands and returns
 * reports, still user-gated by the session id it was handed.
 *
 * `onClose` reports the server's close code when the server is the one that
 * ended it. The socket closing itself (this tab navigating away, `close()`
 * below) is not a refusal and is never reported.
 */
export function openOnboardingSocket(
  sessionId: string,
  role: 'teller' | 'customer',
  onMessage: (envelope: OnboardingEnvelope) => void,
  onClose?: (code: number) => void,
): OnboardingSocket {
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
  const socket = new WebSocket(
    `${protocol}://${window.location.host}/ws/onboarding/${sessionId}?role=${role}`,
  )

  // A command issued before the handshake finishes (the teller sends
  // `activateLiveness` the moment the method is chosen) must not be dropped:
  // the browser refuses send() while CONNECTING, so hold the frames and
  // flush them the instant the socket opens.
  const pending: string[] = []
  socket.onopen = () => {
    while (pending.length > 0 && socket.readyState === WebSocket.OPEN) {
      socket.send(pending.shift()!)
    }
  }

  socket.onmessage = (event) => {
    try {
      const parsed = JSON.parse(String(event.data)) as OnboardingEnvelope
      if (typeof parsed === 'object' && parsed !== null && typeof parsed.type === 'string') {
        onMessage(parsed)
      }
    } catch {
      // Not JSON or not our envelope — ignore rather than surface a toast.
    }
  }

  socket.onclose = (event) => {
    onClose?.(event.code)
  }

  return {
    send: (envelope) => {
      const raw = JSON.stringify(envelope)
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(raw)
      } else if (socket.readyState === WebSocket.CONNECTING) {
        pending.push(raw)
      }
    },
    close: () => {
      pending.length = 0
      socket.onmessage = null
      socket.onclose = null
      socket.close()
    },
  }
}
