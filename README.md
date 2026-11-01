# Mashkif

Mashkif is a community internet outage map for Israel. Its goal is to answer one question: is the problem on my side, or is everyone affected?

## Status

The repository holds the project foundation (toolchains, the server and web shells, a Windows agent that only starts and logs, container definitions, workflow scripts, and CI) and the admin sign-in, the first step of MVP stage 1. There are no heartbeats, outage detection, or map data yet, and nothing for end users to install.

The design, decisions, and current state are in [docs/project-foundation.md](docs/project-foundation.md) and [docs/mvp-stage-1.md](docs/mvp-stage-1.md).

## Repository layout

| Path | Contents | License |
|---|---|---|
| `agent/` | Windows service, tray app, and MSI installer (.NET 10) | [MIT](agent/LICENSE) |
| `contracts/` | OpenAPI definition of the agent-to-server protocol | [MIT](contracts/LICENSE) |
| `server/` | Server (TypeScript, Node.js 24, Hono, PostgreSQL) | [AGPL-3.0](server/LICENSE) |
| `web/` | Web app (React, Vite), served by the server | [AGPL-3.0](web/LICENSE) |
| `config/` | Container image definition and the development Compose template | |
| `scripts/` | Workflow scripts (Bash, run inside WSL) | |
| `docs/` | Project documentation | |

## Development

Requirements: Windows 11 with WSL2, Docker Desktop, and the .NET SDK pinned in `agent/global.json` for the agent. Node.js, pnpm, PostgreSQL, and the linters run in pinned containers, so they are not installed on the host.

Run the scripts from WSL, in the repository root:

| Command | Purpose |
|---|---|
| `scripts/verify.sh` | Run every check. Use `--area <name>` for one area, or `--changed <base-ref>` for the areas affected by a change. |
| `scripts/local.sh` | Build and run the local development environment. Run it without arguments for usage. |
| `scripts/try-pr.sh` | Try a pull request in the local environment, and restore the previous state afterwards. |
| `scripts/release.sh` | Release the agent or the server through a pull request: `prepare` opens the release pull request, and `publish` tags and publishes its merge commit after CI passes. Maintainers only. |

## Operations

The server reads its settings from `.env` (template: `.env.example`). Besides the database settings it needs:

- `MASHKIF_APP_KEY`: a secret of at least 32 random bytes in base64. Generate one with `openssl rand -base64 32` and back it up together with `.env`. A new key signs the admin out and makes the enrolled TOTP unusable; run `reset-admin` afterwards.
- `MASHKIF_PUBLIC_URL`: the origin of the web app, for example `https://mashkif.co.il`. Passkeys are bound to its host name, so use `http://localhost:8180` for local development: browsers refuse passkeys on an IP address such as 127.0.0.1.

The admin panel is at `/admin`. Mashkif has one admin. Run these commands next to the Compose file on the server:

| Command | Purpose |
|---|---|
| `docker compose exec app node server/dist/cli.js setup-token` | Print a setup token for creating the admin at `/admin/setup`. It works once, for 15 minutes, and is refused once an admin exists. |
| `docker compose exec app node server/dist/cli.js reset-admin` | Regain access: the current password, TOTP, passkeys, sessions, and pending sign-ins stop working, and a single-use reset token is printed (valid 15 minutes). Open `/admin/reset`, enter the token, and choose a new password; then sign in and set up TOTP again. No password is ever printed. |

## Contributing

External contributions require a signed Contributor License Agreement, which is collected on the pull request.
