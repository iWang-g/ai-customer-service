#!/usr/bin/env bash
set -Eeuo pipefail

DEPLOY_DIR="${ACS_DEPLOY_DIR:-/opt/ai-customer-service}"
BACKUP_DIR="${ACS_BACKUP_DIR:-/opt/backups/ai-customer-service}"
COMPOSE_FILE="$DEPLOY_DIR/deploy/production/compose.yaml"
ENV_FILE="$DEPLOY_DIR/deploy/production/.env"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
ARCHIVE="$BACKUP_DIR/ai-customer-service-$STAMP.tar.gz"

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

cd "$DEPLOY_DIR"
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" stop business-api ai-reply knowledge-base
restart_services() {
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d --wait --wait-timeout 120
}
trap restart_services EXIT

tar -czf "$ARCHIVE" \
  deploy/production/.env \
  deploy/production/data/business-api \
  deploy/production/data/knowledge-base
chmod 600 "$ARCHIVE"

restart_services
trap - EXIT

find "$BACKUP_DIR" -maxdepth 1 -type f -name 'ai-customer-service-*.tar.gz' -mtime +14 -delete

OFFSITE_BACKUP_DIR="$(sed -n 's/^OFFSITE_BACKUP_DIR=//p' "$ENV_FILE" | tail -n 1)"
if [[ -n "$OFFSITE_BACKUP_DIR" ]]; then
  install -d -m 700 "$OFFSITE_BACKUP_DIR"
  cp -p "$ARCHIVE" "$OFFSITE_BACKUP_DIR/"
fi

printf '%s\n' "$ARCHIVE"
