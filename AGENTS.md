# AGENTS.md

## Project

Mashkif is a community internet outage map for Israel: a Windows agent reports heartbeats and latency, the server detects outages per provider, infrastructure, and area, and a web app shows the results.

Stage: MVP stage 1. The foundation is complete: toolchains, the server and web shells, an agent skeleton, container definitions, workflow scripts, and CI. Of stage 1, step 1 exists: admin sign-in on Better Auth (`server/src/auth/`, `server/src/admin/`, `web/src/admin/`), with email through SMTP (`server/src/mail/`) and the settings registry (`server/src/settings.ts`). Step 2a exists on the server side: the register, heartbeat, and events operations of the contract (`server/src/agent/`), the client address from trusted proxies (`server/src/http/client-address.ts`), GeoLite2-ASN lookups (`server/src/geoip.ts`), area cells and the service area (`server/src/geo/`), retention (`server/src/retention.ts`), and the admin pages for agents, blocked addresses, providers, and settings (`server/src/admin/manage.ts`, `web/src/admin/pages/`). Open enrollment (decisions of 2026-11-03, replacing D2) exists on the server side: `register` takes no key and classifies a request against the existing agents (`server/src/agent/register.ts`), new agents start at the tier `low` and are promoted by `server/src/promotion.ts`, events have an hourly budget per agent (`server/src/agent/events.ts`), agents that never reported are cleaned up by the retention job, and the registration switch, limits, budgets, and trial length are panel settings. Enrollment keys no longer exist. The request examples of every agent build live in `contracts/examples/`. Step 2b exists in the agent (pull request #13): the service registers by itself at its first start and sends heartbeats (`agent/src/Mashkif.Service/Agent/AgentEngine.cs`), keeps its install ID and tokens in `%ProgramData%\Mashkif\state` behind the ACL checks of `agent/src/Mashkif.Service/State/`, registers a new token for the same install ID after a 401 at most once an hour, and stops after a revoke or a changed server until the user chooses Join again in the tray (pipe commands `status` and `rejoin`). The MSI takes no property but `SERVER_URL`. The agent does not send events, keep an offline queue, or report an area yet (step 2c), and the map, outage detection, and local diagnosis do not exist. `docs/project-foundation.md` records the foundation decisions and evidence; `docs/mvp-stage-1.md` is the approved stage 1 plan with the status of each step. Do not assume that anything either document marks as planned exists. Keep this file aligned with implemented reality.

## Architecture boundaries

- `agent/`: Windows agent, tray app, and MSI installer in .NET 10. License: MIT.
- `contracts/`: OpenAPI definition of the agent-to-server protocol, the single source of truth for both sides. License: MIT.
- `server/`: TypeScript on Node.js 24 LTS with PostgreSQL. License: AGPL-3.0.
- `web/`: React, Vite, and MapLibre GL JS; served by the server on the same origin. License: AGPL-3.0.
- .NET is allowed only in `agent/`. Do not propose or add .NET for the server, the web app, tooling, or scripts.
- Code may not cross the license boundary: `agent/` must not depend on `server/` or `web/` code.
- The server must keep accepting the previous agent protocol version.
- Outage detection and reputation scoring live behind one module interface, `DetectionEngine`, in `server/`. Ingest, storage, admin, and web code depend only on that interface, never on engine internals, so a different implementation can replace it later.

## Product invariants

- The agent never sends exact coordinates. It computes a coarse H3 cell locally and sends only that cell.
- Outage thresholds count distinct sites (public IP addresses), not agents.
- The server stores each site's full public IP address. Only the admin can see it; the public site and public APIs never expose it. The "what the agent sends" page must say so.
- Admin sign-in uses Better Auth's own features as documented: one local admin, password with mandatory TOTP, passkeys, Better Auth's email password reset and TOTP backup codes. Do not build authentication mechanisms of Mashkif's own on top of Better Auth, also not to answer review findings; accept Better Auth's behavior or bring the gap to Shlomi as a decision (Shlomi's decision of 2026-11-02). Better Auth is configured in `server/src/auth/auth.ts`; Mashkif adds only the one-admin sign-up hook, the admin API middleware (`server/src/admin/guard.ts`), and audit entries. Treat any change to sign-in as security-sensitive.
- Trust tiers (trusted, normal, low, suspicious, blocked) are managed in the admin panel. A new agent starts at the tier for new agents (default low); the promotion job moves low agents to normal after their trial. A low agent never opens or closes an outage. Never delete revoked agent rows: they make the server answer `agent_revoked` to their token, and a missing row is answered 401.
- Mashkif's own client addresses (the agent API and its sites, admin audit entries) come from `clientAddressResolver` in `server/src/http/client-address.ts`, which reads `X-Forwarded-For` only when the TCP peer is one of the trusted proxies (a setting, overridden by `MASHKIF_TRUSTED_PROXIES`). Better Auth resolves its own client address (rate limits, session records) from `X-Forwarded-For` with `advanced.ipAddress.trustedProxies` set from the same setting; it does not check the TCP peer, so the app must stay behind its proxy. Never read forwarded headers anywhere else.
- The repository is public. Outage thresholds, reputation weights, and trust lists live in the database and are managed from the admin panel. Never commit their production values; code may hold only safe development defaults.
- Every setting is editable in the admin panel, with a default. An environment variable may also set it; it then overrides the stored value, and the panel shows the field locked with a note that the environment sets it. Only values the server needs before it can read its settings are environment-only: the database connection, file paths, Compose wiring, and the Better Auth secret. Never add an environment-only setting outside this list. Settings live in the one registry in `server/src/settings.ts`, and the guard in `scripts/lib/verify-guards.sh` fails when `.env.example` lists any other variable (Shlomi's rule of 2026-11-02).
- Keep `docs/project-foundation.md`, `docs/mvp-stage-1.md`, `README.md`, and this file true in the same pull request that changes what they describe.

## Repository policies

- Public-ready: all repository text is English. Hebrew is allowed only in `web/src/locales/he.json`, `agent/src/Mashkif.Tray/Resources/Strings.he.resx`, `agent/installer/Package.he-IL.wxl`, and `server/src/mail/strings.he.ts` (the emails). The Hebrew guard in `scripts/lib/verify-guards.sh` enforces this list.
- Use `Mashkif` in repository text. The Hebrew name and taglines belong in locale files.
- Never commit secrets, real `.env` files, signing material, or the MaxMind GeoLite2 database files. The GeoLite2 license forbids redistribution, so the database is never committed or baked into an image.
- Keep the repository root minimal. Every root file must appear in the root table of the foundation plan.
- Workflow scripts are Bash under `scripts/`, run inside WSL. Exception: the agent area calls the Windows `dotnet.exe` through WSL interop locally and runs on a Windows runner in CI.
- Record user-visible and operational changes under `Unreleased` in the component changelog. Do not bump versions in ordinary pull requests.
- Product features stay out of the foundation task.
- External contributions require a signed CLA (CLA Assistant). Never merge an external pull request whose author has not signed it.

## Docker

Docker is part of the approved deployment and development architecture. The image is defined in `config/docker/app.Dockerfile`.

- `docker-compose.yml` (tracked) is the production deployment file and references published images. `docker-compose-dev.yml` (root, ignored, machine-local) references `mashkif-app:dev` and is created from `config/docker-compose-dev.example.yml`. Never commit it.
- Use `docker-compose-dev.yml` only through `scripts/local.sh`. CI and release must not depend on it.
- Neither Compose file may contain `build:`. Scripts build images explicitly. A guard enforces this.
- `.env` (through `env_file`) holds the environment-only values listed under Product invariants and any panel overrides. `.env.example` is tracked with placeholders only. Compose interpolation is limited to the image tag, `MASHKIF_DATA_DIR`, `MASHKIF_GEOIP_DIR`, and the external Traefik network name.
- Services: `app` (server plus built web) and `db` (PostgreSQL). Production runs behind an existing Traefik.
- Mashkif never downloads MaxMind data. `app` reads GeoLite2-ASN from `${MASHKIF_GEOIP_DIR}`, mounted read-only and kept current by a tool outside this repository.
- Every application container runs as a dedicated non-root user. Verification fails if any application process runs as UID 0.
- Every long-running container has a real health check. `app` readiness includes database connectivity.
- No named volumes. Durable data uses bind mounts under `${MASHKIF_DATA_DIR}` (`postgres`). Ordinary stop preserves them; only a confirmed nuke removes a validated project-owned path. Logs go to stdout and stderr.
- After startup, verify health, non-root runtime identity, and that the running image is the one just built.

## Verification

- Single entry point: `scripts/verify.sh`, run from WSL. Areas: `contracts`, `server`, `web`, `agent`, `docker`, `guards`. `--area <name>` runs one area, `--changed <base-ref>` runs the areas a change affects, and `--list-areas [base]` prints them. Area selection lives only in `scripts/lib/select-areas.sh`; CI calls `--list-areas` and must not re-implement it.
- Exit codes: 0 pass, 1 a check failed, 2 usage or environment error. A missing area is an error, never a pass.
- Node.js, pnpm, PostgreSQL, shellcheck, and actionlint run in containers pinned by digest. Do not install them on the host. The agent area uses the Windows .NET SDK pinned in `agent/global.json`.
- `contracts/examples/agent-<version>/` holds the requests of every agent build. Redocly validates them against the schemas, and a server test replays all of them. Never delete the examples of a released build; each agent version needs its own folder, so an agent release adds the folder of the new version (a copy of the previous one when the requests did not change).
- The install tests (`agent/tests/Mashkif.Install.Tests`, outside the solution) install, repair, upgrade, and uninstall the real MSI. They run only on a GitHub-hosted runner; their assembly fixture `InstallSafetyGate` refuses any other machine and any machine with Mashkif on it. Never run them on a developer machine and never work around the gate.
- Server tests that need PostgreSQL read `MASHKIF_TEST_DATABASE_URL`, which the server area sets for a throwaway PostgreSQL container; each test file creates its own database. Without it they fail, never skip.
- Scratch files go under `MASHKIF_TMP_DIR`, `RUNNER_TEMP` in CI, or `/mnt/t/mashkif` locally. Use `mashkif_mktemp` from `scripts/lib/common.sh`.
- Git worktrees use relative paths (`worktree.useRelativePaths=true`) so WSL Git can read them. Never export `GIT_DIR` or `GIT_WORK_TREE`; a test that inherited them once rewrote the shared repository config.
- State plainly which checks ran and which did not.

## Documents

- `docs/project-foundation.md`: foundation plan, decisions, blockers, and handoff.
- `docs/mvp-stage-1.md`: approved MVP stage 1 plan, decisions D1 to D8, and the status of each step.
