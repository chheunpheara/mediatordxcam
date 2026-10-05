import type { FieldCheckStatus, VerifyResponse } from '../../lib/api'

/** One appended section outcome, shaped like the field rows beside it (§25, D15). */
export interface VerificationSectionRow {
  readonly label: string
  readonly status: FieldCheckStatus
}

/**
 * The three sections, keyed for exports and labelled for display — one source
 * so a column picker and the list can never name a section differently.
 */
export const SECTION_COLUMNS = [
  { key: 'faceCheck', label: 'Face verification' },
  { key: 'idCardCheck', label: 'ID card check' },
  { key: 'livenessCheck', label: 'Liveness check' },
] as const

/** The export key for a section row's label, or `null` if it is not one. */
export function sectionKeyFor(label: string): string | null {
  return SECTION_COLUMNS.find((column) => column.label === label)?.key ?? null
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
    const sections = SECTION_COLUMNS.map((column) => {
      if (column.key === 'faceCheck') return { label: column.label, outcome: result.face }
      if (column.key === 'idCardCheck') return { label: column.label, outcome: result.idCard }
      return { label: column.label, outcome: result.liveness }
    })
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
