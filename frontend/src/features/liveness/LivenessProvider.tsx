import { useCallback, useEffect, useMemo, useState } from 'react'

import { useIdCardProcessing } from '../id-card-processing/ProcessingContext'

import { LivenessContext } from './LivenessContext'
import type { LivenessState, LivenessValue } from './LivenessContext'
import { ApiError, verifyLiveness } from '../../lib/api'
import { clearSessionSlice, readSession, setSessionSlice } from '../../lib/session'

/**
 * Owns the liveness artefact handle the session will submit to `/verify`.
 *
 * Mirrors the face-capture provider: appends a `liveness` slice to the session
 * store so a finished recording survives a refresh, and records which document
 * the handle belongs to so a handle from a different card is never offered up.
 * Reset explicitly via `reset`.
 */
export function LivenessProvider({ children }: { children: React.ReactNode }) {
  const { result } = useIdCardProcessing()
  const [state, setState] = useState<LivenessState>(() => {
    const stored = readSession()?.liveness
    return stored?.state === 'capturing' ? 'failed' : (stored?.state ?? 'idle')
  })
  const [livenessRef, setLivenessRef] = useState<string | null>(
    () => readSession()?.liveness?.livenessRef ?? null,
  )
  const [ownedBy, setOwnedBy] = useState<string | null>(() => {
    const stored = readSession()?.liveness
    return stored?.state === 'ready' ? stored.ownedBy : null
  })
  const [error, setError] = useState<string | null>(() => {
    const stored = readSession()?.liveness
    return stored?.error ?? (stored?.state === 'capturing'
      ? 'Capture was interrupted. Please try again.'
      : null)
  })

  const live = result?.documentRef ?? null
  const exposedLivenessRef = ownedBy === live ? livenessRef : null

  useEffect(() => {
    if (state === 'capturing') {
      clearSessionSlice('liveness')
      return
    }
    if (state === 'idle' && livenessRef === null && error === null) {
      clearSessionSlice('liveness')
      return
    }
    setSessionSlice('liveness', { state, livenessRef, ownedBy, error })
  }, [state, livenessRef, ownedBy, error, live])

  const capture = useCallback(
    async (video: File | Blob) => {
      setState('capturing')
      setError(null)
      try {
        const response = await verifyLiveness(video)
        setLivenessRef(response.livenessRef)
        setOwnedBy(result?.documentRef ?? null)
        setState('ready')
      } catch (cause) {
        setLivenessRef(null)
        setOwnedBy(null)
        setError(cause instanceof ApiError ? cause.message : 'Something went wrong. Please try again.')
        setState('failed')
      }
    },
    [result],
  )

  const reset = useCallback(() => {
    setState('idle')
    setLivenessRef(null)
    setOwnedBy(null)
    setError(null)
  }, [])

  const value = useMemo<LivenessValue>(
    () => ({ state, livenessRef: exposedLivenessRef, error, capture, reset }),
    [state, exposedLivenessRef, error, capture, reset],
  )

  return <LivenessContext value={value}>{children}</LivenessContext>
}
