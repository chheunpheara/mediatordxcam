import { createContext, use } from 'react'

import type { FaceStatus } from '../../lib/api'

export type FaceCaptureState = 'idle' | 'capturing' | 'ready' | 'failed'

export interface FaceCaptureValue {
  readonly state: FaceCaptureState
  /** Opaque handle of the stored current-face photo, once accepted. */
  readonly faceRef: string | null
  /** Detection outcome of the stored photo, for a UI hint only. */
  readonly captureStatus: FaceStatus | null
  /** User-facing error; already renderable as-is. */
  readonly error: string | null
  readonly capture: (file: File | Blob) => Promise<void>
  readonly reset: () => void
}

export const FaceCaptureContext = createContext<FaceCaptureValue | null>(null)

export function useFaceCapture(): FaceCaptureValue {
  const value = use(FaceCaptureContext)
  if (!value) {
    throw new Error('useFaceCapture must be used inside a FaceCaptureProvider')
  }
  return value
}
