# Bundled Resources

This folder holds assets bundled with the Electron app. Six of its entries are synced to the user's `~/.nessy-agent/` directory on every launch — each by its own rule, and only two of them by overwriting; the rest are read in place from the app bundle, or used by electron-builder, and never reach the user's home.

## How It Works

1. **Build time**: `scripts/copy-assets.ts` copies this folder to `dist/resources/`
2. **Package time**: electron-builder includes `dist/resources/` in the app bundle
3. **Runtime**: `getBundledAssetsDir()` resolves paths to these bundled assets
4. **Launch**: Each synced entry below syncs to the user's home directory by its own rule

## Asset Types

| Folder/File | Synced To | Sync Behavior |
|-------------|-----------|---------------|
| `docs/` | `~/.nessy-agent/docs/` | Overwritten on every launch (`initializeDocs`) |
| `config-defaults.json` | `~/.nessy-agent/config-defaults.json` | Overwritten on every launch (`syncConfigDefaults`) |
| `themes/` | `~/.nessy-agent/themes/` | Copied when missing or invalid; a valid file is kept, so a user's edit survives (the theme sync in `config/storage.ts`) |
| `permissions/` | `~/.nessy-agent/permissions/` | `default.json` installed when missing or corrupt; otherwise merged forward only when the bundled `version` is newer, keeping the user's patterns (`permissions-config.ts`) |
| `tool-icons/` | `~/.nessy-agent/tool-icons/` | Each file copied only when it is missing; an existing file is never replaced |
| `skills/` | `~/.nessy-agent/skills/` | Seeded when absent; a copy still identical to a shipped version is refreshed to the current bundle, an edited copy is left alone (`skills/seed.ts`) |

## Why Sync on Every Launch?

- Ensures users always have the latest defaults/docs when the app updates
- Consistent behavior between debug and release builds
- No stale configuration causing confusion

## Other Files (Not Synced)

These are used by electron-builder or read in place by the app, never synced to the user's home:

| File | Purpose |
|------|---------|
| `icon.icns` | macOS app and DMG icon (`mac.icon`, `dmg.icon`). `getIconPath` in `window-manager.ts` only checks that it exists: a macOS window has no icon of its own (Electron marks `setIcon` `@platform win32,linux`) |
| `icon.ico` | Windows app and window icon (`win.icon`) |
| `icon.png` | Linux app and window icon (`linux.icon`); macOS dock icon and badge base (`app.dock.setIcon`, `initBadgeIcon`). Square, padded — never scaled |
| `bin/` | Shell and `.cmd` wrappers for the bundled document tools (`markitdown`, `pdf-tool`, …), prepended to the agent's `PATH` by `src/main/index.ts`, plus the `node` and `nessy-general-agent` shims, which the packaged `files` list does not carry (DA1.61 in `src/main/index.ts`) |
| `scripts/` | The Python behind those wrappers (`NESSY_SCRIPTS`), with their smoke tests under `scripts/tests/` |
| `certs/` | `tinkoff-bundle.crt`, the bundled CA — trust material, read in place and only from the app's registered assets root (`config/tls-ca-path.ts`) |
| `release-notes/` | One `<version>.md` per release, read in place by the release-notes reader (`release-notes/index.ts`) |
| `AGENTS.md` | This file: developer documentation, copied into `dist/resources/` with the rest and read by nothing at runtime |

Staged by the build and git-ignored, so absent from a fresh checkout:
`session-mcp-server/` (the bundled MCP server for session tools),
`pi-agent-server/` (the Pi subprocess), and the per-platform `bin/<platform>-<arch>/uv`
and `bin/codex/` binaries. `bun run electron:build:servers` restages the two servers.

## Single Source of Truth

The files in this folder are the **source of truth** for bundled defaults:
- Edit `config-defaults.json` here to change default settings
- Edit files in `docs/` to update documentation
- Edit files in `themes/` to update bundled themes (a profile that already holds a valid copy keeps its own)

`config-defaults.json` has one in-code mirror, `FALLBACK_CONFIG_DEFAULTS` in `config/storage.ts`: it is written only when the bundled file cannot be found (CI, a standalone server) and no user copy exists yet, so the two must carry the same defaults.
