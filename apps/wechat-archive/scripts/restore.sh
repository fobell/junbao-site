#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/compose.sh
exec 9>.operation.lock
flock -n 9 || { printf "%s\n" "Another deployment, backup or restore is running." >&2; exit 1; }
if [ "$#" -lt 1 ]; then printf '%s\n' 'Usage: sudo bash scripts/restore.sh backups/file.wca [--replace-existing]'; exit 1; fi
backup="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
umask 077
mkdir -p backups
stage="$(mktemp -d "$(pwd)/backups/restore-XXXXXX")"
trap 'rm -rf "$stage"' EXIT
dc up -d db redis
until dc exec -T db pg_isready -U archive -d archive >/dev/null 2>&1; do sleep 2; done
exists="$(dc exec -T db psql -U archive -d archive -Atc "SELECT to_regclass('public.users') IS NOT NULL")"
if [ "$exists" = t ] && [ "${2:-}" != --replace-existing ]; then printf '%s\n' 'Database already contains the application. Back it up and pass --replace-existing explicitly to overwrite.'; exit 1; fi
dc run --rm -v "$backup:/restore.wca:ro" -v "$stage:/snapshot" ops node --import tsx scripts/operations.ts unseal /restore.wca /snapshot
dc stop api worker browser
dc exec -T db pg_restore -U archive -d archive --clean --if-exists --exit-on-error < "$stage/database.dump"
dc run --rm -v "$stage:/snapshot:ro" ops node --import tsx scripts/operations.ts restore-files /snapshot
services=(api worker browser egress-proxy)
[[ "$deployment_mode" != standalone ]] || services+=(caddy)
dc up -d "${services[@]}"
printf '%s\n' 'Restore completed. Verify login, search, images and a newly generated export. All web sessions were invalidated.'
