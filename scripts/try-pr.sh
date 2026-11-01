#!/usr/bin/env bash
# Try a pull request in the local development environment. Runs inside WSL,
# always from the main checkout; scripts inside the PR are never run.
#
# start   checks who wrote the pull request, pins its head commit, creates a
#         disposable worktree, and then:
#         - server or web changes: builds the PR image and replaces only the
#           app container (db is never replaced);
#         - agent changes: builds the MSI in the worktree and prints its path.
# status  shows the recorded session. Changes nothing.
# restore puts the previous app image back, removes the worktree, and ends the
#         session. It also recovers from an interrupted start.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"
# shellcheck source=lib/dev-env.sh
source "$SCRIPT_DIR/lib/dev-env.sh"
# shellcheck source=lib/select-areas.sh
source "$SCRIPT_DIR/lib/select-areas.sh"

MASHKIF_GITHUB_API="${MASHKIF_GITHUB_API:-https://api.github.com}"
MASHKIF_PREVIOUS_TAG=mashkif-app:try-pr-previous

usage() {
  cat <<EOF
Usage:
  scripts/try-pr.sh start <pr-number> [--trust <head-sha>]
  scripts/try-pr.sh status
  scripts/try-pr.sh restore [--keep-app]

start      Try pull request <pr-number>. Pull requests by the repository owner
           are accepted. Any other author needs --trust with the full head
           commit SHA you reviewed; the run is pinned to that commit, and a
           later push to the pull request is refused.
status     Show the active session.
restore    Start the previous app image again, remove the PR worktree, and end
           the session. Refuses when the database has migrations the previous
           code does not know. --keep-app ends the session but leaves the PR's
           app running, so scripts/local.sh works again.

Run it from the main checkout. Requires a running development environment
(scripts/local.sh up -d) for server and web changes, and the Windows .NET SDK
(dotnet.exe) for agent changes.

Exit codes: 0 success, 1 failed or refused, 2 usage or environment error.
EOF
}

# ---------------------------------------------------------------------------
# Helpers

preflight() {
  local cmd main
  for cmd in docker git curl python3 flock realpath; do
    require_cmd "$cmd" || return
  done
  if ! docker info >/dev/null 2>&1; then
    fail "the Docker daemon is not reachable"
    return "$MASHKIF_EXIT_ENV"
  fi
  mashkif_refuse_try_pr_worktree || return
  main="$(mashkif_dev_checkout)" || return
  if [[ "$(realpath -e -- "$MASHKIF_ROOT")" != "$(realpath -e -- "$main")" ]]; then
    fail "run try-pr.sh from the main checkout: $main/scripts/try-pr.sh (this copy is in $MASHKIF_ROOT)"
    return "$MASHKIF_EXIT_REFUSED"
  fi
  MAIN="$main"
  mashkif_dev_files || return
  STATE_FILE="$(mashkif_try_pr_state_file)"
  OVERRIDE_FILE="$(mashkif_state_dir)/try-pr.compose.yml"
}

# json_get <file> <dotted.key>: prints a JSON value, or fails when it is missing.
json_get() {
  python3 -I -c '
import json, sys
data = json.load(open(sys.argv[1], encoding="utf-8"))
for key in sys.argv[2].split("."):
    if not isinstance(data, dict) or key not in data:
        sys.exit(1)
    data = data[key]
print("" if data is None else data)
' "$1" "$2"
}

# journal_whens: reads a Drizzle _journal.json on stdin and prints the
# migration timestamps, comma-separated.
journal_whens() {
  python3 -I -c '
import json, sys
entries = json.load(sys.stdin).get("entries", [])
print(",".join(str(int(entry["when"])) for entry in entries))
'
}

# applied_migrations <db-container>: prints the created_at values recorded in
# drizzle.__drizzle_migrations, comma-separated (empty before any migration).
applied_migrations() {
  local exists
  exists="$(db_query "$1" "select to_regclass('drizzle.__drizzle_migrations') is not null")" || return
  [[ "$exists" == t ]] || return 0
  db_query "$1" "select coalesce(string_agg(created_at::text, ',' order by created_at), '') from drizzle.__drizzle_migrations"
}

# db_query <db-container> <sql>: runs one query as the application user.
db_query() {
  # shellcheck disable=SC2016 # Expanded by the shell inside the container.
  docker exec "$1" sh -c 'psql -v ON_ERROR_STOP=1 -tAq -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "$1"' sh "$2"
}

# missing_migrations <applied> <journal>: prints applied timestamps that the
# journal does not list, comma-separated.
missing_migrations() {
  local applied="$1" journal="$2" item
  local -a items=() absent=()
  [[ -z "$applied" ]] && return 0
  IFS=, read -r -a items <<<"$applied"
  for item in "${items[@]}"; do
    [[ ",$journal," == *",$item,"* ]] || absent+=("$item")
  done
  if ((${#absent[@]})); then
    (
      IFS=,
      printf '%s\n' "${absent[*]}"
    )
  fi
}

explain_newer_schema() {
  local missing="$1" what="$2"
  fail "the development database has migrations that $what does not know: $missing"
  log "Forward-only migrations: older code must not run against a newer schema."
  log "How to proceed:"
  log "  - Keep the newer code: scripts/try-pr.sh restore --keep-app ends the session"
  log "    and leaves the current app running. Later, scripts/local.sh up -d from a"
  log "    checkout whose server/drizzle includes these migrations."
  log "  - Or discard the development database: scripts/try-pr.sh restore --keep-app,"
  log "    then scripts/local.sh nuke and scripts/local.sh up -d."
}

# github_repo: owner/name of the repository, from origin unless overridden.
github_repo() {
  if [[ -n "${MASHKIF_GITHUB_REPO:-}" ]]; then
    printf '%s\n' "$MASHKIF_GITHUB_REPO"
    return 0
  fi
  local url
  url="$(git -C "$MAIN" remote get-url origin 2>/dev/null)" || {
    fail "the main checkout has no origin remote"
    return "$MASHKIF_EXIT_ENV"
  }
  if [[ "$url" =~ github\.com[:/]+([^/]+)/([^/]+)$ ]]; then
    printf '%s/%s\n' "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]%.git}"
  else
    fail "origin is not a GitHub repository: $url"
    return "$MASHKIF_EXIT_ENV"
  fi
}

# fetch_pull <repo> <number> <output-file>: reads the pull request from the
# GitHub REST API without authentication (read-only).
fetch_pull() {
  local repo="$1" number="$2" out="$3" code
  code="$(curl -sS -L --proto '=https,file' --max-time 30 -o "$out" -w '%{http_code}' \
    -H 'Accept: application/vnd.github+json' -H 'X-GitHub-Api-Version: 2022-11-28' \
    "$MASHKIF_GITHUB_API/repos/$repo/pulls/$number")" || {
    fail "could not reach the GitHub API at $MASHKIF_GITHUB_API"
    return "$MASHKIF_EXIT_ENV"
  }
  # file:// URLs (tests) report 000 on success.
  case "$code" in
    200 | 000) ;;
    404)
      fail "pull request $number was not found in $repo"
      return "$MASHKIF_EXIT_REFUSED"
      ;;
    *)
      fail "the GitHub API answered HTTP $code for pull request $number (rate limit or outage); try again later"
      return "$MASHKIF_EXIT_ENV"
      ;;
  esac
}

lower() {
  tr '[:upper:]' '[:lower:]' <<<"$1"
}

# write_state: writes every session field atomically.
write_state() {
  local tmp
  mkdir -p "$(dirname "$STATE_FILE")"
  tmp="$(mktemp "$STATE_FILE.tmp.XXXXXX")"
  {
    printf '# Mashkif try-pr session. Remove it only through scripts/try-pr.sh restore.\n'
    printf 'version=1\n'
    printf 'pr=%s\n' "$S_PR"
    printf 'sha=%s\n' "$S_SHA"
    printf 'author=%s\n' "$S_AUTHOR"
    printf 'phase=%s\n' "$S_PHASE"
    printf 'worktree=%s\n' "$S_WORKTREE"
    printf 'app_changed=%s\n' "$S_APP_CHANGED"
    printf 'agent_changed=%s\n' "$S_AGENT_CHANGED"
    printf 'previous_image=%s\n' "$S_PREVIOUS_IMAGE"
    printf 'previous_migrations=%s\n' "$S_PREVIOUS_MIGRATIONS"
    printf 'pr_image=%s\n' "$S_PR_IMAGE"
    printf 'pr_image_tag=%s\n' "$S_PR_IMAGE_TAG"
    printf 'msi=%s\n' "$S_MSI"
    printf 'started_at=%s\n' "$S_STARTED_AT"
  } >"$tmp"
  mv -f -- "$tmp" "$STATE_FILE"
}

read_state() {
  local key
  for key in pr sha author phase worktree app_changed agent_changed previous_image \
    previous_migrations pr_image pr_image_tag msi started_at; do
    printf -v "S_${key^^}" '%s' "$(mashkif_state_get "$STATE_FILE" "$key" || true)"
  done
}

# remove_worktree: removes the disposable worktree recorded in the session.
remove_worktree() {
  local root
  [[ -n "$S_WORKTREE" ]] || return 0
  root="$(mashkif_try_pr_root)" || return
  case "$S_WORKTREE" in
    "$root"/pr-*) ;;
    *)
      fail "refusing to remove $S_WORKTREE: it is not under $root"
      return "$MASHKIF_EXIT_REFUSED"
      ;;
  esac
  if [[ -e "$S_WORKTREE" ]]; then
    git -C "$MAIN" worktree remove --force "$S_WORKTREE" 2>/dev/null || rm -rf -- "$S_WORKTREE"
  fi
  git -C "$MAIN" worktree prune
  if [[ -e "$S_WORKTREE" ]]; then
    fail "could not remove $S_WORKTREE"
    return "$MASHKIF_EXIT_FAILED"
  fi
  log "removed worktree $S_WORKTREE"
}

remove_tag() {
  [[ -n "$1" ]] || return 0
  if docker image inspect "$1" >/dev/null 2>&1; then
    docker image rm "$1" >/dev/null 2>&1 || log "note: could not remove image tag $1"
  fi
}

# wait_healthy <container>: starts a stopped container and waits for health.
wait_healthy() {
  local container="$1" i status
  if [[ "$(docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null)" != true ]]; then
    docker start "$container" >/dev/null || return
  fi
  for ((i = 0; i < MASHKIF_WAIT_TIMEOUT; i += 2)); do
    status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$container" 2>/dev/null || true)"
    [[ "$status" == healthy ]] && return 0
    sleep 2
  done
  return 1
}

# build_msi <worktree>: agent build contract, from agent/ with dotnet.exe.
build_msi() {
  local wt="$1" msi
  if ! command -v dotnet.exe >/dev/null 2>&1; then
    fail "dotnet.exe is not reachable from WSL; install the .NET 10 SDK on Windows"
    return "$MASHKIF_EXIT_ENV"
  fi
  if ! (cd "$wt/agent" && dotnet.exe --version >/dev/null); then
    fail "the Windows .NET SDK does not satisfy agent/global.json; install the .NET 10 SDK"
    return "$MASHKIF_EXIT_ENV"
  fi
  log "building the MSI in $wt/agent"
  if ! (cd "$wt/agent" && dotnet.exe build installer/Mashkif.Installer.wixproj -c Release >&2); then
    fail "the MSI build failed"
    return "$MASHKIF_EXIT_FAILED"
  fi
  msi="$(find "$wt/agent/artifacts/msi" -maxdepth 1 -name '*.msi' -print -quit 2>/dev/null || true)"
  if [[ -z "$msi" ]]; then
    fail "the MSI build finished, but agent/artifacts/msi/ has no .msi file"
    return "$MASHKIF_EXIT_FAILED"
  fi
  S_MSI="$msi"
}

windows_path() {
  if command -v wslpath >/dev/null 2>&1; then
    wslpath -w "$1" 2>/dev/null || printf '%s\n' "$1"
  else
    printf '%s\n' "$1"
  fi
}

# abort_start <message>: failure before the app was touched. Removes what this
# run created and ends the session.
abort_start() {
  fail "$1"
  remove_worktree || true
  remove_tag "$S_PR_IMAGE_TAG"
  rm -f -- "$STATE_FILE" "$OVERRIDE_FILE"
  log "nothing in the development environment was changed"
  return "$MASHKIF_EXIT_FAILED"
}

# ---------------------------------------------------------------------------
# Commands

cmd_start() {
  local number="$1" trusted="$2" repo scratch pull author owner full head base_ref state_text
  local base_tip changed areas app db dev_image journal missing iidfile rc

  preflight || return
  mashkif_dev_lock || return
  if [[ -e "$STATE_FILE" ]]; then
    fail "a try-pr session already exists (pull request $(mashkif_state_get "$STATE_FILE" pr || echo '?')); run scripts/try-pr.sh restore first"
    return "$MASHKIF_EXIT_REFUSED"
  fi

  repo="$(github_repo)" || return
  scratch="$(mashkif_mktemp try-pr-run)" || return
  # shellcheck disable=SC2064 # Expand now: the path is fixed for this run.
  trap "rm -rf -- '$scratch'" EXIT
  pull="$scratch/pull.json"
  fetch_pull "$repo" "$number" "$pull" || return
  author="$(json_get "$pull" user.login)" || author=""
  owner="$(json_get "$pull" base.repo.owner.login)" || owner=""
  full="$(json_get "$pull" base.repo.full_name)" || full=""
  head="$(json_get "$pull" head.sha)" || head=""
  base_ref="$(json_get "$pull" base.ref)" || base_ref=""
  state_text="$(json_get "$pull" state)" || state_text=""
  if [[ -z "$author" || -z "$owner" || ! "$head" =~ ^[0-9a-f]{40}$ ]]; then
    fail "the GitHub API answer for pull request $number is incomplete"
    return "$MASHKIF_EXIT_ENV"
  fi

  # Trust gate.
  if [[ "$(lower "$full")" != "$(lower "$repo")" ]]; then
    fail "pull request $number belongs to $full, not $repo"
    return "$MASHKIF_EXIT_REFUSED"
  fi
  if [[ -n "$trusted" ]]; then
    if [[ "$head" != "$trusted" ]]; then
      fail "pull request $number now points at $head, not the commit you trusted ($trusted)"
      log "Review the new commits, then run: scripts/try-pr.sh start $number --trust $head"
      return "$MASHKIF_EXIT_REFUSED"
    fi
    log "trusted by --trust: pull request $number by $author at $head"
  elif [[ "$(lower "$author")" == "$(lower "$owner")" ]]; then
    log "pull request $number is by the repository owner ($owner); pinned to $head"
  else
    fail "pull request $number is by $author, not the repository owner $owner"
    log "try-pr builds and runs the pull request's code on this machine (Dockerfile"
    log "steps and MSBuild targets run code). Review the changes at $head, then run:"
    log "  scripts/try-pr.sh start $number --trust $head"
    return "$MASHKIF_EXIT_REFUSED"
  fi
  [[ "$state_text" == open ]] || log "note: pull request $number is $state_text"

  # Fetch the pinned commit.
  if ! git -C "$MAIN" fetch --quiet --no-tags origin "refs/pull/$number/head"; then
    fail "could not fetch refs/pull/$number/head from origin"
    return "$MASHKIF_EXIT_ENV"
  fi
  if [[ "$(git -C "$MAIN" rev-parse FETCH_HEAD)" != "$head" ]]; then
    fail "pull request $number changed while starting (fetched $(git -C "$MAIN" rev-parse FETCH_HEAD), expected $head); run start again"
    return "$MASHKIF_EXIT_REFUSED"
  fi

  # What changed, through the same table as scripts/verify.sh.
  base_tip=""
  if [[ -n "$base_ref" ]] && git -C "$MAIN" fetch --quiet --no-tags origin "refs/heads/$base_ref"; then
    base_tip="$(git -C "$MAIN" rev-parse FETCH_HEAD)"
  fi
  if [[ -n "$base_tip" ]] && changed="$(git -C "$MAIN" -c core.quotePath=false diff --name-only --no-renames \
    "$(git -C "$MAIN" merge-base "$base_tip" "$head")" "$head")"; then
    areas="$(map_paths_to_areas <<<"$changed" | paste -sd' ' -)"
  else
    log "note: could not compare with the base branch; treating every area as changed"
    areas="${MASHKIF_AREAS[*]}"
  fi
  S_APP_CHANGED=false
  S_AGENT_CHANGED=false
  [[ " $areas " == *" server "* || " $areas " == *" web "* || " $areas " == *" docker "* ]] && S_APP_CHANGED=true
  [[ " $areas " == *" agent "* ]] && S_AGENT_CHANGED=true
  log "changed areas: $areas"
  if [[ "$S_APP_CHANGED" == false && "$S_AGENT_CHANGED" == false ]]; then
    log "pull request $number changes no server, web, or agent code; nothing to try"
    return 0
  fi

  S_PR="$number" S_SHA="$head" S_AUTHOR="$author" S_PHASE=preparing
  S_WORKTREE="$(mashkif_try_pr_root)/pr-$number-${head:0:12}"
  S_PREVIOUS_IMAGE="" S_PREVIOUS_MIGRATIONS="" S_PR_IMAGE="" S_PR_IMAGE_TAG="" S_MSI=""
  S_STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  if [[ "$S_APP_CHANGED" == true ]]; then
    app="$(mashkif_container_id app)"
    db="$(mashkif_container_id db)"
    if [[ -z "$app" || -z "$db" || "$(docker inspect -f '{{.State.Running}}' "$app" 2>/dev/null)" != true ||
      "$(docker inspect -f '{{.State.Running}}' "$db" 2>/dev/null)" != true ]]; then
      fail "the development environment is not running; start it with scripts/local.sh up -d"
      return "$MASHKIF_EXIT_REFUSED"
    fi
  fi
  if [[ -e "$S_WORKTREE" ]]; then
    fail "$S_WORKTREE already exists without a session; remove it with: git worktree remove --force '$S_WORKTREE'"
    return "$MASHKIF_EXIT_REFUSED"
  fi

  # The session is recorded before anything is created, so restore can always
  # clean up after an interruption.
  write_state
  mkdir -p "$(dirname "$S_WORKTREE")"
  if ! git -C "$MAIN" worktree add --quiet --detach "$S_WORKTREE" "$head"; then
    abort_start "could not create the worktree $S_WORKTREE"
    return
  fi
  if [[ "$(git -C "$S_WORKTREE" rev-parse HEAD)" != "$head" ]]; then
    abort_start "the worktree is not at the pinned commit $head"
    return
  fi
  log "worktree: $S_WORKTREE"

  if [[ "$S_APP_CHANGED" == true ]]; then
    S_PREVIOUS_MIGRATIONS="$(applied_migrations "$db")" || {
      abort_start "could not read the applied migrations from the database"
      return
    }
    if ! journal="$(journal_whens <"$S_WORKTREE/server/drizzle/meta/_journal.json")"; then
      abort_start "could not read server/drizzle/meta/_journal.json of the pull request"
      return
    fi
    missing="$(missing_migrations "$S_PREVIOUS_MIGRATIONS" "$journal")"
    if [[ -n "$missing" ]]; then
      explain_newer_schema "$missing" "pull request $number"
      abort_start "refusing to start pull request $number"
      return
    fi
    S_PR_IMAGE_TAG="mashkif-app:try-pr-$number-${head:0:12}"
    iidfile="$scratch/pr.iid"
    log "building $S_PR_IMAGE_TAG from the worktree"
    if ! docker build -f "$S_WORKTREE/config/docker/app.Dockerfile" -t "$S_PR_IMAGE_TAG" \
      --iidfile "$iidfile" "$S_WORKTREE" >&2; then
      abort_start "the image build failed"
      return
    fi
    S_PR_IMAGE="$(cat -- "$iidfile")"
    write_state
  fi

  if [[ "$S_AGENT_CHANGED" == true ]]; then
    build_msi "$S_WORKTREE" || {
      rc=$?
      abort_start "the agent build for pull request $number failed"
      return "$rc"
    }
    write_state
  fi

  if [[ "$S_APP_CHANGED" == true ]]; then
    S_PREVIOUS_IMAGE="$(docker inspect -f '{{.Image}}' "$app")"
    dev_image="$(docker image inspect -f '{{.Id}}' "$MASHKIF_DEV_IMAGE" 2>/dev/null || true)"
    S_PHASE=replacing
    write_state
    # Keep the previous image alive under its own tag until restore.
    docker tag "$S_PREVIOUS_IMAGE" "$MASHKIF_PREVIOUS_TAG"
    [[ -n "$dev_image" ]] || docker tag "$S_PREVIOUS_IMAGE" "$MASHKIF_DEV_IMAGE"
    {
      printf '# Written by scripts/try-pr.sh for pull request %s; removed by restore.\n' "$number"
      printf 'services:\n  app:\n    image: %s\n' "$S_PR_IMAGE_TAG"
    } >"$OVERRIDE_FILE"
    MASHKIF_DEV_COMPOSE_EXTRA=("$OVERRIDE_FILE")
    log "replacing app with pull request $number (db is not touched)"
    if ! mashkif_dev_compose_up --no-deps app; then
      S_PHASE=active
      write_state
      fail "the pull request's app is not healthy; inspect it, then run scripts/try-pr.sh restore"
      return "$MASHKIF_EXIT_FAILED"
    fi
    S_PHASE=active
    write_state
    if ! mashkif_dev_check_running "$S_PR_IMAGE" "app runs the pull request image"; then
      fail "checks failed for pull request $number; run scripts/try-pr.sh restore to go back"
      return "$MASHKIF_EXIT_FAILED"
    fi
  else
    S_PHASE=active
    write_state
  fi

  log ""
  log "Trying pull request $number at $head."
  [[ "$S_APP_CHANGED" == true ]] && log "  app: $S_PR_IMAGE_TAG ($S_PR_IMAGE)"
  [[ -n "$S_MSI" ]] && log "  MSI: $(windows_path "$S_MSI") (install it manually)"
  log "When done: scripts/try-pr.sh restore"
}

cmd_status() {
  local lock_state app running
  preflight || return
  if [[ ! -e "$STATE_FILE" ]]; then
    printf 'No try-pr session.\n'
    return 0
  fi
  read_state
  if flock -n "$(mashkif_state_dir)/dev.lock" true 2>/dev/null; then
    lock_state=free
  else
    lock_state=held
  fi
  printf 'Pull request:   %s by %s\n' "$S_PR" "$S_AUTHOR"
  printf 'Commit:         %s\n' "$S_SHA"
  printf 'Started:        %s\n' "$S_STARTED_AT"
  printf 'Phase:          %s\n' "$S_PHASE"
  printf 'Worktree:       %s%s\n' "$S_WORKTREE" "$([[ -e "$S_WORKTREE" ]] || printf ' (missing)')"
  printf 'Changes:        app=%s agent=%s\n' "$S_APP_CHANGED" "$S_AGENT_CHANGED"
  [[ -n "$S_MSI" ]] && printf 'MSI:            %s\n' "$(windows_path "$S_MSI")"
  if [[ "$S_APP_CHANGED" == true ]]; then
    printf 'Previous image: %s\n' "${S_PREVIOUS_IMAGE:-not recorded yet}"
    printf 'PR image:       %s %s\n' "${S_PR_IMAGE_TAG:-}" "${S_PR_IMAGE:-not built yet}"
    printf 'Migrations before the session: %s\n' "${S_PREVIOUS_MIGRATIONS:-none}"
    app="$(mashkif_container_id app)"
    running="$( [[ -n "$app" ]] && docker inspect -f '{{.Image}}' "$app" 2>/dev/null || true)"
    printf 'Running app image: %s\n' "${running:-no app container}"
  fi
  if [[ "$lock_state" == free && "$S_PHASE" != active ]]; then
    printf 'The run that started this session was interrupted. Run scripts/try-pr.sh restore.\n'
  fi
}

cmd_restore() {
  local keep_app="$1" db applied journal missing
  preflight || return
  mashkif_dev_lock || return
  if [[ ! -e "$STATE_FILE" ]]; then
    rm -f -- "$OVERRIDE_FILE"
    log "no try-pr session; nothing to restore"
    return 0
  fi
  read_state
  log "restoring after pull request $S_PR (phase $S_PHASE)"

  if [[ -n "$S_PREVIOUS_IMAGE" && "$keep_app" == 0 ]]; then
    if ! docker image inspect "$S_PREVIOUS_IMAGE" >/dev/null 2>&1; then
      fail "the previous image $S_PREVIOUS_IMAGE no longer exists"
      log "Use scripts/try-pr.sh restore --keep-app, then scripts/local.sh up -d to build it again."
      return "$MASHKIF_EXIT_FAILED"
    fi
    db="$(mashkif_dev_compose ps -a -q db 2>/dev/null | head -n 1)"
    if [[ -z "$db" ]] || ! wait_healthy "$db"; then
      fail "the db container is missing or not healthy, so the migration state cannot be checked"
      log "Use scripts/try-pr.sh restore --keep-app, then scripts/local.sh up -d."
      return "$MASHKIF_EXIT_FAILED"
    fi
    applied="$(applied_migrations "$db")" || {
      fail "could not read the applied migrations from the database"
      return "$MASHKIF_EXIT_FAILED"
    }
    if ! journal="$(docker run --rm --network none --entrypoint cat "$S_PREVIOUS_IMAGE" \
      server/drizzle/meta/_journal.json | journal_whens)"; then
      fail "could not read the migration journal of the previous image"
      return "$MASHKIF_EXIT_FAILED"
    fi
    missing="$(missing_migrations "$applied" "$journal")"
    if [[ -n "$missing" ]]; then
      explain_newer_schema "$missing" "the previous app image"
      fail "refusing to restore; nothing was changed"
      return "$MASHKIF_EXIT_REFUSED"
    fi
    docker tag "$S_PREVIOUS_IMAGE" "$MASHKIF_DEV_IMAGE"
    MASHKIF_DEV_COMPOSE_EXTRA=()
    log "starting the previous app image $S_PREVIOUS_IMAGE"
    mashkif_dev_compose_up --no-deps --force-recreate app || {
      fail "the previous app did not become healthy; the session is kept, so restore can run again"
      return "$MASHKIF_EXIT_FAILED"
    }
    mashkif_dev_check_running "$S_PREVIOUS_IMAGE" "app runs the previous image again" || {
      fail "checks failed after restore; the session is kept"
      return "$MASHKIF_EXIT_FAILED"
    }
    remove_tag "$S_PR_IMAGE_TAG"
  elif [[ -n "$S_PREVIOUS_IMAGE" ]]; then
    log "--keep-app: the pull request's app stays running ($S_PR_IMAGE_TAG)"
    log "The next scripts/local.sh up -d replaces it with $MASHKIF_DEV_IMAGE built from your checkout."
  else
    remove_tag "$S_PR_IMAGE_TAG"
  fi

  remove_tag "$MASHKIF_PREVIOUS_TAG"
  remove_worktree || return
  rm -f -- "$OVERRIDE_FILE" "$STATE_FILE"
  log "try-pr session for pull request $S_PR ended"
}

main() {
  local command="${1:-}" number="" trusted="" keep_app=0
  if [[ "$command" =~ ^[0-9]+$ ]]; then
    command=start
  elif (( $# )); then
    shift
  fi
  case "$command" in
    start)
      number="${1:-}"
      shift || true
      while (($#)); do
        case "$1" in
          --trust)
            trusted="${2:-}"
            shift 2 || true
            ;;
          *)
            usage >&2
            return "$MASHKIF_EXIT_ENV"
            ;;
        esac
      done
      if [[ ! "$number" =~ ^[1-9][0-9]*$ ]]; then
        fail "start needs a pull request number"
        return "$MASHKIF_EXIT_ENV"
      fi
      if [[ -n "$trusted" && ! "$trusted" =~ ^[0-9a-f]{40}$ ]]; then
        fail "--trust needs the full 40-character head commit SHA"
        return "$MASHKIF_EXIT_ENV"
      fi
      cmd_start "$number" "$trusted"
      ;;
    status)
      (($# == 0)) || {
        usage >&2
        return "$MASHKIF_EXIT_ENV"
      }
      cmd_status
      ;;
    restore)
      case "$#:${1:-}" in
        0:) ;;
        1:--keep-app) keep_app=1 ;;
        *)
          usage >&2
          return "$MASHKIF_EXIT_ENV"
          ;;
      esac
      cmd_restore "$keep_app"
      ;;
    -h | --help)
      usage
      ;;
    *)
      usage >&2
      return "$MASHKIF_EXIT_ENV"
      ;;
  esac
}

main "$@"
