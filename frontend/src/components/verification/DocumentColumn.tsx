import { useState } from 'react'

import { Link } from 'react-router-dom'

import { routes } from '../../app/routes'
import { artifactUrl } from '../../lib/api'
import type { ProcessingState } from '../../features/id-card-processing/ProcessingContext'

/**
 * Column 1 — the original document, exactly as uploaded (§9).
 *
 * The preview reads from the artefact endpoint rather than from a local object
 * URL. That keeps the bytes in one place: what is shown is the same artefact the
 * backend stored, so a file the backend rejected can never be displayed here as
 * though it had been accepted.
 *
 * Zoom is a `transform: scale()` on the image alone. Scaling the frame instead
 * would push the other two columns around, and the point of zooming is to read
 * small print without losing your place in the workspace (§9).
 */

const ZOOM_STEPS = [1, 1.5, 2, 3] as const

export interface DocumentColumnProps {
  readonly fileName: string
  readonly width: number
  readonly height: number
  readonly documentRef: string | null
  readonly state: ProcessingState
}

export function DocumentColumn({
  fileName,
  width,
  height,
  documentRef,
  state,
}: DocumentColumnProps) {
  const [zoomIndex, setZoomIndex] = useState(0)
  const zoom = ZOOM_STEPS[zoomIndex] ?? ZOOM_STEPS[0]

  return (
    <section className="card flex flex-col p-5" aria-label="Original ID card">
      <h2 className="text-ink-subtle text-sm font-semibold">Original ID card</h2>
      <p className="text-ink-muted mt-1 break-all text-sm font-medium">{fileName}</p>
      <p className="text-ink-subtle mt-1 text-xs">
        {width} × {height} px
      </p>

      <div className="bg-canvas mt-4 flex min-h-56 flex-1 items-center justify-center overflow-hidden rounded-lg border">
        {documentRef ? (
          <img
            alt={`Original ID card uploaded as ${fileName}`}
            className="max-h-96 max-w-full object-contain transition-transform"
            src={artifactUrl(documentRef)}
            style={{ transform: `scale(${zoom})` }}
          />
        ) : (
          <p className="text-ink-subtle px-4 py-8 text-center text-xs">
            {state === 'processing' ? 'Preparing your document…' : 'Your document will appear here.'}
          </p>
        )}
      </div>

      <div className="mt-3 flex items-center gap-2">
        <button
          aria-label="Zoom out"
          className="btn-secondary px-3 py-1.5"
          disabled={zoomIndex === 0}
          onClick={() => setZoomIndex((i) => i - 1)}
          type="button"
        >
          −
        </button>
        <span aria-live="polite" className="text-ink-subtle min-w-16 text-center text-xs">
          {Math.round(zoom * 100)}%
        </span>
        <button
          aria-label="Zoom in"
          className="btn-secondary px-3 py-1.5"
          disabled={zoomIndex >= ZOOM_STEPS.length - 1}
          onClick={() => setZoomIndex((i) => i + 1)}
          type="button"
        >
          +
        </button>
      </div>

      <p className="text-ink-subtle mt-3 text-xs" role="status">
        {processingLabel(state)}
      </p>

      <Link className="btn-secondary mt-4" to={routes.landing}>
        Replace document
      </Link>
    </section>
  )
}

/** The §9 "processing status" line, phrased so it never implies verification. */
function processingLabel(state: ProcessingState): string {
  switch (state) {
    case 'idle':
      return 'Waiting to start.'
    case 'processing':
      return 'Processing…'
    case 'ready':
      return 'Processing complete.'
    case 'failed':
      return 'Processing could not finish.'
  }
}