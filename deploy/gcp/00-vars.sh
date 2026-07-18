#!/bin/bash
# Load + validate deployment variables. Source this from the other scripts:
#     set -a; source deploy/.env; set +a   # your real values (gitignored)
#     source deploy/gcp/00-vars.sh          # defaults + validation
#
# Real values live in deploy/.env (copied from deploy/.env.example). This file
# only sets safe defaults and checks that the required variables are present.
set -euo pipefail

: "${PROJECT_ID:?set PROJECT_ID in deploy/.env}"
: "${POSTGRES_HOST:?set POSTGRES_HOST (Cloud SQL public IP) in deploy/.env}"

# ---- defaults (override in deploy/.env) ----
export REGION="${REGION:-europe-west6}"
export ZONE="${ZONE:-europe-west6-a}"
export INSTANCE_NAME="${INSTANCE_NAME:-stalwart-mail}"
export MACHINE_TYPE="${MACHINE_TYPE:-e2-small}"
export NETWORK="${NETWORK:-default}"
export SUBNET="${SUBNET:-default}"
export NETWORK_TAG="${NETWORK_TAG:-stalwart-mail}"
export DATA_DISK_NAME="${DATA_DISK_NAME:-stalwart-data}"
export DATA_DISK_SIZE="${DATA_DISK_SIZE:-20GB}"
export DATA_DISK_TYPE="${DATA_DISK_TYPE:-pd-balanced}"
export CONTAINER_IMAGE="${CONTAINER_IMAGE:-docker.io/stalwartlabs/stalwart:latest}"
export VM_SERVICE_ACCOUNT="${VM_SERVICE_ACCOUNT:-stalwart-vm@${PROJECT_ID}.iam.gserviceaccount.com}"
export POSTGRES_PASSWORD_SECRET="${POSTGRES_PASSWORD_SECRET:-stalwart-postgres-password}"
export RECOVERY_ADMIN_SECRET="${RECOVERY_ADMIN_SECRET:-stalwart-recovery-admin}"
# IAP TCP-forwarding range — admin/mail ports reachable only through an IAP tunnel.
export ADMIN_SOURCE_RANGE="${ADMIN_SOURCE_RANGE:-35.235.240.0/20}"

echo "Project=${PROJECT_ID} Zone=${ZONE} Instance=${INSTANCE_NAME} Machine=${MACHINE_TYPE}"
