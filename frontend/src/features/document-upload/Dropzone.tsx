import { useId, useRef, useState } from 'react'

import { ACCEPTED_FILE_EXTENSIONS } from './validation'

/**
 * Drag-and-drop / click-to-browse upload target (§36 Phase 2).
 *
 * Keyboard and pointer share one control rather than being two affordances: the
 * real `<input type="file">` carries the accessible name and sits in the tab
 * order, and the visible panel is its `<label>`. A `<div>` with a click handler
 * would be unreachable by keyboard and announced as a bare group.
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
      className={`border-2 border-dashed rounded-xl transition-colors ${
        isDragging ? 'border-brand bg-brand-soft' : 'border-border-strong bg-surface-sunken'
      }`}
      onDragEnter={(event) => {
        event.preventDefault()
        if (!disabled) setIsDragging(true)
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => {
        event.preventDefault()
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
        className="focus-visible:outline-brand focus-visible:outline-2 focus-visible:outline-offset-2 peer-focus-visible:outline-brand peer-focus-visible:outline-2 flex cursor-pointer flex-col items-center gap-3 rounded-xl p-8 text-center hover:bg-brand-soft/40 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60"
      >
        <UploadIcon />
        <span className="text-base font-semibold">
          {disabled ? 'Checking image…' : 'Drop your ID Card here'}
        </span>
        <span className="text-ink-muted text-sm">
          or <span className="text-brand font-semibold underline">browse your files</span>
        </span>
        <span className="text-ink-subtle text-xs">
          JPEG or PNG · up to 10 MB · at least 640 × 480 pixels
        </span>
      </label>

      {error ? (
        <p
          id={`${inputId}-error`}
          role="alert"
          className="border-negative bg-negative-soft text-negative rounded-b-xl border-t-2 border-t-transparent px-4 py-3 text-sm font-medium"
        >
          <span aria-hidden="true">✗ </span>
          {error}
        </p>
      ) : null}
    </div>
  )
}

/** Decorative: the adjacent text carries the meaning (§32 colour/role rules). */
function UploadIcon() {
  return (
    <svg
      className="text-brand h-9 w-9"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 16V4m0 0L8 8m4-4 4 4" />
      <path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
    </svg>
  )
}