import { createContext, use } from 'react'

import type { IdentityFieldName, ProcessIdCardResponse } from '../../lib/api'

import type { IdentityDraft } from './IdentityDraftContext'

/**
 * The outcome of processing the selected ID card (§19).
 *
 * Held above the router for the same reason the `File` is: §6 processes the card
 * on the landing page and *then* navigates to `/id-card`, so the result has to
 * outlive the page that produced it.
 *
 * Kept apart from the provider component so React Fast Refresh treats the hook as
 * a plain module.
 */

export type ProcessingState = 'idle' | 'processing' | 'ready' | 'failed'

export interface IdCardProcessingValue {
  readonly state: ProcessingState
  readonly result: ProcessIdCardResponse | null
  /** Already user-facing. Rendered as-is; never a raw error (§24, §28). */
  readonly error: string | null
  /**
   * Process a document. Resolves to the result, or `null` when it failed — the
   * reason is in `error`, so callers branch on the value, not on a caught throw.
   */
  readonly process: (file: File | Blob) => Promise<ProcessIdCardResponse | null>
  readonly reset: () => void
  /** The user's corrections to the OCR read (§14). See `IdentityDraftContext`. */
  readonly draft: IdentityDraft
  readonly setField: (name: IdentityFieldName, value: string) => void
  readonly clearDraft: () => void
}

export const IdCardProcessingContext = createContext<IdCardProcessingValue | null>(null)

export function useIdCardProcessing(): IdCardProcessingValue {
  const value = use(IdCardProcessingContext)
  if (!value) {
    throw new Error('useIdCardProcessing must be used inside an IdCardProcessingProvider')
  }
  return value
}