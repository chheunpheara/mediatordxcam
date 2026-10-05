import '@testing-library/jest-dom/vitest'

import { cleanup } from '@testing-library/react'
import { afterEach, beforeEach } from 'vitest'

import { clearAuthUser, writeAuthUser } from '@/lib/auth'
import { TEST_AUTH_USER } from './fixtures'

/**
 * Every test runs as a signed-in administrator (D18).
 *
 * The whole application sits behind the sign-in guard, so without a seeded
 * profile each of the existing page tests would render the login page instead
 * of the page it is about. Seeding here — rather than wrapping every render in
 * a provider — also matches how the guard decides: it falls back to reading
 * this same stored profile, which is what production does on first paint.
 */
beforeEach(() => {
  writeAuthUser(TEST_AUTH_USER)
})

afterEach(() => {
  cleanup()
  try {
    window.sessionStorage.clear()
  } catch {
    // ignore
  }
  clearAuthUser()
})
