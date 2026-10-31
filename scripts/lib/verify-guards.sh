# shellcheck shell=bash
# Repository guards: Hebrew text, Compose build keys, shell scripts, line
# endings, and the area selection tests. Sourced by scripts/verify.sh.

# The only files that may contain Hebrew. Changing this list needs the
# maintainer's approval and an update to docs/project-foundation.md.
MASHKIF_HEBREW_ALLOWLIST=(
  web/src/locales/he.json
  agent/src/Mashkif.Tray/Resources/Strings.he.resx
  agent/installer/Package.he-IL.wxl
)

MASHKIF_SHELLCHECK_IMAGE="koalaman/shellcheck:v0.11.0@sha256:61862eba1fcf09a484ebcc6feea46f1782532571a34ed51fedf90dd25f925a8d"

# Hebrew letters and points (U+0590-U+05FF) and Hebrew presentation forms (U+FB1D-U+FB4F).
_MASHKIF_HEBREW_PATTERN='[\x{0590}-\x{05FF}\x{FB1D}-\x{FB4F}]'

# _guard_files: prints tracked and untracked (not ignored) files that exist, NUL-separated.
_guard_files() {
  local file
  while IFS= read -r -d '' file; do
    [[ -f "$MASHKIF_ROOT/$file" ]] && printf '%s\0' "$file"
  done < <(git -C "$MASHKIF_ROOT" ls-files -z --cached --others --exclude-standard | sort -zu)
}

_is_hebrew_allowed() {
  local candidate="$1" allowed
  for allowed in "${MASHKIF_HEBREW_ALLOWLIST[@]}"; do
    [[ "$candidate" == "$allowed" ]] && return 0
  done
  return 1
}

guard_hebrew() {
  # Self-test: grep must support -P with Unicode, or the guard would pass silently.
  # The sample is the UTF-8 encoding of the first Hebrew letter, written as bytes.
  if ! printf '\xd7\x90\n' | LC_ALL=C.UTF-8 grep -qP "$_MASHKIF_HEBREW_PATTERN"; then
    fail "grep does not support -P with UTF-8; the Hebrew guard cannot run"
    return "$MASHKIF_EXIT_ENV"
  fi

  local -a candidates=() offenders=()
  local file
  while IFS= read -r -d '' file; do
    _is_hebrew_allowed "$file" || candidates+=("$file")
  done < <(_guard_files)

  if ((${#candidates[@]})); then
    mapfile -t offenders < <(
      cd "$MASHKIF_ROOT" &&
        printf '%s\0' "${candidates[@]}" |
        LC_ALL=C.UTF-8 xargs -0 grep -lIP "$_MASHKIF_HEBREW_PATTERN" -- 2>/dev/null
    ) || true
  fi

  if ((${#offenders[@]})); then
    fail "Hebrew text found outside the locale allowlist:"
    printf '  %s\n' "${offenders[@]}" >&2
    return "$MASHKIF_EXIT_FAILED"
  fi
}

guard_compose_build() {
  local -a offenders=()
  local file
  while IFS= read -r -d '' file; do
    case "$file" in
      docker-compose*.yml | docker-compose*.yaml | compose*.yml | compose*.yaml | */docker-compose*.yml | */docker-compose*.yaml) ;;
      *) continue ;;
    esac
    if grep -nE "(^|[[:space:]{,])[\"']?build[\"']?[[:space:]]*:" "$MASHKIF_ROOT/$file" >/dev/null; then
      offenders+=("$file")
    fi
  done < <(_guard_files)
  # The machine-local development file is ignored by Git but must follow the same rule.
  if [[ -f "$MASHKIF_ROOT/docker-compose-dev.yml" ]] &&
    grep -nE "(^|[[:space:]{,])[\"']?build[\"']?[[:space:]]*:" "$MASHKIF_ROOT/docker-compose-dev.yml" >/dev/null; then
    offenders+=("docker-compose-dev.yml")
  fi

  if ((${#offenders[@]})); then
    fail "Compose files must not contain build: (scripts build images explicitly):"
    printf '  %s\n' "${offenders[@]}" >&2
    return "$MASHKIF_EXIT_FAILED"
  fi
}

# Rules for every *.sh file:
# - LF line endings and valid Bash syntax.
# - Files under scripts/lib/ are sourced: first line `# shellcheck shell=bash`,
#   not executable.
# - Every other script starts with `#!/usr/bin/env bash`, is executable in the
#   Git index, and resolves its location through BASH_SOURCE.
# - shellcheck passes.
guard_shell() {
  local -a scripts=() problems=()
  local file first mode
  while IFS= read -r -d '' file; do
    [[ "$file" == *.sh ]] && scripts+=("$file")
  done < <(_guard_files)
  ((${#scripts[@]})) || return 0

  for file in "${scripts[@]}"; do
    if grep -qU $'\r' "$MASHKIF_ROOT/$file"; then
      problems+=("$file: CRLF line endings")
    fi
    if ! bash -n "$MASHKIF_ROOT/$file" 2>/dev/null; then
      problems+=("$file: bash syntax error (run bash -n $file)")
    fi
    IFS= read -r first <"$MASHKIF_ROOT/$file" || first=""
    mode="$(git -C "$MASHKIF_ROOT" ls-files -s -- "$file" | cut -d' ' -f1)"
    case "$file" in
      scripts/lib/*)
        [[ "$first" == "# shellcheck shell=bash" ]] ||
          problems+=("$file: sourced library must start with '# shellcheck shell=bash'")
        [[ "$mode" == 100755 ]] && problems+=("$file: sourced library must not be executable")
        ;;
      *)
        [[ "$first" == "#!/usr/bin/env bash" ]] ||
          problems+=("$file: must start with '#!/usr/bin/env bash'")
        grep -q 'BASH_SOURCE' "$MASHKIF_ROOT/$file" ||
          problems+=("$file: must resolve its own location through BASH_SOURCE")
        if [[ -z "$mode" ]]; then
          log "  note: $file is untracked; its executable mode is checked once it is staged"
        elif [[ "$mode" != 100755 ]]; then
          problems+=("$file: not executable in the Git index (git update-index --chmod=+x $file)")
        fi
        ;;
    esac
  done

  require_cmd docker "shellcheck runs in the koalaman/shellcheck image" || return
  if ! docker run --rm --network none -v "$MASHKIF_ROOT:/src:ro" -w /src \
    "$MASHKIF_SHELLCHECK_IMAGE" --external-sources --source-path=SCRIPTDIR "${scripts[@]}" >&2; then
    problems+=("shellcheck reported problems (see above)")
  fi

  if ((${#problems[@]})); then
    printf '  %s\n' "${problems[@]}" >&2
    return "$MASHKIF_EXIT_FAILED"
  fi
}

# Text files must be stored with LF in the index.
guard_line_endings() {
  local -a offenders=()
  mapfile -t offenders < <(
    git -C "$MASHKIF_ROOT" -c core.quotePath=false ls-files --eol |
      awk '$1 == "i/crlf" || $1 == "i/mixed" { sub(/^[^\t]*\t/, ""); print }'
  )
  if ((${#offenders[@]})); then
    fail "files stored with CRLF in the Git index (expected LF):"
    printf '  %s\n' "${offenders[@]}" >&2
    return "$MASHKIF_EXIT_FAILED"
  fi
}

guard_selection_tests() {
  bash "$MASHKIF_ROOT/scripts/tests/test-select-areas.sh"
}

verify_guards() {
  local name rc failed=0 env=0
  for name in hebrew compose_build shell line_endings selection_tests; do
    set +e
    "guard_$name"
    rc=$?
    set -e
    case "$rc" in
      0) log "  ok    $name" ;;
      2)
        env=1
        log "  ENV   $name"
        ;;
      *)
        failed=1
        log "  FAIL  $name"
        ;;
    esac
  done
  if ((failed)); then
    return "$MASHKIF_EXIT_FAILED"
  elif ((env)); then
    return "$MASHKIF_EXIT_ENV"
  fi
}
