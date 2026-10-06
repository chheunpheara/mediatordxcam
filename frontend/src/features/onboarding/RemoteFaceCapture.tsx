import { useCallback, useEffect, useRef, useState } from 'react'

import { openOnboardingSocket } from './onboardingSocket'
import type { OnboardingEnvelope } from './onboardingSocket'
import { useLiveFrame } from './useLiveFrame'
import { useFaceCapture } from '../face-capture/FaceCaptureContext'
import { fetchLivenessPageSettings } from '../../lib/api'

/**
 * The customer display's camera, taken from here for the current-face photo.
 *
 * `FaceCapturePanel` keeps the teller's own camera and the upload as they
 * were; this is the same photo driven the way the liveness clip is — the
 * method's requirements turn the monitor on, the customer taps nothing, and
 * the shutter is a button on this side:
 *
 *  - mounting sends `activateFaceCapture`, so choosing a method that needs
 *    the customer's face opens the camera over there;
 *  - frames arrive on the same canvas every other teller feed uses;
 *  - "Take photo" sends `capturePhoto`, and the customer tab answers with
 *    `photo` — a still of exactly the frame being previewed here. It is
 *    uploaded by this tab through `FaceCaptureProvider.capture`, so the
 *    handle lands under the existing "Current face" section with the same
 *    detection status a local capture would give it;
 *  - the customer's camera closes itself afterwards, keeping the picture on
 *    its oval, so nothing is left filming after the shot. `peerJoined` and
 *    the panel's own mount therefore re-send the command only while no photo
 *    exists — reopening is what the panel's "Retake" does, by clearing the
 *    handle and asking again.
 */
export function RemoteFaceCapture() {
  const { capture, faceRef } = useFaceCapture()
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const { canvasRef, hasFrame, acceptFrame } = useLiveFrame()
  const [taking, setTaking] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [noteIsError, setNoteIsError] = useState(false)
  const socketRef = useRef<ReturnType<typeof openOnboardingSocket> | null>(null)
  // The socket handler is written once; keep it on the latest capture.
  const captureRef = useRef(capture)
  // Whether a photo exists. A ref, not state, because the handler cannot
  // read state — and because the customer's camera closes itself with the
  // shot, so "there is a photo" has to be honoured the moment it lands,
  // before any render that would re-sync it.
  const hasPhotoRef = useRef(faceRef !== null)
  useEffect(() => {
    captureRef.current = capture
    hasPhotoRef.current = faceRef !== null
  }, [capture, faceRef])

  const askForCamera = useCallback(() => {
    if (hasPhotoRef.current) return
    socketRef.current?.send({ type: 'activateFaceCapture' })
  }, [])

  // "Retake" in the face panel clears the handle: the customer's camera is
  // wanted again, the way "Re-record" reopens it for a liveness clip.
  const previousPhoto = useRef(faceRef)
  useEffect(() => {
    const cleared = previousPhoto.current !== null && faceRef === null
    previousPhoto.current = faceRef
    if (cleared) askForCamera()
  }, [faceRef, askForCamera])

  useEffect(() => {
    let done = false

    fetchLivenessPageSettings()
      .then((settings) => {
        if (done) return
        setEnabled(settings.enabled)
        if (!settings.enabled) return
        const socket = openOnboardingSocket(settings.sessionId, 'teller', handleTellerEvent)
        socketRef.current = socket
        askForCamera()
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
          acceptFrame(envelope.dataUrl)
          break
        case 'peerJoined':
          // The customer tab (re)connected: it has not seen the activation
          // command this panel sent on mount, so send it again.
          askForCamera()
          break
        case 'photo': {
          setTaking(false)
          const blob = dataUrlToBlob(envelope.dataUrl)
          if (!blob) {
            // The customer's camera closed with that shot, so wanting another
            // one has to reopen it rather than wait for a `peerJoined`.
            setNote('The picture came back unreadable. Please take it again.')
            setNoteIsError(true)
            askForCamera()
            break
          }
          setNote(null)
          setNoteIsError(false)
          // The customer's camera closed with this shot, whatever the upload
          // below makes of it.
          hasPhotoRef.current = true
          void captureRef.current(blob).then(
            () => {
              setNote('Photo received from the customer display.')
              setNoteIsError(false)
            },
            () => {
              hasPhotoRef.current = false
              setNote('The photo could not be saved. Please take it again.')
              setNoteIsError(true)
              askForCamera()
            },
          )
          break
        }
        case 'error':
          setTaking(false)
          setNote(envelope.message)
          setNoteIsError(true)
          break
        default:
          break
      }
    }
  }, [acceptFrame, askForCamera])

  const takePhoto = () => {
    setTaking(true)
    setNote(null)
    setNoteIsError(false)
    socketRef.current?.send({ type: 'capturePhoto' })
  }

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
    <div
      className="border-border bg-surface-sunken mt-3 rounded-lg border p-3"
      role="region"
      aria-label="Customer camera"
    >
      <p className="text-ink text-xs font-semibold">Customer camera</p>
      <div className="mt-2 bg-transparent">
        <canvas
          aria-label="Customer camera feed"
          className="aspect-[4/3] max-h-72 w-full rounded-lg bg-transparent"
          ref={canvasRef}
        />
        {hasFrame ? null : (
          <p className="text-ink-subtle text-xs">Waiting for the customer's webcam frames…</p>
        )}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        {faceRef !== null ? (
          <p className="text-ink-subtle text-xs" role="status">
            The photo is under Current face. Use Retake to take another one here.
          </p>
        ) : (
          <button
            className="btn-primary px-4 py-2 text-sm font-medium disabled:opacity-50"
            disabled={taking}
            onClick={takePhoto}
            type="button"
          >
            {taking ? 'Taking photo…' : 'Take photo'}
          </button>
        )}
        {taking ? (
          <p className="text-ink-subtle text-xs" role="status">
            Waiting for the customer's camera…
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

/**
 * The customer's still, as the blob the face-capture endpoint expects.
 * Done by hand rather than through `fetch`, which would make every caller
 * depend on a global that tests replace wholesale.
 */
function dataUrlToBlob(dataUrl: string): Blob | null {
  const match = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/.exec(dataUrl)
  if (!match) return null
  const payload = match[3] ?? ''
  try {
    const binary = match[2] ? atob(payload) : decodeURIComponent(payload)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index)
    }
    return new Blob([bytes], { type: match[1] || 'image/jpeg' })
  } catch {
    return null // base64 that is not base64: treat as unreadable, not fatal
  }
}
