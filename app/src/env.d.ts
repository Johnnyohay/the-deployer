/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Set for the GitHub Pages build: no server, ANU runs in the browser. */
  readonly VITE_STATIC?: string;
  /** Where the browser build loads data from (default: the site's api/v1/all.json). */
  readonly VITE_DATA_URL?: string;
}
