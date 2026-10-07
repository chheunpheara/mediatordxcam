import { useVerification } from '../../features/verification/VerificationContext'

/**
 * The method dropdown and the card saying what the chosen one asks for (§9,
 * §10) — the same control the panel opens with, rendered wherever a run can be
 * started: the panel that leads up to it, and the dialog itself, so a method
 * can be swapped and re-run without leaving the report.
 *
 * Both copies read `selected` and `select` from the one provider, so they can
 * never disagree: change either and both move, along with the preview column
 * that follows the choice.
 *
 * Which methods exist, which are runnable, and what each needs all come from
 * the backend (§11). There is no `if (method === 'verify_user_info')` here —
 * `id` is the only thing the two copies differ by, since two selects cannot
 * share one HTML id.
 */
export function MethodPicker({
  id,
  className = '',
}: {
  readonly id: string
  readonly className?: string
}) {
  const { methods, selected, select } = useVerification()

  if (methods.length === 0) {
    return (
      <p className={`text-ink-subtle text-xs ${className}`} role="status">
        Loading the verification methods…
      </p>
    )
  }

  return (
    <div className={className}>
      <label className="block" htmlFor={id}>
        <span className="text-ink-muted block text-xs font-medium">Method</span>
        <select
          aria-label="Verification method"
          className="border-border bg-surface text-ink focus:border-brand mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:outline-none"
          id={id}
          name="verification-method"
          onChange={(event) => select(event.target.value as (typeof methods)[number]['method'])}
          value={selected ?? ''}
        >
          {methods.map((method) => (
            <option key={method.method} value={method.method}>
              {method.label} — {method.officialName}
            </option>
          ))}
        </select>
      </label>

      {selected ? (
        <div className="border-border bg-surface-sunken mt-3 rounded-lg border p-3">
          {(() => {
            const method = methods.find((m) => m.method === selected)
            if (!method) return null
            const runnable = method.available && !method.isOcr
            return (
              <>
                <p className="text-sm font-semibold">{method.label}</p>
                <p className="text-ink-subtle block text-xs">{method.officialName}</p>
                <RequiresList method={method} />
                {!runnable && method.unavailableReason ? (
                  <span className="text-ink-subtle mt-1 block text-xs leading-relaxed">
                    {method.unavailableReason}
                  </span>
                ) : null}
              </>
            )
          })()}
        </div>
      ) : null}
    </div>
  )
}

/** What this method asks for, in the user's words (§10). */
function RequiresList({
  method,
}: {
  method: {
    requiresUserInfo: boolean
    requiresCurrentFace: boolean
    requiresIdCard: boolean
    requiresLiveness: boolean
    requiresPassport: boolean
  }
}) {
  const needs = [
    method.requiresUserInfo && 'identity information',
    method.requiresCurrentFace && 'your current face',
    method.requiresIdCard && 'your ID card',
    method.requiresLiveness && 'liveness',
    method.requiresPassport && 'your passport',
  ].filter(Boolean) as string[]

  return (
    <span className="text-ink-subtle mt-1 block text-xs">
      {needs.length > 0 ? `Needs: ${needs.join(', ')}.` : 'Needs nothing else.'}
    </span>
  )
}
