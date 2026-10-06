import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const openOnboardingSocket = vi.hoisted(() => vi.fn())

vi.mock('../features/onboarding/onboardingSocket', () => ({
  openOnboardingSocket,
}))

import { TellerDashboard } from './TellerDashboard'
import type { OnboardingEnvelope } from '../features/onboarding/onboardingSocket'

/**
 * Screen A: opens the customer's tab, activates its webcam and shows the
 * frames that come back. The preview is the part that read as a blinking
 * background — frames arrive at ~12 fps, and one that had not decoded yet
 * blanked the box — so the canvas rule is asserted here as well as in the
 * workspace's own feed: a frame is only ever added, never taken off.
 */

function stubSettings() {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ enabled: true, sessionId: 'sess_fixed_1' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    ),
  )
}

/** Same double as the workspace feed uses: jsdom never finishes a decode. */
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

async function mountDashboard() {
  stubSettings()
  const send = vi.fn()
  const story: { h: ((envelope: OnboardingEnvelope) => void) | null } = { h: null }
  openOnboardingSocket.mockImplementation(
    (_id: string, _role: string, handler: typeof story.h) => {
      story.h = handler
      return { send, close: vi.fn() }
    },
  )
  render(<TellerDashboard />)
  await waitFor(() => expect(story.h).not.toBeNull())
  return { send, story }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  openOnboardingSocket.mockReset()
})

describe('TellerDashboard', () => {
  it('opens the session and waits for the customer without asking them to click', async () => {
    const { send } = await mountDashboard()

    expect(openOnboardingSocket).toHaveBeenCalledWith(
      'sess_fixed_1',
      'teller',
      expect.any(Function),
    )
    expect(screen.getByText(/Waiting for the customer's camera…/)).toBeInTheDocument()
    expect(screen.queryByText(/Enable Webcam/)).toBeNull()
    expect(send).not.toHaveBeenCalled()
  })

  it('shows a frame only once it has decoded, and never takes one off the canvas', async () => {
    const decoder = stubFrameDecoder()
    const canvas = stubCanvas()
    const { story } = await mountDashboard()

    story.h?.({ type: 'frame', dataUrl: 'data:image/jpeg;base64,AAA' })

    expect(canvas.draws).toEqual([])
    expect(screen.getByText(/Waiting for the customer's camera…/)).toBeInTheDocument()

    decoder.finishDecoding()
    await waitFor(() => expect(canvas.draws).toEqual(['data:image/jpeg;base64,AAA']))
    expect(screen.queryByText(/Waiting for the customer's camera…/)).toBeNull()

    story.h?.({ type: 'frame', dataUrl: 'data:image/jpeg;base64,BBB' })

    expect(canvas.draws).toEqual(['data:image/jpeg;base64,AAA'])

    decoder.finishDecoding()
    await waitFor(() =>
      expect(canvas.draws).toEqual(['data:image/jpeg;base64,AAA', 'data:image/jpeg;base64,BBB']),
    )
    expect(screen.getByLabelText('Customer camera')).toBeInTheDocument()
  })
})
