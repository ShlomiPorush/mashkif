# shellcheck shell=bash
# Contracts area: lints contracts/openapi.yaml and checks that the committed
# TypeScript types match freshly generated ones. Sourced by scripts/verify.sh.

# shellcheck source=node-container.sh
source "$MASHKIF_ROOT/scripts/lib/node-container.sh"

verify_contracts() {
  mashkif_js_setup || return
  mashkif_node_steps contracts contracts \
    "lint|corepack pnpm run lint" \
    "types are up to date|out=\$(mktemp -d)/openapi.d.ts
      corepack pnpm exec openapi-typescript openapi.yaml --output \"\$out\" >/dev/null
      if ! diff -u generated/openapi.d.ts \"\$out\"; then
        echo 'contracts/generated/openapi.d.ts is out of date: run pnpm --filter @mashkif/contracts run generate' >&2
        exit 1
      fi"
}
