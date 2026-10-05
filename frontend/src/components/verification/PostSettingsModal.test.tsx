import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { PostSettingsModal } from './PostSettingsModal'
import { bodyOf } from '../../test/fixtures'

/**
 * The "Post Settings" dialog (D19, D22): loads the stored systems, keeps saved
 * passwords write-only (blank on the way back, "leave blank to keep" on the
 * way in), replaces the whole list in one PUT, renders a refused row under
 * its own field, and probes one row at a time with "Test Connection" before
 * anything is saved.
 */

const EXISTING = { id: 'set_1', url: 'https://core.example/post', apiUser: 'svc_camdx' }

interface Route {
  readonly payload: unknown
  readonly status?: number
}

/**
 * One fetch stub answering by method, so a test can behave one way for the
 * load (GET), another for the save (PUT) and another for the probe (POST)
 * without re-stubbing mid-flight — a replaced global would orphan the calls
 * already recorded.
 */
function stubRoutes(
  save: Route = { payload: { settings: [EXISTING] } },
  test: Route = { payload: { ok: true, reason: null } },
) {
  const mock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
    const route =
      init?.method === 'PUT'
        ? save
        : init?.method === 'POST'
          ? test
          : { payload: { settings: [EXISTING] } }
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

async function renderLoadedModal(onClose = vi.fn()) {
  stubRoutes()
  render(<PostSettingsModal onClose={onClose} />)
  await screen.findByDisplayValue(EXISTING.url)
  return { onClose }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('PostSettingsModal', () => {
  it('lists the stored systems in a labelled modal dialog, focus on Close', async () => {
    await renderLoadedModal()

    const dialog = screen.getByRole('dialog', { name: 'Post settings' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(within(dialog).getByDisplayValue(EXISTING.url)).toBeInTheDocument()
    expect(within(dialog).getByDisplayValue(EXISTING.apiUser)).toBeInTheDocument()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }))
  })

  it('shows a saved password as keep-if-blank, never as the secret', async () => {
    await renderLoadedModal()

    const password = screen.getByLabelText<HTMLInputElement>('System 1 API password')
    expect(password.value).toBe('')
    expect(password.placeholder).toBe('Leave blank to keep')
  })

  it('saves the whole list in one PUT, a blank password keeping the stored one', async () => {
    const fetchMock = stubRoutes()
    const onClose = vi.fn()
    render(<PostSettingsModal onClose={onClose} />)
    await screen.findByDisplayValue(EXISTING.url)

    fireEvent.change(screen.getByLabelText('System 1 URL'), {
      target: { value: 'https://core.example/post/v2' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    const putCall = fetchMock.mock.calls.find(
      (call) => (call[1])?.method === 'PUT',
    )
    expect(putCall).toBeDefined()
    expect(bodyOf<{ settings: unknown[] }>(putCall!)).toEqual({
      settings: [
        { id: 'set_1', url: 'https://core.example/post/v2', apiUser: 'svc_camdx', apiPassword: '' },
      ],
    })
  })

  it('adds and removes systems, refusing to save an incomplete new row', async () => {
    const { onClose } = await renderLoadedModal()

    fireEvent.click(screen.getByRole('button', { name: /add system/i }))
    expect(screen.getByLabelText('System 2 URL')).toBeInTheDocument()
    // A brand-new row has no password yet, so Save stays out of the way.
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: 'Remove system 2' }))
    expect(screen.queryByLabelText('System 2 URL')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Remove system 1' }))
    expect(screen.getByText(/no systems configured yet/i)).toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('renders a refused URL under its own field, without a duplicate banner', async () => {
    const refusal = {
      error: {
        code: 'INVALID_REQUEST',
        message: 'Enter a full system URL, starting with http:// or https://.',
        fieldErrors: {
          'settings.0.url': 'Enter a full system URL, starting with http:// or https://.',
        },
        requestId: 'req_2',
      },
    }
    stubRoutes({ payload: refusal, status: 400 })
    render(<PostSettingsModal onClose={vi.fn()} />)
    await screen.findByDisplayValue(EXISTING.url)

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(
      await screen.findByText('Enter a full system URL, starting with http:// or https://.'),
    ).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('exits through Close and Escape — never through the dialog itself', async () => {
    const { onClose } = await renderLoadedModal()
    const dialog = screen.getByRole('dialog', { name: 'Post settings' })

    fireEvent.click(dialog)
    expect(onClose).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledTimes(1)

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})

describe('test connection (D22)', () => {
  it('probes the row as typed — a blank password on a saved row keeps the stored one', async () => {
    const fetchMock = stubRoutes()
    render(<PostSettingsModal onClose={vi.fn()} />)
    await screen.findByDisplayValue(EXISTING.url)

    fireEvent.click(screen.getByRole('button', { name: 'Test Connection' }))

    const result = await screen.findByText('Connection succeeded.')
    expect(result).toHaveAttribute('role', 'status')
    const postCall = fetchMock.mock.calls.find((call) => call[1]?.method === 'POST')
    expect(postCall).toBeDefined()
    expect(bodyOf<Record<string, unknown>>(postCall!)).toEqual({
      id: 'set_1',
      url: 'https://core.example/post',
      apiUser: 'svc_camdx',
      apiPassword: '',
    })
  })

  it('reports a refusal in the fixed safe words', async () => {
    stubRoutes(undefined, {
      payload: { ok: false, reason: 'The system refused the API credentials.' },
    })
    render(<PostSettingsModal onClose={vi.fn()} />)
    await screen.findByDisplayValue(EXISTING.url)

    fireEvent.click(screen.getByRole('button', { name: 'Test Connection' }))

    const result = await screen.findByText('The system refused the API credentials.')
    expect(result).toHaveAttribute('role', 'alert')
  })

  it('shows the server sentence when the probe itself is refused', async () => {
    stubRoutes(undefined, {
      payload: {
        error: {
          code: 'INVALID_REQUEST',
          message: 'Enter the API password.',
          fieldErrors: { apiPassword: 'Enter the API password.' },
          requestId: 'req_5',
        },
      },
      status: 400,
    })
    render(<PostSettingsModal onClose={vi.fn()} />)
    await screen.findByDisplayValue(EXISTING.url)

    fireEvent.click(screen.getByRole('button', { name: 'Test Connection' }))

    const result = await screen.findByText('Enter the API password.')
    expect(result).toHaveAttribute('role', 'alert')
  })

  it('reads Testing… and takes no second probe while one is in flight', async () => {
    let resolveProbe: ((response: Response) => void) | undefined
    const probe = new Promise<Response>((resolve) => {
      resolveProbe = resolve
    })
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') return probe
      return Promise.resolve(
        new Response(JSON.stringify({ settings: [EXISTING] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<PostSettingsModal onClose={vi.fn()} />)
    await screen.findByDisplayValue(EXISTING.url)

    fireEvent.click(screen.getByRole('button', { name: 'Test Connection' }))

    const busy = await screen.findByRole('button', { name: 'Testing…' })
    expect(busy).toBeDisabled()
    fireEvent.click(busy)
    expect(fetchMock.mock.calls.filter((call) => call[1]?.method === 'POST')).toHaveLength(1)

    resolveProbe?.(
      new Response(JSON.stringify({ ok: true, reason: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    expect(await screen.findByText('Connection succeeded.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Test Connection' })).toBeEnabled()
  })

  it('drops a stale result the moment the row is edited', async () => {
    stubRoutes()
    render(<PostSettingsModal onClose={vi.fn()} />)
    await screen.findByDisplayValue(EXISTING.url)

    fireEvent.click(screen.getByRole('button', { name: 'Test Connection' }))
    await screen.findByText('Connection succeeded.')

    fireEvent.change(screen.getByLabelText('System 1 URL'), {
      target: { value: 'https://moved.example/post' },
    })

    expect(screen.queryByText('Connection succeeded.')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Test Connection' })).toBeEnabled()
  })

  it('refuses to test an incomplete new row', async () => {
    await renderLoadedModal()

    fireEvent.click(screen.getByRole('button', { name: /add system/i }))

    const buttons = screen.getAllByRole('button', { name: 'Test Connection' })
    expect(buttons).toHaveLength(2)
    expect(buttons[0]).toBeEnabled() // the saved row is complete
    expect(buttons[1]).toBeDisabled() // the empty new row is not
  })
})
