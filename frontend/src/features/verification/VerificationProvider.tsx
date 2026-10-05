import { useCallback, useEffect, useMemo, useState } from 'react'

import { ApiError, IDENTITY_FIELDS, fetchVerificationMethods, verify } from '../../lib/api'
import type {
  IdentityFields,
  VerificationMethod,
  VerificationMethodId,
  VerifyResponse,
} from '../../lib/api'

import { VerificationContext } from './VerificationContext'
import type { VerificationValue } from './VerificationContext'

/**
 * Owns the method list and the verify call for the session.
 *
 * §11 requires the requirement configuration to come from the backend, so the
 * list is fetched rather than written down here. That is what makes "additional
 * inputs appear automatically" true without any per-method React code: when the
 * backend starts reporting `requiresLiveness`, the UI reacts without a change.
 *
 * The backend re-derives the same requirements on `POST /verify`, so a `canVerify`
 * of true here is a convenience, never the enforcement (§11).
 */

/** Which requirement flags the session currently satisfies. */
export interface SessionInputs {
  /**
   * The nine §14 fields as the user left them, or `null` while no result exists.
   *
   * Sent verbatim on verify (§19). The corrections the user typed are the values
   * the government is asked to check, so passing the raw OCR output instead would
   * silently discard the very corrections §14 exists to enable.
   */
  readonly identity: IdentityFields | null
  readonly documentRef: string | null
  readonly currentFaceRef: string | null
  readonly livenessRef: string | null
  readonly idCardFaceRef: string | null
}

export function VerificationProvider({
  children,
  inputs,
}: {
  children: React.ReactNode
  inputs: SessionInputs
}) {
  const [methods, setMethods] = useState<readonly VerificationMethod[]>([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<VerificationMethodId | null>(null)
  const [verifying, setVerifying] = useState(false)
  const [result, setResult] = useState<VerifyResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  const { identity, documentRef, currentFaceRef, livenessRef, idCardFaceRef } = inputs

  // Mirrors the backend gate: all nine §14 fields, or it is not identity supplied.
  const hasIdentity =
    identity !== null && IDENTITY_FIELDS.every((name) => (identity[name] ?? '').trim() !== '')

  useEffect(() => {
    let active = true
    fetchVerificationMethods()
      .then((loaded) => {
        if (!active) return
        setMethods(loaded)
        // Default to the first runnable method so the panel is never inert on
        // arrival. §9/§10 want six cards, not an empty selection.
        const firstRunnable = loaded.find((m) => m.available && !m.isOcr)
        if (firstRunnable) setSelected(firstRunnable.method)
      })
      .catch((cause: unknown) => {
        if (!active) return
        // Only the server's own sentence reaches the screen (§28).
        setError(cause instanceof ApiError ? cause.message : 'Something went wrong. Please try again.')
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [])

  // Requirements the current selection needs but the session cannot supply (§11).
  const missing = useMemo(() => {
    const chosen = methods.find((m) => m.method === selected)
    if (!chosen) return []

    const unmet: string[] = []
    if (chosen.requiresUserInfo && !hasIdentity) unmet.push('userInfo')
    if (chosen.requiresCurrentFace && !currentFaceRef) unmet.push('currentFace')
    if (chosen.requiresIdCard && !documentRef) unmet.push('idCard')
    if (chosen.requiresLiveness && !livenessRef) unmet.push('liveness')
    if (chosen.requiresPassport) unmet.push('passport')
    return unmet
  }, [methods, selected, hasIdentity, documentRef, currentFaceRef, livenessRef])

  const chosen = methods.find((m) => m.method === selected) ?? null

  const blockingReason = useMemo(() => {
    if (loading) return 'Loading the verification methods…'
    if (!chosen) return 'Choose how you would like to verify.'
    if (chosen.isOcr) return 'This reads a document rather than verifying your identity.'
    if (!chosen.available) return chosen.unavailableReason
    if (missing.length === 1) return 'One more thing is needed before you can verify.'
    if (missing.length > 1) return `${missing.length} more things are needed before you can verify.`
    return null
  }, [loading, chosen, missing])

  const runVerify = useCallback(async () => {
    if (!chosen) return
    setVerifying(true)
    setError(null)
    try {
      setResult(
        await verify({
          method: chosen.method,
          ...(identity === null ? {} : { userInformation: identity }),
          idCardRef: documentRef,
          currentFaceRef,
          livenessRef,
          idCardFaceRef,
        }),
      )
    } catch (cause) {
      setResult(null)
      setError(cause instanceof ApiError ? cause.message : 'Something went wrong. Please try again.')
    } finally {
      setVerifying(false)
    }
  }, [chosen, identity, documentRef, currentFaceRef, livenessRef, idCardFaceRef])

  const reset = useCallback(() => {
    setResult(null)
    setError(null)
  }, [])

  const value = useMemo<VerificationValue>(
    () => ({
      methods,
      selected,
      select: setSelected,
      missing,
      canVerify: Boolean(chosen) && !chosen!.isOcr && chosen!.available && missing.length === 0,
      blockingReason,
      verifying,
      result,
      error,
      verify: runVerify,
      reset,
    }),
    [methods, selected, missing, chosen, blockingReason, verifying, result, error, runVerify, reset],
  )

  return <VerificationContext value={value}>{children}</VerificationContext>
}