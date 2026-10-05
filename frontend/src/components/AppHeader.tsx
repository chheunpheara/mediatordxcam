import { useState } from 'react'
import { Link } from 'react-router-dom'

import { routes } from '../app/routes'
import { useAuthSetter, useAuthUser } from '../features/auth/authContext'
import { logout } from '../lib/api'

/**
 * The signed-in chrome (D18): who you are, where administration lives, and
 * the way out. Rendered once by `AuthenticatedLayout`, so every guarded page
 * carries it without repeating it.
 *
 * Sign-out clears the local profile even if the server call fails: the cookie
 * may already be gone (that is often *why* it failed), and a "signed out"
 * button that leaves the user on the page is worse than one that over-delivers.
 * The route guard takes them to the sign-in page either way.
 */
export function AppHeader() {
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
    <header className="border-border bg-surface-raised sticky top-0 z-10 border-b">
      <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-2.5">
        <span className="text-sm font-semibold">CamDX Identity Verification</span>
        <div className="flex items-center gap-4 text-sm">
          <span className="text-ink-muted max-w-[14rem] truncate" title={user?.email}>
            {user?.email}
          </span>
          {user?.isAdmin ? (
            <Link className="text-brand font-semibold hover:underline" to={routes.admin}>
              Administration
            </Link>
          ) : null}
          <button
            type="button"
            className="btn-secondary"
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
