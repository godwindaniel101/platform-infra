#!/usr/bin/env bash
#
# Deploys the Pact Broker to Cloud Run, with Cloud SQL for Postgres.
#
# The broker is a stateless HTTP container, so Cloud Run fits it well: it scales
# to zero between builds, it gets a public HTTPS address that a GitHub runner can
# reach, and the only stateful part is the database.
#
# Run it again whenever you want to change something. Every step checks first,
# so a second run is safe.
#
# Usage:
#   export GCP_PROJECT=your-project-id
#   ./deploy.sh
#
set -euo pipefail

PROJECT="${GCP_PROJECT:?set GCP_PROJECT to your Google Cloud project id}"
REGION="${GCP_REGION:-europe-west1}"
SERVICE="${BROKER_SERVICE:-pact-broker}"
SQL_INSTANCE="${BROKER_SQL_INSTANCE:-pact-broker-db}"
DB_NAME="${BROKER_DB_NAME:-pact_broker}"
DB_USER="${BROKER_DB_USER:-pactbroker}"
BROKER_USER="${BROKER_BASIC_AUTH_USER:-fincra}"

# Pinned, never "latest". A broker that upgrades itself under a deploy can
# migrate its database when nobody asked it to.
IMAGE="${BROKER_IMAGE:-pactfoundation/pact-broker:2.142.0-pactbroker2.120.0}"

# Cloud SQL: the smallest tier is enough. A broker stores text, and it is read
# a few times per build.
SQL_TIER="${BROKER_SQL_TIER:-db-f1-micro}"

say() { printf '\n\033[1m== %s\033[0m\n' "$1"; }

say "project ${PROJECT}, region ${REGION}"
gcloud config set project "$PROJECT" >/dev/null

say "1/7  enable the APIs"
gcloud services enable \
  run.googleapis.com \
  sqladmin.googleapis.com \
  secretmanager.googleapis.com \
  --project "$PROJECT"

say "2/7  the Postgres instance"
if gcloud sql instances describe "$SQL_INSTANCE" --project "$PROJECT" >/dev/null 2>&1; then
  echo "  ${SQL_INSTANCE} is already there"
else
  # This takes several minutes the first time.
  gcloud sql instances create "$SQL_INSTANCE" \
    --database-version=POSTGRES_16 \
    --tier="$SQL_TIER" \
    --region="$REGION" \
    --storage-auto-increase \
    --backup \
    --backup-start-time=02:00 \
    --project "$PROJECT"
fi

CONNECTION_NAME="$(gcloud sql instances describe "$SQL_INSTANCE" \
  --project "$PROJECT" --format='value(connectionName)')"
echo "  connection name: ${CONNECTION_NAME}"

say "3/7  the database and its user"
gcloud sql databases describe "$DB_NAME" --instance="$SQL_INSTANCE" --project "$PROJECT" \
  >/dev/null 2>&1 \
  || gcloud sql databases create "$DB_NAME" --instance="$SQL_INSTANCE" --project "$PROJECT"

# Two passwords, both generated here and never printed to the terminal. A
# password that appears in a scrollback buffer is a password you have to rotate.
if gcloud secrets describe pact-broker-db-password --project "$PROJECT" >/dev/null 2>&1; then
  echo "  the database password secret is already there"
else
  openssl rand -base64 32 | tr -d '\n' \
    | gcloud secrets create pact-broker-db-password --data-file=- --project "$PROJECT"
fi

if gcloud secrets describe pact-broker-basic-auth-password --project "$PROJECT" >/dev/null 2>&1; then
  echo "  the broker password secret is already there"
else
  openssl rand -base64 32 | tr -d '\n' \
    | gcloud secrets create pact-broker-basic-auth-password --data-file=- --project "$PROJECT"
fi

DB_PASSWORD="$(gcloud secrets versions access latest \
  --secret=pact-broker-db-password --project "$PROJECT")"

gcloud sql users describe "$DB_USER" --instance="$SQL_INSTANCE" --project "$PROJECT" \
  >/dev/null 2>&1 \
  && gcloud sql users set-password "$DB_USER" --instance="$SQL_INSTANCE" \
       --password="$DB_PASSWORD" --project "$PROJECT" \
  || gcloud sql users create "$DB_USER" --instance="$SQL_INSTANCE" \
       --password="$DB_PASSWORD" --project "$PROJECT"

say "4/7  let Cloud Run read the secrets"
SA="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')-compute@developer.gserviceaccount.com"
for secret in pact-broker-db-password pact-broker-basic-auth-password; do
  gcloud secrets add-iam-policy-binding "$secret" \
    --member="serviceAccount:${SA}" \
    --role=roles/secretmanager.secretAccessor \
    --project "$PROJECT" >/dev/null
done
echo "  granted to ${SA}"

say "5/7  deploy the broker"
# PACT_BROKER_PORT must match --port. Cloud Run sends traffic to that port.
#
# ALLOW_PUBLIC_READ is FALSE on purpose. This address is on the public internet,
# and a contract states the shape of an internal payment API. Read is
# authenticated, and PUBLIC_HEARTBEAT keeps only the health endpoint open so
# Cloud Run and the wait scripts can check it without credentials.
gcloud run deploy "$SERVICE" \
  --image="$IMAGE" \
  --region="$REGION" \
  --platform=managed \
  --port=8080 \
  --allow-unauthenticated \
  --add-cloudsql-instances="$CONNECTION_NAME" \
  --min-instances="${BROKER_MIN_INSTANCES:-0}" \
  --max-instances=4 \
  --memory=1Gi \
  --cpu=1 \
  --timeout=120 \
  --set-env-vars="PACT_BROKER_PORT=8080" \
  --set-env-vars="PACT_BROKER_DATABASE_ADAPTER=postgres" \
  --set-env-vars="PACT_BROKER_DATABASE_NAME=${DB_NAME}" \
  --set-env-vars="PACT_BROKER_DATABASE_USERNAME=${DB_USER}" \
  --set-env-vars="PACT_BROKER_DATABASE_HOST=/cloudsql/${CONNECTION_NAME}" \
  --set-env-vars="PACT_BROKER_BASIC_AUTH_USERNAME=${BROKER_USER}" \
  --set-env-vars="PACT_BROKER_ALLOW_PUBLIC_READ=false" \
  --set-env-vars="PACT_BROKER_PUBLIC_HEARTBEAT=true" \
  --set-env-vars="PACT_BROKER_LOG_LEVEL=INFO" \
  --set-secrets="PACT_BROKER_DATABASE_PASSWORD=pact-broker-db-password:latest" \
  --set-secrets="PACT_BROKER_BASIC_AUTH_PASSWORD=pact-broker-basic-auth-password:latest" \
  --project "$PROJECT"

URL="$(gcloud run services describe "$SERVICE" --region="$REGION" \
  --project "$PROJECT" --format='value(status.url)')"

say "6/7  check it answers"
# The heartbeat is public, so this needs no credentials.
for attempt in $(seq 1 30); do
  if curl -fsS "${URL}/diagnostic/status/heartbeat" >/dev/null 2>&1; then
    echo "  the broker is up at ${URL}"
    break
  fi
  [ "$attempt" -eq 30 ] && { echo "  it did not answer. run: gcloud run services logs read ${SERVICE} --region ${REGION}"; exit 1; }
  sleep 4
done

say "7/7  what to do next"
BROKER_PASSWORD="$(gcloud secrets versions access latest \
  --secret=pact-broker-basic-auth-password --project "$PROJECT")"

cat <<NEXT

The broker is live:
  ${URL}
  user: ${BROKER_USER}

Put the credentials into both service repositories. The password is printed
once here and read from Secret Manager after that.

  for repo in disbursement-service switch-service; do
    gh secret set PACT_BROKER_BASE_URL --repo <owner>/\$repo --body '${URL}'
    gh secret set PACT_BROKER_USERNAME --repo <owner>/\$repo --body '${BROKER_USER}'
    gh secret set PACT_BROKER_PASSWORD --repo <owner>/\$repo --body '$(printf '%s' "$BROKER_PASSWORD")'
  done

Then create the environments and the verification webhooks:

  PACT_BROKER_BASE_URL='${URL}' \\
  PACT_BROKER_USERNAME='${BROKER_USER}' \\
  PACT_BROKER_PASSWORD='<the password above>' \\
  CI_PLATFORM=github GITHUB_OWNER=<owner> GITHUB_TOKEN=<a token with repo scope> \\
    node scripts/create-webhooks.mjs

Until the webhook exists, a consumer change does not start the provider build,
and can-i-deploy answers "unknown". Unknown is not a pass.

NEXT
