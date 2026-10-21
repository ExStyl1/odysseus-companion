# Odysseus visual identity, 2026-10-21

Local source build 1.42.1-odysseus.4; no signed packaging or CDP pass claimed.

- App/window title and localized product text now say Odysseus; configuration directory, protocol and provider identifiers remain stable. The raw development host still identifies as Electron in the macOS menu; packaged productName is Odysseus.
- Original user-supplied knight photo is bundled for empty states. A generated square derivative replaces the girl in PNG, ICNS and ICO assets. Originals are backed up under .odysseus/branding/original. macOS iconset generation and asset staging succeeded.
- Native accessibility and screenshot observation confirmed the knight and ODYSSEUS wordmark on the main empty screen. Native settings showed Odysseus theme; selecting it changed its selected state and persisted through restart. Final accessibility observation confirmed window title Odysseus.
- Electron typecheck, main/renderer builds and asset copy passed. Locale parity/sorting passed. Renderer has no browser-externalized Node warnings; existing chunk-size and unsupported CSS `file` advisories remain.
- 28 focused native tests passed for the affected empty-state and transcript surfaces. Root suite: 51 passing; installer checks include idempotence and fail-before-write on incompatible source changes.
- Theme uses native color derivation rather than CSS overrides of contrast roles. It supports both system light and dark modes. No model calls or permission changes were made.
