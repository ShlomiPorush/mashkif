#!/usr/bin/env bash
# Tests for scripts/local.sh with a fake docker: missing machine-local files,
# build failure before any change, occupied port, failed health, root
# processes, image identity, the shared lock, an active try-pr session,
# resumable data preparation, and the nuke safety rules. Every path is under a
# scratch directory; the real development environment is never touched.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/common.sh
source "$SCRIPT_DIR/../lib/common.sh"
# shellcheck source=../lib/test-dev-env-shims.sh
source "$SCRIPT_DIR/../lib/test-dev-env-shims.sh"

LOCAL="$MASHKIF_ROOT/scripts/local.sh"
failures=0

scratch="$(mashkif_mktemp local-test)"
trap 'rm -rf -- "$scratch"' EXIT
mashkif_shims_install "$scratch/shims"
mashkif_shims_fence "$scratch/shims"
S="$scratch/shims/state"

export HOME="$scratch/home"
export MASHKIF_STATE_DIR="$scratch/state"
export MASHKIF_DEV_CHECKOUT="$scratch/main"
export MASHKIF_TRY_PR_ROOT="$scratch/try-pr"
export MASHKIF_WAIT_TIMEOUT=5
unset MASHKIF_DATA_DIR MASHKIF_GEOIP_DIR POSTGRES_PASSWORD DATABASE_URL
mkdir -p "$HOME" "$scratch/main" "$scratch/geoip"
head -c 64 /dev/urandom >"$scratch/geoip/GeoLite2-ASN.mmdb"
DATA="$scratch/data"
# A database password for this run only; never a fixed value in the repository.
TEST_PASSWORD="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"

write_env() {
  cat >"$scratch/main/.env" <<EOF
MASHKIF_DATA_DIR=$1
MASHKIF_GEOIP_DIR=$scratch/geoip
POSTGRES_USER=mashkif
POSTGRES_DB=mashkif
POSTGRES_PASSWORD=${2:-$TEST_PASSWORD}
DATABASE_URL=postgres://mashkif:${2:-$TEST_PASSWORD}@db:5432/mashkif
EOF
}

reset_shims() {
  rm -rf "${S:?}/behave/"* "${S:?}/containers/"*
  : >"$S/calls.log"
}

calls_include() { grep -qF -- "$1" "$S/calls.log"; }
calls_exclude() { ! grep -qF -- "$1" "$S/calls.log"; }
marker_flag() { sed -n 's/^postgres_prepared=//p' "$1/.mashkif-data" 2>/dev/null; }
make_marked() {
  mkdir -p "$1"
  printf 'project_id=%s\npostgres_prepared=%s\n' "${3:-mashkif-dev}" "$2" >"$1/.mashkif-data"
}

log "local.sh: machine-local files"
t_run "$LOCAL" status
t_expect "status without docker-compose-dev.yml fails clearly" 2 "docker-compose-dev.yml" "cp config/docker-compose-dev.example.yml"
t_run "$LOCAL" up -d
t_expect "up without docker-compose-dev.yml fails clearly" 2 "development Compose file is missing"
t_check "nothing ran in Docker without the Compose file" calls_exclude "compose"
cp "$MASHKIF_ROOT/config/docker-compose-dev.example.yml" "$scratch/main/docker-compose-dev.yml"
t_run "$LOCAL" up -d
t_expect "up without .env fails clearly" 2 "environment file is missing" "cp .env.example .env"
write_env "$DATA" change-me
t_run "$LOCAL" up -d
t_expect "placeholder password is refused" 2 "placeholder database password"
write_env "relative/data"
t_run "$LOCAL" up -d
t_expect "relative MASHKIF_DATA_DIR is refused" 2 "expected an absolute path"
t_run "$LOCAL" frobnicate
t_expect "unknown command prints usage" 2 "Usage:"

log "local.sh: build failure before any environment change"
write_env "$DATA"
reset_shims
touch "$S/behave/build-fail"
t_run "$LOCAL" up -d
t_expect "build failure stops up" 1 "image build failed" "running environment was not changed"
t_check "no compose up or down after the failed build" calls_exclude "compose -p mashkif-dev --project-directory $scratch/main -f $scratch/main/docker-compose-dev.yml up"
t_check "the data directory was not created" test ! -e "$DATA"

log "local.sh: healthy start"
reset_shims
t_run "$LOCAL" up -d
t_expect "up -d succeeds and checks the environment" 0 "app is healthy" "db is healthy" \
  "app: every process runs as a non-root user (10001)" "db: every process runs as a non-root user (999)" \
  "app /readyz answers 200" "app runs the image just built" "http://127.0.0.1:8180"
t_check "Compose runs with project mashkif-dev and the main checkout's file" \
  calls_include "compose -p mashkif-dev --project-directory $scratch/main -f $scratch/main/docker-compose-dev.yml up -d --wait"
t_check "up removes orphans" calls_include "--remove-orphans"
t_check "data directory has the marker with postgres_prepared=true" test "$(marker_flag "$DATA")" = true
t_check "postgres/ was given to the db user" grep -qxF "$DATA/postgres" "$S/chowned"
t_run "$LOCAL" status
t_expect "status reports the environment" 0 "Project:        mashkif-dev" "try-pr session: none" \
  "matches mashkif-app:dev" "postgres_prepared=true"
t_check "status never prints secrets" test "${T_OUT//"$TEST_PASSWORD"/}" = "$T_OUT"
t_run "$LOCAL" down
t_expect "down succeeds and keeps data" 0 "the data directory is kept"
t_check "data directory survives down" test -f "$DATA/.mashkif-data"
reset_shims
t_run "$LOCAL" up -d
t_expect "up again after down" 0 "app runs the image just built"
t_check "prepared data directory is not re-owned" calls_exclude "--entrypoint chown"
db_before="$(cat "$S/db-created")"
touch "$S/behave/keep-running-app"
t_run "$LOCAL" up -d
t_expect "rebuild while running: app is recreated on the new image" 0 \
  "recreating app with the image just built" "app runs the image just built"
t_check "  only app was force-recreated" calls_include "--no-deps --force-recreate app"
t_check "  db was not recreated" test "$(cat "$S/db-created")" = "$db_before"
rm -f "$S/behave/keep-running-app"

log "local.sh: failures after start"
reset_shims
touch "$S/behave/port-busy"
t_run "$LOCAL" up -d
t_expect "occupied port is reported" 1 "port is already allocated" "host port for app is in use"
reset_shims
touch "$S/behave/unhealthy"
t_run "$LOCAL" up -d
t_expect "failed health is reported" 1 "did not become healthy"
reset_shims
touch "$S/behave/root-process"
t_run "$LOCAL" up -d
t_expect "a root process fails the identity check" 1 "processes running as root"
reset_shims
touch "$S/behave/stale-image"
t_run "$LOCAL" up -d
t_expect "an app running another image fails the image check" 1 "app runs image sha256:stale, expected"

log "local.sh: shared lock and try-pr session"
reset_shims
mkdir -p "$MASHKIF_STATE_DIR"
flock "$MASHKIF_STATE_DIR/dev.lock" sleep 30 &
holder=$!
for _ in 1 2 3 4 5 6 7 8 9 10; do
  flock -n "$MASHKIF_STATE_DIR/dev.lock" true 2>/dev/null || break
  sleep 0.2
done
t_run "$LOCAL" up -d
t_expect "a concurrent up is refused" 1 "another local.sh or try-pr.sh run"
t_run "$LOCAL" nuke
t_expect "a concurrent nuke is refused" 1 "another local.sh or try-pr.sh run"
t_run "$LOCAL" status
t_expect "status works while the lock is held" 0 "Lock:           held"
pkill -P "$holder" 2>/dev/null || true
kill "$holder" 2>/dev/null || true
wait "$holder" 2>/dev/null || true
printf 'pr=42\nsha=%s\nphase=active\n' "$(printf '0%.0s' {1..40})" >"$MASHKIF_STATE_DIR/try-pr.state"
for action in build "up -d" down nuke; do
  # shellcheck disable=SC2086 # Split the action into arguments on purpose.
  t_run "$LOCAL" $action
  t_expect "$action is refused during a try-pr session" 1 "try-pr session is active (pull request 42)" "try-pr.sh restore"
done
t_run "$LOCAL" status
t_expect "status works during a try-pr session" 0 "try-pr session: pull request 42"
rm -f "$MASHKIF_STATE_DIR/try-pr.state"

log "local.sh: refuses to run from a try-pr worktree"
mkdir -p "$MASHKIF_TRY_PR_ROOT/pr-7-abc"
cp -R "$MASHKIF_ROOT/scripts" "$MASHKIF_TRY_PR_ROOT/pr-7-abc/"
t_run "$MASHKIF_TRY_PR_ROOT/pr-7-abc/scripts/local.sh" status
t_expect "a copy inside a try-pr worktree refuses" 1 "inside a try-pr worktree"

log "local.sh: interrupted data preparation"
D="$scratch/prep"
write_env "$D"
reset_shims
mkdir -p "$(dirname "$D")/.prep.preparing.abc123"
t_run "$LOCAL" up -d
t_expect "interrupted before the marker (leftover temp dir, target absent): completes" 0 "created data directory"
t_check "  marker true" test "$(marker_flag "$D")" = true

D="$scratch/prep-after-marker"
write_env "$D"
reset_shims
make_marked "$D" false
t_run "$LOCAL" up -d
t_expect "interrupted after the marker, before postgres/: completes" 0 "data directory prepared"
t_check "  marker true" test "$(marker_flag "$D")" = true

D="$scratch/prep-chown-fails"
write_env "$D"
reset_shims
touch "$S/behave/chown-fail"
t_run "$LOCAL" up -d
t_expect "ownership change fails: up stops" 1 "could not change the owner"
t_check "  marker stays false" test "$(marker_flag "$D")" = false
t_check "  postgres/ stays empty" test -z "$(ls -A "$D/postgres")"
rm -f "$S/behave/chown-fail"
t_run "$LOCAL" up -d
t_expect "rerun after the failed ownership change completes" 0 "data directory prepared"
t_check "  marker true" test "$(marker_flag "$D")" = true

D="$scratch/prep-after-chown"
write_env "$D"
reset_shims
make_marked "$D" false
mkdir -p "$D/postgres"
printf '%s\n' "$D/postgres" >>"$S/chowned"
t_run "$LOCAL" up -d
t_expect "interrupted after the ownership change, before the flag: completes" 0 "data directory prepared"
t_check "  marker true" test "$(marker_flag "$D")" = true

D="$scratch/prep-not-kept"
write_env "$D"
reset_shims
touch "$S/behave/chown-noop"
t_run "$LOCAL" up -d
t_expect "a file system that drops ownership is refused" 1 "Put MASHKIF_DATA_DIR on WSL ext4"
t_check "  marker stays false" test "$(marker_flag "$D")" = false

D="$scratch/prep-nonempty"
write_env "$D"
reset_shims
make_marked "$D" false
mkdir -p "$D/postgres"
echo data >"$D/postgres/PG_VERSION"
t_run "$LOCAL" up -d
t_expect "non-empty postgres/ with a false flag is refused" 1 "is not empty, but its preparation never finished"
t_check "  it was not re-owned" calls_exclude "--entrypoint chown"

D="$scratch/prep-unmarked"
write_env "$D"
reset_shims
mkdir -p "$D"
echo keep >"$D/file.txt"
t_run "$LOCAL" up -d
t_expect "an existing directory without the marker is refused" 1 "has no .mashkif-data marker"
t_check "  it was not changed" test "$(ls -A "$D")" = file.txt

D="$scratch/prep-other"
write_env "$D"
reset_shims
make_marked "$D" true other-project
t_run "$LOCAL" up -d
t_expect "a marker of another project is refused" 1 "names project 'other-project'"

D="$scratch/prep-owner-lost"
write_env "$D"
reset_shims
make_marked "$D" true
mkdir -p "$D/postgres"
t_run "$LOCAL" up -d
t_expect "prepared flag with the wrong owner is refused" 1 "is marked prepared, but"

log "local.sh: nuke"
D="$scratch/nuke-unmarked"
write_env "$D"
reset_shims
mkdir -p "$D"
echo keep >"$D/file.txt"
t_run bash -c "echo mashkif-dev | '$LOCAL' nuke"
t_expect "nuke on an unmarked path is refused" 1 "has no .mashkif-data marker"
t_check "  it was not deleted" test -f "$D/file.txt"

make_marked "$scratch/nuke-real" true
mkdir -p "$scratch/nuke-real/postgres"
ln -s "$scratch/nuke-real" "$scratch/nuke-link"
write_env "$scratch/nuke-link"
t_run bash -c "echo mashkif-dev | '$LOCAL' nuke"
t_expect "nuke through a symbolic link is refused" 1 "through a symbolic link"
t_check "  the link target was not deleted" test -f "$scratch/nuke-real/.mashkif-data"

make_marked "$scratch/elsewhere/data" true
ln -s "$scratch/elsewhere" "$scratch/linked-parent"
write_env "$scratch/linked-parent/data"
t_run bash -c "echo mashkif-dev | '$LOCAL' nuke"
t_expect "nuke through a symlinked parent directory is refused" 1 "through a symbolic link"
t_check "  the target was not deleted" test -f "$scratch/elsewhere/data/.mashkif-data"

for broad in / /mnt /mnt/c /home "$HOME" "$scratch"; do
  write_env "$broad"
  t_run bash -c "echo mashkif-dev | '$LOCAL' nuke"
  t_expect "nuke of $broad is refused" 1 "refusing to delete"
done

D="$scratch/nuke-extra"
write_env "$D"
make_marked "$D" true
mkdir -p "$D/postgres"
echo x >"$D/notes.txt"
t_run bash -c "echo mashkif-dev | '$LOCAL' nuke"
t_expect "nuke with unexpected entries is refused" 1 "entries Mashkif did not create: notes.txt"
t_check "  nothing was deleted" test -f "$D/notes.txt"

D="$scratch/nuke-ok"
write_env "$D"
make_marked "$D" true
mkdir -p "$D/postgres"
echo data >"$D/postgres/PG_VERSION"
t_run bash -c "echo wrong | '$LOCAL' nuke"
t_expect "nuke without the project ID is refused" 1 "not confirmed; nothing was deleted"
t_check "  data is intact" test -f "$D/postgres/PG_VERSION"
t_run bash -c "'$LOCAL' nuke </dev/null"
t_expect "nuke without any input is refused" 1 "not confirmed"
reset_shims
t_run bash -c "echo mashkif-dev | '$LOCAL' nuke"
t_expect "confirmed nuke deletes the data directory" 0 "deleted $D"
t_check "  the directory is gone" test ! -e "$D"
t_check "  the environment was stopped first" calls_include "down --remove-orphans"
t_run bash -c "echo mashkif-dev | '$LOCAL' nuke"
t_expect "nuke of an absent directory is a no-op" 0 "nothing to delete"

if ((failures)); then
  log "local.sh tests: $failures failed"
  exit 1
fi
log "local.sh tests: all passed"
