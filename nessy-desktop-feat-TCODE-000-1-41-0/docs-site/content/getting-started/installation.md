# Installation

Nessy Desktop is a native Electron app. Builds are published to an internal S3 dev feed, and the same feed serves auto-updates, so installing once keeps the app current.

## Supported Platforms

| Platform | Architectures | Distribution |
| -------- | ------------- | ------------ |
| **macOS** | Apple Silicon (arm64) and Intel (x64) | Signed DMG on the dev feed |
| **Windows** | x64 only | Installer `.exe` on the dev feed |
| **Linux** | — | Packaging script exists in the repo; no published feed in v1 |

## macOS

### One-line install

The installer script resolves the newest build from the update feed, downloads the DMG matching your CPU, and replaces whatever is in `/Applications`:

```bash
curl -fsSL https://nessy-desktop-releases-dev.s3-msk.tinkoff.ru/dev/mac/install-app.sh | bash
```

If the script has not been published to the feed yet, run the copy from a repository checkout instead:

```bash
bash scripts/install-app.sh
```

Either `curl` or `wget` must be present; everything else is stock macOS tooling.

### What the script does

1. Detects your CPU and picks the artifact architecture (`arm64` or `x64`).
2. Resolves the version: `NESSY_DESKTOP_INSTALL_VERSION` if set, otherwise the `version:` field of the first update manifest it can fetch — `dev-mac.yml`, then `dev-<arch>-mac.yml`, `latest-<arch>-mac.yml`, and `latest-mac.yml`.
3. Downloads `NessyDesktop-<version>-mac-<arch>.dmg` into the cache directory (`~/.nessy-agent/downloads` by default).
4. Mounts the image, asks a running Nessy Desktop to quit, deletes the previous `/Applications/Nessy Desktop.app`, and copies the new bundle in.

::: info
The old bundle is deleted rather than overwritten on purpose. Copying onto an existing `.app` merges the two directory trees, which leaves stale files inside the bundle and breaks the code-signature seal.
:::

### Options

| Flag / variable | Effect |
| --------------- | ------ |
| `--print-url` | Print the DMG URL that would be installed, then exit (alias: `--dry-run`) |
| `NESSY_DESKTOP_INSTALL_VERSION` | Pin an exact version instead of the feed's latest |
| `NESSY_DESKTOP_INSTALL_BASE` | Alternate feed base (default `https://nessy-desktop-releases-dev.s3-msk.tinkoff.ru/dev/mac`) |
| `NESSY_DESKTOP_DOWNLOAD_DIR` | Where the DMG is cached (default `~/.nessy-agent/downloads`) |

```bash
# Show the artifact URL without installing
bash scripts/install-app.sh --print-url

# Pin a specific version
NESSY_DESKTOP_INSTALL_VERSION=1.0.1 bash scripts/install-app.sh
```

## Windows

The PowerShell installer follows the same pattern against the `dev/win` feed:

```powershell
irm https://nessy-desktop-releases-dev.s3-msk.tinkoff.ru/dev/win/install-app.ps1 | iex
```

It resolves the version from `dev.yml` (falling back to `latest.yml`, then `latest-x64-win.yml`), downloads `NessyDesktop-<version>-win-x64.exe` to `%TEMP%\nessy-desktop-install`, stops a running Nessy Desktop process, and runs the installer to completion. Only 64-bit Windows is supported.

`NESSY_DESKTOP_INSTALL_VERSION`, `NESSY_DESKTOP_INSTALL_BASE`, and `NESSY_DESKTOP_DOWNLOAD_DIR` behave as on macOS. When invoking the script from a checkout (rather than piping it), `-PrintUrl` prints the installer URL without downloading anything.

## Release Feed

| Item | Value |
| ---- | ----- |
| macOS feed base | `https://nessy-desktop-releases-dev.s3-msk.tinkoff.ru/dev/mac` |
| Windows feed base | `https://nessy-desktop-releases-dev.s3-msk.tinkoff.ru/dev/win` |
| macOS artifact | `NessyDesktop-<version>-mac-<arch>.dmg` |
| Windows artifact | `NessyDesktop-<version>-win-x64.exe` |
| Update metadata | electron-updater manifests (`dev-mac.yml`, `dev.yml`, and `latest*` fallbacks) |

## Auto-Updates

The app checks the same S3 feed through electron-updater on the `dev` channel. Script installs and in-app updates therefore track a single release stream — there is nothing extra to configure.

## Build From Source

### Prerequisites

- macOS (desktop development and packaging are macOS-first)
- [Bun](https://bun.sh) 1.3.x
- Git access to the internal repository

### Develop and build

```bash
bun install

# Run in development with live reload
bun run electron:dev

# Create a production build
bun run electron:build
```

### Package a DMG

```bash
CSC_IDENTITY_AUTO_DISCOVERY=false bash apps/electron/scripts/build-dmg.sh arm64
```

Local packaging needs update-feed placeholders, since electron-builder validates them:

```bash
export NESSY_DESKTOP_UPDATE_URL=https://updates.invalid/dev
export NESSY_DESKTOP_UPDATE_CHANNEL=dev
bun run electron:dist:dev:mac
```

::: warning
Signing and notarization run only in protected release CI. Local builds are unsigned unless you supply your own signing identities.
:::

Windows and Linux packaging scripts live at `apps/electron/scripts/build-win.ps1` and `apps/electron/scripts/build-linux.sh`; only macOS and Windows artifacts are published to the dev feed in v1.

## Runtime Requirements

Everything the app needs at runtime ships inside the bundle. One exception: the first document-conversion request may pull Python wheels through the bundled `uv`, so point it at your approved package index if public package hosts are blocked on your network.

## First Launch

Open the app from `/Applications` or Spotlight on macOS, or from the Start menu on Windows. The setup wizard in the default build offers two ways to connect a model:

1. **Nessy Gateway** (recommended) — one-click corporate sign-in. The app runs
   the corporate `dp` auth flow, exchanges your token for a gateway JWT, and
   creates the connection with the endpoint and models preconfigured. There is
   no form to fill in. On macOS, if the browser tab does not appear, the sign-in
   step shows a **Copy sign-in link** button; open the link in a browser on the
   same computer.
2. **Custom runtime endpoint** — bring your own key. Since 1.26.0 this is the
   single personal-key entrance (the separate "API key" card was merged into
   it): pick the runtime — **Pi agent**, **Claude Code** or **Codex** — paste
   your key, and fetch the model list from the endpoint. The address is filled
   in for you.

The default build also carries the two coding-runtime cards: **Nessy · Codex
agent** (the bundled `codex-app-server` harness on the gateway's models; see
[Codex (Nessy Gateway)](../reference/config/llm-connections#codex-nessy-gateway))
and **Nessy · Claude Code agent** (the Claude Agent SDK harness, same one-click
gateway sign-in; see
[Claude Code (Nessy Gateway)](../reference/config/llm-connections#claude-code-nessy-gateway)).
The **Custom runtime endpoint** card is documented at
[Custom runtime endpoints](../reference/config/llm-connections#custom-runtime-endpoints).
A build can omit a runtime by setting `NESSY_FEATURE_CODEX_RUNTIME=0` /
`NESSY_FEATURE_CLAUDE_RUNTIME=0`.

Subscription cards — Claude Pro/Max, ChatGPT Plus (Pi) and ChatGPT (Codex) — and local models
(Ollama) remain gated behind build-time provider flags and are disabled in the
default build. They appear only in builds produced with the corresponding
`NESSY_FEATURE_PROVIDER_*` flag enabled.

Choosing **Set up later** skips model configuration; you can finish it any time from Settings. On Windows the wizard first verifies that Git Bash is available and helps you locate it if it is missing.

App data — workspaces, sessions, and configuration — lives under `~/.nessy-agent`. See [Config File](../reference/config/config-file) for the layout.

## Headless Server

`scripts/install-server.sh` is intentionally dormant in v1: it refuses to run unless `NESSY_SERVER_DIST_URL` points at a server distribution, and none is published yet. To use the [headless server](../server/headless) today, run it from a repository checkout.

## Next Steps

- [Introduction](introduction) — what the app is and how its pieces fit together.
- [Add sources](../sources/overview) — connect MCP servers, APIs, and local folders.
- [LLM connections](../reference/config/llm-connections) — gateway settings and alternative providers.
