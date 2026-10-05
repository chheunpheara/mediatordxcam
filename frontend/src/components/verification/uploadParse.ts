/**
 * Read a CSV or Excel file into headers and rows (D23).
 *
 * Parsing happens in the browser so the file itself never leaves it: the
 * server receives only the values the mapping step produced — no bytes, no
 * headers, no unmapped columns (§29). `xlsx` (SheetJS) already reads both
 * formats and already writes the exports (D17), so nothing new is added for
 * it; the first worksheet is the file (multi-sheet workbooks are not a thing
 * this dialog offers).
 *
 * The failure style mirrors the document validator: an ok-flagged union whose
 * message is copy shown as-is, so a rejected file gets its answer in
 * milliseconds rather than after a round-trip.
 */

import { read, utils } from 'xlsx'

/** Passed to `accept` on the file input. */
export const ACCEPTED_UPLOAD_EXTENSIONS = '.csv,.xlsx,.xls'

/** 5 MB of spreadsheet is thousands of rows; beyond that, split the file. */
export const MAX_UPLOAD_FILE_BYTES = 5 * 1024 * 1024

/** The list endpoint accepts at most 500 records per submission. */
export const MAX_UPLOAD_ROWS = 500

export const PARSE_MESSAGES = {
  unsupported: 'Please upload a CSV or Excel file (.csv, .xlsx, .xls).',
  tooLarge: 'File is too large. Maximum size is 5 MB.',
  unreadable: 'That file could not be read. Please check it and try again.',
  noHeaders: 'The file has no header row. Its first row must name the columns.',
  noRows: 'The file has no data rows to upload.',
  tooManyRows: 'The file has more than 500 rows. Split it into a smaller upload.',
} as const

export type ParseReason = keyof typeof PARSE_MESSAGES

export interface ParseFailure {
  readonly ok: false
  readonly reason: ParseReason
  /** Copy shown as-is, mirroring the document validator's contract. */
  readonly message: string
}

export interface ParseSuccess {
  readonly ok: true
  /** The first row's names, blanks named `Column N` and duplicates suffixed. */
  readonly headers: readonly string[]
  /** Every later row, cells trimmed and padded to the header width. */
  readonly rows: readonly (readonly string[])[]
}

export type ParseResult = ParseFailure | ParseSuccess

const ACCEPTED_EXTENSIONS = ['.csv', '.xlsx', '.xls']

/** Parse `file`; the caller has already let the user pick it. */
export async function parseSpreadsheet(file: File): Promise<ParseResult> {
  const extension = extensionOf(file.name)
  if (!ACCEPTED_EXTENSIONS.includes(extension)) {
    return failure('unsupported')
  }
  if (file.size > MAX_UPLOAD_FILE_BYTES) {
    return failure('tooLarge')
  }

  let matrix: unknown[][]
  try {
    const workbook = read(await file.arrayBuffer(), { type: 'array' })
    const sheetName = workbook.SheetNames[0]
    const sheet = sheetName ? workbook.Sheets[sheetName] : undefined
    if (!sheet) {
      return failure('unreadable')
    }
    matrix = utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      raw: false,
      defval: '',
      blankrows: false,
    })
  } catch {
    return failure('unreadable')
  }

  const [headerRow, ...dataRows] = matrix
  if (!headerRow) {
    return failure('noHeaders')
  }
  if (dataRows.length === 0) {
    return failure('noRows')
  }
  if (dataRows.length > MAX_UPLOAD_ROWS) {
    return failure('tooManyRows')
  }

  const seen = new Set<string>()
  const headers = Array.from(headerRow, (_cell, index) =>
    uniqueHeader(cellText(_cell) || `Column ${index + 1}`, seen),
  )
  const rows = dataRows
    .map((row) => headers.map((_header, index) => cellText(row[index])))
    .filter((row) => row.some((cell) => cell !== ''))

  if (rows.length === 0) {
    return failure('noRows')
  }

  return { ok: true, headers, rows }
}

/**
 * One cell as trimmed text. `raw: false` already hands strings back, but the
 * matrix is typed `unknown`, and a stray object must read as blank rather
 * than as `[object Object]`.
 */
function cellText(cell: unknown): string {
  if (typeof cell === 'string') return cell.trim()
  if (typeof cell === 'number' || typeof cell === 'boolean' || typeof cell === 'bigint') {
    return String(cell).trim()
  }
  return ''
}

function failure(reason: ParseReason): ParseFailure {
  return { ok: false, reason, message: PARSE_MESSAGES[reason] }
}

function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.')
  return dot === -1 ? '' : fileName.slice(dot).toLowerCase()
}

/**
 * Blank cells become `Column N` so every column stays selectable, and a
 * duplicate name gets a ` (2)` suffix — mapping keys are column names, so two
 * columns called `Name` would otherwise overwrite each other.
 */
function uniqueHeader(name: string, seen: Set<string>): string {
  if (!seen.has(name)) {
    seen.add(name)
    return name
  }
  let suffix = 2
  while (seen.has(`${name} (${suffix})`)) {
    suffix += 1
  }
  const unique = `${name} (${suffix})`
  seen.add(unique)
  return unique
}
