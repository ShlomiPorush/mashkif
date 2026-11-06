# Mashkif

Mashkif is a community internet outage map for Israel. Its goal is to answer one question: is the problem on my side, or is everyone affected?

## Status

The repository holds the project foundation (toolchains, the server and web shells, a Windows agent, container definitions, workflow scripts, and CI) and the admin sign-in, the first step of MVP stage 1. The server accepts agent registrations without a key (open enrollment), heartbeats, and events, and the admin panel manages agents (step 2a). The Windows agent registers by itself and sends heartbeats (step 2b, in review). It does not send events yet, and there is no outage detection, no map, and no release to install.

The design, decisions, and current state are in [docs/project-foundation.md](docs/project-foundation.md) and [docs/mvp-stage-1.md](docs/mvp-stage-1.md).

## Repository layout

| Path | Contents | License |
|---|---|---|
| `agent/` | Windows service, tray app, MSI installer, and EXE installer (.NET 10, WiX 7) | [MIT](agent/LICENSE) |
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

The server reads only a few values from `.env` (template: `.env.example`): the database settings, the GeoLite2-ASN path, and:

- `POSTGRES_PASSWORD`, repeated in `DATABASE_URL`: the database password. Generate one with `openssl rand -hex 32`. The server and the `db` container both refuse to start with an empty password or the `.env.example` placeholder, so PostgreSQL never initializes with it. `POSTGRES_PASSWORD_FILE` of the official image also works.
- `BETTER_AUTH_SECRET`: a secret of at least 32 random characters. Generate one with `openssl rand -base64 32` and back it up together with `.env`. A new secret signs the admin out and makes the enrolled TOTP, the backup codes, and the stored SMTP password unusable.

Every other setting is managed in the admin panel under Settings, with a default: the heartbeat interval, how long raw data is kept, the public URL, other trusted origins, the trusted proxies, the session length, and SMTP for email. An environment variable may override a setting (for example `BETTER_AUTH_URL` for the public URL or `MASHKIF_TRUSTED_PROXIES`; `.env.example` lists them); the panel then shows the field locked. The public URL, the trusted proxies, and the session length apply after a restart.

- Public URL: the origin of the web app, for example `https://mashkif.co.il`. Recommended behind a proxy; while it is empty, Better Auth takes the origin from each request. Use `http://localhost:8180` for local development: browsers refuse passkeys on an IP address such as 127.0.0.1.
- Trusted proxies: addresses or CIDR ranges of the reverse proxies whose `X-Forwarded-For` is believed. Mashkif's own resolver (agent API and audit) and Better Auth's client address handling (sign-in rate limits) are both configured from this list, but they are separate. Behind Traefik, put the app and Traefik on a Docker network that nothing else uses and list that network's subnet; otherwise Mashkif counts every agent as Traefik's address, and Better Auth applies its own documented behavior. Keep the app reachable only through its proxy.
- SMTP: host, port (465, or a port that offers STARTTLS), user, password (stored encrypted, never shown), and sender. Without it the server works, but password reset and email change send nothing: the page still says the link is on its way, and only the server log says why.

The admin panel is at `/admin`. Mashkif has one admin. The first visit creates the admin account (username, email address, password), then sets up two-step verification with an authenticator app and shows ten backup codes once. Keep them: each one replaces the app's code for one sign-in. A lost password is reset from the sign-in page with a link sent by email. There is no other recovery: losing the authenticator and every backup code locks the admin out. In the panel the admin sees the agents and their sites, sets trust tiers, blocks addresses, groups ASNs into providers, and manages the settings. Registration is open: an installed agent registers by itself, without a key. A new agent starts at the tier Low and becomes Normal after it reported on the configured number of days (default 7) and still reports; a Low agent counts in no outage. Under Settings, Registration, the admin can close registration for new agents, choose the tier of new agents, and set the trial length, the limits on new registrations (per address or IPv6 /64, and across all addresses), the hourly event budgets, and after how many days agents that never reported are removed. When the limit across all addresses is used up, new installations wait and retry by themselves, while registered agents are not affected; raise the limit or close registration during an attack. Thresholds and similar values live only in the database; the repository holds development defaults.

## Installing the agent

The agent comes as an EXE for manual installs and as an MSI for GPO and Intune. Both are unsigned, and there is no release yet; `scripts/verify.sh --area agent` builds `agent/artifacts/exe/Mashkif-<version>-x64.exe`, `agent/artifacts/msi/Mashkif-<version>-x64.msi`, and the Hebrew `Mashkif-<version>-x64-he-IL.msi`. CI keeps them as a downloadable artifact for 7 days.

- Install with the EXE: double-click it, or right-click it and choose "Run as administrator". Nothing else is needed: at its first start the service creates its own install ID and token and registers the PC. The tray shows the status; it does not start right after the install, but at the next sign-in (the machine `Run` key). The EXE window is in English; the tray follows the Windows language. It installs the English MSI and shows one entry in Apps and Features.
- Elevation, checked on a real desktop with UAC on (2026-11-04): a double-click opens the setup window without a prompt and shows one UAC prompt after Install, when Burn starts its elevated engine. "Run as administrator" shows the UAC prompt at launch and no second one. The CI tests also run the EXE from an elevated process. Not checked: the behavior with UAC turned off, and the SmartScreen warning for a downloaded file. A silent install (`/quiet`) still needs an elevated context, so GPO and Intune use the MSI.
- The EXE from the command line (always add `/norestart` to `/quiet`, or a quiet run restarts the PC by itself when a restart is needed):
  - Silent install: `Mashkif-<version>-x64.exe /quiet /norestart /log <file>`
  - Repair: `Mashkif-<version>-x64.exe /repair /quiet /norestart /log <file>`
  - Uninstall: `Mashkif-<version>-x64.exe /uninstall /quiet /norestart /log <file>`, or the `QuietUninstallString` of its Apps and Features entry with ` /norestart` added (Windows registers it without `/norestart`).
  - The log path must be writable by the user who runs the EXE; the MSI log is written next to it.
- Install with the MSI: run it, or `msiexec /i Mashkif-<version>-x64.msi /qn` for a silent install.
- Do not mix the EXE and the MSI: keep using the installer type you started with, and uninstall first to switch. These combinations are supported, each proven by an install test on the GitHub runner: a newer EXE over an older EXE; a newer EXE over the English MSI or over the Hebrew MSI, which it replaces with one entry in Apps and Features; and a repair of the MSI with `msiexec /fa` under an installed EXE, which keeps one entry. An installer of the same version in the other language (the EXE or the English MSI over the Hebrew MSI) does not replace the installed one: both stay installed, so uninstall first. Other cross-language cases, such as a newer Hebrew MSI over an English install or a downgrade across languages, are not tested. The remaining combinations leave a second or an orphaned entry in Apps and Features; the install tests pin what each of them does.
- Development server: `SERVER_URL=<origin>` points the agent at another server, for example `msiexec /i Mashkif-<version>-x64.msi SERVER_URL=http://localhost:8180 /qn` or `Mashkif-<version>-x64.exe /quiet /norestart /log <file> SERVER_URL=http://localhost:8180` (write the name in upper case). Plain HTTP is accepted only to `localhost` or a loopback address. A repair or upgrade keeps the value.
- Removed by the admin: the agent stops reporting, and the tray shows that the PC was removed and offers Join again. Joining again registers the PC as a new agent; it never happens without the user's choice. The same applies when the PC is pointed at a different server.
- Not recognized by the server (for example after a restore): the agent keeps reporting with its token and, when the server still refuses it, registers again by itself with the same install ID, at most once an hour.
- Uninstall: from Apps and Features, with the EXE commands above, or `msiexec /x Mashkif-<version>-x64.msi /qn` for an MSI install. The service, the program files, and the registry keys go; the state (`%ProgramData%\Mashkif\state`) and the logs stay, so a reinstall reports as the same PC. Revoke the agent in the admin panel to stop it for good, or delete `%ProgramData%\Mashkif` (as an administrator) to start over as a new PC.
- If the service reports an invalid state (the tray shows the code `state_invalid`), `%ProgramData%\Mashkif` was not created by the installer or was changed. Delete it and repair the installation.

## Contributing

External contributions require a signed Contributor License Agreement, which is collected on the pull request.
