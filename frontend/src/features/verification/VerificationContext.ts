import { createContext, use } from 'react'

import type { VerificationMethod, VerificationMethodId, VerifyResponse } from '../../lib/api'

/**
 * Verification method selection and result state (§10, §11).
 *
 * The method list lives here because it is fetched once and read by the method
 * cards, the enable/disable rule and the submit action. All three must agree on
 * what a method requires, so they read the same objects rather than each keeping
 * its own idea.
 */

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