/**
 * Typed client for our own backend (§19).
 *
 * Two rules shape this file.
 *
 * The browser talks only to our backend, never to CamDigiKey (§30). There is no
 * CamDX host, credential or endpoint anywhere here, and `VITE_API_BASE_URL` is
 * documented as our own origin. A real CamDX integration is added server-side
 * behind the adapter; nothing in this file changes when it lands.
 *
 * A failed *call* is not a failed *verification*. §28 reserves HTTP errors for
 * malformed or unprocessable requests, so this module turns a non-2xx response
 * into an `ApiError` carrying the server's own user-facing sentence. The UI shows
 * that sentence and never a status line, a stack trace or raw JSON (§24, §28).
 */

import { AUTH_EXPIRED_EVENT } from './auth'

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? ''

/** Mirrors `app/domain/enums.py::FaceExtractionStatus` (§12). */
export const FACE_STATUS = {
  detected: 'detected',
  notDetected: 'not_detected',
  multiple: 'multiple',
  lowQuality: 'low_quality',
} as const

export type FaceStatus = (typeof FACE_STATUS)[keyof typeof FACE_STATUS]

/** Mirrors `app/domain/enums.py::OcrStatus` (§16). */
export type OcrStatus = 'completed' | 'partial' | 'unreadable'

export type ProcessingStatus = 'completed' | 'partial'

/** The nine fields of §14, in the order the form presents them. */
export const IDENTITY_FIELDS = [
  'nationalId',
  'firstNameKhmer',
  'lastNameKhmer',
  'firstNameEnglish',
  'lastNameEnglish',
  'gender',
  'dateOfBirth',
  'issuedDate',
  'expiryDate',
] as const

export type IdentityFieldName = (typeof IDENTITY_FIELDS)[number]

/**
 * Identity fields as read by OCR (§14).
 *
 * Khmer and English names are four separate values, not a transliterated pair: a
 * Cambodian ID card prints the holder's name in both scripts and they differ.
 * `null` means "not extracted" (§16) and is distinct from an empty edit.
 */
export type IdentityFields = Readonly<Record<IdentityFieldName, string | null>>

export interface IdentityResponse {
  readonly status: OcrStatus
  readonly documentType: string | null
  readonly fields: IdentityFields
  readonly missingFields: readonly string[]
}

export interface FaceBox {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/**
 * Local detection outcome (§12, §13).
 *
 * `source` is always `local_opencv_detection` and there is no `verified` or
 * `score` field to read, so no caller can mistake this for a CamDX result.
 * `quality` is crop sharpness only.
 */
export interface FaceExtraction {
  readonly status: FaceStatus
  readonly source: string
  readonly detectedCount: number
  readonly box: FaceBox | null
  readonly faceRef: string | null
  readonly quality: number | null
}

export interface ProcessIdCardResponse {
  readonly processingId: string
  readonly status: ProcessingStatus
  readonly ocr: IdentityResponse
  readonly face: FaceExtraction
  readonly documentRef: string
}

/** The error envelope from `app/schemas/common.py::ErrorResponse` (§28). */
interface ErrorEnvelope {
  readonly error?: {
    readonly code?: string
    readonly message?: string
    readonly requestId?: string
    /** Per-field messages for form validation (D18), keyed by form field. */
    readonly fieldErrors?: Readonly<Record<string, string>>
  }
}

/**
 * A rejected request, carrying the server's own wording.
 *
 * `message` is safe to render. Anything else about the failure — status codes,
 * upstream detail — is deliberately not exposed here, because the verification
 * UI must not leak it (§24, §28).
 */
export class ApiError extends Error {
  readonly code: string
  readonly status: number
  readonly requestId: string | undefined
  readonly fieldErrors: Readonly<Record<string, string>>

  constructor(
    code: string,
    message: string,
    status: number,
    requestId?: string,
    fieldErrors: Readonly<Record<string, string>> = {},
  ) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = status
    this.requestId = requestId
    this.fieldErrors = fieldErrors
  }
}

/** Used when the server could not be reached at all. */
export const NETWORK_ERROR_MESSAGE =
  'We could not reach the verification service. Please check your connection and try again.'

function apiUrl(path: string): string {
  return `${API_BASE}${path}`
}

/**
 * Pull the user-facing sentence out of a failure response.
 *
 * Falls back to a generic sentence rather than the raw body, so an unexpected
 * shape cannot put JSON on screen (§24).
 */
async function toApiError(response: Response): Promise<ApiError> {
  let code = 'UNKNOWN'
  let message = 'Something went wrong. Please try again.'
  let requestId: string | undefined
  let fieldErrors: Readonly<Record<string, string>> = {}

  // A 401 anywhere means the session is gone (expired, revoked, account
  // disabled). Announce it once, here, rather than making every caller
  // remember: `AuthProvider` clears the local profile and the route guards
  // take the user to the sign-in page. A failed sign-in is also a 401, but by
  // then the profile is already absent, so the event is a harmless no-op.
  if (response.status === 401 && typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(AUTH_EXPIRED_EVENT))
  }

  try {
    const body = (await response.json()) as ErrorEnvelope
    code = body.error?.code ?? code
    message = body.error?.message ?? message
    requestId = body.error?.requestId
    fieldErrors = body.error?.fieldErrors ?? {}
  } catch {
    // A non-JSON body (a proxy error page, say) is not something to show.
  }

  return new ApiError(code, message, response.status, requestId, fieldErrors)
}

/**
 * `POST /api/v1/kyc/id-card/process` (§19).
 *
 * The file is sent as multipart under the field name `document`. The browser has
 * already validated type, size and resolution; the server re-checks all three.
 */
export async function processIdCard(file: File | Blob): Promise<ProcessIdCardResponse> {
  const body = new FormData()
  body.append('document', file)

  let response: Response
  try {
    response = await fetch(apiUrl('/api/v1/kyc/id-card/process'), {
      method: 'POST',
      body,
      // No Content-Type: the browser must set the multipart boundary itself.
    })
  } catch {
    throw new ApiError('NETWORK_ERROR', NETWORK_ERROR_MESSAGE, 0)
  }

  if (!response.ok) {
    throw await toApiError(response)
  }

  return (await response.json()) as ProcessIdCardResponse
}

export interface FaceCaptureResponse {
  status: FaceStatus
  detectedCount: number
  box: FaceBox | null
  faceRef: string
  quality: number | null
}

/** `POST /api/v1/kyc/face-capture`. */
export async function captureCurrentFace(file: File | Blob): Promise<FaceCaptureResponse> {
  const body = new FormData()
  body.append('face', file)

  let response: Response
  try {
    response = await fetch(apiUrl('/api/v1/kyc/face-capture'), {
      method: 'POST',
      body,
    })
  } catch {
    throw new ApiError('NETWORK_ERROR', NETWORK_ERROR_MESSAGE, 0)
  }

  if (!response.ok) {
    throw await toApiError(response)
  }

  return (await response.json()) as FaceCaptureResponse
}

/**
 * URL for a stored artefact (§14, §29).
 *
 * Image bytes are never inlined in the processing response; only opaque handles
 * cross the wire, and they are dereferenced here. The handle is inserted into the
 * path, so it is encoded — a handle is server-generated, but URL-encoding keeps a
 * malformed value from escaping the path.
 */
export function artifactUrl(handle: string): string {
  return apiUrl(`/api/v1/kyc/artifacts/${encodeURIComponent(handle)}`)
}
/* ---------------------------------------------------------------------------
 * Verification methods and verify (§10, §19)
 *
 * §11 forbids hard-coding requirements in components. So the method list is
 * fetched from the backend and every card, disabled state and extra input is
 * derived from it. Nothing in the React tree knows that API 2 needs a face or
 * that API 4 needs liveness — it reads flags off the response.
 * ------------------------------------------------------------------------- */

export type VerificationMethodId =
  | 'verify_user_info'
  | 'verify_user_info_face'
  | 'verify_user_info_idcard_face'
  | 'verify_user_info_idcard_liveness'
  | 'khmer_id_card_ocr'
  | 'passport_ocr'

/**
 * Every verification permission, in card order (D19).
 *
 * The full set the server requires before it lets anyone post to core
 * systems. Display gating only: a profile missing a permission here hides a
 * button, and the server refuses the request regardless.
 */
export const ALL_VERIFICATION_METHOD_KEYS: readonly VerificationMethodId[] = [
  'verify_user_info',
  'verify_user_info_face',
  'verify_user_info_idcard_face',
  'verify_user_info_idcard_liveness',
  'khmer_id_card_ocr',
  'passport_ocr',
]

/** One method and the inputs it requires (§11, §19). */
export interface VerificationMethod {
  readonly method: VerificationMethodId
  /** The verbatim CamDigiKey name (§3). Shown as supporting text, never renamed. */
  readonly officialName: string
  /** User-friendly label for the method card (§10). */
  readonly label: string
  readonly requiresUserInfo: boolean
  readonly requiresCurrentFace: boolean
  readonly requiresIdCard: boolean
  readonly requiresLiveness: boolean
  readonly requiresPassport: boolean
  readonly isOcr: boolean
  /** False while a required input does not exist in this build yet. */
  readonly available: boolean
  readonly unavailableReason: string | null
}

export type FieldCheckStatus = 'matched' | 'mismatch' | 'not_checked'

export interface IdentityFieldOutcome {
  readonly field: string
  readonly status: FieldCheckStatus
  readonly submitted: string | null
}

export interface SectionOutcome {
  readonly required: boolean
  readonly verified: boolean | null
}

export type VerificationStatus = 'success' | 'partial' | 'failed'

/** The normalized result (§23). Deliberately has no score field — §24. */
export interface VerifyResponse {
  readonly status: VerificationStatus
  readonly method: VerificationMethodId
  readonly identity: {
    readonly fields: readonly IdentityFieldOutcome[]
    readonly matchedCount: number
    readonly incorrectFields: readonly string[]
  }
  readonly face: SectionOutcome
  readonly idCard: SectionOutcome
  readonly liveness: SectionOutcome
}

export interface VerifyRequest {
  readonly method: VerificationMethodId
  readonly userInformation?: IdentityFields
  readonly idCardRef?: string | null
  readonly currentFaceRef?: string | null
  readonly livenessRef?: string | null
  readonly idCardFaceRef?: string | null
}

/** The six methods with their requirements (§19). */
export async function fetchVerificationMethods(): Promise<readonly VerificationMethod[]> {
  let response: Response
  try {
    response = await fetch(apiUrl('/api/v1/kyc/verification-methods'))
  } catch {
    throw new ApiError('NETWORK_ERROR', NETWORK_ERROR_MESSAGE, 0)
  }

  if (!response.ok) {
    throw await toApiError(response)
  }

  const body = (await response.json()) as { methods: VerificationMethod[] }
  return body.methods
}

/**
 * `POST /api/v1/kyc/verify` (§19).
 *
 * A 422 `REQUIREMENTS_NOT_MET` carries `missing` naming the specific inputs, so
 * `RequirementsNotMetError` below surfaces which one to ask for rather than the
 * method-agnostic sentence the server also sends.
 */
export async function verify(request: VerifyRequest): Promise<VerifyResponse> {
  let response: Response
  try {
    response = await fetch(apiUrl('/api/v1/kyc/verify'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    })
  } catch {
    throw new ApiError('NETWORK_ERROR', NETWORK_ERROR_MESSAGE, 0)
  }

  if (!response.ok) {
    const error = await toApiError(response)
    if (error.code === 'REQUIREMENTS_NOT_MET') {
      throw new RequirementsNotMetError(error.message, await missingFlags(response))
    }
    throw error
  }

  return (await response.json()) as VerifyResponse
}

/** Re-read the envelope for `missing`; `toApiError` keeps only code and message. */
async function missingFlags(response: Response): Promise<readonly string[]> {
  try {
    const body = (await response.clone().json()) as {
      error?: { missing?: string[] }
    }
    return body.error?.missing ?? []
  } catch {
    return []
  }
}

/** The chosen method's required inputs were absent (§11). */
export class RequirementsNotMetError extends ApiError {
  readonly missing: readonly string[]

  constructor(message: string, missing: readonly string[]) {
    super('REQUIREMENTS_NOT_MET', message, 422)
    this.name = 'RequirementsNotMetError'
    this.missing = missing
  }
}
/* ---------------------------------------------------------------------------
 * Sign-in and account administration (D18)
 *
 * The session is a cookie: `fetch` sends it on its own for same-origin calls,
 * so none of this code ever reads or writes a token. Responses carry the
 * account's profile, which the auth storage keeps for display and guards —
 * permissions are re-derived server-side on every request, never trusted from
 * what is cached here.
 * ------------------------------------------------------------------------- */

export type UserStatus = 'active' | 'disabled'

/** A role reference as embedded in a user (`RoleSummaryResponse`). */
export interface AuthRoleRef {
  readonly id: string
  readonly name: string
}

/** One account (`UserResponse`). Passwords never appear in any response. */
export interface AuthUser {
  readonly id: string
  readonly email: string
  readonly name: string
  readonly status: UserStatus
  readonly roles: readonly AuthRoleRef[]
  readonly isAdmin: boolean
  /** Every method this account may run, merged from its roles (D19). */
  readonly permissions: readonly VerificationMethodId[]
}

export interface LoginResponse {
  readonly token: string
  readonly user: AuthUser
}

/** One assignable permission, labelled exactly as the method card labels it. */
export interface PermissionItem {
  readonly key: VerificationMethodId
  readonly label: string
  readonly officialName: string
}

/** A role with its permission keys — what the matrix renders. */
export interface AdminRole {
  readonly id: string
  readonly name: string
  readonly isAdmin: boolean
  readonly permissions: readonly VerificationMethodId[]
}

export interface CreateUserInput {
  readonly email: string
  readonly name: string
  readonly password: string
  readonly roleIds: readonly string[]
}

export interface UpdateUserInput {
  readonly name?: string
  readonly roleIds?: readonly string[]
  readonly status?: UserStatus
  readonly password?: string
}

export interface CreateRoleInput {
  readonly name: string
  readonly isAdmin: boolean
}

/**
 * One JSON round-trip with the shared failure handling.
 *
 * Every authenticated endpoint below differs only in path and payload, so the
 * network/parse/error dance lives here once — the same rule the feature code
 * follows: a rejected call throws `ApiError` carrying the server's sentence.
 */
async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(apiUrl(path), init)
  } catch {
    throw new ApiError('NETWORK_ERROR', NETWORK_ERROR_MESSAGE, 0)
  }

  if (!response.ok) {
    throw await toApiError(response)
  }
  if (response.status === 204) {
    return undefined as T
  }
  return (await response.json()) as T
}

function jsonInit(method: string, body?: unknown): RequestInit {
  const init: RequestInit =
    body === undefined
      ? { method, headers: { 'Content-Type': 'application/json' } }
      : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
  return init
}

/** `POST /api/v1/auth/login`. Sets the session cookie on success. */
export async function login(email: string, password: string): Promise<LoginResponse> {
  return requestJson<LoginResponse>('/api/v1/auth/login', jsonInit('POST', { email, password }))
}

/** `POST /api/v1/auth/logout`. Idempotent: signing out twice is not an error. */
export async function logout(): Promise<void> {
  await requestJson<void>('/api/v1/auth/logout', jsonInit('POST', {}))
}

/** The six assignable permissions (`GET /api/v1/admin/permissions`). */
export async function fetchPermissions(): Promise<readonly PermissionItem[]> {
  const body = await requestJson<{ permissions: PermissionItem[] }>('/api/v1/admin/permissions')
  return body.permissions
}

/** Every account (`GET /api/v1/admin/users`). */
export async function fetchUsers(): Promise<readonly AuthUser[]> {
  const body = await requestJson<{ users: AuthUser[] }>('/api/v1/admin/users')
  return body.users
}

/** `POST /api/v1/admin/users` — create an account (201). */
export async function createUser(input: CreateUserInput): Promise<AuthUser> {
  return requestJson<AuthUser>('/api/v1/admin/users', jsonInit('POST', input))
}

/** `PATCH /api/v1/admin/users/{id}` — omitted fields stay unchanged. */
export async function updateUser(id: string, input: UpdateUserInput): Promise<AuthUser> {
  return requestJson<AuthUser>(
    `/api/v1/admin/users/${encodeURIComponent(id)}`,
    jsonInit('PATCH', input),
  )
}

/** `DELETE /api/v1/admin/users/{id}` — never yourself, never the last admin. */
export async function deleteUser(id: string): Promise<void> {
  await requestJson<void>(`/api/v1/admin/users/${encodeURIComponent(id)}`, jsonInit('DELETE'))
}

/** Every role with its permissions (`GET /api/v1/admin/roles`). */
export async function fetchRoles(): Promise<readonly AdminRole[]> {
  const body = await requestJson<{ roles: AdminRole[] }>('/api/v1/admin/roles')
  return body.roles
}

/** `POST /api/v1/admin/roles` — create a role (201). */
export async function createRole(input: CreateRoleInput): Promise<AdminRole> {
  return requestJson<AdminRole>('/api/v1/admin/roles', jsonInit('POST', input))
}

/** `PATCH /api/v1/admin/roles/{id}` — rename or toggle admin rights. */
export async function updateRole(
  id: string,
  input: { readonly name?: string; readonly isAdmin?: boolean },
): Promise<AdminRole> {
  return requestJson<AdminRole>(
    `/api/v1/admin/roles/${encodeURIComponent(id)}`,
    jsonInit('PATCH', input),
  )
}

/** `PUT /api/v1/admin/roles/{id}/permissions` — replace the whole set. */
export async function setRolePermissions(
  id: string,
  permissions: readonly VerificationMethodId[],
): Promise<AdminRole> {
  return requestJson<AdminRole>(
    `/api/v1/admin/roles/${encodeURIComponent(id)}/permissions`,
    jsonInit('PUT', { permissions }),
  )
}

/** `DELETE /api/v1/admin/roles/{id}` — refused while a user still holds it. */
export async function deleteRole(id: string): Promise<void> {
  await requestJson<void>(`/api/v1/admin/roles/${encodeURIComponent(id)}`, jsonInit('DELETE'))
}

/* ------------------------------------------------------------------------- *
 * Third-party integration settings and posting (D19)
 * ------------------------------------------------------------------------- */

/**
 * One configured core system. The password is write-only: the server never
 * returns it, so a save that keeps this row's credentials sends a blank one.
 */
export interface IntegrationSetting {
  readonly id: string
  readonly url: string
  readonly apiUser: string
}

/** One row on its way to `PUT /api/v1/integrations/settings`. */
export interface IntegrationSettingInput {
  readonly id?: string | null
  readonly url: string
  readonly apiUser: string
  readonly apiPassword?: string
}

export interface IntegrationSettingsResponse {
  readonly settings: readonly IntegrationSetting[]
}

/** One target that did not take the post, in safe words only (§28). */
export interface PostToCoreFailure {
  readonly url: string
  readonly reason: string
}

/** Per-target outcome of `POST /api/v1/integrations/post`. */
export interface PostToCoreResponse {
  readonly posted: readonly string[]
  readonly failed: readonly PostToCoreFailure[]
}

/** Every configured system (`GET /api/v1/integrations/settings`). */
export async function fetchIntegrationSettings(): Promise<readonly IntegrationSetting[]> {
  const body = await requestJson<IntegrationSettingsResponse>('/api/v1/integrations/settings')
  return body.settings
}

/** `PUT /api/v1/integrations/settings` — replaces the whole list. */
export async function saveIntegrationSettings(
  settings: readonly IntegrationSettingInput[],
): Promise<readonly IntegrationSetting[]> {
  const body = await requestJson<IntegrationSettingsResponse>(
    '/api/v1/integrations/settings',
    jsonInit('PUT', { settings }),
  )
  return body.settings
}

/** `POST /api/v1/integrations/post` — replay a result to every system (D19). */
export async function postToCore(payload: VerifyResponse): Promise<PostToCoreResponse> {
  return requestJson<PostToCoreResponse>(
    '/api/v1/integrations/post',
    jsonInit('POST', { payload }),
  )
}
