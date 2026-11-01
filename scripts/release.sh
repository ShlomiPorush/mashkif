#!/usr/bin/env bash
# Mashkif release workflow. Runs inside WSL. Never deploys.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"
# shellcheck source=lib/release-core.sh
source "$SCRIPT_DIR/lib/release-core.sh"

usage() {
  cat <<EOF
Usage:
  scripts/release.sh <agent|server> [--version X.Y.Z] [--preview]
  scripts/release.sh <agent|server> --resume X.Y.Z [--preview]

Start a release: bump the version, promote the Unreleased changelog section,
push main and the tag <target>-vX.Y.Z atomically, then build and publish the
artifacts from the tag commit. Without --version, the version is asked for.

  --version X.Y.Z   The new version; it must be greater than the current one.
  --resume X.Y.Z    Publish the missing artifacts of an already tagged release.
  --preview         Run the preflight and print the plan; change nothing.

Targets:
  server   Container image $RELEASE_IMAGE_REPO:X.Y.Z, built from
           $RELEASE_DOCKERFILE and labelled with the tag commit.
  agent    Signed MSI as a GitHub Release asset. Refused until code signing exists.

Only one release runs at a time, for any target or version: the lease ref
$RELEASE_LEASE_REF on origin guards it, and the script never removes a
lease it does not own.

Exit codes: 0 done, 1 refused or failed, 2 usage or environment error.
EOF
}

usage_error() {
  fail "$1"
  usage >&2
  exit "$MASHKIF_EXIT_ENV"
}

main() {
  local target="" version="" resume=""
  while (($#)); do
    case "$1" in
      agent | server)
        [[ -z "$target" ]] || usage_error "only one target may be given"
        target="$1"
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
  if [[ -n "$version" && -n "$resume" ]]; then
    usage_error "use either --version or --resume, not both"
  fi
  release_target_setup "$target"
  if [[ -n "$resume" ]]; then
    REL_MODE=resume
    REL_VERSION="$resume"
  else
    REL_MODE=start
    REL_VERSION="$version"
  fi
  release_main
}

main "$@"
