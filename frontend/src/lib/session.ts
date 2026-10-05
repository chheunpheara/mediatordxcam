import type { ProcessIdCardResponse } from './api'
import type { ProcessingState } from '../features/id-card-processing/ProcessingContext'
import type { IdentityDraft } from '../features/id-card-processing/IdentityDraftContext'
import type { FaceStatus } from '../lib/api'

export interface StoredDoc {
  readonly fileName: string
  readonly type: string
  readonly width: number
  readonly height: number
  readonly dataUrl: string
}

export interface StoredProcessing {
  readonly state: ProcessingState
  readonly result: ProcessIdCardResponse | null
  readonly draft: IdentityDraft
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
  doc?: StoredDoc
  processing?: StoredProcessing
  face?: StoredFace
}

const STORAGE_KEY = 'camdx:session'

export function readSession(): Session | null {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    return JSON.parse(raw) as Session
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
