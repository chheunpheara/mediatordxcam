import { useState } from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { makeVerifyResult } from '@/test/fixtures'
import type { VerifyResponse } from '@/lib/api'
import { ExportModal } from './ExportModal'
import { buildCsv, exportColumns, exportRecord } from './exportData'

/**
 * The export dialog (D17): every column starts selected so an untouched
 * download carries all of the available data, the preview shows everything
 * the session verified, and the three formats write the same keys.
 */

function session(): readonly VerifyResponse[] {
  return [
    makeVerifyResult(),
    makeVerifyResult({ method: 'verify_user_info_face', face: { required: true, verified: true } }),
  ]
}

let lastBlob: Blob | null = null

beforeEach(() => {
  lastBlob = null
  vi.stubGlobal(
    'URL',
    Object.assign(vi.fn(), {
      createObjectURL: vi.fn((blob: Blob) => {
        lastBlob = blob
        return 'blob:mock/export'
      }),
      revokeObjectURL: vi.fn(),
    }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function userEvent() {
  return import('@testing-library/user-event').then((module) => module.default)
}

async function download() {
  const click = await userEvent()
  await click.click(screen.getByRole('button', { name: 'Download file' }))
  await waitFor(() => expect(lastBlob).toBeTruthy())
  return lastBlob!
}

describe('ExportModal', () => {
  it('shows all available verified data', () => {
    render(<ExportModal history={session()} onClose={vi.fn()} />)

    const dialog = screen.getByRole('dialog', { name: 'Export verified data' })
    const table = within(dialog).getByRole('table')
    expect(within(table).getByText('National ID')).toBeInTheDocument()
    expect(within(table).getByText('123456789')).toBeInTheDocument()
    expect(within(table).getByText('Face verification')).toBeInTheDocument()
    expect(within(table).getByText('Passed')).toBeInTheDocument()
    expect(within(table).getByText('verify_user_info_face')).toBeInTheDocument()
    expect(within(table).getByText('success')).toBeInTheDocument()
  })

  it('selects every column by default', () => {
    render(<ExportModal history={session()} onClose={vi.fn()} />)

    const boxes = screen.getAllByRole('checkbox')
    expect(boxes).toHaveLength(exportColumns(session()).length)
    for (const box of boxes) expect(box).toBeChecked()
  })

  it('downloads every column untouched — the default is all of them (D17)', async () => {
    render(<ExportModal history={session()} onClose={vi.fn()} />)

    const click = await userEvent()
    await click.click(screen.getByRole('radio', { name: 'CSV (.csv)' }))

    // Blob.text() decodes UTF-8 and strips the BOM, so read the raw bytes: a
    // leading EF BB BF is what makes Excel read the Khmer names correctly.
    const bytes = new Uint8Array(await (await download()).arrayBuffer())
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes)
    expect(text).toBe(
      buildCsv(
        exportColumns(session()).map((column) => column.key),
        exportRecord(session()),
      ),
    )
  })

  it('drops exactly the columns the user deselected', async () => {
    render(<ExportModal history={session()} onClose={vi.fn()} />)

    const click = await userEvent()
    await click.click(screen.getByLabelText('National ID'))
    await click.click(screen.getByRole('radio', { name: 'JSON (.json)' }))

    const parsed = JSON.parse(await (await download()).text()) as Record<string, string>
    expect(parsed).not.toHaveProperty('nationalId')
    expect(parsed).toHaveProperty('gender')
    expect(parsed).toHaveProperty('faceCheck', 'passed')
  })

  it('refuses to download when no column is left selected', async () => {
    render(<ExportModal history={session()} onClose={vi.fn()} />)

    const click = await userEvent()
    for (const box of screen.getAllByRole('checkbox')) {
      await click.click(box)
    }

    expect(screen.getByRole('button', { name: 'Download file' })).toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent('Select at least one column to export.')
  })

  it('closes on Close, Escape and a backdrop click, calling back each time', async () => {
    const onClose = vi.fn()
    render(<ExportModal history={session()} onClose={onClose} />)

    await waitFor(() => expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus())
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('presentation'))
    expect(onClose).toHaveBeenCalledTimes(2)

    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledTimes(3)
  })

  it('gives focus back to the button that opened it', async () => {
    function Harness() {
      const [open, setOpen] = useState(false)
      return (
        <>
          <button onClick={() => setOpen(true)} type="button">
            Export
          </button>
          {open ? <ExportModal history={session()} onClose={() => setOpen(false)} /> : null}
        </>
      )
    }
    render(<Harness />)

    const opener = screen.getByRole('button', { name: 'Export' })
    opener.focus()
    const click = await userEvent()
    await click.click(opener)

    await waitFor(() => expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus())

    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(opener).toHaveFocus())
  })
})
