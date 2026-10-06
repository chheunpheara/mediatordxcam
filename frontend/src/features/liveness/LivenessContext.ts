import { createContext, use } from 'react'

export type LivenessState = 'idle' | 'capturing' | 'ready' | 'failed'

export interface LivenessValue {
  readonly state: LivenessState
  /** Opaque handle of the stored liveness recording, once accepted. */
  readonly livenessRef: string | null
  /** User-facing error; already renderable as-is. */
  readonly error: string | null
  readonly capture: (video: File | Blob) => Promise<void>
  /**
   * Adopt a handle the customer display already verified server-side (the
   * remote dual-screen flow uploads from the other tab and hands the ref
   * back over the relay). Same contract as a local capture's success.
   */
  readonly adopt: (livenessRef: string) => void
  readonly reset: () => void
}

export const LivenessContext = createContext<LivenessValue | null>(null)

export function useLiveness(): LivenessValue {
  const value = use(LivenessContext)
  if (!value) {
    throw new Error('useLiveness must be used inside a LivenessProvider')
  }
  return value
}
