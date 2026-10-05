import {
  IDENTITY_FIELDS,
  type AuthUser,
  type FaceCaptureResponse,
  type IdentityFieldOutcome,
  type ProcessIdCardResponse,
  type VerificationMethod,
  type VerifyResponse,
} from '@/lib/api'

/**
 * A signed-in administrator (D18).
 *
 * `setup.ts` writes this into auth storage before every test — the app is
 * gated, and the existing page tests must keep rendering their own page. A
 * test that wants a signed-out or non-admin visitor clears or replaces the
 * stored profile first.
 */
export const TEST_AUTH_USER: AuthUser = {
  id: 'user_test_admin',
  email: 'admin@gmail.com',
  name: 'Test Admin',
  status: 'active',
  roles: [{ id: 'role_admin', name: 'Admin' }],
  isAdmin: true,
}


/**
 * The URL of a stubbed `fetch` call.
 *
 * `fetch` accepts a string, a `URL` or a `Request`, and `String()` on a `Request`
 * yields `[object Object]`. Narrowing explicitly keeps the match honest and keeps
 * the type checker out of `any` territory.
 */
export function urlOf(input: unknown): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  if (input instanceof Request) return input.url
  return ''
}

/**
 * A realistic `POST /api/v1/kyc/id-card/process` response (§19).
 *
 * Shaped like the mock provider's actual output: a Khmer ID card whose OCR is
 * `partial` because the date of birth was not read, and a detected face. The
 * Khmer and English names differ, as they do on a real card (§14). Tests
 * that assert on rendering should start from this and override one field, so a
 * change to the API contract shows up as one obvious diff instead of every test.
 */
export function makeProcessingResult(
  overrides: Partial<ProcessIdCardResponse> = {},
): ProcessIdCardResponse {
  return {
    processingId: 'proc_2f1c9a',
    status: 'partial',
    ocr: {
      status: 'partial',
      documentType: 'khmer_id_card',
      fields: {
        nationalId: '123456789',
        firstNameKhmer: 'សុខា',
        lastNameKhmer: 'ចម',
        firstNameEnglish: 'Sokha',
        lastNameEnglish: 'Cham',
        dateOfBirth: null,
        gender: 'F',
        issuedDate: '2021-04-12',
        expiryDate: '2029-04-12',
      },
      missingFields: ['dateOfBirth'],
    },
    face: {
      status: 'detected',
      source: 'local_opencv_detection',
      detectedCount: 1,
      box: { x: 312, y: 96, width: 180, height: 210 },
      faceRef: 'art_0123456789abcdef0123456789abcdef',
      quality: 96.4,
    },
    documentRef: 'art_fedcba9876543210fedcba9876543210',
    ...overrides,
  }
}

/**
 * A realistic `POST /api/v1/kyc/verify` response (§23).
 *
 * Mirrors what the mock provider returns for API 1 once the identity is fully
 * supplied: every field checked and matched, and no other section required.
 * A test wanting a partial or failed outcome overrides one key instead of
 * hand-rolling a payload, so a contract change stays one obvious diff.
 *
 * Without a dedicated fixture the stub used to answer `/verify` with a
 * *processing* payload, and the result card crashed rendering
 * `result.identity.matchedCount` on `undefined`.
 */
export function makeVerifyResult(overrides: Partial<VerifyResponse> = {}): VerifyResponse {
  const submitted = {
    ...makeProcessingResult().ocr.fields,
    dateOfBirth: '1994-02-11',
  }
  const fields: readonly IdentityFieldOutcome[] = IDENTITY_FIELDS.map((field) => ({
    field,
    status: 'matched' as const,
    submitted: submitted[field],
  }))

  return {
    status: 'success',
    method: 'verify_user_info',
    identity: { fields, matchedCount: fields.length, incorrectFields: [] },
    face: { required: false, verified: null },
    idCard: { required: false, verified: null },
    liveness: { required: false, verified: null },
    ...overrides,
  }
}

/**
 * Install a `fetch` stub answering the process endpoint.
 *
 * Delegates to `stubKycFetch`, which also serves the methods endpoint: the
 * workspace fetches both, and a single-endpoint stub would hand the methods call
 * a processing payload.
 */
export function stubProcessingFetch(
  result: ProcessIdCardResponse = makeProcessingResult(),
): ReturnType<typeof vi.fn> {
  return stubKycFetch(result)
}

/** Install a `fetch` stub that rejects with the API's own error envelope. */
export function stubFailingFetch(
  code: string,
  message: string,
  status = 422,
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          error: { code, message, fieldErrors: {}, requestId: 'req_abc123' },
        }),
        { status, headers: { 'Content-Type': 'application/json' } },
      ),
    ),
  )
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}
/**
 * The six methods with their requirements, as `GET /api/v1/kyc/verification-methods`
 * returns them (§19).
 *
 * Mirrors the backend fixture set, including the phase state: only API 1 is
 * runnable, because current-face capture is Phase 6 and liveness is Phase 7.
 * A test that assumed otherwise would pass against a stub the real backend would
 * contradict.
 */
export const VERIFICATION_METHODS: readonly VerificationMethod[] = [
  {
    method: 'verify_user_info',
    officialName: 'Verify User Info',
    label: 'Identity Information',
    requiresUserInfo: true,
    requiresCurrentFace: false,
    requiresIdCard: false,
    requiresLiveness: false,
    requiresPassport: false,
    isOcr: false,
    available: true,
    unavailableReason: null,
  },
  {
    method: 'verify_user_info_face',
    officialName: 'Verify User Info + User Face',
    label: 'Identity + Face',
    requiresUserInfo: true,
    requiresCurrentFace: true,
    requiresIdCard: false,
    requiresLiveness: false,
    requiresPassport: false,
    isOcr: false,
    available: true,
    unavailableReason: null,
  },
  {
    method: 'verify_user_info_idcard_face',
    officialName: 'Verify User Info + ID Card + User Face',
    label: 'Identity + ID Card + Face',
    requiresUserInfo: true,
    requiresCurrentFace: true,
    requiresIdCard: true,
    requiresLiveness: false,
    requiresPassport: false,
    isOcr: false,
    available: true,
    unavailableReason: null,
  },
  {
    method: 'verify_user_info_idcard_liveness',
    officialName: 'Verify User Info + ID Card Image + Liveness',
    label: 'Identity + ID Card + Liveness',
    requiresUserInfo: true,
    requiresCurrentFace: false,
    requiresIdCard: true,
    requiresLiveness: true,
    requiresPassport: false,
    isOcr: false,
    available: false,
    unavailableReason: 'This method needs a liveness check, which this build does not run yet.',
  },
  {
    method: 'khmer_id_card_ocr',
    officialName: 'Khmer ID Card OCR',
    label: 'Read Cambodian ID Card',
    requiresUserInfo: false,
    requiresCurrentFace: false,
    requiresIdCard: true,
    requiresLiveness: false,
    requiresPassport: false,
    isOcr: true,
    available: false,
    unavailableReason: 'This is a document read, not a verification. It runs when you process a document.',
  },
  {
    method: 'passport_ocr',
    officialName: 'Passport OCR',
    label: 'Read Passport',
    requiresUserInfo: false,
    requiresCurrentFace: false,
    requiresIdCard: false,
    requiresLiveness: false,
    requiresPassport: true,
    isOcr: true,
    available: false,
    unavailableReason: 'This method needs a passport image, which this build does not read yet.',
  },
]

/** The face-capture endpoint's payload: a signed artefact handle (§17). */
export function makeFaceCapture(): FaceCaptureResponse {
  return {
    status: 'detected',
    detectedCount: 1,
    box: { x: 312, y: 96, width: 180, height: 210 },
    faceRef: 'art_0a1b2c3d4e5f60718293a4b5c6d7e8f9',
    quality: 96.4,
  }
}

/** Install a `fetch` stub that answers both KYC endpoints (§19). */
export function stubKycFetch(
  result: ProcessIdCardResponse = makeProcessingResult(),
  methods: readonly VerificationMethod[] = VERIFICATION_METHODS,
  verifyResult: VerifyResponse | VerifyResponse[] = makeVerifyResult(),
): ReturnType<typeof vi.fn> {
  // An array answers successive /verify calls (last one repeats), so a test can
  // drive run after run through the accumulated list (D16).
  const verifyAnswers: readonly VerifyResponse[] = Array.isArray(verifyResult)
    ? verifyResult
    : [verifyResult]
  let verifyCall = 0
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = urlOf(input)
    // Each endpoint gets the payload its real contract carries: handing `/verify`
    // a processing payload used to crash the result card on `result.identity`.
    const body = url.includes('verification-methods')
      ? { methods }
      : url.includes('/api/v1/kyc/face-capture')
        ? makeFaceCapture()
        : url.includes('/api/v1/kyc/verify')
          ? verifyAnswers[Math.min(verifyCall++, verifyAnswers.length - 1)]!
          : result
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/** Parsed JSON body of a stubbed `fetch` call, typed. */
export function bodyOf<T>(call: readonly unknown[]): T {
  const init = call[1]
  const body = (init as RequestInit | undefined)?.body
  if (typeof body !== 'string') throw new Error('call had no JSON body')
  return JSON.parse(body) as T
}
