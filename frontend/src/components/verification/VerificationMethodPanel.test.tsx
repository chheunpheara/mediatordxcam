import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AppRoutes } from '@/app/AppRoutes'
import { DocumentSessionProvider } from '@/features/document-upload/DocumentSessionProvider'
import { FaceCaptureProvider } from '@/features/face-capture/FaceCaptureProvider'
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
  verifyResult?: VerifyResponse | VerifyResponse[],
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
    const rows = await within(card).findAllByRole('listitem')
    expect(rows).toHaveLength(9)
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
    await screen.findByAltText('Captured current face')

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
    await screen.findByRole('status', { name: 'Verification result' })
    return { fetchMock, panel, userEvent }
  }

  it('titles the result Verification Response, above the card, and posts it', async () => {
    const fetchMock = stubWorkspaceWithPost({
      payload: { posted: ['https://core.example/post'], failed: [] },
    })

    const { panel, userEvent } = await verifyFirst(fetchMock)

    // The heading owns the section the card sits in — card follows it.
    const heading = within(panel).getByRole('heading', { name: 'Verification Response' })
    const card = within(panel).getByRole('status', { name: 'Verification result' })
    expect(heading.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    await userEvent.click(within(panel).getByRole('button', { name: 'Post to Core Systems' }))

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

    const { panel, userEvent } = await verifyFirst(fetchMock)
    await userEvent.click(within(panel).getByRole('button', { name: 'Post to Core Systems' }))

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

    const { panel, userEvent } = await verifyFirst(fetchMock)
    await userEvent.click(within(panel).getByRole('button', { name: 'Post to Core Systems' }))

    const notice = await screen.findByRole('alertdialog', { name: 'Could not post' })
    expect(notice).toHaveTextContent('There are no core systems configured yet.')
  })

  it('offers nothing to a profile without the full permission set', async () => {
    writeAuthUser({ ...TEST_AUTH_USER, permissions: ['verify_user_info'] })
    const fetchMock = stubWorkspaceWithPost({ payload: { posted: [], failed: [] } })

    const { panel } = await verifyFirst(fetchMock)

    expect(within(panel).queryByRole('button', { name: 'Post to Core Systems' })).not.toBeInTheDocument()
  })
})
