import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createRecords,
  fetchRecordMapping,
  fetchRecords,
  saveRecordMapping,
  saveRecordVerification,
} from './api'
import type { UploadedRecord } from './api'
import { bodyOf, makeVerifyResult } from '../test/fixtures'

/**
 * The record client (D23): one GET carries the list's controls as query
 * parameters, a submission posts the mapped values only, a finished run
 * replays its outcome to the record, and the one reusable mapping round-trips
 * on its own endpoints.
 */

function stubJson(payload: unknown, status = 200) {
  const mock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
    Promise.resolve(
      new Response(JSON.stringify(payload), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    ),
  )
  vi.stubGlobal('fetch', mock)
  return mock
}

const RECORD: UploadedRecord = {
  id: 'rec_1',
  status: 'pending',
  values: {
    nationalId: '123456789',
    firstNameKhmer: null,
    lastNameKhmer: null,
    firstNameEnglish: 'Chann',
    lastNameEnglish: 'Sok',
    gender: 'Female',
    dateOfBirth: '2000-01-01',
    issuedDate: null,
    expiryDate: null,
  },
  verification: null,
  createdAt: 1769900000,
  verifiedAt: null,
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fetchRecords', () => {
  it('carries search, status, limit and offset as query parameters', async () => {
    const fetchMock = stubJson({ records: [RECORD], total: 1 })

    const page = await fetchRecords({
      search: 'chann',
      status: 'verified',
      limit: 25,
      offset: 50,
    })

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      '/api/v1/records?search=chann&status=verified&limit=25&offset=50',
    )
    expect(page.total).toBe(1)
    expect(page.records[0]?.values.nationalId).toBe('123456789')
  })

  it('omits controls the caller did not set', async () => {
    const fetchMock = stubJson({ records: [], total: 0 })

    await fetchRecords()

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/v1/records')
  })
})

describe('createRecords', () => {
  it('posts the mapped values as { records } (201)', async () => {
    const fetchMock = stubJson({ records: [RECORD] }, 201)

    const created = await createRecords([{ nationalId: '123456789', firstNameEnglish: 'Chann' }])

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/v1/records')
    expect(init.method).toBe('POST')
    expect(bodyOf<{ records: unknown[] }>(fetchMock.mock.calls[0]!)).toEqual({
      records: [{ nationalId: '123456789', firstNameEnglish: 'Chann' }],
    })
    expect(created).toHaveLength(1)
    expect(created[0]?.status).toBe('pending')
  })
})

describe('saveRecordVerification', () => {
  it('replays the outcome to the record and reads it back verified', async () => {
    const fetchMock = stubJson({
      ...RECORD,
      status: 'verified',
      verification: { ...makeVerifyResult(), verifiedAt: 1769900100 },
      verifiedAt: 1769900100,
    })
    const outcome = makeVerifyResult()

    const saved = await saveRecordVerification('rec 1', outcome)

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/v1/records/rec%201/verification')
    expect(init.method).toBe('POST')
    expect(bodyOf<{ verification: unknown }>(fetchMock.mock.calls[0]!)).toEqual({
      verification: outcome,
    })
    expect(saved.status).toBe('verified')
    expect(saved.verification?.verifiedAt).toBe(1769900100)
  })
})

describe('the saved mapping', () => {
  it('reads a mapping that was never saved as null', async () => {
    stubJson({ mapping: null })

    expect(await fetchRecordMapping()).toBeNull()
  })

  it('replaces the one reusable mapping in a PUT', async () => {
    const fetchMock = stubJson({ mapping: { ID: 'nationalId' } })

    const saved = await saveRecordMapping({ ID: 'nationalId' })

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/v1/records/mappings')
    expect(init.method).toBe('PUT')
    expect(bodyOf<{ mapping: unknown }>(fetchMock.mock.calls[0]!)).toEqual({
      mapping: { ID: 'nationalId' },
    })
    expect(saved).toEqual({ ID: 'nationalId' })
  })
})
