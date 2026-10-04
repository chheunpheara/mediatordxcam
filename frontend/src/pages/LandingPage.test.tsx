import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DocumentSessionProvider } from '@/features/document-upload/DocumentSessionProvider'
import { IdCardProcessingProvider } from '@/features/id-card-processing/IdCardProcessingProvider'
import { AppRoutes } from '@/app/AppRoutes'
import { MAX_FILE_SIZE_BYTES, MESSAGES } from '@/features/document-upload/validation'
import { stubFailingFetch, stubProcessingFetch } from '@/test/fixtures'

/**
 * The §6 landing flow, end to end: choose → validate → preview → continue.
 *
 * `validateDocumentImage` decodes via `createImageBitmap`, which jsdom does not
 * implement. Stubbing it here is closer to a real browser than mocking the
 * validator would be — the production code path still runs, only the decode is
 * replaced. `fetch` is stubbed for the same reason: §6 processes the card before
 * navigating, so the Continue button now performs a real request.
 */

let decoded: { width: number; height: number } | null

beforeEach(() => {
  decoded = { width: 1280, height: 800 }
  const OrigURL = URL
  const stubURL = function(input: string | URL, base?: string | URL) {
    return new OrigURL(input, base)
  } as unknown as typeof URL
  stubURL.createObjectURL = vi.fn(() => 'blob:mock/1')
  stubURL.revokeObjectURL = vi.fn()
  vi.stubGlobal('URL', stubURL)
  stubProcessingFetch()
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(() =>
      decoded
        ? Promise.resolve({ ...decoded, close: vi.fn() })
        : Promise.reject(new Error('undecodable')),
    ),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function renderLanding() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <DocumentSessionProvider>
        <IdCardProcessingProvider>
          <AppRoutes />
        </IdCardProcessingProvider>
      </DocumentSessionProvider>
    </MemoryRouter>,
  )
}

function getInput(container: HTMLElement): HTMLInputElement {
  return container.querySelector('input[type="file"]')!
}

describe('landing page upload flow', () => {
  it('starts with the upload panel and no way forward', () => {
    renderLanding()

    expect(screen.getByLabelText('Choose an ID Card image')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /continue/i })).not.toBeInTheDocument()
  })

  it('previews a valid image and offers to continue', async () => {
    const { container } = renderLanding()

    await userEvent.upload(
      getInput(container),
      new File(['x'], 'my-id.jpg', { type: 'image/jpeg' }),
    )

    const image = await screen.findByRole('img')
    expect(image).toHaveAccessibleName(/my-id\.jpg/)
    expect(screen.getByText(/1280 × 800 px/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /continue to verification/i })).toBeInTheDocument()
  })

  it('shows the exact message for an unsupported type and blocks progress', async () => {
    const { container } = renderLanding()
    const file = new File(['x'], 'doc.pdf', { type: 'application/pdf' })
    const input = getInput(container)
    Object.defineProperty(input, 'files', { value: [file] })
    fireEvent.change(input)
    expect(await screen.findByRole('alert')).toHaveTextContent(MESSAGES.invalidType)
    expect(screen.queryByRole('button', { name: /continue/i })).not.toBeInTheDocument()
  })

  it('shows the exact message for a low-resolution image and blocks progress', async () => {
    decoded = { width: 320, height: 240 }
    const { container } = renderLanding()
    const file = new File(['x'], 'small.png', { type: 'image/png' })
    await userEvent.upload(getInput(container), file)
    expect(await screen.findByRole('alert')).toHaveTextContent(MESSAGES.tooSmall)
    expect(screen.queryByRole('button', { name: /continue/i })).not.toBeInTheDocument()
  })

  it('shows the exact message for a corrupted file and blocks progress', async () => {
    decoded = null
    const { container } = renderLanding()
    const file = new File(['x'], 'broken.jpg', { type: 'image/jpeg' })
    await userEvent.upload(getInput(container), file)
    expect(await screen.findByRole('alert')).toHaveTextContent(MESSAGES.unreadable)
    expect(screen.queryByRole('button', { name: /continue/i })).not.toBeInTheDocument()
  })

  it('rejects a file over 10 MB with the exact message', async () => {
    const file = new File(['x'], 'huge.jpg', { type: 'image/jpeg' })
    Object.defineProperty(file, 'size', { value: MAX_FILE_SIZE_BYTES + 1 })

    const { container } = renderLanding()
    await userEvent.upload(getInput(container), file)

    expect(await screen.findByRole('alert')).toHaveTextContent(MESSAGES.tooLarge)
  })

  it('recovers after a rejected file once a good one is chosen', async () => {
    const { container } = renderLanding()
    const input = getInput(container)

    const bad = new File(['x'], 'doc.pdf', { type: 'application/pdf' })
    Object.defineProperty(input, 'files', { value: [bad], configurable: true })
    fireEvent.change(input)
    expect(await screen.findByRole('alert')).toBeInTheDocument()

    const good = new File(['x'], 'good.jpg', { type: 'image/jpeg' })
    Object.defineProperty(input, 'files', { value: [good], configurable: true })
    fireEvent.change(input)

    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
    expect(screen.getByRole('button', { name: /continue to verification/i })).toBeInTheDocument()
  })

  it('carries the document into the workspace when continuing', async () => {
    const { container } = renderLanding()

    await userEvent.upload(
      getInput(container),
      new File(['x'], 'carried.jpg', { type: 'image/jpeg' }),
    )
    await userEvent.click(await screen.findByRole('button', { name: /continue to verification/i }))

    // The workspace must see the same file: proof the session outlives the page
    // that created it.
    expect(
      await screen.findByRole('heading', { name: 'Verification workspace', level: 1 }),
    ).toBeInTheDocument()
    expect(screen.getByText('carried.jpg')).toBeInTheDocument()
  })

  it('returns to the upload panel when the choice is discarded', async () => {
    const { container } = renderLanding()

    await userEvent.upload(
      getInput(container),
      new File(['x'], 'replaced.jpg', { type: 'image/jpeg' }),
    )
    await userEvent.click(await screen.findByRole('button', { name: /different image/i }))

    expect(screen.getByLabelText('Choose an ID Card image')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /continue/i })).not.toBeInTheDocument()
  })
})

describe('processing failure', () => {
  it("shows the server's sentence and stays on the page", async () => {
    stubFailingFetch('IMAGE_UNREADABLE', 'File is corrupted or cannot be read as an image.')
    const { container } = renderLanding()

    await userEvent.upload(
      getInput(container),
      new File(['x'], 'broken.jpg', { type: 'image/jpeg' }),
    )
    await userEvent.click(await screen.findByRole('button', { name: /continue to verification/i }))

    // The user must not be navigated to a workspace with nothing in it, and must
    // not see a status line or a JSON body (§24, §28).
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'File is corrupted or cannot be read as an image.',
    )
    expect(
      screen.queryByRole('heading', { name: 'Verification workspace', level: 1 }),
    ).not.toBeInTheDocument()
  })

  it('keeps the chosen file so a retry does not mean re-uploading', async () => {
    stubFailingFetch('IMAGE_TOO_LOW_RESOLUTION', 'Image is too small. Minimum resolution is 640 × 480 pixels.')
    const { container } = renderLanding()

    await userEvent.upload(
      getInput(container),
      new File(['x'], 'small.jpg', { type: 'image/jpeg' }),
    )
    await userEvent.click(await screen.findByRole('button', { name: /continue to verification/i }))
    await screen.findByRole('alert')

    expect(screen.getByText('small.jpg')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /continue to verification/i }),
    ).toBeEnabled()
  })
})

describe('workspace without a document', () => {
  it('sends the user back to upload rather than showing an empty workspace', () => {
    render(
      <MemoryRouter initialEntries={['/id-card']}>
        <DocumentSessionProvider>
          <IdCardProcessingProvider>
            <AppRoutes />
          </IdCardProcessingProvider>
        </DocumentSessionProvider>
      </MemoryRouter>,
    )

    expect(screen.getByRole('status')).toHaveTextContent(/no document selected/i)
    expect(screen.getByRole('link', { name: /go to upload/i })).toHaveAttribute('href', '/')
  })
})