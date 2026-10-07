import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const openOnboardingSocket = vi.hoisted(() => vi.fn())
const liveness = vi.hoisted(() => ({ adopt: vi.fn(), livenessRef: null as string | null }))

vi.mock('./onboardingSocket', async (importOriginal) => ({
  // The real refusal wording stays in place — only the socket is faked.
  ...(await importOriginal<typeof OnboardingSocketModule>()),
  openOnboardingSocket,
}))
vi.mock('../liveness/LivenessContext', () => ({
  useLiveness: () => ({ adopt: liveness.adopt, livenessRef: liveness.livenessRef }),
}))

import { RemoteCameraFeed } from './RemoteCameraFeed'
import type { OnboardingEnvelope } from './onboardingSocket'
import type * as OnboardingSocketModule from './onboardingSocket'

import { artifactUrl } from '../../lib/api'
import { writeScreenMode } from './displayRoom'
import { makeLivenessLink } from '../../test/fixtures'

/**
 * The teller-side liveness feed: opens the officer's current link the moment
 * the method is chosen, asks the customer display to start filming
 * (`activateLiveness`), and renders incoming frames. "Start liveness check"
 * queues the customer's 3-second recording; the returned `livenessRef` is
 * adopted into the shared artefact and played back from the artefact store.
 * With no link open it says so instead of opening a socket.
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
  const story: {
    h: ((envelope: OnboardingEnvelope) => void) | null
    onClose: ((code: number) => void) | null
  } = { h: null, onClose: null }
  openOnboardingSocket.mockImplementation(
    (
      _id: string,
      _role: string,
      handler: (envelope: OnboardingEnvelope) => void,
      onClose?: (code: number) => void,
    ) => {
      story.h = handler
      story.onClose = onClose ?? null
      return { send, close: vi.fn() }
    },
  )
  render(<RemoteCameraFeed />)
  await waitFor(() => expect(story.h).not.toBeNull())
  return { send, story }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  openOnboardingSocket.mockReset()
  liveness.adopt.mockReset()
  liveness.livenessRef = null
})

/** The playback element, or a failure that names what was missing. */
function player(): HTMLVideoElement {
  const video = document.querySelector('video')
  if (!video) throw new Error('no recorded clip on screen')
  return video
}

/**
 * The frame decoder double. jsdom never finishes decoding, so the test says
 * when it does — which is exactly what makes "a frame reaches the screen only
 * once it has decoded" observable.
 */
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

/**
 * jsdom has no 2d context, so the draws are recorded here instead — which is
 * also what makes the no-blink guarantee testable: frames may only ever be
 * *added* to the canvas, never taken off it.
 */
function stubCanvas() {
  const draws: string[] = []
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage: (image: { src: string }) => {
      draws.push(image.src)
    },
  } as unknown as CanvasRenderingContext2D)
  return { draws }
}

describe('RemoteCameraFeed', () => {
  it('opens the current link and asks the display to film as soon as it mounts', async () => {
    stubSettings(LINKS)
    const send = vi.fn()
    openOnboardingSocket.mockReturnValue({ send, close: vi.fn() })

    render(<RemoteCameraFeed />)

    await waitFor(() => expect(openOnboardingSocket).toHaveBeenCalledTimes(1))
    expect(openOnboardingSocket).toHaveBeenCalledWith(
      'sess_fixed_1',
      'teller',
      expect.any(Function),
      expect.any(Function),
    )
    expect(send).toHaveBeenCalledWith({ type: 'activateLiveness' })
    expect(
      await screen.findByText(/waiting for the customer's webcam frames/i),
    ).toBeInTheDocument()
  })

  it('draws incoming customer frames onto the preview canvas', async () => {
    const decoder = stubFrameDecoder()
    const canvas = stubCanvas()
    stubSettings(LINKS)
    const send = vi.fn()
    const story: { h: ((envelope: OnboardingEnvelope) => void) | null } = { h: null }
    openOnboardingSocket.mockImplementation(
      (_id: string, _role: string, handler: typeof story.h) => {
        story.h = handler
        return { send, close: vi.fn() }
      },
    )

    render(<RemoteCameraFeed />)
    await waitFor(() => expect(story.h).not.toBeNull())

    story.h?.({ type: 'frame', dataUrl: 'data:image/jpeg;base64,/9j/4AAQ' })
    expect(screen.getByText(/Waiting for the customer's webcam frames…/)).toBeInTheDocument()

    decoder.finishDecoding()

    await waitFor(() =>
      expect(screen.queryByText(/Waiting for the customer's webcam frames…/)).toBeNull(),
    )
    expect(canvas.draws).toEqual(['data:image/jpeg;base64,/9j/4AAQ'])
    expect(screen.getByLabelText('Customer liveness feed')).toBeInTheDocument()
  })

  it('keeps the frame on the canvas until the next one has decoded', async () => {
    const decoder = stubFrameDecoder()
    const canvas = stubCanvas()
    const { story } = await mountWithStory()

    story.h?.({ type: 'frame', dataUrl: 'data:image/jpeg;base64,AAA' })

    // Nothing has been decoded, so nothing has been drawn — and nothing has
    // been taken off the canvas either. That is the whole anti-blink rule.
    expect(canvas.draws).toEqual([])
    expect(screen.getByText(/Waiting for the customer's webcam frames…/)).toBeInTheDocument()

    decoder.finishDecoding()
    await waitFor(() => expect(canvas.draws).toEqual(['data:image/jpeg;base64,AAA']))
    expect(screen.queryByText(/Waiting for the customer's webcam frames…/)).toBeNull()

    story.h?.({ type: 'frame', dataUrl: 'data:image/jpeg;base64,BBB' })

    expect(canvas.draws).toEqual(['data:image/jpeg;base64,AAA'])

    decoder.finishDecoding()
    await waitFor(() =>
      expect(canvas.draws).toEqual(['data:image/jpeg;base64,AAA', 'data:image/jpeg;base64,BBB']),
    )
  })

  it('does not ask for the camera when a recording already exists', async () => {
    liveness.livenessRef = 'liv_9'
    const { send, story } = await mountWithStory()

    expect(send).not.toHaveBeenCalled()

    // A monitor tab that reloads after the check: it must find the camera
    // still closed. Reopening is the "Re-record" button's job.
    story.h?.({ type: 'peerJoined' })

    expect(send).not.toHaveBeenCalled()
  })

  it('opens no socket when no link is open', async () => {
    stubSettings({ links: [] })

    render(<RemoteCameraFeed />)

    expect(
      await screen.findByText(/no liveness link is open yet/i),
    ).toBeInTheDocument()
    expect(openOnboardingSocket).not.toHaveBeenCalled()
  })

  it('joins the counter standby room when that screen is chosen', async () => {
    writeScreenMode('static')
    stubSettings({ enabled: true, sessionId: 'sess_standby_1' })
    const send = vi.fn()
    openOnboardingSocket.mockReturnValue({ send, close: vi.fn() })

    render(<RemoteCameraFeed />)

    await waitFor(() => expect(openOnboardingSocket).toHaveBeenCalledTimes(1))
    expect(openOnboardingSocket).toHaveBeenCalledWith(
      'sess_standby_1',
      'teller',
      expect.any(Function),
      expect.any(Function),
    )
    expect(send).toHaveBeenCalledWith({ type: 'activateLiveness' })
  })

  it('says the standby screen is switched off rather than joining it', async () => {
    writeScreenMode('static')
    stubSettings({ enabled: false, sessionId: 'sess_standby_1' })
    openOnboardingSocket.mockReturnValue({ send: vi.fn(), close: vi.fn() })

    render(<RemoteCameraFeed />)

    expect(await screen.findByText(/standby screen is turned off/i)).toBeInTheDocument()
    expect(openOnboardingSocket).not.toHaveBeenCalled()
  })

  it('leaves the link room and joins the standby room when the screen switches', async () => {
    stubSettings(LINKS)
    const close = vi.fn()
    openOnboardingSocket.mockReturnValue({ send: vi.fn(), close })

    render(<RemoteCameraFeed />)
    await waitFor(() => expect(openOnboardingSocket).toHaveBeenCalledTimes(1))
    expect(openOnboardingSocket).toHaveBeenLastCalledWith(
      'sess_fixed_1',
      'teller',
      expect.any(Function),
      expect.any(Function),
    )

    stubSettings({ enabled: true, sessionId: 'sess_standby_1' })
    await act(async () => {
      writeScreenMode('static')
      // Let the settings fetch settle while React is still listening, so the
      // panel's re-render is part of this act rather than after it.
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    await waitFor(() => expect(openOnboardingSocket).toHaveBeenCalledTimes(2))
    expect(close).toHaveBeenCalledTimes(1)
    expect(openOnboardingSocket).toHaveBeenLastCalledWith(
      'sess_standby_1',
      'teller',
      expect.any(Function),
      expect.any(Function),
    )
  })

  it('names the refusal when the room closes under it', async () => {
    const { story } = await mountWithStory()

    story.onClose?.(4410)

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This link has expired. Create a new one to reach the customer screen.',
    )
  })

  it('stays quiet for a close this tab performed itself', async () => {
    const { story } = await mountWithStory()

    story.onClose?.(1000)

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('treats a refused links load as "no link open"', async () => {
    stubSettings({ error: { code: 'UNAVAILABLE', message: 'Down.' } }, 503)

    render(<RemoteCameraFeed />)

    expect(
      await screen.findByText(/no liveness link is open yet/i),
    ).toBeInTheDocument()
    expect(openOnboardingSocket).not.toHaveBeenCalled()
  })

  it('offers the start control, locks it while recording, then adopts the result', async () => {
    const { send, story } = await mountWithStory()

    fireEvent.click(screen.getByRole('button', { name: 'Start liveness check' }))
    expect(send).toHaveBeenCalledWith({ type: 'startRecording' })

    story.h?.({ type: 'recordingStarted' })
    expect(await screen.findByRole('button', { name: 'Recording…' })).toBeDisabled()
    expect(screen.getByText('Customer is recording…')).toBeInTheDocument()

    story.h?.({ type: 'recordingFinished', livenessRef: 'liv_9' })
    expect(liveness.adopt).toHaveBeenCalledWith('liv_9')
    expect(
      await screen.findByText('Liveness recording received and accepted.'),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Start liveness check' })).toBeEnabled()
  })

  it('reports a resultless recording without adopting anything', async () => {
    const { story } = await mountWithStory()

    story.h?.({ type: 'recordingFinished', livenessRef: null })

    expect(await screen.findByRole('alert')).toHaveTextContent(/without a result/i)
    expect(liveness.adopt).not.toHaveBeenCalled()
  })

  it('surfaces an error reported by the customer tab', async () => {
    const { story } = await mountWithStory()

    story.h?.({ type: 'error', message: 'Camera access was denied.' })

    expect(await screen.findByRole('alert')).toHaveTextContent('Camera access was denied.')
    expect(screen.getByRole('button', { name: 'Start liveness check' })).toBeEnabled()
  })

  it('asks the display to film again when its tab joins after the method was chosen', async () => {
    const { send, story } = await mountWithStory()
    expect(send).toHaveBeenCalledWith({ type: 'activateLiveness' })

    story.h?.({ type: 'peerJoined' })

    expect(send).toHaveBeenCalledTimes(2)
    expect(send).toHaveBeenLastCalledWith({ type: 'activateLiveness' })
  })

  it('plays back a recorded clip from the artefact store, not the relay', async () => {
    liveness.livenessRef = 'liv_9'
    await mountWithStory()

    expect(player()).toHaveAttribute('src', artifactUrl('liv_9'))
    expect(player()).toHaveAttribute('controls')
    expect(screen.getByText('A liveness video was recorded.')).toBeInTheDocument()
  })

  it('renders no player before anything has been recorded', async () => {
    await mountWithStory()

    expect(document.querySelector('video')).toBeNull()
    expect(screen.queryByText('A liveness video was recorded.')).toBeNull()
  })

  it('swaps a clip the browser cannot load for an expiry notice', async () => {
    liveness.livenessRef = 'liv_expired'
    await mountWithStory()

    fireEvent.error(player())

    expect(await screen.findByRole('alert')).toHaveTextContent(/has expired/i)
    expect(document.querySelector('video')).toBeNull()
  })

  it('gives the next recording a clean player', async () => {
    liveness.livenessRef = 'liv_expired'
    const { story } = await mountWithStory()

    fireEvent.error(player())
    expect(await screen.findByRole('alert')).toHaveTextContent(/has expired/i)

    // The next clip arrives the way one really does: its handle, adopted.
    liveness.livenessRef = 'liv_fresh'
    story.h?.({ type: 'recordingFinished', livenessRef: 'liv_fresh' })

    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    expect(player()).toHaveAttribute('src', artifactUrl('liv_fresh'))
  })
})
