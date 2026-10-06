import { useEffect, useRef, useState } from 'react'

import { useLiveness } from './LivenessContext'
import { pickMimeType } from './mimeTypes'

/**
 * Record a three-second liveness video through the browser camera (Phase 7).
 *
 * Mirrors `FaceCapturePanel`'s explicit-trigger camera model: nothing prompts
 * for camera access until the user clicks "Enable Webcam", and nothing records
 * until they click "Start Liveness Check". The camera is never started just
 * because the method that needs it was selected.
 *
 * The webcam stream is released on cancel, on camera turn-off, on method
 * switch (this component unmounts) and on blob capture — `showCamera` runs a
 * single effect whose cleanup stops every track, and the recorder is torn
 * down with it, so the hardware indicator never outlives the UI that needs it.
  */

const RECORD_SECONDS = 3
const RECORD_INTERVAL_MS = 100

export function LivenessPanel() {
  const { state, livenessRef, error, capture, reset } = useLiveness()
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<BlobPart[]>([])
  const [showCamera, setShowCamera] = useState(false)
  const [cameraError, setCameraError] = useState<string | null>(null)
  const [recording, setRecording] = useState(false)
  const [remainingMs, setRemainingMs] = useState(RECORD_SECONDS * 1000)

  // Camera stream lifecycle. The effect's cleanup is the single place tracks
  // are stopped, so it also covers this component unmounting while a method
  // was just switched away from the liveness option.
  useEffect(() => {
    if (!showCamera) return
    let active = true
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: 'user' }, audio: false })
      .then((stream) => {
        if (!active) {
          stream.getTracks().forEach((track) => track.stop())
          return
        }
        streamRef.current = stream
        setCameraError(null)
        const video = videoRef.current
        if (video) {
          video.muted = true
          video.srcObject = stream
          void video.play().catch(() => {})
        }
      })
      .catch((cause: unknown) => {
        if (!active) return
        setCameraError(
          cause instanceof DOMException && cause.name === 'NotAllowedError'
            ? 'Camera access was denied. Please allow the camera and try again.'
            : 'Could not access the camera. Please try again.',
        )
      })
    return () => {
      active = false
      streamRef.current?.getTracks().forEach((track) => track.stop())
      streamRef.current = null
    }
  }, [showCamera])

  // Countdown, visible while the 3-second recording runs.
  useEffect(() => {
    if (!recording) return
    const started = Date.now()
    const tick = window.setInterval(() => {
      setRemainingMs(Math.max(0, RECORD_SECONDS * 1000 - (Date.now() - started)))
    }, RECORD_INTERVAL_MS)
    return () => window.clearInterval(tick)
  }, [recording])

  // Cancel a mid-flight recording when the camera effect or the panel tears
  // down — a recorder left in 'recording' state would keep the camera alive.
  useEffect(() => {
    return () => {
      const recorder = recorderRef.current
      recorderRef.current = null
      if (recorder && recorder.state !== 'inactive') {
        recorder.ondataavailable = null
        recorder.onstop = null
        recorder.stop()
      }
    }
  }, [])

  const stopCamera = () => {
    const recorder = recorderRef.current
    recorderRef.current = null
    if (recorder && recorder.state !== 'inactive') {
      recorder.ondataavailable = null
      recorder.onstop = null
      recorder.stop()
    }
    setRecording(false)
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    setShowCamera(false)
  }

  const startRecording = () => {
    const stream = streamRef.current
    if (!stream || typeof MediaRecorder === 'undefined') {
      setCameraError('This browser cannot record a liveness video.')
      return
    }
    setCameraError(null)
    const mimeType = pickMimeType()
    const recorder = new MediaRecorder(
      stream,
      mimeType
        ? { mimeType, videoBitsPerSecond: 1_000_000 }
        : { videoBitsPerSecond: 1_000_000 },
    )
    chunksRef.current = []
    recorder.ondataavailable = (event: BlobEvent) => {
      if (event.data.size > 0) chunksRef.current.push(event.data)
    }
    recorder.onstop = () => {
      if (chunksRef.current.length === 0) return
      const blob = new Blob(chunksRef.current, {
        type: recorder.mimeType || mimeType || 'video/webm',
      })
      setRecording(false)
      void capture(blob)
    }
    recorderRef.current = recorder
    setRemainingMs(RECORD_SECONDS * 1000)
    setRecording(true)
    recorder.start()
    window.setTimeout(() => {
      if (recorder.state !== 'inactive') recorder.stop()
    }, RECORD_SECONDS * 1000)
  }

  if (livenessRef) {
    return (
      <div className="card p-5" role="region" aria-label="Liveness check">
        <p className="text-ink text-sm font-semibold">Liveness check</p>
        <p className="text-positive mt-2 text-sm" role="status">
          A liveness video was recorded.
        </p>
        <button className="btn-secondary mt-3 px-3 py-1 text-xs" onClick={reset} type="button">
          Re-record
        </button>
      </div>
    )
  }

  return (
    <div className="card p-5" role="region" aria-label="Liveness check">
      <p className="text-ink text-sm font-semibold">Liveness check</p>
      <p className="text-ink-muted mt-1 text-xs">
        Records a short video through your camera. Nothing starts until you enable the webcam.
      </p>

      {state === 'capturing' ? (
        <p className="text-ink-subtle mt-3 text-xs" role="status">
          Saving your liveness check…
        </p>
      ) : null}

      {error ? (
        <p className="text-negative mt-3 text-sm" role="alert">
          {error}
        </p>
      ) : null}

      {state !== 'capturing' ? (
        <div className="mt-3 flex flex-col gap-2">
          <div className="flex gap-2">
            <button
              className="btn-secondary px-3 py-1.5 text-xs"
              onClick={() => setShowCamera(true)}
              type="button"
            >
              Enable Webcam
            </button>
            {showCamera ? (
              <button
                className="btn-secondary px-3 py-1.5 text-xs"
                disabled={recording}
                onClick={stopCamera}
                type="button"
              >
                Turn off camera
              </button>
            ) : null}
          </div>

          {cameraError ? (
            <p className="text-negative mt-1 text-xs" role="alert">
              {cameraError}
            </p>
          ) : null}

          {showCamera ? (
            <>
              <div className="liveness-stage">
                <video
                  aria-label="Liveness camera preview"
                  className="liveness-stage__video"
                  playsInline
                  ref={videoRef}
                />
                <div className="liveness-stage__dim" aria-hidden="true" />
                <div className="liveness-stage__oval" aria-hidden="true" />
                <p className="liveness-stage__hint" role={recording ? 'status' : undefined}>
                  {recording
                    ? `Look straight and blink slowly. ${(remainingMs / 1000).toFixed(1)}s`
                    : 'Centre your face in the oval before starting.'}
                </p>
              </div>
              <div className="mt-2 flex gap-2">
                <button
                  className="btn-primary px-3 py-1 text-xs"
                  disabled={recording}
                  onClick={startRecording}
                  type="button"
                >
                  {recording ? 'Recording…' : 'Start Liveness Check'}
                </button>
              </div>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
