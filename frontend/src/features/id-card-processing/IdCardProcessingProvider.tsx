import { useCallback, useEffect, useMemo, useState } from 'react'

import type { IdentityFieldName } from '../../lib/api'

import { ApiError, processIdCard } from '../../lib/api'
import type { ProcessIdCardResponse } from '../../lib/api'

import type { IdentityDraft } from './IdentityDraftContext'
import { IdCardProcessingContext } from './ProcessingContext'
import type { IdCardProcessingValue, ProcessingState } from './ProcessingContext'
import { clearSessionSlice, readSession, setSessionSlice } from '../../lib/session'

/**
 * Owns the `POST /api/v1/kyc/id-card/process` call for the session.
 *
 * Centralised so exactly one component performs the request: both the landing
 * page (§6 processes before navigating) and the workspace (a direct visit to
 * `/id-card`) go through the same call, and a page refresh cannot silently skip
 * processing.
 *
 * A rejected request is recorded as `failed` with the server's own sentence. A
 * failure here is a transport or validation problem, never a negative
 * verification result — those arrive as `partial`/`failed` inside a 200 response
 * (§26, §28).
 */
export function IdCardProcessingProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<ProcessingState>(() => {
    const stored = readSession()?.processing
    if (stored?.state === 'processing') return 'failed'
    return stored?.state ?? 'idle'
  })
  const [result, setResult] = useState<ProcessIdCardResponse | null>(() => {
    const stored = readSession()?.processing
    return stored?.state === 'ready' ? stored.result : null
  })
  const [error, setError] = useState<string | null>(() => {
    const stored = readSession()?.processing
    return stored?.error ?? (stored?.state === 'processing' ? 'Processing was interrupted. Please try again.' : null)
  })
  const [draft, setDraft] = useState<IdentityDraft>(() => readSession()?.processing?.draft ?? {})

  // Restoring a stored `processing` snapshot is not meaningful (the request is
  // not narrowed any faster from disk); turn it into an actionable failure.
  // The effect below then persists that state consistently.

  useEffect(() => {
    if (state === 'processing') {
      clearSessionSlice('processing')
      return
    }
    if (state === 'idle' && result === null && error === null && Object.keys(draft).length === 0) {
      clearSessionSlice('processing')
      return
    }
    setSessionSlice('processing', { state, result, draft, error })
  }, [state, result, draft, error])

  const process = useCallback(async (file: File | Blob) => {
    setState('processing')
    setError(null)
    try {
      const processed = await processIdCard(file)
      setResult(processed)
      setDraft({})
      setState('ready')
      return processed
    } catch (cause) {
      // Only the server's user-facing sentence reaches the screen. An unexpected
      // throw gets a generic one rather than its own text, which could be a
      // technical message (§7: do not expose technical exceptions).
      setResult(null)
      setError(cause instanceof ApiError ? cause.message : 'Something went wrong. Please try again.')
      setState('failed')
      return null
    }
  }, [])

  const reset = useCallback(() => {
    setState('idle')
    setResult(null)
    setError(null)
    setDraft({})
  }, [])

  const setField = useCallback((name: IdentityFieldName, value: string) => {
    setDraft((current) => ({ ...current, [name]: value }))
  }, [])

  const clearDraft = useCallback(() => setDraft({}), [])

  const value = useMemo<IdCardProcessingValue>(
    () => ({ state, result, error, process, reset, draft, setField, clearDraft }),
    [state, result, error, process, reset, draft, setField, clearDraft],
  )

  return <IdCardProcessingContext value={value}>{children}</IdCardProcessingContext>
}