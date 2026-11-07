#!/usr/bin/env bash
# Mashkif local development environment. Runs inside WSL.
#
# The environment is shared by every checkout and worktree on the machine: it
# uses the Compose project mashkif-dev and the machine-local
# docker-compose-dev.yml and .env from the root of the main checkout. The image
# mashkif-app:dev is built from the checkout this script belongs to.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"
# shellcheck source=lib/dev-env.sh
source "$SCRIPT_DIR/lib/dev-env.sh"

usage() {
  cat <<EOF
Usage:
  scripts/local.sh build     Build $MASHKIF_DEV_IMAGE from this checkout.
  scripts/local.sh up        Build, start, and check the environment, then follow
                             the logs. Ctrl+C stops the environment (data is kept).
  scripts/local.sh up -d     Build, start in the background, and check.
  scripts/local.sh down      Stop and remove the containers. Data is kept.
  scripts/local.sh status    Show containers, images, the data directory, and any
                             try-pr session. Changes nothing.
  scripts/local.sh nuke      Stop the environment and delete the data directory
                             after you type the project ID ($MASHKIF_DEV_PROJECT_ID).

Machine-local files in the main checkout (both ignored by Git):
  docker-compose-dev.yml     from config/docker-compose-dev.example.yml
  .env                       from .env.example

Exit codes: 0 success, 1 failed or refused, 2 usage or environment error.
EOF
}

preflight() {
  require_cmd docker || return
  require_cmd flock || return
  require_cmd realpath || return
  if ! docker info >/dev/null 2>&1; then
    fail "the Docker daemon is not reachable"
    return "$MASHKIF_EXIT_ENV"
  fi
  mashkif_refuse_try_pr_worktree
}

# check_settings: validates .env values that local.sh relies on and exports
# the normalized paths so Compose sees the same values.
check_settings() {
  local geoip password url placeholder
  mashkif_data_dir || return
  DATA_DIR="$MASHKIF_DATA_DIR"
  geoip="$(mashkif_env_value MASHKIF_GEOIP_DIR || true)"
  if [[ -z "$geoip" ]]; then
    fail "MASHKIF_GEOIP_DIR is not set in $MASHKIF_DEV_ENV_FILE"
    return "$MASHKIF_EXIT_ENV"
  fi
  geoip="$(mashkif_normalize_path "$geoip")" || return
  if [[ ! -r "$geoip/GeoLite2-ASN.mmdb" ]]; then
    fail "MASHKIF_GEOIP_DIR ($geoip) has no readable GeoLite2-ASN.mmdb"
    return "$MASHKIF_EXIT_ENV"
  fi
  export MASHKIF_GEOIP_DIR="$geoip"
  password="$(mashkif_env_value POSTGRES_PASSWORD || true)"
  url="$(mashkif_env_value DATABASE_URL || true)"
  # The same placeholder as ENV_EXAMPLE_PLACEHOLDER in server/src/config.ts;
  # a server test checks that .env.example uses it.
  placeholder="$(sed -n 's/^POSTGRES_PASSWORD=//p' "$MASHKIF_ROOT/.env.example")"
  if [[ -z "$placeholder" ]]; then
    fail "$MASHKIF_ROOT/.env.example has no POSTGRES_PASSWORD placeholder"
    return "$MASHKIF_EXIT_ENV"
  fi
  if [[ -z "$password" || "$password" == "$placeholder" || "$url" == *"$placeholder"* ]]; then
    fail "$MASHKIF_DEV_ENV_FILE still has the placeholder database password; set POSTGRES_PASSWORD and the same password in DATABASE_URL"
    return "$MASHKIF_EXIT_ENV"
  fi
  if ! mashkif_dev_compose config --quiet; then
    fail "docker compose rejected $MASHKIF_DEV_COMPOSE_FILE"
    return "$MASHKIF_EXIT_ENV"
  fi
}

# build_image: builds mashkif-app:dev and sets BUILT_IMAGE_ID. Nothing in the
# running environment changes before this succeeds.
build_image() {
  local iidfile
  iidfile="$(mashkif_state_dir)/build.iid.$$"
  rm -f -- "$iidfile"
  log "building $MASHKIF_DEV_IMAGE from $MASHKIF_ROOT"
  if ! docker build -f "$MASHKIF_ROOT/config/docker/app.Dockerfile" -t "$MASHKIF_DEV_IMAGE" \
    --iidfile "$iidfile" "$MASHKIF_ROOT" >&2; then
    rm -f -- "$iidfile"
    fail "the image build failed; the running environment was not changed"
    return "$MASHKIF_EXIT_FAILED"
  fi
  BUILT_IMAGE_ID="$(cat -- "$iidfile")"
  rm -f -- "$iidfile"
  log "built $MASHKIF_DEV_IMAGE: $BUILT_IMAGE_ID"
}

cmd_build() {
  preflight || return
  mashkif_dev_lock || return
  mashkif_refuse_during_try_pr || return
  mkdir -p "$(mashkif_state_dir)"
  build_image
}

cmd_up() {
  local detach="$1" port
  preflight || return
  mashkif_dev_files || return
  mashkif_dev_lock || return
  mashkif_refuse_during_try_pr || return
  check_settings || return
  build_image || return
  mashkif_data_prepare "$DATA_DIR" || return
  log "starting $MASHKIF_DEV_PROJECT"
  mashkif_dev_compose_up --remove-orphans || return
  # Compose does not always notice that the mashkif-app:dev tag moved to a new
  # image while app is running; recreate app (never db) when it did not.
  if [[ "$(docker inspect -f '{{.Image}}' "$(mashkif_container_id app)" 2>/dev/null)" != "$BUILT_IMAGE_ID" ]]; then
    log "recreating app with the image just built"
    mashkif_dev_compose_up --no-deps --force-recreate app || return
  fi
  mashkif_dev_check_running "$BUILT_IMAGE_ID" "app runs the image just built" || return
  port="$(mashkif_dev_compose port app 8080 2>/dev/null || true)"
  log "Mashkif is running: http://${port:-127.0.0.1:<port>}"
  ((detach)) && return 0

  mashkif_dev_unlock
  log "Following the logs. Press Ctrl+C to stop the environment; data is kept."
  trap ':' INT TERM
  mashkif_dev_compose logs -f --tail 20 || true
  trap - INT TERM
  mashkif_dev_lock || return
  mashkif_refuse_during_try_pr || return
  log "stopping $MASHKIF_DEV_PROJECT"
  mashkif_dev_compose down --remove-orphans
}

cmd_down() {
  preflight || return
  mashkif_dev_files || return
  mashkif_dev_lock || return
  mashkif_refuse_during_try_pr || return
  mashkif_data_dir || return
  mashkif_dev_compose down --remove-orphans
  log "stopped $MASHKIF_DEV_PROJECT; the data directory is kept"
}

cmd_status() {
  local state lock_state try_state dev_id app running dir flag
  preflight || return
  mashkif_dev_files || return
  state="$(mashkif_state_dir)"
  mashkif_data_dir || return
  dir="$MASHKIF_DATA_DIR"
  if [[ ! -e "$state/dev.lock" ]] || flock -n "$state/dev.lock" true; then
    lock_state=free
  else
    lock_state="held by a running local.sh or try-pr.sh"
  fi
  try_state="$(mashkif_try_pr_state_file)"
  printf 'Project:        %s\n' "$MASHKIF_DEV_PROJECT"
  printf 'Main checkout:  %s\n' "$MASHKIF_DEV_CHECKOUT_DIR"
  printf 'This checkout:  %s\n' "$MASHKIF_ROOT"
  printf 'Lock:           %s\n' "$lock_state"
  if [[ -e "$try_state" ]]; then
    printf 'try-pr session: pull request %s at %s (scripts/try-pr.sh status)\n' \
      "$(mashkif_state_get "$try_state" pr || echo '?')" "$(mashkif_state_get "$try_state" sha || echo '?')"
  else
    printf 'try-pr session: none\n'
  fi
  dev_id="$(docker image inspect -f '{{.Id}}' "$MASHKIF_DEV_IMAGE" 2>/dev/null || true)"
  printf 'Image %s: %s\n' "$MASHKIF_DEV_IMAGE" "${dev_id:-not built}"
  app="$(mashkif_container_id app)"
  if [[ -n "$app" ]]; then
    running="$(docker inspect -f '{{.Image}}' "$app" 2>/dev/null || true)"
    if [[ "$running" == "$dev_id" ]]; then
      printf 'Running app image: %s (matches %s)\n' "$running" "$MASHKIF_DEV_IMAGE"
    else
      printf 'Running app image: %s (differs from %s)\n' "$running" "$MASHKIF_DEV_IMAGE"
    fi
  fi
  printf 'Containers:\n'
  mashkif_dev_compose ps -a --format 'table {{.Service}}\t{{.Status}}\t{{.Ports}}' || true
  if [[ -f "$dir/$MASHKIF_DATA_MARKER" ]]; then
    flag="$(mashkif_state_get "$dir/$MASHKIF_DATA_MARKER" postgres_prepared || true)"
    printf 'Data directory: %s (marker present, postgres_prepared=%s)\n' "$dir" "${flag:-?}"
  elif [[ -e "$dir" ]]; then
    printf 'Data directory: %s (exists without a Mashkif marker)\n' "$dir"
  else
    printf 'Data directory: %s (absent)\n' "$dir"
  fi
}

cmd_nuke() {
  local dir answer=""
  preflight || return
  mashkif_dev_files || return
  mashkif_dev_lock || return
  mashkif_refuse_during_try_pr || return
  mashkif_data_dir || return
  dir="$MASHKIF_DATA_DIR"
  mashkif_nuke_target_check "$dir" || return
  if [[ ! -e "$dir" ]]; then
    mashkif_dev_compose down --remove-orphans
    log "the data directory $dir does not exist; nothing to delete"
    return 0
  fi
  log "This stops $MASHKIF_DEV_PROJECT and permanently deletes the development data in:"
  log "  $dir"
  printf 'Type %s to confirm: ' "$MASHKIF_DEV_PROJECT_ID" >&2
  read -r answer || true
  # End the prompt line when the answer was piped in.
  [[ -t 0 ]] || log ""
  if [[ "$answer" != "$MASHKIF_DEV_PROJECT_ID" ]]; then
    fail "not confirmed; nothing was deleted"
    return "$MASHKIF_EXIT_REFUSED"
  fi
  mashkif_dev_compose down --remove-orphans
  # Check again under the lock, right before deleting.
  mashkif_nuke_target_check "$dir" || return
  if ! mashkif_data_remove "$dir"; then
    fail "could not delete $dir completely; inspect it"
    return "$MASHKIF_EXIT_FAILED"
  fi
  log "deleted $dir"
}

main() {
  case "$#:${1:-}:${2:-}" in
    1:build:) cmd_build ;;
    1:up:) cmd_up 0 ;;
    2:up:-d | 2:up:--detach) cmd_up 1 ;;
    1:down: | 1:status: | 1:nuke:) "cmd_$1" ;;
    1:-h: | 1:--help:) usage ;;
    *)
      usage >&2
      return "$MASHKIF_EXIT_ENV"
      ;;
  esac
}

main "$@"
