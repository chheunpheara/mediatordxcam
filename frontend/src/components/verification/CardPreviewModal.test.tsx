import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { CardPreviewModal } from './CardPreviewModal'

/**
 * The full-screen card preview: focus lands on Close, Escape / backdrop /
 * Close all exit, and clicks inside the dialog never fall through to the
 * backdrop (§9's "read the small print" surface).
 */

function renderModal(onClose = vi.fn()) {
  render(
    <CardPreviewModal alt="Original ID card uploaded as card.jpg" onClose={onClose} src="/api/v1/kyc/artifacts/art_1" />,
  )
  return { onClose }
}

describe('CardPreviewModal', () => {
  it('shows the card large, in a labelled modal dialog', () => {
    renderModal()

    const dialog = screen.getByRole('dialog', { name: 'ID card preview' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    const image = within(dialog).getByRole('img', { name: /original id card/i })
    expect(image.getAttribute('src')).toContain('art_1')
    expect(image.style.width).toBe('100%')
  })

  it('moves focus to Close on open', () => {
    renderModal()

    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }))
  })

  it('exits through Close, Escape and the backdrop — never through the dialog itself', () => {
    const { onClose } = renderModal()
    const dialog = screen.getByRole('dialog', { name: 'ID card preview' })

    fireEvent.click(dialog)
    expect(onClose).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledTimes(1)

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(2)

    fireEvent.click(dialog.parentElement!)
    expect(onClose).toHaveBeenCalledTimes(3)
  })

  it('zooms by growing the image width, so the scroll view can pan past the frame', () => {
    renderModal()
    const image = within(screen.getByRole('dialog')).getByRole('img')

    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
    expect(image.style.width).toBe('150%')
    expect(screen.getByText('150%')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }))
    expect(image.style.width).toBe('100%')
    expect(screen.getByRole('button', { name: 'Zoom out' })).toBeDisabled()
  })
})
