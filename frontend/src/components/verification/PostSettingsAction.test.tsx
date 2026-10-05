import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { PostSettingsAction } from './PostSettingsAction'
import { writeAuthUser } from '../../lib/auth'
import { TEST_AUTH_USER } from '../../test/fixtures'

/**
 * The header button's display gate (D19): it appears for a profile holding
 * every verification permission, and is not rendered at all for a partial
 * one — matching what the server would say anyway.
 */

function stubSettingsFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ settings: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    ),
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('PostSettingsAction', () => {
  it('opens the settings dialog for a full-permission profile', async () => {
    stubSettingsFetch()
    render(<PostSettingsAction />)

    fireEvent.click(screen.getByRole('button', { name: /post settings/i }))

    expect(await screen.findByRole('dialog', { name: 'Post settings' })).toBeInTheDocument()
  })

  it('renders nothing for a profile without the full permission set', () => {
    writeAuthUser({
      ...TEST_AUTH_USER,
      permissions: ['verify_user_info', 'verify_user_info_face'],
    })

    const { container } = render(<PostSettingsAction />)

    expect(container).toBeEmptyDOMElement()
    expect(screen.queryByRole('button', { name: /post settings/i })).not.toBeInTheDocument()
  })
})
