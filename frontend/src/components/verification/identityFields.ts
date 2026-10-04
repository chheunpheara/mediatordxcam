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
}

export const IDENTITY_FORM_FIELDS: readonly IdentityFormField[] = [
  { name: 'nationalId', label: 'National ID', required: true },
  { name: 'firstNameKhmer', label: 'First Name — Khmer', hint: 'ឈ្មោះដំបូង', required: true },
  { name: 'lastNameKhmer', label: 'Last Name — Khmer', hint: 'ឈ្មោះគ្រួសារ' },
  { name: 'firstNameEnglish', label: 'First Name — English' },
  { name: 'lastNameEnglish', label: 'Last Name — English' },
  { name: 'gender', label: 'Gender' },
  { name: 'dateOfBirth', label: 'Date of Birth', hint: 'YYYY-MM-DD', required: true },
  { name: 'issuedDate', label: 'Issued Date', hint: 'YYYY-MM-DD' },
  { name: 'expiryDate', label: 'Expired Date', hint: 'YYYY-MM-DD' },
]
