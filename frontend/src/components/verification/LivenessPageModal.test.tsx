import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { LivenessPageModal } from './LivenessPageModal'
import { bodyOf } from '../../test/fixtures'

/**
 * The "Liveness Page" dialog: loads the fixed customer-display settings,
 * shows the permanent `/display?session=…` URL for the second monitor, and
 * saves enable/disable in one PUT — closing only on success, and exiting
 * through Close or Escape rather than a click on the dialog itself.
 */

const SETTINGS = { enabled: true, sessionId: 'sess_fixed_1' }

function stubRoutes(save: { payload: unknown; status?: number } = { payload: SETTINGS }) {
  const mock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
    const route = init?.method === 'PUT' ? save : { payload: SETTINGS }
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
  render(<LivenessPageModal onClose={onClose} />)
  await screen.findByLabelText('Display URL')
  return { onClose }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('LivenessPageModal', () => {
  it('shows the permanent display URL in a labelled modal dialog, focus on Close', async () => {
    await renderLoadedModal()

    const dialog = screen.getByRole('dialog', { name: 'Liveness page' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    const url = screen.getByLabelText<HTMLInputElement>('Display URL')
    expect(url.readOnly).toBe(true)
    expect(url.value).toContain('/display?session=sess_fixed_1')
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }))
  })

  it('saves the switch in one PUT and closes only on success', async () => {
    const fetchMock = stubRoutes()
    const onClose = vi.fn()
    render(<LivenessPageModal onClose={onClose} />)
    await screen.findByLabelText('Display URL')

    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    const putCall = fetchMock.mock.calls.find((call) => call[1]?.method === 'PUT')
    expect(putCall).toBeDefined()
    expect(bodyOf<{ enabled: boolean }>(putCall!)).toEqual({ enabled: false })
  })

  it('keeps the dialog open and reports the server sentence when a save is refused', async () => {
    stubRoutes({
      payload: {
        error: {
          code: 'FORBIDDEN',
          message: 'Administrator access is required to change the liveness page.',
          requestId: 'req_9',
        },
      },
      status: 403,
    })
    const onClose = vi.fn()
    render(<LivenessPageModal onClose={onClose} />)
    await screen.findByLabelText('Display URL')

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(
      await screen.findByText('Administrator access is required to change the liveness page.'),
    ).toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
  })

  it('exits through Close and Escape — never through the dialog itself', async () => {
    const { onClose } = await renderLoadedModal()
    const dialog = screen.getByRole('dialog', { name: 'Liveness page' })

    fireEvent.click(dialog)
    expect(onClose).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledTimes(1)

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('renders a failed load under its own banner', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: { code: 'UNAVAILABLE', message: 'Down right now.' } }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' },
          }),
        ),
      ),
    )
    render(<LivenessPageModal onClose={vi.fn()} />)

    expect(await screen.findByRole('alert')).toHaveTextContent('Down right now.')
    expect(screen.queryByLabelText('Display URL')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })
})
