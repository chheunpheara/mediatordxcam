/**
 * Which room this browser's teller panels join (Phase 7): the counter's
 * standby screen, or the unique link minted for the customer in front of you.
 *
 * The choice is the officer's, made in the Liveness Links dialog, and it
 * lives in `localStorage` — it belongs to the counter's browser, needs no
 * round-trip, and survives reloads. It defaults to `unique`, so an
 * installation that has never seen the dialog keeps joining the link it mints.
 *
 * Panels re-read the mode when they mount and whenever the dialog changes it
 * (`SCREEN_MODE_CHANGED`), so switching screens moves an open panel too.
 */

import { fetchActiveLivenessLink, fetchLivenessPageSettings } from '../../lib/api'

/** Standby screen = the one permanent room; unique link = this customer only. */
export type ScreenMode = 'static' | 'unique'

/** Why there is nothing to join. Each has its own sentence below. */
export type RoomReason = 'static-off' | 'no-link' | 'unreachable'

/** The room to open, or `null` with the reason nothing can be opened. */
export type DisplayRoom =
  | { readonly token: string; readonly mode: ScreenMode; readonly reason: null }
  | { readonly token: null; readonly mode: ScreenMode; readonly reason: RoomReason }

const STORAGE_KEY = 'camdx.screenMode'

/** Dispatched after the mode changes, so open panels re-join the new room. */
export const SCREEN_MODE_CHANGED = 'camdx:screen-mode-changed'

/** The screen this browser's teller panels join. */
export function readScreenMode(): ScreenMode {
  return window.localStorage.getItem(STORAGE_KEY) === 'static' ? 'static' : 'unique'
}

/** Choose a screen and tell every open panel to follow it. */
export function writeScreenMode(mode: ScreenMode): void {
  window.localStorage.setItem(STORAGE_KEY, mode)
  window.dispatchEvent(new Event(SCREEN_MODE_CHANGED))
}

/** Forget the choice — for tests, and for anything that must start fresh. */
export function resetScreenMode(): void {
  window.localStorage.removeItem(STORAGE_KEY)
}

/**
 * The room to join right now.
 *
 * Standby mode needs the counter's switch to be on; unique mode needs an
 * in-use link. Nothing else is consulted: a stale link in the list is not a
 * room, and the standby URL is not somebody's link.
 */
export async function fetchDisplayRoom(): Promise<DisplayRoom> {
  const mode = readScreenMode()
  if (mode === 'static') {
    const standby = await fetchLivenessPageSettings()
    return standby.enabled
      ? { token: standby.sessionId, mode, reason: null }
      : { token: null, mode, reason: 'static-off' }
  }
  const link = await fetchActiveLivenessLink()
  return link !== null && link.token !== null
    ? { token: link.token, mode, reason: null }
    : { token: null, mode, reason: 'no-link' }
}

/** What the panel says where there is no room to join. */
export function displayRoomMessage(reason: RoomReason): string {
  switch (reason) {
    case 'static-off':
      return 'The standby screen is turned off. Turn it on in Liveness Links, or switch to a unique link.'
    case 'unreachable':
      return 'Could not reach the server to find the customer display. Please try again.'
    default:
      return 'No liveness link is open yet. Create one to reach the customer screen.'
  }
}
