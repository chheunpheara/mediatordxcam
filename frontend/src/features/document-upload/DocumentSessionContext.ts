import { createContext, use } from 'react'

import type { ImageDimensions } from './validation'

/**
 * The document the user is currently verifying.
 *
 * A `File` cannot cross a route boundary in a URL, and re-reading it from an
 * `<input>` after navigation is impossible — the element is gone. So it is held
 * for the length of the session and handed to Phase 3, which POSTs it to
 * `/id-card/process`.
 *
 * Kept apart from the provider component so that React Fast Refresh treats the
 * hook as a plain module: editing the provider must not invalidate every
 * consumer of `useDocumentSession`.
 */

export interface UploadedDocument {
  readonly file: File
  readonly dimensions: ImageDimensions
  /** Object URL for display. Revoked automatically; never store it yourself. */
  readonly previewUrl: string
}

export interface DocumentSessionValue {
  readonly document: UploadedDocument | null
  /** True while the stored copy (D21) is being read back after a refresh. */
  readonly restoring: boolean
  readonly accept: (file: File, dimensions: ImageDimensions) => void
  readonly clear: () => void
}

export const DocumentSessionContext = createContext<DocumentSessionValue | null>(null)

export function useDocumentSession(): DocumentSessionValue {
  const value = use(DocumentSessionContext)
  if (!value) {
    throw new Error('useDocumentSession must be used inside a DocumentSessionProvider')
  }
  return value
}