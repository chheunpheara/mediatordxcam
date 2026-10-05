import { clearSessionSlice, readSession, setSessionSlice } from './session'

/**
 * Where the uploaded document survives a refresh (D21).
 *
 * The bytes cannot live in `sessionStorage`: validation accepts up to 10 MB,
 * which becomes ~13 MB of base64 against a ~5 MB per-origin quota — the write
 * failed silently and a refresh emptied the workspace, the captured face with
 * it, because the face only renders inside a document-bearing session.
 * IndexedDB has no such bound and keeps the landing page's promise that the
 * file stays on this device: nothing is uploaded before "Continue".
 *
 * `sessionStorage` keeps only the `docStored` marker, read synchronously on
 * first paint to know whether a restore is pending (IndexedDB cannot be read
 * synchronously). Marker writes are synchronous with their caller's own action
 * — never with a background completion — so a write can never straggle into
 * storage that was cleared in the meantime. A marker without bytes heals on
 * the next load.
 *
 * All operations are best effort: where IndexedDB is unavailable (old
 * browsers, private mode), the document simply does not outlive the session —
 * exactly how the app behaved before D21.
 */
export interface StoredDocument {
  readonly fileName: string
  readonly type: string
  readonly width: number
  readonly height: number
  readonly dataUrl: string
}

const DB_NAME = 'camdx'
const STORE_NAME = 'documents'
const RECORD_ID = 'document'

function openDatabase(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null)
  return new Promise((resolve) => {
    let request: IDBOpenDBRequest
    try {
      request = indexedDB.open(DB_NAME, 1)
    } catch {
      resolve(null)
      return
    }
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME)
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => resolve(null)
    request.onblocked = () => resolve(null)
  })
}

/**
 * Runs one request against the store. Resolves `null` for every failure mode —
 * no caller of this module may throw because persistence is unavailable.
 */
async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T | null> {
  const db = await openDatabase()
  if (!db) return null
  return new Promise<T | null>((resolve) => {
    const done = (value: T | null) => {
      db.close()
      resolve(value)
    }
    try {
      const request = run(db.transaction(STORE_NAME, mode).objectStore(STORE_NAME))
      request.onsuccess = () => done(request.result)
      request.onerror = () => done(null)
    } catch {
      done(null)
    }
  })
}

/** Stores the record. The marker flips with the call, not with the write. */
export async function saveStoredDocument(record: StoredDocument): Promise<void> {
  setSessionSlice('docStored', true)
  await withStore('readwrite', (store) => store.put(record, RECORD_ID))
}

export async function loadStoredDocument(): Promise<StoredDocument | null> {
  const record = await withStore<StoredDocument>('readonly', (store) =>
    store.get(RECORD_ID) as IDBRequest<StoredDocument>,
  )
  if (!record || typeof record !== 'object' || typeof record.dataUrl !== 'string') {
    return null
  }
  return record
}

export async function clearStoredDocument(): Promise<void> {
  // Marker first and synchronously, for the same reason save sets it up front:
  // a straggler must not clear a marker that belongs to a later session.
  clearSessionSlice('docStored')
  await withStore('readwrite', (store) => store.delete(RECORD_ID))
}

/** Whether a restore is pending; the synchronous half of the store (D21). */
export function hasStoredDocument(): boolean {
  return readSession()?.docStored === true
}

/** Tests only: drop everything a previous test stored. */
export async function resetDocumentStore(): Promise<void> {
  clearSessionSlice('docStored')
  if (typeof indexedDB === 'undefined') return
  await new Promise<void>((resolve) => {
    try {
      const request = indexedDB.deleteDatabase(DB_NAME)
      request.onsuccess = () => resolve()
      request.onerror = () => resolve()
      request.onblocked = () => resolve()
    } catch {
      resolve()
    }
  })
}
