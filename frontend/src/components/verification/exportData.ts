import { utils, write } from 'xlsx'

import type { VerifyResponse } from '../../lib/api'
import { fieldLabel } from './identityFields'
import { sectionKeyFor, sectionsOf } from './sectionRows'
import { sectionWord, statusWord } from './statusDisplay'

/**
 * Turning the session's verified data into a file another system can read
 * (D17). Everything here is pure: the modal chooses columns and a format,
 * these functions turn that choice into bytes.
 *
 * A column set is exactly what the modal offered — `exportColumns` is the
 * default (all of them) and `exportRecord` holds every value, so a selection
 * is only ever a filter over the same keys. Values are the machine forms a
 * downstream importer expects: raw §14 field names, the `FieldCheckStatus`
 * enums, the method id, and `passed`/`failed`/`not_checked` for sections.
 */

export interface ExportColumn {
  readonly key: string
  readonly label: string
}

export type ExportFormat = 'xlsx' | 'csv' | 'json'

export const EXPORT_FORMATS: readonly ExportFormat[] = ['xlsx', 'csv', 'json']

const MIME: Readonly<Record<ExportFormat, string>> = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv;charset=utf-8',
  json: 'application/json;charset=utf-8',
}

/** Every column the session can offer — the default selection is all of them. */
export function exportColumns(history: readonly VerifyResponse[]): readonly ExportColumn[] {
  const latest = history[history.length - 1]
  if (!latest) return []

  const fields: readonly ExportColumn[] = latest.identity.fields.map((field) => ({
    key: field.field,
    label: fieldLabel(field.field),
  }))
  const statuses: readonly ExportColumn[] = latest.identity.fields.map((field) => ({
    key: `${field.field}_status`,
    label: `${fieldLabel(field.field)} — status`,
  }))
  const meta: readonly ExportColumn[] = [
    { key: 'method', label: 'Verification method' },
    { key: 'verificationStatus', label: 'Verification status' },
  ]
  const checks: readonly ExportColumn[] = sectionsOf(history).map((row) => ({
    key: sectionKeyFor(row.label) ?? row.label,
    label: row.label,
  }))

  return [...fields, ...statuses, ...meta, ...checks]
}

/** key → value for every available column (empty string where a value is null). */
export function exportRecord(history: readonly VerifyResponse[]): Readonly<Record<string, string>> {
  const latest = history[history.length - 1]
  if (!latest) return {}

  const record: Record<string, string> = {}
  for (const field of latest.identity.fields) {
    record[field.field] = field.submitted ?? ''
    record[`${field.field}_status`] = field.status
  }
  record.method = latest.method
  record.verificationStatus = latest.status
  for (const row of sectionsOf(history)) {
    const key = sectionKeyFor(row.label)
    if (key === null) continue
    record[key] =
      row.status === 'matched' ? 'passed' : row.status === 'mismatch' ? 'failed' : 'not_checked'
  }
  return record
}

/** RFC 4180 quoting, plus a BOM so Excel reads the Khmer names as UTF-8. */
export function buildCsv(keys: readonly string[], record: Readonly<Record<string, string>>): string {
  const escape = (value: string): string =>
    /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
  const header = keys.map(escape).join(',')
  const row = keys.map((key) => escape(record[key] ?? '')).join(',')
  return `\uFEFF${header}\n${row}\n`
}

/** A flat object of the selected columns — what an importer POSTs as JSON. */
export function buildJson(
  keys: readonly string[],
  record: Readonly<Record<string, string>>,
): string {
  const selected: Record<string, string> = {}
  for (const key of keys) selected[key] = record[key] ?? ''
  return JSON.stringify(selected, null, 2)
}

/** One sheet, one header row, one data row — readable by any spreadsheet tool. */
export function buildXlsx(keys: readonly string[], record: Readonly<Record<string, string>>): Blob {
  const rows = [[...keys], keys.map((key) => record[key] ?? '')]
  const book = utils.book_new()
  utils.book_append_sheet(book, utils.aoa_to_sheet(rows), 'Verification')
  const bytes = write(book, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer
  return new Blob([bytes], { type: MIME.xlsx })
}

export function buildExport(
  format: ExportFormat,
  keys: readonly string[],
  record: Readonly<Record<string, string>>,
): Blob {
  if (format === 'xlsx') return buildXlsx(keys, record)
  if (format === 'csv') return new Blob([buildCsv(keys, record)], { type: MIME.csv })
  return new Blob([buildJson(keys, record)], { type: MIME.json })
}

/** Stable, dated, extension-matching — `camdx-verification-2026-10-05.csv`. */
export function exportFileName(format: ExportFormat, today: Date = new Date()): string {
  return `camdx-verification-${today.toISOString().slice(0, 10)}.${format}`
}

export function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

/** The preview rows: every verified value beside its status, sections included. */
export interface PreviewRow {
  readonly label: string
  readonly value: string
  readonly status: string | null
}

export function previewRows(history: readonly VerifyResponse[]): readonly PreviewRow[] {
  const latest = history[history.length - 1]
  if (!latest) return []

  const fields: readonly PreviewRow[] = latest.identity.fields.map((field) => ({
    label: fieldLabel(field.field),
    value: field.submitted ?? '',
    status: statusWord(field.status),
  }))
  const checks: readonly PreviewRow[] = sectionsOf(history).map((row) => ({
    label: row.label,
    value: '',
    status: sectionWord(row.status),
  }))
  const meta: readonly PreviewRow[] = [
    { label: 'Verification method', value: latest.method, status: null },
    { label: 'Verification status', value: latest.status, status: null },
  ]
  return [...fields, ...checks, ...meta]
}
