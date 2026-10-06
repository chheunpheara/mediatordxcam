import type { FaceStatus, ProcessIdCardResponse } from './api'
import type { ProcessingState } from '../features/id-card-processing/ProcessingContext'
import type { IdentityDraft } from '../features/id-card-processing/IdentityDraftContext'

export interface StoredProcessing {
  readonly state: ProcessingState
  readonly result: ProcessIdCardResponse | null
  readonly draft: IdentityDraft
  readonly error: string | null
}

export interface StoredLiveness {
  readonly state: 'idle' | 'capturing' | 'ready' | 'failed'
  readonly livenessRef: string | null
  readonly ownedBy: string | null
  readonly error: string | null
}

export interface StoredFace {
  readonly state: 'idle' | 'capturing' | 'ready' | 'failed'
  readonly faceRef: string | null
  readonly captureStatus: FaceStatus | null
  readonly ownedBy: string | null
  readonly error: string | null
}

export interface Session {
  /** A copy of the document waits in the IndexedDB store (D21); its bytes never come back here. */
  docStored?: boolean
  processing?: StoredProcessing
  face?: StoredFace
  liveness?: StoredLiveness
}

const STORAGE_KEY = 'camdx:session'

export function readSession(): Session | null {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const session = JSON.parse(raw) as Session & { doc?: unknown }
    // Pre-D21 payloads carried the file bytes in this slice, against a quota
    // they could not fit. Drop them on read so they leave with the next write.
    delete session.doc
    return session
  } catch {
    return null
  }
}

function writeSession(session: Session): void {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session))
  } catch {
    // A full/corrupted store must not break the UI.
  }
}

export function setSessionSlice(name: keyof Session, value: unknown): void {
  const current = readSession() ?? {}
  const next: Session = { ...current }
  delete next[name]
  if (value !== null && value !== undefined) {
    // @ts-expect-error accepting an opaque value into the slice slot
    next[name] = value
  }
  const hasAnySlice = Object.values(next).some((v) => v !== undefined)
  if (!hasAnySlice) {
    clearSession()
  } else {
    writeSession(next)
  }
}

export function clearSessionSlice(name: keyof Session): void {
  setSessionSlice(name, undefined)
}

export function clearSession(): void {
  try {
    window.sessionStorage.removeItem(STORAGE_KEY)
  } catch {
    // ignore
  }
}

export function dataUrlToFile(dataUrl: string, fileName: string, fallbackType: string): File {
  const comma = dataUrl.indexOf(',')
  const header = comma === -1 ? '' : dataUrl.slice(0, comma)
  const payload = comma === -1 ? '' : dataUrl.slice(comma + 1)
  const mimeFrom = /data:([^;]+)/.exec(header)?.[1]
  const type = mimeFrom && mimeFrom !== '...' ? mimeFrom : fallbackType
  const binary = atob(payload)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return new File([bytes], fileName, { type })
}
