import { describe, expect, it } from 'vitest'
import { utils, write } from 'xlsx'

import { MAX_UPLOAD_FILE_BYTES, PARSE_MESSAGES, parseSpreadsheet } from './uploadParse'

/**
 * The file reader for the upload dialog (D23): both formats parse to the same
 * headers-plus-rows shape, blank and duplicate column names stay selectable,
 * and every refusal carries the exact sentence the dialog shows.
 */

function csvFile(content: string, name = 'people.csv'): File {
  return new File([content], name, { type: 'text/csv' })
}

function xlsxFile(headers: string[], rows: string[][], name = 'people.xlsx'): File {
  const workbook = utils.book_new()
  utils.book_append_sheet(workbook, utils.aoa_to_sheet([headers, ...rows]), 'People')
  const bytes = write(workbook, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer
  return new File([bytes], name, {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
}

describe('parseSpreadsheet', () => {
  it('reads a CSV into headers and rows, honouring quoted commas', async () => {
    const result = await parseSpreadsheet(csvFile('ID,Full Name,DOB\n"123, Main St",Chann,2000-01-01\n'))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.headers).toEqual(['ID', 'Full Name', 'DOB'])
    expect(result.rows).toEqual([['123, Main St', 'Chann', '2000-01-01']])
  })

  it('reads an Excel file into the same shape', async () => {
    const result = await parseSpreadsheet(
      xlsxFile(['ID', 'Name'], [['111', 'Chann'], ['222', 'Dara']]),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.headers).toEqual(['ID', 'Name'])
    expect(result.rows).toEqual([
      ['111', 'Chann'],
      ['222', 'Dara'],
    ])
  })

  it('refuses a file that is not CSV or Excel', async () => {
    const result = await parseSpreadsheet(csvFile('ID\n1', 'notes.txt'))

    expect(result).toEqual({ ok: false, reason: 'unsupported', message: PARSE_MESSAGES.unsupported })
  })

  it('refuses a file over 5 MB', async () => {
    const big = new File([new ArrayBuffer(MAX_UPLOAD_FILE_BYTES + 1)], 'big.csv')

    const result = await parseSpreadsheet(big)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('tooLarge')
    expect(result.message).toBe(PARSE_MESSAGES.tooLarge)
  })

  it('refuses a file whose every data row is blank', async () => {
    const result = await parseSpreadsheet(csvFile('ID,Name\n   ,   \n'))

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('noRows')
  })

  it('refuses a file with more than 500 data rows', async () => {
    const body = Array.from({ length: 501 }, (_row, index) => String(index)).join('\n')
    const result = await parseSpreadsheet(csvFile(`ID\n${body}\n`))

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('tooManyRows')
    expect(result.message).toBe(PARSE_MESSAGES.tooManyRows)
  })

  it('names blank header cells and suffixes duplicates so mapping keys stay unique', async () => {
    const result = await parseSpreadsheet(csvFile('ID,,ID,Name\n1,2,3,Chann\n'))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.headers).toEqual(['ID', 'Column 2', 'ID (2)', 'Name'])
  })

  it('trims cells and pads short rows to the header width', async () => {
    const result = await parseSpreadsheet(csvFile('A,B,C\n  1  ,2\n'))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.rows).toEqual([['1', '2', '']])
  })
})
