# ODYSSEUS-DISTRIBUTION — 2026-10-21

Built the CLI from package sources (CLI-only + web shell), bundled it with native optional dependencies, built native Electron components, and packaged a self-contained arm64 app. SDK packaging hook confirmed 0.3.280 / Claude 2.1.280 against the installed pin. DMG created with native hdiutil; image checksum verification passed before the final color-only refresh. Final artifact has a separate SHA-256 sidecar.

Installed to ~/Applications/Odysseus.app. CUA confirmed the packaged file URL, existing workspace/session, 85 sources, 247 skills and Odysseus knight. A fresh zsh resolves ~/.local/bin/od ahead of the system command; --version and --help succeeded. An isolated HOME with PATH=/usr/bin:/bin also ran the bundled CLI without a source checkout or system Node/Bun.

Root tests: 91 pass, 0 fail. Distribution tests cover preservation of workspace state and customized shared resources, safe shell quoting/PATH and stale/live installer locks. Integration installer check has no pending changes.

User reported monochrome CLI. Inherited NO_COLOR=1 was confirmed. Interactive launch now removes that inherited opt-out and enables the terminal palette; explicit ODYSSEUS_NO_COLOR=1 opts out. Redirected output remains unforced. A real script PTY smoke with NO_COLOR=1 and TERM_PROGRAM=Apple_Terminal captured ODYSSEUS and ANSI 256-color indices 101, 186, 145, 151, 224, 181; no model prompt was submitted. The smoke process was stopped after observing the header/auth screen.

This is a local unsigned arm64 build. Apple Developer ID signing/notarization and GitHub Actions were not exercised. Intel requires an Intel build. Graphify Python environment remains optional first-use setup; bundled uv and the guide are present in the installed runtime.
