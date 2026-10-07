import { useEffect, useMemo, useRef, useState } from 'react'

import { routes } from '../../app/routes'
import { useAuthUser } from '../../features/auth/authContext'
import { ApiError, createLivenessLink, fetchLivenessLinks } from '../../lib/api'
import type { CreatedLivenessLink, LivenessLink } from '../../lib/api'

/**
 * The officer's liveness links: mint one for a named customer, read the URL
 * off it, and see which of their links are still usable.
 *
 * The server owns every rule — one usable link per officer (a new mint
 * supersedes the previous one), expiry checked at request time, no read-only
 * "enabled" switch any more. This dialog only collects what a mint needs (a
 * customer label and when it should stop working) and shows back what the
 * server reports, including links that are already `Expired`, so a customer
 * returning tomorrow is still findable by name.
 *
 * A link's token is a secret: it is shown only for links this officer owns,
 * which is also all the server ever sends back (`token: null` for anyone
 * else's row).
 *
 * Three exits, like the post-settings dialog: Close, Escape, the backdrop.
 * Opening moves focus to Close; closing returns it to the button that opened
 * this.
 */
export function LivenessPageModal({ onClose }: { readonly onClose: () => void }) {
  const user = useAuthUser()
  const [links, setLinks] = useState<readonly LivenessLink[] | null>(null)
  const [scope, setScope] = useState<'own' | 'all'>('own')
  const [loadError, setLoadError] = useState<string | null>(null)
  const [customer, setCustomer] = useState('')
  const [presetId, setPresetId] = useState<string>('4h')
  const [customExpiry, setCustomExpiry] = useState('')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [minted, setMinted] = useState<CreatedLivenessLink | null>(null)
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

  const loadLinks = async (activeScope: 'own' | 'all'): Promise<void> => {
    try {
      const loaded = await fetchLivenessLinks(activeScope)
      setLinks(loaded)
      setLoadError(null)
    } catch (cause: unknown) {
      setLoadError(
        cause instanceof ApiError ? cause.message : 'Something went wrong. Please try again.',
      )
    }
  }

  useEffect(() => {
    let cancelled = false
    fetchLivenessLinks(scope)
      .then((loaded) => {
        if (cancelled) return
        setLinks(loaded)
        setLoadError(null)
      })
      .catch((cause: unknown) => {
        if (cancelled) return
        setLoadError(
          cause instanceof ApiError ? cause.message : 'Something went wrong. Please try again.',
        )
      })
    return () => {
      cancelled = true
    }
  }, [scope])

  const handleCreate = async (): Promise<void> => {
    const label = customer.trim()
    if (label === '') {
      setCreateError('Enter the customer this link is for.')
      return
    }
    const isCustom = presetId === 'custom'
    const customMs = isCustom ? new Date(customExpiry).getTime() : 0
    if (isCustom && (Number.isNaN(customMs) || customMs <= Date.now())) {
      setCreateError('Choose a future expiry time.')
      return
    }
    setCreating(true)
    setCreateError(null)
    try {
      const preset = PRESETS.find((option) => option.id === presetId) ?? PRESETS[1]
      const created = await createLivenessLink(
        isCustom
          ? { customer: label, expiresAt: new Date(customExpiry).toISOString() }
          : { customer: label, durationSeconds: preset.seconds },
      )
      setMinted(created)
      setCustomer('')
      await loadLinks(scope)
    } catch (cause: unknown) {
      setCreateError(
        cause instanceof ApiError ? cause.message : 'Something went wrong. Please try again.',
      )
    } finally {
      setCreating(false)
    }
  }

  const handleCopy = async (url: string): Promise<void> => {
    try {
      await navigator.clipboard?.writeText(url)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  // The URL to hand to the second monitor: the link just minted if there is
  // one, otherwise whatever is usable right now.
  const usableToken =
    minted?.link.token ??
    links?.find((link) => link.status === 'in_use' && link.token !== null)?.token ??
    null
  const displayUrl =
    usableToken === null
      ? null
      : `${window.location.origin}${routes.display}?session=${usableToken}`

  // Grouped by customer, newest group first, exactly as the server listed
  // them — so yesterday's expired rows sit under the same name as today's.
  const groups = useMemo(() => {
    const buckets: { readonly customer: string; links: LivenessLink[] }[] = []
    for (const link of links ?? []) {
      const bucket = buckets.find((candidate) => candidate.customer === link.customer)
      if (bucket) bucket.links.push(link)
      else buckets.push({ customer: link.customer, links: [link] })
    }
    return buckets
  }, [links])

  return (
    // Backdrop: a click anywhere outside the dialog closes it.
    <div
      className="bg-ink/80 fixed inset-0 z-50 flex items-center justify-center p-4"
      onClick={onClose}
      role="presentation"
    >
      {/* Dialog: clicks inside must not fall through to the backdrop. */}
      <div
        aria-label="Liveness links"
        aria-modal="true"
        className="bg-surface text-ink w-full max-w-xl rounded-lg p-6"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold">Liveness links</h2>
            <p className="text-ink-subtle mt-1 text-xs">
              One link per customer, open for as long as you choose. Creating a new one stops the
              previous link, so only the newest URL works on the customer monitor.
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
              <button
                className="btn-secondary shrink-0 px-3 py-2 text-xs"
                onClick={() => void handleCopy(displayUrl)}
                type="button"
              >
                {copied ? 'Copied.' : 'Copy link'}
              </button>
            </div>
            <p className="text-ink-subtle mt-2 text-xs">
              Open this URL on the customer monitor. It works until this link expires or you create
              another one.
            </p>
          </div>
        ) : null}

        <div className="border-border mt-5 rounded-lg border p-4">
          <label className="text-sm font-semibold" htmlFor="liveness-customer">
            Customer
          </label>
          <input
            aria-label="Customer"
            className="border-border bg-surface-sunken text-ink mt-2 w-full rounded-md border px-3 py-2 text-sm"
            id="liveness-customer"
            onChange={(event) => setCustomer(event.target.value)}
            placeholder="Name or application number"
            value={customer}
          />

          <fieldset className="mt-4">
            <legend className="text-sm font-semibold">Link expires</legend>
            <div className="mt-2 flex flex-wrap gap-2">
              {PRESETS.map((option) => (
                <button
                  aria-pressed={presetId === option.id}
                  className="btn-secondary px-3 py-1.5 text-xs"
                  key={option.id}
                  onClick={() => setPresetId(option.id)}
                  type="button"
                >
                  {option.label}
                </button>
              ))}
            </div>
            <div className="mt-3 flex items-center gap-3">
              <label className="text-ink-subtle flex items-center gap-2 text-xs">
                <input
                  checked={presetId === 'custom'}
                  className="h-4 w-4"
                  name="liveness-expiry"
                  onChange={() => setPresetId('custom')}
                  type="radio"
                />
                Custom
              </label>
              {presetId === 'custom' ? (
                <input
                  aria-label="Expiry date and time"
                  className="border-border bg-surface-sunken text-ink rounded-md border px-3 py-1.5 text-xs"
                  onChange={(event) => setCustomExpiry(event.target.value)}
                  type="datetime-local"
                  value={customExpiry}
                />
              ) : null}
            </div>
          </fieldset>
        </div>

        {createError ? (
          <p
            className="border-negative bg-negative-soft text-negative mt-4 rounded-lg border px-4 py-3 text-sm"
            role="alert"
          >
            {createError}
          </p>
        ) : null}

        <div className="mt-6 flex justify-end gap-2">
          <button
            className="btn-primary px-4 py-2 text-sm font-medium disabled:opacity-50"
            disabled={creating || links === null}
            onClick={() => void handleCreate()}
            type="button"
          >
            {creating ? 'Creating…' : 'Create link'}
          </button>
        </div>

        <div className="border-border mt-6 border-t pt-4">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold">Your links</h3>
            {user?.isAdmin ? (
              <div className="flex gap-2" role="group" aria-label="Which links to list">
                <button
                  aria-pressed={scope === 'own'}
                  className="btn-secondary px-3 py-1.5 text-xs"
                  onClick={() => setScope('own')}
                  type="button"
                >
                  Yours
                </button>
                <button
                  aria-pressed={scope === 'all'}
                  className="btn-secondary px-3 py-1.5 text-xs"
                  onClick={() => setScope('all')}
                  type="button"
                >
                  All officers
                </button>
              </div>
            ) : null}
          </div>

          {links !== null && groups.length === 0 ? (
            <p className="text-ink-subtle mt-3 text-xs">No links yet.</p>
          ) : null}

          {groups.map((group) => (
            <section className="mt-3" key={group.customer}>
              <p className="text-ink text-xs font-semibold">{group.customer}</p>
              <ul className="mt-1 space-y-1">
                {group.links.map((link) => (
                  <li className="text-ink-subtle flex flex-wrap gap-2 text-xs" key={link.id}>
                    <span
                      className={
                        link.status === 'in_use'
                          ? 'text-positive font-medium'
                          : 'text-ink-subtle font-medium'
                      }
                    >
                      {STATUS_LABEL[link.status]}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span>
                      Expires {new Date(link.expiresAt).toLocaleString(undefined, DATE_OPTIONS)}
                    </span>
                    {scope === 'all' ? (
                      <>
                        <span aria-hidden="true">·</span>
                        <span>{link.owner.name}</span>
                      </>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          ))}

          {minted?.supersededPrevious ? (
            <p className="text-ink-subtle mt-3 text-xs">
              The previous link has been stopped — only the URL above still works.
            </p>
          ) : null}
        </div>
      </div>
    </div>
  )
}

const PRESETS = [
  { id: '1h', label: '1 hour', seconds: 3_600 },
  { id: '4h', label: '4 hours', seconds: 14_400 },
  { id: '8h', label: '8 hours', seconds: 28_800 },
  { id: '24h', label: '24 hours', seconds: 86_400 },
  { id: '7d', label: '7 days', seconds: 604_800 },
] as const

const STATUS_LABEL = {
  in_use: 'In use',
  superseded: 'Superseded',
  expired: 'Expired',
} as const

const DATE_OPTIONS = { dateStyle: 'medium', timeStyle: 'short' } as const
