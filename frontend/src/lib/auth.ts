import type { AuthUser } from './api'

/**
 * Local mirror of the signed-in account (D18).
 *
 * The session itself is an `HttpOnly` cookie the browser holds and this code
 * cannot read — deliberately, so a script cannot steal it. What is stored here
 * is only the account's profile: enough to render "signed in as …", to let the
 * route guards decide before the first request, and to know whether to offer
 * the administration area. The server re-derives every permission from the
 * session on each call; a stale copy here can hide a control, never grant one.
 *
 * Storage follows `session.ts`'s rule: a full or unavailable store must not
 * break the UI, so every access is wrapped and every failure answers "nobody".
 */

const STORAGE_KEY = 'camdx:auth'

/**
 * Fired (as a window event) when any API call answers 401, wherever that
 * response is noticed — `lib/api.ts` dispatches it, `AuthProvider` listens.
 * This decouples "the session died" from React: the api layer must not import
 * the component tree, and the provider must not know about `fetch`.
 */
export const AUTH_EXPIRED_EVENT = 'camdx:auth-expired'

export function readAuthUser(): AuthUser | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<AuthUser>
    if (typeof parsed !== 'object' || parsed === null || typeof parsed.email !== 'string') {
      return null
    }
    return parsed as AuthUser
  } catch {
    return null
  }
}

export function writeAuthUser(user: AuthUser): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(user))
  } catch {
    // A full store leaves the cookie session intact; the UI just starts fresh
    // on the next load.
  }
}

export function clearAuthUser(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY)
  } catch {
    // ignore
  }
}
