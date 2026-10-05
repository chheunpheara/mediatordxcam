import { useId, useMemo } from 'react'

import type { IdentityResponse } from '../../lib/api'
import { DateInput } from './DateInput'
import { IDENTITY_FORM_FIELDS } from './identityFields'
import { resolveIdentity } from '../../features/id-card-processing/IdentityDraftContext'
import { useIdCardProcessing } from '../../features/id-card-processing/ProcessingContext'

/**
 * Column 3 — the editable KYC form (§14).
 *
 * Nine inputs, in the order §14 lists them, pre-filled from the OCR read and all
 * editable so the user can correct a misread (§14). Values are held in the
 * session draft, which is what §19 `POST /api/v1/kyc/verify` receives as "user
 * information"; nothing is written to the server from here.
 *
 * A field OCR did not read renders empty with a "Please enter this information."
 * prompt (§16) rather than being disabled or pre-filled with a guess. Nothing on
 * this form is ever marked verified (§13) — these are values the user is
 * asserting, not facts a government service has confirmed.
 */


export interface IdentityFormProps {
  readonly ocr: IdentityResponse
  /** True while the user has changed at least one field. */
  readonly hasDraft: boolean
}

export function IdentityForm({ ocr, hasDraft }: IdentityFormProps) {
  const { draft, setField, clearDraft } = useIdCardProcessing()
  const formId = useId()

  const values = useMemo(() => resolveIdentity(ocr.fields, draft), [ocr.fields, draft])
  const emptyRequired = useMemo(
    () => IDENTITY_FORM_FIELDS.filter((f) => f.required && values[f.name].trim() === '').map((f) => f.name),
    [values],
  )

  return (
    <section className="card flex flex-col p-5" aria-label="Identity information">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-ink-subtle text-sm font-semibold">Identity Information</h2>
        {hasDraft ? (
          <button
            className="btn-secondary px-2 py-1 text-xs"
            onClick={clearDraft}
            type="button"
          >
            Reset to OCR
          </button>
        ) : null}
      </div>

      <p className="text-ink-subtle mt-1 text-xs" role="status">
        {ocrStatusLabel(ocr)}
      </p>
      <p className="text-ink-subtle mt-2 text-xs leading-relaxed">
        Every field is editable so you can correct anything read incorrectly.
      </p>

      <form className="mt-4 grid gap-3" onSubmit={(e) => e.preventDefault()}>
        {IDENTITY_FORM_FIELDS.map((field) => {
          const wasMissing = ocr.missingFields.includes(field.name)
          const inputId = `${formId}-${field.name}`
          const hintId = `${inputId}-hint`
          const empty = values[field.name].trim() === ''

          return (
            <div key={field.name}>
              <label className="text-ink-muted block text-xs font-semibold" htmlFor={inputId}>
                {field.label}
                {field.required ? <span className="text-negative"> *</span> : null}
              </label>
              {field.hint ? (
                <p className="text-ink-subtle text-xs" id={hintId}>
                  {field.hint}
                </p>
              ) : null}
              {field.kind === 'date' ? (
                <DateInput
                  ariaDescribedBy={wasMissing || empty ? hintId : undefined}
                  id={inputId}
                  name={field.name}
                  onChange={(next) => setField(field.name, next)}
                  placeholder={field.hint}
                  required={field.required}
                  value={values[field.name]}
                />
              ) : (
                <input
                  aria-describedby={wasMissing || empty ? hintId : undefined}
                  className="input mt-1 w-full"
                  id={inputId}
                  name={field.name}
                  onChange={(event) => setField(field.name, event.target.value)}
                  placeholder={field.hint}
                  required={field.required}
                  type="text"
                  value={values[field.name]}
                />
              )}
              {empty && field.required ? (
                <p className="text-negative mt-1 text-xs">Please enter this information.</p>
              ) : wasMissing ? (
                <p className="text-ink-subtle mt-1 text-xs">
                  Not read from the card — please check and enter it.
                </p>
              ) : null}
            </div>
          )
        })}
      </form>

      {emptyRequired.length > 0 ? (
        <p className="text-ink-subtle mt-4 text-xs leading-relaxed">
          {emptyRequired.length === 1
            ? 'One required field still needs a value before verification can continue.'
            : `${emptyRequired.length} required fields still need values before verification can continue.`}
        </p>
      ) : (
        <p className="text-ink-subtle mt-4 text-xs leading-relaxed">
          All required fields have a value. CamDigiKey verification is not available yet, so
          nothing here has been checked against a government record.
        </p>
      )}

    </section>
  )
}

function ocrStatusLabel(ocr: IdentityResponse): string {
  switch (ocr.status) {
    case 'completed':
      return 'All fields were read from the card.'
    case 'partial':
      return `Some fields could not be read. Check the ${ocr.missingFields.length === 1 ? 'highlighted field' : `${ocr.missingFields.length} highlighted fields`} and fill ${ocr.missingFields.length === 1 ? 'it' : 'them'} in.`
    case 'unreadable':
      return 'Nothing could be read from this card. Please enter the details by hand.'
  }
}
