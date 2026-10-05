import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'

import { ApiError, createUser, deleteUser, fetchUsers, updateUser } from '../../lib/api'
import type { AdminRole, AuthUser, UpdateUserInput } from '../../lib/api'

/**
 * Accounts (D18): the list, a creation form, and a per-row editor.
 *
 * Roles are picked here as checkboxes and status is a direct toggle, because
 * those are the two things an administrator does most; name and password edits
 * live behind "Edit" so the common actions stay one click. The password policy
 * itself is enforced by the server — this form displays whatever it says,
 * field by field (`fieldErrors`), and never re-implements the rule.
 *
 * Every mutation re-reads the list rather than patching it locally: with
 * last-admin protection and role guards deciding 403s server-side, what comes
 * back is the only trustworthy shape of the table.
 */
export function UsersPanel({ roles }: { readonly roles: readonly AdminRole[] }) {
  const [users, setUsers] = useState<readonly AuthUser[] | null>(null)
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<AuthUser | null>(null)
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Readonly<Record<string, string>>>({})

  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [roleIds, setRoleIds] = useState<readonly string[]>([])

  const [editName, setEditName] = useState('')
  const [editRoleIds, setEditRoleIds] = useState<readonly string[]>([])
  const [editPassword, setEditPassword] = useState('')

  const reload = useCallback(async () => {
    try {
      setUsers(await fetchUsers())
    } catch (caught) {
      setActionError(messageOf(caught))
    }
  }, [])

  useEffect(() => {
    // The mount fetch follows VerificationProvider's pattern: state changes
    // only inside promise callbacks, guarded so a late response cannot land
    // after the panel has gone. `reload` stays for mutations, which run from
    // event handlers.
    let active = true
    fetchUsers()
      .then((loaded) => {
        if (active) setUsers(loaded)
      })
      .catch((caught: unknown) => {
        if (active) setActionError(messageOf(caught))
      })
    return () => {
      active = false
    }
  }, [])

  const beginEdit = (user: AuthUser) => {
    setEditing(user)
    setConfirmingDelete(null)
    setActionError(null)
    setFieldErrors({})
    setEditName(user.name)
    setEditRoleIds(user.roles.map((role) => role.id))
    setEditPassword('')
  }

  const resetForms = () => {
    setCreating(false)
    setEditing(null)
    setActionError(null)
    setFieldErrors({})
    setEmail('')
    setName('')
    setPassword('')
    setRoleIds([])
    setEditName('')
    setEditRoleIds([])
    setEditPassword('')
  }

  const reportFailure = (caught: unknown) => {
    if (caught instanceof ApiError) {
      setActionError(caught.message)
      setFieldErrors(caught.fieldErrors)
    } else {
      setActionError('Something went wrong. Please try again.')
      setFieldErrors({})
    }
  }

  const handleCreate = async () => {
    setActionError(null)
    setFieldErrors({})
    try {
      await createUser({ email, name, password, roleIds })
      resetForms()
      await reload()
    } catch (caught) {
      reportFailure(caught)
    }
  }

  const handleSaveEdit = async (user: AuthUser) => {
    setActionError(null)
    setFieldErrors({})
    const patch: UpdateUserInput = { name: editName, roleIds: editRoleIds }
    try {
      await updateUser(user.id, editPassword ? { ...patch, password: editPassword } : patch)
      resetForms()
      await reload()
    } catch (caught) {
      reportFailure(caught)
    }
  }

  const handleToggleStatus = async (user: AuthUser) => {
    setBusyId(user.id)
    setActionError(null)
    setFieldErrors({})
    try {
      await updateUser(user.id, {
        status: user.status === 'active' ? 'disabled' : 'active',
      })
      await reload()
    } catch (caught) {
      reportFailure(caught)
    } finally {
      setBusyId(null)
    }
  }

  const handleDelete = async (user: AuthUser) => {
    if (confirmingDelete !== user.id) {
      setConfirmingDelete(user.id)
      setActionError(null)
      return
    }
    setBusyId(user.id)
    setActionError(null)
    try {
      await deleteUser(user.id)
      setConfirmingDelete(null)
      resetForms()
      await reload()
    } catch (caught) {
      reportFailure(caught)
    } finally {
      setBusyId(null)
    }
  }

  if (!users) {
    return (
      <p className="text-ink-muted text-sm" role="status">
        Loading accounts…
      </p>
    )
  }

  return (
    <div className="card p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">Users</h2>
        {!creating && !editing ? (
          <button
            type="button"
            className="btn-primary"
            onClick={() => {
              resetForms()
              setCreating(true)
            }}
          >
            Add user
          </button>
        ) : null}
      </div>

      {actionError ? (
        <p
          role="alert"
          className="border-negative bg-negative-soft text-negative mt-4 rounded-lg border px-4 py-3 text-sm font-medium"
        >
          {actionError}
        </p>
      ) : null}

      {creating ? (
        <form
          className="border-border mt-4 space-y-4 rounded-lg border p-4"
          onSubmit={(event) => {
            event.preventDefault()
            void handleCreate()
          }}
        >
          <h3 className="font-semibold">New account</h3>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Email" error={fieldErrors.email}>
              <input
                className="input"
                type="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </Field>
            <Field label="Name" error={fieldErrors.name}>
              <input
                className="input"
                required
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
          </div>
          <Field label="Password" error={fieldErrors.password}>
            <input
              className="input"
              type="password"
              required
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </Field>
          <PolicyHint />
          <RoleChecklist
            legend="Roles"
            roles={roles}
            selected={roleIds}
            onChange={setRoleIds}
            error={fieldErrors.roleIds}
          />
          <div className="flex gap-3">
            <button className="btn-primary" type="submit">
              Create account
            </button>
            <button className="btn-secondary" type="button" onClick={resetForms}>
              Cancel
            </button>
          </div>
        </form>
      ) : null}

      <div className="overflow-x-auto">
        <table className="mt-4 w-full text-left text-sm">
          <thead>
            <tr className="text-ink-muted border-border border-b">
              <th scope="col" className="py-2 pr-4 font-medium">
                Email
              </th>
              <th scope="col" className="py-2 pr-4 font-medium">
                Name
              </th>
              <th scope="col" className="py-2 pr-4 font-medium">
                Roles
              </th>
              <th scope="col" className="py-2 pr-4 font-medium">
                Status
              </th>
              <th scope="col" className="py-2 font-medium">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {users.map((account) => (
              <tr key={account.id} className="border-border border-b last:border-b-0">
                <td className="py-3 pr-4">{account.email}</td>
                <td className="py-3 pr-4">{account.name}</td>
                <td className="py-3 pr-4">
                  <span className="flex flex-wrap gap-1">
                    {account.roles.map((role) => (
                      <span
                        key={role.id}
                        className="bg-brand-soft text-ink rounded-full px-2 py-0.5 text-xs font-medium"
                      >
                        {role.name}
                      </span>
                    ))}
                  </span>
                </td>
                <td className="py-3 pr-4">
                  {account.status === 'active' ? (
                    <span className="text-positive font-medium">Active</span>
                  ) : (
                    <span className="text-negative font-medium">Disabled</span>
                  )}
                </td>
                <td className="py-3">
                  <div className="flex flex-wrap justify-end gap-2">
                    <button
                      type="button"
                      className="btn-secondary"
                      onClick={() => beginEdit(account)}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className="btn-secondary"
                      disabled={busyId === account.id}
                      onClick={() => void handleToggleStatus(account)}
                    >
                      {account.status === 'active' ? 'Disable' : 'Enable'}
                    </button>
                    <button
                      type="button"
                      className={confirmingDelete === account.id ? 'btn bg-brand text-white' : 'btn-secondary'}
                      disabled={busyId === account.id}
                      onClick={() => void handleDelete(account)}
                    >
                      {confirmingDelete === account.id
                        ? 'Confirm delete'
                        : busyId === account.id
                          ? 'Deleting…'
                          : 'Delete'}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editing ? (
        <form
          className="border-border mt-4 space-y-4 rounded-lg border p-4"
          onSubmit={(event) => {
            event.preventDefault()
            void handleSaveEdit(editing)
          }}
        >
          <h3 className="font-semibold">Edit {editing.email}</h3>
          <Field label="Name" error={fieldErrors.name}>
            <input
              className="input"
              required
              value={editName}
              onChange={(event) => setEditName(event.target.value)}
            />
          </Field>
          <Field label="New password" error={fieldErrors.password}>
            <input
              className="input"
              type="password"
              autoComplete="new-password"
              placeholder="Leave blank to keep the current password"
              value={editPassword}
              onChange={(event) => setEditPassword(event.target.value)}
            />
          </Field>
          <PolicyHint />
          <RoleChecklist
            legend="Roles"
            roles={roles}
            selected={editRoleIds}
            onChange={setEditRoleIds}
            error={fieldErrors.roleIds}
          />
          <div className="flex gap-3">
            <button className="btn-primary" type="submit">
              Save changes
            </button>
            <button className="btn-secondary" type="button" onClick={resetForms}>
              Cancel
            </button>
          </div>
        </form>
      ) : null}
    </div>
  )
}

/** One labelled control with its server-side field error, if any. */
function Field({
  label,
  error,
  children,
}: {
  readonly label: string
  readonly error?: string | undefined
  readonly children: ReactNode
}) {
  return (
    <label className="text-ink block text-sm font-medium">
      {label}
      <span className="mt-1 block">{children}</span>
      {error ? <span className="text-negative mt-1 block text-xs">{error}</span> : null}
    </label>
  )
}

function PolicyHint() {
  return (
    <p className="text-ink-subtle text-xs leading-relaxed">
      Passwords need at least 8 characters with an upper-case letter, a lower-case letter, a number
      and a symbol.
    </p>
  )
}

function RoleChecklist({
  legend,
  roles,
  selected,
  onChange,
  error,
}: {
  readonly legend: string
  readonly roles: readonly AdminRole[]
  readonly selected: readonly string[]
  readonly onChange: (next: readonly string[]) => void
  readonly error?: string | undefined
}) {
  const toggle = (id: string) => {
    onChange(
      selected.includes(id) ? selected.filter((roleId) => roleId !== id) : [...selected, id],
    )
  }

  return (
    <fieldset>
      <legend className="text-ink text-sm font-medium">{legend}</legend>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2">
        {roles.map((role) => (
          <label key={role.id} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={selected.includes(role.id)}
              onChange={() => toggle(role.id)}
            />
            {role.name}
            {role.isAdmin ? <span className="text-ink-subtle text-xs">(admin)</span> : null}
          </label>
        ))}
      </div>
      {error ? <span className="text-negative mt-1 block text-xs">{error}</span> : null}
    </fieldset>
  )
}

function messageOf(caught: unknown): string {
  return caught instanceof ApiError
    ? caught.message
    : 'Something went wrong. Please try again.'
}
