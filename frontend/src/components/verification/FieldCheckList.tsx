import type { FieldCheckStatus, IdentityFieldOutcome } from '../../lib/api'
import { IDENTITY_FORM_FIELDS } from './identityFields'

/**
 * The report's identity section: one row per §14 field, `field | status` (§25).
 *
 * Colour never carries the meaning alone (§32): each status is a tint *plus*
 * an icon *plus* the word, so the result reads the same in greyscale and to a
 * screen reader. A field the registry never compared keeps the neutral dash and
 * "Not checked" — §25 forbids presenting it as a failure, so it is neither a
 * green tick nor a red cross.
 */
export function FieldCheckList({
  fields,
}: {
  readonly fields: readonly IdentityFieldOutcome[]
}) {
  return (
    <ul
      aria-label="Identity field results"
      className="border-border bg-surface divide-y text-ink mt-2 rounded-lg border text-xs"
    >
      {fields.map((entry) => (
        <li className="flex items-center justify-between gap-3 px-3 py-1.5" key={entry.field}>
          <span>{fieldLabel(entry.field)}</span>
          <span className={`flex items-center gap-1.5 font-medium ${statusTone(entry.status)}`}>
            <StatusIcon status={entry.status} />
            {statusWord(entry.status)}
          </span>
        </li>
      ))}
    </ul>
  )
}

/** §14's field names as the form already labels them; unknown names still read as words. */
function fieldLabel(field: string): string {
  const known = IDENTITY_FORM_FIELDS.find((row) => row.name === field)
  if (known) return known.label
  const words = field.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

function statusWord(status: FieldCheckStatus): string {
  switch (status) {
    case 'matched':
      return 'Matched'
    case 'mismatch':
      return 'Mismatched'
    case 'not_checked':
      return 'Not checked'
  }
}

function statusTone(status: FieldCheckStatus): string {
  switch (status) {
    case 'matched':
      return 'text-positive'
    case 'mismatch':
      return 'text-negative'
    case 'not_checked':
      return 'text-ink-muted'
  }
}

/** Decorative: the adjacent word carries the meaning (§32). */
function StatusIcon({ status }: { readonly status: FieldCheckStatus }) {
  const path =
    status === 'matched'
      ? 'M20 6 9 17l-5-5'
      : status === 'mismatch'
        ? 'M18 6 6 18M6 6l12 12'
        : 'M5 12h14'
  return (
    <svg
      aria-hidden="true"
      className="h-3.5 w-3.5 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2.5}
      viewBox="0 0 24 24"
    >
      <path d={path} />
    </svg>
  )
}
