#!/usr/bin/env bash
# Tests for scripts/release.sh. A local bare repository stands in for origin,
# so push semantics (porcelain status, --force-with-lease) are real Git. Each
# clone names origin by its GitHub URL and reaches the bare repository through
# a url.<path>.insteadOf rewrite, so the script derives owner/name as it does
# for real. docker, gh, and date are PATH shims; gh serves pull requests,
# workflow runs, and jobs from fixture files the test controls. A git wrapper
# passes every call through to the real git and only injects the faults a test
# names: lost push responses, an unreadable origin, a failed lease release,
# hooks before a push, and barriers that hold a run at a chosen point.
#
# RELEASE_TEST_CASES="case_a case_b" runs only the named cases.
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
REAL_DATE="$(command -v date)"
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
[gc]
	auto = 0
EOF
export GIT_CONFIG_GLOBAL="$SCRATCH/gitconfig"
export GIT_CONFIG_NOSYSTEM=1
export GIT_TERMINAL_PROMPT=0

REPO=ShlomiPorush/mashkif
GH_URL="https://github.com/$REPO.git"
TAG=server-v1.0.0
BRANCH=release/server-v1.0.0
IMAGE=ghcr.io/shlomiporush/mashkif:1.0.0
IMAGE_KEY="ghcr.io_shlomiporush_mashkif_1.0.0"
TODAY=2026-11-01

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
    *" :refs/release-leases/"*) kind=lease-release ;;
    *" --force-with-lease=refs/release-leases/"*) kind=lease-acquire ;;
    *":refs/tags/"*) kind=reserve ;;
    *":refs/heads/release/"*) kind=branch ;;
  esac
  printf '%s\n' "$kind" >>"$state/push.log"
  case "$kind" in
    lease-acquire)
      if [[ -n "${SHIM_BEFORE_LEASE:-}" ]]; then
        "$SHIM_BEFORE_LEASE" "$dir" || exit 1
      fi
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
      # The lease push succeeds, then origin becomes unreachable.
      if has_fault down-after-lease; then
        "$real" "$@"
        rc=$?
        : >"$state/remote-down"
        exit "$rc"
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
    branch)
      if [[ -n "${SHIM_BRANCH_BARRIER:-}" ]]; then
        barrier "$SHIM_BRANCH_BARRIER" "${SHIM_NAME:-branch}"
      fi
      # The push never reaches origin.
      if has_fault branch-fail; then
        echo "fatal: the remote end hung up unexpectedly (simulated)" >&2
        exit 128
      fi
      # Origin accepts the push, but the response is lost.
      if has_fault branch-lost; then
        "$real" "$@" >/dev/null 2>&1
        exit 1
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

# The gh shim serves the output of `gh api --jq` directly: tab-separated
# lines in the columns of the script's projections, which the shim checks
# verbatim, so a changed projection fails here until the shim follows it.
# Fixtures under SHIM_GH_DIR:
#   prs            number state merged_at merge_sha head_ref head_sha head_repo base_ref base_repo url
#   runs/<sha>     id attempt status conclusion head_sha event branch path repo (latest attempt)
#   jobs/<id>.<n>  name status conclusion
# Without --paginate only the first page (SHIM_GH_PAGE_SIZE lines) is returned.
cat >"$SHIMS/gh" <<'EOF'
#!/usr/bin/env bash
# Test stand-in for gh: pull requests, workflow runs, and jobs from fixture files.
source "$(dirname "${BASH_SOURCE[0]}")/barrier.sh"
d="${SHIM_GH_DIR:?}"
repo="${SHIM_GH_REPO:?}"
printf '%s\n' "$*" >>"${SHIM_GH_LOG:?}"
mkdir -p "$d/runs" "$d/jobs"
touch "$d/prs"
if has_fault gh-down; then
  echo "error connecting to api.github.com (simulated)" >&2
  exit 1
fi
PULLS_JQ='.[] | [.number, .state, (.merged_at // "-"), (.merge_commit_sha // "-"), .head.ref, .head.sha, (.head.repo.full_name // "-"), .base.ref, .base.repo.full_name, .html_url] | @tsv'
RUNS_JQ='.workflow_runs[] | [.id, .run_attempt, .status, (.conclusion // "-"), .head_sha, .event, .head_branch, .path, .repository.full_name] | @tsv'
JOBS_JQ='.jobs[] | [.name, .status, (.conclusion // "-")] | @tsv'
page_size="${SHIM_GH_PAGE_SIZE:-100}"
paginate=0
emit() {
  if ((paginate)); then cat; else head -n "$page_size"; fi
}
query() {
  local kv
  local IFS='&'
  for kv in $1; do
    if [[ "${kv%%=*}" == "$2" ]]; then
      printf '%s' "${kv#*=}"
      return
    fi
  done
}
need_jq() {
  if [[ "$jq" != "$1" ]]; then
    echo "gh shim: unexpected --jq for $endpoint: $jq" >&2
    exit 1
  fi
}
next_pr() {
  awk -F '\t' 'BEGIN { m = 0 } $1 + 0 > m { m = $1 + 0 } END { print m + 1 }' "$d/prs"
}
case "${1:-} ${2:-}" in
  api\ *)
    shift
    path="" jq=""
    while (($#)); do
      case "$1" in
        --paginate) paginate=1; shift ;;
        --jq) jq="$2"; shift 2 ;;
        -*) echo "gh shim: unexpected api option $1" >&2; exit 1 ;;
        *) path="$1"; shift ;;
      esac
    done
    endpoint="${path%%\?*}"
    q=""
    [[ "$path" == *\?* ]] && q="${path#*\?}"
    case "$endpoint" in
      "repos/$repo/pulls")
        need_jq "$PULLS_JQ"
        state="$(query "$q" state)" base="$(query "$q" base)" head="$(query "$q" head)"
        # GitHub also filters head by owner. The shim matches the branch name
        # only, so a fork case reaches the script's own repository check.
        awk -F '\t' -v state="$state" -v base="$base" -v branch="${head#*:}" '
          (state == "all" || $2 == state) && (base == "" || $8 == base) && (branch == "" || $5 == branch)
        ' "$d/prs" | emit
        ;;
      "repos/$repo/actions/workflows/ci.yml/runs")
        need_jq "$RUNS_JQ"
        sha="$(query "$q" head_sha)" event="$(query "$q" event)" branch="$(query "$q" branch)"
        # Not filtered by workflow path, so a run of another workflow file
        # reaches the script's own path check.
        if [[ -f "$d/runs/$sha" ]]; then
          awk -F '\t' -v event="$event" -v branch="$branch" '$6 == event && $7 == branch' "$d/runs/$sha" | emit
        fi
        ;;
      repos/"$repo"/actions/runs/*/attempts/*/jobs)
        need_jq "$JOBS_JQ"
        rest="${endpoint#repos/"$repo"/actions/runs/}"
        id="${rest%%/*}"
        attempt="${rest#*/attempts/}"
        attempt="${attempt%%/*}"
        if [[ -f "$d/jobs/$id.$attempt" ]]; then
          emit <"$d/jobs/$id.$attempt"
        fi
        ;;
      *)
        echo "gh: Not Found (HTTP 404): $endpoint" >&2
        exit 1
        ;;
    esac
    ;;
  "pr create")
    shift 2
    prrepo="" base="" head="" title="" body=""
    while (($#)); do
      case "$1" in
        --repo) prrepo="$2"; shift 2 ;;
        --base) base="$2"; shift 2 ;;
        --head) head="$2"; shift 2 ;;
        --title) title="$2"; shift 2 ;;
        --body-file) body="$2"; shift 2 ;;
        *) echo "gh shim: unexpected pr create argument $1" >&2; exit 1 ;;
      esac
    done
    if [[ "$prrepo" != "$repo" || -z "$base" || -z "$head" || -z "$title" || ! -f "$body" ]]; then
      echo "gh shim: incomplete pr create call" >&2
      exit 1
    fi
    if ! sha="$("$SHIM_REAL_GIT" -C "${SHIM_ORIGIN:?}" rev-parse -q --verify "refs/heads/$head")"; then
      echo "pull request create failed: GraphQL: Head sha can't be blank (createPullRequest)" >&2
      exit 1
    fi
    if awk -F '\t' -v b="$head" -v r="$repo" '$2 == "open" && $5 == b && $7 == r { f = 1 } END { exit !f }' "$d/prs"; then
      echo "a pull request for branch \"$head\" into branch \"$base\" already exists" >&2
      exit 1
    fi
    if has_fault pr-create-fail; then
      echo "pull request create failed: simulated" >&2
      exit 1
    fi
    n="$(next_pr)"
    url="https://github.com/$repo/pull/$n"
    printf '%s\topen\t-\t-\t%s\t%s\t%s\t%s\t%s\t%s\n' "$n" "$head" "$sha" "$repo" "$base" "$repo" "$url" >>"$d/prs"
    cp "$body" "$d/body.$n"
    printf '%s\n' "$title" >"$d/title.$n"
    # Created on GitHub, but the response is lost.
    if has_fault pr-create-lost; then
      exit 1
    fi
    printf '%s\n' "$url"
    ;;
  *)
    echo "gh shim: unexpected gh call: $*" >&2
    exit 1
    ;;
esac
EOF

cat >"$SHIMS/date" <<'EOF'
#!/usr/bin/env bash
# Test stand-in for date: SHIM_TODAY answers `date -u +%F`; everything else is real.
if [[ -n "${SHIM_TODAY:-}" && "$*" == "-u +%F" ]]; then
  printf '%s\n' "$SHIM_TODAY"
  exit 0
fi
exec "${SHIM_REAL_DATE:?}" "$@"
EOF
chmod +x "$SHIMS/git" "$SHIMS/docker" "$SHIMS/gh" "$SHIMS/date"

# ---------------------------------------------------------------------------
# Fixture: a repository with the release scripts, both components, and a
# Dockerfile, pushed to a bare origin. Each case copies a template.

TEMPLATE="$SCRATCH/template"
make_template() {
  local seed="$TEMPLATE/seed"
  mkdir -p "$seed/scripts/lib" "$seed/server" "$seed/agent" "$seed/config/docker" "$TEMPLATE/base/gh/runs" "$TEMPLATE/base/gh/jobs"
  : >"$TEMPLATE/base/gh/prs"
  "$REAL_GIT" init -q "$seed"
  cp "$MASHKIF_ROOT/scripts/release.sh" "$seed/scripts/"
  cp "$MASHKIF_ROOT/scripts/lib/common.sh" "$MASHKIF_ROOT"/scripts/lib/release-*.sh "$seed/scripts/lib/"
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
  "$REAL_GIT" init -q --bare "$TEMPLATE/base/origin.git"
  "$REAL_GIT" -C "$seed" push -q "$TEMPLATE/base/origin.git" main
  ORIG="$("$REAL_GIT" -C "$seed" rev-parse HEAD)"
}
ORIG=""
make_template

W=""
MAIN0=""
MERGE=""
# world <name> [base|merged]: a fresh origin and gh fixture from a template,
# clone a, and empty shim state. In the merged template the release pull
# request for 1.0.0 is merged (merge commit $MERGE) and CI passed for it.
world() {
  local variant="${2:-base}"
  W="$SCRATCH/$1"
  mkdir -p "$W/tmp" "$W/docker" "$W/state" "$W/barrier"
  cp -a "$TEMPLATE/$variant/origin.git" "$W/origin.git"
  cp -a "$TEMPLATE/$variant/gh" "$W/gh"
  MERGE="$(cat "$TEMPLATE/$variant/merge" 2>/dev/null || true)"
  clone a
  MAIN0="$(g a rev-parse HEAD)"
  printf '%s\n' "--- $1" >&2
}

# clone <name>: a clone whose origin is the GitHub URL, rewritten to the bare repository.
clone() {
  "$REAL_GIT" clone -q -c "url.$W/origin.git.insteadOf=$GH_URL" "$GH_URL" "$W/$1"
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

count_pushes() {
  if [[ -f "$W/state/push.log" ]]; then
    grep -cx "$1" "$W/state/push.log" || true
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

# push_main <message>: a new commit on origin main through clone m; prints its SHA.
push_main() {
  [[ -d "$W/m" ]] || clone m
  g m fetch -q origin
  g m checkout -q -B main origin/main
  commit_on m "$1"
  g m push -q origin main
  g m rev-parse HEAD
}

# ---------------------------------------------------------------------------
# gh fixtures

# pr_add <state> <merged_at> <merge_sha> <head_ref> <head_sha> <head_repo>
pr_add() {
  local n
  n="$(awk -F '\t' 'BEGIN { m = 0 } $1 + 0 > m { m = $1 + 0 } END { print m + 1 }' "$W/gh/prs")"
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\tmain\t%s\thttps://github.com/%s/pull/%s\n' \
    "$n" "$1" "$2" "$3" "$4" "$5" "$6" "$REPO" "$6" "$n" >>"$W/gh/prs"
}

# pr_set <awk condition> <awk assignments>: rewrites matching pull requests.
pr_set() {
  awk -F '\t' -v OFS='\t' "$1 { $2 } { print }" "$W/gh/prs" >"$W/gh/prs.new"
  mv "$W/gh/prs.new" "$W/gh/prs"
}

# pr_merge <branch> <merge_sha>: marks this repository's open pull request from <branch> merged.
pr_merge() {
  pr_set "\$2 == \"open\" && \$5 == \"$1\" && \$7 == \"$REPO\"" \
    "\$2 = \"closed\"; \$3 = \"${TODAY}T12:00:00Z\"; \$4 = \"$2\""
}

pr_lines() {
  grep -c . "$W/gh/prs" || true
}

# open_pr_head <branch>: the head SHA of this repository's open pull request from <branch>.
open_pr_head() {
  awk -F '\t' -v b="$1" -v r="$REPO" '$2 == "open" && $5 == b && $7 == r { print $6 }' "$W/gh/prs"
}

next_run_id() {
  local f="$W/gh/next-run" n
  n="$(cat "$f" 2>/dev/null || printf '5000')"
  printf '%s\n' "$((n + 1))" >"$f"
  printf '%s' "$n"
}

# ci_run <sha> <attempt> <status> <conclusion> [path]: adds a push run on main; prints its ID.
ci_run() {
  local id
  id="$(next_run_id)"
  printf '%s\t%s\t%s\t%s\t%s\tpush\tmain\t%s\t%s\n' \
    "$id" "$2" "$3" "$4" "$1" "${5:-.github/workflows/ci.yml}" "$REPO" >>"$W/gh/runs/$1"
  printf '%s' "$id"
}

# ci_jobs <id> <attempt> <summary status|none> [summary conclusion]
ci_jobs() {
  {
    printf 'detect\tcompleted\tsuccess\n'
    [[ "$3" == none ]] || printf 'summary\t%s\t%s\n' "$3" "$4"
  } >"$W/gh/jobs/$1.$2"
}

ci_green() {
  local id
  id="$(ci_run "$1" 1 completed success)"
  ci_jobs "$id" 1 completed success
}

ci_clear() {
  rm -f "$W/gh/runs/$1"
}

# merge_release <version>: merges this repository's open release pull request
# on origin with a merge commit, marks it merged, and records green CI. Sets MERGE.
merge_release() {
  local branch="release/server-v$1"
  [[ -d "$W/m" ]] || clone m
  g m fetch -q origin
  g m checkout -q -B main origin/main
  g m merge -q --no-ff -m "Merge pull request from $branch" "origin/$branch"
  g m push -q origin main
  MERGE="$(g m rev-parse HEAD)"
  pr_merge "$branch" "$MERGE"
  ci_green "$MERGE"
}

# ---------------------------------------------------------------------------
# Running the script

RC=0
OUT=""
run_env() {
  env PATH="$SHIMS:$PATH" MASHKIF_TMP_DIR="$W/tmp" SHIM_REAL_GIT="$REAL_GIT" SHIM_REAL_DATE="$REAL_DATE" \
    SHIM_STATE="$W/state" SHIM_DOCKER_DIR="$W/docker" SHIM_GH_LOG="$W/gh.log" SHIM_GH_DIR="$W/gh" \
    SHIM_GH_REPO="$REPO" SHIM_ORIGIN="$W/origin.git" SHIM_TODAY="$TODAY" XDG_STATE_HOME="$W/state-home" \
    "$@"
}

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
      run_env "${vars[@]}" bash scripts/release.sh "$@"
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
      exec env PATH="$SHIMS:$PATH" MASHKIF_TMP_DIR="$W/tmp" SHIM_REAL_GIT="$REAL_GIT" SHIM_REAL_DATE="$REAL_DATE" \
        SHIM_STATE="$W/state" SHIM_DOCKER_DIR="$W/docker" SHIM_GH_LOG="$W/gh.log" SHIM_GH_DIR="$W/gh" \
        SHIM_GH_REPO="$REPO" SHIM_ORIGIN="$W/origin.git" SHIM_TODAY="$TODAY" XDG_STATE_HOME="$W/state-home" \
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

# snapshot <clone>: every file of the clone and of origin, the gh fixtures,
# the shim registry and images, and the scratch directory. The gh call log is
# not included; cases check it separately.
snapshot() {
  (cd "$W/$1" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum)
  (cd "$W/origin.git" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum)
  (cd "$W/gh" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 -r sha256sum)
  (cd "$W/docker" && find . -type f ! -name log -print0 | LC_ALL=C sort -z | xargs -0 -r sha256sum)
  find "$W/tmp" -mindepth 1 | LC_ALL=C sort
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

gh_only_reads() {
  ! grep -qvE '^api ' "$W/gh.log" 2>/dev/null
}

# expect_published <label> <clone> <source>: the full outcome of a successful
# publish of 1.0.0 from <source>.
expect_published() {
  local label="$1" where="$2" source="$3" head_before
  expect_eq "$label: tag on origin at the source commit" "$source" "$(remote_ref "refs/tags/$TAG")"
  expect_eq "$label: image carries the source SHA" "$source" "$(registry_revision)"
  expect_eq "$label: built from the source SHA in a detached worktree" \
    "tag=$IMAGE rev=$source head=$source version=1.0.0" "$(last_build)"
  expect "$label: no lease left" no_leases
  expect_eq "$label: no local tag created" "" "$(g "$where" tag -l)"
  expect "$label: build worktree removed" one_worktree "$where"
  expect "$label: scratch cleaned" scratch_clean
  expect "$label: gh only read" gh_only_reads
  head_before="$(g "$where" rev-parse HEAD)"
  expect_eq "$label: origin main untouched" "$head_before" "$(remote_ref refs/heads/main)"
}

# expect_prepared <label> <base> <date>: the release branch holds one commit on
# <base> with the expected change, and this repository's pull request is open.
expect_prepared() {
  local label="$1" base="$2" date="$3" tip
  tip="$(remote_ref "refs/heads/$BRANCH")"
  expect "$label: release branch on origin" test -n "$tip"
  expect_eq "$label: one commit on the base" "$base" "$("$REAL_GIT" -C "$W/origin.git" rev-parse "$tip^")"
  expect_eq "$label: the commit changes only the version file and the changelog" \
    "server/CHANGELOG.md server/package.json" \
    "$("$REAL_GIT" -C "$W/origin.git" diff-tree --no-commit-id --name-only -r "$tip" | sort | tr '\n' ' ' | sed 's/ $//')"
  expect_eq "$label: version set" '  "version": "1.0.0",' \
    "$("$REAL_GIT" -C "$W/origin.git" show "$tip:server/package.json" | grep '"version"')"
  expect "$label: changelog promoted under a fresh Unreleased on $date" changelog_promoted "$tip" "$date"
  expect_eq "$label: the open pull request is at the release commit" "$tip" "$(open_pr_head "$BRANCH")"
  expect_eq "$label: origin main untouched" "$base" "$(remote_ref refs/heads/main)"
  expect_eq "$label: no tag" "" "$(remote_ref "refs/tags/$TAG")"
  expect "$label: no lease" no_leases
  expect "$label: scratch cleaned" scratch_clean
  expect "$label: prepare worktree removed" one_worktree a
}

# changelog_promoted <sha> <date>: Unreleased is empty and the notes sit under the new version.
changelog_promoted() {
  "$REAL_GIT" -C "$W/origin.git" show "$1:server/CHANGELOG.md" | tr '\n' '|' |
    grep -qF "## [Unreleased]||## [1.0.0] - $2||### Added||- A health endpoint."
}

# ---------------------------------------------------------------------------
# The merged template: prepare 1.0.0, merge its pull request, CI green.

make_merged_template() {
  world template-merged
  run_release a prepare -- server prepare --version 1.0.0
  if ((RC != 0)); then
    sed 's/^/  | /' "$OUT" >&2
    printf 'release tests: could not build the merged template\n' >&2
    exit 2
  fi
  merge_release 1.0.0
  mkdir -p "$TEMPLATE/merged"
  cp -a "$W/origin.git" "$TEMPLATE/merged/origin.git"
  cp -a "$W/gh" "$TEMPLATE/merged/gh"
  printf '%s\n' "$MERGE" >"$TEMPLATE/merged/merge"
}
make_merged_template

publish() {
  run_release "$1" "$2" "${@:3}" -- server publish --version 1.0.0
}

# fail_publish <label> <fault>: a publish that fails while publishing.
fail_publish() {
  run_release a "$1" SHIM_FAULTS="$2" -- server publish --version 1.0.0
}

# ---------------------------------------------------------------------------
# Cases: command line

case_usage() {
  world usage
  local before
  before="$(snapshot a)"
  run_release a no-command -- server --version 1.0.0
  expect_eq "no command: exit 2" 2 "$RC"
  expect_out "no command names the commands" "a command is required: prepare or publish"
  run_release a prepare-resume -- server prepare --resume 1.0.0
  expect_eq "prepare with --resume: exit 2" 2 "$RC"
  run_release a both -- server publish --version 1.0.0 --resume 1.0.0
  expect_eq "--version with --resume: exit 2" 2 "$RC"
  expect_eq "usage errors change nothing" "$before" "$(snapshot a)"
  expect_eq "usage errors call no gh" 0 "$(count_lines "$W/gh.log")"
}

case_agent_signing() {
  world agent
  local before
  before="$(snapshot a)"
  run_release a agent-prepare -- agent prepare --version 0.2.0
  expect_rc_nonzero "agent prepare"
  expect_out "agent refusal names signing" "code signing is not set up"
  run_release a agent-prepare-preview -- agent prepare --preview --version 0.2.0
  expect_rc_nonzero "agent prepare preview"
  run_release a agent-publish -- agent publish --version 0.2.0
  expect_rc_nonzero "agent publish"
  run_release a agent-resume -- agent publish --resume 0.1.0
  expect_rc_nonzero "agent resume"
  run_release a agent-noversion -- agent prepare
  expect_rc_nonzero "agent without a version is refused before any prompt"
  expect_out "agent without a version names signing" "code signing is not set up"
  expect_eq "agent refusal changes nothing" "$before" "$(snapshot a)"
  expect_eq "agent refusal calls no docker" 0 "$(count_lines "$W/docker/log")"
  expect_eq "agent refusal calls no gh" 0 "$(count_lines "$W/gh.log")"
  expect_eq "agent refusal pushes nothing" 0 "$(count_lines "$W/state/push.log")"
  expect "agent refusal takes no prepare lock" test ! -e "$W/state-home"
}

# ---------------------------------------------------------------------------
# Cases: prepare

case_prepare_preview() {
  world prepare-preview
  local before
  before="$(snapshot a)"
  run_release a preview -- server prepare --preview --version 1.0.0
  expect_rc_zero "prepare preview"
  expect_out "preview says nothing was created" "Preview only: no branch, commit, pull request, or tag was created."
  expect_out "preview names the branch" "push the new branch $BRANCH"
  expect_out "preview lists the notes" "- A health endpoint."
  expect_eq "preview: no files, refs, commits, or pull requests changed" "$before" "$(snapshot a)"
  expect_eq "preview: no push attempted" 0 "$(count_lines "$W/state/push.log")"
  expect_eq "preview: no gh call" 0 "$(count_lines "$W/gh.log")"
  expect "preview: no prepare lock" test ! -e "$W/state-home"
}

# prepare never uses the user's checkout: it runs from a topic branch with
# staged and unstaged changes and leaves all of them as they were.
case_prepare_success() {
  world prepare
  g a checkout -q -b topic
  commit_on a "Local work"
  printf 'staged\n' >"$W/a/staged.txt"
  g a add staged.txt
  printf 'unstaged\n' >>"$W/a/README.txt"
  local head status index
  head="$(g a rev-parse HEAD)"
  status="$(g a status --porcelain)"
  index="$(g a ls-files -s | sha256sum)"
  run_release a prepare -- server prepare --version 1.0.0
  expect_rc_zero "prepare"
  expect_prepared "prepare" "$MAIN0" "$TODAY"
  local tip
  tip="$(remote_ref "refs/heads/$BRANCH")"
  expect_out "prepare reports the branch" "branch: $BRANCH"
  expect_out "prepare reports the commit" "commit: $tip"
  expect_out "prepare reports the pull request" "pull request: https://github.com/$REPO/pull/1"
  expect_out "prepare names the publish step" "scripts/release.sh server publish --version 1.0.0"
  expect_eq "pull request opened with the expected arguments" \
    "pr create --repo $REPO --base main --head $BRANCH --title Release server 1.0.0 --body-file" \
    "$(grep '^pr create' "$W/gh.log" | sed -E 's/ --body-file .*/ --body-file/')"
  expect_eq "pull request title" "Release server 1.0.0" "$(cat "$W/gh/title.1")"
  expect "pull request body names the publish command" grep -qF "scripts/release.sh server publish --version 1.0.0" "$W/gh/body.1"
  expect_eq "one branch push" 1 "$(count_pushes branch)"
  expect_eq "checkout: branch unchanged" topic "$(g a symbolic-ref --short HEAD)"
  expect_eq "checkout: HEAD unchanged" "$head" "$(g a rev-parse HEAD)"
  expect_eq "checkout: status unchanged" "$status" "$(g a status --porcelain)"
  expect_eq "checkout: index unchanged" "$index" "$(g a ls-files -s | sha256sum)"
  expect_eq "checkout: no local release branch" "" "$(g a branch --list 'release/*')"
  expect_eq "no docker call" 0 "$(count_lines "$W/docker/log")"

  # A second run finds the open pull request and changes nothing.
  local prs
  prs="$(pr_lines)"
  run_release a again -- server prepare --version 1.0.0
  expect_rc_zero "prepare again"
  expect_out "the open pull request is reused" "The release pull request is already open: https://github.com/$REPO/pull/1"
  expect_eq "prepare again opens no pull request" "$prs" "$(pr_lines)"
  expect_eq "prepare again pushes nothing" 1 "$(count_pushes branch)"
}

case_prepare_version_rules() {
  world prepare-versions
  local before v
  before="$(snapshot a)"
  for v in 0.1.0 0.0.9 1.0 v1.0.0 01.0.0 1.0.0-rc.1 1.0.0+build; do
    run_release a "version-$v" -- server prepare --version "$v"
    expect_rc_nonzero "version $v"
    if [[ "$v" == 0.1.0 ]]; then
      expect_out "an equal version names the current one" "not greater than the server version 0.1.0"
    fi
  done
  run_release a version-missing -- server prepare
  expect_eq "missing version without a terminal: exit 2" 2 "$RC"
  expect_out "missing version asks for --version" "pass --version X.Y.Z"
  expect_eq "version refusals change nothing" "$before" "$(snapshot a)"
  expect_eq "version refusals push nothing" 0 "$(count_lines "$W/state/push.log")"
}

case_prepare_refusals() {
  world prepare-refusals
  printf '# Changelog\n\n## [Unreleased]\n\n## [0.1.0] - 2026-10-01\n' >"$W/a/server/CHANGELOG.md"
  g a commit -q -am "Empty notes"
  g a push -q origin main
  run_release a empty-notes -- server prepare --version 1.0.0
  expect_rc_nonzero "prepare with an empty Unreleased section"
  expect_out "empty notes are explained" "its Unreleased section is empty"
  g a revert --no-edit HEAD >/dev/null
  g a push -q origin main

  g a push -q origin "$ORIG:refs/tags/$TAG"
  run_release a tag-exists -- server prepare --version 1.0.0
  expect_rc_nonzero "prepare when the tag exists on origin"
  expect_out "existing tag is named" "the tag $TAG already exists on origin"
  g a push -q origin ":refs/tags/$TAG"

  g a remote set-url origin "$W/origin.git"
  run_release a not-github -- server prepare --version 1.0.0
  expect_eq "prepare with a non-GitHub origin: exit 2" 2 "$RC"
  expect_out "the origin URL is named" "is not a GitHub repository URL"

  expect_eq "refusals push no release branch" 0 "$(count_pushes branch)"
  expect_eq "refusals open no pull request" 0 "$(pr_lines)"
}

# G10: the push fails before it reaches origin; a rerun starts over cleanly.
case_prepare_failure_before_push() {
  world prepare-fail-before-push
  run_release a fail SHIM_FAULTS=branch-fail -- server prepare --version 1.0.0
  expect_rc_nonzero "prepare whose branch push fails"
  expect_eq "no release branch on origin" "" "$(remote_ref "refs/heads/$BRANCH")"
  expect_eq "no pull request" 0 "$(pr_lines)"
  expect "prepare worktree removed" one_worktree a
  expect "scratch cleaned" scratch_clean
  run_release a rerun -- server prepare --version 1.0.0
  expect_rc_zero "rerun after the failed push"
  expect_prepared "rerun after the failed push" "$MAIN0" "$TODAY"
  expect_eq "one pull request" 1 "$(pr_lines)"
}

# G10: origin accepts the branch push but the response is lost.
case_prepare_lost_push_response() {
  world prepare-lost-push
  run_release a lost SHIM_FAULTS=branch-lost -- server prepare --version 1.0.0
  expect_rc_zero "prepare with a lost push response"
  expect_out "origin decided the push" "Origin shows refs/heads/$BRANCH at the release commit; the push happened."
  expect_prepared "lost push response" "$MAIN0" "$TODAY"
  expect_eq "one branch push" 1 "$(count_pushes branch)"
}

# G10: GitHub creates the pull request but the response is lost.
case_prepare_lost_pr_response() {
  world prepare-lost-pr
  run_release a lost SHIM_FAULTS=pr-create-lost -- server prepare --version 1.0.0
  expect_rc_zero "prepare with a lost pull request response"
  expect_out "GitHub decided the creation" "GitHub shows the pull request; it was created."
  expect_prepared "lost pull request response" "$MAIN0" "$TODAY"
  expect_eq "exactly one pull request" 1 "$(pr_lines)"
}

# G10: the pull request step fails after the push; main moves on; the rerun
# reuses the branch without pushing again and opens the pull request.
case_prepare_recovery_after_main_moved() {
  world prepare-main-moved
  run_release a first SHIM_FAULTS=pr-create-fail -- server prepare --version 1.0.0
  expect_rc_nonzero "prepare whose pull request creation fails"
  expect_out "the pushed branch is reported" "$BRANCH is on origin at"
  expect_out "the rerun is suggested" "It reuses the branch and finds or opens the pull request."
  local tip moved
  tip="$(remote_ref "refs/heads/$BRANCH")"
  expect "the branch was pushed" test -n "$tip"
  moved="$(push_main "Later work")"
  run_release a rerun -- server prepare --version 1.0.0
  expect_rc_zero "rerun after main moved on"
  expect_out "the branch is reused" "already holds the expected commit $tip"
  expect_eq "the rerun pushed nothing" 1 "$(count_pushes branch)"
  expect_eq "the branch is unchanged" "$tip" "$(remote_ref "refs/heads/$BRANCH")"
  expect_eq "the pull request is at the first commit" "$tip" "$(open_pr_head "$BRANCH")"
  expect_eq "main keeps the later work" "$moved" "$(remote_ref refs/heads/main)"
}

# G10: the rerun happens on a later day; the commit's recorded date counts.
case_prepare_recovery_later_date() {
  world prepare-later-date
  run_release a first SHIM_FAULTS=pr-create-fail -- server prepare --version 1.0.0
  expect_rc_nonzero "prepare whose pull request creation fails"
  run_release a later SHIM_TODAY=2026-11-03 -- server prepare --version 1.0.0
  expect_rc_zero "rerun two days later"
  expect_out "the recorded date is used" "(dated $TODAY)"
  expect_prepared "rerun two days later" "$MAIN0" "$TODAY"
  expect_eq "the rerun pushed nothing" 1 "$(count_pushes branch)"
}

# G10: a remote release branch with other content is never reused or replaced.
case_prepare_foreign_branch() {
  local variant tip
  for variant in extra-file other-notes two-commits; do
    world "prepare-foreign-$variant"
    clone b
    g b checkout -q -b "$BRANCH"
    case "$variant" in
      extra-file)
        sed -i 's/"version": "0.1.0"/"version": "1.0.0"/' "$W/b/server/package.json"
        printf 'extra\n' >"$W/b/extra.txt"
        g b add -A
        g b commit -q -m "Release server 1.0.0"
        ;;
      other-notes)
        sed -i 's/"version": "0.1.0"/"version": "1.0.0"/' "$W/b/server/package.json"
        sed -i "s/^## \[Unreleased\]\$/## [Unreleased]\n\n## [1.0.0] - $TODAY/; s/A health endpoint/Something else/" "$W/b/server/CHANGELOG.md"
        g b commit -q -am "Release server 1.0.0"
        ;;
      two-commits)
        # The expected change, split over two commits.
        sed -i 's/"version": "0.1.0"/"version": "1.0.0"/' "$W/b/server/package.json"
        g b commit -q -am "Version"
        sed -i "s/^## \[Unreleased\]\$/## [Unreleased]\n\n## [1.0.0] - $TODAY/" "$W/b/server/CHANGELOG.md"
        g b commit -q -am "Changelog"
        ;;
    esac
    g b push -q origin "$BRANCH"
    tip="$(remote_ref "refs/heads/$BRANCH")"
    run_release a foreign -- server prepare --version 1.0.0
    expect_rc_nonzero "$variant: prepare over a foreign branch"
    expect_out "$variant: the branch is reported" "is not the expected release commit"
    expect_eq "$variant: the branch is untouched" "$tip" "$(remote_ref "refs/heads/$BRANCH")"
    expect_eq "$variant: no push" 0 "$(count_pushes branch)"
    expect_eq "$variant: no pull request" 0 "$(pr_lines)"
  done
}

# G14: an open fork pull request with the same branch name is not ours.
case_prepare_ignores_fork_pr() {
  world prepare-fork
  pr_add open - - "$BRANCH" "$(printf '%040d' 7)" someone/mashkif
  run_release a prepare -- server prepare --version 1.0.0
  expect_rc_zero "prepare next to a fork pull request"
  expect_prepared "prepare next to a fork pull request" "$MAIN0" "$TODAY"
  expect_eq "a pull request of this repository was opened" 1 "$(grep -c '^pr create' "$W/gh.log")"
}

# G11: a second prepare fails fast while the first holds the lock.
case_prepare_concurrent() {
  world prepare-concurrent
  local pid
  spawn_release a first SHIM_BRANCH_BARRIER="$W/barrier" SHIM_NAME=first -- server prepare --version 1.0.0
  pid=$LAST_PID
  expect "the first prepare holds the lock at its push" wait_file "$W/barrier/first.ready"
  run_release a second -- server prepare --version 1.0.0
  expect_rc_nonzero "a second prepare while the first runs"
  expect_out "the lock is reported" "another 'scripts/release.sh prepare' is running"
  expect_no_out "the second made no commit" "Created the release commit"
  # The first run logged its push before it stopped at the barrier.
  expect_eq "the second pushed nothing" 1 "$(count_pushes branch)"
  expect_eq "the second called no gh" 0 "$(count_lines "$W/gh.log")"
  : >"$W/barrier/go"
  wait_exit "$pid" || true
  OUT="$W/first.out"
  expect_rc_zero "the first prepare finishes"
  expect_prepared "the first prepare" "$MAIN0" "$TODAY"
  expect_eq "one pull request" 1 "$(pr_lines)"
}

# ---------------------------------------------------------------------------
# Cases: publish

case_publish_preview() {
  world publish-preview merged
  local before
  before="$(snapshot a)"
  run_release a preview -- server publish --preview --version 1.0.0
  expect_rc_zero "publish preview"
  expect_out "preview says nothing changed" "Preview only: no branch, tag, lease, pull request, or image was changed."
  expect_out "preview names the source" "push refs/tags/$TAG at $MERGE"
  expect_eq "preview: no files, refs, commits, or images changed" "$before" "$(snapshot a)"
  expect "preview: docker only inspected" only_inspects
  expect_eq "preview: no push attempted" 0 "$(count_lines "$W/state/push.log")"
  expect "preview: gh only read" gh_only_reads
}

case_publish_success() {
  world publish merged
  publish a publish
  expect_rc_zero "publish"
  expect_published "publish" a "$MERGE"
  expect_out "publish reports that no local tag exists" "No local tag was created"
  expect_out "publish rechecks after the lease" "Rechecked after taking the lease"
  expect_eq "docker build used --provenance=false --sbom=false" 1 \
    "$(grep -c -- '--provenance=false --sbom=false' "$W/docker/log")"
  expect_eq "one tag push" 1 "$(count_pushes reserve)"
  expect "the CI runs were read with pagination" grep -qE "^api --paginate repos/$REPO/actions/workflows/ci.yml/runs\?head_sha=$MERGE&event=push&branch=main&per_page=100 " "$W/gh.log"
  expect "the pull requests were read with pagination" grep -qF "api --paginate repos/$REPO/pulls?state=closed&base=main&head=ShlomiPorush:$BRANCH&per_page=100 " "$W/gh.log"
}

case_publish_preflight() {
  world publish-preflight merged
  printf 'x\n' >>"$W/a/server/CHANGELOG.md"
  publish a dirty
  expect_rc_nonzero "publish with a modified file"
  expect_out "dirty tree is named" "the working tree is not clean"
  g a checkout -q -- server/CHANGELOG.md

  g a tag "$TAG"
  publish a local-tag
  expect_rc_nonzero "publish with a local tag"
  expect_out "local tag is named" "already exists locally"
  g a tag -d "$TAG" >/dev/null
  expect "preflight refusals never take a lease" test ! -e "$W/state/push.log"
  expect "preflight refusals never build" no_builds
}

case_registry_checks() {
  world registry merged
  local before
  before="$(snapshot a)"
  publish a denied SHIM_FAULTS=registry-denied
  expect_eq "unreadable registry: exit 2" 2 "$RC"
  expect_out "unreadable registry asks for a login" "docker login ghcr.io"
  expect_eq "unreadable registry changes nothing" "$before" "$(snapshot a)"
  mkdir -p "$W/docker/registry"
  printf 'sha256:%064d other\n' 0 >"$W/docker/registry/$IMAGE_KEY"
  before="$(snapshot a)"
  publish a exists
  expect_rc_nonzero "existing image version"
  expect_out "existing image is never overwritten" "already exists; a published version is never overwritten"
  expect_eq "registry refusals change nothing" "$before" "$(snapshot a)"
}

# G9: the source is the release pull request's merge commit, not the tip of main.
case_publish_after_main_moved() {
  world publish-main-moved merged
  local tip
  tip="$(push_main "Later work")"
  ci_green "$tip"
  g a pull -q --ff-only
  publish a publish
  expect_rc_zero "publish after main moved on"
  expect_published "publish after main moved on" a "$MERGE"
  expect "the tip of main is not the tag" test "$tip" != "$(remote_ref "refs/tags/$TAG")"
}

# G9: refusals of the source rule.
case_publish_source_rules() {
  local variant sha
  for variant in unmerged two-merged not-on-main other-version no-section; do
    if [[ "$variant" == no-section ]]; then
      world "publish-source-$variant"
    else
      world "publish-source-$variant" merged
    fi
    case "$variant" in
      unmerged)
        pr_set "\$5 == \"$BRANCH\"" "\$2 = \"open\"; \$3 = \"-\"; \$4 = \"-\""
        ;;
      two-merged)
        pr_add closed "${TODAY}T13:00:00Z" "$ORIG" "$BRANCH" "$ORIG" "$REPO"
        ;;
      not-on-main)
        clone b
        commit_on b "Side work"
        g b push -q origin "HEAD:refs/heads/side"
        sha="$(g b rev-parse HEAD)"
        pr_set "\$5 == \"$BRANCH\"" "\$4 = \"$sha\""
        ;;
      other-version)
        # A merged release pull request whose merge commit still says 0.1.0.
        pr_set "\$5 == \"$BRANCH\"" "\$4 = \"$ORIG\""
        ci_green "$ORIG"
        ;;
      no-section)
        # A merged release pull request that sets the version but has no
        # changelog section.
        clone b
        g b checkout -q -b "$BRANCH"
        sed -i 's/"version": "0.1.0"/"version": "1.0.0"/' "$W/b/server/package.json"
        g b commit -q -am "Bump only"
        g b checkout -q main
        g b merge -q --no-ff -m "Merge bump" "$BRANCH"
        g b push -q origin main
        sha="$(g b rev-parse HEAD)"
        pr_add closed "${TODAY}T12:00:00Z" "$sha" "$BRANCH" "$(g b rev-parse "$BRANCH")" "$REPO"
        ci_green "$sha"
        ;;
    esac
    publish a publish
    expect_rc_nonzero "$variant: publish"
    case "$variant" in
      unmerged) expect_out "$variant: explained" "no merged release pull request" ;;
      two-merged) expect_out "$variant: explained" "more than one merged release pull request" ;;
      not-on-main) expect_out "$variant: explained" "is not on origin/main" ;;
      other-version) expect_out "$variant: explained" "says 0.1.0, not 1.0.0" ;;
      no-section) expect_out "$variant: explained" "has no \"## [1.0.0]\" section" ;;
    esac
    expect_eq "$variant: no tag" "" "$(remote_ref "refs/tags/$TAG")"
    expect_eq "$variant: no lease taken" 0 "$(count_pushes lease-acquire)"
    expect "$variant: nothing built" no_builds
  done
}

# G13: a release pull request merged and then fully reverted refuses.
case_publish_reverted() {
  world publish-reverted merged
  clone b
  g b revert --no-edit -m 1 "$MERGE" >/dev/null
  g b push -q origin main
  ci_green "$(g b rev-parse HEAD)"
  publish a publish
  expect_rc_nonzero "publish after the release was reverted"
  expect_out "the revert is explained" "the release looks reverted"
  expect_eq "no tag" "" "$(remote_ref "refs/tags/$TAG")"
  expect "nothing built" no_builds
}

# G14: a merged fork pull request with the same branch name is not a release.
case_publish_fork_pr() {
  world publish-fork merged
  pr_set "\$5 == \"$BRANCH\"" "\$7 = \"someone/mashkif\""
  publish a publish
  expect_rc_nonzero "publish with only a fork pull request merged"
  expect_out "no release pull request is found" "no merged release pull request"
  expect_eq "no tag" "" "$(remote_ref "refs/tags/$TAG")"
  expect "nothing built" no_builds
}

# G14: the head branch was deleted after the merge.
case_publish_deleted_head_branch() {
  world publish-deleted-branch merged
  g a push -q origin ":refs/heads/$BRANCH"
  expect_eq "the release branch is gone" "" "$(remote_ref "refs/heads/$BRANCH")"
  publish a publish
  expect_rc_zero "publish after the head branch was deleted"
  expect_published "publish after the head branch was deleted" a "$MERGE"
}

# G8: CI evidence for the source commit.
case_publish_ci_evidence() {
  local variant id
  for variant in none other-workflow disagree attempt-running attempt-failed summary-missing summary-failed summary-running pagination; do
    world "publish-ci-$variant" merged
    ci_clear "$MERGE"
    local -a vars=()
    case "$variant" in
      none) ;;
      other-workflow)
        id="$(ci_run "$MERGE" 1 completed success .github/workflows/other.yml)"
        ci_jobs "$id" 1 completed success
        ;;
      disagree)
        ci_green "$MERGE"
        id="$(ci_run "$MERGE" 1 completed failure)"
        ci_jobs "$id" 1 completed failure
        ;;
      attempt-running)
        id="$(ci_run "$MERGE" 2 in_progress -)"
        ci_jobs "$id" 1 completed success
        ;;
      attempt-failed)
        id="$(ci_run "$MERGE" 2 completed failure)"
        ci_jobs "$id" 1 completed success
        ci_jobs "$id" 2 completed failure
        ;;
      summary-missing)
        id="$(ci_run "$MERGE" 1 completed success)"
        ci_jobs "$id" 1 none
        ;;
      summary-failed)
        id="$(ci_run "$MERGE" 1 completed success)"
        ci_jobs "$id" 1 completed failure
        ;;
      summary-running)
        id="$(ci_run "$MERGE" 1 completed success)"
        ci_jobs "$id" 1 in_progress -
        ;;
      pagination)
        # The failed run is on the second page.
        ci_green "$MERGE"
        id="$(ci_run "$MERGE" 1 completed failure)"
        ci_jobs "$id" 1 completed failure
        vars=(SHIM_GH_PAGE_SIZE=1)
        ;;
    esac
    publish a publish "${vars[@]}"
    expect_rc_nonzero "$variant: publish"
    case "$variant" in
      none) expect_out "$variant: explained" "no push run of .github/workflows/ci.yml on main exists for $MERGE" ;;
      other-workflow) expect_out "$variant: explained" "does not match the release source (workflow .github/workflows/other.yml" ;;
      disagree | pagination) expect_out "$variant: explained" "concluded failure, not success" ;;
      attempt-running) expect_out "$variant: explained" "(attempt 2) for $MERGE is in_progress, not completed" ;;
      attempt-failed) expect_out "$variant: explained" "(attempt 2) for $MERGE concluded failure" ;;
      summary-missing) expect_out "$variant: explained" "has no single successful summary job (found: none)" ;;
      summary-failed) expect_out "$variant: explained" "(found: completed/failure)" ;;
      summary-running) expect_out "$variant: explained" "(found: in_progress/-)" ;;
    esac
    expect_eq "$variant: no tag" "" "$(remote_ref "refs/tags/$TAG")"
    expect_eq "$variant: no lease taken" 0 "$(count_pushes lease-acquire)"
    expect "$variant: nothing built" no_builds
  done
}

# G8: the CI evidence changes while the run waits for the lease.
case_publish_ci_changes_during_lease_wait() {
  world publish-ci-lease-wait merged
  local id
  id="$(head -n 1 "$W/gh/runs/$MERGE" | cut -f 1)"
  cat >"$W/hook.sh" <<EOF
#!/usr/bin/env bash
printf '%s\t2\tcompleted\tfailure\t%s\tpush\tmain\t.github/workflows/ci.yml\t%s\n' "$id" "$MERGE" "$REPO" >"$W/gh/runs/$MERGE"
printf 'summary\tcompleted\tfailure\n' >"$W/gh/jobs/$id.2"
EOF
  chmod +x "$W/hook.sh"
  publish a publish SHIM_BEFORE_LEASE="$W/hook.sh"
  expect_rc_nonzero "publish whose CI evidence fails during the lease wait"
  expect_out "the lease was taken" "Acquired refs/release-leases/active"
  expect_out "the new attempt is reported" "(attempt 2) for $MERGE concluded failure"
  expect_eq "no tag" "" "$(remote_ref "refs/tags/$TAG")"
  expect_eq "no tag push" 0 "$(count_pushes reserve)"
  expect "lease released" no_leases
  expect "nothing built" no_builds
}

# ---------------------------------------------------------------------------
# Cases: lease, reservation, interruption, and resume

case_concurrent_publishes() {
  world concurrent merged
  clone b
  local pid_a pid_b rc_a rc_b winner loser
  spawn_release a race-a SHIM_LEASE_BARRIER="$W/barrier" SHIM_NAME=a -- server publish --version 1.0.0
  pid_a=$LAST_PID
  spawn_release b race-b SHIM_LEASE_BARRIER="$W/barrier" SHIM_NAME=b -- server publish --version 1.0.0
  pid_b=$LAST_PID
  if wait_file "$W/barrier/a.ready" && wait_file "$W/barrier/b.ready"; then
    pass "both publishes passed preflight and reached the lease push"
  else
    flunk "both publishes reached the lease push"
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
    flunk "exactly one concurrent publish succeeds (a=$rc_a b=$rc_b)"
    return
  fi
  pass "exactly one concurrent publish succeeds ($winner)"
  OUT="$W/race-$loser.out"
  expect_out "loser reports the held lease" "another release run holds the publish lease refs/release-leases/active"
  expect_out "loser shows the owner" "owner: "
  expect_out "loser shows the start time" "started: "
  expect_eq "one build in total" 1 "$(count_lines "$W/docker/builds")"
  expect_eq "one tag push in total" 1 "$(count_pushes reserve)"
  expect_eq "the tag is the merge commit" "$MERGE" "$(remote_ref "refs/tags/$TAG")"
  expect "no lease left after the race" no_leases
}

# Publishes of different versions share one lease.
case_concurrent_publishes_different_versions() {
  world concurrent-versions merged
  clone m
  sed -i 's/^## \[Unreleased\]$/## [Unreleased]\n\n### Fixed\n\n- A fix./' "$W/m/server/CHANGELOG.md"
  g m commit -q -am "Record a fix"
  g m push -q origin main
  run_release a prepare-1.1.0 -- server prepare --version 1.1.0
  expect_rc_zero "prepare 1.1.0"
  local merge_one="$MERGE"
  merge_release 1.1.0
  g a pull -q --ff-only
  local pid_one pid_two rc_one rc_two loser winner_tag loser_tag
  spawn_release a versions-one SHIM_LEASE_BARRIER="$W/barrier" SHIM_NAME=one -- server publish --version 1.0.0
  pid_one=$LAST_PID
  spawn_release a versions-two SHIM_LEASE_BARRIER="$W/barrier" SHIM_NAME=two -- server publish --version 1.1.0
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
    expect_eq "1.0.0 is tagged at its merge commit" "$merge_one" "$(remote_ref refs/tags/server-v1.0.0)"
  elif ((rc_two == 0 && rc_one != 0)); then
    loser=one winner_tag=server-v1.1.0 loser_tag=server-v1.0.0
    expect_eq "1.1.0 is tagged at its merge commit" "$MERGE" "$(remote_ref refs/tags/server-v1.1.0)"
  else
    OUT="$W/versions-one.out"
    flunk "exactly one publish of two versions proceeds (1.0.0=$rc_one 1.1.0=$rc_two)"
    return
  fi
  pass "exactly one publish of two versions proceeds"
  OUT="$W/versions-$loser.out"
  expect_out "the other version is refused at the lease" "another release run holds the publish lease refs/release-leases/active"
  expect_out "the refusal names the leased tag" "tag: $winner_tag"
  expect_no_out "the refused version never acquired a lease" "Acquired refs/release-leases/"
  expect_eq "the refused version has no tag" "" "$(remote_ref "refs/tags/$loser_tag")"
  expect_eq "one build in total" 1 "$(count_lines "$W/docker/builds")"
  expect "no lease left" no_leases
}

# A publish that passed preflight waits at the lease while another publish of
# the same version finishes; after the lease it finds the tag and refuses.
case_lease_after_other_publish() {
  world lease-after-other merged
  clone b
  local pid
  spawn_release a late SHIM_LEASE_BARRIER="$W/barrier" SHIM_NAME=late -- server publish --version 1.0.0
  pid=$LAST_PID
  if wait_file "$W/barrier/late.ready"; then
    pass "the late run passed preflight and waits at the lease push"
  else
    flunk "the late run reached the lease push"
  fi
  publish b early
  expect_rc_zero "the early run publishes 1.0.0"
  : >"$W/barrier/go"
  wait_exit "$pid" || true
  OUT="$W/late.out"
  expect_rc_nonzero "the late run is refused after taking the lease"
  expect_out "the refusal names the new tag" "was created on origin while this run waited for the lease"
  expect_eq "one tag push in total" 1 "$(count_pushes reserve)"
  expect_eq "one build in total" 1 "$(count_lines "$W/docker/builds")"
  expect "no lease left" no_leases
}

case_publish_vs_resume() {
  world publish-vs-resume merged
  clone b
  local pid before_b
  spawn_release a held SHIM_BUILD_BARRIER="$W/barrier" -- server publish --version 1.0.0
  pid=$LAST_PID
  expect "publish is building while holding the lease" wait_file "$W/barrier/build.ready"
  before_b="$(snapshot b)"
  run_release b resume-blocked -- server publish --resume 1.0.0
  expect_rc_nonzero "resume from another clone while the publish holds the lease"
  expect_out "blocked resume shows the owner" "owner: "
  expect_out "blocked resume shows the start time" "started: "
  expect_out "blocked resume prints the manual recovery" "git push --porcelain --force-with-lease=refs/release-leases/active:"
  expect_out "blocked resume shows the leased tag" "tag: $TAG"
  expect_eq "blocked resume changed nothing" "$before_b" "$(snapshot b)"
  : >"$W/barrier/go"
  wait_exit "$pid" || true
  OUT="$W/held.out"
  expect_rc_zero "publish finishes after the blocked resume"
  run_release b resume-after -- server publish --resume 1.0.0
  expect_rc_nonzero "resume after the publish finished does not claim success"
  expect_out "resume cannot verify the existing image" "already exists; this run cannot verify its content"
  expect_eq "resume built nothing" 1 "$(count_lines "$W/docker/builds")"
  expect_eq "resume created no local tag" "" "$(g b tag -l)"
  expect_eq "resume left HEAD alone" "$MAIN0" "$(g b rev-parse HEAD)"
}

# '=': the tag appears at the source commit just before the reservation push.
case_tag_equal() {
  world tag-equal merged
  cat >"$W/hook.sh" <<EOF
#!/usr/bin/env bash
"$REAL_GIT" -C "\$1" push -q origin "$MERGE:refs/tags/$TAG"
EOF
  chmod +x "$W/hook.sh"
  publish a tag-equal SHIM_BEFORE_RESERVE="$W/hook.sh"
  expect_rc_nonzero "reservation where the tag already exists (=)"
  expect_out "the existing tag is reported" "it already existed on origin"
  expect_out "recovery says this run published nothing" "This run published nothing"
  expect "no build after '='" no_builds
  expect "lease released after '='" no_leases
}

# '!': the tag appears at another commit just before the reservation push.
case_rejected_reservation() {
  world rejected merged
  cat >"$W/hook.sh" <<EOF
#!/usr/bin/env bash
"$REAL_GIT" -C "\$1" push -q origin "$ORIG:refs/tags/$TAG"
EOF
  chmod +x "$W/hook.sh"
  publish a rejected SHIM_BEFORE_RESERVE="$W/hook.sh"
  expect_rc_nonzero "rejected reservation"
  expect_out "rejection is reported" "origin rejected the creation of refs/tags/$TAG"
  expect_out "recovery says nothing was tagged" "this run tagged and published nothing"
  expect_no_out "no advice to reset a local branch" "git reset"
  expect "lease released after the rejection" no_leases
  expect_eq "the other tag is untouched" "$ORIG" "$(remote_ref "refs/tags/$TAG")"
  expect_eq "local tree clean" "" "$(g a status --porcelain)"
  expect "nothing built" no_builds
}

case_lost_reservation_response() {
  world lost-reservation merged
  publish a lost SHIM_FAULTS=reserve-lost
  expect_rc_zero "lost reservation response"
  expect_out "origin decided" "The reservation push gave no clear answer"
  expect_published "lost reservation response" a "$MERGE"
}

case_lost_lease_response() {
  world lost-lease merged
  publish a lost SHIM_FAULTS=lease-lost
  expect_rc_zero "lost lease response"
  expect_out "origin shows the lease" "Origin shows our lease; continuing."
  expect_published "lost lease response" a "$MERGE"
}

case_lost_lease_origin_down() {
  world lost-lease-down merged
  publish a lost-down SHIM_FAULTS=lease-lost-down
  expect_rc_nonzero "lost lease response with origin unreadable"
  expect_out "ownership unknown is reported" "lease ownership is unknown"
  local lease cmd
  lease="$(remote_leases)"
  expect "lease left in place" test -n "$lease"
  expect_out "printed recovery names the lease SHA" "${lease%% *}"
  expect_eq "no tag" "" "$(remote_ref "refs/tags/$TAG")"
  cmd="$(last_delete_command)"
  rm -f "$W/state/remote-down"
  (cd "$W/a" && eval "$cmd") >/dev/null 2>&1 || true
  expect "printed command deletes the lease" no_leases
}

case_crash_holding_lease() {
  world crash merged
  local pid shim_pid lease cmd before
  spawn_release a crash SHIM_BUILD_BARRIER="$W/barrier" -- server publish --version 1.0.0
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
  run_release a after-crash-preview -- server publish --preview --resume 1.0.0
  expect_rc_nonzero "preview refuses while the lease exists"
  expect_out "preview shows the owner host" "host: "
  expect_eq "refusing preview changes nothing" "$before" "$(snapshot a)"

  run_release a after-crash -- server publish --resume 1.0.0
  expect_rc_nonzero "resume refuses while the crashed lease exists"
  expect_out "refusal shows the owner" "owner: "
  expect_out "refusal shows the start time" "started: "
  expect_out "refusal explains the manual recovery" "confirm that no"
  expect_eq "refusal leaves the lease untouched" "$lease" "$(remote_leases)"
  cmd="$(last_delete_command)"
  (cd "$W/a" && eval "$cmd") >/dev/null 2>&1 || true
  expect "printed recovery command deletes the lease" no_leases
  run_release a recovered -- server publish --resume 1.0.0
  expect_rc_zero "resume after the manual recovery"
  expect_eq "recovered resume publishes the tag SHA" "$MERGE" "$(registry_revision)"
}

case_interrupt_waits_for_child() {
  world interrupt merged
  local pid
  spawn_release a interrupted SHIM_BUILD_BARRIER="$W/barrier" -- server publish --version 1.0.0
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
  expect_out "resume is suggested after the interrupt" "scripts/release.sh server publish --resume 1.0.0"
  expect "nothing pushed after the interrupt" test ! -e "$W/docker/pushes"
  expect "build worktree removed after the interrupt" one_worktree a
}

case_failed_lease_release() {
  world release-fail merged
  publish a release-fail SHIM_FAULTS=release-fail
  expect_rc_nonzero "failed lease release"
  expect_out "failure is reported" "could not delete the publish lease"
  local lease cmd
  lease="$(remote_leases)"
  expect "lease still on origin" test -n "$lease"
  expect_out "lease SHA is printed" "${lease%% *}"
  expect_eq "publishing itself finished" "$MERGE" "$(registry_revision)"
  cmd="$(last_delete_command)"
  (cd "$W/a" && eval "$cmd") >/dev/null 2>&1 || true
  expect "printed command deletes the lease" no_leases
}

# A failure at each publishing step, then a resume.
case_publish_failures() {
  local fault
  for fault in build-fail push-fail push-lost remote-digest-mismatch; do
    world "publish-$fault" merged
    fail_publish "$fault" "$fault"
    expect_rc_nonzero "$fault"
    expect_out "$fault: resume is suggested" "scripts/release.sh server publish --resume 1.0.0"
    expect "$fault: lease released" no_leases
    expect_eq "$fault: tag stays reserved at the merge commit" "$MERGE" "$(remote_ref "refs/tags/$TAG")"
    expect "$fault: build worktree removed" one_worktree a
    expect "$fault: scratch cleaned" scratch_clean
    expect_eq "$fault: still no local tag" "" "$(g a tag -l)"
    run_release a "resume-$fault" -- server publish --resume 1.0.0
    expect_eq "$fault: registry has the tag SHA" "$MERGE" "$(registry_revision)"
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
          "tag=$IMAGE rev=$MERGE head=$MERGE version=1.0.0" "$(last_build)"
        ;;
    esac
    expect "$fault: no lease after resume" no_leases
  done
  OUT="$W/remote-digest-mismatch.out"
  expect_out "digest mismatch is reported" "differs from the locally built digest"
}

case_resume_mismatched_artifact() {
  world mismatch merged
  fail_publish start build-fail
  printf 'sha256:%064d %040d\n' 1 1 >"$W/docker/registry/$IMAGE_KEY"
  local before
  before="$(cat "$W/docker/registry/$IMAGE_KEY")"
  run_release a resume -- server publish --resume 1.0.0
  expect_rc_nonzero "resume over an image with another revision"
  expect_out "mismatch is never overwritten" "was not built from"
  expect_eq "registry unchanged" "$before" "$(cat "$W/docker/registry/$IMAGE_KEY")"
  expect "lease released" no_leases
}

case_resume_main_moved() {
  world resume-main-moved merged
  fail_publish start build-fail
  local moved
  moved="$(push_main "Later work")"
  g a pull -q --ff-only
  run_release a resume -- server publish --resume 1.0.0
  expect_rc_zero "resume after main moved on"
  expect_eq "built from the tag SHA, not main" \
    "tag=$IMAGE rev=$MERGE head=$MERGE version=1.0.0" "$(last_build)"
  expect_eq "resume did not touch origin main" "$moved" "$(remote_ref refs/heads/main)"
  expect_eq "resume did not touch local HEAD" "$moved" "$(g a rev-parse HEAD)"
}

# Clone b predates the release: resume fetches what it needs and leaves b alone.
case_resume_commit_missing() {
  world commit-missing
  clone b
  run_release a prepare -- server prepare --version 1.0.0
  expect_rc_zero "prepare"
  merge_release 1.0.0
  fail_publish start build-fail
  expect "clone b lacks the merge commit" lacks_commit b "$MERGE"
  run_release b resume -- server publish --resume 1.0.0
  expect_rc_zero "resume with the merge commit missing locally"
  expect_eq "built from the merge commit" \
    "tag=$IMAGE rev=$MERGE head=$MERGE version=1.0.0" "$(last_build)"
  expect_eq "no local tag in b" "" "$(g b tag -l)"
  expect_eq "b HEAD unchanged" "$ORIG" "$(g b rev-parse HEAD)"
}

case_resume_dirty_and_preview() {
  world resume-dirty merged
  fail_publish start build-fail
  local before pushes
  pushes="$(count_lines "$W/state/push.log")"
  before="$(snapshot a)"
  run_release a preview-resume -- server publish --preview --resume 1.0.0
  expect_rc_zero "preview resume"
  expect_out "preview resume reports the missing image" "$IMAGE: absent"
  expect_eq "preview resume changes nothing" "$before" "$(snapshot a)"

  printf 'local edit\n' >>"$W/a/server/CHANGELOG.md"
  before="$(snapshot a)"
  run_release a dirty-resume -- server publish --resume 1.0.0
  expect_rc_nonzero "resume with an uncommitted change"
  expect_out "dirty tree is named" "the working tree is not clean"
  expect_eq "dirty resume changes nothing" "$before" "$(snapshot a)"
  expect_eq "dirty resume pushes nothing" "$pushes" "$(count_lines "$W/state/push.log")"

  g a checkout -q -- server/CHANGELOG.md
  run_release a no-tag -- server publish --resume 2.0.0
  expect_rc_nonzero "resume of a version that was never tagged"
  expect_out "missing tag is explained" "there is nothing to resume"
}

# G12: resume publishes only a tag at the release pull request's merge commit
# that passes the source, revert, and CI checks.
case_resume_source_checks() {
  local sha
  # A hand-made tag on a commit with the right version, without a release pull request.
  world resume-hand-made-tag
  clone b
  sed -i 's/"version": "0.1.0"/"version": "1.0.0"/' "$W/b/server/package.json"
  sed -i "s/^## \[Unreleased\]\$/## [Unreleased]\n\n## [1.0.0] - $TODAY/" "$W/b/server/CHANGELOG.md"
  g b commit -q -am "Hand-made release"
  g b push -q origin main
  sha="$(g b rev-parse HEAD)"
  g b push -q origin "$sha:refs/tags/$TAG"
  ci_green "$sha"
  run_release a hand-made -- server publish --resume 1.0.0
  expect_rc_nonzero "resume of a hand-made tag"
  expect_out "hand-made: no release pull request" "no merged release pull request"
  expect "hand-made: no lease taken" test "$(count_pushes lease-acquire)" = 0
  expect "hand-made: nothing built" no_builds

  # A tag at another commit than the merge commit.
  world resume-other-commit merged
  g a push -q origin "$ORIG:refs/tags/$TAG"
  run_release a other-commit -- server publish --resume 1.0.0
  expect_rc_nonzero "resume of a tag at another commit"
  expect_out "other commit: explained" "points at $ORIG, not at $MERGE"
  expect "other commit: nothing built" no_builds

  # The CI evidence turned into a failed newest attempt after the tag was made.
  world resume-ci-failed merged
  fail_publish start build-fail
  local id
  id="$(head -n 1 "$W/gh/runs/$MERGE" | cut -f 1)"
  ci_clear "$MERGE"
  printf '%s\t2\tcompleted\tfailure\t%s\tpush\tmain\t.github/workflows/ci.yml\t%s\n' "$id" "$MERGE" "$REPO" >"$W/gh/runs/$MERGE"
  ci_jobs "$id" 2 completed failure
  run_release a ci-failed -- server publish --resume 1.0.0
  expect_rc_nonzero "resume after CI failed on a new attempt"
  expect_out "CI failure: explained" "(attempt 2) for $MERGE concluded failure"
  expect_eq "CI failure: only the first failed build" 0 "$(count_lines "$W/docker/pushes")"
  expect "CI failure: no lease" no_leases

  # The release was reverted after the tag was made.
  world resume-reverted merged
  fail_publish start build-fail
  clone b
  g b revert --no-edit -m 1 "$MERGE" >/dev/null
  g b push -q origin main
  run_release a reverted -- server publish --resume 1.0.0
  expect_rc_nonzero "resume after the release was reverted"
  expect_out "reverted: explained" "the release looks reverted"
}

# The recheck after the lease covers resume too.
case_resume_recheck_after_lease() {
  world resume-recheck merged
  fail_publish start build-fail
  local id
  id="$(head -n 1 "$W/gh/runs/$MERGE" | cut -f 1)"
  cat >"$W/hook.sh" <<EOF
#!/usr/bin/env bash
printf '%s\t2\tin_progress\t-\t%s\tpush\tmain\t.github/workflows/ci.yml\t%s\n' "$id" "$MERGE" "$REPO" >"$W/gh/runs/$MERGE"
EOF
  chmod +x "$W/hook.sh"
  run_release a resume SHIM_BEFORE_LEASE="$W/hook.sh" -- server publish --resume 1.0.0
  expect_rc_nonzero "resume whose CI evidence changes during the lease wait"
  expect_out "the lease was taken" "Acquired refs/release-leases/active"
  expect_out "the running attempt is reported" "(attempt 2) for $MERGE is in_progress"
  expect "lease released" no_leases
  expect "nothing built or pushed" no_builds
}

# Origin becomes unreadable right after the lease is taken. The recheck cannot
# run, which is an environment error (exit 2), not a refusal.
case_origin_down_after_lease() {
  world origin-down-after-lease merged
  publish a down-after-lease SHIM_FAULTS=down-after-lease
  expect_eq "an unreadable origin after the lease exits 2" 2 "$RC"
  expect_out "the error names the unreadable remote" "cannot read tags from origin after taking the lease"
  expect "nothing built" no_builds
  expect_eq "local tree clean" "" "$(g a status --porcelain)"
}

# TERM after origin accepted the tag push, before the script read the result.
case_interrupt_after_reservation_accepted() {
  local variant pid tag_sha
  for variant in readable unreadable; do
    world "interrupt-reservation-$variant" merged
    local faults=""
    [[ "$variant" == unreadable ]] && faults=down-after-reserve
    spawn_release a interrupted SHIM_RESERVE_BARRIER="$W/barrier" SHIM_FAULTS="$faults" -- server publish --version 1.0.0
    pid=$LAST_PID
    wait_file "$W/barrier/reserve.ready" || true
    tag_sha="$(remote_ref "refs/tags/$TAG")"
    expect_eq "$variant: origin accepted the tag at the merge commit" "$MERGE" "$tag_sha"
    kill -TERM "$pid"
    sleep 1
    : >"$W/barrier/go"
    wait_exit "$pid" || true
    OUT="$W/interrupted.out"
    expect_eq "$variant: interrupted run exits 143" 143 "$RC"
    expect "$variant: nothing built" no_builds
    if [[ "$variant" == readable ]]; then
      expect_out "$variant: origin decides the result" "the reservation happened"
      expect_out "$variant: resume is suggested" "scripts/release.sh server publish --resume 1.0.0"
      expect "$variant: lease released" no_leases
    else
      expect_out "$variant: the result is reported as unknown" "The reservation result is unknown"
      expect_out "$variant: the reserved check is printed" "the reservation happened: run"
      expect_out "$variant: the not-reserved check is printed" "is absent, nothing was tagged or published"
    fi
  done
}

# A resume over an existing image with the right label still fails, because
# the label does not prove the content.
case_resume_does_not_trust_label() {
  world resume-label merged
  fail_publish start remote-digest-mismatch
  expect_rc_nonzero "publish with a digest mismatch"
  local registry_before digest
  registry_before="$(cat "$W/docker/registry/$IMAGE_KEY")"
  digest="${registry_before%% *}"
  run_release a resume -- server publish --resume 1.0.0
  expect_rc_nonzero "resume over an image whose label matches"
  expect_out "resume says the content cannot be verified" "this run cannot verify its content"
  expect_out "resume prints the registry digest" "registry digest: $digest"
  expect_out "resume prints the revision label" "org.opencontainers.image.revision: $MERGE"
  expect_no_out "resume does not claim the release is done" "Released server 1.0.0"
  expect_no_out "resume does not suggest resuming again" "After fixing the cause, run:"
  expect_eq "resume built nothing" 1 "$(count_lines "$W/docker/builds")"
  expect_eq "registry unchanged" "$registry_before" "$(cat "$W/docker/registry/$IMAGE_KEY")"
  expect "lease released" no_leases
}

ALL_CASES=(
  case_usage
  case_agent_signing
  case_prepare_preview
  case_prepare_success
  case_prepare_version_rules
  case_prepare_refusals
  case_prepare_failure_before_push
  case_prepare_lost_push_response
  case_prepare_lost_pr_response
  case_prepare_recovery_after_main_moved
  case_prepare_recovery_later_date
  case_prepare_foreign_branch
  case_prepare_ignores_fork_pr
  case_prepare_concurrent
  case_publish_preview
  case_publish_success
  case_publish_preflight
  case_registry_checks
  case_publish_after_main_moved
  case_publish_source_rules
  case_publish_reverted
  case_publish_fork_pr
  case_publish_deleted_head_branch
  case_publish_ci_evidence
  case_publish_ci_changes_during_lease_wait
  case_concurrent_publishes
  case_concurrent_publishes_different_versions
  case_lease_after_other_publish
  case_publish_vs_resume
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
  case_resume_source_checks
  case_resume_recheck_after_lease
  case_origin_down_after_lease
  case_interrupt_after_reservation_accepted
  case_resume_does_not_trust_label
)

if [[ -n "${RELEASE_TEST_CASES:-}" ]]; then
  read -r -a selected <<<"$RELEASE_TEST_CASES"
else
  selected=("${ALL_CASES[@]}")
fi
for case_name in "${selected[@]}"; do
  "$case_name"
done

printf 'release tests: %d failure(s) in %ds\n' "$failures" "$((SECONDS - started_at))" >&2
((failures == 0))
