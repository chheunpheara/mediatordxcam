import { useEffect, useRef, useState } from 'react'

import { onboardingRefusalMessage, openOnboardingSocket } from '../features/onboarding/onboardingSocket'
import type { OnboardingEnvelope } from '../features/onboarding/onboardingSocket'
import { useLiveFrame } from '../features/onboarding/useLiveFrame'
import { fetchActiveLivenessLink } from '../lib/api'

/**
 * Screen A (teller dashboard).
 *
 * On mount it creates a session and opens the customer's tab at
 * `/display?session={id}`. The teller controls the customer tab over the
 * WebSocket, and the customer's webcam frames arrive back at ~12 fps and
 * are shown in the preview below. A "Start liveness check" click on this
 * tab queues a 3-second recording on the customer screen.
 */
export function TellerDashboard() {
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const { canvasRef, hasFrame, acceptFrame } = useLiveFrame()
  const [recordingBusy, setRecordingBusy] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const socketRef = useRef<ReturnType<typeof openOnboardingSocket> | null>(null)

  function fallbackCreateAdhocSession() {
    fetch('/api/v1/onboarding/sessions', { method: 'POST' })
      .then((response) => response.json())
      .then((body: { sessionId?: string }) => {
        if (!body.sessionId) throw new Error('Session creation failed')
        setSessionId(body.sessionId)
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : 'Unable to create session')
      })
  }

  useEffect(() => {
    // The officer's open link, if there is one: the customer monitor is
    // already on that URL, so this tab joins the same room. Otherwise mint an
    // ad-hoc session, so the dashboard stays usable before any link exists.
    fetchActiveLivenessLink()
      .then((link) => {
        if (link?.token) setSessionId(link.token)
        else fallbackCreateAdhocSession()
      })
      .catch(() => fallbackCreateAdhocSession())
  }, [])

  useEffect(() => {
    if (!sessionId) return
    const handle = (env: OnboardingEnvelope) => {
      switch (env.type) {
        case 'frame':
          acceptFrame(env.dataUrl)
          break
        case 'recordingStarted':
          setRecordingBusy(true)
          break
        case 'recordingFinished':
          setRecordingBusy(false)
          setResult(env.livenessRef ? `Received video (${env.livenessRef})` : 'Recording finished.')
          break
        case 'error':
          setError(env.message)
          break
        default:
          break
      }
    }
    socketRef.current = openOnboardingSocket(sessionId, 'teller', handle, (code) => {
      const message = onboardingRefusalMessage(code, 'teller')
      if (message !== null) setError(message)
    })
    return () => {
      socketRef.current?.close()
      socketRef.current = null
    }
  }, [sessionId, acceptFrame])

  if (error && !sessionId) {
    return (
      <main className="p-6">
        <p role="alert">{error}</p>
      </main>
    )
  }

  return (
    <main className="mx-auto max-w-3xl p-6">
      <h1 className="text-2xl font-semibold">Teller Dashboard</h1>

      <section className="card p-5">
        {sessionId ? (
          <>
            <p>
              Customer tab:{' '}
              <a
                className="text-brand"
                href={`/display?session=${encodeURIComponent(sessionId)}`}
                rel="noreferrer"
                target="_blank"
              >
                {`/display?session=${sessionId}`}
              </a>
            </p>
            <p className="mt-1 text-sm text-neutral-500">
              Open this on the customer-facing monitor. It takes no clicks: the webcam opens
              when you activate it and closes again once a recording has been sent.
            </p>

            <div className="mt-4 bg-transparent">
              <canvas
                aria-label="Customer camera"
                className="aspect-[4/3] max-h-72 w-full rounded-md bg-transparent"
                ref={canvasRef}
              />
              {hasFrame ? null : (
                <p className="text-sm text-neutral-500">Waiting for the customer's camera…</p>
              )}
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              <button
                className="btn-secondary px-4 py-2 text-sm"
                onClick={() => socketRef.current?.send({ type: 'activateLiveness' })}
                type="button"
              >
                Activate customer webcam
              </button>
              <button
                className="btn-secondary px-4 py-2 text-sm"
                disabled={recordingBusy}
                onClick={() => socketRef.current?.send({ type: 'startRecording' })}
                type="button"
              >
                Start liveness check
              </button>
              <button
                className="btn-secondary px-4 py-2 text-sm"
                onClick={() => socketRef.current?.send({ type: 'cancelSession' })}
                type="button"
              >
                Reset customer screen
              </button>
            </div>

            {recordingBusy ? (
              <p className="mt-3 text-sm text-neutral-600" role="status">
                Customer is recording…
              </p>
            ) : null}
            {result ? <p className="mt-3 text-sm">{result}</p> : null}
            {error ? (
              <p className="mt-3 text-sm text-red-600" role="alert">
                {error}
              </p>
            ) : null}
          </>
        ) : (
          <p role="status">Opening session…</p>
        )}
      </section>
    </main>
  )
}
