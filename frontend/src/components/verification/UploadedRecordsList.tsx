import { useState } from 'react'
import type { FormEvent } from 'react'

import { useFaceCapture } from '../../features/face-capture/FaceCaptureContext'
import { useIdCardProcessing } from '../../features/id-card-processing/ProcessingContext'
import { RECORD_PAGE_SIZES, recordName, useRecords } from '../../features/records/RecordsContext'
import { useVerification } from '../../features/verification/VerificationContext'
import type { UploadedRecord, UploadedRecordStatus } from '../../lib/api'
import { RecordPreviewModal } from './RecordPreviewModal'

/**
 * The uploaded-records list below the workspace (D23, requirements 6–10).
 *
 * Every control is one server-side query: search applies on submit (so a
 * keystroke never races the request it caused), the status filter, page size
 * and page all round-trip as query parameters, and the footer states exactly
 * which slice of `total` is on screen.
 *
 * Two row actions: Start loads the row into the workspace regardless of any
 * uploaded document — clearing the previous draft, runs and face capture
 * first, so one subject's data can never ride along with another's — and
 * Preview opens the stored record and its verification. Colour never carries
 * a status alone: Pending and Verified each keep an icon and the word (§32).
 */
export function UploadedRecordsList() {
  const {
    records,
    total,
    loading,
    error,
    search,
    status,
    limit,
    page,
    lastAdded,
    activeRecord,
    setSearch,
    setStatus,
    setLimit,
    setPage,
    dismissAdded,
    start,
  } = useRecords()
  const { clearDraft } = useIdCardProcessing()
  const { reset: resetVerification } = useVerification()
  const faceCapture = useFaceCapture()

  const [draftSearch, setDraftSearch] = useState(search)
  const [previewing, setPreviewing] = useState<UploadedRecord | null>(null)

  const totalPages = Math.max(1, Math.ceil(total / limit))
  const from = total === 0 ? 0 : page * limit + 1
  const to = page * limit + records.length

  const applySearch = (event: FormEvent): void => {
    event.preventDefault()
    setSearch(draftSearch)
  }

  const handleStart = (record: UploadedRecord): void => {
    // A fresh start: OCR corrections, earlier runs and the captured face all
    // belong to the previous subject (D23). The record's values take over the
    // identity form whether or not a document was ever uploaded.
    clearDraft()
    resetVerification()
    faceCapture.reset()
    start(record)
  }

  return (
    <section aria-label="Uploaded records" className="card mt-4 p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold">Uploaded records</h2>
        <p className="text-ink-subtle text-xs">
          {total === 0 ? 'Nothing uploaded yet' : `${total} total`}
        </p>
      </div>

      {lastAdded !== null ? (
        <div
          className="border-border bg-surface-sunken mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border px-4 py-2.5"
          role="status"
        >
          <p className="text-sm">
            {lastAdded === 1
              ? '1 record added to the list.'
              : `${lastAdded} records added to the list.`}
          </p>
          <button className="btn-secondary px-2 py-1 text-xs" onClick={dismissAdded} type="button">
            Dismiss
          </button>
        </div>
      ) : null}

      <div className="mt-4 flex flex-wrap items-end gap-3">
        <form className="flex items-end gap-2" onSubmit={applySearch} role="search">
          <div>
            <label className="text-ink-muted block text-xs font-semibold" htmlFor="records-search">
              Search
            </label>
            <input
              className="input mt-1 w-52"
              id="records-search"
              onChange={(event) => setDraftSearch(event.target.value)}
              placeholder="Name or ID"
              type="search"
              value={draftSearch}
            />
          </div>
          <button className="btn-secondary px-3 py-1.5" type="submit">
            Search
          </button>
        </form>

        <div>
          <label className="text-ink-muted block text-xs font-semibold" htmlFor="records-status">
            Status
          </label>
          <select
            className="input mt-1"
            id="records-status"
            onChange={(event) => setStatus(event.target.value as UploadedRecordStatus | 'all')}
            value={status}
          >
            <option value="all">All</option>
            <option value="pending">Pending</option>
            <option value="verified">Verified</option>
          </select>
        </div>

        <div>
          <label className="text-ink-muted block text-xs font-semibold" htmlFor="records-limit">
            Rows per page
          </label>
          <select
            className="input mt-1"
            id="records-limit"
            onChange={(event) => setLimit(Number(event.target.value))}
            value={limit}
          >
            {RECORD_PAGE_SIZES.map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        </div>
      </div>

      {error ? (
        <p
          className="border-negative bg-negative-soft text-negative mt-3 rounded-lg border px-4 py-2.5 text-sm"
          role="alert"
        >
          {error}
        </p>
      ) : null}

      <div className="mt-4" aria-busy={loading}>
        {loading && records.length === 0 ? (
          <p className="text-ink-subtle text-sm" role="status">
            Loading records…
          </p>
        ) : records.length === 0 && error !== null ? (
          // The alert above already carries the reason — an "all clear" empty
          // state underneath it would contradict it.
          null
        ) : records.length === 0 ? (
          <p className="text-ink-subtle text-sm" role="status">
            {search.trim() !== '' || status !== 'all'
              ? 'No records match this search.'
              : 'No records yet. Upload a CSV or Excel file to add some.'}
          </p>
        ) : (
          <>
            <table className="w-full text-left text-xs">
              <thead className="text-ink-subtle">
                <tr>
                  <th className="py-1 pr-3 font-medium">National ID</th>
                  <th className="py-1 pr-3 font-medium">Name</th>
                  <th className="py-1 pr-3 font-medium">Status</th>
                  <th className="py-1 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {records.map((record) => (
                  <tr
                    aria-current={record.id === activeRecord?.id ? 'true' : undefined}
                    className="border-border border-t"
                    key={record.id}
                  >
                    <td className="py-1.5 pr-3">{record.values.nationalId ?? '—'}</td>
                    <td className="py-1.5 pr-3">{recordName(record)}</td>
                    <td className="py-1.5 pr-3">
                      <StatusPill status={record.status} />
                    </td>
                    <td className="py-1.5">
                      <div className="flex justify-end gap-2">
                        <button
                          className="btn-secondary px-2 py-1 text-xs"
                          onClick={() => handleStart(record)}
                          type="button"
                        >
                          Start
                        </button>
                        <button
                          className="btn-secondary px-2 py-1 text-xs"
                          onClick={() => setPreviewing(record)}
                          type="button"
                        >
                          Preview
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="text-ink-muted mt-3 flex flex-wrap items-center justify-between gap-2 text-xs">
              <p role="status">
                {`Showing ${from}–${to} of ${total}`}
              </p>
              <div className="flex gap-2">
                <button
                  className="btn-secondary px-3 py-1 text-xs"
                  disabled={page === 0}
                  onClick={() => setPage(page - 1)}
                  type="button"
                >
                  Previous
                </button>
                <button
                  className="btn-secondary px-3 py-1 text-xs"
                  disabled={page >= totalPages - 1}
                  onClick={() => setPage(page + 1)}
                  type="button"
                >
                  Next
                </button>
              </div>
            </div>
          </>
        )}
      </div>

      {previewing ? <RecordPreviewModal record={previewing} onClose={() => setPreviewing(null)} /> : null}
    </section>
  )
}

/** Pending / Verified — icon plus word plus tint, never colour alone (§32). */
function StatusPill({ status }: { readonly status: UploadedRecordStatus }) {
  const verified = status === 'verified'
  return (
    <span
      className={`inline-flex items-center gap-1.5 font-medium ${verified ? 'text-positive' : 'text-ink-muted'}`}
    >
      <svg
        aria-hidden="true"
        className="h-3.5 w-3.5 shrink-0"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2.5}
        viewBox="0 0 24 24"
      >
        <path d={verified ? 'M20 6 9 17l-5-5' : 'M12 6v6l4 2'} />
      </svg>
      {verified ? 'Verified' : 'Pending'}
    </span>
  )
}
