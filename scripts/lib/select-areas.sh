# shellcheck shell=bash
# Area selection for scripts/verify.sh and CI. This is the only place that maps
# changed paths to verify areas. CI calls `scripts/verify.sh --list-areas` and
# must not re-implement this table.

# Canonical area order.
MASHKIF_AREAS=(contracts server web agent docker guards)

# map_paths_to_areas: reads repository-relative paths on stdin (one per line)
# and prints the selected areas in canonical order, one per line.
#
# Rules:
# - contracts/, server/, web/, agent/ select their own area.
# - docs/ selects nothing beyond guards.
# - scripts/, .github/, config/, root files, and unknown top-level
#   directories select every area.
# - Dependency edges: contracts selects server, web, and agent;
#   server or web selects docker.
# - guards always runs.
map_paths_to_areas() {
  local path all=0
  local contracts=0 server=0 web=0 agent=0 docker=0
  while IFS= read -r path; do
    [[ -z "$path" ]] && continue
    case "$path" in
      contracts/*) contracts=1 ;;
      server/*) server=1 ;;
      web/*) web=1 ;;
      agent/*) agent=1 ;;
      docs/*) ;;
      *) all=1 ;;
    esac
  done

  if ((all)); then
    printf '%s\n' "${MASHKIF_AREAS[@]}"
    return 0
  fi
  if ((contracts)); then
    server=1
    web=1
    agent=1
  fi
  if ((server || web)); then
    docker=1
  fi

  ((contracts)) && printf 'contracts\n'
  ((server)) && printf 'server\n'
  ((web)) && printf 'web\n'
  ((agent)) && printf 'agent\n'
  ((docker)) && printf 'docker\n'
  printf 'guards\n'
}

# mashkif_changed_paths <base-ref> [repo-dir]: prints every path changed since
# the merge base of <base-ref> and HEAD, including staged, unstaged, and
# untracked (not ignored) files. Renames are reported as a deletion of the old
# path plus an addition of the new path, so both sides count.
# Returns non-zero when the base is empty, all zeros, unknown, or unrelated.
mashkif_changed_paths() {
  local base="$1" repo="${2:-$MASHKIF_ROOT}" merge_base
  [[ -z "$base" || "$base" =~ ^0+$ ]] && return 1
  git -C "$repo" rev-parse --verify --quiet "${base}^{commit}" >/dev/null || return 1
  merge_base="$(git -C "$repo" merge-base "$base" HEAD 2>/dev/null)" || return 1
  git -C "$repo" -c core.quotePath=false diff --name-only --no-renames "$merge_base" -- || return 1
  git -C "$repo" -c core.quotePath=false ls-files --others --exclude-standard || return 1
}

# select_areas [base-ref] [repo-dir]: prints the areas to verify.
# Without a usable base (no argument, all zeros, unknown, unrelated history)
# every area is selected.
select_areas() {
  local base="${1:-}" repo="${2:-$MASHKIF_ROOT}" paths
  if ! paths="$(mashkif_changed_paths "$base" "$repo")"; then
    printf '%s\n' "${MASHKIF_AREAS[@]}"
    return 0
  fi
  map_paths_to_areas <<<"$paths"
}
