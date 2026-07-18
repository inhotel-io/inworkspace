#!/bin/bash
# SAFE-MODE firewall. Admin + mail-client ports are reachable ONLY from the IAP
# range (i.e. only through `gcloud compute start-iap-tunnel`). SMTP :25 is NOT
# opened to the internet at all, plus an explicit belt-and-suspenders deny.
#
# Usage:
#   set -a; source deploy/.env; set +a
#   source deploy/gcp/00-vars.sh
#   bash deploy/gcp/10-firewall.sh
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${HERE}/00-vars.sh"

# Admin/setup (8080,443) + mail-client ports, restricted to IAP (or your VPN CIDR).
gcloud compute firewall-rules create stalwart-admin-allow \
  --project="${PROJECT_ID}" --network="${NETWORK}" \
  --direction=INGRESS --action=ALLOW \
  --rules=tcp:8080,tcp:443,tcp:993,tcp:995,tcp:587,tcp:465,tcp:143,tcp:110,tcp:4190 \
  --source-ranges="${ADMIN_SOURCE_RANGE}" \
  --target-tags="${NETWORK_TAG}" \
  --description="Stalwart admin+mail ports, IAP-only (safe mode)" || \
  echo "(rule stalwart-admin-allow may already exist)"

# Allow IAP to reach SSH for troubleshooting.
gcloud compute firewall-rules create stalwart-iap-ssh \
  --project="${PROJECT_ID}" --network="${NETWORK}" \
  --direction=INGRESS --action=ALLOW \
  --rules=tcp:22 --source-ranges=35.235.240.0/20 \
  --target-tags="${NETWORK_TAG}" \
  --description="IAP SSH to Stalwart VM" || \
  echo "(rule stalwart-iap-ssh may already exist)"

# Belt-and-suspenders: explicitly DENY SMTP :25 from the internet in safe mode.
gcloud compute firewall-rules create stalwart-smtp-deny-25 \
  --project="${PROJECT_ID}" --network="${NETWORK}" \
  --direction=INGRESS --action=DENY \
  --rules=tcp:25 --source-ranges=0.0.0.0/0 \
  --target-tags="${NETWORK_TAG}" --priority=1000 \
  --description="Deny inbound SMTP until hardened (safe mode)" || \
  echo "(rule stalwart-smtp-deny-25 may already exist)"

echo "Firewall configured (safe mode: no public :25, admin/mail via IAP only)."
