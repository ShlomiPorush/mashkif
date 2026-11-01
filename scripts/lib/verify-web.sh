# shellcheck shell=bash
# Web area: format, lint, typecheck, tests, production build of web/ in the
# Node container, and a check that the admin code stays out of the public
# bundle. Sourced by scripts/verify.sh.

# shellcheck source=node-container.sh
source "$MASHKIF_ROOT/scripts/lib/node-container.sh"

# Strings that only the admin code contains: its API paths, WebAuthn, and TOTP.
_WEB_ADMIN_MARKERS=("/api/admin" "/api/auth" "navigator.credentials" "two-factor")

# _web_bundle_split: the entry chunk that every public page loads must not
# contain admin code, and the admin code must exist as its own chunk. Reads
# the build output only.
_web_bundle_split() {
  local dist="$MASHKIF_ROOT/web/dist" entry marker found=()
  entry="$(grep -o 'src="/assets/[^"]*\.js"' "$dist/index.html" | head -n 1 | sed 's|^src="/||; s|"$||')"
  if [[ -z "$entry" || ! -f "$dist/$entry" ]]; then
    log "  FAIL  web admin code stays out of the public bundle (no entry script in dist/index.html)"
    return "$MASHKIF_EXIT_FAILED"
  fi
  for marker in "${_WEB_ADMIN_MARKERS[@]}"; do
    grep -qF -- "$marker" "$dist/$entry" && found+=("$marker")
  done
  if ((${#found[@]} > 0)); then
    log "  FAIL  web admin code stays out of the public bundle ($entry contains: ${found[*]})"
    return "$MASHKIF_EXIT_FAILED"
  fi
  if ! compgen -G "$dist/assets/AdminApp-*.js" >/dev/null ||
    ! grep -qF -- "/api/admin" "$dist"/assets/AdminApp-*.js; then
    log "  FAIL  web admin code stays out of the public bundle (no separate admin chunk)"
    return "$MASHKIF_EXIT_FAILED"
  fi
  log "  ok    web admin code stays out of the public bundle"
}

verify_web() {
  mashkif_js_setup || return
  mashkif_node_steps web web \
    "format and lint|corepack pnpm run check" \
    "typecheck|corepack pnpm run typecheck" \
    "tests|corepack pnpm run test" \
    "build|rm -rf dist && corepack pnpm run build && test -f dist/index.html" || return
  _web_bundle_split
}
