/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Your name in the hero greeting (optional). */
  readonly VITE_OPERATOR_NAME?: string
}
interface ImportMeta {
  readonly env: ImportMetaEnv
}
