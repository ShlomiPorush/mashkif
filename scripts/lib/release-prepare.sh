# shellcheck shell=bash
# shellcheck disable=SC2034 # The REL_* variables set here are read by release-core.sh.
# The prepare command of scripts/release.sh. Source this file; do not run it.
#
# prepare opens the release pull request: one commit on a fresh
# release/<target>-vX.Y.Z branch from origin/main that changes only the version
# file and the changelog. It never merges, never pushes main, and never uses the
# user's checkout, branch, or index: the commit is made in a fresh detached
# worktree under the scratch root.
#
# A rerun after a partial failure resolves the state instead of starting over:
# a remote release branch is reused, without a new push, when its single commit
# is exactly the expected change of its parent (with the changelog date recorded
# in that commit) and the parent is still on origin/main. An open pull request
# for that commit is reused; otherwise one is opened.

REL_PREP_BRANCH=""
REL_PREP_COMMIT=""
REL_PREP_PUSHED=no      # no | pending | yes | unknown
REL_PREP_REUSED=0
REL_PREP_PR_URL=""
REL_PREP_LOCK_FD=""

# release_state_dir: per-user tool state, outside every checkout.
release_state_dir() {
  printf '%s/mashkif\n' "${XDG_STATE_HOME:-$HOME/.local/state}"
}

# release_prepare_lock: an exclusive, non-blocking flock for this user, held
# until the exit handler releases it (after the branch is pushed and the pull request
# exists). A second prepare fails fast instead of waiting.
release_prepare_lock() {
  local dir file
  dir="$(release_state_dir)"
  file="$dir/release-prepare.lock"
  if ! mkdir -p "$dir" || ! exec {REL_PREP_LOCK_FD}>>"$file"; then
    fail "cannot open the prepare lock $file"
    return "$MASHKIF_EXIT_ENV"
  fi
  if ! flock -n "$REL_PREP_LOCK_FD"; then
    fail "another 'scripts/release.sh prepare' is running for this user (lock: $file); let it finish, then run this again"
    return 1
  fi
}

# release_prepare_unlock: releases the prepare lock explicitly, from the exit
# handler after the cleanup. A flock belongs to the open file description, so
# this also frees it for a child that inherited the descriptor and outlives
# the run (for example a detached `git gc --auto`). The lock file stays.
release_prepare_unlock() {
  [[ -n "$REL_PREP_LOCK_FD" ]] || return 0
  flock -u "$REL_PREP_LOCK_FD" 2>/dev/null || true
  exec {REL_PREP_LOCK_FD}>&-
  REL_PREP_LOCK_FD=""
}

# release_render <base-rev> <date> <path>: prints the expected release content
# of <path> (the version file or the changelog) derived from <base-rev>.
release_render() {
  case "$3" in
    "$REL_VERSION_FILE") rgit show "$1:$3" | release_write_version "$REL_TARGET" "$REL_VERSION" ;;
    "$REL_CHANGELOG") rgit show "$1:$3" | release_changelog_promote "$REL_VERSION" "$2" ;;
    *) return 1 ;;
  esac
}

# release_prepare_check_base <rev> <label>: the version at <rev> is lower than
# the release version and its Unreleased section can be promoted.
release_prepare_check_base() {
  local current notes
  current="$(release_version_at "$1")" || return 1
  if ! release_is_semver "$current"; then
    fail "the $REL_TARGET version '$current' in $REL_VERSION_FILE at $2 is not X.Y.Z"
    return 1
  fi
  if ! release_version_gt "$REL_VERSION" "$current"; then
    fail "version $REL_VERSION is not greater than the $REL_TARGET version $current at $2"
    return 1
  fi
  if ! notes="$(rgit show "$1:$REL_CHANGELOG" 2>/dev/null | release_changelog_check "$REL_VERSION")"; then
    fail "$REL_CHANGELOG at $2 cannot be promoted: ${notes:-it is missing}"
    return 1
  fi
}

# release_prepare_changed_files <commit>: the sorted paths a commit changes.
release_prepare_changed_files() {
  rgit diff-tree --no-commit-id --name-only -r "$1" | LC_ALL=C sort | tr '\n' ' '
}

release_prepare_expected_files() {
  printf '%s\n' "$REL_VERSION_FILE" "$REL_CHANGELOG" | LC_ALL=C sort | tr '\n' ' '
}

# release_prepare_check_branch <sha>: decides whether an existing remote release
# branch at <sha> holds exactly the commit prepare would have made.
release_prepare_check_branch() {
  local tip="$1" ref="refs/heads/$REL_PREP_BRANCH" parent dates date path want have
  local -a parents=()
  if ! rgit cat-file -e "$tip^{commit}" 2>/dev/null; then
    rgit fetch -q --no-tags --no-write-fetch-head "$RELEASE_REMOTE" "$ref" || {
      fail "cannot fetch $ref from $RELEASE_REMOTE"
      return "$MASHKIF_EXIT_ENV"
    }
  fi
  if [[ "$(rgit rev-parse --verify -q "$tip^{commit}")" != "$tip" ]]; then
    fail "the commit $tip of $ref is not available locally after fetching"
    return "$MASHKIF_EXIT_ENV"
  fi
  read -r -a parents <<<"$(rgit rev-list --parents -n 1 "$tip")"
  if ((${#parents[@]} != 2)); then
    release_prepare_foreign_branch "$tip" "its tip is not a single-parent commit"
    return 1
  fi
  parent="${parents[1]}"
  if ! rgit merge-base --is-ancestor "$parent" "$REL_MAIN_SHA"; then
    release_prepare_foreign_branch "$tip" "its parent $parent is not on $RELEASE_REMOTE/$RELEASE_MAIN"
    return 1
  fi
  if [[ "$(release_prepare_changed_files "$tip")" != "$(release_prepare_expected_files)" ]]; then
    release_prepare_foreign_branch "$tip" "it changes $(release_prepare_changed_files "$tip")"
    return 1
  fi
  dates="$(rgit show "$tip:$REL_CHANGELOG" |
    sed -nE "s/^## \[${REL_VERSION//./\\.}\] - ([0-9]{4}-[0-9]{2}-[0-9]{2})\$/\1/p")"
  if [[ ! "$dates" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
    release_prepare_foreign_branch "$tip" "its changelog has no single \"## [$REL_VERSION] - YYYY-MM-DD\" heading"
    return 1
  fi
  date="$dates"
  release_prepare_check_base "$parent" "the parent $parent of $ref" || return 1
  # The expected content uses the date recorded in the commit, so a rerun on a
  # later day still recognizes the commit.
  for path in "$REL_VERSION_FILE" "$REL_CHANGELOG"; do
    want="$(release_render "$parent" "$date" "$path" | rgit hash-object --stdin)" || return 1
    have="$(rgit rev-parse --verify -q "$tip:$path")" || have=""
    if [[ "$want" != "$have" ]]; then
      release_prepare_foreign_branch "$tip" "$path differs from the expected release change"
      return 1
    fi
  done
  log "The release branch $REL_PREP_BRANCH on $RELEASE_REMOTE already holds the expected commit $tip (dated $date); reusing it without a new push."
}

release_prepare_foreign_branch() {
  fail "$REL_PREP_BRANCH on $RELEASE_REMOTE ($1) is not the expected release commit: $2"
  log "  It was left untouched. Inspect it with: git fetch $RELEASE_REMOTE $REL_PREP_BRANCH && git show FETCH_HEAD"
  log "  If it is stale, delete the branch on GitHub (and close its pull request), then run prepare again."
}

# release_prepare_commit: the release commit on origin/main, made in a fresh
# detached worktree under the run directory.
release_prepare_commit() {
  local wt="$REL_RUN_DIR/prepare" date path version
  REL_WORKTREE="$wt"
  rgit worktree add -q --detach "$wt" "$REL_MAIN_SHA" || {
    fail "cannot create the prepare worktree at $wt"
    return 1
  }
  date="$(date -u +%F)"
  for path in "$REL_VERSION_FILE" "$REL_CHANGELOG"; do
    release_render "$REL_MAIN_SHA" "$date" "$path" >"$wt/$path" || {
      fail "cannot write the release change of $path"
      return 1
    }
  done
  version="$(release_read_version "$REL_TARGET" <"$wt/$REL_VERSION_FILE")"
  if [[ "$version" != "$REL_VERSION" ]]; then
    fail "the version update of $REL_VERSION_FILE did not produce $REL_VERSION"
    return 1
  fi
  git -C "$wt" add -- "$REL_VERSION_FILE" "$REL_CHANGELOG" || return 1
  git -C "$wt" commit -q -m "Release $REL_TARGET $REL_VERSION" || {
    fail "cannot commit the release change in $wt"
    return 1
  }
  REL_PREP_COMMIT="$(git -C "$wt" rev-parse HEAD)" || return 1
  if [[ "$(release_prepare_changed_files "$REL_PREP_COMMIT")" != "$(release_prepare_expected_files)" ]]; then
    fail "the release commit changed unexpected files: $(release_prepare_changed_files "$REL_PREP_COMMIT")"
    return 1
  fi
  log "Created the release commit $REL_PREP_COMMIT on $RELEASE_REMOTE/$RELEASE_MAIN ($REL_MAIN_SHA)."
}

# release_prepare_push: creates the remote release branch at the release
# commit. The lease on an absent ref makes it creation only.
release_prepare_push() {
  local out rc flag sha ref="refs/heads/$REL_PREP_BRANCH"
  out="$REL_RUN_DIR/branch-push"
  REL_PREP_PUSHED=pending
  release_push "$out" "--force-with-lease=$ref:" "$RELEASE_REMOTE" "$REL_PREP_COMMIT:$ref"
  rc=$?
  flag="$(release_flag "$out" "$ref")"
  if ((rc == 0)) && [[ "$flag" == "*" ]]; then
    REL_PREP_PUSHED=yes
  elif [[ "$flag" == "!" ]]; then
    REL_PREP_PUSHED=no
    fail "$RELEASE_REMOTE rejected the creation of $ref:"
    release_push_details "$out"
  else
    log "The branch push gave no clear answer (exit $rc); reading $RELEASE_REMOTE."
    sha="$(release_remote_ref "$ref")"
    case $? in
      0)
        if [[ "$sha" == "$REL_PREP_COMMIT" ]]; then
          REL_PREP_PUSHED=yes
          log "Origin shows $ref at the release commit; the push happened."
        else
          REL_PREP_PUSHED=no
          fail "$ref on $RELEASE_REMOTE points at $sha, not at the release commit $REL_PREP_COMMIT"
        fi
        ;;
      1)
        REL_PREP_PUSHED=no
        fail "the push did not happen: $ref is absent on $RELEASE_REMOTE"
        release_push_details "$out"
        ;;
      *)
        REL_PREP_PUSHED=unknown
        fail "cannot read $RELEASE_REMOTE after the branch push"
        ;;
    esac
  fi
  rm -f -- "$out" "$out.err"
  [[ "$REL_PREP_PUSHED" == yes ]] || return 1
  log "Pushed $REL_PREP_BRANCH at $REL_PREP_COMMIT."
}

# release_prepare_pr: finds the open release pull request for the release
# commit, or opens one. A lost `gh pr create` response is resolved by listing
# the pull requests for the head again.
release_prepare_pr() {
  local url rc body out lost=0
  url="$(release_find_open_pr "$REL_PREP_COMMIT")"
  rc=$?
  case "$rc" in
    0)
      REL_PREP_PR_URL="$url"
      log "The release pull request is already open: $url"
      return 0
      ;;
    1) ;;
    3) return 1 ;;
    *) return "$rc" ;;
  esac
  body="$REL_RUN_DIR/pr-body.md"
  {
    printf 'Release %s %s.\n\n' "$REL_TARGET" "$REL_VERSION"
    printf 'This pull request changes only %s and %s. ' "$REL_VERSION_FILE" "$REL_CHANGELOG"
    printf 'After CI passes, merge it; when CI on %s has passed for the merge commit, publish with:\n\n' "$RELEASE_MAIN"
    printf '    scripts/release.sh %s publish --version %s\n' "$REL_TARGET" "$REL_VERSION"
  } >"$body" || return 1
  url=""
  if out="$(gh pr create --repo "$REL_REPO" --base "$RELEASE_MAIN" --head "$REL_PREP_BRANCH" \
    --title "Release $REL_TARGET $REL_VERSION" --body-file "$body")"; then
    url="$(grep -oE 'https://[^[:space:]]+' <<<"$out" | tail -n 1)"
  fi
  if [[ -z "$url" ]]; then
    lost=1
    log "gh pr create gave no pull request URL; looking for the pull request on GitHub."
  fi
  # Also after a successful creation: the branch may have moved between the
  # push and the creation, so the pull request must be at the release commit.
  url="$(release_find_open_pr "$REL_PREP_COMMIT")"
  rc=$?
  if ((rc == 1)); then
    fail "no open release pull request at $REL_PREP_COMMIT was found after gh pr create"
    return 1
  elif ((rc != 0)); then
    return 1
  fi
  ((!lost)) || log "GitHub shows the pull request; it was created."
  REL_PREP_PR_URL="$url"
  log "Opened the release pull request: $url"
}

# release_prepare_print_recovery <rc>: called by the exit handler.
release_prepare_print_recovery() {
  local rc="$1"
  ((rc != 0)) || return 0
  case "$REL_PREP_PUSHED" in
    yes)
      log ""
      log "$REL_PREP_BRANCH is on $RELEASE_REMOTE at $REL_PREP_COMMIT, but the pull request step did not finish."
      log "After fixing the cause, run: scripts/release.sh $REL_TARGET prepare --version $REL_VERSION"
      log "It reuses the branch and finds or opens the pull request."
      ;;
    pending | unknown)
      log ""
      log "The push result of $REL_PREP_BRANCH is unknown. Check it with: git ls-remote $RELEASE_REMOTE refs/heads/$REL_PREP_BRANCH"
      log "Then run: scripts/release.sh $REL_TARGET prepare --version $REL_VERSION"
      log "It reuses the branch when it holds the expected commit and refuses otherwise."
      ;;
  esac
}

release_prepare_main() {
  local rc branch_sha
  # Signing first: an agent prepare refuses before any prompt or change.
  release_signing_available "$REL_TARGET" || return 1
  release_check_tools || return
  release_obtain_version || return
  if ((!REL_PREVIEW)); then
    # Before any checkout state is read.
    release_prepare_lock || return
    release_install_traps
  fi
  release_repo_identity || return
  REL_PREP_BRANCH="$(release_branch_name)"
  release_fetch_main || return
  release_prepare_check_base "$REL_MAIN_SHA" "$RELEASE_REMOTE/$RELEASE_MAIN ($REL_MAIN_SHA)" || return 1
  release_check_tag_absent || return
  branch_sha="$(release_remote_ref "refs/heads/$REL_PREP_BRANCH")"
  rc=$?
  if ((rc == 0)); then
    release_prepare_check_branch "$branch_sha" || return
    REL_PREP_COMMIT="$branch_sha"
    REL_PREP_REUSED=1
  elif ((rc == 2)); then
    fail "cannot read $REL_PREP_BRANCH from $RELEASE_REMOTE"
    return "$MASHKIF_EXIT_ENV"
  fi

  if ((REL_PREVIEW)); then
    log ""
    log "Preview only: no branch, commit, pull request, or tag was created."
    if ((REL_PREP_REUSED)); then
      log "A prepare would reuse $REL_PREP_BRANCH at $REL_PREP_COMMIT, then find or open its pull request."
    else
      log "A prepare would:"
      log "  1. commit $REL_VERSION_FILE ($(release_version_at "$REL_MAIN_SHA") -> $REL_VERSION) and promote Unreleased in"
      log "     $REL_CHANGELOG on $RELEASE_REMOTE/$RELEASE_MAIN ($REL_MAIN_SHA), in a scratch worktree"
      log "  2. push the new branch $REL_PREP_BRANCH"
      log "  3. open the pull request \"Release $REL_TARGET $REL_VERSION\" into $RELEASE_MAIN of $REL_REPO"
    fi
    log ""
    log "Release notes for $REL_VERSION:"
    rgit show "$REL_MAIN_SHA:$REL_CHANGELOG" | awk '
      $0 == "## [Unreleased]" { inside = 1; next }
      /^## / { inside = 0 }
      inside { print "    " $0 }
    ' >&2
    return 0
  fi

  release_make_run_dir || return
  if ((REL_PREP_REUSED)); then
    REL_PREP_PUSHED=yes
  else
    release_prepare_commit || return 1
    release_prepare_push || return 1
  fi
  release_prepare_pr || return
  log ""
  log "Prepared $REL_TARGET $REL_VERSION:"
  log "  branch: $REL_PREP_BRANCH"
  log "  commit: $REL_PREP_COMMIT"
  log "  pull request: $REL_PREP_PR_URL"
  log "Next: merge the pull request after CI passes. When CI on $RELEASE_MAIN has passed for the merge commit, run:"
  log "  scripts/release.sh $REL_TARGET publish --version $REL_VERSION"
}
