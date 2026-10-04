/**
 * Client-side document image validation (§7).
 *
 * The browser checks first so the user gets an answer in milliseconds instead of
 * after an upload. That is UX, not security: the backend re-validates every file
 * and treats the browser check as a hint (§38).
 *
 * Error codes are the *same strings* the API returns, so a message shown now and
 * a rejection later cannot disagree about what went wrong.
 */

export const UNSUPPORTED_IMAGE_TYPE = 'UNSUPPORTED_IMAGE_TYPE'
export const IMAGE_TOO_LARGE = 'IMAGE_TOO_LARGE'
export const IMAGE_TOO_LOW_RESOLUTION = 'IMAGE_TOO_LOW_RESOLUTION'
export const IMAGE_UNREADABLE = 'IMAGE_UNREADABLE'

export type ValidationCode =
  | typeof UNSUPPORTED_IMAGE_TYPE
  | typeof IMAGE_TOO_LARGE
  | typeof IMAGE_TOO_LOW_RESOLUTION
  | typeof IMAGE_UNREADABLE

export interface ValidationFailure {
  readonly ok: false
  readonly code: ValidationCode
  /** Exact copy mandated by §7. Do not reword. */
  readonly message: string
}

export interface ImageDimensions {
  readonly width: number
  readonly height: number
}

export interface ValidationSuccess {
  readonly ok: true
  readonly file: File
  readonly dimensions: ImageDimensions
}

export type ValidationResult = ValidationSuccess | ValidationFailure

/** §6: JPG, JPEG, PNG and WebP. */
export const ACCEPTED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const

/** Passed to `accept` on the file input. */
export const ACCEPTED_FILE_EXTENSIONS = '.jpg,.jpeg,.png,.webp'

/** §7: 10 MB. Binary megabytes, matching how browsers report `File.size`. */
export const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024

/** §7: 640 × 480. */
export const MIN_WIDTH_PX = 640
export const MIN_HEIGHT_PX = 480

export const MESSAGES = {
  invalidType: 'Please upload a JPG, PNG or WebP image.',
  tooLarge: 'File is too large. Maximum size is 10 MB.',
  tooSmall: 'Image is too small. Minimum resolution is 640 × 480 pixels.',
  unreadable: 'File is corrupted or cannot be read as an image.',
} as const

export function checkFileType(file: File): ValidationResult | null {
  if (!(ACCEPTED_MIME_TYPES as readonly string[]).includes(file.type)) {
    return { ok: false, code: UNSUPPORTED_IMAGE_TYPE, message: MESSAGES.invalidType }
  }
  return null
}

export function checkFileSize(file: File): ValidationResult | null {
  if (file.size > MAX_FILE_SIZE_BYTES) {
    return { ok: false, code: IMAGE_TOO_LARGE, message: MESSAGES.tooLarge }
  }
  return null
}

export function checkResolution(
  dimensions: ImageDimensions,
): ValidationResult | null {
  const { width, height } = dimensions
  if (width < MIN_WIDTH_PX || height < MIN_HEIGHT_PX) {
    return { ok: false, code: IMAGE_TOO_LOW_RESOLUTION, message: MESSAGES.tooSmall }
  }
  return null
}

/**
 * Read the pixel dimensions of an image without uploading it.
 *
 * `createImageBitmap` is preferred: it decodes off the main thread and does not
 * need an object URL. Where it is missing (jsdom, older Safari) we fall back to
 * an `Image` element, which needs the URL revoked afterwards or the blob is
 * retained for the lifetime of the document.
 *
 * Returns null when the bytes cannot be decoded at all.
 */
export async function probeImageDimensions(
  file: File | Blob,
): Promise<ImageDimensions | null> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file)
      const dimensions = { width: bitmap.width, height: bitmap.height }
      bitmap.close()
      return dimensions
    } catch {
      return null
    }
  }

  return probeViaImageElement(file)
}

function probeViaImageElement(file: File | Blob): Promise<ImageDimensions | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file)
    const image = new Image()

    const finish = (dimensions: ImageDimensions | null) => {
      URL.revokeObjectURL(url)
      resolve(dimensions)
    }

    image.onload = () => finish({ width: image.naturalWidth, height: image.naturalHeight })
    image.onerror = () => finish(null)
    image.src = url
  })
}

export interface ValidateOptions {
  /** Injected by tests; defaults to a real decode. */
  readonly probe?: (file: File) => Promise<ImageDimensions | null>
}

/**
 * Run every §7 check, cheapest first.
 *
 * Order matters: type and size are synchronous reads of metadata, so a rejected
 * 40 MB video never costs a decode. Decoding only happens once the cheap checks
 * pass.
 */
export async function validateDocumentImage(
  file: File,
  { probe = probeImageDimensions }: ValidateOptions = {},
): Promise<ValidationResult> {
  const typeFailure = checkFileType(file)
  if (typeFailure) return typeFailure

  const sizeFailure = checkFileSize(file)
  if (sizeFailure) return sizeFailure

  const dimensions = await probe(file)
  if (!dimensions) {
    return { ok: false, code: IMAGE_UNREADABLE, message: MESSAGES.unreadable }
  }

  const resolutionFailure = checkResolution(dimensions)
  if (resolutionFailure) return resolutionFailure

  return { ok: true, file, dimensions }
}

/** Compact size for the preview caption, e.g. `1.4 MB`. */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}