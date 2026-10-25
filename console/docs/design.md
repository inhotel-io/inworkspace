# inWorkspace Console — design

Status: approved for implementation, 2026-10-25.

## Purpose

AI agents can work through ordinary inWorkspace mailboxes: guests and partners email an
agent's address, an agent runtime reads the mailbox over JMAP, and the agent's reply is
submitted from the same mailbox and filed in its Sent folder. The people responsible for
those agents need to see what the agents receive, what they answer, and what the mail
server is doing with that mail.

The console is a read-only web application for that oversight. It shows:

- **Conversations** — each agent's threads with its counterparts, read live from the
  agent's mailboxes, including what landed in Junk and which threads still await a reply.
- **Events** — what the mail server did: messages accepted, filed as junk, rejected,
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

The application is TypeScript on Next.js (App Router), with server-side rendering. Every
call to the mail server and the database happens on the server; the browser never sees a
credential. Postgres is the only state.

## Components

Each unit has one purpose and is tested on its own.

| Unit | Responsibility | Depends on |
| --- | --- | --- |
| `config` | Parse and validate the environment once; fail fast on missing or invalid values. | — |
| `signature` | Verify `X-Signature`: base64 HMAC-SHA256 of the raw request body, compared in constant time. | `config` |
| `normalize` | Turn one webhook event into an event row: type, time, severity, addresses, remote IP, queue and message ids, dedupe hash, raw JSON. | — |
| `eventStore` | Migrations, idempotent batch insert, filtered queries, overview counts, retention prune. | Postgres |
| `jmap` | Minimal JMAP client: session discovery and method calls, authenticated either as the console principal or as a mailbox through master-user login. Rejects any method not on its read-only allow-list. | `config` |
| `directory` | The list of agent mailboxes: the accounts whose address is an agent address (defined under Event ingest), with display names. Cached for five minutes. | `jmap` |
| `conversations` | Build thread summaries and thread views from JMAP results: direction of each message, junk flag, awaiting-reply flag. | — |
| `sanitize` | Turn an HTML email body into safe markup: no scripts, no event handlers, no forms, no remote resources. | — |
| `auth` | Resolve the signed-in operator from the proxy's signed assertion and check the allow-list. | `config` |
| `audit` | Write one structured log line for each conversation or thread view. | `auth` |

## Event ingest

The server's event webhook posts JSON of the form `{"events": [event, ...]}`, where each
event has `id`, `createdAt` (RFC 3339), `type` (for example `delivery.completed`) and
`data` (a map of keys such as `from`, `to`, `accountName`, `remoteIp`, `queueId`,
`messageId`, `spanId`, `reason`, `details`, `code`). When a signing key is configured the
server adds `X-Signature`, the base64 HMAC-SHA256 of the body.

The ingest role:

1. rejects a request without a valid signature with 401, and a body over 5 MB with 413;
2. rejects a body that is not an event batch with 400;
3. normalizes every event and inserts the batch in one transaction, ignoring rows whose
   dedupe hash already exists;
4. answers 204 on success and 503 when the database is unavailable, so that the server
   retries the batch.

The server re-serializes a failed batch with fresh `id` values, so `id` cannot detect a
resend. The dedupe hash is SHA-256 over `createdAt`, `type` and the canonical JSON of
`data`.

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
matches `AGENT_LOCALPART_PATTERN` when it is set, other than the console principal.

### Subscribed event types

The server-side webhook includes only these types, so that routine traffic — every
authentication, connection and timing sample — never reaches the console:

- Mail accepted or stored: `message-ingest.ham`, `message-ingest.spam`,
  `message-ingest.duplicate`, `message-ingest.error`, `message-ingest.jmap-append`.
- Mail queued: `queue.message-queued`, `queue.authenticated-message-queued`,
  `queue.rescheduled`, `queue.dsn-queued`, `queue.quota-exceeded`,
  `queue.rate-limit-exceeded`.
- Delivery outcomes: `delivery.delivered`, `delivery.completed`, `delivery.failed`,
  `delivery.dsn-success`, `delivery.dsn-temp-fail`, `delivery.dsn-perm-fail`,
  `delivery.double-bounce`, `delivery.rcpt-to-rejected`, `delivery.rcpt-to-failed`,
  `delivery.message-rejected`, `delivery.mail-from-rejected`, `delivery.connect-error`,
  `delivery.auth-failed`, `delivery.greeting-failed`, `delivery.start-tls-error`.
- Inbound mail refused: `smtp.mailbox-does-not-exist`, `smtp.relay-not-allowed`,
  `smtp.rcpt-to-greylisted`, `smtp.message-too-large`, `smtp.rate-limit-exceeded`,
  `smtp.dmarc-fail`, `smtp.spf-from-fail`, `smtp.dkim-fail`, `smtp.loop-detected`,
  `smtp.message-parse-failed`.
- Access problems: `auth.failed`, `auth.too-many-attempts`, `security.authentication-ban`,
  `security.abuse-ban`, `security.ip-blocked`, `security.scan-ban`,
  `security.loiter-ban`, `security.unauthorized`.

## Data model

```sql
create table events (
  id          bigserial primary key,
  dedupe_hash bytea       not null unique,
  event_at    timestamptz not null,
  received_at timestamptz not null default now(),
  type        text        not null,
  severity    text        not null check (severity in ('info', 'warning', 'error')),
  addresses   text[]      not null default '{}',
  remote_ip   text,
  queue_id    text,
  message_id  text,
  data        jsonb       not null
);
create index events_event_at_idx  on events (event_at desc);
create index events_type_idx      on events (type, event_at desc);
create index events_addresses_idx on events using gin (addresses);
```

`addresses` holds every email address found in `from`, `to` and `accountName`, lowercased,
so that "events for this agent" is one indexed containment query. Migrations are plain SQL
files applied in order at startup and recorded in `schema_migrations`.

Retention: rows older than `EVENT_RETENTION_DAYS` (default 30) are deleted at most once per
hour, during ingest requests.

## Conversations

Nothing is copied. Each view reads the agent's mailbox through JMAP, authenticated with the
master-user form `<agent address>%<console principal>` and the console principal's
password. The principal needs the `Impersonate` permission, so a successful impersonation
gives full access to the mailbox; the console therefore enforces read-only access itself:
the `jmap` unit only sends `Mailbox/get`, `Email/query`, `Email/get`, `Thread/get` and
`Identity/get` for mailboxes, plus registry `get` and `query` calls for the directory, and
refuses any other method. Reading never changes keywords, so no message becomes seen.

- **Thread list**: `Email/query` across all mailboxes, newest first, collapsed by thread,
  50 per page; then `Email/get` and `Thread/get`. Each row shows the subject, the
  counterpart, the message count, the last activity and two flags: *junk* when the thread's
  newest inbound message is in the Junk mailbox, *awaiting reply* when the newest message in
  the thread is inbound and not junk.
- **Thread view**: every message of the thread in time order, marked inbound (in Inbox or
  Junk, or not sent by the agent) or outbound (in Sent, or sent by the agent), with sender,
  recipients, date, text body, and the sanitized HTML body on request. Attachments are
  listed by name and size; they are not downloadable in this version.

HTML bodies are sanitized on the server and rendered in a sandboxed `iframe` whose content
security policy blocks scripts and all remote resources, so tracking pixels never load.

## Overview

Counts over the last 24 hours, from the event store, restricted to events whose
`addresses` include an agent address:

| Count | Event types |
| --- | --- |
| Received | `message-ingest.ham` |
| Filed as junk | `message-ingest.spam` |
| Refused at SMTP | the subscribed `smtp.*` types |
| Replies queued | `queue.authenticated-message-queued`, `queue.message-queued` sent by an agent |
| Delivered | `delivery.delivered` |
| Delivery problems | `delivery.failed`, `delivery.dsn-temp-fail`, `delivery.dsn-perm-fail`, `delivery.double-bounce`, `delivery.rcpt-to-rejected`, `delivery.rcpt-to-failed`, `delivery.message-rejected` |
| Access problems | the subscribed `auth.*` and `security.*` types (not restricted to agents) |

Below the counts: one row per agent with its received, replies-queued and problem counts
and its last activity, linking to its conversations; and the 20 most recent `error`
events.

## Events view

A table of events, newest first, filtered by type prefix, severity, agent and time range,
100 per page. A live mode polls `GET /api/events?after=<id>` every three seconds and
prepends new rows. Each row expands to its full JSON.

## Access control and privacy

- The web role trusts only the identity in the proxy's signed assertion. With
  `AUTH_MODE=iap` it verifies the `x-goog-iap-jwt-assertion` JWT against Google's public
  keys and the configured audience, then checks the email against `ALLOWED_EMAILS` and
  `ALLOWED_DOMAINS`. Every page and API route performs this check; a layout-only check is
  not enough under the App Router.
- `AUTH_MODE=none` is for local development and is refused when `NODE_ENV=production`.
- Every conversation and thread view writes an audit line: operator, agent, thread id,
  time.
- Message bodies are never stored by the console. Event rows hold addresses, IPs and ids,
  and expire with retention.
- Responses carry a strict content security policy and `Cache-Control: no-store`.

## Configuration

| Variable | Role | Meaning |
| --- | --- | --- |
| `CONSOLE_ROLE` | both | `web`, `ingest` or `all`. |
| `DATABASE_URL` | both | Postgres connection string. |
| `WEBHOOK_SIGNING_KEY` | ingest | Shared HMAC key; must match the server's webhook. |
| `EVENT_RETENTION_DAYS` | ingest | Days to keep events; default 30. |
| `JMAP_URL` | web | Base URL of the inWorkspace server, such as `https://mail.example.com`. |
| `JMAP_PRINCIPAL` | web | Login of the console principal. |
| `JMAP_PRINCIPAL_SECRET` | web | Its password. |
| `AGENT_DOMAINS` | web | Comma-separated domains whose accounts are agent mailboxes. |
| `AGENT_LOCALPART_PATTERN` | web | Optional regular expression an agent's local part must match. |
| `AUTH_MODE` | web | `iap` or `none`. |
| `IAP_AUDIENCE` | web | Expected audience of the proxy assertion. |
| `ALLOWED_EMAILS`, `ALLOWED_DOMAINS` | web | Who may use the console once signed in. |

## Server setup

On the inWorkspace server, an administrator:

1. creates a console principal — an individual account that receives no mail — with the
   `Authenticate` and `Impersonate` permissions and read access to accounts and domains,
   and a long random password;
2. creates a webhook pointing at `<ingest URL>/api/ingest/events`, with the signing key,
   level `info`, and the event types listed above as an include list.

## Error handling

- Ingest: 401 bad signature, 400 malformed batch, 413 oversize, 503 database unavailable,
  204 success. Errors are logged without the body.
- Web: a failed JMAP call renders an error state in the affected panel with the server's
  error type, and the rest of the page still renders. An unauthorized operator gets 403.
- Startup fails when configuration is invalid or migrations cannot be applied.

## Testing

- Unit tests (Vitest) for `signature`, `normalize`, `conversations`, `sanitize`, `auth`,
  `config` and the `jmap` allow-list, using event payloads captured from a real server.
- Integration tests for `eventStore` against a real Postgres: migrations, dedupe, filters,
  counts, retention.
- An end-to-end check against a real inWorkspace server in Docker: create an agent
  mailbox, the console principal and the webhook; send a message over SMTP and reply from
  the agent mailbox over JMAP; then confirm the events arrive and the conversation renders
  with an inbound and an outbound message.

## Deployment

Any container platform works. The reference deployment is two Google Cloud Run services
from the same image — the web role with Identity-Aware Proxy enabled, the ingest role
publicly reachable and protected by the signature — sharing a Postgres database, with all
secrets supplied as environment variables from a secret manager. Organization-specific
values never belong in this repository.
