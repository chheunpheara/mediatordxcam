import { afterEach, describe, expect, it } from 'vitest'

import { canPostToCore, readAuthUser, writeAuthUser } from './auth'
import { TEST_AUTH_USER } from '../test/fixtures'

/**
 * The local profile's two D19 decisions: whether to offer posting controls,
 * and what an older stored profile without `permissions` reads as. Both must
 * fail closed — a missing permission hides a button, never grants one.
 */

afterEach(() => {
  window.localStorage.clear()
})

describe('canPostToCore', () => {
  it('accepts the full six-permission set', () => {
    expect(canPostToCore(TEST_AUTH_USER)).toBe(true)
  })

  it('refuses a partial set — a Loan Officer never sees the posting controls', () => {
    expect(
      canPostToCore({ ...TEST_AUTH_USER, permissions: ['verify_user_info', 'verify_user_info_face'] }),
    ).toBe(false)
  })

  it('refuses nobody signed in', () => {
    expect(canPostToCore(null)).toBe(false)
  })
})

describe('readAuthUser', () => {
  it('reads a profile stored before permissions existed as no permissions', () => {
    // The shape a pre-D19 build left behind: written as an AuthUser back
    // then, so it round-trips through the same storage call.
    const legacy = { ...TEST_AUTH_USER } as Record<string, unknown>
    delete legacy.permissions
    writeAuthUser(legacy as unknown as typeof TEST_AUTH_USER)

    expect(readAuthUser()?.permissions).toEqual([])
    expect(canPostToCore(readAuthUser())).toBe(false)
  })
})
