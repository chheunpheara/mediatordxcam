import { useState } from 'react'

import { useVerification } from '../../features/verification/VerificationContext'
import { FaceCapturePanel } from '../../features/face-capture/FaceCapturePanel'
import { RemoteCameraFeed } from '../../features/onboarding/RemoteCameraFeed'
import { RemoteFaceCapture } from '../../features/onboarding/RemoteFaceCapture'
import { VerificationModal } from './VerificationModal'
import { MethodPicker } from './MethodPicker'
import { runStatusSentence } from './statusDisplay'

/**
 * The six official methods, as a dropdown (§9, §10).
 *
 * Every flag comes from `VerificationMethod`, which the backend produced (§11).
 * There is no `if (method === 'verify_user_info')` anywhere in this file, and
 * adding one would defeat the point: the panel is a rendering of configuration,
 * not a second copy of it.
 *
 * All six are shown even though three cannot run yet. §9 requires the six
 * official methods to be displayed; the pending ones carry the backend's own
 * explanation instead of being hidden, so the app does not look like it supports
 * fewer than it does.
 *
 * The run and its report live in `VerificationModal`: pressing Verify opens it
 * and starts the check, and the panel keeps the method, the inputs, the
 * button, and the sentence saying why it cannot be pressed yet — all of which
 * the dialog repeats, so a method can be changed and re-run from inside the
 * report too. Once a run exists, "Open report" brings the dialog back without
 * spending another call.
 */
export function VerificationMethodPanel() {
  const {
    methods,
    selected,
    blockingReason,
    canVerify,
    verifying,
    verify,
    error,
    result,
  } = useVerification()
  const [reportOpen, setReportOpen] = useState(false)

  const chosen = methods.find((m) => m.method === selected) ?? null

  const startVerify = (): void => {
    setReportOpen(true)
    void verify()
  }

  return (
    <>
      <section aria-label="Verification method" className="card p-5">
        <h2 className="text-ink-subtle text-sm font-semibold">Verification Method</h2>
        <p className="text-ink-subtle mt-1 text-xs">
          Choose how your identity should be checked.
        </p>

        <MethodPicker className="mt-4" id="verification-method-select" />

        {/* While the dialog is open its first column carries the customer
            display instead — the same components, rendered once, so there is
            one teller screen (and one socket) rather than two. */}
        {!reportOpen && chosen?.requiresCurrentFace ? (
          <>
            <RemoteFaceCapture />
            <FaceCapturePanel />
          </>
        ) : null}

        {!reportOpen && chosen?.requiresLiveness ? <RemoteCameraFeed /> : null}

        <button
          className="btn-primary mt-4 w-full"
          disabled={!canVerify || verifying}
          onClick={startVerify}
          type="button"
        >
          {verifying ? 'Checking…' : 'Verify'}
        </button>

        {blockingReason ? (
          <p className="text-ink-subtle mt-2 text-xs leading-relaxed" role="status">
            {blockingReason}
          </p>
        ) : null}

        {error ? (
          <p
            className="border-negative bg-negative-soft text-negative mt-3 rounded-lg border px-3 py-2 text-xs"
            role="alert"
          >
            {error}
          </p>
        ) : null}

        {result ? (
          <div className="border-border bg-surface-sunken mt-4 rounded-lg border p-3">
            <p className="text-ink text-sm font-semibold">{runStatusSentence(result.status)}</p>
            <p className="text-ink-muted mt-1 text-xs">
              {result.identity.matchedCount} of {result.identity.fields.length} details matched.
            </p>
            <button
              className="btn-secondary mt-3 w-full"
              onClick={() => setReportOpen(true)}
              type="button"
            >
              Open report
            </button>
          </div>
        ) : null}
      </section>

      {reportOpen ? <VerificationModal onClose={() => setReportOpen(false)} /> : null}
    </>
  )
}
