import { useCallback, useRef, useState } from 'react'
import type { RefObject } from 'react'

/**
 * The customer's webcam frames, arriving at ~12 fps (Phase 7).
 *
 * Frames are drawn onto one canvas that is never cleared. Swapping an
 * `<img>.src` at this rate blanks the element between paints — an undecoded
 * JPEG shows nothing, so the preview flickered and the box behind it flashed
 * with it. A canvas keeps the last frame's pixels until the next one has
 * decoded, so the picture is continuous; and with no background of its own it
 * is transparent wherever the frame does not cover it.
 */
export function useLiveFrame(): {
  canvasRef: RefObject<HTMLCanvasElement | null>
  hasFrame: boolean
  acceptFrame: (dataUrl: string) => void
} {
  const [hasFrame, setHasFrame] = useState(false)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const decoderRef = useRef<HTMLImageElement | null>(null)

  const acceptFrame = useCallback((dataUrl: string) => {
    const decoder = (decoderRef.current ??= new Image())
    decoder.onerror = () => undefined // keep the frame already on the canvas
    decoder.onload = () => {
      const canvas = canvasRef.current
      if (canvas) {
        const { naturalWidth, naturalHeight } = decoder
        // Resize only once, and only to a real size: clearing the bitmap
        // between frames is the blink this whole function exists to avoid.
        if (
          naturalWidth > 0 &&
          naturalHeight > 0 &&
          (canvas.width !== naturalWidth || canvas.height !== naturalHeight)
        ) {
          canvas.width = naturalWidth
          canvas.height = naturalHeight
        }
        canvas.getContext('2d')?.drawImage(decoder, 0, 0)
      }
      setHasFrame(true)
    }
    decoder.src = dataUrl
  }, [])

  return { canvasRef, hasFrame, acceptFrame }
}
