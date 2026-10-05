import type { FieldCheckStatus } from '../../lib/api'

/**
 * The words that sit beside every icon (§32): fields read as matched /
 * mismatched, sections as passed / failed, and an unknown result always as
 * "Not checked" — never as a failure (§25).
 */

export function statusWord(status: FieldCheckStatus): string {
  switch (status) {
    case 'matched':
      return 'Matched'
    case 'mismatch':
      return 'Mismatched'
    case 'not_checked':
      return 'Not checked'
  }
}

/** Sections speak as the report phrases them (§25): passed, failed, not checked. */
export function sectionWord(status: FieldCheckStatus): string {
  switch (status) {
    case 'matched':
      return 'Passed'
    case 'mismatch':
      return 'Failed'
    case 'not_checked':
      return 'Not checked'
  }
}
