import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'

import { onboardingRefusalMessage, openOnboardingSocket } from '../features/onboarding/onboardingSocket'
import type { CustomerUiState, OnboardingEnvelope } from '../features/onboarding/onboardingSocket'
import { verifyLiveness } from '../lib/api'
import { pickMimeType } from '../features/liveness/mimeTypes'
import { LivenessArt } from '../components/liveness/LivenessArt'

/**
 * Screen B (the customer-facing Address 1 monitor).
 *
 * Default is the idle liveness art — the oval the camera will later fill,
 * breathing in the middle of the screen — with the camera closed. The
 * teller's `activateLiveness` opens the webcam — the customer taps nothing:
 * the only input this screen takes is the operating system's own permission
 * prompt.
 * Once live, frames stream to the teller tab at ~12 fps.
 *
 * When the teller dispatches `startRecording`, this tab records a 3-second
 * MediaRecorder clip through the already-live stream, shows the countdown
 * for the customer, uploads the blob to /api/broker/verify-liveness, and
 * echoes `recordingFinished` back with the handle the teller then previews.
 * A start that arrives while the camera is still opening is held and fired
 * the moment the stream lands, so no command needs a click to take effect.
 * A denied camera is reported to the teller, not only shown here.
 *
 * The camera is closed again once the clip has been accepted: a monitor left
 * running after the check is a camera the customer was not told was on. The
 * last picture the camera saw stays on the oval, so the customer can see what
 * was just taken while the shutter is shut. It reopens only on a teller
 * command — `activateLiveness`, or the `startRecording` that carries a
 * re-record — which the held-start path above already handles.
 *
 * A method that needs the customer's photo works the same way from the
 * other end: `activateFaceCapture` opens this camera for the still, the
 * frames below keep streaming to the teller's preview, and `capturePhoto`
 * takes one and sends it back as `photo`. The camera closes afterwards just
 * as it does after a recording, keeping the picture on the oval — so the
 * teller's "Take photo" button is the only shutter in either flow.
 *
 * `cancelSession` (teller clicking "Reset session" or the room expiring) rips
 * down tracks and recorder timers and returns to the welcome screen.
 *
 * The link itself can end under this screen — expired, replaced by a newer
 * one, unknown after a restart. The server says which by closing the socket
 * with a refusal code, and this page then shuts the camera down and takes over
 * with one plain sentence: no command can arrive on a room that is gone.
 */

const FRAME_INTERVAL_MS = 80 // ~12 fps; JPEG base64 sized for a modern web link
const RECORD_SECONDS = 3

export function CustomerDisplayPage() {
  const [searchParams] = useSearchParams()
  const sessionId = searchParams.get('session') ?? ''

  const [screenState, setScreenState] = useState<CustomerUiState>('welcome')
  const [webcamOn, setWebcamOn] = useState(false)
  const [recording, setRecording] = useState(false)
  const [countdown, setCountdown] = useState(RECORD_SECONDS)
  const [note, setNote] = useState<string | null>(null)
  const [cameraFailed, setCameraFailed] = useState(false)
  // The clip was accepted, so the camera was closed on purpose rather than
  // being on its way in — the hint has to say so instead of "Starting the
  // camera…", and the next teller command clears it.
  const [cameraClosed, setCameraClosed] = useState(false)
  // Which teller command opened the camera: the hint below promises a
  // recording or a photo, and only the teller switches between them.
  const [purpose, setPurpose] = useState<'liveness' | 'photo'>('liveness')
  // Why the room closed, as a sentence for the customer — null while the link
  // is still alive. Set only from a refusal code, never from this tab's own
  // close, so navigating away never shows an error.
  const [refusal, setRefusal] = useState<string | null>(null)
  // The last frame the camera saw, kept on the oval after it closes.
  const [snapshot, setSnapshot] = useState<string | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const socketRef = useRef<ReturnType<typeof openOnboardingSocket> | null>(null)
  const frameTimer = useRef<number | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const countdownTimer = useRef<number | null>(null)
  // A `getUserMedia` already in flight, so a repeated command cannot open a
  // second stream on top of the first.
  const cameraRequestRef = useRef(false)
  // A `startRecording` that arrived before the camera was ready: fired the
  // moment the stream lands, so the customer never has to click anything.
  const pendingStartRef = useRef(false)

  const stopStream = () => {
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    if (videoRef.current) videoRef.current.srcObject = null
  }
  const stopFrames = () => {
    if (frameTimer.current !== null) {
      window.clearInterval(frameTimer.current)
      frameTimer.current = null
    }
  }
  const stopRecorder = () => {
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop()
    recorderRef.current = null
    if (countdownTimer.current !== null) {
      window.clearInterval(countdownTimer.current)
      countdownTimer.current = null
    }
  }

  /**
   * The picture the camera is showing right now, as a JPEG. Taken before the
   * tracks stop: once they do, the element has no frame left to copy.
   */
  const captureSnapshot = () => {
    const video = videoRef.current
    if (!video || !video.videoWidth || !video.videoHeight) return null
    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(video, 0, 0)
    return canvas.toDataURL('image/jpeg', 0.86)
  }

  /** Camera off. Only a completed check or a teller command leads here. */
  const closeCamera = () => {
    const picture = captureSnapshot()
    stopFrames()
    stopStream()
    setWebcamOn(false)
    setSnapshot(picture)
  }

  // Outgoing frames: at ~12 fps, canvas-JPEG of the live preview.
  const startFrameStream = () => {
    frameTimer.current = window.setInterval(() => {
      const video = videoRef.current
      if (!video || video.readyState < 2) return
      const canvas = document.createElement('canvas')
      canvas.width = 640
      canvas.height = 480
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
      socketRef.current?.send({ type: 'frame', dataUrl: canvas.toDataURL('image/jpeg', 0.6) })
    }, FRAME_INTERVAL_MS)
  }

  /** The teller's start command, held or immediate — never a customer click. */
  const beginRecording = () => {
    setScreenState('recording')
    setRecording(true)
    setCountdown(RECORD_SECONDS)
    // 3-second MediaRecorder loop, compressed webm/mp4. The teller sees
    // `recordingStarted`; the customer sees the countdown below the oval.
    startClientRecording()
    socketRef.current?.send({ type: 'recordingStarted' })
  }

  const enableWebcam = () => {
    if (streamRef.current || cameraRequestRef.current) return
    if (!navigator.mediaDevices?.getUserMedia) {
      const message = 'No webcam is available in this browser.'
      setCameraFailed(true)
      setNote(message)
      socketRef.current?.send({ type: 'error', message })
      return
    }
    cameraRequestRef.current = true
    setCameraFailed(false)
    setCameraClosed(false)
    // The live picture replaces the still from the last recording.
    setSnapshot(null)
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: 'user' }, audio: false })
      .then((stream) => {
        cameraRequestRef.current = false
        streamRef.current = stream
        setWebcamOn(true)
        setNote(null)
        const video = videoRef.current
        if (video) {
          video.muted = true
          video.srcObject = stream
          void video.play().catch(() => {})
        }
        socketRef.current?.send({ type: 'customerState', state: 'liveness' })
        startFrameStream()
        if (pendingStartRef.current) {
          pendingStartRef.current = false
          beginRecording()
        }
      })
      .catch((cause: unknown) => {
        cameraRequestRef.current = false
        pendingStartRef.current = false
        const message =
          cause instanceof DOMException && cause.name === 'NotAllowedError'
            ? 'Camera access was denied.'
            : 'Could not access the camera.'
        setCameraFailed(true)
        setNote(message)
        // The customer's screen is not the only place this must appear: the
        // teller is the one who has to decide what to do about it.
        socketRef.current?.send({ type: 'error', message })
      })
  }

  // Incoming commands from the teller tab.
  function handleMessage(envelope: OnboardingEnvelope) {
    switch (envelope.type) {
      case 'activateLiveness':
        setScreenState('liveness')
        setPurpose('liveness')
        setCameraFailed(false)
        setNote('The teller is ready for your liveness check.')
        enableWebcam()
        break
      case 'activateFaceCapture':
        setScreenState('liveness')
        setPurpose('photo')
        setCameraFailed(false)
        setNote('The teller is ready to take your photo.')
        enableWebcam()
        break
      case 'capturePhoto': {
        const dataUrl = captureSnapshot()
        if (dataUrl === null) {
          socketRef.current?.send({
            type: 'error',
            message: 'The camera is not ready to take a photo yet.',
          })
          break
        }
        socketRef.current?.send({ type: 'photo', dataUrl })
        // Same bargain as a finished recording: the camera did its job, so it
        // closes itself — and the still it was asked for stays on the oval.
        setCameraClosed(true)
        setNote('Your photo has been taken and sent to the teller.')
        closeCamera()
        break
      }
      case 'startRecording':
        // The stream itself is the readiness signal. `webcamOn` (state the
        // handler cannot capture — it is bound once) turns true a render later
        // than the stream lands, and a start arriving in that window would be
        // held against a camera that is already on, with nothing left to fire
        // it. The open stream, not the flag, says the recording can start.
        if (streamRef.current) {
          beginRecording()
          break
        }
        // The camera is still opening (permission prompt, or the command beat
        // `activateLiveness`): hold the start instead of refusing it.
        pendingStartRef.current = true
        setScreenState('liveness')
        setNote('Starting the camera…')
        enableWebcam()
        break
      case 'cancelSession':
        pendingStartRef.current = false
        stopRecorder()
        stopFrames()
        stopStream()
        setWebcamOn(false)
        setRecording(false)
        setScreenState('welcome')
      setNote(null)
      setCameraClosed(false)
      setSnapshot(null)
      setPurpose('liveness')
      break
      default:
        break
    }
  }

  const startClientRecording = () => {
    const stream = streamRef.current
    if (!stream || typeof MediaRecorder === 'undefined') {
      setNote('This browser cannot record video.')
      setRecording(false)
      setScreenState('liveness')
      return
    }
    countdownTimer.current = window.setInterval(() => {
      setCountdown((current) => Math.max(0, current - 1))
    }, 1000)
    const mimeType = pickMimeType()
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
    chunksRef.current = []
    recorder.ondataavailable = (event: BlobEvent) => {
      if (event.data.size > 0) chunksRef.current.push(event.data)
    }
    recorder.onstop = () => {
      if (countdownTimer.current !== null) {
        window.clearInterval(countdownTimer.current)
        countdownTimer.current = null
      }
      setRecording(false)
      const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'video/webm' })
      void uploadBlob(blob)
      setScreenState('liveness')
    }
    recorderRef.current = recorder
    recorder.start()
    window.setTimeout(() => {
      if (recorder.state === 'recording') recorder.stop()
      setCountdown(0)
    }, RECORD_SECONDS * 1000)
  }

  const chunksRef = useRef<BlobPart[]>([])

  const uploadBlob = async (blob: Blob) => {
    try {
      // Through the API client, not a raw fetch: it turns a non-JSON body (an
      // HTML error page from a proxy, say) into a readable ApiError instead of
      // letting `response.json()` throw a parse error at the customer.
      const { livenessRef } = await verifyLiveness(blob)
      socketRef.current?.send({ type: 'recordingFinished', livenessRef })
      setNote('Liveness recording complete. Your video was sent to the teller.')
      // Accepted: the camera has done its job. Off it goes, and the next
      // `startRecording` reopens it through the held-start path above.
      setCameraClosed(true)
      closeCamera()
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Liveness upload failed.'
      setNote(message)
      // The teller is the one who has to decide what to do about it, and a
      // raw `String(cause)` would show them the browser's parse wording.
      socketRef.current?.send({ type: 'error', message })
    }
  }

  useEffect(() => {
    if (!sessionId) return
    socketRef.current = openOnboardingSocket(
      sessionId,
      'customer',
      handleMessage,
      (code) => {
        const message = onboardingRefusalMessage(code, 'customer')
        if (message === null) return
        // The room is gone, so nothing can re-open the camera: shut it down
        // now rather than leaving a camera on behind an error page.
        stopRecorder()
        stopFrames()
        stopStream()
        setWebcamOn(false)
        setRecording(false)
        setRefusal(message)
      },
    )
    return () => {
      stopRecorder()
      stopFrames()
      stopStream()
      socketRef.current?.close()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  return (
    <main
      className="bg-white text-ink flex min-h-screen flex-col items-center justify-center p-3 text-center"
    >
      {refusal !== null ? (
        <section className="w-full max-w-xl px-4 py-8" role="alert">
          <h1 className="text-lg font-semibold">This link is no longer open</h1>
          <p className="text-ink-muted mt-3 text-sm">{refusal}</p>
        </section>
      ) : screenState === 'welcome' ? (
        <LivenessArt />
      ) : (
        <section className="w-full max-w-xl">
          <div className="liveness-stage">
            <video
              ref={videoRef}
              className="liveness-stage__feed"
              playsInline
              aria-label="Customer camera preview"
            />
            {snapshot ? (
              <img
                className="liveness-stage__feed"
                src={snapshot}
                alt="Your recorded preview"
              />
            ) : null}
            <div className="liveness-stage__dim" aria-hidden="true" />
            <div className="liveness-stage__oval" aria-hidden="true" />
          </div>
          <p className="liveness-stage__hint" role="status">
            {recording
              ? `Look straight and blink slowly. ${countdown}s`
              : webcamOn
                ? purpose === 'photo'
                  ? 'Look at the camera — the teller will take your photo.'
                  : 'Hold still — the teller will start the check.'
                : cameraClosed
                  ? purpose === 'photo'
                    ? 'Your camera is off. The teller can open it again to take another photo.'
                    : 'Your camera is off. The teller will start it again if you need to re-record.'
                  : cameraFailed
                    ? 'Camera unavailable — the teller has been notified.'
                    : 'Starting the camera…'}
          </p>
          <div className="mt-4 flex items-center justify-center gap-3">
            {recording ? (
              <p className="text-lg" role="status">
                Keep that pose — finishing…
              </p>
            ) : null}
          </div>
          {note ? (
            <p
              className={`mt-3 text-sm ${cameraClosed ? 'text-positive font-medium' : 'text-ink-muted'}`}
              role="status"
            >
              {note}
            </p>
          ) : null}
        </section>
      )}
    </main>
  )
}
