import { useCallback, useState } from 'react'

import { useVerification } from '../../features/verification/VerificationContext'
import { ExportModal } from './ExportModal'

/**
 * The workspace header's Export button and its dialog (D17).
 *
 * Disabled until a verification has produced a result — there is nothing to
 * export before the first run, so the empty-state question never arises. The
 * close callback is stable so the modal's focus effect does not re-run every
 * time this component re-renders.
 */
export function ExportAction() {
  const { history, result } = useVerification()
  const [open, setOpen] = useState(false)
  const onClose = useCallback(() => setOpen(false), [])

  return (
    <>
      <button
        className="btn-secondary py-1.5"
        disabled={result === null}
        onClick={() => setOpen(true)}
        type="button"
      >
        Export
      </button>
      {open ? <ExportModal history={history} onClose={onClose} /> : null}
    </>
  )
}
