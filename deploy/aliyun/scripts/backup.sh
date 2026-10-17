#!/usr/bin/env bash
# Usage: backup.sh <env>
# Daily backup (cron): dumps both databases and the Paperclip attachments and
# secrets master key, uploads them to OSS under <bucket>/<YYYY-MM-DD>/, then
# checks that both public certificates are valid for at least 7 more days.
set -euo pipefail

# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"

[ "$#" -eq 1 ] || die "usage: backup.sh <env>"
load_environment "$1"
[ -n "$OSS_BACKUP_BUCKET" ] || die "OSS_BACKUP_BUCKET is not set in $ENV_FILE"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
day="$(date +%F)"

for db in paperclip keycloak litellm; do
  compose exec -T postgres pg_dump -U postgres -Fc "$db" > "$work/$db.dump"
done
compose exec -T paperclip tar czf - -C /paperclip/instances/default data/storage secrets \
  > "$work/paperclip-data.tgz"

ossutil_args
ossutil cp -r -f "${OSSUTIL_ARGS[@]}" "$work/" "$OSS_BACKUP_BUCKET/$day/" >/dev/null \
  || die "upload to $OSS_BACKUP_BUCKET/$day/ failed"
echo "backup uploaded to $OSS_BACKUP_BUCKET/$day/"

status=0
for domain in "$APP_DOMAIN" "$SSO_DOMAIN"; do
  if ! openssl s_client -connect 127.0.0.1:443 -servername "$domain" </dev/null 2>/dev/null \
    | openssl x509 -noout -checkend 604800 >/dev/null; then
    echo "error: certificate for $domain expires within 7 days (or could not be read)" >&2
    status=1
  fi
done
exit "$status"
