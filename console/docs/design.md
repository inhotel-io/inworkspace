# inWorkspace Console — design

Status: approved for implementation, 2026-10-25. Revised the same day after a spike against
a real server (v0.16.16): event types, the event table and the overview counts now follow
what the server actually emits.

Revised on 2026-10-26 (issue #8). The inWorkspace server now serves the console itself, at
`/console` next to its web admin, and operators sign in with their mail-server account. The
console service is now an API, and the Google identity modes and server-rendered pages are
gone.

## Purpose

AI agents can work through ordinary inWorkspace mailboxes: guests and partners email an
agent's address, an agent runtime reads the mailbox over JMAP, and the agent's reply is
submitted from the same mailbox and filed in its Sent folder. The people responsible for
those agents need to see what the agents receive, what they answer, and what the mail
server is doing with that mail.

The console is a read-only web application for that oversight. The inWorkspace server
serves it at `/console`, so operators find it on the same site as the web admin and sign
in with the same account. It shows:

- **Conversations** — each agent's threads with its counterparts, read live from the
  agent's mailboxes, including what landed in Junk and which threads still await a reply.
- **Events** — what the mail server did: messages accepted, filed as junk, refused,
  queued, delivered or bounced, and authentication or abuse problems.
- **Overview** — counts for the last 24 hours and per-agent activity.

It is generic: it works with any inWorkspace (Stalwart-based) server and any set of agent
mailboxes. A deployment is configuration only.

## Scope

In scope: the three views above, an ingest endpoint for the server's event webhook, an
event store with retention, sign-in with the server's own accounts, and an audit log of who
viewed which conversation.

Out of scope for this version:

- Any action on mail or agents — reply, delete, move, retry, block, take over. The
  console never writes to a mailbox.
- The server's own Enterprise telemetry (stored metrics, stored traces, live tracing).
  The console uses only the open-source event webhook and the JMAP protocol, and no code
  licensed only under `LicenseRef-SEL`.
- Events from the agent runtime itself (why an agent did or did not reply). A generic
  ingest API for runtime events is a possible follow-up.
- Metrics charts, multi-tenant permissions, and full-text search across conversations.

## Architecture

```text
operator's browser ──▶ inWorkspace server: /console (the web app), /login and /auth/token (sign-in)
operator's browser ──bearer token──▶ console, api role ──▶ Postgres
                                       └── token introspection, JMAP read-only ──▶ inWorkspace server
inWorkspace server ──event webhook (HMAC-signed)──▶ console, ingest role ──▶ Postgres
```

The **web app** is built from `ui/` with Vite, React, React Router and Tailwind CSS, and it has
two parts.

- **The shell** is what the server hosts, as one of its web applications: the same mechanism
  that serves the web admin at `/admin`.
  - It is a single page, holding this deployment's settings and a content security policy, plus
    the icon.
  - The server downloads it as a zip from a URL, keeps it in its blob store, and serves it under
    a path prefix, `/console` by default.
  - Unknown paths also get the page. The server rewrites the page's `<base href="/">` to the
    prefix, which is how the app learns its base path.
  - Because the server serves the page, the app signs in against its own origin.
- **The code** is served by the api role: the module `/ui/app/entry.js`, and the hashed files
  under `/ui/app/assets/`.
  - The shell loads the entry module from the API's origin. The module adds the stylesheets
    and imports the current build.
  - Browsers load module scripts with CORS, so these responses allow the server's origin.
  - The entry module is revalidated on every load. The hashed files are cached for good.

The server loads web applications only when it starts, or on its **Update apps** action
(`x:Action` `UpdateApps`), never when a record is written. Update apps also downloads every
application again from its `resourceUrl`, the web admin included.

Keeping the code out of the shell therefore matters:
- A new console version needs nothing on the server.
- The shell changes only when its settings or its page template do, and only then does it need
  a new record and an Update apps or a restart. Release notes say when a version changes the
  template.
- The app's routes live in the URL's hash, so no app path reaches the server's checks for
  banned paths. The callback `/console/oauth/callback` is the only real path.

One container image runs in one of two roles, chosen by `CONSOLE_ROLE`:

- **api** serves the JSON API under `/api/v1/`, and the web app's shell and code under `/ui/`.
  - Browsers call it from the server's origin, so it is publicly reachable.
  - Every API request must carry the operator's bearer token.
  - It holds the JMAP and database credentials, and never accepts webhook posts.
- **ingest** serves only `POST /api/ingest/events` and `GET /healthz`.
  - It must be reachable from the mail server.
  - It holds the webhook signing key and the database credentials, and no JMAP credentials.

`CONSOLE_ROLE=all` runs both in one process for local development.

The service is TypeScript on Next.js 16, with route handlers only. Every call to the mail
server's mailboxes and to the database happens in the service. The browser holds only the
operator's own tokens. Postgres is the only state.

## Components

Each unit has one purpose and is tested on its own.

| Unit | Responsibility | Depends on |
| --- | --- | --- |
| `config` | Parse and validate the environment once; fail fast on missing or invalid values. | — |
| `json` | Parse JSON while keeping integers above 2^53 as exact decimal strings. | — |
| `signature` | Verify `X-Signature`: base64 HMAC-SHA256 of the raw request body, compared in constant time. | — |
| `eventTypes` | The subscribed event types, their severity, and the groups the overview counts. | — |
| `normalize` | Turn one webhook event into an event row: type, time, severity, sender, recipients, addresses, remote IP, queue and message ids, dedupe hash, raw data. | `json`, `eventTypes` |
| `eventStore` | Migrations, idempotent batch insert, filtered queries, overview counts, per-agent activity, retention prune. | Postgres |
| `ingest` | The ingest request handler: size limit, signature, parse, store, prune. | `signature`, `normalize`, `eventStore` |
| `jmap` | Minimal JMAP client: session discovery and method calls, authenticated either as the console principal or as a mailbox through master-user login. Rejects any method not on its read-only allow-list. | — |
| `directory` | The agent mailboxes: accounts whose address is an agent address, with display names. Cached for five minutes. | `jmap` |
| `conversations` | Build thread summaries and thread views from JMAP results: direction of each message, junk, automated and awaiting-reply flags. | — |
| `mailbox` | Read one agent's mailbox through `jmap` and hand the results to `conversations`. | `jmap`, `conversations`, `sanitize` |
| `sanitize` | Turn an HTML email body into safe markup and plain text. | — |
| `emailDocument` | Wrap sanitized markup in a document for a sandboxed frame, with a policy that blocks every remote resource. Shared with the web app. | — |
| `auth` | Verify the operator's bearer token with the server: introspection, permissions and login. Check the required permission and the allow-list, and cache the result. | `config` |
| `cors` | Cross-origin headers for the server's origin, and preflight answers. | — |
| `apiRoute` | Wrap every API handler: role check, CORS, authentication, JSON errors, `no-store`. | `auth`, `cors` |
| `uiBundle` | Build the shell zip the server downloads: the page with the settings, and the icon. It gets a version from its content. Also load the app's build: the entry module, generated from Vite's manifest, and the assets. | `config` |
| `audit` | Write one structured log line for each conversation or thread view. | — |

The web app has its own units, all under `ui/src/`:

| Unit | Responsibility |
| --- | --- |
| `auth/pkce` | Code verifier, S256 challenge and state, from the browser's random source. |
| `auth/session` | Start sign-in, finish it on the callback, and keep the tokens for the tab. Refresh the access token, and sign out. |
| `api` | Call the console API with the access token. On 401, refresh once and retry, else sign in again. |
| `settings` | Read the runtime settings the bundle carries in `index.html`, and the base path. |
| pages and components | Overview, an agent's conversations, a thread, events, sign-in states. |

## Event ingest

The server's event webhook posts JSON of the form `{"events": [event, ...]}`, where each
event has `id`, `createdAt` (RFC 3339, whole seconds), `type` (for example
`queue.authenticated-message-queued`) and `data`, a flat map whose keys include `from`,
`to` (a string or a list), `accountName`, `remoteIp`, `queueId`, `messageId`, `spanId`,
`details` and `code`. Span keys are merged into `data`. `queueId` and `spanId` are 64-bit
integers, so they are parsed as exact decimal strings. When a signing key is configured the
server adds `X-Signature`, the base64 HMAC-SHA256 of the body.

The ingest role:

1. rejects a body over 25 MB with 413, and a request without a valid signature with 401;
2. rejects a body that is not an event batch with 400;
3. removes NUL characters from every key and string (Postgres cannot store them, and event
   values carry text from remote servers), normalizes every event and inserts the batch in
   one transaction, ignoring rows whose dedupe hash already exists;
4. if Postgres rejects a row as invalid data, stores the rest of the batch row by row and
   logs the rejected rows, so one bad row never blocks the stream;
5. answers 204 on success and 503 when the database is unavailable, so that the server
   retries the batch. A failing prune is logged and does not change the answer.

The server re-serializes a failed batch with fresh `id` values, so `id` cannot detect a
resend. The dedupe hash is SHA-256 over `createdAt`, `type` and the canonical JSON of
`data`. The server also folds a failed batch into every later one until its `discardAfter`,
which bounds how large a batch can grow after an outage. Every 413, 400 and 503 is logged.

### Subscribed event types

The server-side webhook includes only these 39 types, so that routine traffic — every
authentication, connection, timing sample and per-message authentication result — never
reaches the console:

- Mail stored: `message-ingest.ham`, `message-ingest.spam`, `message-ingest.duplicate`,
  `message-ingest.error`.
- Mail queued: `queue.message-queued` (accepted from SMTP),
  `queue.authenticated-message-queued` (submitted by an account, such as an agent reply),
  `queue.rescheduled`, `queue.dsn-queued`, `queue.quota-exceeded`,
  `queue.rate-limit-exceeded`.
- Delivery outcomes, one per recipient: `delivery.dsn-success`, `delivery.dsn-temp-fail`,
  `delivery.dsn-perm-fail`; and message or session failures: `delivery.failed`,
  `delivery.double-bounce`, `delivery.rcpt-to-rejected`, `delivery.rcpt-to-failed`,
  `delivery.message-rejected`, `delivery.mail-from-rejected`, `delivery.connect-error`,
  `delivery.auth-failed`, `delivery.greeting-failed`, `delivery.start-tls-error`.
- Inbound mail refused: `smtp.mailbox-does-not-exist`, `smtp.relay-not-allowed`,
  `smtp.rcpt-to-greylisted`, `smtp.message-too-large`, `smtp.rate-limit-exceeded`,
  `smtp.loop-detected`, `smtp.message-parse-failed`; and the sender's domain failing DMARC:
  `smtp.dmarc-fail`.
- Access problems: `auth.failed`, `auth.too-many-attempts`, `security.authentication-ban`,
  `security.abuse-ban`, `security.ip-blocked`, `security.scan-ban`,
  `security.loiter-ban`, `security.unauthorized`.

Deliberately excluded: `delivery.delivered` and `delivery.completed`, which repeat what
`delivery.dsn-success` says; `message-ingest.jmap-append`, which carries no addresses; and
`smtp.spf-from-fail` and `smtp.dkim-fail`, which fire for most unsigned mail.

Severity is derived from the type, because the webhook does not send the level:

- `error` — mail the server accepted or tried to deliver has definitely failed:
  `message-ingest.error`, `queue.quota-exceeded`, `delivery.failed`,
  `delivery.dsn-perm-fail`, `delivery.double-bounce`, `delivery.rcpt-to-rejected`,
  `delivery.rcpt-to-failed`, `delivery.message-rejected`, `delivery.mail-from-rejected`,
  `delivery.auth-failed`.
- `warning` — a deviation worth a look, usually retried or refused at the door:
  `message-ingest.spam`, `message-ingest.duplicate`, `queue.rescheduled`,
  `queue.dsn-queued`, `queue.rate-limit-exceeded`, `delivery.dsn-temp-fail`,
  `delivery.connect-error`, `delivery.greeting-failed`, `delivery.start-tls-error`, and
  every subscribed `smtp.*`, `auth.*` and `security.*` type.
- `info` — every other type, including any type not listed in this document.

An **agent address** is an address whose domain is in `AGENT_DOMAINS` and whose local part
matches `AGENT_LOCALPART_PATTERN` when it is set, other than the console principal. An
**agent** is a user account on the server whose address is an agent address.

## Data model

```sql
create table events (
  id          bigserial primary key,
  dedupe_hash bytea       not null unique,
  event_at    timestamptz not null,
  received_at timestamptz not null default now(),
  type        text        not null,
  severity    text        not null check (severity in ('info', 'warning', 'error')),
  sender      text,
  recipients  text[]      not null default '{}',
  addresses   text[]      not null default '{}',
  remote_ip   text,
  queue_id    text,
  message_id  text,
  data        jsonb       not null
);
create index events_event_at_idx  on events (event_at desc);
create index events_type_idx      on events (type, event_at desc);
create index events_sender_idx    on events (sender, event_at desc);
create index events_addresses_idx on events using gin (addresses);
```

`sender` is the lowercased `from` when it is an email address (a bounce's `<>` is not).
`recipients` holds the lowercased email addresses in `to`. `addresses` holds `sender`,
`recipients` and `accountName`, so that "events for this agent" is one indexed containment
query. Migrations are applied in order at startup, under an advisory lock, and recorded in
`schema_migrations`.

Migration `002_events_account` adds `account_id bigint` (indexed where present): the
server's numeric id of the account a `message-ingest.*` event stored the message in. Those
events list every local recipient of the delivery in `to` — one message to two agents yields
two events, each naming both — so counting by recipient would count it twice for each agent.
The directory reads each agent's account id from the registry, whose ids are the same numbers
written in the server's base32 alphabet `abcdefghijklmnopqrstuvwxyz792013`.

Retention: rows older than `EVENT_RETENTION_DAYS` (default 30) are deleted at most once per
hour per instance, during ingest requests.

## Conversations

Nothing is copied. Each view reads the agent's mailbox through JMAP, authenticated with the
master-user form `<agent address>%<console principal>` and the console principal's
password. Only agents from the directory can be opened, so the console cannot be pointed at
any other mailbox on the server.

The principal needs the `Impersonate` permission, so a successful impersonation gives full
access to the mailbox; the console therefore enforces read-only access itself: the `jmap`
unit only sends `Mailbox/get`, `Email/query`, `Email/get` and `Thread/get` for mailboxes,
plus `x:Domain/query`, `x:Domain/get`, `x:Account/query` and `x:Account/get` for the
directory, and refuses any other method before a request is made. Reading never changes
keywords, so no message becomes seen.

- **Thread list**: `Email/query` across every mailbox except Trash and Drafts, newest
  first, collapsed by thread, 50 per page; then `Email/get` and `Thread/get`. Each row
  shows the subject, the counterpart, the message count, the last activity and a status:
  *junk* when the newest message is inbound and in Junk or marked `$junk`; *automated* when
  the newest message is inbound and machine-generated (an `Auto-Submitted` header other
  than `no`, or a `mailer-daemon` or `postmaster` sender); *awaiting reply* when the newest
  message is inbound and neither junk nor automated; *answered* when it is outbound.
- **Thread view**: every message of the thread in time order, marked inbound or outbound
  (outbound when it is in Sent or sent by the agent), with sender, recipients, date, text
  body, and the sanitized HTML body on request. A message in Drafts is labelled as a draft
  that was never sent, and a message in Trash is marked as such. Attachments are listed by
  name and size; they are not downloadable in this version.

HTML bodies are sanitized by the API. The web app renders them in an `iframe` with an empty
`sandbox` attribute (no scripts, no same-origin), whose document carries a content security
policy that blocks every remote resource, so tracking pixels never load.

## Overview

Counts over the last 24 hours, from the event store:

| Count | Definition |
| --- | --- |
| Received | `message-ingest.ham` stored in an agent's account |
| Filed as junk | `message-ingest.spam` stored in an agent's account |
| Refused at SMTP | the subscribed inbound refusal types, when a recipient is in an agent domain or the event has no recipient |
| Replies sent | `queue.authenticated-message-queued` sent by an agent |
| Replies delivered | `delivery.dsn-success` sent by an agent |
| Delivery problems | `delivery.failed`, `delivery.dsn-temp-fail`, `delivery.dsn-perm-fail`, `delivery.double-bounce`, `delivery.rcpt-to-rejected`, `delivery.rcpt-to-failed`, `delivery.message-rejected` sent by an agent |
| Access problems | the subscribed `auth.*` and `security.*` types |

Below the counts: one row per agent with its received, junk, replies-sent and error counts
and its last activity, linking to its conversations; and the 20 most recent `error`
events. When the agent directory cannot be read, the counts that depend on it show "—"
instead of zero, next to an error panel.

## Events view

A table of events, newest first, filtered by type prefix, severity, agent and time window,
100 per page, with keyset paging. A live mode polls `GET /api/v1/events?after=<id>` every
three seconds and prepends new rows. Each row expands to its full JSON.

## API

Every endpoint is `GET` under `/api/v1/`, answers JSON with `Cache-Control: no-store`, and
needs a verified operator.

| Path | Answer |
| --- | --- |
| `me` | The operator's login. |
| `overview` | The 24-hour counts, the agents with their activity (or the directory error), and the 20 latest errors. |
| `agents` | The agent directory: address and name. |
| `agents/{address}/threads?position=` | One page of the agent's threads. 404 for an address outside the directory. |
| `agents/{address}/threads/{threadId}` | Every message of the thread. 404 when the thread is not in that mailbox. |
| `events?type=&severity=&agent=&window=&before=&after=` | Events, newest first. `before` pages back, `after` returns only newer events for live mode. |

Errors are `{"error": {"code", "message"}}`:

| Status | Meaning |
| --- | --- |
| 400 | A bad parameter. |
| 401 | Sign-in needed, or the token is expired or invalid. |
| 403 | The account may not use the console. |
| 404 | An unknown agent or thread. |
| 429 | Too many token checks. |
| 502 | A mailbox read failed at the server. |
| 503 | The server could not check the token. |

The web app's files, none of which needs a token:

| Path | Answer |
| --- | --- |
| `GET /ui/manifest` | Names the current shell. |
| `GET /ui/console-<version>.zip` | The shell. Any version name returns the current shell, so the server never gets a 404 when it fetches again. |
| `GET /ui/app/entry.js` | The entry module. `no-cache`, with CORS for the server's origin. |
| `GET /ui/app/assets/<file>` | Only the files the build produced. Cached for a year as immutable, with CORS for the server's origin. |

## Sign-in and access control

**Sign-in** happens entirely at the server. Setup registers a public OAuth client,
`inworkspace-console` by default, whose only redirect URI is `<server>/console/oauth/callback`.
1. The web app redirects to the server's `/login` with that client id, a PKCE S256 challenge
   and a random state.
2. The server's own sign-in page asks for the password, and MFA when the account has it, then
   returns to the callback with a code.
3. The app checks the state and exchanges the code at `/auth/token`.
4. It keeps the access and refresh tokens in `sessionStorage`, so they belong to one tab and
   go when the tab closes.
5. It refreshes the access token when it expires. By default an access token lasts one hour
   and a refresh token 30 days.

Signing out discards the tokens in the tab. The server has no revocation endpoint, so a
discarded token stays valid at the server until it expires: one hour for an access token, 30
days for a refresh token. Changing the account's password revokes them all.

The OAuth client's redirect URI is enforced only when the server requires registered clients.
That is off by default, and accounts with the `oAuthClientOverride` permission bypass it.

**Every API request** carries `Authorization: Bearer <access token>`. The api role:

1. accepts only a well-formed bearer token: 16 to 1,000 characters of `A–Z a–z 0–9 . _ -`.
   - The server's tokens are `sw1.` followed by base64url.
   - None of those characters grows in a form body, so the token always fits the server's
     1,024-byte introspection form.
   - Anything else is 401, and the server is not asked.
2. answers from a cache keyed by the token's SHA-256.
   - The cache holds verified tokens and refused ones alike, for 60 seconds.
   - A verified token is held for less when it expires sooner.
3. checks each token once at a time. Requests that arrive together with the same token share
   one check.
4. checks the token by introspection, `POST /auth/introspect` at the server, authenticating as
   the console principal.
   - An invalid or expired token is therefore never presented to the server as a failed login,
     so the server's authentication ban cannot be turned against the API's own address.
   - Introspection is limited to 120 per minute per instance, and to 20 per minute per client.
     Beyond the limit the API answers 429.
   - Clients are told apart by the `X-Forwarded-For` entry that `TRUSTED_PROXY_HOPS` trusted
     proxies appended. IPv6 clients are counted by their /64.
   - A token that already passed is checked again without counting, until it expires. A flood
     of strangers' tokens can therefore only delay new sign-ins, never end a working session.
5. refuses an active token that lives longer than `MAX_ACCESS_TOKEN_LIFETIME`, one day by
   default, without presenting it to the server.
   - The server's introspection reports every unexpired token it issued as active, including
     refresh tokens and calendar reply links.
   - The grant type is sealed inside the token. Only the lifetime, `exp` minus `iat`, tells an
     access token (one hour by default) from those (30 and 90 days by default).
6. reads the account's permissions from `GET /api/account`, then its login from
   `GET /jmap/session`, both with the operator's token.
   - The reads run one after the other, because the server allows each account four
     concurrent requests.
   - When the server says the account is at that limit (a 400 with the problem type
     `urn:ietf:params:jmap:error:limit`), the API retries once after 300 ms. It does the same
     for introspection, whose requests share the principal's limit.
   - A 429 is a per-minute limit, so the API reports it as unavailable instead.
7. requires the permission `OPERATOR_PERMISSION`, `impersonate` by default, and, when
   `ALLOWED_ACCOUNTS` is set, a login on that list. Otherwise it answers 403.
   - The default admits only accounts that could already read any mailbox through
     impersonation, so the console gives nobody new access.
   - The server's built-in recovery administrator has every permission.

**If the server uses an OpenID Connect directory**, it checks a bearer token with the identity
provider first, and counts a refusal as a failed login.
- Put the API's egress address on the server's allowed IPs (an `x:AllowedIp` record), so that
  no ban or rate limit applies to it.
- That needs a static egress address, such as Cloud NAT or Direct VPC egress with a reserved IP.
  Cloud Run's default egress addresses change, and other Google Cloud customers share them.
- With the built-in directory, step 5 keeps every token the API presents valid.

**Cross-origin access.** API responses allow exactly the server's origin, taken from
`JMAP_URL`.
- They allow the method `GET` and the header `Authorization`; preflights are cached for ten
  minutes.
- No cookies are used, so cross-site request forgery does not apply.

**The shell page** carries a content security policy in a meta tag.
- Scripts and styles come only from `<console API>/ui/app/`, not from the rest of that
  origin.
- Calls go only to the page's own origin and the console API.
- Images are only the page's own or inline.
- Email frames inherit that policy and add their own.
- A meta policy cannot forbid framing. Add `Content-Security-Policy: frame-ancestors 'self'`
  through the server's own response headers (`x:Http` `responseHeaders`) to cover `/console`
  and `/admin` alike.

**Trust.** The API receives each operator's access token on every request. Those tokens are
not limited to the console: they carry the account's full rights. The API also serves the code
that runs on the server's origin. Treat the api service, its runtime and its logs like the
server's own administration.

**Other controls.**
- `AUTH_MODE=none` is for local development only. It is refused when
  `NODE_ENV=production` unless `ALLOW_INSECURE_AUTH_NONE=1` is also set.
- Every conversation and thread view writes an audit line: the operator's login, the agent,
  the thread id and the time.
- The console never stores message bodies. Event rows hold addresses, IPs and ids, and
  expire with retention.
- API responses carry `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff` and
  `Cache-Control: no-store`.

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
| `AUTH_MODE` | api | `server` (default) or `none`. |
| `OPERATOR_PERMISSION` | api | The server permission an operator needs; default `impersonate`. |
| `ALLOWED_ACCOUNTS` | api | Optional comma-separated logins that may use the console. |
| `OAUTH_CLIENT_ID` | api | The client id the web app signs in with; default `inworkspace-console`. |
| `DISPLAY_TIME_ZONE` | api | Optional IANA time zone for displayed times; default: the browser's. |
| `UI_DIST_DIR` | api | Directory of the built web app; default `ui-dist`. |
| `TRUSTED_PROXY_HOPS` | api | Proxies in front of the service that append the client's address to `X-Forwarded-For`; default 0, which gives no per-client introspection limit. |
| `MAX_ACCESS_TOKEN_LIFETIME` | api | Seconds an access token can live at most; default 86400, at most 604800. It must be at least the server's access-token lifetime, and below its refresh-token lifetime. |

## Server setup

On the inWorkspace server, an administrator — or `console/scripts/server-setup.mjs`, which
does the same idempotently — :

1. creates a console principal — an individual account that receives no mail — with the
   `impersonate`, `sysAccountGet`, `sysAccountQuery`, `sysDomainGet` and `sysDomainQuery`
   permissions and a long random password;
2. creates a webhook pointing at `<ingest URL>/api/ingest/events`, with the signing key,
   level `info`, and the 39 subscribed types as an include list;
3. registers the public OAuth client, with no secret and the single redirect URI
   `<server>/console/oauth/callback`;
4. registers the web application at `/console`, pointing at the shell that the api role's
   `/ui/manifest` names. The URL uses the address the server uses to reach the api role.
   - The server keeps one downloaded shell per application record, so a new shell gets a new
     record. The script creates the new record first, then deletes the old one.
   - The script only touches records whose only prefix is the console's.
   - A new record is live only after the server restarts or runs Update apps. With
     `UPDATE_APPS=1` the script runs Update apps. Otherwise it says the step is needed.
   - A restart is the safer default, because it downloads only applications with no stored
     copy.
   - Update apps first deletes every stored copy, the web admin's included, then downloads each
     again. An application whose download fails stays offline until a later update or restart
     succeeds.
   - **Before running Update apps, check the web admin's `resourceUrl`.** If it follows
     `releases/latest`, the server downloads whatever web admin is newest, which may need a
     newer server. Point it at the release the server already serves.
5. reloads settings. Some server versions fail to reload because of an unrelated default
   setting; the webhook then becomes active at the next restart.

## Error handling

- Ingest: 413 oversize, 401 bad signature, 400 malformed batch, 503 database unavailable,
  204 success. Every rejection is logged with its size or reason, never the body; rows
  Postgres refuses are logged and skipped.
- API: the statuses listed under [API](#api). A failed JMAP call is a 502 for that request
  only. The overview still answers when the directory fails, with the error in place of the
  agent list. An unknown agent or thread is a 404, and no mailbox is opened.
- Web app:
  - A failed request shows an error panel where its data would be, and the rest of the
    page still renders.
  - A 401 refreshes the access token once and retries, then starts sign-in again.
  - A 403 explains which permission the account lacks, and offers to sign out.
- Startup fails when the configuration is invalid, the migrations cannot be applied, or (in
  the api role) the built web app is missing.

## Testing

- Unit tests (Vitest), using event payloads and JMAP responses captured from a real server:
  - for `config`, `json`, `signature`, `eventTypes`, `normalize`, `ingest`, `jmap`,
    `directory`, `conversations`, `mailbox` and `sanitize`;
  - for `auth`, `cors`, `apiRoute` and `uiBundle`;
  - for the web app's `auth/pkce`, `auth/session`, `api` and `settings`.
- Integration tests for `eventStore` against a real Postgres: migrations, dedupe, filters,
  counts, retention.
- An end-to-end run against a real inWorkspace server in Docker:
  1. Create two agent mailboxes, a runtime principal, a plain user, the console principal
     and the webhook.
  2. Register the OAuth client and the web application. Confirm that the server ignores the
     record until Update apps, then serves the shell at `/console`. Confirm that the entry
     module and an asset load from the API with CORS for the server's origin.
  3. Send messages over SMTP and reply from an agent mailbox over JMAP.
  4. Confirm that the shell is also served on the callback path, and that registering the same
     shell again changes nothing.
  5. Sign in as the recovery administrator through the server's real `/api/auth` and
     `/auth/token` endpoints.
  6. Confirm that the API returns the conversation with an inbound and an outbound message,
     and the events.
  7. Confirm that the API refuses a missing or invalid token with 401 and the plain user with
     403, and answers preflights only for the server's origin.

## Deployment

Any container platform works. The reference deployment is two Google Cloud Run services
from the same image, sharing a Postgres database:
- The api role is publicly reachable; every API request needs a bearer token.
- The ingest role is publicly reachable and protected by the signature.

All secrets are supplied as environment variables from a secret manager.

A new console version needs only the deploy: the next page load picks up the new code. The
setup script needs to run again only when the shell changes: its settings (the API's URL, the
client id or the time zone) or its page template. That needs one restart or Update apps.

Organization-specific values never belong in this repository.

## The web admin's Dashboard, Live Tracing and History

Added in 0.3 (issue #10). On the community edition, the web admin locks three screens:
- the Dashboard;
- Observability → Live Tracing;
- Emails → History.

The screens themselves are open source (the web UI is `AGPL-3.0-only OR LicenseRef-SEL`). Their
data comes from Enterprise-only server code:
- `/api/live/metrics` and `/api/live/tracing`, two event streams;
- the `x:Metric` and `x:Trace` objects, the stored history.

The console replaces the data, not the screens.

**Collecting the data.** Only what the community edition exports is used.
- **Metrics: the OpenTelemetry push, not Prometheus.**
  - The push comes from the server, like the event webhook, so nothing is opened on the server
    and no scheduler polls it.
  - Its metric names are the server's own ids, which the dashboards name.
  - Counters and histograms arrive as cumulative values since the server started, and the
    console stores what each push added. A different start time, or a value that went down,
    means a restart.
  - A series first seen long after its start becomes a baseline only, so enabling the push
    does not show everything since the last restart as one spike.
  - The server schedules its first push when its task scheduler starts. A settings reload sets
    the push up but schedules nothing, so pushes begin at the next restart.
- **Histograms keep running totals.** The dashboards take the difference between consecutive
  samples themselves.
  - So the console keeps totals that only grow, even across restarts.
  - When it merges samples into the about 360 steps a window shows, it keeps the first and last
    total of each step, plus the last one before the window, so no increase is lost.
- **The queue's size** is not in the community export. The ingest counts it with each push,
  through an app password on the console principal that may only sign in and count the queue.
  - The server makes app passwords and shows the secret once, and only to the account itself,
    so the setup script signs in as the principal to make it.
- **Traces come from a second webhook.** The server's webhooks ignore their level and send
  exactly the events they list, so the list is generated from the server's event table:
  - every event at `info` level or above;
  - the debug-level events of SMTP sessions, delivery attempts and authentication results;
  - no trace-level events.

  An inbound trace is an SMTP session span, and an outbound trace a delivery attempt span. The
  server's own `x:Trace` lists are keyed by the same two starting events.
  - A trace's sender, recipients and size come from the events that describe the delivery: an
    attempt's first event, or a session's envelope and the messages it queued.
  - Messages the server makes along the way, such as a bounce, are not counted.
- **Derived latencies.** The community export has no histograms for message ingest, indexing or
  DNS lookups. They are derived from the `elapsed` value of the same events the server's own
  histograms observe:
  - ingest: `message-ingest.ham`, `spam`, `imap-append` and `jmap-append`;
  - indexing: `message-ingest.search-index`;
  - DNS lookups: `delivery.mx-lookup`, `ip-lookup` and `null-mx`, and the `tls-rpt.*`, `mta-sts.*`
    and `dane.*` lookups, when they took time.
- **Not available:** the data and blob store latencies. They come from debug-level events on every
  read and write, too many to send. The API names them as unavailable, and the dashboards say so
  instead of showing zero.

**Serving the data.** `/api/v1/insights/` answers in the Enterprise endpoints' shapes, so the web
UI's own pages need only to be pointed at it.
- `metrics` serves history and `metrics/live` current gauges.
- `jmap` serves `x:Trace/query` and `x:Trace/get`, with the History lists' filters, both kinds of
  paging and result references.
- `tracing` serves events after a cursor.
- **Polling, not streams.** Live Tracing polls every two seconds and live cards every 30.
  - That needs no long-lived connections on Cloud Run.
  - It carries the administrator's token in a header, like every other request.
  - A feed rides out failures that may pass (the network, a rate limit, a server error) by
    waiting longer each time, and keeps its cursor, so no event is shown twice. A refusal, such
    as a missing permission, is shown at once.
  - Each answer is one statement, so its events and its cursor come from the same snapshot.
    Trace batches are stored one at a time, so event ids follow the order batches commit in, and
    a feed past a cursor never misses one.
- **Permissions.** Each route needs the permission the server would require: `liveMetrics`,
  `sysMetricQuery` and `sysMetricGet`, `liveTracing`, `sysTraceQuery` and `sysTraceGet`.
  - The verifier refuses an account with none of the permissions any route accepts, so ordinary
    accounts never count as sessions that passed, and stay within the introspection budget.
  - It returns the account's permissions, and each route checks its own.
  - The console's own routes still need `OPERATOR_PERMISSION`.

**The patched web admin** (`webadmin/`) is upstream web UI v1.0.5 with an overlay and four
patches.
- The three screens are no longer Enterprise features, and the trace lists are read-only.
- The Dashboard's stores, Live Tracing and `x:Trace` calls go to the console. Everything else is
  unchanged.
- It finds the API on the console's page at `/console/`, so the build has no deployment settings
  and can be a public release asset.
- It links to its source, as the AGPL requires of a modified version used over a network.

`scripts/webadmin.mjs` switches the server's `/admin` application to a build, or back to
upstream's.
- It checks the zip first.
- If the server does not serve the new build after Update apps, it puts the previous one back.

The alternatives were weighed and set aside:
- **Running a fork of the server** that implements those endpoints would mean replacing the
  production mail server, and re-implementing code whose Enterprise version sits next to it.
- **Showing the screens in the console** instead would have meant a second place to look; the
  web admin is where administrators already work.
