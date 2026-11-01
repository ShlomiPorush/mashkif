# Contributing to Mashkif

Thank you for your interest in Mashkif. This guide explains how to propose a change.

## Contributor License Agreement

Every external contributor signs the Mashkif Contributor License Agreement (CLA) before a pull request can be merged. You sign once for each version of the CLA. CLA Assistant asks for the signature in a comment on your first pull request, and asks again only when the CLA version changes. Pull requests from authors who have not signed the current version are not merged.

## Before you start

- Read [`docs/project-foundation.md`](../docs/project-foundation.md). It records the design decisions, the architecture boundaries, and the status of each part of the project. Propose a change to a decision in an issue before you write code for it.
- For a bug or a feature request, open an issue first, unless the change is small and obvious.
- Report security vulnerabilities privately, as described in [`SECURITY.md`](SECURITY.md). Never in a public issue or pull request.

## Write the change

- Write all repository text in English: code, comments, documentation, commit messages, and pull request descriptions. Hebrew is allowed only in the Hebrew locale files, and a repository guard enforces this.
- Keep one topic per pull request. Split unrelated changes into separate pull requests.
- Never commit secrets, real `.env` files, signing material, or MaxMind GeoLite2 database files.

## Record the change

For a user-visible or operational change, add an entry under `Unreleased` in the changelog of the component:

- `agent/CHANGELOG.md` for the Windows agent;
- `server/CHANGELOG.md` for the server and the web app.

Do not change version numbers in an ordinary pull request. Versions change only when a release is made.

## Verify the change

Run the checks from WSL, in the repository root, before you open a pull request:

```sh
scripts/verify.sh
```

`scripts/verify.sh --changed origin/main` runs only the areas that your change affects. The requirements are listed in [`README.md`](../README.md#development).

## Open the pull request

- Fill in the pull request template: what changed, and how you verified it.
- CI must pass. The `main` branch accepts a pull request only when the `summary` check is green and the branch is up to date with `main`.
- If `main` moves before your pull request is merged, update your branch from `main` and let CI run again.
