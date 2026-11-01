# shellcheck shell=bash
# shellcheck disable=SC2034 # The variables below are used by the scripts that source this file.
# Development environment identity, shared by scripts/local.sh and
# scripts/try-pr.sh. Source common.sh first; do not run this file.
#
# Every checkout and worktree on a machine shares one development environment:
# - Compose project name: mashkif-dev, passed with -p on every call.
# - Compose file and .env: read only from the root of the main checkout,
#   resolved through `git rev-parse --git-common-dir`.
# - Tool state (lock, try-pr state): ~/.local/state/mashkif/, outside the data
#   directory, so it survives nuke and is shared by every worktree.
# - Data: ${MASHKIF_DATA_DIR}, with a marker file and postgres/ owned by the
#   db user.
#
# Test hooks: MASHKIF_STATE_DIR, MASHKIF_DEV_CHECKOUT, and MASHKIF_TRY_PR_ROOT
# replace the default locations. Nothing else changes behaviour.

MASHKIF_DEV_PROJECT=mashkif-dev
MASHKIF_DEV_IMAGE=mashkif-app:dev
MASHKIF_DEV_PROJECT_ID=mashkif-dev
MASHKIF_DATA_MARKER=.mashkif-data
# The official PostgreSQL image's postgres user, used as user: in Compose.
MASHKIF_DB_UID=999
MASHKIF_DB_GID=999
# Same pinned image as the db service in both Compose files (checked by the
# docker verify area). Used for one-shot ownership and removal containers.
MASHKIF_DB_IMAGE="postgres:18.6-bookworm@sha256:5c4783a8cc3f0074912164f94dfa1be4e043438f0f707cf968d7af9a0d31a2c8"

MASHKIF_EXIT_REFUSED=1

mashkif_state_dir() {
  printf '%s\n' "${MASHKIF_STATE_DIR:-$HOME/.local/state/mashkif}"
}

mashkif_try_pr_state_file() {
  printf '%s/try-pr.state\n' "$(mashkif_state_dir)"
}

# mashkif_try_pr_root: the parent directory of disposable PR worktrees.
mashkif_try_pr_root() {
  if [[ -n "${MASHKIF_TRY_PR_ROOT:-}" ]]; then
    printf '%s\n' "$MASHKIF_TRY_PR_ROOT"
    return 0
  fi
  local root
  root="$(mashkif_tmp_root)" || return 1
  printf '%s/try-pr\n' "$root"
}

# mashkif_dev_checkout: prints the root of the main checkout.
mashkif_dev_checkout() {
  if [[ -n "${MASHKIF_DEV_CHECKOUT:-}" ]]; then
    printf '%s\n' "$MASHKIF_DEV_CHECKOUT"
    return 0
  fi
  local common
  if ! common="$(git -C "$MASHKIF_ROOT" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)"; then
    fail "cannot find the Git repository of $MASHKIF_ROOT"
    return "$MASHKIF_EXIT_ENV"
  fi
  if [[ "$(basename "$common")" != .git ]]; then
    fail "the main repository at $common is not a regular checkout (expected <checkout>/.git)"
    return "$MASHKIF_EXIT_ENV"
  fi
  dirname "$common"
}

# mashkif_refuse_try_pr_worktree: scripts never run from a PR worktree.
mashkif_refuse_try_pr_worktree() {
  local root
  root="$(mashkif_try_pr_root 2>/dev/null)" || return 0
  case "$MASHKIF_ROOT/" in
    "$root"/*)
      fail "this copy of the script is inside a try-pr worktree ($MASHKIF_ROOT); run the script from the main checkout"
      return "$MASHKIF_EXIT_REFUSED"
      ;;
  esac
}

# mashkif_dev_files: checks the machine-local files and sets
# MASHKIF_DEV_CHECKOUT_DIR, MASHKIF_DEV_COMPOSE_FILE, and MASHKIF_DEV_ENV_FILE.
mashkif_dev_files() {
  local checkout
  checkout="$(mashkif_dev_checkout)" || return
  MASHKIF_DEV_CHECKOUT_DIR="$checkout"
  MASHKIF_DEV_COMPOSE_FILE="$checkout/docker-compose-dev.yml"
  MASHKIF_DEV_ENV_FILE="$checkout/.env"
  if [[ ! -f "$MASHKIF_DEV_COMPOSE_FILE" ]]; then
    fail "the development Compose file is missing: $MASHKIF_DEV_COMPOSE_FILE"
    log "Create it once in the main checkout:"
    log "  cp config/docker-compose-dev.example.yml docker-compose-dev.yml"
    return "$MASHKIF_EXIT_ENV"
  fi
  if [[ ! -f "$MASHKIF_DEV_ENV_FILE" ]]; then
    fail "the environment file is missing: $MASHKIF_DEV_ENV_FILE"
    log "Create it once in the main checkout and replace every placeholder:"
    log "  cp .env.example .env"
    return "$MASHKIF_EXIT_ENV"
  fi
}

# mashkif_env_value <name>: prints a setting the way Compose resolves it:
# the shell environment first, then the main checkout's .env file.
mashkif_env_value() {
  local name="$1" line value=""
  if [[ -n "${!name+set}" ]]; then
    printf '%s\n' "${!name}"
    return 0
  fi
  [[ -f "${MASHKIF_DEV_ENV_FILE:-}" ]] || return 1
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    line="${line#export }"
    if [[ "$line" == "$name="* ]]; then
      value="${line#"$name="}"
      if [[ "$value" =~ ^\"(.*)\"$ || "$value" =~ ^\'(.*)\'$ ]]; then
        value="${BASH_REMATCH[1]}"
      fi
    fi
  done <"$MASHKIF_DEV_ENV_FILE"
  printf '%s\n' "$value"
}

# mashkif_dev_compose <args>: docker compose on the development environment.
# Extra Compose files (used by try-pr) come from MASHKIF_DEV_COMPOSE_EXTRA.
mashkif_dev_compose() {
  local -a files=(-f "$MASHKIF_DEV_COMPOSE_FILE")
  local extra
  for extra in "${MASHKIF_DEV_COMPOSE_EXTRA[@]}"; do
    files+=(-f "$extra")
  done
  docker compose -p "$MASHKIF_DEV_PROJECT" --project-directory "$MASHKIF_DEV_CHECKOUT_DIR" \
    "${files[@]}" "$@"
}
MASHKIF_DEV_COMPOSE_EXTRA=()

# mashkif_dev_lock: takes the shared lock on file descriptor 9 without
# waiting. Every state-changing action of local.sh and try-pr.sh holds it.
mashkif_dev_lock() {
  local state
  state="$(mashkif_state_dir)"
  mkdir -p "$state" || return "$MASHKIF_EXIT_ENV"
  exec 9>>"$state/dev.lock"
  if ! flock -n 9; then
    exec 9>&-
    fail "another local.sh or try-pr.sh run is changing the development environment (lock: $state/dev.lock); wait for it to finish"
    return "$MASHKIF_EXIT_REFUSED"
  fi
}

mashkif_dev_unlock() {
  exec 9>&-
}

# mashkif_state_get <file> <key>: prints the value of key=value from a state
# or marker file.
mashkif_state_get() {
  local file="$1" key="$2" line
  [[ -f "$file" ]] || return 1
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" == "$key="* ]]; then
      printf '%s\n' "${line#"$key="}"
      return 0
    fi
  done <"$file"
  return 1
}

# mashkif_refuse_during_try_pr: state-changing local.sh actions refuse while a
# try-pr session is recorded.
mashkif_refuse_during_try_pr() {
  local file pr
  file="$(mashkif_try_pr_state_file)"
  [[ -e "$file" ]] || return 0
  pr="$(mashkif_state_get "$file" pr || true)"
  fail "a try-pr session is active (pull request ${pr:-unknown}); run scripts/try-pr.sh restore first (scripts/try-pr.sh status shows details)"
  return "$MASHKIF_EXIT_REFUSED"
}

# mashkif_normalize_path <path>: lexical normalization without resolving
# symlinks. Refuses relative paths.
mashkif_normalize_path() {
  local path="$1"
  if [[ "$path" != /* ]]; then
    fail "expected an absolute path, got: ${path:-<empty>}"
    return "$MASHKIF_EXIT_ENV"
  fi
  realpath -ms -- "$path"
}

# mashkif_data_dir: resolves MASHKIF_DATA_DIR and exports the normalized value,
# so this script and Compose use exactly the same path. Call it directly, not
# in a command substitution.
mashkif_data_dir() {
  local value
  value="$(mashkif_env_value MASHKIF_DATA_DIR || true)"
  if [[ -z "$value" ]]; then
    fail "MASHKIF_DATA_DIR is not set in $MASHKIF_DEV_ENV_FILE"
    return "$MASHKIF_EXIT_ENV"
  fi
  value="$(mashkif_normalize_path "$value")" || return
  export MASHKIF_DATA_DIR="$value"
}

# mashkif_path_owner <path>: prints uid:gid.
mashkif_path_owner() {
  stat -c '%u:%g' -- "$1"
}

_mashkif_marker_write() {
  local dir="$1" prepared="$2" tmp
  tmp="$(mktemp "$dir/$MASHKIF_DATA_MARKER.tmp.XXXXXX")" || return
  {
    printf '# Mashkif development data directory, managed by scripts/local.sh.\n'
    printf '# scripts/local.sh nuke deletes this directory only while this marker matches.\n'
    printf 'project_id=%s\n' "$MASHKIF_DEV_PROJECT_ID"
    printf 'postgres_prepared=%s\n' "$prepared"
  } >"$tmp" && chmod 644 "$tmp" && mv -f -- "$tmp" "$dir/$MASHKIF_DATA_MARKER"
}

# _mashkif_marker_check <dir>: the marker exists and names this project.
_mashkif_marker_check() {
  local dir="$1" id
  if [[ ! -f "$dir/$MASHKIF_DATA_MARKER" ]]; then
    fail "$dir exists but has no $MASHKIF_DATA_MARKER marker, so Mashkif did not create it; refusing to touch it"
    log "Point MASHKIF_DATA_DIR at a path that does not exist yet, and local.sh creates it."
    return "$MASHKIF_EXIT_REFUSED"
  fi
  id="$(mashkif_state_get "$dir/$MASHKIF_DATA_MARKER" project_id || true)"
  if [[ "$id" != "$MASHKIF_DEV_PROJECT_ID" ]]; then
    fail "$dir/$MASHKIF_DATA_MARKER names project '${id:-<none>}', expected '$MASHKIF_DEV_PROJECT_ID'; refusing to touch it"
    return "$MASHKIF_EXIT_REFUSED"
  fi
}

_mashkif_dir_is_empty() {
  [[ -z "$(find "$1" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]]
}

# _mashkif_chown_db <dir>: gives the directory to the db user through a
# one-shot root container. This is a preparation step, not an application
# process; the running services never run as root.
_mashkif_chown_db() {
  docker run --rm --network none --user 0:0 --entrypoint chown \
    -v "$1:/target" "$MASHKIF_DB_IMAGE" "$MASHKIF_DB_UID:$MASHKIF_DB_GID" /target
}

# mashkif_data_prepare <dir>: creates and prepares the data directory.
# Resumable: a missing directory is created atomically together with its
# marker (postgres_prepared=false); postgres/ is created and given to the db
# user only while the marker exists, the flag is false, and postgres/ is empty;
# the flag becomes true only after the ownership is verified. A non-empty
# postgres/ with a false flag, or any existing directory without the marker,
# is refused and never re-owned.
mashkif_data_prepare() {
  local dir="$1" parent tmp flag owner
  if [[ -L "$dir" ]]; then
    fail "$dir is a symbolic link; MASHKIF_DATA_DIR must name a real directory"
    return "$MASHKIF_EXIT_REFUSED"
  fi
  if [[ ! -e "$dir" ]]; then
    parent="$(dirname "$dir")"
    mkdir -p -- "$parent" || return "$MASHKIF_EXIT_ENV"
    tmp="$(mktemp -d "$parent/.$(basename "$dir").preparing.XXXXXX")" || return "$MASHKIF_EXIT_ENV"
    if ! chmod 755 "$tmp" || ! _mashkif_marker_write "$tmp" false; then
      rm -rf -- "$tmp"
      return "$MASHKIF_EXIT_ENV"
    fi
    if ! mv -T -- "$tmp" "$dir"; then
      rm -rf -- "$tmp"
      fail "could not create $dir"
      return "$MASHKIF_EXIT_ENV"
    fi
    log "created data directory $dir"
  elif [[ ! -d "$dir" ]]; then
    fail "$dir exists and is not a directory"
    return "$MASHKIF_EXIT_REFUSED"
  fi
  if [[ "$(realpath -e -- "$dir")" != "$dir" ]]; then
    fail "$dir resolves to $(realpath -e -- "$dir") through a symbolic link; refusing"
    return "$MASHKIF_EXIT_REFUSED"
  fi
  _mashkif_marker_check "$dir" || return

  flag="$(mashkif_state_get "$dir/$MASHKIF_DATA_MARKER" postgres_prepared || true)"
  if [[ -L "$dir/postgres" ]]; then
    fail "$dir/postgres is a symbolic link; refusing"
    return "$MASHKIF_EXIT_REFUSED"
  fi
  if [[ "$flag" == true ]]; then
    owner="$(mashkif_path_owner "$dir/postgres" 2>/dev/null || true)"
    if [[ "$owner" != "$MASHKIF_DB_UID:$MASHKIF_DB_GID" ]]; then
      fail "$dir is marked prepared, but $dir/postgres is ${owner:+owned by $owner}${owner:-missing}; expected $MASHKIF_DB_UID:$MASHKIF_DB_GID. Inspect it, or run scripts/local.sh nuke"
      return "$MASHKIF_EXIT_REFUSED"
    fi
    return 0
  fi
  if [[ "$flag" != false ]]; then
    fail "$dir/$MASHKIF_DATA_MARKER has an unexpected postgres_prepared value: ${flag:-<none>}"
    return "$MASHKIF_EXIT_REFUSED"
  fi

  if [[ -e "$dir/postgres" && ! -d "$dir/postgres" ]]; then
    fail "$dir/postgres is not a directory; refusing"
    return "$MASHKIF_EXIT_REFUSED"
  fi
  mkdir -p -- "$dir/postgres" || return "$MASHKIF_EXIT_ENV"
  if ! _mashkif_dir_is_empty "$dir/postgres"; then
    fail "$dir/postgres is not empty, but its preparation never finished; refusing to change its ownership. Inspect it, or run scripts/local.sh nuke"
    return "$MASHKIF_EXIT_REFUSED"
  fi
  log "giving $dir/postgres to the database user $MASHKIF_DB_UID:$MASHKIF_DB_GID"
  if ! _mashkif_chown_db "$dir/postgres" >&2; then
    fail "could not change the owner of $dir/postgres"
    return "$MASHKIF_EXIT_FAILED"
  fi
  owner="$(mashkif_path_owner "$dir/postgres")"
  if [[ "$owner" != "$MASHKIF_DB_UID:$MASHKIF_DB_GID" ]]; then
    fail "$dir/postgres is owned by $owner after the ownership change, expected $MASHKIF_DB_UID:$MASHKIF_DB_GID"
    log "The file system does not keep ownership. Put MASHKIF_DATA_DIR on WSL ext4 (for example ~/mashkif-data), not under /mnt."
    return "$MASHKIF_EXIT_FAILED"
  fi
  _mashkif_marker_write "$dir" true || return "$MASHKIF_EXIT_ENV"
  log "data directory prepared"
}

# mashkif_nuke_target_check <configured-path>: validates a nuke target and
# prints its canonical path. Refuses broad paths, symlink escapes, unmarked
# directories, and unexpected contents.
mashkif_nuke_target_check() {
  local dir="$1" home canonical entry name
  local -a unexpected=()
  home="$(realpath -ms -- "$HOME")"
  # Refused: /, any top-level directory (including /mnt), a drive root such as
  # /mnt/c, the home directory, and any ancestor of it.
  if [[ "$dir" == / || "$dir" == "$home" ]] ||
    [[ "$dir" =~ ^/mnt/[^/]+$ ]] || [[ "$dir" =~ ^/[^/]+$ ]] ||
    [[ "$home/" == "$dir/"* ]]; then
    fail "refusing to delete $dir: it is a root, a drive, or contains the home directory"
    return "$MASHKIF_EXIT_REFUSED"
  fi
  if [[ ! -e "$dir" && ! -L "$dir" ]]; then
    return 0
  fi
  canonical="$(realpath -e -- "$dir" 2>/dev/null || true)"
  if [[ -L "$dir" || "$canonical" != "$dir" ]]; then
    fail "refusing to delete $dir: it resolves to ${canonical:-an unreadable path} through a symbolic link"
    return "$MASHKIF_EXIT_REFUSED"
  fi
  if [[ ! -d "$dir" ]]; then
    fail "refusing to delete $dir: it is not a directory"
    return "$MASHKIF_EXIT_REFUSED"
  fi
  _mashkif_marker_check "$dir" || return
  if [[ -L "$dir/postgres" ]]; then
    fail "refusing to delete $dir: $dir/postgres is a symbolic link"
    return "$MASHKIF_EXIT_REFUSED"
  fi
  while IFS= read -r -d '' entry; do
    name="$(basename "$entry")"
    case "$name" in
      "$MASHKIF_DATA_MARKER" | "$MASHKIF_DATA_MARKER".tmp.* | postgres) ;;
      *) unexpected+=("$name") ;;
    esac
  done < <(find "$dir" -mindepth 1 -maxdepth 1 -print0)
  if ((${#unexpected[@]})); then
    fail "refusing to delete $dir: it contains entries Mashkif did not create: ${unexpected[*]}"
    return "$MASHKIF_EXIT_REFUSED"
  fi
}

# mashkif_data_remove <dir>: deletes a validated data directory. postgres/
# belongs to the db user, so a one-shot root container removes it.
mashkif_data_remove() {
  local dir="$1"
  if [[ -e "$dir/postgres" ]]; then
    docker run --rm --network none --user 0:0 --entrypoint rm \
      -v "$dir:/target" "$MASHKIF_DB_IMAGE" -rf -- /target/postgres >&2 || return "$MASHKIF_EXIT_FAILED"
  fi
  rm -f -- "$dir/$MASHKIF_DATA_MARKER" "$dir/$MASHKIF_DATA_MARKER".tmp.* || return "$MASHKIF_EXIT_FAILED"
  rmdir -- "$dir" || return "$MASHKIF_EXIT_FAILED"
  [[ ! -e "$dir" ]]
}

# mashkif_container_id <service>: prints the container ID of a service.
mashkif_container_id() {
  mashkif_dev_compose ps -q "$1" 2>/dev/null | head -n 1
}

# mashkif_check_container_uids <container> <label>: every process in the
# container runs with a non-zero effective and real UID.
mashkif_check_container_uids() {
  local container="$1" label="$2" out bad
  if ! out="$(docker top "$container" -eo uid,ruid,pid,comm 2>&1)"; then
    fail "$label: cannot list processes: $out"
    return "$MASHKIF_EXIT_FAILED"
  fi
  bad="$(awk 'NR > 1 && ($1 == "0" || $2 == "0")' <<<"$out")"
  if [[ -n "$bad" ]]; then
    fail "$label: processes running as root:"
    printf '%s\n' "$bad" >&2
    return "$MASHKIF_EXIT_FAILED"
  fi
  if [[ "$(awk 'NR > 1' <<<"$out" | wc -l)" -eq 0 ]]; then
    fail "$label: no running processes"
    return "$MASHKIF_EXIT_FAILED"
  fi
  log "  ok    $label: every process runs as a non-root user ($(awk 'NR > 1 { print $1 }' <<<"$out" | sort -u | paste -sd, -))"
}

# mashkif_http_status <container> <path>: HTTP status of a request made from
# inside the app container, or 000.
mashkif_http_status() {
  # shellcheck disable=SC2016 # JavaScript, not shell.
  docker exec "$1" node -e '
    fetch("http://127.0.0.1:8080" + process.argv[1], { signal: AbortSignal.timeout(10000) })
      .then((r) => console.log(r.status), () => console.log("000"));
  ' "$2" 2>/dev/null || printf '000\n'
}
