#!/usr/bin/env bash
# Source after cd to the application directory. Never source executable .env text.
[[ -z "${COMPOSE_FILE:-}${COMPOSE_PROJECT_NAME:-}${COMPOSE_PROFILES:-}" ]] || {
  printf '%s\n' 'Unset COMPOSE_FILE, COMPOSE_PROJECT_NAME and COMPOSE_PROFILES before using production scripts.' >&2
  return 1
}
deployment_mode="${DEPLOYMENT_MODE:-}"
if [[ -z "$deployment_mode" && -f .env ]]; then
  deployment_mode="$(sed -n 's/^DEPLOYMENT_MODE=\([a-z-]*\)[[:space:]]*$/\1/p' .env)"
fi
case "${deployment_mode:-standalone}" in
  standalone) deployment_mode=standalone; compose_file=compose.yaml ;;
  tools) compose_file=compose.tools.yaml ;;
  *) printf '%s\n' 'DEPLOYMENT_MODE must be standalone or tools.' >&2; return 1 ;;
esac
dc() { docker compose -f "$compose_file" "$@"; }
