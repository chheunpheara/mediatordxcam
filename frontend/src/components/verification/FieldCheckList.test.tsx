import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { IDENTITY_FIELDS, type IdentityFieldOutcome } from '@/lib/api'
import { makeVerifyResult } from '@/test/fixtures'
import { FieldCheckList } from './FieldCheckList'
import { sectionsOf } from './sectionRows'

/**
 * The §25 report's rows (verification-flow: `field | status`, icons paired with
 * words, `not_checked` never rendered as a failure — §32), plus the method's
 * required sections appended beneath the fields as rows (D15).
 */

function outcome(
  field: IdentityFieldOutcome['field'],
  status: IdentityFieldOutcome['status'],
): IdentityFieldOutcome {
  return { field, status, submitted: null }
}

describe('FieldCheckList', () => {
  it('renders one row per field, labelled the way the form labels it', () => {
    const fields = IDENTITY_FIELDS.map((field) => outcome(field, 'matched'))
    render(<FieldCheckList fields={fields} />)

    const rows = screen.getAllByRole('listitem')
    expect(rows).toHaveLength(IDENTITY_FIELDS.length)
    expect(rows[0]!).toHaveTextContent('National ID')
    expect(rows[6]!).toHaveTextContent('Date of Birth')
    expect(rows[8]!).toHaveTextContent('Expired Date')
  })

  it('marks matched fields with a tick icon and the word, tinted positive (§32)', () => {
    render(<FieldCheckList fields={[outcome('nationalId', 'matched')]} />)

    const row = screen.getByRole('listitem')
    expect(row).toHaveTextContent('Matched')
    expect(row.querySelector('svg')).toBeTruthy()
    expect(row.querySelector('span:last-child')?.className).toContain('text-positive')
  })

  it('marks a mismatch with a cross icon and the word, never colour alone', () => {
    render(
      <FieldCheckList
        fields={[outcome('nationalId', 'matched'), outcome('dateOfBirth', 'mismatch')]}
      />,
    )

    const rows = screen.getAllByRole('listitem')
    const matched = rows[0]!
    const mismatched = rows[1]!
    expect(matched).toHaveTextContent('Matched')
    expect(matched.querySelector('span:last-child')?.className).toContain('text-positive')

    expect(mismatched).toHaveTextContent('Date of Birth')
    expect(mismatched).toHaveTextContent('Mismatched')
    expect(mismatched.querySelector('svg')).toBeTruthy()
    expect(mismatched.querySelector('span:last-child')?.className).toContain('text-negative')
  })

  it('renders an unchecked field as neither pass nor failure (§25)', () => {
    render(<FieldCheckList fields={[outcome('firstNameKhmer', 'not_checked')]} />)

    const row = screen.getByRole('listitem')
    expect(row).toHaveTextContent('Not checked')
    expect(row.querySelector('svg')).toBeTruthy()
    const tone = row.querySelector('span:last-child')?.className ?? ''
    expect(tone).not.toContain('text-positive')
    expect(tone).not.toContain('text-negative')
  })

  it('reads an unknown field name as words rather than raw camelCase', () => {
    render(<FieldCheckList fields={[outcome('someNewField', 'matched')]} />)

    expect(screen.getByText('Some new field')).toBeInTheDocument()
  })

  it('labels the list for assistive technology', () => {
    render(<FieldCheckList fields={[]} />)

    expect(screen.getByRole('list', { name: 'Verification results' })).toBeInTheDocument()
    expect(within(screen.getByRole('list')).queryAllByRole('listitem')).toHaveLength(0)
  })

  it('appends section rows beneath the fields, still icon and word per row (D15)', () => {
    render(
      <FieldCheckList
        fields={[outcome('nationalId', 'matched')]}
        sections={[
          { label: 'Face verification', status: 'matched' },
          { label: 'ID card check', status: 'mismatch' },
        ]}
      />,
    )

    const rows = screen.getAllByRole('listitem')
    expect(rows).toHaveLength(3)
    expect(rows[1]).toHaveTextContent('Face verification')
    expect(rows[1]).toHaveTextContent('Passed')
    expect(rows[1]!.querySelector('svg')).toBeTruthy()
    expect(rows[1]!.querySelector('span:last-child')?.className).toContain('text-positive')

    expect(rows[2]).toHaveTextContent('ID card check')
    expect(rows[2]).toHaveTextContent('Failed')
    expect(rows[2]!.querySelector('span:last-child')?.className).toContain('text-negative')
  })

  it('keeps a section with no result as neither pass nor failure (§25)', () => {
    render(
      <FieldCheckList fields={[]} sections={[{ label: 'Face verification', status: 'not_checked' }]} />,
    )

    const row = screen.getByRole('listitem')
    expect(row).toHaveTextContent('Not checked')
    const tone = row.querySelector('span:last-child')?.className ?? ''
    expect(tone).not.toContain('text-positive')
    expect(tone).not.toContain('text-negative')
  })
})

describe('sectionsOf', () => {
  it('turns each required section into a row, in Face, ID card, Liveness order', () => {
    const rows = sectionsOf(
      makeVerifyResult({
        face: { required: true, verified: true },
        liveness: { required: true, verified: false },
      }),
    )

    expect(rows.map((row) => row.label)).toEqual(['Face verification', 'Liveness check'])
    expect(rows.map((row) => row.status)).toEqual(['matched', 'mismatch'])
  })

  it('leaves out sections the method did not require — method 1 shows no face row', () => {
    expect(sectionsOf(makeVerifyResult())).toEqual([])
  })

  it('maps a required section with no result to not_checked, never a failure (§25)', () => {
    expect(sectionsOf(makeVerifyResult({ face: { required: true, verified: null } }))).toEqual([
      { label: 'Face verification', status: 'not_checked' },
    ])
  })
})
