#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 /absolute/path/to/newsbot-backup.dump" >&2
  exit 1
fi

BACKUP_FILE=$1
case "$BACKUP_FILE" in
  /*) ;;
  *) echo "Backup path must be absolute" >&2; exit 1 ;;
esac
if [ ! -f "$BACKUP_FILE" ]; then
  echo "Backup does not exist: $BACKUP_FILE" >&2
  exit 1
fi

PROJECT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
COMPOSE_FILE="$PROJECT_DIR/docker-compose.production.yml"
ENV_FILE="$PROJECT_DIR/.env.production"

echo "This will replace the newsbot database contents from: $BACKUP_FILE"
printf "Type RESTORE to continue: "
read -r CONFIRMATION
if [ "$CONFIRMATION" != "RESTORE" ]; then
  echo "Restore cancelled"
  exit 1
fi

restart_app() {
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d app caddy >/dev/null 2>&1 || true
}
trap restart_app EXIT INT TERM

docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" stop app
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T postgres \
  pg_restore -U newsbot -d newsbot --clean --if-exists --no-owner --no-privileges < "$BACKUP_FILE"

docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" run --rm migrate
trap - EXIT INT TERM
echo "Restore completed. Starting application."
restart_app
