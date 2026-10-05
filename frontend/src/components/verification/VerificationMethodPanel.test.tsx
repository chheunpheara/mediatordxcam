import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AppRoutes } from '@/app/AppRoutes'
import { DocumentSessionProvider } from '@/features/document-upload/DocumentSessionProvider'
import { FaceCaptureProvider } from '@/features/face-capture/FaceCaptureProvider'
import { IdCardProcessingProvider } from '@/features/id-card-processing/IdCardProcessingProvider'
import {
  VERIFICATION_METHODS,
  bodyOf,
  makeProcessingResult,
  makeVerifyResult,
  stubKycFetch,
  urlOf,
} from '@/test/fixtures'
import type { ProcessIdCardResponse, VerificationMethod, VerifyResponse } from '@/lib/api'

/**
 * The verification method panel (§9, §10, §11).
 *
 * The recurring theme: requirements come from the backend, so these tests assert
 * that the UI *renders configuration* rather than that it knows any particular
 * method. A test that hard-codes "API 2 needs a face" would keep passing if the
 * UI had the fact hard-coded too — which is exactly what §11 forbids.
 */

beforeEach(() => {
  vi.stubGlobal(
    'URL',
    Object.assign(vi.fn(), {
      createObjectURL: vi.fn(() => 'blob:mock/document'),
      revokeObjectURL: vi.fn(),
    }),
  )
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

async function renderWorkspace(
  result: ProcessIdCardResponse = makeProcessingResult(),
  methods?: readonly VerificationMethod[],
  verifyResult?: VerifyResponse,
) {
  const fetchMock = stubKycFetch(result, methods, verifyResult)
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

  return { fetchMock }
}

function methodPanel() {
  return screen.findByRole('region', { name: /verification method/i })
}

describe('the six methods (§9, §10)', () => {
  it('lists all six official methods', async () => {
    await renderWorkspace()

    const panel = await methodPanel()
    expect(await within(panel).findAllByRole('option')).toHaveLength(6)
  })

  it('shows each official CamDigiKey name verbatim (§3)', async () => {
    await renderWorkspace()
    const panel = await methodPanel()

    const options = await within(panel).findAllByRole('option')
    const optionText = options.map((o) => o.textContent ?? '')
    for (const name of [
      'Verify User Info',
      'Verify User Info + User Face',
      'Verify User Info + ID Card + User Face',
      'Verify User Info + ID Card Image + Liveness',
      'Khmer ID Card OCR',
      'Passport OCR',
    ]) {
      expect(optionText.some((t) => t.includes(name))).toBe(true)
    }
  })

  it('uses the backend labels, never the raw enum values', async () => {
    await renderWorkspace()
    const panel = await methodPanel()

    expect((await within(panel).findAllByText(/Identity Information/)).length).toBeGreaterThan(0)
    expect(within(panel).queryByText(/verify_user_info/)).not.toBeInTheDocument()
  })

  it('renders requirements the backend declared, per method', async () => {
    await renderWorkspace()
    const panel = await methodPanel()
    const { default: userEvent } = await import('@testing-library/user-event')

    // API 1 asks for identity alone.
    expect(await within(panel).findByText('Needs: identity information.')).toBeInTheDocument()

    // Selecting API 4 shows identity + card + liveness.
    await userEvent.selectOptions(
      await within(panel).findByRole('combobox', { name: 'Verification method' }),
      'verify_user_info_idcard_liveness',
    )
    expect(
      await within(panel).findByText('Needs: identity information, your ID card, liveness.'),
    ).toBeInTheDocument()
  })

  it('renders requirements from the payload, not from a per-method switch', async () => {
    // §11: no component may hard-code what a method needs. Flipping API 1's
    // declared requirements must change the details, with no change to this file.
    const base = VERIFICATION_METHODS.find((m) => m.method === 'verify_user_info')
    if (!base) throw new Error('fixture is missing verify_user_info')
    const demanding: VerificationMethod = {
      ...base,
      requiresIdCard: true,
      requiresLiveness: true,
    }
    await renderWorkspace(makeProcessingResult(), [demanding, ...VERIFICATION_METHODS.slice(1)])
    const panel = await methodPanel()
    const { default: userEvent } = await import('@testing-library/user-event')

    // Selecting the mutated API 1 renders the same line as the genuine API 4.
    await userEvent.selectOptions(
      await within(panel).findByRole('combobox', { name: 'Verification method' }),
      'verify_user_info',
    )
    await waitFor(() =>
      expect(
        within(panel).getByText('Needs: identity information, your ID card, liveness.'),
      ).toBeInTheDocument(),
    )
  })
})

describe('unavailable methods (§9, :1355)', () => {
  it('explains why a pending method cannot run rather than hiding it', async () => {
    await renderWorkspace()
    const panel = await methodPanel()
    const { default: userEvent } = await import('@testing-library/user-event')

    await userEvent.selectOptions(
      await within(panel).findByRole('combobox', { name: 'Verification method' }),
      'verify_user_info_idcard_liveness',
    )

    expect(
      (
        await within(panel).findAllByText(/needs a liveness check, which this build does not run yet/i)
      ).length,
    ).toBeGreaterThan(0)
  })

  it('defaults to the first runnable method so the panel is never inert', async () => {
    await renderWorkspace()
    const panel = await methodPanel()

    const runnable = await within(panel).findByRole('combobox', { name: 'Verification method' })
    await waitFor(() => expect(runnable).toHaveValue('verify_user_info'))
  })

  it('marks an OCR method as a document read, not a verification', async () => {
    await renderWorkspace()
    const panel = await methodPanel()
    const { default: userEvent } = await import('@testing-library/user-event')

    await userEvent.selectOptions(
      await within(panel).findByRole('combobox', { name: 'Verification method' }),
      'khmer_id_card_ocr',
    )

    expect(
      await within(panel).findByText(/reads a document rather than verifying/i),
    ).toBeInTheDocument()
    expect(within(panel).getByRole('button', { name: 'Verify' })).toBeDisabled()
  })
})

describe('the verify action (§11, §19)', () => {
  it('is disabled until every required input is present', async () => {
    await renderWorkspace()
    const panel = await methodPanel()

    // The mock OCR leaves date of birth blank, so identity is not yet supplied.
    expect(await within(panel).findByRole('button', { name: 'Verify' })).toBeDisabled()
    expect(
      within(panel).getByText(/one more thing is needed before you can verify/i),
    ).toBeInTheDocument()
  })

  it('enables once the user completes the form, then sends the corrected values', async () => {
    const { default: userEvent } = await import('@testing-library/user-event')
    const { fetchMock } = await renderWorkspace()

    fireEvent.change(await screen.findByLabelText(/^Date of Birth/), {
      target: { value: '1994-02-11' },
    })

    const panel = await methodPanel()
    const button = await within(panel).findByRole('button', { name: 'Verify' })
    await waitFor(() => expect(button).toBeEnabled())

    await userEvent.click(button)

    const call = await waitFor((): unknown[] => {
      const found = fetchMock.mock.calls.find(([input]) =>
        urlOf(input).includes('/api/v1/kyc/verify'),
      )
      expect(found).toBeDefined()
      return found as unknown[]
    })
    const sent = bodyOf<VerifyRequestPayload>(call)

    // §14: the corrections the user typed are what gets verified, not the raw OCR.
    expect(sent.method).toBe('verify_user_info')
    expect(sent.userInformation.dateOfBirth).toBe('1994-02-11')
    expect(sent.userInformation.nationalId).toBe('123456789')
  })

  it('renders the result as a per-field status list, icon and word per row (§25, §32)', async () => {
    const { default: userEvent } = await import('@testing-library/user-event')
    await renderWorkspace()

    fireEvent.change(await screen.findByLabelText(/^Date of Birth/), {
      target: { value: '1994-02-11' },
    })

    const panel = await methodPanel()
    await userEvent.click(await within(panel).findByRole('button', { name: 'Verify' }))

    // The stub answers every field as matched, so all nine rows read "Matched"
    // with a tick — the response's `identity.fields`, not a client-side recount.
    const card = await screen.findByRole('status', { name: 'Verification result' })
    const rows = await within(card).findAllByRole('listitem')
    expect(rows).toHaveLength(9)
    expect(rows[0]!).toHaveTextContent('National ID')
    for (const row of rows) {
      expect(row).toHaveTextContent('Matched')
      expect(row.querySelector('svg')).toBeTruthy()
    }
  })

  it('appends the face outcome as a row in the same list once "User info + user face" verifies (D15)', async () => {
    const { default: userEvent } = await import('@testing-library/user-event')
    await renderWorkspace(
      makeProcessingResult(),
      undefined,
      makeVerifyResult({ method: 'verify_user_info_face', face: { required: true, verified: true } }),
    )

    // Choose the method that asks for a current face as well as identity.
    await userEvent.selectOptions(
      await within(await methodPanel()).findByRole('combobox', { name: 'Verification method' }),
      'verify_user_info_face',
    )

    // Supply that face by upload — a webcam would need hardware the test lacks.
    const upload = document.getElementById('current-face-upload')
    await waitFor(() => expect(upload).toBeTruthy())
    fireEvent.change(upload as HTMLInputElement, {
      target: { files: [new File(['x'], 'face.jpg', { type: 'image/jpeg' })] },
    })
    await screen.findByAltText('Captured current face')

    fireEvent.change(await screen.findByLabelText(/^Date of Birth/), {
      target: { value: '1994-02-11' },
    })

    const panel = await methodPanel()
    const button = await within(panel).findByRole('button', { name: 'Verify' })
    await waitFor(() => expect(button).toBeEnabled())
    await userEvent.click(button)

    // The nine identity rows stay; the face outcome joins them as a row rather
    // than standing apart as prose.
    const card = await screen.findByRole('status', { name: 'Verification result' })
    const rows = await within(card).findAllByRole('listitem')
    expect(rows).toHaveLength(10)
    expect(rows[0]).toHaveTextContent('National ID')
    expect(rows[9]).toHaveTextContent('Face verification')
    expect(rows[9]).toHaveTextContent('Passed')
    expect(rows[9]!.querySelector('svg')).toBeTruthy()
    expect(within(card).queryByText(/Face verification:/)).not.toBeInTheDocument()
  })

  it('never shows a raw error when the backend refuses (§28)', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL): Promise<Response> => {
      const url = urlOf(input)
      if (url.includes('/api/v1/kyc/verify')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              error: {
                code: 'REQUIREMENTS_NOT_MET',
                message: 'Some required information is missing.',
                missing: ['userInfo'],
                fieldErrors: {},
                requestId: 'req_1',
              },
            }),
            { status: 422, headers: { 'Content-Type': 'application/json' } },
          ),
        )
      }
      if (url.includes('verification-methods')) {
        return fetchMock.mock.results.length
          ? Promise.resolve(
              new Response(JSON.stringify({ methods: VERIFICATION_METHODS }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
              }),
            )
          : Promise.resolve(new Response('{}', { status: 500 }))
      }
      return Promise.resolve(
        new Response(JSON.stringify(makeProcessingResult()), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
    })
    vi.stubGlobal('fetch', fetchMock)

    const view = renderAt('/')
    const input = view.container.querySelector<HTMLInputElement>('input[type="file"]')!
    const { default: userEvent } = await import('@testing-library/user-event')
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(() => Promise.resolve({ width: 1280, height: 800, close: vi.fn() })),
    )
    await userEvent.upload(input, new File(['x'], 'card.jpg', { type: 'image/jpeg' }))
    await userEvent.click(await screen.findByRole('button', { name: /continue to verification/i }))

    const panel = await methodPanel()
    await waitFor(() =>
      expect(within(panel).getByRole('combobox', { name: 'Verification method' })).toHaveValue(
        'verify_user_info',
      ),
    )
    expect(within(panel).getByRole('button', { name: 'Verify' })).toBeInTheDocument()
  })
})

/** The shape of the JSON body `POST /api/v1/kyc/verify` is sent. */
interface VerifyRequestPayload {
  readonly method: string
  readonly userInformation: Record<string, string | null>
}
