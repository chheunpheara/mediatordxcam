import { useState } from 'react'
import { Outlet } from 'react-router-dom'

import { AppHeader } from '../components/AppHeader'
import { AppSidebar } from '../components/AppSidebar'

/**
 * Chrome for every authenticated route (D18) — as an "L".
 *
 * The vertical arm is the fixed sidebar: navigation and the local engine's
 * vitals, always in the same place so a teller never hunts for them. The
 * horizontal arm is the glass top bar: the account, the way out, and (below
 * `lg`) the button that slides the arm back in.
 *
 * The nav-open state lives here because both halves of the L touch it — the
 * bar presses the button, the sidebar takes the class, and the scrim between
 * them is the tap that changes its mind again.
 */
export function AuthenticatedLayout() {
  const [navOpen, setNavOpen] = useState(false)

  return (
    <div className="app-frame">
      <AppSidebar open={navOpen} />

      {navOpen ? (
        <button
          type="button"
          aria-label="Close navigation"
          className="app-scrim lg:hidden"
          onClick={() => setNavOpen(false)}
        />
      ) : null}

      <div className="app-frame__main">
        <AppHeader navOpen={navOpen} onToggleNav={() => setNavOpen((open) => !open)} />
        <div className="app-frame__body">
          <Outlet />
        </div>
      </div>
    </div>
  )
}
