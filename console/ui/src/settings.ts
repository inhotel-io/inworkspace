export interface UiSettings {
  /** Origin of the console API, or "" for the page's own origin (the development server proxies it). */
  apiUrl: string;
  clientId: string;
  /** The configured time zone, else the browser's own. */
  timeZone: string;
  /** The path the server serves the app under, such as "/console"; "" at the root. */
  basePath: string;
}

function meta(document: Document, name: string): string {
  return document.querySelector(`meta[name="${name}"]`)?.getAttribute("content")?.trim() ?? "";
}

/** The server rewrites the page's <base href> to the app's prefix: ".../console/" → "/console". */
export function basePathFrom(baseUri: string): string {
  return new URL(baseUri).pathname.replace(/\/+$/, "");
}

export function readSettings(document: Document): UiSettings {
  return {
    apiUrl: meta(document, "inworkspace-console-api").replace(/\/+$/, ""),
    clientId: meta(document, "inworkspace-console-client-id"),
    timeZone: meta(document, "inworkspace-console-time-zone") || Intl.DateTimeFormat().resolvedOptions().timeZone,
    basePath: basePathFrom(document.baseURI),
  };
}
