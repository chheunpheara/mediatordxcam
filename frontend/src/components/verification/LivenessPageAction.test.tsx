import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { LivenessPageAction } from './LivenessPageAction'
import { writeAuthUser } from '../../lib/auth'
import { TEST_AUTH_USER } from '../../test/fixtures'

/**
 * The header button's gate: every signed-in officer mints links — the route
 * carries no `require_admin` — so the button renders for any profile. The
 * administrator's read-only view of everyone else's links lives *inside* the
 * dialog as a scope toggle, not as a different button for a different person.
 */

function stubLinksFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ links: [] }), {
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
  it('opens the liveness links dialog', async () => {
    stubLinksFetch()
    render(<LivenessPageAction />)

    fireEvent.click(screen.getByRole('button', { name: /liveness links/i }))

    expect(await screen.findByRole('dialog', { name: 'Liveness links' })).toBeInTheDocument()
  })

  it('renders for a non-admin officer too — minting is theirs as well', async () => {
    writeAuthUser({ ...TEST_AUTH_USER, isAdmin: false })
    stubLinksFetch()
    render(<LivenessPageAction />)

    fireEvent.click(screen.getByRole('button', { name: /liveness links/i }))

    expect(await screen.findByRole('dialog', { name: 'Liveness links' })).toBeInTheDocument()
  })
})
