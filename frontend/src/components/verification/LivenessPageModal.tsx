import { useEffect, useRef, useState } from 'react'

import { routes } from '../../app/routes'
import { ApiError, fetchLivenessPageSettings, saveLivenessPageSettings } from '../../lib/api'

/**
 * The "Liveness Page" dialog: the fixed customer-display URL (Screen B) and
 * whether that page is in service.
 *
 * The token never changes once minted, so the URL shown here is the permanent
 * one to paste into the second monitor's browser; the toggle decides whether
 * `WS /ws/onboarding/{session}` will accept that token as a live room. When
 * the page is disabled the teller tab falls back to minting an ad-hoc session
 * per verification, so the URL matters only while this switch is on.
 *
 * Three exits, like the post-settings dialog: Close, Escape, the backdrop.
 * Opening moves focus to Close; closing returns it to the button that opened
 * this.
 */
export function LivenessPageModal({ onClose }: { readonly onClose: () => void }) {
  const [settings, setSettings] = useState<{ enabled: boolean; sessionId: string } | null>(null)
  const [draftEnabled, setDraftEnabled] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [copied, setCopied] = useState(false)
  const closeButtonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    closeButtonRef.current?.focus()
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      opener?.focus()
    }
  }, [onClose])

  useEffect(() => {
    let cancelled = false
    fetchLivenessPageSettings()
      .then((current) => {
        if (cancelled) return
        setSettings(current)
        setDraftEnabled(current.enabled)
      })
      .catch((cause: unknown) => {
        if (cancelled) return
        setLoadError(cause instanceof ApiError ? cause.message : 'Something went wrong. Please try again.')
      })
    return () => {
      cancelled = true
    }
  }, [])

  const handleSave = async (): Promise<void> => {
    setSaving(true)
    setSaveError(null)
    try {
      const saved = await saveLivenessPageSettings(draftEnabled)
      setSettings(saved)
      onClose()
    } catch (cause: unknown) {
      setSaveError(cause instanceof ApiError ? cause.message : 'Something went wrong. Please try again.')
    } finally {
      setSaving(false)
    }
  }

  const handleCopy = async (): Promise<void> => {
    if (settings === null) return
    const url = `${window.location.origin}${routes.display}?session=${settings.sessionId}`
    try {
      await navigator.clipboard?.writeText(url)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  const displayUrl =
    settings === null ? null : `${window.location.origin}${routes.display}?session=${settings.sessionId}`

  return (
    // Backdrop: a click anywhere outside the dialog closes it.
    <div
      className="bg-ink/80 fixed inset-0 z-50 flex items-center justify-center p-4"
      onClick={onClose}
      role="presentation"
    >
      {/* Dialog: clicks inside must not fall through to the backdrop. */}
      <div
        aria-label="Liveness page"
        aria-modal="true"
        className="bg-surface text-ink w-full max-w-xl rounded-lg p-6"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold">Liveness page</h2>
            <p className="text-ink-subtle mt-1 text-xs">
              The fixed customer screen for the second monitor. Its URL stays the same; the switch
              decides whether the display is in service.
            </p>
          </div>
          <button
            className="btn-secondary shrink-0 px-3 py-1.5"
            onClick={onClose}
            ref={closeButtonRef}
            type="button"
          >
            Close
          </button>
        </div>

        {loadError ? (
          <p
            className="border-negative bg-negative-soft text-negative mt-4 rounded-lg border px-4 py-3 text-sm"
            role="alert"
          >
            {loadError}
          </p>
        ) : null}

        {displayUrl !== null ? (
          <div className="mt-5">
            <label className="text-sm font-semibold" htmlFor="liveness-page-url">
              Display URL
            </label>
            <div className="mt-2 flex items-center gap-2">
              <input
                aria-label="Display URL"
                className="border-border bg-surface-sunken text-ink w-full rounded-md border px-3 py-2 font-mono text-xs"
                id="liveness-page-url"
                readOnly
                value={displayUrl}
              />
              <button className="btn-secondary shrink-0 px-3 py-2 text-xs" onClick={() => void handleCopy()} type="button">
                {copied ? 'Copied.' : 'Copy link'}
              </button>
            </div>
            <p className="text-ink-subtle mt-2 text-xs">
              Open this URL on the customer monitor. The page connects as the customer and starts
              filming when the teller selects a liveness check.
            </p>
          </div>
        ) : null}

        <label className="border-border mt-5 flex items-center gap-3 rounded-lg border p-4">
          <input
            checked={draftEnabled}
            className="h-4 w-4"
            disabled={settings === null || saving}
            onChange={(event) => setDraftEnabled(event.target.checked)}
            type="checkbox"
          />
          <span className="text-sm font-semibold">Enable the fixed customer display</span>
        </label>

        {saveError ? (
          <p
            className="border-negative bg-negative-soft text-negative mt-4 rounded-lg border px-4 py-3 text-sm"
            role="alert"
          >
            {saveError}
          </p>
        ) : null}

        <div className="mt-6 flex justify-end gap-2">
          <button
            className="btn-primary px-4 py-2 text-sm font-medium disabled:opacity-50"
            disabled={settings === null || saving}
            onClick={() => void handleSave()}
            type="button"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}
