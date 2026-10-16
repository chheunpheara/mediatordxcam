import { formatFileSize } from './validation'
import type { UploadedDocument } from './DocumentSessionContext'

/**
 * Preview of the chosen document, shown before anything is uploaded (§36).
 *
 * The user confirms "this is the right side of my card" while it is still only on
 * their device — no network request has been made at this point.
 */

interface ImagePreviewProps {
  readonly document: UploadedDocument
  readonly onClear: () => void
}

export function ImagePreview({ document, onClear }: ImagePreviewProps) {
  const { file, dimensions, previewUrl } = document
  const { width, height } = dimensions

  return (
    <figure className="card lift overflow-hidden">
      <img
        src={previewUrl}
        alt={`Preview of the selected file: ${file.name}`}
        className="bg-surface-sunken max-h-96 w-full object-contain"
      />

      <figcaption className="flex flex-wrap items-center justify-between gap-3 p-4">
        <dl className="min-w-0 text-sm">
          <dt className="sr-only-focusable">Selected file</dt>
          <dd className="truncate font-semibold">{file.name}</dd>
          <dt className="text-ink-subtle mt-1 text-xs">Resolution</dt>
          <dd className="text-ink-muted text-xs">
            {width} × {height} px · {formatFileSize(file.size)}
          </dd>
        </dl>

        <button type="button" className="btn-secondary" onClick={onClear}>
          Choose a different image
        </button>
      </figcaption>
    </figure>
  )
}