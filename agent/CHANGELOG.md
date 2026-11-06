# Changelog: Mashkif for Windows (agent)

All notable changes to this component are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/). Releases are tagged `agent-vX.Y.Z`.

## [Unreleased]

### Added

- Windows service and tray app skeleton that start and write log lines only.
- Unsigned MSI installer (WiX 7.0.1) with English and Hebrew text, silent install and uninstall for GPO and Intune, and a self-contained runtime. Its upgrade ignores the language, so a newer EXE also replaces an older Hebrew MSI.
- Unsigned EXE installer (WiX 7.0.1 Burn bundle with the standard bootstrapper window, in English) that installs the English MSI, so Explorer offers "Run as administrator". It shows one entry in Apps and Features and supports `/quiet`, `/norestart`, `/log`, `/repair`, `/uninstall`, and `SERVER_URL=`.
- The service registers the PC by itself at its first start, with its own install ID and token, and sends heartbeats with the round trip and DNS time. No key or property is needed; `SERVER_URL` points a development install at another server.
- When the server no longer recognizes the token, the agent keeps it and, if the server still refuses it an hour later, registers a new token for the same install ID, at most once an hour.
- After a revoke or a change of server the agent sends nothing until the user chooses Join again in the tray, which registers the PC as a new agent.
- The tray shows the agent status in Hebrew and English and offers Join again when it applies.
- The state is kept in `%ProgramData%\Mashkif\state`, readable only by SYSTEM, Administrators, and the service; it stays on uninstall.
- The service records when the connection to the Mashkif server is lost and restored (it checks every 15 seconds, also offline), and when the PC sleeps, resumes, shuts down, or the service stops. The events wait in an offline queue in the state folder and are sent when the server can be reached, with the time measured from the last server answer, never from the PC clock. Events past the server's hourly budget wait as long as the server asks; events older than 7 days or past 10,000 are dropped, oldest first, and the server is told how many.
- A shutdown waits at most 1 second for a heartbeat in flight and sends its event at once; the service stops within 10 seconds on a healthy disk. A sleep event is best effort and may be lost or arrive late; reporting resumes at most 5 seconds after a sleep notice on an awake PC.
- The state file moves to schema version 2; a version 1 file of an earlier build is read and migrated. An earlier build cannot read the new file and reports `state_invalid` (development builds only; there is no release yet).
