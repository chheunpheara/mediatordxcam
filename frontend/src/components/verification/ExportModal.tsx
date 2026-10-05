import { useEffect, useRef, useState } from 'react'

import type { VerifyResponse } from '../../lib/api'
import {
  EXPORT_FORMATS,
  buildExport,
  downloadBlob,
  exportColumns,
  exportFileName,
  exportRecord,
  previewRows,
} from './exportData'
import type { ExportFormat } from './exportData'

/**
 * The export dialog (D17): everything this session has verified, a column
 * picker, and xlsx / csv / json output — a file another system can import.
 *
 * Every column starts selected, so the untouched dialog exports all of the
 * available data; deselecting is the only way to narrow it. The preview shows
 * the same data in human words, while the file keeps the machine forms (raw
 * field names, `matched`, the method id) a downstream importer expects.
 *
 * Three exits, like the card preview: Close, Escape, the backdrop. Opening
 * moves focus to Close and closing gives it back to the button that opened
 * this dialog.
 */
export function ExportModal({
  history,
  onClose,
}: {
  readonly history: readonly VerifyResponse[]
  readonly onClose: () => void
}) {
  const columns = exportColumns(history)
  const record = exportRecord(history)
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set(columns.map((column) => column.key)),
  )
  const [format, setFormat] = useState<ExportFormat>('xlsx')
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

  const toggle = (key: string): void => {
    setSelected((previous) => {
      const next = new Set(previous)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const keys = columns.filter((column) => selected.has(column.key)).map((column) => column.key)
  const rows = previewRows(history)

  const handleDownload = (): void => {
    if (keys.length === 0) return
    downloadBlob(buildExport(format, keys, record), exportFileName(format))
  }

  return (
    // Backdrop: a click anywhere outside the dialog closes it.
    <div
      className="bg-ink/80 fixed inset-0 z-50 flex items-center justify-center p-4"
      onClick={onClose}
      role="presentation"
    >
      {/* Dialog: clicks inside must not fall through to the backdrop. */}
      <div
        aria-label="Export verified data"
        aria-modal="true"
        className="bg-surface text-ink max-h-[90vh] w-full max-w-4xl overflow-auto rounded-lg p-6"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold">Export verified data</h2>
            <p className="text-ink-subtle mt-1 text-xs">
              Choose the columns and a file format. Every column is selected by default.
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

        <section className="mt-5">
          <h3 className="text-sm font-semibold">Available verified data</h3>
          <table className="mt-2 w-full text-left text-xs">
            <thead className="text-ink-subtle">
              <tr>
                <th className="py-1 pr-3 font-medium">Field</th>
                <th className="py-1 pr-3 font-medium">Value</th>
                <th className="py-1 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr className="border-border border-t" key={row.label}>
                  <td className="py-1.5 pr-3">{row.label}</td>
                  <td className="py-1.5 pr-3">{row.value === '' ? '—' : row.value}</td>
                  <td className="py-1.5">{row.status ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <fieldset className="mt-5">
          <legend className="text-sm font-semibold">Columns to export</legend>
          <div className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1.5 sm:grid-cols-2">
            {columns.map((column) => (
              <label className="flex items-center gap-2 text-xs" key={column.key}>
                <input
                  checked={selected.has(column.key)}
                  className="accent-brand"
                  onChange={() => toggle(column.key)}
                  type="checkbox"
                />
                {column.label}
              </label>
            ))}
          </div>
          {selected.size === 0 ? (
            <p className="text-negative mt-2 text-xs" role="status">
              Select at least one column to export.
            </p>
          ) : null}
        </fieldset>

        <fieldset className="mt-5">
          <legend className="text-sm font-semibold">File format</legend>
          <div className="mt-2 flex gap-4">
            {EXPORT_FORMATS.map((option) => (
              <label className="flex items-center gap-2 text-xs" key={option}>
                <input
                  checked={format === option}
                  className="accent-brand"
                  name="export-format"
                  onChange={() => setFormat(option)}
                  type="radio"
                />
                {`${option.toUpperCase()} (.${option})`}
              </label>
            ))}
          </div>
        </fieldset>

        <div className="mt-6 flex justify-end gap-2">
          <button className="btn-secondary px-4 py-1.5" onClick={onClose} type="button">
            Cancel
          </button>
          <button
            className="btn-primary px-4 py-1.5"
            disabled={selected.size === 0}
            onClick={handleDownload}
            type="button"
          >
            Download file
          </button>
        </div>
      </div>
    </div>
  )
}
