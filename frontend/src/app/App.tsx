import { IdCardProcessingProvider } from '../features/id-card-processing/IdCardProcessingProvider'
import { DocumentSessionProvider } from '../features/document-upload/DocumentSessionProvider'
import { FaceCaptureProvider } from '../features/face-capture/FaceCaptureProvider'

import { AppErrorBoundary } from './AppErrorBoundary'
import { AppRoutes } from './AppRoutes'

/**
 * Application shell.
 *
 * Deliberately minimal: the error boundary, the skip link and the route outlet.
 * Auth, query cache and session providers arrive with the phase that needs them,
 * so nothing here is a placeholder for unused machinery.
 *
 * Both providers sit above `AppRoutes` on purpose. The document the user picks on
 * `/` has to outlive that page — `/id-card` is where it is consumed, so a provider
 * scoped to the landing page would unmount mid-navigation and take the `File` with
 * it. The processing result has the same lifetime requirement: §6 processes the
 * card and *then* navigates, so the result is produced on one route and displayed
 * on the next.
 */
export function App() {
  return (
    <AppErrorBoundary>
      <a className="btn-primary sr-only-focusable" href="#main-content">
        Skip to main content
      </a>
      <DocumentSessionProvider>
        <IdCardProcessingProvider>
          <FaceCaptureProvider>
            <div id="main-content">
              <AppRoutes />
            </div>
          </FaceCaptureProvider>
        </IdCardProcessingProvider>
      </DocumentSessionProvider>
    </AppErrorBoundary>
  )
}