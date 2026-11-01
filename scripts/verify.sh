#!/usr/bin/env bash
# Mashkif verification entry point. Runs inside WSL locally and on Linux CI
# runners; the agent area also runs under Git Bash on the Windows CI runner.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"
# shellcheck source=lib/select-areas.sh
source "$SCRIPT_DIR/lib/select-areas.sh"

usage() {
  cat <<EOF
Usage:
  scripts/verify.sh                        Run every area (full sweep).
  scripts/verify.sh --area <name> [...]    Run only the named areas.
  scripts/verify.sh --changed <base-ref>   Run the areas selected by changes since <base-ref>.
  scripts/verify.sh --list-areas [base]    Print the selected areas, one per line, and exit.
                                           Without a usable base, every area is printed.

Areas: ${MASHKIF_AREAS[*]}
Each area lives in scripts/lib/verify-<area>.sh and defines verify_<area>.

Exit codes: 0 all checks passed, 1 a check failed, 2 usage or environment error.
EOF
}

usage_error() {
  fail "$1"
  usage >&2
  exit "$MASHKIF_EXIT_ENV"
}

is_area() {
  local candidate="$1" area
  for area in "${MASHKIF_AREAS[@]}"; do
    [[ "$area" == "$candidate" ]] && return 0
  done
  return 1
}

# run_area <area>: runs one area in a subshell and returns its exit code.
run_area() {
  local area="$1"
  local file="$SCRIPT_DIR/lib/verify-$area.sh"
  if [[ ! -f "$file" ]]; then
    fail "area '$area' is not implemented yet: ${file#"$MASHKIF_ROOT"/} is missing"
    return "$MASHKIF_EXIT_ENV"
  fi
  (
    set -euo pipefail
    # shellcheck source=/dev/null
    source "$file"
    if ! declare -F "verify_$area" >/dev/null; then
      fail "${file#"$MASHKIF_ROOT"/} does not define verify_$area"
      exit "$MASHKIF_EXIT_ENV"
    fi
    "verify_$area"
  )
}

main() {
  local mode=run base="" area rc
  local -a requested=() selected=() results=()

  while (($#)); do
    case "$1" in
      --area)
        [[ $# -ge 2 ]] || usage_error "--area needs an area name"
        is_area "$2" || usage_error "unknown area: $2"
        requested+=("$2")
        shift 2
        ;;
      --changed)
        [[ $# -ge 2 ]] || usage_error "--changed needs a base ref"
        [[ "$mode" == run ]] || usage_error "use only one of --changed and --list-areas"
        mode=changed
        base="$2"
        shift 2
        ;;
      --list-areas)
        [[ "$mode" == run ]] || usage_error "use only one of --changed and --list-areas"
        mode=list
        if [[ $# -ge 2 && "$2" != --* ]]; then
          base="$2"
          shift
        fi
        shift
        ;;
      -h | --help)
        usage
        return 0
        ;;
      *)
        usage_error "unknown argument: $1"
        ;;
    esac
  done

  if ((${#requested[@]})) && [[ "$mode" != run ]]; then
    usage_error "--area cannot be combined with --changed or --list-areas"
  fi

  case "$mode" in
    list)
      select_areas "$base"
      return 0
      ;;
    changed)
      mapfile -t requested < <(select_areas "$base")
      ;;
    run)
      ((${#requested[@]})) || requested=("${MASHKIF_AREAS[@]}")
      ;;
  esac

  # Deduplicate and keep canonical order.
  for area in "${MASHKIF_AREAS[@]}"; do
    if printf '%s\n' "${requested[@]}" | grep -qx -- "$area"; then
      selected+=("$area")
    fi
  done

  local any_failed=0 any_env=0 started
  for area in "${selected[@]}"; do
    log "==> $area"
    started=$SECONDS
    set +e
    run_area "$area"
    rc=$?
    set -e
    case "$rc" in
      0) results+=("$area: passed ($((SECONDS - started))s)") ;;
      2)
        any_env=1
        results+=("$area: environment error ($((SECONDS - started))s)")
        ;;
      *)
        any_failed=1
        results+=("$area: FAILED, exit $rc ($((SECONDS - started))s)")
        ;;
    esac
  done

  log ""
  log "Summary:"
  printf '  %s\n' "${results[@]}" >&2

  if ((any_failed)); then
    return "$MASHKIF_EXIT_FAILED"
  elif ((any_env)); then
    return "$MASHKIF_EXIT_ENV"
  fi
  return "$MASHKIF_EXIT_OK"
}

main "$@"
