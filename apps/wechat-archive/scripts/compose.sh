#!/usr/bin/env bash
# Source after cd to the application directory. Never source executable .env text.
[[ -z "${COMPOSE_FILE:-}${COMPOSE_PROJECT_NAME:-}${COMPOSE_PROFILES:-}" ]] || {
  printf '%s\n' 'Unset COMPOSE_FILE, COMPOSE_PROJECT_NAME and COMPOSE_PROFILES before using production scripts.' >&2
  return 1
}
deployment_mode="${DEPLOYMENT_MODE:-}"
if [[ -z "$deployment_mode" && -f .env ]]; then
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    if [[ "$line" =~ ^[[:space:]]*(export[[:space:]]+)?DEPLOYMENT_MODE[[:space:]]*= ]]; then
      raw="${line#*=}"
      raw="${raw%%#*}"
      raw="$(printf '%s' "$raw" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
      case "$raw" in
        tools|\"tools\"|\'tools\') deployment_mode=tools ;;
        standalone|\"standalone\"|\'standalone\') deployment_mode=standalone ;;
        *) printf '%s\n' 'Invalid DEPLOYMENT_MODE in .env; expected tools or standalone.' >&2; return 1 ;;
      esac
    fi
  done < .env
fi
case "${deployment_mode:-standalone}" in
  standalone) deployment_mode=standalone; compose_file=compose.yaml ;;
  tools) compose_file=compose.tools.yaml ;;
  *) printf '%s\n' 'DEPLOYMENT_MODE must be standalone or tools.' >&2; return 1 ;;
esac
dc() { docker compose -f "$compose_file" "$@"; }
