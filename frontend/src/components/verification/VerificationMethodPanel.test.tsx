import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AppRoutes } from '@/app/AppRoutes'
import { DocumentSessionProvider } from '@/features/document-upload/DocumentSessionProvider'
import { FaceCaptureProvider } from '@/features/face-capture/FaceCaptureProvider'
import { LivenessProvider } from '@/features/liveness/LivenessProvider'
import { IdCardProcessingProvider } from '@/features/id-card-processing/IdCardProcessingProvider'
import { writeAuthUser } from '@/lib/auth'
import {
  TEST_AUTH_USER,
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
            <LivenessProvider>
              <AppRoutes />
            </LivenessProvider>
          </FaceCaptureProvider>
        </IdCardProcessingProvider>
      </DocumentSessionProvider>
    </MemoryRouter>,
  )
}

async function renderWorkspace(
  result: ProcessIdCardResponse = makeProcessingResult(),
  methods?: readonly VerificationMethod[],
  verifyResult?: VerifyResponse | VerifyResponse[],
  livenessPage?: { readonly enabled: boolean; readonly sessionId: string },
) {
  const fetchMock = stubKycFetch(result, methods, verifyResult, livenessPage)
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

  it('renders the liveness capture only when its method is selected', async () => {
    await renderWorkspace()
    const panel = await methodPanel()
    const { default: userEvent } = await import('@testing-library/user-event')

    // No method yet: the camera UI never appears, even in an API-4 world.
    expect(within(panel).queryByRole('button', { name: 'Enable Webcam' })).toBeNull()

    // Selecting another method does not introduce the camera UI.
    await userEvent.selectOptions(
      await within(panel).findByRole('combobox', { name: 'Verification method' }),
      'verify_user_info',
    )
    expect(within(panel).queryByRole('button', { name: 'Enable Webcam' })).toBeNull()

    // API 4 demands liveness, and only then does the remote panel render.
    await userEvent.selectOptions(
      within(panel).getByRole('combobox', { name: 'Verification method' }),
      'verify_user_info_idcard_liveness',
    )
    expect(
      await within(panel).findByText(/No fixed customer display is enabled yet/i),
    ).toBeInTheDocument()
  })

  it('offers the customer display camera when the method needs the current face', async () => {
    await renderWorkspace()
    const panel = await methodPanel()
    const { default: userEvent } = await import('@testing-library/user-event')

    // A method that never mentions the customer's face never mentions the
    // customer display either — the feed is a rendering of the requirements.
    expect(within(panel).queryByText(/No fixed customer display is enabled yet/i)).toBeNull()

    await userEvent.selectOptions(
      await within(panel).findByRole('combobox', { name: 'Verification method' }),
      'verify_user_info_face',
    )

    expect(
      await within(panel).findByText(/No fixed customer display is enabled yet/i),
    ).toBeInTheDocument()
    // The teller's own camera and upload stay exactly where they were.
    expect(within(panel).getByRole('button', { name: 'Use camera' })).toBeInTheDocument()
    expect(within(panel).getByRole('button', { name: 'Upload photo' })).toBeInTheDocument()
  })

  it('keeps the face camera off the screen when the method wants liveness instead', async () => {
    await renderWorkspace()
    const panel = await methodPanel()
    const { default: userEvent } = await import('@testing-library/user-event')

    await userEvent.selectOptions(
      await within(panel).findByRole('combobox', { name: 'Verification method' }),
      'verify_user_info_idcard_liveness',
    )

    expect(
      await within(panel).findByText(/No fixed customer display is enabled yet/i),
    ).toBeInTheDocument()
    expect(within(panel).queryByRole('button', { name: 'Use camera' })).toBeNull()
    expect(within(panel).queryByRole('button', { name: 'Take photo' })).toBeNull()
  })
})

describe('unavailable methods (§9)', () => {
  it('explains why a pending method cannot run rather than hiding it', async () => {
    await renderWorkspace()
    const panel = await methodPanel()
    const { default: userEvent } = await import('@testing-library/user-event')

    // The one method still unavailable now that Phase 7 landed: passport OCR.
    // API 4 used to be the subject here, and moved to the runnable side with
    // the phase, which `lists all six official methods` still covers either way.
    await userEvent.selectOptions(
      await within(panel).findByRole('combobox', { name: 'Verification method' }),
      'passport_ocr',
    )

    expect(
      (
        await within(panel).findAllByText(/needs a passport image, which this build does not read yet/i)
      ).length,
    ).toBeGreaterThan(0)
    expect(within(panel).getByRole('button', { name: 'Verify' })).toBeDisabled()
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
    expect(await within(panel).findByRole('button', { name: 'Verify' })).toBeInTheDocument()
    // The sentence is rendered from the fetched method list, so it may land
    // after the button does.
    expect(
      await within(panel).findByText(/one more thing is needed before you can verify/i),
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
    // The list appends a row at a time, so it is complete only once it says so.
    await waitFor(() => expect(within(card).getAllByRole('listitem')).toHaveLength(9))
    const rows = within(card).getAllByRole('listitem')
    expect(rows[0]!).toHaveTextContent('National ID')
    for (const row of rows) {
      expect(row).toHaveTextContent('Matched')
      expect(row.querySelector('svg')).toBeTruthy()
    }
  })

  it('grows the same list when the face method verifies after "Verify User Info" (D16)', async () => {
    const { default: userEvent } = await import('@testing-library/user-event')
    await renderWorkspace(makeProcessingResult(), undefined, [
      makeVerifyResult(),
      makeVerifyResult({ method: 'verify_user_info_face', face: { required: true, verified: true } }),
    ])

    // First run: the default "Verify User Info" — nine identity rows.
    fireEvent.change(await screen.findByLabelText(/^Date of Birth/), {
      target: { value: '1994-02-11' },
    })
    const panel = await methodPanel()
    const button = await within(panel).findByRole('button', { name: 'Verify' })
    await waitFor(() => expect(button).toBeEnabled())
    await userEvent.click(button)

    const card = await screen.findByRole('status', { name: 'Verification result' })
    await waitFor(() => expect(within(card).getAllByRole('listitem')).toHaveLength(9))

    // Second run: choose the face method, supply its face, verify again. The
    // identity rows stay in the same list; the face outcome appends beneath.
    await userEvent.selectOptions(
      await within(panel).findByRole('combobox', { name: 'Verification method' }),
      'verify_user_info_face',
    )
    const upload = document.getElementById('current-face-upload')
    await waitFor(() => expect(upload).toBeTruthy())
    fireEvent.change(upload as HTMLInputElement, {
      target: { files: [new File(['x'], 'face.jpg', { type: 'image/jpeg' })] },
    })
    // The photo landed, and the dialog's first column shows it exactly once:
    // as the art. Its capture panel keeps the controls, not a second copy.
    await screen.findByAltText('Your live photo')
    expect(screen.queryByAltText('Captured current face')).toBeNull()

    const retry = await within(panel).findByRole('button', { name: 'Verify' })
    await waitFor(() => expect(retry).toBeEnabled())
    await userEvent.click(retry)

    // Nine shared identity rows plus the appended face row — not a new list.
    await waitFor(() => expect(within(card).getAllByRole('listitem')).toHaveLength(10))
    const rows = within(card).getAllByRole('listitem')
    expect(rows[0]).toHaveTextContent('National ID')
    expect(rows[0]).toHaveTextContent('Matched')
    expect(rows[9]).toHaveTextContent('Face verification')
    expect(rows[9]!).toHaveTextContent('Passed')
    expect(rows[9]!.querySelector('svg')).toBeTruthy()
    expect(within(card).queryByText(/Face verification:/)).not.toBeInTheDocument()
  })

  it('keeps the previous result on screen when a later verify is refused (§28, D16)', async () => {
    const { default: userEvent } = await import('@testing-library/user-event')

    let verifyCalls = 0
    const fetchMock = vi.fn((input: RequestInfo | URL): Promise<Response> => {
      const url = urlOf(input)
      const ok = (body: unknown) =>
        Promise.resolve(
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        )
      if (url.includes('/api/v1/kyc/verify')) {
        verifyCalls += 1
        if (verifyCalls > 1) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                error: {
                  code: 'REQUIREMENTS_NOT_MET',
                  message: 'Some required information is missing.',
                  missing: ['currentFace'],
                  fieldErrors: {},
                  requestId: 'req_2',
                },
              }),
              { status: 422, headers: { 'Content-Type': 'application/json' } },
            ),
          )
        }
        return ok(makeVerifyResult())
      }
      if (url.includes('verification-methods')) return ok({ methods: VERIFICATION_METHODS })
      if (url.includes('/api/v1/records')) return ok({ records: [], total: 0 })
      return ok(makeProcessingResult())
    })
    vi.stubGlobal('fetch', fetchMock)

    const view = renderAt('/')
    const input = view.container.querySelector<HTMLInputElement>('input[type="file"]')!
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(() => Promise.resolve({ width: 1280, height: 800, close: vi.fn() })),
    )
    await userEvent.upload(input, new File(['x'], 'card.jpg', { type: 'image/jpeg' }))
    await userEvent.click(await screen.findByRole('button', { name: /continue to verification/i }))

    fireEvent.change(await screen.findByLabelText(/^Date of Birth/), {
      target: { value: '1994-02-11' },
    })
    const panel = await methodPanel()
    const button = await within(panel).findByRole('button', { name: 'Verify' })
    await waitFor(() => expect(button).toBeEnabled())
    await userEvent.click(button)

    const card = await screen.findByRole('status', { name: 'Verification result' })
    await waitFor(() => expect(within(card).getAllByRole('listitem')).toHaveLength(9))

    // The retry is refused — the list from the first run must survive it.
    await userEvent.click(await within(panel).findByRole('button', { name: 'Verify' }))
    expect(await within(panel).findByRole('alert')).toHaveTextContent(
      'Some required information is missing.',
    )
    expect(within(card).getAllByRole('listitem')).toHaveLength(9)
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
      if (url.includes('/api/v1/records')) {
        return Promise.resolve(
          new Response(JSON.stringify({ records: [], total: 0 }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        )
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

/**
 * The relay, driven by the test: jsdom has no WebSocket, and the teller
 * screen only renders its controls once the customer display answers. Every
 * frame sent is recorded so a test can prove the dialog's copy is the one
 * talking to the customer's tab.
 */
class TestWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly sent: string[] = []
  /** The socket the last component opened, so a test can answer it. */
  static current: TestWebSocket | null = null
  onopen: (() => void) | null = null
  onmessage: ((event: { readonly data: string }) => void) | null = null
  readyState = TestWebSocket.CONNECTING

  constructor(_url: string) {
    TestWebSocket.current = this
    setTimeout(() => {
      this.readyState = TestWebSocket.OPEN
      this.onopen?.()
    }, 0)
  }

  send(raw: string) {
    TestWebSocket.sent.push(raw)
  }

  close() {
    this.readyState = -1 // CLOSED
  }

  /** The relay handing an envelope back to the teller tab. */
  emit(envelope: unknown) {
    this.onmessage?.({ data: JSON.stringify(envelope) })
  }
}

describe('the report dialog (§24)', () => {
  /** The workspace with the identity form filled and Verify pressed. */
  async function openReport(
    verifyResult?: VerifyResponse | VerifyResponse[],
    customerDisplay = false,
  ) {
    const { default: userEvent } = await import('@testing-library/user-event')
    const { fetchMock } = await renderWorkspace(
      makeProcessingResult(),
      undefined,
      verifyResult,
      customerDisplay ? { enabled: true, sessionId: 'sess_test_1' } : undefined,
    )

    fireEvent.change(await screen.findByLabelText(/^Date of Birth/), {
      target: { value: '1994-02-11' },
    })
    const panel = await methodPanel()
    const button = await within(panel).findByRole('button', { name: 'Verify' })
    await waitFor(() => expect(button).toBeEnabled())
    await userEvent.click(button)

    const report = await screen.findByRole('dialog', { name: 'Verification' })
    return { fetchMock, panel, report, userEvent }
  }

  /** How many runs the dialog has sent. */
  function verifyCalls(fetchMock: ReturnType<typeof vi.fn>): number {
    return fetchMock.mock.calls.filter(([input]) => urlOf(input).includes('/api/v1/kyc/verify'))
      .length
  }

  it('takes the method choice itself, and the panel follows it', async () => {
    const { panel, report, userEvent } = await openReport()

    const dialogSelect = within(report).getByRole('combobox', { name: 'Verification method' })
    expect(dialogSelect).toHaveValue('verify_user_info')

    await userEvent.selectOptions(dialogSelect, 'khmer_id_card_ocr')

    // One provider, two copies of the control: they cannot disagree.
    expect(within(panel).getByRole('combobox', { name: 'Verification method' })).toHaveValue(
      'khmer_id_card_ocr',
    )
    // The sentence saying the choice cannot run comes along with it…
    expect(
      within(report).getByText(/reads a document rather than verifying/i),
    ).toBeInTheDocument()
    // …and so does the disabled footer button it explains.
    expect(within(report).getByRole('button', { name: 'Verify' })).toBeDisabled()
  })

  it('starts a run from the dialog without leaving it', async () => {
    const { fetchMock, report, userEvent } = await openReport()
    await within(report).findByRole('status', { name: 'Verification result' })
    expect(verifyCalls(fetchMock)).toBe(1)

    await userEvent.click(within(report).getByRole('button', { name: 'Verify' }))

    await waitFor(() => expect(verifyCalls(fetchMock)).toBe(2))
    expect(
      await within(report).findByRole('status', { name: 'Verification result' }),
    ).toBeInTheDocument()
    // The report never went anywhere: still the one dialog, still open.
    expect(screen.getAllByRole('dialog', { name: 'Verification' })).toHaveLength(1)
  })

  it('hands the customer display to the first column, so a photo is taken from here', async () => {
    vi.stubGlobal('WebSocket', TestWebSocket)
    TestWebSocket.sent.length = 0
    const { panel, report, userEvent } = await openReport(undefined, true)

    // The dialog's own selector picks the method whose picture column shows.
    await userEvent.selectOptions(
      within(report).getByRole('combobox', { name: 'Verification method' }),
      'verify_user_info_face',
    )

    const preview = await within(report).findByRole('region', { name: 'Preview' })
    const camera = await within(preview).findByRole('region', { name: 'Customer camera' })
    expect(within(camera).getByRole('button', { name: 'Take photo' })).toBeInTheDocument()
    // The upload the panel used to own moved with it — one copy in the
    // document, and it sits inside the dialog the teller is looking at.
    expect(within(panel).queryByRole('region', { name: 'Customer camera' })).toBeNull()
    const uploads = document.querySelectorAll('#current-face-upload')
    expect(uploads).toHaveLength(1)
    expect(preview.contains(uploads[0]!)).toBe(true)

    // …and it is a live copy: the customer's camera was asked to open.
    await waitFor(() =>
      expect(TestWebSocket.sent.some((raw) => raw.includes('activateFaceCapture'))).toBe(true),
    )
  })

  it('starts the liveness check from the dialog, without the panel holding a second one', async () => {
    vi.stubGlobal('WebSocket', TestWebSocket)
    TestWebSocket.sent.length = 0
    const { panel, report, userEvent } = await openReport(undefined, true)

    await userEvent.selectOptions(
      within(report).getByRole('combobox', { name: 'Verification method' }),
      'verify_user_info_idcard_liveness',
    )

    const preview = await within(report).findByRole('region', { name: 'Preview' })
    expect(
      await within(preview).findByRole('button', { name: 'Start liveness check' }),
    ).toBeInTheDocument()
    expect(within(panel).queryByRole('button', { name: 'Start liveness check' })).toBeNull()
    expect(within(panel).queryByText(/No fixed customer display is enabled yet/i)).toBeNull()

    await waitFor(() =>
      expect(TestWebSocket.sent.some((raw) => raw.includes('activateLiveness'))).toBe(true),
    )
  })

  it('shows the photo once: the art owns the pixels, the capture keeps the controls', async () => {
    vi.stubGlobal('WebSocket', TestWebSocket)
    TestWebSocket.sent.length = 0
    const { report, userEvent } = await openReport(undefined, true)

    await userEvent.selectOptions(
      within(report).getByRole('combobox', { name: 'Verification method' }),
      'verify_user_info_face',
    )
    const preview = await within(report).findByRole('region', { name: 'Preview' })

    const upload = document.getElementById('current-face-upload')
    await waitFor(() => expect(upload).toBeTruthy())
    fireEvent.change(upload as HTMLInputElement, {
      target: { files: [new File(['x'], 'face.jpg', { type: 'image/jpeg' })] },
    })

    // Retake still says the capture is there…
    await within(preview).findByRole('button', { name: 'Retake' })
    // …but the picture itself is on screen once, not twice.
    expect(within(preview).getAllByAltText('Your live photo')).toHaveLength(1)
    expect(within(preview).queryByAltText('Captured current face')).toBeNull()
  })

  it('shows the recording once: the art frames it, the feed keeps Re-record', async () => {
    vi.stubGlobal('WebSocket', TestWebSocket)
    TestWebSocket.sent.length = 0
    const { report, userEvent } = await openReport(undefined, true)

    await userEvent.selectOptions(
      within(report).getByRole('combobox', { name: 'Verification method' }),
      'verify_user_info_idcard_liveness',
    )
    const preview = await within(report).findByRole('region', { name: 'Preview' })

    await userEvent.click(
      await within(preview).findByRole('button', { name: 'Start liveness check' }),
    )
    await waitFor(() =>
      expect(TestWebSocket.sent.some((raw) => raw.includes('startRecording'))).toBe(true),
    )

    // The customer's tab answers the way it really does: two envelopes.
    const socket = TestWebSocket.current!
    socket.emit({ type: 'recordingStarted' })
    socket.emit({ type: 'recordingFinished', livenessRef: 'art_0a1b2c3d4e5f60718293a4b5c6d7e8f9' })

    await within(preview).findByRole('button', { name: 'Re-record' })
    expect(within(preview).getByText('A liveness video was recorded.')).toBeInTheDocument()
    // One player, not two: the art's. (jsdom exposes no `video` role, so this
    // counts the elements the dialog's column actually renders.)
    expect(within(preview).getAllByLabelText('Liveness recording')).toHaveLength(1)
    expect(preview.querySelectorAll('video')).toHaveLength(1)
  })

  it('opens a large dialog on Verify and moves the report into it', async () => {
    const { panel, report } = await openReport()

    const card = await within(report).findByRole('status', { name: 'Verification result' })
    expect(within(report).getByRole('heading', { name: 'Verification Response' })).toBeInTheDocument()
    // The panel is left with its own summary, not with the list the dialog holds.
    expect(within(panel).queryByRole('status', { name: 'Verification result' })).toBeNull()
    expect(within(panel).getByRole('button', { name: 'Open report' })).toBeInTheDocument()
    // This method was given no picture, so there is one column, not two.
    expect(within(report).queryByRole('region', { name: 'Preview' })).toBeNull()
    expect(card).toBeInTheDocument()
  })

  it('appends the rows a step at a time and only then offers the footer actions', async () => {
    const { report } = await openReport()
    const card = await within(report).findByRole('status', { name: 'Verification result' })

    // Nothing may be posted from a report that has not finished arriving.
    expect(within(report).queryByRole('button', { name: 'Post to Core Systems' })).toBeNull()

    await waitFor(() => {
      const shown = within(card).getAllByRole('listitem')
      expect(shown.length).toBeGreaterThan(0)
      expect(shown.length).toBeLessThan(9)
    })
    await waitFor(() => expect(within(card).getAllByRole('listitem')).toHaveLength(9))
    expect(
      await within(report).findByRole('button', { name: 'Post to Core Systems' }),
    ).toBeInTheDocument()
  })

  it('gives a photo method the preview column beside the field list', async () => {
    const { default: userEvent } = await import('@testing-library/user-event')
    await renderWorkspace()

    fireEvent.change(await screen.findByLabelText(/^Date of Birth/), {
      target: { value: '1994-02-11' },
    })
    const panel = await methodPanel()
    await userEvent.selectOptions(
      await within(panel).findByRole('combobox', { name: 'Verification method' }),
      'verify_user_info_face',
    )
    const upload = document.getElementById('current-face-upload')
    await waitFor(() => expect(upload).toBeTruthy())
    fireEvent.change(upload as HTMLInputElement, {
      target: { files: [new File(['x'], 'face.jpg', { type: 'image/jpeg' })] },
    })
    await screen.findByAltText('Captured current face')

    const button = await within(panel).findByRole('button', { name: 'Verify' })
    await waitFor(() => expect(button).toBeEnabled())
    await userEvent.click(button)

    const report = await screen.findByRole('dialog', { name: 'Verification' })
    // Two columns: the picture it was given first, the field list beside it.
    const preview = await within(report).findByRole('region', { name: 'Preview' })
    expect(within(preview).getByAltText('Your live photo')).toBeInTheDocument()
    expect(
      await within(report).findByRole('status', { name: 'Verification result' }),
    ).toBeInTheDocument()
  })

  it('pulses a field that did not match, beside the cross and the word (§32)', async () => {
    const base = makeVerifyResult()
    const mismatched = makeVerifyResult({
      status: 'partial',
      identity: {
        ...base.identity,
        matchedCount: 8,
        incorrectFields: ['nationalId'],
        fields: base.identity.fields.map((field) =>
          field.field === 'nationalId' ? { ...field, status: 'mismatch' as const } : field,
        ),
      },
    })

    const { report } = await openReport(mismatched)
    const card = await within(report).findByRole('status', { name: 'Verification result' })
    await waitFor(() => expect(within(card).getAllByRole('listitem')).toHaveLength(9))

    const first = within(card).getAllByRole('listitem')[0]!
    expect(first).toHaveTextContent('National ID')
    expect(first).toHaveTextContent('Mismatched')
    expect(first.className).toContain('verify-row--attention')
  })
})

describe('posting the response to core systems (D19)', () => {
  interface PostRoute {
    readonly payload: unknown
    readonly status?: number
  }

  /** The workspace with one route added: the integrations post endpoint. */
  function stubWorkspaceWithPost(post: PostRoute) {
    const fetchMock = vi.fn((input: RequestInfo | URL): Promise<Response> => {
      const url = urlOf(input)
      const ok = (body: unknown, status = 200) =>
        Promise.resolve(
          new Response(JSON.stringify(body), {
            status,
            headers: { 'Content-Type': 'application/json' },
          }),
        )
      if (url.includes('/api/v1/integrations/post')) return ok(post.payload, post.status ?? 200)
      if (url.includes('verification-methods')) return ok({ methods: VERIFICATION_METHODS })
      if (url.includes('/api/v1/kyc/verify')) return ok(makeVerifyResult())
      if (url.includes('/api/v1/records')) return ok({ records: [], total: 0 })
      return ok(makeProcessingResult())
    })
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  async function verifyFirst(fetchMock: ReturnType<typeof vi.fn>) {
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

    fireEvent.change(await screen.findByLabelText(/^Date of Birth/), {
      target: { value: '1994-02-11' },
    })
    const panel = await methodPanel()
    const verify = await within(panel).findByRole('button', { name: 'Verify' })
    await waitFor(() => expect(verify).toBeEnabled())
    await userEvent.click(verify)
    const card = await screen.findByRole('status', { name: 'Verification result' })
    const report = await screen.findByRole('dialog', { name: 'Verification' })
    return { fetchMock, panel, report, card, userEvent }
  }

  it('titles the result Verification Response, above the card, and posts it', async () => {
    const fetchMock = stubWorkspaceWithPost({
      payload: { posted: ['https://core.example/post'], failed: [] },
    })

    const { report, userEvent } = await verifyFirst(fetchMock)

    // The heading owns the section the card sits in — card follows it.
    const heading = within(report).getByRole('heading', { name: 'Verification Response' })
    const card = within(report).getByRole('status', { name: 'Verification result' })
    expect(heading.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    // The button lives in the dialog's footer, and only once the run answered.
    const post = await within(report).findByRole('button', { name: 'Post to Core Systems' })
    await userEvent.click(post)

    const notice = await screen.findByRole('alertdialog', { name: 'Posted' })
    expect(notice).toHaveTextContent('Sent to 1 core system.')
    expect(notice).toHaveTextContent('https://core.example/post')

    // The current result went as the payload — the card's own outcome.
    const call = fetchMock.mock.calls.find(([input]) =>
      urlOf(input).includes('/api/v1/integrations/post'),
    )
    expect(call).toBeDefined()
    expect(bodyOf<{ payload: { status: string; method: string } }>(call!)).toMatchObject({
      payload: { status: 'success', method: 'verify_user_info' },
    })

    await userEvent.click(screen.getByRole('button', { name: 'OK' }))
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })

  it('names a system that refused the post with the safe reason', async () => {
    const fetchMock = stubWorkspaceWithPost({
      payload: {
        posted: [],
        failed: [
          { url: 'https://other.example/post', reason: 'The system refused the API credentials.' },
        ],
      },
    })

    const { report, userEvent } = await verifyFirst(fetchMock)
    await userEvent.click(await within(report).findByRole('button', { name: 'Post to Core Systems' }))

    const notice = await screen.findByRole('alertdialog', { name: 'Posted with problems' })
    expect(notice).toHaveTextContent('1 did not accept it.')
    expect(notice).toHaveTextContent('The system refused the API credentials.')
  })

  it('shows the server sentence when nothing is configured', async () => {
    const fetchMock = stubWorkspaceWithPost({
      payload: {
        error: {
          code: 'INVALID_REQUEST',
          message: 'There are no core systems configured yet. Add one in Post Settings first.',
          fieldErrors: {},
          requestId: 'req_5',
        },
      },
      status: 400,
    })

    const { report, userEvent } = await verifyFirst(fetchMock)
    await userEvent.click(await within(report).findByRole('button', { name: 'Post to Core Systems' }))

    const notice = await screen.findByRole('alertdialog', { name: 'Could not post' })
    expect(notice).toHaveTextContent('There are no core systems configured yet.')
  })

  it('offers nothing to a profile without the full permission set', async () => {
    writeAuthUser({ ...TEST_AUTH_USER, permissions: ['verify_user_info'] })
    const fetchMock = stubWorkspaceWithPost({ payload: { posted: [], failed: [] } })

    const { panel, report } = await verifyFirst(fetchMock)

    // Neither place the button could sit — the panel it used to live in, and
    // the dialog footer it now waits in — offers it.
    expect(within(panel).queryByRole('button', { name: 'Post to Core Systems' })).not.toBeInTheDocument()
    expect(within(report).queryByRole('button', { name: 'Post to Core Systems' })).not.toBeInTheDocument()
  })
})
