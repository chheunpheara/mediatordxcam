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

  it('shows the welcome art by default, with nothing to tap', async () => {
    openOnboardingSocket.mockReturnValue({ send: vi.fn(), close: vi.fn() })
    renderAt('/display?session=abc')

    expect(await screen.findByRole('img', { name: 'Welcome' })).toBeInTheDocument()
    expect(screen.queryByText(/thank you/i)).toBeNull()
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
    // The idle art is what the oval replaced, so it cannot still be on screen.
    expect(screen.queryByRole('img', { name: 'Welcome' })).toBeNull()
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

    expect(await screen.findByRole('img', { name: 'Welcome' })).toBeInTheDocument()
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

  it('opens the camera for a photo the teller takes and keeps the picture after it', async () => {
    const camera = stubCamera()
    stubRecording()
    const { send, story } = await mountDisplay()

    story.h?.({ type: 'activateFaceCapture' })
    camera.open()
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith({ type: 'customerState', state: 'liveness' }),
    )
    expect(
      await screen.findByText('Look at the camera — the teller will take your photo.'),
    ).toBeInTheDocument()

    // A frame worth taking, so the shutter has something to copy.
    const video = screen.getByLabelText<HTMLVideoElement>('Customer camera preview')
    Object.defineProperty(video, 'videoWidth', { value: 640, configurable: true })
    Object.defineProperty(video, 'videoHeight', { value: 480, configurable: true })
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D)
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(
      'data:image/jpeg;base64,PHOTO',
    )

    story.h?.({ type: 'capturePhoto' })

    await waitFor(() =>
      expect(send).toHaveBeenCalledWith({ type: 'photo', dataUrl: 'data:image/jpeg;base64,PHOTO' }),
    )
    // The shutter is the teller's: after the shot this camera closes itself
    // the way it does after a recording, keeping the still on the oval.
    expect(camera.stopTrack).toHaveBeenCalled()
    expect(
      await screen.findByText('Your photo has been taken and sent to the teller.'),
    ).toBeInTheDocument()
    expect(await screen.findByAltText('Your recorded preview')).toBeInTheDocument()
    expect(
      screen.getByText('Your camera is off. The teller can open it again to take another photo.'),
    ).toBeInTheDocument()
    expect(camera.getUserMedia).toHaveBeenCalledTimes(1)

    // …and opens again only when the teller asks for another one.
    story.h?.({ type: 'activateFaceCapture' })
    camera.open()
    await waitFor(() => expect(camera.getUserMedia).toHaveBeenCalledTimes(2))
    expect(screen.queryByAltText('Your recorded preview')).toBeNull()
    expect(
      await screen.findByText('Look at the camera — the teller will take your photo.'),
    ).toBeInTheDocument()
  })

  it('refuses to take a photo when the camera never opened', async () => {
    const { send, story } = await mountDisplay()

    story.h?.({ type: 'capturePhoto' })

    await waitFor(() =>
      expect(send).toHaveBeenCalledWith({
        type: 'error',
        message: 'The camera is not ready to take a photo yet.',
      }),
    )
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'photo' }))
  })

  it('keeps the last picture on the oval after the camera closes', async () => {
    const camera = stubCamera()
    const { finishRecording } = stubRecording()
    const { send, story } = await mountDisplay()

    story.h?.({ type: 'activateLiveness' })
    camera.open()
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith({ type: 'customerState', state: 'liveness' }),
    )

    // A frame the camera is actually showing, so there is one to keep.
    const video = screen.getByLabelText<HTMLVideoElement>('Customer camera preview')
    Object.defineProperty(video, 'videoWidth', { value: 640, configurable: true })
    Object.defineProperty(video, 'videoHeight', { value: 480, configurable: true })
    const drawImage = vi.fn()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage,
    } as unknown as CanvasRenderingContext2D)
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(
      'data:image/jpeg;base64,SNAPSHOT',
    )

    story.h?.({ type: 'startRecording' })
    await waitFor(() => expect(send).toHaveBeenCalledWith({ type: 'recordingStarted' }))
    finishRecording()
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith({ type: 'recordingFinished', livenessRef: 'liv_1' }),
    )

    const picture = await screen.findByAltText('Your recorded preview')
    expect(picture).toHaveAttribute('src', 'data:image/jpeg;base64,SNAPSHOT')
    expect(drawImage).toHaveBeenCalledWith(video, 0, 0)

    // The still is the last thing this camera saw, so it must be copied
    // before the tracks stop — afterwards there is nothing left to copy.
    expect(camera.stopTrack).toHaveBeenCalled()

    // A re-record drops the still for the live picture again.
    story.h?.({ type: 'startRecording' })
    await waitFor(() => expect(camera.getUserMedia).toHaveBeenCalledTimes(2))
    expect(screen.queryByAltText('Your recorded preview')).toBeNull()
  })

  it('reports an upload a proxy refused with HTML as a readable failure', async () => {
    const camera = stubCamera()
    const { finishRecording } = stubRecording()
    // An HTML error page, not JSON — nginx's 413 before the body-size limit
    // matched the API's. Parsing it would throw at the customer and reach the
    // teller as the browser's own wording for a failed parse.
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response('<html>413 Request Entity Too Large</html>', {
            status: 413,
            headers: { 'Content-Type': 'text/html' },
          }),
        ),
      ),
    )
    const { send, story } = await mountDisplay()

    story.h?.({ type: 'activateLiveness' })
    camera.open()
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith({ type: 'customerState', state: 'liveness' }),
    )
    story.h?.({ type: 'startRecording' })
    await waitFor(() => expect(send).toHaveBeenCalledWith({ type: 'recordingStarted' }))
    finishRecording()

    await waitFor(() =>
      expect(send).toHaveBeenCalledWith({
        type: 'error',
        message: 'Something went wrong. Please try again.',
      }),
    )
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'recordingFinished' }))
    expect(
      await screen.findByText('Something went wrong. Please try again.'),
    ).toBeInTheDocument()
    expect(screen.queryByText(/pattern/i)).toBeNull()
    expect(screen.queryByText(/SyntaxError/i)).toBeNull()
  })
})
