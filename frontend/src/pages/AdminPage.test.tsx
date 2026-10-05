import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AdminPage } from './AdminPage'
import { AuthProvider } from '@/features/auth/AuthProvider'
import type { AdminRole, AuthUser, VerificationMethodId } from '@/lib/api'
import { bodyOf, urlOf } from '@/test/fixtures'

/**
 * Administration (D18): the three tabs against the real endpoint contracts.
 *
 * The stub answers the way the backend does — role creation refused with a
 * field error, permissions replaced wholesale, a held role rejected on delete
 * — so these tests fail if the panels drift from what the API actually sends
 * and returns, rather than from a mock that agrees with anything.
 */

const POLICY_MESSAGE =
  'Password must be at least 8 characters and include an upper-case letter, a lower-case letter, a number and a symbol.'

const PERMISSIONS = [
  { key: 'verify_user_info', label: 'Identity Information', officialName: 'Verify User Info' },
  {
    key: 'verify_user_info_face',
    label: 'Identity + Face',
    officialName: 'Verify User Info + User Face',
  },
]

const INITIAL_ROLES: AdminRole[] = [
  { id: 'role_admin', name: 'Admin', isAdmin: true, permissions: ['verify_user_info'] },
  { id: 'role_loan', name: 'Loan Officer', isAdmin: false, permissions: [] },
]

const USERS: AuthUser[] = [
  {
    id: 'u_loan',
    email: 'loan@example.com',
    name: 'Sokha Cham',
    status: 'active',
    roles: [{ id: 'role_loan', name: 'Loan Officer' }],
    isAdmin: false,
    permissions: ['verify_user_info', 'verify_user_info_face'],
  },
]

interface StubOptions {
  readonly users?: readonly AuthUser[]
  readonly createPolicyError?: boolean
}

/**
 * Route `fetch` by endpoint, keeping the role list *mutable* so a PUT visibly
 * changes what the next GET returns — the way the real server behaves.
 */
function stubAdminFetch(options: StubOptions = {}) {
  const state = {
    roles: INITIAL_ROLES.map((role) => ({ ...role, permissions: [...role.permissions] })),
    users: [...(options.users ?? USERS)],
  }

  const mock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = urlOf(input)
    const method = init?.method ?? 'GET'

    if (method === 'POST' && url.includes('/admin/users')) {
      if (options.createPolicyError) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              error: {
                code: 'INVALID_REQUEST',
                message: POLICY_MESSAGE,
                fieldErrors: { password: POLICY_MESSAGE },
              },
            }),
            { status: 400, headers: { 'Content-Type': 'application/json' } },
          ),
        )
      }
      const payload = bodyOf<{ email: string; name: string; roleIds: string[] }>([input, init])
      const created: AuthUser = {
        id: 'u_new',
        email: payload.email,
        name: payload.name,
        status: 'active',
        roles: [],
        isAdmin: false,
        permissions: [],
      }
      state.users = [...state.users, created]
      return Promise.resolve(
        new Response(JSON.stringify(created), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
    }

    if (method === 'PUT' && url.includes('/admin/roles/')) {
      const body = bodyOf<{ permissions: VerificationMethodId[] }>([input, init])
      state.roles = state.roles.map((role) =>
        url.includes(role.id) ? { ...role, permissions: body.permissions } : role,
      )
      const updated = state.roles.find((role) => url.includes(role.id))
      return Promise.resolve(
        new Response(JSON.stringify(updated), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
    }

    if (method === 'DELETE' && url.includes('/admin/roles/')) {
      const roleId = url.split('/admin/roles/')[1]
      // The backend refuses (409) while someone still holds the role; the
      // seeded Admin role is held by the signed-in account.
      if (roleId === 'role_admin') {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              error: {
                code: 'CONFLICT',
                message: 'A user still holds this role.',
              },
            }),
            { status: 409, headers: { 'Content-Type': 'application/json' } },
          ),
        )
      }
      state.roles = state.roles.filter((role) => role.id !== roleId)
      return Promise.resolve(new Response(null, { status: 204 }))
    }

    if (url.includes('/admin/roles')) {
      return Promise.resolve(
        new Response(JSON.stringify({ roles: state.roles }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
    }
    if (url.includes('/admin/permissions')) {
      return Promise.resolve(
        new Response(JSON.stringify({ permissions: PERMISSIONS }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
    }
    if (url.includes('/admin/users')) {
      return Promise.resolve(
        new Response(JSON.stringify({ users: state.users }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
    }
    return Promise.resolve(
      new Response(JSON.stringify({}), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
  })
  vi.stubGlobal('fetch', mock)
  return mock
}

function renderAdmin() {
  return render(
    <MemoryRouter initialEntries={['/admin']}>
      <AuthProvider>
        <AdminPage />
      </AuthProvider>
    </MemoryRouter>,
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the users tab', () => {
  it('lists the accounts with their roles and status', async () => {
    stubAdminFetch()

    renderAdmin()

    expect(await screen.findByText('loan@example.com')).toBeInTheDocument()
    expect(screen.getByText('Sokha Cham')).toBeInTheDocument()
    expect(screen.getByText('Loan Officer')).toBeInTheDocument()
    expect(screen.getByText('Active')).toBeInTheDocument()
  })

  it('shows the password policy under the field the server refused', async () => {
    stubAdminFetch({ createPolicyError: true })

    renderAdmin()
    await screen.findByText('loan@example.com')

    await userEvent.click(screen.getByRole('button', { name: 'Add user' }))
    await userEvent.type(screen.getByLabelText('Email'), 'weak@example.com')
    await userEvent.type(screen.getByLabelText('Name'), 'Weak Password')
    await userEvent.type(screen.getByLabelText('Password'), 'short')
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }))

    // The message appears both as the form alert and as the field's own
    // error — the policy is server-owned either way (D18).
    expect(await screen.findByRole('alert')).toHaveTextContent(POLICY_MESSAGE)
    expect(screen.getByText(POLICY_MESSAGE, { selector: 'span' })).toBeInTheDocument()
  })

  it('posts the new account and refreshes the list on success', async () => {
    const fetchMock = stubAdminFetch({ users: [] })

    renderAdmin()
    await userEvent.click(await screen.findByRole('button', { name: 'Add user' }))
    await userEvent.type(screen.getByLabelText('Email'), 'new@example.com')
    await userEvent.type(screen.getByLabelText('Name'), 'New Officer')
    await userEvent.type(screen.getByLabelText('Password'), 'Str0ng!Pass')
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }))

    expect(await screen.findByText('new@example.com')).toBeInTheDocument()
    const post = fetchMock.mock.calls.find(
      (call) => call[1]?.method === 'POST',
    )
    expect(post).toBeDefined()
    expect(bodyOf<{ email: string }>(post!)).toMatchObject({ email: 'new@example.com' })
  })
})

describe('the permissions tab', () => {
  it('sends the role whole permission set and confirms the save', async () => {
    const fetchMock = stubAdminFetch()

    renderAdmin()
    await userEvent.click(screen.getByRole('tab', { name: 'Permissions' }))

    const cell = await screen.findByLabelText('Identity Information for Loan Officer')
    expect(cell).not.toBeChecked()
    await userEvent.click(cell)

    const save = screen.getByRole('button', { name: 'Save changes' })
    expect(save).toBeEnabled()
    await userEvent.click(save)

    expect(await screen.findByRole('status')).toHaveTextContent('Permissions saved.')
    const put = fetchMock.mock.calls.find(
      (call) => call[1]?.method === 'PUT',
    )
    expect(put).toBeDefined()
    expect(put![0]).toContain('/admin/roles/role_loan/permissions')
    expect(bodyOf<{ permissions: string[] }>(put!)).toEqual({
      permissions: ['verify_user_info'],
    })
    // What came back is what shows: the box stays ticked after the reload.
    expect(screen.getByLabelText('Identity Information for Loan Officer')).toBeChecked()
  })

  it('leaves save disabled until something changes', async () => {
    stubAdminFetch()

    renderAdmin()
    await userEvent.click(screen.getByRole('tab', { name: 'Permissions' }))
    await screen.findByLabelText('Identity Information for Loan Officer')

    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled()
  })
})

describe('the roles tab', () => {
  it('deletes a role only on the confirmed second click', async () => {
    const fetchMock = stubAdminFetch()

    renderAdmin()
    await userEvent.click(screen.getByRole('tab', { name: 'Roles' }))

    const loanRow = (await screen.findByText('Loan Officer')).closest('li')!
    await userEvent.click(within(loanRow).getByRole('button', { name: 'Delete' }))
    expect(within(loanRow).getByRole('button', { name: 'Confirm delete' })).toBeInTheDocument()
    expect(
      fetchMock.mock.calls.some((call) => call[1]?.method === 'DELETE'),
    ).toBe(false)

    await userEvent.click(within(loanRow).getByRole('button', { name: 'Confirm delete' }))

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          (call) => call[1]?.method === 'DELETE',
        ),
      ).toBe(true),
    )
  })

  it('shows the server refusal when a held role cannot be deleted', async () => {
    stubAdminFetch()

    renderAdmin()
    await userEvent.click(screen.getByRole('tab', { name: 'Roles' }))

    const adminRow = (await screen.findByText('Admin')).closest('li')!
    await userEvent.click(within(adminRow).getByRole('button', { name: 'Delete' }))
    await userEvent.click(within(adminRow).getByRole('button', { name: 'Confirm delete' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('A user still holds this role.')
  })
})
