import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AppRoutes } from '@/app/AppRoutes'
import { IDENTITY_FORM_FIELDS } from '@/components/verification/identityFields'
import { FACE_MESSAGES } from '@/features/id-card-processing/faceMessages'
import { DocumentSessionProvider } from '@/features/document-upload/DocumentSessionProvider'
import { FaceCaptureProvider } from '@/features/face-capture/FaceCaptureProvider'
import { IdCardProcessingProvider } from '@/features/id-card-processing/IdCardProcessingProvider'
import { bodyOf, makeProcessingResult, makeUploadedRecord, makeVerifyResult, stubProcessingFetch, urlOf, VERIFICATION_METHODS } from '@/test/fixtures'
import { saveStoredDocument } from '@/lib/documentStore'
import { setSessionSlice } from '@/lib/session'
import type { FaceExtraction, ProcessIdCardResponse } from '@/lib/api'

/**
 * The three-column workspace (§8, §9, §12, §14).
 *
 * One test per column, then the guarantees that are easy to lose in a redesign:
 * that the face card never claims verification, that column 2 renders exactly
 * §14's nine fields and keeps the user's corrections, and that nothing here
 * ever shows raw JSON or a fabricated face.
 */

beforeEach(() => {
  vi.stubGlobal('URL', Object.assign(vi.fn(), {
    createObjectURL: vi.fn(() => 'blob:mock/document'),
    revokeObjectURL: vi.fn(),
  }))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <DocumentSessionProvider>
        <IdCardProcessingProvider>
          <FaceCaptureProvider>
            <AppRoutes />
          </FaceCaptureProvider>
        </IdCardProcessingProvider>
      </DocumentSessionProvider>
    </MemoryRouter>,
  )
}

/** Put a document in session the way the landing page does, then load `/id-card`. */
async function renderWorkspaceWithResult(
  result: ProcessIdCardResponse = makeProcessingResult(),
) {
  const fetchMock = stubProcessingFetch(result)
  const view = renderAt('/')

  const input = view.container.querySelector<HTMLInputElement>('input[type="file"]')!
  await waitFor(() => expect(input).toBeTruthy())

  const { default: userEvent } = await import('@testing-library/user-event')
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(() => Promise.resolve({ width: 1280, height: 800, close: vi.fn() })),
  )
  await userEvent.upload(input, new File(['x'], 'card.jpg', { type: 'image/jpeg' }))
  await userEvent.click(await screen.findByRole('button', { name: /continue to verification/i }))
  await screen.findByRole('heading', { name: 'Verification workspace', level: 1 })

  return { view, fetchMock }
}

/** Calls the ID-card process endpoint made, ignoring the method-list fetch. */
function processCalls(fetchMock: ReturnType<typeof vi.fn>): unknown[][] {
  return fetchMock.mock.calls.filter(([input]) => urlOf(input).includes('id-card/process'))
}

/** §12's four outcomes, built minimally. */
function faceWith(status: FaceExtraction['status'], detectedCount = 1): FaceExtraction {
  const detected = status === 'detected'
  return {
    status,
    source: 'local_opencv_detection',
    detectedCount,
    box: detected ? { x: 312, y: 96, width: 180, height: 210 } : null,
    faceRef: detected ? 'art_0123456789abcdef0123456789abcdef' : null,
    quality: detected ? 96.4 : null,
  }
}

describe('column 1 — the original document (§9)', () => {
  it('shows the uploaded file itself, fetched from the artefact endpoint', async () => {
    const result = makeProcessingResult()
    await renderWorkspaceWithResult(result)

    // §9: the original document, not a thumbnail of the card's face.
    const preview = await screen.findByAltText(/original id card uploaded as card\.jpg/i)
    expect(preview).toHaveAttribute(
      'src',
      `/api/v1/kyc/artifacts/${result.documentRef}`,
    )
    expect(preview).not.toHaveAttribute('src', `/api/v1/kyc/artifacts/${result.face.faceRef}`)
  })

  it('shows the filename and pixel dimensions', async () => {
    await renderWorkspaceWithResult()

    expect(await screen.findByText('card.jpg')).toBeInTheDocument()
    expect(await screen.findByText(/1280 × 800 px/)).toBeInTheDocument()
  })

  it('zooms the image on demand', async () => {
    const { default: userEvent } = await import('@testing-library/user-event')
    await renderWorkspaceWithResult()

    const preview = await screen.findByAltText(/original id card/i)
    expect(preview).toHaveStyle({ transform: 'scale(1)' })

    await userEvent.click(screen.getByRole('button', { name: /zoom in/i }))

    expect(screen.getByAltText(/original id card/i)).toHaveStyle({ transform: 'scale(1.5)' })
    expect(screen.getByText('150%')).toBeInTheDocument()
  })

  it('will not zoom out past the original size', async () => {
    await renderWorkspaceWithResult()
    await screen.findByAltText(/original id card/i)

    expect(screen.getByRole('button', { name: /zoom out/i })).toBeDisabled()
  })

  it('offers to replace the document', async () => {
    await renderWorkspaceWithResult()

    expect(await screen.findByRole('link', { name: /replace document/i })).toBeInTheDocument()
  })
})

describe('column 1, beneath the document — the ID card face (§12, §13)', () => {
  it('shows only the face, not the whole card', async () => {
    const result = makeProcessingResult()
    await renderWorkspaceWithResult(result)

    const face = await screen.findByAltText(/face extracted from the id card/i)
    expect(face).toHaveAttribute('src', `/api/v1/kyc/artifacts/${result.face.faceRef}`)
  })

  it("says §12's no-face sentence verbatim", async () => {
    await renderWorkspaceWithResult(
      makeProcessingResult({ face: faceWith('not_detected', 0) }),
    )

    expect(await screen.findByText(FACE_MESSAGES.noFace)).toBeInTheDocument()
    expect(FACE_MESSAGES.noFace).toBe("We couldn't detect a face on this ID Card.")
  })

  it("says §12's multiple-faces sentence verbatim", async () => {
    await renderWorkspaceWithResult(makeProcessingResult({ face: faceWith('multiple', 2) }))

    expect(await screen.findByText(FACE_MESSAGES.multiple)).toBeInTheDocument()
    expect(FACE_MESSAGES.multiple).toBe(
      'Multiple faces were detected. Please upload a valid ID Card image.',
    )
  })

  it("says §12's poor-quality sentence verbatim", async () => {
    await renderWorkspaceWithResult(makeProcessingResult({ face: faceWith('low_quality') }))

    expect(await screen.findByText(FACE_MESSAGES.poorQuality)).toBeInTheDocument()
    expect(FACE_MESSAGES.poorQuality).toBe(
      'The face image is unclear. Please upload a clearer ID Card.',
    )
  })

  it('fabricates nothing when no face was found', async () => {
    await renderWorkspaceWithResult(makeProcessingResult({ face: faceWith('not_detected', 0) }))

    await screen.findByText(FACE_MESSAGES.noFace)
    // §12: do not fabricate a face. No image element may stand in for the crop.
    expect(screen.queryByAltText(/face extracted/i)).not.toBeInTheDocument()
  })

  it('names OpenCV as the capturer and denies verification (§13)', async () => {
    await renderWorkspaceWithResult()

    expect(await screen.findByText(/opencv face detection/i)).toBeInTheDocument()
    expect(screen.getByText(/not been compared against any government record/i)).toBeInTheDocument()
    // Scoped to the face card: the page's Status filter (D23) honestly offers
    // a "Verified" option, which is a control, not a claim about this face.
    const faceCard = screen.getByRole('region', { name: /id card face/i })
    expect(within(faceCard).queryByText(/verified/i)).not.toBeInTheDocument()
  })
})

describe('column 2 — the editable KYC form (§14)', () => {
  it('renders exactly the nine fields of §14, in order', async () => {
    await renderWorkspaceWithResult()

    const form = await screen.findByRole('region', { name: /identity information/i })
    await waitFor(() =>
      expect(within(form).getAllByText(/Please enter|Not read|required/i).length).toBeGreaterThan(0),
    )
    expect(form.querySelectorAll('input')).toHaveLength(IDENTITY_FORM_FIELDS.length)

    const labels = within(form)
      .getAllByText(/^(National ID|First Name|Last Name|Gender|Date of Birth|Issued Date|Expired Date)/)
      .map((node) => node.textContent?.replace(' *', ''))

    expect(labels).toEqual([
      'National ID',
      'First Name — Khmer',
      'Last Name — Khmer',
      'First Name — English',
      'Last Name — English',
      'Gender',
      'Date of Birth',
      'Issued Date',
      'Expired Date',
    ])
  })

  it('pre-fills each field from the OCR read', async () => {
    await renderWorkspaceWithResult()

    await waitFor(() =>
      expect(screen.getByLabelText(/^National ID/)).toHaveValue('123456789'),
    )
    expect(screen.getByLabelText(/^First Name — English/)).toHaveValue('Sokha')
    expect(screen.getByLabelText(/^Last Name — English/)).toHaveValue('Cham')
    expect(screen.getByLabelText(/^Issued Date/)).toHaveValue('2021-04-12')
  })

  it('keeps the Khmer and English names as separate values', async () => {
    await renderWorkspaceWithResult()

    await waitFor(() =>
      expect(screen.getByLabelText(/^First Name — Khmer/)).toHaveValue('សុខា'),
    )
    expect(screen.getByLabelText(/^First Name — English/)).toHaveValue('Sokha')
  })

  it('prompts for a field OCR could not read instead of guessing (§16)', async () => {
    await renderWorkspaceWithResult()

    await waitFor(() =>
      expect(screen.getByLabelText(/^Date of Birth/)).toHaveValue(''),
    )
    expect(screen.getByText('Please enter this information.')).toBeInTheDocument()
  })

  it('accepts a correction and keeps it', async () => {
    await renderWorkspaceWithResult()

    const dob = await screen.findByLabelText(/^Date of Birth/)

    fireEvent.change(dob, { target: { value: '1994-02-11' } })

    expect(dob).toHaveValue('1994-02-11')
    expect(screen.queryByText('Please enter this information.')).not.toBeInTheDocument()
  })

  it('keeps a correction when the user clears a field deliberately', async () => {
    const { default: userEvent } = await import('@testing-library/user-event')
    await renderWorkspaceWithResult()

    const name = await screen.findByLabelText(/^First Name — English/)
    await userEvent.clear(name)
    await userEvent.type(name, 'S')

    expect(name).toHaveValue('S')
  })

  it('lets the user put a correction back to the OCR value', async () => {
    const { default: userEvent } = await import('@testing-library/user-event')
    await renderWorkspaceWithResult()

    const name = await screen.findByLabelText(/^First Name — English/)
    await userEvent.clear(name)
    await userEvent.type(name, 'Typo')
    expect(name).toHaveValue('Typo')

    await userEvent.click(screen.getByRole('button', { name: /reset to ocr/i }))

    expect(screen.getByLabelText(/^First Name — English/)).toHaveValue('Sokha')
  })

  it('makes every field editable, including the ones it could read', async () => {
    await renderWorkspaceWithResult()

    await waitFor(() =>
      expect(screen.getByLabelText(/^Gender/)).toHaveValue('F'),
    )
    // §14: all fields editable, so the user can fix a *wrong* read, not only a
    // missing one. A disabled input would make the pre-filled value unfalsifiable.
    expect(screen.getByLabelText(/^Gender/)).toBeEnabled()
  })

  it('counts the required fields still needing a value', async () => {
    await renderWorkspaceWithResult()

    expect(await screen.findByText(/required field still needs a value/i)).toBeInTheDocument()
  })

  it('never claims the entered values were verified (§13)', async () => {
    await renderWorkspaceWithResult()

    // Fill the last gap so the form reaches its complete state, where the
    // temptation to overclaim is highest.
    fireEvent.change(await screen.findByLabelText(/^Date of Birth/), {
      target: { value: '1994-02-11' },
    })

    expect(await screen.findByText(/been checked against a government record/i)).toBeInTheDocument()
    // Scoped to the form: the records list's Status filter (D23) offers a
    // "Verified" option — a control for filtering rows, not a claim here.
    const form = screen.getByRole('region', { name: /identity information/i })
    expect(within(form).queryByText(/^verified$/i)).not.toBeInTheDocument()
  })
})

describe('workspace behaviour', () => {
  it('lays the cards out in the D14 order: document, face, identity, method', async () => {
    await renderWorkspaceWithResult()

    const regions = await screen.findAllByRole('region')
    expect(regions.map((region) => region.getAttribute('aria-label'))).toEqual([
      'Original ID card',
      'ID card face',
      'Identity information',
      'Verification method',
      'Uploaded records',
    ])
  })

  it('does not process anything when there is no document in session', () => {
    const fetchMock = stubProcessingFetch()
    renderAt('/id-card')

    expect(screen.getByText(/no document selected/i)).toBeInTheDocument()
    // The workspace still loads its method list and the records list (D23) —
    // what must not happen is a processing call with no file to process.
    expect(processCalls(fetchMock)).toHaveLength(0)
  })

  it('never renders raw JSON, whatever the payload shape', async () => {
    await renderWorkspaceWithResult()

    await screen.findByLabelText(/^National ID/)
    const body = document.body.textContent ?? ''
    expect(body).not.toMatch(/[{}[\]]/)
  })

  it('navigates only after the document has been processed (§6 order)', async () => {
    const { fetchMock } = await renderWorkspaceWithResult()

    // Counted per-endpoint: the workspace also fetches the method list, so a
    // total-call assertion would pass or fail for the wrong reason.
    expect(processCalls(fetchMock)).toHaveLength(1)
    expect(
      await screen.findByRole('heading', { name: 'Verification workspace', level: 1 }),
    ).toBeInTheDocument()
    await waitFor(() => expect(screen.getByLabelText(/^National ID/)).toHaveValue('123456789'))
  })

  it('drops corrections when a different document is processed', async () => {
    // Stale edits are worse than none: a new card processed onto the previous
    // card's corrections would submit one person's names with another's face.
    const { default: userEvent } = await import('@testing-library/user-event')
    const fetchMock = stubProcessingFetch()
    const view = renderAt('/')

    const input = view.container.querySelector<HTMLInputElement>('input[type="file"]')!
    await waitFor(() => expect(input).toBeTruthy())
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(() => Promise.resolve({ width: 1280, height: 800, close: vi.fn() })),
    )

    await userEvent.upload(input, new File(['x'], 'card.jpg', { type: 'image/jpeg' }))
    await userEvent.click(await screen.findByRole('button', { name: /continue to verification/i }))

    await waitFor(() => expect(screen.getByLabelText(/^National ID/)).toHaveValue('123456789'))
    const nationalId = screen.getByLabelText(/^National ID/)
    await userEvent.clear(nationalId)
    await userEvent.type(nationalId, '999')
    expect(nationalId).toHaveValue('999')

    // Re-process the same document from the landing page.
    await userEvent.click(screen.getByRole('link', { name: /replace document/i }))
    await userEvent.upload(input, new File(['y'], 'card2.jpg', { type: 'image/jpeg' }))
    await userEvent.click(await screen.findByRole('button', { name: /continue to verification/i }))

    await waitFor(() => expect(processCalls(fetchMock)).toHaveLength(2))
    expect(await screen.findByLabelText(/^National ID/)).toHaveValue('123456789')
  })
})

describe('refresh survival (D21)', () => {
  it('restores the uploaded document and the captured face after a refresh', async () => {
    const result = makeProcessingResult()
    const fetchMock = stubProcessingFetch(result)
    // What a refresh leaves behind: the document in the store (D21) plus the
    // two small slices sessionStorage has always been able to hold.
    await saveStoredDocument({
      fileName: 'card.jpg',
      type: 'image/jpeg',
      width: 1280,
      height: 800,
      dataUrl: 'data:image/jpeg;base64,eA==',
    })
    setSessionSlice('processing', { state: 'ready', result, draft: {}, error: null })
    setSessionSlice('face', {
      state: 'ready',
      faceRef: 'art_99999999999999999999999999999999',
      captureStatus: 'detected',
      ownedBy: result.documentRef,
      error: null,
    })

    renderAt('/id-card')

    // The workspace comes back from the stored copy — no re-upload, no reprocess.
    expect(
      await screen.findByRole('heading', { name: 'Verification workspace', level: 1 }),
    ).toBeInTheDocument()
    expect(await screen.findByText('card.jpg')).toBeInTheDocument()
    expect(screen.queryByText(/no document selected/i)).not.toBeInTheDocument()
    expect(await screen.findByLabelText(/^National ID/)).toHaveValue('123456789')

    // Column 1 still shows the document from the earlier run's artefact…
    const preview = await screen.findByAltText(/original id card uploaded as card\.jpg/i)
    expect(preview).toHaveAttribute('src', `/api/v1/kyc/artifacts/${result.documentRef}`)

    // …and the method list loads from its own endpoint without the document
    // being processed a second time.
    const select = await screen.findByRole('combobox', { name: /verification method/i })
    expect(processCalls(fetchMock)).toHaveLength(0)

    // The captured face is still offered to a method that needs it.
    const { default: userEvent } = await import('@testing-library/user-event')
    await userEvent.selectOptions(select, 'verify_user_info_face')

    const face = await screen.findByAltText(/captured current face/i)
    expect(face).toHaveAttribute(
      'src',
      '/api/v1/kyc/artifacts/art_99999999999999999999999999999999',
    )
  })
})
describe('export (D17)', () => {
  it('sits beside Back to upload, disabled until a run produces a result', async () => {
    await renderWorkspaceWithResult()

    expect(screen.getByRole('link', { name: /back to upload/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Export' })).toBeDisabled()
  })

  it('opens the dialog with the verified data once verification finishes', async () => {
    const { default: userEvent } = await import('@testing-library/user-event')
    await renderWorkspaceWithResult()

    fireEvent.change(await screen.findByLabelText(/^Date of Birth/), {
      target: { value: '1994-02-11' },
    })
    const panel = await screen.findByRole('region', { name: /verification method/i })
    const verify = within(panel).getByRole('button', { name: 'Verify' })
    await waitFor(() => expect(verify).toBeEnabled())
    await userEvent.click(verify)

    const exportButton = screen.getByRole('button', { name: 'Export' })
    await waitFor(() => expect(exportButton).toBeEnabled())
    await userEvent.click(exportButton)

    const dialog = await screen.findByRole('dialog', { name: 'Export verified data' })
    expect(within(dialog).getByRole('table')).toBeInTheDocument()
    // The stub's result: nine values, nine statuses, method and overall status.
    expect(within(dialog).getAllByRole('checkbox')).toHaveLength(20)
    expect(within(dialog).getAllByRole('checkbox').every((box) => (box as HTMLInputElement).checked)).toBe(true)
  })
})

describe('uploaded records (D23)', () => {
  /** The workspace endpoints plus one pending row on the records list. */
  function stubRecordsWorkflow(record = makeUploadedRecord()) {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = urlOf(input)
      const ok = (body: unknown) =>
        Promise.resolve(
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        )
      if (url.includes('/api/v1/records/mappings')) return ok({ mapping: null })
      if (url.includes('/verification') && init?.method === 'POST') {
        const { verification } = bodyOf<{ verification: Record<string, unknown> }>([input, init])
        return ok({
          ...record,
          status: 'verified',
          verification: { ...verification, verifiedAt: 1759710000 },
          verifiedAt: 1759710000,
        })
      }
      if (url.includes('/api/v1/records')) return ok({ records: [record], total: 1 })
      if (url.includes('verification-methods')) return ok({ methods: VERIFICATION_METHODS })
      if (url.includes('/api/v1/kyc/verify')) return ok(makeVerifyResult())
      return ok(makeProcessingResult())
    })
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  it('Start fills the form from a row, with no document attached', async () => {
    stubRecordsWorkflow()
    renderAt('/id-card')

    fireEvent.click(await screen.findByRole('button', { name: 'Start' }))

    // The workspace appears around the record even though nothing was uploaded.
    expect(await screen.findByText(/Verifying an uploaded record/)).toBeInTheDocument()
    const form = await screen.findByRole('region', { name: /identity information/i })
    expect(within(form).getByText('Imported from the uploaded file.')).toBeInTheDocument()
    expect(screen.getByLabelText(/^National ID/)).toHaveValue('123456789')
    // Column 1 explains the absent document instead of hiding the workspace.
    expect(screen.getByText(/no document uploaded/i)).toBeInTheDocument()
    expect(screen.getByRole('region', { name: /verification method/i })).toBeInTheDocument()
  })

  it('verifies the started row and stores the run against it', async () => {
    const { default: userEvent } = await import('@testing-library/user-event')
    const fetchMock = stubRecordsWorkflow()
    renderAt('/id-card')

    fireEvent.click(await screen.findByRole('button', { name: 'Start' }))
    await screen.findByText(/Verifying an uploaded record/)

    const panel = await screen.findByRole('region', { name: /verification method/i })
    const verify = within(panel).getByRole('button', { name: 'Verify' })
    await waitFor(() => expect(verify).toBeEnabled())
    await userEvent.click(verify)

    // The row's Status cell flips without a reload (D23).
    await waitFor(() => {
      const rows = screen.getAllByRole('row')
      const active = rows.find((row) => row.getAttribute('aria-current') === 'true')
      expect(active).toBeDefined()
      expect(active).toHaveTextContent('Verified')
    })
    expect(
      fetchMock.mock.calls.some(
        (call) => urlOf(call[0]).includes('/records/rec_2f1c9a4b/verification'),
      ),
    ).toBe(true)
  })
})
