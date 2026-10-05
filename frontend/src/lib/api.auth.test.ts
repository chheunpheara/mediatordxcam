import { afterEach, describe, expect, it, vi } from 'vitest'

import { createUser, deleteUser, login, logout, setRolePermissions } from './api'
import type { ApiError } from './api'
import { AUTH_EXPIRED_EVENT } from './auth'
import { bodyOf } from '../test/fixtures'

/**
 * The sign-in and administration client (D18).
 *
 * What matters here is the contract the forms rely on: credentials go as
 * JSON, field-level validation comes back as `fieldErrors`, a 401 announces
 * itself to the auth layer, and role permissions are sent as a whole set —
 * the server replaces, never merges.
 */

function stubJson(payload: unknown, status = 200) {
  // 204 must be built without a body — the Response constructor refuses one
  // for bodyless statuses, which is exactly what the endpoint returns.
  const body = status === 204 ? null : JSON.stringify(payload)
  const mock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
    Promise.resolve(
      new Response(body, {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    ),
  )
  vi.stubGlobal('fetch', mock)
  return mock
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('login', () => {
  it('posts the credentials and returns the account', async () => {
    const user = {
      id: 'u1',
      email: 'admin@gmail.com',
      name: 'Admin',
      status: 'active',
      roles: [{ id: 'r1', name: 'Admin' }],
      isAdmin: true,
    }
    const fetchMock = stubJson({ token: 'tok_abc', user })

    const session = await login('admin@gmail.com', 'P4ssw0rd!')

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/v1/auth/login')
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit
    expect(init.method).toBe('POST')
    expect(bodyOf<{ email: string; password: string }>(fetchMock.mock.calls[0]!)).toEqual({
      email: 'admin@gmail.com',
      password: 'P4ssw0rd!',
    })
    expect(session.user).toEqual(user)
  })

  it('surfaces the server sentence and the failing field', async () => {
    stubJson(
      {
        error: {
          code: 'INVALID_REQUEST',
          message: 'Password must be at least 8 characters and include an upper-case letter, a lower-case letter, a number and a symbol.',
          fieldErrors: { password: 'Password must be at least 8 characters and include an upper-case letter, a lower-case letter, a number and a symbol.' },
          requestId: 'req_1',
        },
      },
      400,
    )

    const error = (await login('a@example.com', 'short').catch((cause: unknown) => cause)) as ApiError

    expect(error.code).toBe('INVALID_REQUEST')
    expect(error.status).toBe(400)
    expect(error.fieldErrors.password).toContain('at least 8 characters')
  })

  it('announces an expired session when the server answers 401', async () => {
    // Manual add/remove: jsdom's EventTarget does not honour an AbortSignal
    // passed here, so the listener is detached explicitly instead.
    const listener = vi.fn()
    window.addEventListener(AUTH_EXPIRED_EVENT, listener)
    try {
      stubJson(
        { error: { code: 'UNAUTHENTICATED', message: 'That email or password is incorrect.' } },
        401,
      )

      await login('nobody@example.com', 'nope').catch(() => undefined)

      expect(listener).toHaveBeenCalledTimes(1)
    } finally {
      window.removeEventListener(AUTH_EXPIRED_EVENT, listener)
    }
  })
})

describe('logout', () => {
  it('posts to the logout endpoint so the session dies server-side too', async () => {
    const fetchMock = stubJson(null, 204)

    await logout()

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/v1/auth/logout')
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).method).toBe('POST')
  })

  it('lets a failed sign-out reach the caller — the header clears locally either way', async () => {
    stubJson({ error: { code: 'UNKNOWN', message: 'Something went wrong. Please try again.' } }, 500)

    await expect(logout()).rejects.toMatchObject({ status: 500 })
  })
})

describe('administration', () => {
  it('sends a new account with its role ids', async () => {
    const fetchMock = stubJson(
      {
        id: 'u2',
        email: 'loan@example.com',
        name: 'Loan Officer',
        status: 'active',
        roles: [],
        isAdmin: false,
      },
      201,
    )

    await createUser({
      email: 'loan@example.com',
      name: 'Loan Officer',
      password: 'Str0ng!Pass',
      roleIds: ['role_loan'],
    })

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/v1/admin/users')
    expect(bodyOf<{ roleIds: string[] }>(fetchMock.mock.calls[0]!)).toEqual({
      email: 'loan@example.com',
      name: 'Loan Officer',
      password: 'Str0ng!Pass',
      roleIds: ['role_loan'],
    })
  })

  it('replaces a role permissions set wholesale', async () => {
    const fetchMock = stubJson({
      id: 'role_loan',
      name: 'Loan Officer',
      isAdmin: false,
      permissions: ['verify_user_info'],
    })

    await setRolePermissions('role_loan', ['verify_user_info'])

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/v1/admin/roles/role_loan/permissions')
    expect(init.method).toBe('PUT')
    expect(bodyOf<{ permissions: string[] }>(fetchMock.mock.calls[0]!)).toEqual({
      permissions: ['verify_user_info'],
    })
  })

  it('treats a 204 as success without trying to parse a body', async () => {
    const fetchMock = stubJson(null, 204)

    await expect(deleteUser('u9')).resolves.toBeUndefined()
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).method).toBe('DELETE')
  })
})
