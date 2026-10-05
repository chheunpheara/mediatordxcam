import type { FieldCheckStatus, IdentityFieldOutcome } from '../../lib/api'
import { fieldLabel } from './identityFields'
import type { VerificationSectionRow } from './sectionRows'
import { sectionWord, statusWord } from './statusDisplay'

/**
 * The report's list: one row per §14 field, `field | status` (§25), with the
 * session's section outcomes appended beneath as their own rows (D15) — one
 * shared list where a face outcome lives beside the identity fields rather
 * than in a line of prose, and survives later runs (D16).
 *
 * Colour never carries the meaning alone (§32): each status is a tint *plus*
 * an icon *plus* the word, so the result reads the same in greyscale and to a
 * screen reader. A field the registry never compared keeps the neutral dash and
 * "Not checked" — §25 forbids presenting it as a failure, so it is neither a
 * green tick nor a red cross.
 */
export function FieldCheckList({
  fields,
  sections = [],
}: {
  readonly fields: readonly IdentityFieldOutcome[]
  readonly sections?: readonly VerificationSectionRow[]
}) {
  return (
    <ul
      aria-label="Verification results"
      className="border-border bg-surface divide-y text-ink mt-2 rounded-lg border text-xs"
    >
      {fields.map((entry) => (
        <Row
          key={entry.field}
          label={fieldLabel(entry.field)}
          status={entry.status}
          word={statusWord(entry.status)}
        />
      ))}
      {sections.map((section) => (
        <Row
          key={section.label}
          label={section.label}
          status={section.status}
          word={sectionWord(section.status)}
        />
      ))}
    </ul>
  )
}

/** One `label | status` row: the word next to the icon carries the meaning (§32). */
function Row({
  label,
  status,
  word,
}: {
  readonly label: string
  readonly status: FieldCheckStatus
  readonly word: string
}) {
  return (
    <li className="flex items-center justify-between gap-3 px-3 py-1.5">
      <span>{label}</span>
      <span className={`flex items-center gap-1.5 font-medium ${statusTone(status)}`}>
        <StatusIcon status={status} />
        {word}
      </span>
    </li>
  )
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
