import { useCallback, useEffect, useState } from 'react'

import { AuditPanel } from '../features/admin/AuditPanel'
import { PermissionsPanel } from '../features/admin/PermissionsPanel'
import { RolesPanel } from '../features/admin/RolesPanel'
import { UsersPanel } from '../features/admin/UsersPanel'
import { ApiError, fetchPermissions, fetchRoles } from '../lib/api'
import type { AdminRole, PermissionItem } from '../lib/api'

/**
 * Account administration (D18) and the audit trail (D25): four tabs, one page.
 *
 * Roles and the six permissions are loaded here once and passed down, because
 * two of the tabs need them and a tab switch should not re-ask — the users
 * form picks roles to assign, the matrix needs both sides of it. Accounts are
 * fetched by their own tab, which is the only panel that renders them. The
 * audit tab needs neither list, so it renders before they arrive instead of
 * waiting behind the accounts' own loading gate.
 *
 * Every mutation happens inside a panel and reports back through
 * `onRolesChanged`, so a created or renamed role appears in the matrix without
 * this page knowing what the panel did.
 */
type Tab = 'users' | 'roles' | 'permissions' | 'audit'

const TABS: readonly { readonly id: Tab; readonly label: string }[] = [
  { id: 'users', label: 'Users' },
  { id: 'roles', label: 'Roles' },
  { id: 'permissions', label: 'Permissions' },
  { id: 'audit', label: 'Audit trail' },
]

export function AdminPage() {
  const [tab, setTab] = useState<Tab>('users')
  const [roles, setRoles] = useState<readonly AdminRole[] | null>(null)
  const [permissions, setPermissions] = useState<readonly PermissionItem[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const loadRoles = useCallback(async () => {
    try {
      setRoles(await fetchRoles())
      setLoadError(null)
    } catch (caught) {
      setLoadError(messageOf(caught))
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [loadedRoles, loadedPermissions] = await Promise.all([fetchRoles(), fetchPermissions()])
        if (cancelled) return
        setRoles(loadedRoles)
        setPermissions(loadedPermissions)
      } catch (caught) {
        if (!cancelled) setLoadError(messageOf(caught))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <main className="mx-auto w-full max-w-5xl p-4 sm:p-6">
      <h1 className="text-2xl font-semibold">Administration</h1>
      <p className="text-ink-muted mt-2 text-sm">
        Manage who can sign in, which roles exist, and which verification methods each role may
        run — then review everything that happened in the audit trail.
      </p>

      <div className="mt-6 flex flex-wrap gap-2" role="tablist" aria-label="Administration sections">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            id={`admin-tab-${entry.id}`}
            aria-selected={tab === entry.id}
            aria-controls={`admin-panel-${entry.id}`}
            className={
              tab === entry.id
                ? 'btn bg-brand text-white'
                : 'btn border-border-strong bg-surface-raised text-ink hover:bg-surface-sunken'
            }
            onClick={() => setTab(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </div>

      {loadError ? (
        <p
          role="alert"
          className="border-negative bg-negative-soft text-negative mt-4 rounded-lg border px-4 py-3 text-sm font-medium"
        >
          {loadError}
        </p>
      ) : null}

      <div
        role="tabpanel"
        id={`admin-panel-${tab}`}
        aria-labelledby={`admin-tab-${tab}`}
        className="mt-4"
      >
        {tab === 'audit' ? (
          <AuditPanel />
        ) : !roles || !permissions ? (
          <p className="text-ink-muted text-sm" role="status">
            Loading accounts…
          </p>
        ) : tab === 'users' ? (
          <UsersPanel roles={roles} />
        ) : tab === 'roles' ? (
          <RolesPanel roles={roles} onRolesChanged={() => void loadRoles()} />
        ) : (
          <PermissionsPanel
            roles={roles}
            permissions={permissions}
            onRolesChanged={() => void loadRoles()}
          />
        )}
      </div>
    </main>
  )
}

function messageOf(caught: unknown): string {
  return caught instanceof ApiError
    ? caught.message
    : 'Something went wrong. Please try again.'
}
