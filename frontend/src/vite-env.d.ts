/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Base path of our backend. Empty in development, where the Vite proxy makes
   * the backend same-origin. Never a CamDX URL — the browser must not be able to
   * reach CamDigiKey even if this value is tampered with (§30).
   */
  readonly VITE_API_BASE_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}