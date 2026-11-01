# shellcheck shell=bash
# Web area: format, lint, typecheck, tests, and production build of web/ in the
# Node container. Sourced by scripts/verify.sh.

# shellcheck source=node-container.sh
source "$MASHKIF_ROOT/scripts/lib/node-container.sh"

verify_web() {
  mashkif_js_setup || return
  mashkif_node_steps web web \
    "format and lint|corepack pnpm run check" \
    "typecheck|corepack pnpm run typecheck" \
    "tests|corepack pnpm run test" \
    "build|rm -rf dist && corepack pnpm run build && test -f dist/index.html"
}
