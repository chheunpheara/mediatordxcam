import { useCallback, useState } from 'react'

import { useAuthUser } from '../../features/auth/authContext'
import { LivenessPageModal } from './LivenessPageModal'

/**
 * The workspace header's "Liveness Page" button and its dialog.
 *
 * Admin-only, matching the server rule that gates `PUT
 * /api/v1/onboarding/liveness-page` behind `require_admin`: an officer who
 * cannot save the setting only finds out after the dialog is open. The
 * monitor is inline SVG so the button needs no icon package.
 */
export function LivenessPageAction() {
  const user = useAuthUser()
  const [open, setOpen] = useState(false)
  const onClose = useCallback(() => setOpen(false), [])

  if (!user?.isAdmin) return null

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
        Liveness Page
      </button>
      {open ? <LivenessPageModal onClose={onClose} /> : null}
    </>
  )
}
