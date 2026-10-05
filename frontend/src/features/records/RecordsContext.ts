import { createContext, use } from 'react'

import type { UploadedRecord, UploadedRecordStatus, VerifyResponse } from '../../lib/api'

/**
 * The uploaded-records list below the verification workspace (D23).
 *
 * The list owns its controls — search, status filter, page size, page — as
 * state, because they are one server-side query: the same values that arrive
 * here are sent back as `search`/`status`/`limit`/`offset` so the page shows
 * the same slice the backend returned, and one response can never be paired
 * with another request's controls.
 *
 * It also holds the record being verified: pressing Start swaps the
 * workspace's identity form onto that row's values regardless of whether a
 * document was ever uploaded (D23).
 */

/** What the status filter is showing. */
export type RecordsStatusFilter = UploadedRecordStatus | 'all'

/** The page-size choices offered next to the table (D23). */
export const RECORD_PAGE_SIZES = [10, 25, 50] as const

/** The row's person in words: the English name, or the ID when there is none. */
export function recordName(record: UploadedRecord): string {
  const first = record.values.firstNameEnglish ?? ''
  const last = record.values.lastNameEnglish ?? ''
  const joined = `${first} ${last}`.trim()
  if (joined !== '') return joined
  const nationalId = record.values.nationalId ?? ''
  return nationalId.trim() === '' ? record.id : nationalId
}

export interface RecordsValue {
  readonly records: readonly UploadedRecord[]
  readonly total: number
  readonly loading: boolean
  /** Already user-facing (§28). Rendered as-is; never a raw error. */
  readonly error: string | null
  readonly search: string
  readonly status: RecordsStatusFilter
  readonly limit: number
  /** Zero-based page, as `offset = page * limit`. */
  readonly page: number
  /** How many rows the last upload added, or null once dismissed. */
  readonly lastAdded: number | null
  /** The row Start was pressed — its values drive the form until Stop. */
  readonly activeRecord: UploadedRecord | null
  readonly setSearch: (value: string) => void
  readonly setStatus: (value: RecordsStatusFilter) => void
  readonly setLimit: (value: number) => void
  readonly setPage: (value: number) => void
  readonly refresh: () => void
  readonly uploaded: (count: number) => void
  readonly dismissAdded: () => void
  readonly start: (record: UploadedRecord) => void
  readonly stop: () => void
  /** Store a run against a record and reflect it in the row (D23). */
  readonly markVerified: (recordId: string, verification: VerifyResponse) => Promise<void>
}

export const RecordsContext = createContext<RecordsValue | null>(null)

export function useRecords(): RecordsValue {
  const value = use(RecordsContext)
  if (!value) {
    throw new Error('useRecords must be used inside a RecordsProvider')
  }
  return value
}
