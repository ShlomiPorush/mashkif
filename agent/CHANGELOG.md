# Changelog: Mashkif for Windows (agent)

All notable changes to this component are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/). Releases are tagged `agent-vX.Y.Z`.

## [Unreleased]

### Added

- Windows service and tray app skeleton that start and write log lines only.
- Unsigned MSI installer (WiX 7.0.1) with English and Hebrew text, silent install and uninstall for GPO and Intune, and a self-contained runtime. Its upgrade ignores the language, so a newer EXE also replaces an older Hebrew MSI.
- Unsigned EXE installer (WiX 7.0.1 Burn bundle with the standard bootstrapper window, in English) that installs the English MSI, so Explorer offers "Run as administrator". It shows one entry in Apps and Features and supports `/quiet`, `/norestart`, `/log`, `/repair`, `/uninstall`, and `SERVER_URL=`.
- The EXE's finish page offers Launch after an install, repair, or upgrade, which starts the tray right away. It is not offered when the EXE was started elevated ("Run as administrator" or UAC off), because the tray would run elevated, nor in a quiet or passive run; when a restart is needed the page offers Restart instead.
- The service registers the PC by itself at its first start, with its own install ID and token, and sends heartbeats with the round trip and DNS time. No key or property is needed; `SERVER_URL` points a development install at another server.
- When the server no longer recognizes the token, the agent keeps it and, if the server still refuses it an hour later, registers a new token for the same install ID, at most once an hour.
- After a revoke or a change of server the agent sends nothing until the user chooses Join again in the tray, which registers the PC as a new agent.
- The tray shows the agent status in Hebrew and English and offers Join again when it applies.
- The state is kept in `%ProgramData%\Mashkif\state`, readable only by SYSTEM, Administrators, and the service; it stays on uninstall.
