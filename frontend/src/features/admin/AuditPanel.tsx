import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'

import { ApiError, fetchAuditLogs } from '../../lib/api'
import type { AuditActionType, AuditLogEntry, AuditLogStatus } from '../../lib/api'

/**
 * The audit trail (D25): a read-only, paginated view of the append-only log.
 *
 * Filters are drafted in a form and applied together, so a staff ID can be
 * combined with an action and a date range in one query; the server decides
 * validity (including a start date after an end date) and its refusal is
 * shown as-is. Each row expands to the stored snapshot — masked before it
 * ever reached the database — plus the error body a failed core post
 * captured, which is exactly the evidence a Maker-Checker review needs.
 */

const LIMIT = 10

const ACTION_OPTIONS: readonly (AuditActionType | 'all')[] = [
  'all',
  'POST_TO_CORE',
  'IDENTITY_VERIFIED',
  'CAMDX_FETCH',
  'MANUAL_APPROVED',
]

const STATUS_OPTIONS: readonly (AuditLogStatus | 'all')[] = ['all', 'PENDING', 'SUCCESS', 'FAILED']

interface Filters {
  readonly staffId: string
  readonly actionType: AuditActionType | 'all'
  readonly status: AuditLogStatus | 'all'
  readonly dateFrom: string
  readonly dateTo: string
}

const EMPTY_FILTERS: Filters = {
  staffId: '',
  actionType: 'all',
  status: 'all',
  dateFrom: '',
  dateTo: '',
}

const STATUS_STYLES: Readonly<Record<AuditLogStatus, string>> = {
  PENDING: 'text-ink-muted',
  SUCCESS: 'text-positive',
  FAILED: 'text-negative',
}

/** The local time for an epoch-seconds stamp, the repo's portability format. */
function formatWhen(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toLocaleString()
}

export function AuditPanel() {
  const [draft, setDraft] = useState<Filters>(EMPTY_FILTERS)
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS)
  const [logs, setLogs] = useState<readonly AuditLogEntry[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const seqRef = useRef(0)

  useEffect(() => {
    const seq = ++seqRef.current
    const staffId = filters.staffId.trim()
    fetchAuditLogs({
      ...(staffId === '' ? {} : { staffId }),
      ...(filters.actionType === 'all' ? {} : { actionType: filters.actionType }),
      ...(filters.status === 'all' ? {} : { status: filters.status }),
      ...(filters.dateFrom === '' ? {} : { dateFrom: filters.dateFrom }),
      ...(filters.dateTo === '' ? {} : { dateTo: filters.dateTo }),
      limit: LIMIT,
      offset: page * LIMIT,
    })
      .then((response) => {
        if (seq !== seqRef.current) return
        setLogs(response.logs)
        setTotal(response.total)
        setError(null)
        setLoading(false)
      })
      .catch((cause: unknown) => {
        if (seq !== seqRef.current) return
        setError(
          cause instanceof ApiError ? cause.message : 'Something went wrong. Please try again.',
        )
        setLoading(false)
      })
  }, [filters, page])

  const applyFilters = (event: FormEvent) => {
    event.preventDefault()
    setFilters(draft)
    setPage(0)
  }

  const resetFilters = () => {
    setDraft(EMPTY_FILTERS)
    setFilters(EMPTY_FILTERS)
    setPage(0)
  }

  const totalPages = Math.max(1, Math.ceil(total / LIMIT))
  const from = total === 0 ? 0 : page * LIMIT + 1
  const to = Math.min((page + 1) * LIMIT, total)

  return (
    <div>
      <form className="mt-4 flex flex-wrap items-end gap-3" onSubmit={applyFilters} role="search">
        <div>
          <label className="text-ink-muted block text-xs font-semibold" htmlFor="audit-staff">
            Staff ID
          </label>
          <input
            className="input mt-1 w-48"
            id="audit-staff"
            onChange={(event) => setDraft({ ...draft, staffId: event.target.value })}
            placeholder="User ID"
            type="search"
            value={draft.staffId}
          />
        </div>

        <div>
          <label className="text-ink-muted block text-xs font-semibold" htmlFor="audit-action">
            Action
          </label>
          <select
            className="input mt-1"
            id="audit-action"
            onChange={(event) =>
              setDraft({
                ...draft,
                actionType: event.target.value as AuditActionType | 'all',
              })
            }
            value={draft.actionType}
          >
            {ACTION_OPTIONS.map((action) => (
              <option key={action} value={action}>
                {action === 'all' ? 'All' : action}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="text-ink-muted block text-xs font-semibold" htmlFor="audit-status">
            Status
          </label>
          <select
            className="input mt-1"
            id="audit-status"
            onChange={(event) =>
              setDraft({
                ...draft,
                status: event.target.value as AuditLogStatus | 'all',
              })
            }
            value={draft.status}
          >
            {STATUS_OPTIONS.map((status) => (
              <option key={status} value={status}>
                {status === 'all' ? 'All' : status}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="text-ink-muted block text-xs font-semibold" htmlFor="audit-from">
            From
          </label>
          <input
            className="input mt-1"
            id="audit-from"
            onChange={(event) => setDraft({ ...draft, dateFrom: event.target.value })}
            type="date"
            value={draft.dateFrom}
          />
        </div>

        <div>
          <label className="text-ink-muted block text-xs font-semibold" htmlFor="audit-to">
            To
          </label>
          <input
            className="input mt-1"
            id="audit-to"
            onChange={(event) => setDraft({ ...draft, dateTo: event.target.value })}
            type="date"
            value={draft.dateTo}
          />
        </div>

        <button className="btn-secondary px-3 py-1.5" type="submit">
          Apply
        </button>
        <button className="btn-secondary px-3 py-1.5" onClick={resetFilters} type="button">
          Reset
        </button>
      </form>

      {error ? (
        <div
          className="border-negative bg-negative-soft text-negative mt-4 rounded-lg border px-4 py-3 text-sm font-medium"
          role="alert"
        >
          {error}
        </div>
      ) : null}

      <div className="mt-4">
        {loading ? (
          <p className="text-ink-muted text-sm" role="status">
            Loading audit trail…
          </p>
        ) : logs.length === 0 ? (
          <p className="text-ink-muted text-sm">No audit entries match this view.</p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="text-ink-muted border-b text-xs font-semibold uppercase">
              <tr>
                <th className="py-2 pr-4">When</th>
                <th className="py-2 pr-4">Staff</th>
                <th className="py-2 pr-4">Action</th>
                <th className="py-2 pr-4">Target</th>
                <th className="py-2 pr-4">Status</th>
                <th className="py-2 pr-4">Evidence</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((entry) => (
                <tr className="border-b" key={entry.id}>
                  <td className="py-3 pr-4 whitespace-nowrap">{formatWhen(entry.createdAt)}</td>
                  <td className="py-3 pr-4">
                    <span className="block font-medium">{entry.staffEmail}</span>
                    <span className="text-ink-muted block text-xs">
                      {entry.staffRole || entry.staffId}
                    </span>
                  </td>
                  <td className="py-3 pr-4 font-mono text-xs">{entry.actionType}</td>
                  <td className="text-ink-muted max-w-48 truncate py-3 pr-4 text-xs">
                    {entry.targetSystemUrl ?? '—'}
                  </td>
                  <td className={`py-3 pr-4 font-semibold ${STATUS_STYLES[entry.status]}`}>
                    {entry.status}
                  </td>
                  <td className="py-3 pr-4">
                    <details>
                      <summary className="cursor-pointer font-medium">View</summary>
                      <pre className="bg-surface-sunken mt-2 max-w-md overflow-x-auto rounded p-2 text-xs">
                        {JSON.stringify(entry.payloadSnapshot, null, 2)}
                      </pre>
                      {entry.biometricConfidenceScore !== null ? (
                        <p className="text-ink-muted mt-2 text-xs">
                          Biometric score: {entry.biometricConfidenceScore}
                        </p>
                      ) : null}
                      {entry.errorResponse !== null ? (
                        <>
                          <p className="text-ink-muted mt-2 text-xs font-semibold">
                            Error response
                          </p>
                          <pre className="bg-surface-sunken mt-1 max-w-md overflow-x-auto rounded p-2 text-xs">
                            {entry.errorResponse}
                          </pre>
                        </>
                      ) : null}
                    </details>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {!loading && total > 0 ? (
        <div className="text-ink-muted mt-3 flex flex-wrap items-center justify-between gap-2 text-xs">
          <p role="status">{`Showing ${from}–${to} of ${total}`}</p>
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
      ) : null}
    </div>
  )
}
