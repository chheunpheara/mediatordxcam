import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { IDENTITY_FIELDS, type IdentityFieldOutcome } from '@/lib/api'
import { FieldCheckList } from './FieldCheckList'

/**
 * The §25 report's identity rows (verification-flow: `field | status`, icons
 * paired with words, `not_checked` never rendered as a failure — §32).
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

    expect(screen.getByRole('list', { name: 'Identity field results' })).toBeInTheDocument()
    expect(within(screen.getByRole('list')).queryAllByRole('listitem')).toHaveLength(0)
  })
})
