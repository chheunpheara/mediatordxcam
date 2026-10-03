import { describe, expect, it, vi } from 'vitest'

import {
  IMAGE_TOO_LARGE,
  IMAGE_TOO_LOW_RESOLUTION,
  IMAGE_UNREADABLE,
  MAX_FILE_SIZE_BYTES,
  MESSAGES,
  UNSUPPORTED_IMAGE_TYPE,
  checkFileSize,
  checkFileType,
  formatFileSize,
  validateDocumentImage,
} from './validation'

/** A file that passes every check; individual tests break one property. */
function makeFile(overrides: Partial<File> = {}): File {
  return new File(['x'], 'id-card.jpg', { type: 'image/jpeg', ...overrides })
}

const goodDimensions = { width: 1280, height: 800 }
const probeOk = vi.fn().mockResolvedValue(goodDimensions)

describe('checkFileType', () => {
  it.each(['image/jpeg', 'image/png'])('accepts %s', (type) => {
    expect(checkFileType(makeFile({ type }))).toBeNull()
  })

  it.each([
    'application/pdf',
    'image/gif',
    'image/heic',
    'image/webp',
    'video/mp4',
    // A file with no declared type is not assumable to be an image.
    '',
  ])('rejects %s', (type) => {
    expect(checkFileType(makeFile({ type }))).toEqual({
      ok: false,
      code: UNSUPPORTED_IMAGE_TYPE,
      message: MESSAGES.invalidType,
    })
  })
})

describe('checkFileSize', () => {
  it('accepts a file at exactly the limit', () => {
    const file = makeFile()
    Object.defineProperty(file, 'size', { value: MAX_FILE_SIZE_BYTES })
    expect(checkFileSize(file)).toBeNull()
  })

  it('rejects one byte over the limit', () => {
    const file = makeFile()
    Object.defineProperty(file, 'size', { value: MAX_FILE_SIZE_BYTES + 1 })
    expect(checkFileSize(file)).toEqual({
      ok: false,
      code: IMAGE_TOO_LARGE,
      message: MESSAGES.tooLarge,
    })
  })
})

describe('validateDocumentImage', () => {
  it('returns the file and dimensions when everything passes', async () => {
    const file = makeFile()
    const result = await validateDocumentImage(file, { probe: probeOk })

    expect(result).toEqual({ ok: true, file, dimensions: goodDimensions })
    expect(result.ok && result.dimensions.width).toBe(1280)
  })

  it('rejects a non-image type before decoding', async () => {
    const probe = vi.fn()
    const result = await validateDocumentImage(makeFile({ type: 'application/pdf' }), {
      probe,
    })

    expect(result).toMatchObject({ ok: false, code: UNSUPPORTED_IMAGE_TYPE })
    expect(probe).not.toHaveBeenCalled()
  })

  it('rejects an oversized file before decoding', async () => {
    const probe = vi.fn()
    const file = makeFile()
    Object.defineProperty(file, 'size', { value: MAX_FILE_SIZE_BYTES + 1 })

    const result = await validateDocumentImage(file, { probe })

    expect(result).toMatchObject({ ok: false, code: IMAGE_TOO_LARGE })
    expect(probe).not.toHaveBeenCalled()
  })

  it('rejects undecodable bytes as corrupted', async () => {
    const probe = vi.fn().mockResolvedValue(null)
    const result = await validateDocumentImage(makeFile(), { probe })

    expect(result).toEqual({
      ok: false,
      code: IMAGE_UNREADABLE,
      message: MESSAGES.unreadable,
    })
  })

  it.each([
    ['too narrow', { width: 639, height: 800 }],
    ['too short', { width: 1280, height: 479 }],
    ['tiny', { width: 100, height: 80 }],
  ])('rejects an image that is %s', async (_label, dimensions) => {
    const probe = vi.fn().mockResolvedValue(dimensions)
    const result = await validateDocumentImage(makeFile(), { probe })

    expect(result).toEqual({
      ok: false,
      code: IMAGE_TOO_LOW_RESOLUTION,
      message: MESSAGES.tooSmall,
    })
  })

  it.each([
    ['exact minimum width', { width: 640, height: 480 }],
    ['minimum with portrait ratio', { width: 640, height: 900 }],
    ['above minimum', { width: 1920, height: 1080 }],
  ])('accepts %s', async (_label, dimensions) => {
    const probe = vi.fn().mockResolvedValue(dimensions)
    const result = await validateDocumentImage(makeFile(), { probe })

    expect(result.ok).toBe(true)
  })

  it('propagates a probe that rejects instead of returning null', async () => {
    const probe = vi.fn().mockRejectedValue(new Error('decode exploded'))
    await expect(validateDocumentImage(makeFile(), { probe })).rejects.toThrow(
      'decode exploded',
    )
  })
})

describe('formatFileSize', () => {
  it.each([
    [512, '512 B'],
    [2048, '2 KB'],
    [1_500_000, '1.4 MB'],
  ])('formats %i bytes as %s', (bytes, expected) => {
    expect(formatFileSize(bytes)).toBe(expected)
  })
})