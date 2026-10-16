import { useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { routes } from '../app/routes'
import { UploadDataAction } from '../components/verification/UploadDataAction'
import { useDocumentSession } from '../features/document-upload/DocumentSessionContext'
import { Dropzone } from '../features/document-upload/Dropzone'
import { ImagePreview } from '../features/document-upload/ImagePreview'
import { validateDocumentImage } from '../features/document-upload/validation'
import { useFaceCapture } from '../features/face-capture/FaceCaptureContext'
import { useIdCardProcessing } from '../features/id-card-processing/ProcessingContext'

/**
 * Landing page (§6): upload → validate → preview → process → navigate.
 *
 * The document is validated in the browser first so a bad file costs no round
 * trip (§7), then previewed as a deliberate checkpoint. Only when the user
 * continues is anything transmitted: `POST /api/v1/kyc/id-card/process` runs here,
 * before the navigation, exactly as the §6 flow orders it.
 *
 * Visually this page is the product's handshake: one glass card, one hero
 * dropzone, and nothing else competing for the first glance. Every waiting
 * state — restoring, checking, reading the card — is a shimmer in the shape of
 * the content to come rather than a spinner (see `index.css`).
 *
 * The result is held above the router (see `App`), so the workspace on `/id-card`
 * renders what this page produced. A failed processing request keeps the user
 * here with the server's own message and their file still selected, so retrying
 * does not mean re-uploading.
 */
export function LandingPage() {
  const navigate = useNavigate()
  const { document, restoring, accept, clear } = useDocumentSession()
  const { state, error: processingError, process, reset } = useIdCardProcessing()
  const faceCapture = useFaceCapture()
  const [validationError, setValidationError] = useState<string | null>(null)
  const [isValidating, setIsValidating] = useState(false)

  const isProcessing = state === 'processing'

  const handleSelect = async (file: File) => {
    setValidationError(null)
    // A new selection invalidates any previous result.
    reset()
    setIsValidating(true)
    try {
      const result = await validateDocumentImage(file)
      if (!result.ok) {
        setValidationError(result.message)
        return
      }
      accept(result.file, result.dimensions)
    } finally {
      setIsValidating(false)
    }
  }

  const handleContinue = async () => {
    if (!document) return
    // Navigation happens only on success, so a rejected upload keeps the user here
    // with their file still selected and the server's own sentence to act on.
    const processed = await process(document.file)
    if (processed) {
      await navigate(routes.idCard)
    }
  }

  const handleClear = () => {
    clear()
    reset()
    faceCapture.reset()
    setValidationError(null)
  }

  // One banner: a client-side validation failure takes precedence over a stale
  // processing failure, because it is the earlier and more actionable problem.
  const error = validationError ?? processingError

  return (
    <main className="mx-auto flex min-h-[calc(100vh-3.5rem)] w-full max-w-2xl flex-col justify-center px-4 py-8 sm:px-6 sm:py-12">
      <div className="card p-6 sm:p-10">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-accent-from text-xs font-semibold tracking-[0.16em] uppercase">
              Step 1 of 2 · Document
            </p>
            <h1 className="mt-1.5 text-2xl font-semibold tracking-tight sm:text-3xl">
              <span className="accent-text">Identity Verification</span>
            </h1>
            <p className="text-ink-muted mt-2 max-w-sm text-sm leading-relaxed">
              Verify your identity securely using your Cambodian National ID Card.
            </p>
          </div>
          <UploadDataAction />
        </div>

        <div className="mt-8">
          {document ? (
            <ImagePreview document={document} onClear={handleClear} />
          ) : restoring ? (
            // A stored copy is on its way back (D21); hold the dropzone until it
            // lands, so a second pick cannot race the restore.
            <div
              className="border-white/60 bg-white/50 rounded-xl border-2 border-dashed p-8 text-center backdrop-blur-md"
              role="status"
            >
              <p className="text-sm font-semibold">Restoring your selection…</p>
              <p className="text-ink-muted mt-1 text-sm">
                Bringing back your uploaded document.
              </p>
              <span
                className="skeleton mx-auto mt-4 block h-2.5 w-40"
                aria-hidden="true"
              />
            </div>
          ) : (
            <Dropzone
              onSelect={(file) => void handleSelect(file)}
              error={validationError}
              disabled={isValidating}
            />
          )}
        </div>

        {document ? (
          <>
            {isProcessing ? (
              /* Reading the card is a few seconds of local work: shimmer in the
                 shape of the fields it is finding, not a spinner. */
              <div className="border-white/60 bg-white/55 mt-6 rounded-xl border p-4 backdrop-blur-md" role="status">
                <p className="text-sm font-semibold">Reading your document…</p>
                <p className="text-ink-muted mt-0.5 text-sm">
                  OCR and face detection run on this machine.
                </p>
                <span className="mt-3 grid gap-2" aria-hidden="true">
                  <span className="skeleton h-2.5 w-2/3" />
                  <span className="skeleton h-2.5 w-1/2" />
                  <span className="skeleton h-2.5 w-3/5" />
                </span>
              </div>
            ) : null}

            {error ? (
              <p
                role="alert"
                className="border-negative bg-negative-soft text-negative mt-6 rounded-lg border px-4 py-3 text-sm font-medium"
              >
                {error}
              </p>
            ) : null}
            <button
              type="button"
              className="btn-primary mt-6 w-full py-3 text-base"
              disabled={isProcessing}
              onClick={() => void handleContinue()}
            >
              {isProcessing ? 'Reading your document…' : 'Continue to verification'}
            </button>
          </>
        ) : null}

        <p className="text-ink-subtle mt-6 flex items-start gap-2 text-xs leading-relaxed">
          <LockIcon />
          <span>
            Your document stays on this device until you choose to submit it, and is deleted
            automatically after verification.
          </span>
        </p>
      </div>
    </main>
  )
}

/** Decorative: the sentence beside it carries the promise. */
function LockIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="mt-px h-3.5 w-3.5 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="4.5" y="10.5" width="15" height="9.5" rx="2" />
      <path d="M8 10.5V7.8a4 4 0 0 1 8 0v2.7" />
    </svg>
  )
}
