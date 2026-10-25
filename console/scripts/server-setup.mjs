#!/usr/bin/env node
// Creates or updates the console principal, its webhooks, the metrics push and the console's web
// application on an inWorkspace server. Idempotent; prints no secret. See console/README.md#server-setup.
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const eventTypes = JSON.parse(readFileSync(new URL("../src/lib/event-types.json", import.meta.url), "utf8"));
const traceEventTypes = JSON.parse(readFileSync(new URL("../src/lib/trace-event-types.json", import.meta.url), "utf8"));

/** What the ingest's app password may do: sign in and count the delivery queue, nothing else. */
const QUEUE_READER_PERMISSIONS = { "@type": "Replace", permissions: { authenticate: true, sysQueuedMessageQuery: true } };
const QUEUE_READER_DESCRIPTION = "inWorkspace Console ingest: counts the delivery queue";

const PRINCIPAL_PERMISSIONS = {
  "@type": "Merge",
  enabledPermissions: {
    impersonate: true,
    sysAccountGet: true,
    sysAccountQuery: true,
    sysDomainGet: true,
    sysDomainQuery: true,
    // Only for the queue reader's app password, which may hold no permission its account lacks.
    sysQueuedMessageQuery: true,
  },
  disabledPermissions: {},
};

export class RegistryClient {
  constructor(baseUrl, username, password) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  }

  async call(methodCalls) {
    const response = await fetch(`${this.baseUrl}/jmap/`, {
      method: "POST",
      headers: { Authorization: this.authorization, "Content-Type": "application/json" },
      body: JSON.stringify({ using: ["urn:ietf:params:jmap:core", "urn:stalwart:jmap"], methodCalls }),
    });
    if (!response.ok) throw new Error(`registry request failed with HTTP ${response.status}`);
    const body = await response.json();
    for (const [name, args] of body.methodResponses) {
      if (name === "error") throw new Error(`registry error ${args.type}${args.description ? `: ${args.description}` : ""}`);
    }
    return body.methodResponses;
  }

  async one(name, args) {
    const [[, result]] = await this.call([[name, args, "0"]]);
    return result;
  }

  /** The server's admin schema, which names every event type it knows. */
  async schema() {
    const response = await fetch(`${this.baseUrl}/api/schema`, { headers: { Authorization: this.authorization } });
    if (!response.ok) throw new Error(`the server's schema answered HTTP ${response.status}`);
    return response.json();
  }
}

function createdId(result, key, what) {
  if (result.notCreated?.[key]) throw new Error(`could not create ${what}: ${JSON.stringify(result.notCreated[key])}`);
  return result.created[key].id;
}

function assertUpdated(result, id, what) {
  if (result.notUpdated?.[id]) throw new Error(`could not update ${what}: ${JSON.stringify(result.notUpdated[id])}`);
}

export async function domainId(client, name) {
  const result = await client.one("x:Domain/query", { filter: { name: name.toLowerCase() } });
  return result.ids[0] ?? null;
}

export async function ensureAccount(client, { address, description, secret, permissions }) {
  const [local, domain] = address.toLowerCase().split("@");
  const id = await domainId(client, domain);
  if (!id) throw new Error(`the domain ${domain} does not exist on the server`);
  const responses = await client.call([
    ["x:Account/query", { filter: { domainId: id } }, "q"],
    ["x:Account/get", { "#ids": { resultOf: "q", name: "x:Account/query", path: "/ids" }, properties: ["name"] }, "g"],
  ]);
  const existing = responses[1][1].list.find((account) => account.name.toLowerCase() === local);
  const password = { "@type": "Password", secret };
  const fields = { description, ...(permissions ? { permissions } : {}) };
  if (existing) {
    // Only the password, the first credential, is set: the account's app passwords stay.
    const update = { ...fields, ...(secret ? { "credentials/0": password } : {}) };
    assertUpdated(await client.one("x:Account/set", { update: { [existing.id]: update } }), existing.id, address);
    return { id: existing.id, created: false };
  }
  const created = { "@type": "User", name: local, domainId: id, ...fields, ...(secret ? { credentials: { 0: password } } : {}) };
  const result = await client.one("x:Account/set", { create: { a: created } });
  return { id: createdId(result, "a", address), created: true };
}

export function ensurePrincipal(client, { address, secret }) {
  return ensureAccount(client, {
    address,
    secret,
    description: "inWorkspace Console (read-only oversight)",
    permissions: PRINCIPAL_PERMISSIONS,
  });
}

/** Whether an app password can count the queue: the one thing the ingest uses it for. */
export async function canCountQueue(serverUrl, login, appPassword) {
  const reader = new RegistryClient(serverUrl, login, appPassword);
  try {
    const result = await reader.one("x:QueuedMessage/query", { calculateTotal: true, limit: 1 });
    return typeof result.total === "number";
  } catch {
    return false;
  }
}

/**
 * The ingest's app password on the console principal: it may only sign in and count the delivery
 * queue. The server makes the secret and shows it once, so an account creates its own app
 * passwords: this signs in as the principal. `current` is the secret the ingest has now; when it
 * still works, nothing changes and the result is null. Otherwise the old app passwords are
 * removed, and the new secret is returned.
 */
export async function ensureQueueReader(serverUrl, { login, password, current }) {
  if (current && (await canCountQueue(serverUrl, login, current))) return null;
  const principal = new RegistryClient(serverUrl, login, password);
  const responses = await principal.call([
    ["x:AppPassword/query", {}, "q"],
    ["x:AppPassword/get", { "#ids": { resultOf: "q", name: "x:AppPassword/query", path: "/ids" }, properties: ["description"] }, "g"],
  ]);
  const stale = responses[1][1].list.filter((app) => app.description === QUEUE_READER_DESCRIPTION).map((app) => app.id);
  if (stale.length > 0) await principal.one("x:AppPassword/set", { destroy: stale });
  const result = await principal.one("x:AppPassword/set", {
    create: { r: { description: QUEUE_READER_DESCRIPTION, permissions: QUEUE_READER_PERMISSIONS } },
  });
  if (result.notCreated?.r) throw new Error(`could not create the queue reader's app password: ${JSON.stringify(result.notCreated.r)}`);
  const secret = result.created?.r?.secret;
  if (typeof secret !== "string" || !secret) throw new Error("the server did not return the new app password");
  return secret;
}

/** The event types the server knows; a list made from a newer server may name some it does not. */
export async function serverEventTypes(client) {
  const schema = await client.schema();
  const variants = schema?.enums?.EventType;
  if (!Array.isArray(variants) || variants.length === 0) throw new Error("the server's schema lists no event types");
  return new Set(variants.map((variant) => variant.name));
}

export async function ensureWebhook(client, { url, signingKey, events = eventTypes.subscribed }) {
  const responses = await client.call([
    ["x:WebHook/query", {}, "q"],
    ["x:WebHook/get", { "#ids": { resultOf: "q", name: "x:WebHook/query", path: "/ids" }, properties: ["url"] }, "g"],
  ]);
  const existing = responses[1][1].list.find((hook) => hook.url === url);
  const fields = {
    url,
    signatureKey: { "@type": "Value", secret: signingKey },
    enable: true,
    level: "info",
    lossy: false,
    eventsPolicy: "include",
    events: Object.fromEntries(events.map((type) => [type, true])),
    throttle: 1000,
    timeout: 30000,
    discardAfter: 3600000,
  };
  if (existing) {
    assertUpdated(await client.one("x:WebHook/set", { update: { [existing.id]: fields } }), existing.id, "the webhook");
    return { id: existing.id, created: false };
  }
  const result = await client.one("x:WebHook/set", { create: { w: fields } });
  return { id: createdId(result, "w", "the webhook"), created: true };
}

/**
 * The webhook for the web admin's Live Tracing and History: the events of trace-event-types.json
 * that this server knows.
 */
export async function ensureTracingWebhook(client, { url, signingKey }) {
  const known = await serverEventTypes(client);
  const events = traceEventTypes.events.filter((type) => known.has(type));
  const webhook = await ensureWebhook(client, { url, signingKey, events });
  return { ...webhook, events: events.length, unknown: traceEventTypes.events.length - events.length };
}

/**
 * Makes the server push its metrics (OpenTelemetry over HTTP) to the console every `intervalMs`.
 * Only the push is set; the Prometheus endpoint and the choice of metrics stay as they are.
 */
export async function ensureMetricsPush(client, { endpoint, token, intervalMs = 60_000 }) {
  const result = await client.one("x:Metrics/set", {
    update: {
      singleton: {
        openTelemetry: {
          "@type": "Http",
          endpoint,
          interval: intervalMs,
          timeout: 10_000,
          httpAuth: { "@type": "Bearer", bearerToken: { "@type": "Value", secret: token } },
          httpHeaders: {},
        },
      },
    },
  });
  assertUpdated(result, "singleton", "the metrics push");
}

/** Paths the server or its web admin already use. */
const RESERVED_PREFIXES = new Set([
  ".well-known", "account", "admin", "api", "auth", "authorize", "autoconfig", "autodiscover",
  "calendar", "card", "dav", "device", "form", "healthz", "jmap", "login", "logo", "mail",
  "metrics", "mta-sts.txt", "oauth", "robots.txt",
]);

/** "/console/" → "console"; refuses a prefix the server or its web admin use. */
export function appPrefix(value) {
  const prefix = value.trim().replace(/^\/+|\/+$/g, "").toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(prefix) || RESERVED_PREFIXES.has(prefix)) {
    throw new Error(`${value} cannot be the console's path`);
  }
  return prefix;
}

/** A public client (no secret) whose only redirect URI is the console's callback. */
export async function ensureOAuthClient(client, { clientId, redirectUri, description }) {
  const responses = await client.call([
    ["x:OAuthClient/query", {}, "q"],
    ["x:OAuthClient/get", { "#ids": { resultOf: "q", name: "x:OAuthClient/query", path: "/ids" }, properties: ["clientId"] }, "g"],
  ]);
  const existing = responses[1][1].list.find((candidate) => candidate.clientId === clientId);
  const fields = { clientId, description, redirectUris: { [redirectUri]: true } };
  if (existing) {
    assertUpdated(await client.one("x:OAuthClient/set", { update: { [existing.id]: fields } }), existing.id, "the OAuth client");
    return { id: existing.id, created: false };
  }
  const result = await client.one("x:OAuthClient/set", { create: { c: fields } });
  return { id: createdId(result, "c", "the OAuth client"), created: true };
}

/** The bundle the console's api role serves now. */
export async function consoleBundle(consoleUrl) {
  const response = await fetch(`${consoleUrl.replace(/\/+$/, "")}/ui/manifest`);
  if (!response.ok) throw new Error(`the console's /ui/manifest answered HTTP ${response.status}`);
  const manifest = await response.json();
  if (typeof manifest.file !== "string" || !/^console-[A-Za-z0-9_-]{1,64}\.zip$/.test(manifest.file)) {
    throw new Error("the console's /ui/manifest names no bundle");
  }
  return manifest;
}

function prefixesOf(app) {
  return Object.keys(app.urlPrefix ?? {}).map((value) => value.trim().replace(/^\/+|\/+$/g, "").toLowerCase());
}

/**
 * Serves the bundle at /<prefix>. The server keeps one downloaded bundle per application record, so
 * a new bundle gets a new record: created first, then the old one is deleted. Only records that
 * serve nothing but this prefix are ever touched.
 */
export async function ensureApplication(client, { prefix, resourceUrl, description = "inWorkspace Console" }) {
  const path = appPrefix(prefix);
  const responses = await client.call([
    ["x:Application/query", {}, "q"],
    [
      "x:Application/get",
      { "#ids": { resultOf: "q", name: "x:Application/query", path: "/ids" }, properties: ["urlPrefix", "resourceUrl", "enabled"] },
      "g",
    ],
  ]);
  const mine = responses[1][1].list.filter((app) => prefixesOf(app).includes(path));
  if (mine.some((app) => prefixesOf(app).some((other) => other !== path))) {
    throw new Error(`another web application also serves /${path}; remove /${path} from it first`);
  }
  if (mine.length === 1 && mine[0].resourceUrl === resourceUrl && mine[0].enabled) {
    return { id: mine[0].id, created: false, removed: 0 };
  }
  const result = await client.one("x:Application/set", {
    create: { a: { description, urlPrefix: { [`/${path}`]: true }, resourceUrl, enabled: true } },
  });
  const id = createdId(result, "a", "the web application");
  if (mine.length > 0) {
    const destroyed = await client.one("x:Application/set", { destroy: mine.map((app) => app.id) });
    if (destroyed.notDestroyed && Object.keys(destroyed.notDestroyed).length > 0) {
      throw new Error(`could not remove the previous web application: ${JSON.stringify(destroyed.notDestroyed)}`);
    }
  }
  return { id, created: true, removed: mine.length };
}

/**
 * The server loads web applications when it starts and on this action, not when a record is
 * written. The action first deletes every application's downloaded copy, the web admin's included,
 * then downloads each again from its resourceUrl: one that fails to download stays offline until
 * a later update or restart succeeds. A restart downloads only applications it has no copy of.
 */
export async function updateApps(client) {
  try {
    const result = await client.one("x:Action/set", { create: { u: { "@type": "UpdateApps" } } });
    if (result.notCreated?.u) return { updated: false, reason: JSON.stringify(result.notCreated.u) };
    return { updated: true };
  } catch (error) {
    return { updated: false, reason: error.message };
  }
}

/** Some server versions refuse to reload because of an unrelated default setting; the webhook then activates on restart. */
export async function reloadSettings(client) {
  try {
    const result = await client.one("x:Action/set", { create: { r: { "@type": "ReloadSettings" } } });
    if (result.notCreated?.r) return { reloaded: false, reason: JSON.stringify(result.notCreated.r) };
    return { reloaded: true };
  } catch (error) {
    return { reloaded: false, reason: error.message };
  }
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main() {
  const serverUrl = required("SERVER_URL").replace(/\/+$/, "");
  const client = new RegistryClient(serverUrl, required("SERVER_ADMIN_USER"), required("SERVER_ADMIN_SECRET"));
  const principalLogin = required("CONSOLE_PRINCIPAL");
  const principalSecret = required("CONSOLE_PRINCIPAL_SECRET");
  const principal = await ensurePrincipal(client, { address: principalLogin, secret: principalSecret });
  console.log(`console principal ${principal.created ? "created" : "updated"} (id ${principal.id})`);

  // The ingest's queue reader: a new secret is written to this file (only readable by you), never printed.
  const secretFile = process.env.QUEUE_READER_SECRET_FILE?.trim();
  if (secretFile) {
    const fresh = await ensureQueueReader(serverUrl, {
      login: principalLogin,
      password: principalSecret,
      current: process.env.QUEUE_READER_SECRET?.trim() || undefined,
    });
    if (fresh) {
      writeFileSync(secretFile, fresh, { mode: 0o600 });
      console.log(`queue reader: a new app password is in ${secretFile}; give it to the ingest as QUEUE_READER_SECRET, then delete the file`);
    } else {
      console.log("queue reader: the ingest's app password still works");
    }
  }
  const signingKey = required("WEBHOOK_SIGNING_KEY");
  const webhook = await ensureWebhook(client, { url: required("WEBHOOK_URL"), signingKey });
  console.log(`webhook ${webhook.created ? "created" : "updated"} (id ${webhook.id}, ${eventTypes.subscribed.length} event types)`);

  // The web admin's Dashboard, Live Tracing and History (see webadmin/README.md).
  const tracingUrl = process.env.TRACING_WEBHOOK_URL?.trim();
  if (tracingUrl) {
    const tracing = await ensureTracingWebhook(client, { url: tracingUrl, signingKey });
    console.log(
      `tracing webhook ${tracing.created ? "created" : "updated"} (id ${tracing.id}, ${tracing.events} event types` +
        `${tracing.unknown ? `; ${tracing.unknown} this server does not know` : ""})`,
    );
  }
  const metricsUrl = process.env.METRICS_PUSH_URL?.trim();
  if (metricsUrl) {
    await ensureMetricsPush(client, { endpoint: metricsUrl, token: required("METRICS_PUSH_TOKEN") });
    console.log(`metrics push set to ${metricsUrl}, every minute`);
  }

  const path = appPrefix(process.env.CONSOLE_PATH ?? "console");
  const clientId = process.env.OAUTH_CLIENT_ID?.trim() || "inworkspace-console";
  const redirectUri = `${serverUrl}/${path}/oauth/callback`;
  const oauthClient = await ensureOAuthClient(client, { clientId, redirectUri, description: "inWorkspace Console" });
  console.log(`OAuth client ${clientId} ${oauthClient.created ? "created" : "updated"} (redirect ${redirectUri})`);

  const consoleUrl = required("CONSOLE_URL");
  const manifest = await consoleBundle(consoleUrl);
  const fetchBase = (process.env.CONSOLE_FETCH_URL?.trim() || consoleUrl).replace(/\/+$/, "");
  if (!fetchBase.startsWith("https://")) {
    console.log(`warning: the server downloads the shell over plain http from ${fetchBase}; anyone on that path could replace it`);
  }
  const app = await ensureApplication(client, { prefix: path, resourceUrl: `${fetchBase}/ui/${manifest.file}` });
  console.log(
    app.created
      ? `web application /${path} registered for shell ${manifest.version}${app.removed ? ` (${app.removed} previous record removed)` : ""}`
      : `web application /${path} already registered for shell ${manifest.version}`,
  );
  if (app.created) {
    if (process.env.UPDATE_APPS === "1") {
      const update = await updateApps(client);
      console.log(update.updated ? "web applications updated: /" + path + " is live" : `updating web applications failed (${update.reason})`);
    } else {
      console.log(
        "the server loads it when it starts: restart the server to make it live. " +
          '"Update apps" (UPDATE_APPS=1) avoids the restart, but it downloads every application again, the web admin included, ' +
          "from its resourceUrl: check that URL first, and know that a failed download leaves that application offline until a retry succeeds",
      );
    }
  }

  const reload = await reloadSettings(client);
  console.log(reload.reloaded ? "settings reloaded" : `settings not reloaded (${reload.reason}); restart the server to activate the webhook`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
