import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'

import type { AuthUser } from '../../lib/api'
import { AUTH_EXPIRED_EVENT, clearAuthUser, readAuthUser, writeAuthUser } from '../../lib/auth'
import { AuthContext } from './authContext'

/**
 * Signed-in account state (D18).
 *
 * The provider owns one piece of state — who is signed in — and two ways to
 * change it: `setUser` after a successful sign-in, and automatic clearing when
 * any API call reports the session gone (the `AUTH_EXPIRED_EVENT` that
 * `lib/api.ts` dispatches on a 401). Everything else, including permission
 * decisions, stays server-side: this value decides what to *show*, never what
 * is *allowed*.
 */
export function AuthProvider({ children }: { readonly children: ReactNode }) {
  const [user, setUserState] = useState<AuthUser | null>(() => readAuthUser())

  const setUser = useCallback((next: AuthUser | null) => {
    if (next) {
      writeAuthUser(next)
    } else {
      clearAuthUser()
    }
    setUserState(next)
  }, [])

  useEffect(() => {
    const onExpired = () => setUser(null)
    window.addEventListener(AUTH_EXPIRED_EVENT, onExpired)
    return () => window.removeEventListener(AUTH_EXPIRED_EVENT, onExpired)
  }, [setUser])

  const value = useMemo(() => ({ user, setUser }), [user, setUser])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
