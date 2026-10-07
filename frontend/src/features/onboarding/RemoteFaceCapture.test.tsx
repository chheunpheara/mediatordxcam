import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const openOnboardingSocket = vi.hoisted(() => vi.fn())
const faceCapture = vi.hoisted(() => ({
  capture: vi.fn((_file: Blob) => Promise.resolve()),
  faceRef: null as string | null,
}))

vi.mock('./onboardingSocket', async (importOriginal) => ({
  // The real refusal wording stays in place — only the socket is faked.
  ...(await importOriginal<typeof OnboardingSocketModule>()),
  openOnboardingSocket,
}))
vi.mock('../face-capture/FaceCaptureContext', () => ({
  useFaceCapture: () => ({
    state: faceCapture.faceRef ? 'ready' : 'idle',
    faceRef: faceCapture.faceRef,
    captureStatus: null,
    error: null,
    capture: faceCapture.capture,
    reset: vi.fn(),
  }),
}))

import { RemoteFaceCapture } from './RemoteFaceCapture'
import type { OnboardingEnvelope } from './onboardingSocket'
import type * as OnboardingSocketModule from './onboardingSocket'

import { makeLivenessLink } from '../../test/fixtures'

/**
 * The teller-side shutter for the customer's photo (Phase 7). Choosing a
 * method that needs the customer's face opens the monitor's camera over
 * there, frames land on the same canvas the liveness feed uses, and the
 * button here is what takes the picture: `capturePhoto` out, `photo` back,
 * then the still is uploaded through the face-capture provider exactly as
 * the panel's own camera would have uploaded it.
 */

const LINKS = { links: [makeLivenessLink({ token: 'sess_fixed_1' })] }

function stubSettings(payload: unknown, status = 200) {
  const mock = vi.fn(() =>
    Promise.resolve(
      new Response(JSON.stringify(payload), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    ),
  )
  vi.stubGlobal('fetch', mock)
  return mock
}

async function mountWithStory() {
  stubSettings(LINKS)
  const send = vi.fn()
  const story: { h: ((envelope: OnboardingEnvelope) => void) | null } = { h: null }
  openOnboardingSocket.mockImplementation(
    (_id: string, _role: string, handler: typeof story.h) => {
      story.h = handler
      return { send, close: vi.fn() }
    },
  )
  render(<RemoteFaceCapture />)
  await waitFor(() => expect(story.h).not.toBeNull())
  return { send, story }
}

function activations(send: ReturnType<typeof vi.fn>) {
  return send.mock.calls.filter(
    (call) => (call[0] as { type?: string }).type === 'activateFaceCapture',
  )
}

/** The frame decoder double: jsdom never finishes decoding on its own. */
function stubFrameDecoder() {
  const created: Array<{ onload: (() => void) | null; fire: () => void }> = []
  vi.stubGlobal(
    'Image',
    class {
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      private value = ''
      constructor() {
        created.push(this)
      }
      get src() {
        return this.value
      }
      set src(next: string) {
        this.value = next
      }
      fire() {
        this.onload?.()
      }
    },
  )
  return { finishDecoding: () => created.at(-1)?.fire() }
}

/** jsdom has no 2d context, so the draws are recorded instead. */
function stubCanvas() {
  const draws: string[] = []
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage: (image: { src: string }) => {
      draws.push(image.src)
    },
  } as unknown as CanvasRenderingContext2D)
  return { draws }
}

beforeEach(() => {
  faceCapture.faceRef = null
  faceCapture.capture = vi.fn(() => Promise.resolve())
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  openOnboardingSocket.mockReset()
})

describe('RemoteFaceCapture', () => {
  it('opens the customer camera as soon as the method needs a face', async () => {
    stubSettings(LINKS)
    const send = vi.fn()
    openOnboardingSocket.mockReturnValue({ send, close: vi.fn() })

    render(<RemoteFaceCapture />)

    await waitFor(() => expect(openOnboardingSocket).toHaveBeenCalledTimes(1))
    expect(openOnboardingSocket).toHaveBeenCalledWith(
      'sess_fixed_1',
      'teller',
      expect.any(Function),
      expect.any(Function),
    )
    expect(send).toHaveBeenCalledWith({ type: 'activateFaceCapture' })
    expect(
      await screen.findByText(/waiting for the customer's webcam frames/i),
    ).toBeInTheDocument()
  })

  it('does not open a camera that already has a photo', async () => {
    faceCapture.faceRef = 'art_taken'
    stubSettings(LINKS)
    const send = vi.fn()
    openOnboardingSocket.mockReturnValue({ send, close: vi.fn() })

    render(<RemoteFaceCapture />)

    await waitFor(() => expect(openOnboardingSocket).toHaveBeenCalledTimes(1))
    expect(send).not.toHaveBeenCalledWith({ type: 'activateFaceCapture' })
    expect(screen.getByText(/The photo is under Current face/i)).toBeInTheDocument()
  })

  it('draws the customer frames onto the preview canvas', async () => {
    const decoder = stubFrameDecoder()
    const canvas = stubCanvas()
    const { story } = await mountWithStory()

    story.h?.({ type: 'frame', dataUrl: 'data:image/jpeg;base64,/9j/4AAQ' })
    expect(canvas.draws).toEqual([])

    decoder.finishDecoding()
    await waitFor(() => expect(canvas.draws).toEqual(['data:image/jpeg;base64,/9j/4AAQ']))
    expect(screen.queryByText(/waiting for the customer's webcam frames/i)).toBeNull()
  })

  it('takes the photo on the teller click and hands it to the face panel', async () => {
    const { send, story } = await mountWithStory()

    fireEvent.click(screen.getByRole('button', { name: 'Take photo' }))

    expect(send).toHaveBeenCalledWith({ type: 'capturePhoto' })

    story.h?.({ type: 'photo', dataUrl: 'data:image/jpeg;base64,S0lU' })

    await waitFor(() => expect(faceCapture.capture).toHaveBeenCalledTimes(1))
    const blob = faceCapture.capture.mock.calls[0]?.[0]
    if (!blob) throw new Error('capture was called without a file')
    expect(blob.type).toBe('image/jpeg')
    expect(blob.size).toBeGreaterThan(0)
    expect(await screen.findByText('Photo received from the customer display.')).toBeInTheDocument()
    expect(activations(send)).toHaveLength(1)
  })

  it('does not ask for the camera again once a photo exists', async () => {
    const { send, story } = await mountWithStory()
    expect(activations(send)).toHaveLength(1)

    // The shot lands, and the customer's camera closed itself with it.
    faceCapture.faceRef = 'art_taken'
    story.h?.({ type: 'photo', dataUrl: 'data:image/jpeg;base64,QUJD' })
    await waitFor(() => expect(faceCapture.capture).toHaveBeenCalledTimes(1))
    // …which re-renders the panel: the status line is what proves it now
    // reads the handle the guard depends on.
    expect(screen.getByText(/The photo is under Current face/i)).toBeInTheDocument()

    story.h?.({ type: 'peerJoined' })

    expect(activations(send)).toHaveLength(1)
  })

  it('reports an unreadable picture instead of uploading it', async () => {
    const { send, story } = await mountWithStory()

    story.h?.({ type: 'photo', dataUrl: 'not-a-data-url' })

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The picture came back unreadable. Please take it again.',
    )
    expect(faceCapture.capture).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalledWith({ type: 'capturePhoto' })
  })

  it('surfaces a camera error from the customer side', async () => {
    const { story } = await mountWithStory()

    story.h?.({ type: 'error', message: 'Camera access was denied.' })

    expect(await screen.findByRole('alert')).toHaveTextContent('Camera access was denied.')
  })

  it('says so instead of opening a socket when no display is configured', async () => {
    stubSettings({ links: [] })
    openOnboardingSocket.mockReturnValue({ send: vi.fn(), close: vi.fn() })

    render(<RemoteFaceCapture />)

    expect(
      await screen.findByText(/No liveness link is open yet/i),
    ).toBeInTheDocument()
    expect(openOnboardingSocket).not.toHaveBeenCalled()
  })
})
