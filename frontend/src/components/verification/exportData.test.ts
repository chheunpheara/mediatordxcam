import { describe, expect, it } from 'vitest'
import { read, utils } from 'xlsx'

import { makeVerifyResult } from '@/test/fixtures'
import type { VerifyResponse } from '@/lib/api'
import {
  buildCsv,
  buildJson,
  buildXlsx,
  exportColumns,
  exportFileName,
  exportRecord,
  previewRows,
} from './exportData'

/**
 * The export builders (D17): the column set is the default selection (all of
 * it), files carry the machine forms a downstream importer expects, and the
 * three formats write the same selected keys.
 */

const FIELD_KEYS = [
  'nationalId',
  'firstNameKhmer',
  'lastNameKhmer',
  'firstNameEnglish',
  'lastNameEnglish',
  'gender',
  'dateOfBirth',
  'issuedDate',
  'expiryDate',
] as const
const STATUS_KEYS = FIELD_KEYS.map((key) => `${key}_status`)

function session(): readonly VerifyResponse[] {
  return [
    makeVerifyResult(),
    makeVerifyResult({ method: 'verify_user_info_face', face: { required: true, verified: true } }),
  ]
}

describe('exportColumns', () => {
  it('offers values, per-field statuses, the metadata and every reported section', () => {
    expect(exportColumns(session()).map((column) => column.key)).toEqual([
      ...FIELD_KEYS,
      ...STATUS_KEYS,
      'method',
      'verificationStatus',
      'faceCheck',
    ])
  })

  it('omits sections no run reported', () => {
    expect(exportColumns([makeVerifyResult()]).map((column) => column.key)).not.toContain(
      'faceCheck',
    )
  })

  it('has nothing to offer without a result', () => {
    expect(exportColumns([])).toEqual([])
  })
})

describe('exportRecord', () => {
  it('fills every column with the machine values a system imports', () => {
    const record = exportRecord(session())

    expect(record.nationalId).toBe('123456789')
    expect(record.nationalId_status).toBe('matched')
    expect(record.method).toBe('verify_user_info_face')
    expect(record.verificationStatus).toBe('success')
    expect(record.faceCheck).toBe('passed')
  })

  it('writes an empty string for a field the card did not carry', () => {
    const base = makeVerifyResult()
    const record = exportRecord([
      {
        ...base,
        identity: {
          ...base.identity,
          fields: base.identity.fields.map((field) =>
            field.field === 'nationalId' ? { ...field, submitted: null } : field,
          ),
        },
      },
    ])

    expect(record.nationalId).toBe('')
  })

  it('has nothing to export without a result', () => {
    expect(exportRecord([])).toEqual({})
  })
})

describe('buildCsv', () => {
  it('writes a BOM, the header row and one data row of the selected keys', () => {
    const text = buildCsv(['nationalId', 'method'], {
      nationalId: '123456789',
      method: 'verify_user_info',
      gender: 'F',
    })

    expect(text).toBe('\uFEFFnationalId,method\n123456789,verify_user_info\n')
  })

  it('quotes values containing commas, quotes and newlines (RFC 4180)', () => {
    const text = buildCsv(['firstNameEnglish'], {
      firstNameEnglish: 'Sokha, "The Great"\nagain',
    })

    expect(text).toContain('"Sokha, ""The Great""\nagain"')
  })

  it('writes an empty cell for a value that is missing', () => {
    expect(buildCsv(['gender'], {})).toBe('\uFEFFgender\n\n')
  })
})

describe('buildJson', () => {
  it('emits a flat object of exactly the selected columns', () => {
    const json = buildJson(['nationalId', 'method'], {
      nationalId: '123456789',
      method: 'verify_user_info',
      gender: 'F',
    })

    expect(JSON.parse(json)).toEqual({ nationalId: '123456789', method: 'verify_user_info' })
  })
})

describe('buildXlsx', () => {
  it('round-trips through a spreadsheet reader: header row then data row', async () => {
    const keys = ['nationalId', 'verificationStatus']
    const record = exportRecord(session())

    const book = read(await buildXlsx(keys, record).arrayBuffer())
    const rows = utils.sheet_to_json<unknown[]>(book.Sheets['Verification']!, { header: 1 })

    expect(rows[0]).toEqual([...keys])
    expect(rows[1]).toEqual(['123456789', 'success'])
  })
})

describe('exportFileName', () => {
  it('dates the file with the day it was exported', () => {
    expect(exportFileName('csv', new Date('2026-10-05T12:00:00Z'))).toBe(
      'camdx-verification-2026-10-05.csv',
    )
  })
})

describe('previewRows', () => {
  it('lists every value with its status word, then the checks and the summary', () => {
    const rows = previewRows(session())

    expect(rows[0]).toEqual({ label: 'National ID', value: '123456789', status: 'Matched' })
    expect(rows.some((row) => row.label === 'Face verification' && row.status === 'Passed')).toBe(
      true,
    )
    expect(rows[rows.length - 2]).toEqual({
      label: 'Verification method',
      value: 'verify_user_info_face',
      status: null,
    })
    expect(rows[rows.length - 1]).toEqual({
      label: 'Verification status',
      value: 'success',
      status: null,
    })
  })
})
