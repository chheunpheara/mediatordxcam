import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { UploadedRecordsList } from './UploadedRecordsList'
import { RecordsProvider } from '../../features/records/RecordsProvider'
import { FaceCaptureProvider } from '../../features/face-capture/FaceCaptureProvider'
import { IdCardProcessingProvider } from '../../features/id-card-processing/IdCardProcessingProvider'
import { VerificationProvider } from '../../features/verification/VerificationProvider'
import {
  VERIFICATION_METHODS,
  makeUploadedRecord,
  makeVerifyResult,
  urlOf,
} from '../../test/fixtures'
import type { UploadedRecord } from '../../lib/api'

/**
 * The uploaded-records list (D23, requirements 6–10): its controls ride along
 * as query parameters, the Status cell keeps icon and word beside its colour,
 * Start marks the row as the workspace's subject, and Preview opens the stored
 * record.
 */

afterEach(() => {
  vi.unstubAllGlobals()
})

const BLANK_INPUTS = {
  identity: null,
  documentRef: null,
  currentFaceRef: null,
  livenessRef: null,
  idCardFaceRef: null,
}

function renderList(records: readonly UploadedRecord[], total = records.length) {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = urlOf(input)
    // apiUrl hands fetch a relative path, so the parse needs a stand-in base.
    const parsed = new URL(url, 'http://stub.local')
    const offset = Number(parsed.searchParams.get('offset') ?? '0')
    const limit = Number(parsed.searchParams.get('limit') ?? '10')
    // A search the server refused to match answers empty, so the no-match
    // empty state can be driven without a second stub. Otherwise the page
    // slice is served exactly as the query asked for it.
    const matched = url.includes('search=') ? [] : records
    const body = url.includes('verification-methods')
      ? { methods: VERIFICATION_METHODS }
      : url.includes('/api/v1/records/mappings')
        ? { mapping: null }
        : {
            records: matched.slice(offset, offset + limit),
            total: url.includes('search=') ? 0 : total,
          }
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
  })
  vi.stubGlobal('fetch', fetchMock)

  render(
    <IdCardProcessingProvider>
      <FaceCaptureProvider>
        <VerificationProvider inputs={BLANK_INPUTS}>
          <RecordsProvider>
            <UploadedRecordsList />
          </RecordsProvider>
        </VerificationProvider>
      </FaceCaptureProvider>
    </IdCardProcessingProvider>,
  )
  return fetchMock
}

function verifiedRecord(): UploadedRecord {
  return makeUploadedRecord({
    id: 'rec_verified',
    status: 'verified',
    verification: { ...makeVerifyResult(), verifiedAt: 1759710000 },
    verifiedAt: 1759710000,
  })
}

describe('UploadedRecordsList', () => {
  it('lists each row with its Status word and both actions (§32)', async () => {
    renderList([makeUploadedRecord(), verifiedRecord()])

    expect(await screen.findAllByText('Sokha Cham')).toHaveLength(2)
    // Scoped to the table: the filter's own options also say Pending/Verified.
    const table = screen.getByRole('table')
    // The word carries the meaning on its own — colour never does (§32).
    expect(within(table).getByText('Pending')).toBeInTheDocument()
    expect(within(table).getByText('Verified')).toBeInTheDocument()

    expect(screen.getAllByRole('button', { name: 'Start' })).toHaveLength(2)
    expect(screen.getAllByRole('button', { name: 'Preview' })).toHaveLength(2)
    expect(screen.getByLabelText('Status')).toBeInTheDocument()
    expect(screen.getByLabelText('Rows per page')).toBeInTheDocument()
  })

  it('searches on submit, not per keystroke', async () => {
    const fetchMock = renderList([makeUploadedRecord()])
    await screen.findByText('Sokha Cham')
    const before = fetchMock.mock.calls.length

    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'sokha' } })
    expect(fetchMock).toHaveBeenCalledTimes(before)

    fireEvent.click(screen.getByRole('button', { name: 'Search' }))

    await waitFor(() => {
      const last = urlOf(fetchMock.mock.calls.at(-1)?.[0])
      expect(last).toContain('search=sokha')
    })
    expect(screen.getByLabelText('Search')).toHaveValue('sokha')
  })

  it('sends the status filter and page size as query parameters', async () => {
    const fetchMock = renderList([verifiedRecord()])
    await screen.findByText('Sokha Cham')

    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'verified' } })
    await waitFor(() =>
      expect(urlOf(fetchMock.mock.calls.at(-1)?.[0])).toContain('status=verified'),
    )

    fireEvent.change(screen.getByLabelText('Rows per page'), { target: { value: '25' } })
    await waitFor(() =>
      expect(urlOf(fetchMock.mock.calls.at(-1)?.[0])).toContain('limit=25'),
    )
  })

  it('pages through the server and says which slice is shown', async () => {
    const rows = Array.from({ length: 42 }, (_, index) =>
      makeUploadedRecord({ id: `rec_${index}` }),
    )
    const fetchMock = renderList(rows, 42)

    expect(await screen.findByText('Showing 1–10 of 42')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: 'Next' }))

    expect(await screen.findByText('Showing 11–20 of 42')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Previous' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled()
    expect(urlOf(fetchMock.mock.calls.at(-1)?.[0])).toContain('offset=10')
  })

  it('never offers a page past the last one', async () => {
    const rows = Array.from({ length: 12 }, (_, index) =>
      makeUploadedRecord({ id: `rec_${index}` }),
    )
    renderList(rows, 12)

    expect(await screen.findByText('Showing 1–10 of 12')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(await screen.findByText('Showing 11–12 of 12')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled()
  })

  it('marks the started row as the workspace’s subject', async () => {
    renderList([makeUploadedRecord(), verifiedRecord()])
    await screen.findAllByText('Sokha Cham')

    fireEvent.click(screen.getAllByRole('button', { name: 'Start' })[1]!)

    const rows = screen.getAllByRole('row').filter((row) => row.getAttribute('aria-current'))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toHaveTextContent('Verified')
  })

  it('opens the preview dialog from a row', async () => {
    renderList([verifiedRecord()])
    await screen.findByText('Sokha Cham')

    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))

    const dialog = await screen.findByRole('dialog', { name: 'Record preview' })
    expect(within(dialog).getByText('Sokha Cham · Verified')).toBeInTheDocument()
    expect(within(dialog).getByRole('table')).toBeInTheDocument()
  })

  it('says the list is empty, and differently when a search matched nothing', async () => {
    renderList([])

    expect(
      await screen.findByText('No records yet. Upload a CSV or Excel file to add some.'),
    ).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'nobody' } })
    fireEvent.click(screen.getByRole('button', { name: 'Search' }))

    expect(await screen.findByText('No records match this search.')).toBeInTheDocument()
  })
})
