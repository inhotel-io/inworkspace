#!/usr/bin/env node
// Creates or updates the console principal and the event webhook on an inWorkspace server.
// Idempotent; prints no secret. See console/README.md#server-setup.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const eventTypes = JSON.parse(readFileSync(new URL("../src/lib/event-types.json", import.meta.url), "utf8"));

const PRINCIPAL_PERMISSIONS = {
  "@type": "Merge",
  enabledPermissions: { impersonate: true, sysAccountGet: true, sysAccountQuery: true, sysDomainGet: true, sysDomainQuery: true },
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
  const fields = {
    description,
    ...(secret ? { credentials: { 0: { "@type": "Password", secret } } } : {}),
    ...(permissions ? { permissions } : {}),
  };
  if (existing) {
    assertUpdated(await client.one("x:Account/set", { update: { [existing.id]: fields } }), existing.id, address);
    return { id: existing.id, created: false };
  }
  const result = await client.one("x:Account/set", { create: { a: { "@type": "User", name: local, domainId: id, ...fields } } });
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

export async function ensureWebhook(client, { url, signingKey }) {
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
    events: Object.fromEntries(eventTypes.subscribed.map((type) => [type, true])),
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

/** Paths the server or its web admin already use. */
const RESERVED_PREFIXES = new Set([
  ".well-known", "account", "admin", "api", "auth", "authorize", "calendar", "card", "dav",
  "device", "healthz", "jmap", "login", "metrics", "mta-sts.txt", "oauth", "robots.txt",
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
  const principal = await ensurePrincipal(client, {
    address: required("CONSOLE_PRINCIPAL"),
    secret: required("CONSOLE_PRINCIPAL_SECRET"),
  });
  console.log(`console principal ${principal.created ? "created" : "updated"} (id ${principal.id})`);
  const webhook = await ensureWebhook(client, { url: required("WEBHOOK_URL"), signingKey: required("WEBHOOK_SIGNING_KEY") });
  console.log(`webhook ${webhook.created ? "created" : "updated"} (id ${webhook.id}, ${eventTypes.subscribed.length} event types)`);

  const path = appPrefix(process.env.CONSOLE_PATH ?? "console");
  const clientId = process.env.OAUTH_CLIENT_ID?.trim() || "inworkspace-console";
  const redirectUri = `${serverUrl}/${path}/oauth/callback`;
  const oauthClient = await ensureOAuthClient(client, { clientId, redirectUri, description: "inWorkspace Console" });
  console.log(`OAuth client ${clientId} ${oauthClient.created ? "created" : "updated"} (redirect ${redirectUri})`);

  const consoleUrl = required("CONSOLE_URL");
  const manifest = await consoleBundle(consoleUrl);
  const fetchBase = (process.env.CONSOLE_FETCH_URL?.trim() || consoleUrl).replace(/\/+$/, "");
  const app = await ensureApplication(client, { prefix: path, resourceUrl: `${fetchBase}/ui/${manifest.file}` });
  console.log(
    app.created
      ? `web application /${path} now serves bundle ${manifest.version}${app.removed ? ` (${app.removed} previous record removed)` : ""}`
      : `web application /${path} already serves bundle ${manifest.version}`,
  );

  const reload = await reloadSettings(client);
  console.log(reload.reloaded ? "settings reloaded" : `settings not reloaded (${reload.reason}); restart the server to activate the webhook`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
