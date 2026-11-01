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
