# shellcheck shell=bash
# Migration drift check of the server area. Sourced inside the Node container,
# with server/ as the working directory.

# mashkif_migration_drift <migrations-dir>: fails unless the migrations match
# server/src/db/schema.ts. drizzle-kit regenerates into a scratch copy. It
# exits 0 after some errors (a malformed or unsupported snapshot) without
# writing anything, so a pass needs positive evidence: its "No schema changes"
# message and an unchanged copy.
mashkif_migration_drift() {
  local dir="$1" out generated
  out="$(mktemp -d)"
  cp -R "$dir/." "$out"
  # drizzle-kit reads earlier snapshots from ./<out>, so the path is relative.
  if ! generated="$(MASHKIF_DRIZZLE_OUT="$(realpath --relative-to=. "$out")" \
    corepack pnpm exec drizzle-kit generate 2>&1)"; then
    printf '%s\n' "$generated" >&2
    echo 'drizzle-kit generate failed while checking for schema drift' >&2
    return 1
  fi
  if ! grep -qF 'No schema changes, nothing to migrate' <<<"$generated"; then
    printf '%s\n' "$generated" >&2
    echo 'drizzle-kit did not confirm that the migrations match the schema' >&2
    return 1
  fi
  if ! diff -r "$dir" "$out" >&2; then
    echo 'server/src/db/schema.ts has changes without a migration: run pnpm --filter @mashkif/server run db:generate' >&2
    return 1
  fi
}

# mashkif_migration_drift_self_test: the check passes the real migrations and
# fails a malformed snapshot, an unsupported snapshot version, and real drift
# (a column missing from the snapshot).
mashkif_migration_drift_self_test() {
  local base snapshot name failures=0
  base="$(mktemp -d)"
  for name in unchanged malformed unsupported drift; do
    cp -R drizzle "$base/$name"
  done
  # drizzle-kit compares against the newest snapshot.
  snapshot="meta/$(find drizzle/meta -name '*_snapshot.json' -printf '%f\n' | sort | tail -n 1)"
  printf '{"version": "7", "tables": ' >"$base/malformed/$snapshot"
  sed -i 's/^  "version": "7",$/  "version": "99",/' "$base/unsupported/$snapshot"
  node -e '
    const fs = require("node:fs");
    const file = process.argv[1];
    const snapshot = JSON.parse(fs.readFileSync(file, "utf8"));
    delete snapshot.tables["public.audit_log"].columns.user_agent;
    fs.writeFileSync(file, JSON.stringify(snapshot, null, 2));
  ' "$base/drift/$snapshot"
  if ! grep -q '"version": "99"' "$base/unsupported/$snapshot"; then
    echo 'self-test setup: the snapshot version was not changed' >&2
    return 1
  fi

  if ! mashkif_migration_drift "$base/unchanged" 2>/dev/null; then
    echo 'self-test: unchanged migrations were reported as drift' >&2
    failures=1
  fi
  for name in malformed unsupported drift; do
    if mashkif_migration_drift "$base/$name" 2>/dev/null; then
      echo "self-test: the drift check passed a $name snapshot" >&2
      failures=1
    fi
  done
  rm -rf -- "$base"
  return "$failures"
}
