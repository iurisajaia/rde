/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Reserved for future use */
  readonly VITE_EXAMPLE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
