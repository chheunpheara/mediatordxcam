import { useEffect, useRef, useState } from 'react'

import { useVerification } from '../../features/verification/VerificationContext'
import { FieldCheckList } from './FieldCheckList'
import { MethodPicker } from './MethodPicker'
import { PostToCoreAction } from './PostToCoreAction'
import { sectionsOf } from './sectionRows'
import { runStatusSentence } from './statusDisplay'
import { VerificationPreview } from './VerificationPreview'

/**
 * The report dialog (§24) — opened by the panel's Verify button, and by
 * "Open report" once a run exists.
 *
 * Three things happen here that the old panel could not show:
 *
 * 1. **The run is visible.** While the request is in flight the dialog shows a
 *    sweeping progress card instead of a button that says "Checking…" and a
 *    column that looks frozen.
 * 2. **The answer arrives a row at a time.** The list appends one row per
 *    tick, so "which detail just came back" is something the eye can follow
 *    rather than a block of text that lands all at once.
 * 3. **A mismatch pulses.** Rows that did not match fade a red-soft background
 *    in and out (§32 still pairs it with the cross and the word, so the pulse
 *    is a nudge, never the only signal).
 *
 * The dialog is also where the run is *chosen*: it carries the same method
 * dropdown the panel opens with and its own Verify, both bound to the one
 * provider, so a method can be swapped and re-run without going back. The
 * columns: one by default, two once the method was given a picture or a
 * recording — those runs get the preview column first and the field list
 * beside it (§24). "Post to Core Systems" lives in the footer and is not
 * rendered until the run has answered and the list has finished appending, so
 * nothing can be posted from a report the user has not seen.
 */

/** How long between one appended row and the next: real time, still watchable. */
const REVEAL_STEP_MS = 50

export function VerificationModal({ onClose }: { readonly onClose: () => void }) {
  const {
    methods,
    selected,
    blockingReason,
    canVerify,
    verifying,
    verify,
    result,
    history,
    error,
    inputs,
  } = useVerification()
  const closeButtonRef = useRef<HTMLButtonElement>(null)

  const chosen = methods.find((method) => method.method === selected) ?? null
  const fields = result?.identity.fields ?? []
  const sections = result === null ? [] : sectionsOf(history)
  const total = fields.length + sections.length

  // One row per tick: the list fills the way an answer arrives, from the top.
  // A later run with more rows (D16's appended section) simply keeps ticking
  // from where the list already stands, so a grown list never replays itself.
  const [revealed, setRevealed] = useState(0)
  useEffect(() => {
    if (revealed >= total) return
    const timer = window.setTimeout(() => setRevealed((shown) => shown + 1), REVEAL_STEP_MS)
    return () => window.clearTimeout(timer)
  }, [revealed, total])

  useEffect(() => {
    closeButtonRef.current?.focus()
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const complete = result !== null && !verifying && revealed >= total
  const showPreview = chosen !== null && (chosen.requiresCurrentFace || chosen.requiresLiveness)

  return (
    // Backdrop: a click anywhere outside the dialog closes it.
    <div
      className="bg-ink/80 fixed inset-0 z-50 flex items-center justify-center p-4"
      onClick={onClose}
      role="presentation"
    >
      {/* Dialog: clicks inside must not fall through to the backdrop. */}
      <div
        aria-label="Verification"
        aria-modal="true"
        className="bg-surface text-ink flex max-h-[92vh] w-full max-w-6xl flex-col overflow-hidden rounded-lg"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
      >
        <header className="border-border border-b px-6 py-4">
          <h2 className="text-lg font-semibold">Verification</h2>
          <p className="text-ink-subtle mt-0.5 text-xs">
            {chosen === null ? 'Checking your identity' : `${chosen.label} · ${chosen.officialName}`}
          </p>
        </header>

        <div
          className={`grid min-h-0 flex-1 gap-6 overflow-auto px-6 py-5 ${showPreview ? 'grid-cols-1 lg:grid-cols-2' : 'grid-cols-1'}`}
        >
          {showPreview && chosen !== null ? (
            <VerificationPreview checking={verifying} inputs={inputs} method={chosen} />
          ) : null}

          <div className="min-w-0">
            {/* Choose here, not behind the dialog: one provider drives both
                copies of this control, so the panel agrees with the dialog. */}
            <div className="mb-4">
              <h3 className="text-sm font-semibold">Verification method</h3>
              <MethodPicker className="mt-2" id="verification-method-select-modal" />
              {blockingReason ? (
                <p className="text-ink-subtle mt-2 text-xs leading-relaxed" role="status">
                  {blockingReason}
                </p>
              ) : null}
            </div>

            {error ? (
              <p
                className="border-negative bg-negative-soft text-negative mb-3 rounded-lg border px-3 py-2 text-xs"
                role="alert"
              >
                {error}
              </p>
            ) : null}

            {verifying ? <VerifyProgress /> : null}

            {result ? (
              <section>
                <h3 className="text-sm font-semibold">Verification Response</h3>
                <div
                  aria-label="Verification result"
                  className="border-border bg-surface-sunken mt-2 rounded-lg border p-3"
                  role="status"
                >
                  <p className="text-ink text-sm font-semibold">{runStatusSentence(result.status)}</p>
                  <p className="text-ink-muted mt-1 text-xs">
                    {result.identity.matchedCount} of {result.identity.fields.length} details matched.
                  </p>
                  <FieldCheckList
                    fields={fields.slice(0, Math.min(revealed, fields.length))}
                    sections={sections.slice(0, Math.max(0, revealed - fields.length))}
                  />
                  <p className="text-ink-subtle mt-2 text-xs">
                    This is an in-app check against the backend sample. It does not contact CamDX yet.
                  </p>
                </div>
              </section>
            ) : null}

            {!verifying && result === null && error === null ? (
              <p className="text-ink-subtle text-xs" role="status">
                The check has not run yet.
              </p>
            ) : null}
          </div>
        </div>

        <footer className="border-border bg-surface-sunken border-t px-6 py-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-ink-subtle text-xs" role="status">
              {verifying
                ? 'Verification in progress…'
                : result === null
                  ? error === null
                    ? 'Nothing to report yet.'
                    : 'The check did not complete.'
                  : complete
                    ? 'Report ready.'
                    : 'Building the report…'}
            </p>
            <div className="flex items-center gap-2">
              <button
                className="btn-secondary px-4 py-1.5"
                onClick={onClose}
                ref={closeButtonRef}
                type="button"
              >
                Close
              </button>
              {/* The run can be started from here too: same `verify`, same
                  `canVerify`, as the panel's own button. */}
              <button
                className="btn-primary px-4 py-1.5"
                disabled={!canVerify || verifying}
                onClick={() => void verify()}
                type="button"
              >
                {verifying ? 'Checking…' : 'Verify'}
              </button>
              {complete ? <PostToCoreAction className="btn-primary px-4 py-1.5" /> : null}
            </div>
          </div>
        </footer>
      </div>
    </div>
  )
}

/**
 * The run itself, while it is running: a sweep, three lines waiting to be
 * filled, and words for a screen reader — never a silent column.
 */
function VerifyProgress() {
  return (
    <div
      aria-label="Verification in progress"
      className="border-border bg-surface-raised grid justify-items-center gap-3 rounded-lg border px-4 py-6 text-center"
      role="status"
    >
      <span aria-hidden="true" className="verify-progress__orb" />
      <p className="text-sm font-medium">Verifying your details…</p>
      <ul aria-hidden="true" className="verify-progress__skeleton">
        <li />
        <li />
        <li />
      </ul>
    </div>
  )
}
