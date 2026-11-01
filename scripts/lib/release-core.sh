# shellcheck shell=bash
# Release workflow for scripts/release.sh. Source this file; do not run it.
#
# A release has two commands. `prepare` (release-prepare.sh) opens a pull
# request with the version and changelog change; it never merges and never
# pushes main. After that pull request is merged, `publish` releases its merge
# commit:
#   1. Preflight, read-only: no branch, tag, lease, or image changes. The
#      source is the merge commit of the single merged release pull request,
#      never the tip of main (release-github.sh), and it needs CI evidence.
#   2. Publish lease: refs/release-leases/active on origin, created only when
#      absent. One ref for every target and version, so only one release runs.
#   3. Recheck: the tag is still absent and the source still resolves to the
#      same commit with the same evidence.
#   4. Reservation: a push of the tag only, created at the source commit.
#   5. Publish: build from the tag SHA in a fresh detached worktree, push, verify.
# The exit handler waits for publishing children, then releases the lease with
# a lease on its own SHA, and prints any state that needs manual action.

RELEASE_REMOTE=origin
RELEASE_MAIN=main
RELEASE_LEASE_NS=refs/release-leases
# The single publish lease. The lease commit records the target, tag, and owner.
RELEASE_LEASE_REF="$RELEASE_LEASE_NS/active"
RELEASE_IMAGE_REPO=ghcr.io/shlomiporush/mashkif
RELEASE_DOCKERFILE=config/docker/app.Dockerfile
RELEASE_REVISION_LABEL=org.opencontainers.image.revision

# Run state, read by the exit handler.
REL_TARGET=""
REL_VERSION=""
REL_TAG=""
REL_MODE=""             # prepare | publish | resume
REL_PREVIEW=0
REL_VERSION_FILE=""
REL_CHANGELOG=""
REL_LEASE_REF=""
REL_LEASE_SHA=""
REL_LEASE_STATE=none    # none | pending | held | unknown | released | release-failed
REL_MAIN_SHA=""         # origin/main as last fetched
REL_RESOLVED_SHA=""     # the source commit found by release_resolve_source
REL_RESERVE_TRIED=0
REL_RESERVED=no         # no | pending | yes | unconfirmed | unknown | foreign
REL_MANUAL_CHECK=0
REL_SOURCE_SHA=""
REL_PUBLISHED=0
REL_LEASE_ACQUIRED=0
REL_RUN_DIR=""
REL_WORKTREE=""
REL_CHILD_PIDS=()
REL_IMAGE_DIGEST=""

rgit() {
  git -C "$MASHKIF_ROOT" "$@"
}

# ---------------------------------------------------------------------------
# Targets

# release_target_setup <target>: sets the tag prefix, version file, and changelog.
release_target_setup() {
  case "$1" in
    agent)
      REL_VERSION_FILE=agent/Directory.Build.props
      REL_CHANGELOG=agent/CHANGELOG.md
      ;;
    server)
      REL_VERSION_FILE=server/package.json
      REL_CHANGELOG=server/CHANGELOG.md
      ;;
    *) return 1 ;;
  esac
  REL_TARGET="$1"
}

# release_signing_available <target>: agent releases ship a signed MSI only.
# Code signing is deferred (docs/project-foundation.md, "Code signing"), so the
# agent target refuses before anything changes. When signing exists, this check
# verifies the signing setup, and release_publish_agent signs the MSI before
# any upload; there is no path that publishes an unsigned MSI.
release_signing_available() {
  case "$1" in
    agent)
      fail "the agent target is not available yet: an agent release publishes a signed MSI, and code signing is not set up (see \"Code signing\" in docs/project-foundation.md). Nothing was changed."
      return 1
      ;;
    *) return 0 ;;
  esac
}

# ---------------------------------------------------------------------------
# Versions and changelog

release_is_semver() {
  [[ "$1" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]
}

# release_version_gt <a> <b>: true when a > b. Both must be X.Y.Z. Components
# are compared as digit strings (length, then lexicographically after leading
# zeros are stripped), never as Bash integers, which overflow.
release_version_gt() {
  local -a a b
  local i x y
  IFS=. read -r -a a <<<"$1"
  IFS=. read -r -a b <<<"$2"
  for i in 0 1 2; do
    x="${a[i]}" y="${b[i]}"
    while [[ ${#x} -gt 1 && "$x" == 0* ]]; do x="${x#0}"; done
    while [[ ${#y} -gt 1 && "$y" == 0* ]]; do y="${y#0}"; done
    if ((${#x} != ${#y})); then
      ((${#x} > ${#y}))
      return
    elif [[ "$x" > "$y" ]]; then
      return 0
    elif [[ "$x" < "$y" ]]; then
      return 1
    fi
  done
  return 1
}

# release_read_version <target>: reads the version from stdin (version file content).
release_read_version() {
  local content count
  content="$(cat)"
  case "$1" in
    server)
      count="$(grep -cE '^  "version": "[^"]*",?$' <<<"$content" || true)"
      [[ "$count" == 1 ]] || return 1
      sed -nE 's/^  "version": "([^"]*)",?$/\1/p' <<<"$content"
      ;;
    agent)
      count="$(grep -cE '<Version>[^<]*</Version>' <<<"$content" || true)"
      [[ "$count" == 1 ]] || return 1
      sed -nE 's#.*<Version>([^<]*)</Version>.*#\1#p' <<<"$content"
      ;;
  esac
}

# release_write_version <target> <version>: filters stdin to stdout.
release_write_version() {
  case "$1" in
    server) sed -E "s/^(  \"version\": \")[^\"]*(\",?)\$/\\1$2\\2/" ;;
    agent) sed -E "s#(<Version>)[^<]*(</Version>)#\\1$2\\2#" ;;
  esac
}

# release_changelog_check <version>: validates the changelog on stdin. The
# Unreleased section must exist once and have content; the version must be new.
release_changelog_check() {
  awk -v version="$1" '
    $0 == "## [Unreleased]" { unreleased++; inside = 1; next }
    /^## / {
      inside = 0
      if (index($0, "## [" version "]") == 1) duplicate = 1
      next
    }
    inside && NF { content = 1 }
    END {
      if (unreleased != 1) { print "it must contain exactly one \"## [Unreleased]\" line"; exit 1 }
      if (duplicate) { print "it already has a section for " version; exit 1 }
      if (!content) { print "its Unreleased section is empty; record the changes before releasing"; exit 1 }
    }
  '
}

# release_changelog_promote <version> <date>: filters stdin to stdout. Turns
# Unreleased into "## [version] - date" under a fresh, empty Unreleased.
release_changelog_promote() {
  awk -v heading="## [$1] - $2" '
    $0 == "## [Unreleased]" { print; print ""; print heading; next }
    { print }
  '
}

# release_has_section <rev>: true when the changelog at <rev> has a section
# for the release version.
release_has_section() {
  rgit show "$1:$REL_CHANGELOG" 2>/dev/null |
    awk -v heading="## [$REL_VERSION]" 'index($0, heading) == 1 { found = 1 } END { exit !found }'
}

# ---------------------------------------------------------------------------
# Remote reads

# release_remote_ref <ref>: prints the SHA of an exact ref on origin. For an
# annotated tag it prints the peeled commit. Returns 0 found, 1 absent,
# 2 origin could not be read.
release_remote_ref() {
  local ref="$1" out rc
  out="$(rgit ls-remote --exit-code "$RELEASE_REMOTE" "$ref" "$ref^{}" 2>/dev/null)"
  rc=$?
  if ((rc == 2)); then
    return 1
  elif ((rc != 0)); then
    return 2
  fi
  awk -v ref="$ref" '
    $2 == ref "^{}" { peeled = $1 }
    $2 == ref { direct = $1 }
    END {
      if (peeled != "") print peeled
      else if (direct != "") print direct
      else exit 1
    }
  ' <<<"$out"
}

# release_remote_leases: prints "<sha> <ref>" for every lease on origin.
# Returns 0 when at least one exists, 1 when none, 2 when origin could not be read.
release_remote_leases() {
  local out rc
  out="$(rgit ls-remote --exit-code "$RELEASE_REMOTE" "$RELEASE_LEASE_NS/*" 2>/dev/null)"
  rc=$?
  if ((rc == 2)); then
    return 1
  elif ((rc != 0)); then
    return 2
  fi
  awk -v ns="$RELEASE_LEASE_NS/" 'index($2, ns) == 1 { print $1, $2; found = 1 } END { exit !found }' <<<"$out"
}

release_lease_delete_command() {
  printf 'git push --porcelain --force-with-lease=%s:%s %s :%s' "$1" "$2" "$RELEASE_REMOTE" "$1"
}

# release_show_lease <ref> <sha>: prints the lease owner and the manual recovery.
# The lease commit is read through a temporary bare repository, so this
# repository does not change, also in preview.
release_show_lease() {
  local ref="$1" sha="$2" url tmp details=""
  url="$(rgit remote get-url "$RELEASE_REMOTE" 2>/dev/null)" || url=""
  if [[ -n "$url" && "$url" != *:* && "$url" != /* ]]; then
    url="$MASHKIF_ROOT/$url"
  fi
  if [[ -n "$url" ]] && tmp="$(mashkif_mktemp release-lease-owner 2>/dev/null)"; then
    if git init -q --bare "$tmp/repo" >/dev/null 2>&1 &&
      git -C "$tmp/repo" fetch -q --no-tags --no-write-fetch-head "$url" "$ref" >/dev/null 2>&1; then
      details="$(git -C "$tmp/repo" cat-file commit "$sha" 2>/dev/null | sed '1,/^$/d' | grep -E '^(target|tag|owner|host|user|pid|started|mode): ')" || details=""
    fi
    rm -rf -- "$tmp"
  fi
  log "  lease: $ref -> $sha"
  if [[ -n "$details" ]]; then
    printf '%s\n' "$details" | sed 's/^/    /' >&2
  else
    log "    owner and start time could not be read"
  fi
  log "  Only the owning run removes its lease. If that run crashed: on its host, confirm that no"
  log "  release.sh, docker push, or gh release process is still running, then delete the lease with:"
  log "    $(release_lease_delete_command "$ref" "$sha")"
  log "  If you cannot confirm that, leave the lease in place."
}

# release_refuse_if_leased: preflight check that origin holds no lease at all.
release_refuse_if_leased() {
  local leases rc sha ref
  leases="$(release_remote_leases)"
  rc=$?
  if ((rc == 2)); then
    fail "cannot read release leases from $RELEASE_REMOTE"
    return "$MASHKIF_EXIT_ENV"
  elif ((rc == 0)); then
    fail "a release lease exists on $RELEASE_REMOTE; no release can start or resume while one is held:"
    while read -r sha ref; do
      release_show_lease "$ref" "$sha"
    done <<<"$leases"
    return 1
  fi
}

# ---------------------------------------------------------------------------
# Pushes

# release_push <out-file> <git push arguments>: runs a porcelain push without
# following tags. Standard output goes to <out-file>, standard error to the log.
release_push() {
  local out="$1"
  shift
  # git, not the rgit function: a redirected function call keeps its
  # redirections while a pending signal trap runs, which would send the exit
  # handler's messages into these files.
  git -C "$MASHKIF_ROOT" push --porcelain --no-follow-tags "$@" >"$out" 2>"$out.err"
}

# release_flag <out-file> <dst-ref>: prints the porcelain status flag for <dst-ref>.
release_flag() {
  awk -F '\t' -v dst=":$2" '
    NF >= 2 && length($2) >= length(dst) && substr($2, length($2) - length(dst) + 1) == dst {
      print substr($1, 1, 1); exit
    }
  ' "$1"
}

release_push_details() {
  sed 's/^/    /' "$1" "$1.err" >&2 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# Lease

release_new_lease_commit() {
  local tree token host user started
  tree="$(rgit mktree </dev/null)" || return 1
  token="$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')" || return 1
  host="$(uname -n)"
  user="$(id -un 2>/dev/null || printf 'unknown')"
  started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf 'Release lease for %s\n\ntarget: %s\ntag: %s\nowner: %s/%s/%s\nhost: %s\nuser: %s\npid: %s\nstarted: %s\nmode: %s\n' \
    "$REL_TAG" "$REL_TARGET" "$REL_TAG" "$host" "$user" "$token" "$host" "$user" "$$" "$started" "$REL_MODE" |
    rgit commit-tree "$tree"
}

# release_resolve_lease: decides lease ownership from origin after a lost,
# ambiguous, or interrupted lease push. Our lease is a ref at our lease SHA.
release_resolve_lease() {
  local sha rc
  sha="$(release_remote_ref "$REL_LEASE_REF")"
  rc=$?
  if ((rc == 0)) && [[ "$sha" == "$REL_LEASE_SHA" ]]; then
    REL_LEASE_STATE=held
    return 0
  elif ((rc == 0)); then
    REL_LEASE_STATE=none
    fail "the lease is held by another run"
    release_show_lease "$REL_LEASE_REF" "$sha"
    return 1
  elif ((rc == 1)); then
    REL_LEASE_STATE=none
    fail "the lease was not created"
    return 1
  fi
  REL_LEASE_STATE=unknown
  fail "cannot read $REL_LEASE_REF from $RELEASE_REMOTE, so lease ownership is unknown"
  return 1
}

release_acquire_lease() {
  local out rc flag
  REL_LEASE_REF="$RELEASE_LEASE_REF"
  REL_LEASE_SHA="$(release_new_lease_commit)" || {
    fail "could not create the lease commit"
    return 1
  }
  out="$REL_RUN_DIR/lease-push"
  # The exit handler is already installed; from here on it resolves the lease.
  REL_LEASE_STATE=pending
  release_push "$out" "--force-with-lease=$REL_LEASE_REF:" "$RELEASE_REMOTE" "$REL_LEASE_SHA:$REL_LEASE_REF"
  rc=$?
  flag="$(release_flag "$out" "$REL_LEASE_REF")"
  if ((rc == 0)) && [[ "$flag" == "*" ]]; then
    REL_LEASE_STATE=held
    REL_LEASE_ACQUIRED=1
    log "Acquired $REL_LEASE_REF ($REL_LEASE_SHA)."
  elif [[ "$flag" == "!" ]]; then
    REL_LEASE_STATE=none
    fail "another release run holds the publish lease $REL_LEASE_REF"
    local sha
    if sha="$(release_remote_ref "$REL_LEASE_REF")"; then
      release_show_lease "$REL_LEASE_REF" "$sha"
    fi
    rm -f -- "$out" "$out.err"
    return 1
  else
    log "The lease push gave no clear answer (exit $rc, status '${flag:-none}'); reading $RELEASE_REMOTE."
    if ! release_resolve_lease; then
      rm -f -- "$out" "$out.err"
      return 1
    fi
    REL_LEASE_ACQUIRED=1
    log "Origin shows our lease; continuing."
  fi
  rm -f -- "$out" "$out.err"
}

# release_release_lease: deletes our lease only while it still points at our SHA.
release_release_lease() {
  local out rc flag sha
  out="$REL_RUN_DIR/lease-release"
  release_push "$out" "--force-with-lease=$REL_LEASE_REF:$REL_LEASE_SHA" "$RELEASE_REMOTE" ":$REL_LEASE_REF"
  rc=$?
  flag="$(release_flag "$out" "$REL_LEASE_REF")"
  if ((rc == 0)) && [[ "$flag" == "-" ]]; then
    REL_LEASE_STATE=released
    log "Released $REL_LEASE_REF."
    rm -f -- "$out" "$out.err"
    return 0
  fi
  sha="$(release_remote_ref "$REL_LEASE_REF")"
  case $? in
    1)
      REL_LEASE_STATE=released
      log "Released $REL_LEASE_REF (confirmed by reading $RELEASE_REMOTE)."
      rm -f -- "$out" "$out.err"
      return 0
      ;;
    0)
      if [[ "$sha" != "$REL_LEASE_SHA" ]]; then
        REL_LEASE_STATE=released
        fail "$REL_LEASE_REF now points at $sha, not at this run's lease; it was left untouched"
        rm -f -- "$out" "$out.err"
        return 1
      fi
      ;;
  esac
  REL_LEASE_STATE=release-failed
  fail "could not delete the publish lease $REL_LEASE_REF (lease commit $REL_LEASE_SHA):"
  release_push_details "$out"
  log "  No other release can start or resume until it is deleted. Delete it with:"
  log "    $(release_lease_delete_command "$REL_LEASE_REF" "$REL_LEASE_SHA")"
  rm -f -- "$out" "$out.err"
  return 1
}

# ---------------------------------------------------------------------------
# Exit handling

# release_run_child <command...>: runs a publishing command as a recorded child,
# so the exit handler can wait for it before releasing the lease.
# Whatever a child does on Ctrl-C or TERM (Bash starts background children with
# SIGINT ignored, but a program may install its own handler), the exit handler
# waits for it to end before it touches the lease.
release_run_child() {
  "$@" &
  local pid=$! rc=0
  REL_CHILD_PIDS=("$pid")
  wait "$pid" || rc=$?
  # Reaped: forget the PID, so a reused PID is never waited for.
  REL_CHILD_PIDS=()
  return "$rc"
}

release_wait_children() {
  local pid
  for pid in "${REL_CHILD_PIDS[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then
      log "Waiting for publishing process $pid to end before releasing the lease."
    fi
    while kill -0 "$pid" 2>/dev/null; do
      wait "$pid" 2>/dev/null
      # 127: not a child of this shell; nothing to wait for.
      (($? != 127)) || break
    done
  done
  REL_CHILD_PIDS=()
}

release_cleanup_worktree() {
  if [[ -n "$REL_WORKTREE" && -e "$REL_WORKTREE" ]]; then
    rgit worktree remove --force "$REL_WORKTREE" >/dev/null 2>&1 ||
      log "note: could not remove the build worktree $REL_WORKTREE (git worktree remove --force)"
  fi
  rgit worktree prune >/dev/null 2>&1 || true
  if [[ -n "$REL_RUN_DIR" && -d "$REL_RUN_DIR" ]]; then
    rm -rf -- "$REL_RUN_DIR"
  fi
}

release_print_recovery() {
  local rc="$1"
  if [[ "$REL_MODE" == prepare ]]; then
    release_prepare_print_recovery "$rc"
    return
  fi
  if ((REL_RESERVE_TRIED)) && [[ "$REL_RESERVED" != yes ]]; then
    log ""
    case "$REL_RESERVED" in
      unknown)
        log "The reservation result is unknown: $RELEASE_REMOTE could not be read after the tag push."
        log "Check it with: git ls-remote $RELEASE_REMOTE refs/tags/$REL_TAG"
        log "If refs/tags/$REL_TAG points at $REL_SOURCE_SHA, the reservation happened: run"
        log "  scripts/release.sh $REL_TARGET publish --resume $REL_VERSION"
        log "If refs/tags/$REL_TAG is absent, nothing was tagged or published: run"
        log "  scripts/release.sh $REL_TARGET publish --version $REL_VERSION"
        ;;
      unconfirmed)
        log "refs/tags/$REL_TAG is at the source commit $REL_SOURCE_SHA, but this run cannot confirm that it created it."
        log "Publish it with: scripts/release.sh $REL_TARGET publish --resume $REL_VERSION"
        log "Resume checks the tag, the release pull request, $RELEASE_MAIN, and CI again before publishing."
        ;;
      foreign)
        log "refs/tags/$REL_TAG already existed on $RELEASE_REMOTE and was not created by this run."
        log "This run published nothing. Inspect the tag with: git ls-remote $RELEASE_REMOTE refs/tags/$REL_TAG"
        log "If the tag is the intended release, publish it with: scripts/release.sh $REL_TARGET publish --resume $REL_VERSION"
        ;;
      *)
        log "The tag $REL_TAG was not created; this run tagged and published nothing."
        log "Check the tag with: git ls-remote $RELEASE_REMOTE refs/tags/$REL_TAG"
        ;;
    esac
  fi
  if ((rc != 0)) && ((!REL_PUBLISHED)) && ((!REL_MANUAL_CHECK)) &&
    [[ "$REL_RESERVED" == yes || ("$REL_MODE" == resume && "$REL_LEASE_ACQUIRED" == 1) ]]; then
    log ""
    log "The tag $REL_TAG is reserved, but its artifacts are not all published."
    log "After fixing the cause, run: scripts/release.sh $REL_TARGET publish --resume $REL_VERSION"
  fi
}

# shellcheck disable=SC2317,SC2329 # Invoked through the EXIT trap.
release_on_exit() {
  local rc=$?
  set +e
  trap - EXIT
  trap '' INT TERM
  release_wait_children
  if [[ "$REL_RESERVED" == pending ]]; then
    log "Interrupted during the reservation push; reading $RELEASE_REMOTE to decide its result."
    release_resolve_reservation
  fi
  case "$REL_LEASE_STATE" in
    pending)
      if release_resolve_lease 2>/dev/null; then
        release_release_lease || rc=1
      elif [[ "$REL_LEASE_STATE" == unknown ]]; then
        rc=1
      fi
      ;;
    held) release_release_lease || { ((rc)) || rc=1; } ;;
  esac
  if [[ "$REL_LEASE_STATE" == unknown ]]; then
    fail "the publish lease may exist: $REL_LEASE_REF -> $REL_LEASE_SHA"
    log "  Check it with: git ls-remote $RELEASE_REMOTE $REL_LEASE_REF"
    log "  If it points at $REL_LEASE_SHA, it belongs to this run. Delete it with:"
    log "    $(release_lease_delete_command "$REL_LEASE_REF" "$REL_LEASE_SHA")"
  fi
  release_cleanup_worktree
  release_print_recovery "$rc"
  release_prepare_unlock
  exit "$rc"
}

release_install_traps() {
  trap release_on_exit EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
}

# ---------------------------------------------------------------------------
# Preflight

release_check_clean() {
  local status
  status="$(rgit --no-optional-locks status --porcelain --untracked-files=normal)" || {
    fail "cannot read the working tree status"
    return "$MASHKIF_EXIT_ENV"
  }
  if [[ -n "$status" ]]; then
    fail "the working tree is not clean; commit or remove these changes first:"
    printf '%s\n' "$status" | sed 's/^/    /' >&2
    return 1
  fi
}

release_check_tools() {
  require_cmd git || return
  require_cmd gh "install the GitHub CLI in WSL and sign in with: gh auth login" || return
  if [[ "$REL_MODE" == prepare ]]; then
    require_cmd flock "util-linux; prepare holds a local lock" || return
    return 0
  fi
  if [[ "$REL_TARGET" == server ]]; then
    require_cmd docker "the server target builds and pushes a container image" || return
    if ! docker buildx version >/dev/null 2>&1; then
      fail "docker buildx is required to inspect registry images"
      return "$MASHKIF_EXIT_ENV"
    fi
  fi
}

# release_version_at <rev>: prints the target version recorded at <rev>.
release_version_at() {
  local version
  if ! version="$(rgit show "$1:$REL_VERSION_FILE" 2>/dev/null | release_read_version "$REL_TARGET")" ||
    [[ -z "$version" ]]; then
    fail "cannot read the version from $REL_VERSION_FILE at $1"
    return 1
  fi
  printf '%s\n' "$version"
}

release_image_ref() {
  printf '%s:%s' "$RELEASE_IMAGE_REPO" "$REL_VERSION"
}

# release_image_state <sha>: prints absent, match, or mismatch for the image
# tag of this version. Returns 2 when the registry cannot be read.
release_image_state() {
  local ref out rc revisions
  ref="$(release_image_ref)"
  # Output and errors are captured together, so preview creates no files.
  out="$(docker buildx imagetools inspect --format '{{json .Image}}' "$ref" 2>&1)"
  rc=$?
  if ((rc != 0)); then
    if grep -qE ': not found$|manifest unknown|MANIFEST_UNKNOWN|NAME_UNKNOWN|name unknown' <<<"$out"; then
      printf 'absent\n'
      return 0
    fi
    fail "cannot check whether $ref exists: $(head -n 1 <<<"$out")"
    log "  Sign in first with: docker login ghcr.io"
    return "$MASHKIF_EXIT_ENV"
  fi
  revisions="$(printf '%s' "$out" | tr -d ' \t\r\n' |
    grep -oE "\"${RELEASE_REVISION_LABEL//./\\.}\":\"[^\"]*\"" | sed -E 's/.*:"([^"]*)"$/\1/' | sort -u)"
  if [[ "$revisions" == "$1" ]]; then
    printf 'match\n'
  else
    log "  $ref exists with revision label: ${revisions:-none}"
    printf 'mismatch\n'
  fi
}

# release_obtain_version: --version, or a prompt on a terminal.
release_obtain_version() {
  if [[ -z "$REL_VERSION" ]]; then
    if [[ -t 0 ]]; then
      read -r -p "Version to release for $REL_TARGET (X.Y.Z): " REL_VERSION || true
    else
      fail "no version given: pass --version X.Y.Z"
      return "$MASHKIF_EXIT_ENV"
    fi
  fi
  if ! release_is_semver "$REL_VERSION"; then
    fail "invalid version '$REL_VERSION': expected X.Y.Z (SemVer core, no leading zeros, no prerelease or build suffix)"
    return "$MASHKIF_EXIT_ENV"
  fi
  REL_TAG="$REL_TARGET-v$REL_VERSION"
}

# release_fetch_main: fetches main from origin and sets REL_MAIN_SHA. Only the
# remote-tracking ref changes; no local branch, index, or working tree.
release_fetch_main() {
  local tracking="refs/remotes/$RELEASE_REMOTE/$RELEASE_MAIN"
  if ! rgit fetch -q --no-tags --no-write-fetch-head "$RELEASE_REMOTE" "+refs/heads/$RELEASE_MAIN:$tracking"; then
    fail "cannot fetch $RELEASE_MAIN from $RELEASE_REMOTE"
    return "$MASHKIF_EXIT_ENV"
  fi
  REL_MAIN_SHA="$(rgit rev-parse --verify -q "$tracking^{commit}")" || {
    fail "cannot read $tracking after fetching"
    return "$MASHKIF_EXIT_ENV"
  }
}

# release_check_tag_absent: the release tag exists neither locally nor on origin.
release_check_tag_absent() {
  local rc
  if rgit rev-parse -q --verify "refs/tags/$REL_TAG" >/dev/null; then
    fail "the tag $REL_TAG already exists locally"
    return 1
  fi
  release_remote_ref "refs/tags/$REL_TAG" >/dev/null
  rc=$?
  if ((rc == 0)); then
    fail "the tag $REL_TAG already exists on $RELEASE_REMOTE; to finish that release use: scripts/release.sh $REL_TARGET publish --resume $REL_VERSION"
    return 1
  elif ((rc == 2)); then
    fail "cannot read tags from $RELEASE_REMOTE"
    return "$MASHKIF_EXIT_ENV"
  fi
}

# release_resolve_source: finds the release source and sets REL_RESOLVED_SHA.
# - Source rule: the merge commit of the single merged release pull request,
#   an ancestor of the freshly fetched origin/main, carrying the version and a
#   changelog section for it. Later merges to main never change the source.
# - Revert rule: origin/main still has that changelog section and a version
#   not lower than the release, so a reverted release pull request refuses.
# - CI evidence for the source commit (release_ci_evidence).
# Runs before and after the lease.
release_resolve_source() {
  local sha version main_version
  REL_RESOLVED_SHA=""
  release_fetch_main || return
  release_find_merged_pr || return
  sha="$REL_PR_MERGE"
  if ! rgit cat-file -e "$sha^{commit}" 2>/dev/null ||
    ! rgit merge-base --is-ancestor "$sha" "$REL_MAIN_SHA" 2>/dev/null; then
    fail "the merge commit $sha of $REL_PR_URL is not on $RELEASE_REMOTE/$RELEASE_MAIN"
    return 1
  fi
  version="$(release_version_at "$sha")" || return 1
  if [[ "$version" != "$REL_VERSION" ]]; then
    fail "$REL_VERSION_FILE at the merge commit $sha of $REL_PR_URL says $version, not $REL_VERSION"
    return 1
  fi
  if ! release_has_section "$sha"; then
    fail "$REL_CHANGELOG at the merge commit $sha of $REL_PR_URL has no \"## [$REL_VERSION]\" section"
    return 1
  fi
  if ! release_has_section "$REL_MAIN_SHA"; then
    fail "$REL_CHANGELOG on $RELEASE_REMOTE/$RELEASE_MAIN ($REL_MAIN_SHA) no longer has the \"## [$REL_VERSION]\" section; the release looks reverted"
    return 1
  fi
  main_version="$(release_version_at "$REL_MAIN_SHA")" || return 1
  if ! release_is_semver "$main_version"; then
    fail "$REL_VERSION_FILE on $RELEASE_REMOTE/$RELEASE_MAIN ($REL_MAIN_SHA) says '$main_version', which is not X.Y.Z"
    return 1
  fi
  if release_version_gt "$REL_VERSION" "$main_version"; then
    fail "$REL_VERSION_FILE on $RELEASE_REMOTE/$RELEASE_MAIN ($REL_MAIN_SHA) says $main_version, lower than $REL_VERSION; the release looks reverted"
    return 1
  fi
  release_ci_evidence "$sha" || return
  REL_RESOLVED_SHA="$sha"
}

release_preflight_publish() {
  release_signing_available "$REL_TARGET" || return 1
  release_check_tools || return
  release_check_clean || return
  release_obtain_version || return
  release_repo_identity || return
  release_check_tag_absent || return
  release_refuse_if_leased || return
  release_preflight_artifacts_absent || return
  release_resolve_source || return
  REL_SOURCE_SHA="$REL_RESOLVED_SHA"
  log "Preflight passed: publish $REL_TARGET $REL_VERSION from $REL_SOURCE_SHA, the merge commit of $REL_PR_URL."
}

# release_recheck_after_lease: the preflight ran before the lease was held, so
# another run may have released in between, the release may have been
# reverted, or the CI evidence may have changed. Everything is read again.
release_recheck_after_lease() {
  local rc sha
  if [[ "$REL_MODE" == publish ]]; then
    release_remote_ref "refs/tags/$REL_TAG" >/dev/null
    rc=$?
    if ((rc == 0)); then
      fail "the tag $REL_TAG was created on $RELEASE_REMOTE while this run waited for the lease; nothing was changed"
      return 1
    fi
  else
    sha="$(release_remote_ref "refs/tags/$REL_TAG")"
    rc=$?
    if ((rc == 0)) && [[ "$sha" != "$REL_SOURCE_SHA" ]]; then
      fail "refs/tags/$REL_TAG moved from $REL_SOURCE_SHA to $sha while this run waited for the lease; stopping"
      return 1
    elif ((rc == 1)); then
      fail "refs/tags/$REL_TAG disappeared from $RELEASE_REMOTE while this run waited for the lease; stopping"
      return 1
    fi
  fi
  if ((rc == 2)); then
    fail "cannot read tags from $RELEASE_REMOTE after taking the lease"
    return "$MASHKIF_EXIT_ENV"
  fi
  release_resolve_source || return
  if [[ "$REL_RESOLVED_SHA" != "$REL_SOURCE_SHA" ]]; then
    fail "the release source changed from $REL_SOURCE_SHA to $REL_RESOLVED_SHA while this run waited for the lease; start again"
    return 1
  fi
  log "Rechecked after taking the lease: the source is still $REL_SOURCE_SHA."
}

release_preflight_artifacts_absent() {
  local state
  case "$REL_TARGET" in
    server)
      state="$(release_image_state "")" || return
      if [[ "$state" != absent ]]; then
        fail "$(release_image_ref) already exists; a published version is never overwritten"
        return 1
      fi
      ;;
  esac
}

# release_preflight_resume: the tag already exists on origin. It is published
# only when it points at the release pull request's merge commit and that
# commit passes the same source, revert, and CI checks as publish.
release_preflight_resume() {
  local rc
  release_signing_available "$REL_TARGET" || return 1
  release_check_tools || return
  release_check_clean || return
  release_obtain_version || return
  release_repo_identity || return
  REL_SOURCE_SHA="$(release_remote_ref "refs/tags/$REL_TAG")"
  rc=$?
  if ((rc == 1)); then
    fail "the tag $REL_TAG does not exist on $RELEASE_REMOTE; there is nothing to resume"
    return 1
  elif ((rc != 0)); then
    fail "cannot read tags from $RELEASE_REMOTE"
    return "$MASHKIF_EXIT_ENV"
  fi
  release_refuse_if_leased || return
  release_resolve_source || return
  if [[ "$REL_RESOLVED_SHA" != "$REL_SOURCE_SHA" ]]; then
    fail "refs/tags/$REL_TAG points at $REL_SOURCE_SHA, not at $REL_RESOLVED_SHA, the merge commit of $REL_PR_URL; it is not resumed"
    return 1
  fi
  log "Preflight passed: resume $REL_TAG at $REL_SOURCE_SHA, the merge commit of $REL_PR_URL."
}

# ---------------------------------------------------------------------------
# Reservation

# release_reserve: creates the tag at the source commit with a push of that
# tag only. Only porcelain status "*" (created) counts as this run's tag.
release_reserve() {
  local out rc tag_flag tag_ref="refs/tags/$REL_TAG"
  out="$REL_RUN_DIR/reservation-push"
  # Until the result is parsed, the exit handler reads origin to decide.
  REL_RESERVE_TRIED=1
  REL_RESERVED=pending
  release_push "$out" "$RELEASE_REMOTE" "$REL_SOURCE_SHA:$tag_ref"
  rc=$?
  tag_flag="$(release_flag "$out" "$tag_ref")"
  if ((rc == 0)) && [[ "$tag_flag" == "*" ]]; then
    REL_RESERVED=yes
  elif [[ "$tag_flag" == "=" ]]; then
    REL_RESERVED=foreign
    fail "the reservation did not create $tag_ref; it already existed on $RELEASE_REMOTE"
    release_push_details "$out"
  elif [[ "$tag_flag" == "!" ]]; then
    REL_RESERVED=no
    fail "$RELEASE_REMOTE rejected the creation of $tag_ref:"
    release_push_details "$out"
  else
    log "The reservation push gave no clear answer (exit $rc); reading $RELEASE_REMOTE."
    release_resolve_reservation
    [[ "$REL_RESERVED" != no ]] || release_push_details "$out"
  fi
  rm -f -- "$out" "$out.err"
  [[ "$REL_RESERVED" == yes ]] || return 1
  log "Reserved $tag_ref at $REL_SOURCE_SHA."
}

# release_resolve_reservation: decides the reservation from origin after a
# lost, ambiguous, or interrupted tag push. The source commit is the release
# pull request's merge commit, not unique to this run, so a tag at it may have
# been created by hand: without porcelain "*" it is never taken as this run's
# tag. The run stops, and --resume, which checks everything again, publishes.
release_resolve_reservation() {
  local tag_ref="refs/tags/$REL_TAG" tag_sha
  tag_sha="$(release_remote_ref "$tag_ref")"
  case $? in
    0)
      if [[ "$tag_sha" == "$REL_SOURCE_SHA" ]]; then
        REL_RESERVED=unconfirmed
        fail "origin shows $tag_ref at the source commit, but this run has no proof that it created the tag; nothing was published"
      else
        REL_RESERVED=foreign
        fail "$tag_ref on $RELEASE_REMOTE points at $tag_sha, not at the source commit $REL_SOURCE_SHA"
      fi
      ;;
    1)
      REL_RESERVED=no
      fail "the reservation did not happen: $tag_ref is absent on $RELEASE_REMOTE"
      ;;
    *)
      REL_RESERVED=unknown
      fail "cannot read $RELEASE_REMOTE after the reservation push"
      ;;
  esac
}

# release_verify_source: reads the tag SHA from origin after the reservation
# (or, for resume, after the lease), makes sure the commit is present locally,
# and checks that it is the source commit and carries the version.
release_verify_source() {
  local sha version
  sha="$(release_remote_ref "refs/tags/$REL_TAG")" || {
    fail "cannot read refs/tags/$REL_TAG from $RELEASE_REMOTE"
    return 1
  }
  if [[ "$sha" != "$REL_SOURCE_SHA" ]]; then
    fail "refs/tags/$REL_TAG points at $sha, not at the source commit $REL_SOURCE_SHA; stopping"
    return 1
  fi
  if ! rgit cat-file -e "$sha^{commit}" 2>/dev/null; then
    log "Fetching the tagged commit $sha."
    rgit fetch -q --no-tags --no-write-fetch-head "$RELEASE_REMOTE" "refs/tags/$REL_TAG" || {
      fail "cannot fetch refs/tags/$REL_TAG from $RELEASE_REMOTE"
      return 1
    }
  fi
  if [[ "$(rgit rev-parse --verify -q "$sha^{commit}")" != "$sha" ]]; then
    fail "the tagged commit $sha is not available locally after fetching"
    return 1
  fi
  version="$(release_version_at "$sha")" || return 1
  if [[ "$version" != "$REL_VERSION" ]]; then
    fail "$REL_VERSION_FILE at $sha says $version, not $REL_VERSION"
    return 1
  fi
}

# ---------------------------------------------------------------------------
# Publishing

# release_make_run_dir: per-run scratch directory under <scratch root>/release/.
# Holds push output and the build worktree; removed by the exit handler.
release_make_run_dir() {
  local root
  if ! root="$(mashkif_tmp_root)"; then
    fail "no scratch location: set MASHKIF_TMP_DIR (locally the T: drive is expected at /mnt/t)"
    return "$MASHKIF_EXIT_ENV"
  fi
  if ! mkdir -p "$root/release" || ! REL_RUN_DIR="$(mktemp -d "$root/release/$REL_TAG.XXXXXX")"; then
    fail "cannot create a scratch directory under $root/release"
    return "$MASHKIF_EXIT_ENV"
  fi
}

release_prepare_worktree() {
  REL_WORKTREE="$REL_RUN_DIR/src"
  rgit worktree add -q --detach "$REL_WORKTREE" "$1" || {
    fail "cannot create the build worktree at $REL_WORKTREE"
    return 1
  }
  if [[ "$(git -C "$REL_WORKTREE" rev-parse HEAD)" != "$1" ]]; then
    fail "the build worktree is not at $1"
    return 1
  fi
}

release_publish_server() {
  local sha="$1" ref state local_digest remote_digest
  ref="$(release_image_ref)"
  state="$(release_image_state "$sha")" || return 1
  case "$state" in
    match)
      # A matching revision label does not prove the content, and this run has
      # no locally built digest to compare with, so it never reports success.
      remote_digest="$(docker buildx imagetools inspect --format '{{.Manifest.Digest}}' "$ref" 2>/dev/null)" ||
        remote_digest="could not be read"
      fail "$ref already exists; this run cannot verify its content"
      log "  registry digest: $remote_digest"
      log "  $RELEASE_REVISION_LABEL: $sha"
      log "  A matching revision label does not prove the content. Check the digest by hand, for example"
      log "  against the digest the original run printed or a trusted build of $sha."
      log "  The image is never overwritten. If it is wrong, release a new version instead."
      REL_MANUAL_CHECK=1
      return 1
      ;;
    mismatch)
      fail "$ref exists but was not built from $sha; it is never overwritten"
      return 1
      ;;
  esac
  release_prepare_worktree "$sha" || return 1
  if [[ ! -f "$REL_WORKTREE/$RELEASE_DOCKERFILE" ]]; then
    fail "$RELEASE_DOCKERFILE does not exist at $sha"
    return 1
  fi
  log "Building $ref from $sha."
  if ! release_run_child docker build \
    --file "$REL_WORKTREE/$RELEASE_DOCKERFILE" \
    --label "$RELEASE_REVISION_LABEL=$sha" \
    --label "org.opencontainers.image.version=$REL_VERSION" \
    --provenance=false --sbom=false \
    --tag "$ref" \
    "$REL_WORKTREE"; then
    fail "docker build failed"
    return 1
  fi
  # The lease keeps other release runs out; this catches a manual push meanwhile.
  state="$(release_image_state "$sha")" || return 1
  if [[ "$state" != absent ]]; then
    fail "$ref appeared in the registry during the build; it is never overwritten"
    return 1
  fi
  log "Pushing $ref."
  if ! release_run_child docker push "$ref"; then
    fail "docker push failed"
    return 1
  fi
  local_digest="$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$ref" |
    awk -v prefix="$RELEASE_IMAGE_REPO@" 'index($0, prefix) == 1 { print substr($0, length(prefix) + 1) }' | sort -u)"
  if [[ ! "$local_digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
    fail "cannot read a single pushed digest for $ref from the local image (got '${local_digest//$'\n'/ }')"
    return 1
  fi
  remote_digest="$(docker buildx imagetools inspect --format '{{.Manifest.Digest}}' "$ref")" || {
    fail "cannot read the digest of $ref from the registry"
    return 1
  }
  if [[ "$remote_digest" != "$local_digest" ]]; then
    fail "the registry digest of $ref ($remote_digest) differs from the locally built digest ($local_digest)"
    return 1
  fi
  state="$(release_image_state "$sha")" || return 1
  if [[ "$state" != match ]]; then
    fail "the registry image $ref does not carry $RELEASE_REVISION_LABEL=$sha"
    return 1
  fi
  REL_IMAGE_DIGEST="$local_digest"
  REL_PUBLISHED=1
  log "Published $ref@$local_digest."
}

release_publish_agent() {
  # Unreachable until signing exists: release_signing_available refuses first.
  # The future flow builds the MSI in the worktree, signs it, verifies the
  # signature, and only then uploads it with its checksum.
  fail "agent publishing requires code signing, which is not set up"
  return 1
}

release_publish() {
  "release_publish_$REL_TARGET" "$REL_SOURCE_SHA"
}

# ---------------------------------------------------------------------------
# Preview

release_print_preview() {
  local state
  log ""
  log "Preview only: no branch, tag, lease, pull request, or image was changed."
  if [[ "$REL_MODE" == publish ]]; then
    log "A publish would:"
    log "  1. create the publish lease $RELEASE_LEASE_REF on $RELEASE_REMOTE, recording $REL_TAG"
    log "  2. read the tag, the release pull request, $RELEASE_MAIN, and CI again"
    log "  3. push refs/tags/$REL_TAG at $REL_SOURCE_SHA, the merge commit of $REL_PR_URL"
    log "  4. build and push $(release_image_ref) from the tag commit, then verify its digest"
    log "  5. release the lease"
  else
    state="$(release_image_state "$REL_SOURCE_SHA")" || return
    log "A resume would build from $REL_SOURCE_SHA (refs/tags/$REL_TAG) under a new lease."
    log "  $(release_image_ref): $state"
  fi
}

# ---------------------------------------------------------------------------
# Entry

release_main() {
  if [[ "$REL_MODE" == prepare ]]; then
    # Called in a || list like every other step, so its expected non-zero
    # statuses (an absent ref, for example) are handled, not fatal.
    release_prepare_main || return
    return 0
  fi
  if ((REL_PREVIEW)); then
    if [[ "$REL_MODE" == publish ]]; then
      release_preflight_publish || return
    else
      release_preflight_resume || return
    fi
    release_print_preview
    return
  fi

  # Installed before the lease push, so an interrupted run resolves its lease.
  release_install_traps
  if [[ "$REL_MODE" == publish ]]; then
    release_preflight_publish || return
  else
    release_preflight_resume || return
  fi
  release_make_run_dir || return
  release_acquire_lease || return 1
  release_recheck_after_lease || return
  if [[ "$REL_MODE" == publish ]]; then
    release_reserve || return 1
  fi
  release_verify_source || return 1
  release_publish || return 1
  log ""
  log "Released $REL_TARGET $REL_VERSION from $REL_SOURCE_SHA (tag $REL_TAG)."
  if [[ -n "$REL_IMAGE_DIGEST" ]]; then
    log "  image: $(release_image_ref)@$REL_IMAGE_DIGEST"
  fi
  if [[ "$REL_MODE" == publish ]]; then
    log "  No local tag was created; fetch it with: git fetch $RELEASE_REMOTE tag $REL_TAG"
  fi
}
