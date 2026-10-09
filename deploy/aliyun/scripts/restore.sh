#!/usr/bin/env bash
# Usage: restore.sh <env> <backup-date YYYY-MM-DD>
# Restores both databases and the Paperclip data volume from OSS. The backup
# is downloaded first; services are stopped only once it is safely on disk.
set -euo pipefail

# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"

[ "$#" -eq 2 ] || die "usage: restore.sh <env> <backup-date YYYY-MM-DD>"
BACKUP_DATE="$2"
load_environment "$1"
[ -n "$OSS_BACKUP_BUCKET" ] || die "OSS_BACKUP_BUCKET is not set in $ENV_FILE"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

ossutil_args
ossutil cp -r -f "${OSSUTIL_ARGS[@]}" "$OSS_BACKUP_BUCKET/$BACKUP_DATE/" "$work/" >/dev/null \
  || die "could not download $OSS_BACKUP_BUCKET/$BACKUP_DATE/"
for file in paperclip.dump keycloak.dump paperclip-data.tgz; do
  [ -s "$work/$file" ] || die "backup $BACKUP_DATE is missing $file"
done

PAPERCLIP_IMAGE_TAG="$(cat "$STATE_DIR/current" 2>/dev/null || true)"
[ -n "$PAPERCLIP_IMAGE_TAG" ] || die "no deployed version recorded in $STATE_DIR/current"
export PAPERCLIP_IMAGE_TAG

echo "restoring $BACKUP_DATE into $PAPERCLIP_IMAGE_TAG"
compose stop paperclip keycloak
compose up -d postgres
for db in paperclip keycloak; do
  compose exec -T postgres pg_restore -U postgres --clean --if-exists --no-owner --role="$db" -d "$db" \
    < "$work/$db.dump"
done
compose run --rm --no-deps -T --entrypoint sh paperclip -c 'tar xzf - -C /paperclip/instances/default' \
  < "$work/paperclip-data.tgz"
compose up -d --remove-orphans

if ! wait_healthy "$PAPERCLIP_IMAGE_TAG"; then
  die "services did not become healthy after restoring $BACKUP_DATE"
fi
echo "restored $BACKUP_DATE"
