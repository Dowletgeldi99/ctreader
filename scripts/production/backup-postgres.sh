#!/bin/sh
set -eu

PROJECT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
COMPOSE_FILE="$PROJECT_DIR/docker-compose.production.yml"
ENV_FILE="$PROJECT_DIR/.env.production"
BACKUP_DIR="$PROJECT_DIR/backups/postgres"
RETENTION_DAYS=${BACKUP_RETENTION_DAYS:-14}

if [ ! -f "$ENV_FILE" ]; then
  echo "Missing $ENV_FILE" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
TARGET="$BACKUP_DIR/newsbot-$STAMP.dump"

docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T postgres \
  pg_dump -U newsbot -d newsbot --format=custom --no-owner --no-privileges > "$TARGET"

docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T postgres \
  pg_restore --list < "$TARGET" > /dev/null

find "$BACKUP_DIR" -type f -name 'newsbot-*.dump' -mtime "+$RETENTION_DAYS" -delete
echo "Backup created: $TARGET"
