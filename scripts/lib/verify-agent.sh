# shellcheck shell=bash
# Agent area: locked NuGet restore, format check, build with warnings as
# errors, tests, and the unsigned MSI. Sourced by scripts/verify.sh.
#
# Agent build contract:
# - Every command runs with agent/ as the working directory, so agent/global.json
#   selects the SDK.
# - WSL (/proc/version mentions Microsoft): the Windows dotnet.exe through
#   interop, never a Linux dotnet. Git Bash on Windows (uname -s is MINGW* or
#   MSYS*, the CI Windows runner): dotnet. Anything else, or a missing or
#   unsuitable SDK, is an environment error (exit 2).
# - MSI: <dotnet> build installer/Mashkif.Installer.wixproj -c Release
#   writes agent/artifacts/msi/Mashkif-<version>-x64.msi, before the tests,
#   because Mashkif.Installer.Tests reads its tables.
# - Install tests (tests/Mashkif.Install.Tests, outside the solution) run only
#   on a GitHub-hosted runner.

_AGENT_DIR="$MASHKIF_ROOT/agent"
_AGENT_SDK_HINT="install the .NET 10 SDK"
# Not in Mashkif.Agent.slnx: it changes the machine (see _agent_install_tests).
_AGENT_INSTALL_TESTS="tests/Mashkif.Install.Tests/Mashkif.Install.Tests.csproj"

# _agent_select_dotnet: sets _AGENT_DOTNET and _AGENT_HOST (wsl or gitbash).
_agent_select_dotnet() {
  case "$(uname -s)" in
    MINGW* | MSYS*)
      _AGENT_HOST=gitbash
      _AGENT_DOTNET=dotnet
      ;;
    *)
      if grep -qi microsoft /proc/version 2>/dev/null; then
        _AGENT_HOST=wsl
        _AGENT_DOTNET=dotnet.exe
      else
        fail "the agent area runs only in WSL or in Git Bash on Windows; $_AGENT_SDK_HINT on Windows"
        return "$MASHKIF_EXIT_ENV"
      fi
      ;;
  esac
  require_cmd "$_AGENT_DOTNET" "$_AGENT_SDK_HINT"
}

# _agent_windows_path <path>: prints the Windows form of a local path.
_agent_windows_path() {
  case "$_AGENT_HOST" in
    wsl) wslpath -w "$1" ;;
    gitbash) cygpath -w "$1" ;;
  esac
}

# _agent_dotnet <args...>: runs the SDK from agent/.
_agent_dotnet() {
  (cd "$_AGENT_DIR" && "$_AGENT_DOTNET" "$@")
}

# _agent_global_json_version: prints sdk.version from agent/global.json.
_agent_global_json_version() {
  sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([0-9][0-9.]*\)".*/\1/p' "$_AGENT_DIR/global.json" | head -n 1
}

# _agent_check_sdk: the SDK that agent/global.json resolves must be the pinned
# version or a later patch in the same feature band (rollForward latestPatch).
_agent_check_sdk() {
  local pinned actual p_major p_minor p_patch a_major a_minor a_patch
  pinned="$(_agent_global_json_version)"
  if [[ ! "$pinned" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    fail "cannot read sdk.version from agent/global.json"
    return "$MASHKIF_EXIT_ENV"
  fi
  if ! actual="$(_agent_dotnet --version 2>&1)"; then
    printf '%s\n' "$actual" >&2
    fail "no installed SDK satisfies agent/global.json ($pinned or a later $((${pinned##*.} / 100))xx patch); $_AGENT_SDK_HINT"
    return "$MASHKIF_EXIT_ENV"
  fi
  actual="${actual//$'\r'/}"
  IFS=. read -r p_major p_minor p_patch <<<"$pinned"
  IFS=. read -r a_major a_minor a_patch <<<"${actual%%-*}"
  if [[ "$a_major" != "$p_major" || "$a_minor" != "$p_minor" ]] ||
    ((a_patch / 100 != p_patch / 100 || a_patch < p_patch)); then
    fail "dotnet --version is $actual, but agent/global.json needs $pinned or a later patch in the same feature band; $_AGENT_SDK_HINT"
    return "$MASHKIF_EXIT_ENV"
  fi
  log "  SDK $actual ($_AGENT_HOST: $_AGENT_DOTNET)"
}

# _agent_version: prints <Version> from agent/Directory.Build.props.
_agent_version() {
  sed -n 's:.*<Version>\([^<]*\)</Version>.*:\1:p' "$_AGENT_DIR/Directory.Build.props" | head -n 1
}

# _agent_step <name> <dotnet args...>: runs one check and reports it.
_agent_step() {
  local name="$1"
  shift
  log "  -> $name: $_AGENT_DOTNET $*"
  if ! _agent_dotnet "$@" >&2; then
    log "  FAIL  $name"
    return "$MASHKIF_EXIT_FAILED"
  fi
  log "  ok    $name"
}

verify_agent() {
  _agent_select_dotnet || return
  if [[ "$_AGENT_HOST" == wsl ]] && [[ "$(wslpath -w "$_AGENT_DIR")" == \\\\* ]]; then
    fail "dotnet.exe cannot build from a WSL file system path; use a checkout on a Windows drive (/mnt/<drive>/...)"
    return "$MASHKIF_EXIT_ENV"
  fi

  # Quiet, reproducible SDK runs that leave no build servers behind.
  export DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1 DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1 MSBUILDDISABLENODEREUSE=1
  # Tests write their temporary files here instead of the system temporary folder.
  local scratch
  scratch="$(mashkif_mktemp agent-tests)" || return "$MASHKIF_EXIT_ENV"
  MASHKIF_TEST_TMP="$(_agent_windows_path "$scratch")"
  export MASHKIF_TEST_TMP
  if [[ "$_AGENT_HOST" == wsl ]]; then
    # Environment variables reach Windows processes only through WSLENV.
    export WSLENV="${WSLENV:+$WSLENV:}DOTNET_CLI_TELEMETRY_OPTOUT:DOTNET_NOLOGO:DOTNET_SKIP_FIRST_TIME_EXPERIENCE:MSBUILDDISABLENODEREUSE:MASHKIF_TEST_TMP"
  fi

  local rc=0
  _agent_run_checks || rc=$?
  rm -rf -- "$scratch"
  return "$rc"
}

_agent_run_checks() {
  _agent_check_sdk || return

  local version msi
  version="$(_agent_version)"
  if [[ -z "$version" ]]; then
    fail "cannot read <Version> from agent/Directory.Build.props"
    return "$MASHKIF_EXIT_FAILED"
  fi
  msi="$_AGENT_DIR/artifacts/msi/Mashkif-$version-x64.msi"
  rm -f -- "$msi"

  _agent_step "restore (locked)" restore Mashkif.Agent.slnx --locked-mode || return
  _agent_step "restore installer (locked)" restore installer/Mashkif.Installer.wixproj --locked-mode || return
  _agent_step "restore install tests (locked)" restore "$_AGENT_INSTALL_TESTS" --locked-mode || return
  _agent_step "format" format Mashkif.Agent.slnx --verify-no-changes --no-restore --verbosity minimal || return
  _agent_step "format install tests" format "$_AGENT_INSTALL_TESTS" --verify-no-changes --no-restore --verbosity minimal || return
  _agent_step "build" build Mashkif.Agent.slnx -c Release --no-restore -warnaserror --disable-build-servers || return
  _agent_step "build install tests" build "$_AGENT_INSTALL_TESTS" -c Release --no-restore -warnaserror --disable-build-servers || return
  # The MSI comes before the tests: Mashkif.Installer.Tests reads its tables.
  _agent_step "msi" build installer/Mashkif.Installer.wixproj -c Release --no-restore -warnaserror --disable-build-servers || return

  if [[ ! -s "$msi" ]]; then
    fail "the MSI build did not produce ${msi#"$MASHKIF_ROOT"/}"
    return "$MASHKIF_EXIT_FAILED"
  fi
  log "  MSI   ${msi#"$MASHKIF_ROOT"/} ($(wc -c <"$msi") bytes)"

  _agent_step "test" test --solution Mashkif.Agent.slnx -c Release --no-build || return
  _agent_install_tests "$msi"
}

# _agent_install_tests <msi>: installs, repairs, upgrades, and uninstalls the
# real MSI. Only on a GitHub-hosted runner, a disposable VM; never on a
# developer machine. The test assembly enforces the same rule and a full
# preflight itself (InstallSafetyGate); the check here only reports early.
_agent_install_tests() {
  local msi="$1" upgrade_root upgrade_msi
  if [[ "${GITHUB_ACTIONS:-}" != true || "${RUNNER_ENVIRONMENT:-}" != github-hosted ]]; then
    log "  install tests: not run (GitHub-hosted runner only)"
    return 0
  fi
  if sc.exe query Mashkif >/dev/null 2>&1 || reg.exe query 'HKLM\SOFTWARE\Mashkif' >/dev/null 2>&1 ||
    [[ -e "$(cygpath -u "$PROGRAMDATA")/Mashkif" ]]; then
    fail "the runner already has a Mashkif service, registry key, or %ProgramData%\Mashkif; install tests refused"
    return "$MASHKIF_EXIT_ENV"
  fi

  # A second MSI with a higher version, for the upgrade. Test artifact only.
  upgrade_root="$(mashkif_mktemp agent-upgrade)" || return "$MASHKIF_EXIT_ENV"
  upgrade_msi="$upgrade_root/msi/Mashkif-0.1.1-x64.msi"
  local rc=0
  _agent_step "upgrade msi (0.1.1)" build installer/Mashkif.Installer.wixproj -c Release --no-restore --no-incremental -warnaserror \
    --disable-build-servers -p:Version=0.1.1 "-p:ArtifactsRoot=$(_agent_windows_path "$upgrade_root")\\" || rc=$?
  if ((rc == 0)) && [[ ! -s "$upgrade_msi" ]]; then
    fail "the upgrade MSI build did not produce $upgrade_msi"
    rc="$MASHKIF_EXIT_FAILED"
  fi

  if ((rc == 0)); then
    MASHKIF_INSTALL_TEST_MSI="$(_agent_windows_path "$msi")"
    MASHKIF_INSTALL_TEST_UPGRADE_MSI="$(_agent_windows_path "$upgrade_msi")"
    export MASHKIF_INSTALL_TEST_MSI MASHKIF_INSTALL_TEST_UPGRADE_MSI
    _agent_step "install tests" test --project "$_AGENT_INSTALL_TESTS" -c Release --no-build || rc=$?
  fi
  rm -rf -- "$upgrade_root"
  return "$rc"
}
