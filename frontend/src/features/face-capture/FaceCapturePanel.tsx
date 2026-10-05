import { useEffect, useRef, useState } from 'react'

import { artifactUrl } from '../../lib/api'

import { useFaceCapture } from './FaceCaptureContext'

/**
 * Upload or webcam-capture the current face (Phase 6 §17). Signs the photo up by
 * uploading it to `POST /api/v1/kyc/face-capture` and returns its handle via
 * `useFaceCapture().faceRef`.
 */
export function FaceCapturePanel() {
  const { state, faceRef, captureStatus, error, capture, reset } = useFaceCapture()
  const fileRef = useRef<HTMLInputElement | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const [showCamera, setShowCamera] = useState(false)
  const [cameraError, setCameraError] = useState<string | null>(null)

  useEffect(() => {
    if (!showCamera) return
    let active = true
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: 'user' }, audio: false })
      .then((stream) => {
        if (!active) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }
        streamRef.current = stream
        setCameraError(null)
        const video = videoRef.current
        if (video) {
          video.srcObject = stream
          void video.play().catch(() => {})
        }
      })
      .catch((cause: unknown) => {
        if (!active) return
        setCameraError(
          cause instanceof DOMException && cause.name === 'NotAllowedError'
            ? 'Camera access was denied. You can upload a photo instead.'
            : 'Could not access the camera. You can upload a photo instead.',
        )
      })
    return () => {
      active = false
      streamRef.current?.getTracks().forEach((t) => t.stop())
      streamRef.current = null
    }
  }, [showCamera])

  const stopCamera = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    setShowCamera(false)
  }

  const onPick = async (files: FileList | null) => {
    const file = files && files[0]
    if (file) await capture(file)
  }

  const takePhoto = () => {
    const video = videoRef.current
    if (!video) return
    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth || 640
    canvas.height = video.videoHeight || 480
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.drawImage(video, 0, 0)
    canvas.toBlob(
      (blob) => {
        if (!blob) return
        stopCamera()
        void capture(blob)
      },
      'image/jpeg',
      0.9,
    )
  }

  return (
    <div className="border-border bg-surface-sunken mt-3 rounded-lg border p-3" role="region" aria-label="Current face">
      <p className="text-ink text-xs font-semibold">Current face</p>

      {faceRef ? (
        <div className="mt-2">
          <img
            alt="Captured current face"
            className="max-h-40 rounded-lg object-contain"
            src={artifactUrl(faceRef)}
          />
          <p className="text-ink-subtle mt-1 text-xs">
            {captureStatus === 'detected'
              ? 'A face was detected in your photo.'
              : 'We could not clearly find a face in that photo, but it was saved.'}
          </p>
          <button className="btn-secondary mt-2 px-3 py-1 text-xs" onClick={reset} type="button">
            Retake
          </button>
        </div>
      ) : null}

      {state === 'capturing' ? (
        <p className="text-ink-subtle mt-2 text-xs" role="status">
          Checking your photo…
        </p>
      ) : null}

      {error ? (
        <p className="text-negative mt-2 text-xs" role="alert">
          {error}
        </p>
      ) : null}

      {!faceRef && state !== 'capturing' ? (
        <div className="mt-2 flex flex-col gap-2">
          <input
            accept="image/jpeg,image/png,image/webp"
            className="hidden"
            id="current-face-upload"
            onChange={(e) => void onPick(e.target.files)}
            ref={fileRef}
            type="file"
          />
          <div className="flex gap-2">
            <button
              className="btn-secondary px-3 py-1.5 text-xs"
              onClick={() => fileRef.current?.click()}
              type="button"
            >
              Upload photo
            </button>
            <button
              className="btn-secondary px-3 py-1.5 text-xs"
              onClick={() => setShowCamera(true)}
              type="button"
            >
              Use camera
            </button>
          </div>

          {showCamera ? (
            <div className="mt-2">
              <video
                aria-label="Camera preview"
                className="max-h-48 w-full rounded-lg"
                playsInline
                ref={videoRef}
              />
              {cameraError ? <p className="text-negative mt-1 text-xs">{cameraError}</p> : null}
              <div className="mt-2 flex gap-2">
                <button className="btn-primary px-3 py-1 text-xs" onClick={takePhoto} type="button">
                  Take photo
                </button>
                <button className="btn-secondary px-3 py-1 text-xs" onClick={stopCamera} type="button">
                  Cancel
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
