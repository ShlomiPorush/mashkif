# Mashkif Project Foundation

Status: Foundation deliverables 1 to 14 are implemented and merged into `main` (pull requests #1, #4, #5, #7; deliverable 14 completed on 2026-11-01). The plan was approved by Shlomi on 2026-11-01. MVP stage 1 work after the foundation is tracked in [mvp-stage-1.md](mvp-stage-1.md).

This document separates the repository's current state from the approved foundation. A planned item does not exist until its status and verification evidence say otherwise. Product features (heartbeats, outage detection, reputation, maps with real data) are out of scope for the foundation task.

## Current truth

Inspected on 2026-11-02:

- The public repository is `ShlomiPorush/mashkif`, default branch `main`. The foundation is merged into `main` (pull request #1).
- Implemented: per-component licenses, the protocol contract with one health endpoint, the server and web shells, the Windows agent skeleton and its unsigned MSI, the container image and Compose files, `scripts/verify.sh`, `scripts/local.sh`, `scripts/try-pr.sh`, `scripts/release.sh`, path-filtered CI, and Dependabot. Evidence is in the implementation plan table below.
- After the foundation: admin sign-in, step 1 of MVP stage 1, is merged (pull request #8). Step 2a, the server and admin side of agent registration, heartbeats, and events, is merged (pull request #9); CI is green on `main` at f412520. Shlomi decided on 2026-11-02 to rework admin sign-in on Better Auth as is and to move every setting into the admin panel; pull request #11, merged on 2026-11-02, implements both. On 2026-11-03 Shlomi replaced enrollment keys with open enrollment (decision D2 replaced); its server side is in review in pull request #14. The plan, these decisions, and the status of each step are in [mvp-stage-1.md](mvp-stage-1.md).
- `scripts/verify.sh` (full sweep, all six areas) passed locally from WSL on 2026-11-01; later changes were verified with `scripts/verify.sh --changed origin/main` and CI on each pull request.
- The GitHub configuration (deliverable 14) is applied: labels, templates, rulesets for `main` and release tags, security settings, and CLA Assistant. No release has been made, and nothing is deployed.
- The domain `mashkif.co.il` is registered. Hosting is an existing Linux server with Docker and Traefik that Shlomi operates; its details are not recorded in the repository.
- A related project, geoip-extractor (outside this repository), downloads MaxMind GeoLite2 data and writes per-country CIDR and ASN lists. Its CIDR output is collapsed without per-range ASN, so it cannot map an IP address to a provider. Its Israeli ASN list is a useful seed for the curated provider table.

## Product intent and boundaries

Mashkif is a community internet outage map for Israel. It answers one question: is the problem on my side, or is everyone affected?

- **Users:** first, IT staff who install the agent on managed Windows endpoints; later, home users. The public website serves anyone.
- **How it works:** a small Windows agent sends a heartbeat and latency measurements every few minutes. The server identifies the internet provider from the public IP address (ASN). When many sites of the same provider or the same access infrastructure in the same area go silent together, the server declares an outage. The agent also runs a local diagnosis (gateway, provider first hop, DNS, external host) to tell its own user whether the fault is at home or at the provider.
- **Privacy invariant:** the agent never sends an exact location. It sends only a coarse regional cell (H3), derived on the machine from the Windows Location API (with consent) or from an area the user picks.
- **Abuse resistance:** open registration without keys (decision of 2026-11-03), with limits on new registrations per site and across all sites, a registration switch, hourly event budgets per agent, and new agents at the tier low until they have reported on enough days; outage thresholds counted by distinct sites (public IP addresses) rather than agents; and admin-managed trust tiers (trusted, normal, low, suspicious, blocked) for agents, and blocks for IP addresses and ranges.
- **Rollout stages:** (1) Shlomi's own computers, unsigned agent; (2) endpoints of the company Shlomi works with, with customer consent, signed agent; (3) public. The MVP ends at stage 2. The public website starts after enough agents report data.
- **Scope:** Israel only. Windows only for the agent.
- **Non-goals for the MVP:** macOS or Linux agents, mobile apps, active probing of IP blocks, BGP monitoring, and the public website.
- **Deployment shape:** one Linux host running Docker Compose behind an existing Traefik reverse proxy, serving `mashkif.co.il`. The agent ships as an MSI suitable for GPO and Intune deployment.

## Preparation decisions

| Decision | Status | Choice | Rationale or blocker |
|---|---|---|---|
| Publication posture | Approved | Public-ready | The repository will be public so people can audit the agent before installing it. |
| Repository structure | Approved | One public repository for agent, contract, server, and web | Mashkif is a non-commercial community project. A split with a private server was considered and rejected: public repositories keep GitHub code scanning, secret scanning, rulesets, and unlimited Actions minutes free. If abuse appears, the mechanism can change and future versions can move private. |
| Detection engine boundary | Approved | Outage detection and reputation scoring sit behind one server module interface (`DetectionEngine`) with no other code depending on their internals | Keeps everything public now while allowing a private implementation to replace the public one later, without a rewrite, if abuse appears. |
| External contributions | Approved | Contributors sign a Contributor License Agreement once, collected by CLA Assistant on the pull request. The CLA grants a license, including the right to relicense; it does not transfer ownership. | Keeps Shlomi able to move future server versions private or combine the server with a private detection engine. Enabled with the GitHub configuration, before any external pull request is merged. The CLA text starts from an established template and Shlomi approves it. |
| Detection parameters | Approved | Outage thresholds, reputation weights, and trust lists live in the database, managed from the admin panel, never in the repository | Public code must not hand attackers the exact values to game. |
| GitHub visibility | Approved | Public from the first push | CI and GitHub security features run free on public repositories. Creating the repository still needs separate authorization, and nothing secret may ever be committed, because the full history is public. |
| Repository language | Approved | English, except Hebrew locale files | Follows from the public-ready posture. |
| Licensing | Approved | `MIT` for the agent and the protocol contract; `AGPL-3.0` for the server and web | MIT lets anyone audit and reuse the agent; AGPL keeps hosted forks of the service open. The contract is MIT because the MIT agent consumes it. |
| License file layout | Approved | One `LICENSE` file per component directory, no root `LICENSE`; the root README states the map | A single root license would misstate the split. |
| Agent technology | Approved | .NET 10, Windows Service plus a tray app, MSI installer | Native access to Location API, power and sleep events, and managed deployment. .NET is confined to `agent/`. |
| Server technology | Approved | TypeScript on Node.js 24 LTS, PostgreSQL | Shlomi excluded .NET from everything server-side. One language with the web app allows shared API types. |
| Web technology | Approved | React, Vite, MapLibre GL JS | Strong map, RTL, and localization ecosystem; no map API key needed. Hosts the admin panel and internal map now, the public site later. |
| Server framework, DB access, migrations | Approved | Hono, Drizzle ORM with forward-only migrations, postgres.js, Biome for format and lint | Matches Shlomi's n8n-ops project, whose Better Auth setup (Drizzle adapter) Mashkif reuses for admin sign-in. |
| JS package manager | Approved | pnpm workspace with a committed lockfile | Standard workspace support and a single lockfile for server, web, and contract types. |
| Protocol contract | Approved | OpenAPI document in `contracts/` is the source of truth | The agent (C#) and server (TypeScript) are in different languages; generated or checked types prevent drift. |
| Runtime shape | Approved | Docker Compose on Shlomi's Linux server behind Traefik | Shlomi's existing hosting. |
| Workflow scripts | Approved | WSL Bash `.sh` files under `scripts/`, with an agent exception | Agent build and tests need Windows. Locally, scripts call the Windows `dotnet.exe` through WSL interop for the agent area; CI runs the agent area on a Windows runner. |
| Root layout | Approved | Minimal root with every file justified | See the planned root table. |
| Agent distribution | Approved | MSI only in the MVP, for manual install and GPO or Intune deployment; no winget package or EXE installer yet | IT staff are the first audience. |
| User interface language | Approved | Hebrew (RTL) by default, English (LTR) as the second language, in the web app and the agent | Israeli audience; English for non-Hebrew readers. |
| Release artifacts | Approved | Agent: MSI published as a GitHub Release asset and downloaded from the website. Server and web: one container image in GitHub Container Registry (GHCR). | GHCR sits next to the repository and its CI and needs no extra account. |
| Versioning | Approved | Independent SemVer for agent and server, tags `agent-vX.Y.Z` and `server-vX.Y.Z`, one changelog per component | Agent releases need signing and are rare; server releases are frequent. |
| Code signing | Deferred | Decided before stage 2 | Stage 1 runs unsigned on Shlomi's computers. Agent release to customers is blocked until then. |
| Admin authentication | Approved | Reuse the n8n-ops model: Better Auth, one local admin, username and password with mandatory TOTP, rate-limited sign-in, audited logins, session time limits, first-run setup wizard. Add passkey sign-in through Better Auth's passkey support; password plus TOTP stays as the fallback. | Proven in Shlomi's n8n-ops; passkeys resist phishing. Security review required when the feature is built. Not part of the foundation task. Built in MVP stage 1, step 1, with a setup token from the server instead of an open first-run wizard. |
| Public IP storage | Approved | Store the full public IP address of each site, visible only to the admin, never exposed by the public site or any public API, and disclosed on the "what the agent sends" page | Site counting and trust tiers for IP addresses and ranges need the real address; a hash cannot match ranges. A retention period is set before the public stage. |
| ASN data source | Approved | Mashkif does not download MaxMind data. The operator mounts an existing GeoLite2-ASN directory read-only (for example the one geoip-extractor maintains). The app reports the database build date and warns in the admin panel when it is stale. | Reuses Shlomi's existing MaxMind download and license key. The GeoLite2 license forbids redistribution, so the file is never committed or baked into an image. |

## Publication and language policy

- All repository text is English: documentation, `AGENTS.md`, code, comments, tests, fixtures, commit messages, issues, pull requests, and reviews.
- Hebrew is allowed only in exact locale files: `web/src/locales/he.json`, `agent/src/Mashkif.Tray/Resources/Strings.he.resx`, `agent/installer/Package.he-IL.wxl`, and, since admin sign-in sends email (approved plan of 2026-11-02), `server/src/mail/strings.he.ts`. The guard in `scripts/lib/verify-guards.sh` lists them.
- A CI guard scans tracked text for Hebrew characters and excludes only those exact paths. Tests load Hebrew samples from the locale files.
- The product name in repository text is `Mashkif`. The Hebrew name and taglines live only in locale files.
- Secrets never enter the repository: no MaxMind license key, signing material, database passwords, or registration keys. Only `.env.example` with placeholders is tracked.

## Architecture

| Component | Responsibility | Expected path | License | Status | Dependencies or blockers |
|---|---|---|---|---|---|
| Protocol contract | OpenAPI definition of the agent-to-server API; source for TypeScript types and C# client code | `contracts/` | MIT | Version 1: health, register, heartbeat, and events | None |
| Windows agent | Background service: heartbeat, latency, local diagnosis, outage journal with retroactive reports, sleep and shutdown notices, H3 cell computed locally | `agent/` | MIT | Skeleton: starts and logs only | Contract |
| Agent tray app | User-facing status ("home or provider"), consent for location, area selection; Hebrew and English | `agent/` | MIT | Skeleton: starts and logs only | Agent service |
| Agent installer | MSI with silent install properties for GPO and Intune | `agent/` | MIT | Skeleton: unsigned MSI | Signing decision before stage 2 |
| Server | Ingest API for agents, ASN lookup, site grouping, outage detection, reputation, admin API | `server/` | AGPL-3.0 | Health, readiness, admin sign-in and its API, operator commands (`cli.js`), agent registration, heartbeats, events, ASN lookup, sites, retention, open registration with a trust tier low and its promotion, an event budget, cleanup of agents that never reported, and the admin API for agents, blocked addresses, providers, and settings | Contract, PostgreSQL, ASN data |
| Web | Admin panel with reputation controls and internal map now; public site later | `web/` | AGPL-3.0 | Empty public shell; admin sign-in pages and the pages for agents, blocked addresses, providers, and settings under `/admin` | Server API |
| Database | Agents, sites, heartbeats, outages, trust tiers, detection parameters, curated provider and infrastructure table | Container | Third-party | Admin, session, credential, setup token, and audit tables; agents, heartbeats, events, blocked ranges, providers, and settings (enrollment keys were removed on 2026-11-03) | None |
| ASN data | GeoLite2-ASN file maintained outside Mashkif and mounted read-only | Host directory | MaxMind GeoLite2 license | Mount defined; file readability checked; read with `maxmind` and loaded again when it changes; build date shown in the admin settings | Operator provides the directory |

Load-bearing boundaries:

- The agent talks to the server only through the versioned contract. The server must accept the previous agent protocol version, because agents update slowly on managed endpoints.
- The server and web ship as one container image. The server serves the built web assets on the same origin, so the admin panel needs no cross-origin configuration. Traefik routes `mashkif.co.il` to that container.
- Coordinates never leave the endpoint. The server stores only H3 cells.

## Containers

| Service | Image | Runtime user | Health check | Persistent state | Host bind directory | Named-volume exception | Backup lifecycle |
|---|---|---|---|---|---|---|---|
| `app` | Project image (server plus built web), Node.js 24 | Dedicated unprivileged user declared in the image | HTTP readiness endpoint that also checks database connectivity and that the GeoLite2-ASN file is readable | None | `${MASHKIF_GEOIP_DIR}`, read-only, owned by the external updater | None | Not applicable; the external updater owns it |
| `db` | Official PostgreSQL image | Non-root UID set in Compose that owns the data directory; verified at startup | `pg_isready` against the application database | Database files | `${MASHKIF_DATA_DIR}/postgres` | None | Scheduled logical dump to a host backup directory; documented restore; kept on ordinary stop; removed only by confirmed nuke |

Compose interpolation is limited to values Compose itself resolves: the image tag, `MASHKIF_DATA_DIR`, `MASHKIF_GEOIP_DIR`, and the external Traefik network name. `.env` (through `env_file`) holds only what the server needs before it can read its settings: the database connection, file paths, and the Better Auth secret. Every other setting is managed in the admin panel; an environment variable may override a panel setting and then locks its field (Shlomi's rule of 2026-11-02, see `AGENTS.md`).

## Repository root

| Root file | Git tracking policy | Why this exact root location is required | Status |
|---|---|---|---|
| `README.md` | Tracked | GitHub and contributor discovery | Exists |
| `AGENTS.md` | Tracked | Agent instruction discovery | Exists |
| `CLAUDE.md` | Tracked | Claude Code discovery; contains only an import of `AGENTS.md` | Exists |
| `.gitignore` | Tracked | Git reads root ignore rules | Exists |
| `.gitattributes` | Tracked | Enforces LF for `.sh` and text files from the root | Exists |
| `.editorconfig` | Tracked | Editors resolve it from the root | Exists |
| `package.json` | Tracked | pnpm workspace root | Exists |
| `pnpm-workspace.yaml` | Tracked | pnpm requires it at the workspace root | Exists |
| `pnpm-lock.yaml` | Tracked | pnpm writes the single workspace lockfile at the root | Exists |
| `docker-compose.yml` | Tracked | Production deployment contract | Exists |
| `docker-compose-dev.yml` | Ignored, machine-local | Docker contract requires this exact root path; created per machine from `config/docker-compose-dev.example.yml` | Machine-local; template exists |
| `.env.example` | Tracked | Environment contract next to the Compose file, placeholders only | Exists |
| `.env` | Ignored, machine-local | Real values read by Compose `env_file` | Machine-local; template exists |

Everything else lives in purpose-specific directories: `agent/` (including its `global.json`, solution, central package management, and NuGet lock files), `server/`, `web/`, `contracts/`, `scripts/`, `config/`, `docs/`, and `.github/` (workflows, Dependabot, `SECURITY.md`, `CONTRIBUTING.md`). Changelogs live at `agent/CHANGELOG.md` and `server/CHANGELOG.md`.

## Foundation implementation plan

| Order | Deliverable | Status | Acceptance criteria | Required verification |
|---|---|---|---|---|
| 1 | Repository baseline | Implemented: `git check-ignore` confirmed every rule and `.env.example` is tracked (2026-11-01) | Root files from the table exist; per-component `LICENSE` files; `.gitignore` covers `.env`, `docker-compose-dev.yml`, build output, and GeoLite2 files while keeping `.env.example` tracked | `git check-ignore` confirms each ignore rule; `.env.example` is not ignored |
| 2 | Protocol contract | Implemented: `GET /api/agent/health` with the `Mashkif-Protocol-Version` header; Redocly lint and a type drift check pass in the `contracts` area | OpenAPI document with only a health endpoint and the protocol version header; lint passes; TypeScript types generated or checked | Contract lint in `verify.sh` |
| 3 | Server and web toolchain | Implemented: `contracts`, `server`, and `web` areas pass, including readiness tests against a real PostgreSQL container (database down and GeoIP file missing return 503) | pnpm workspace; TypeScript strict; format, lint, unit test, and build for `server/` and `web/`; server exposes only health and readiness; web shows an empty shell | `verify.sh` area runs pass |
| 4 | Web localization and themes | Implemented: eight screenshots (he and en, light and dark, 390 and 1440 px) inspected on 2026-11-01; a test fails on hard-coded user-facing strings | Hebrew (default, RTL) and English (LTR) locale files; language switch; complete light and dark themes; responsive layout; no hard-coded user-facing strings | Screenshots of both languages and both themes at mobile and desktop widths |
| 5 | Agent toolchain | Implemented: `agent` area passes from WSL and Git Bash; the MSI installed, ran, and uninstalled cleanly in Windows Sandbox (34 of 34 checks, including install and uninstall as SYSTEM) | .NET 10 solution with a service and a tray project that start and log only; tests; central package versions with lock files; MSI builds unsigned | Agent area of `verify.sh` on Windows; MSI installs and uninstalls cleanly on a test machine |
| 6 | Production Docker definition | Implemented: `docker` area passes (no `build:`, every process non-root, the build context excludes `.env`, GeoLite2 files, dependencies, and build output). Untracked files inside allowed source directories such as `web/src/` and `web/public/` do reach images built by `local.sh`; published images are built from a clean checkout (`release.sh` uses a fresh worktree of the tag, CI a fresh checkout); verified with placeholder values only, not on the server | Image for `app` with non-root user and health check; `docker-compose.yml` with `app`, `db`, the read-only GeoLite2 mount, Traefik labels, `env_file`, bind mounts, no `build:` | Guard rejects `build:`; effective UID is not 0 for every application process |
| 7 | Development Docker definition | Implemented: `local.sh` refuses clearly when the file is missing (tested) | `config/docker-compose-dev.example.yml` documents how to create the machine-local file; dev images use `mashkif-app:dev` | `local.sh` fails clearly when the file is missing |
| 8 | Local workflow | Implemented: live run on 2026-11-01 showed health, UIDs 10001 and 999, running image equal to the built one, data surviving down and up, then a confirmed nuke | `scripts/local.sh` build, up, detached up, down, status, confirmed nuke | Health, runtime identity, and running image identity verified after startup; data survives down and up |
| 9 | Verify workflow | Implemented: full sweep passed locally on 2026-11-01; CI calls the same script | `scripts/verify.sh` full sweep and changed-area mode; guards for Hebrew text, Compose `build:`, and shell lint | Same commands run locally and in CI |
| 10 | Try PR workflow | Implemented: tested with a fake Docker and a local repository standing in for GitHub; a live run against pull request #1 on 2026-11-01 built the image and the MSI, replaced only `app` (the `db` container kept its ID), blocked `local.sh` during the session, and restored the previous image | `scripts/try-pr.sh` with start, status, and restore | Disposable worktree; running `app` uses the freshly built image; database container not replaced |
| 11 | Release workflow | Implemented, with releases through a pull request: the scenario tests for `prepare` (preview, recovery after partial failures, concurrency) and `publish` (source and revert rules, CI evidence, concurrency, interruption, lost responses, resume) pass against a local bare repository with shims for Docker and gh; the gh projections were checked against the real pulls, runs, and jobs APIs with read-only calls; no real release; GitHub acceptance of `refs/release-leases/*` and real `gh pr create` are unverified | `scripts/release.sh` with preview mode, explicit target (`agent` or `server`), version and changelog update, immutable tag | Preview run produces no changes |
| 12 | Path-filtered CI | Implemented: actionlint passes; every check, including `agent` on Windows and `summary`, passed on pull request #1 | Change detection, server and web on Linux, agent on Windows, guards, final summary job; least-privilege permissions; pinned actions; manual and weekly full runs | Green run on a pull request that touches each area |
| 13 | Dependency management | Implemented: validated against the published schema; GitHub validates it only after merge to `main` | Dependabot weekly for npm, NuGet, Docker, and GitHub Actions; grouped minor and patch updates; no auto-merge | Configuration validated by GitHub |
| 14 | GitHub configuration | Implemented, applied on 2026-11-01 with a saved backup and rollback command for each setting: 14 area, priority, and topic labels; issue forms, pull request template, `SECURITY.md`, and `CONTRIBUTING.md` (pull request #4); tag ruleset `release-tags` (updates and deletions of `agent-v*` and `server-v*` blocked); branch ruleset `main` (no deletion, no force push, pull request with resolved conversations, `summary` from GitHub Actions required and up to date, no bypass), checked with a throwaway pull request that stayed blocked until `summary` passed; Actions approval required for every external fork pull request; CodeQL default setup, first analyses for `actions`, `csharp`, and `javascript-typescript` succeeded with no alerts; CLA Assistant linked to the approved CLA version 1.0 gist, with `dependabot[bot]` allowlisted; its commit status `license/cla` appeared on pull request #7 and is a required check of the `main` ruleset. Not verified, for lack of a second GitHub account: an unsigned external pull request, a multi-author pull request, and an Actions run from a real fork | Repository, labels, templates, branch rules, security settings, CLA Assistant with the approved CLA text | Read-back of every setting; a pull request blocked until its required checks pass; first CodeQL analyses complete; CLA check present on a real pull request |

## Required workflow contracts

All scripts are Bash run inside WSL, start with `#!/usr/bin/env bash`, use LF line endings and executable modes, and resolve the repository root from their own location. Shell lint and syntax checks run in `verify.sh`.

- **`scripts/local.sh`:** builds `mashkif-app:dev` explicitly before changing the running environment and stops on the first failure. Runs `docker-compose-dev.yml` only, removes orphans, and keeps `${MASHKIF_DATA_DIR}` contents across `down` and `up`. Nuke asks for confirmation and removes only a validated project-owned data path. The agent is not part of the local Compose environment.
- **`scripts/verify.sh`:** areas are `contracts`, `server`, `web`, `agent`, `docker`, and `guards`. The agent area calls the Windows .NET SDK through WSL interop (approved exception). Integration checks use the real PostgreSQL image and clean up afterwards.
- **`scripts/try-pr.sh`:** takes a pull request number. For server or web changes it rebuilds and restarts only `app`. For agent changes it builds the MSI inside the worktree and prints its path; installation stays manual. Migrations are forward-only; restore refuses to start older code against a newer schema and explains how to proceed.
- **`scripts/release.sh`:** separate targets. `agent` produces a signed MSI once signing exists and a GitHub Release asset; until then every `agent` command refuses before any change. `server` builds and pushes the container image. Never deploys, never pushes `main`, never merges. Never uses `git add .`, force-pushes a tag, or overwrites a published version. Every GitHub call goes through `gh`; the repository (`owner/name`) comes from the `origin` URL. A release has two commands:
  - `release.sh <target> prepare --version X.Y.Z [--preview]` checks a fresh fetch of `origin/main` (version greater, `## [Unreleased]` has notes, tag absent on origin), then commits only the version file and the changelog on `origin/main` in a scratch worktree (the user's checkout, branch, and index are not used), pushes the new branch `release/<target>-vX.Y.Z` (creation only), and opens the pull request `Release <target> X.Y.Z` with `gh pr create`. An exclusive per-user `flock` (`${XDG_STATE_HOME:-~/.local/state}/mashkif/release-prepare.lock`) makes a second `prepare` fail fast. A rerun after a partial failure reuses a remote release branch only when its single commit is exactly the expected change of its parent (with the changelog date recorded in that commit) and the parent is still on `origin/main`; it never pushes again, and it reuses an open pull request of this repository for that commit or opens one. A branch with other content refuses.
  - The release pull request is merged like any other change after CI passes. If `main` moved first, the branch is brought up to date through the normal pull request flow.
  - `release.sh <target> publish --version X.Y.Z [--preview]` releases the merge commit of the single merged pull request from `release/<target>-vX.Y.Z` into `main` whose head and base repositories are both this repository (read from the pulls API, so a fork never matches and a deleted head branch still resolves). That commit must be on `origin/main`, carry the version and a `## [X.Y.Z]` changelog section, and have CI evidence: every push run of `.github/workflows/ci.yml` on `main` for that commit (paginated) is completed and successful at its latest attempt with a successful `summary` job, and at least one exists. `origin/main` must still have the changelog section and a version not lower than X.Y.Z, so a reverted release refuses; later merges never change the source. The publish lease `refs/release-leases/active` is then taken, everything is read again, the tag alone is pushed at the source commit (only porcelain `*` counts), and the artifacts are built from a fresh detached worktree of the tag and verified by digest.
  - `release.sh <target> publish --resume X.Y.Z [--preview]` publishes the missing artifacts of an existing tag, under the same lease, only when the tag points at that merge commit and it passes the same checks before and after the lease. It never trusts an existing image.
  - Preview may fetch from `origin` but creates no branch, commit, tag, lease, pull request, or image.

## Known unknowns and blockers

| Question or blocker | Why it matters | Evidence or decision needed | Owner |
|---|---|---|---|
| Traefik network name, entry point, and certificate resolver | Compose labels must match the existing Traefik; `docker-compose.yml` sets only `tls: "true"` for now | Values from the server | Shlomi |
| Host data directory and GeoLite2 directory | Bind mounts and backup location | Paths on the server, and confirmation that the GeoLite2-ASN file there is kept current | Shlomi |
| Docker Engine and Compose versions on the server | The image health check uses `--start-interval` (Engine 25 or later); the Compose files use `start_interval` and `create_host_path` (recent Compose v2) | Versions on the server | Shlomi, before the first deployment |
| Code-signing provider | Blocks agent release for stage 2 | Choose a provider available to an individual in Israel | Shlomi, before stage 2 |
| Public IP retention period | The privacy page must state how long full addresses are kept | Choose a period | Shlomi, before the public stage |
| GitHub acceptance of `refs/release-leases/*` | `scripts/release.sh` uses these refs as a remote publish lock | Observe the first real server release | Shlomi, at the first release |
| GitHub behavior of the release pull request flow | `prepare` runs `gh pr create` and `publish` reads the pulls, workflow runs, and jobs APIs; tests use a gh shim, and only the read projections were checked against the real API | Observe the first real `prepare` and `publish`, including the tag push under the `main` and tag rulesets | Shlomi, at the first release |
| Dependabot and NuGet lock files | The agent restores in locked mode; an update that does not regenerate `packages.lock.json` fails CI | Observe the first NuGet update from Dependabot | Maintainer |
| Backup lifecycle for `db` | The container table requires a scheduled logical dump and a documented restore | Not part of deliverables 1 to 13; build it before the first deployment | Maintainer |

## Implementation decisions

Decisions made while building the foundation and later steps, within the approved plans:

| Decision | Choice | Reason |
|---|---|---|
| WiX version | WiX 5.0.2 as an MSBuild SDK, pinned in `agent/global.json`; Dependabot ignores WiX 6 and later | WiX 6 and 7 require accepting the Open Source Maintenance Fee EULA |
| Agent packaging | Service and tray published self-contained for `win-x64`; English MSI at the contract path plus a Hebrew MSI | No .NET runtime needed on endpoints; Hebrew installer text for Hebrew users |
| Tray start | The tray starts at every user sign-in through the machine `Run` key; uninstall closes it in every session | Needed for the user-facing status later; uninstall as SYSTEM must not leave it running |
| Protocol versioning | One unversioned path with the `Mashkif-Protocol-Version` request and response header | One route can serve the current and the previous protocol version |
| Node and pnpm | Run only in the pinned official Node image; pnpm from corepack and `packageManager` | No host installs |
| Development port | The development app listens on `127.0.0.1:8180` | Port 8080 is taken on the development machine |
| Release lock | `publish` and `--resume`: one remote ref, `refs/release-leases/active`, held for the whole publish of any target and version; any lease blocks every publish; no automatic takeover. `prepare`: a local per-user `flock` (`${XDG_STATE_HOME:-~/.local/state}/mashkif/release-prepare.lock`), held until the branch is pushed and the pull request exists | The lease prevents two machines from publishing the same version, and a crashed run is cleared manually. `prepare` changes no published state, and its rerun recovers from partial failures, so a local lock is enough |
| Release through a pull request | `scripts/release.sh prepare` opens a pull request with the version and changelog change; after it is merged with green CI, `publish` tags its merge commit and publishes. The script never pushes `main` | `main` requires pull requests and a green `summary` check with no bypass, so a direct push of the release commit would be rejected |
| Dependabot cooldown | New versions are proposed after seven days | Supply-chain hardening |
| Better Auth version (MVP stage 1, step 1) | `better-auth` and `@better-auth/passkey` pinned to 1.7.12 in `server/` and `web/`; n8n-ops uses 1.7.10 | 1.7.12 is the newest release older than the seven-day cooldown on 2026-11-01. 1.7.11 and 1.7.12 add fixes; 1.7.13 to 1.7.15 change nothing Mashkif uses |
| Admin sign-in (step 1, reworked on 2026-11-02) | Better Auth as is: its own options for sign-up of the first admin (refused once a user exists), TOTP with backup codes, passkeys, password reset and email change by email, sessions, cookies, and rate limits. Mashkif adds only a sign-up hook, one middleware that admits its admin API to sessions with TOTP, the Origin check of admin API mutations, and audit entries | Shlomi's decision of 2026-11-02: no authentication mechanisms of Mashkif's own; where Better Auth is weaker than an earlier promise, the promise changes. `docs/mvp-stage-1.md` lists the accepted behaviors |
| Settings (2026-11-02) | One registry in `server/src/settings.ts`: each setting has a default, validation, and optionally an environment variable that overrides the stored value and locks the field in the panel. Environment-only: the database connection, port, file paths, Compose wiring, and `BETTER_AUTH_SECRET`, which replaces `MASHKIF_APP_KEY` and is passed to Better Auth as is. A guard checks `.env.example` against this list | Shlomi's rule: every setting is editable in the admin panel |
| Error logging (step 1) | Database errors are logged by name and PostgreSQL SQLSTATE only; Better Auth hands errors other than API errors to the server's handler (`onAPIError.throw`) instead of printing them | Their messages carry SQL parameters such as password hashes and session tokens |
| Client address (step 2a, Better Auth since 2026-11-02) | Mashkif's own code uses `clientAddressResolver`: `X-Forwarded-For` counts only from a TCP peer among the trusted proxies, and then the right-most address that is not a trusted proxy is the client. Better Auth reads `X-Forwarded-For` itself with `trustedProxies` from the same setting | Better Auth does not check the TCP peer, so the app stays reachable only through its proxy |
| Email (2026-11-02) | SMTP through `nodemailer` 10.3.1, pinned; TLS required (465, or STARTTLS on any other port); settings read for each email; the password stored encrypted with Better Auth's `symmetricEncrypt` and the Better Auth secret | Better Auth's password reset and email change need email; notifications will use it later |
| MMDB reader (step 2a) | `maxmind` 5.0.7, pinned; the file is read into memory, checked every minute, and loaded again when it changes; a broken file keeps the last good database | Maintained, MIT, no install scripts, and the base of MaxMind's own Node client. Mashkif never downloads the database; the operator's updater replaces the file |
| IP normalization (step 2a) | `ipaddr.js` 2.5.0, pinned, behind one module (`server/src/http/ip.ts`) for client addresses, sites, trusted proxies, and blocked ranges; Node's `isIP` validates first | Every IPv4-mapped IPv6 spelling becomes IPv4 everywhere, so a block or a site never depends on how an address was written. MIT, no dependencies, the library behind Express's `proxy-addr` |
| H3 library (step 2a) | `h3-js` 4.5.0, pinned | The reference H3 implementation (Apache-2.0); the server validates area cells at resolution 7 |
| Service area (step 2a) | A hand-drawn outline of 21 vertices in `server/src/geo/service-area.ts`, generous at sea and at the borders; a reported cell whose center is outside is stored as unknown | No third-party map data, so no license beyond the server's AGPL-3.0. Its only purpose is to catch impossible cells; it is not a border |

## Handoff to foundation implementation

The first implementation task builds deliverables 1 through 13 on a topic branch. Permitted scope: repository baseline, contract skeleton, toolchains, empty server and web shells with health endpoints and localization and theme infrastructure, an agent that starts and logs only, container definitions, the four workflow scripts, CI, and Dependabot configuration.

Out of scope: heartbeats, diagnosis, outage detection, reputation, admin features, real map data, signing, deployment to the server, and any release.

Stopping point: `scripts/verify.sh` passes a full sweep locally, `scripts/local.sh` brings up a healthy non-root development environment, the unsigned MSI installs and uninstalls on a test machine, and CI is green on the pull request. Then update this document's statuses with evidence and stop for review.

Outcome on 2026-11-01: every stopping criterion is met (see the implementation plan table), and CI is green on pull request #1. `.github/SECURITY.md` and `.github/CONTRIBUTING.md` were added later with deliverable 14 (pull request #4).
