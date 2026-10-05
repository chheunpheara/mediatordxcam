import { Route, Routes } from 'react-router-dom'

import { routes } from './routes'
import { AuthenticatedLayout } from './AuthenticatedLayout'
import { RequireAdmin, RequireAuth } from '../features/auth/guards'
import { IdCardPage } from '../pages/IdCardPage'
import { LandingPage } from '../pages/LandingPage'
import { LoginPage } from '../pages/LoginPage'
import { AdminPage } from '../pages/AdminPage'
import { NotFoundPage } from '../pages/NotFoundPage'

/**
 * Route tree.
 *
 * Each page is a thin composition root — it owns layout and nothing else, so
 * business logic stays in `features/` (§6, §8).
 *
 * Sign-in gates the whole application (D18): everything except `/login` and
 * the not-found page is wrapped in `RequireAuth` (and `/admin` additionally in
 * `RequireAdmin`), under one shared authenticated layout that carries the
 * header. The backend enforces the same rules independently — this is which
 * pages *exist* for a visitor, not whether a request is permitted.
 */
export function AppRoutes() {
  return (
    <Routes>
      <Route path={routes.login} element={<LoginPage />} />
      <Route
        element={
          <RequireAuth>
            <AuthenticatedLayout />
          </RequireAuth>
        }
      >
        <Route path={routes.landing} element={<LandingPage />} />
        <Route path={routes.idCard} element={<IdCardPage />} />
        {/* Phase 8 — Passport OCR, reachable independently of the ID-card journey. */}
        <Route path={routes.passport} element={<IdCardPage />} />
        <Route
          path={routes.admin}
          element={
            <RequireAdmin>
              <AdminPage />
            </RequireAdmin>
          }
        />
      </Route>
      <Route path={routes.notFound} element={<NotFoundPage />} />
    </Routes>
  )
}
