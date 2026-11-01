# shellcheck shell=bash
# Repository guards: Hebrew text, Compose build keys, shell scripts, line
# endings, the area selection and release script tests, and CI configuration.
# Sourced by scripts/verify.sh.

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

# scripts/release.sh against a local bare repository standing in for origin,
# with docker and gh replaced by shims. No network, no real release.
guard_release_tests() {
  bash "$MASHKIF_ROOT/scripts/tests/test-release.sh"
}

# CI configuration under .github/:
# - every action is pinned by a full commit SHA (local ./ actions excepted,
#   docker:// references need a sha256 digest);
# - no workflow uses the pull_request_target trigger;
# - actionlint, with its bundled shellcheck for run: scripts, passes;
# - dependabot.yml validates against the SchemaStore schema vendored in
#   check-jsonschema, so no schema is fetched at run time.
guard_ci_config() {
  local actionlint_image="rhysd/actionlint:1.7.12@sha256:b1934ee5f1c509618f2508e6eb47ee0d3520686341fec936f3b79331f9315667"
  local python_image="python:3.14-slim-bookworm@sha256:516b51cb9db2ef061e465c803e50f64361b82cefd91e525b889b967b83e83527"
  # check-jsonschema and its dependencies at exact versions (binary wheels only).
  local requirements="attrs==26.1.0
certifi==2026.10.23
charset-normalizer==3.5.2
check-jsonschema==0.39.0
click==8.5.0
idna==3.20
jsonschema==4.26.0
jsonschema-specifications==2025.9.1
referencing==0.37.0
regress==2026.9.1
requests==2.34.2
rpds-py==2026.9.1
ruamel.yaml==0.19.1
urllib3==2.8.0"
  local -a workflows=() dependabot=() problems=()
  local file line ref root rc

  while IFS= read -r -d '' file; do
    case "$file" in
      .github/workflows/*.yml | .github/workflows/*.yaml) workflows+=("$file") ;;
      .github/dependabot.yml | .github/dependabot.yaml) dependabot+=("$file") ;;
    esac
  done < <(_guard_files)
  ((${#workflows[@]} + ${#dependabot[@]})) || return 0

  for file in "${workflows[@]}"; do
    while IFS= read -r line; do
      ref="${line#*uses:}"
      ref="${ref%%#*}"
      ref="${ref//[[:space:]\"\']/}"
      case "$ref" in
        ./*) ;;
        docker://*)
          [[ "$ref" =~ @sha256:[0-9a-f]{64}$ ]] ||
            problems+=("$file:${line%%:*}: $ref is not pinned by a sha256 digest")
          ;;
        *)
          [[ "$ref" =~ ^[^@]+@[0-9a-f]{40}$ ]] ||
            problems+=("$file:${line%%:*}: $ref is not pinned by a full commit SHA")
          ;;
      esac
    done < <(grep -nE '^[[:space:]]*(-[[:space:]]+)?uses:' "$MASHKIF_ROOT/$file")
    while IFS= read -r line; do
      problems+=("$file:${line%%:*}: pull_request_target is not allowed")
    done < <(grep -nE '^[^#]*pull_request_target' "$MASHKIF_ROOT/$file")
  done

  require_cmd docker "actionlint and check-jsonschema run in containers" || return

  if ((${#workflows[@]})); then
    rc=0
    docker run --rm --network none -v "$MASHKIF_ROOT:/repo:ro" -w /repo \
      "$actionlint_image" -no-color -shellcheck=/usr/local/bin/shellcheck "${workflows[@]}" >&2 || rc=$?
    case "$rc" in
      0) ;;
      125)
        fail "could not run the actionlint container"
        return "$MASHKIF_EXIT_ENV"
        ;;
      *) problems+=("actionlint reported problems (see above)") ;;
    esac
  fi

  if ((${#dependabot[@]})); then
    if ! root="$(mashkif_tmp_root)"; then
      fail "no scratch location: set MASHKIF_TMP_DIR (locally the T: drive is expected at /mnt/t)"
      return "$MASHKIF_EXIT_ENV"
    fi
    mkdir -p "$root/cache/pip" || return "$MASHKIF_EXIT_ENV"
    rc=0
    # shellcheck disable=SC2016 # Expanded by the container shell.
    docker run --rm --user "$(id -u):$(id -g)" \
      -e HOME=/tmp/home \
      -e PIP_CACHE_DIR=/cache/pip \
      -e PIP_DISABLE_PIP_VERSION_CHECK=1 \
      -e PIP_NO_INPUT=1 \
      -e MASHKIF_REQUIREMENTS="$requirements" \
      -v "$MASHKIF_ROOT:/repo:ro" -v "$root/cache:/cache" -w /repo \
      "$python_image" sh -euc '
        printf "%s\n" "$MASHKIF_REQUIREMENTS" >/tmp/requirements.txt
        { python -m venv /tmp/venv &&
          /tmp/venv/bin/pip install --quiet --only-binary=:all: -r /tmp/requirements.txt; } >&2 || exit 125
        exec /tmp/venv/bin/check-jsonschema --builtin-schema vendor.dependabot "$@"
      ' sh "${dependabot[@]}" >&2 || rc=$?
    case "$rc" in
      0) ;;
      125)
        fail "could not run check-jsonschema (container or pip install failed)"
        return "$MASHKIF_EXIT_ENV"
        ;;
      *) problems+=("${dependabot[*]} does not match the Dependabot schema (see above)") ;;
    esac
  fi

  if ((${#problems[@]})); then
    printf '  %s\n' "${problems[@]}" >&2
    return "$MASHKIF_EXIT_FAILED"
  fi
}

verify_guards() {
  local name rc failed=0 env=0
  for name in hebrew compose_build shell line_endings selection_tests release_tests ci_config; do
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
