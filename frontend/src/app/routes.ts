/**
 * Route table.
 *
 * Route paths are declared once here so a link, a redirect and a test all agree
 * on the same string. §6 defines two primary pages; `/id-card/passport` exists
 * because API 6 must be reachable independently of the ID-card journey (Phase 8).
 */
export const routes = {
  landing: '/',
  idCard: '/id-card',
  passport: '/id-card/passport',
  notFound: '*',
} as const

export type RoutePath = (typeof routes)[keyof typeof routes]