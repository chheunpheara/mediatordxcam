import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { DocumentSessionContext } from './DocumentSessionContext'
import type { DocumentSessionValue, UploadedDocument } from './DocumentSessionContext'
import type { ImageDimensions } from './validation'
import { clearSessionSlice, dataUrlToFile, readSession, setSessionSlice } from '../../lib/session'

/**
 * Holds the selected document for the whole session, above the router.
 *
 * Scope is the app rather than the landing page: the preview on `/` and the
 * workspace on `/id-card` are two views of one selection, and Phase 3 POSTs the
 * file from the second page.
 *
 * The bytes are mirrored to `sessionStorage` so a refresh on `/id-card`
 * rehydrates instead of resetting the workspace; only an explicit back-to-upload
 * clears that slice.
 */
export function DocumentSessionProvider({ children }: { children: React.ReactNode }) {
  const [document, setDocument] = useState<UploadedDocument | null>(() => {
    const stored = readSession()?.doc
    if (!stored) return null
    try {
      const file = dataUrlToFile(stored.dataUrl, stored.fileName, stored.type)
      return {
        file,
        dimensions: { width: stored.width, height: stored.height },
        previewUrl: stored.dataUrl,
      }
    } catch {
      return null
    }
  })

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

  const accept = useCallback(
    (file: File, dimensions: ImageDimensions) => {
      // Revoke before replacing, or the old blob stays resident for the rest of
      // the session — invisible until a phone runs out of memory.
      releasePreviewUrl()
      const previewUrl = URL.createObjectURL(file)
      previewUrlRef.current = previewUrl
      setDocument({ file, dimensions, previewUrl })
    },
    [releasePreviewUrl],
  )

  const clear = useCallback(() => {
    releasePreviewUrl()
    setDocument(null)
  }, [releasePreviewUrl])

  // Unmounting with a URL outstanding leaks the blob, so release on the way out.
  useEffect(() => releasePreviewUrl, [releasePreviewUrl])

  // Persistence: carry the file bytes in sessionStorage so `/id-card`
  // survives a refresh. Object URLs are not storable, so we re-read the file
  // here; the rehydrated entry uses the same `previewUrl`.
  useEffect(() => {
    if (!document) {
      clearSessionSlice('doc')
      return
    }
    let active = true
    const reader = new FileReader()
    reader.onload = () => {
      if (!active || typeof reader.result !== 'string') return
      setSessionSlice('doc', {
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
  }, [document])

  const value = useMemo<DocumentSessionValue>(
    () => ({ document, accept, clear }),
    [document, accept, clear],
  )

  return <DocumentSessionContext value={value}>{children}</DocumentSessionContext>
}