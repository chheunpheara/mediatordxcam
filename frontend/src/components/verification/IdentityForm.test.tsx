import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { IdentityForm } from '@/components/verification/IdentityForm'
import { IdCardProcessingProvider } from '@/features/id-card-processing/IdCardProcessingProvider'
import type { IdentityFields, IdentityResponse } from '@/lib/api'

function fields(overrides: Partial<IdentityFields> = {}): IdentityFields {
  return {
    nationalId: null,
    firstNameKhmer: null,
    lastNameKhmer: null,
    firstNameEnglish: null,
    lastNameEnglish: null,
    gender: null,
    dateOfBirth: null,
    issuedDate: null,
    expiryDate: null,
    ...overrides,
  }
}

function renderForm(ocr: IdentityResponse) {
  return render(
    <IdCardProcessingProvider>
      <IdentityForm ocr={ocr} hasDraft={false} />
    </IdCardProcessingProvider>,
  )
}

describe('the OCR status line', () => {
  it('counts the fields actually prompting, not the card-required set', () => {
    // `missingFields` is only the card's required subset (two here), while
    // four of the nine form fields are empty and show a prompt each — the
    // banner must agree with what the user can see.
    renderForm({
      status: 'partial',
      documentType: 'khmer_id_card',
      fields: fields({
        nationalId: '123',
        firstNameKhmer: 'ដ',
        firstNameEnglish: 'Jane',
        lastNameEnglish: 'Doe',
        gender: 'F',
      }),
      missingFields: ['lastNameKhmer', 'dateOfBirth'],
    })

    expect(screen.getByRole('status')).toHaveTextContent('4 highlighted fields')
    expect(screen.getByText(/4 required fields still need values/)).toBeInTheDocument()
  })

  it('says field in the singular when one field is prompting', () => {
    renderForm({
      status: 'partial',
      documentType: 'khmer_id_card',
      fields: fields({
        nationalId: '123',
        firstNameKhmer: 'ដ',
        lastNameKhmer: 'ក',
        firstNameEnglish: 'Jane',
        lastNameEnglish: 'Doe',
        gender: 'F',
        dateOfBirth: '1988-12-05',
        issuedDate: '2022-01-15',
      }),
      missingFields: ['dateOfBirth'],
    })

    expect(screen.getByRole('status')).toHaveTextContent('Check the highlighted field and fill it in')
    expect(screen.getByText(/One required field still needs a value/)).toBeInTheDocument()
  })

  it('never claims highlighted fields when every field has a value', () => {
    renderForm({
      status: 'partial',
      documentType: 'khmer_id_card',
      fields: fields({
        nationalId: '123',
        firstNameKhmer: 'ដ',
        lastNameKhmer: 'ក',
        firstNameEnglish: 'Jane',
        lastNameEnglish: 'Doe',
        gender: 'F',
        dateOfBirth: '1988-12-05',
        issuedDate: '2022-01-15',
        expiryDate: '2032-01-15',
      }),
      missingFields: ['dateOfBirth'],
    })

    expect(screen.getByRole('status')).toHaveTextContent('Check the values above')
    expect(screen.queryByText(/highlighted/)).not.toBeInTheDocument()
  })
})
