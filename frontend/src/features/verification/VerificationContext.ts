import { createContext, use } from 'react'

import type { IdentityFields, VerificationMethod, VerificationMethodId, VerifyResponse } from '../../lib/api'

/**
 * Verification method selection and result state (§10, §11).
 *
 * The method list lives here because it is fetched once and read by the method
 * cards, the enable/disable rule and the submit action. All three must agree on
 * what a method requires, so they read the same objects rather than each keeping
 * its own idea.
 */

/**
 * The inputs the session can supply to `POST /verify` (§19).
 *
 * Carried on the context as well as sent in the request, because the report's
 * preview column draws the very pictures that were verified — a component that
 * only saw the response could not show the face it was asked about.
 */
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

/** Plain-language name for a missing requirement flag, for the user's benefit. */
export const REQUIREMENT_LABELS: Readonly<Record<string, string>> = {
  userInfo: 'identity information',
  currentFace: 'a current photo of your face',
  idCard: 'your ID card',
  liveness: 'a liveness check',
  passport: 'a passport image',
}

export interface VerificationValue {
  readonly methods: readonly VerificationMethod[]
  readonly selected: VerificationMethodId | null
  readonly select: (method: VerificationMethodId) => void
  /** Requirements the selection needs but the session does not have yet. */
  readonly missing: readonly string[]
  /** False while loading, unavailable, or when something required is missing. */
  readonly canVerify: boolean
  readonly blockingReason: string | null
  readonly verifying: boolean
  readonly result: VerifyResponse | null
  /** What the session holds, for the report's preview column. */
  readonly inputs: SessionInputs
  /**
   * Every successful verification this session ran, in order (D16).
   *
   * The report's identity rows render from `result` — the latest run, so a
   * retry refreshes them — while section rows accumulate across the history:
   * a face outcome from an earlier run is not lost when a later method does
   * not ask about faces.
   */
  readonly history: readonly VerifyResponse[]
  /** Already user-facing. Rendered as-is; never a raw error (§24, §28). */
  readonly error: string | null
  readonly verify: () => Promise<void>
  readonly reset: () => void
}

export const VerificationContext = createContext<VerificationValue | null>(null)

export function useVerification(): VerificationValue {
  const value = use(VerificationContext)
  if (!value) {
    throw new Error('useVerification must be used inside a VerificationProvider')
  }
  return value
}