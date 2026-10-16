import { IdCardProcessingProvider } from '../features/id-card-processing/IdCardProcessingProvider'
import { DocumentSessionProvider } from '../features/document-upload/DocumentSessionProvider'
import { FaceCaptureProvider } from '../features/face-capture/FaceCaptureProvider'
import { AuthProvider } from '../features/auth/AuthProvider'
import { LivenessProvider } from '../features/liveness/LivenessProvider'

import { AppErrorBoundary } from './AppErrorBoundary'
import { AppRoutes } from './AppRoutes'

/**
 * Application shell.
 *
 * Deliberately minimal: the error boundary, the skip link and the route outlet.
 * Query cache machinery arrives with the phase that needs it, so nothing here
 * is a placeholder for unused machinery.
 *
 * The providers sit above `AppRoutes` on purpose. The document the user picks on
 * `/` has to outlive that page — `/id-card` is where it is consumed, so a provider
 * scoped to the landing page would unmount mid-navigation and take the `File` with
 * it. The processing result has the same lifetime requirement: §6 processes the
 * card and *then* navigates, so the result is produced on one route and displayed
 * on the next. Authentication is outermost of all (D18): the signed-in account
 * decides which routes render, so it must outlive every one of them.
 */
export function App() {
  return (
    <AppErrorBoundary>
      {/* The wash the shell's glass surfaces are glass over. Decorative. */}
      <div aria-hidden="true" className="app-ambient" />
      <a className="btn-primary sr-only-focusable" href="#main-content">
        Skip to main content
      </a>
      <AuthProvider>
        <DocumentSessionProvider>
          <IdCardProcessingProvider>
            <FaceCaptureProvider>
              <LivenessProvider>
                <div id="main-content">
                  <AppRoutes />
                </div>
              </LivenessProvider>
            </FaceCaptureProvider>
          </IdCardProcessingProvider>
        </DocumentSessionProvider>
      </AuthProvider>
    </AppErrorBoundary>
  )
}