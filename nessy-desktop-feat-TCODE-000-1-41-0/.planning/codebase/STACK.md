# Technology Stack

**Analysis Date:** 2026-08-16

## Languages

**Primary:**
- TypeScript ~5.x (ESNext target/module, `strict: true`, `moduleResolution: bundler`) — all of `packages/*` and `apps/*`. Base config: `tsconfig.base.json`
- TSX/React 18 — renderer surfaces in `apps/electron/src`, `packages/ui/src`, `apps/viewer`, `apps/webui`

**Secondary:**
- Python 3 — bundled document tools shipped as app resources: `apps/electron/resources/scripts/pdf_tool.py`, `docx_tool.py`, `xlsx_tool.py`, `pptx_tool.py`, `img_tool.py`, `ical_tool.py`, `doc_diff.py`, `markitdown_cli.py` (smoke tests in `apps/electron/resources/scripts/tests/`)
- Swift — iOS client `apps/ios/NessyMobile` and `apps/ios/NessyAgentKit`
- Ruby — signing/notarization/release lanes in `fastlane/Fastfile` (Bundler 4, repo-local `fastlane/vendor/bundle`)
- Shell / PowerShell — packaging scripts `apps/electron/scripts/build-dmg.sh`, `build-win.ps1`, `build-linux.sh`

## Runtime

**Environment:**
- Bun 1.3.14 — test runner, script runner, TS execution (`packages/server/src/index.ts` runs under Bun)
- Node.js — CI `${NODE_IMAGE}` jobs and `.mjs` release helpers (`scripts/prepare-release-assets.mjs`, `scripts/verify-update-feed.mjs`)
- Electron ^39.2.7 — desktop shell (`apps/electron`)

**Package Manager:**
- Bun workspaces (`workspaces: ["packages/*", "apps/*"]` in `package.json`)
- Lockfile: `bun.lock` present; installs are `bun install --frozen-lockfile`
- Registry pinned to Artifactory in `bunfig.toml`: `https://artifactory.tcsbank.ru/artifactory/api/npm/npm-all/`
- Linker: `hoisted` (required — Vite/esbuild bundling expects a hoisted `node_modules`; see comment in `bunfig.toml`)

## Frameworks

**Core:**
- React 18.3 + `react-dom` — renderer UI
- Electron 39 + `electron-builder` ^26 — desktop shell and packaging (`apps/electron/electron-builder.yml`)
- Vite ^6.2 + `@vitejs/plugin-react` — renderer/viewer/webui/marketing dev+build (`apps/electron/vite.config.ts`, `apps/viewer/vite.config.ts`, `apps/webui/vite.config.ts`)
- Tailwind CSS v4 (`@tailwindcss/vite`, `@tailwindcss/typography`), `postcss`, `autoprefixer`
- Radix UI primitives + `class-variance-authority` + `tailwind-merge` + `lucide-react` — design system in `packages/ui`
- Jotai (`jotai`, `jotai-family`) — renderer state; `@tanstack/react-query`, `@tanstack/react-table`
- TipTap 3 (`@tiptap/*`, `tiptap-markdown`, `tiptap-extension-code-block-shiki`) — the composer editor
- `ws` — websocket transport between `packages/server`/`server-core` and the Electron/CLI clients

**Agent runtimes (the product's core frameworks):**
- `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-agent-core` 0.80.3 — Pi runtime, wrapped by `packages/pi-agent-server`
- `@anthropic-ai/claude-agent-sdk` 0.3.218 + `@anthropic-ai/sdk` ^0.100.0 — Claude runtime (`packages/shared/src/agent/claude-runtime-agents.ts`)
- Codex runtime — in-repo `packages/codex-agent-server`, `packages/codex-protocol`, `packages/codex-responses-adapter` (Responses-API translation)
- `@modelcontextprotocol/sdk` ^1.29.0 — MCP client/server (`packages/session-mcp-server`)
- `@github/copilot-sdk` ^0.1.23

**Testing:**
- `bun test` — the only test runner; preloads configured in `bunfig.toml` `[test]` (`packages/shared/tests/setup/isolate-shared-config-dir.ts`, `packages/shared/src/unified-network-interceptor.ts`, `apps/electron/testing/electron-mock-preload.ts`)
- Python `unittest` for doc tools (`bun run test:doc-tools`)
- CDP live-test driver in `scripts/cdp/` (checklist: `docs/testing/cdp-live-checklist.md`)

**Build/Dev:**
- `esbuild` ^0.25 — main/preload bundling via `scripts/electron-build-main.ts`, `scripts/electron-build-preload.ts`
- `electron-builder` — dmg/nsis/AppImage; `@electron/packager`, `app-builder-bin`
- ESLint 9 + `@typescript-eslint` 8 + react plugins; repo-local rules in `apps/electron/eslint-rules`
- Husky ^9 (`prepare: husky`)

## Key Dependencies

**Critical:**
- `zod` ^4 — schema validation across wire types and tool contracts
- `@vscode/ripgrep` ^1.17 — file search backing the agent's search tools
- `sharp` 0.34.5 (+ pinned `@img/*` platform binaries in `optionalDependencies`) — image processing in `packages/server-core` and Electron
- `jose` — JWT handling in `packages/server-core`
- `undici` — HTTP in the Electron main process
- `electron-updater` + `electron-log` — auto-update and logging
- `shiki` / `@shikijs/cli`, `marked`, `react-markdown`, `remark-gfm`, `rehype-katex`, `katex`, `beautiful-mermaid` — content rendering
- `i18next` + `react-i18next` + `i18next-browser-languagedetector` — localization (`packages/shared/src/i18n`), parity enforced by `scripts/check-i18n-parity.ts`

**Infrastructure:**
- `@aws-sdk/client-s3` ^3.947 (dev) — release publishing to S3
- `tar` ^7.5, `yauzl`, `fflate` — archive handling (plugin/skill install)
- `croner` — cron scheduling (`packages/shared/src/sessions/cron-scheduler.ts`)
- `koffi` — native FFI used by `packages/pi-agent-server`
- `pdfjs-dist`, `turndown`, `node-html-parser`, `duck-duck-scrape`, `markitdown-js` — Pi tool implementations
- `filtrex`, `bash-parser`, `shell-quote`, `acorn`, `ajv`, `incr-regex-package`, `@leeoniya/ufuzzy`, `@isaacs/ttlcache`, `glob`, `js-yaml`, `gray-matter`, `semver`, `date-fns`

## Configuration

**Environment:**
- `.env.example` and `.env.local` exist at the repo root (contents not read — treated as secrets)
- Hundreds of `NESSY_*` env vars drive runtime behavior; representative: `NESSY_CONFIG_DIR`, `NESSY_CACHE_DIR`, `NESSY_DEBUG`, `NESSY_BUNDLED_ASSETS_ROOT`, `NESSY_WEBUI_DIR`, `NESSY_WEBUI_PORT`, `NESSY_AUTO_COMPACT_WINDOW`, `NESSY_AGENT_DIR`, `NESSY_DESKTOP_UPDATE_URL`, and the `NESSY_CDP_*` family used only by live tests
- Build-time feature flags (values `1`/`0` only) resolved in `packages/shared/src/feature-flags.ts`: `NESSY_FEATURE_PROVIDER_NESSY`, `_NESTOR_CLOUD`, `_API_KEY`, `_LOCAL`, `_CLAUDE`, `_CHATGPT`, `NESSY_FEATURE_CODEX_RUNTIME`, `NESSY_FEATURE_CLAUDE_RUNTIME`
- User config directory: `~/.nessy-agent/` (plus the shared `~/.nessy/dp_auth_creds.json`)

**Build:**
- `tsconfig.base.json` (shared compiler options), per-package `tsconfig.json`, `scripts/build/tsconfig.json`
- `apps/electron/electron-builder.yml` — `appId: ru.tfinance.nessy-desktop.NessyDesktop`, `productName: Nessy Desktop`
- `bunfig.toml` — registry, linker, test preloads
- `.gitlab-ci.yml` (+ `.gitlab-ci-compliance.yml`, `policy.yml`), `fastlane/Fastfile`, `fastlane/match.yml`
- Vite configs per app; `apps/electron/components.json` (shadcn-style component config)

## Platform Requirements

**Development:**
- Bun 1.3.x, Node for CI helpers, Electron toolchain
- Homebrew Ruby 3.4 + Bundler 4 for Fastlane on macOS
- Python 3 for the document-tool suite
- Xcode for `apps/ios`

**Production:**
- Desktop app for macOS (arm64/x64, dmg, signed+notarized via Fastlane), Windows (nsis, `build-win.ps1`), Linux (AppImage, `build-linux.sh`)
- Headless server binary (`nessy-server`) built by `scripts/build-server.ts` for darwin/linux × arm64/x64
- CLI binary `nessy-general-agent` (`apps/cli`)
- Updates served from a generic feed at `${NESSY_DESKTOP_UPDATE_URL}` (S3-backed), verified by `scripts/verify-update-feed.mjs`

---

*Stack analysis: 2026-08-16*
