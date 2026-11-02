# Changelog: Mashkif server and web

All notable changes to this component are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/). Releases are tagged `server-vX.Y.Z`.

## [Unreleased]

### Added

- Server skeleton with liveness (`/healthz`), readiness (`/readyz`, checks PostgreSQL and the GeoLite2-ASN file), and the agent health endpoint of protocol version 1.
- Web shell in Hebrew (default, right-to-left) and English, with light and dark themes.
- Container image running as a non-root user, a production Compose file for Traefik, and a local development environment.
- Admin sign-in at `/admin`, in Hebrew and English, on Better Auth: one admin, created on the first visit with a username, an email address, and a password; mandatory TOTP with ten backup codes shown once and regenerated on the account page; passkeys. Sessions last 12 hours by default and are never extended. Sign-in, code, and password reset attempts are limited to 5 per 5 minutes.
- Password reset by an emailed link, valid one hour, which ends every session; email address change confirmed by a link sent to the new address.
- Audit log of setup, sign-ins, failed sign-ins, sign-outs (recorded without the actor), credential and email changes, password resets, and admin changes.
- Settings in the admin panel, each with a default: heartbeat interval, retention, public URL, other trusted origins, trusted proxies, session length, and SMTP (host, port, user, password stored encrypted and never shown, sender). An environment variable may override a setting (`BETTER_AUTH_URL`, `BETTER_AUTH_TRUSTED_ORIGINS`, `MASHKIF_TRUSTED_PROXIES`, `MASHKIF_SESSION_HOURS`, `MASHKIF_SMTP_*`); the panel then shows it locked.
- Email through SMTP with TLS. Without SMTP the server works; password reset and email change requests then send nothing, and the server log says why.
- New required setting `BETTER_AUTH_SECRET` (at least 32 random characters). The server refuses to start without it.
- Agent protocol version 1: `POST /api/agent/register` trades a single-use enrollment key for an agent identity, `POST /api/agent/heartbeat` records heartbeats, and `POST /api/agent/events` stores events, also those recorded offline, with one result per event. Bodies are limited to 64 KB and 500 events; requests are rate limited and get 429 with `Retry-After`.
- Event times come from the server time of the last heartbeat response plus the agent's monotonic clock; events without a usable sync, later than their receipt, or older than 7 days are marked time uncertain.
- Sites: an IPv4 address or an IPv6 /64. The full address of each agent is stored and shown only in the admin panel.
- ASN and organization of each heartbeat from the mounted GeoLite2-ASN file, loaded again when the file changes. The settings page shows the database's build date and warns when it is old.
- Admin pages for agents (last seen, version, site address, network, provider, area, infrastructure, trust tier, label, revoke), single-use enrollment keys (valid 24 hours by default, shown once), blocked addresses and ranges, providers that group ASNs, and settings (heartbeat interval 30 to 600 seconds, retention of at least 8 days). Every change is audited.
- Raw heartbeats and events are deleted every hour after the retention period (30 days by default).
- Trusted proxies: the reverse proxies whose `X-Forwarded-For` is believed, for the agent API and Better Auth.
