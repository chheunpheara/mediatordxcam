import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { DocumentSessionContext } from './DocumentSessionContext'
import type { DocumentSessionValue, UploadedDocument } from './DocumentSessionContext'
import type { ImageDimensions } from './validation'
import { dataUrlToFile } from '../../lib/session'
import {
  clearStoredDocument,
  hasStoredDocument,
  loadStoredDocument,
  saveStoredDocument,
} from '../../lib/documentStore'

/**
 * Holds the selected document for the whole session, above the router.
 *
 * Scope is the app rather than the landing page: the preview on `/` and the
 * workspace on `/id-card` are two views of one selection, and Phase 3 POSTs the
 * file from the second page.
 *
 * The bytes are mirrored to IndexedDB so a refresh on `/id-card` rehydrates
 * instead of resetting the workspace (D21); `sessionStorage` only carries the
 * marker that a copy is waiting, because its ~5 MB quota cannot hold the 10 MB
 * uploads validation allows. First paint reports `restoring` while that copy is
 * read, so the workspace can say "restoring" instead of "no document selected",
 * and only an explicit back-to-upload clears it.
 */
export function DocumentSessionProvider({ children }: { children: React.ReactNode }) {
  const [document, setDocument] = useState<UploadedDocument | null>(null)
  const [restoring, setRestoring] = useState(hasStoredDocument)

  /**
   * The live object URL lives in a ref, not in state. Revoking "the previous one"
   * needs the actual previous value, and reading state inside a state setter is
   * unsafe — React may already have discarded the render that held it.
   */
  const previewUrlRef = useRef<string | null>(null)

  const releasePreviewUrl = useCallback(() => {
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current)
      previewUrlRef.current = null
    }
  }, [])

  // Read the stored copy back. accept() and clear() both drop `restoring`
  // first, and that state change cancels this effect — a restore in flight
  // loses to an explicit user action rather than overwriting it.
  useEffect(() => {
    if (!restoring) return
    let active = true
    void loadStoredDocument().then((stored) => {
      if (!active) return
      setRestoring(false)
      if (!stored) return
      try {
        setDocument({
          file: dataUrlToFile(stored.dataUrl, stored.fileName, stored.type),
          dimensions: { width: stored.width, height: stored.height },
          // Object URLs do not survive a refresh; the stored data URL is the
          // preview for a restored entry, as it was when the bytes were read.
          previewUrl: stored.dataUrl,
        })
      } catch {
        // An undecodable record counts as no record; the save effect below
        // then clears it, so the session heals to the empty state.
      }
    })
    return () => {
      active = false
    }
  }, [restoring])

  const accept = useCallback(
    (file: File, dimensions: ImageDimensions) => {
      // Revoke before replacing, or the old blob stays resident for the rest of
      // the session — invisible until a phone runs out of memory.
      releasePreviewUrl()
      const previewUrl = URL.createObjectURL(file)
      previewUrlRef.current = previewUrl
      setRestoring(false)
      setDocument({ file, dimensions, previewUrl })
    },
    [releasePreviewUrl],
  )

  const clear = useCallback(() => {
    releasePreviewUrl()
    setRestoring(false)
    setDocument(null)
  }, [releasePreviewUrl])

  // Unmounting with a URL outstanding leaks the blob, so release on the way out.
  useEffect(() => releasePreviewUrl, [releasePreviewUrl])

  // Persistence: mirror the file bytes to IndexedDB so `/id-card` survives a
  // refresh (D21). Object URLs are not storable, so we re-read the file here;
  // skipped while a restore is in flight, whose own copy is already stored.
  useEffect(() => {
    if (restoring) return
    if (!document) {
      void clearStoredDocument()
      return
    }
    let active = true
    const reader = new FileReader()
    reader.onload = () => {
      if (!active || typeof reader.result !== 'string') return
      void saveStoredDocument({
        fileName: document.file.name,
        type: document.file.type,
        width: document.dimensions.width,
        height: document.dimensions.height,
        dataUrl: reader.result,
      })
    }
    try {
      reader.readAsDataURL(document.file)
    } catch {
      // ignore
    }
    return () => {
      active = false
      try {
        reader.abort()
      } catch {
        // ignore
      }
    }
  }, [document, restoring])

  const value = useMemo<DocumentSessionValue>(
    () => ({ document, restoring, accept, clear }),
    [document, restoring, accept, clear],
  )

  return <DocumentSessionContext value={value}>{children}</DocumentSessionContext>
}
