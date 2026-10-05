import { fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { DateInput } from './DateInput'

/**
 * The Identity Information datepicker (D20).
 *
 * The contract that matters: the labelled control still holds `YYYY-MM-DD`
 * for the draft (typing and `fireEvent.change` keep working exactly as the
 * native input did), the react-day-picker calendar replaces only the platform
 * picker, and a partial or lettered entry can never masquerade as a filled
 * required field.
 */

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]

function Harness({ initial = '' }: { readonly initial?: string }) {
  const [value, setValue] = useState(initial)
  return (
    <>
      <label htmlFor="dob">Date of Birth *</label>
      <DateInput
        id="dob"
        name="dateOfBirth"
        onChange={setValue}
        placeholder="YYYY-MM-DD"
        required
        value={value}
      />
    </>
  )
}

function openCalendar() {
  fireEvent.click(screen.getByRole('button', { name: 'Open calendar' }))
  return screen.getByRole('dialog', { name: 'Choose a date' })
}

describe('DateInput', () => {
  it('keeps the label on a single text input holding the ISO value', () => {
    render(<Harness initial="1994-02-11" />)

    const matches = screen.getAllByLabelText(/^Date of Birth/)
    expect(matches).toHaveLength(1)
    expect(matches[0]).toHaveAttribute('type', 'text')
    expect(matches[0]).toHaveValue('1994-02-11')
    expect(matches[0]).toHaveAttribute('placeholder', 'YYYY-MM-DD')
  })

  it('opens the calendar anchored to the value, focus on the selected day', () => {
    render(<Harness initial="1994-02-11" />)

    const dialog = openCalendar()

    expect(dialog).toHaveTextContent('February 1994')
    const selected = within(dialog).getByRole('button', { name: /February 11th, 1994/ })
    expect(selected).toHaveAccessibleName('Friday, February 11th, 1994, selected')
    expect(selected.closest('td')).toHaveAttribute('aria-selected', 'true')
    expect(document.activeElement).toBe(selected)
    expect(screen.getByRole('button', { name: 'Open calendar' })).toHaveAttribute(
      'aria-expanded',
      'true',
    )
  })

  it('writes a picked day as YYYY-MM-DD, closes and returns to the input', () => {
    render(<Harness initial="1994-02-11" />)
    const dialog = openCalendar()

    fireEvent.click(within(dialog).getByRole('button', { name: /February 15th, 1994/ }))

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    const input = screen.getByLabelText(/^Date of Birth/)
    expect(input).toHaveValue('1994-02-15')
    expect(document.activeElement).toBe(input)
    expect(screen.getByRole('button', { name: 'Open calendar' })).toHaveAttribute(
      'aria-expanded',
      'false',
    )
  })

  it('moves between months with the header buttons', () => {
    render(<Harness initial="1994-02-11" />)
    openCalendar()

    fireEvent.click(screen.getByRole('button', { name: /next month/i }))
    expect(screen.getByRole('dialog')).toHaveTextContent('March 1994')

    fireEvent.click(screen.getByRole('button', { name: /previous month/i }))
    fireEvent.click(screen.getByRole('button', { name: /previous month/i }))
    expect(screen.getByRole('dialog')).toHaveTextContent('January 1994')
  })

  it('walks days with the arrow keys, crossing into the next month', () => {
    render(<Harness initial="1994-02-11" />)
    openCalendar()

    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' })
    expect(document.activeElement).toHaveAccessibleName(/Saturday, February 12th, 1994/)

    // 12 → 19 → 26 → March 5 (February 1994 has 28 days).
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })

    expect(screen.getByRole('dialog')).toHaveTextContent('March 1994')
    expect(document.activeElement).toHaveAccessibleName(/March 5th, 1994/)
  })

  it('closes on Escape and gives focus back to the input', () => {
    render(<Harness initial="1994-02-11" />)
    openCalendar()

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(document.activeElement).toBe(screen.getByLabelText(/^Date of Birth/))
  })

  it('closes when the click lands outside the field', () => {
    render(
      <>
        <Harness initial="1994-02-11" />
        <button type="button">Elsewhere</button>
      </>,
    )
    openCalendar()

    fireEvent.mouseDown(screen.getByRole('button', { name: 'Elsewhere' }))

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('anchors an empty field to today and marks today’s date', () => {
    render(<Harness initial="" />)
    const dialog = openCalendar()

    const now = new Date()
    const monthTitle = `${MONTHS[now.getMonth()]} ${now.getFullYear()}`
    expect(dialog).toHaveTextContent(monthTitle)

    const today = within(dialog).getByRole('button', { name: /^Today,/ })
    expect(today).toHaveAccessibleName(
      expect.stringMatching(
        `^Today, .*${MONTHS[now.getMonth()]} ${now.getDate()}(st|nd|rd|th), ${now.getFullYear()}$`,
      ),
    )
    expect(today.closest('td')).toHaveAttribute('data-today')
    expect(document.activeElement).toBe(today)
  })

  it('never lets letters reach the form', () => {
    const onChange = vi.fn()
    render(
      <>
        <label htmlFor="dob">Date of Birth *</label>
        <DateInput id="dob" name="dateOfBirth" onChange={onChange} value="1994-02-11" />
      </>,
    )

    fireEvent.change(screen.getByLabelText(/^Date of Birth/), { target: { value: 'banana' } })

    expect(onChange).not.toHaveBeenCalled()
  })

  it('keeps partial digits while typing but clears them on blur', () => {
    render(<Harness initial="1994-02-11" />)
    const input = screen.getByLabelText(/^Date of Birth/)

    fireEvent.change(input, { target: { value: '199' } })
    expect(input).toHaveValue('199')

    fireEvent.blur(input)
    expect(input).toHaveValue('')

    fireEvent.change(input, { target: { value: '1994-02-11' } })
    fireEvent.blur(input)
    expect(input).toHaveValue('1994-02-11')
  })

  it('clears an impossible date on blur — 1994-02-31 never counts as filled', () => {
    render(<Harness initial="1994-02-31" />)
    const input = screen.getByLabelText(/^Date of Birth/)

    fireEvent.blur(input)

    expect(input).toHaveValue('')
  })
})
