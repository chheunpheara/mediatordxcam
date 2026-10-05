import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'

/**
 * A date field with a Tailwind calendar popup (D20).
 *
 * Replaces the browser's native `<input type="date">` picker on the Identity
 * Information form: the text input keeps the contract the rest of the app
 * relies on — a labelled control holding `YYYY-MM-DD`, editable by typing and
 * drivable by `fireEvent.change` — while the calendar button opens a styled
 * month grid instead of the platform's.
 *
 * Typing keeps the native input's strictness: only digits and dashes enter,
 * and a value that is not a real `YYYY-MM-DD` date when focus leaves is
 * cleared — a partial "1994" must never count as a filled required field.
 *
 * Keyboard: the calendar opens with focus on its day, arrows move a day (or a
 * week), Escape closes and returns to the input. Clicking outside closes it.
 * No dependencies: months, weekdays and ISO strings are plain arithmetic.
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
] as const

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const

/** Arrow-key movement from the focused day, in days. */
const KEY_DELTAS: Readonly<Record<string, number>> = {
  ArrowLeft: -1,
  ArrowRight: 1,
  ArrowUp: -7,
  ArrowDown: 7,
}

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
  /** Explicit month navigation; `null` follows the current value. */
  const [view, setView] = useState<{ year: number; month: number } | null>(null)
  /** The day the keyboard is on inside the open calendar. */
  const [focusedDate, setFocusedDate] = useState<Date | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const popupRef = useRef<HTMLDivElement>(null)

  const selected = parseIso(value)
  const anchor = selected ?? today()
  const current = view ?? { year: anchor.getFullYear(), month: anchor.getMonth() }
  const todayDate = today()

  // Opening puts the keyboard on the selected day (today when empty) — the
  // calendar is open *at* the date that matters, not at some default.
  useEffect(() => {
    if (!open || !focusedDate) return
    const day = popupRef.current?.querySelector<HTMLElement>(
      `[data-date="${formatIso(focusedDate)}"]`,
    )
    day?.focus()
  }, [open, focusedDate])

  // A click anywhere outside the field dismisses the calendar.
  useEffect(() => {
    if (!open) return
    function onPointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false)
        setView(null)
      }
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [open])

  const toggle = (): void => {
    if (open) {
      closeCalendar(false)
    } else {
      setFocusedDate(selected ?? today())
      setOpen(true)
    }
  }

  const closeCalendar = (focusInput: boolean): void => {
    setOpen(false)
    setView(null)
    if (focusInput) inputRef.current?.focus()
  }

  const pick = (date: Date): void => {
    onChange(formatIso(date))
    closeCalendar(true)
  }

  const goMonth = (delta: number): void => {
    const next = addMonths(current, delta)
    setView(next)
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
          ref={popupRef}
          role="dialog"
        >
          <div className="flex items-center justify-between">
            <button
              aria-label="Previous month"
              className="text-ink-subtle hover:text-brand rounded-md p-1"
              onClick={() => goMonth(-1)}
              type="button"
            >
              <Chevron direction="left" />
            </button>
            <span className="text-sm font-semibold">
              {MONTHS[current.month]} {current.year}
            </span>
            <button
              aria-label="Next month"
              className="text-ink-subtle hover:text-brand rounded-md p-1"
              onClick={() => goMonth(1)}
              type="button"
            >
              <Chevron direction="right" />
            </button>
          </div>

          <div className="text-ink-subtle mt-2 grid grid-cols-7 text-center text-[10px] font-semibold tracking-wide uppercase">
            {WEEKDAYS.map((weekday) => (
              <span key={weekday}>{weekday}</span>
            ))}
          </div>

          <div className="mt-1 grid grid-cols-7 justify-items-center gap-y-1">
            {Array.from({ length: new Date(current.year, current.month, 1).getDay() }, (_, i) => (
              <span key={`blank-${i}`} />
            ))}
            {Array.from(
              { length: new Date(current.year, current.month + 1, 0).getDate() },
              (_, index) => {
                const day = index + 1
                const date = new Date(current.year, current.month, day)
                const iso = formatIso(date)
                const isSelected = selected !== null && formatIso(selected) === iso
                const isToday = formatIso(todayDate) === iso
                return (
                  <button
                    aria-current={isToday ? 'date' : undefined}
                    aria-pressed={isSelected}
                    aria-label={`${MONTHS[current.month]} ${day}, ${current.year}`}
                    className={
                      isSelected
                        ? 'bg-brand text-white hover:bg-brand-hover flex h-8 w-8 items-center justify-center rounded-full text-xs'
                        : isToday
                          ? 'text-brand ring-brand flex h-8 w-8 items-center justify-center rounded-full text-xs font-semibold ring-1 ring-inset'
                          : 'hover:bg-brand-soft text-ink flex h-8 w-8 items-center justify-center rounded-full text-xs'
                    }
                    data-date={iso}
                    key={iso}
                    onClick={() => pick(date)}
                    type="button"
                  >
                    {day}
                  </button>
                )
              },
            )}
          </div>
        </div>
      ) : null}
    </div>
  )

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (!open) return
    if (event.key === 'Escape') {
      closeCalendar(true)
      return
    }
    const target = event.target as HTMLElement
    // Typing arrows in the input moves the caret, not the calendar.
    if (target instanceof HTMLInputElement) return

    const targetIso = target.dataset?.date
    if (targetIso) {
      const delta = KEY_DELTAS[event.key]
      const base = parseIso(targetIso)
      if (delta === undefined || base === null) return
      event.preventDefault()
      const next = addDays(base, delta)
      setFocusedDate(next)
      setView({ year: next.getFullYear(), month: next.getMonth() })
      return
    }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault()
      goMonth(event.key === 'ArrowLeft' ? -1 : 1)
    }
  }
}

function Chevron({ direction }: { readonly direction: 'left' | 'right' }) {
  return (
    <svg
      aria-hidden="true"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2.5}
      viewBox="0 0 24 24"
    >
      <path d={direction === 'left' ? 'M15 18l-6-6 6-6' : 'M9 18l6-6-6-6'} />
    </svg>
  )
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

function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days)
}

function addMonths(view: { year: number; month: number }, delta: number): { year: number; month: number } {
  const next = new Date(view.year, view.month + delta, 1)
  const year = Math.min(9999, Math.max(1, next.getFullYear()))
  return { year, month: next.getMonth() }
}
