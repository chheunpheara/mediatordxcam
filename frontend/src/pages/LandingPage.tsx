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
    <main className="mx-auto flex min-h-screen w-full max-w-xl flex-col justify-center p-4 sm:p-6">
      <div className="card p-6 sm:p-8">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold">Identity Verification</h1>
            <p className="text-ink-muted mt-2 text-sm">
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
              className="border-border bg-surface-sunken rounded-xl border-2 border-dashed p-8 text-center"
              role="status"
            >
              <p className="text-sm font-semibold">Restoring your selection…</p>
              <p className="text-ink-muted mt-1 text-sm">
                Bringing back your uploaded document.
              </p>
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
              className="btn-primary mt-6 w-full"
              disabled={isProcessing}
              onClick={() => void handleContinue()}
            >
              {isProcessing ? 'Reading your document…' : 'Continue to verification'}
            </button>
          </>
        ) : null}

        <p className="text-ink-subtle mt-6 text-xs leading-relaxed">
          Your document stays on this device until you choose to submit it, and is deleted
          automatically after verification.
        </p>
      </div>
    </main>
  )
}