import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { zipSync, type Zippable } from "fflate";
import type { ConsoleConfig } from "./config";

export interface UiSettings {
  apiUrl: string;
  clientId: string;
  timeZone: string | null;
}

export interface UiBundle {
  version: string;
  fileName: string;
  zip: Uint8Array<ArrayBuffer>;
}

export const BUNDLE_FILE = /^console-[A-Za-z0-9_-]{1,64}\.zip$/;

/** The server rewrites exactly this tag to the app's prefix; without it the app cannot find its assets. */
const BASE_TAG = '<base href="/"';
/** A fixed time for every entry, so the same files always give the same zip. */
const ENTRY_TIME = new Date("2000-01-01T00:00:00Z");

export function uiSettingsFrom(config: Pick<ConsoleConfig, "publicUrl" | "oauthClientId" | "displayTimeZone">): UiSettings {
  return { apiUrl: config.publicUrl, clientId: config.oauthClientId, timeZone: config.displayTimeZone };
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** The web app's own policy: its scripts and styles, calls to the console API only, inline images only. */
export function contentSecurityPolicy(apiUrl: string): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    `connect-src 'self' ${new URL(apiUrl).origin}`,
    "frame-src 'self'",
    "base-uri 'self'",
    "form-action 'none'",
    "object-src 'none'",
  ].join("; ");
}

export function renderIndex(template: string, settings: UiSettings): string {
  if (!template.includes(BASE_TAG)) {
    throw new Error(`the built index.html has no ${BASE_TAG}> tag, so the server could not place the app under its prefix`);
  }
  const values: Record<string, string> = {
    __CONSOLE_CSP__: contentSecurityPolicy(settings.apiUrl),
    __CONSOLE_API_URL__: settings.apiUrl,
    __CONSOLE_OAUTH_CLIENT_ID__: settings.clientId,
    __CONSOLE_TIME_ZONE__: settings.timeZone ?? "",
  };
  let html = template;
  for (const [placeholder, value] of Object.entries(values)) {
    if (!html.includes(placeholder)) throw new Error(`the built index.html has no ${placeholder} placeholder`);
    html = html.split(placeholder).join(escapeAttribute(value));
  }
  return html;
}

async function listFiles(root: string, directory = ""): Promise<string[]> {
  const entries = await readdir(path.join(root, directory), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const relative = directory ? `${directory}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await listFiles(root, relative)));
    else if (entry.isFile()) files.push(relative);
  }
  return files;
}

/** The built web app as the zip the server downloads, with this deployment's settings in index.html. */
export async function buildUiBundle(distDir: string, settings: UiSettings): Promise<UiBundle> {
  let files: string[];
  try {
    files = (await listFiles(distDir)).sort();
  } catch {
    files = [];
  }
  if (!files.includes("index.html")) {
    throw new Error(`${distDir} has no index.html; build the web app with \`npm run build:ui\``);
  }
  const entries: Zippable = {};
  const hash = createHash("sha256");
  for (const file of files) {
    let content: Uint8Array = await readFile(path.join(distDir, file));
    if (file === "index.html") content = new TextEncoder().encode(renderIndex(Buffer.from(content).toString("utf8"), settings));
    entries[file] = content;
    hash.update(file).update("\0").update(content).update("\0");
  }
  const version = hash.digest("hex").slice(0, 16);
  return {
    version,
    fileName: `console-${version}.zip`,
    zip: new Uint8Array(zipSync(entries, { level: 9, mtime: ENTRY_TIME })),
  };
}
