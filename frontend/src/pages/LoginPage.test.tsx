import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DocumentSessionProvider } from '@/features/document-upload/DocumentSessionProvider'
import { FaceCaptureProvider } from '@/features/face-capture/FaceCaptureProvider'
import { IdCardProcessingProvider } from '@/features/id-card-processing/IdCardProcessingProvider'
import { AppRoutes } from '@/app/AppRoutes'
import { clearAuthUser, readAuthUser, writeAuthUser } from '@/lib/auth'
import { TEST_AUTH_USER, bodyOf, urlOf } from '@/test/fixtures'

/**
 * The sign-in page (D18).
 *
 * A credential failure must show the server's sentence — one identical
 * sentence for wrong email and wrong password, because the form must not
 * become an account-enumeration oracle (§30) — and must leave the visitor
 * signed out. Success must store the profile and continue into the app.
 */

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/** Stub `fetch` for login: `answers` maps a status to the envelope to return. */
function stubLoginFetch(
  answer: { readonly status: number; readonly payload: unknown },
): ReturnType<typeof vi.fn> {
  const mock = vi.fn((input: RequestInfo | URL) => {
    if (urlOf(input).includes('/auth/login')) {
      return Promise.resolve(json(answer.payload, answer.status))
    }
    return Promise.resolve(json({}, 404))
  })
  vi.stubGlobal('fetch', mock)
  return mock
}

function renderLogin() {
  return render(
    <MemoryRouter initialEntries={['/login']}>
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

afterEach(() => {
  vi.unstubAllGlobals()
  clearAuthUser()
})

async function fillAndSubmit(email: string, password: string) {
  await userEvent.type(screen.getByLabelText('Email'), email)
  await userEvent.type(screen.getByLabelText('Password'), password)
  await userEvent.click(screen.getByRole('button', { name: 'Sign in' }))
}

describe('the sign-in page', () => {
  it('shows the server sentence for bad credentials and stays signed out', async () => {
    clearAuthUser()
    stubLoginFetch({
      status: 401,
      payload: {
        error: { code: 'UNAUTHENTICATED', message: 'That email or password is incorrect.' },
      },
    })
    renderLogin()

    await fillAndSubmit('nobody@example.com', 'wrong')

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'That email or password is incorrect.',
    )
    expect(screen.getByRole('heading', { name: 'Sign in', level: 1 })).toBeInTheDocument()
    expect(readAuthUser()).toBeNull()
  })

  it('shows the disabled-account sentence as its own message', async () => {
    clearAuthUser()
    stubLoginFetch({
      status: 403,
      payload: {
        error: {
          code: 'FORBIDDEN',
          message: 'This account has been disabled. Please contact an administrator.',
        },
      },
    })
    renderLogin()

    await fillAndSubmit('disabled@example.com', 'Str0ng!Pass')

    expect(await screen.findByRole('alert')).toHaveTextContent(/has been disabled/i)
    expect(readAuthUser()).toBeNull()
  })

  it('stores the account and continues into the workspace on success', async () => {
    clearAuthUser()
    stubLoginFetch({
      status: 200,
      payload: { token: 'tok_1', user: TEST_AUTH_USER },
    })
    renderLogin()

    await fillAndSubmit(TEST_AUTH_USER.email, 'P4ssw0rd!')

    expect(
      await screen.findByRole('heading', { name: 'Identity Verification', level: 1 }),
    ).toBeInTheDocument()
    expect(readAuthUser()?.email).toBe(TEST_AUTH_USER.email)
  })

  it('posts exactly what was typed, no more', async () => {
    clearAuthUser()
    const fetchMock = stubLoginFetch({
      status: 200,
      payload: { token: 'tok_1', user: TEST_AUTH_USER },
    })
    renderLogin()

    await fillAndSubmit('admin@gmail.com', 'P4ssw0rd!')

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(bodyOf<{ email: string; password: string }>(fetchMock.mock.calls[0]!)).toEqual({
      email: 'admin@gmail.com',
      password: 'P4ssw0rd!',
    })
  })

  it('bounces an already signed-in visitor straight into the workspace', () => {
    writeAuthUser(TEST_AUTH_USER)

    renderLogin()

    expect(
      screen.getByRole('heading', { name: 'Identity Verification', level: 1 }),
    ).toBeInTheDocument()
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument()
  })
})
