#!/usr/bin/env bash
# Tests for scripts/lib/select-areas.sh: the path table, dependency edges,
# renames, deletions, untracked files, and unusable base refs.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/common.sh
source "$SCRIPT_DIR/../lib/common.sh"
# shellcheck source=../lib/select-areas.sh
source "$SCRIPT_DIR/../lib/select-areas.sh"

failures=0
ALL="contracts server web agent docker guards"

# expect <description> <expected areas, space-separated> <actual, newline-separated>
expect() {
  local description="$1" expected="$2" actual
  actual="$(printf '%s' "$3" | tr '\n' ' ' | sed 's/ $//')"
  if [[ "$actual" == "$expected" ]]; then
    printf '  ok    %s\n' "$description" >&2
  else
    printf '  FAIL  %s\n        expected: %s\n        actual:   %s\n' "$description" "$expected" "$actual" >&2
    failures=$((failures + 1))
  fi
}

map() {
  printf '%s\n' "$@" | map_paths_to_areas
}

# Path table and edges.
expect "docs only selects guards" "guards" "$(map docs/project-foundation.md)"
expect "agent only" "agent guards" "$(map agent/src/Program.cs)"
expect "server selects docker" "server docker guards" "$(map server/src/main.ts)"
expect "web selects docker" "web docker guards" "$(map web/src/App.tsx)"
expect "contracts selects dependants" "$ALL" "$(map contracts/openapi.yaml)"
expect "scripts select all" "$ALL" "$(map scripts/local.sh)"
expect "workflows select all" "$ALL" "$(map .github/workflows/ci.yml)"
expect "config selects all" "$ALL" "$(map config/docker/app.Dockerfile)"
expect "root file selects all" "$ALL" "$(map README.md)"
expect "unknown directory selects all" "$ALL" "$(map tools/x.txt)"
expect "no changes selects guards" "guards" "$(map_paths_to_areas </dev/null)"

# Unusable base refs select everything.
expect "empty base" "$ALL" "$(select_areas "")"
expect "all-zero base" "$ALL" "$(select_areas 0000000000000000000000000000000000000000)"
expect "unknown base" "$ALL" "$(select_areas refs/heads/does-not-exist-mashkif-test)"

# Git behaviour against a scratch repository. Clear every variable that would
# redirect Git to another repository, so `git init` and the commits below can
# only touch the scratch repository.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR GIT_OBJECT_DIRECTORY \
  GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_CEILING_DIRECTORIES GIT_NAMESPACE
scratch="$(mashkif_mktemp select-areas-test)"
trap 'rm -rf -- "$scratch"' EXIT
repo="$scratch/repo"
git init -q -b main "$repo"
g() {
  git -C "$repo" -c user.name=test -c user.email=test@example.invalid -c commit.gpgsign=false "$@"
}
mkdir -p "$repo/server" "$repo/agent" "$repo/contracts" "$repo/docs"
printf 'a\n' >"$repo/server/a.ts"
printf 'b\n' >"$repo/agent/b.cs"
printf 'c\n' >"$repo/contracts/c.yaml"
printf 'd\n' >"$repo/docs/d.md"
g add -A
g commit -q -m base
base="$(g rev-parse HEAD)"

mkdir -p "$repo/web"
g mv server/a.ts web/a.ts
g commit -q -m rename
expect "rename counts both paths" "server web docker guards" "$(select_areas "$base" "$repo")"

g reset -q --hard "$base"
g rm -q agent/b.cs
g commit -q -m delete
expect "deletion counts the old path" "agent guards" "$(select_areas "$base" "$repo")"

g reset -q --hard "$base"
printf 'new\n' >"$repo/docs/new.md"
expect "untracked docs file" "guards" "$(select_areas "$base" "$repo")"
printf 'x\n' >>"$repo/contracts/c.yaml"
expect "unstaged contract change" "$ALL" "$(select_areas "$base" "$repo")"

g checkout -q -- contracts/c.yaml
rm -f "$repo/docs/new.md"
g checkout -q --orphan unrelated
g rm -rq --cached .
printf 'z\n' >"$repo/z.txt"
g add z.txt
g commit -q -m unrelated
g checkout -q -f main
orphan="$(g rev-parse unrelated)"
g checkout -q -f unrelated
expect "unrelated history selects all" "$ALL" "$(select_areas "$base" "$repo")"
g checkout -q -f main
expect "no changes since base" "guards" "$(select_areas "$base" "$repo")"
expect "orphan base from main selects all" "$ALL" "$(select_areas "$orphan" "$repo")"

if ((failures)); then
  printf '%d selection test(s) failed\n' "$failures" >&2
  exit 1
fi
