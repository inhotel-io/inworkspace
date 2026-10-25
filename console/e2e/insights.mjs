#!/usr/bin/env node
// End-to-end run of the web admin's Dashboard, Live Tracing and History on the community edition:
// a real server (by default v0.16.13) pushing its metrics and tracing events to the console, the
// console's API answering as the Enterprise endpoints would, and the patched web admin served by the
// server. Run `npm run build` first; give a built web admin with WEBADMIN_ZIP=<path>, or the run
// builds one (webadmin/build.mjs). `--keep` leaves everything running, to look at it in a browser.
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { cpSync, existsSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import {
  RegistryClient,
  canCountQueue,
  consoleBundle,
  ensureAccount,
  ensureApplication,
  ensureMetricsPush,
  ensureOAuthClient,
  ensurePrincipal,
  ensureQueueReader,
  ensureTracingWebhook,
  ensureWebhook,
  reloadSettings,
} from "../scripts/server-setup.mjs";
import { switchWebadmin } from "../scripts/webadmin.mjs";
import { sendMail } from "./smtp.mjs";

const keep = process.argv.includes("--keep");
const root = new URL("..", import.meta.url).pathname;
const compose = ["compose", "-f", new URL("./compose.yaml", import.meta.url).pathname];
const SERVER_TAG = process.env.E2E_STALWART_TAG || "v0.16.13";
const SERVER = "http://localhost:18080";
const PORT = 3100;
const ZIP_PORT = 3101;
const CONSOLE = `http://localhost:${PORT}`;
const FROM_SERVER = (port) => `http://host.docker.internal:${port}`;
const DATABASE_URL = "postgres://console:console@localhost:15432/console";
const DOMAIN = "agents.example.test";
const AGENT = `a21i3v9v@${DOMAIN}`;
const GUEST = "jane@example.com";
const CLIENT_ID = "inworkspace-console";
const REDIRECT_URI = `${SERVER}/console/oauth/callback`;
const secret = () => randomBytes(24).toString("hex");
// Set E2E_ADMIN_SECRET to sign in to the web admin yourself after a --keep run.
const adminSecret = process.env.E2E_ADMIN_SECRET || secret();
const principalSecret = secret();
const runtimeSecret = secret();
const viewerSecret = secret();
const signingKey = secret();
const pushToken = secret();

function docker(args) {
  execFileSync("docker", [...compose, ...args], {
    stdio: "inherit",
    env: { ...process.env, E2E_ADMIN_SECRET: adminSecret, E2E_STALWART_TAG: SERVER_TAG },
  });
}

async function waitFor(what, check, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}${last ? ` (${last.message})` : ""}`);
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

async function signIn(accountName, accountSecret) {
  const verifier = randomBytes(32).toString("base64url");
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
      state: randomBytes(16).toString("base64url"),
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
  if (!exchange.ok || typeof tokens.access_token !== "string") throw new Error(`the token exchange for ${accountName} failed`);
  return tokens.access_token;
}

async function insights(path, token, init = {}) {
  const response = await fetch(`${CONSOLE}/api/v1/insights/${path}`, {
    ...init,
    headers: { Origin: SERVER, Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

function traceJmap(token, methodCalls) {
  return insights("jmap", token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ using: ["urn:ietf:params:jmap:core", "urn:stalwart:jmap"], methodCalls }),
  });
}

let consoleProcess;
let zipServer;
try {
  step(`Starting a fresh server ${SERVER_TAG} and Postgres`);
  docker(["down", "-v", "--remove-orphans"]);
  docker(["up", "-d"]);
  await waitFor("the mail server", async () => (await fetch(`${SERVER}/healthz/live`)).ok);
  const admin = new RegistryClient(SERVER, "admin", adminSecret);

  step("Creating the accounts, the console principal with its queue reader, both webhooks and the metrics push");
  await admin.one("x:Domain/set", { create: { d: { name: DOMAIN } } });
  await ensureAccount(admin, { address: AGENT, description: "Front desk agent" });
  await ensureAccount(admin, {
    address: `runtime@${DOMAIN}`,
    description: "Agent runtime",
    secret: runtimeSecret,
    permissions: { "@type": "Merge", enabledPermissions: { impersonate: true }, disabledPermissions: {} },
  });
  await ensureAccount(admin, { address: `viewer@${DOMAIN}`, description: "Plain user", secret: viewerSecret });
  await ensurePrincipal(admin, { address: `console@${DOMAIN}`, secret: principalSecret });
  const queueReaderSecret = await ensureQueueReader(SERVER, { login: `console@${DOMAIN}`, password: principalSecret });
  expect(typeof queueReaderSecret === "string", "the principal made the ingest an app password");
  await ensurePrincipal(admin, { address: `console@${DOMAIN}`, secret: principalSecret });
  expect(await canCountQueue(SERVER, `console@${DOMAIN}`, queueReaderSecret), "running the setup again keeps it");
  expect(
    (await ensureQueueReader(SERVER, { login: `console@${DOMAIN}`, password: principalSecret, current: queueReaderSecret })) === null,
    "and does not replace it while it works",
  );
  await ensureWebhook(admin, { url: `${FROM_SERVER(PORT)}/api/ingest/events`, signingKey });
  const tracing = await ensureTracingWebhook(admin, { url: `${FROM_SERVER(PORT)}/api/ingest/traces`, signingKey });
  expect(tracing.events > 300 && tracing.unknown < 20, `the tracing webhook lists ${tracing.events} event types (${tracing.unknown} unknown to ${SERVER_TAG})`);
  await ensureMetricsPush(admin, { endpoint: `${FROM_SERVER(PORT)}/api/ingest/metrics`, token: pushToken, intervalMs: 5000 });
  const reload = await reloadSettings(admin);
  if (!reload.reloaded) {
    console.log(`  settings reload refused (${reload.reason.slice(0, 120)}…); restarting the server`);
    docker(["restart", "stalwart"]);
    await sleep(3000);
    await waitFor("the mail server after restart", async () => (await fetch(`${SERVER}/healthz/live`)).ok);
  }
  const denied = await jmapAs(`console@${DOMAIN}`, queueReaderSecret, ["urn:ietf:params:jmap:core", "urn:stalwart:jmap"], [
    ["x:Account/query", {}, "0"],
  ]).catch((error) => [["error", { type: error.message }]]);
  expect(denied[0][0] === "error", "and can do nothing else, such as list accounts");

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
      METRICS_PUSH_TOKEN: pushToken,
      QUEUE_READER_LOGIN: `console@${DOMAIN}`,
      QUEUE_READER_SECRET: queueReaderSecret,
      JMAP_URL: SERVER,
      JMAP_PRINCIPAL: `console@${DOMAIN}`,
      JMAP_PRINCIPAL_SECRET: principalSecret,
      AGENT_DOMAINS: DOMAIN,
      AGENT_LOCALPART_PATTERN: "a[0-9a-z]{7}",
      PUBLIC_URL: CONSOLE,
    },
  });
  await waitFor("the console", async () => (await fetch(`${CONSOLE}/healthz`)).ok);

  step("Installing the console at /console and the patched web admin at /admin");
  let zipPath = process.env.WEBADMIN_ZIP;
  if (!zipPath) {
    zipPath = `${root}webadmin/webui.zip`;
    execFileSync("node", [`${root}webadmin/build.mjs`, "--out", zipPath], { stdio: "inherit", cwd: root });
  }
  const zip = readFileSync(zipPath);
  zipServer = http.createServer((request, response) => {
    if (request.url !== "/webui.zip") return response.writeHead(404).end();
    response.writeHead(200, { "Content-Type": "application/zip" }).end(zip);
  });
  await new Promise((resolve) => zipServer.listen(ZIP_PORT, "0.0.0.0", resolve));
  await ensureOAuthClient(admin, { clientId: CLIENT_ID, redirectUri: REDIRECT_URI, description: "inWorkspace Console" });
  const manifest = await consoleBundle(CONSOLE);
  await ensureApplication(admin, { prefix: "console", resourceUrl: `${FROM_SERVER(PORT)}/ui/${manifest.file}` });
  const switched = await switchWebadmin(admin, SERVER, `${FROM_SERVER(ZIP_PORT)}/webui.zip`, {
    requireHttps: false,
    checkUrl: `http://localhost:${ZIP_PORT}/webui.zip`,
    log: () => {},
  });
  expect(switched.switched, "the server serves the patched web admin at /admin");
  const shell = await (await fetch(`${SERVER}/console/`)).text();
  expect(shell.includes(`name="inworkspace-console-api" content="${CONSOLE}"`), "the console page at /console names the API the web admin uses");

  step("Sending mail: a guest message, one to a missing mailbox, an agent reply, and a failed sign-in");
  // Right after a restart the first session can stall while the server loads its spam model.
  const sendOnce = (message) => sendMail(message).catch(() => sendMail(message));
  const inbound = await sendOnce({
    host: "localhost",
    port: 12525,
    from: GUEST,
    to: AGENT,
    data: `From: Jane Guest <${GUEST}>\nTo: ${AGENT}\nSubject: Late check-in on Friday?\nMessage-ID: <insights-1@example.com>\nDate: ${new Date().toUTCString()}\n\nHi, can I check in at 11pm on Friday? Thanks, Jane`,
  });
  if (!inbound.accepted) throw new Error(`the guest message was refused: ${inbound.reply}`);
  await sendMail({ host: "localhost", port: 12525, from: GUEST, to: `ghost@${DOMAIN}`, data: "Subject: hello\n\nanyone?" });
  const runtimeLogin = `${AGENT}%runtime@${DOMAIN}`;
  const mailUsing = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail", "urn:ietf:params:jmap:submission"];
  const session = await (await fetch(`${SERVER}/jmap/session`, { headers: { Authorization: basic(runtimeLogin, runtimeSecret) } })).json();
  const accountId = session.primaryAccounts["urn:ietf:params:jmap:mail"];
  const mailbox = await waitFor("the guest message in the mailbox", async () => {
    const [[, mailboxes], [, identities], , [, emails]] = await jmapAs(runtimeLogin, runtimeSecret, mailUsing, [
      ["Mailbox/get", { accountId, ids: null, properties: ["role"] }, "m"],
      ["Identity/get", { accountId }, "i"],
      ["Email/query", { accountId, limit: 5 }, "q"],
      ["Email/get", { accountId, "#ids": { resultOf: "q", name: "Email/query", path: "/ids" }, properties: ["messageId"] }, "g"],
    ]);
    const arrived = emails.list.some((email) => email.messageId?.includes("insights-1@example.com"));
    return arrived && { sent: mailboxes.list.find((box) => box.role === "sent").id, identity: identities.list[0]?.id };
  });
  await jmapAs(runtimeLogin, runtimeSecret, mailUsing, [
    [
      "Email/set",
      {
        accountId,
        create: {
          r: {
            mailboxIds: { [mailbox.sent]: true },
            from: [{ email: AGENT }],
            to: [{ email: GUEST }],
            subject: "Re: Late check-in on Friday?",
            bodyValues: { t: { value: "Hi Jane, yes - 11pm is fine." } },
            textBody: [{ partId: "t", type: "text/plain" }],
          },
        },
      },
      "e",
    ],
    ["EmailSubmission/set", { accountId, create: { s: { emailId: "#r", identityId: mailbox.identity, envelope: { mailFrom: { email: AGENT }, rcptTo: [{ email: GUEST }] } } } }, "x"],
  ]);
  await fetch(`${SERVER}/jmap/session`, { headers: { Authorization: basic(`viewer@${DOMAIN}`, "wrong-password") } });

  step("Reading the Dashboard's data as the administrator");
  const adminToken = await signIn("admin", adminSecret);
  const live = await waitFor("live gauges, the queue's size among them", async () => {
    const { status, body } = await insights("metrics/live?metric=server.memory&metric=user.count&metric=queue.count&metric=smtp.active-connections", adminToken);
    return status === 200 && body.metrics.some((m) => m.metric === "queue.count") ? body : null;
  });
  const memory = live.metrics.find((m) => m.metric === "server.memory");
  expect(memory?.["@type"] === "Gauge" && memory.count > 0, `server memory is live (${Math.round(memory.count / 1048576)} MB)`);
  expect(live.metrics.find((m) => m.metric === "user.count")?.count >= 3, "the account count is live");
  expect(live.lastPushAt !== null, "the console reports when the server last pushed");
  const window = `from=${new Date(Date.now() - 3_600_000).toISOString()}&to=${new Date(Date.now() + 60_000).toISOString()}`;
  const history = await waitFor("counters and the derived ingest time in the history", async () => {
    const { body } = await insights(`metrics?${window}&metric=smtp.connection-start&metric=message-ingest.time&metric=store.data-read-time`, adminToken);
    const connections = body?.metrics.filter((m) => m.metric === "smtp.connection-start").reduce((total, m) => total + m.count, 0) ?? 0;
    const ingest = body?.metrics.filter((m) => m.metric === "message-ingest.time") ?? [];
    return connections >= 2 && ingest.length >= 2 ? body : null;
  });
  expect(history.unavailable.join() === "store.data-read-time", "store latencies are reported as not exported by the community edition");

  step("Reading History and Live Tracing as the administrator");
  const inboundTrace = await waitFor("the guest's inbound delivery trace", async () => {
    const { body } = await traceJmap(adminToken, [
      ["x:Trace/query", { filter: { event: "smtp.connection-start", text: GUEST }, calculateTotal: true, limit: 25 }, "0"],
      ["x:Trace/get", { "#ids": { resultOf: "0", name: "x:Trace/query", path: "/ids" }, properties: ["id", "timestamp", "from", "to", "size"] }, "1"],
    ]);
    const [, list] = body.methodResponses[1];
    return list.list.find((trace) => trace.from === GUEST && trace.to.includes(AGENT) && trace.size > 0);
  });
  expect(true, `inbound trace ${inboundTrace.id}: ${inboundTrace.from} → ${inboundTrace.to}, ${inboundTrace.size} bytes`);
  const { body: detail } = await traceJmap(adminToken, [["x:Trace/get", { ids: [inboundTrace.id] }, "0"]]);
  const events = detail.methodResponses[0][1].list[0].events.map((event) => event.event);
  expect(events[0] === "smtp.connection-start" && events.includes("smtp.mail-from") && events.includes("smtp.rcpt-to"), `the trace shows the session: ${events.slice(0, 6).join(", ")}…`);
  const outbound = await waitFor("the reply's outbound delivery trace", async () => {
    const { body } = await traceJmap(adminToken, [["x:Trace/query", { filter: { event: "delivery.attempt-start" }, calculateTotal: true }, "0"]]);
    return body.methodResponses[0][1].total > 0 ? body.methodResponses[0][1] : null;
  });
  expect(outbound.total >= 1, `${outbound.total} outbound delivery trace(s)`);
  const feed = await insights("tracing", adminToken);
  expect(feed.status === 200 && feed.body.events.length > 0 && /^\d+$/.test(feed.body.cursor), `live tracing starts with ${feed.body.events.length} recent events`);
  const next = await insights(`tracing?after=${feed.body.cursor}&filter=nothing-matches-this`, adminToken);
  expect(next.status === 200 && next.body.events.length === 0, "and continues from its cursor");

  step("Refusing an account without the permissions");
  const viewerToken = await signIn(`viewer@${DOMAIN}`, viewerSecret);
  expect((await insights("metrics/live?metric=server.memory", viewerToken)).status === 403, "live metrics need liveMetrics");
  expect((await insights("tracing", viewerToken)).status === 403, "live tracing needs liveTracing");
  const { body: forbidden } = await traceJmap(viewerToken, [["x:Trace/query", {}, "0"]]);
  expect(forbidden.methodResponses[0][1].type === "forbidden", "trace queries need sysTraceQuery");

  console.log(`\n✓ insights end-to-end run passed against ${SERVER_TAG}`);
  if (keep) {
    console.log(`\nThe web admin: ${SERVER}/admin/ (sign in as admin, with E2E_ADMIN_SECRET if you set it)`);
    console.log("Ctrl-C stops the console; `docker compose -f e2e/compose.yaml down -v` removes the containers.");
    await new Promise(() => {});
  }
} finally {
  if (!keep) {
    consoleProcess?.kill();
    zipServer?.close();
    docker(["down", "-v", "--remove-orphans"]);
  }
}
