import { createContext, use } from 'react'

import type { IdentityFieldName, IdentityFields } from '../../lib/api'

/**
 * The user's corrections to the OCR read (§14).
 *
 * §14 makes every field editable so the user can fix OCR mistakes. Those
 * corrections are held here, above the router, for two reasons: the workspace is
 * reachable from a bookmark or a refresh, and re-rendering the form from the raw
 * OCR payload would otherwise throw the user's typing away every time the form
 * remounts.
 *
 * Nothing here is persisted. The corrected values are what §19 `POST
 * /api/v1/kyc/verify` receives as "user information"; the browser holds them
 * until then, and they are not written anywhere on the server.
 */

/** A field the user has changed, keyed by field name. */
export type IdentityDraft = Readonly<Partial<Record<IdentityFieldName, string>>>

export interface IdentityDraftValue {
  /** What the user has corrected so far, overriding the OCR read. */
  readonly draft: IdentityDraft
  /** Edit one field. An empty value is stored as an empty string, not removed. */
  readonly setField: (name: IdentityFieldName, value: string) => void
  /** Drop every correction and fall back to the raw OCR values. */
  readonly clear: () => void
}

export const IdentityDraftContext = createContext<IdentityDraftValue | null>(null)

export function useIdentityDraft(): IdentityDraftValue {
  const value = use(IdentityDraftContext)
  if (!value) {
    throw new Error('useIdentityDraft must be used inside an IdCardProcessingProvider')
  }
  return value
}

/**
 * Merge OCR output with the user's corrections.
 *
 * Corrections win over OCR, and an empty correction is honoured as empty rather
 * than falling back to the OCR value — the user clearing a field on purpose is a
 * correction, not a request to see the wrong value back.
 */
export function resolveIdentity(
  ocr: IdentityFields,
  draft: IdentityDraft,
): Record<IdentityFieldName, string> {
  const resolved = {} as Record<IdentityFieldName, string>
  for (const [name, value] of Object.entries(ocr) as [IdentityFieldName, string | null][]) {
    resolved[name] = draft[name] ?? value ?? ''
  }
  return resolved
}