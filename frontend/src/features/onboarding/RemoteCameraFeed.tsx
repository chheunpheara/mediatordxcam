import { useEffect, useRef, useState } from 'react'

import { onboardingRefusalMessage, openOnboardingSocket } from './onboardingSocket'
import type { OnboardingEnvelope } from './onboardingSocket'
import { useLiveFrame } from './useLiveFrame'
import { useLiveness } from '../liveness/LivenessContext'
import { artifactUrl, fetchActiveLivenessLink } from '../../lib/api'

/**
 * In-browser live feed of the separate customer display tab (Phase 7).
 *
 * The workspace joins the officer's current liveness link as a *sender* of
 * the activation command; frames flow countermand it back as teller-side
 * events. The link is fetched, not configured here: one minted link is all
 * this panel needs, and it is the same one the customer monitor opens.
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
 * open its camera — but only while no clip exists. Once a recording has been
 * accepted the customer's camera is meant to stay closed (it closes itself on
 * success), so a monitor tab that reloads must not be told to film again;
 * reopening it is what "Re-record" is for.
 *
 * `hideClip` drops the playback itself — for the report dialog, where the same
 * recording is already the clip the composition art frames. The section still
 * says a clip exists and still offers Re-record; only the second player goes.
 */
export function RemoteCameraFeed({
  hideClip = false,
}: {
  readonly hideClip?: boolean
} = {}) {
  const { adopt, livenessRef } = useLiveness()
  const [hasLink, setHasLink] = useState<boolean | null>(null)
  const { canvasRef, hasFrame, acceptFrame } = useLiveFrame()
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
  // …and on the latest handle, so the activation guard below reads a clip
  // that was recorded after this panel mounted.
  const livenessRefRef = useRef(livenessRef)
  useEffect(() => {
    adoptRef.current = adopt
    livenessRefRef.current = livenessRef
  }, [adopt, livenessRef])

  useEffect(() => {
    let done = false

    // Ask the customer display to film — but only while there is no clip to
    // replay. After a successful recording the camera is closed on purpose,
    // and neither this panel's mount nor a monitor tab reloading behind it
    // may undo that; "Re-record" is what opens it again.
    const askForCamera = () => {
      if (livenessRefRef.current !== null) return
      socketRef.current?.send({ type: 'activateLiveness' })
    }

    fetchActiveLivenessLink()
      .then((link) => {
        if (done) return
        setHasLink(link !== null && link.token !== null)
        if (link === null || link.token === null) return
        const socket = openOnboardingSocket(
          link.token,
          'teller',
          (envelope) => {
            handleTellerEvent(envelope)
          },
          (code) => {
            // The room ended under us — expired, replaced, or another
            // officer's link. Say which, and leave the feed as it is.
            const message = onboardingRefusalMessage(code, 'teller')
            if (message === null) return
            setRecording(false)
            setNote(message)
            setNoteIsError(true)
          },
        )
        socketRef.current = socket
        askForCamera()
      })
      .catch(() => setHasLink(false))
    return () => {
      done = true
      socketRef.current?.close()
      socketRef.current = null
    }

    function handleTellerEvent(envelope: OnboardingEnvelope) {
      switch (envelope.type) {
        case 'frame':
          acceptFrame(envelope.dataUrl)
          break
        case 'peerJoined':
          // The customer tab (re)connected: it has not seen the activation
          // command this panel sent on mount, so send it again.
          askForCamera()
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
  }, [acceptFrame])

  if (hasLink === null) {
    return (
      <p className="text-ink-subtle text-xs" role="status">
        Contacting the customer display…
      </p>
    )
  }

  if (!hasLink) {
    return (
      <p className="text-ink-subtle text-xs">
        No liveness link is open yet. Create one to reach the customer screen.
      </p>
    )
  }

  return (
    <div className="mt-3">
      {livenessRef !== null ? (
        <section
          aria-label="Recorded liveness clip"
          className="border-border mb-3 rounded-lg border p-3"
          role="region"
        >
          <p className="text-ink text-xs font-semibold">Liveness check</p>
          {previewFailed ? (
            <p className="text-negative mt-2 text-xs" role="alert">
              This recording has expired. Please run the liveness check again.
            </p>
          ) : hideClip ? null : (
            <video
              aria-label="Recorded liveness clip"
              className="mt-2 max-h-72 w-full rounded-lg bg-transparent"
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
      <div className="bg-transparent">
        <canvas
          aria-label="Customer liveness feed"
          className="aspect-[4/3] max-h-72 w-full rounded-lg bg-transparent"
          ref={canvasRef}
        />
        {hasFrame ? null : (
          <p className="text-ink-subtle text-xs">Waiting for the customer's webcam frames…</p>
        )}
      </div>
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
