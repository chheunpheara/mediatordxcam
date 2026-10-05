import { useState } from 'react'

import { ApiError, setRolePermissions } from '../../lib/api'
import type { AdminRole, PermissionItem, VerificationMethodId } from '../../lib/api'

/**
 * The permission matrix (D18): roles across the top, the six methods down the
 * side, one checkbox per intersection.
 *
 * The six rows come from the server's catalogue, labelled exactly as the
 * method cards label them (§10) — nothing here knows what "API 4" is, so a
 * seventh method would appear on its own. Editing is draft-then-save: the
 * checkboxes move freely, and one Save sends each *changed* role's full set.
 * The server replaces a role's set wholesale (`PUT .../permissions`), so the
 * payload is always everything the row now shows, not a diff.
 *
 * The draft is stored as *overrides on top of the server's roles*, not as a
 * copy of them: when the roles prop reloads after any mutation, the overrides
 * still refer to their roles by id and a successful save clears them. No
 * effect re-syncs state — the grid renders whatever base plus overrides say,
 * and after a save the base is the only thing left.
 */
type Overrides = Readonly<Record<string, readonly VerificationMethodId[]>>

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const sortedA = [...a].sort()
  const sortedB = [...b].sort()
  return sortedA.every((value, index) => value === sortedB[index])
}

export function PermissionsPanel({
  roles,
  permissions,
  onRolesChanged,
}: {
  readonly roles: readonly AdminRole[]
  readonly permissions: readonly PermissionItem[]
  readonly onRolesChanged: () => void
}) {
  const [overrides, setOverrides] = useState<Overrides>({})
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const shown = (role: AdminRole): readonly VerificationMethodId[] =>
    overrides[role.id] ?? role.permissions

  const changedRoles = roles.filter((role) => !sameSet(shown(role), role.permissions))

  const toggle = (role: AdminRole, key: VerificationMethodId) => {
    setSaved(false)
    setError(null)
    const current = shown(role)
    setOverrides({
      ...overrides,
      [role.id]: current.includes(key)
        ? current.filter((value) => value !== key)
        : [...current, key],
    })
  }

  const handleSave = async () => {
    setSaving(true)
    setError(null)
    try {
      for (const role of changedRoles) {
        await setRolePermissions(role.id, shown(role))
      }
      // The overrides were the change; with them cleared the grid shows
      // exactly what the server just confirmed.
      setOverrides({})
      onRolesChanged()
      setSaved(true)
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : 'Something went wrong. Please try again.',
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="card p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Permissions</h2>
          <p className="text-ink-muted text-sm">
            Choose which verification methods each role may run. Changes apply to everyone holding
            that role.
          </p>
        </div>
        <button
          type="button"
          className="btn-primary"
          disabled={saving || changedRoles.length === 0}
          onClick={() => void handleSave()}
        >
          {saving ? 'Saving…' : 'Save changes'}
        </button>
      </div>

      {saved ? (
        <p role="status" className="text-positive mt-4 text-sm font-medium">
          Permissions saved.
        </p>
      ) : null}
      {error ? (
        <p
          role="alert"
          className="border-negative bg-negative-soft text-negative mt-4 rounded-lg border px-4 py-3 text-sm font-medium"
        >
          {error}
        </p>
      ) : null}

      <div className="overflow-x-auto">
        <table className="mt-4 w-full text-left text-sm">
          <thead>
            <tr className="text-ink-muted border-border border-b">
              <th scope="col" className="py-2 pr-4 font-medium">
                Verification method
              </th>
              {roles.map((role) => (
                <th key={role.id} scope="col" className="py-2 px-2 text-center font-medium">
                  {role.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {permissions.map((permission) => (
              <tr key={permission.key} className="border-border border-b last:border-b-0">
                <th scope="row" className="py-3 pr-4 font-normal">
                  <span className="block font-medium">{permission.label}</span>
                  <span className="text-ink-subtle block text-xs">{permission.officialName}</span>
                </th>
                {roles.map((role) => {
                  const checked = shown(role).includes(permission.key)
                  return (
                    <td key={role.id} className="py-3 px-2 text-center">
                      <input
                        type="checkbox"
                        checked={checked}
                        aria-label={`${permission.label} for ${role.name}`}
                        onChange={() => toggle(role, permission.key)}
                      />
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {roles.length === 0 ? (
        <p className="text-ink-muted mt-4 text-sm" role="status">
          No roles exist yet — create one on the Roles tab.
        </p>
      ) : null}
    </div>
  )
}
