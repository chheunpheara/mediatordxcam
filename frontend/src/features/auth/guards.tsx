import type { ReactNode } from 'react'
import { Link, Navigate } from 'react-router-dom'

import { routes } from '../../app/routes'
import { useAuthUser } from './authContext'

/**
 * Route guards (D18).
 *
 * The whole application — every verification route and the administration
 * area — sits behind a sign-in; only sign-in itself, the health-checked error
 * page and the API's own public surface stay open. These guards decide what
 * the *browser* may render before a request exists; the backend independently
 * answers 401/403 for anything that does reach it. Neither side assumes the
 * other is asleep: a guard only hides controls, it never grants access.
 */

/** Signed out → the sign-in page. Signed in → the app. */
export function RequireAuth({ children }: { readonly children: ReactNode }) {
  const user = useAuthUser()
  if (!user) {
    return <Navigate to={routes.login} replace />
  }
  return children
}

/**
 * Signed in but not administrative → a stated denial, not a redirect.
 *
 * Redirecting would hide *why* the URL went nowhere. This panel says it, and
 * offers the way back — a dead end with a signpost rather than a blank.
 */
export function RequireAdmin({ children }: { readonly children: ReactNode }) {
  const user = useAuthUser()
  if (!user) {
    return <Navigate to={routes.login} replace />
  }
  if (!user.isAdmin) {
    return (
      <main className="mx-auto flex min-h-[calc(100vh-3.5rem)] w-full max-w-xl flex-col justify-center p-4 sm:p-6">
        <div className="card p-6 sm:p-8" role="alert">
          <h1 className="text-xl font-semibold">Administration is restricted</h1>
          <p className="text-ink-muted mt-2 text-sm">
            Your account does not include administrator access, so this area stays closed. Ask an
            administrator to change your roles if you need it.
          </p>
          <Link className="btn-secondary mt-6 inline-flex" to={routes.landing}>
            Back to verification
          </Link>
        </div>
      </main>
    )
  }
  return children
}
