import { useCallback, useState } from 'react'

import { LivenessPageModal } from './LivenessPageModal'

/**
 * The workspace header's "Liveness Links" button and its dialog.
 *
 * Every signed-in officer mints links — the route takes no admin gate, and
 * hiding the button for anyone who could use it would only push them to the
 * URL by hand. The dialog itself reads a scope toggle for administrators,
 * so this button does not branch on the profile at all. The monitor is
 * inline SVG so the button needs no icon package.
 */
export function LivenessPageAction() {
  const [open, setOpen] = useState(false)
  const onClose = useCallback(() => setOpen(false), [])

  return (
    <>
      <button
        className="btn-secondary flex items-center gap-1.5 py-1.5"
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
          strokeWidth={2}
          viewBox="0 0 24 24"
        >
          <rect height="14" width="20" x="2" y="3" rx="2" />
          <path d="M8 21h8M12 17v4" />
        </svg>
        Liveness Links
      </button>
      {open ? <LivenessPageModal onClose={onClose} /> : null}
    </>
  )
}
