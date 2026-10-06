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
 * Open the relay WebSocket for a session.
 *
 * The browser's own cookie authenticates the teller tab; the customer tab
 * is deliberately public — it only ever answers commands and returns
 * reports, still user-gated by the session id it was handed.
 */
export function openOnboardingSocket(
  sessionId: string,
  role: 'teller' | 'customer',
  onMessage: (envelope: OnboardingEnvelope) => void,
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
      socket.close()
    },
  }
}
