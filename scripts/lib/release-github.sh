# shellcheck shell=bash
# shellcheck disable=SC2034 # The REL_* variables set here are read by release-core.sh.
# GitHub reads and writes for scripts/release.sh: the repository identity,
# release pull requests, and CI evidence. Source this file; do not run it.
#
# Every GitHub call goes through gh. `gh api --jq` projects each response to
# tab-separated lines; a null field becomes "-", because Bash `read` with a tab
# IFS collapses empty fields.

# The CI workflow whose push run on main is the release evidence, and the job
# that summarizes it.
RELEASE_CI_WORKFLOW=.github/workflows/ci.yml
RELEASE_CI_JOB=summary

# number, state, merged_at, merge_commit_sha, head.ref, head.sha,
# head.repo.full_name, base.ref, base.repo.full_name, html_url
RELEASE_PULLS_JQ='.[] | [.number, .state, (.merged_at // "-"), (.merge_commit_sha // "-"), .head.ref, .head.sha, (.head.repo.full_name // "-"), .base.ref, .base.repo.full_name, .html_url] | @tsv'
# id, run_attempt, status, conclusion, head_sha, event, head_branch, path, repository.full_name
RELEASE_RUNS_JQ='.workflow_runs[] | [.id, .run_attempt, .status, (.conclusion // "-"), .head_sha, .event, .head_branch, .path, .repository.full_name] | @tsv'
# name, status, conclusion
RELEASE_JOBS_JQ='.jobs[] | [.name, .status, (.conclusion // "-")] | @tsv'

REL_REPO=""   # owner/name of origin on GitHub
REL_OWNER=""

# release_repo_identity: reads owner/name from the configured origin URL. The
# raw configuration value is used on purpose: `git remote get-url` expands
# insteadOf rewrites, which would hide the GitHub name.
release_repo_identity() {
  local url
  url="$(rgit config --get "remote.$RELEASE_REMOTE.url" 2>/dev/null)" || url=""
  if [[ "$url" =~ ^(https://github\.com/|git@github\.com:|ssh://git@github\.com/)([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)$ ]]; then
    REL_OWNER="${BASH_REMATCH[2]}"
    REL_REPO="$REL_OWNER/${BASH_REMATCH[3]%.git}"
    return 0
  fi
  fail "$RELEASE_REMOTE is not a GitHub repository URL (${url:-not set}); releases go through GitHub pull requests"
  return "$MASHKIF_EXIT_ENV"
}

# release_branch_name: the release pull request's head branch.
release_branch_name() {
  printf 'release/%s-v%s' "$REL_TARGET" "$REL_VERSION"
}

# release_list_prs <state>: prints the release pull requests of this
# repository, in the RELEASE_PULLS_JQ columns, for the release branch and base
# main. A pull request counts only when its head and base repositories are both
# this repository, so a fork with the same branch name never matches. The head
# branch name comes from the pull request, so a branch deleted after the merge
# still resolves. Returns 2 when GitHub cannot be read.
release_list_prs() {
  local state="$1" branch out
  branch="$(release_branch_name)"
  if ! out="$(gh api --paginate \
    "repos/$REL_REPO/pulls?state=$state&base=$RELEASE_MAIN&head=$REL_OWNER:$branch&per_page=100" \
    --jq "$RELEASE_PULLS_JQ")"; then
    fail "cannot read pull requests of $REL_REPO from GitHub (gh api)"
    return "$MASHKIF_EXIT_ENV"
  fi
  # Owner and repository names compare case-insensitively, as GitHub treats
  # them; branch names compare exactly.
  awk -F '\t' -v branch="$branch" -v repo="$REL_REPO" -v base="$RELEASE_MAIN" '
    NF == 10 && $5 == branch && tolower($7) == tolower(repo) && $8 == base && tolower($9) == tolower(repo)
  ' <<<"$out"
}

# release_find_merged_pr: sets REL_PR_URL and REL_PR_MERGE to the single
# merged release pull request. Refuses when there is none or more than one.
REL_PR_URL=""
REL_PR_MERGE=""
release_find_merged_pr() {
  local prs merged count
  prs="$(release_list_prs closed)" || return
  merged="$(awk -F '\t' '$3 != "-" && $4 ~ /^[0-9a-f]{40}$/' <<<"$prs")"
  count="$(grep -c . <<<"$merged" || true)"
  if ((count == 0)); then
    fail "no merged release pull request from $REL_REPO:$(release_branch_name) into $RELEASE_MAIN; run 'scripts/release.sh $REL_TARGET prepare --version $REL_VERSION' and merge its pull request first"
    return 1
  elif ((count > 1)); then
    fail "more than one merged release pull request from $(release_branch_name):"
    awk -F '\t' '{ print "    " $10 " (merge commit " $4 ")" }' <<<"$merged" >&2
    return 1
  fi
  REL_PR_MERGE="$(cut -f 4 <<<"$merged")"
  REL_PR_URL="$(cut -f 10 <<<"$merged")"
}

# release_find_open_pr <head-sha>: prints the URL of the open release pull
# request whose head is <head-sha>. Returns 1 when none exists, 3 when an open
# release pull request has another head, 2 when GitHub cannot be read.
release_find_open_pr() {
  local sha="$1" prs match other
  prs="$(release_list_prs open)" || return
  match="$(awk -F '\t' -v sha="$sha" '$2 == "open" && $6 == sha { print $10 }' <<<"$prs")"
  other="$(awk -F '\t' -v sha="$sha" '$2 == "open" && $6 != sha { print $10 " (head " $6 ")" }' <<<"$prs")"
  if [[ -n "$other" ]]; then
    fail "an open release pull request has another head commit than $sha:"
    awk '{ print "    " $0 }' <<<"$other" >&2
    return 3
  fi
  [[ -n "$match" ]] || return 1
  head -n 1 <<<"$match"
}

# release_ci_evidence <sha>: the release source needs a successful push run of
# $RELEASE_CI_WORKFLOW on main for exactly <sha>, at its latest attempt, with a
# successful $RELEASE_CI_JOB job. Every matching run must pass, so no run,
# runs that disagree, a newer attempt still running, or a failed newest attempt
# all refuse. Returns 2 when GitHub cannot be read.
release_ci_evidence() {
  local sha="$1" runs jobs count=0 id attempt status conclusion head event branch path repo
  local summary
  if ! runs="$(gh api --paginate \
    "repos/$REL_REPO/actions/workflows/${RELEASE_CI_WORKFLOW##*/}/runs?head_sha=$sha&event=push&branch=$RELEASE_MAIN&per_page=100" \
    --jq "$RELEASE_RUNS_JQ")"; then
    fail "cannot read CI runs of $REL_REPO from GitHub (gh api)"
    return "$MASHKIF_EXIT_ENV"
  fi
  while IFS=$'\t' read -r id attempt status conclusion head event branch path repo; do
    [[ -n "$id" ]] || continue
    count=$((count + 1))
    # Repository names compare case-insensitively, as GitHub treats them.
    if [[ "$path" != "$RELEASE_CI_WORKFLOW" || "$event" != push || "$branch" != "$RELEASE_MAIN" ||
      "$head" != "$sha" || "${repo,,}" != "${REL_REPO,,}" ]]; then
      fail "CI run $id does not match the release source (workflow $path, event $event, branch $branch, commit $head, repository $repo)"
      return 1
    fi
    if [[ "$status" != completed ]]; then
      fail "CI run $id (attempt $attempt) for $sha is $status, not completed; wait for it and run this again"
      return 1
    fi
    if [[ "$conclusion" != success ]]; then
      fail "CI run $id (attempt $attempt) for $sha concluded $conclusion, not success"
      return 1
    fi
    if ! jobs="$(gh api --paginate \
      "repos/$REL_REPO/actions/runs/$id/attempts/$attempt/jobs?per_page=100" \
      --jq "$RELEASE_JOBS_JQ")"; then
      fail "cannot read the jobs of CI run $id from GitHub (gh api)"
      return "$MASHKIF_EXIT_ENV"
    fi
    summary="$(awk -F '\t' -v job="$RELEASE_CI_JOB" '$1 == job { print $2 "/" $3 }' <<<"$jobs")"
    if [[ "$summary" != completed/success ]]; then
      summary="${summary//$'\n'/, }"
      fail "CI run $id (attempt $attempt) for $sha has no single successful $RELEASE_CI_JOB job (found: ${summary:-none})"
      return 1
    fi
  done <<<"$runs"
  if ((count == 0)); then
    fail "no push run of $RELEASE_CI_WORKFLOW on $RELEASE_MAIN exists for $sha; wait for CI on $RELEASE_MAIN and run this again"
    return 1
  fi
  log "CI evidence: $count successful push run(s) of $RELEASE_CI_WORKFLOW for $sha."
}
