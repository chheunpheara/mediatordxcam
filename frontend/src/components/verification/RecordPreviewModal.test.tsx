import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { RecordPreviewModal } from './RecordPreviewModal'
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
 * The record preview (D23, requirement 10): the nine imported values, and
 * once verified — the method, the run's sentence, when it happened, and the
 * same field rows the live report shows. A record not yet verified says so.
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

function renderModal(record: UploadedRecord) {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const body = urlOf(input).includes('verification-methods')
        ? { methods: VERIFICATION_METHODS }
        : { records: [], total: 0 }
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
    }),
  )

  const onClose = vi.fn()
  render(
    <IdCardProcessingProvider>
      <FaceCaptureProvider>
        <VerificationProvider inputs={BLANK_INPUTS}>
          <RecordPreviewModal onClose={onClose} record={record} />
        </VerificationProvider>
      </FaceCaptureProvider>
    </IdCardProcessingProvider>,
  )
  return onClose
}

function verifiedRecord(): UploadedRecord {
  return makeUploadedRecord({
    status: 'verified',
    verification: { ...makeVerifyResult(), verifiedAt: 1759710000 },
    verifiedAt: 1759710000,
  })
}

describe('RecordPreviewModal', () => {
  it('opens with focus on Close, Escape and the backdrop both close it', () => {
    const onClose = renderModal(makeUploadedRecord())

    const closes = screen.getAllByRole('button', { name: 'Close' })
    expect(closes[0]).toHaveFocus()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('presentation'))
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('shows the imported values, with a dash for a field the mapping left empty', () => {
    const base = makeUploadedRecord()
    renderModal(
      makeUploadedRecord({ values: { ...base.values, dateOfBirth: null } }),
    )

    const dialog = screen.getByRole('dialog', { name: 'Record preview' })
    const table = within(dialog).getAllByRole('table')[0]!
    expect(within(table).getByRole('cell', { name: '123456789' })).toBeInTheDocument()
    expect(within(table).getByRole('cell', { name: 'Sokha' })).toBeInTheDocument()
    expect(within(table).getByRole('cell', { name: '—' })).toBeInTheDocument()
    expect(within(dialog).getByText('Sokha Cham · Pending')).toBeInTheDocument()
  })

  it('says plainly that a record has not been verified yet', () => {
    renderModal(makeUploadedRecord())

    const dialog = screen.getByRole('dialog', { name: 'Record preview' })
    expect(within(dialog).getByText(/has not been verified yet/)).toBeInTheDocument()
    expect(within(dialog).queryByText('Method')).not.toBeInTheDocument()
  })

  it('lays out the stored run: method, sentence, time and the field rows', async () => {
    renderModal(verifiedRecord())

    const dialog = screen.getByRole('dialog', { name: 'Record preview' })
    // The method list arrives with its own fetch — wait for its label.
    expect(await within(dialog).findByText('Identity Information')).toBeInTheDocument()
    expect(within(dialog).getByText('Verification successful.')).toBeInTheDocument()
    expect(within(dialog).getByText('Verified at')).toBeInTheDocument()
    expect(within(dialog).getByText(new Date(1759710000 * 1000).toLocaleString())).toBeInTheDocument()

    // The same nine field rows the live report renders (§25, §27).
    expect(within(dialog).getAllByRole('listitem')).toHaveLength(9)
    expect(within(dialog).getAllByText('Matched')).toHaveLength(9)
    expect(within(dialog).getByText('Stored with this record when the run finished (D23).')).toBeInTheDocument()
  })

  it('takes the method name from the backend’s own label', async () => {
    const record = verifiedRecord()
    const verification = record.verification
    if (!verification) throw new Error('fixture must be verified')
    renderModal({ ...record, verification: { ...verification, method: 'passport_ocr' } })

    // §11: the dialog names methods as the method list configures them — it
    // never invents its own name for one.
    const dialog = screen.getByRole('dialog', { name: 'Record preview' })
    expect(await within(dialog).findByText('Read Passport')).toBeInTheDocument()
  })
})
