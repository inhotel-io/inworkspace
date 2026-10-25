# inWorkspace Console — design

Status: approved for implementation, 2026-10-25. Revised the same day after a spike against
a real server (v0.16.16): event types, the event table and the overview counts now follow
what the server actually emits.

## Purpose

AI agents can work through ordinary inWorkspace mailboxes: guests and partners email an
agent's address, an agent runtime reads the mailbox over JMAP, and the agent's reply is
submitted from the same mailbox and filed in its Sent folder. The people responsible for
those agents need to see what the agents receive, what they answer, and what the mail
server is doing with that mail.

The console is a read-only web application for that oversight. It shows:

- **Conversations** — each agent's threads with its counterparts, read live from the
  agent's mailboxes, including what landed in Junk and which threads still await a reply.
- **Events** — what the mail server did: messages accepted, filed as junk, refused,
  queued, delivered or bounced, and authentication or abuse problems.
- **Overview** — counts for the last 24 hours and per-agent activity.

It is generic: it works with any inWorkspace (Stalwart-based) server and any set of agent
mailboxes. A deployment is configuration only.

## Scope

In scope: the three views above, an ingest endpoint for the server's event webhook, an
event store with retention, access control in front of the web views, and an audit log of
who viewed which conversation.

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
counterpart ──SMTP──▶ inWorkspace server ──event webhook (HMAC-signed)──▶ console (ingest role)
                          ▲    agent mailboxes                                     │
                          │                                                        ▼
                          └──── JMAP, read-only methods ──── console (web role) ◀── Postgres
operator ──identity-aware proxy──▶ console (web role)
```

One container image runs in one of two roles, chosen by `CONSOLE_ROLE`:

- **ingest** serves only `POST /api/ingest/events` and `GET /healthz`. It must be reachable
  from the mail server, holds the webhook signing key and database credentials, and holds
  no JMAP credentials.
- **web** serves the pages and their JSON endpoints. It sits behind an identity-aware proxy,
  holds the JMAP credentials and database credentials, and never accepts webhook posts.

`CONSOLE_ROLE=all` runs both in one process for local development.

The application is TypeScript on Next.js 16 (App Router, Cache Components), rendered on the
server. Every call to the mail server and the database happens on the server; the browser
never sees a credential. Postgres is the only state.

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
| `sanitize` | Turn an HTML email body into safe markup, plain text, and a sandboxed document. | — |
| `auth` | Resolve the signed-in operator from the proxy's signed assertion and check the allow-list. | `config` |
| `audit` | Write one structured log line for each conversation or thread view. | — |

## Event ingest

The server's event webhook posts JSON of the form `{"events": [event, ...]}`, where each
event has `id`, `createdAt` (RFC 3339, whole seconds), `type` (for example
`queue.authenticated-message-queued`) and `data`, a flat map whose keys include `from`,
`to` (a string or a list), `accountName`, `remoteIp`, `queueId`, `messageId`, `spanId`,
`details` and `code`. Span keys are merged into `data`. `queueId` and `spanId` are 64-bit
integers, so they are parsed as exact decimal strings. When a signing key is configured the
server adds `X-Signature`, the base64 HMAC-SHA256 of the body.

The ingest role:

1. rejects a body over 5 MB with 413, and a request without a valid signature with 401;
2. rejects a body that is not an event batch with 400;
3. normalizes every event and inserts the batch in one transaction, ignoring rows whose
   dedupe hash already exists;
4. answers 204 on success and 503 when the database is unavailable, so that the server
   retries the batch.

The server re-serializes a failed batch with fresh `id` values, so `id` cannot detect a
resend. The dedupe hash is SHA-256 over `createdAt`, `type` and the canonical JSON of
`data`.

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
  body, and the sanitized HTML body on request. Attachments are listed by name and size;
  they are not downloadable in this version.

HTML bodies are sanitized on the server and rendered in an `iframe` with an empty `sandbox`
attribute (no scripts, no same-origin) whose document carries a content security policy
that blocks every remote resource, so tracking pixels never load.

## Overview

Counts over the last 24 hours, from the event store:

| Count | Definition |
| --- | --- |
| Received | `message-ingest.ham` with an agent among the recipients |
| Filed as junk | `message-ingest.spam` with an agent among the recipients |
| Refused at SMTP | the subscribed inbound refusal types, when a recipient is in an agent domain or the event has no recipient |
| Replies sent | `queue.authenticated-message-queued` sent by an agent |
| Replies delivered | `delivery.dsn-success` sent by an agent |
| Delivery problems | `delivery.failed`, `delivery.dsn-temp-fail`, `delivery.dsn-perm-fail`, `delivery.double-bounce`, `delivery.rcpt-to-rejected`, `delivery.rcpt-to-failed`, `delivery.message-rejected` sent by an agent |
| Access problems | the subscribed `auth.*` and `security.*` types |

Below the counts: one row per agent with its received, junk, replies-sent and error counts
and its last activity, linking to its conversations; and the 20 most recent `error`
events.

## Events view

A table of events, newest first, filtered by type prefix, severity, agent and time window,
100 per page, with keyset paging. A live mode polls `GET /api/events?after=<id>` every three
seconds and prepends new rows. Each row expands to its full JSON.

## Access control and privacy

- Every request to the web role passes a gate (`proxy.ts`) that trusts only the identity in
  the proxy's signed assertion. With `AUTH_MODE=iap` it verifies the
  `x-goog-iap-jwt-assertion` JWT against Google's public keys and the configured audience,
  then checks the email against `ALLOWED_EMAILS` and `ALLOWED_DOMAINS`, and answers 403
  otherwise. Every page and API route repeats the check before it reads data.
- `AUTH_MODE=none` is for local development. It is refused when `NODE_ENV=production`
  unless `ALLOW_INSECURE_AUTH_NONE=1` is also set, which only local end-to-end runs do.
- Every conversation and thread view writes an audit line: operator, agent, thread id,
  time.
- Message bodies are never stored by the console. Event rows hold addresses, IPs and ids,
  and expire with retention.
- Responses carry a content security policy that blocks remote scripts, styles, images and
  framing, plus `Referrer-Policy: no-referrer`; data responses are `Cache-Control:
  no-store`.

## Configuration

| Variable | Role | Meaning |
| --- | --- | --- |
| `CONSOLE_ROLE` | both | `web`, `ingest` or `all`. |
| `DATABASE_URL` | both | Postgres connection string. |
| `WEBHOOK_SIGNING_KEY` | ingest | Shared HMAC key, at least 32 characters; must match the server's webhook. |
| `EVENT_RETENTION_DAYS` | ingest | Days to keep events; default 30. |
| `JMAP_URL` | web | Base URL of the inWorkspace server, such as `https://mail.example.com`. |
| `JMAP_PRINCIPAL` | web | Login of the console principal. |
| `JMAP_PRINCIPAL_SECRET` | web | Its password. |
| `AGENT_DOMAINS` | web | Comma-separated domains whose accounts are agent mailboxes. |
| `AGENT_LOCALPART_PATTERN` | web | Optional regular expression the whole local part must match. |
| `AUTH_MODE` | web | `iap` or `none`. |
| `IAP_AUDIENCE` | web | Expected audience of the proxy assertion. |
| `IAP_JWKS_URL` | web | Key set for the assertion; defaults to Google's IAP keys. |
| `ALLOWED_EMAILS`, `ALLOWED_DOMAINS` | web | Who may use the console once signed in. |
| `DISPLAY_TIME_ZONE` | web | IANA time zone for displayed times; default `UTC`. |

## Server setup

On the inWorkspace server, an administrator — or `console/scripts/server-setup.mjs`, which
does the same idempotently — :

1. creates a console principal — an individual account that receives no mail — with the
   `impersonate`, `sysAccountGet`, `sysAccountQuery`, `sysDomainGet` and `sysDomainQuery`
   permissions and a long random password;
2. creates a webhook pointing at `<ingest URL>/api/ingest/events`, with the signing key,
   level `info`, and the 39 subscribed types as an include list;
3. reloads settings. Some server versions fail to reload because of an unrelated default
   setting; the webhook then becomes active at the next restart.

## Error handling

- Ingest: 413 oversize, 401 bad signature, 400 malformed batch, 503 database unavailable,
  204 success. Errors are logged without the body.
- Web: a failed JMAP call renders an error state in the affected panel with the server's
  error type, and the rest of the page still renders. An unauthorized operator gets 403
  from the gate; an unknown agent or thread renders the not-found page (inside a streamed
  boundary, so the status stays 200) and no mailbox is opened.
- Startup fails when configuration is invalid or migrations cannot be applied.

## Testing

- Unit tests (Vitest) for `config`, `json`, `signature`, `eventTypes`, `normalize`,
  `ingest`, `jmap`, `directory`, `conversations`, `mailbox`, `sanitize` and `auth`, using
  event payloads and JMAP responses captured from a real server.
- Integration tests for `eventStore` against a real Postgres: migrations, dedupe, filters,
  counts, retention.
- An end-to-end run against a real inWorkspace server in Docker: create two agent
  mailboxes, a runtime principal, the console principal and the webhook; send messages over
  SMTP and reply from an agent mailbox over JMAP; then confirm the events arrive and the
  conversation renders with an inbound and an outbound message.

## Deployment

Any container platform works. The reference deployment is two Google Cloud Run services
from the same image — the web role with Identity-Aware Proxy enabled, the ingest role
publicly reachable and protected by the signature — sharing a Postgres database, with all
secrets supplied as environment variables from a secret manager. Organization-specific
values never belong in this repository.
