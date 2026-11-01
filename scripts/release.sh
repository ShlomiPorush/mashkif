#!/usr/bin/env bash
# Mashkif release workflow. Runs inside WSL. Never deploys.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"
# shellcheck source=lib/release-core.sh
source "$SCRIPT_DIR/lib/release-core.sh"
# shellcheck source=lib/release-github.sh
source "$SCRIPT_DIR/lib/release-github.sh"
# shellcheck source=lib/release-prepare.sh
source "$SCRIPT_DIR/lib/release-prepare.sh"

usage() {
  cat <<EOF
Usage:
  scripts/release.sh <agent|server> prepare [--version X.Y.Z] [--preview]
  scripts/release.sh <agent|server> publish [--version X.Y.Z] [--preview]
  scripts/release.sh <agent|server> publish --resume X.Y.Z [--preview]

A release goes through a pull request, because $RELEASE_MAIN accepts changes only
through pull requests with green CI.

  prepare   Open the release pull request: branch release/<target>-vX.Y.Z from
            $RELEASE_REMOTE/$RELEASE_MAIN with one commit that sets the version and
            promotes the Unreleased changelog section. Never merges. Works in a
            scratch worktree; your checkout, branch, and index are not used. A
            rerun reuses the branch and pull request it already created.
  publish   After the pull request is merged and CI on $RELEASE_MAIN passed for its
            merge commit: create the tag <target>-vX.Y.Z at that merge commit,
            then build and publish the artifacts from it.

  --version X.Y.Z   The release version. Without it, it is asked for on a terminal.
  --resume X.Y.Z    Publish the missing artifacts of an already tagged release.
  --preview         Run the checks and print the plan. It may fetch from $RELEASE_REMOTE,
                    but creates no branch, commit, tag, lease, pull request, or image.

Targets:
  server   Container image $RELEASE_IMAGE_REPO:X.Y.Z, built from
           $RELEASE_DOCKERFILE and labelled with the tag commit.
  agent    Signed MSI as a GitHub Release asset. Refused until code signing exists.

Only one publish runs at a time, for any target or version: the lease ref
$RELEASE_LEASE_REF on $RELEASE_REMOTE guards it, and the script never removes a
lease it does not own. Only one prepare runs at a time for each user.

Exit codes: 0 done, 1 refused or failed, 2 usage or environment error.
EOF
}

usage_error() {
  fail "$1"
  usage >&2
  exit "$MASHKIF_EXIT_ENV"
}

main() {
  local target="" command="" version="" resume=""
  while (($#)); do
    case "$1" in
      agent | server)
        [[ -z "$target" ]] || usage_error "only one target may be given"
        target="$1"
        shift
        ;;
      prepare | publish)
        [[ -z "$command" ]] || usage_error "only one command may be given"
        command="$1"
        shift
        ;;
      --version)
        [[ $# -ge 2 ]] || usage_error "--version needs a value"
        version="$2"
        shift 2
        ;;
      --resume)
        [[ $# -ge 2 ]] || usage_error "--resume needs a version"
        resume="$2"
        shift 2
        ;;
      --preview)
        REL_PREVIEW=1
        shift
        ;;
      -h | --help)
        usage
        return 0
        ;;
      *) usage_error "unknown argument: $1" ;;
    esac
  done
  [[ -n "$target" ]] || usage_error "a target is required: agent or server"
  [[ -n "$command" ]] || usage_error "a command is required: prepare or publish"
  if [[ -n "$version" && -n "$resume" ]]; then
    usage_error "use either --version or --resume, not both"
  fi
  if [[ "$command" == prepare && -n "$resume" ]]; then
    usage_error "--resume belongs to publish"
  fi
  release_target_setup "$target"
  if [[ -n "$resume" ]]; then
    REL_MODE=resume
    REL_VERSION="$resume"
  else
    REL_MODE="$command"
    REL_VERSION="$version"
  fi
  release_main
}

main "$@"
