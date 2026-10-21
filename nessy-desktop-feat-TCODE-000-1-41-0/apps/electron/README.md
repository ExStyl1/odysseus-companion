# Nessy Desktop Electron App

The Electron app is the primary Nessy Desktop interface. It hosts the main
window, renderer UI, local RPC transport, onboarding, auto-update checks,
packaged resources, and release configuration.

## Quick Start

From the repo root:

```bash
bun run electron:build
bun run electron:start
bun run electron:dev
```

Package-local scripts also exist in `apps/electron/package.json`:

```bash
cd apps/electron
bun run typecheck
bun run lint
bun run build
```

## Current Architecture

```text
apps/electron/
├── src/
│   ├── main/             Electron main process, windows, menus, IPC handlers
│   ├── preload/          Renderer bootstrap and browser-toolbar bridges
│   ├── renderer/         React app, pages, hooks, playground, UI glue
│   ├── runtime/          Platform service interfaces
│   ├── shared/           Routes, shared DTOs, menu schema
│   └── transport/        Typed IPC/RPC channel map and client/server codecs
├── resources/            Icons, bundled docs, permissions, scripts, tool icons
├── scripts/              Packaging/build helpers
└── electron-builder.yml  Desktop packaging configuration
```

The headless server/session implementation lives under `packages/server` and
`packages/server-core`. Shared agent, config, credential, source, i18n, and
model logic lives under `packages/shared`.

## Gateway And Subscriptions

First-run onboarding offers Nessy Gateway first. The preset stores a
`pi_compat` connection pointed at:

```text
https://code-completion-nestor.tcsbank.ru/api/v1/cli/openai-like/v1
```

The app reads the local JWT from `~/.nessy/dp_auth_creds.json` for prefill only.
Runtime requests to the verified `/api/v1/cli/` gateway prefix are rewritten
from `Authorization: Bearer` to `Nestor-Token`; other endpoints keep normal
provider auth semantics. The Nessy Gateway model list refreshes at startup from
`https://code-completion-nestor.tcsbank.ru/api/v1/cli/models`.

Claude Max/Pro OAuth, Anthropic API key, and ChatGPT/Codex subscription flows
remain available as user opt-in connections.

## Packaging Notes

The Claude Agent SDK spawns a native `claude` binary from a per-platform
optional dependency. Packaged builds stage the binary under:

```text
node_modules/@anthropic-ai/claude-agent-sdk-binary/{claude,claude.exe}
```

`packages/shared/src/agent/backend/internal/runtime-resolver.ts` resolves that
packaged alias first and falls back to the real optional dependency in dev.

Local unsigned macOS release rehearsal:

```bash
export NESSY_DESKTOP_UPDATE_URL=https://updates.invalid/dev
export NESSY_DESKTOP_UPDATE_CHANNEL=dev
CSC_IDENTITY_AUTO_DISCOVERY=false bash apps/electron/scripts/build-dmg.sh arm64
```

The two exports are not optional: `electron-builder.yml`'s publish block
interpolates both, and electron-builder expands them at the packaging step, so a
build without them used to run for minutes and then die on `cannot expand
pattern`. All three platform scripts (`build-dmg.sh`, `build-linux.sh`,
`build-win.ps1`) now refuse up front instead, naming the missing variable and
these values (P6.980).

The release output is written to the repo-root `release/` directory.

## Useful Files

| File | Purpose |
| --- | --- |
| `src/main/index.ts` | App entry and startup orchestration |
| `src/main/handlers/` | Main-process IPC handlers |
| `src/main/deep-link.ts` | `nessy://` deep-link handling |
| `src/main/auto-update.ts` | Auto-update integration |
| `src/preload/bootstrap.ts` | Renderer bootstrap API |
| `src/renderer/App.tsx` | React root |
| `src/renderer/hooks/useOnboarding.ts` | Onboarding flow state |
| `src/renderer/components/apisetup/nessy-gateway.ts` | Nessy Gateway preset |
| `src/renderer/contexts/NavigationContext.tsx` | Navigation state |
| `src/shared/routes.ts` | Route definitions |
| `src/transport/channel-map.ts` | IPC/RPC channel registry |
| `resources/AGENTS.md` | Developer notes on what `resources/` holds and what syncs to `~/.nessy-agent` (bundled into `dist/resources/`, but nothing syncs or reads it at runtime) |

## Icons

Three committed icon files ship, and nothing generates them at build time —
electron-builder and the main process read each one as it is:

| File | Read by |
| --- | --- |
| `resources/icon.icns` | `mac.icon` and `dmg.icon` in `electron-builder.yml`. On macOS `getIconPath` (`src/main/window-manager.ts`) only checks that it exists: a macOS window has no icon of its own (Electron marks `setIcon` `@platform win32,linux`) |
| `resources/icon.ico` | `win.icon` in `electron-builder.yml`; the Windows window icon |
| `resources/icon.png` | `linux.icon` in `electron-builder.yml`; the Linux window icon; the macOS dock icon and its badge base (`app.dock.setIcon` / `initBadgeIcon` in `src/main/index.ts`, in dev AND packaged builds) |

`icon.png` must stay square: pad it with transparent pixels rather than
scaling or cropping the artwork (`sips --padToHeightWidth <n> <n>` does this).
Replacing the artwork means re-exporting all three files from one source.
