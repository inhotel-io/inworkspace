#!/usr/bin/env node
// Points the server's web admin at another build of the web UI, or back at upstream's, safely:
// the new zip is checked before the switch, and if the server does not then serve it, the previous
// one is put back. Prints no secret.
//
//   SERVER_URL=… SERVER_ADMIN_USER=… SERVER_ADMIN_SECRET=… node scripts/webadmin.mjs show
//   … node scripts/webadmin.mjs use <zip-url>
//   … node scripts/webadmin.mjs restore [<zip-url>]   (default: upstream web UI v1.0.5)
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { unzipSync } from "fflate";
import { RegistryClient, updateApps } from "./server-setup.mjs";

export const UPSTREAM_WEBADMIN = "https://github.com/stalwartlabs/webui/releases/download/v1.0.5/webui.zip";
const WEBADMIN_PREFIX = "/admin";

/** The application record that serves the web admin. */
export async function webadminApplication(client) {
  const responses = await client.call([
    ["x:Application/query", {}, "q"],
    ["x:Application/get", { "#ids": { resultOf: "q", name: "x:Application/query", path: "/ids" }, properties: ["urlPrefix", "resourceUrl", "enabled"] }, "g"],
  ]);
  const apps = responses[1][1].list.filter((app) =>
    Object.keys(app.urlPrefix ?? {}).some((prefix) => prefix.trim().replace(/\/+$/, "").toLowerCase() === WEBADMIN_PREFIX),
  );
  if (apps.length !== 1) throw new Error(`expected one web application at ${WEBADMIN_PREFIX}, found ${apps.length}`);
  return apps[0];
}

/** Downloads a zip and checks that it is a web admin build: its page and the scripts it loads. */
export async function checkBundle(url, fetchImpl = fetch, { requireHttps = true } = {}) {
  if (requireHttps && !/^https:\/\//.test(url)) throw new Error("the web admin must be downloaded over https");
  const response = await fetchImpl(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  let files;
  try {
    files = unzipSync(bytes);
  } catch {
    throw new Error(`${url} is not a zip`);
  }
  const page = files["index.html"] ? new TextDecoder().decode(files["index.html"]) : "";
  if (!page.includes('<base href="/"') || !page.includes('id="root"')) throw new Error(`${url} has no web admin page`);
  const scripts = [...page.matchAll(/src="\.?\/?(assets\/[^"]+\.js)"/g)].map((match) => match[1]);
  if (scripts.length === 0 || scripts.some((script) => !files[script])) throw new Error(`${url} is missing the scripts its page loads`);
  return { bytes: bytes.length, scripts };
}

/** Whether the server now serves the build whose page loads these scripts. */
async function serving(serverUrl, scripts, fetchImpl) {
  const response = await fetchImpl(`${serverUrl}${WEBADMIN_PREFIX}/`, { cache: "no-store" });
  if (!response.ok) return false;
  const page = await response.text();
  return scripts.every((script) => page.includes(script));
}

async function waitForServing(serverUrl, scripts, fetchImpl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await serving(serverUrl, scripts, fetchImpl).catch(() => false)) return true;
    await sleep(2000);
  }
  return false;
}

async function setResourceUrl(client, app, resourceUrl) {
  const result = await client.one("x:Application/set", { update: { [app.id]: { resourceUrl } } });
  if (result.notUpdated?.[app.id]) throw new Error(`could not update the web admin record: ${JSON.stringify(result.notUpdated[app.id])}`);
}

/**
 * Switches the web admin to `url`. Update apps downloads every web application again; when the
 * server does not serve the new build within the timeout, the previous URL is restored.
 */
export async function switchWebadmin(
  client,
  serverUrl,
  url,
  { fetchImpl = fetch, timeoutMs = 120_000, requireHttps = true, checkUrl = url, log = console.log } = {},
) {
  // checkUrl: where this machine downloads the same zip, when the server reaches it by another name.
  const bundle = await checkBundle(checkUrl, fetchImpl, { requireHttps });
  log(`checked ${url}: ${bundle.bytes} bytes, page and scripts present`);
  const app = await webadminApplication(client);
  const previous = app.resourceUrl;
  if (previous === url && (await serving(serverUrl, bundle.scripts, fetchImpl).catch(() => false))) {
    log("the web admin already serves this build");
    return { switched: false, previous };
  }
  await setResourceUrl(client, app, url);
  const update = await updateApps(client);
  if (update.updated && (await waitForServing(serverUrl, bundle.scripts, fetchImpl, timeoutMs))) {
    log(`the web admin now serves ${url} (previously ${previous})`);
    return { switched: true, previous };
  }
  log(`the server did not serve the new build (${update.updated ? "timed out" : update.reason}); restoring ${previous}`);
  await setResourceUrl(client, app, previous);
  const restored = await updateApps(client);
  throw new Error(`switching the web admin failed; ${restored.updated ? "the previous build was restored" : `restoring it also failed: ${restored.reason}`}`);
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main() {
  const [command, url] = process.argv.slice(2);
  const serverUrl = required("SERVER_URL").replace(/\/+$/, "");
  const client = new RegistryClient(serverUrl, required("SERVER_ADMIN_USER"), required("SERVER_ADMIN_SECRET"));
  switch (command) {
    case "show": {
      const app = await webadminApplication(client);
      console.log(`${WEBADMIN_PREFIX}: ${app.resourceUrl}${app.enabled ? "" : " (disabled)"}`);
      return;
    }
    case "use":
      if (!url) throw new Error("usage: webadmin.mjs use <zip-url>");
      await switchWebadmin(client, serverUrl, url);
      return;
    case "restore":
      await switchWebadmin(client, serverUrl, url ?? UPSTREAM_WEBADMIN);
      return;
    default:
      throw new Error("usage: webadmin.mjs show | use <zip-url> | restore [<zip-url>]");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
