import { useState } from 'react'

import { ApiError, createRole, deleteRole, updateRole } from '../../lib/api'
import type { AdminRole } from '../../lib/api'

/**
 * Roles (D18): create, rename, grant or drop administrator rights, delete.
 *
 * *Which* methods a role may run is deliberately not touched here — that is
 * the matrix's job on the next tab, and splitting the two keeps a rename from
 * looking like it also edits permissions. Deleting is a two-step confirmation
 * with the server's answer shown verbatim if it refuses: a role still held by
 * someone comes back 409, and the sentence explaining that is the useful one.
 */
export function RolesPanel({
  roles,
  onRolesChanged,
}: {
  readonly roles: readonly AdminRole[]
  readonly onRolesChanged: () => void
}) {
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [newIsAdmin, setNewIsAdmin] = useState(false)
  const [editing, setEditing] = useState<AdminRole | null>(null)
  const [editName, setEditName] = useState('')
  const [editIsAdmin, setEditIsAdmin] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Readonly<Record<string, string>>>({})

  const reportFailure = (caught: unknown) => {
    if (caught instanceof ApiError) {
      setError(caught.message)
      setFieldErrors(caught.fieldErrors)
    } else {
      setError('Something went wrong. Please try again.')
      setFieldErrors({})
    }
  }

  const reset = () => {
    setCreating(false)
    setEditing(null)
    setConfirmingDelete(null)
    setError(null)
    setFieldErrors({})
    setNewName('')
    setNewIsAdmin(false)
  }

  const handleCreate = async () => {
    setBusy(true)
    setError(null)
    setFieldErrors({})
    try {
      await createRole({ name: newName, isAdmin: newIsAdmin })
      reset()
      onRolesChanged()
    } catch (caught) {
      reportFailure(caught)
    } finally {
      setBusy(false)
    }
  }

  const handleSaveEdit = async (role: AdminRole) => {
    setBusy(true)
    setError(null)
    setFieldErrors({})
    try {
      await updateRole(role.id, { name: editName, isAdmin: editIsAdmin })
      reset()
      onRolesChanged()
    } catch (caught) {
      reportFailure(caught)
    } finally {
      setBusy(false)
    }
  }

  const handleDelete = async (role: AdminRole) => {
    if (confirmingDelete !== role.id) {
      setConfirmingDelete(role.id)
      setError(null)
      return
    }
    setBusy(true)
    setError(null)
    try {
      await deleteRole(role.id)
      reset()
      onRolesChanged()
    } catch (caught) {
      reportFailure(caught)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">Roles</h2>
        {!creating && !editing ? (
          <button
            type="button"
            className="btn-primary"
            onClick={() => {
              reset()
              setCreating(true)
            }}
          >
            Add role
          </button>
        ) : null}
      </div>

      {error ? (
        <p
          role="alert"
          className="border-negative bg-negative-soft text-negative mt-4 rounded-lg border px-4 py-3 text-sm font-medium"
        >
          {error}
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
          <h3 className="font-semibold">New role</h3>
          <label className="text-ink block text-sm font-medium">
            Name
            <input
              className="input mt-1"
              required
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
            />
            {fieldErrors.name ? (
              <span className="text-negative mt-1 block text-xs">{fieldErrors.name}</span>
            ) : null}
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={newIsAdmin}
              onChange={(event) => setNewIsAdmin(event.target.checked)}
            />
            Administrator rights (may manage users, roles and permissions)
          </label>
          <div className="flex gap-3">
            <button className="btn-primary" type="submit" disabled={busy}>
              Create role
            </button>
            <button className="btn-secondary" type="button" onClick={reset}>
              Cancel
            </button>
          </div>
        </form>
      ) : null}

      <ul className="mt-4 divide-border divide-y">
        {roles.map((role) => (
          <li key={role.id} className="py-3">
            {editing?.id === role.id ? (
              <form
                className="space-y-3"
                onSubmit={(event) => {
                  event.preventDefault()
                  void handleSaveEdit(role)
                }}
              >
                <label className="text-ink block text-sm font-medium">
                  Name
                  <input
                    className="input mt-1"
                    required
                    value={editName}
                    onChange={(event) => setEditName(event.target.value)}
                  />
                  {fieldErrors.name ? (
                    <span className="text-negative mt-1 block text-xs">{fieldErrors.name}</span>
                  ) : null}
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={editIsAdmin}
                    onChange={(event) => setEditIsAdmin(event.target.checked)}
                  />
                  Administrator rights
                </label>
                <div className="flex gap-3">
                  <button className="btn-primary" type="submit" disabled={busy}>
                    Save changes
                  </button>
                  <button className="btn-secondary" type="button" onClick={reset}>
                    Cancel
                  </button>
                </div>
              </form>
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <span className="font-medium">{role.name}</span>
                  {role.isAdmin ? (
                    <span className="bg-brand-soft text-ink ml-2 rounded-full px-2 py-0.5 text-xs font-medium">
                      Administrator
                    </span>
                  ) : null}
                  <p className="text-ink-muted text-sm">
                    {role.permissions.length === 0
                      ? 'No verification methods'
                      : `${role.permissions.length} verification method${role.permissions.length === 1 ? '' : 's'}`}
                    {' — edit them on the Permissions tab'}
                  </p>
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => {
                      reset()
                      setEditing(role)
                      setEditName(role.name)
                      setEditIsAdmin(role.isAdmin)
                    }}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className={
                      confirmingDelete === role.id ? 'btn bg-brand text-white' : 'btn-secondary'
                    }
                    disabled={busy}
                    onClick={() => void handleDelete(role)}
                  >
                    {confirmingDelete === role.id ? 'Confirm delete' : 'Delete'}
                  </button>
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
