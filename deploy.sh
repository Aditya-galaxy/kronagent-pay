#!/usr/bin/env bash
#
# Deploy the judge-facing console to Cloud Run.
#
# Idempotent: re-running redeploys the same service rather than creating a
# second one. Safe to run from a laptop or from CI.
#
#   ./deploy.sh                      # deploy with defaults
#   PROJECT=my-gcp-project ./deploy.sh
#
set -euo pipefail

PROJECT="${PROJECT:-$(gcloud config get-value project 2>/dev/null)}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-kronagent-payouts}"

if [ -z "$PROJECT" ] || [ "$PROJECT" = "(unset)" ]; then
  echo "No GCP project set. Run: gcloud config set project <project-id>" >&2
  exit 1
fi

echo "Deploying $SERVICE to $PROJECT ($REGION)"

# --allow-unauthenticated is a competition requirement, not laziness: judges
# must reach a working instance "free of charge and without any restriction".
gcloud run deploy "$SERVICE" \
  --source . \
  --project "$PROJECT" \
  --region "$REGION" \
  --allow-unauthenticated \
  --port 8080 \
  --cpu 1 \
  --memory 512Mi \
  --min-instances 1 \
  --max-instances 4 \
  --timeout 60s \
  --set-env-vars "NODE_ENV=production,GCS_BUCKET=${GCS_BUCKET:-},TICK_SECRET=${TICK_SECRET:-}"

URL="$(gcloud run services describe "$SERVICE" --project "$PROJECT" --region "$REGION" --format='value(status.url)')"
echo
echo "Live: $URL"
echo "Health: $(curl -fsS "$URL/healthz" || echo 'FAILED')"

# Both of these are fail-closed rather than fail-quiet, because the ways they
# fail are silent ones: without a bucket the campaign store is in-memory on a
# service that scales to zero, so no view ever survives the dwell window and
# every submission is held forever; without a secret the payout endpoint
# refuses to run at all, which is the correct choice but looks like nothing
# happening.
if [ -z "${GCS_BUCKET:-}" ]; then
  echo
  echo "WARNING: GCS_BUCKET unset — campaign state is in-memory and dies with the" >&2
  echo "         instance. The 24h dwell window can never be satisfied. Create one:" >&2
  echo "           gsutil mb -p $PROJECT gs://$SERVICE-state" >&2
  echo "           GCS_BUCKET=$SERVICE-state ./deploy.sh" >&2
fi

if [ -z "${TICK_SECRET:-}" ]; then
  echo
  echo "WARNING: TICK_SECRET unset — /api/tick returns 503 and no payouts run." >&2
  echo "         The service is public by competition requirement, so this endpoint" >&2
  echo "         is the one thing that must not be. Generate and redeploy:" >&2
  echo "           TICK_SECRET=\$(openssl rand -hex 24) GCS_BUCKET=$SERVICE-state ./deploy.sh" >&2
  exit 0
fi

cat <<SCHEDULER

Schedule the agent (hourly). Cloud Scheduler rather than an in-process timer,
so each pass is an HTTP request and Cloud Logging keeps the execution log:

  gcloud scheduler jobs create http ${SERVICE}-tick \\
    --project $PROJECT --location $REGION \\
    --schedule "0 * * * *" \\
    --uri "$URL/api/tick" \\
    --http-method POST \\
    --headers "x-tick-secret=\$TICK_SECRET"
SCHEDULER
