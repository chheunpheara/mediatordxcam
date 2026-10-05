import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { UploadDataModal } from './UploadDataModal'
import { bodyOf, urlOf } from '../../test/fixtures'

/**
 * The upload dialog (D23): a picked file reports its shape in the browser,
 * the mapping step pairs columns with the nine §14 fields (one column fills
 * one field, the saved default pre-applies), review shows exactly what will
 * be sent, and submitting posts the mapped values — remembering the mapping
 * only while the reminder is ticked.
 */

const CSV = 'ID,Name,DOB\n111,Chann,2000-01-01\n222,,2001-02-02\n'

interface StubOptions {
  readonly mapping?: Readonly<Record<string, string>> | null
  readonly create?: { readonly payload: unknown; readonly status?: number }
}

/**
 * One fetch stub answering by URL and method: the saved mapping (GET), its
 * replacement (PUT) and the submission (POST) each behave on their own, so a
 * test can let one fail while the others succeed.
 */
function stubRoutes(options: StubOptions = {}) {
  const mock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = urlOf(input)
    const method = init?.method ?? 'GET'
    let payload: unknown
    let status = 200
    if (url.includes('/records/mappings') && method === 'PUT') {
      payload = bodyOf<{ mapping: unknown }>([input, init])
    } else if (url.includes('/records/mappings')) {
      payload = { mapping: options.mapping ?? null }
    } else if (method === 'POST') {
      payload = options.create?.payload ?? { records: [] }
      status = options.create?.status ?? 201
    } else {
      payload = { records: [], total: 0 }
    }
    return Promise.resolve(
      new Response(JSON.stringify(payload), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
  })
  vi.stubGlobal('fetch', mock)
  return mock
}

afterEach(() => {
  vi.unstubAllGlobals()
})

function pickFile(container: HTMLElement, name = 'people.csv', content = CSV): void {
  const input = container.querySelector('input[type="file"]')
  if (!input) throw new Error('no file input')
  const file = new File([content], name, { type: 'text/csv' })
  fireEvent.change(input, { target: { files: [file] } })
}

async function toMapStep(container: HTMLElement): Promise<void> {
  pickFile(container)
  // Wait for the browser-side parse before advancing — the forward button
  // exists (disabled) long before the file has been read.
  await screen.findByText(/rows · \d+ columns/)
  fireEvent.click(screen.getByRole('button', { name: 'Map fields' }))
  await screen.findByRole('region', { name: 'Map fields' })
}

function choose(field: string, column: string): void {
  fireEvent.change(screen.getByRole('combobox', { name: field }), {
    target: { value: column },
  })
}

describe('UploadDataModal', () => {
  it('opens with focus on Close and closes on Escape', () => {
    stubRoutes()
    const onClose = vi.fn()

    render(<UploadDataModal onClose={onClose} />)

    expect(screen.getByRole('dialog', { name: 'Upload records' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })

  it('reads a picked file in the browser and reports its shape', async () => {
    stubRoutes()
    const { container } = render(<UploadDataModal onClose={() => undefined} />)

    pickFile(container)

    expect(await screen.findByText('people.csv — 2 rows · 3 columns')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Map fields' })).toBeEnabled()
  })

  it("shows the parser's sentence for a file it cannot read", async () => {
    stubRoutes()
    const { container } = render(<UploadDataModal onClose={() => undefined} />)

    pickFile(container, 'notes.txt')

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Please upload a CSV or Excel file (.csv, .xlsx, .xls).',
    )
    expect(screen.getByRole('button', { name: 'Map fields' })).toBeDisabled()
  })

  it('refuses to reach the review step with nothing mapped', async () => {
    stubRoutes()
    const { container } = render(<UploadDataModal onClose={() => undefined} />)

    await toMapStep(container)

    expect(screen.getByRole('button', { name: 'Next: Review' })).toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent('0 of 9 fields mapped.')
    expect(screen.getByRole('status')).toHaveTextContent('Map at least one field to continue.')
  })

  it('maps a column to a system field and previews its first value', async () => {
    stubRoutes()
    const { container } = render(<UploadDataModal onClose={() => undefined} />)

    await toMapStep(container)
    choose('National ID', 'ID')

    expect(screen.getByRole('combobox', { name: 'National ID' })).toHaveValue('ID')
    expect(screen.getByText('e.g. 111')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('1 of 9 fields mapped.')
    expect(screen.getByRole('button', { name: 'Next: Review' })).toBeEnabled()
  })

  it('applies the saved mapping when the columns line up', async () => {
    stubRoutes({ mapping: { ID: 'nationalId', Name: 'firstNameEnglish' } })
    const { container } = render(<UploadDataModal onClose={() => undefined} />)

    await toMapStep(container)

    expect(screen.getByText('Your saved mapping was applied.')).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'National ID' })).toHaveValue('ID')
    expect(screen.getByRole('combobox', { name: 'First Name — English' })).toHaveValue('Name')
  })

  it('lets one column fill only one field', async () => {
    stubRoutes()
    const { container } = render(<UploadDataModal onClose={() => undefined} />)

    await toMapStep(container)
    choose('National ID', 'ID')

    const dateOfBirth = screen.getByRole('combobox', { name: 'Date of Birth' })
    expect(within(dateOfBirth).getByRole('option', { name: 'ID (used)' })).toBeDisabled()
  })

  it('reviews the rows, then adds them and remembers the mapping', async () => {
    const fetchMock = stubRoutes()
    const onClose = vi.fn()
    const onUploaded = vi.fn()
    const { container } = render(
      <UploadDataModal onClose={onClose} onUploaded={onUploaded} />,
    )

    await toMapStep(container)
    choose('National ID', 'ID')
    choose('First Name — English', 'Name')
    fireEvent.click(screen.getByRole('button', { name: 'Next: Review' }))
    await screen.findByRole('region', { name: 'Review the records' })

    expect(screen.getByText(/Ready to add 2 records\./)).toBeInTheDocument()
    expect(screen.getByText(/1 row needs a value for a mapped field/)).toBeInTheDocument()
    expect(screen.getAllByText('Chann')).toHaveLength(1)

    fireEvent.click(screen.getByRole('button', { name: 'Add to list' }))

    await waitFor(() => expect(onUploaded).toHaveBeenCalledWith(2))
    expect(onClose).toHaveBeenCalled()

    const calls = fetchMock.mock.calls
    const savedMapping = calls.find(
      (call) => urlOf(call[0]).includes('/records/mappings') && (call[1] as RequestInit)?.method === 'PUT',
    )
    expect(savedMapping).toBeDefined()
    expect(bodyOf<{ mapping: Record<string, string> }>(savedMapping!)).toEqual({
      mapping: { ID: 'nationalId', Name: 'firstNameEnglish' },
    })

    const created = calls.find(
      (call) => urlOf(call[0]).endsWith('/records') && (call[1] as RequestInit)?.method === 'POST',
    )
    expect(created).toBeDefined()
    expect(bodyOf<{ records: unknown[] }>(created!).records).toEqual([
      { nationalId: '111', firstNameEnglish: 'Chann' },
      { nationalId: '222', firstNameEnglish: '' },
    ])
  })

  it('skips the mapping save when the reminder is off', async () => {
    const fetchMock = stubRoutes()
    const { container } = render(<UploadDataModal onClose={() => undefined} />)

    await toMapStep(container)
    choose('National ID', 'ID')
    fireEvent.click(screen.getByRole('checkbox', { name: /Remember this mapping/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Next: Review' }))
    await screen.findByRole('region', { name: 'Review the records' })
    fireEvent.click(screen.getByRole('button', { name: 'Add to list' }))

    await waitFor(() => {
      const posted = fetchMock.mock.calls.some(
        (call) => urlOf(call[0]).endsWith('/records') && (call[1] as RequestInit)?.method === 'POST',
      )
      expect(posted).toBe(true)
    })
    const putMapping = fetchMock.mock.calls.some(
      (call) => urlOf(call[0]).includes('/records/mappings') && (call[1] as RequestInit)?.method === 'PUT',
    )
    expect(putMapping).toBe(false)
  })

  it("shows the server's sentence when the submission is refused", async () => {
    stubRoutes({
      create: {
        payload: {
          error: {
            code: 'INVALID_REQUEST',
            message: 'Enter at least one value for this record.',
            fieldErrors: { 'records.0.values': 'Enter at least one value for this record.' },
            requestId: 'req_1',
          },
        },
        status: 400,
      },
    })
    const onClose = vi.fn()
    const { container } = render(<UploadDataModal onClose={onClose} />)

    await toMapStep(container)
    choose('National ID', 'ID')
    fireEvent.click(screen.getByRole('button', { name: 'Next: Review' }))
    await screen.findByRole('region', { name: 'Review the records' })
    fireEvent.click(screen.getByRole('button', { name: 'Add to list' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Enter at least one value for this record.',
    )
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Add to list' })).toBeEnabled()
  })
})
