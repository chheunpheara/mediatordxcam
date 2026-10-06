const MIME_CANDIDATES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
  'video/mp4',
] as const

/** First container the browser can actually record, so webm-only UAs get a path too. */
export function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined
  for (const candidate of MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(candidate)) return candidate
  }
  return undefined
}
