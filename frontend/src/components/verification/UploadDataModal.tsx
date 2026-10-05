import { useEffect, useId, useRef, useState } from 'react'

import { ApiError, createRecords, fetchRecordMapping, saveRecordMapping } from '../../lib/api'
import type { ColumnMapping, IdentityFieldName, RecordValuesInput } from '../../lib/api'
import { IDENTITY_FORM_FIELDS } from './identityFields'
import { ACCEPTED_UPLOAD_EXTENSIONS, parseSpreadsheet } from './uploadParse'
import type { ParseSuccess } from './uploadParse'

/**
 * The upload dialog (D23): file, map fields, review — then the rows land in
 * the records list below the workspace.
 *
 * The file is read in the browser (`xlsx`, the same library that writes the
 * exports) and only the mapped values are ever submitted: headers, unmapped
 * columns and the bytes themselves stay here (§29). The mapping step pairs
 * each §14 field with one column — one column cannot feed two fields, because
 * the saved default is keyed column-first — and offers to remember the choice
 * as the one reusable default, re-applied the next time a file's columns line
 * up.
 *
 * Three exits, like the export dialog: Close, Escape, the backdrop. Opening
 * moves focus to Close and closing gives it back to the button that opened
 * this dialog.
 */

type Step = 'upload' | 'map' | 'review'

const STEPS: readonly { readonly id: Step; readonly label: string }[] = [
  { id: 'upload', label: 'Upload file' },
  { id: 'map', label: 'Map fields' },
  { id: 'review', label: 'Review' },
]

type FieldMapping = Partial<Record<IdentityFieldName, string>>

export function UploadDataModal({
  onClose,
  onUploaded,
}: {
  readonly onClose: () => void
  readonly onUploaded?: (count: number) => void
}) {
  const formId = useId()
  const [step, setStep] = useState<Step>('upload')
  const [fileName, setFileName] = useState<string | null>(null)
  const [parsed, setParsed] = useState<ParseSuccess | null>(null)
  const [parsing, setParsing] = useState(false)
  const [fileError, setFileError] = useState<string | null>(null)
  const [mapping, setMapping] = useState<FieldMapping>({})
  const [touched, setTouched] = useState(false)
  const [savedMapping, setSavedMapping] = useState<ColumnMapping | null>(null)
  const [appliedSaved, setAppliedSaved] = useState(false)
  const [remember, setRemember] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
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

  // The saved default is a convenience: a failure here simply means no
  // pre-fill, so it is never surfaced as an error.
  useEffect(() => {
    let active = true
    fetchRecordMapping()
      .then((saved) => {
        if (active) setSavedMapping(saved)
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [])

  const headers = parsed?.headers ?? []
  const mapped = IDENTITY_FORM_FIELDS.flatMap((field) => {
    const column = mapping[field.name]
    return column && parsed ? [{ field: field.name, label: field.label, column }] : []
  })

  const handleFile = async (file: File): Promise<void> => {
    setParsing(true)
    setFileError(null)
    const result = await parseSpreadsheet(file)
    setParsing(false)
    if (!result.ok) {
      setFileError(result.message)
      setFileName(null)
      setParsed(null)
      return
    }
    setFileName(file.name)
    setParsed(result)
    setMapping({})
    setTouched(false)
    setAppliedSaved(false)
    setError(null)
  }

  const openMapStep = (): void => {
    if (!parsed) return
    // A file picked after an earlier mapping keeps only what still exists.
    const kept = keepKnownColumns(mapping, headers)
    // Until the user edits a select, the saved default is pre-applied when
    // its columns line up with this file. (The fetch races the click only in
    // theory: it is one local round-trip issued when the dialog opened.)
    if (!touched && Object.keys(kept).length === 0 && savedMapping) {
      const applied = applyMapping(savedMapping, headers)
      if (Object.keys(applied).length > 0) {
        setMapping(applied)
        setAppliedSaved(true)
        setStep('map')
        return
      }
    }
    setMapping(kept)
    setAppliedSaved(false)
    setStep('map')
  }

  const chooseColumn = (field: IdentityFieldName, column: string): void => {
    setTouched(true)
    setAppliedSaved(false)
    setMapping((current) => {
      const next = { ...current }
      if (column) next[field] = column
      else delete next[field]
      return next
    })
  }

  const rowValues = (rowIndex: number): RecordValuesInput => {
    const values: RecordValuesInput = {}
    const row = parsed?.rows[rowIndex] ?? []
    for (const { field, column } of mapped) {
      const cell = row[headers.indexOf(column)] ?? ''
      values[field] = cell
    }
    return values
  }

  const needsValues = parsed
    ? parsed.rows.filter(
        (_row, rowIndex) =>
          mapped.some(
            ({ column }) =>
              ((parsed.rows[rowIndex] ?? [])[headers.indexOf(column)] ?? '') === '',
          ),
      ).length
    : 0

  const handleSubmit = async (): Promise<void> => {
    if (!parsed || mapped.length === 0) return
    setSubmitting(true)
    setError(null)
    try {
      if (remember) {
        const payload: Record<string, IdentityFieldName> = {}
        for (const { field, column } of mapped) {
          payload[column] = field
        }
        await saveRecordMapping(payload)
      }
      const records = parsed.rows.map((_row, rowIndex) => rowValues(rowIndex))
      await createRecords(records)
      onUploaded?.(records.length)
      onClose()
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'Something went wrong. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  const forwardDisabled =
    step === 'upload' ? parsed === null || parsing : mapped.length === 0

  const handleForward = (): void => {
    if (step === 'upload') openMapStep()
    else if (step === 'map') setStep('review')
  }

  return (
    <div
      className="bg-ink/80 fixed inset-0 z-50 flex items-center justify-center p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        aria-label="Upload records"
        aria-modal="true"
        className="bg-surface text-ink max-h-[90vh] w-full max-w-4xl overflow-auto rounded-lg p-6"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold">Upload records</h2>
            <p className="text-ink-subtle mt-1 text-xs">
              Bring a CSV or Excel list in, match its columns to the identity fields, review, and
              add it to the verification list.
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

        <ol className="text-ink-subtle mt-4 flex flex-wrap gap-4 text-xs" aria-label="Steps">
          {STEPS.map((entry, index) => (
            <li
              aria-current={step === entry.id ? 'step' : undefined}
              className={step === entry.id ? 'text-ink font-semibold' : undefined}
              key={entry.id}
            >
              {index + 1}. {entry.label}
            </li>
          ))}
        </ol>

        {step === 'upload' ? (
          <section className="mt-5" aria-label="Choose a file">
            <h3 className="text-sm font-semibold">Choose a CSV or Excel file</h3>
            <p className="text-ink-subtle mt-1 text-xs leading-relaxed">
              The first row must be the column names. The file is read in your browser — only the
              mapped values below are ever sent to the server.
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <input
                accept={ACCEPTED_UPLOAD_EXTENSIONS}
                className="peer sr-only"
                disabled={parsing}
                id={`${formId}-file`}
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  // Allow re-picking the same file after a failed read.
                  event.target.value = ''
                  if (file) void handleFile(file)
                }}
                type="file"
              />
              <label className="btn-secondary cursor-pointer px-4 py-1.5" htmlFor={`${formId}-file`}>
                {parsing ? 'Reading…' : 'Choose file'}
              </label>
              <span className="text-ink-muted text-xs">{fileName ?? 'No file chosen'}</span>
            </div>
            {parsed ? (
              <p className="text-ink-muted mt-3 text-xs" role="status">
                {fileName} — {parsed.rows.length} row{parsed.rows.length === 1 ? '' : 's'} ·{' '}
                {parsed.headers.length} column{parsed.headers.length === 1 ? '' : 's'}
              </p>
            ) : null}
            {fileError ? (
              <p
                className="border-negative bg-negative-soft text-negative mt-3 rounded-lg border px-3 py-2 text-xs"
                role="alert"
              >
                {fileError}
              </p>
            ) : null}
          </section>
        ) : null}

        {step === 'map' && parsed ? (
          <section className="mt-5" aria-label="Map fields">
            <h3 className="text-sm font-semibold">Map your columns</h3>
            <p className="text-ink-subtle mt-1 text-xs leading-relaxed">
              Pair each system field with a column from {fileName}. One column can fill only one
              field.
            </p>
            {appliedSaved ? (
              <p className="text-ink-muted mt-2 text-xs" role="status">
                Your saved mapping was applied.
              </p>
            ) : null}
            <ul className="mt-3 space-y-3">
              {IDENTITY_FORM_FIELDS.map((field) => {
                const inputId = `${formId}-${field.name}`
                const column = mapping[field.name] ?? ''
                const previewIndex = column ? headers.indexOf(column) : -1
                const preview =
                  previewIndex === -1 ? null : (parsed.rows[0]?.[previewIndex] ?? '')
                return (
                  <li className="grid items-center gap-2 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_minmax(0,10rem)]" key={field.name}>
                    <label className="text-ink-muted text-xs font-semibold" htmlFor={inputId}>
                      {field.label}
                    </label>
                    <select
                      className="border-border bg-surface text-ink focus:border-brand w-full rounded-lg border px-3 py-1.5 text-sm focus:outline-none"
                      id={inputId}
                      onChange={(event) => chooseColumn(field.name, event.target.value)}
                      value={column}
                    >
                      <option value="">Not mapped</option>
                      {headers.map((header) => {
                        const usedByOther = IDENTITY_FORM_FIELDS.some(
                          (other) => other.name !== field.name && mapping[other.name] === header,
                        )
                        return (
                          <option disabled={usedByOther} key={header} value={header}>
                            {usedByOther ? `${header} (used)` : header}
                          </option>
                        )
                      })}
                    </select>
                    <span className="text-ink-subtle truncate text-xs" title={preview ?? undefined}>
                      {column === '' ? '—' : preview ? `e.g. ${preview}` : 'no value'}
                    </span>
                  </li>
                )
              })}
            </ul>
            <p className="text-ink-muted mt-3 text-xs" role="status">
              {mapped.length} of {IDENTITY_FORM_FIELDS.length} fields mapped.
              {mapped.length === 0 ? ' Map at least one field to continue.' : ''}
            </p>
            <label className="mt-3 flex items-center gap-2 text-xs">
              <input
                checked={remember}
                className="accent-brand"
                onChange={(event) => setRemember(event.target.checked)}
                type="checkbox"
              />
              Remember this mapping for future uploads
            </label>
          </section>
        ) : null}

        {step === 'review' && parsed ? (
          <section className="mt-5" aria-label="Review the records">
            <h3 className="text-sm font-semibold">Review the records</h3>
            <p className="text-ink-muted mt-1 text-xs" role="status">
              Ready to add {parsed.rows.length} record{parsed.rows.length === 1 ? '' : 's'}.
              {needsValues > 0
                ? ` ${needsValues} row${needsValues === 1 ? '' : 's'} need${needsValues === 1 ? 's' : ''} a value for a mapped field — you can fill ${needsValues === 1 ? 'it' : 'them'} in before verifying.`
                : ''}
            </p>
            <div className="border-border mt-3 max-h-64 overflow-auto rounded-lg border">
              <table className="w-full text-left text-xs">
                <thead className="text-ink-subtle bg-surface-sunken sticky top-0">
                  <tr>
                    <th className="px-3 py-2 font-medium">#</th>
                    {mapped.map(({ field, label }) => (
                      <th className="px-3 py-2 font-medium" key={field}>
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {parsed.rows.map((_row, rowIndex) => (
                    <tr className="border-border border-t" key={rowIndex}>
                      <td className="px-3 py-1.5 text-ink-subtle">{rowIndex + 1}</td>
                      {mapped.map(({ field, column }) => {
                        const value = (parsed.rows[rowIndex] ?? [])[headers.indexOf(column)] ?? ''
                        return (
                          <td
                            className={`px-3 py-1.5 ${value === '' ? 'text-negative' : ''}`}
                            key={field}
                          >
                            {value === '' ? '—' : value}
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ) : null}

        {error ? (
          <p
            className="border-negative bg-negative-soft text-negative mt-4 rounded-lg border px-3 py-2 text-xs"
            role="alert"
          >
            {error}
          </p>
        ) : null}

        <div className="mt-6 flex justify-end gap-2">
          <button className="btn-secondary px-4 py-1.5" onClick={onClose} type="button">
            Cancel
          </button>
          {step === 'review' ? (
            <>
              <button className="btn-secondary px-4 py-1.5" onClick={() => setStep('map')} type="button">
                Back
              </button>
              <button
                className="btn-primary px-4 py-1.5"
                disabled={submitting}
                onClick={() => void handleSubmit()}
                type="button"
              >
                {submitting ? 'Adding…' : 'Add to list'}
              </button>
            </>
          ) : (
            <>
              {step === 'map' ? (
                <button className="btn-secondary px-4 py-1.5" onClick={() => setStep('upload')} type="button">
                  Back
                </button>
              ) : null}
              <button
                className="btn-primary px-4 py-1.5"
                disabled={forwardDisabled}
                onClick={handleForward}
                type="button"
              >
                {step === 'upload' ? 'Map fields' : 'Next: Review'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

/** The saved mapping, restricted to columns this file actually has. */
function applyMapping(saved: ColumnMapping, headers: readonly string[]): FieldMapping {
  const applied: FieldMapping = {}
  for (const [column, field] of Object.entries(saved)) {
    if (headers.includes(column) && applied[field] === undefined) {
      applied[field] = column
    }
  }
  return applied
}

/** A mapping survives a file change only where its column still exists. */
function keepKnownColumns(current: FieldMapping, headers: readonly string[]): FieldMapping {
  const kept: FieldMapping = {}
  for (const field of IDENTITY_FORM_FIELDS) {
    const column = current[field.name]
    if (column && headers.includes(column)) kept[field.name] = column
  }
  return kept
}
