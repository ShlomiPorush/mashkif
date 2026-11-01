# Security policy

## Report a vulnerability

Report security vulnerabilities privately through GitHub private vulnerability reporting:

<https://github.com/ShlomiPorush/mashkif/security/advisories/new>

Do not report vulnerabilities in public issues, pull requests, or discussions. A public report can expose users before a fix exists.

## Scope

This policy covers the code in this repository:

- the Windows agent, tray app, and MSI installer (`agent/`);
- the agent-to-server protocol definition (`contracts/`);
- the server (`server/`);
- the web app (`web/`);
- the workflow scripts (`scripts/`) and the container definitions (`config/`, `docker-compose.yml`);
- the CI configuration (`.github/`).

Vulnerabilities in third-party dependencies are in scope when they affect Mashkif. Report vulnerabilities that do not depend on Mashkif to the project that owns the dependency.

## What to include

- The affected component, and the commit or version.
- A description of the vulnerability and its impact.
- Steps to reproduce it, or a proof of concept.
- Any known workaround or suggested fix.

Do not include personal data of other people in the report.

## Supported versions

Mashkif has no release yet. Until the first release, only the latest commit on the `main` branch receives security fixes.

## Response

Mashkif has a single maintainer, and responses are best effort. There is no fixed response time. You receive a reply in the private advisory, and the maintainer coordinates the fix and its disclosure with you there.
