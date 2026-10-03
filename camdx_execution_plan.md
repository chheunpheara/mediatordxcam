# CAMDX KYC VERIFICATION APPLICATION

## Master Product & Implementation Specification

You are an autonomous senior full-stack engineer.

Build a **new project from scratch** for a Cambodian identity verification application integrating the **six CamDigiKey KYC APIs defined by CamDX**.

Do not assume an existing codebase.

Do not reuse the previous project architecture.

Do not create unrelated government-service APIs.

The application must be designed as a clean, modular KYC verification product that can later connect to the real CamDX environment.

---

# 1. PRODUCT OBJECTIVE

Build a web-based KYC application where a user can:

1. Upload a Cambodian National ID Card.
2. Extract identity information.
3. Detect/extract the face from the ID Card.
4. Review and edit extracted information.
5. Select a KYC verification method.
6. Provide additional information when required.
7. Perform CamDigiKey KYC verification.
8. View a clear human-readable verification report.

The user must NEVER need to understand CamDX API technical details.

The UI must never expose raw JSON.

---

# 2. OFFICIAL CAMDX API SCOPE

The application must support these six CamDigiKey KYC APIs:

### API 1

**Verify User Info**

Purpose:

Verify user-provided identity information.

---

### API 2

**Verify User Info + User Face**

Purpose:

Verify identity information together with the current user's face.

Additional requirement:

The user must provide a current face image.

---

### API 3

**Verify User Info + ID Card + User Face**

Purpose:

Verify:

* User information
* Submitted ID Card
* Current user's face

Additional requirements:

* ID Card image
* Current user face

---

### API 4

**Verify User Info + ID Card Image + Liveness**

Purpose:

Verify:

* User information
* ID Card
* Face
* Liveness

Additional requirements:

* ID Card image
* Liveness interaction

The application must support the documented liveness action workflow.

---

### API 5

**Khmer ID Card OCR**

Purpose:

Extract information from a Cambodian National ID Card.

This API is the primary entry point for the ID Card upload workflow.

---

### API 6

**Passport OCR**

Purpose:

Extract information from a passport.

This API is supported by the application but is not the primary Cambodian ID Card journey.

---

# 3. IMPORTANT API PRINCIPLE

Do not invent additional CamDX APIs.

Do not rename the six official APIs internally in a way that makes the implementation confusing.

Create an internal adapter/service layer that maps application actions to the six CamDigiKey APIs.

Example:

```text
Application
    |
    v
KYC Service
    |
    +---- Verify User Info
    |
    +---- Verify User Info + Face
    |
    +---- Verify User Info + ID Card + Face
    |
    +---- Verify User Info + ID Card + Liveness
    |
    +---- Khmer ID Card OCR
    |
    +---- Passport OCR
```

---

# 4. TECHNOLOGY STACK

Use:

## Frontend

* React
* TypeScript
* Vite
* TailwindCSS
* React Router
* Modern component architecture

## Backend

* Python 3.11+
* FastAPI
* Pydantic
* HTTP client for CamDX integration
* OpenCV

## Database

Use PostgreSQL only where persistent application data is actually required.

Do not store biometric images unnecessarily.

## Infrastructure

Use Docker Compose for local development.

Structure:

```text
camdx-kyc/
├── frontend/
├── backend/
├── docs/
├── tests/
├── docker-compose.yml
├── .env.example
├── .gitignore
└── README.md
```

---

# 5. ARCHITECTURE

Use a layered architecture.

```text
                    ┌──────────────────────┐
                    │      React UI        │
                    └──────────┬───────────┘
                               │
                               ▼
                    ┌──────────────────────┐
                    │     FastAPI API      │
                    │   Application Layer  │
                    └──────────┬───────────┘
                               │
                ┌──────────────┼──────────────┐
                ▼              ▼              ▼
        Document Service   Face Service   KYC Service
                │              │              │
                ▼              ▼              ▼
             OCR/API        OpenCV        CamDX Adapter
                                               │
                                               ▼
                                      CamDigiKey APIs
```

Keep these responsibilities separate.

---

# 6. FRONTEND PAGES

The application has two primary pages.

## PAGE 1 — LANDING PAGE

Route:

`/`

Purpose:

Start identity verification.

### UI

Centered card containing:

**Identity Verification**

"Verify your identity securely using your Cambodian National ID Card."

Primary action:

**Start Verification**

The user can:

* Click upload
* Drag and drop

Supported:

* JPG
* JPEG
* PNG
* WebP

After upload:

```text
Upload
  ↓
Validate file
  ↓
Preview
  ↓
Process ID Card
  ↓
Navigate to /id-card
```

---

# 7. FILE VALIDATION

Before sending the file to the backend:

Validate:

* File type
* File size
* Image readability
* Minimum resolution

Provide clear user messages.

Examples:

`Please upload a JPG, PNG or WebP image.`

`The image is too large.`

`The image quality is too low. Please upload a clearer ID Card.`

Do not expose technical exceptions.

---

# 8. PAGE 2 — ID CARD VERIFICATION

Route:

`/id-card`

Desktop layout:

```text
┌──────────────────┬──────────────────┬──────────────────┐
│                  │                  │                  │
│ ORIGINAL         │ ID CARD FACE     │ EXTRACTED DATA   │
│ DOCUMENT         │                  │                  │
│                  │                  │                  │
│                  │                  │                  │
│                  │                  │                  │
│                  │                  │                  │
│                  │                  │                  │
│ VERIFICATION     │                  │                  │
│ METHOD           │                  │                  │
└──────────────────┴──────────────────┴──────────────────┘
```

---

# 9. COLUMN 1 — ORIGINAL DOCUMENT

Display:

### Original ID Card

Requirements:

* Large preview
* Zoom
* Filename
* Processing status
* Replace document option

Below it:

### Verification Method

Display the six official methods.

Use user-friendly labels.

---

# 10. VERIFICATION METHOD UI

Display cards/radio options.

### 1. Identity Information

`Verify User Info`

Requires:

* Identity information

---

### 2. Identity + Face

`Verify User Info + User Face`

Requires:

* Identity information
* Current face

---

### 3. Identity + ID Card + Face

`Verify User Info + ID Card + User Face`

Requires:

* Identity information
* Original ID Card
* Current face

---

### 4. Identity + ID Card + Liveness

`Verify User Info + ID Card + Liveness`

Requires:

* Identity information
* Original ID Card
* Liveness

---

### 5. Cambodian ID Card OCR

`Read Cambodian ID Card`

Requires:

* Cambodian ID Card

---

### 6. Passport OCR

`Read Passport`

Requires:

* Passport

---

# 11. DYNAMIC REQUIREMENT ENGINE

This is an important architectural requirement.

Do NOT hard-code verification requirements throughout React components.

Create a centralized verification configuration.

Conceptually:

```typescript
type VerificationMethod = {
  id: string;
  name: string;
  requiresUserInfo: boolean;
  requiresCurrentFace: boolean;
  requiresIdCard: boolean;
  requiresLiveness: boolean;
  requiresPassport: boolean;
};
```

The UI uses this configuration to determine what the user must provide.

This ensures that:

* The Verify button is correctly enabled/disabled.
* Additional inputs appear automatically.
* Backend validation follows the same rules.

The backend MUST independently validate these requirements.

Never trust frontend validation alone.

---

# 12. COLUMN 2 — ID CARD FACE

Title:

`ID Card Face`

The backend must use OpenCV to detect and extract the face from the uploaded ID Card.

Create:

`backend/services/face_service.py`

Responsibilities:

* Read image
* Detect face
* Determine face bounding box
* Crop face
* Validate face quality
* Return temporary face image/reference

Handle:

### No face

`We couldn't detect a face on this ID Card.`

### Multiple faces

`Multiple faces were detected. Please upload a valid ID Card image.`

### Poor quality

`The face image is unclear. Please upload a clearer ID Card.`

Do not fabricate a face.

---

# 13. FACE DETECTION VS FACE VERIFICATION

This distinction MUST remain explicit throughout the architecture.

### OpenCV

Used for:

**Local face detection and extraction from the ID Card.**

It does NOT represent CamDX KYC verification.

### CamDigiKey

Used for:

**Government-side identity/face verification.**

Therefore:

```text
ID Card
   ↓
OpenCV
   ↓
Extract ID Card Face
```

is different from:

```text
Current User Face
       +
Identity Data
       +
ID Card
       ↓
CamDigiKey
       ↓
KYC Verification
```

Never present an OpenCV detection result as a government identity verification result.

---

# 14. COLUMN 3 — EDITABLE KYC FORM

Title:

`Identity Information`

Populate using the ID Card OCR result.

Fields:

* National ID
* First Name — Khmer
* Last Name — Khmer
* First Name — English
* Last Name — English
* Gender
* Date of Birth
* Issued Date
* Expired Date

All fields editable.

The user can correct OCR mistakes.

---

# 15. OCR SOURCE

For Cambodian ID Cards:

Use:

**CamDigiKey API #5 — Khmer ID Card OCR**

The application should process:

```text
ID Card Image
      ↓
CamDX OCR
      ↓
Structured Identity Data
      ↓
Editable Form
```

Do not duplicate OCR logic unnecessarily.

OpenCV is for face detection.

CamDX OCR is for identity information extraction.

---

# 16. OCR FALLBACK

If OCR cannot extract a field:

Leave the field empty.

Display:

`Please enter this information.`

Never guess.

Never generate fake identity information.

---

# 17. CURRENT USER FACE CAPTURE

For APIs #2 and #3:

The system must require a current user face.

Display a dedicated UI:

### Current Face

Options:

**Take Photo**

or

**Upload Photo**

Requirements:

* One face only
* Reasonable image quality
* Face visible
* No empty image

Display preview.

Provide:

* Retake
* Remove
* Replace

The verification action remains disabled until a valid face image exists.

---

# 18. LIVENESS FLOW

For API #4:

Create a dedicated liveness UI.

Example:

```text
Step 1 / 3

Turn your face left
```

Then:

```text
Step 2 / 3

Turn your face right
```

Then:

```text
Step 3 / 3

Nod your head
```

Show:

* Camera preview
* Instruction
* Progress indicator
* Capture status

Do not pretend that ordinary image upload is liveness.

For the local mock environment, create a clearly isolated:

`MockLivenessProvider`

so it can later be replaced by the actual CamDX liveness implementation.

---

# 19. BACKEND APPLICATION API

Create application-level APIs.

## Process ID Card

```text
POST /api/v1/kyc/id-card/process
```

Input:

ID Card image.

Output:

* OCR data
* face detection result
* temporary references
* processing status

---

## Get Verification Methods

```text
GET /api/v1/kyc/verification-methods
```

Return the six supported methods and their requirements.

---

## Verify

```text
POST /api/v1/kyc/verify
```

Input:

* verification method
* user information
* ID Card reference when required
* current face reference when required
* liveness reference when required

Backend validates the request.

Then calls the appropriate CamDigiKey adapter.

---

# 20. CAMDX ADAPTER

Create:

`backend/integrations/camdx/`

Example:

```text
camdx/
├── client.py
├── models.py
├── exceptions.py
├── config.py
└── services/
    ├── verify_user_info.py
    ├── verify_user_face.py
    ├── verify_user_idcard_face.py
    ├── verify_user_liveness.py
    ├── idcard_ocr.py
    └── passport_ocr.py
```

The purpose is to keep CamDX-specific implementation separate from business logic.

---

# 21. MOCK VS REAL CAMDX

The application must support two modes.

### MOCK

Used during development.

```text
CAMDX_MODE=mock
```

### REAL

For future integration.

```text
CAMDX_MODE=real
```

Do not mix mock implementation with production implementation.

Use an interface/adapter pattern.

Example:

```text
KYCService
    ↓
CamDXProvider
    ├── MockCamDXProvider
    └── RealCamDXProvider
```

This allows the application to switch to real CamDX APIs without rewriting the frontend.

---

# 22. CONFIGURATION

Use environment variables.

Example:

```text
CAMDX_MODE=mock
CAMDX_BASE_URL=
CAMDX_CLIENT_ID=
CAMDX_CLIENT_SECRET=
CAMDX_API_KEY=
CAMDX_TIMEOUT=30
```

Never hard-code credentials.

Create:

`.env.example`

Never commit:

`.env`

---

# 23. NORMALIZED KYC RESULT

The frontend must never depend directly on CamDX's raw response structure.

Create an internal normalized result.

Conceptually:

```typescript
{
  status,
  method,
  identity: {
    matched,
    incorrectFields
  },
  face: {
    required,
    verified,
    score
  },
  idCard: {
    required,
    verified
  },
  liveness: {
    required,
    verified,
    score
  },
  message
}
```

The exact structure can be improved during implementation.

The principle is:

**CamDX response → backend normalization → UI result**

---

# 24. VERIFICATION REPORT

Once verification completes, replace or supplement the verification workspace with a clear report.

Never show JSON.

Never show:

* API response
* HTTP response
* technical endpoint
* raw error
* internal score fields

unless explicitly required by an administrator/developer view.

---

# 25. SUCCESS REPORT

Example:

## ✓ Verification Successful

### Identity

| Field         | Status    |
| ------------- | --------- |
| National ID   | ✓ Matched |
| First Name    | ✓ Matched |
| Last Name     | ✓ Matched |
| Date of Birth | ✓ Matched |
| Gender        | ✓ Matched |

### Face

`✓ Face verification successful`

### ID Card

`✓ ID Card verified`

### Liveness

`✓ Liveness verified`

Only show relevant sections.

For example, API #1 should not display a face section.

---

# 26. PARTIAL RESULT

If some fields fail:

## Verification Completed with Differences

Display:

`✓ National ID matched`

`✓ Name matched`

`✕ Date of Birth does not match`

Do not simply display:

`Verification Failed`

when useful partial information exists.

---

# 27. FAILED RESULT

Display:

## Verification Unsuccessful

Provide a clear explanation.

Examples:

`The submitted identity information could not be verified.`

`The current face could not be verified.`

`The ID Card could not be read.`

`The liveness verification was unsuccessful.`

Provide an appropriate action:

* Try Again
* Upload New Document
* Retake Photo

---

# 28. CAMDX ERROR TRANSLATION

Create an error-mapping layer.

Technical CamDX errors must never be passed directly to the frontend.

Example:

```text
CamDX technical error
       ↓
Backend error mapper
       ↓
Business-friendly message
       ↓
Frontend
```

The user should see meaningful messages rather than:

`500 Internal Server Error`

---

# 29. PRIVACY AND BIOMETRIC DATA

Treat ID Card images and face images as highly sensitive.

Requirements:

* Use HTTPS-ready architecture.
* Never expose files through public static directories.
* Use temporary storage where possible.
* Automatically delete temporary biometric files.
* Do not store face embeddings unless explicitly required.
* Do not log face images.
* Do not log full ID Card images.
* Avoid logging unnecessary personal information.
* Do not put uploaded files into Git.
* Do not expose sensitive information in browser console logs.

Document the data lifecycle in:

`docs/data-privacy.md`

---

# 30. SECURITY BOUNDARY

The browser must NEVER communicate directly with CamDX using secret credentials.

Correct:

```text
Browser
   ↓
Our FastAPI Backend
   ↓
CamDX
```

Incorrect:

```text
Browser
   ↓
CamDX
```

CamDX credentials and integration configuration remain server-side.

---

# 31. RESPONSIVE UX

Desktop:

Three columns.

Tablet:

Two columns.

Mobile:

Stack:

1. Original ID Card
2. Face
3. Identity Information
4. Verification Method
5. Additional verification input
6. Result

The workflow must remain usable on mobile browsers.

---

# 32. ACCESSIBILITY

Implement:

* Keyboard navigation
* Visible focus states
* Proper labels
* Accessible buttons
* Error messages associated with inputs
* Sufficient contrast
* Screen-reader-friendly status messages

Do not rely on color alone.

---

# 33. STATE MANAGEMENT

Maintain a clear verification state.

Suggested state:

```text
idle
uploading
processing
ocr_completed
face_detected
review_required
ready_for_verification
collecting_face
collecting_liveness
verifying
success
partial
failed
```

Do not allow invalid transitions.

Example:

```text
verifying
```

cannot start until required inputs exist.

---

# 34. TESTING STRATEGY

Implement tests at three levels.

## Unit

Test:

* OCR mapping
* Face detection service
* Verification requirement rules
* CamDX response normalization
* Error mapping

## Integration

Test:

* Upload → processing
* Processing → form
* Verification method → required inputs
* Verification → CamDX mock
* CamDX result → normalized result

## End-to-End

Test:

### Scenario A

ID Card → OCR → API #1 → Success

### Scenario B

ID Card → OCR → current face → API #2 → Success

### Scenario C

ID Card → OCR → current face → API #3 → Success

### Scenario D

ID Card → OCR → liveness → API #4 → Success

### Scenario E

Passport → API #6 → OCR

### Scenario F

Incorrect identity information → partial/failure

### Scenario G

Face mismatch → failure

### Scenario H

No face detected → processing failure

### Scenario I

Liveness failure → verification failure

---

# 35. PROJECT DOCUMENTATION

Create:

```text
README.md
docs/
├── architecture.md
├── api.md
├── camdx-integration.md
├── verification-flow.md
├── data-privacy.md
├── development.md
└── testing.md
```

README must explain:

* What the application does
* Architecture
* Local setup
* Docker startup
* Environment variables
* Mock mode
* Real CamDX integration preparation
* Testing

---

# 36. DEVELOPMENT PHASES

Do NOT attempt to build everything in one uncontrolled step.

Execute in phases.

## Phase 1 — Foundation

Create:

* Repository
* Docker Compose
* FastAPI
* React
* Tailwind
* Environment configuration
* Health check

Acceptance:

Application starts successfully.

---

## Phase 2 — Landing Page

Implement:

* Upload
* Drag/drop
* File validation
* Preview
* Navigation

Acceptance:

User can upload an ID Card and enter the verification workspace.

---

## Phase 3 — ID Card Processing

Implement:

* CamDX OCR abstraction
* Mock OCR provider
* OpenCV face detection
* Temporary file handling

Acceptance:

Uploaded ID Card produces:

* Extracted identity fields
* Extracted face

---

## Phase 4 — Three-Column UI

Implement:

* Original document
* Face
* Editable form

Acceptance:

All extracted information is editable.

---

## Phase 5 — Verification Method Engine

Implement:

* Six verification methods
* Requirement configuration
* Dynamic UI
* Backend validation

Acceptance:

Each method asks only for its required inputs.

---

## Phase 6 — Face Verification Flow

Implement:

* Current photo
* Camera/upload
* API #2
* API #3

Acceptance:

Verification cannot start without required current face.

---

## Phase 7 — Liveness

Implement:

* Camera workflow
* Liveness state
* Actions
* API #4 adapter
* Mock provider

Acceptance:

API #4 cannot execute without the required liveness state.

---

## Phase 8 — Passport OCR

Implement API #6.

Acceptance:

Passport image can be processed independently from ID Card flow.

---

## Phase 9 — Verification Report

Implement:

* Success
* Partial
* Failed
* Matched fields
* Green check icons
* User-friendly errors

Acceptance:

No raw JSON appears in the user interface.

---

## Phase 10 — Hardening

Implement:

* Security
* Privacy
* Cleanup
* Error handling
* Logging policy
* Automated tests
* Documentation

---

# 37. FINAL ACCEPTANCE CRITERIA

The project is complete only when:

### User Experience

* [ ] Landing page works.
* [ ] ID Card upload works.
* [ ] ID Card preview works.
* [ ] Three-column workspace works.
* [ ] Face is extracted and displayed.
* [ ] Identity form is populated.
* [ ] Identity form is editable.
* [ ] Verification methods are clearly presented.
* [ ] Required additional inputs appear dynamically.
* [ ] Current face capture works.
* [ ] Liveness flow works in mock mode.
* [ ] Passport OCR is available.

### CamDX

* [ ] Six official CamDigiKey KYC APIs are represented.
* [ ] API #1 is correctly mapped.
* [ ] API #2 is correctly mapped.
* [ ] API #3 is correctly mapped.
* [ ] API #4 is correctly mapped.
* [ ] API #5 is correctly mapped.
* [ ] API #6 is correctly mapped.
* [ ] CamDX integration is isolated behind an adapter.
* [ ] Mock mode works independently.
* [ ] Real integration can be added without rewriting the frontend.

### Security

* [ ] CamDX credentials are server-side.
* [ ] Sensitive files are temporary.
* [ ] Sensitive information is not unnecessarily logged.
* [ ] No secrets are committed.
* [ ] Raw biometric data is not unnecessarily persisted.

### UX Result

* [ ] No raw JSON is shown.
* [ ] Successful fields show green check icons.
* [ ] Failed fields are clearly identified.
* [ ] Face verification status is clear.
* [ ] Liveness status is clear.
* [ ] User receives actionable error messages.

### Quality

* [ ] Unit tests pass.
* [ ] Integration tests pass.
* [ ] E2E tests pass.
* [ ] Frontend build passes.
* [ ] Docker Compose starts successfully.
* [ ] Documentation is complete.

---

# 38. CODING-AGENT EXECUTION RULE

Do not generate the entire application blindly.

Follow this sequence:

```text
1. Analyze requirements
2. Create architecture
3. Create implementation plan
4. Create project structure
5. Implement Phase 1
6. Test Phase 1
7. Implement Phase 2
8. Test Phase 2
9. Continue phase by phase
10. Run complete automated test suite
11. Perform end-to-end validation
12. Review UI/UX
13. Fix issues
14. Provide final implementation summary
```

At every phase:

* Do not leave known errors unresolved.
* Do not skip tests.
* Do not silently change requirements.
* Do not invent CamDX behavior.
* Keep CamDX-specific code isolated.
* Keep mock and real integration separate.

**Start now with Phase 1: analyze the requirements and create the architecture/project structure. Do not implement later phases until Phase 1 is validated.**
