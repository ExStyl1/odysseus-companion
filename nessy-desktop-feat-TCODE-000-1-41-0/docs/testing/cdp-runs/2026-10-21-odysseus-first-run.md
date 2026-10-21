# ODYSSEUS-FIRST-RUN — 2026-10-21

Root regression: 87 pass, 0 fail. Focused native bridge/native-format/terminal/catalog: 7 pass, 0 fail. Electron typecheck, main and renderer builds passed; renderer has no browser-externalized warnings. Integration installer check: zero pending changes; shared profile preview: zero file changes.

Real import copied 314 files from .nessy and .nessy-agent into ~/.odysseus/profiles, skipped 12 runtime entries, reported zero warnings. Neither .nestor nor Nessy Desktop.app was present in discovery; isolated fixtures cover those sources and ASAR dist/resources.

Live launch exposed loss of empty directories required by native v2 storage readiness. Import now preserves directory entries, with regression coverage. The existing owned snapshot was repaired by copying directory structure only; original files were untouched. Native Retry then opened the workspace successfully with its existing session, 85 sources and 247 skills. The UI displayed the first-run import receipt. Navigating Sources → Skills displayed all four role tabs and Russian descriptions.

External provider authentication and every imported third-party extension were not exercised. No provider request was sent.
