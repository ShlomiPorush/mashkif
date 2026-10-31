# shellcheck shell=bash
# Contracts area: lints contracts/openapi.yaml and checks that the committed
# TypeScript types match freshly generated ones. Sourced by scripts/verify.sh.
#
# This file also holds the Node container helpers shared by the contracts,
# server, and web areas. Node and pnpm never run on the host: every command
# runs in the official Node image with the repository bind-mounted, and pnpm
# comes from corepack and the packageManager field in package.json.

MASHKIF_NODE_IMAGE="node:24.22.2-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c"

# mashkif_node_cache: prints the cache directory for corepack and the pnpm
# store, creating it if needed. It lives under the scratch root, never in the
# repository.
mashkif_node_cache() {
  local root
  if ! root="$(mashkif_tmp_root)"; then
    fail "no scratch location: set MASHKIF_TMP_DIR (locally the T: drive is expected at /mnt/t)"
    return "$MASHKIF_EXIT_ENV"
  fi
  mkdir -p "$root/cache/corepack" "$root/cache/pnpm-store" && printf '%s/cache\n' "$root"
}

# mashkif_node_run <network> <workdir> <command> [args...]
# Runs a command in the Node container as the calling user. <network> is a
# Docker network name, "none" for offline steps, or "default". <workdir> is
# relative to the repository root.
mashkif_node_run() {
  local network="$1" workdir="$2" cache
  shift 2
  require_cmd docker "Node and pnpm run in the official Node image" || return
  cache="$(mashkif_node_cache)" || return
  local -a net_args=()
  [[ "$network" == default ]] || net_args=(--network "$network")
  docker run --rm --init "${net_args[@]}" \
    --user "$(id -u):$(id -g)" \
    -e CI=true \
    -e HOME=/tmp/home \
    -e COREPACK_HOME=/cache/corepack \
    -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    -e REDOCLY_TELEMETRY=off \
    -e REDOCLY_SUPPRESS_UPDATE_NOTICE=true \
    -v "$MASHKIF_ROOT:/repo" \
    -v "$cache:/cache" \
    -w "/repo/$workdir" \
    "$MASHKIF_NODE_IMAGE" "$@"
}

# mashkif_pnpm_install: installs the workspace from the committed lockfile.
# This is the only step with network access; it also caches pnpm itself for
# the offline steps that follow.
mashkif_pnpm_install() {
  mashkif_node_run default . corepack pnpm install --frozen-lockfile --store-dir /cache/pnpm-store
}

# mashkif_node_steps <label> <workdir> <step>...
# Each step is "<name>|<shell command>" and runs offline in the Node container.
# Prints ok or FAIL per step and returns 1 when any step failed, 2 on an
# environment error.
mashkif_node_steps() {
  local label="$1" workdir="$2" step name command rc failed=0
  shift 2
  for step in "$@"; do
    name="${step%%|*}"
    command="${step#*|}"
    set +e
    mashkif_node_run none "$workdir" bash -euo pipefail -c "$command" >&2
    rc=$?
    set -e
    case "$rc" in
      0) log "  ok    $label $name" ;;
      *)
        failed=1
        log "  FAIL  $label $name (exit $rc)"
        ;;
    esac
  done
  return "$failed"
}

# mashkif_js_setup: environment checks and workspace install shared by the
# JavaScript areas.
mashkif_js_setup() {
  require_cmd docker "Node and pnpm run in the official Node image" || return
  if ! docker info >/dev/null 2>&1; then
    fail "the Docker daemon is not reachable"
    return "$MASHKIF_EXIT_ENV"
  fi
  if ! mashkif_pnpm_install >&2; then
    fail "pnpm install --frozen-lockfile failed (if package.json changed, update pnpm-lock.yaml)"
    return "$MASHKIF_EXIT_FAILED"
  fi
  log "  ok    pnpm install --frozen-lockfile"
}

verify_contracts() {
  mashkif_js_setup || return
  mashkif_node_steps contracts contracts \
    "lint|corepack pnpm run lint" \
    "types are up to date|out=\$(mktemp -d)/openapi.d.ts
      corepack pnpm exec openapi-typescript openapi.yaml --output \"\$out\" >/dev/null
      if ! diff -u generated/openapi.d.ts \"\$out\"; then
        echo 'contracts/generated/openapi.d.ts is out of date: run pnpm --filter @mashkif/contracts run generate' >&2
        exit 1
      fi"
}
