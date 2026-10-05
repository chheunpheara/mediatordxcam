import { createContext, useContext } from 'react'
import type { AuthUser } from '../../lib/api'
import { clearAuthUser, readAuthUser, writeAuthUser } from '../../lib/auth'

/**
 * The auth context itself, with its hooks (D18).
 *
 * Kept in a module of its own so `AuthProvider.tsx` exports only a component
 * (fast refresh stays intact) while every consumer reads the same context —
 * guards, the header and the sign-in page.
 *
 * Two deliberate escapes for tests and provider-less renders: `useAuthUser`
 * falls back to reading the stored profile when no provider is mounted (the
 * existing page tests render `AppRoutes` bare), and `useAuthSetter` falls back
 * to writing storage directly. Production always mounts the provider — it sits
 * above `AppRoutes` in `App`.
 */

export interface AuthContextValue {
  readonly user: AuthUser | null
  readonly setUser: (user: AuthUser | null) => void
}

export const AuthContext = createContext<AuthContextValue | null>(null)

/**
 * The signed-in account, or null.
 *
 * With a provider it is the reactive state; without one it falls back to the
 * stored profile so a guard can decide before (or instead of) any request.
 */
export function useAuthUser(): AuthUser | null {
  const context = useContext(AuthContext)
  return context ? context.user : readAuthUser()
}

/** Replace or clear the signed-in account. Falls back to storage without a provider. */
export function useAuthSetter(): (user: AuthUser | null) => void {
  const context = useContext(AuthContext)
  return context ? context.setUser : setUserViaStorage
}

function setUserViaStorage(user: AuthUser | null): void {
  if (user) {
    writeAuthUser(user)
  } else {
    clearAuthUser()
  }
}
