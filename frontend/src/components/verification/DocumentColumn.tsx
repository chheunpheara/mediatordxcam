import { useRef, useState } from 'react'

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
 * Two ways to read the small print, both scaling the image alone — scaling the
 * frame would push the other two columns around (§9):
 *
 * * The ± buttons step the whole preview through fixed zoom levels.
 * * Hovering the card magnifies it *around the point under the pointer*, like a
 *   magnifier, so the row you are inspecting stays put while the rest expands.
 *   Touch is excluded (there is no hover); keyboard users keep the buttons.
 */

const ZOOM_STEPS = [1, 1.5, 2, 3] as const

/** Extra magnification applied while the pointer is over the card. */
const HOVER_MAGNIFICATION = 2

/** The point of hover zoom: the card focuses exactly where the pointer points. */
interface HoverPoint {
  readonly x: number
  readonly y: number
}

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
  const [hoverPoint, setHoverPoint] = useState<HoverPoint | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const imageRef = useRef<HTMLImageElement>(null)
  const zoom = ZOOM_STEPS[zoomIndex] ?? ZOOM_STEPS[0]

  /**
   * Where the pointer is, in the image's own (untransformed) coordinates.
   *
   * `offsetLeft`/`offsetWidth` are layout values, so they report the resting
   * geometry even while the hover transform is applied — reading the live
   * bounding rect instead would feed the magnified position back into the next
   * calculation and drift.
   */
  function trackPointer(event: React.PointerEvent<HTMLDivElement>) {
    if (event.pointerType === 'touch') return
    const container = containerRef.current
    const image = imageRef.current
    if (!container || !image) return
    const box = container.getBoundingClientRect()
    const x = event.clientX - box.left - image.offsetLeft
    const y = event.clientY - box.top - image.offsetTop
    setHoverPoint({
      x: Math.min(Math.max(x, 0), image.offsetWidth),
      y: Math.min(Math.max(y, 0), image.offsetHeight),
    })
  }

  const magnifying = hoverPoint !== null && documentRef !== null
  const scale = magnifying ? zoom * HOVER_MAGNIFICATION : zoom
  // With the origin at the image's top-left, `translate((1 - s)·p)` pins the
  // hovered point p in place while scale `s` grows the image around it.
  const transform =
    magnifying && hoverPoint
      ? `translate(${(1 - scale) * hoverPoint.x}px, ${(1 - scale) * hoverPoint.y}px) scale(${scale})`
      : `scale(${zoom})`

  return (
    <section className="card flex flex-col p-5" aria-label="Original ID card">
      <h2 className="text-ink-subtle text-sm font-semibold">Original ID card</h2>
      <p className="text-ink-muted mt-1 break-all text-sm font-medium">{fileName}</p>
      <p className="text-ink-subtle mt-1 text-xs">
        {width} × {height} px
      </p>

      <div
        className="bg-canvas mt-4 flex min-h-56 flex-1 items-center justify-center overflow-hidden rounded-lg border"
        onPointerLeave={() => setHoverPoint(null)}
        onPointerMove={trackPointer}
        ref={containerRef}
      >
        {documentRef ? (
          <img
            alt={`Original ID card uploaded as ${fileName}`}
            className={`max-h-96 max-w-full object-contain ${magnifying ? '' : 'transition-transform'}`}
            ref={imageRef}
            src={artifactUrl(documentRef)}
            style={
              magnifying
                ? { transform, transformOrigin: '0 0' }
                : { transform }
            }
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

      {documentRef ? (
        <p className="text-ink-subtle mt-2 text-xs">
          Hover over the card to magnify the area under your pointer.
        </p>
      ) : null}

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