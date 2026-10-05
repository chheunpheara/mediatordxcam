import { Outlet } from 'react-router-dom'

import { AppHeader } from '../components/AppHeader'

/**
 * Chrome for every authenticated route (D18): the header, then the page.
 *
 * A layout route rather than a header in each page, so sign-out and the
 * administration link cannot drift out of sync between them — and so a future
 * authenticated page inherits both for free.
 */
export function AuthenticatedLayout() {
  return (
    <>
      <AppHeader />
      <Outlet />
    </>
  )
}
