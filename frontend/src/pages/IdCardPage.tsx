import { useEffect } from 'react'
import { Link } from 'react-router-dom'

import { routes } from '../app/routes'
import { DocumentColumn } from '../components/verification/DocumentColumn'
import { ExportAction } from '../components/verification/ExportAction'
import { PostSettingsAction } from '../components/verification/PostSettingsAction'
import { FaceColumn } from '../components/verification/FaceColumn'
import { IdentityForm } from '../components/verification/IdentityForm'
import { UploadedRecordsList } from '../components/verification/UploadedRecordsList'
import { VerificationMethodPanel } from '../components/verification/VerificationMethodPanel'
import { recordName, useRecords } from '../features/records/RecordsContext'
import { RecordsProvider } from '../features/records/RecordsProvider'
import { VerificationProvider } from '../features/verification/VerificationProvider'
import { useDocumentSession } from '../features/document-upload/DocumentSessionContext'
import { resolveIdentity } from '../features/id-card-processing/IdentityDraftContext'
import { useIdCardProcessing } from '../features/id-card-processing/ProcessingContext'
import { useFaceCapture } from '../features/face-capture/FaceCaptureContext'
import { clearSession } from '../lib/session'
import { IDENTITY_FIELDS } from '../lib/api'
import type { IdentityResponse, UploadedRecord, VerifyResponse } from '../lib/api'

/**
 * Verification workspace (§8) — three columns (order per D14).
 *
 * 1. the original document exactly as uploaded, with zoom (§9), and beneath it
 *    the face OpenCV cut off that card (§12) — or, for a record started from
 *    the list, a note that no document is attached (D23)
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
 * The header pairs "Back to upload" with Export (D17): verified data goes out
 * as a file, while bulk rows come in through Upload on the landing page (D23)
 * and are listed below the workspace, each one startable into this form
 * regardless of any document. The provider wraps the whole page so the method
 * panel, the header's actions and the records list all read the same session
 * state.
 *
 * Verification can only start once the chosen method's own inputs are present.
 * Today that means API 1: current-face capture is Phase 6 and liveness is Phase 7,
 * so methods 2 to 4 are listed with the backend's explanation and stay disabled
 * (§9 requires all six to be visible).
 */
export function IdCardPage() {
  return (
    <RecordsProvider>
      <Workspace />
    </RecordsProvider>
  )
}

function Workspace() {
  const { document, restoring, clear: clearDocument } = useDocumentSession()
  const { state, result, error, process, draft, reset } = useIdCardProcessing()
  const faceCapture = useFaceCapture()
  const { activeRecord, markVerified, stop } = useRecords()

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

  // The nine §14 fields the session verifies: an active uploaded record wins
  // over the OCR read — its values are what the user chose to verify, with any
  // edits layered on top exactly like document corrections (D23).
  const identity = activeRecord
    ? resolveIdentity(activeRecord.values, draft)
    : result === null
      ? null
      : resolveIdentity(result.ocr.fields, draft)

  // A finished run is stored against the record it verified (D23). Without an
  // active record this is a no-op and the session behaves as before.
  const handleResult = (outcome: VerifyResponse): void => {
    if (activeRecord !== null) void markVerified(activeRecord.id, outcome)
  }

  const showWorkspace = document !== null || activeRecord !== null

  return (
    <main className="mx-auto w-full max-w-7xl p-4 sm:p-6">
      <VerificationProvider
        inputs={{
          identity,
          documentRef: result?.documentRef ?? null,
          currentFaceRef: faceCapture.faceRef,
          livenessRef: null,
          idCardFaceRef: result?.face?.faceRef ?? null,
        }}
        onResult={handleResult}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-xl font-semibold">Verification workspace</h1>
          <div className="flex items-center gap-2">
            <Link className="btn-secondary py-1.5" onClick={handleBackToUpload} to={routes.landing}>
              ← Back to upload
            </Link>
            <PostSettingsAction />
            <ExportAction />
          </div>
        </div>

        {activeRecord !== null ? (
          <div
            className="border-border bg-surface-sunken mt-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border px-4 py-3"
            role="status"
          >
            <p className="text-sm">
              <span className="font-semibold">Verifying an uploaded record:</span>{' '}
              {recordName(activeRecord)} ({activeRecord.values.nationalId ?? activeRecord.id})
            </p>
            <button className="btn-secondary px-3 py-1.5 text-xs" onClick={stop} type="button">
              Stop
            </button>
          </div>
        ) : null}

        {showWorkspace ? (
          <div className="mt-4 grid items-start gap-4 lg:grid-cols-3">
            {/* Column 1 (D14): the card, and the face cut from it beneath. */}
            <div className="flex flex-col gap-4">
              {document ? (
                <>
                  <DocumentColumn
                    documentRef={result?.documentRef ?? null}
                    fileName={document.file.name}
                    height={document.dimensions.height}
                    state={state}
                    width={document.dimensions.width}
                  />
                  <FaceColumn face={result?.face ?? null} />
                </>
              ) : (
                <section className="card p-5" aria-label="Document">
                  <h2 className="text-ink-subtle text-sm font-semibold">Document</h2>
                  <p className="text-ink-subtle mt-3 text-xs" role="status">
                    No document uploaded. Methods that need the ID card stay unavailable.
                  </p>
                </section>
              )}
            </div>

            {/* Column 2 (D14): the nine editable identity fields. */}
            {activeRecord ? (
              <IdentityForm
                hasDraft={Object.keys(draft).length > 0}
                ocr={recordOcr(activeRecord)}
                source="upload"
              />
            ) : result ? (
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
            <VerificationMethodPanel />
          </div>
        ) : (
          <div className="card mt-4 p-5" role="status">
            {restoring ? (
              <>
                <p className="text-sm font-semibold">Restoring your session…</p>
                <p className="text-ink-muted mt-1 text-sm">
                  Bringing back your uploaded document.
                </p>
              </>
            ) : (
              <>
                <p className="text-sm font-semibold">No document selected</p>
                <p className="text-ink-muted mt-1 text-sm">
                  Choose an ID Card image to begin verification.
                </p>
                <Link className="btn-primary mt-4" to={routes.landing}>
                  Go to upload
                </Link>
              </>
            )}
          </div>
        )}

        <UploadedRecordsList />
      </VerificationProvider>

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

/**
 * A record shaped like the OCR response the identity form already consumes
 * (D23).
 *
 * `status` is `partial` only to satisfy the shape — the form renders the
 * upload's own sentence from `source`, never an OCR claim about a spreadsheet
 * row (§13). Fields the mapping left empty arrive as `missingFields`, which
 * keeps §16's "Please enter this information." prompt working unchanged.
 */
function recordOcr(record: UploadedRecord): IdentityResponse {
  return {
    status: 'partial',
    documentType: null,
    fields: record.values,
    missingFields: IDENTITY_FIELDS.filter((name) => (record.values[name] ?? '').trim() === ''),
  }
}
