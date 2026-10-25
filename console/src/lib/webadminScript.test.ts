import { zipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";
import { checkBundle, switchWebadmin } from "../../scripts/webadmin.mjs";

const SERVER = "https://mail.example.test";
const NEW = "https://releases.example.test/webui-new.zip";
const OLD = "https://github.com/stalwartlabs/webui/releases/download/v1.0.5/webui.zip";
const PAGE = '<!doctype html><html><head><base href="/" /><script type="module" src="./assets/index-new.js"></script></head><body><div id="root"></div></body></html>';

function zipOf(files: Record<string, string>): Uint8Array {
  return zipSync(Object.fromEntries(Object.entries(files).map(([name, text]) => [name, new TextEncoder().encode(text)])));
}

const GOOD = zipOf({ "index.html": PAGE, "assets/index-new.js": "console.log(1)" });

/** A server whose /admin serves whatever its record points at, once Update apps runs. */
function fakeServer({ updateWorks = true, servesNew = true } = {}) {
  const state = { resourceUrl: OLD, live: OLD, updates: 0 };
  const client = {
    call: vi.fn(async () => [
      ["x:Application/query", { ids: ["a1", "c1"] }, "q"],
      [
        "x:Application/get",
        {
          list: [
            { id: "a1", urlPrefix: { "/admin": true, "/account": true }, resourceUrl: state.resourceUrl, enabled: true },
            { id: "c1", urlPrefix: { "/console": true }, resourceUrl: "https://console.example.test/ui/console-1.zip", enabled: true },
          ],
        },
        "g",
      ],
    ]),
    one: vi.fn(async (name: string, args: Record<string, unknown>) => {
      if (name === "x:Application/set") {
        state.resourceUrl = (args.update as Record<string, { resourceUrl: string }>).a1!.resourceUrl;
        return { updated: { a1: null } };
      }
      if (name === "x:Action/set") {
        state.updates += 1;
        if (!updateWorks) return { notCreated: { u: { type: "serverFail" } } };
        state.live = state.resourceUrl;
        return { created: { u: { id: "x" } } };
      }
      throw new Error(`unexpected ${name}`);
    }),
  };
  const fetchImpl = vi.fn(async (url: string | URL | Request) => {
    const href = String(url);
    if (href === NEW) return new Response(GOOD as BodyInit);
    if (href === "https://releases.example.test/broken.zip") return new Response("not a zip");
    if (href === `${SERVER}/admin/`) {
      const servesBuild = state.live === NEW && servesNew;
      return new Response(servesBuild ? PAGE.replace('href="/"', 'href="/admin/"') : "<html>old</html>");
    }
    return new Response(null, { status: 404 });
  });
  return { client, fetchImpl, state };
}

describe("checkBundle", () => {
  it("accepts a web admin zip whose page and scripts are there", async () => {
    const { fetchImpl } = fakeServer();
    await expect(checkBundle(NEW, fetchImpl)).resolves.toEqual({ bytes: GOOD.length, scripts: ["assets/index-new.js"] });
  });

  it("refuses plain http, a broken zip, and a zip missing its scripts", async () => {
    const { fetchImpl } = fakeServer();
    await expect(checkBundle("http://releases.example.test/webui.zip", fetchImpl)).rejects.toThrow("https");
    await expect(checkBundle("https://releases.example.test/broken.zip", fetchImpl)).rejects.toThrow("not a zip");
    const missing = vi.fn(async () => new Response(zipOf({ "index.html": PAGE }) as BodyInit));
    await expect(checkBundle(NEW, missing)).rejects.toThrow("missing the scripts");
  });
});

describe("switchWebadmin", () => {
  it("switches, updates the apps, and waits until the server serves the new build", async () => {
    const { client, fetchImpl, state } = fakeServer();
    const result = await switchWebadmin(client, SERVER, NEW, { fetchImpl, timeoutMs: 1000, log: () => {} });
    expect(result).toEqual({ switched: true, previous: OLD });
    expect(state).toMatchObject({ resourceUrl: NEW, live: NEW, updates: 1 });
  });

  it("puts the previous build back when the server does not serve the new one", async () => {
    const { client, fetchImpl, state } = fakeServer({ servesNew: false });
    await expect(switchWebadmin(client, SERVER, NEW, { fetchImpl, timeoutMs: 10, log: () => {} })).rejects.toThrow(
      "the previous build was restored",
    );
    expect(state).toMatchObject({ resourceUrl: OLD, live: OLD, updates: 2 });
  });

  it("does not touch the server when the zip fails its check", async () => {
    const { client, fetchImpl, state } = fakeServer();
    await expect(switchWebadmin(client, SERVER, "https://releases.example.test/broken.zip", { fetchImpl, log: () => {} })).rejects.toThrow();
    expect(state.updates).toBe(0);
    expect(client.one).not.toHaveBeenCalled();
  });
});
