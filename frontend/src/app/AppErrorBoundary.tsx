import type { PropsWithChildren } from 'react'

import { ErrorBoundary } from './ErrorBoundary'

/**
 * Global error boundary.
 *
 * A render crash must not present a blank page or a stack trace. The user gets a
 * plain apology and a way to start again; the technical detail goes to the
 * console for developers only, and contains no user data (§24, §29).
 */
export function AppErrorBoundary({ children }: PropsWithChildren) {
  return <ErrorBoundary fallbackTitle="Something went wrong">{children}</ErrorBoundary>
}