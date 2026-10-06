import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

const openOnboardingSocket = vi.hoisted(() => vi.fn())

vi.mock('../features/onboarding/onboardingSocket', () => ({
  openOnboardingSocket,
}))

import { CustomerDisplayPage } from './CustomerDisplay'
import type { OnboardingEnvelope } from '../features/onboarding/onboardingSocket'

/**
 * Screen B is hands-free: the teller's `activateLiveness` opens the webcam by
 * itself, a `startRecording` that beats the permission prompt is held rather
 * than refused, and a refused camera is reported to the teller as well as shown
 * here. The tests below drive the socket handler the way the relay does.
 */

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <CustomerDisplayPage />
    </MemoryRouter>,
  )
}

/** Mount the page with a captured socket handler and its `send` spy. */
async function mountDisplay() {
  const send = vi.fn()
  const story: { h: ((envelope: OnboardingEnvelope) => void) | null } = { h: null }
  openOnboardingSocket.mockImplementation(
    (_id: string, _role: string, onMessage: (envelope: OnboardingEnvelope) => void) => {
      story.h = onMessage
      return { send, close: vi.fn() }
    },
  )
  renderAt('/display?session=abc')
  await waitFor(() => expect(story.h).not.toBeNull())
  return { send, story }
}

/**
 * A camera whose permission prompt the test resolves or refuses on demand —
 * the window in which the teller's start command can arrive.
 */
function stubCamera() {
  const stopTrack = vi.fn()
  const stream = { getTracks: () => [{ stop: stopTrack }] }
  let resolveStream!: (value: unknown) => void
  let rejectStream!: (reason: unknown) => void
  const getUserMedia = vi.fn(
    () =>
      new Promise((resolve, reject) => {
        resolveStream = resolve
        rejectStream = reject
      }),
  )
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia },
  })
  return {
    getUserMedia,
    stopTrack,
    open: () => resolveStream(stream),
    deny: (reason: unknown) => rejectStream(reason),
  }
}

/** The recording half: a recorder double and the broker upload it feeds. */
function stubRecording() {
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
  const recorders: Array<() => void> = []
  vi.stubGlobal(
    'MediaRecorder',
    class {
      static isTypeSupported(): boolean {
        return false
      }
      state = 'inactive'
      ondataavailable: ((event: { data: Blob }) => void) | null = null
      onstop: (() => void) | null = null
      constructor() {
        // The 3-second loop, on demand: tests end long before it elapses.
        recorders.push(() => this.stop())
      }
      start(): void {
        this.state = 'recording'
      }
      stop(): void {
        this.state = 'inactive'
        queueMicrotask(() => this.onstop?.())
      }
    },
  )
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ livenessRef: 'liv_1' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    ),
  )
  return { finishRecording: () => recorders.at(-1)?.() }
}

describe('CustomerDisplayPage', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    Reflect.deleteProperty(navigator, 'mediaDevices')
  })

  it('shows the welcome screen by default, with nothing to tap', async () => {
    openOnboardingSocket.mockReturnValue({ send: vi.fn(), close: vi.fn() })
    renderAt('/display?session=abc')

    expect(await screen.findByText('Welcome')).toBeInTheDocument()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('opens the webcam on the teller command alone', async () => {
    const camera = stubCamera()
    stubRecording()
    const { send, story } = await mountDisplay()

    story.h?.({ type: 'activateLiveness' })

    expect(camera.getUserMedia).toHaveBeenCalledTimes(1)
    camera.open()

    // The camera has actually opened. An assertion on the *absence* of a
    // button cannot tell you that — it is true before the prompt is answered
    // too, which is exactly how this page's own test used to pass vacuously.
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith({ type: 'customerState', state: 'liveness' }),
    )
    expect(
      await screen.findByText('Hold still — the teller will start the check.'),
    ).toBeInTheDocument()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('records a start command that arrived while the permission prompt was open', async () => {
    const camera = stubCamera()
    stubRecording()
    const { send, story } = await mountDisplay()

    story.h?.({ type: 'activateLiveness' })
    // The camera is still opening when the teller sends the start.
    story.h?.({ type: 'startRecording' })

    expect(send).not.toHaveBeenCalledWith({ type: 'recordingStarted' })
    // The held start is visible as "Starting the camera…", not as a refusal.
    expect((await screen.findAllByText('Starting the camera…')).length).toBeGreaterThan(0)

    camera.open()

    await waitFor(() => expect(send).toHaveBeenCalledWith({ type: 'recordingStarted' }))
    expect(await screen.findByText(/blink slowly/i)).toBeInTheDocument()
    expect(screen.queryByText(/enable the webcam first/i)).toBeNull()
  })

  it('reports a refused camera to the teller, not only to the customer', async () => {
    const camera = stubCamera()
    const { send, story } = await mountDisplay()

    story.h?.({ type: 'activateLiveness' })
    camera.deny(new DOMException('denied', 'NotAllowedError'))

    expect(await screen.findByText('Camera access was denied.')).toBeInTheDocument()
    expect(send).toHaveBeenCalledWith({
      type: 'error',
      message: 'Camera access was denied.',
    })
    expect(
      await screen.findByText('Camera unavailable — the teller has been notified.'),
    ).toBeInTheDocument()
  })

  it('returns to the welcome screen and closes the camera when the session is cancelled', async () => {
    const camera = stubCamera()
    stubRecording()
    const { story } = await mountDisplay()

    story.h?.({ type: 'activateLiveness' })
    camera.open()
    await waitFor(() =>
      expect(
        screen.getByText('Hold still — the teller will start the check.'),
      ).toBeInTheDocument(),
    )

    story.h?.({ type: 'cancelSession' })

    expect(await screen.findByText('Welcome')).toBeInTheDocument()
    expect(camera.stopTrack).toHaveBeenCalled()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('closes the camera once the clip is accepted and reopens it for a re-record', async () => {
    const camera = stubCamera()
    const { finishRecording } = stubRecording()
    const { send, story } = await mountDisplay()

    story.h?.({ type: 'activateLiveness' })
    camera.open()
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith({ type: 'customerState', state: 'liveness' }),
    )
    story.h?.({ type: 'startRecording' })
    await waitFor(() => expect(send).toHaveBeenCalledWith({ type: 'recordingStarted' }))

    finishRecording() // the loop ends, the clip uploads, the teller gets it

    await waitFor(() =>
      expect(send).toHaveBeenCalledWith({ type: 'recordingFinished', livenessRef: 'liv_1' }),
    )
    expect(camera.stopTrack).toHaveBeenCalled()
    expect(
      await screen.findByText(
        'Liveness recording complete. Your video was sent to the teller.',
      ),
    ).toBeInTheDocument()
    expect(
      screen.getByText('Your camera is off. The teller will start it again if you need to re-record.'),
    ).toBeInTheDocument()
    expect(camera.getUserMedia).toHaveBeenCalledTimes(1)

    // The teller's "Re-record" is the only thing that brings the camera back.
    story.h?.({ type: 'startRecording' })

    await waitFor(() => expect(camera.getUserMedia).toHaveBeenCalledTimes(2))
    expect(
      screen.queryByText(
        'Your camera is off. The teller will start it again if you need to re-record.',
      ),
    ).toBeNull()

    camera.open()
    expect(await screen.findByText(/blink slowly/i)).toBeInTheDocument()
  })
})
