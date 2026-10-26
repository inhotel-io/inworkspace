# inWorkspace Console

A read-only web console for the people who oversee the mailboxes on an inWorkspace server.

The inWorkspace server serves the console itself, at `/console` next to its web admin, and
operators sign in with their mail-server account. The console shows:

- **Overview**: 24-hour counts, every mailbox on the server with its activity, and the latest
  errors. It reloads every minute and marks mailboxes with activity since you opened it.
  *Access problems* counts failed sign-ins and new bans, and opens them; connections from
  addresses that are already banned are left out.
- **Mailboxes**: all of a mailbox's mail, newest first, read live from every folder. Each
  conversation is marked *awaiting reply*, *answered*, *junk*, *automated*, *draft* or *in
  Trash*. An open mailbox checks for new mail every 30 seconds and marks what arrived.
- **Events**: what the mail server did with mail:
  - messages accepted, filed as junk, refused, queued, delivered or bounced;
  - authentication and abuse problems.

It also gives the server's own web admin the screens the community edition locks: the
**Dashboard**, **Live Tracing** and the delivery **History**. The console collects their data, and
a patched build of the web admin reads it from there; see
[the web admin's Dashboard, Live Tracing and History](#the-web-admins-dashboard-live-tracing-and-history).

It never writes to a mailbox. It uses only the server's open-source parts: the event webhook,
the JMAP and OAuth endpoints, and the web-application hosting. It uses no Enterprise-only APIs.
The design is in [`docs/design.md`](docs/design.md).

## How it works

```text
operator's browser ──▶ inWorkspace server: /console (the web app), /login and /auth/token (sign-in)
operator's browser ──bearer token──▶ console, api role ──▶ Postgres
                                       └── token introspection, JMAP read-only ──▶ inWorkspace server
inWorkspace server ──event webhook (HMAC-signed)──▶ console, ingest role ──▶ Postgres
inWorkspace server ──tracing webhook (HMAC-signed), metrics push (bearer token)──▶ console, ingest role
server's web admin (/admin) ──administrator's token──▶ console, api role: dashboards, tracing, history
```

The console has two parts.

**The web app** (`ui/`) is a React app in two parts.
- **The shell** is a page with this deployment's settings.
  - The server downloads it as a zip from the api role, and serves it at `/console`, the same
    way it serves its web admin at `/admin`.
  - The shell loads the app's code from the api role (`/ui/app/`), so a new console version
    needs nothing on the server.
- **The app** signs operators in at the server with OAuth 2.0 and PKCE, then calls the API with
  their access token.

**The service** (`src/`) is one container image that runs in one of two roles, chosen by
`CONSOLE_ROLE`:
- **api** answers the web app's JSON requests under `/api/v1/`, and serves the web app's shell
  and code under `/ui/`.
  - Browsers call it from the server's origin, so it is publicly reachable. Every API request
    needs an operator's access token.
  - It reads mailboxes over JMAP, using a master-user login as each mailbox's account.
- **ingest** accepts what the server sends, and stores it in Postgres:
  - signed event batches at `POST /api/ingest/events`;
  - signed tracing batches at `POST /api/ingest/traces`;
  - the OpenTelemetry metrics push at `POST /api/ingest/metrics`.

  It must be reachable from the mail server. It holds no JMAP credentials, except an optional
  app password that can only count the delivery queue.

`CONSOLE_ROLE=all` runs both roles in one process, for development.

Message bodies are never stored. The console keeps only events (addresses, IPs and ids), for
`EVENT_RETENTION_DAYS`. Traces, which are events too, are kept for `TRACE_RETENTION_DAYS`, and
metrics for `METRIC_RETENTION_DAYS`.

## Configuration

| Variable | Role | Meaning |
| --- | --- | --- |
| `CONSOLE_ROLE` | both | `api`, `ingest` or `all`. |
| `DATABASE_URL` | both | Postgres connection string. |
| `WEBHOOK_SIGNING_KEY` | ingest | Shared HMAC key, at least 32 characters; must match the server's webhook. |
| `EVENT_RETENTION_DAYS` | ingest | Days to keep events; default 30. |
| `METRICS_PUSH_TOKEN` | ingest | Bearer token of the server's metrics push, 32 to 256 characters. Without it, `/api/ingest/metrics` answers 404. |
| `METRIC_RETENTION_DAYS` | ingest | Days to keep metrics; default 90, the dashboards' longest period. |
| `TRACE_RETENTION_DAYS` | ingest | Days to keep traces; default 30. |
| `QUEUE_READER_LOGIN`, `QUEUE_READER_SECRET` | ingest | Optional: the console principal's login and its queue reader app password (see [Server setup](#server-setup)). With them, every metrics push also records the delivery queue's size, which the community edition does not export. |
| `JMAP_URL` | api, and ingest with a queue reader | Origin of the inWorkspace server, such as `https://mail.example.com`. The web app runs on it. |
| `JMAP_PRINCIPAL` | api | Login of the console principal. |
| `JMAP_PRINCIPAL_SECRET` | api | Its password. |
| `MAILBOX_DOMAINS` | api | Optional comma-separated domains whose mailboxes the console lists. Default: every domain on the server. |
| `MAILBOX_LOCALPART_PATTERN` | api | Optional regular expression the whole local part of a listed mailbox must match. |
| `PUBLIC_URL` | api | Origin at which browsers reach the api role, such as `https://console-api.example.com`. |
| `AUTH_MODE` | api | `server` (default) or `none`; see [Access](#access). |
| `OPERATOR_PERMISSION` | api | The server permission an operator needs; default `impersonate`. |
| `ALLOWED_ACCOUNTS` | api | Optional comma-separated logins that may use the console. |
| `OAUTH_CLIENT_ID` | api | The client id the web app signs in with; default `inworkspace-console`. |
| `DISPLAY_TIME_ZONE` | api | Optional IANA time zone for displayed times; default: the browser's. |
| `UI_DIST_DIR` | api | Directory of the built web app; default `ui-dist`. |
| `TRUSTED_PROXY_HOPS` | api | Proxies in front of the service that append the client's address to `X-Forwarded-For`; default 0. With 0 there is no per-client introspection limit. |
| `MAX_ACCESS_TOKEN_LIFETIME` | api | Seconds an access token can live at most; default 86400, at most 604800. Must be at least the server's access-token lifetime (default one hour), and below its refresh-token lifetime (default 30 days). |

The service exits at startup in any of these cases:
- the configuration is invalid;
- the database cannot be migrated;
- in the api role, the built web app is missing.

`AUTH_MODE=none` skips sign-in. It is refused when `NODE_ENV=production`, unless
`ALLOW_INSECURE_AUTH_NONE=1` is also set.

## Server setup

The console needs four things on the inWorkspace server:
- a principal it logs in as;
- a webhook that sends it events;
- an OAuth client for sign-in;
- the web application that serves `/console`.

`scripts/server-setup.mjs` creates or updates all four, and you can run it again safely. Run it
once, and again only when the shell changes: its settings (the API's URL, the client id or the
time zone) or its page template, which release notes mention.

```bash
SERVER_URL=https://mail.example.com \
SERVER_ADMIN_USER=admin SERVER_ADMIN_SECRET=… \
CONSOLE_PRINCIPAL=console@example.com CONSOLE_PRINCIPAL_SECRET=… \
WEBHOOK_URL=https://console-ingest.example.com/api/ingest/events WEBHOOK_SIGNING_KEY=… \
CONSOLE_URL=https://console-api.example.com \
node scripts/server-setup.mjs
```

**The principal**
- It gets `impersonate`, plus read access to accounts and domains, and `sysQueuedMessageQuery`
  for its queue reader app password.
- Impersonation gives full access to a mailbox, so the console enforces read-only access
  itself:
  - It only sends `Mailbox/get`, `Email/query`, `Email/get`, `Thread/get`, and the registry's
    `get` and `query` calls.
  - It only opens the mailboxes it lists: user accounts in the listed domains, never its own.

**The webhook** subscribes to the 39 event types in
[`src/lib/event-types.json`](src/lib/event-types.json), at level `info`, signed with the key.

**The OAuth client** is `inworkspace-console`, or `OAUTH_CLIENT_ID`. It is public, with no
secret. Its only redirect URI is `<SERVER_URL>/console/oauth/callback`.

**The web application**
- It serves `/console`, or `CONSOLE_PATH`, from the shell that `<CONSOLE_URL>/ui/manifest`
  names.
- The server downloads the shell from `CONSOLE_FETCH_URL` when that is set, else from
  `CONSOLE_URL`.
- The server keeps one downloaded shell per application record, so a new shell gets a new
  record. The script creates it, then deletes the old one.
- The script never touches records that serve other paths, such as the web admin.

**Making a new record live.** The server loads web applications only when it starts, or on its
**Update apps** action.
- **Restarting the server is the safer way.** A restart downloads only applications it has no
  copy of, which here means the console's shell.
- **Update apps avoids the restart** (run the script with `UPDATE_APPS=1`). It first deletes
  every application's stored copy, the web admin's included, then downloads each again from its
  `resourceUrl`. An application whose download fails stays offline until a later Update apps or
  restart succeeds.

> **Check the web admin's `resourceUrl` first.** If it ends in
> `releases/latest/download/webui.zip`, the server installs whatever web admin is newest. That
> may need a newer server than yours: since web UI 1.0.9, sign-in needs server support that
> older 0.16 servers lack. Point it at the release your server already serves, for example
> `https://github.com/stalwartlabs/webui/releases/download/v1.0.5/webui.zip`.

**For the web admin's Dashboard, Live Tracing and History**, set these too:

| Variable | What the script does |
| --- | --- |
| `TRACING_WEBHOOK_URL` | The ingest's `/api/ingest/traces`. Creates or updates the tracing webhook, signed with the same key. It subscribes to the event types in [`src/lib/trace-event-types.json`](src/lib/trace-event-types.json) that the server knows. |
| `METRICS_PUSH_URL`, `METRICS_PUSH_TOKEN` | The ingest's `/api/ingest/metrics` and its token. Makes the server push its metrics there every minute (OpenTelemetry over HTTP). The Prometheus endpoint and the choice of metrics stay as they are. If the server already pushes elsewhere, the script stops, unless `METRICS_PUSH_REPLACE=1`. |
| `QUEUE_READER_SECRET_FILE`, `QUEUE_READER_SECRET` | Signs in as the principal and makes it an app password that may only sign in and count the delivery queue. The server makes the secret and shows it once, so the script writes a new one to `QUEUE_READER_SECRET_FILE`, readable only by you, and never prints it. Give the ingest that secret as `QUEUE_READER_SECRET`, then delete the file. When `QUEUE_READER_SECRET` is set and still works, nothing changes; without it, every run makes a new one and removes the old. A secret the server cannot be asked about is left as it is. |

The server's webhooks ignore their `level` setting and send exactly the events they list. So
the tracing webhook lists its events: those at `info` level and above, plus the debug-level
events that make a delivery trace readable. `scripts/generate-trace-events.mjs` makes that list
from the server's event table.

**Reload.** Finally, the script asks the server to reload its settings. Some server versions
refuse the reload because of an unrelated setting. The script says so, and the webhook then
becomes active at the next restart.

**The metrics push starts only at a restart.** A reload sets the push up, but the server
schedules its first push when its task scheduler starts, so pushes begin at the next restart.
That includes the queue's size, which the ingest counts with each push. The tracing webhook
needs no restart.

## The web admin's Dashboard, Live Tracing and History

On the community edition, the web admin locks the Dashboard, Observability → Live Tracing and
Emails → History. Their data comes from Enterprise-only server code.

The console collects the same data from what the community edition exports:
- **Metrics.** The server's OpenTelemetry push. Counters become what each push added, gauges are
  kept as pushed, and histograms as running totals that survive restarts.
- **Queue size.** The queue reader counts it with each push.
- **Traces.** The tracing webhook's events. Inbound SMTP sessions and outbound delivery
  attempts are grouped into traces by span.
- **Latencies the export lacks.** Message ingest, indexing and DNS lookup times are measured from
  the same events the server's own histograms observe.

The api role serves it in the Enterprise endpoints' shapes, under `/api/v1/insights/`:
- metric history and current values;
- `x:Trace/query` and `x:Trace/get` over JMAP;
- a polled live event feed.

Each route needs the permission the server itself would require.

[`webadmin/`](webadmin) builds the server's web UI with patches that point those screens at this
API. Its README covers the build, installing it at `/admin`, and rolling back to the stock web
UI.

## Development

```bash
npm install
npm run build && node e2e/run.mjs --keep   # a real server and Postgres in Docker, with sample mail
```

`--keep` leaves the stack and the console running.
- Open http://localhost:18080/console/ and sign in as `admin`, with the throwaway password the
  run prints.
- To stop, press Ctrl-C, then run `docker compose -f e2e/compose.yaml down -v`.

To work on the web app with hot reload:
1. Keep that stack running.
2. Run `npm run dev:ui`.
3. Open http://localhost:5173 and sign in as `admin`.

Vite proxies sign-in to the server and API calls to the console.

## Tests

| Command | What it covers |
| --- | --- |
| `npm test` | Unit tests for the service: configuration, signature, normalization, JMAP client, conversations, sanitizing, token verification, CORS, the API wrapper and the bundle. Also the web app's sign-in and its API client. |
| `npm run test:integration` | The event store against a real Postgres; needs `TEST_DATABASE_URL`. |
| `npm run e2e` | A real inWorkspace server and Postgres in Docker, with mailboxes in two domains. It sends mail over SMTP, and over JMAP a reply plus drafts and messages in Trash and Junk. It checks the web app at `/console`, and signs in through the server's OAuth endpoints. Then it calls the API with valid, invalid and unauthorized tokens, and checks the audit lines. |
| `npm run e2e:insights` | The web admin's Dashboard, Live Tracing and History, against a real server in Docker (v0.16.13 by default, `E2E_STALWART_TAG` for another). It sets up the queue reader, the tracing webhook and the metrics push, and installs the patched web admin at `/admin`. Then it reads metrics, traces and the live feed as an administrator, and checks that an account without the permissions is refused. Builds the web admin first unless `WEBADMIN_ZIP` names one. |

## Deployment

Build the image with `docker build -t inworkspace-console .` and run it twice, once per role,
against one Postgres database. The image listens on port 8080 and contains the built web app.

The reference deployment is Google Cloud Run:

- **api service**: `CONSOLE_ROLE=api`, publicly reachable (allow unauthenticated invocations).
  - The web app runs in operators' browsers on the mail server's origin and calls the service
    directly.
  - Every API request must carry an operator's access token.
  - Set `PUBLIC_URL` to the service's URL.
  - Set `TRUSTED_PROXY_HOPS` so the per-client limit sees real clients:
    - `1` for the service's own `run.app` URL, where Cloud Run appends the client's address to
      `X-Forwarded-For`;
    - `2` behind an external Application Load Balancer, which appends its own address too.
  - Cap the instance count, for example `--max-instances 3`. Each instance has its own
    introspection budget, and every introspection runs as the console principal.
- **ingest service**: `CONSOLE_ROLE=ingest`, publicly reachable so the mail server can post to
  it. Every request must carry a valid signature.
- **Database**: Cloud SQL Postgres through the built-in connector:
  `DATABASE_URL=postgresql://<user>:<password>@/<database>?host=/cloudsql/<instance connection name>`.
- **Secrets**: supply `DATABASE_URL`, `WEBHOOK_SIGNING_KEY` and `JMAP_PRINCIPAL_SECRET` from a
  secret manager, never as plain environment values in source control. So are
  `METRICS_PUSH_TOKEN` and `QUEUE_READER_SECRET`.
- **Health**: Cloud Run reserves paths ending in `z`, so `/healthz` does not reach the app
  there. Its default TCP startup probe is enough, because a bad configuration makes the
  server exit.

A new console version needs only the deploy: the next page load picks up the new code. Run
[`scripts/server-setup.mjs`](#server-setup) again only when the shell changes: its settings or
its page template.

## Upgrading from 0.3

Version 0.4 lists every mailbox, where 0.3 listed only AI agents' mailboxes.
- `AGENT_DOMAINS` and `AGENT_LOCALPART_PATTERN` are now `MAILBOX_DOMAINS` and
  `MAILBOX_LOCALPART_PATTERN`, and both are optional. The old names are read only while neither
  new name is set, so a deployment keeps listing the same mailboxes; setting either new name
  replaces both old ones. Remove the old names to list every mailbox on the server.
- The API's `agents` paths are now `mailboxes`. Links to the web app's old `#/agents/…` pages
  still work.
- `console.view` log lines name the `mailbox`, where they named the `agent`.
- A mailbox's list now includes drafts and mail in Trash, marked.

## Upgrading from 0.1

Version 0.1 had a server-rendered console behind Google identity, with roles `web` and
`ingest`. Version 0.2 replaces the web role. To upgrade:

1. Deploy the image as a new **api** service, with these changes from the old web service:
   - `CONSOLE_ROLE=api` instead of `web`, and `PUBLIC_URL` set to the new service's URL;
   - remove `AUTH_MODE=iap|cloud-run`, `IAP_AUDIENCE`, `IAP_JWKS_URL`, `ALLOWED_EMAILS` and
     `ALLOWED_DOMAINS`;
   - optionally add `ALLOWED_ACCOUNTS`. It holds mail-server logins, not Google addresses;
   - make it publicly reachable.
2. Deploy the same image to the ingest service; nothing else changes there.
3. Run [`scripts/server-setup.mjs`](#server-setup) with `CONSOLE_URL` set to the api service.
   Then restart the server, or run Update apps.
4. Open `<server>/console/`, sign in, and delete the old web service. Its URL now answers 404.

## Access

Operators open `<server>/console/` and sign in with their account on the inWorkspace server. It
is the server's own sign-in page, with MFA when the account has it.

An account may use the console when it has the `impersonate` permission (`OPERATOR_PERMISSION`).
- The server's administrators have it, and so does its recovery administrator.
- An account that could already read any mailbox through impersonation sees nothing new.
- `ALLOWED_ACCOUNTS` narrows access further, to named logins.

Logs are JSON lines.
- `console.view` records every mailbox and thread view, with the operator's login, the
  mailbox and the thread. Reloads the web app makes by itself, to show new mail, carry
  `"automatic": true`. The web app says which reads those are and the API takes its word, so
  read the field as a guide through the log, not as proof.
- These report problems: `console.ingest.*`, `console.auth.unavailable`, `console.jmap.failed`,
  `console.api.failed` and `console.startup-failed`.

## Security notes

- **Every operator can read every listed mailbox**, and by default that is every user account
  on the server. Narrow it with `MAILBOX_DOMAINS` and `MAILBOX_LOCALPART_PATTERN`, and
  `ALLOWED_ACCOUNTS` narrows who may look. Every read is logged as `console.view`.
- **The principal's password can impersonate any mailbox on the server**, also those the
  console does not list. The console limits itself to listed mailboxes and read-only methods,
  but the secret does not.
  Store it like an administrator credential, and rotate it with `server-setup.mjs`.
- **Token checks.**
  - The api role checks each access token by introspection at the server, authenticating as
    the console principal. An invalid token therefore never counts as a failed login against
    the API's own address.
  - It refuses tokens that live longer than an access token can, such as refresh tokens and
    calendar reply links. The server's introspection reports those as active too.
  - It then reads the account's permissions and login with the token, one request at a time.
  - It checks each token once at a time, and remembers the answer, yes or no, for up to 60
    seconds.
  - Introspections are limited to 120 a minute per instance, and 20 per client. Beyond that it
    answers 429. A session that already passed is checked again without counting, so a flood
    can only delay new sign-ins.
  - If the server uses an OpenID Connect directory, add the API's egress address to the
    server's allowed IPs. That needs a static egress address (Cloud NAT or Direct VPC egress
    with a reserved IP); see the design's sign-in section.
- **Signing out** discards the tokens in the tab. The server has no revocation endpoint, so a
  discarded token stays valid until it expires: one hour for access, 30 days for refresh.
  Changing the account's password revokes them all.
- **The OAuth client's redirect URI** is enforced only when the server requires registered
  clients. That is off by default, and accounts with `oAuthClientOverride` bypass it.
- **Framing**: the shell's meta policy cannot forbid framing. Add
  `Content-Security-Policy: frame-ancestors 'self'` to the server's own response headers
  (`x:Http` `responseHeaders`).
- **In the browser.**
  - Tokens live in `sessionStorage`, one tab at a time.
  - API responses allow only the server's origin, and no cookies are used.
  - The shell page carries a content security policy. Scripts and styles come only from the
    console API's `/ui/app/`, and calls go only to the server and the console API.
  - **Treat the api service like the server's own administration.**
    - The api service serves the app's code to the server's origin.
    - It receives each operator's access token on every request, and those tokens carry the
      account's full rights.
    - So whoever can change the api service, or read its memory or logs, can act as any
      operator.
- Email HTML is sanitized by the API and shown in an `iframe` with an empty `sandbox`
  attribute. A content security policy there blocks every remote resource, so tracking pixels
  never load.
- **The ingest role.**
  - It compares the HMAC signature in constant time, and rejects bodies over 25 MB.
  - After a failed post, the server folds the batch into later ones until its `discardAfter`
    (one hour, as `server-setup.mjs` sets it). An outage of the console or its database
    therefore loses at most an hour of events. The merged batch stays well under the size limit
    at typical mail volumes.
  - Rejections are logged as `console.ingest.*` errors; alert on them.
  - The metrics push must carry `METRICS_PUSH_TOKEN`, compared in constant time; bodies over 4 MB
    are refused. Problems are logged as `console.metrics.*`, and tracing batches as
    `console.traces.*`.
  - The queue reader app password may only sign in and count the delivery queue.
- **The patched web admin** sends the signed-in administrator's token to the console API named
  on the server's own `/console/` page. That is the same trust as the console's own web app: the
  api service sees administrators' tokens, so treat it like the server's administration.
