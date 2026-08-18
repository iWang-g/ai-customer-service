#!/usr/bin/env bash
set -Eeuo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: RESTORE_CONFIRM=yes $0 /path/to/backup.tar.gz" >&2
  exit 2
fi
if [[ "${RESTORE_CONFIRM:-}" != "yes" ]]; then
  echo "Set RESTORE_CONFIRM=yes to confirm the restore." >&2
  exit 2
fi

DEPLOY_DIR="${ACS_DEPLOY_DIR:-/opt/ai-customer-service}"
COMPOSE_FILE="$DEPLOY_DIR/deploy/production/compose.yaml"
ENV_FILE="$DEPLOY_DIR/deploy/production/.env"
ARCHIVE="$(realpath "$1")"

tar -tzf "$ARCHIVE" | while IFS= read -r entry; do
  if [[ "$entry" == /* || "$entry" == *../* ]]; then
    echo "Unsafe archive entry: $entry" >&2
    exit 1
  fi
done

cd "$DEPLOY_DIR"
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" down
tar -xzf "$ARCHIVE" -C "$DEPLOY_DIR"
chown -R 10001:10001 \
  deploy/production/data/business-api \
  deploy/production/data/knowledge-base
chmod 600 deploy/production/.env
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d
