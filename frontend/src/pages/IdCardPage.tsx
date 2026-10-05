import { useEffect } from 'react'
import { Link } from 'react-router-dom'

import { routes } from '../app/routes'
import { DocumentColumn } from '../components/verification/DocumentColumn'
import { FaceColumn } from '../components/verification/FaceColumn'
import { IdentityForm } from '../components/verification/IdentityForm'
import { VerificationMethodPanel } from '../components/verification/VerificationMethodPanel'
import { VerificationProvider } from '../features/verification/VerificationProvider'
import { useDocumentSession } from '../features/document-upload/DocumentSessionContext'
import { resolveIdentity } from '../features/id-card-processing/IdentityDraftContext'
import { useIdCardProcessing } from '../features/id-card-processing/ProcessingContext'
import { useFaceCapture } from '../features/face-capture/FaceCaptureContext'
import { clearSession } from '../lib/session'

/**
 * Verification workspace (§8) — three columns (order per D14).
 *
 * 1. the original document exactly as uploaded, with zoom (§9), and beneath it
 *    the face OpenCV cut off that card (§12)
 * 2. the nine editable identity fields (§14)
 * 3. the verification-method panel, driven by the backend's requirement
 *    configuration: the six methods and every disabled state are read from
 *    `GET /api/v1/kyc/verification-methods` rather than written down in React
 *    (§11)
 *
 * Processing normally happened on the landing page, before navigation (§6). A
 * direct visit to `/id-card` — a refresh, a bookmark — has a document in session
 * but no result, so the call is made here too instead of showing an empty
 * workspace.
 *
 * Verification can only start once the chosen method's own inputs are present.
 * Today that means API 1: current-face capture is Phase 6 and liveness is Phase 7,
 * so methods 2 to 4 are listed with the backend's explanation and stay disabled
 * (§9 requires all six to be visible).
 */
export function IdCardPage() {
  const { document, clear: clearDocument } = useDocumentSession()
  const { state, result, error, process, draft, reset } = useIdCardProcessing()
  const faceCapture = useFaceCapture()

  const handleBackToUpload = () => {
    clearSession()
    clearDocument()
    reset()
    faceCapture.reset()
  }

  const needsProcessing = state === 'idle' && document !== null

  useEffect(() => {
    if (needsProcessing && document) {
      void process(document.file)
    }
  }, [needsProcessing, document, process])

  if (!document) {
    return (
      <main className="mx-auto w-full max-w-7xl p-4 sm:p-6">
        <h1 className="text-xl font-semibold">Verification workspace</h1>
        <div className="card mt-4 p-5" role="status">
          <p className="text-sm font-semibold">No document selected</p>
          <p className="text-ink-muted mt-1 text-sm">
            Choose an ID Card image to begin verification.
          </p>
          <Link className="btn-primary mt-4" to={routes.landing}>
            Go to upload
          </Link>
        </div>
      </main>
    )
  }

  return (
    <main className="mx-auto w-full max-w-7xl p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Verification workspace</h1>
        <Link className="btn-secondary py-1.5" onClick={handleBackToUpload} to={routes.landing}>
          ← Back to upload
        </Link>
      </div>

      <div className="mt-4 grid items-start gap-4 lg:grid-cols-3">
        {/* Column 1 (D14): the card, and the face cut from it beneath. */}
        <div className="flex flex-col gap-4">
          <DocumentColumn
            documentRef={result?.documentRef ?? null}
            fileName={document.file.name}
            height={document.dimensions.height}
            state={state}
            width={document.dimensions.width}
          />
          <FaceColumn face={result?.face ?? null} />
        </div>

        {/* Column 2 (D14): the nine editable identity fields. */}
        {result ? (
          <IdentityForm hasDraft={Object.keys(draft).length > 0} ocr={result.ocr} />
        ) : (
          <section className="card p-5" aria-label="Identity information">
            <h2 className="text-ink-subtle text-sm font-semibold">Identity Information</h2>
            <p className="text-ink-subtle mt-3 text-xs" role="status">
              {state === 'processing' ? 'Reading your document…' : 'Not available yet.'}
            </p>
          </section>
        )}

        {/* Column 3 (D14): method picker and Verify. */}
        <VerificationProvider
          inputs={{
            identity: result === null ? null : resolveIdentity(result.ocr.fields, draft),
            documentRef: result?.documentRef ?? null,
            currentFaceRef: faceCapture.faceRef,
            livenessRef: null,
            idCardFaceRef: result?.face?.faceRef ?? null,
          }}
        >
          <VerificationMethodPanel />
        </VerificationProvider>
      </div>

      {error ? (
        <div className="card mt-4 p-5" role="alert">
          <p className="border-negative bg-negative-soft text-negative rounded-lg border px-4 py-3 text-sm font-medium">
            {error}
          </p>
          <Link className="btn-secondary mt-4" to={routes.landing}>
            Choose another document
          </Link>
        </div>
      ) : null}
    </main>
  )
}
