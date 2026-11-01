# Changelog: Mashkif server and web

All notable changes to this component are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/). Releases are tagged `server-vX.Y.Z`.

## [Unreleased]

### Added

- Server skeleton with liveness (`/healthz`), readiness (`/readyz`, checks PostgreSQL and the GeoLite2-ASN file), and the agent health endpoint of protocol version 1.
- Web shell in Hebrew (default, right-to-left) and English, with light and dark themes.
- Container image running as a non-root user, a production Compose file for Traefik, and a local development environment.
- Admin sign-in at `/admin`, in Hebrew and English: one admin with a password and mandatory TOTP, plus passkeys that verify the user. Sessions end 12 hours after sign-in or after 1 hour without activity. Sign-in attempts are limited to 5 per 5 minutes.
- First admin through a single-use setup token valid for 15 minutes: `node server/dist/cli.js setup-token`.
- Recovery with `node server/dist/cli.js reset-admin`: the current password, TOTP, passkeys, and sessions stop working, and a single-use reset token (valid 15 minutes) lets the admin choose a new password at `/admin/reset`. No password is ever printed.
- Audit log of setup, sign-ins, failed sign-ins, sign-outs, credential changes, and resets.
- New required settings: `MASHKIF_APP_KEY` (secret, at least 32 random bytes in base64) and `MASHKIF_PUBLIC_URL` (the origin of the web app). The server refuses to start without them.
- Agent protocol version 1: `POST /api/agent/register` trades a single-use enrollment key for an agent identity, `POST /api/agent/heartbeat` records heartbeats, and `POST /api/agent/events` stores events, also those recorded offline, with one result per event. Bodies are limited to 64 KB and 500 events; requests are rate limited and get 429 with `Retry-After`.
- Event times come from the server time of the last heartbeat response plus the agent's monotonic clock; events without a usable sync, later than their receipt, or older than 7 days are marked time uncertain.
- Sites: an IPv4 address or an IPv6 /64. The full address of each agent is stored and shown only in the admin panel.
- ASN and organization of each heartbeat from the mounted GeoLite2-ASN file, loaded again when the file changes. The settings page shows the database's build date and warns when it is old.
- Admin pages for agents (last seen, version, site address, network, provider, area, infrastructure, trust tier, label, revoke), single-use enrollment keys (valid 24 hours by default, shown once), blocked addresses and ranges, providers that group ASNs, and settings (heartbeat interval 30 to 600 seconds, retention of at least 8 days). Every change is audited.
- Raw heartbeats and events are deleted every hour after the retention period (30 days by default).
- New optional setting `MASHKIF_TRUSTED_PROXIES`: the reverse proxies whose `X-Forwarded-For` is believed. Sign-in rate limits now use the same client address as the agent API.
