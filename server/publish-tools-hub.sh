#!/usr/bin/env bash
# Publish an already-built static directory; does not change the main site or Caddy.
set -euo pipefail
source_dir="${1:?Usage: publish-tools-hub.sh /path/to/dist release-id}"
release="${2:?Missing release-id}"
[[ "$release" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]*$ ]] || { echo 'Invalid release-id' >&2; exit 1; }
[[ -f "$source_dir/index.html" && -d "$source_dir/hub-assets" ]] || { echo 'Build tools hub first' >&2; exit 1; }
root=/var/www/junbao.ai/tools-hub
mkdir -p "$root/releases"
[[ ! -e "$root/releases/$release" ]] || { echo 'Release already exists; choose a new id' >&2; exit 1; }
mkdir "$root/releases/$release"
cp -a "$source_dir/." "$root/releases/$release/"
chmod -R a+rX "$root/releases/$release"
ln -s "releases/$release" "$root/current.next"
mv -Tf "$root/current.next" "$root/current"
echo "Tools hub published: $release"
