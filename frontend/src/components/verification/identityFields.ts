import type { IdentityFieldName } from '../../lib/api'

/**
 * The form's rows: §14's nine fields, in §14's order.
 *
 * `required` drives the §16 prompt and the "still needs a value" count. Only
 * fields a card actually carries are required — a passport has no Khmer names,
 * so requiring them would ask the user for something the document cannot supply.
 *
 * `hint` is the script or format cue shown under the label.
 */
export interface IdentityFormField {
  readonly name: IdentityFieldName
  readonly label: string
  readonly hint?: string
  readonly required?: boolean
  /** Render through the calendar datepicker (`DateInput`) when `date`. */
  readonly kind?: 'date'
}

export const IDENTITY_FORM_FIELDS: readonly IdentityFormField[] = [
  { name: 'nationalId', label: 'National ID', required: true },
  { name: 'firstNameKhmer', label: 'First Name — Khmer', hint: 'ឈ្មោះដំបូង', required: true },
  { name: 'lastNameKhmer', label: 'Last Name — Khmer', hint: 'ឈ្មោះគ្រួសារ', required: true },
  { name: 'firstNameEnglish', label: 'First Name — English', required: true },
  { name: 'lastNameEnglish', label: 'Last Name — English', required: true },
  { name: 'gender', label: 'Gender', required: true },
  { name: 'dateOfBirth', label: 'Date of Birth', hint: 'YYYY-MM-DD', required: true, kind: 'date' },
  { name: 'issuedDate', label: 'Issued Date', hint: 'YYYY-MM-DD', required: true, kind: 'date' },
  { name: 'expiryDate', label: 'Expired Date', hint: 'YYYY-MM-DD', required: true, kind: 'date' },
]

/** §14's field names as the form already labels them; unknown names still read as words. */
export function fieldLabel(field: string): string {
  const known = IDENTITY_FORM_FIELDS.find((row) => row.name === field)
  if (known) return known.label
  const words = field.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase()
  return words.charAt(0).toUpperCase() + words.slice(1)
}
