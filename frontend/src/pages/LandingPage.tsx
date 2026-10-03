import { useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { routes } from '../app/routes'
import { useDocumentSession } from '../features/document-upload/DocumentSessionContext'
import { Dropzone } from '../features/document-upload/Dropzone'
import { ImagePreview } from '../features/document-upload/ImagePreview'
import { validateDocumentImage } from '../features/document-upload/validation'

/**
 * Landing page (§6): upload → validate → preview → continue.
 *
 * Nothing leaves the device here. The preview is a deliberate checkpoint before
 * the user commits to the verification workspace, and `POST /id-card/process` is
 * Phase 3 — the Continue button navigates with the file held in session, it does
 * not transmit anything yet.
 *
 * The session lives above the router (see `App`), so the file survives the
 * navigation this page performs.
 */
export function LandingPage() {
  const navigate = useNavigate()
  const { document, accept, clear } = useDocumentSession()
  const [error, setError] = useState<string | null>(null)
  const [isValidating, setIsValidating] = useState(false)

  const handleSelect = async (file: File) => {
    setError(null)
    setIsValidating(true)
    try {
      const result = await validateDocumentImage(file)
      if (!result.ok) {
        setError(result.message)
        return
      }
      accept(result.file, result.dimensions)
    } finally {
      setIsValidating(false)
    }
  }

  const handleClear = () => {
    clear()
    setError(null)
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-xl flex-col justify-center p-4 sm:p-6">
      <div className="card p-6 sm:p-8">
        <h1 className="text-2xl font-semibold">Identity Verification</h1>
        <p className="text-ink-muted mt-2 text-sm">
          Verify your identity securely using your Cambodian National ID Card.
        </p>

        <div className="mt-8">
          {document ? (
            <ImagePreview document={document} onClear={handleClear} />
          ) : (
            <Dropzone onSelect={(file) => void handleSelect(file)} error={error} disabled={isValidating} />
          )}
        </div>

        {document ? (
          <button
            type="button"
            className="btn-primary mt-6 w-full"
            onClick={() => void navigate(routes.idCard)}
          >
            Continue to verification
          </button>
        ) : null}

        <p className="text-ink-subtle mt-6 text-xs leading-relaxed">
          Your document stays on this device until you choose to submit it, and is deleted
          automatically after verification.
        </p>
      </div>
    </main>
  )
}