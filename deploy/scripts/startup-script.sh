#!/bin/bash
#
# Stalwart on Container-Optimized OS — VM startup script (SAFE MODE).
#
# Runs on every boot. It:
#   1. Formats (first boot only) and mounts the persistent data disk.
#   2. Fetches secrets from Secret Manager using the VM service account
#      (via the metadata token + Secret Manager REST API — no gcloud needed on COS).
#   3. Renders /etc/stalwart/config.json (the DataStore bootstrap file — points
#      Stalwart at the EXISTING Cloud SQL Postgres; blob/fts/lookup/in-memory and
#      the internal directory all default to that same store).
#   4. Runs the Stalwart container with the secret values in its process env ONLY
#      (secrets are never written to instance metadata or to any tracked file).
#
# All non-secret parameters come from instance metadata attributes (see 20-create-vm.sh).
# Secrets come from Secret Manager by NAME; values are resolved here at boot.
set -euo pipefail

log() { echo "[startup $(date -u +%H:%M:%S)] $*"; }

md() { curl -s -H "Metadata-Flavor: Google" "http://metadata.google.internal/computeMetadata/v1/$1"; }

PROJECT_ID="$(md project/project-id)"
POSTGRES_HOST="$(md instance/attributes/postgres-host)"
CONTAINER_IMAGE="$(md instance/attributes/container-image)"
PG_PASSWORD_SECRET="$(md instance/attributes/pg-password-secret)"
RECOVERY_ADMIN_SECRET="$(md instance/attributes/recovery-admin-secret)"
DATA_DEVICE="/dev/disk/by-id/google-stalwart-data"
MNT="/mnt/disks/stalwart"

# --- resolve secrets from Secret Manager (base64 payload -> plaintext) ----------
ACCESS_TOKEN="$(md instance/service-accounts/default/token \
  | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p')"

sm_secret() { # $1 = secret name; prints plaintext value
  curl -s -H "Authorization: Bearer ${ACCESS_TOKEN}" \
    "https://secretmanager.googleapis.com/v1/projects/${PROJECT_ID}/secrets/$1/versions/latest:access" \
    | sed -n 's/.*"data": *"\([^"]*\)".*/\1/p' | base64 -d
}

POSTGRES_PASSWORD="$(sm_secret "${PG_PASSWORD_SECRET}")"
STALWART_RECOVERY_ADMIN="$(sm_secret "${RECOVERY_ADMIN_SECRET}")"   # format: admin:<password>

# --- persistent data disk -------------------------------------------------------
mkdir -p "${MNT}"
if ! blkid "${DATA_DEVICE}" >/dev/null 2>&1; then
  log "formatting new data disk ${DATA_DEVICE}"
  mkfs.ext4 -m 0 -E lazy_itable_init=0,lazy_journal_init=0,discard -F "${DATA_DEVICE}"
fi
mountpoint -q "${MNT}" || mount -o discard,defaults "${DATA_DEVICE}" "${MNT}"
mkdir -p "${MNT}/etc" "${MNT}/lib"
chown -R 2000:2000 "${MNT}/etc" "${MNT}/lib"

# --- render the DataStore bootstrap config (no secrets inline) -------------------
cat > "${MNT}/etc/config.json" <<EOF
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
  "poolRecyclingMethod": "fast"
}
EOF
chown 2000:2000 "${MNT}/etc/config.json"

# --- host firewall: open the mail/admin ports -----------------------------------
# Container-Optimized OS ships with an iptables INPUT policy of DROP that only
# permits SSH/ICMP/established. With --network host the container binds the ports
# but COS still drops inbound unless we ACCEPT them here. iptables is reset on every
# boot, so this runs on each startup. Source-based access control stays with the VPC
# firewall (e.g. 443/80 public, the rest IAP-only); this host rule only unblocks the
# ports so packets reach Stalwart.
STALWART_PORTS="25,80,143,443,465,587,993,995,4190,8080"
if ! iptables -C INPUT -p tcp -m multiport --dports "${STALWART_PORTS}" -j ACCEPT 2>/dev/null; then
  iptables -A INPUT -p tcp -m multiport --dports "${STALWART_PORTS}" -j ACCEPT
  log "host firewall: opened tcp ${STALWART_PORTS}"
fi

# --- run the container ----------------------------------------------------------
# host networking so all mail ports bind on the VM (firewall restricts access in
# safe mode). Docker's default cap set includes NET_BIND_SERVICE, which combined
# with the binary's file capability lets uid 2000 bind :25/:443/etc.
log "starting Stalwart container: ${CONTAINER_IMAGE}"
docker rm -f stalwart >/dev/null 2>&1 || true
docker run -d --name stalwart --restart=always \
  --network host \
  -v "${MNT}/etc":/etc/stalwart \
  -v "${MNT}/lib":/var/lib/stalwart \
  -e POSTGRES_PASSWORD="${POSTGRES_PASSWORD}" \
  -e STALWART_RECOVERY_ADMIN="${STALWART_RECOVERY_ADMIN}" \
  "${CONTAINER_IMAGE}"

log "done. tail logs with: docker logs -f stalwart"
