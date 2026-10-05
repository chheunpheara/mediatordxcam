import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from 'react'
import { DayPicker } from 'react-day-picker'

import 'react-day-picker/style.css'

/**
 * A date field with a react-day-picker calendar popup (D20).
 *
 * Replaces the browser's native `<input type="date">` picker on the Identity
 * Information form: the text input keeps the contract the rest of the app
 * relies on — a labelled control holding `YYYY-MM-DD`, editable by typing and
 * drivable by `fireEvent.change` — while the calendar button opens the
 * library's WAI-ARIA calendar instead of the platform's.
 *
 * Typing keeps the native input's strictness: only digits and dashes enter,
 * and a value that is not a real `YYYY-MM-DD` date when focus leaves is
 * cleared — a partial "1994" must never count as a filled required field.
 *
 * Keyboard: react-day-picker owns the grid (arrows walk days and weeks and
 * cross months, Home/End/PageUp/PageDown included, roving focus over a real
 * `role="grid"`); Escape closes and returns to the input, and clicking
 * outside closes it.
 */

/**
 * Brand colour and cell sizing for the calendar, applied as custom
 * properties on the DayPicker root — inline so they win no matter how the
 * library stylesheet is ordered against ours.
 */
const CALENDAR_STYLE = {
  '--rdp-accent-color': 'var(--color-brand)',
  '--rdp-day-width': '2rem',
  '--rdp-day-height': '2rem',
  '--rdp-day_button-width': '2rem',
  '--rdp-day_button-height': '2rem',
  '--rdp-nav_button-width': '2rem',
  '--rdp-nav_button-height': '2rem',
} as CSSProperties

export interface DateInputProps {
  readonly id: string
  readonly name: string
  /** `YYYY-MM-DD`, or empty. */
  readonly value: string
  readonly required?: boolean | undefined
  readonly placeholder?: string | undefined
  readonly ariaDescribedBy?: string | undefined
  readonly onChange: (value: string) => void
}

export function DateInput({
  ariaDescribedBy,
  id,
  name,
  onChange,
  placeholder,
  required,
  value,
}: DateInputProps) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const selected = parseIso(value)
  const anchor = selected ?? today()

  // A click anywhere outside the field dismisses the calendar.
  useEffect(() => {
    if (!open) return
    function onPointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [open])

  const toggle = (): void => {
    if (open) {
      closeCalendar(false)
    } else {
      setOpen(true)
    }
  }

  const closeCalendar = (focusInput: boolean): void => {
    setOpen(false)
    if (focusInput) inputRef.current?.focus()
  }

  const pick = (date: Date): void => {
    onChange(formatIso(date))
    closeCalendar(true)
  }

  // Only well-formed shapes reach the form: digits and dashes while typing…
  const handleInput = (raw: string): void => {
    if (raw === '' || /^[\d-]*$/.test(raw)) onChange(raw)
  }

  // …and a real date or nothing at all once focus leaves (the native input
  // discarded partials the same way).
  const handleBlur = (): void => {
    if (value !== '' && !parseIso(value)) onChange('')
  }

  return (
    <div className="relative mt-1" onKeyDown={handleKeyDown} ref={rootRef}>
      <input
        aria-describedby={ariaDescribedBy}
        className="input pr-10"
        id={id}
        name={name}
        ref={inputRef}
        onBlur={handleBlur}
        onChange={(event) => handleInput(event.target.value)}
        placeholder={placeholder}
        required={required}
        type="text"
        value={value}
      />
      <button
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label="Open calendar"
        className="text-ink-subtle hover:text-brand absolute inset-y-0 right-0 flex w-10 items-center justify-center rounded-r-lg"
        onClick={toggle}
        type="button"
      >
        <svg
          aria-hidden="true"
          className="h-4 w-4"
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          viewBox="0 0 24 24"
        >
          <rect height="18" rx="2" width="18" x="3" y="4" />
          <path d="M16 2v4M8 2v4M3 10h18" />
        </svg>
      </button>

      {open ? (
        <div
          aria-label="Choose a date"
          className="border-border bg-surface-raised absolute top-full left-0 z-30 mt-1 w-64 rounded-lg border p-3 shadow-lg"
          role="dialog"
        >
          <DayPicker
            autoFocus
            defaultMonth={anchor}
            mode="single"
            onSelect={(date) => {
              if (date) pick(date)
            }}
            selected={selected ?? undefined}
            style={CALENDAR_STYLE}
          />
        </div>
      ) : null}
    </div>
  )

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    // The grid owns every other key; Escape alone dismisses the dialog.
    if (open && event.key === 'Escape') closeCalendar(true)
  }
}

function today(): Date {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), now.getDate())
}

/** Parse `YYYY-MM-DD` into a local date; impossible shapes answer `null`. */
function parseIso(raw: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(year, month - 1, day)
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null
  }
  return date
}

function formatIso(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}
