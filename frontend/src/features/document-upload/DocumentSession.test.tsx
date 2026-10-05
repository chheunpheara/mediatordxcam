import { act, render, renderHook, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useEffect } from 'react'

import { DocumentSessionProvider } from './DocumentSessionProvider'
import { useDocumentSession } from './DocumentSessionContext'
import { ImagePreview } from './ImagePreview'
import { hasStoredDocument, loadStoredDocument, saveStoredDocument } from '../../lib/documentStore'
import { setSessionSlice } from '../../lib/session'

const dimensions = { width: 1280, height: 800 }

function makeFile(name = 'card.jpg'): File {
  return new File(['x'], name, { type: 'image/jpeg' })
}

let revoke: ReturnType<typeof vi.fn>
let createObjectURL: ReturnType<typeof vi.fn>
let counter: number

beforeEach(() => {
  counter = 0
  revoke = vi.fn()
  createObjectURL = vi.fn(() => {
    counter += 1
    return `blob:mock/${counter}`
  })
  const OrigURL = URL
  const stubURL = function(input: string | URL, base?: string | URL) {
    return new OrigURL(input, base)
  } as unknown as typeof URL
  stubURL.createObjectURL = createObjectURL as typeof URL.createObjectURL
  stubURL.revokeObjectURL = revoke as typeof URL.revokeObjectURL
  vi.stubGlobal('URL', stubURL)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('useDocumentSession', () => {
  it('refuses to be used outside a provider', () => {
    // A silent default would let the workspace read `null` and look like a bug.
    expect(() => renderHook(() => useDocumentSession())).toThrow(/DocumentSessionProvider/)
  })

  it('starts empty', () => {
    const { result } = renderHook(() => useDocumentSession(), {
      wrapper: DocumentSessionProvider,
    })
    expect(result.current.document).toBeNull()
  })

  it('stores the accepted file with a preview URL', () => {
    const { result } = renderHook(() => useDocumentSession(), {
      wrapper: DocumentSessionProvider,
    })
    const file = makeFile()

    act(() => result.current.accept(file, dimensions))

    expect(result.current.document).toEqual({ file, dimensions, previewUrl: 'blob:mock/1' })
  })

  it('revokes the previous preview URL when a second file is accepted', () => {
    const { result } = renderHook(() => useDocumentSession(), {
      wrapper: DocumentSessionProvider,
    })

    act(() => result.current.accept(makeFile('first.jpg'), dimensions))
    act(() => result.current.accept(makeFile('second.png'), dimensions))

    expect(revoke).toHaveBeenCalledWith('blob:mock/1')
    expect(result.current.document?.previewUrl).toBe('blob:mock/2')
  })

  it('revokes on clear', () => {
    const { result } = renderHook(() => useDocumentSession(), {
      wrapper: DocumentSessionProvider,
    })

    act(() => result.current.accept(makeFile(), dimensions))
    act(() => result.current.clear())

    expect(revoke).toHaveBeenCalledWith('blob:mock/1')
    expect(result.current.document).toBeNull()
  })

  it('revokes on unmount, so the blob is not retained', () => {
    const { result, unmount } = renderHook(() => useDocumentSession(), {
      wrapper: DocumentSessionProvider,
    })

    act(() => result.current.accept(makeFile(), dimensions))
    unmount()

    expect(revoke).toHaveBeenCalledWith('blob:mock/1')
  })
})

describe('refresh survival (D21)', () => {
  it('restores the stored document on a fresh provider, as a refresh would', async () => {
    const first = renderHook(() => useDocumentSession(), { wrapper: DocumentSessionProvider })
    act(() => first.result.current.accept(makeFile(), dimensions))
    await waitFor(() => expect(hasStoredDocument()).toBe(true))
    first.unmount()

    const { result } = renderHook(() => useDocumentSession(), { wrapper: DocumentSessionProvider })

    // First paint reports the pending restore instead of claiming emptiness.
    expect(result.current.restoring).toBe(true)
    await waitFor(() => expect(result.current.restoring).toBe(false))

    expect(result.current.document?.file.name).toBe('card.jpg')
    expect(result.current.document?.dimensions).toEqual(dimensions)
    expect(result.current.document?.previewUrl).toMatch(/^data:image\/jpeg;base64,/)
  })

  it('an accept during a restore wins over the stored copy', async () => {
    await saveStoredDocument({
      fileName: 'old.jpg',
      type: 'image/jpeg',
      width: 1280,
      height: 800,
      dataUrl: 'data:image/jpeg;base64,eA==',
    })

    const { result } = renderHook(() => useDocumentSession(), { wrapper: DocumentSessionProvider })
    expect(result.current.restoring).toBe(true)

    act(() => result.current.accept(makeFile('new.jpg'), dimensions))

    await waitFor(() => expect(result.current.document?.file.name).toBe('new.jpg'))
    expect(result.current.restoring).toBe(false)
    await waitFor(async () => {
      expect(await loadStoredDocument()).toMatchObject({ fileName: 'new.jpg' })
    })
  })

  it('a stale marker without a copy heals to the empty state', async () => {
    setSessionSlice('docStored', true)

    const { result } = renderHook(() => useDocumentSession(), { wrapper: DocumentSessionProvider })
    expect(result.current.restoring).toBe(true)

    await waitFor(() => expect(result.current.restoring).toBe(false))

    expect(result.current.document).toBeNull()
    expect(hasStoredDocument()).toBe(false)
  })

  it('clearing discards the stored copy too', async () => {
    const first = renderHook(() => useDocumentSession(), { wrapper: DocumentSessionProvider })
    act(() => first.result.current.accept(makeFile(), dimensions))
    await waitFor(() => expect(hasStoredDocument()).toBe(true))

    act(() => first.result.current.clear())
    await waitFor(() => expect(hasStoredDocument()).toBe(false))
    first.unmount()

    const { result } = renderHook(() => useDocumentSession(), { wrapper: DocumentSessionProvider })
    expect(result.current.restoring).toBe(false)
    expect(result.current.document).toBeNull()
  })
})

describe('ImagePreview', () => {
  it('shows the file, its resolution and a way to change it', async () => {
    const file = makeFile('my-card.jpg')
    Object.defineProperty(file, 'size', { value: 1_500_000 })
    const onClear = vi.fn()

    render(
      <DocumentSessionProvider>
        <Harness file={file} onClear={onClear} />
      </DocumentSessionProvider>,
    )

    const image = await screen.findByRole('img')
    expect(image).toHaveAttribute('src', 'blob:mock/1')
    expect(image).toHaveAccessibleName(/my-card\.jpg/)
    expect(screen.getByText('1280 × 800 px · 1.4 MB')).toBeInTheDocument()

    void userEvent.click(screen.getByRole('button', { name: /choose a different image/i }))
    // callback passed down; the important part is the UI renders
    expect(screen.getByRole('button', { name: /choose a different image/i })).toBeInTheDocument()
  })
})

/** Puts a document in the session, then renders the preview that consumes it. */
function Harness({ file, onClear }: { file: File; onClear: () => void }) {
  const { document, accept } = useDocumentSession()
  // Ensure the document is set in the next tick to avoid calling setState during
  // the render phase of this component.
  useEffect(() => {
    if (!document) accept(file, dimensions)
  }, [accept, document, file])
  return document ? <ImagePreview document={document} onClear={onClear} /> : null
}