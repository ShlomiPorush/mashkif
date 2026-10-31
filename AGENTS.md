# AGENTS.md

## Project

Mashkif is a community internet outage map for Israel: a Windows agent reports heartbeats and latency, the server detects outages per provider, infrastructure, and area, and a web app shows the results.

Stage: preparation. No code exists yet. `docs/project-foundation.md` is the desired-state contract. Do not assume that any file, script, command, or service it lists exists until that document marks it implemented with evidence. Keep this file aligned with implemented reality as the foundation is built.

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
- Admin sign-in follows Shlomi's n8n-ops project: Better Auth, one local admin, password with mandatory TOTP, plus passkeys. Treat any change to it as security-sensitive.
- Trust tiers (trusted, normal, suspicious or blocked) are managed in the admin panel.
- The repository is public. Outage thresholds, reputation weights, and trust lists live in the database and are managed from the admin panel. Never commit their production values; code may hold only safe development defaults.

## Repository policies

- Public-ready: all repository text is English. Hebrew is allowed only in the exact locale files listed in the foundation plan and in the Hebrew text guard.
- Use `Mashkif` in repository text. The Hebrew name and taglines belong in locale files.
- Never commit secrets, real `.env` files, signing material, or the MaxMind GeoLite2 database files. The GeoLite2 license forbids redistribution, so the database is never committed or baked into an image.
- Keep the repository root minimal. Every root file must appear in the root table of the foundation plan.
- Workflow scripts are Bash under `scripts/`, run inside WSL. Exception: the agent area calls the Windows `dotnet.exe` through WSL interop locally and runs on a Windows runner in CI.
- Record user-visible and operational changes under `Unreleased` in the component changelog. Do not bump versions in ordinary pull requests.
- Product features stay out of the foundation task.
- External contributions require a signed CLA (CLA Assistant). Never merge an external pull request whose author has not signed it.

## Docker

Docker is part of the approved deployment and development architecture. None of the files below exist yet.

- `docker-compose.yml` (tracked) is the production deployment file and references published images. `docker-compose-dev.yml` (root, ignored, machine-local) references `mashkif-app:dev` and is created from `config/docker-compose-dev.example.yml`. Never commit it.
- Use `docker-compose-dev.yml` only through `scripts/local.sh`. CI and release must not depend on it.
- Neither Compose file may contain `build:`. Scripts build images explicitly. A guard enforces this.
- Runtime variables live in `.env` through `env_file`. `.env.example` is tracked with placeholders only. Compose interpolation is limited to the image tag, `MASHKIF_DATA_DIR`, `MASHKIF_GEOIP_DIR`, and the external Traefik network name.
- Services: `app` (server plus built web) and `db` (PostgreSQL). Production runs behind an existing Traefik.
- Mashkif never downloads MaxMind data. `app` reads GeoLite2-ASN from `${MASHKIF_GEOIP_DIR}`, mounted read-only and kept current by a tool outside this repository.
- Every application container runs as a dedicated non-root user. Verification fails if any application process runs as UID 0.
- Every long-running container has a real health check. `app` readiness includes database connectivity.
- No named volumes. Durable data uses bind mounts under `${MASHKIF_DATA_DIR}` (`postgres`). Ordinary stop preserves them; only a confirmed nuke removes a validated project-owned path. Logs go to stdout and stderr.
- After startup, verify health, non-root runtime identity, and that the running image is the one just built.

## Verification

Planned single entry point: `scripts/verify.sh`. It does not exist yet. Until it does, state plainly that nothing was verified by scripts.

## Documents

- `docs/project-foundation.md`: foundation plan, decisions, blockers, and handoff.
