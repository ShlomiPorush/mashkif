# shellcheck shell=bash
# Server area: format, lint, typecheck, tests (unit, and integration against a
# real PostgreSQL container), build, migration drift, and readiness tests of the
# built server against PostgreSQL. Sourced by scripts/verify.sh.

# shellcheck source=node-container.sh
source "$MASHKIF_ROOT/scripts/lib/node-container.sh"

MASHKIF_POSTGRES_IMAGE="postgres:18.6-bookworm@sha256:5c4783a8cc3f0074912164f94dfa1be4e043438f0f707cf968d7af9a0d31a2c8"

# _server_probe <app-container> <path> [protocol-version]
# Prints "<status> <Mashkif-Protocol-Version header or -> <body>" for a request
# made from inside the app container, or "000 - <error>" when it fails.
_server_probe() {
  local container="$1" path="$2" version="${3:-}"
  # shellcheck disable=SC2016 # JavaScript, not shell.
  docker exec "$container" node -e '
    const [path, version] = process.argv.slice(1);
    const headers = version ? { "Mashkif-Protocol-Version": version } : {};
    fetch("http://127.0.0.1:8080" + path, { headers, signal: AbortSignal.timeout(15000) })
      .then(async (r) => {
        const header = r.headers.get("mashkif-protocol-version") ?? "-";
        console.log(`${r.status} ${header} ${await r.text()}`);
      })
      .catch((e) => console.log(`000 - ${e.message}`));
  ' "$path" "$version" 2>&1
}

# _server_start_postgres <network> <name> <password>: starts a throwaway
# PostgreSQL container on tmpfs and waits until it accepts connections. The
# caller removes the container.
_server_start_postgres() {
  local net="$1" name="$2" password="$3" i
  docker run -d --name "$name" --network "$net" --tmpfs /var/lib/postgresql \
    -e POSTGRES_USER=mashkif -e POSTGRES_PASSWORD="$password" -e POSTGRES_DB=mashkif \
    "$MASHKIF_POSTGRES_IMAGE" >/dev/null || return "$MASHKIF_EXIT_ENV"
  for ((i = 0; i < 60; i++)); do
    docker exec "$name" pg_isready -q -h 127.0.0.1 -U mashkif -d mashkif && return 0
    sleep 1
  done
  fail "PostgreSQL did not become ready"
  docker logs "$name" >&2 || true
  return "$MASHKIF_EXIT_ENV"
}

# _server_tests: runs every server test, unit and integration, in the Node
# container. The integration tests use a throwaway PostgreSQL container on an
# internal network, so the tests still have no internet access; each test file
# creates its own database there. Everything is removed afterwards.
_server_tests() (
  set -euo pipefail
  local scratch id net db password rc=0

  scratch="$(mashkif_mktemp server-tests)" || exit "$MASHKIF_EXIT_ENV"
  id="$(printf '%s' "${scratch##*.}" | tr '[:upper:]' '[:lower:]')"
  net="mashkif-verify-server-tests-$id"
  db="$net-db"
  password="verify-$id"

  # shellcheck disable=SC2329 # Invoked by the EXIT trap.
  cleanup() {
    docker rm -f "$db" >/dev/null 2>&1 || true
    docker network rm "$net" >/dev/null 2>&1 || true
    rm -rf -- "$scratch"
  }
  trap cleanup EXIT

  docker network create --internal "$net" >/dev/null || exit "$MASHKIF_EXIT_ENV"
  _server_start_postgres "$net" "$db" "$password" || exit
  mashkif_node_run "$net" server env \
    MASHKIF_TEST_DATABASE_URL="postgres://mashkif:$password@$db:5432/mashkif" \
    corepack pnpm run test >&2 || rc=$?
  if ((rc == 0)); then
    log "  ok    server tests (unit, and integration against PostgreSQL)"
  else
    log "  FAIL  server tests (unit, and integration against PostgreSQL) (exit $rc)"
    exit "$MASHKIF_EXIT_FAILED"
  fi
)

# _server_readiness_tests: runs the built server against a throwaway PostgreSQL
# container on a uniquely named network, with a generated dummy file standing
# in for GeoLite2-ASN (it proves readability only). Everything it creates is
# removed on success and on failure.
_server_readiness_tests() (
  set -euo pipefail
  local scratch id net db app password database_url app_key token failures=0 out i rc

  scratch="$(mashkif_mktemp server-readiness)" || exit "$MASHKIF_EXIT_ENV"
  id="$(printf '%s' "${scratch##*.}" | tr '[:upper:]' '[:lower:]')"
  net="mashkif-verify-server-$id"
  db="$net-db"
  app="$net-app"
  password="verify-$id"
  database_url="postgres://mashkif:$password@$db:5432/mashkif"
  app_key="$(head -c 32 /dev/urandom | base64)"

  # shellcheck disable=SC2329 # Invoked by the EXIT trap.
  cleanup() {
    docker rm -f "$app" "$db" >/dev/null 2>&1 || true
    docker network rm "$net" >/dev/null 2>&1 || true
    rm -rf -- "$scratch"
  }
  trap cleanup EXIT

  pass() { log "  ok    server $1"; }
  failed() {
    log "  FAIL  server $1"
    [[ -n "${2:-}" ]] && log "        $2"
    failures=$((failures + 1))
  }

  # expect <description> <status> <substring> <path> [protocol-version]
  expect() {
    local description="$1" status="$2" substring="$3"
    out="$(_server_probe "$app" "$4" "${5:-}")"
    if [[ "${out%% *}" == "$status" && "$out" == *"$substring"* ]]; then
      pass "$description"
    else
      failed "$description" "expected $status containing $substring, got: $out"
    fi
  }

  docker network create "$net" >/dev/null || exit "$MASHKIF_EXIT_ENV"
  _server_start_postgres "$net" "$db" "$password" || exit

  mkdir -p "$scratch/geoip"
  head -c 4096 /dev/urandom >"$scratch/geoip/GeoLite2-ASN.mmdb"

  # PORT is not set, so this also covers the 8080 default.
  docker run -d --name "$app" --network "$net" --user "$(id -u):$(id -g)" \
    -e DATABASE_URL="$database_url" \
    -e MASHKIF_GEOIP_ASN_PATH=/geoip/GeoLite2-ASN.mmdb \
    -e MASHKIF_APP_KEY="$app_key" -e MASHKIF_PUBLIC_URL=http://127.0.0.1:8080 \
    -v "$MASHKIF_ROOT:/repo:ro" -v "$scratch/geoip:/geoip:ro" -w /repo \
    "$MASHKIF_NODE_IMAGE" node server/dist/main.js >/dev/null || exit "$MASHKIF_EXIT_ENV"
  for ((i = 0; i < 60; i++)); do
    [[ "$(_server_probe "$app" /healthz)" == 200* ]] && break
    if [[ "$(docker inspect -f '{{.State.Running}}' "$app" 2>/dev/null)" != true ]]; then
      break
    fi
    sleep 1
  done
  if [[ "$(_server_probe "$app" /healthz)" != 200* ]]; then
    failed "starts and serves /healthz"
    docker logs "$app" >&2 || true
    exit "$MASHKIF_EXIT_FAILED"
  fi
  pass "starts, applies migrations, and listens on 8080"

  expect "liveness /healthz is 200" 200 '{"status":"ok"}' /healthz
  expect "readiness /readyz is 200 when ready" 200 '"status":"ready"' /readyz
  out="$(docker exec "$db" psql -U mashkif -d mashkif -tAc \
    "select to_regclass('drizzle.__drizzle_migrations') is not null")"
  if [[ "$out" == t ]]; then
    pass "migrations table drizzle.__drizzle_migrations exists"
  else
    failed "migrations table drizzle.__drizzle_migrations exists" "got: $out"
  fi
  expect "agent health answers protocol version 1" 200 \
    ' 1 {"status":"ok","protocolVersion":1}' /api/agent/health 1
  expect "agent health without the version header is 400" 400 \
    '"error":"protocol_version_missing"' /api/agent/health
  expect "admin status reports that setup is required" 200 '{"setupRequired":true}' /api/admin/status
  expect "Better Auth routes outside the allowlist are 404" 404 '"error":"not_found"' \
    /api/auth/list-sessions

  # Operator commands, as the README documents them.
  rc=0
  out="$(docker exec "$app" node server/dist/cli.js 2>&1)" || rc=$?
  if ((rc == 2)) && [[ "$out" == *"Usage: node server/dist/cli.js"* ]]; then
    pass "cli.js without a command prints usage and exits 2"
  else
    failed "cli.js without a command prints usage and exits 2" "exit $rc: $out"
  fi
  rc=0
  out="$(docker exec "$app" node server/dist/cli.js reset-admin 2>&1)" || rc=$?
  if ((rc == 1)) && [[ "$out" == *"No admin exists yet"* ]]; then
    pass "cli.js reset-admin refuses before an admin exists"
  else
    failed "cli.js reset-admin refuses before an admin exists" "exit $rc: $out"
  fi
  rc=0
  out="$(docker exec "$app" node server/dist/cli.js setup-token 2>&1)" || rc=$?
  token="$(sed -n 's/^Setup token: //p' <<<"$out")"
  if ((rc == 0)) && [[ "$token" =~ ^[A-Za-z0-9_-]{32}$ ]]; then
    pass "cli.js setup-token prints a token"
  else
    failed "cli.js setup-token prints a token" "exit $rc: $out"
  fi
  out="$(docker exec "$db" psql -U mashkif -d mashkif -tAc \
    "select count(*) || ' ' || bool_and(token_hash <> '$token') from admin_setup_token")"
  if [[ "$out" == "1 true" ]]; then
    pass "the setup token is stored hashed"
  else
    failed "the setup token is stored hashed" "got: $out"
  fi

  rm -f "$scratch/geoip/GeoLite2-ASN.mmdb"
  expect "readiness is 503 naming geoip when the file is missing" 503 \
    '"failing":["geoip"]' /readyz
  head -c 4096 /dev/urandom >"$scratch/geoip/GeoLite2-ASN.mmdb"
  expect "readiness recovers when the file is back" 200 '"status":"ready"' /readyz

  docker stop "$db" >/dev/null
  expect "readiness is 503 naming database when PostgreSQL is down" 503 \
    '"failing":["database"]' /readyz
  expect "liveness stays 200 while PostgreSQL is down" 200 '{"status":"ok"}' /healthz

  if docker logs "$app" 2>&1 | grep -qF -- "$password"; then
    failed "logs never contain the database password"
  else
    pass "logs never contain the database password"
  fi
  if docker logs "$app" 2>&1 | grep -qF -- "$app_key"; then
    failed "logs never contain MASHKIF_APP_KEY"
  else
    pass "logs never contain MASHKIF_APP_KEY"
  fi

  if out="$(docker run --rm --network "$net" --user "$(id -u):$(id -g)" \
    -e DATABASE_URL="$database_url" -e MASHKIF_GEOIP_ASN_PATH=/geoip/GeoLite2-ASN.mmdb \
    -e MASHKIF_APP_KEY="$app_key" -e MASHKIF_PUBLIC_URL=http://127.0.0.1:8080 \
    -v "$MASHKIF_ROOT:/repo:ro" -w /repo "$MASHKIF_NODE_IMAGE" node server/dist/main.js 2>&1)"; then
    failed "refuses to start when PostgreSQL is down" "it exited 0: $out"
  elif [[ "$out" == *"database migration failed"* && "$out" != *"$password"* ]]; then
    pass "refuses to start when PostgreSQL is down"
  else
    failed "refuses to start when PostgreSQL is down" "unexpected output: $out"
  fi

  if out="$(docker run --rm --network none --user "$(id -u):$(id -g)" \
    -v "$MASHKIF_ROOT:/repo:ro" -w /repo "$MASHKIF_NODE_IMAGE" node server/dist/main.js 2>&1)"; then
    failed "refuses to start without configuration" "it exited 0: $out"
  elif [[ "$out" == *"DATABASE_URL is required"* && "$out" == *"MASHKIF_GEOIP_ASN_PATH is required"* &&
    "$out" == *"MASHKIF_APP_KEY is required"* && "$out" == *"MASHKIF_PUBLIC_URL is required"* ]]; then
    pass "refuses to start without configuration"
  else
    failed "refuses to start without configuration" "unexpected output: $out"
  fi

  if out="$(docker run --rm --network none --user "$(id -u):$(id -g)" \
    -e DATABASE_URL="$database_url" -e MASHKIF_GEOIP_ASN_PATH=/geoip/GeoLite2-ASN.mmdb \
    -e MASHKIF_APP_KEY=change-me -e MASHKIF_PUBLIC_URL=http://127.0.0.1:8080 \
    -v "$MASHKIF_ROOT:/repo:ro" -w /repo "$MASHKIF_NODE_IMAGE" node server/dist/main.js 2>&1)"; then
    failed "refuses to start with the placeholder MASHKIF_APP_KEY" "it exited 0: $out"
  elif [[ "$out" == *"MASHKIF_APP_KEY must be at least 32 random bytes"* && "$out" != *change-me* ]]; then
    pass "refuses to start with the placeholder MASHKIF_APP_KEY"
  else
    failed "refuses to start with the placeholder MASHKIF_APP_KEY" "unexpected output: $out"
  fi

  ((failures == 0)) || exit "$MASHKIF_EXIT_FAILED"
)

verify_server() {
  local rc=0 step=0
  mashkif_js_setup || return
  mashkif_node_steps server server \
    "format and lint|corepack pnpm run check" \
    "typecheck|corepack pnpm run typecheck" || rc=$?
  _server_tests || {
    step=$?
    ((step > rc)) && rc=$step
  }
  mashkif_node_steps server server \
    "build|rm -rf dist && corepack pnpm run build" \
    "migrations match the schema|source ../scripts/lib/migration-drift.sh && mashkif_migration_drift drizzle" \
    "the drift check fails on drift (self-test)|source ../scripts/lib/migration-drift.sh && mashkif_migration_drift_self_test" || {
    step=$?
    ((step > rc)) && rc=$step
  }
  ((rc == 0)) || return "$rc"
  _server_readiness_tests
}
