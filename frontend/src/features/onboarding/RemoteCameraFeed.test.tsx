import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const openOnboardingSocket = vi.hoisted(() => vi.fn())
const liveness = vi.hoisted(() => ({ adopt: vi.fn(), livenessRef: null as string | null }))

vi.mock('./onboardingSocket', () => ({
  openOnboardingSocket,
}))
vi.mock('../liveness/LivenessContext', () => ({
  useLiveness: () => ({ adopt: liveness.adopt, livenessRef: liveness.livenessRef }),
}))

import { RemoteCameraFeed } from './RemoteCameraFeed'
import type { OnboardingEnvelope } from './onboardingSocket'
import { artifactUrl } from '../../lib/api'

/**
 * The teller-side liveness feed: opens the fixed session's WebSocket the
 * moment the method is chosen, asks the customer display to start filming
 * (`activateLiveness`), and renders incoming frames. "Start liveness check"
 * queues the customer's 3-second recording; the returned `livenessRef` is
 * adopted into the shared artefact and played back from the artefact store.
 * When no fixed display is configured it says so instead of opening a socket.
 */

const SETTINGS = { enabled: true, sessionId: 'sess_fixed_1' }

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
  stubSettings(SETTINGS)
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
  return { send, story }
}

afterEach(() => {
  vi.unstubAllGlobals()
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

describe('RemoteCameraFeed', () => {
  it('opens the fixed session and asks the display to film as soon as it mounts', async () => {
    stubSettings(SETTINGS)
    const send = vi.fn()
    openOnboardingSocket.mockReturnValue({ send, close: vi.fn() })

    render(<RemoteCameraFeed />)

    await waitFor(() => expect(openOnboardingSocket).toHaveBeenCalledTimes(1))
    expect(openOnboardingSocket).toHaveBeenCalledWith(
      'sess_fixed_1',
      'teller',
      expect.any(Function),
    )
    expect(send).toHaveBeenCalledWith({ type: 'activateLiveness' })
    expect(
      await screen.findByText(/waiting for the customer's webcam frames/i),
    ).toBeInTheDocument()
  })

  it('renders incoming customer frames as the live feed', async () => {
    stubSettings(SETTINGS)
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

    const image = await screen.findByAltText('Customer liveness feed')
    expect(image).toHaveAttribute('src', 'data:image/jpeg;base64,/9j/4AAQ')
  })

  it('opens no socket when the fixed display is disabled', async () => {
    stubSettings({ enabled: false, sessionId: 'sess_fixed_1' })

    render(<RemoteCameraFeed />)

    expect(
      await screen.findByText(/no fixed customer display is enabled yet/i),
    ).toBeInTheDocument()
    expect(openOnboardingSocket).not.toHaveBeenCalled()
  })

  it('treats a refused settings load as "not configured"', async () => {
    stubSettings({ error: { code: 'UNAVAILABLE', message: 'Down.' } }, 503)

    render(<RemoteCameraFeed />)

    expect(
      await screen.findByText(/no fixed customer display is enabled yet/i),
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

    liveness.livenessRef = 'liv_fresh'
    story.h?.({ type: 'frame', dataUrl: 'data:image/jpeg;base64,/9j/4AAQ' })

    expect(await screen.findByAltText('Customer liveness feed')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(player()).toHaveAttribute('src', artifactUrl('liv_fresh'))
  })
})
