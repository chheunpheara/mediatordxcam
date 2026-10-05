import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { ApiError, fetchRecords, saveRecordVerification } from '../../lib/api'
import type { UploadedRecord, VerifyResponse } from '../../lib/api'
import { RecordsContext } from './RecordsContext'
import type { RecordsStatusFilter, RecordsValue } from './RecordsContext'

/**
 * Loads the uploaded-records list and keeps its controls in step with it
 * (D23).
 *
 * One `load` per control change, and every load takes a sequence number: a
 * search typed over a slow first page would otherwise land after it and
 * replace newer results with older ones. Only the latest sequence writes
 * state, so the table can never show one response beside another request's
 * controls.
 */
export function RecordsProvider({ children }: { children: React.ReactNode }) {
  const [records, setRecords] = useState<readonly UploadedRecord[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearchState] = useState('')
  const [status, setStatusState] = useState<RecordsStatusFilter>('all')
  const [limit, setLimitState] = useState<number>(10)
  const [page, setPageState] = useState(0)
  const [lastAdded, setLastAdded] = useState<number | null>(null)
  const [activeRecord, setActiveRecord] = useState<UploadedRecord | null>(null)
  // Bumped to ask for the same query again (a refresh, a completed upload)
  // without any of its inputs having changed.
  const [reloadTick, setReloadTick] = useState(0)

  const seqRef = useRef(0)

  // `loading` covers the first load (its initial state); later control changes
  // re-fetch over the rows already on screen rather than blanking the table.
  // The fetch lives in the effect as promise callbacks, and every load takes a
  // sequence number: only the latest one writes, so a slow first page can
  // never land after — and overwrite — a newer search's response.
  useEffect(() => {
    const seq = ++seqRef.current
    const trimmed = search.trim()
    fetchRecords({
      ...(trimmed === '' ? {} : { search: trimmed }),
      ...(status === 'all' ? {} : { status }),
      limit,
      offset: page * limit,
    })
      .then((response) => {
        if (seq !== seqRef.current) return
        setRecords(response.records)
        setTotal(response.total)
        setError(null)
      })
      .catch((cause: unknown) => {
        if (seq !== seqRef.current) return
        setError(
          cause instanceof ApiError ? cause.message : 'Something went wrong. Please try again.',
        )
      })
      .finally(() => {
        if (seq === seqRef.current) setLoading(false)
      })
  }, [search, status, limit, page, reloadTick])

  // Changing a control always returns to the first page: offset 25 under a
  // new filter would silently show page 3 of a 10-row list.
  const setSearch = useCallback((value: string) => {
    setPageState(0)
    setSearchState(value)
  }, [])
  const setStatus = useCallback((value: RecordsStatusFilter) => {
    setPageState(0)
    setStatusState(value)
  }, [])
  const setLimit = useCallback((value: number) => {
    setPageState(0)
    setLimitState(value)
  }, [])
  const setPage = useCallback((value: number) => setPageState(value), [])
  const refresh = useCallback(() => setReloadTick((tick) => tick + 1), [])

  const uploaded = useCallback((count: number) => {
    setLastAdded(count)
    setPageState(0)
    setReloadTick((tick) => tick + 1)
  }, [])

  const dismissAdded = useCallback(() => setLastAdded(null), [])
  const start = useCallback((record: UploadedRecord) => setActiveRecord(record), [])
  const stop = useCallback(() => setActiveRecord(null), [])

  const markVerified = useCallback(
    async (recordId: string, verification: VerifyResponse) => {
      try {
        const updated = await saveRecordVerification(recordId, verification)
        setRecords((previous) =>
          previous.map((row) => (row.id === recordId ? updated : row)),
        )
        // Unfiltered, the row keeps its place and only its Status cell moves.
        // A status filter must re-run: a pending view would keep showing a
        // row that no longer belongs to it.
        if (status !== 'all') setReloadTick((tick) => tick + 1)
      } catch (cause) {
        setError(cause instanceof ApiError ? cause.message : 'Something went wrong. Please try again.')
      }
    },
    [status],
  )

  const value = useMemo<RecordsValue>(
    () => ({
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
      refresh,
      uploaded,
      dismissAdded,
      start,
      stop,
      markVerified,
    }),
    [
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
      refresh,
      uploaded,
      dismissAdded,
      start,
      stop,
      markVerified,
    ],
  )

  return <RecordsContext value={value}>{children}</RecordsContext>
}
