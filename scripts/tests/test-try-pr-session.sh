#!/usr/bin/env bash
# Tests for scripts/try-pr.sh with a fake docker and dotnet.exe, a local bare
# repository standing in for GitHub (refs/pull/N/head), and file:// JSON
# standing in for the GitHub REST API. Covers the trust gate, pinning, the
# main-checkout rule, app replacement and restore, agent-only pull requests,
# the shared lock, an interrupted run, and the migration refusals. Every path
# is under a scratch directory; the real development environment is never
# touched.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/common.sh
source "$SCRIPT_DIR/../lib/common.sh"
# shellcheck source=../lib/test-dev-env-shims.sh
source "$SCRIPT_DIR/../lib/test-dev-env-shims.sh"

failures=0
require_cmd setsid || exit
require_cmd python3 || exit

# Only the scratch repositories below may be touched.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR GIT_OBJECT_DIRECTORY \
  GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_CEILING_DIRECTORIES GIT_NAMESPACE MASHKIF_DEV_CHECKOUT

scratch="$(mashkif_mktemp try-pr-test)"
trap 'rm -rf -- "$scratch"' EXIT
mashkif_shims_install "$scratch/shims"
mashkif_shims_fence "$scratch/shims"
S="$scratch/shims/state"

export HOME="$scratch/home"
export MASHKIF_STATE_DIR="$scratch/state"
export MASHKIF_TRY_PR_ROOT="$scratch/try-pr"
export MASHKIF_WAIT_TIMEOUT=4
export MASHKIF_GITHUB_API="file://$scratch/api"
export MASHKIF_GITHUB_REPO=ShlomiPorush/mashkif
# Scratch of the runs under test, including one that is killed, stays here.
export MASHKIF_TMP_DIR="$scratch/tmp"
mkdir -p "$HOME"
STATE_FILE="$MASHKIF_STATE_DIR/try-pr.state"

g() {
  git -c user.name=test -c user.email=test@example.invalid -c commit.gpgsign=false \
    -c init.defaultBranch=main -c advice.detachedHead=false "$@"
}

# --- Repositories --------------------------------------------------------
origin="$scratch/origin.git"
seed="$scratch/seed"
g init -q --bare "$origin"
g init -q -b main "$seed"
mkdir -p "$seed/server/src" "$seed/server/drizzle/meta" "$seed/config/docker" "$seed/agent" "$seed/docs"
echo 'FROM scratch' >"$seed/config/docker/app.Dockerfile"
echo 'export {};' >"$seed/server/src/main.ts"
echo '{"version":"7","dialect":"postgresql","entries":[]}' >"$seed/server/drizzle/meta/_journal.json"
echo '<Project />' >"$seed/agent/Agent.csproj"
echo '# Docs' >"$seed/docs/index.md"
g -C "$seed" add -A
g -C "$seed" commit -q -m "initial"
commit_a="$(g -C "$seed" rev-parse HEAD)"

journal() {
  local whens="$1" entries="" when
  for when in $whens; do
    entries+="${entries:+,}{\"idx\":0,\"version\":\"7\",\"when\":$when,\"tag\":\"m$when\",\"breakpoints\":true}"
  done
  printf '{"version":"7","dialect":"postgresql","entries":[%s]}\n' "$entries"
}

# branch_commit <base> <file> <content> [journal-whens]: prints a new commit.
branch_commit() {
  g -C "$seed" checkout -q --detach "$1"
  mkdir -p "$(dirname "$seed/$2")"
  printf '%s\n' "$3" >"$seed/$2"
  [[ -n "${4:-}" ]] && journal "$4" >"$seed/server/drizzle/meta/_journal.json"
  g -C "$seed" add -A
  g -C "$seed" commit -q -m "change $2"
  g -C "$seed" rev-parse HEAD
}

pr6="$(branch_commit "$commit_a" server/src/old.ts 'export const old = 1;')"
main_b="$(branch_commit "$commit_a" server/drizzle/0000_init.sql 'create table t (id int);' 1700000003000)"
pr1="$(branch_commit "$main_b" server/src/one.ts 'export const one = 1;')"
pr2="$(branch_commit "$main_b" server/src/two.ts 'export const two = 2;')"
pr3="$(branch_commit "$main_b" agent/Tray.cs '// tray')"
pr4="$(branch_commit "$main_b" docs/notes.md '# Notes')"
pr5="$(branch_commit "$main_b" server/drizzle/0001_more.sql 'create table u (id int);' '1700000003000 1700000005000')"
g -C "$seed" push -q "$origin" "$main_b:refs/heads/main"
for n in 1 2 3 4 5 6; do
  sha_var="pr$n"
  g -C "$seed" push -q "$origin" "${!sha_var}:refs/pull/$n/head"
done
g -C "$seed" push -q "$origin" "$pr4:refs/pull/8/head"
g -C "$seed" push -q "$origin" "$pr1:refs/pull/9/head"

main="$scratch/main"
g clone -q "$origin" "$main"
cp -R "$MASHKIF_ROOT/scripts" "$main/scripts"
echo "name: mashkif-dev" >"$main/docker-compose-dev.yml"
printf 'MASHKIF_DATA_DIR=%s/data\nPOSTGRES_PASSWORD=test-password\n' "$scratch" >"$main/.env"
TRY="$main/scripts/try-pr.sh"

# --- Fake GitHub API -----------------------------------------------------
api_pull() {
  local n="$1" author="$2" sha="$3" full="${4:-ShlomiPorush/mashkif}"
  mkdir -p "$scratch/api/repos/ShlomiPorush/mashkif/pulls"
  cat >"$scratch/api/repos/ShlomiPorush/mashkif/pulls/$n" <<EOF
{"number": $n, "state": "open", "title": "Test $n",
 "user": {"login": "$author"},
 "head": {"sha": "$sha", "ref": "topic-$n"},
 "base": {"ref": "main", "sha": "$main_b",
          "repo": {"full_name": "$full", "owner": {"login": "ShlomiPorush"}}}}
EOF
}
api_pull 1 ShlomiPorush "$pr1"
api_pull 2 someone-else "$pr2"
api_pull 3 shlomiporush "$pr3"
api_pull 4 ShlomiPorush "$pr4"
api_pull 5 ShlomiPorush "$pr5"
api_pull 6 ShlomiPorush "$pr6"
api_pull 8 ShlomiPorush "$pr1"
api_pull 9 ShlomiPorush "$pr1" someone/fork

# --- Running development environment (fake) --------------------------------
fake_compose() {
  docker compose -p mashkif-dev --project-directory "$main" -f "$main/docker-compose-dev.yml" "$@"
}
docker build -f "$main/config/docker/app.Dockerfile" -t mashkif-app:dev --iidfile "$scratch/dev.iid" "$main"
dev_id="$(cat "$scratch/dev.iid")"
fake_compose up -d --wait >/dev/null
app_image() { cat "$S/containers/mashkif-dev-app-1/image"; }
state_get() { sed -n "s/^$1=//p" "$STATE_FILE"; }
no_session() { [[ ! -e "$STATE_FILE" ]] && [[ -z "$(ls -A "$MASHKIF_TRY_PR_ROOT" 2>/dev/null)" ]]; }
worktree_count() { g -C "$main" worktree list | wc -l; }
calls_exclude() { ! grep -qE -- "$1" "$S/calls.log"; }
t_check "fake environment runs mashkif-app:dev with migration 1700000003000 applied" \
  test "$(app_image)" = "$dev_id" -a "$(cat "$S/applied")" = 1700000003000

# --- Main checkout rule -----------------------------------------------------
log "try-pr.sh: runs only from the main checkout"
g -C "$main" worktree add -q --detach "$scratch/other-worktree" HEAD
cp -R "$MASHKIF_ROOT/scripts" "$scratch/other-worktree/scripts"
t_run "$scratch/other-worktree/scripts/try-pr.sh" status
t_expect "a copy in another worktree refuses" 1 "run try-pr.sh from the main checkout"
g -C "$main" worktree remove --force "$scratch/other-worktree"
t_run "$TRY" start abc
t_expect "a malformed number is a usage error" 2 "needs a pull request number"
t_run "$TRY" start 2 --trust deadbeef
t_expect "a short --trust SHA is a usage error" 2 "full 40-character"
# Without a value, --trust once looped forever; timeout turns a regression into a failure.
t_run timeout 30 "$TRY" start 2 --trust
t_expect "--trust without a value is a usage error" 2 "full 40-character"

# --- Trust gate -------------------------------------------------------------
log "try-pr.sh: trust gate"
: >"$S/calls.log"
t_run "$TRY" start 2
t_expect "a pull request by another author is refused" 1 "is by someone-else, not the repository owner ShlomiPorush" \
  "scripts/try-pr.sh start 2 --trust $pr2"
t_check "  nothing was built or started" calls_exclude '^(build|compose .* up)'
t_check "  no session or worktree" no_session
t_run "$TRY" start 2 --trust "$pr1"
t_expect "--trust with a different SHA is refused (later push)" 1 "now points at $pr2, not the commit you trusted"
t_check "  no session or worktree" no_session
t_run "$TRY" start 9
t_expect "a pull request against another repository is refused" 1 "belongs to someone/fork"
t_run "$TRY" start 8
t_expect "the fetched head must equal the pinned SHA" 1 "changed while starting"
t_check "  no session or worktree" no_session
t_run "$TRY" start 77
t_expect "an unknown pull request fails clearly" 2 "could not reach the GitHub API"

# --- Owner pull request with server changes ---------------------------------
log "try-pr.sh: server change, start and restore"
: >"$S/calls.log"
t_run "$TRY" start 1
t_expect "owner pull request starts" 0 "by the repository owner" "changed areas: server docker guards" \
  "app runs the pull request image" "When done: scripts/try-pr.sh restore"
pr1_image="$(state_get pr_image)"
t_check "  session is active and pinned" test "$(state_get phase)" = active -a "$(state_get sha)" = "$pr1"
t_check "  previous image recorded" test "$(state_get previous_image)" = "$dev_id"
t_check "  previous migrations recorded" test "$(state_get previous_migrations)" = 1700000003000
t_check "  app runs the PR image" test "$(app_image)" = "$pr1_image" -a -n "$pr1_image"
t_check "  db was created once and never replaced" test "$(cat "$S/db-created")" = 1
t_check "  only app was started" grep -qE 'try-pr.compose.yml up -d --wait --wait-timeout [0-9]+ --no-deps --force-recreate app$' "$S/calls.log"
t_check "  the worktree is at the pinned commit" test "$(git -C "$(state_get worktree)" rev-parse HEAD)" = "$pr1"
t_check "  the image was built from the worktree" grep -qF "build -f $(state_get worktree)/config/docker/app.Dockerfile" "$S/calls.log"
t_check "  mashkif-app:dev still names the previous image" test "$(cat "$S/tags/mashkif-app_dev")" = "$dev_id"

t_run "$TRY" status
t_expect "status shows the session" 0 "Pull request:   1 by ShlomiPorush" "Phase:          active" "Running app image: $pr1_image"
t_run "$main/scripts/local.sh" up -d
t_expect "local.sh up -d is refused during the session" 1 "try-pr session is active (pull request 1)"
t_run "$TRY" start 3
t_expect "a second start is refused" 1 "a try-pr session already exists (pull request 1)"

flock "$MASHKIF_STATE_DIR/dev.lock" sleep 30 &
holder=$!
for _ in 1 2 3 4 5 6 7 8 9 10; do
  flock -n "$MASHKIF_STATE_DIR/dev.lock" true 2>/dev/null || break
  sleep 0.2
done
t_run "$TRY" restore
t_expect "a concurrent restore is refused" 1 "another local.sh or try-pr.sh run"
pkill -P "$holder" 2>/dev/null || true
kill "$holder" 2>/dev/null || true
wait "$holder" 2>/dev/null || true

t_run "$TRY" restore
t_expect "restore puts the previous image back" 0 "app runs the previous image again" "session for pull request 1 ended"
t_check "  app runs the previous image" test "$(app_image)" = "$dev_id"
t_check "  db was never replaced" test "$(cat "$S/db-created")" = 1
t_check "  session and worktree are gone" no_session
t_check "  Git no longer lists the worktree" test "$(worktree_count)" = 1
t_check "  the PR image tag is removed" bash -c "! test -f '$S/tags/mashkif-app_try-pr-1-${pr1:0:12}'"
t_check "  the protective tag is removed" bash -c "! test -f '$S/tags/mashkif-app_try-pr-previous'"
t_run "$TRY" restore
t_expect "restore without a session is a no-op" 0 "nothing to restore"

log "try-pr.sh: --trust for another author"
t_run "$TRY" start 2 --trust "$pr2"
t_expect "a reviewed pull request by another author starts with --trust" 0 "trusted by --trust" "app runs the pull request image"
t_run "$TRY" restore
t_expect "  and restores" 0 "app runs the previous image again"

# --- Agent and docs pull requests -------------------------------------------
log "try-pr.sh: agent and docs changes"
: >"$S/calls.log"
t_run "$TRY" start 3
t_expect "agent change builds the MSI and prints its path" 0 "changed areas: agent guards" "MSI:" "Mashkif-0.0.0-x64.msi"
t_check "  dotnet.exe ran the installer build from agent/" grep -qE "^dotnet.exe build installer/Mashkif.Installer.wixproj -c Release \(in .*/agent\)$" "$S/calls.log"
t_check "  the app was not touched" calls_exclude '^(build|compose .* up)'
t_check "  the MSI is inside the worktree" test -f "$(state_get msi)"
t_run "$TRY" restore
t_expect "  restore removes the worktree" 0 "session for pull request 3 ended"
t_check "  no session or worktree" no_session
t_run "$TRY" start 4
t_expect "documentation-only change has nothing to try" 0 "nothing to try"
t_check "  no session or worktree" no_session
touch "$S/behave/msi-fail"
t_run "$TRY" start 3
t_expect "a failed MSI build ends the run cleanly" 1 "the MSI build failed" "nothing in the development environment was changed"
t_check "  no session or worktree" no_session
rm -f "$S/behave/msi-fail"

# --- Failures before the app is replaced ------------------------------------
log "try-pr.sh: failures before replacing app"
touch "$S/behave/build-fail"
t_run "$TRY" start 1
t_expect "a failed image build ends the run cleanly" 1 "the image build failed" "nothing in the development environment was changed"
t_check "  no session or worktree" no_session
t_check "  app still runs the previous image" test "$(app_image)" = "$dev_id"
rm -f "$S/behave/build-fail"
t_run "$TRY" start 6
t_expect "a pull request without an applied migration is refused" 1 \
  "database has migrations that pull request 6 does not know: 1700000003000" "restore --keep-app"
t_check "  no session or worktree" no_session
t_check "  app still runs the previous image" test "$(app_image)" = "$dev_id"
fake_compose down
t_run "$TRY" start 1
t_expect "start needs a running environment" 1 "scripts/local.sh up -d"
t_check "  no session or worktree" no_session
fake_compose up -d --wait >/dev/null

# --- Interrupted run --------------------------------------------------------
log "try-pr.sh: interrupted run"
touch "$S/behave/kill-on-app-up"
t_run setsid -w "$TRY" start 1
t_check "the run was killed while replacing app" test "$T_RC" -ne 0
t_check "  the session was recorded before replacing app" test "$(state_get phase)" = replacing -a "$(state_get previous_image)" = "$dev_id"
t_run "$TRY" status
t_expect "status reports the interrupted run" 0 "was interrupted. Run scripts/try-pr.sh restore"
t_run "$TRY" start 1
t_expect "a new start is refused until restore" 1 "a try-pr session already exists"
t_run "$TRY" restore
t_expect "restore recovers from the interrupted run" 0 "app runs the previous image again"
t_check "  app runs the previous image" test "$(app_image)" = "$dev_id"
t_check "  no session or worktree" no_session

# --- Migrations added by the pull request -----------------------------------
log "try-pr.sh: restore refuses older code against a newer schema"
t_run "$TRY" start 5
t_expect "a pull request with a new migration starts" 0 "app runs the pull request image"
pr5_image="$(state_get pr_image)"
t_check "  the pull request applied its migration" test "$(cat "$S/applied")" = 1700000003000,1700000005000
t_run "$TRY" restore
t_expect "restore is refused and explains how to proceed" 1 \
  "migrations that the previous app image does not know: 1700000005000" "restore --keep-app" "scripts/local.sh nuke"
t_check "  nothing changed: session kept" test "$(state_get phase)" = active
t_check "  nothing changed: app still runs the PR image" test "$(app_image)" = "$pr5_image"
t_run "$TRY" restore --keep-app
t_expect "restore --keep-app ends the session" 0 "stays running" "session for pull request 5 ended"
t_check "  app still runs the PR image" test "$(app_image)" = "$pr5_image"
t_check "  no session or worktree" no_session
t_run "$main/scripts/local.sh" status
t_expect "local.sh works again" 0 "try-pr session: none"

if ((failures)); then
  log "try-pr.sh tests: $failures failed"
  exit 1
fi
log "try-pr.sh tests: all passed"
