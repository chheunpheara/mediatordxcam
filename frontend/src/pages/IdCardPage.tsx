import { Link } from 'react-router-dom'

import { routes } from '../app/routes'
import { useDocumentSession } from '../features/document-upload/DocumentSessionContext'

/**
 * Verification workspace — Phase 2.
 *
 * §8 specifies three columns (original document, extracted ID-card face, editable
 * identity data) plus the verification-method panel; those arrive in Phases 3–5.
 *
 * What Phase 2 does own is the handover: reaching this page with the chosen
 * document still in session. The file lives in `DocumentSessionProvider` above the
 * router precisely so it survives navigation, and the strip below is the proof —
 * if the document were scoped to the landing page this would be empty.
 */
export function IdCardPage() {
  const { document } = useDocumentSession()

  return (
    <main className="mx-auto w-full max-w-7xl p-4 sm:p-6">
      <h1 className="text-xl font-semibold">Verification workspace</h1>

      {document ? (
        <p className="text-ink-muted mt-2 text-sm">
          Selected document:{' '}
          <span className="font-semibold text-ink">{document.file.name}</span>{' '}
          <span className="text-ink-subtle">
            ({document.dimensions.width} × {document.dimensions.height} px)
          </span>
        </p>
      ) : (
        <div className="card mt-4 p-5" role="status">
          <p className="text-sm font-semibold">No document selected</p>
          <p className="text-ink-muted mt-1 text-sm">
            Choose an ID Card image to begin verification.
          </p>
          <Link className="btn-primary mt-4" to={routes.landing}>
            Go to upload
          </Link>
        </div>
      )}

      <div className="mt-6 grid gap-4 lg:grid-cols-3">
        {['Original document', 'ID card face', 'Identity information'].map((title) => (
          <section key={title} className="card p-5" aria-label={title}>
            <h2 className="text-ink-subtle text-sm font-semibold">{title}</h2>
            <p className="text-ink-subtle mt-3 text-xs">
              {document ? 'Arrives in Phase 3.' : 'Not implemented yet.'}
            </p>
          </section>
        ))}
      </div>
    </main>
  )
}