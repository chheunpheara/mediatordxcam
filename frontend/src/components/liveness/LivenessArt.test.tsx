import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { LivenessArt } from './LivenessArt'

describe('LivenessArt', () => {
  it('carries the greeting as its accessible name and keeps its parts decorative', () => {
    render(<LivenessArt />)

    const art = screen.getByRole('img', { name: 'Welcome' })
    expect(art).toBeInTheDocument()

    const parts = art.querySelectorAll('span')
    expect(parts.length).toBeGreaterThan(0)
    for (const part of parts) {
      expect(part).toHaveAttribute('aria-hidden', 'true')
    }
  })
})
