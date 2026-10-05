import { useEffect, useRef, useState } from 'react'

/**
 * The uploaded card at near-full-screen size (§9: read small print without
 * losing your place — the workspace stays mounted behind the overlay).
 *
 * The in-column preview is capped at 384px tall; the modal gives the image
 * most of the viewport and, at the ± zoom steps, scrolls to every part of a
 * card that exceeds it — a transform alone would magnify but never let you
 * pan past the frame.
 *
 * Three exits, because a modal that traps people is a bug: the Close button,
 * Escape, and a click on the backdrop. Opening moves focus to Close; the
 * caller moves focus back when this unmounts.
 */

const ZOOM_STEPS = [1, 1.5, 2, 3] as const

export interface CardPreviewModalProps {
  readonly src: string
  readonly alt: string
  readonly onClose: () => void
}

export function CardPreviewModal({ src, alt, onClose }: CardPreviewModalProps) {
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const [zoomIndex, setZoomIndex] = useState(0)
  const zoom = ZOOM_STEPS[zoomIndex] ?? ZOOM_STEPS[0]

  useEffect(() => {
    closeButtonRef.current?.focus()
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return (
    // Backdrop: a click anywhere outside the dialog closes it.
    <div
      className="bg-ink/80 fixed inset-0 z-50 flex items-center justify-center p-4"
      onClick={onClose}
      role="presentation"
    >
      {/* Dialog: clicks inside must not fall through to the backdrop. */}
      <div
        aria-label="ID card preview"
        aria-modal="true"
        className="w-full max-w-5xl"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
      >
        <div className="bg-surface max-h-[75vh] overflow-auto rounded-lg p-2">
          <img
            alt={alt}
            className="mx-auto rounded"
            src={src}
            style={{ width: `${Math.round(zoom * 100)}%` }}
          />
        </div>

        <div className="mt-3 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <button
              aria-label="Zoom out"
              className="btn-secondary px-3 py-1.5"
              disabled={zoomIndex === 0}
              onClick={() => setZoomIndex((i) => i - 1)}
              type="button"
            >
              −
            </button>
            <span aria-live="polite" className="text-ink-muted min-w-16 text-center text-xs">
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

          <button
            className="btn-secondary px-4 py-1.5"
            onClick={onClose}
            ref={closeButtonRef}
            type="button"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
