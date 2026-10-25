import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { strFromU8, unzipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ASSET_FILE, SHELL_FILE, buildUiShell, contentSecurityPolicy, entryModule, loadUiApp, shellPage } from "./uiBundle";

const SETTINGS = { apiUrl: "https://console-api.example.com", clientId: "inworkspace-console", timeZone: "Europe/Zurich" };

const MANIFEST = {
  "index.html": { file: "assets/index-abc.js", src: "index.html", isEntry: true, css: ["assets/index-def.css"] },
};

describe("shellPage", () => {
  it("writes the settings into the page", () => {
    const html = shellPage(SETTINGS);
    expect(html).toContain('<meta name="inworkspace-console-api" content="https://console-api.example.com" />');
    expect(html).toContain('<meta name="inworkspace-console-client-id" content="inworkspace-console" />');
    expect(html).toContain('<meta name="inworkspace-console-time-zone" content="Europe/Zurich" />');
  });

  it("carries the base tag the server rewrites to the app's prefix", () => {
    expect(shellPage(SETTINGS)).toContain('<base href="/" />');
  });

  it("loads the app from the console API", () => {
    expect(shellPage(SETTINGS)).toContain('<script type="module" src="https://console-api.example.com/ui/app/entry.js"></script>');
  });

  it("escapes the values it writes into attributes", () => {
    expect(shellPage({ ...SETTINGS, clientId: 'x"><script>' })).toContain('content="x&quot;&gt;&lt;script&gt;"');
  });
});

describe("contentSecurityPolicy", () => {
  it("allows scripts and styles only from the console API, and calls only to it and the page's origin", () => {
    const policy = contentSecurityPolicy("https://console-api.example.com");
    expect(policy).toContain("script-src https://console-api.example.com;");
    expect(policy).toContain("style-src https://console-api.example.com 'unsafe-inline';");
    expect(policy).toContain("connect-src 'self' https://console-api.example.com;");
    expect(policy).toContain("object-src 'none'");
  });
});

describe("entryModule", () => {
  it("adds the stylesheets, waits for them, then imports the entry, all relative to itself", () => {
    const source = entryModule(MANIFEST["index.html"]);
    expect(source).toContain('const base = new URL("./", import.meta.url);');
    expect(source).toContain('["assets/index-def.css"]');
    expect(source).toContain('await import(new URL("assets/index-abc.js", base).href);');
  });
});

describe("with a built web app", () => {
  let dist: string;

  beforeEach(async () => {
    dist = await mkdtemp(path.join(tmpdir(), "console-ui-"));
    await mkdir(path.join(dist, "assets"));
    await mkdir(path.join(dist, ".vite"));
    await writeFile(path.join(dist, ".vite", "manifest.json"), JSON.stringify(MANIFEST));
    await writeFile(path.join(dist, "assets", "index-abc.js"), "console.log('app')");
    await writeFile(path.join(dist, "assets", "index-def.css"), "body{}");
    await writeFile(path.join(dist, "favicon.ico"), "icon");
  });

  afterEach(async () => {
    await rm(dist, { recursive: true, force: true });
  });

  describe("buildUiShell", () => {
    it("zips the page and the icon, and nothing of the app's code", async () => {
      const shell = await buildUiShell(dist, SETTINGS);
      expect(shell.fileName).toMatch(SHELL_FILE);
      expect(shell.fileName).toBe(`console-${shell.version}.zip`);
      const files = unzipSync(shell.zip);
      expect(Object.keys(files).sort()).toEqual(["favicon.ico", "index.html"]);
      expect(strFromU8(files["index.html"]!)).toBe(shellPage(SETTINGS));
    });

    it("keeps its version when only the app's code changes, so the server needs nothing new", async () => {
      const before = await buildUiShell(dist, SETTINGS);
      await writeFile(path.join(dist, "assets", "index-abc.js"), "console.log('app, version 2')");
      const after = await buildUiShell(dist, SETTINGS);
      expect(after.version).toBe(before.version);
      expect(Buffer.from(after.zip).equals(Buffer.from(before.zip))).toBe(true);
    });

    it("gets a new version when the settings change", async () => {
      const before = await buildUiShell(dist, SETTINGS);
      const moved = await buildUiShell(dist, { ...SETTINGS, apiUrl: "https://console-api-2.example.com" });
      expect(moved.version).not.toBe(before.version);
    });
  });

  describe("loadUiApp", () => {
    it("generates the entry module and serves the built assets with their types", async () => {
      const app = await loadUiApp(dist);
      expect(app.entry).toContain('await import(new URL("assets/index-abc.js", base).href);');
      expect(app.assets.get("index-abc.js")?.type).toBe("text/javascript; charset=utf-8");
      expect(app.assets.get("index-def.css")?.type).toBe("text/css; charset=utf-8");
      expect(Buffer.from(app.assets.get("index-abc.js")!.content).toString()).toBe("console.log('app')");
    });

    it("refuses a manifest that names a file the build does not have", async () => {
      await rm(path.join(dist, "assets", "index-def.css"));
      await expect(loadUiApp(dist)).rejects.toThrow(/index-def\.css/);
    });

    it("explains a missing build", async () => {
      await rm(path.join(dist, ".vite"), { recursive: true });
      await expect(loadUiApp(dist)).rejects.toThrow(/npm run build:ui/);
    });
  });
});

describe("ASSET_FILE", () => {
  it("accepts built file names and nothing that leaves the directory", () => {
    expect(ASSET_FILE.test("index-CUlKN-9x.js")).toBe(true);
    for (const name of ["../secret", ".hidden", "a/b.js", "", "x".repeat(200)]) expect(ASSET_FILE.test(name)).toBe(false);
  });
});
