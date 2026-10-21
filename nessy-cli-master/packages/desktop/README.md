# Nessy CLI

Nessy CLI is a desktop and headless agent workspace. It provides multi-session chat, source connections, skills, file previews, automations, and permission modes in a local-first application.

## Backend

This fork is Nessy-only:

- Agent sessions run through Nessy CLI over ACP.
- The app does not store third-party LLM API keys.
- The built-in LLM connection is `nessy-cli`.
- Legacy multi-provider backends and package/runtime wiring have been removed.

## Nessy CLI Runtime

The desktop app talks to the Nessy CLI over ACP. Treat the CLI as a
runtime artifact, not as desktop source code. A packaged app must bundle a
known CLI build so users can launch it without installing `nessy` separately.

Use one of these workflows depending on what you are developing:

| Workflow                    | Use it when                                                               | Commands                                                             |
| --------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Default desktop development | You are developing desktop only.                                          | `bun run dev`                                                        |
| Published npm package       | You want a specific published CLI version for dev, CI, or release builds. | `NESSY_CLI_VERSION=0.15.12-acp.0 bun run dev`                        |
| Local npm tarball           | You need to verify the exact package contents before publishing.          | `NESSY_CLI_TARBALL=/path/to/nessy-cli-0.15.12-acp.0.tgz bun run dev` |
| Local nessy-cli checkout    | You are changing ACP or other CLI behavior while testing desktop.         | `NESSY_CLI_ROOT=/path/to/nessy-cli bun run dev`                      |
| Explicit CLI entry          | You need to point at a specific CLI file.                                 | `NESSY_CLI=/path/to/nessy-cli/scripts/dev.js bun run dev`        |

`electron:dev` uses local overrides first. If no override is set and this
repository is not inside the nessy-cli monorepo, it vendors the default version
from `nessyCodeRuntime.version` in `package.json` and points Electron at the
vendored CLI automatically.

If you are preparing a package without publishing it, create the tarball from
the Nessy CLI repository and point desktop at it:

```bash
cd /path/to/nessy-cli
npm run build
npm run bundle
npm run prepare:package
npm pack

cd /path/to/desktop
NESSY_CLI_TARBALL=/path/to/nestor/nessy-cli-0.15.12-acp.0.tgz bun run dist:mac
```

Distribution builds run `electron:vendor:nessy` automatically. Set
`NESSY_CLI_VERSION` or `NESSY_CLI_TARBALL` when you want the packaged app to use
a published or packed CLI artifact. If neither is set, this monorepo builds
from the local checkout; a standalone desktop checkout uses
`nessyCodeRuntime.version` from `package.json`.

Development runtime resolution checks sources in this order:

```text
NESSY_CLI / NESSY_CLI_ROOT / NESSY_CLI_PATH
NESSY_CLI_TARBALL
NESSY_CLI_VERSION
local monorepo checkout
existing vendored CLI
nessyCodeRuntime.version from package.json
```

Distribution vendoring checks sources in this order:

```text
NESSY_CLI_TARBALL
NESSY_CLI_VERSION
NESSY_CLI_ROOT / NESSY_CLI_PATH
local monorepo checkout
nessyCodeRuntime.version from package.json
```

## Installation

```bash
bun install
bun run dev
```

## Common Commands

```bash
bun run typecheck:all
bun run test:shared
bun run dev
bun run server:start
```

## Building for Distribution

All build commands run from `packages/desktop/`.

### Prerequisites

- [Bun](https://bun.sh) (see `.bun-version` for exact version)
- `bun install` — install all workspace dependencies

### Developer Build (no code signing)

Use this for local testing. Produces an ad-hoc signed app.

```bash
# macOS (arm64 + x64)
bun run electron:dist:dev:mac

# Windows
bun run electron:dist:dev:win

# Linux
bun run electron:dist:dev:linux
```

### Release Build (with code signing)

```bash
bun run electron:dist:mac
bun run electron:dist:win
bun run electron:dist:linux
```

Release builds require signing credentials via environment variables:

| Variable                      | Purpose                                                 |
| ----------------------------- | ------------------------------------------------------- |
| `CSC_LINK`                    | Path to macOS signing certificate                       |
| `WIN_CSC_LINK`                | File variable containing the Windows `.pfx` in base64   |
| `WIN_CSC_KEY_PASSWORD`        | Password for the Windows signing certificate            |
| `APPLE_ID`                    | Apple ID for notarization                               |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password                                   |
| `APPLE_TEAM_ID`               | Team ID for notarization                                |

### Build Output

All artifacts are written to `apps/electron/release/`:

| Platform | Artifact                                                                 |
| -------- | ------------------------------------------------------------------------ |
| macOS    | `Nessy-CLI-Desktop-{arm64,x64}.dmg`, `Nessy-CLI-Desktop-{arm64,x64}.zip` |
| Windows  | `Nessy-CLI-Desktop-x64.exe`                                              |
| Linux    | `Nessy-CLI-Desktop-x64.AppImage`                                         |

### Bootstrap Installer

Upload desktop artifacts and installer scripts to S3:

```bash
bun run scripts/upload.ts --electron --version 1.2.3 --latest --script
```

Install the latest desktop build on macOS or Linux:

```bash
curl -fsSL https://s3-msk.tinkoff.ru/nestor-companion/nessy-cli/desktop/latest/install-app.sh | bash
```

Install a specific desktop version on macOS or Linux:

```bash
curl -fsSL https://s3-msk.tinkoff.ru/nestor-companion/nessy-cli/desktop/latest/install-app.sh | bash -s -- --version 0.13.0-beta.2
```

Install the latest desktop build on Windows PowerShell:

```powershell
$u = "https://s3-msk.tinkoff.ru/nestor-companion/nessy-cli/desktop/latest/install-app.ps1"; $p = "$env:TEMP\install-app.ps1"; Invoke-WebRequest -UseBasicParsing -Uri $u -OutFile $p; powershell -NoProfile -ExecutionPolicy Bypass -File $p
```

Install a specific desktop version on Windows PowerShell:

```powershell
$u = "https://s3-msk.tinkoff.ru/nestor-companion/nessy-cli/desktop/latest/install-app.ps1"; $p = "$env:TEMP\install-app.ps1"; Invoke-WebRequest -UseBasicParsing -Uri $u -OutFile $p; powershell -NoProfile -ExecutionPolicy Bypass -File $p --version 0.13.0-beta.2
```

### What the Build Does

Each `electron:dist:*` command runs three stages:

1. **`electron:vendor:nessy`** — vendors a Nessy CLI runtime into `vendor/nessy-cli/`. Set `NESSY_CLI_VERSION` to download a published npm version, or `NESSY_CLI_TARBALL` to use a local `npm pack` tarball. If neither is set in this monorepo, it builds from the local checkout.
2. **`electron:build`** — compiles the app via esbuild (main + preload), Vite (renderer), and copies resources/assets.
3. **`electron-builder`** — downloads the Electron runtime, packages the app, signs it, and produces distributable installers (DMG, NSIS, AppImage).

## CLI

```bash
bun run apps/cli/src/index.ts run "Hello from Nessy"
bun run apps/cli/src/index.ts run --workspace-dir ./project "Summarize this repo"
```

The `run` command spawns a headless server, creates a temporary session, streams the response, and exits. Provider flags are accepted only for compatibility; the backend remains Nessy CLI.

## Repository Layout

```text
apps/
  electron/     Desktop app
  cli/          Terminal client
  webui/        Web adapter
packages/
  shared/       Agent, config, prompts, sessions, sources
  server-core/  RPC handlers and session manager
  core/         Shared types
  ui/           Shared UI components
  session-tools-core/
  session-mcp-server/
scripts/        Build and packaging helpers
```

## Capabilities

- Multi-session inbox with streaming responses and tool visualization
- Nessy CLI model discovery through ACP
- MCP, REST API, and local filesystem sources
- Skills stored per workspace
- Permission modes for planning, asking before edits, and autonomous execution
- File attachments and in-app previews for images, PDFs, Office files, and diffs
- Event-driven automations and messaging integrations

## License

Apache 2.0. Third-party dependencies are listed in package manifests and are subject to their respective licenses.
