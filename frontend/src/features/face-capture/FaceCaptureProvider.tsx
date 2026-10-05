import { useCallback, useEffect, useMemo, useState } from 'react'

import { useIdCardProcessing } from '../id-card-processing/ProcessingContext'

import { FaceCaptureContext } from './FaceCaptureContext'
import type { FaceCaptureState, FaceCaptureValue } from './FaceCaptureContext'
import { ApiError, captureCurrentFace } from '../../lib/api'
import type { FaceStatus } from '../../lib/api'
import { clearSessionSlice, readSession, setSessionSlice } from '../../lib/session'

/**
 * Owns the current-face artefact handle the session will submit to `/verify`.
 * Records which document the handle belongs to, so a stale handle from a
 * different card is not offered up on replace. Reset explicitly via `reset`.
 * The captured handle survives a refresh.
 */
export function FaceCaptureProvider({ children }: { children: React.ReactNode }) {
  const { result } = useIdCardProcessing()
  const [state, setState] = useState<FaceCaptureState>(() => {
    const stored = readSession()?.face
    return stored?.state === 'capturing' ? 'failed' : stored?.state ?? 'idle'
  })
  const [faceRef, setFaceRef] = useState<string | null>(() => readSession()?.face?.faceRef ?? null)
  const [ownedBy, setOwnedBy] = useState<string | null>(() => {
    const stored = readSession()?.face
    return stored?.state === 'ready' ? stored.ownedBy : null
  })
  const [captureStatus, setCaptureStatus] = useState<FaceStatus | null>(
    () => readSession()?.face?.captureStatus ?? null,
  )
  const [error, setError] = useState<string | null>(() => {
    const stored = readSession()?.face
    return stored?.error ?? (stored?.state === 'capturing' ? 'Capture was interrupted. Please try again.' : null)
  })

  const live = result?.documentRef ?? null
  const exposedFaceRef = ownedBy === live ? faceRef : null
  const exposedStatus = ownedBy === live ? captureStatus : null

  useEffect(() => {
    if (state === 'capturing') {
      clearSessionSlice('face')
      return
    }
    if (state === 'idle' && faceRef === null && error === null) {
      clearSessionSlice('face')
      return
    }
    setSessionSlice('face', { state, faceRef, captureStatus, ownedBy, error })
  }, [state, faceRef, captureStatus, ownedBy, error, live])

  const capture = useCallback(async (file: File | Blob) => {
    setState('capturing')
    setError(null)
    try {
      const response = await captureCurrentFace(file)
      setFaceRef(response.faceRef)
      setOwnedBy(result?.documentRef ?? null)
      setCaptureStatus(response.status)
      setState('ready')
    } catch (cause) {
      setFaceRef(null)
      setOwnedBy(null)
      setCaptureStatus(null)
      setError(cause instanceof ApiError ? cause.message : 'Something went wrong. Please try again.')
      setState('failed')
    }
  }, [result])

  const reset = useCallback(() => {
    setState('idle')
    setFaceRef(null)
    setOwnedBy(null)
    setCaptureStatus(null)
    setError(null)
  }, [])

  const value = useMemo<FaceCaptureValue>(
    () => ({ state, faceRef: exposedFaceRef, captureStatus: exposedStatus, error, capture, reset }),
    [state, exposedFaceRef, exposedStatus, error, capture, reset],
  )

  return <FaceCaptureContext value={value}>{children}</FaceCaptureContext>
}
