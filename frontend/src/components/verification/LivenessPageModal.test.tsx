import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { LivenessPageModal } from './LivenessPageModal'
import { writeAuthUser } from '../../lib/auth'
import { TEST_AUTH_USER, bodyOf, makeLivenessLink } from '../../test/fixtures'

/**
 * The links dialog: mint one for a named customer, read the URL off it, and
 * keep every past link visible under that customer — expired ones included,
 * because a returning customer is found by name, not by remembering which
 * URL worked yesterday.
 *
 * The dialog decides nothing by itself: expiry, ownership and the
 * one-usable-link rule are the server's. These tests therefore assert the
 * requests it sends and the status words it prints back.
 */

const OWN_LIST: Route = { payload: { links: [makeLivenessLink()] } }
const EXPIRED_LINK = makeLivenessLink({
  id: 'lnk_expired',
  token: 'sess_old_1',
  status: 'expired',
  expiresAt: '2026-10-01T09:00:00Z',
})

interface Route {
  readonly payload: unknown
  readonly status?: number
}

/** Stub the list (GET) and mint (POST) routes; URLs decide the list payload. */
function stubRoutes(
  routes: {
    readonly list?: Route
    readonly listAll?: Route
    readonly create?: Route
  } = {},
) {
  const list = routes.list ?? OWN_LIST
  const mock = vi.fn((input: string, init?: RequestInit) => {
    const route =
      init?.method === 'POST'
        ? routes.create
        : String(input).includes('scope=all')
          ? (routes.listAll ?? list)
          : list
    if (!route) throw new Error('unexpected POST')
    return Promise.resolve(
      new Response(JSON.stringify(route.payload), {
        status: route.status ?? 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
  })
  vi.stubGlobal('fetch', mock)
  return mock
}

beforeEach(() => {
  writeAuthUser(TEST_AUTH_USER)
})

afterEach(() => {
  vi.unstubAllGlobals()
  writeAuthUser(TEST_AUTH_USER)
})

describe('LivenessPageModal', () => {
  it('shows the open link URL in a labelled dialog, focus on Close', async () => {
    stubRoutes()
    render(<LivenessPageModal onClose={vi.fn()} />)
    await screen.findByLabelText('Display URL')

    const dialog = screen.getByRole('dialog', { name: 'Liveness links' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    const url = screen.getByLabelText<HTMLInputElement>('Display URL')
    expect(url.readOnly).toBe(true)
    expect(url.value).toContain('/display?session=sess_fixed_1')
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }))
  })

  it('mints a link with the chosen preset and shows the new URL', async () => {
    const fetchMock = stubRoutes({
      create: {
        payload: {
          link: makeLivenessLink({ id: 'lnk_new', token: 'sess_new_1', status: 'in_use' }),
          supersededPrevious: true,
        },
      },
    })
    render(<LivenessPageModal onClose={vi.fn()} />)
    await screen.findByLabelText('Display URL')

    fireEvent.change(screen.getByLabelText('Customer'), { target: { value: 'Chhorn Sreyneang' } })
    fireEvent.click(screen.getByRole('button', { name: '1 hour' }))
    fireEvent.click(screen.getByRole('button', { name: 'Create link' }))

    await waitFor(() =>
      expect(screen.getByLabelText<HTMLInputElement>('Display URL').value).toContain(
        '/display?session=sess_new_1',
      ),
    )
    const postCall = fetchMock.mock.calls.find((call) => call[1]?.method === 'POST')
    expect(postCall).toBeDefined()
    expect(bodyOf<{ customer: string; durationSeconds: number }>(postCall!)).toEqual({
      customer: 'Chhorn Sreyneang',
      durationSeconds: 3_600,
    })
    expect(screen.getByLabelText('Customer')).toHaveValue('')
    expect(await screen.findByText(/previous link has been stopped/i)).toBeInTheDocument()
  })

  it('refuses to mint without a customer label', async () => {
    const fetchMock = stubRoutes()
    render(<LivenessPageModal onClose={vi.fn()} />)
    await screen.findByLabelText('Display URL')

    fireEvent.click(screen.getByRole('button', { name: 'Create link' }))

    expect(await screen.findByText('Enter the customer this link is for.')).toBeInTheDocument()
    expect(fetchMock.mock.calls.some((call) => call[1]?.method === 'POST')).toBe(false)
  })

  it('sends an absolute expiry for a custom one, and refuses a past time', async () => {
    const fetchMock = stubRoutes({
      create: { payload: { link: makeLivenessLink({ token: 'sess_c_1' }), supersededPrevious: false } },
    })
    render(<LivenessPageModal onClose={vi.fn()} />)
    await screen.findByLabelText('Display URL')

    fireEvent.change(screen.getByLabelText('Customer'), { target: { value: 'Oum Srey' } })
    fireEvent.click(screen.getByRole('radio', { name: 'Custom' }))
    const expiry = screen.getByLabelText('Expiry date and time')

    fireEvent.change(expiry, { target: { value: '2020-01-01T10:00' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create link' }))
    expect(await screen.findByText('Choose a future expiry time.')).toBeInTheDocument()
    expect(fetchMock.mock.calls.some((call) => call[1]?.method === 'POST')).toBe(false)

    fireEvent.change(expiry, { target: { value: '2030-01-01T10:00' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create link' }))

    const postCall = await waitFor(() => {
      const call = fetchMock.mock.calls.find((entry) => entry[1]?.method === 'POST')
      expect(call).toBeDefined()
      return call!
    })
    expect(bodyOf<{ customer: string; expiresAt: string }>(postCall)).toEqual({
      customer: 'Oum Srey',
      expiresAt: new Date('2030-01-01T10:00').toISOString(),
    })
  })

  it('keeps the dialog open and reports the server sentence when a mint is refused', async () => {
    stubRoutes({
      create: {
        payload: {
          error: {
            code: 'FORBIDDEN',
            message: 'Only the owner may mint this link.',
            requestId: 'req_9',
          },
        },
        status: 403,
      },
    })
    const onClose = vi.fn()
    render(<LivenessPageModal onClose={onClose} />)
    await screen.findByLabelText('Display URL')

    fireEvent.change(screen.getByLabelText('Customer'), { target: { value: 'Sok Dara' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create link' }))

    expect(await screen.findByText('Only the owner may mint this link.')).toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Create link' })).toBeEnabled()
  })

  it('keeps expired links listed under their customer', async () => {
    stubRoutes({ list: { payload: { links: [makeLivenessLink(), EXPIRED_LINK] } } })
    render(<LivenessPageModal onClose={vi.fn()} />)

    expect(await screen.findByText('Expired')).toBeInTheDocument()
    expect(screen.getByText('In use')).toBeInTheDocument()
    // Both rows belong to one customer, so the name heads them exactly once.
    expect(screen.getAllByText('Sok Dara')).toHaveLength(1)
  })

  it('renders a failed load under its own banner and blocks minting', async () => {
    stubRoutes({
      list: { payload: { error: { code: 'UNAVAILABLE', message: 'Down right now.' } }, status: 503 },
    })
    render(<LivenessPageModal onClose={vi.fn()} />)

    expect(await screen.findByRole('alert')).toHaveTextContent('Down right now.')
    expect(screen.queryByLabelText('Display URL')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create link' })).toBeDisabled()
  })

  it('lists nothing yet before any link exists', async () => {
    stubRoutes({ list: { payload: { links: [] } } })
    render(<LivenessPageModal onClose={vi.fn()} />)

    expect(await screen.findByText('No links yet.')).toBeInTheDocument()
    expect(screen.queryByLabelText('Display URL')).not.toBeInTheDocument()
  })

  it('offers the all-officers view to an administrator, without anyone else’s token', async () => {
    const fetchMock = stubRoutes({
      list: { payload: { links: [makeLivenessLink()] } },
      listAll: {
        payload: {
          links: [
            makeLivenessLink(),
            makeLivenessLink({
              id: 'lnk_other',
              token: null,
              owner: { id: 'user_b', name: 'Chan Vandy' },
            }),
          ],
        },
      },
    })
    render(<LivenessPageModal onClose={vi.fn()} />)
    await screen.findByLabelText('Display URL')

    fireEvent.click(screen.getByRole('button', { name: 'All officers' }))

    expect(await screen.findByText('Chan Vandy')).toBeInTheDocument()
    expect(
      fetchMock.mock.calls.some((call) => call[0].includes('scope=all')),
    ).toBe(true)
    // The other officer's row carries no secret, so the URL shown is still ours.
    expect(screen.getByLabelText<HTMLInputElement>('Display URL').value).toContain(
      'sess_fixed_1',
    )
  })

  it('offers no scope toggle to a non-administrator', async () => {
    writeAuthUser({ ...TEST_AUTH_USER, isAdmin: false })
    stubRoutes()
    render(<LivenessPageModal onClose={vi.fn()} />)
    await screen.findByLabelText('Display URL')

    expect(screen.queryByRole('button', { name: 'All officers' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Yours' })).not.toBeInTheDocument()
  })

  it('exits through Close and Escape — never through the dialog itself', async () => {
    stubRoutes()
    const onClose = vi.fn()
    render(<LivenessPageModal onClose={onClose} />)
    await screen.findByLabelText('Display URL')
    const dialog = screen.getByRole('dialog', { name: 'Liveness links' })

    fireEvent.click(dialog)
    expect(onClose).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledTimes(1)

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})
