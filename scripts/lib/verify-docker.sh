# shellcheck shell=bash
# Docker area: both Compose files, the app image and its build context, a
# Compose-free runtime test against a real PostgreSQL container, and the
# local.sh and try-pr.sh tests. Sourced by scripts/verify.sh.
#
# Nothing here touches the development environment: containers, networks, and
# images get unique names and are removed on success and on failure, and the
# script tests run against a fake docker.

# shellcheck source=dev-env.sh
source "$MASHKIF_ROOT/scripts/lib/dev-env.sh"
# shellcheck source=node-container.sh
source "$MASHKIF_ROOT/scripts/lib/node-container.sh"

_docker_pass() { log "  ok    docker $1"; }
_docker_failed() {
  log "  FAIL  docker $1"
  [[ -n "${2:-}" ]] && log "        $2"
  _DOCKER_FAILURES=$((_DOCKER_FAILURES + 1))
}

# _docker_compose_json <file> <project-dir>: effective configuration as JSON,
# with only the placeholder values from .env.example.
_docker_compose_json() {
  env -u MASHKIF_IMAGE_TAG -u MASHKIF_DATA_DIR -u MASHKIF_GEOIP_DIR -u MASHKIF_TRAEFIK_NETWORK \
    -u COMPOSE_PROJECT_NAME -u COMPOSE_FILE \
    docker compose -f "$1" --project-directory "$2" config --format json
}

# Structural checks of the effective Compose configuration. Prints one problem
# per line; prints nothing when the file is correct.
# shellcheck disable=SC2016 # Python source.
_DOCKER_COMPOSE_CHECKS='
import json, re, sys
kind, path, raw_path, db_image = sys.argv[1:5]
config = json.load(open(path, encoding="utf-8"))
raw = open(raw_path, encoding="utf-8").read()
problems = []
def need(condition, message):
    if not condition:
        problems.append(message)

services = config.get("services", {})
need(sorted(services) == ["app", "db"], f"services must be app and db, got {sorted(services)}")
need(not config.get("volumes"), "named volumes are not allowed")
for name, service in services.items():
    need("build" not in service, f"{name} must not build")
    for volume in service.get("volumes", []):
        need(volume.get("type") == "bind", f"{name}: only bind mounts are allowed, got {volume}")
    need(service.get("cap_drop") == ["ALL"], f"{name}: cap_drop must be [ALL]")
    need("no-new-privileges:true" in service.get("security_opt", []), f"{name}: needs no-new-privileges")
app, db = services.get("app", {}), services.get("db", {})

need(raw.count("env_file: .env") == 2, "app and db must both use env_file: .env")
need(app.get("environment", {}).get("MASHKIF_GEOIP_ASN_PATH") == "/geoip/GeoLite2-ASN.mmdb",
     "app: MASHKIF_GEOIP_ASN_PATH must be /geoip/GeoLite2-ASN.mmdb")
geoip = [v for v in app.get("volumes", []) if v.get("target") == "/geoip"]
need(len(geoip) == 1 and geoip[0].get("read_only") is True
     and geoip[0].get("source") == "/absolute/path/to/geoip-directory",
     "app: the GeoIP directory must be a read-only bind of MASHKIF_GEOIP_DIR at /geoip")
need(app.get("read_only") is True, "app: the root file system must be read-only")
need(app.get("depends_on", {}).get("db", {}).get("condition") == "service_healthy",
     "app must wait for a healthy db")

need(db.get("image") == db_image, f"db image must be {db_image}")
need(db.get("user") == "999:999", "db must run as 999:999")
data = db.get("volumes", [])
need(len(data) == 1 and data[0].get("source") == "/absolute/path/to/mashkif-data/postgres"
     and data[0].get("target") == "/var/lib/postgresql",
     "db: data must be a bind of ${MASHKIF_DATA_DIR}/postgres at /var/lib/postgresql")
need(db.get("command") == ["postgres"], "db command must repeat the image CMD [postgres]")
need("exec docker-entrypoint.sh" in " ".join(db.get("entrypoint") or []),
     "db entrypoint must end by running the image ENTRYPOINT docker-entrypoint.sh")
test = " ".join(db.get("healthcheck", {}).get("test", []))
need("pg_isready" in test and "POSTGRES_DB" in test, "db health check must run pg_isready against the application database")

allowed = {"MASHKIF_DATA_DIR", "MASHKIF_GEOIP_DIR"}
if kind == "production":
    allowed |= {"MASHKIF_IMAGE_TAG", "MASHKIF_TRAEFIK_NETWORK"}
    need(config.get("name") == "mashkif", "project name must be mashkif")
    need(app.get("image") == "ghcr.io/shlomiporush/mashkif:0.0.0", "app image must come from GHCR with MASHKIF_IMAGE_TAG, got " + str(app.get("image")))
    labels = app.get("labels", {})
    need(labels.get("traefik.enable") == "true", "app needs traefik.enable")
    need(labels.get("traefik.docker.network") == "traefik-network-name", "traefik.docker.network must be MASHKIF_TRAEFIK_NETWORK")
    traefik = config.get("networks", {}).get("traefik", {})
    need(traefik.get("external") is True and traefik.get("name") == "traefik-network-name",
         "the traefik network must be external and named by MASHKIF_TRAEFIK_NETWORK")
    need(not app.get("ports"), "production app must not publish ports; Traefik routes to it")
else:
    need(config.get("name") == "mashkif-dev", "project name must be mashkif-dev")
    need(app.get("image") == "mashkif-app:dev", "app image must be mashkif-app:dev")
    ports = app.get("ports", [])
    need(len(ports) == 1 and ports[0].get("host_ip") == "127.0.0.1", "app must publish one port on 127.0.0.1 only")
    need(not app.get("labels"), "development app has no Traefik labels")

used = set(re.findall(r"(?<!\$)\$\{?([A-Za-z_][A-Za-z0-9_]*)", raw))
need(used <= allowed, f"interpolation outside the allowed variables: {sorted(used - allowed)}")
print("\n".join(problems))
'

_docker_compose_checks() {
  local scratch="$1" kind file problems
  mkdir -p "$scratch/compose"
  cp "$MASHKIF_ROOT/.env.example" "$scratch/compose/.env"
  for kind in production development; do
    file="$MASHKIF_ROOT/docker-compose.yml"
    [[ "$kind" == development ]] && file="$MASHKIF_ROOT/config/docker-compose-dev.example.yml"
    if ! _docker_compose_json "$file" "$scratch/compose" >"$scratch/compose/$kind.json" 2>"$scratch/compose/$kind.err"; then
      _docker_failed "$kind Compose file is valid with .env.example" "$(cat "$scratch/compose/$kind.err")"
      continue
    fi
    _docker_pass "$kind Compose file is valid with .env.example"
    problems="$(python3 -I -c "$_DOCKER_COMPOSE_CHECKS" "$kind" "$scratch/compose/$kind.json" "$file" "$MASHKIF_DB_IMAGE" 2>&1)" ||
      problems="checker failed: $problems"
    if [[ -z "$problems" ]]; then
      _docker_pass "$kind Compose file follows the container contract"
    else
      _docker_failed "$kind Compose file follows the container contract" "${problems//$'\n'/; }"
    fi
  done

  mkdir -p "$scratch/compose-missing"
  grep -v '^MASHKIF_DATA_DIR=' "$MASHKIF_ROOT/.env.example" >"$scratch/compose-missing/.env"
  for file in docker-compose.yml config/docker-compose-dev.example.yml; do
    if _docker_compose_json "$MASHKIF_ROOT/$file" "$scratch/compose-missing" >/dev/null 2>"$scratch/compose-missing/err"; then
      _docker_failed "$file refuses a missing MASHKIF_DATA_DIR" "docker compose config succeeded"
    elif grep -q 'set MASHKIF_DATA_DIR' "$scratch/compose-missing/err"; then
      _docker_pass "$file refuses a missing MASHKIF_DATA_DIR"
    else
      _docker_failed "$file refuses a missing MASHKIF_DATA_DIR" "$(cat "$scratch/compose-missing/err")"
    fi
  done

  if grep -q "^ARG NODE_IMAGE=$MASHKIF_NODE_IMAGE\$" "$MASHKIF_ROOT/config/docker/app.Dockerfile"; then
    _docker_pass "app.Dockerfile uses the pinned Node image of scripts/lib/node-container.sh"
  else
    _docker_failed "app.Dockerfile uses the pinned Node image of scripts/lib/node-container.sh"
  fi
  if grep -qE '^(MASHKIF_DATA_DIR|MASHKIF_GEOIP_DIR)=/absolute/path/' "$MASHKIF_ROOT/.env.example" &&
    grep -q '^POSTGRES_PASSWORD=change-me$' "$MASHKIF_ROOT/.env.example"; then
    _docker_pass ".env.example holds placeholders only"
  else
    _docker_failed ".env.example holds placeholders only"
  fi
}

# _docker_context <scratch> <marker>: copies the working tree (tracked and
# untracked, not ignored) and plants files that must never reach the image.
_DOCKER_PLANTED=(
  .env .env.local docker-compose-dev.yml GeoLite2-ASN.mmdb mashkif-leak-root.txt
  server/.env server/src/.env server/src/GeoLite2-ASN.mmdb server/mashkif-leak.txt
  server/dist/mashkif-leak.js server/node_modules/mashkif-leak/index.js server/coverage/mashkif-leak.txt
  web/.env web/.env.production web/dist/mashkif-leak.js web/node_modules/mashkif-leak.js
  node_modules/mashkif-leak/index.js contracts/mashkif-leak.txt config/mashkif-leak.txt
  docs/mashkif-leak.md agent/mashkif-leak.txt scripts/mashkif-leak.sh .git/mashkif-leak
)

_docker_context() {
  local scratch="$1" marker="$2" file
  mkdir -p "$scratch/context"
  while IFS= read -r -d '' file; do
    [[ -f "$MASHKIF_ROOT/$file" ]] && printf '%s\0' "$file"
  done < <(git -C "$MASHKIF_ROOT" ls-files -z --cached --others --exclude-standard) |
    tar -C "$MASHKIF_ROOT" --null -T - -cf - | tar -C "$scratch/context" -xf - || return
  for file in "${_DOCKER_PLANTED[@]}"; do
    mkdir -p "$(dirname "$scratch/context/$file")"
    printf '%s %s\n' "$marker" "$file" >"$scratch/context/$file"
  done
}

# _docker_context_filter <scratch>: exports exactly what the ignore file lets
# into the build context (a FROM scratch build that copies everything, using
# the same ignore file) and checks it against the planted files.
_docker_context_filter() {
  local scratch="$1" file leaked=() missing=()
  mkdir -p "$scratch/filter"
  printf 'FROM scratch\nCOPY . /\n' >"$scratch/filter/context.Dockerfile"
  cp "$MASHKIF_ROOT/config/docker/app.Dockerfile.dockerignore" "$scratch/filter/context.Dockerfile.dockerignore"
  if ! docker build -q -f "$scratch/filter/context.Dockerfile" \
    --output "type=local,dest=$scratch/filter/out" "$scratch/context" >/dev/null 2>"$scratch/filter/err"; then
    _docker_failed "the build context filter can be inspected" "$(cat "$scratch/filter/err")"
    return 0
  fi
  for file in "${_DOCKER_PLANTED[@]}"; do
    [[ -e "$scratch/filter/out/$file" ]] && leaked+=("$file")
  done
  for file in package.json pnpm-lock.yaml server/src/main.ts server/drizzle/meta/_journal.json web/index.html; do
    [[ -e "$scratch/filter/out/$file" ]] || missing+=("$file")
  done
  if ((${#leaked[@]})); then
    _docker_failed "the build context excludes every planted file" "sent to the build: ${leaked[*]}"
  elif ((${#missing[@]})); then
    _docker_failed "the build context includes the sources the build needs" "missing: ${missing[*]}"
  else
    _docker_pass "the build context excludes every planted file and keeps the sources ($(find "$scratch/filter/out" -type f | wc -l) files sent)"
  fi
  rm -rf -- "$scratch/filter"
}

_docker_image_checks() {
  local image="$1" marker="$2" scratch="$3" out container
  out="$(docker image inspect -f '{{.Config.User}}' "$image")" || out=""
  if [[ "$out" == 10001:10001 ]]; then
    _docker_pass "image runs as the dedicated user 10001:10001"
  else
    _docker_failed "image runs as the dedicated user 10001:10001" "Config.User is '$out'"
  fi
  out="$(docker image inspect -f '{{json .Config.Healthcheck.Test}}' "$image")" || out=""
  if [[ "$out" == *"/readyz"* ]]; then
    _docker_pass "image health check probes /readyz"
  else
    _docker_failed "image health check probes /readyz" "$out"
  fi
  out="$(docker run --rm --network none --entrypoint sh "$image" -c \
    'find /app ! -type l \( -perm -o+w -o -perm -g+w -o -user mashkif \) -print | head -5; if [ -d /app/server/src ]; then echo /app/server/src; fi')" || out="could not inspect /app"
  if [[ -z "$out" ]]; then
    _docker_pass "application files are root-owned, not writable by the runtime user, and contain no sources"
  else
    _docker_failed "application files are root-owned, not writable by the runtime user, and contain no sources" "$out"
  fi

  container="$(docker create "$image")" || container=""
  [[ -z "$container" ]] || _DOCKER_CLEANUP+=("$container")
  if [[ -z "$container" ]] || ! docker export "$container" >"$scratch/image.tar"; then
    _docker_failed "no planted file reaches the image" "could not export the image file system"
    return 0
  fi
  docker rm "$container" >/dev/null || true
  out="$(tar -tf "$scratch/image.tar" | grep -E '^app/(.*/)?(\.env(\..*)?|[^/]*\.mmdb|docker-compose-dev\.yml)$|mashkif-leak' | head -5 || true)"
  if [[ -n "$out" ]]; then
    _docker_failed "no planted file reaches the image" "$out"
  elif grep -qaF -- "$marker" "$scratch/image.tar"; then
    _docker_failed "no planted file reaches the image" "the marker text was found in the image file system"
  else
    _docker_pass "no planted .env, .mmdb, build output, dependency, or untracked file reaches the image (${#_DOCKER_PLANTED[@]} planted)"
  fi
  rm -f "$scratch/image.tar"
}

# _docker_probe <container> <path>: "<status> <body>" from inside the app.
_docker_probe() {
  # shellcheck disable=SC2016 # JavaScript, not shell.
  docker exec "$1" node -e '
    fetch("http://127.0.0.1:8080" + process.argv[1], { signal: AbortSignal.timeout(10000) })
      .then(async (r) => console.log(`${r.status} ${(await r.text()).slice(0, 200)}`))
      .catch((e) => console.log(`000 ${e.message}`));
  ' "$2" 2>&1
}

# _docker_wait_health <container> <status> <seconds>
_docker_wait_health() {
  local container="$1" want="$2" seconds="$3" i status=""
  for ((i = 0; i < seconds; i++)); do
    status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$container" 2>/dev/null || true)"
    [[ "$status" == "$want" ]] && return 0
    sleep 1
  done
  log "        $container health is '$status' after ${seconds}s, expected $want"
  return 1
}

_docker_uids() {
  local container="$1" label="$2" out
  out="$(docker top "$container" -eo uid,ruid,pid,comm 2>&1)" || {
    _docker_failed "$label processes are not root" "$out"
    return 0
  }
  if awk 'NR > 1 && ($1 == "0" || $2 == "0") { bad = 1 } END { exit !bad }' <<<"$out"; then
    _docker_failed "$label processes are not root" "$out"
  else
    _docker_pass "$label processes are not root (UIDs $(awk 'NR > 1 { print $1 }' <<<"$out" | sort -u | paste -sd, -))"
  fi
}

# _docker_expect <description> <container> <path> <status> <substring>
_docker_expect() {
  local out
  out="$(_docker_probe "$2" "$3")"
  if [[ "${out%% *}" == "$4" && "$out" == *"$5"* ]]; then
    _docker_pass "$1"
  else
    _docker_failed "$1" "expected $4 containing $5, got: $out"
  fi
}

# _docker_runtime <scratch> <image> <id>: runs the image the way Compose does,
# without Compose, against PostgreSQL on tmpfs.
# _docker_db_entrypoint <compose-json>: sets _DOCKER_DB_ENTRYPOINT to the db
# service's entrypoint from the effective Compose configuration. compose config
# keeps $$ escaped so that its output stays valid Compose; docker compose up
# and run pass $$ on as $, and so does this.
_docker_db_entrypoint() {
  _DOCKER_DB_ENTRYPOINT=()
  [[ -s "$1" ]] || return 1
  mapfile -d '' -t _DOCKER_DB_ENTRYPOINT < <(python3 -I -c '
import json, sys
db = json.load(open(sys.argv[1], encoding="utf-8"))["services"]["db"]
for word in db.get("entrypoint") or []:
    sys.stdout.write(word.replace("$$", "$") + "\0")
' "$1")
  ((${#_DOCKER_DB_ENTRYPOINT[@]} > 0))
}

# _docker_db_guard [docker run options...]: runs the db image with
# _DOCKER_DB_ENTRYPOINT and the command true instead of postgres, so only the
# password guard and the image entrypoint run. Sets _DOCKER_DB_OUT.
_docker_db_guard() {
  _DOCKER_DB_OUT="$(docker run --rm --network none --user 999:999 --cap-drop ALL \
    --security-opt no-new-privileges:true "$@" --entrypoint "${_DOCKER_DB_ENTRYPOINT[0]}" \
    "$MASHKIF_DB_IMAGE" "${_DOCKER_DB_ENTRYPOINT[@]:1}" true 2>&1)"
}

# _docker_db_refused <name> <rc> <placeholder>: the guard exited non-zero with
# its message and without printing the placeholder.
_docker_db_refused() {
  if (($2 != 0)) && [[ "$_DOCKER_DB_OUT" == *"POSTGRES_PASSWORD is empty or the .env.example placeholder"* &&
    "$_DOCKER_DB_OUT" != *"$3"* ]]; then
    _docker_pass "$1"
  else
    _docker_failed "$1" "exit $2: $_DOCKER_DB_OUT"
  fi
}

# _docker_db_guard_checks <scratch>: the db password guard of both Compose
# files refuses the .env.example placeholder and an empty password without
# printing them, and lets a random password and POSTGRES_PASSWORD_FILE through.
_docker_db_guard_checks() {
  local scratch="$1" kind placeholder random rc
  placeholder="$(sed -n 's/^POSTGRES_PASSWORD=//p' "$MASHKIF_ROOT/.env.example")"
  if [[ -z "$placeholder" ]]; then
    _docker_failed ".env.example has a POSTGRES_PASSWORD placeholder"
    return 0
  fi
  random="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  for kind in production development; do
    if ! _docker_db_entrypoint "$scratch/compose/$kind.json"; then
      _docker_failed "$kind db has a password guard entrypoint"
      continue
    fi
    rc=0
    _docker_db_guard -e POSTGRES_PASSWORD="$placeholder" || rc=$?
    _docker_db_refused "$kind db refuses the .env.example placeholder password" "$rc" "$placeholder"
    rc=0
    _docker_db_guard || rc=$?
    _docker_db_refused "$kind db refuses an empty password" "$rc" "$placeholder"
    rc=0
    _docker_db_guard -e POSTGRES_PASSWORD="$random" || rc=$?
    if ((rc == 0)); then
      _docker_pass "$kind db accepts a random password"
    else
      _docker_failed "$kind db accepts a random password" "exit $rc"
    fi
    rc=0
    _docker_db_guard -e POSTGRES_PASSWORD_FILE=/run/secrets/postgres-password || rc=$?
    if ((rc == 0)); then
      _docker_pass "$kind db accepts POSTGRES_PASSWORD_FILE"
    else
      _docker_failed "$kind db accepts POSTGRES_PASSWORD_FILE" "exit $rc: $_DOCKER_DB_OUT"
    fi
  done
}

_docker_runtime() {
  local scratch="$1" image="$2" id="$3" net db app password url app_key
  app_key="$(head -c 32 /dev/urandom | base64)"
  net="mashkif-verify-docker-$id"
  db="$net-db"
  app="$net-app"
  password="verify-$id"
  url="postgres://mashkif:$password@$db:5432/mashkif"
  _DOCKER_CLEANUP+=("$app" "$db")
  _DOCKER_NETWORK="$net"

  docker network create "$net" >/dev/null || return "$MASHKIF_EXIT_ENV"
  if ! _docker_db_entrypoint "$scratch/compose/production.json"; then
    _docker_failed "PostgreSQL starts through the db entrypoint of docker-compose.yml" "no entrypoint"
    return 0
  fi
  # The db service settings from the Compose files, with its entrypoint and
  # command.
  # shellcheck disable=SC2016 # Expanded inside the container.
  docker run -d --name "$db" --network "$net" --user 999:999 --tmpfs /var/lib/postgresql \
    --shm-size 128m --cap-drop ALL --security-opt no-new-privileges:true \
    -e POSTGRES_USER=mashkif -e POSTGRES_PASSWORD="$password" -e POSTGRES_DB=mashkif \
    --health-cmd 'pg_isready -q -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
    --health-interval 2s --health-retries 30 --entrypoint "${_DOCKER_DB_ENTRYPOINT[0]}" \
    "$MASHKIF_DB_IMAGE" "${_DOCKER_DB_ENTRYPOINT[@]:1}" postgres >/dev/null || return "$MASHKIF_EXIT_ENV"
  if ! _docker_wait_health "$db" healthy 90; then
    docker logs "$db" >&2 || true
    return "$MASHKIF_EXIT_ENV"
  fi
  _docker_pass "PostgreSQL runs as 999:999 through the db entrypoint, with the pg_isready health check"

  mkdir -p "$scratch/geoip"
  chmod 755 "$scratch/geoip"
  head -c 4096 /dev/urandom >"$scratch/geoip/GeoLite2-ASN.mmdb"
  chmod 644 "$scratch/geoip/GeoLite2-ASN.mmdb"

  # The app service settings from the Compose files; the health check runs
  # every 2 seconds instead of 30 so state changes show up quickly.
  docker run -d --name "$app" --network "$net" \
    --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true \
    -e DATABASE_URL="$url" -e MASHKIF_GEOIP_ASN_PATH=/geoip/GeoLite2-ASN.mmdb -e PORT=8080 \
    -e BETTER_AUTH_SECRET="$app_key" -e BETTER_AUTH_URL=http://127.0.0.1:8080 \
    -v "$scratch/geoip:/geoip:ro" \
    --health-interval 2s --health-retries 2 --health-timeout 5s --health-start-period 60s \
    "$image" >/dev/null || return "$MASHKIF_EXIT_ENV"
  if _docker_wait_health "$app" healthy 90; then
    _docker_pass "app becomes healthy through the image HEALTHCHECK"
  else
    _docker_failed "app becomes healthy through the image HEALTHCHECK"
    docker logs "$app" >&2 || true
    return 0
  fi

  if [[ "$(docker inspect -f '{{.Image}}' "$app")" == "$image" ]]; then
    _docker_pass "the running container uses the image just built"
  else
    _docker_failed "the running container uses the image just built"
  fi
  _docker_uids "$app" "app"
  _docker_uids "$db" "db"
  _docker_expect "readiness /readyz is 200" "$app" /readyz 200 '"status":"ready"'
  _docker_expect "liveness /healthz is 200" "$app" /healthz 200 '"status":"ok"'
  _docker_expect "the web app is served at /" "$app" / 200 '<!doctype html>'

  rm -f "$scratch/geoip/GeoLite2-ASN.mmdb"
  _docker_expect "readiness is 503 naming geoip when the GeoIP file is missing" "$app" /readyz 503 '"failing":["geoip"]'
  if _docker_wait_health "$app" unhealthy 30; then
    _docker_pass "app turns unhealthy without the GeoIP file"
  else
    _docker_failed "app turns unhealthy without the GeoIP file"
  fi
  head -c 4096 /dev/urandom >"$scratch/geoip/GeoLite2-ASN.mmdb"
  chmod 644 "$scratch/geoip/GeoLite2-ASN.mmdb"
  if _docker_wait_health "$app" healthy 30; then
    _docker_pass "app recovers when the GeoIP file is back"
  else
    _docker_failed "app recovers when the GeoIP file is back"
  fi

  docker stop "$db" >/dev/null
  _docker_expect "readiness is 503 naming database when PostgreSQL is down" "$app" /readyz 503 '"failing":["database"]'
  if _docker_wait_health "$app" unhealthy 30; then
    _docker_pass "app turns unhealthy when PostgreSQL is down"
  else
    _docker_failed "app turns unhealthy when PostgreSQL is down"
  fi
  if docker logs "$app" 2>&1 | grep -qF -- "$password"; then
    _docker_failed "app logs never contain the database password"
  else
    _docker_pass "app logs never contain the database password"
  fi
  if docker logs "$app" 2>&1 | grep -qF -- "$app_key"; then
    _docker_failed "app logs never contain BETTER_AUTH_SECRET"
  else
    _docker_pass "app logs never contain BETTER_AUTH_SECRET"
  fi
}

_docker_cleanup() {
  local name
  for name in "${_DOCKER_CLEANUP[@]}"; do
    docker rm -f "$name" >/dev/null 2>&1 || true
  done
  [[ -n "$_DOCKER_NETWORK" ]] && docker network rm "$_DOCKER_NETWORK" >/dev/null 2>&1
  [[ -n "$_DOCKER_IMAGE" ]] && docker image rm "$_DOCKER_IMAGE" >/dev/null 2>&1
  [[ -n "$_DOCKER_SCRATCH" ]] && rm -rf -- "$_DOCKER_SCRATCH"
  return 0
}

_docker_script_tests() {
  local test rc
  for test in test-local-environment.sh test-try-pr-session.sh; do
    set +e
    bash "$MASHKIF_ROOT/scripts/tests/$test" >&2
    rc=$?
    set -e
    case "$rc" in
      0) _docker_pass "$test" ;;
      2) return "$MASHKIF_EXIT_ENV" ;;
      *) _docker_failed "$test" ;;
    esac
  done
}

verify_docker() (
  set -euo pipefail
  local id marker rc
  _DOCKER_FAILURES=0
  _DOCKER_CLEANUP=()
  _DOCKER_NETWORK=""
  _DOCKER_IMAGE=""
  _DOCKER_SCRATCH=""

  require_cmd docker || exit
  require_cmd python3 "used to check the Compose configuration" || exit
  if ! docker info >/dev/null 2>&1; then
    fail "the Docker daemon is not reachable"
    exit "$MASHKIF_EXIT_ENV"
  fi
  trap _docker_cleanup EXIT
  _DOCKER_SCRATCH="$(mashkif_mktemp verify-docker)" || exit "$MASHKIF_EXIT_ENV"
  id="$(printf '%s' "${_DOCKER_SCRATCH##*.}" | tr '[:upper:]' '[:lower:]')"
  marker="MASHKIF-CONTEXT-LEAK-$id"

  _docker_compose_checks "$_DOCKER_SCRATCH"
  _docker_db_guard_checks "$_DOCKER_SCRATCH"

  _docker_context "$_DOCKER_SCRATCH" "$marker" || {
    fail "could not prepare the build context copy"
    exit "$MASHKIF_EXIT_ENV"
  }
  _docker_context_filter "$_DOCKER_SCRATCH"
  _DOCKER_IMAGE="mashkif-app:verify-$id"
  log "  ..    building the app image (context: working tree plus planted files)"
  if ! docker build -f "$_DOCKER_SCRATCH/context/config/docker/app.Dockerfile" -t "$_DOCKER_IMAGE" \
    --iidfile "$_DOCKER_SCRATCH/image.iid" "$_DOCKER_SCRATCH/context" >&2; then
    _docker_failed "app image builds"
    exit "$MASHKIF_EXIT_FAILED"
  fi
  _docker_pass "app image builds"
  _docker_image_checks "$_DOCKER_IMAGE" "$marker" "$_DOCKER_SCRATCH"

  set +e
  _docker_runtime "$_DOCKER_SCRATCH" "$(cat "$_DOCKER_SCRATCH/image.iid")" "$id"
  rc=$?
  set -e
  ((rc == 0)) || exit "$rc"

  set +e
  _docker_script_tests
  rc=$?
  set -e
  ((rc == 0)) || exit "$rc"

  ((_DOCKER_FAILURES == 0)) || exit "$MASHKIF_EXIT_FAILED"
)
