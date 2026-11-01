# shellcheck shell=bash
# shellcheck disable=SC2034 # The variables below are used by the scripts that source this file.
# Shared helpers for Mashkif workflow scripts. Source this file; do not run it.

if [[ -n "${MASHKIF_COMMON_LOADED:-}" ]]; then
  return 0
fi
MASHKIF_COMMON_LOADED=1

# Repository root, resolved from this file's location.
MASHKIF_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Exit codes shared by every verify area:
# 0 = all checks passed, 1 = a check failed, 2 = usage or environment error.
MASHKIF_EXIT_OK=0
MASHKIF_EXIT_FAILED=1
MASHKIF_EXIT_ENV=2

log() {
  printf '%s\n' "$*" >&2
}

fail() {
  printf 'error: %s\n' "$*" >&2
}

# require_cmd <command> [hint]: returns 2 with a clear message when the command is missing.
require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    fail "required command not found: $1${2:+ ($2)}"
    return "$MASHKIF_EXIT_ENV"
  fi
}

# mashkif_tmp_root: prints the scratch root.
# Order: MASHKIF_TMP_DIR, then RUNNER_TEMP in CI, then the Windows T: drive seen from WSL.
mashkif_tmp_root() {
  if [[ -n "${MASHKIF_TMP_DIR:-}" ]]; then
    printf '%s\n' "$MASHKIF_TMP_DIR"
  elif [[ -n "${RUNNER_TEMP:-}" ]]; then
    if command -v cygpath >/dev/null 2>&1; then
      printf '%s/mashkif\n' "$(cygpath -u "$RUNNER_TEMP")"
    else
      printf '%s/mashkif\n' "$RUNNER_TEMP"
    fi
  elif [[ -d /mnt/t ]]; then
    printf '/mnt/t/mashkif\n'
  else
    return 1
  fi
}

# mashkif_mktemp <name>: creates a fresh scratch directory and prints its path.
# The caller owns cleanup.
mashkif_mktemp() {
  local root
  if ! root="$(mashkif_tmp_root)"; then
    fail "no scratch location: set MASHKIF_TMP_DIR (locally the T: drive is expected at /mnt/t)"
    return "$MASHKIF_EXIT_ENV"
  fi
  mkdir -p "$root" && mktemp -d "$root/${1:-tmp}.XXXXXX"
}
