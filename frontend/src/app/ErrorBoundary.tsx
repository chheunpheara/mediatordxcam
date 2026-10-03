import { Component, type ErrorInfo, type PropsWithChildren, type ReactNode } from 'react'

interface ErrorBoundaryProps extends PropsWithChildren {
  /** Heading shown to the user. Written in user language, not developer language. */
  fallbackTitle: string
  /** Optional developer note. Never rendered in production builds. */
  fallbackDetail?: ReactNode
}

interface ErrorBoundaryState {
  error: Error | null
}

/**
 * Catches render errors anywhere below it.
 *
 * `getDerivedStateFromError` records the error for the fallback UI. Nothing about
 * the error is rendered to the user: a stack trace or a component name is
 * technical text, which §24 forbids in the product UI.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Developer console only — never the user's screen.
    console.error('render error', { message: error.message, component: info.componentStack })
  }

  override render(): ReactNode {
    const { error } = this.state
    const { children, fallbackTitle, fallbackDetail } = this.props

    if (!error) return children

    return (
      <main className="flex min-h-screen items-center justify-center p-6">
        <div className="card w-full max-w-md p-6 text-center" role="alert">
          <h1 className="text-lg font-semibold">{fallbackTitle}</h1>
          <p className="text-ink-muted mt-2 text-sm">
            Please go back and try again. If this keeps happening, contact support.
          </p>
          {import.meta.env.DEV && fallbackDetail ? (
            <pre className="text-ink-subtle mt-4 overflow-x-auto text-left text-xs">
              {fallbackDetail}
            </pre>
          ) : null}
          <button type="button" className="btn-primary mt-6 w-full" onClick={() => this.reset()}>
            Try again
          </button>
        </div>
      </main>
    )
  }

  private reset(): void {
    this.setState({ error: null })
  }
}