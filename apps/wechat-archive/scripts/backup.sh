#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/compose.sh
exec 9>.operation.lock
flock -n 9 || { printf "%s\n" "Another deployment, backup or restore is running." >&2; exit 1; }
umask 077
mkdir -p backups
root="$(pwd)"
stage="$(mktemp -d "$root/backups/staging-XXXXXX")"
cleanup() { rm -rf "$stage"; }
trap cleanup EXIT
fail() { dc run --rm ops node --import tsx scripts/operations.ts backup-status failed '备份失败，请检查服务器日志' || true; }
trap fail ERR
dc exec -T db pg_dump -U archive -d archive -Fc > "$stage/database.dump"
dc run --rm -v "$stage:/snapshot" ops node --import tsx scripts/operations.ts snapshot /snapshot
stamp="$(date -u +%Y-%m-%dT%H-%M-%S)"
name="wechat-daily-$stamp.wca"
dc run --rm -v "$stage:/snapshot:ro" -v "$root/backups:/backups" ops node --import tsx scripts/operations.ts seal /snapshot "/backups/$name"
if [ "$(TZ=Asia/Shanghai date +%u)" = 1 ]; then cp "$root/backups/$name" "$root/backups/wechat-weekly-$stamp.wca"; fi
dc run --rm -v "$root/backups:/backups" ops node --import tsx scripts/operations.ts rotate /backups
dc run --rm ops node --import tsx scripts/operations.ts backup-status ok "${name}（请确认异机副本）"
printf '%s\n' "Encrypted backup: backups/$name. Copy it to your offsite backup destination."
