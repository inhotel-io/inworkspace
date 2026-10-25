# inWorkspace Console

A read-only web console for the people who oversee AI agents working through inWorkspace
mailboxes. People email an agent's address, an agent runtime reads the mailbox over JMAP,
and the agent's reply is sent from the same mailbox. The console shows:

- **Conversations**: each agent's threads, read live from its mailbox. Each thread is marked
  *awaiting reply*, *answered*, *junk* or *automated*.
- **Events**: what the mail server did with agent mail. That covers messages accepted, filed as
  junk, refused, queued, delivered or bounced, and authentication and abuse problems.
- **Overview**: 24-hour counts, per-agent activity and the latest errors.

It never writes to a mailbox. It uses the server's open-source event webhook and the JMAP
protocol only, with no Enterprise-only APIs. The design is in [`docs/design.md`](docs/design.md).

## How it works

```text
counterpart ──SMTP──▶ inWorkspace server ──event webhook (HMAC-signed)──▶ console, ingest role
                          ▲    agent mailboxes                                     │
                          │                                                        ▼
                          └──── JMAP, read-only methods ──── console, web role ◀── Postgres
operator ──identity-aware proxy──▶ console, web role
```

One container image runs in one of two roles, chosen by `CONSOLE_ROLE`:

- **ingest** accepts the server's signed event batches at `POST /api/ingest/events` and
  stores them in Postgres. It must be reachable from the mail server, and it holds no JMAP
  credentials.
- **web** serves the pages. It runs behind an identity-aware proxy, such as Google
  Identity-Aware Proxy, and reads mailboxes over JMAP by master-user login as each agent.

`CONSOLE_ROLE=all` runs both roles in one process, for development.

Message bodies are never stored. The console keeps events only: addresses, IPs and ids,
for `EVENT_RETENTION_DAYS`.

## Configuration

| Variable | Role | Meaning |
| --- | --- | --- |
| `CONSOLE_ROLE` | both | `web`, `ingest` or `all`. |
| `DATABASE_URL` | both | Postgres connection string. |
| `WEBHOOK_SIGNING_KEY` | ingest | Shared HMAC key, at least 32 characters; must match the server's webhook. |
| `EVENT_RETENTION_DAYS` | ingest | Days to keep events; default 30. |
| `JMAP_URL` | web | Origin of the inWorkspace server, such as `https://mail.example.com`. |
| `JMAP_PRINCIPAL` | web | Login of the console principal. |
| `JMAP_PRINCIPAL_SECRET` | web | Its password. |
| `AGENT_DOMAINS` | web | Comma-separated domains whose accounts are agent mailboxes. |
| `AGENT_LOCALPART_PATTERN` | web | Optional regular expression the whole local part must match. |
| `AUTH_MODE` | web | `iap` (default) or `none`. |
| `IAP_AUDIENCE` | web | Expected audience of the proxy's signed assertion. |
| `IAP_JWKS_URL` | web | Key set for the assertion; defaults to Google's IAP keys. |
| `ALLOWED_EMAILS`, `ALLOWED_DOMAINS` | web | Who may use the console once signed in. |
| `DISPLAY_TIME_ZONE` | web | IANA time zone for displayed times; default `UTC`. |

The server exits at startup if the configuration is invalid or the database cannot be
migrated. `AUTH_MODE=none` is refused when `NODE_ENV=production` unless
`ALLOW_INSECURE_AUTH_NONE=1` is also set. Only local test runs set it.

## Server setup

The console needs two things on the inWorkspace server: a principal it logs in as, and a
webhook that sends it events. `scripts/server-setup.mjs` creates or updates both, and you
can run it again safely:

```bash
SERVER_URL=https://mail.example.com \
SERVER_ADMIN_USER=admin SERVER_ADMIN_SECRET=… \
CONSOLE_PRINCIPAL=console@agents.example.com CONSOLE_PRINCIPAL_SECRET=… \
WEBHOOK_URL=https://console-ingest.example.com/api/ingest/events WEBHOOK_SIGNING_KEY=… \
node scripts/server-setup.mjs
```

- The **principal** gets `impersonate` plus read access to accounts and domains. Impersonation
  gives full access to a mailbox, so the console enforces read-only access itself. It only
  sends `Mailbox/get`, `Email/query`, `Email/get`, `Thread/get` and the registry's `get` and
  `query` calls, and it only opens mailboxes from its agent directory.
- The **webhook** subscribes to the 39 event types in
  [`src/lib/event-types.json`](src/lib/event-types.json) at level `info`, signed with the key.
- The script then asks the server to reload its settings. Some server versions refuse the
  reload because of an unrelated setting; the script says so, and the webhook becomes active
  at the next restart.

## Development

```bash
npm install
npm run build && node e2e/run.mjs --keep   # a real server and Postgres in Docker, with sample mail
```

`--keep` leaves the stack and the console running at http://localhost:3100. Stop it with
Ctrl-C and `docker compose -f e2e/compose.yaml down -v`.

## Tests

| Command | What it covers |
| --- | --- |
| `npm test` | Unit tests: configuration, signature, normalization, JMAP client, conversations, sanitizing, authentication. |
| `npm run test:integration` | The event store against a real Postgres; needs `TEST_DATABASE_URL`. |
| `npm run e2e` | A real inWorkspace server and Postgres in Docker: mail over SMTP, an agent reply over JMAP, then every page. |

## Deployment

Build the image with `docker build -t inworkspace-console .` and run it twice, once per role,
against one Postgres database. The image listens on port 8080.

The reference deployment is Google Cloud Run:

- **ingest service**: `CONSOLE_ROLE=ingest`, publicly reachable so the mail server can post
  to it. Every request must carry a valid signature.
- **web service**: `CONSOLE_ROLE=web`, with Identity-Aware Proxy enabled and access granted to
  the people who oversee the agents. For Cloud Run, `IAP_AUDIENCE` is
  `/projects/<project number>/locations/<region>/services/<service name>`.
- **Database**: Cloud SQL Postgres through the built-in connector:
  `DATABASE_URL=postgresql://<user>:<password>@/<database>?host=/cloudsql/<instance connection name>`.
- **Secrets**: supply `DATABASE_URL`, `WEBHOOK_SIGNING_KEY` and `JMAP_PRINCIPAL_SECRET` from a
  secret manager, never as plain environment values in source control.

Logs are JSON lines. `console.view` records every conversation and thread view, with the
operator, agent and thread. `console.ingest.*` and `console.startup-failed` report problems.

## Security notes

- **Every allowed operator can read every agent mailbox.** Any user account in
  `AGENT_DOMAINS` that matches `AGENT_LOCALPART_PATTERN` is an agent. Keep human mailboxes out
  of those domains, or narrow the pattern.
- **The principal's password can impersonate any mailbox on the server**, not only agents.
  The console limits itself to directory agents and read-only methods, but the secret does
  not. Store it like an administrator credential and rotate it with `server-setup.mjs`.
- The web role trusts only the identity in the proxy's signed assertion. It checks the
  signature, issuer, audience and expiry, then the allow-list, on every request and again in
  every page and API route.
- Email HTML is sanitized on the server. It is shown in an `iframe` with an empty `sandbox`
  attribute, under a content security policy that blocks every remote resource, so tracking
  pixels never load.
- The ingest role compares the HMAC signature in constant time and rejects bodies over 25 MB.
  After a failed post, the server folds the batch into later ones until its `discardAfter`
  (one hour, as `server-setup.mjs` sets it). An outage of the console or its database
  therefore loses at most an hour of events, and the merged batch stays well under the limit
  at typical agent-mail volumes. Rejections are logged as `console.ingest.*` errors; alert on
  them.
