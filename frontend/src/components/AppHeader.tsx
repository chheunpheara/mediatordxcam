import { useState } from 'react'

import { useAuthSetter, useAuthUser } from '../features/auth/authContext'
import { logout } from '../lib/api'

/**
 * The signed-in chrome (D18) — the horizontal arm of the L-shaped layout.
 *
 * It carries the account and the way out and little else: where the user can
 * *go* lives in the sidebar, so a destination never appears twice. Below `lg`
 * it also carries the button that slides the sidebar in.
 *
 * Sign-out clears the local profile even if the server call fails: the cookie
 * may already be gone (that is often *why* it failed), and a "signed out"
 * button that leaves the user on the page is worse than one that over-delivers.
 * The route guard takes them to the sign-in page either way.
 */
interface AppHeaderProps {
  /** Whether the sidebar arm is currently slid out (below `lg`). */
  readonly navOpen: boolean
  readonly onToggleNav: () => void
}

export function AppHeader({ navOpen, onToggleNav }: AppHeaderProps) {
  const user = useAuthUser()
  const setUser = useAuthSetter()
  const [signingOut, setSigningOut] = useState(false)

  const handleSignOut = async () => {
    setSigningOut(true)
    try {
      await logout()
    } catch {
      // Session already gone server-side — proceeding to clear locally anyway.
    } finally {
      setUser(null)
      setSigningOut(false)
    }
  }

  return (
    <header className="app-topbar border-border/60 sticky top-0 z-20 border-b">
      <div className="flex w-full flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-2.5 sm:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <button
            type="button"
            aria-label={navOpen ? 'Hide navigation' : 'Show navigation'}
            aria-expanded={navOpen}
            aria-controls="app-sidebar"
            className="app-topbar__menu"
            onClick={onToggleNav}
          >
            <MenuIcon />
          </button>
          <span className="text-sm font-semibold tracking-tight">
            CamDX <span className="text-ink-muted font-medium">Identity Verification</span>
          </span>
        </div>

        <div className="flex items-center gap-3 text-sm">
          <span className="flex min-w-0 items-center gap-2.5">
            <span
              aria-hidden="true"
              className="accent-gradient grid h-7 w-7 shrink-0 place-items-center rounded-full text-[0.7rem] font-bold text-white"
            >
              {(user?.email ?? '?').slice(0, 1).toUpperCase()}
            </span>
            <span className="text-ink-muted max-w-[14rem] truncate" title={user?.email}>
              {user?.email}
            </span>
          </span>
          <button
            type="button"
            className="btn-secondary py-1.5"
            disabled={signingOut}
            onClick={() => void handleSignOut()}
          >
            {signingOut ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
      </div>
    </header>
  )
}

/** Decorative: the button's accessible name says the same thing. */
function MenuIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-5 w-5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M4 7h16M4 12h16M4 17h10" />
    </svg>
  )
}
