import { useEffect, useRef } from 'react'

import { useVerification } from '../../features/verification/VerificationContext'
import type { UploadedRecord } from '../../lib/api'
import { FieldCheckList } from './FieldCheckList'
import { IDENTITY_FORM_FIELDS } from './identityFields'
import { sectionsOf } from './sectionRows'
import { runStatusSentence } from './statusDisplay'

/**
 * The list's Preview dialog (D23, requirement 10): what one row holds, and —
 * once it has been verified — how that went.
 *
 * The stored run renders through the same `FieldCheckList` and section rows
 * the live report uses, so a preview cannot phrase a status differently from
 * the screen that produced it. A record not yet verified says so plainly
 * rather than showing an empty report (§13, §25).
 *
 * Three exits, like the export dialog: Close, Escape, the backdrop.
 */
export function RecordPreviewModal({
  record,
  onClose,
}: {
  readonly record: UploadedRecord
  readonly onClose: () => void
}) {
  const { methods } = useVerification()
  const closeButtonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    closeButtonRef.current?.focus()
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      opener?.focus()
    }
  }, [onClose])

  const verification = record.verification
  const methodLabel = verification
    ? (methods.find((method) => method.method === verification.method)?.label ??
      verification.method)
    : null

  return (
    // Backdrop: a click anywhere outside the dialog closes it.
    <div
      className="bg-ink/80 fixed inset-0 z-50 flex items-center justify-center p-4"
      onClick={onClose}
      role="presentation"
    >
      {/* Dialog: clicks inside must not fall through to the backdrop. */}
      <div
        aria-label="Record preview"
        aria-modal="true"
        className="bg-surface text-ink max-h-[90vh] w-full max-w-2xl overflow-auto rounded-lg p-6"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold">Record preview</h2>
            <p className="text-ink-subtle mt-1 text-xs">
              {recordLabel(record)} · {record.status === 'verified' ? 'Verified' : 'Pending'}
            </p>
          </div>
          <button
            className="btn-secondary shrink-0 px-3 py-1.5"
            onClick={onClose}
            ref={closeButtonRef}
            type="button"
          >
            Close
          </button>
        </div>

        <section className="mt-5">
          <h3 className="text-sm font-semibold">Imported values</h3>
          <table className="mt-2 w-full text-left text-xs">
            <thead className="text-ink-subtle">
              <tr>
                <th className="py-1 pr-3 font-medium">Field</th>
                <th className="py-1 font-medium">Value</th>
              </tr>
            </thead>
            <tbody>
              {IDENTITY_FORM_FIELDS.map((field) => {
                const value = record.values[field.name]
                return (
                  <tr className="border-border border-t" key={field.name}>
                    <td className="py-1.5 pr-3">{field.label}</td>
                    <td className="py-1.5">
                      {value === null || value.trim() === '' ? '—' : value}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </section>

        <section className="mt-5">
          <h3 className="text-sm font-semibold">Verification</h3>
          {verification ? (
            <>
              <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
                <div className="flex gap-2">
                  <dt className="text-ink-muted font-medium">Method</dt>
                  <dd>{methodLabel}</dd>
                </div>
                <div className="flex gap-2">
                  <dt className="text-ink-muted font-medium">Result</dt>
                  <dd>{runStatusSentence(verification.status)}</dd>
                </div>
                <div className="flex gap-2">
                  <dt className="text-ink-muted font-medium">Verified at</dt>
                  <dd>{new Date(verification.verifiedAt * 1000).toLocaleString()}</dd>
                </div>
              </dl>
              <FieldCheckList
                fields={verification.identity.fields}
                sections={sectionsOf([verification])}
              />
              <p className="text-ink-subtle mt-2 text-xs">
                Stored with this record when the run finished (D23).
              </p>
            </>
          ) : (
            <p className="text-ink-subtle mt-2 text-xs" role="status">
              This record has not been verified yet. Press Start to fill the workspace with it.
            </p>
          )}
        </section>

        <div className="mt-6 flex justify-end">
          <button className="btn-secondary px-4 py-1.5" onClick={onClose} type="button">
            Close
          </button>
        </div>
      </div>
    </div>
  )
}

/** The row's person in words: the English name, or the ID when there is none. */
function recordLabel(record: UploadedRecord): string {
  const first = record.values.firstNameEnglish ?? ''
  const last = record.values.lastNameEnglish ?? ''
  const joined = `${first} ${last}`.trim()
  if (joined !== '') return joined
  const nationalId = record.values.nationalId ?? ''
  return nationalId.trim() === '' ? record.id : nationalId
}
