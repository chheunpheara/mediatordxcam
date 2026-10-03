import { Route, Routes } from 'react-router-dom'

import { routes } from './routes'
import { IdCardPage } from '../pages/IdCardPage'
import { LandingPage } from '../pages/LandingPage'
import { NotFoundPage } from '../pages/NotFoundPage'

/**
 * Route tree.
 *
 * Each page is a thin composition root — it owns layout and nothing else, so
 * business logic stays in `features/` (§6, §8).
 */
export function AppRoutes() {
  return (
    <Routes>
      <Route path={routes.landing} element={<LandingPage />} />
      <Route path={routes.idCard} element={<IdCardPage />} />
      {/* Phase 8 — Passport OCR, reachable independently of the ID-card journey. */}
      <Route path={routes.passport} element={<IdCardPage />} />
      <Route path={routes.notFound} element={<NotFoundPage />} />
    </Routes>
  )
}