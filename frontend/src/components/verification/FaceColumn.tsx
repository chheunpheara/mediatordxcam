import { FACE_STATUS, artifactUrl } from '../../lib/api'
import { FACE_MESSAGES } from '../../features/id-card-processing/faceMessages'
import type { FaceExtraction, FaceStatus } from '../../lib/api'

/**
 * Column 2 — the face cut off the ID card (§12).
 *
 * Every message here is quoted verbatim from §12. These three sentences are the
 * requirement, so they are constants rather than JSX fragments: a reworded
 * status would still satisfy a test that only looked for "no face".
 *
 * §12 says *do not fabricate a face*. So there is no placeholder image and no
 * generic "unavailable" tile — when detection fails the column states which of
 * the three reasons applies and stops.
 *
 * The footnote is not decoration. §13 insists the boundary between local OpenCV
 * detection and CamDigiKey verification stays explicit, and this is the one
 * place a user is looking at a picture of their own face being asserted to be
 * the right one.
 */

export interface FaceColumnProps {
  readonly face: FaceExtraction | null
}

export function FaceColumn({ face }: FaceColumnProps) {
  return (
    <section className="card flex flex-col p-5" aria-label="ID card face">
      <h2 className="text-ink-subtle text-sm font-semibold">ID card face</h2>
      {face ? <FaceOutcome face={face} /> : <p className="text-ink-subtle mt-3 text-xs">Looking for a face…</p>}
    </section>
  )
}

function FaceOutcome({ face }: { face: FaceExtraction }) {
  if (face.status === FACE_STATUS.detected) {
    return (
      <>
        <div className="bg-canvas mt-4 flex min-h-56 flex-1 items-center justify-center overflow-hidden rounded-lg border">
          {face.faceRef ? (
            <img
              alt="Face extracted from the ID card"
              className="max-h-96 max-w-full object-contain"
              src={artifactUrl(face.faceRef)}
            />
          ) : (
            <p className="text-ink-subtle px-4 py-8 text-center text-xs">
              A face was located but its image is no longer available.
            </p>
          )}
        </div>
        <p className="text-ink-subtle mt-3 text-xs" role="status">
          One face detected on the ID card.
        </p>
        <p className="text-ink-subtle mt-3 text-xs leading-relaxed">
          Found on this device with OpenCV face detection. It has not been compared against any
          government record — only CamDigiKey does that.
        </p>
      </>
    )
  }

  return (
    <>
      <div className="bg-canvas text-ink-subtle mt-4 flex min-h-56 flex-1 items-center justify-center rounded-lg border p-6 text-center">
        <p className="text-sm font-medium leading-relaxed">{messageFor(face.status)}</p>
      </div>
      {face.status === FACE_STATUS.multiple ? (
        <p className="text-ink-subtle mt-3 text-xs">
          OpenCV found {face.detectedCount} faces. A valid ID card shows one.
        </p>
      ) : null}
      <p className="text-ink-subtle mt-3 text-xs leading-relaxed">
        Found on this device with OpenCV face detection. It has not been compared against any
        government record — only CamDigiKey does that.
      </p>
    </>
  )
}

/** Map a §12 status onto its exact sentence. */
function messageFor(status: Exclude<FaceStatus, 'detected'>): string {
  switch (status) {
    case FACE_STATUS.notDetected:
      return FACE_MESSAGES.noFace
    case FACE_STATUS.multiple:
      return FACE_MESSAGES.multiple
    case FACE_STATUS.lowQuality:
      return FACE_MESSAGES.poorQuality
  }
}