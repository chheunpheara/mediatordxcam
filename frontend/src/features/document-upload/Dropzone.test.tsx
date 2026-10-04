import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { Dropzone } from './Dropzone'
import { ACCEPTED_FILE_EXTENSIONS, MESSAGES } from './validation'

function getInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]')
  if (!input) throw new Error('file input not found')
  return input
}

describe('Dropzone', () => {
  it('exposes a file input named for assistive tech', () => {
    render(<Dropzone onSelect={vi.fn()} />)

    const input = screen.getByLabelText('Choose an ID Card image')
    expect(input).toHaveAttribute('type', 'file')
    // §6: JPG, JPEG, PNG and WebP.
    expect(input).toHaveAttribute('accept', '.jpg,.jpeg,.png,.webp')
    expect(input).toHaveAttribute('accept', ACCEPTED_FILE_EXTENSIONS)
  })

  it('is reachable by keyboard, not pointer-only', async () => {
    const onSelect = vi.fn()
    render(<Dropzone onSelect={onSelect} />)

    await userEvent.tab()
    expect(screen.getByLabelText('Choose an ID Card image')).toHaveFocus()
  })

  it('reports a file chosen through the input', async () => {
    const onSelect = vi.fn()
    const { container } = render(<Dropzone onSelect={onSelect} />)
    const file = new File(['x'], 'card.jpg', { type: 'image/jpeg' })

    await userEvent.upload(getInput(container), file)

    expect(onSelect).toHaveBeenCalledWith(file)
  })

  it('reports a file dropped onto the panel', () => {
    const onSelect = vi.fn()
    render(<Dropzone onSelect={onSelect} />)
    const file = new File(['x'], 'card.png', { type: 'image/png' })

    const zone = screen.getByText('Drop your ID Card here').closest('div')!
    const dataTransfer = { files: [file], items: [{ kind: 'file' }] }

    fireEvent.dragEnter(zone, { dataTransfer })
    fireEvent.dragOver(zone, { dataTransfer })
    fireEvent.drop(zone, { dataTransfer })

    expect(onSelect).toHaveBeenCalledWith(file)
  })

  it('marks the input invalid and announces the error', () => {
    render(<Dropzone onSelect={vi.fn()} error={MESSAGES.tooLarge} />)

    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent(MESSAGES.tooLarge)

    const input = screen.getByLabelText('Choose an ID Card image')
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(input).toHaveAttribute('aria-describedby', alert.id)
  })

  it('is inert while disabled', () => {
    const onSelect = vi.fn()
    const { container } = render(<Dropzone onSelect={onSelect} disabled />)

    expect(getInput(container)).toBeDisabled()
    expect(screen.getByText('Checking image…')).toBeInTheDocument()
    expect(onSelect).not.toHaveBeenCalled()
  })
})