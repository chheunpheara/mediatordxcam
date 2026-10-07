import { useEffect, useRef, useState } from 'react'

import { useAuthUser } from '../../features/auth/authContext'
import { useVerification } from '../../features/verification/VerificationContext'
import { ApiError, postToCore } from '../../lib/api'
import type { PostToCoreResponse } from '../../lib/api'
import { canPostToCore } from '../../lib/auth'

/**
 * "Post to Core Systems" and its outcome notice (D19).
 *
 * Sits directly under the Verification Response card: one click replays the
 * current result to every configured system. Same display gate as Post
 * Settings — the full six-permission set — because the server would refuse
 * the request anyway.
 *
 * The outcome arrives as a sweet-alert-style notice: a centred card with an
 * icon, a title, and the per-target report in safe words (§28). One per
 * outcome, dismissed by OK, Escape or the backdrop — never a toast that
 * vanishes before a partial failure can be read.
 */
export function PostToCoreAction({ className = 'btn-secondary mt-3 w-full' }: { readonly className?: string }) {
  const user = useAuthUser()
  const { result } = useVerification()
  const [posting, setPosting] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const onClose = (): void => setNotice(null)

  if (!canPostToCore(user) || result === null) return null

  const handlePost = async (): Promise<void> => {
    setPosting(true)
    try {
      const outcome = await postToCore(result)
      setNotice({ kind: outcome.failed.length === 0 ? 'success' : 'partial', outcome })
    } catch (cause: unknown) {
      setNotice({
        kind: 'error',
        message: cause instanceof ApiError ? cause.message : 'Something went wrong. Please try again.',
      })
    } finally {
      setPosting(false)
    }
  }

  return (
    <>
      <button
        className={className}
        disabled={posting}
        onClick={() => void handlePost()}
        type="button"
      >
        {posting ? 'Posting…' : 'Post to Core Systems'}
      </button>
      {notice ? <PostNotice notice={notice} onClose={onClose} /> : null}
    </>
  )
}

type Notice =
  | { readonly kind: 'success' | 'partial'; readonly outcome: PostToCoreResponse }
  | { readonly kind: 'error'; readonly message: string }

function PostNotice({ notice, onClose }: { readonly notice: Notice; readonly onClose: () => void }) {
  const okButtonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    okButtonRef.current?.focus()
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      opener?.focus()
    }
  }, [onClose])

  const content = describe(notice)

  return (
    // Backdrop: a click anywhere outside the notice dismisses it.
    <div
      className="bg-ink/80 fixed inset-0 z-50 flex items-center justify-center p-4"
      onClick={onClose}
      role="presentation"
    >
      {/* Notice: clicks inside must not fall through to the backdrop. */}
      <div
        aria-label={content.title}
        aria-modal="true"
        className="bg-surface text-ink w-full max-w-md rounded-lg p-6 text-center"
        onClick={(event) => event.stopPropagation()}
        role="alertdialog"
      >
        <span className={`mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full ${content.circle}`}>
          <svg
            aria-hidden="true"
            className="h-6 w-6"
            fill="none"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2.5}
            viewBox="0 0 24 24"
          >
            <path d={content.icon} />
          </svg>
        </span>
        <h2 className="text-lg font-semibold">{content.title}</h2>
        <p className="text-ink-muted mt-1 text-sm">{content.body}</p>
        {content.details.length > 0 ? (
          <ul className="text-ink-subtle mx-auto mt-3 max-h-40 overflow-auto space-y-1 text-left text-xs">
            {content.details.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        ) : null}
        <button className="btn-primary mt-5 px-6 py-1.5" onClick={onClose} ref={okButtonRef} type="button">
          OK
        </button>
      </div>
    </div>
  )
}

interface DescribedNotice {
  readonly title: string
  readonly body: string
  readonly details: readonly string[]
  readonly circle: string
  readonly icon: string
}

const CHECK_ICON = 'M20 6 9 17l-5-5'
const ALERT_ICON = 'M12 8v4M12 16h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z'

function describe(notice: Notice): DescribedNotice {
  if (notice.kind === 'error') {
    return {
      title: 'Could not post',
      body: notice.message,
      details: [],
      circle: 'bg-negative-soft text-negative',
      icon: ALERT_ICON,
    }
  }
  const { outcome } = notice
  const sent = `Sent to ${outcome.posted.length} core system${outcome.posted.length === 1 ? '' : 's'}.`
  const details = [
    ...outcome.posted.map((url) => `Posted: ${url}`),
    ...outcome.failed.map((failure) => `${failure.url} — ${failure.reason}`),
  ]
  if (notice.kind === 'success') {
    return {
      title: 'Posted',
      body: sent,
      details,
      circle: 'bg-positive-soft text-positive',
      icon: CHECK_ICON,
    }
  }
  return {
    title: 'Posted with problems',
    body: `${sent} ${outcome.failed.length} did not accept it.`,
    details,
    circle: 'bg-negative-soft text-negative',
    icon: ALERT_ICON,
  }
}
