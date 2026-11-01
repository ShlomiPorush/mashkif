# shellcheck shell=bash
# Test doubles for the local.sh and try-pr.sh tests. Source this file from a
# test script; do not run it.
#
# mashkif_shims_install <dir> writes fake `docker`, `stat`, and `dotnet.exe`
# commands into <dir>/bin and their state into <dir>/state. The fake Docker
# keeps images, tags, containers, and applied migrations in plain files, so
# tests never reach a Docker daemon. The output formats follow what the real
# commands print (docker top, inspect templates, compose ps -q).
#
# Behaviour switches are files in <dir>/state/behave/:
#   build-fail      docker build fails
#   port-busy       compose up fails with an occupied host port
#   unhealthy       compose up --wait reports an unhealthy app
#   root-process    docker top shows a process running as UID 0
#   stale-image     compose up starts app from an unrelated image
#   chown-fail      the one-shot ownership container fails
#   chown-noop      the ownership container succeeds but ownership is not kept
#   kill-on-app-up  compose up of app with the try-pr override kills the caller's
#                   process group (simulates an interrupted run); removed after use
#   msi-fail        dotnet.exe build fails

mashkif_shims_install() {
  local dir="$1"
  mkdir -p "$dir/bin" "$dir/state/behave" "$dir/state/tags" "$dir/state/ids" "$dir/state/containers"
  : >"$dir/state/calls.log"
  : >"$dir/state/applied"
  : >"$dir/state/chowned"
  printf '0\n' >"$dir/state/db-created"

  cat >"$dir/bin/docker" <<'SHIM'
#!/usr/bin/env bash
# Fake docker for Mashkif script tests.
set -euo pipefail
S="${MASHKIF_SHIM_STATE:?MASHKIF_SHIM_STATE is not set}"
printf '%s\n' "$*" >>"$S/calls.log"

behave() { [[ -e "$S/behave/$1" ]]; }
key() { printf '%s' "$1" | tr '/:@' '___'; }

# image_id <ref>: resolves a tag or an ID to a known image ID.
image_id() {
  local ref="$1"
  if [[ "$ref" == sha256:* ]]; then
    [[ -f "$S/ids/$(key "$ref")" ]] && printf '%s\n' "$ref" && return 0
    return 1
  fi
  [[ "$ref" == *:* ]] || ref="$ref:latest"
  [[ -f "$S/tags/$(key "$ref")" ]] || return 1
  cat "$S/tags/$(key "$ref")"
}

journal_whens() {
  python3 -I -c '
import json, sys
print("\n".join(str(int(e["when"])) for e in json.load(open(sys.argv[1])).get("entries", [])))
' "$1"
}

container_dir() { printf '%s/containers/%s\n' "$S" "$1"; }

set_container() {
  local name="$1" image="$2" health="$3" d
  d="$(container_dir "$name")"
  mkdir -p "$d"
  printf '%s\n' "$image" >"$d/image"
  printf 'true\n' >"$d/running"
  printf '%s\n' "$health" >"$d/health"
}

# The server applies its migrations when it starts.
apply_migrations() {
  local id="$1" merged
  merged="$( { tr ',' '\n' <"$S/applied"; journal_whens "$S/ids/$(key "$id")"; } | grep -E '^[0-9]+$' | sort -n -u | paste -sd, - || true)"
  printf '%s\n' "$merged" >"$S/applied"
}

compose() {
  local override="" sub app_ref=mashkif-app:dev a
  while (($#)); do
    case "$1" in
      -p | --project-directory) shift 2 ;;
      -f)
        [[ "$2" == *try-pr.compose.yml ]] && override="$2"
        shift 2
        ;;
      *) break ;;
    esac
  done
  sub="$1"
  shift
  [[ -n "$override" ]] && app_ref="$(awk '$1 == "image:" { print $2 }' "$override")"
  case "$sub" in
    config) return 0 ;;
    up)
      local -a services=()
      for a in "$@"; do
        case "$a" in
          -* | [0-9]*) ;;
          *) services+=("$a") ;;
        esac
      done
      ((${#services[@]})) || services=(db app)
      if behave port-busy; then
        echo "Error response from daemon: failed to set up container networking: Bind for 127.0.0.1:8180 failed: port is already allocated" >&2
        return 1
      fi
      for a in "${services[@]}"; do
        case "$a" in
          db)
            if [[ ! -d "$(container_dir mashkif-dev-db-1)" ]]; then
              set_container mashkif-dev-db-1 "$(image_id postgres:18 || echo sha256:postgres)" healthy
              echo $(($(cat "$S/db-created") + 1)) >"$S/db-created"
            else
              printf 'true\n' >"$(container_dir mashkif-dev-db-1)/running"
            fi
            ;;
          app)
            if behave kill-on-app-up && [[ -n "$override" ]]; then
              rm -f "$S/behave/kill-on-app-up"
              kill -KILL 0
            fi
            local id
            id="$(image_id "$app_ref")" || {
              echo "Error: no such image: $app_ref" >&2
              return 1
            }
            apply_migrations "$id"
            behave stale-image && id="sha256:stale"
            if behave unhealthy; then
              set_container mashkif-dev-app-1 "$id" unhealthy
              echo "container mashkif-dev-app-1 is unhealthy" >&2
              return 1
            fi
            set_container mashkif-dev-app-1 "$id" healthy
            ;;
        esac
      done
      ;;
    ps)
      local quiet=0 all=0 service=""
      for a in "$@"; do
        case "$a" in
          -q) quiet=1 ;;
          -a) all=1 ;;
          --format) ;;
          -*) ;;
          *) [[ "$a" == app || "$a" == db ]] && service="$a" ;;
        esac
      done
      if ((quiet)); then
        local name="mashkif-dev-$service-1"
        if [[ -d "$(container_dir "$name")" ]] &&
          { ((all)) || [[ "$(cat "$(container_dir "$name")/running")" == true ]]; }; then
          printf '%s\n' "$name"
        fi
      else
        ls "$S/containers"
      fi
      ;;
    logs) return 0 ;;
    down) rm -rf "${S:?}/containers/"* ;;
    port) echo 127.0.0.1:8180 ;;
    *) return 0 ;;
  esac
}

cmd="$1"
shift
case "$cmd" in
  info) exit 0 ;;
  compose) compose "$@" ;;
  build)
    tag="" iid="" ctx=""
    while (($#)); do
      case "$1" in
        -f) shift 2 ;;
        -t) tag="$2"; shift 2 ;;
        --iidfile) iid="$2"; shift 2 ;;
        *) ctx="$1"; shift ;;
      esac
    done
    behave build-fail && { echo "ERROR: failed to solve: process did not complete successfully" >&2; exit 1; }
    id="sha256:$(printf '%s %s %s' "$ctx" "$tag" "$(date +%s%N)" | sha256sum | cut -c1-64)"
    if [[ -f "$ctx/server/drizzle/meta/_journal.json" ]]; then
      cp "$ctx/server/drizzle/meta/_journal.json" "$S/ids/$(key "$id")"
    else
      echo '{"entries":[]}' >"$S/ids/$(key "$id")"
    fi
    printf '%s\n' "$id" >"$S/tags/$(key "$tag")"
    [[ -n "$iid" ]] && printf '%s' "$id" >"$iid"
    exit 0
    ;;
  tag)
    id="$(image_id "$1")" || { echo "Error: No such image: $1" >&2; exit 1; }
    printf '%s\n' "$id" >"$S/tags/$(key "$2")"
    ;;
  image)
    sub="$1"
    shift
    case "$sub" in
      inspect)
        fmt=""
        [[ "$1" == -f ]] && { fmt="$2"; shift 2; }
        id="$(image_id "$1")" || { echo "Error: No such image: $1" >&2; exit 1; }
        [[ -n "$fmt" ]] && printf '%s\n' "$id"
        exit 0
        ;;
      rm)
        ref="$1"
        [[ "$ref" == *:* ]] || ref="$ref:latest"
        rm -f "$S/tags/$(key "$ref")"
        ;;
    esac
    ;;
  inspect)
    [[ "$1" == -f ]] || exit 1
    fmt="$2" name="$3" d="$(container_dir "$3")"
    [[ -d "$d" ]] || { echo "Error: No such object: $name" >&2; exit 1; }
    case "$fmt" in
      *Health*) cat "$d/health" ;;
      *.Image*) cat "$d/image" ;;
      *Running*) cat "$d/running" ;;
    esac
    ;;
  top)
    name="$1"
    [[ -d "$(container_dir "$name")" ]] || exit 1
    echo "UID                 RUID                PID                 COMMAND"
    case "$name" in
      *app*) echo "10001               10001               4100                node" ;;
      *db*) printf '%s\n' "999                 999                 4200                postgres" \
        "999                 999                 4201                postgres" ;;
    esac
    behave root-process && echo "0                   0                   4300                sh"
    exit 0
    ;;
  exec)
    name="$1"
    shift
    [[ -d "$(container_dir "$name")" ]] || exit 1
    if [[ "$1" == node ]]; then
      echo 200
    elif [[ "$1" == sh ]]; then
      sql="${*: -1}"
      case "$sql" in
        *to_regclass*) [[ -s "$S/applied" && "$(cat "$S/applied")" != "" ]] && echo t || echo f ;;
        *string_agg*) cat "$S/applied" ;;
      esac
    fi
    ;;
  start)
    d="$(container_dir "$1")"
    [[ -d "$d" ]] || exit 1
    printf 'true\n' >"$d/running"
    printf 'healthy\n' >"$d/health"
    ;;
  run)
    entry="" src="" image="" rest=()
    while (($#)); do
      case "$1" in
        --rm) shift ;;
        --network | --user) shift 2 ;;
        --entrypoint) entry="$2"; shift 2 ;;
        -v) src="${2%%:*}"; shift 2 ;;
        *)
          image="$1"
          shift
          rest=("$@")
          break
          ;;
      esac
    done
    case "$entry" in
      chown)
        behave chown-fail && { echo "chown: permission denied" >&2; exit 1; }
        behave chown-noop || printf '%s\n' "$src" >>"$S/chowned"
        ;;
      rm) rm -rf -- "$src/postgres" ;;
      cat)
        id="$(image_id "$image")" || exit 1
        cat "$S/ids/$(key "$id")"
        ;;
      *) echo "fake docker: unexpected run: ${rest[*]}" >&2; exit 1 ;;
    esac
    ;;
  *)
    echo "fake docker: unsupported command: $cmd $*" >&2
    exit 1
    ;;
esac
SHIM

  cat >"$dir/bin/stat" <<'SHIM'
#!/usr/bin/env bash
# Fake stat: paths given to the db user by the fake ownership container
# report 999:999; everything else goes to the real stat.
set -euo pipefail
S="${MASHKIF_SHIM_STATE:?MASHKIF_SHIM_STATE is not set}"
if [[ "${1:-}" == -c && "${2:-}" == '%u:%g' ]]; then
  path="${*: -1}"
  if grep -qxF -- "$path" "$S/chowned" 2>/dev/null; then
    echo 999:999
    exit 0
  fi
fi
exec /usr/bin/stat "$@"
SHIM

  cat >"$dir/bin/dotnet.exe" <<'SHIM'
#!/usr/bin/env bash
# Fake Windows .NET SDK, run from agent/.
set -euo pipefail
S="${MASHKIF_SHIM_STATE:?MASHKIF_SHIM_STATE is not set}"
printf 'dotnet.exe %s (in %s)\n' "$*" "$PWD" >>"$S/calls.log"
case "${1:-}" in
  --version) echo 10.0.403 ;;
  build)
    [[ -e "$S/behave/msi-fail" ]] && { echo "error MSB0000: build failed" >&2; exit 1; }
    mkdir -p artifacts/msi
    echo fake-msi >artifacts/msi/Mashkif-0.0.0-x64.msi
    ;;
  *) exit 1 ;;
esac
SHIM

  chmod +x "$dir/bin/docker" "$dir/bin/stat" "$dir/bin/dotnet.exe"
}

# mashkif_shims_fence <dir>: puts the shims first in PATH and makes sure no
# real Docker daemon is reachable, so a test can never touch the real
# development environment.
mashkif_shims_fence() {
  local dir="$1"
  export PATH="$dir/bin:$PATH"
  export MASHKIF_SHIM_STATE="$dir/state"
  export DOCKER_HOST="unix:///nonexistent/mashkif-test-docker.sock"
  if [[ "$(command -v docker)" != "$dir/bin/docker" ]]; then
    fail "the fake docker is not first in PATH; refusing to run the tests"
    return "$MASHKIF_EXIT_ENV"
  fi
}

# Assertions shared by the tests. Each test script sets failures=0.
t_ok() { log "  ok    $1"; }
t_fail() {
  log "  FAIL  $1"
  [[ -n "${2:-}" ]] && log "        $2"
  failures=$((failures + 1))
}

# t_run <name>: runs the remaining arguments, saving stdout+stderr in
# $T_OUT and the exit code in $T_RC.
t_run() {
  set +e
  T_OUT="$("$@" 2>&1)"
  T_RC=$?
  set -e
}

# t_expect <description> <expected-rc> [substring...]
t_expect() {
  local description="$1" rc="$2" part
  shift 2
  if [[ "$T_RC" != "$rc" ]]; then
    t_fail "$description" "exit $T_RC, expected $rc; output: $T_OUT"
    return 0
  fi
  for part in "$@"; do
    if [[ "$T_OUT" != *"$part"* ]]; then
      t_fail "$description" "output lacks '$part': $T_OUT"
      return 0
    fi
  done
  t_ok "$description"
}

# t_check <description> <command...>: passes when the command succeeds.
t_check() {
  local description="$1"
  shift
  if "$@"; then
    t_ok "$description"
  else
    t_fail "$description"
  fi
}
