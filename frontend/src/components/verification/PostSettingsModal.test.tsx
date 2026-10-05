import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { PostSettingsModal } from './PostSettingsModal'
import { bodyOf } from '../../test/fixtures'

/**
 * The "Post Settings" dialog (D19): loads the stored systems, keeps saved
 * passwords write-only (blank on the way back, "leave blank to keep" on the
 * way in), replaces the whole list in one PUT, and renders a refused row
 * under its own field.
 */

const EXISTING = { id: 'set_1', url: 'https://core.example/post', apiUser: 'svc_camdx' }

interface Route {
  readonly payload: unknown
  readonly status?: number
}

/**
 * One fetch stub answering by method, so a test can behave one way for the
 * load (GET) and another for the save (PUT) without re-stubbing mid-flight —
 * a replaced global would orphan the calls already recorded.
 */
function stubRoutes(save: Route = { payload: { settings: [EXISTING] } }) {
  const mock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
    const route = init?.method === 'PUT' ? save : { payload: { settings: [EXISTING] } }
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
