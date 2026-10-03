import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'

import { App } from '@/app/App'
import { routes } from '@/app/routes'

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  )
}

describe('app shell', () => {
  it('renders the landing page at /', () => {
    renderAt(routes.landing)

    expect(
      screen.getByRole('heading', { name: 'Identity Verification', level: 1 }),
    ).toBeInTheDocument()
  })

  it('renders the workspace at /id-card', () => {
    renderAt(routes.idCard)

    expect(
      screen.getByRole('heading', { name: 'Verification workspace', level: 1 }),
    ).toBeInTheDocument()
  })

  it('renders a recoverable not-found page for an unknown path', () => {
    renderAt('/nowhere')

    expect(screen.getByRole('alert')).toHaveTextContent(/could not be found/i)
    expect(screen.getByRole('link', { name: /back to start/i })).toBeInTheDocument()
  })

  it('exposes a skip link for keyboard users', () => {
    renderAt(routes.landing)

    expect(screen.getByRole('link', { name: /skip to main content/i })).toBeInTheDocument()
  })

  it('offers no bare link to the workspace from the landing page', () => {
    renderAt(routes.landing)

    // Phase 2: the workspace is reached by choosing a document, not by following
    // a link — otherwise the user arrives with nothing to verify.
    expect(
      screen.queryByRole('link', { name: /verification workspace/i }),
    ).not.toBeInTheDocument()
    expect(screen.getByLabelText('Choose an ID Card image')).toBeInTheDocument()
  })
})