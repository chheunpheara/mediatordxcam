import { Link } from 'react-router-dom'

import { routes } from '../app/routes'

/** Shown for any unmatched path. Offers a way back instead of a dead end. */
export function NotFoundPage() {
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="card w-full max-w-md p-8 text-center" role="alert">
        <h1 className="text-lg font-semibold">That page could not be found.</h1>
        <p className="text-ink-muted mt-2 text-sm">
          The link may be out of date. Start again from the beginning.
        </p>
        <Link className="btn-primary mt-6 w-full" to={routes.landing}>
          Back to start
        </Link>
      </div>
    </main>
  )
}