import { useEffect, useRef, useState } from 'react'

import {
  ApiError,
  fetchIntegrationSettings,
  saveIntegrationSettings,
  testConnection,
} from '../../lib/api'

/**
 * The "Post Settings" dialog (D19): which core systems receive verification
 * results, and the Basic-auth credentials to reach them.
 *
 * Passwords are write-only by contract — the server never sends one back —
 * so a saved row shows a "leave blank to keep" placeholder instead, and a
 * blank there means exactly that. Every row's validation failure arrives as
 * `settings.<index>.<field>` and is rendered under the field it belongs to.
 *
 * Each row also offers "Test Connection" (D22): the server probes the values
 * as typed — a blank password on a saved row uses the stored credential, the
 * rule a save keeps — and answers in fixed safe words, so a broken URL or
 * refused credential is caught before anything is saved. Editing the row
 * drops its stale result.
 *
 * Three exits, like the export dialog: Close, Escape, the backdrop. Opening
 * moves focus to Close; closing returns it to the button that opened this.
 */
export function PostSettingsModal({ onClose }: { readonly onClose: () => void }) {
  const [rows, setRows] = useState<Row[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Readonly<Record<string, string>>>({})
  const [saving, setSaving] = useState(false)
  const [testResults, setTestResults] = useState<Readonly<Record<string, TestState>>>({})
  const closeButtonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    closeButtonRef.current?.focus()
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      opener?.focus()
    }
  }, [onClose])

  useEffect(() => {
    let cancelled = false
    fetchIntegrationSettings()
      .then((settings) => {
        if (cancelled) return
        setRows(settings.map(toRow))
      })
      .catch((cause: unknown) => {
        if (cancelled) return
        setLoadError(cause instanceof ApiError ? cause.message : 'Something went wrong. Please try again.')
      })
    return () => {
      cancelled = true
    }
  }, [])

  const update = (key: string, patch: Partial<Omit<Row, 'key'>>): void => {
    setRows((current) =>
      current === null ? current : current.map((row) => (row.key === key ? { ...row, ...patch } : row)),
    )
    // A changed row invalidates its last probe — a green tick must never
    // describe values that are no longer on screen.
    setTestResults((current) => {
      if (!(key in current)) return current
      const next = { ...current }
      delete next[key]
      return next
    })
  }

  const addRow = (): void => {
    setRows((current) => [...(current ?? []), newRow()])
  }

  const removeRow = (key: string): void => {
    setRows((current) => (current === null ? current : current.filter((row) => row.key !== key)))
    setTestResults((current) => {
      if (!(key in current)) return current
      const next = { ...current }
      delete next[key]
      return next
    })
  }

  const handleTest = async (row: Row): Promise<void> => {
    setTestResults((current) => ({
      ...current,
      [row.key]: { status: 'testing', message: '' },
    }))
    try {
      const outcome = await testConnection({
        id: row.id,
        url: row.url.trim(),
        apiUser: row.apiUser.trim(),
        apiPassword: row.apiPassword,
      })
      setTestResults((current) => ({
        ...current,
        [row.key]: outcome.ok
          ? { status: 'ok', message: 'Connection succeeded.' }
          : { status: 'failed', message: outcome.reason ?? 'Something went wrong. Please try again.' },
      }))
    } catch (cause: unknown) {
      setTestResults((current) => ({
        ...current,
        [row.key]: {
          status: 'failed',
          message: cause instanceof ApiError ? cause.message : 'Something went wrong. Please try again.',
        },
      }))
    }
  }

  const handleSave = async (): Promise<void> => {
    if (rows === null) return
    setSaving(true)
    setSaveError(null)
    setFieldErrors({})
    try {
      await saveIntegrationSettings(
        rows.map((row) => ({
          id: row.id,
          url: row.url.trim(),
          apiUser: row.apiUser.trim(),
          apiPassword: row.apiPassword,
        })),
      )
      onClose()
    } catch (cause: unknown) {
      if (cause instanceof ApiError) {
        setSaveError(cause.message)
        setFieldErrors(cause.fieldErrors)
      } else {
        setSaveError('Something went wrong. Please try again.')
      }
    } finally {
      setSaving(false)
    }
  }

  const incomplete = rows !== null && rows.some(rowIncomplete)

  return (
    // Backdrop: a click anywhere outside the dialog closes it.
    <div
      className="bg-ink/80 fixed inset-0 z-50 flex items-center justify-center p-4"
      onClick={onClose}
      role="presentation"
    >
      {/* Dialog: clicks inside must not fall through to the backdrop. */}
      <div
        aria-label="Post settings"
        aria-modal="true"
        className="bg-surface text-ink max-h-[90vh] w-full max-w-3xl overflow-auto rounded-lg p-6"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold">Post settings</h2>
            <p className="text-ink-subtle mt-1 text-xs">
              The core systems that receive every verification result. Credentials stay on the
              server.
            </p>
          </div>
          <button
            className="btn-secondary shrink-0 px-3 py-1.5"
            onClick={onClose}
            ref={closeButtonRef}
            type="button"
          >
            Close
          </button>
        </div>

        {loadError ? (
          <p className="border-negative bg-negative-soft text-negative mt-4 rounded-lg border px-4 py-3 text-sm" role="alert">
            {loadError}
          </p>
        ) : null}

        {rows !== null && rows.length > 0 ? (
          <ul className="mt-5 space-y-4">
            {rows.map((row, index) => {
              const test = testResults[row.key]
              return (
                <li className="border-border rounded-lg border p-4" key={row.key}>
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="text-sm font-semibold">{`System ${index + 1}`}</h3>
                    <button
                      aria-label={`Remove system ${index + 1}`}
                      className="text-ink-subtle hover:text-negative p-1"
                      onClick={() => removeRow(row.key)}
                      type="button"
                    >
                      <svg
                        aria-hidden="true"
                        fill="none"
                        stroke="currentColor"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        viewBox="0 0 24 24"
                      >
                        <path d="M18 6 6 18M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                  <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
                    <Field
                      ariaLabel={`System ${index + 1} URL`}
                      error={fieldErrors[`settings.${index}.url`]}
                      label="System URL"
                      onChange={(value) => update(row.key, { url: value })}
                      placeholder="https://core.example/post"
                      value={row.url}
                    />
                    <Field
                      ariaLabel={`System ${index + 1} API user`}
                      error={fieldErrors[`settings.${index}.apiUser`]}
                      label="API user"
                      onChange={(value) => update(row.key, { apiUser: value })}
                      placeholder="svc_camdx"
                      value={row.apiUser}
                    />
                    <Field
                      ariaLabel={`System ${index + 1} API password`}
                      error={fieldErrors[`settings.${index}.apiPassword`]}
                      label="API password"
                      onChange={(value) => update(row.key, { apiPassword: value })}
                      placeholder={row.id === null ? 'Required' : 'Leave blank to keep'}
                      type="password"
                      value={row.apiPassword}
                    />
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1">
                    <button
                      className="btn-secondary px-3 py-1.5 text-xs"
                      disabled={rowIncomplete(row) || saving || test?.status === 'testing'}
                      onClick={() => void handleTest(row)}
                      type="button"
                    >
                      {test?.status === 'testing' ? 'Testing…' : 'Test Connection'}
                    </button>
                    {test && test.status !== 'testing' ? (
                      <p
                        className={`text-xs ${test.status === 'ok' ? 'text-positive' : 'text-negative'}`}
                        role={test.status === 'ok' ? 'status' : 'alert'}
                      >
                        {test.message}
                      </p>
                    ) : null}
                  </div>
                </li>
              )
            })}
          </ul>
        ) : rows !== null ? (
          <p className="text-ink-subtle mt-5 text-sm" role="status">
            No systems configured yet. Add one to start posting results.
          </p>
        ) : null}

        <button
          className="border-border text-ink mt-4 flex items-center gap-1.5 rounded-lg border border-dashed px-3 py-2 text-xs font-medium"
          onClick={addRow}
          type="button"
        >
          <svg
            aria-hidden="true"
            fill="none"
            height="14"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            viewBox="0 0 24 24"
            width="14"
          >
            <path d="M12 5v14M5 12h14" />
          </svg>
          Add system
        </button>

        {saveError && Object.keys(fieldErrors).length === 0 ? (
          <p className="border-negative bg-negative-soft text-negative mt-4 rounded-lg border px-4 py-3 text-sm" role="alert">
            {saveError}
          </p>
        ) : null}

        <div className="mt-6 flex justify-end gap-2">
          <button className="btn-secondary px-4 py-1.5" onClick={onClose} type="button">
            Cancel
          </button>
          <button
            className="btn-primary px-4 py-1.5"
            disabled={rows === null || incomplete || saving}
            onClick={() => void handleSave()}
            type="button"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}

interface Row {
  readonly key: string
  readonly id: string | null
  readonly url: string
  readonly apiUser: string
  readonly apiPassword: string
}

/** A row's last "Test Connection" probe (D22); `message` is '' while in flight. */
interface TestState {
  readonly status: 'testing' | 'ok' | 'failed'
  readonly message: string
}

/** The same bar for Save and Test: a row must be filled in to be checked. */
function rowIncomplete(row: Row): boolean {
  return !row.url.trim() || !row.apiUser.trim() || (row.id === null && !row.apiPassword)
}

let rowSequence = 0

function newRow(): Row {
  rowSequence += 1
  return { key: `row_${rowSequence}`, id: null, url: '', apiUser: '', apiPassword: '' }
}

function toRow(setting: { id: string; url: string; apiUser: string }): Row {
  rowSequence += 1
  return { key: `row_${rowSequence}`, id: setting.id, url: setting.url, apiUser: setting.apiUser, apiPassword: '' }
}

function Field({
  ariaLabel,
  error,
  label,
  onChange,
  placeholder,
  type = 'text',
  value,
}: {
  readonly ariaLabel: string
  readonly error: string | undefined
  readonly label: string
  readonly onChange: (value: string) => void
  readonly placeholder: string
  readonly type?: string
  readonly value: string
}) {
  return (
    <label className="block text-xs">
      <span className="text-ink-subtle font-medium">{label}</span>
      <input
        aria-label={ariaLabel}
        className={`border-border mt-1 w-full rounded-md border px-2 py-1.5 text-sm ${error ? 'border-negative' : ''}`}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        type={type}
        value={value}
      />
      {error ? (
        <span className="text-negative mt-1 block text-xs" role="status">
          {error}
        </span>
      ) : null}
    </label>
  )
}
