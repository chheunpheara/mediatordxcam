import { useCallback, useState } from 'react'

import { UploadDataModal } from './UploadDataModal'

/**
 * The workspace header's Upload button and its dialog (D23).
 *
 * Beside Export, its mirror: Export takes the session's verified data out as a
 * file, Upload brings a file's data in to be verified. The icon is inline SVG
 * so the button needs no icon package (same rule as the gear in Post
 * Settings), and the adjacent text carries the meaning (§32).
 *
 * `onUploaded` is how the caller below learns a submission landed — the
 * records list refetches so the new rows are visible without a refresh.
 */
export function UploadDataAction({
  onUploaded,
}: {
  readonly onUploaded?: (count: number) => void
}) {
  const [open, setOpen] = useState(false)
  const onClose = useCallback(() => setOpen(false), [])
  const handleUploaded = useCallback(
    (count: number) => onUploaded?.(count),
    [onUploaded],
  )

  return (
    <>
      <button
        className="btn-secondary inline-flex items-center gap-1.5 py-1.5"
        onClick={() => setOpen(true)}
        type="button"
      >
        <svg
          aria-hidden="true"
          className="h-4 w-4"
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.75"
          viewBox="0 0 24 24"
        >
          <path d="M12 16V4m0 0L8 8m4-4 4 4" />
          <path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
        </svg>
        Upload
      </button>
      {open ? <UploadDataModal onClose={onClose} onUploaded={handleUploaded} /> : null}
    </>
  )
}
