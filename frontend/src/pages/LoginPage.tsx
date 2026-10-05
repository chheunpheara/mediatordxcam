import { useState } from 'react'
import type { FormEvent } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'

import { routes } from '../app/routes'
import { useAuthSetter, useAuthUser } from '../features/auth/authContext'
import { ApiError, login } from '../lib/api'

/**
 * Sign-in (D18).
 *
 * The only application route that exists before authentication. On success the
 * account profile is stored and the visitor lands where they were headed — the
 * root, since guards redirect *here* and a redirect back must not ping-pong.
 *
 * Failure shows the server's own sentence and nothing else: the backend answers
 * every bad credential with one identical 401 (so the form cannot be used to
 * enumerate accounts) and a distinct 403 for a disabled account, and both are
 * safe to display. Field-level policy errors have no home here — a sign-in form
 * never sets a password — so `fieldErrors` is ignored on purpose.
 */
export function LoginPage() {
  const user = useAuthUser()
  const setUser = useAuthSetter()
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  if (user) {
    // Already signed in: the sign-in page would be a dead end.
    return <Navigate to={routes.landing} replace />
  }

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      const session = await login(email, password)
      setUser(session.user)
      await navigate(routes.landing, { replace: true })
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.message
          : 'Something went wrong. Please try again.',
      )
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-sm flex-col justify-center p-4 sm:p-6">
      <form className="card p-6 sm:p-8" onSubmit={(event) => void handleSubmit(event)}>
        <h1 className="text-2xl font-semibold">Sign in</h1>
        <p className="text-ink-muted mt-2 text-sm">
          CamDX Identity Verification — sign in with the account an administrator gave you.
        </p>

        <div className="mt-6 space-y-4">
          <div>
            <label className="text-ink block text-sm font-medium" htmlFor="login-email">
              Email
            </label>
            <input
              className="input mt-1"
              id="login-email"
              type="email"
              name="email"
              autoComplete="username"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>
          <div>
            <label className="text-ink block text-sm font-medium" htmlFor="login-password">
              Password
            </label>
            <input
              className="input mt-1"
              id="login-password"
              type="password"
              name="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </div>
        </div>

        {error ? (
          <p role="alert" className="border-negative bg-negative-soft text-negative mt-4 rounded-lg border px-4 py-3 text-sm font-medium">
            {error}
          </p>
        ) : null}

        <button className="btn-primary mt-6 w-full" type="submit" disabled={submitting}>
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </main>
  )
}
