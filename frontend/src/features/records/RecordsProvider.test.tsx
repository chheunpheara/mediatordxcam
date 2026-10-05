import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { RecordsProvider } from './RecordsProvider'
import { useRecords } from './RecordsContext'
import { bodyOf, makeUploadedRecord, makeVerifyResult, urlOf } from '../../test/fixtures'

/**
 * The records provider (D23): the list's controls are one server query, and
 * only the newest response may write state.
 */

afterEach(() => {
  vi.unstubAllGlobals()
})

type Router = (url: string, init?: RequestInit) => Response | Promise<Response>

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function stubJson(router: Router) {
  const mock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const result = router(urlOf(input), init)
    return result instanceof Promise ? result : Promise.resolve(result)
  })
  vi.stubGlobal('fetch', mock)
  return mock
}

function Probe() {
  const records = useRecords()
  return (
    <div>
      <p data-testid="ids">{records.records.map((row) => row.id).join(',')}</p>
      <p data-testid="total">{records.total}</p>
      <p data-testid="loading">{String(records.loading)}</p>
      <p data-testid="error">{records.error ?? ''}</p>
      <p data-testid="search">{records.search}</p>
      <p data-testid="status">{records.status}</p>
      <p data-testid="limit">{records.limit}</p>
      <p data-testid="page">{records.page}</p>
      <p data-testid="lastAdded">{records.lastAdded === null ? '' : String(records.lastAdded)}</p>
      <p data-testid="active">{records.activeRecord?.id ?? ''}</p>
      <button onClick={() => records.setSearch('sokha')}>apply search</button>
      <button onClick={() => records.setStatus('verified')}>only verified</button>
      <button onClick={() => records.setLimit(25)}>page size 25</button>
      <button onClick={() => records.setPage(1)}>page 2</button>
      <button onClick={() => records.uploaded(3)}>upload landed</button>
      <button onClick={() => records.refresh()}>refresh</button>
      <button onClick={() => records.start(makeUploadedRecord())}>start</button>
      <button onClick={() => records.stop()}>stop</button>
      <button onClick={() => void records.markVerified('rec_1', makeVerifyResult())}>
        store run
      </button>
    </div>
  )
}

function renderProvider(router: Router) {
  const fetchMock = stubJson(router)
  render(
    <RecordsProvider>
      <Probe />
    </RecordsProvider>,
  )
  return fetchMock
}

describe('RecordsProvider', () => {
  it('loads the first page on mount and reports it', async () => {
    const fetchMock = renderProvider(() =>
      json({ records: [makeUploadedRecord()], total: 1 }),
    )

    await waitFor(() => expect(screen.getByTestId('ids')).toHaveTextContent('rec_2f1c9a4b'))
    expect(screen.getByTestId('total')).toHaveTextContent('1')
    expect(screen.getByTestId('loading')).toHaveTextContent('false')
    expect(screen.getByTestId('error')).toHaveTextContent('')

    const url = urlOf(fetchMock.mock.calls[0]?.[0])
    expect(url).toContain('limit=10')
    expect(url).toContain('offset=0')
  })

  it('sends search, status, limit and offset as one query, back on page one', async () => {
    const fetchMock = renderProvider(() => json({ records: [], total: 0 }))
    await screen.findByTestId('loading')

    fireEvent.click(screen.getByRole('button', { name: 'page size 25' }))
    fireEvent.click(screen.getByRole('button', { name: 'page 2' }))
    fireEvent.click(screen.getByRole('button', { name: 'apply search' }))
    fireEvent.click(screen.getByRole('button', { name: 'only verified' }))

    await waitFor(() => {
      const urls = fetchMock.mock.calls.map((call) => urlOf(call[0]))
      expect(urls.at(-1)).toContain('search=sokha')
      expect(urls.at(-1)).toContain('status=verified')
      expect(urls.at(-1)).toContain('limit=25')
      // A new filter starts over: offset belongs to the previous paging.
      expect(urls.at(-1)).toContain('offset=0')
    })
    expect(screen.getByTestId('search')).toHaveTextContent('sokha')
    expect(screen.getByTestId('status')).toHaveTextContent('verified')
    expect(screen.getByTestId('page')).toHaveTextContent('0')
  })

  it('keeps the newer response when an older one lands later', async () => {
    let releaseFirst: ((response: Response) => void) | undefined
    const first = new Promise<Response>((resolve) => {
      releaseFirst = resolve
    })
    let getCalls = 0
    renderProvider((_url, init) => {
      if (init?.method === 'POST') return json({})
      // First call hangs until released; the control change's call wins.
      getCalls += 1
      if (getCalls === 1) return first
      return json({ records: [makeUploadedRecord({ id: 'rec_newer' })], total: 1 })
    })

    await waitFor(() => expect(getCalls).toBe(1))

    fireEvent.click(screen.getByRole('button', { name: 'only verified' }))
    await waitFor(() => expect(screen.getByTestId('ids')).toHaveTextContent('rec_newer'))

    // The hung first response arrives last — with a total of its own.
    releaseFirst?.(json({ records: [makeUploadedRecord({ id: 'rec_stale' })], total: 99 }))
    await waitFor(() => expect(getCalls).toBe(2))

    expect(screen.getByTestId('ids')).toHaveTextContent('rec_newer')
    expect(screen.getByTestId('total')).toHaveTextContent('1')
  })

  it('stores a finished run against the row and refreshes a filtered view', async () => {
    const fetchMock = renderProvider(
      (url, init) => {
        if (init?.method === 'POST' && url.includes('/verification')) {
          const body = bodyOf<{ verification: { method: string } }>([
            url,
            init,
          ])
          expect(body.verification.method).toBe('verify_user_info')
          return json(
            makeUploadedRecord({
              id: 'rec_1',
              status: 'verified',
              verification: { ...makeVerifyResult(), verifiedAt: 1759710000 },
              verifiedAt: 1759710000,
            }),
          )
        }
        return json({ records: [makeUploadedRecord({ id: 'rec_1' })], total: 1 })
      },
    )
    await screen.findByTestId('ids')

    fireEvent.click(screen.getByRole('button', { name: 'store run' }))

    const verificationCall = await waitFor(() => {
      const found = fetchMock.mock.calls.find((call) => urlOf(call[0]).includes('/verification'))
      expect(found).toBeDefined()
      return found!
    })
    expect(urlOf(verificationCall[0])).toContain('/records/rec_1/verification')
    expect(bodyOf<{ verification: { method: string } }>(verificationCall).verification.method).toBe(
      'verify_user_info',
    )

    // Unfiltered, the row flips in place — no extra GET just to move one cell.
    const getCalls = fetchMock.mock.calls.filter((call) => (call[1] as RequestInit)?.method === undefined)
    expect(getCalls).toHaveLength(1)

    // Under a status filter the view must re-run: the row may no longer belong.
    fireEvent.click(screen.getByRole('button', { name: 'only verified' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))
  })

  it('announces an upload, returns to page one and reloads', async () => {
    const fetchMock = renderProvider(() => json({ records: [], total: 0 }))
    await screen.findByTestId('loading')

    fireEvent.click(screen.getByRole('button', { name: 'page 2' }))
    fireEvent.click(screen.getByRole('button', { name: 'upload landed' }))

    expect(await screen.findByTestId('lastAdded')).toHaveTextContent('3')
    expect(screen.getByTestId('page')).toHaveTextContent('0')
    await waitFor(() => {
      const last = urlOf(fetchMock.mock.calls.at(-1)?.[0])
      expect(last).toContain('offset=0')
    })
  })

  it('shows the server sentence when the list call is refused', async () => {
    renderProvider(() =>
      json(
        {
          error: {
            code: 'FORBIDDEN',
            message: 'You do not have access to this list.',
            fieldErrors: {},
            requestId: 'req_1',
          },
        },
        403,
      ),
    )

    await waitFor(() =>
      expect(screen.getByTestId('error')).toHaveTextContent('You do not have access to this list.'),
    )
  })

  it('holds the record whose Start was pressed until Stop', async () => {
    renderProvider(() => json({ records: [], total: 0 }))
    await screen.findByTestId('loading')

    fireEvent.click(screen.getByRole('button', { name: 'start' }))
    expect(screen.getByTestId('active')).toHaveTextContent('rec_2f1c9a4b')

    fireEvent.click(screen.getByRole('button', { name: 'stop' }))
    expect(screen.getByTestId('active')).toHaveTextContent('')
  })

  it('throws outside its provider', () => {
    // A bare consumer must fail loudly, not render an empty list forever.
    expect(() => render(<Probe />)).toThrow(/inside a RecordsProvider/)
  })
})
