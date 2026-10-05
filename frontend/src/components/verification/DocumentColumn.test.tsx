import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'

import { DocumentColumn } from './DocumentColumn'

/**
 * The uploaded-card column: in-column ± zoom, and click-to-open preview in a
 * modal (the card is too small in the column to read its fine print — §9).
 */

function renderCard(documentRef: string | null = 'art_0123456789abcdef') {
  return render(
    // The column links back to the landing route, so a router context is needed.
    <MemoryRouter>
      <DocumentColumn
        documentRef={documentRef}
        fileName="card.jpg"
        height={800}
        state="ready"
        width={1280}
      />
    </MemoryRouter>,
  )
}

function cardButton() {
  return screen.getByRole('button', { name: /open a larger preview/i })
}

describe('the in-column preview', () => {
  it('offers the modal preview and says so', () => {
    renderCard()

    expect(cardButton()).toBeInTheDocument()
    expect(screen.getByText(/click the card to open a larger preview/i)).toBeInTheDocument()
  })

  it('keeps the ± zoom scaling the in-column image', () => {
    renderCard()
    const image = screen.getByRole('img', { name: /original id card/i })

    expect(image.style.transform).toBe('scale(1)')

    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
    expect(image.style.transform).toBe('scale(1.5)')
    expect(screen.getByText('150%')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }))
    expect(image.style.transform).toBe('scale(1)')
  })

  it('stays quiet while there is no card to preview', () => {
    renderCard(null)

    expect(screen.queryByRole('button', { name: /open a larger preview/i })).not.toBeInTheDocument()
    expect(screen.queryByText(/click the card to open a larger preview/i)).not.toBeInTheDocument()
    expect(screen.getByText(/your document will appear here/i)).toBeInTheDocument()
  })
})

describe('the preview modal', () => {
  it('opens on click, showing the same artefact the column shows', () => {
    renderCard()

    fireEvent.click(cardButton())

    const dialog = screen.getByRole('dialog', { name: 'ID card preview' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    const image = within(dialog).getByRole('img')
    expect(image.getAttribute('src')).toContain('art_0123456789abcdef')
  })

  it('closes on the Close button and returns focus to the card', () => {
    renderCard()
    fireEvent.click(cardButton())

    fireEvent.click(screen.getByRole('button', { name: 'Close' }))

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(document.activeElement).toBe(cardButton())
  })

  it('closes on Escape', () => {
    renderCard()
    fireEvent.click(cardButton())

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(document.activeElement).toBe(cardButton())
  })

  it('closes on a backdrop click but not on a click inside the dialog', () => {
    renderCard()
    fireEvent.click(cardButton())
    const dialog = screen.getByRole('dialog', { name: 'ID card preview' })

    fireEvent.click(dialog)
    expect(screen.getByRole('dialog')).toBeInTheDocument()

    fireEvent.click(dialog.parentElement!)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
