#!/usr/bin/env bash
# Tests for the parts of scripts/lib/verify-agent.sh that need no .NET SDK:
# the parsing of a dotnet test --list-tests listing, which decides which
# install tests run.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/common.sh
source "$SCRIPT_DIR/../lib/common.sh"
# shellcheck source=../lib/verify-agent.sh
source "$SCRIPT_DIR/../lib/verify-agent.sh"

failures=0
esc=$'\e'

# expect <description> <expected exit code> <expected output> <listing>
expect() {
  local description="$1" want_rc="$2" want="$3" have rc=0
  have="$(_agent_parse_test_listing Mashkif.Install.Tests <<<"$4" 2>/dev/null)" || rc=$?
  if [[ "$rc" == "$want_rc" && "$have" == "$want" ]]; then
    printf '  ok    %s\n' "$description" >&2
  else
    printf '  FAIL  %s\n        expected: exit %s, %q\n        actual:   exit %s, %q\n' \
      "$description" "$want_rc" "$want" "$rc" "$have" >&2
    failures=$((failures + 1))
  fi
}

two=$'Mashkif.Install.Tests.InstallTests.A_test\nMashkif.Install.Tests.InstallTests.B_test'
header='Discovering tests from D:\a\agent\tests\Mashkif.Install.Tests\bin\Release\Mashkif.Install.Tests.dll (net10.0|x64)'
assembly='Discovered 2 tests in assembly - D:\a\agent\tests\Mashkif.Install.Tests\bin\Release\Mashkif.Install.Tests.dll (net10.0|x64)'
body="  Mashkif.Install.Tests.InstallTests.A_test
  Mashkif.Install.Tests.InstallTests.B_test"

expect "plain listing" 0 "$two" "$header

$assembly
$body

Discovered 2 tests."

# As in GitHub Actions: CRLF line ends and an ANSI-colored summary line.
expect "colored listing with CRLF" 0 "$two" "$header"$'\r\n\r\n'"$assembly"$'\r\n'"${body//$'\n'/$'\r\n'}"$'\r\n\r\n'"${esc}[32mDiscovered 2 tests."$'\r\n'"${esc}[m"

expect "one test" 0 "Mashkif.Install.Tests.InstallTests.A_test" "  Mashkif.Install.Tests.InstallTests.A_test

Discovered 1 test."

expect "a count that does not match fails" 1 "" "$body

Discovered 3 tests."

expect "no summary line fails" 1 "" "$body"

expect "no tests fails" 1 "" "Discovered 0 tests."

expect "tests of another namespace are not taken" 1 "" "  Other.Tests.A_test

Discovered 1 test."

if ((failures)); then
  printf '%d verify-agent test(s) failed\n' "$failures" >&2
  exit 1
fi
printf 'verify-agent tests: all passed\n' >&2
