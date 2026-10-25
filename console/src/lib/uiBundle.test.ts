import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { strFromU8, unzipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BUNDLE_FILE, buildUiBundle, contentSecurityPolicy, renderIndex } from "./uiBundle";

const TEMPLATE = [
  "<!doctype html><html><head>",
  '<meta http-equiv="Content-Security-Policy" content="__CONSOLE_CSP__" />',
  '<base href="/" />',
  '<meta name="inworkspace-console-api" content="__CONSOLE_API_URL__" />',
  '<meta name="inworkspace-console-client-id" content="__CONSOLE_OAUTH_CLIENT_ID__" />',
  '<meta name="inworkspace-console-time-zone" content="__CONSOLE_TIME_ZONE__" />',
  '<script type="module" src="./assets/index-abc.js"></script>',
  "</head><body></body></html>",
].join("");

const SETTINGS = { apiUrl: "https://console-api.example.com", clientId: "inworkspace-console", timeZone: "Europe/Zurich" };

describe("renderIndex", () => {
  it("writes the settings into the page", () => {
    const html = renderIndex(TEMPLATE, SETTINGS);
    expect(html).toContain('<meta name="inworkspace-console-api" content="https://console-api.example.com" />');
    expect(html).toContain('<meta name="inworkspace-console-client-id" content="inworkspace-console" />');
    expect(html).toContain('<meta name="inworkspace-console-time-zone" content="Europe/Zurich" />');
    expect(html).not.toContain("__CONSOLE_");
  });

  it("escapes the values it writes into attributes", () => {
    const html = renderIndex(TEMPLATE, { ...SETTINGS, clientId: 'x"><script>' });
    expect(html).toContain('content="x&quot;&gt;&lt;script&gt;"');
  });

  it("allows API calls only to the console API", () => {
    expect(contentSecurityPolicy("https://console-api.example.com/ignored")).toContain("connect-src 'self' https://console-api.example.com;");
    expect(renderIndex(TEMPLATE, SETTINGS)).toContain("script-src 'self';");
  });

  it("refuses a page the server could not place under its prefix", () => {
    expect(() => renderIndex(TEMPLATE.replace('<base href="/" />', ""), SETTINGS)).toThrow(/base href/);
  });

  it("refuses a page without a placeholder", () => {
    expect(() => renderIndex(TEMPLATE.replace("__CONSOLE_TIME_ZONE__", ""), SETTINGS)).toThrow(/__CONSOLE_TIME_ZONE__/);
  });
});

describe("buildUiBundle", () => {
  let dist: string;

  beforeEach(async () => {
    dist = await mkdtemp(path.join(tmpdir(), "console-ui-"));
    await mkdir(path.join(dist, "assets"));
    await writeFile(path.join(dist, "index.html"), TEMPLATE);
    await writeFile(path.join(dist, "assets", "index-abc.js"), "console.log('app')");
  });

  afterEach(async () => {
    await rm(dist, { recursive: true, force: true });
  });

  it("zips every file, with the settings in index.html", async () => {
    const bundle = await buildUiBundle(dist, SETTINGS);
    expect(bundle.fileName).toMatch(BUNDLE_FILE);
    expect(bundle.fileName).toBe(`console-${bundle.version}.zip`);
    const files = unzipSync(bundle.zip);
    expect(Object.keys(files).sort()).toEqual(["assets/index-abc.js", "index.html"]);
    expect(strFromU8(files["index.html"]!)).toContain('content="https://console-api.example.com"');
    expect(strFromU8(files["assets/index-abc.js"]!)).toBe("console.log('app')");
  });

  it("gives the same bundle the same version and bytes, and new settings a new version", async () => {
    const first = await buildUiBundle(dist, SETTINGS);
    const second = await buildUiBundle(dist, SETTINGS);
    expect(second.version).toBe(first.version);
    expect(Buffer.from(second.zip).equals(Buffer.from(first.zip))).toBe(true);
    const moved = await buildUiBundle(dist, { ...SETTINGS, apiUrl: "https://console-api-2.example.com" });
    expect(moved.version).not.toBe(first.version);
  });

  it("explains a missing build", async () => {
    await rm(path.join(dist, "index.html"));
    await expect(buildUiBundle(dist, SETTINGS)).rejects.toThrow(/npm run build:ui/);
  });
});
