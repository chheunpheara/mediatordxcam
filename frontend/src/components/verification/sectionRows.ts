import type { FieldCheckStatus, VerifyResponse } from '../../lib/api'

/** One appended section outcome, shaped like the field rows beside it (§25, D15). */
export interface VerificationSectionRow {
  readonly label: string
  readonly status: FieldCheckStatus
}

/**
 * The session's section rows, accumulated across every run (D16): each method
 * reports only the sections it required, so a row appears the first time a
 * method reports that section, its status refreshes on later runs, and a
 * section a later method does not ask about keeps the row it already earned.
 * Order is first-appearance.
 *
 * `verified: null` stays the neutral dash — §25 forbids showing an unknown
 * result as a failure.
 */
export function sectionsOf(results: readonly VerifyResponse[]): readonly VerificationSectionRow[] {
  const rows = new Map<string, FieldCheckStatus>()
  for (const result of results) {
    const sections = [
      { label: 'Face verification', outcome: result.face },
      { label: 'ID card check', outcome: result.idCard },
      { label: 'Liveness check', outcome: result.liveness },
    ]
    for (const section of sections) {
      if (!section.outcome.required) continue
      const status =
        section.outcome.verified === null
          ? 'not_checked'
          : section.outcome.verified
            ? 'matched'
            : 'mismatch'
      // Re-setting an existing key refreshes its status but keeps its position.
      rows.set(section.label, status)
    }
  }
  return [...rows].map(([label, status]) => ({ label, status }))
}
