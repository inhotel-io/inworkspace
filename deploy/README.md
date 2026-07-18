# Stalwart on GCP — Runbook (SAFE MODE, reuse existing Cloud SQL)

Deploy [Stalwart](https://stalw.art) so AI agents get their own mailboxes, at
minimum cost, by **reusing infrastructure you already run**. This runbook covers
the *safe-mode* first deploy: nothing is exposed to the public internet, no DNS
or MX records, no public TLS, and **no outbound relay** yet. Those are tracked in
[DEFERRED / FOLLOW-UPS](#deferred--follow-ups).

> **Public-repo safety.** Every file here is committed to a PUBLIC repository.
> Real project ids, IPs, connection names, and passwords live ONLY in the
> gitignored `deploy/.env` or in Google Secret Manager. Commands below read
> values from `deploy/.env`. Never paste a real value into a tracked file.

---

## 1. Architecture (reuse-based)

```
                 IAP TCP tunnel (admin only)          ┌──────────────────────────┐
   operator ───────────────────────────────────────► │  Compute Engine VM        │
   (gcloud start-iap-tunnel)                          │  e2-small, COS            │
                                                      │  ┌──────────────────────┐ │
                                                      │  │ stalwartlabs/stalwart│ │
                                                      │  │ (container, uid 2000)│ │
                                                      │  │  443 25 110 587 465  │ │
                                                      │  │  143 993 995 4190    │ │
                                                      │  │  8080                 │ │
                                                      │  └──────────┬───────────┘ │
                                                      │   /etc/stalwart  (disk)   │
                                                      │   /var/lib/stalwart(disk) │
                                                      └──────────────┬────────────┘
                                                                     │ TLS (require)
                                                                     ▼
                                              ┌────────────────────────────────────┐
                                              │  EXISTING Cloud SQL for PostgreSQL   │
                                              │  db: stalwart / user: stalwart       │
                                              │  serves: data + blob + full-text +   │
                                              │  lookup/in-memory + INTERNAL directory│
                                              └────────────────────────────────────┘
```

**Why this is cheap:** the only new billable resource is one `e2-small` VM plus a
small persistent disk. There is **no new database, no Redis, no object storage.**

**How one Postgres serves everything.** In Stalwart v0.16 the on-disk config
(`config.json`) contains only the *data store* definition. On boot, the blob
store, full-text index, and in-memory/lookup store all **default to that same
data store**, and authentication uses the **internal directory** (also backed by
the data store) whenever no external directory is configured. So pointing
Stalwart at the `stalwart` Postgres database gives you data + blob + FTS +
lookup + internal directory from a single connection — verified against the
source (`crates/store/src/build/{blob,search,memory}.rs`,
`crates/directory/src/core/config.rs`). The internal directory is what lets you
provision agent accounts via the web-admin / management API.

**GKE alternative:** if you already run a cluster and prefer zero new compute,
use the StatefulSet in `deploy/gke/` instead of the VM (see
[GKE alternative](#gke-alternative)). Same Postgres reuse model.

---

## 2. Prerequisites

- `gcloud` CLI authenticated (`gcloud auth login`) with rights to create a VM,
  firewall rules, a service account, and Secret Manager secrets in `PROJECT_ID`,
  and to run `gcloud sql` against the existing instance.
- The existing Cloud SQL **PostgreSQL** instance (region `europe-west6`), its
  instance name, and its public IP.
- A Postgres **admin** login (e.g. the `postgres` user) to create the dedicated
  database and role. You run these; this runbook never stores that admin password.
- APIs enabled: `compute.googleapis.com`, `sqladmin.googleapis.com`,
  `secretmanager.googleapis.com`, `iap.googleapis.com`.
- Copy and fill the environment file:
  ```bash
  cp deploy/.env.example deploy/.env
  # edit deploy/.env — see every variable documented inline there
  ```
- Load it into your shell for the commands below:
  ```bash
  set -a; source deploy/.env; set +a
  ```

---

## 3. Deploy order (do these in sequence)

> Each step has a matching row to fill in `DEPLOYMENT_LOG.md`.

### Step 1 — Create the Cloud SQL database, user, and secret

Create the dedicated database and role **on the existing instance** (no new
instance). First generate a strong password and store it in Secret Manager —
**do not** type it into a shell that logs history or into any tracked file:

```bash
# Generate a random password and push it straight into Secret Manager.
POSTGRES_PASSWORD="$(openssl rand -base64 30)"
printf '%s' "$POSTGRES_PASSWORD" | \
  gcloud secrets create "$POSTGRES_PASSWORD_SECRET" \
    --project="$PROJECT_ID" --replication-policy=automatic --data-file=-
# (use `gcloud secrets versions add` instead of `create` if it already exists)

# Create the role and database on the EXISTING instance.
gcloud sql users create "$POSTGRES_USER" \
  --project="$PROJECT_ID" --instance="$POSTGRES_INSTANCE" \
  --password="$POSTGRES_PASSWORD"

gcloud sql databases create "$POSTGRES_DB" \
  --project="$PROJECT_ID" --instance="$POSTGRES_INSTANCE"

unset POSTGRES_PASSWORD   # keep it out of the environment after this step
```

Grant ownership so Stalwart can create its own tables (it creates them on first
run). Connect as the instance admin and run:

```sql
-- as the Postgres admin, connected to the `stalwart` database
GRANT ALL PRIVILEGES ON DATABASE stalwart TO stalwart;
ALTER DATABASE stalwart OWNER TO stalwart;
```

Also create the break-glass admin credential secret (used to log in to the
web-admin / management API the first time):

```bash
ADMIN_PW="$(openssl rand -base64 24)"
printf 'admin:%s' "$ADMIN_PW" | \
  gcloud secrets create "$RECOVERY_ADMIN_SECRET" \
    --project="$PROJECT_ID" --replication-policy=automatic --data-file=-
unset ADMIN_PW
```

### Step 2 — Write the Stalwart config

`config.json` is the data-store bootstrap file. It contains **no secrets**: the
Postgres password is referenced by *environment variable name*, and the value is
injected at runtime from Secret Manager. Render it from the template in
`deploy/config/config.json.template` using values from `.env`:

```bash
envsubst < deploy/config/config.json.template > deploy/config/config.json.rendered
```

The template/rendered shape looks like this — note `authSecret` is an env-var
reference (never an inline value), and `useTls`/`allowInvalidCerts` implement
`sslmode=require`:

```json
{
  "@type": "PostgreSql",
  "host": "${POSTGRES_HOST}",
  "port": 5432,
  "database": "stalwart",
  "authUsername": "stalwart",
  "authSecret": { "@type": "EnvironmentVariable", "variableName": "POSTGRES_PASSWORD" },
  "useTls": true,
  "allowInvalidCerts": true,
  "poolMaxConnections": 10,
  "poolRecyclingMethod": "Fast"
}
```

> `allowInvalidCerts: true` gives you **encrypted** transport (matching Cloud
> SQL `sslmode=require`) but does **not** verify the server against a CA, because
> Cloud SQL's per-instance CA is not in the container trust store. Tightening
> this to CA verification is a follow-up (see below). The stronger near-term
> mitigation is restricting Cloud SQL authorized networks — also a follow-up.

### Step 3 — Create the firewall rules (SAFE MODE)

Admin and mail ports are opened **only** to `ADMIN_SOURCE_RANGE` (the IAP range
by default), so nothing is reachable from the open internet. Port **25 is not
opened at all**.

```bash
# Admin / setup + mail-client ports, restricted to IAP (or your VPN CIDR).
gcloud compute firewall-rules create stalwart-admin-allow \
  --project="$PROJECT_ID" --network="$NETWORK" --direction=INGRESS --action=ALLOW \
  --rules=tcp:8080,tcp:443,tcp:993,tcp:995,tcp:587,tcp:465,tcp:143,tcp:110,tcp:4190 \
  --source-ranges="$ADMIN_SOURCE_RANGE" \
  --target-tags="$NETWORK_TAG"

# Explicit deny of SMTP :25 from the internet (belt-and-suspenders; there is no
# allow rule for :25 in safe mode anyway).
gcloud compute firewall-rules create stalwart-smtp-deny-25 \
  --project="$PROJECT_ID" --network="$NETWORK" --direction=INGRESS --action=DENY \
  --rules=tcp:25 --source-ranges=0.0.0.0/0 \
  --target-tags="$NETWORK_TAG" --priority=1000
```

> Do **not** create an allow rule for `tcp:25` from `0.0.0.0/0` until the
> outbound/inbound mail path is hardened (DNS, PTR, TLS, anti-abuse). See
> [DEFERRED / FOLLOW-UPS](#deferred--follow-ups).

### Step 4 — Create the persistent disk and the VM

The VM's service account must be allowed to read the two secrets:

```bash
for S in "$POSTGRES_PASSWORD_SECRET" "$RECOVERY_ADMIN_SECRET"; do
  gcloud secrets add-iam-policy-binding "$S" --project="$PROJECT_ID" \
    --member="serviceAccount:$VM_SERVICE_ACCOUNT" \
    --role=roles/secretmanager.secretAccessor
done

# Persistent data disk for /etc/stalwart and /var/lib/stalwart.
gcloud compute disks create "$DATA_DISK_NAME" \
  --project="$PROJECT_ID" --zone="$ZONE" \
  --size="$DATA_DISK_SIZE" --type="$DATA_DISK_TYPE"
```

Create the VM with the container. Secrets are **not** passed as `--container-env`
(that would land in instance metadata in plaintext). Instead a startup script
(`deploy/scripts/startup-script.sh`) fetches them from Secret Manager at boot,
writes `config.json` to the mounted disk, and starts the container with the
secret values in its process env only. Non-secret settings are passed directly:

```bash
gcloud compute instances create-with-container "$INSTANCE_NAME" \
  --project="$PROJECT_ID" --zone="$ZONE" \
  --machine-type="$MACHINE_TYPE" \
  --network-interface=network="$NETWORK",subnet="$SUBNET",no-address \
  --service-account="$VM_SERVICE_ACCOUNT" \
  --scopes=cloud-platform \
  --tags="$NETWORK_TAG" \
  --disk=name="$DATA_DISK_NAME",device-name=stalwart-data,mode=rw,boot=no \
  --container-image="$CONTAINER_IMAGE" \
  --container-privileged=false \
  --container-mount-disk=mount-path="/etc/stalwart",name="$DATA_DISK_NAME",partition=1 \
  --container-mount-disk=mount-path="/var/lib/stalwart",name="$DATA_DISK_NAME",partition=1 \
  --container-env=CONFIG_PATH="$CONFIG_PATH",STALWART_HOSTNAME="$STALWART_HOSTNAME",STALWART_HTTPS_PORT="$STALWART_HTTPS_PORT" \
  --metadata-from-file=startup-script=deploy/scripts/startup-script.sh \
  --shielded-secure-boot --shielded-vtpm --shielded-integrity-monitoring
```

Notes:
- `--no-address` gives the VM **no public IP**. Reach it only via IAP tunnel.
- Shielded VM flags are on; the container runs unprivileged (`uid 2000`, with
  `cap_net_bind_service` from the image so it can bind :443/:25 etc.).
- A **brand-new** persistent disk is unformatted. The startup script
  (`deploy/scripts/startup-script.sh`) formats it on first boot (single ext4
  partition) and creates the `etc`/`lib` subdirs before the container mounts it;
  on later boots it just remounts. It also renders `config.json` and exports the
  two secrets into the container's process env (never into instance metadata).
- If you prefer the fully-managed konlet secret path, see the comments in
  `deploy/scripts/startup-script.sh`; the trade-off is documented there and in
  the security checklist.

### Step 5 — Verify health

Open an IAP tunnel to the HTTP setup port and hit the liveness/readiness probes.
`/healthz/live` returns 200 once the process is up; `/healthz/ready` returns 200
once the **data store (Postgres) connection is established** — that is your proof
the Cloud SQL reuse works.

```bash
# Terminal A: tunnel local :8080 -> VM :8080 over IAP
gcloud compute start-iap-tunnel "$INSTANCE_NAME" 8080 \
  --project="$PROJECT_ID" --zone="$ZONE" --local-host-port=localhost:8080

# Terminal B:
curl -fsS http://localhost:8080/healthz/live   && echo "  <- live OK"
curl -fsS http://localhost:8080/healthz/ready  && echo "  <- ready OK (Postgres connected)"
```

If `ready` is not 200, inspect the container logs on the VM:

```bash
gcloud compute ssh "$INSTANCE_NAME" --project="$PROJECT_ID" --zone="$ZONE" --tunnel-through-iap \
  --command='sudo docker logs $(sudo docker ps -q --filter name=klt-) 2>&1 | tail -50'
```

Common causes: wrong `POSTGRES_HOST`, the `stalwart` role/db not created,
Cloud SQL authorized networks not permitting the VM's egress, or TLS mode
mismatch.

### Step 6 — Create the first (test) mailbox

Tunnel to the admin UI and create an **Individual** account — this is the AI
agent's mailbox. Log in with the break-glass admin (`admin` + the password from
`RECOVERY_ADMIN_SECRET`).

```bash
# Tunnel the HTTPS/admin port (self-signed cert in safe mode -> use -k / accept warning).
gcloud compute start-iap-tunnel "$INSTANCE_NAME" 443 \
  --project="$PROJECT_ID" --zone="$ZONE" --local-host-port=localhost:8443
# then open https://localhost:8443/  (accept the self-signed cert) and log in as admin,
# create Account -> Individual -> email = $TEST_MAILBOX_EMAIL.
```

Accounts are managed through the web-admin / management API (JMAP `Principal/set`
under the hood); the `stalwart` binary has **no** `account create` subcommand
(verified in `crates/common/src/manager/boot.rs`). For scripted provisioning,
drive the same management API the web-admin uses, authenticating with the admin
credential; consult the running server's live API spec at `/api/spec`.

Verify the mailbox by connecting an IMAP client through the tunnel
(`localhost` → VM `:993`, STARTTLS/implicit TLS) with the new account's
credentials, or by re-checking the admin UI account list.

---

## 4. GKE alternative

For teams that would rather reuse an existing cluster (zero new compute), apply
the manifests in `deploy/gke/` (StatefulSet + headless Service + PVC for
`/etc/stalwart` and `/var/lib/stalwart`). The Postgres reuse model is identical:
the same `config.json` (with `authSecret` → `POSTGRES_PASSWORD`) mounted via a
ConfigMap/Secret projection, and `POSTGRES_PASSWORD` / `STALWART_RECOVERY_ADMIN`
injected from a Kubernetes Secret sourced from Secret Manager (e.g. External
Secrets Operator). Keep the Service **ClusterIP / internal LoadBalancer only** in
safe mode — do not expose `:25` publicly. See `deploy/gke/README.md`.

---

## 5. DEFERRED / FOLLOW-UPS

These are intentionally **NOT** done in the safe-mode first deploy. Do them,
roughly in this order, when you are ready to receive/send real mail:

1. **Domain & internal DNS** — decide the mail domain; add it in Stalwart; set
   `STALWART_HOSTNAME` / public URL accordingly.
2. **Reserve a static public IP + PTR (reverse DNS).** A matching PTR is
   mandatory for deliverability. Request it from GCP for the VM's external IP.
3. **DNS MX (and SPF/DKIM/DMARC/MTA-STS/TLS-RPT).** Publish MX only after the
   server is reachable and TLS is valid. Add SPF, enable DKIM signing (Stalwart
   manages keys), publish DMARC, then MTA-STS + TLS reporting.
4. **Public TLS via ACME.** Configure Let's Encrypt in Stalwart so :443 and the
   mail ports present a trusted certificate; then drop `-k` / self-signed usage.
   Only after this, switch the healthcheck back to
   `https://127.0.0.1:443/healthz/live`.
5. **Open SMTP :25** — add an INGRESS allow for `tcp:25` from `0.0.0.0/0` and a
   static IP with PTR, *after* anti-abuse (rate limits, auth, spam filtering) is
   configured. Remove the temporary deny rule.
6. **Outbound relay / smarthost.** Deferred by design. When ready, configure an
   outbound route (direct MX or a smarthost) and sender authentication. Until
   then agents can send only internally.
7. **Cloud SQL hardening (do this early, even in safe mode):**
   - Restrict `authorizedNetworks` from `0.0.0.0/0` to the VM's egress IP (or
     move to **Private IP** / the Cloud SQL Auth Proxy) — see security checklist.
   - Move to `sslmode=verify-ca` by making Cloud SQL's `server-ca.pem` trusted
     in the container and setting `allowInvalidCerts: false`.
8. **Backups & monitoring** — confirm Cloud SQL automated backups/PITR cover the
   `stalwart` database; wire Stalwart metrics (`/metrics/prometheus`) and logs to
   Cloud Monitoring; alert on `/healthz/ready`.
9. **Pin the image** — replace `:latest` with a specific digest and set an
   update/rollback process.

---

## 6. File map

| Path | Purpose |
|------|---------|
| `deploy/README.md` | This runbook. |
| `deploy/DEPLOYMENT_LOG.md` | Fill-in-as-you-go execution log (template). |
| `deploy/.env.example` | Every variable the scripts/commands read (placeholders). |
| `deploy/.gitignore` | Keeps `.env`, rendered config, logs, tfstate, secrets out of git. |
| `deploy/config/config.json.template` | Data-store bootstrap template (sibling artifact). |
| `deploy/scripts/*.sh` | Deploy/startup scripts (sibling artifacts). |
| `deploy/gke/` | GKE StatefulSet alternative (sibling artifact). |
