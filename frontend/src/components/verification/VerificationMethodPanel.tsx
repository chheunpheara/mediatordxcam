import { useState } from 'react'

import { useVerification } from '../../features/verification/VerificationContext'
import { FaceCapturePanel } from '../../features/face-capture/FaceCapturePanel'
import { RemoteCameraFeed } from '../../features/onboarding/RemoteCameraFeed'
import { RemoteFaceCapture } from '../../features/onboarding/RemoteFaceCapture'
import { VerificationModal } from './VerificationModal'
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
 * and starts the check, and the panel keeps only what has to be chosen or
 * supplied before that — method, inputs, the button, and the sentence saying
 * why it cannot be pressed yet. Once a run exists, "Open report" brings the
 * dialog back without spending another call.
 */
export function VerificationMethodPanel() {
  const {
    methods,
    selected,
    select,
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

        {methods.length === 0 ? (
          <p className="text-ink-subtle mt-4 text-xs" role="status">
            Loading the verification methods…
          </p>
        ) : (
          <div className="mt-4">
            <label className="block" htmlFor="verification-method-select">
              <span className="text-ink-muted block text-xs font-medium">Method</span>
              <select
                aria-label="Verification method"
                className="border-border bg-surface text-ink focus:border-brand mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:outline-none"
                id="verification-method-select"
                name="verification-method"
                onChange={(event) =>
                  select(event.target.value as (typeof methods)[number]['method'])
                }
                value={selected ?? ''}
              >
                {methods.map((method) => (
                  <option key={method.method} value={method.method}>
                    {method.label} — {method.officialName}
                  </option>
                ))}
              </select>
            </label>

            {selected ? (
              <div className="border-border bg-surface-sunken mt-3 rounded-lg border p-3">
                {(() => {
                  const method = methods.find((m) => m.method === selected)
                  if (!method) return null
                  const runnable = method.available && !method.isOcr
                  return (
                    <>
                      <p className="text-sm font-semibold">{method.label}</p>
                      <p className="text-ink-subtle block text-xs">{method.officialName}</p>
                      <RequiresList method={method} />
                      {!runnable && method.unavailableReason ? (
                        <span className="text-ink-subtle mt-1 block text-xs leading-relaxed">
                          {method.unavailableReason}
                        </span>
                      ) : null}
                    </>
                  )
                })()}
              </div>
            ) : null}
          </div>
        )}

        {chosen?.requiresCurrentFace ? (
          <>
            <RemoteFaceCapture />
            <FaceCapturePanel />
          </>
        ) : null}

        {chosen?.requiresLiveness ? <RemoteCameraFeed /> : null}

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

/** What this method asks for, in the user's words (§10). */
function RequiresList({
  method,
}: {
  method: {
    requiresUserInfo: boolean
    requiresCurrentFace: boolean
    requiresIdCard: boolean
    requiresLiveness: boolean
    requiresPassport: boolean
  }
}) {
  const needs = [
    method.requiresUserInfo && 'identity information',
    method.requiresCurrentFace && 'your current face',
    method.requiresIdCard && 'your ID card',
    method.requiresLiveness && 'liveness',
    method.requiresPassport && 'your passport',
  ].filter(Boolean) as string[]

  return (
    <span className="text-ink-subtle mt-1 block text-xs">
      {needs.length > 0 ? `Needs: ${needs.join(', ')}.` : 'Needs nothing else.'}
    </span>
  )
}
