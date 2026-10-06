import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { LivenessPageAction } from './LivenessPageAction'
import { writeAuthUser } from '../../lib/auth'
import { TEST_AUTH_USER } from '../../test/fixtures'

/**
 * The header button's display gate: it appears for an admin — the same
 * `require_admin` the server puts on `PUT /api/v1/onboarding/liveness-page`
 * — and is not rendered at all for a non-admin profile, who could only ever
 * meet a refusal after the dialog is already open.
 */

function stubLivenessFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ enabled: false, sessionId: 'sess_fixed_1' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    ),
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
  writeAuthUser(TEST_AUTH_USER)
})

describe('LivenessPageAction', () => {
  it('opens the liveness page dialog for an admin profile', async () => {
    stubLivenessFetch()
    render(<LivenessPageAction />)

    fireEvent.click(screen.getByRole('button', { name: /liveness page/i }))

    expect(await screen.findByRole('dialog', { name: 'Liveness page' })).toBeInTheDocument()
  })

  it('renders nothing for a non-admin profile', () => {
    writeAuthUser({ ...TEST_AUTH_USER, isAdmin: false })

    const { container } = render(<LivenessPageAction />)

    expect(container).toBeEmptyDOMElement()
    expect(screen.queryByRole('button', { name: /liveness page/i })).not.toBeInTheDocument()
  })
})
