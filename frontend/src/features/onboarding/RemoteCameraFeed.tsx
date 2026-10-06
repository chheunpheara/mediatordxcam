import { useEffect, useRef, useState } from 'react'

import { openOnboardingSocket } from './onboardingSocket'
import type { OnboardingEnvelope } from './onboardingSocket'
import { useLiveness } from '../liveness/LivenessContext'
import { artifactUrl, fetchLivenessPageSettings } from '../../lib/api'

/**
 * In-browser live feed of the separate customer display tab (Phase 7).
 *
 * The workspace links to the fixed liveness page as a *sender* of the
 * activation command; frames flow countermand it back as teller-side events.
 * There is no local camera UI: the customer is the person proving liveness.
 *
 * "Start liveness check" queues the 3-second recording on the customer
 * screen. The customer tab uploads the clip itself and the relay hands back
 * the server-issued `livenessRef`, which is adopted into the shared liveness
 * artefact exactly as a local capture's success would be — so the panel's
 * verification inputs see one handle either way. The same handle is what this
 * panel plays back: the teller sees the clip that was just recorded, served
 * from the artefact store rather than mirrored through the relay.
 *
 * `peerJoined` re-sends the activation command, because a monitor tab that
 * connects *after* the method was chosen would otherwise never be told to
 * open its camera.
 */
export function RemoteCameraFeed() {
  const { adopt, livenessRef } = useLiveness()
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [frameUrl, setFrameUrl] = useState<string | null>(null)
  const [recording, setRecording] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [noteIsError, setNoteIsError] = useState(false)
  // Which handle failed to load, rather than a bare flag: a handle that has
  // since expired must not keep rendering as broken, and a flag reset in an
  // effect would race the next render. Equality against the current handle
  // clears itself the moment a new recording arrives.
  const [failedHandle, setFailedHandle] = useState<string | null>(null)
  const previewFailed = failedHandle !== null && failedHandle === livenessRef
  const socketRef = useRef<ReturnType<typeof openOnboardingSocket> | null>(null)
  // The socket handler is written once; keep it on the latest adopt.
  const adoptRef = useRef(adopt)
  useEffect(() => {
    adoptRef.current = adopt
  }, [adopt])

  useEffect(() => {
    let done = false

    fetchLivenessPageSettings()
      .then((settings) => {
        if (done) return
        setEnabled(settings.enabled)
        if (!settings.enabled) return
        const socket = openOnboardingSocket(settings.sessionId, 'teller', (envelope) => {
          handleTellerEvent(envelope)
        })
        socketRef.current = socket
        // Ask the customer display to show the webcam automatically.
        socket.send({ type: 'activateLiveness' })
      })
      .catch(() => setEnabled(false))
    return () => {
      done = true
      socketRef.current?.close()
      socketRef.current = null
    }

    function handleTellerEvent(envelope: OnboardingEnvelope) {
      switch (envelope.type) {
        case 'frame':
          setFrameUrl(envelope.dataUrl)
          break
        case 'peerJoined':
          // The customer tab (re)connected: it has not seen the activation
          // command this panel sent on mount, so send it again.
          socketRef.current?.send({ type: 'activateLiveness' })
          break
        case 'recordingStarted':
          setRecording(true)
          setNote(null)
          setNoteIsError(false)
          break
        case 'recordingFinished':
          setRecording(false)
          if (envelope.livenessRef) {
            adoptRef.current(envelope.livenessRef)
            setNote('Liveness recording received and accepted.')
            setNoteIsError(false)
          } else {
            setNote('The recording came back without a result. Please run it again.')
            setNoteIsError(true)
          }
          break
        case 'error':
          setRecording(false)
          setNote(envelope.message)
          setNoteIsError(true)
          break
        default:
          break
      }
    }
  }, [])

  if (enabled === null) {
    return (
      <p className="text-ink-subtle text-xs" role="status">
        Contacting the customer display…
      </p>
    )
  }

  if (!enabled) {
    return (
      <p className="text-ink-subtle text-xs">
        No fixed customer display is enabled yet. Open the Liveness Page settings to configure one.
      </p>
    )
  }

  return (
    <div className="mt-3">
      {livenessRef !== null ? (
        <section
          aria-label="Recorded liveness clip"
          className="border-border bg-surface-sunken mb-3 rounded-lg border p-3"
          role="region"
        >
          <p className="text-ink text-xs font-semibold">Liveness check</p>
          {previewFailed ? (
            <p className="text-negative mt-2 text-xs" role="alert">
              This recording has expired. Please run the liveness check again.
            </p>
          ) : (
            <video
              aria-label="Recorded liveness clip"
              className="mt-2 max-h-72 w-full rounded-lg"
              controls
              onError={() => setFailedHandle(livenessRef)}
              playsInline
              preload="metadata"
              src={artifactUrl(livenessRef)}
            />
          )}
          <p className="text-ink-subtle mt-1 text-xs">A liveness video was recorded.</p>
        </section>
      ) : null}
      {frameUrl ? (
        <img alt="Customer liveness feed" className="max-h-72 w-full rounded-lg" src={frameUrl} />
      ) : (
        <p className="text-ink-subtle text-xs">Waiting for the customer's webcam frames…</p>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <button
          className="btn-primary px-4 py-2 text-sm font-medium disabled:opacity-50"
          disabled={recording}
          onClick={() => socketRef.current?.send({ type: 'startRecording' })}
          type="button"
        >
          {recording ? 'Recording…' : livenessRef ? 'Re-record' : 'Start liveness check'}
        </button>
        {recording ? (
          <p className="text-ink-subtle text-xs" role="status">
            Customer is recording…
          </p>
        ) : null}
      </div>
      {note ? (
        <p
          className={`mt-2 text-xs ${noteIsError ? 'text-negative' : 'text-ink-subtle'}`}
          role={noteIsError ? 'alert' : 'status'}
        >
          {note}
        </p>
      ) : null}
    </div>
  )
}
