import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'

import { DocumentColumn } from './DocumentColumn'

/**
 * Hover magnification on the uploaded card: the image grows around the point
 * under the pointer (the workspace's "read the small print" affordance), touch
 * is excluded, and the ± buttons keep working on top of it.
 */

function renderCard() {
  const view = render(
    // The column links back to the landing route, so a router context is needed.
    <MemoryRouter>
      <DocumentColumn
        documentRef="art_0123456789abcdef"
        fileName="card.jpg"
        height={800}
        state="ready"
        width={1280}
      />
    </MemoryRouter>,
  )

  const image = screen.getByRole('img', { name: /original id card/i })
  // jsdom has no layout engine: supply the geometry a browser would report, so
  // the pointer arithmetic under test receives real numbers.
  Object.defineProperties(image, {
    offsetLeft: { value: 10 },
    offsetTop: { value: 5 },
    offsetWidth: { value: 300 },
    offsetHeight: { value: 200 },
  })
  const frame = image.parentElement as HTMLDivElement
  vi.spyOn(frame, 'getBoundingClientRect').mockReturnValue({
    bottom: 260,
    height: 260,
    left: 0,
    right: 400,
    toJSON: () => ({}),
    top: 0,
    width: 400,
    x: 0,
    y: 0,
  })

  return { frame, image, view }
}

describe('hover zoom on the uploaded card', () => {
  it('magnifies around the pointer, keeping the hovered point in place', () => {
    const { frame, image } = renderCard()

    // Pointer at container (100, 100) → image coords (90, 95); scale 1 → 2.
    fireEvent.pointerMove(frame, { clientX: 100, clientY: 100, pointerType: 'mouse' })

    expect(image.style.transform).toBe('translate(-90px, -95px) scale(2)')
    expect(image.style.transformOrigin).toBe('0 0')
    // No transition mid-hover: the origin changes with the scale, and an
    // animated origin swap would shift the image instead of gliding.
    expect(image.className).not.toContain('transition-transform')
  })

  it('focuses the nearest edge when the pointer is over the frame, not the card', () => {
    const { frame, image } = renderCard()

    fireEvent.pointerMove(frame, { clientX: -50, clientY: -50, pointerType: 'mouse' })

    expect(image.style.transform).toBe('translate(0px, 0px) scale(2)')
  })

  it('leaves touch input alone — a tap must not leave the card stuck magnified', () => {
    const { frame, image } = renderCard()

    fireEvent.pointerMove(frame, { clientX: 100, clientY: 100, pointerType: 'touch' })

    expect(image.style.transform).toBe('scale(1)')
    expect(image.style.transformOrigin).toBe('')
  })

  it('returns to the resting view when the pointer leaves', () => {
    const { frame, image } = renderCard()

    fireEvent.pointerMove(frame, { clientX: 100, clientY: 100, pointerType: 'mouse' })
    fireEvent.pointerLeave(frame)

    expect(image.style.transform).toBe('scale(1)')
    expect(image.style.transformOrigin).toBe('')
    expect(image.className).toContain('transition-transform')
  })

  it('stacks with the ± zoom: manual 150% plus hover reads as 300%', () => {
    const { frame, image } = renderCard()

    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
    fireEvent.pointerMove(frame, { clientX: 100, clientY: 100, pointerType: 'mouse' })

    expect(image.style.transform).toBe('translate(-180px, -190px) scale(3)')
    expect(screen.getByText('150%')).toBeInTheDocument()
  })

  it('mentions the affordance once the card is on screen', () => {
    renderCard()

    expect(screen.getByText(/hover over the card to magnify/i)).toBeInTheDocument()
  })

  it('stays quiet while there is no card to magnify', () => {
    render(
      <MemoryRouter>
        <DocumentColumn documentRef={null} fileName="card.jpg" height={800} state="ready" width={1280} />
      </MemoryRouter>,
    )

    expect(screen.queryByText(/hover over the card to magnify/i)).not.toBeInTheDocument()
    expect(screen.getByText(/your document will appear here/i)).toBeInTheDocument()
  })
})
