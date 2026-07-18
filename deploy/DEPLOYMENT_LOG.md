# Stalwart on GCP — Deployment Log

> **Fill this in as you execute** the runbook in `deploy/README.md`.
>
> **Real values live only in the gitignored `deploy/.env` and in Google Secret
> Manager — never in this file.** This log is committed to a PUBLIC repo, so:
> - Refer to values by their variable name (e.g. `$POSTGRES_HOST`), not the value.
> - Never paste passwords, secret values, real IPs, project ids, or connection
>   names here. Redact command output before committing (mask IPs/ids/tokens).
> - Keep any output that must retain real values in a local `*.log` file — those
>   are gitignored (see `deploy/.gitignore`).

---

## Deploy metadata

| Field | Value |
|-------|-------|
| Deploy owner | inHotel infra (Claude Code assisted) |
| Date started (UTC) | `2026-07-18` |
| Date completed (UTC) | _in progress_ |
| Target | VM (COS + startup-script `docker run`) |
| Region / Zone | `europe-west6` / `europe-west6-a` |
| Stalwart image | `docker.io/stalwartlabs/stalwart:latest` (pin digest before prod) |
| Mode | SAFE MODE (no public :25, no DNS/MX, no public TLS, no outbound relay) |
| `deploy/.env` reviewed & gitignored? | ☑ yes |
| Secrets stored only in Secret Manager? | ☑ yes |

---

## Pre-flight checklist

- [ ] `gcloud` authenticated; correct `PROJECT_ID` selected.
- [ ] Required APIs enabled (compute, sqladmin, secretmanager, iap).
- [ ] Existing Cloud SQL instance name + region confirmed (`europe-west6`).
- [ ] `deploy/.env` created from `.env.example` and filled.
- [ ] `set -a; source deploy/.env; set +a` run in the working shell.
- [ ] Confirmed **no** new database instance / Redis / object storage is being created.

---

## Execution log

Record one row per action. Redact anything sensitive in the *Result* column.

| # | Date (UTC) | Step | Command (sanitized) | Result / notes |
|---|-----------|------|---------------------|----------------|
| 1 | 2026-07-18 | Create SQL db + user + password secret | `gcloud sql databases create $POSTGRES_DB …` / `gcloud sql users create $POSTGRES_USER …` / `gcloud secrets create $POSTGRES_PASSWORD_SECRET …` | ✅ DONE. db `stalwart` + user `stalwart` created on the EXISTING instance; password in Secret Manager (v2 — v1 rejected by pw policy, regenerated compliant). |
| 2 | | Grant DB ownership to `stalwart` | `psql … GRANT ALL … ; ALTER DATABASE stalwart OWNER TO stalwart;` | ⏳ pending — run once VM confirms it can connect (Stalwart creates its own tables). |
| 3 | 2026-07-18 | Create break-glass admin secret | `gcloud secrets create $RECOVERY_ADMIN_SECRET …` | ⏳ queued in VM batch (blocked on approval). Value = `admin:<generated>` in Secret Manager. |
| 4 | | Render `config.json` | (on the VM at boot, by `scripts/startup-script.sh`) | Rendered ON the VM from metadata + secrets; password is an env-ref only. Deviation from template's local `envsubst`. |
| 5 | | Create firewall (admin ports → IAP only) | `bash deploy/gcp/10-firewall.sh` | ⏳ queued. source range = `$ADMIN_SOURCE_RANGE` (IAP). |
| 6 | | Create firewall (deny :25) | `gcloud compute firewall-rules create stalwart-smtp-deny-25 …` | ⏳ queued. :25 NOT world-open. |
| 7 | | Grant SA `secretAccessor` on both secrets | `gcloud secrets add-iam-policy-binding …` | ⏳ queued in VM batch. |
| 8 | | Create persistent data disk | `gcloud compute disks create $DATA_DISK_NAME …` | ⏳ queued in VM batch. |
| 9 | | Create VM (COS) | `bash deploy/gcp/20-create-vm.sh` | ⏳ queued (blocked on approval). Ephemeral external IP for egress to Cloud SQL public IP; inbound locked to IAP. |
| 10 | | Verify `/healthz/live` (via IAP tunnel) | `curl -fsS http://localhost:8080/healthz/live` | expect 200 |
| 11 | | Verify `/healthz/ready` (Postgres connected) | `curl -fsS http://localhost:8080/healthz/ready` | expect 200 |
| 12 | | Create test mailbox (web-admin) | web-admin → Account → Individual → `$TEST_MAILBOX_EMAIL` | |
| 13 | | Verify mailbox (IMAP over tunnel) | `openssl s_client -connect localhost:993 …` / client login | |

_Add rows as needed._

---

## Verification evidence

| Check | Expected | Observed | Pass? |
|-------|----------|----------|-------|
| `/healthz/live` | HTTP 200 | | ☐ |
| `/healthz/ready` | HTTP 200 (data store connected) | | ☐ |
| Postgres tables created by Stalwart | tables present in `stalwart` db | | ☐ |
| VM has no external IP | `no-address` confirmed | | ☐ |
| Port 25 not reachable from internet | connection refused/timeout from outside | | ☐ |
| Admin ports reachable ONLY via IAP | direct connect fails; tunnel works | | ☐ |
| Test mailbox login works | IMAP auth succeeds | | ☐ |

---

## Incidents / deviations

_Record anything that differed from the runbook, rollbacks, or surprises._

| Date (UTC) | What happened | Resolution |
|-----------|----------------|------------|
| 2026-07-18 | Cloud SQL rejected the first generated Postgres password (policy: needs upper+lower+digit+special). | Regenerated a compliant password; created secret version 2. |
| 2026-07-18 | Existing Cloud SQL has **public IP only** (no Private IP), so a `--no-address` VM couldn't reach it. | VM given an **ephemeral external IP** for egress; **all inbound** locked to the IAP range by firewall (external IP does not open inbound). Follow-up: reserve a static egress IP or move to Cloud SQL Auth Proxy / Private IP. |
| 2026-07-18 | Deploy switched from konlet `create-with-container` to plain COS + startup-script `docker run`. | Keeps DB/admin secrets out of instance metadata (fetched from Secret Manager at boot into container env only). |

---

## Follow-ups opened (from DEFERRED section)

- [ ] Restrict Cloud SQL `authorizedNetworks` (remove `0.0.0.0/0`) / move to Private IP.
- [ ] `sslmode=verify-ca` (trust Cloud SQL `server-ca.pem`, set `allowInvalidCerts: false`).
- [ ] Domain + internal DNS.
- [ ] Static public IP + PTR.
- [ ] DNS MX + SPF/DKIM/DMARC/MTA-STS/TLS-RPT.
- [ ] Public ACME TLS; revert healthcheck to HTTPS `:443`.
- [ ] Open SMTP :25 (after anti-abuse hardening).
- [ ] Outbound relay / smarthost.
- [ ] Backups (Cloud SQL PITR covers `stalwart` db) + monitoring/alerting.
- [ ] Pin container image to a digest.
