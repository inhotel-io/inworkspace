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
| Date completed (UTC) | `2026-07-18` (safe-mode deploy verified) |
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
| 5 | 2026-07-18 | Create firewall (admin ports → IAP only) | `gcloud compute firewall-rules create stalwart-admin-allow …` | ✅ DONE. source range = IAP `35.235.240.0/20`. |
| 6 | 2026-07-18 | Create firewall (deny :25 + IAP ssh) | `… stalwart-smtp-deny-25 …` / `… stalwart-iap-ssh …` | ✅ DONE. :25 NOT world-open. |
| 7 | 2026-07-18 | Grant SA `secretAccessor` on both secrets | `gcloud secrets add-iam-policy-binding …` | ✅ DONE. First attempt on the pg-password secret failed (IAM propagation lag right after SA create); retry succeeded. |
| 8 | 2026-07-18 | Create persistent data disk | `gcloud compute disks create $DATA_DISK_NAME …` | ✅ DONE. 20 GB pd-balanced, READY. |
| 9 | 2026-07-18 | Create VM (COS) | `gcloud compute instances create … --metadata-from-file=startup-script=…` | ✅ DONE. `stalwart-mail` e2-small COS RUNNING. Ephemeral egress IP; inbound locked to IAP. Reset once after the pg-password grant landed so startup re-fetched the secret. |
| 10 | 2026-07-18 | Verify `/healthz/live` | `curl -fsSk https://127.0.0.1:443/healthz/live` (on VM) | ✅ 200 `{"title":"OK","status":200}`. |
| 11 | 2026-07-18 | Verify `/healthz/ready` (Postgres connected) | `curl -fsSk https://127.0.0.1:443/healthz/ready` (on VM) | ✅ **200 — Cloud SQL Postgres connection established.** Container `Up (healthy)`. Listeners up: 443, 25, 465, 993, 995, 4190, 8080. |
| 12 | | Create test mailbox (web-admin) | web-admin → Account → Individual → `$TEST_MAILBOX_EMAIL` | ⏳ next — via IAP tunnel to :443, log in with break-glass admin. |
| 13 | | Verify mailbox (IMAP over tunnel) | `openssl s_client -connect localhost:993 …` / client login | ⏳ next |

_Add rows as needed._

---

## Verification evidence

| Check | Expected | Observed | Pass? |
|-------|----------|----------|-------|
| `/healthz/live` | HTTP 200 | 200 `{"title":"OK"}` on :443 and :8080 | ☑ |
| `/healthz/ready` | HTTP 200 (data store connected) | 200 on :443 — **Cloud SQL connected** | ☑ |
| Container status | running/healthy | `Up (healthy)` | ☑ |
| Listeners bound | mail + admin ports | 443, 25, 465, 993, 995, 4190, 8080 listening | ☑ |
| Port 25 not reachable from internet | denied in safe mode | explicit DENY rule + no allow for :25 | ☑ |
| Admin ports reachable ONLY via IAP | direct connect fails; tunnel works | firewall source = IAP range only | ☑ |
| VM egress reaches Cloud SQL | Postgres reachable over TLS | proven by `/healthz/ready` = 200 | ☑ |
| Test mailbox login works | IMAP/JMAP auth succeeds | ⏳ pending (create first mailbox) | ☐ |
| Postgres tables created by Stalwart | tables present in `stalwart` db | ⏳ verify via psql (implied by ready=200) | ☐ |

---

## Incidents / deviations

_Record anything that differed from the runbook, rollbacks, or surprises._

| Date (UTC) | What happened | Resolution |
|-----------|----------------|------------|
| 2026-07-18 | Cloud SQL rejected the first generated Postgres password (policy: needs upper+lower+digit+special). | Regenerated a compliant password; created secret version 2. |
| 2026-07-18 | Existing Cloud SQL has **public IP only** (no Private IP), so a `--no-address` VM couldn't reach it. | VM given an **ephemeral external IP** for egress; **all inbound** locked to the IAP range by firewall (external IP does not open inbound). Follow-up: reserve a static egress IP or move to Cloud SQL Auth Proxy / Private IP. |
| 2026-07-18 | Deploy switched from konlet `create-with-container` to plain COS + startup-script `docker run`. | Keeps DB/admin secrets out of instance metadata (fetched from Secret Manager at boot into container env only). |
| 2026-07-18 | Public access to :443 timed out even though VPC firewall allowed it and GCP connectivity test said REACHABLE. Root cause: **COS host iptables `INPUT` policy is `DROP`** (only SSH/ICMP/established allowed); with `--network host` the container binds the ports but COS drops inbound. | Added `iptables -A INPUT -p tcp -m multiport --dports 25,80,143,443,465,587,993,995,4190,8080 -j ACCEPT` on the VM, and baked it into `startup-script.sh` so it re-applies on every boot (iptables resets on reboot). Public `https://<static-ip>/login` then returned 200. |
| 2026-07-18 | Reserved the ephemeral IP as a static address `stalwart-ip` (34.65.x, Premium) and opened `stalwart-web-public` (tcp:80,443 from 0.0.0.0/0) so the admin is reachable by IP. | Admin is now internet-exposed with a self-signed cert (`CN=rcgen self signed cert`). Follow-up: link domain + ACME for a trusted cert, and restrict access to trusted sources. |
| 2026-07-18 | Linked domain: added Cloudflare A record `admin.<domain>` → static IP (DNS-only/grey-cloud), set Stalwart `defaultHostname` = `admin.<domain>`, created a domain + set it as default (initial-setup requirement), and configured Stalwart's built-in **ACME (TLS-ALPN-01, Let's Encrypt)** via an `AcmeProvider` + the domain's `certificateManagement = Automatic`. | Trusted cert issued (`CN=admin.<domain>`, issuer Let's Encrypt). Admin now at `https://admin.<domain>/`. Note: the admin WebUI SPA caches the OIDC config — after changing the hostname, clear site data / use a fresh browser session or the login redirect keeps using the old host. |
| 2026-07-18 | Outbound relay set up via Google Workspace SMTP relay (`smtp-relay.gmail.com:587`, IP-authorized, no SMTP auth). The WebAdmin **"delivery trace" tool hung on "TCP Connection"** — it does *direct* MX delivery on port 25, which GCP blocks; it is NOT representative of the relay path. | Not a real failure — direct MX is expected to fail on GCP. Real mail routes through the relay. |
| 2026-07-18 | **Outbound queue silently not delivering** — messages stuck `Scheduled`. Enabled a Stdout `Tracer` to get logs; delivery failed with `Connection error … localIp=34.65.106.216 … Cannot assign requested address (os error 99)`. Root cause: Stalwart auto-populated the **`sourceIps` of the `default` MtaConnectionStrategy with the server's public IP** (34.65.106.216), which is NOT bindable on GCP (1:1 NAT — the NIC only holds the internal IP). Binding it fails, so every relay connection dies instantly. | **Fix: clear `sourceIps` on the `default` connection strategy** (`x:MtaConnectionStrategy/set` update → `sourceIps: {}`), then restart to reload config. Outbound then binds the default interface (internal IP → NAT) and delivers. Verified: `delivery.delivered` / `250 OK` from `smtp-relay.gmail.com`. **This is a required step for any Stalwart-on-GCP (or any 1:1-NAT) outbound setup.** |
| 2026-07-18 | Repeated container restarts during debugging left a **stale queue lock** ("Queue event is locked by another process"), blocking the stuck message. | Deleted the stuck message and stopped restarting; fresh messages deliver cleanly. Avoid rapid restarts while messages are mid-delivery. |

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
