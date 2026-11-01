# Mashkif

Mashkif is a community internet outage map for Israel. Its goal is to answer one question: is the problem on my side, or is everyone affected?

## Status

The repository holds the project foundation: toolchains, an empty server and web shell, a Windows agent that only starts and logs, container definitions, workflow scripts, and CI. No product features exist yet: no heartbeats, outage detection, or map data. There is nothing for end users to install.

The design, decisions, and current state are in [docs/project-foundation.md](docs/project-foundation.md).

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
| `scripts/release.sh` | Release the agent or the server. Maintainers only. |

## Contributing

External contributions require a signed Contributor License Agreement, which is collected on the pull request.
