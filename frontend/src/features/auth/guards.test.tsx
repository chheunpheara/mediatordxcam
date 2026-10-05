import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AppRoutes } from '@/app/AppRoutes'
import { AuthProvider } from '@/features/auth/AuthProvider'
import { DocumentSessionProvider } from '@/features/document-upload/DocumentSessionProvider'
import { FaceCaptureProvider } from '@/features/face-capture/FaceCaptureProvider'
import { IdCardProcessingProvider } from '@/features/id-card-processing/IdCardProcessingProvider'
import { AUTH_EXPIRED_EVENT, clearAuthUser, readAuthUser, writeAuthUser } from '@/lib/auth'
import { TEST_AUTH_USER, urlOf } from '@/test/fixtures'

/**
 * The sign-in gates (D18).
 *
 * Two directions to protect: nobody sees an application page without an
 * account, and an account without administrator rights gets a *stated*
 * refusal rather than a silently empty screen. The guards read the stored
 * profile — which is what production does on first paint — so these tests
 * exercise exactly the decision the browser makes before any request exists.
 */

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/** Answer the admin surface with empty-but-valid lists. */
function stubAdminFetch(options: { readonly logoutStatus?: number } = {}) {
  const mock = vi.fn((input: RequestInfo | URL) => {
    const url = urlOf(input)
    if (url.includes('/auth/logout')) {
      if (options.logoutStatus && options.logoutStatus >= 400) {
        return Promise.resolve(
          json({ error: { code: 'UNKNOWN', message: 'Something went wrong.' } }, options.logoutStatus),
        )
      }
      return Promise.resolve(new Response(null, { status: 204 }))
    }
    if (url.includes('/admin/roles')) return Promise.resolve(json({ roles: [] }))
    if (url.includes('/admin/permissions')) return Promise.resolve(json({ permissions: [] }))
    if (url.includes('/admin/users')) return Promise.resolve(json({ users: [] }))
    return Promise.resolve(json({}, 404))
  })
  vi.stubGlobal('fetch', mock)
  return mock
}

afterEach(() => {
  vi.unstubAllGlobals()
})

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <DocumentSessionProvider>
          <IdCardProcessingProvider>
            <FaceCaptureProvider>
              <AppRoutes />
            </FaceCaptureProvider>
          </IdCardProcessingProvider>
        </DocumentSessionProvider>
      </AuthProvider>
    </MemoryRouter>,
  )
}

describe('the sign-in gate', () => {
  it('sends a signed-out visitor from the workspace entry to sign-in', () => {
    clearAuthUser()

    renderAt('/')

    expect(screen.getByRole('heading', { name: 'Sign in', level: 1 })).toBeInTheDocument()
  })

  it('sends a signed-out visitor from administration to sign-in', () => {
    clearAuthUser()

    renderAt('/admin')

    expect(screen.getByRole('heading', { name: 'Sign in', level: 1 })).toBeInTheDocument()
  })

  it('takes a signed-in visitor straight past the sign-in page', () => {
    renderAt('/login')

    expect(
      screen.getByRole('heading', { name: 'Identity Verification', level: 1 }),
    ).toBeInTheDocument()
  })
})

describe('administration access', () => {
  it('renders the area for an administrator', () => {
    stubAdminFetch()

    renderAt('/admin')

    expect(screen.getByRole('heading', { name: 'Administration', level: 1 })).toBeInTheDocument()
  })

  it('states the refusal to a signed-in non-administrator instead of redirecting', () => {
    writeAuthUser({ ...TEST_AUTH_USER, isAdmin: false })

    renderAt('/admin')

    const refusal = screen.getByRole('alert')
    expect(refusal).toHaveTextContent(/does not include administrator access/i)
    expect(screen.getByRole('link', { name: /back to verification/i })).toBeInTheDocument()
    // The denial is a page, not a bounce: they are still signed in.
    expect(screen.queryByRole('heading', { name: 'Sign in', level: 1 })).not.toBeInTheDocument()
  })

  it('shows the sign-in page again after signing out, even if the server call fails', async () => {
    stubAdminFetch({ logoutStatus: 500 })

    renderAt('/')
    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }))

    expect(await screen.findByRole('heading', { name: 'Sign in', level: 1 })).toBeInTheDocument()
    expect(readAuthUser()).toBeNull()
  })
})

describe('an expired session', () => {
  it('clears the stored account so the guards react on the next render', async () => {
    render(
      <MemoryRouter>
        <AuthProvider>
          <div />
        </AuthProvider>
      </MemoryRouter>,
    )
    expect(readAuthUser()).not.toBeNull()

    window.dispatchEvent(new CustomEvent(AUTH_EXPIRED_EVENT))

    await waitFor(() => expect(readAuthUser()).toBeNull())
  })
})
