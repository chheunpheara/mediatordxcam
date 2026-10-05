import type { FieldCheckStatus, VerifyResponse } from '../../lib/api'

/** One appended section outcome, shaped like the field rows beside it (§25, D15). */
export interface VerificationSectionRow {
  readonly label: string
  readonly status: FieldCheckStatus
}

/**
 * The method's required sections as rows for the status list (D15): Face, ID
 * card, then Liveness. A section the method did not ask for contributes
 * nothing, and `verified: null` stays the neutral dash — §25 forbids showing an
 * unknown result as a failure.
 */
export function sectionsOf(result: VerifyResponse): readonly VerificationSectionRow[] {
  const sections = [
    { label: 'Face verification', outcome: result.face },
    { label: 'ID card check', outcome: result.idCard },
    { label: 'Liveness check', outcome: result.liveness },
  ]
  return sections
    .filter((section) => section.outcome.required)
    .map((section) => ({
      label: section.label,
      status:
        section.outcome.verified === null
          ? 'not_checked'
          : section.outcome.verified
            ? 'matched'
            : 'mismatch',
    }))
}
