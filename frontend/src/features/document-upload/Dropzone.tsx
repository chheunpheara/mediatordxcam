import { useId, useRef, useState } from 'react'

import { ACCEPTED_FILE_EXTENSIONS } from './validation'

/**
 * Drag-and-drop / click-to-browse upload target (§36 Phase 2) — the hero of
 * the upload screen.
 *
 * Keyboard and pointer share one control rather than being two affordances: the
 * real `<input type="file">` carries the accessible name and sits in the tab
 * order, and the visible panel is its `<label>`. A `<div>` with a click handler
 * would be unreachable by keyboard and announced as a bare group.
 *
 * The theatre — dashed border that blooms indigo on hover or drag, a pulsing
 * gradient orb at the centre, shimmer instead of a spinner while a file is
 * checked — is all decoration around that one control: every word it shows and
 * every state it takes is unchanged.
 */

interface DropzoneProps {
  /** Receives the chosen file. Validation is the caller's business. */
  readonly onSelect: (file: File) => void
  readonly error?: string | null
  readonly disabled?: boolean
}

export function Dropzone({ onSelect, error = null, disabled = false }: DropzoneProps) {
  const inputId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const [isDragging, setIsDragging] = useState(false)

  const handleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (file) onSelect(file)
    // Reset so re-picking the same file still fires `change`.
    event.target.value = ''
  }

  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setIsDragging(false)
    if (disabled) return

    const file = event.dataTransfer.files?.[0]
    if (file) onSelect(file)
  }

  const describedBy = error ? `${inputId}-error` : undefined

  return (
    <div
      className={`dropzone border-2 border-dashed bg-white/40 backdrop-blur-md ${
        isDragging ? 'dropzone--active' : ''
      } ${disabled ? 'dropzone--busy' : ''}`}
      onDragEnter={(event) => {
        event.preventDefault()
        if (!disabled) setIsDragging(true)
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => {
        event.preventDefault()
        // Drag events fire for every child the pointer crosses: only a real
        // exit (or a drop) takes the glow away.
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
        setIsDragging(false)
      }}
      onDrop={handleDrop}
    >
      <input
        ref={inputRef}
        id={inputId}
        type="file"
        accept={ACCEPTED_FILE_EXTENSIONS}
        className="peer sr-only"
        disabled={disabled}
        onChange={handleChange}
        aria-label="Choose an ID Card image"
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
      />

      <label
        htmlFor={inputId}
        className="focus-visible:outline-accent-from focus-visible:outline-2 focus-visible:outline-offset-4 peer-focus-visible:outline-accent-from peer-focus-visible:outline-2 flex cursor-pointer flex-col items-center gap-3 rounded-[1.1rem] px-6 py-12 text-center has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-70 sm:py-14"
      >
        {disabled ? <BusyState /> : <IdleState />}
      </label>

      {error ? (
        <p
          id={`${inputId}-error`}
          role="alert"
          className="border-negative bg-negative-soft text-negative rounded-b-[1.1rem] border-t-2 border-t-transparent px-4 py-3 text-sm font-medium"
        >
          <span aria-hidden="true">✗ </span>
          {error}
        </p>
      ) : null}
    </div>
  )
}

/** At rest: the orb, the invitation, and the rules in one line. */
function IdleState() {
  return (
    <>
      <PulsingOrb />
      <span className="text-ink text-lg font-semibold">Drop your ID Card here</span>
      <span className="text-ink-muted text-sm">
        or <span className="accent-text font-semibold">browse your files</span>
      </span>
      <span className="text-ink-subtle text-xs">
        JPEG, PNG or WebP · up to 10 MB · at least 640 × 480 pixels
      </span>
    </>
  )
}

/**
 * While a file is checked: the same panel, now shimmering.
 *
 * The bars stand in for the work (type, size, decode) rather than spinning a
 * wheel at the user, and the sentence stays as the announcement for anyone not
 * looking at the screen.
 */
function BusyState() {
  return (
    <>
      <span className="skeleton h-14 w-14 rounded-full" aria-hidden="true" />
      <span className="text-ink text-lg font-semibold">Checking image…</span>
      <span className="text-ink-muted text-sm">Reading its type, size and resolution.</span>
      <span className="mt-1 grid w-full max-w-xs gap-2" aria-hidden="true">
        <span className="skeleton h-2.5 w-3/4 justify-self-center" />
        <span className="skeleton h-2.5 w-1/2 justify-self-center" />
      </span>
    </>
  )
}

/** A gradient core with two rings breathing out of it. Decorative throughout. */
function PulsingOrb() {
  return (
    <span className="dropzone-orb" aria-hidden="true">
      <span className="dropzone-orb__halo" />
      <span className="dropzone-orb__ring" />
      <span className="dropzone-orb__ring dropzone-orb__ring--late" />
      <span className="dropzone-orb__core">
        <svg
          viewBox="0 0 24 24"
          className="h-7 w-7 text-white"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M12 16.5V4.5m0 0L7.5 9M12 4.5 16.5 9" />
          <path d="M4.5 14.5v3A2.5 2.5 0 0 0 7 20h10a2.5 2.5 0 0 0 2.5-2.5v-3" />
        </svg>
      </span>
    </span>
  )
}
