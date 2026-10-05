import { beforeEach, describe, expect, it } from 'vitest'

import {
  clearStoredDocument,
  hasStoredDocument,
  loadStoredDocument,
  resetDocumentStore,
  saveStoredDocument,
} from './documentStore'
import { readSession } from './session'

const record = {
  fileName: 'card.jpg',
  type: 'image/jpeg',
  width: 1280,
  height: 800,
  dataUrl: 'data:image/jpeg;base64,eA==',
}

/**
 * The document store behind D21: bytes in IndexedDB, marker in
 * sessionStorage. The middle test is the regression that motivated both —
 * the quota a base64 document used to blow through silently.
 */
describe('documentStore (D21)', () => {
  beforeEach(async () => {
    await resetDocumentStore()
  })

  it('starts from nothing', async () => {
    expect(await loadStoredDocument()).toBeNull()
    expect(hasStoredDocument()).toBe(false)
  })

  it('round-trips a stored document and marks it for restore', async () => {
    await saveStoredDocument(record)

    expect(await loadStoredDocument()).toEqual(record)
    // The marker is the synchronous half first paint reads to know a
    // restore is pending.
    expect(hasStoredDocument()).toBe(true)
  })

  it('keeps the bytes out of sessionStorage, which cannot hold them', async () => {
    const big = { ...record, dataUrl: `data:image/jpeg;base64,${'A'.repeat(6_000_000)}` }

    await saveStoredDocument(big)

    // What broke before D21: the whole document used to be written here,
    // against a ~5 MB quota that a 10 MB upload exceeds after base64.
    const raw = JSON.stringify(readSession())
    expect(raw).not.toContain('dataUrl')
    expect(raw).not.toContain('AAAA')
    expect((await loadStoredDocument())?.dataUrl).toHaveLength(big.dataUrl.length)
  })

  it('drops the stored copy and the marker on clear', async () => {
    await saveStoredDocument(record)

    await clearStoredDocument()

    expect(await loadStoredDocument()).toBeNull()
    expect(hasStoredDocument()).toBe(false)
  })
})
