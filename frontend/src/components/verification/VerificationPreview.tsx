import type { SessionInputs } from '../../features/verification/VerificationContext'
import { artifactUrl } from '../../lib/api'
import type { VerificationMethod } from '../../lib/api'

import { LivenessArt, PhotoMatchArt } from './PhotoMatchArt'

/**
 * The report's first column (§24): what the method was actually given.
 *
 * A method that reads a face or records a liveness clip is answering a
 * question about a picture — "is this the person on the card?", "is this a
 * live person?" — and a list of words cannot stand in for it. So those methods
 * get this column: the photos compared, or the recording played, beside the
 * field list in the second column.
 *
 * Which art appears is read off the same `VerificationMethod` flags the rest
 * of the panel renders (§11); there is no `if (method === …)` here either.
 */
export function VerificationPreview({
  method,
  inputs,
  checking,
}: {
  readonly method: VerificationMethod
  readonly inputs: SessionInputs
  readonly checking: boolean
}) {
  const faceSrc = handle(inputs.currentFaceRef)
  // Only a method that reads the card may show it: for any other method the
  // picture is in the session but was not part of the question (§13).
  const cardSrc = method.requiresIdCard
    ? (handle(inputs.idCardFaceRef) ?? handle(inputs.documentRef))
    : null
  const livenessSrc = handle(inputs.livenessRef)

  const showsPhoto = method.requiresCurrentFace && faceSrc !== null
  const showsLiveness = method.requiresLiveness
  const empty = !showsPhoto && !showsLiveness

  return (
    <section aria-label="Preview" className="verify-preview">
      <h3 className="text-sm font-semibold">Preview</h3>
      <p className="text-ink-subtle mt-1 text-xs">What this check was given.</p>

      {showsPhoto ? <PhotoMatchArt cardSrc={cardSrc} checking={checking} faceSrc={faceSrc} /> : null}
      {showsLiveness ? <LivenessArt src={livenessSrc} /> : null}
      {empty ? (
        <p className="text-ink-subtle border-border rounded-lg border border-dashed p-4 text-xs" role="status">
          {method.requiresCurrentFace
            ? 'No photo is attached yet, so there is nothing to preview.'
            : 'This method reads your details — there is no picture to preview.'}
        </p>
      ) : null}
    </section>
  )
}

function handle(ref: string | null): string | null {
  return ref === null ? null : artifactUrl(ref)
}
