#!/usr/bin/env bash
# Tests for scripts/release.sh. A local bare repository stands in for origin,
# so push semantics (porcelain status, --atomic, --force-with-lease) are real
# Git. docker and gh are PATH shims. A git wrapper passes every call through to
# the real git and only injects the faults a test names: lost push responses,
# an unreadable origin, a failed lease release, a hook before the reservation
# push, and barriers that hold a run at a chosen point.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/common.sh
source "$SCRIPT_DIR/../lib/common.sh"

# Clear every inherited Git variable, so scratch repositories cannot redirect
# to a real repository, and isolate Git from the caller's configuration.
while IFS= read -r name; do
  unset "$name"
done < <(compgen -e | grep '^GIT_' || true)

REAL_GIT="$(command -v git)"
started_at=$SECONDS
failures=0
SCRATCH="$(mashkif_mktemp release-test)"
BG_PIDS=()

cleanup() {
  local pid
  for pid in "${BG_PIDS[@]}"; do
    kill -9 "$pid" 2>/dev/null || true
  done
  if [[ -n "${RELEASE_TEST_KEEP:-}" ]]; then
    printf 'kept the test scratch directory: %s\n' "$SCRATCH" >&2
  else
    rm -rf -- "$SCRATCH"
  fi
}
trap cleanup EXIT

cat >"$SCRATCH/gitconfig" <<'EOF'
[user]
	name = Release Test
	email = release-test@example.invalid
[init]
	defaultBranch = main
[commit]
	gpgsign = false
[tag]
	gpgsign = false
[advice]
	detachedHead = false
EOF
export GIT_CONFIG_GLOBAL="$SCRATCH/gitconfig"
export GIT_CONFIG_NOSYSTEM=1
export GIT_TERMINAL_PROMPT=0

TAG=server-v1.0.0
IMAGE=ghcr.io/shlomiporush/mashkif:1.0.0
IMAGE_KEY="ghcr.io_shlomiporush_mashkif_1.0.0"

# ---------------------------------------------------------------------------
# Shims

SHIMS="$SCRATCH/shims"
mkdir -p "$SHIMS"

cat >"$SHIMS/barrier.sh" <<'EOF'
# barrier <dir> <name>: announces arrival with the caller's PID, then waits for <dir>/go.
barrier() {
  local dir="$1" name="$2" ticks=0
  printf '%s\n' "$$" >"$dir/$name.ready"
  while [[ ! -e "$dir/go" ]]; do
    sleep 0.1
    ticks=$((ticks + 1))
    if ((ticks > 600)); then
      echo "shim: barrier $name timed out" >&2
      exit 1
    fi
  done
}
has_fault() {
  [[ " ${SHIM_FAULTS:-} " == *" $1 "* ]]
}
EOF

cat >"$SHIMS/git" <<'EOF'
#!/usr/bin/env bash
# Test wrapper for git: passes through unless SHIM_FAULTS names a fault.
source "$(dirname "${BASH_SOURCE[0]}")/barrier.sh"
real="${SHIM_REAL_GIT:?}"
state="${SHIM_STATE:?}"
args=("$@")
i=0
dir=""
while ((i < ${#args[@]})); do
  case "${args[i]}" in
    -C) dir="${args[i + 1]}"; i=$((i + 2)) ;;
    -c) i=$((i + 2)) ;;
    --no-optional-locks) i=$((i + 1)) ;;
    *) break ;;
  esac
done
sub="${args[i]:-}"
case "$sub" in
  push | ls-remote | fetch)
    if [[ -e "$state/remote-down" ]]; then
      echo "fatal: unable to access origin: simulated outage" >&2
      exit 128
    fi
    ;;
esac
if [[ "$sub" == push ]]; then
  kind=other
  case " $* " in
    *" --atomic "*) kind=reserve ;;
    *" :refs/release-leases/"*) kind=lease-release ;;
    *" --force-with-lease=refs/release-leases/"*) kind=lease-acquire ;;
  esac
  printf '%s\n' "$kind" >>"$state/push.log"
  case "$kind" in
    lease-acquire)
      if [[ -n "${SHIM_LEASE_BARRIER:-}" ]]; then
        barrier "$SHIM_LEASE_BARRIER" "${SHIM_NAME:-run}"
      fi
      if has_fault lease-lost; then
        "$real" "$@" >/dev/null 2>&1
        exit 1
      fi
      if has_fault lease-lost-down; then
        "$real" "$@" >/dev/null 2>&1
        : >"$state/remote-down"
        exit 1
      fi
      ;;
    lease-release)
      if has_fault release-fail; then
        echo "error: failed to push some refs (simulated)" >&2
        exit 1
      fi
      ;;
    reserve)
      if [[ -n "${SHIM_BEFORE_RESERVE:-}" ]]; then
        "$SHIM_BEFORE_RESERVE" "$dir" || exit 1
      fi
      if has_fault reserve-lost; then
        "$real" "$@" >/dev/null 2>&1
        exit 1
      fi
      # Origin has accepted the push; hold the push process open at a barrier.
      if [[ -n "${SHIM_RESERVE_BARRIER:-}" ]]; then
        "$real" "$@"
        rc=$?
        if has_fault down-after-reserve; then
          : >"$state/remote-down"
        fi
        barrier "$SHIM_RESERVE_BARRIER" reserve
        exit "$rc"
      fi
      ;;
  esac
fi
exec "$real" "$@"
EOF

cat >"$SHIMS/docker" <<'EOF'
#!/usr/bin/env bash
# Test stand-in for docker: a local image store and a registry in files.
source "$(dirname "${BASH_SOURCE[0]}")/barrier.sh"
d="${SHIM_DOCKER_DIR:?}"
mkdir -p "$d/registry" "$d/images"
printf '%s\n' "$*" >>"$d/log"
key() { printf '%s' "$1" | tr '/:@' '___'; }
case "$1 ${2:-}" in
  "buildx version")
    echo "github.com/docker/buildx v0.0.0-shim"
    ;;
  "buildx imagetools")
    fmt="$5" ref="$6"
    if has_fault registry-denied; then
      echo "ERROR: failed to authorize: unexpected status: 403 Forbidden" >&2
      exit 1
    fi
    f="$d/registry/$(key "$ref")"
    if [[ ! -f "$f" ]]; then
      echo "ERROR: $ref: not found" >&2
      exit 1
    fi
    read -r digest rev <"$f"
    case "$fmt" in
      '{{.Manifest.Digest}}')
        if has_fault remote-digest-mismatch; then
          echo "sha256:$(printf 'other' | sha256sum | cut -d' ' -f1)"
        else
          echo "$digest"
        fi
        ;;
      '{{json .Image}}')
        printf '{\n  "architecture": "amd64",\n  "config": {\n    "Labels": {\n      "org.opencontainers.image.revision": "%s",\n      "org.opencontainers.image.version": "x"\n    }\n  }\n}\n' "$rev"
        ;;
      *) echo "shim: unsupported format $fmt" >&2; exit 1 ;;
    esac
    ;;
  build*)
    shift
    file="" tag="" rev="" ctx=""
    while (($#)); do
      case "$1" in
        --file) file="$2"; shift 2 ;;
        --tag) tag="$2"; shift 2 ;;
        --label)
          [[ "$2" == org.opencontainers.image.revision=* ]] && rev="${2#*=}"
          shift 2
          ;;
        --provenance=* | --sbom=*) shift ;;
        -*) echo "shim: unexpected build option $1" >&2; exit 1 ;;
        *) ctx="$1"; shift ;;
      esac
    done
    if [[ -n "${SHIM_BUILD_BARRIER:-}" ]]; then
      barrier "$SHIM_BUILD_BARRIER" build
    fi
    if has_fault build-fail; then
      echo "simulated build failure" >&2
      exit 1
    fi
    [[ -f "$file" && -n "$tag" && -n "$rev" && -d "$ctx" ]] || { echo "shim: bad build call" >&2; exit 1; }
    head="$("$SHIM_REAL_GIT" -C "$ctx" rev-parse HEAD)"
    version="$(sed -nE 's/^  "version": "([^"]*)",?$/\1/p' "$ctx/server/package.json")"
    printf 'tag=%s rev=%s head=%s version=%s\n' "$tag" "$rev" "$head" "$version" >>"$d/builds"
    digest="sha256:$(printf '%s %s %s' "$tag" "$rev" "$RANDOM$$" | sha256sum | cut -d' ' -f1)"
    printf '%s %s\n' "$digest" "$rev" >"$d/images/$(key "$tag")"
    ;;
  push*)
    ref="$2"
    f="$d/images/$(key "$ref")"
    [[ -f "$f" ]] || { echo "shim: no local image $ref" >&2; exit 1; }
    if has_fault push-fail; then
      echo "simulated push failure" >&2
      exit 1
    fi
    cp "$f" "$d/registry/$(key "$ref")"
    : >"$f.pushed"
    printf '%s\n' "$ref" >>"$d/pushes"
    if has_fault push-lost; then
      exit 1
    fi
    ;;
  "image inspect")
    ref="$5"
    f="$d/images/$(key "$ref")"
    [[ -f "$f" ]] || { echo "Error: No such image: $ref" >&2; exit 1; }
    if [[ -f "$f.pushed" ]]; then
      read -r digest _ <"$f"
      echo "${ref%:*}@$digest"
    fi
    ;;
  *)
    echo "shim: unexpected docker call: $*" >&2
    exit 1
    ;;
esac
EOF

cat >"$SHIMS/gh" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"${SHIM_GH_LOG:?}"
echo "gh shim: no gh call is expected" >&2
exit 1
EOF
chmod +x "$SHIMS/git" "$SHIMS/docker" "$SHIMS/gh"

# ---------------------------------------------------------------------------
# Fixture: a repository with the release scripts, both components, and a
# Dockerfile, pushed to a bare origin. Each case copies it.

TEMPLATE="$SCRATCH/template"
make_template() {
  local seed="$TEMPLATE/seed"
  mkdir -p "$seed/scripts/lib" "$seed/server" "$seed/agent" "$seed/config/docker"
  "$REAL_GIT" init -q "$seed"
  cp "$MASHKIF_ROOT/scripts/release.sh" "$seed/scripts/"
  cp "$MASHKIF_ROOT/scripts/lib/common.sh" "$MASHKIF_ROOT/scripts/lib/release-core.sh" "$seed/scripts/lib/"
  cat >"$seed/server/package.json" <<'EOF'
{
  "name": "@mashkif/server",
  "version": "0.1.0",
  "private": true,
  "dependencies": {
    "example": "1.0.0"
  }
}
EOF
  local component
  for component in server agent; do
    cat >"$seed/$component/CHANGELOG.md" <<EOF
# Changelog: $component

Releases are tagged \`$component-vX.Y.Z\`.

## [Unreleased]

### Added

- A health endpoint.

## [0.1.0] - 2026-10-01

### Added

- First version.
EOF
  done
  cat >"$seed/agent/Directory.Build.props" <<'EOF'
<Project>
  <PropertyGroup>
    <Version>0.1.0</Version>
  </PropertyGroup>
</Project>
EOF
  printf 'FROM scratch\n' >"$seed/config/docker/app.Dockerfile"
  "$REAL_GIT" -C "$seed" add -A
  "$REAL_GIT" -C "$seed" commit -q -m "Fixture"
  "$REAL_GIT" init -q --bare "$TEMPLATE/origin.git"
  "$REAL_GIT" -C "$seed" push -q "$TEMPLATE/origin.git" main
}
make_template

W=""
ORIG=""
# world <name>: a fresh origin, clone a, and empty shim state.
world() {
  W="$SCRATCH/$1"
  mkdir -p "$W/tmp" "$W/docker" "$W/state" "$W/barrier"
  cp -a "$TEMPLATE/origin.git" "$W/origin.git"
  clone a
  ORIG="$(g a rev-parse HEAD)"
  printf '%s\n' "--- $1" >&2
}

clone() {
  "$REAL_GIT" clone -q "$W/origin.git" "$W/$1"
}

# g <clone> <git args>: the real git in a clone.
g() {
  local where="$1"
  shift
  "$REAL_GIT" -C "$W/$where" "$@"
}

remote_ref() {
  "$REAL_GIT" -C "$W/origin.git" rev-parse -q --verify "$1" 2>/dev/null || true
}

remote_leases() {
  "$REAL_GIT" -C "$W/origin.git" for-each-ref --format='%(objectname) %(refname)' refs/release-leases/
}

count_lines() {
  if [[ -f "$1" ]]; then
    wc -l <"$1" | tr -d ' '
  else
    printf '0\n'
  fi
}

# commit_on <clone> <message>: a new commit in a clone, without pushing.
commit_on() {
  printf '%s\n' "$2" >>"$W/$1/README.txt"
  g "$1" add README.txt
  g "$1" commit -q -m "$2"
}

RC=0
OUT=""
# run_release <clone> <label> [VAR=value...] -- <release.sh arguments>
run_release() {
  local where="$1" label="$2"
  shift 2
  local -a vars=()
  while (($#)) && [[ "$1" != -- ]]; do
    vars+=("$1")
    shift
  done
  shift
  OUT="$W/$label.out"
  set +e
  (
    cd "$W/$where" &&
      env PATH="$SHIMS:$PATH" MASHKIF_TMP_DIR="$W/tmp" SHIM_REAL_GIT="$REAL_GIT" \
        SHIM_STATE="$W/state" SHIM_DOCKER_DIR="$W/docker" SHIM_GH_LOG="$W/gh.log" \
        "${vars[@]}" bash scripts/release.sh "$@"
  ) >"$OUT" 2>&1 </dev/null
  RC=$?
  set -e
}

LAST_PID=""
# spawn_release: like run_release, in the background; LAST_PID is the release.sh process.
spawn_release() {
  local where="$1" label="$2"
  shift 2
  local -a vars=()
  while (($#)) && [[ "$1" != -- ]]; do
    vars+=("$1")
    shift
  done
  shift
  (
    cd "$W/$where" &&
      exec env PATH="$SHIMS:$PATH" MASHKIF_TMP_DIR="$W/tmp" SHIM_REAL_GIT="$REAL_GIT" \
        SHIM_STATE="$W/state" SHIM_DOCKER_DIR="$W/docker" SHIM_GH_LOG="$W/gh.log" \
        "${vars[@]}" bash scripts/release.sh "$@"
  ) >"$W/$label.out" 2>&1 </dev/null &
  LAST_PID=$!
  BG_PIDS+=("$LAST_PID")
}

# wait_file <path> [seconds]: waits for a file with a deadline.
wait_file() {
  local deadline=$((SECONDS + ${2:-60}))
  while [[ ! -e "$1" ]]; do
    if ((SECONDS > deadline)); then
      printf 'timed out waiting for %s\n' "$1" >&2
      return 1
    fi
    sleep 0.1
  done
}

# wait_exit <pid> [seconds]: waits for a background run with a deadline; sets RC.
wait_exit() {
  local deadline=$((SECONDS + ${2:-120}))
  while kill -0 "$1" 2>/dev/null; do
    if ((SECONDS > deadline)); then
      printf 'timed out waiting for process %s\n' "$1" >&2
      kill -9 "$1" 2>/dev/null || true
      RC=124
      return 1
    fi
    sleep 0.1
  done
  set +e
  wait "$1" 2>/dev/null
  RC=$?
  set -e
}

# snapshot <clone>: every file of the clone and of origin, the shim registry and
# images, the scratch directory, and the gh log.
snapshot() {
  (cd "$W/$1" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum)
  (cd "$W/origin.git" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum)
  (cd "$W/docker" && find . -type f ! -name log -print0 | LC_ALL=C sort -z | xargs -0 -r sha256sum)
  find "$W/tmp" -mindepth 1 | LC_ALL=C sort
  cat "$W/gh.log" 2>/dev/null || true
}

# last_delete_command: the last lease delete command printed by a run.
last_delete_command() {
  grep -F 'git push --porcelain --force-with-lease=refs/release-leases/' "$OUT" | tail -n 1 | sed 's/^ *//'
}

# ---------------------------------------------------------------------------
# Assertions

pass() {
  printf '  ok    %s\n' "$1" >&2
}

flunk() {
  printf '  FAIL  %s\n' "$1" >&2
  if [[ -n "$OUT" && -f "$OUT" ]]; then
    sed 's/^/        | /' "$OUT" | tail -n 25 >&2
  fi
  failures=$((failures + 1))
}

expect() {
  local description="$1"
  shift
  if "$@"; then
    pass "$description"
  else
    flunk "$description"
  fi
}

expect_eq() {
  if [[ "$2" == "$3" ]]; then
    pass "$1"
  else
    flunk "$1 (expected '$2', got '$3')"
  fi
}

expect_rc_zero() {
  expect_eq "$1: exit 0" 0 "$RC"
}

expect_rc_nonzero() {
  if ((RC != 0)); then
    pass "$1: refused (exit $RC)"
  else
    flunk "$1: expected a non-zero exit"
  fi
}

expect_no_out() {
  if grep -qF -- "$2" "$OUT"; then
    flunk "$1 (output contains: $2)"
  else
    pass "$1"
  fi
}

expect_out() {
  if grep -qF -- "$2" "$OUT"; then
    pass "$1"
  else
    flunk "$1 (output lacks: $2)"
  fi
}

no_builds() {
  [[ "$(count_lines "$W/docker/builds")" == 0 && "$(count_lines "$W/docker/pushes")" == 0 ]]
}

only_inspects() {
  ! grep -qE '^(build|push) ' "$W/docker/log" 2>/dev/null
}

no_leases() {
  [[ -z "$(remote_leases)" ]]
}

# scratch_clean: the scratch root holds nothing but the empty release directory.
scratch_clean() {
  [[ -z "$(find "$W/tmp" -mindepth 1 ! -path "$W/tmp/release")" ]]
}

one_worktree() {
  [[ "$(g "$1" worktree list --porcelain | grep -c '^worktree ')" == 1 ]]
}

registry_revision() {
  if [[ -f "$W/docker/registry/$IMAGE_KEY" ]]; then
    cut -d' ' -f2 "$W/docker/registry/$IMAGE_KEY"
  fi
}

last_build() {
  tail -n 1 "$W/docker/builds" 2>/dev/null || true
}

lacks_commit() {
  ! g "$1" cat-file -e "$2^{commit}" 2>/dev/null
}

# changelog_promoted <sha>: Unreleased is empty and the notes sit under the new version.
changelog_promoted() {
  "$REAL_GIT" -C "$W/origin.git" show "$1:server/CHANGELOG.md" | tr '\n' '|' |
    grep -qE '## \[Unreleased\]\|\|## \[1\.0\.0\] - [0-9]{4}-[0-9]{2}-[0-9]{2}\|\|### Added\|\|- A health endpoint\.'
}

# expect_released <label> <clone>: the full outcome of a successful start of 1.0.0.
expect_released() {
  local label="$1" where="$2" tag_sha main_sha
  tag_sha="$(remote_ref "refs/tags/$TAG")"
  main_sha="$(remote_ref refs/heads/main)"
  expect "$label: tag on origin" test -n "$tag_sha"
  expect_eq "$label: origin main is the release commit" "$tag_sha" "$main_sha"
  expect_eq "$label: release commit sits on the old main" "$ORIG" "$("$REAL_GIT" -C "$W/origin.git" rev-parse "$tag_sha^")"
  expect_eq "$label: release commit changes only the named files" \
    "server/CHANGELOG.md server/package.json" \
    "$("$REAL_GIT" -C "$W/origin.git" diff-tree --no-commit-id --name-only -r "$tag_sha" | sort | tr '\n' ' ' | sed 's/ $//')"
  expect_eq "$label: version bumped" '  "version": "1.0.0",' \
    "$("$REAL_GIT" -C "$W/origin.git" show "$tag_sha:server/package.json" | grep '"version"')"
  expect "$label: changelog promoted under a fresh Unreleased" changelog_promoted "$tag_sha"
  expect_eq "$label: image carries the tag SHA" "$tag_sha" "$(registry_revision)"
  expect_eq "$label: built from the tag SHA in a detached worktree" \
    "tag=$IMAGE rev=$tag_sha head=$tag_sha version=1.0.0" "$(last_build)"
  expect "$label: no lease left" no_leases
  expect_eq "$label: no local tag created" "" "$(g "$where" tag -l)"
  expect "$label: build worktree removed" one_worktree "$where"
  expect "$label: scratch cleaned" scratch_clean
}

# fail_start <label> <fault>: a start that fails while publishing.
fail_start() {
  run_release a "$1" SHIM_FAULTS="$2" -- server --version 1.0.0
}

# ---------------------------------------------------------------------------
# Cases

case_preview_start() {
  world preview-start
  local before
  before="$(snapshot a)"
  run_release a preview -- server --preview --version 1.0.0
  expect_rc_zero "preview start"
  expect_out "preview says nothing changed" "Preview only: nothing was changed."
  expect_out "preview lists the notes" "- A health endpoint."
  expect_eq "preview: no files, refs, commits, or images changed" "$before" "$(snapshot a)"
  expect "preview: docker only inspected" only_inspects
  expect_eq "preview: no push attempted" 0 "$(count_lines "$W/state/push.log")"
}

case_start_success() {
  world start
  run_release a start -- server --version 1.0.0
  expect_rc_zero "start"
  expect_released "start" a
  expect_out "start reports that no local tag exists" "No local tag was created"
  expect_eq "start: docker build used --provenance=false --sbom=false" 1 \
    "$(grep -c -- '--provenance=false --sbom=false' "$W/docker/log")"
  expect_eq "start: gh never called" 0 "$(count_lines "$W/gh.log")"
}

case_version_rules() {
  world versions
  local before v
  before="$(snapshot a)"
  for v in 0.1.0 0.0.9 1.0 v1.0.0 01.0.0 1.0.0-rc.1 1.0.0+build; do
    run_release a "version-$v" -- server --version "$v"
    expect_rc_nonzero "version $v"
    if [[ "$v" == 0.1.0 ]]; then
      expect_out "an equal version names the current one" "not greater than the current server version 0.1.0"
    fi
  done
  run_release a version-missing -- server
  expect_eq "missing version without a terminal: exit 2" 2 "$RC"
  expect_out "missing version asks for --version" "pass --version X.Y.Z"
  expect_eq "version refusals change nothing" "$before" "$(snapshot a)"
}

case_start_preflight() {
  world preflight
  printf 'x\n' >>"$W/a/server/CHANGELOG.md"
  run_release a dirty -- server --version 1.0.0
  expect_rc_nonzero "start with a modified file"
  expect_out "dirty tree is named" "the working tree is not clean"
  g a checkout -q -- server/CHANGELOG.md

  printf 'x\n' >"$W/a/untracked.txt"
  run_release a untracked -- server --version 1.0.0
  expect_rc_nonzero "start with an untracked file"
  rm -f "$W/a/untracked.txt"

  g a checkout -q -b topic
  run_release a branch -- server --version 1.0.0
  expect_rc_nonzero "start off main"
  expect_out "branch is named" "the current branch is topic"
  g a checkout -q main

  clone c
  commit_on c "Move main"
  g c push -q origin main
  run_release a behind -- server --version 1.0.0
  expect_rc_nonzero "start behind origin"
  expect_out "behind is explained" "is not the same as origin/main"

  g a pull -q --ff-only
  printf '# Changelog\n\n## [Unreleased]\n\n## [0.1.0] - 2026-10-01\n' >"$W/a/server/CHANGELOG.md"
  g a commit -q -am "Empty notes"
  g a push -q origin main
  run_release a empty-notes -- server --version 1.0.0
  expect_rc_nonzero "start with an empty Unreleased section"
  expect_out "empty notes are explained" "its Unreleased section is empty"

  expect "preflight refusals never take a lease" test ! -e "$W/state/push.log"
  expect "preflight refusals never build" no_builds
}

case_registry_checks() {
  world registry
  local before
  before="$(snapshot a)"
  run_release a denied SHIM_FAULTS=registry-denied -- server --version 1.0.0
  expect_eq "unreadable registry: exit 2" 2 "$RC"
  expect_out "unreadable registry asks for a login" "docker login ghcr.io"
  expect_eq "unreadable registry changes nothing" "$before" "$(snapshot a)"
  mkdir -p "$W/docker/registry"
  printf 'sha256:%064d other\n' 0 >"$W/docker/registry/$IMAGE_KEY"
  before="$(snapshot a)"
  run_release a exists -- server --version 1.0.0
  expect_rc_nonzero "existing image version"
  expect_out "existing image is never overwritten" "already exists; a published version is never overwritten"
  expect_eq "registry refusals change nothing" "$before" "$(snapshot a)"
}

case_agent_signing() {
  world agent
  local before
  before="$(snapshot a)"
  run_release a agent-start -- agent --version 0.2.0
  expect_rc_nonzero "agent start"
  expect_out "agent refusal names signing" "code signing is not set up"
  run_release a agent-preview -- agent --preview --version 0.2.0
  expect_rc_nonzero "agent preview"
  run_release a agent-resume -- agent --resume 0.1.0
  expect_rc_nonzero "agent resume"
  run_release a agent-noversion -- agent
  expect_rc_nonzero "agent without a version is refused before any prompt"
  expect_out "agent without a version names signing" "code signing is not set up"
  expect_eq "agent refusal changes nothing" "$before" "$(snapshot a)"
  expect_eq "agent refusal calls no docker" 0 "$(count_lines "$W/docker/log")"
  expect_eq "agent refusal calls no gh" 0 "$(count_lines "$W/gh.log")"
  expect_eq "agent refusal pushes nothing" 0 "$(count_lines "$W/state/push.log")"
}

case_concurrent_starts() {
  world concurrent
  clone b
  local pid_a pid_b rc_a rc_b winner loser
  spawn_release a race-a SHIM_LEASE_BARRIER="$W/barrier" SHIM_NAME=a -- server --version 1.0.0
  pid_a=$LAST_PID
  spawn_release b race-b SHIM_LEASE_BARRIER="$W/barrier" SHIM_NAME=b -- server --version 1.0.0
  pid_b=$LAST_PID
  if wait_file "$W/barrier/a.ready" && wait_file "$W/barrier/b.ready"; then
    pass "both starts passed preflight and reached the lease push"
  else
    flunk "both starts reached the lease push"
  fi
  : >"$W/barrier/go"
  wait_exit "$pid_a" || true
  rc_a=$RC
  wait_exit "$pid_b" || true
  rc_b=$RC
  if ((rc_a == 0 && rc_b != 0)); then
    winner=a loser=b
  elif ((rc_b == 0 && rc_a != 0)); then
    winner=b loser=a
  else
    OUT="$W/race-a.out"
    flunk "exactly one concurrent start succeeds (a=$rc_a b=$rc_b)"
    return
  fi
  pass "exactly one concurrent start succeeds ($winner)"
  OUT="$W/race-$loser.out"
  expect_out "loser reports the held lease" "another release run holds the publish lease refs/release-leases/active"
  expect_out "loser shows the owner" "owner: "
  expect_out "loser shows the start time" "started: "
  expect_eq "loser made no release commit" "$ORIG" "$(g "$loser" rev-parse HEAD)"
  expect_eq "loser tree is clean" "" "$(g "$loser" status --porcelain)"
  expect_eq "one build in total" 1 "$(count_lines "$W/docker/builds")"
  expect_eq "origin main is the winner's release commit" "$(g "$winner" rev-parse HEAD)" "$(remote_ref refs/heads/main)"
  expect "no lease left after the race" no_leases
}

case_start_vs_resume() {
  world start-vs-resume
  clone b
  local pid before_b
  spawn_release a held SHIM_BUILD_BARRIER="$W/barrier" -- server --version 1.0.0
  pid=$LAST_PID
  expect "start is publishing while holding the lease" wait_file "$W/barrier/build.ready"
  before_b="$(snapshot b)"
  run_release b resume-blocked -- server --resume 1.0.0
  expect_rc_nonzero "resume from another clone while the start holds the lease"
  expect_out "blocked resume shows the owner" "owner: "
  expect_out "blocked resume shows the start time" "started: "
  expect_out "blocked resume prints the manual recovery" "git push --porcelain --force-with-lease=refs/release-leases/active:"
  expect_out "blocked resume shows the leased tag" "tag: $TAG"
  expect_eq "blocked resume changed nothing" "$before_b" "$(snapshot b)"
  : >"$W/barrier/go"
  wait_exit "$pid" || true
  OUT="$W/held.out"
  expect_rc_zero "start finishes after the blocked resume"
  local tag_sha
  tag_sha="$(remote_ref "refs/tags/$TAG")"
  expect "other clone lacks the tagged commit" lacks_commit b "$tag_sha"
  run_release b resume-after -- server --resume 1.0.0
  expect_rc_nonzero "resume after the start finished does not claim success"
  expect_out "resume cannot verify the existing image" "already exists; this run cannot verify its content"
  expect_eq "resume built nothing" 1 "$(count_lines "$W/docker/builds")"
  expect "resume fetched the missing tagged commit" g b cat-file -e "$tag_sha^{commit}"
  expect_eq "resume created no local tag" "" "$(g b tag -l)"
  expect_eq "resume left HEAD alone" "$ORIG" "$(g b rev-parse HEAD)"
}

case_tag_equal() {
  world tag-equal
  cat >"$W/hook.sh" <<EOF
#!/usr/bin/env bash
"$REAL_GIT" -C "\$1" push -q origin "HEAD:refs/tags/$TAG"
EOF
  chmod +x "$W/hook.sh"
  run_release a tag-equal SHIM_BEFORE_RESERVE="$W/hook.sh" -- server --version 1.0.0
  expect_rc_nonzero "reservation where the tag already exists (=)"
  expect_out "the existing tag is reported" "it already existed on origin"
  expect_out "recovery says this run published nothing" "This run published nothing"
  expect "no build after '='" no_builds
  expect "lease released after '='" no_leases
}

case_rejected_reservation() {
  world rejected
  clone c
  commit_on c "Concurrent change"
  cat >"$W/hook.sh" <<EOF
#!/usr/bin/env bash
"$REAL_GIT" -C "$W/c" push -q origin main
EOF
  chmod +x "$W/hook.sh"
  run_release a rejected SHIM_BEFORE_RESERVE="$W/hook.sh" -- server --version 1.0.0
  expect_rc_nonzero "rejected reservation"
  expect_out "rejection is reported" "origin rejected the reservation"
  expect_out "recovery command is printed" "git reset --keep $ORIG"
  expect "lease released after the rejection" no_leases
  expect_eq "no tag on origin" "" "$(remote_ref "refs/tags/$TAG")"
  expect_eq "origin main is the concurrent change" "$(g c rev-parse HEAD)" "$(remote_ref refs/heads/main)"
  expect_eq "local release commit kept on the old main" "$ORIG" "$(g a rev-parse HEAD^)"
  expect_eq "local tree clean" "" "$(g a status --porcelain)"
  expect "nothing built" no_builds
}

case_lost_reservation_response() {
  world lost-reservation
  run_release a lost SHIM_FAULTS=reserve-lost -- server --version 1.0.0
  expect_rc_zero "lost reservation response"
  expect_out "origin decided" "The reservation push gave no clear answer"
  expect_released "lost reservation response" a
}

case_lost_lease_response() {
  world lost-lease
  run_release a lost SHIM_FAULTS=lease-lost -- server --version 1.0.0
  expect_rc_zero "lost lease response"
  expect_out "origin shows the lease" "Origin shows our lease; continuing."
  expect_released "lost lease response" a
}

case_lost_lease_origin_down() {
  world lost-lease-down
  run_release a lost-down SHIM_FAULTS=lease-lost-down -- server --version 1.0.0
  expect_rc_nonzero "lost lease response with origin unreadable"
  expect_out "ownership unknown is reported" "lease ownership is unknown"
  local lease cmd
  lease="$(remote_leases)"
  expect "lease left in place" test -n "$lease"
  expect_out "printed recovery names the lease SHA" "${lease%% *}"
  expect_eq "no release commit" "$ORIG" "$(g a rev-parse HEAD)"
  cmd="$(last_delete_command)"
  rm -f "$W/state/remote-down"
  (cd "$W/a" && eval "$cmd") >/dev/null 2>&1 || true
  expect "printed command deletes the lease" no_leases
}

case_crash_holding_lease() {
  world crash
  local pid shim_pid lease cmd before
  spawn_release a crash SHIM_BUILD_BARRIER="$W/barrier" -- server --version 1.0.0
  pid=$LAST_PID
  wait_file "$W/barrier/build.ready" || true
  shim_pid="$(cat "$W/barrier/build.ready" 2>/dev/null || true)"
  kill -9 "$pid" 2>/dev/null || true
  [[ -n "$shim_pid" ]] && kill -9 "$shim_pid" 2>/dev/null || true
  wait_exit "$pid" || true
  expect_eq "crashed run was killed" 137 "$RC"
  lease="$(remote_leases)"
  expect "crash leaves the lease" test -n "$lease"

  before="$(snapshot a)"
  run_release a after-crash-preview -- server --preview --resume 1.0.0
  expect_rc_nonzero "preview refuses while the lease exists"
  expect_out "preview shows the owner host" "host: "
  expect_eq "refusing preview changes nothing" "$before" "$(snapshot a)"

  run_release a after-crash -- server --resume 1.0.0
  expect_rc_nonzero "resume refuses while the crashed lease exists"
  expect_out "refusal shows the owner" "owner: "
  expect_out "refusal shows the start time" "started: "
  expect_out "refusal explains the manual recovery" "confirm that no"
  expect_eq "refusal leaves the lease untouched" "$lease" "$(remote_leases)"
  cmd="$(last_delete_command)"
  (cd "$W/a" && eval "$cmd") >/dev/null 2>&1 || true
  expect "printed recovery command deletes the lease" no_leases
  run_release a recovered -- server --resume 1.0.0
  expect_rc_zero "resume after the manual recovery"
  expect_eq "recovered resume publishes the tag SHA" "$(remote_ref "refs/tags/$TAG")" "$(registry_revision)"
}

case_interrupt_waits_for_child() {
  world interrupt
  local pid
  spawn_release a interrupted SHIM_BUILD_BARRIER="$W/barrier" -- server --version 1.0.0
  pid=$LAST_PID
  wait_file "$W/barrier/build.ready" || true
  kill -TERM "$pid"
  sleep 2
  expect "interrupted run waits for the running build" kill -0 "$pid"
  expect "lease kept while the build still runs" test -n "$(remote_leases)"
  : >"$W/barrier/go"
  wait_exit "$pid" || true
  OUT="$W/interrupted.out"
  expect_eq "interrupted run exits 143" 143 "$RC"
  expect_out "the wait is reported" "Waiting for publishing process"
  expect "lease released after the child ended" no_leases
  expect_out "resume is suggested after the interrupt" "scripts/release.sh server --resume 1.0.0"
  expect "nothing pushed after the interrupt" test ! -e "$W/docker/pushes"
  expect "build worktree removed after the interrupt" one_worktree a
}

case_failed_lease_release() {
  world release-fail
  run_release a release-fail SHIM_FAULTS=release-fail -- server --version 1.0.0
  expect_rc_nonzero "failed lease release"
  expect_out "failure is reported" "could not delete the publish lease"
  local lease cmd
  lease="$(remote_leases)"
  expect "lease still on origin" test -n "$lease"
  expect_out "lease SHA is printed" "${lease%% *}"
  expect_eq "publishing itself finished" "$(remote_ref "refs/tags/$TAG")" "$(registry_revision)"
  cmd="$(last_delete_command)"
  (cd "$W/a" && eval "$cmd") >/dev/null 2>&1 || true
  expect "printed command deletes the lease" no_leases
}

# A failure at each publishing step, then a resume.
case_publish_failures() {
  local fault tag_sha
  for fault in build-fail push-fail push-lost remote-digest-mismatch; do
    world "publish-$fault"
    fail_start "$fault" "$fault"
    expect_rc_nonzero "$fault"
    expect_out "$fault: resume is suggested" "scripts/release.sh server --resume 1.0.0"
    expect "$fault: lease released" no_leases
    tag_sha="$(remote_ref "refs/tags/$TAG")"
    expect "$fault: tag stays reserved" test -n "$tag_sha"
    expect "$fault: build worktree removed" one_worktree a
    expect "$fault: scratch cleaned" scratch_clean
    expect_eq "$fault: still no local tag" "" "$(g a tag -l)"
    run_release a "resume-$fault" -- server --resume 1.0.0
    expect_eq "$fault: registry has the tag SHA" "$tag_sha" "$(registry_revision)"
    case "$fault" in
      push-lost | remote-digest-mismatch)
        # The image already exists: the label alone is not accepted as proof.
        expect_rc_nonzero "$fault: resume over the pushed image"
        expect_out "$fault: resume asks for a manual check" "this run cannot verify its content"
        expect_eq "$fault: resume built nothing" 1 "$(count_lines "$W/docker/builds")"
        ;;
      *)
        expect_rc_zero "$fault: resume"
        expect_eq "$fault: resume built from the tag SHA" \
          "tag=$IMAGE rev=$tag_sha head=$tag_sha version=1.0.0" "$(last_build)"
        ;;
    esac
    expect "$fault: no lease after resume" no_leases
  done
  OUT="$W/remote-digest-mismatch.out"
  expect_out "digest mismatch is reported" "differs from the locally built digest"
}

case_resume_mismatched_artifact() {
  world mismatch
  fail_start start build-fail
  printf 'sha256:%064d %040d\n' 1 1 >"$W/docker/registry/$IMAGE_KEY"
  local before
  before="$(cat "$W/docker/registry/$IMAGE_KEY")"
  run_release a resume -- server --resume 1.0.0
  expect_rc_nonzero "resume over an image with another revision"
  expect_out "mismatch is never overwritten" "was not built from"
  expect_eq "registry unchanged" "$before" "$(cat "$W/docker/registry/$IMAGE_KEY")"
  expect "lease released" no_leases
}

case_resume_main_moved() {
  world main-moved
  fail_start start build-fail
  local tag_sha moved
  tag_sha="$(remote_ref "refs/tags/$TAG")"
  clone c
  commit_on c "Later work"
  g c push -q origin main
  g a pull -q --ff-only
  moved="$(g a rev-parse HEAD)"
  expect "local main moved past the tag" test "$moved" != "$tag_sha"
  run_release a resume -- server --resume 1.0.0
  expect_rc_zero "resume after main moved on"
  expect_eq "built from the tag SHA, not main" \
    "tag=$IMAGE rev=$tag_sha head=$tag_sha version=1.0.0" "$(last_build)"
  expect_eq "resume did not touch origin main" "$moved" "$(remote_ref refs/heads/main)"
  expect_eq "resume did not touch local HEAD" "$moved" "$(g a rev-parse HEAD)"
}

case_resume_commit_missing() {
  world commit-missing
  clone b
  fail_start start build-fail
  local tag_sha
  tag_sha="$(remote_ref "refs/tags/$TAG")"
  expect "clone b lacks the tagged commit" lacks_commit b "$tag_sha"
  run_release b resume -- server --resume 1.0.0
  expect_rc_zero "resume with the tagged commit missing locally"
  expect_out "the commit is fetched" "Fetching the tagged commit $tag_sha."
  expect_eq "built from the fetched tag SHA" \
    "tag=$IMAGE rev=$tag_sha head=$tag_sha version=1.0.0" "$(last_build)"
  expect_eq "no local tag in b" "" "$(g b tag -l)"
  expect_eq "b HEAD unchanged" "$ORIG" "$(g b rev-parse HEAD)"
}

case_resume_dirty_and_preview() {
  world resume-dirty
  fail_start start build-fail
  local before pushes
  pushes="$(count_lines "$W/state/push.log")"
  before="$(snapshot a)"
  run_release a preview-resume -- server --preview --resume 1.0.0
  expect_rc_zero "preview resume"
  expect_out "preview resume reports the missing image" "$IMAGE: absent"
  expect_eq "preview resume changes nothing" "$before" "$(snapshot a)"

  printf 'local edit\n' >>"$W/a/server/CHANGELOG.md"
  before="$(snapshot a)"
  run_release a dirty-resume -- server --resume 1.0.0
  expect_rc_nonzero "resume with an uncommitted change"
  expect_out "dirty tree is named" "the working tree is not clean"
  expect_eq "dirty resume changes nothing" "$before" "$(snapshot a)"
  expect_eq "dirty resume pushes nothing" "$pushes" "$(count_lines "$W/state/push.log")"

  g a checkout -q -- server/CHANGELOG.md
  run_release a no-tag -- server --resume 2.0.0
  expect_rc_nonzero "resume of a version that was never tagged"
  expect_out "missing tag is explained" "there is nothing to resume"
}

# R1: starts for different versions in the same checkout share one lease, so
# only one of them edits, commits, and reserves.
case_concurrent_starts_different_versions() {
  world concurrent-versions
  local pid_one pid_two rc_one rc_two loser winner_tag loser_tag
  spawn_release a versions-one SHIM_LEASE_BARRIER="$W/barrier" SHIM_NAME=one -- server --version 1.0.0
  pid_one=$LAST_PID
  spawn_release a versions-two SHIM_LEASE_BARRIER="$W/barrier" SHIM_NAME=two -- server --version 1.1.0
  pid_two=$LAST_PID
  if wait_file "$W/barrier/one.ready" && wait_file "$W/barrier/two.ready"; then
    pass "both versions passed preflight and reached the lease push"
  else
    flunk "both versions reached the lease push"
  fi
  : >"$W/barrier/go"
  wait_exit "$pid_one" || true
  rc_one=$RC
  wait_exit "$pid_two" || true
  rc_two=$RC
  if ((rc_one == 0 && rc_two != 0)); then
    loser=two winner_tag=server-v1.0.0 loser_tag=server-v1.1.0
  elif ((rc_two == 0 && rc_one != 0)); then
    loser=one winner_tag=server-v1.1.0 loser_tag=server-v1.0.0
  else
    OUT="$W/versions-one.out"
    flunk "exactly one start of two versions proceeds (1.0.0=$rc_one 1.1.0=$rc_two)"
    return
  fi
  pass "exactly one start of two versions proceeds"
  OUT="$W/versions-$loser.out"
  expect_out "the other version is refused at the lease" "another release run holds the publish lease refs/release-leases/active"
  expect_out "the refusal names the leased tag" "tag: $winner_tag"
  expect_no_out "the refused version never acquired a lease" "Acquired refs/release-leases/"
  expect_no_out "the refused version never edited or committed" "release edits"
  expect_no_out "the refused version never committed" "Created the local release commit"
  expect_eq "origin main has exactly one release commit" "$ORIG" "$(remote_ref refs/heads/main^)"
  expect_eq "local main is that release commit" "$(remote_ref refs/heads/main)" "$(g a rev-parse HEAD)"
  expect_eq "the winner's tag is on that commit" "$(remote_ref refs/heads/main)" "$(remote_ref "refs/tags/$winner_tag")"
  expect_eq "the refused version has no tag" "" "$(remote_ref "refs/tags/$loser_tag")"
  expect_eq "local tree clean" "" "$(g a status --porcelain)"
  expect_eq "one build in total" 1 "$(count_lines "$W/docker/builds")"
  expect "no lease left" no_leases
}

# R2: TERM after origin accepted the reservation, before the script read the result.
case_interrupt_after_reservation_accepted() {
  local variant pid tag_sha
  for variant in readable unreadable; do
    world "interrupt-reservation-$variant"
    local faults=""
    [[ "$variant" == unreadable ]] && faults=down-after-reserve
    spawn_release a interrupted SHIM_RESERVE_BARRIER="$W/barrier" SHIM_FAULTS="$faults" -- server --version 1.0.0
    pid=$LAST_PID
    wait_file "$W/barrier/reserve.ready" || true
    tag_sha="$(remote_ref "refs/tags/$TAG")"
    expect "$variant: origin accepted the reservation" test -n "$tag_sha"
    kill -TERM "$pid"
    sleep 1
    : >"$W/barrier/go"
    wait_exit "$pid" || true
    OUT="$W/interrupted.out"
    expect_eq "$variant: interrupted run exits 143" 143 "$RC"
    expect_eq "$variant: the tag is on the local release commit" "$tag_sha" "$(g a rev-parse HEAD)"
    expect "$variant: nothing built" no_builds
    if [[ "$variant" == readable ]]; then
      expect_out "$variant: origin decides the result" "the reservation happened"
      expect_no_out "$variant: no advice to discard the published commit" "git reset --keep"
      expect_out "$variant: resume is suggested" "scripts/release.sh server --resume 1.0.0"
      expect "$variant: lease released" no_leases
    else
      expect_out "$variant: the result is reported as unknown" "The reservation result is unknown"
      expect_out "$variant: the reserved check is printed" "the reservation happened: run"
      expect_out "$variant: the not-reserved check is printed" "is absent, the reservation did not happen"
    fi
  done
}

# R3: a resume over an existing image with the right label still fails,
# because the label does not prove the content.
case_resume_does_not_trust_label() {
  world resume-label
  fail_start start remote-digest-mismatch
  expect_rc_nonzero "start with a digest mismatch"
  local tag_sha registry_before digest
  tag_sha="$(remote_ref "refs/tags/$TAG")"
  registry_before="$(cat "$W/docker/registry/$IMAGE_KEY")"
  digest="${registry_before%% *}"
  run_release a resume -- server --resume 1.0.0
  expect_rc_nonzero "resume over an image whose label matches"
  expect_out "resume says the content cannot be verified" "this run cannot verify its content"
  expect_out "resume prints the registry digest" "registry digest: $digest"
  expect_out "resume prints the revision label" "org.opencontainers.image.revision: $tag_sha"
  expect_no_out "resume does not claim the release is done" "Released server 1.0.0"
  expect_no_out "resume does not suggest resuming again" "After fixing the cause, run:"
  expect_eq "resume built nothing" 1 "$(count_lines "$W/docker/builds")"
  expect_eq "registry unchanged" "$registry_before" "$(cat "$W/docker/registry/$IMAGE_KEY")"
  expect "lease released" no_leases
}

case_preview_start
case_start_success
case_version_rules
case_start_preflight
case_registry_checks
case_agent_signing
case_concurrent_starts
case_start_vs_resume
case_tag_equal
case_rejected_reservation
case_lost_reservation_response
case_lost_lease_response
case_lost_lease_origin_down
case_crash_holding_lease
case_interrupt_waits_for_child
case_failed_lease_release
case_publish_failures
case_resume_mismatched_artifact
case_resume_main_moved
case_resume_commit_missing
case_resume_dirty_and_preview
case_concurrent_starts_different_versions
case_interrupt_after_reservation_accepted
case_resume_does_not_trust_label

printf 'release tests: %d failure(s) in %ds\n' "$failures" "$((SECONDS - started_at))" >&2
((failures == 0))
