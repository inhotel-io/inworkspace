# inWorkspace Console

A read-only web console for the people who oversee AI agents working through inWorkspace
mailboxes.
- People email an agent's address.
- An agent runtime reads the mailbox over JMAP.
- The agent's reply is sent from the same mailbox.

The inWorkspace server serves the console itself, at `/console` next to its web admin, and
operators sign in with their mail-server account. The console shows:

- **Conversations**: each agent's threads, read live from its mailbox. Each thread is marked
  *awaiting reply*, *answered*, *junk* or *automated*.
- **Events**: what the mail server did with agent mail:
  - messages accepted, filed as junk, refused, queued, delivered or bounced;
  - authentication and abuse problems.
- **Overview**: 24-hour counts, per-agent activity and the latest errors.

It never writes to a mailbox. It uses only the server's open-source parts: the event webhook,
the JMAP and OAuth endpoints, and the web-application hosting. It uses no Enterprise-only APIs.
The design is in [`docs/design.md`](docs/design.md).

## How it works

```text
operator's browser ──▶ inWorkspace server: /console (the web app), /login and /auth/token (sign-in)
operator's browser ──bearer token──▶ console, api role ──▶ Postgres
                                       └── token introspection, JMAP read-only ──▶ inWorkspace server
inWorkspace server ──event webhook (HMAC-signed)──▶ console, ingest role ──▶ Postgres
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
  - It reads mailboxes over JMAP, using a master-user login as each agent.
- **ingest** accepts the server's signed event batches at `POST /api/ingest/events`, and stores
  them in Postgres.
  - It must be reachable from the mail server.
  - It holds no JMAP credentials.

`CONSOLE_ROLE=all` runs both roles in one process, for development.

Message bodies are never stored. The console keeps only events (addresses, IPs and ids), for
`EVENT_RETENTION_DAYS`.

## Configuration

| Variable | Role | Meaning |
| --- | --- | --- |
| `CONSOLE_ROLE` | both | `api`, `ingest` or `all`. |
| `DATABASE_URL` | both | Postgres connection string. |
| `WEBHOOK_SIGNING_KEY` | ingest | Shared HMAC key, at least 32 characters; must match the server's webhook. |
| `EVENT_RETENTION_DAYS` | ingest | Days to keep events; default 30. |
| `JMAP_URL` | api | Origin of the inWorkspace server, such as `https://mail.example.com`. The web app runs on it. |
| `JMAP_PRINCIPAL` | api | Login of the console principal. |
| `JMAP_PRINCIPAL_SECRET` | api | Its password. |
| `AGENT_DOMAINS` | api | Comma-separated domains whose accounts are agent mailboxes. |
| `AGENT_LOCALPART_PATTERN` | api | Optional regular expression the whole local part must match. |
| `PUBLIC_URL` | api | Origin at which browsers reach the api role, such as `https://console-api.example.com`. |
| `AUTH_MODE` | api | `server` (default) or `none`; see [Access](#access). |
| `OPERATOR_PERMISSION` | api | The server permission an operator needs; default `impersonate`. |
| `ALLOWED_ACCOUNTS` | api | Optional comma-separated logins that may use the console. |
| `OAUTH_CLIENT_ID` | api | The client id the web app signs in with; default `inworkspace-console`. |
| `DISPLAY_TIME_ZONE` | api | Optional IANA time zone for displayed times; default: the browser's. |
| `UI_DIST_DIR` | api | Directory of the built web app; default `ui-dist`. |
| `TRUSTED_PROXY_HOPS` | api | Proxies in front of the service that append the client's address to `X-Forwarded-For`; default 0. With 0 there is no per-client introspection limit. |
| `MAX_ACCESS_TOKEN_LIFETIME` | api | Seconds an access token can live at most; default 86400. Must be at least the server's access-token lifetime (default one hour), and below its refresh-token lifetime (default 30 days). |

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
once, and again only when the shell's settings change: the API's URL, the client id or the time
zone.

```bash
SERVER_URL=https://mail.example.com \
SERVER_ADMIN_USER=admin SERVER_ADMIN_SECRET=… \
CONSOLE_PRINCIPAL=console@agents.example.com CONSOLE_PRINCIPAL_SECRET=… \
WEBHOOK_URL=https://console-ingest.example.com/api/ingest/events WEBHOOK_SIGNING_KEY=… \
CONSOLE_URL=https://console-api.example.com \
node scripts/server-setup.mjs
```

**The principal**
- It gets `impersonate`, plus read access to accounts and domains.
- Impersonation gives full access to a mailbox, so the console enforces read-only access
  itself:
  - It only sends `Mailbox/get`, `Email/query`, `Email/get`, `Thread/get`, and the registry's
    `get` and `query` calls.
  - It only opens mailboxes from its agent directory.

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

**Reload.** Finally, the script asks the server to reload its settings. Some server versions
refuse the reload because of an unrelated setting. The script says so, and the webhook then
becomes active at the next restart.

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
| `npm run e2e` | A real inWorkspace server and Postgres in Docker. It sends mail over SMTP and an agent reply over JMAP, checks the web app at `/console`, and signs in through the server's OAuth endpoints. Then it calls the API with valid, invalid and unauthorized tokens. |

## Deployment

Build the image with `docker build -t inworkspace-console .` and run it twice, once per role,
against one Postgres database. The image listens on port 8080 and contains the built web app.

The reference deployment is Google Cloud Run:

- **api service**: `CONSOLE_ROLE=api`, publicly reachable (allow unauthenticated invocations).
  - The web app runs in operators' browsers on the mail server's origin and calls the service
    directly.
  - Every API request must carry an operator's access token.
  - Set `PUBLIC_URL` to the service's URL.
  - Set `TRUSTED_PROXY_HOPS=1`: Cloud Run appends the client's address to
    `X-Forwarded-For`.
  - Cap the instance count, for example `--max-instances 3`. Each instance has its own
    introspection budget, and every introspection runs as the console principal.
- **ingest service**: `CONSOLE_ROLE=ingest`, publicly reachable so the mail server can post to
  it. Every request must carry a valid signature.
- **Database**: Cloud SQL Postgres through the built-in connector:
  `DATABASE_URL=postgresql://<user>:<password>@/<database>?host=/cloudsql/<instance connection name>`.
- **Secrets**: supply `DATABASE_URL`, `WEBHOOK_SIGNING_KEY` and `JMAP_PRINCIPAL_SECRET` from a
  secret manager, never as plain environment values in source control.
- **Health**: Cloud Run reserves paths ending in `z`, so `/healthz` does not reach the app
  there. Its default TCP startup probe is enough, because a bad configuration makes the
  server exit.

A new console version needs only the deploy: the next page load picks up the new code. Run
[`scripts/server-setup.mjs`](#server-setup) again only when the shell's settings change.

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
- `console.view` records every conversation and thread view, with the operator's login, the
  agent and the thread.
- These report problems: `console.ingest.*`, `console.auth.unavailable`, `console.jmap.failed`,
  `console.api.failed` and `console.startup-failed`.

## Security notes

- **Every operator can read every agent mailbox.** Any user account in `AGENT_DOMAINS` that
  matches `AGENT_LOCALPART_PATTERN` is an agent. Keep human mailboxes out of those domains, or
  narrow the pattern.
- **The principal's password can impersonate any mailbox on the server**, not only agents. The
  console limits itself to directory agents and read-only methods, but the secret does not.
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
    answers 429.
  - If the server uses an OpenID Connect directory, add the API's egress address to the
    server's allowed IPs. See the design's sign-in section.
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
    at typical agent-mail volumes.
  - Rejections are logged as `console.ingest.*` errors; alert on them.
