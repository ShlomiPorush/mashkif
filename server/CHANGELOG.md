# Changelog: Mashkif server and web

All notable changes to this component are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/). Releases are tagged `server-vX.Y.Z`.

## [Unreleased]

### Added

- Server skeleton with liveness (`/healthz`), readiness (`/readyz`, checks PostgreSQL and the GeoLite2-ASN file), and the agent health endpoint of protocol version 1.
- Web shell in Hebrew (default, right-to-left) and English, with light and dark themes.
- Container image running as a non-root user, a production Compose file for Traefik, and a local development environment.
