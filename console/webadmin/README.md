# The web admin, with the console's Dashboard, Live Tracing and History

On the community edition, three parts of the server's web admin are locked behind an Enterprise
license:
- the **Dashboard**;
- **Observability → Live Tracing**;
- **Emails → History** (inbound and outbound delivery).

Their screens are in the open-source web UI, but their data comes from Enterprise-only server
code: the live metrics and tracing streams, and the stored metric and trace history.

This directory builds the server's web UI with a small set of patches. Those three menu entries
then read the same data from the inWorkspace Console, which collects it through exports the
community edition has:
- the server's **OpenTelemetry metrics push**;
- a **tracing webhook** that carries its delivery events.

Nothing is unlocked on the server, and no Enterprise code is used. The rest of the web admin is
unchanged.

## What each screen shows

| Screen | In this build |
| --- | --- |
| Dashboard | All six boards. Live cards are refreshed every 30 seconds; history covers 24 hours to 90 days. The community edition exports no latencies for message indexing, DNS lookups, or the data and blob stores, and those cards say so. Message ingest time is measured from the server's `message-ingest.*` events instead. |
| Live Tracing | The server's events a few seconds after they happen, with the same keyword and key filters, polled every two seconds. It shows the events the tracing webhook carries: everything at `info` level and above, plus the debug-level events of SMTP sessions and delivery attempts. Trace-level protocol lines are not included. |
| History | Inbound SMTP sessions and outbound delivery attempts, each with its event timeline, for as long as the console keeps traces (30 days by default). The lists are read-only. |

Who may open each screen is decided by the same server permissions as on the Enterprise edition.

| Screen | Permissions |
| --- | --- |
| Dashboard | `liveMetrics`, plus `sysMetricQuery` and `sysMetricGet` for its history |
| Live Tracing | `liveTracing` |
| History | `sysTraceQuery` and `sysTraceGet` |

## How the pages find the console

The build carries no deployment settings. Its pages read the console API's address from the
console's own page on the same server, `/console/`, which names it in its
`inworkspace-console-api` meta tag. Requests go to that API with the signed-in administrator's
access token, which the console checks with the server.

When the console is not installed, those pages say so instead of loading.

## Source and license

The web UI is © Stalwart Labs LLC and licensed `AGPL-3.0-only OR LicenseRef-SEL`. This build
uses it under the AGPL-3.0, and the patched build is licensed AGPL-3.0-only.

What this directory adds:
- [`overlay/`](overlay): new files. They are AGPL-3.0-only and © inWorkspace contributors.
- [`patches/`](patches): changes to upstream files, 2026-10-26. Each changed place is marked
  with an `inWorkspace:` comment.

| Patch | What it changes |
| --- | --- |
| `0001` | The three screens are no longer Enterprise features, and the trace lists are read-only. |
| `0002` | The Dashboard's stores, Live Tracing, and `x:Trace` JMAP calls read from the console. |
| `0003` | The Dashboard says what the community edition does not export, and when the server last sent metrics. |
| `0004` | The sidebar links to this source, as AGPL-3.0 section 13 requires for a modified version used over a network. |

[`upstream.json`](upstream.json) pins the upstream repository, tag and commit. The build checks
the commit.

## Build

From the `console` directory, after `npm ci`:

```bash
node webadmin/build.mjs --out webui.zip --source-url https://github.com/<owner>/<repo>/tree/<tag>/console/webadmin
```

The build does these steps:
1. clones the pinned web UI and checks its commit;
2. adds the overlay and applies the patches;
3. runs upstream's own checks (type check, lint and tests) and its build, in the Node image
   that `upstream.json` names. `--local` uses this machine's npm instead;
4. zips `dist/` the way upstream's release asset is laid out.

The same sources always give the same zip. `--source-url` is the link the sidebar shows: point
it at the exact commit or tag the zip was built from.

Publish the zip somewhere the mail server can download over https, such as a release asset of
this repository.

## Install, and roll back

The console must already collect the data: see the console's
[server setup](../README.md#the-web-admins-dashboard-live-tracing-and-history). Then point the
server's web admin at the zip:

```bash
SERVER_URL=https://mail.example.com SERVER_ADMIN_USER=admin SERVER_ADMIN_SECRET=… \
  node scripts/webadmin.mjs use https://…/webui.zip
```

`webadmin.mjs` does these steps:
1. downloads the zip, and checks that it holds a web admin page and the scripts it loads;
2. points the server's `/admin` web application at it;
3. runs **Update apps**, and waits until `/admin` serves the new build.

If the server does not serve it within two minutes, the previous URL is put back.

**Update apps downloads every web application again.** That includes the console's shell. One
whose download fails stays offline until a later attempt succeeds.

**To roll back** to the stock web UI:

```bash
… node scripts/webadmin.mjs restore
```

That reinstalls web UI v1.0.5, the release that matches 0.16 servers before 0.16.16. Pass
another release's URL for a newer server. `webadmin.mjs show` prints what `/admin` serves now.

## Moving to a newer web UI

When the server is upgraded, its matching web UI may be newer than the pinned one.
1. Set `upstream.json` to the new tag and commit.
2. Rebuild. A patch that no longer applies fails the build, and names the file.
3. Update that patch against the new upstream, check the three screens, and release.

`e2e/insights.mjs` runs the whole flow against a real server in Docker. It covers the metrics
push, the tracing webhook, the API, and this build served at `/admin`.
