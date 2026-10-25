#!/usr/bin/env node
// End-to-end run: a real inWorkspace server and Postgres in Docker, the console built from this
// directory, real mail over SMTP, an agent reply over JMAP, and sign-in through the server's own
// OAuth endpoints. Run `npm run build` first. `node e2e/run.mjs --keep` leaves everything running.
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { cpSync, existsSync, rmSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import pg from "pg";
import {
  RegistryClient,
  consoleBundle,
  ensureAccount,
  ensureApplication,
  ensureOAuthClient,
  ensurePrincipal,
  ensureWebhook,
  reloadSettings,
  updateApps,
} from "../scripts/server-setup.mjs";
import { sendMail } from "./smtp.mjs";

const keep = process.argv.includes("--keep");
const root = new URL("..", import.meta.url).pathname;
const compose = ["compose", "-f", new URL("./compose.yaml", import.meta.url).pathname];
const SERVER = "http://localhost:18080";
const PORT = 3100;
const CONSOLE = `http://localhost:${PORT}`;
/** How the mail server, inside Docker, reaches the console on this machine. */
const CONSOLE_FROM_SERVER = `http://host.docker.internal:${PORT}`;
const DATABASE_URL = "postgres://console:console@localhost:15432/console";
const DOMAIN = "agents.example.test";
const AGENT = `a21i3v9v@${DOMAIN}`;
const GUEST = "jane@example.com";
const CLIENT_ID = "inworkspace-console";
const REDIRECT_URI = `${SERVER}/console/oauth/callback`;
const secret = () => randomBytes(24).toString("hex");
const adminSecret = secret();
const principalSecret = secret();
const runtimeSecret = secret();
const viewerSecret = secret();
const signingKey = secret();

function docker(args, env = {}) {
  execFileSync("docker", [...compose, ...args], { stdio: "inherit", env: { ...process.env, E2E_ADMIN_SECRET: adminSecret, ...env } });
}

async function waitFor(what, check, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const value = await check();
      if (value) return value;
    } catch {
      // not ready yet
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(1000);
  }
}

function step(message) {
  console.log(`\n▸ ${message}`);
}

function expect(condition, what) {
  if (!condition) throw new Error(`expected: ${what}`);
  console.log(`  ✓ ${what}`);
}

function basic(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

async function jmapAs(username, password, using, methodCalls) {
  const response = await fetch(`${SERVER}/jmap/`, {
    method: "POST",
    headers: { Authorization: basic(username, password), "Content-Type": "application/json" },
    body: JSON.stringify({ using, methodCalls }),
  });
  if (!response.ok) throw new Error(`JMAP HTTP ${response.status}`);
  return (await response.json()).methodResponses;
}

/** What the web app does, without the browser: the server's sign-in API, then its token endpoint. */
async function signIn(accountName, accountSecret) {
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(16).toString("base64url");
  const login = await fetch(`${SERVER}/api/auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "authCode",
      accountName,
      accountSecret,
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      scope: "openid offline_access",
      codeChallenge: createHash("sha256").update(verifier).digest("base64url"),
      codeChallengeMethod: "S256",
      state,
    }),
  });
  const answer = await login.json().catch(() => ({}));
  if (!login.ok || answer.type !== "authenticated") throw new Error(`signing in as ${accountName} failed: ${JSON.stringify(answer)}`);
  const exchange = await fetch(`${SERVER}/auth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code: answer.client_code, redirect_uri: REDIRECT_URI, client_id: CLIENT_ID, code_verifier: verifier }),
  });
  const tokens = await exchange.json().catch(() => ({}));
  if (!exchange.ok || typeof tokens.access_token !== "string") throw new Error(`the token exchange for ${accountName} failed: ${JSON.stringify(tokens)}`);
  return tokens;
}

function api(path, { token, origin = SERVER, method = "GET", headers = {} } = {}) {
  return fetch(`${CONSOLE}/api/v1/${path}`, {
    method,
    headers: { Origin: origin, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
  });
}

async function apiJson(path, token) {
  const response = await api(path, { token });
  const body = await response.json();
  if (!response.ok) throw new Error(`GET /api/v1/${path} answered ${response.status}: ${JSON.stringify(body)}`);
  return { response, body };
}

let consoleProcess;
try {
  step("Starting a fresh inWorkspace server and Postgres");
  docker(["down", "-v", "--remove-orphans"]);
  docker(["up", "-d"]);
  await waitFor("the mail server", async () => (await fetch(`${SERVER}/healthz/live`)).ok);
  const admin = new RegistryClient(SERVER, "admin", adminSecret);

  step("Creating the agent domain, two agents, an agent runtime, a plain user, the console principal and the webhook");
  await admin.one("x:Domain/set", { create: { d: { name: DOMAIN } } });
  await ensureAccount(admin, { address: AGENT, description: "Front desk agent" });
  await ensureAccount(admin, { address: `a000001e@${DOMAIN}`, description: "Concierge agent" });
  await ensureAccount(admin, {
    address: `runtime@${DOMAIN}`,
    description: "Agent runtime",
    secret: runtimeSecret,
    permissions: { "@type": "Merge", enabledPermissions: { impersonate: true }, disabledPermissions: {} },
  });
  await ensureAccount(admin, { address: `viewer@${DOMAIN}`, description: "Plain user", secret: viewerSecret });
  await ensurePrincipal(admin, { address: `console@${DOMAIN}`, secret: principalSecret });
  await ensureWebhook(admin, { url: `${CONSOLE_FROM_SERVER}/api/ingest/events`, signingKey });
  const reload = await reloadSettings(admin);
  if (!reload.reloaded) {
    console.log(`  settings reload refused (${reload.reason.slice(0, 120)}…); restarting the server`);
    docker(["restart", "stalwart"]);
    await waitFor("the mail server after restart", async () => (await fetch(`${SERVER}/healthz/live`)).ok);
  }

  step("Starting the console (api and ingest roles in one process)");
  if (!existsSync(`${root}.next/standalone/server.js`) || !existsSync(`${root}ui-dist/index.html`)) throw new Error("run `npm run build` first");
  cpSync(`${root}.next/static`, `${root}.next/standalone/.next/static`, { recursive: true });
  rmSync(`${root}.next/standalone/ui-dist`, { recursive: true, force: true });
  cpSync(`${root}ui-dist`, `${root}.next/standalone/ui-dist`, { recursive: true });
  consoleProcess = spawn("node", [`${root}.next/standalone/server.js`], {
    stdio: ["ignore", "inherit", "inherit"],
    env: {
      ...process.env,
      PORT: String(PORT),
      HOSTNAME: "0.0.0.0",
      CONSOLE_ROLE: "all",
      DATABASE_URL,
      WEBHOOK_SIGNING_KEY: signingKey,
      JMAP_URL: SERVER,
      JMAP_PRINCIPAL: `console@${DOMAIN}`,
      JMAP_PRINCIPAL_SECRET: principalSecret,
      AGENT_DOMAINS: DOMAIN,
      AGENT_LOCALPART_PATTERN: "a[0-9a-z]{7}",
      PUBLIC_URL: CONSOLE,
    },
  });
  await waitFor("the console", async () => (await fetch(`${CONSOLE}/healthz`)).ok);

  step("Registering the OAuth client and the web application at the server");
  await ensureOAuthClient(admin, { clientId: CLIENT_ID, redirectUri: REDIRECT_URI, description: "inWorkspace Console" });
  const manifest = await consoleBundle(CONSOLE);
  const resourceUrl = `${CONSOLE_FROM_SERVER}/ui/${manifest.file}`;
  const app = await ensureApplication(admin, { prefix: "/console/", resourceUrl });
  expect(app.created, `a web application record for shell ${manifest.version} was created`);
  const notYet = await fetch(`${SERVER}/console/`);
  expect(notYet.status === 404, "the server does not load a new record by itself");
  const update = await updateApps(admin);
  expect(update.updated, "Update apps loads it");
  const page = await waitFor("the server to serve the shell", async () => {
    const response = await fetch(`${SERVER}/console/`);
    const html = await response.text();
    return response.ok && html.includes('name="inworkspace-console-api"') ? html : null;
  });
  expect(page.includes('<base href="/console/"'), "the server serves the shell at /console, with its base path");
  expect(page.includes(`<script type="module" src="${CONSOLE}/ui/app/entry.js">`), "the shell loads the app from the console API");
  const entry = await fetch(`${CONSOLE}/ui/app/entry.js`, { headers: { Origin: SERVER } });
  const entrySource = await entry.text();
  expect(
    entry.ok && entry.headers.get("content-type")?.startsWith("text/javascript") && entry.headers.get("access-control-allow-origin") === SERVER,
    "the entry module is JavaScript that the server's origin may load",
  );
  const script = /import\(new URL\("assets\/([^"]+\.js)"/.exec(entrySource)?.[1];
  const asset = script ? await fetch(`${CONSOLE}/ui/app/assets/${script}`, { headers: { Origin: SERVER } }) : null;
  expect(
    asset?.ok && asset.headers.get("content-type")?.startsWith("text/javascript") && asset.headers.get("cache-control")?.includes("immutable"),
    "the app's script is served, cached for good",
  );
  const deepLink = await fetch(`${SERVER}/console/oauth/callback?code=x&state=y`);
  expect(deepLink.ok && (await deepLink.text()).includes('name="inworkspace-console-api"'), "the server serves the shell on the callback path");
  const again = await ensureApplication(admin, { prefix: "console", resourceUrl });
  expect(!again.created, "registering the same shell again changes nothing");

  step("Sending a guest message, a message to a mailbox that does not exist, and an agent reply");
  const inbound = await sendMail({
    host: "localhost",
    port: 12525,
    from: GUEST,
    to: AGENT,
    data: [
      `From: Jane Guest <${GUEST}>`,
      `To: ${AGENT}`,
      "Subject: Late check-in on Friday?",
      "Message-ID: <e2e-1@example.com>",
      `Date: ${new Date().toUTCString()}`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Hi, can I check in at 11pm on Friday? Thanks, Jane",
    ].join("\n"),
  });
  if (!inbound.accepted) throw new Error(`the guest message was refused: ${inbound.reply}`);
  const refused = await sendMail({ host: "localhost", port: 12525, from: GUEST, to: `ghost@${DOMAIN}`, data: "Subject: hello\n\nanyone?" });
  if (refused.accepted) throw new Error("mail to a missing mailbox was accepted");

  const runtimeLogin = `${AGENT}%runtime@${DOMAIN}`;
  const mailUsing = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail", "urn:ietf:params:jmap:submission"];
  const session = await (await fetch(`${SERVER}/jmap/session`, { headers: { Authorization: basic(runtimeLogin, runtimeSecret) } })).json();
  const accountId = session.primaryAccounts["urn:ietf:params:jmap:mail"];
  const inboundEmail = await waitFor("the guest message in the mailbox", async () => {
    const [[, mailboxes], , [, emails], [, identities]] = await jmapAs(runtimeLogin, runtimeSecret, mailUsing, [
      ["Mailbox/get", { accountId, ids: null, properties: ["role"] }, "m"],
      ["Email/query", { accountId, sort: [{ property: "receivedAt", isAscending: false }], limit: 20 }, "q"],
      ["Email/get", { accountId, "#ids": { resultOf: "q", name: "Email/query", path: "/ids" }, properties: ["threadId", "messageId"] }, "g"],
      ["Identity/get", { accountId }, "i"],
    ]);
    const email = emails.list.find((candidate) => candidate.messageId?.includes("e2e-1@example.com"));
    return email && { ...email, sent: mailboxes.list.find((mailbox) => mailbox.role === "sent").id, identity: identities.list[0]?.id };
  });
  const [[, created], [, submitted]] = await jmapAs(runtimeLogin, runtimeSecret, mailUsing, [
    [
      "Email/set",
      {
        accountId,
        create: {
          r: {
            mailboxIds: { [inboundEmail.sent]: true },
            keywords: { $seen: true },
            from: [{ name: "Front desk agent", email: AGENT }],
            to: [{ name: "Jane Guest", email: GUEST }],
            subject: "Re: Late check-in on Friday?",
            inReplyTo: ["e2e-1@example.com"],
            references: ["e2e-1@example.com"],
            bodyValues: { t: { value: "Hi Jane, yes - late check-in at 11pm is fine. The night desk will have your key." } },
            textBody: [{ partId: "t", type: "text/plain" }],
          },
        },
      },
      "e",
    ],
    [
      "EmailSubmission/set",
      {
        accountId,
        create: { s: { emailId: "#r", identityId: inboundEmail.identity, envelope: { mailFrom: { email: AGENT }, rcptTo: [{ email: GUEST }] } } },
      },
      "x",
    ],
  ]);
  if (!created.created?.r || !submitted.created?.s) throw new Error(`the agent reply failed: ${JSON.stringify([created, submitted])}`);

  step("Waiting for the server's events in Postgres");
  const db = new pg.Client({ connectionString: DATABASE_URL });
  await db.connect();
  const expected = ["queue.authenticated-message-queued", "delivery.dsn-perm-fail", "smtp.mailbox-does-not-exist"];
  const types = await waitFor("the expected events", async () => {
    const { rows } = await db.query("select distinct type from events");
    const seen = rows.map((row) => row.type);
    const ingested = seen.some((type) => type.startsWith("message-ingest."));
    return ingested && expected.every((type) => seen.includes(type)) ? seen : null;
  });
  await db.end();
  console.log(`  ✓ ${types.length} event types stored: ${types.sort().join(", ")}`);

  step("Signing in as the server's administrator and reading through the API");
  const adminTokens = await signIn("admin", adminSecret);
  const token = adminTokens.access_token;
  const me = await apiJson("me", token);
  expect(me.body.login === "admin", "the API knows the operator as admin");
  expect(me.response.headers.get("access-control-allow-origin") === SERVER, "the API allows the server's origin");
  const overview = (await apiJson("overview", token)).body;
  expect(
    ["Front desk agent", "Concierge agent"].every((name) => overview.agents?.some((agent) => agent.name === name)),
    "the overview lists both agents",
  );
  expect(overview.totals.repliesSent >= 1, "the overview counts the agent's reply");
  const agentPath = `agents/${encodeURIComponent(AGENT)}/threads`;
  const thread = (await apiJson(agentPath, token)).body.threads.find((candidate) => candidate.subject.includes("Late check-in on Friday?"));
  expect(thread?.status === "answered", "the conversation is listed as answered");
  const messages = (await apiJson(`${agentPath}/${thread.threadId}`, token)).body.messages;
  expect(
    messages.some((message) => message.direction === "inbound" && message.text.includes("Hi, can I check in at 11pm on Friday?")) &&
      messages.some((message) => message.direction === "outbound" && message.text.includes("The night desk will have your key.")),
    "the thread has the guest's message and the agent's reply",
  );
  const events = (await apiJson("events?type=delivery.", token)).body.events;
  expect(events.some((event) => event.type === "delivery.dsn-perm-fail" && JSON.stringify(event.data).includes("null MX")), "the events include the bounce");
  const live = (await apiJson("events?after=0", token)).body;
  expect(live.events.length > 0 && live.pageSize === 200, "live mode returns events after an id");
  const outside = await api(`agents/${encodeURIComponent(`runtime@${DOMAIN}`)}/threads`, { token });
  expect(outside.status === 404, "a mailbox outside the agent directory is not opened");

  step("Checking what the API refuses");
  expect((await api("me")).status === 401, "a request without a token gets 401");
  expect((await api("me", { token: "bm90LWEtcmVhbC10b2tlbg" })).status === 401, "an invalid token gets 401");
  const viewer = await signIn(`viewer@${DOMAIN}`, viewerSecret);
  const forbidden = await api("me", { token: viewer.access_token });
  expect(forbidden.status === 403 && (await forbidden.json()).error.message.includes("impersonate"), "an account without the impersonate permission gets 403");
  const preflightHeaders = { "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "authorization" };
  const preflight = await api("me", { method: "OPTIONS", headers: preflightHeaders });
  expect(preflight.status === 204 && preflight.headers.get("access-control-allow-origin") === SERVER, "a preflight from the server's origin is allowed");
  const foreign = await api("me", { method: "OPTIONS", origin: "https://attacker.example", headers: preflightHeaders });
  expect(foreign.status === 403 && !foreign.headers.get("access-control-allow-origin"), "a preflight from another origin is refused");
  const refreshed = await fetch(`${SERVER}/auth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: adminTokens.refresh_token, client_id: CLIENT_ID }),
  });
  const renewed = await refreshed.json();
  expect(refreshed.ok && (await api("me", { token: renewed.access_token })).status === 200, "a refreshed access token works");
  const unsigned = await fetch(`${CONSOLE}/api/ingest/events`, { method: "POST", body: '{"events":[]}' });
  expect(unsigned.status === 401, "an unsigned webhook post is refused with 401");

  console.log("\nEnd-to-end run passed.");
  if (keep) {
    console.log(`Console: ${SERVER}/console/ — sign in as admin with the throwaway password ${adminSecret}`);
    console.log("Ctrl-C stops the console; the containers keep running until `docker compose -f e2e/compose.yaml down -v`.");
    await new Promise(() => {});
  }
} finally {
  if (!keep) {
    consoleProcess?.kill();
    docker(["down", "-v", "--remove-orphans"]);
  }
}
