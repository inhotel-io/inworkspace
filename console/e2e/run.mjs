#!/usr/bin/env node
// End-to-end run: a real inWorkspace server and Postgres in Docker, the console built from this
// directory, real mail over SMTP and an agent reply over JMAP. Run `npm run build` first.
// `node e2e/run.mjs --keep` leaves everything running for a look in the browser.
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import pg from "pg";
import { RegistryClient, ensureAccount, ensurePrincipal, ensureWebhook, reloadSettings } from "../scripts/server-setup.mjs";
import { sendMail } from "./smtp.mjs";

const keep = process.argv.includes("--keep");
const root = new URL("..", import.meta.url).pathname;
const compose = ["compose", "-f", new URL("./compose.yaml", import.meta.url).pathname];
const SERVER = "http://localhost:18080";
const PORT = 3100;
const CONSOLE = `http://localhost:${PORT}`;
const DATABASE_URL = "postgres://console:console@localhost:15432/console";
const DOMAIN = "agents.example.test";
const AGENT = `a21i3v9v@${DOMAIN}`;
const GUEST = "jane@example.com";
const secret = () => randomBytes(24).toString("hex");
const adminSecret = secret();
const principalSecret = secret();
const runtimeSecret = secret();
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

function expectText(page, html, texts) {
  for (const text of texts) {
    if (!html.includes(text)) throw new Error(`${page} does not contain "${text}"`);
  }
  console.log(`  ✓ ${page} shows ${texts.map((text) => `"${text}"`).join(", ")}`);
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

let consoleProcess;
try {
  step("Starting a fresh inWorkspace server and Postgres");
  docker(["down", "-v", "--remove-orphans"]);
  docker(["up", "-d"]);
  await waitFor("the mail server", async () => (await fetch(`${SERVER}/healthz/live`)).ok);
  const admin = new RegistryClient(SERVER, "admin", adminSecret);

  step("Creating the agent domain, two agents, an agent runtime, the console principal and the webhook");
  await admin.one("x:Domain/set", { create: { d: { name: DOMAIN } } });
  await ensureAccount(admin, { address: AGENT, description: "Front desk agent" });
  await ensureAccount(admin, { address: `a000001e@${DOMAIN}`, description: "Concierge agent" });
  await ensureAccount(admin, {
    address: `runtime@${DOMAIN}`,
    description: "Agent runtime",
    secret: runtimeSecret,
    permissions: { "@type": "Merge", enabledPermissions: { impersonate: true }, disabledPermissions: {} },
  });
  await ensurePrincipal(admin, { address: `console@${DOMAIN}`, secret: principalSecret });
  await ensureWebhook(admin, { url: `http://host.docker.internal:${PORT}/api/ingest/events`, signingKey });
  const reload = await reloadSettings(admin);
  if (!reload.reloaded) {
    console.log(`  settings reload refused (${reload.reason.slice(0, 120)}…); restarting the server`);
    docker(["restart", "stalwart"]);
    await waitFor("the mail server after restart", async () => (await fetch(`${SERVER}/healthz/live`)).ok);
  }

  step("Starting the console (role all, authentication off)");
  if (!existsSync(`${root}.next/standalone/server.js`)) throw new Error("run `npm run build` first");
  cpSync(`${root}.next/static`, `${root}.next/standalone/.next/static`, { recursive: true });
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
      AUTH_MODE: "none",
      ALLOW_INSECURE_AUTH_NONE: "1",
    },
  });
  await waitFor("the console", async () => (await fetch(`${CONSOLE}/healthz`)).ok);

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

  step("Checking the console");
  expectText("the overview", await (await fetch(`${CONSOLE}/`)).text(), ["Front desk agent", "Concierge agent", "Replies sent"]);
  const agentPath = `/agents/${encodeURIComponent(AGENT)}`;
  expectText("the agent's conversations", await (await fetch(`${CONSOLE}${agentPath}`)).text(), ["Late check-in on Friday?", "Answered"]);
  expectText(
    "the thread",
    await (await fetch(`${CONSOLE}${agentPath}/threads/${inboundEmail.threadId}`)).text(),
    ["Hi, can I check in at 11pm on Friday?", "The night desk will have your key.", "Agent reply"],
  );
  expectText("the events page", await (await fetch(`${CONSOLE}/events?type=delivery.`)).text(), ["delivery.dsn-perm-fail", "null MX"]);
  const api = await (await fetch(`${CONSOLE}/api/events?after=0`)).json();
  if (!Array.isArray(api.events) || api.events.length === 0) throw new Error("the events API returned no events");
  console.log(`  ✓ the events API returns ${api.events.length} events`);
  const unsigned = await fetch(`${CONSOLE}/api/ingest/events`, { method: "POST", body: '{"events":[]}' });
  if (unsigned.status !== 401) throw new Error(`an unsigned webhook post got ${unsigned.status}, expected 401`);
  console.log("  ✓ an unsigned webhook post is refused with 401");
  // notFound() inside a streamed Suspense boundary keeps HTTP 200, so check what the page shows.
  const outside = await (await fetch(`${CONSOLE}/agents/${encodeURIComponent(`runtime@${DOMAIN}`)}`)).text();
  if (!outside.includes("There is no agent, thread or page at this address.") || outside.includes("Agent runtime")) {
    throw new Error("a mailbox outside the agent directory could be opened");
  }
  console.log("  ✓ a mailbox outside the agent directory is not opened");

  console.log("\nEnd-to-end run passed.");
  if (keep) {
    console.log(`Console: ${CONSOLE}  (Ctrl-C to stop; the containers keep running until \`docker compose -f e2e/compose.yaml down -v\`)`);
    await new Promise(() => {});
  }
} finally {
  if (!keep) {
    consoleProcess?.kill();
    docker(["down", "-v", "--remove-orphans"]);
  }
}
