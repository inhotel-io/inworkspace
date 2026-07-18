#!/bin/bash
# Create the least-priv service account, secret grants, data disk, and the COS VM
# that runs Stalwart against the EXISTING Cloud SQL Postgres.
#
# NOTE on networking: the Cloud SQL instance is reachable only over its PUBLIC IP,
# so the VM needs internet egress. We give it an EPHEMERAL external IP for egress,
# but ALL inbound is locked to the IAP range by 10-firewall.sh (external IP does
# NOT open inbound). When you later restrict Cloud SQL authorized networks, reserve
# a static egress IP or switch to the Cloud SQL Auth Proxy / Private IP.
#
# Usage:
#   set -a; source deploy/.env; set +a
#   bash deploy/gcp/20-create-vm.sh
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${HERE}/00-vars.sh"

SA_NAME="${VM_SERVICE_ACCOUNT%%@*}"

# 1) dedicated least-privilege service account
gcloud iam service-accounts create "${SA_NAME}" --project="${PROJECT_ID}" \
  --display-name="Stalwart mail VM" || echo "(SA may already exist)"

# 2) let the SA read ONLY the two secrets
for S in "${POSTGRES_PASSWORD_SECRET}" "${RECOVERY_ADMIN_SECRET}"; do
  gcloud secrets add-iam-policy-binding "${S}" --project="${PROJECT_ID}" \
    --member="serviceAccount:${VM_SERVICE_ACCOUNT}" \
    --role=roles/secretmanager.secretAccessor >/dev/null
done

# 3) persistent data disk for /etc/stalwart + /var/lib/stalwart
gcloud compute disks create "${DATA_DISK_NAME}" --project="${PROJECT_ID}" \
  --zone="${ZONE}" --size="${DATA_DISK_SIZE}" --type="${DATA_DISK_TYPE}" || \
  echo "(disk may already exist)"

# 4) the VM (Container-Optimized OS). The startup script formats/mounts the disk,
#    resolves secrets from Secret Manager, renders config.json, and runs the container.
gcloud compute instances create "${INSTANCE_NAME}" --project="${PROJECT_ID}" \
  --zone="${ZONE}" --machine-type="${MACHINE_TYPE}" \
  --image-family=cos-stable --image-project=cos-cloud \
  --boot-disk-size=20GB \
  --network-interface=network="${NETWORK}",subnet="${SUBNET}" \
  --service-account="${VM_SERVICE_ACCOUNT}" \
  --scopes=cloud-platform \
  --tags="${NETWORK_TAG}" \
  --disk=name="${DATA_DISK_NAME}",device-name=stalwart-data,mode=rw,boot=no \
  --shielded-secure-boot --shielded-vtpm --shielded-integrity-monitoring \
  --metadata=postgres-host="${POSTGRES_HOST}",container-image="${CONTAINER_IMAGE}",pg-password-secret="${POSTGRES_PASSWORD_SECRET}",recovery-admin-secret="${RECOVERY_ADMIN_SECRET}" \
  --metadata-from-file=startup-script="${HERE}/../scripts/startup-script.sh"

echo "VM ${INSTANCE_NAME} created. Verify health via IAP:"
echo "  gcloud compute start-iap-tunnel ${INSTANCE_NAME} 8080 --zone=${ZONE} --local-host-port=localhost:8080 &"
echo "  curl -fsS http://localhost:8080/healthz/ready && echo READY"
