# Codebase Structure

**Analysis Date:** 2026-08-16

## Directory Layout

```
nessy-desktop/
├── apps/
│   ├── electron/         # Desktop shell: main, preload, renderer, packaging
│   ├── cli/              # nessy-general-agent CLI client
│   ├── ios/              # Swift NessyAgentKit + NessyMobile remote
│   ├── viewer/           # Dormant web surface (retained)
│   └── webui/            # Dormant web surface (retained)
├── packages/
│   ├── core/             # Cross-package wire types and utils
│   ├── shared/           # Agents, config, credentials, plugins, i18n, protocol
│   ├── server-core/      # Transport, RPC handlers, SessionManager, bootstrap
│   ├── server/           # nessy-server headless binary
│   ├── pi-agent-server/  # Pi subprocess wrapper, orchestrator, extensions
│   ├── codex-agent-server/     # codex-app-server client + event mapping
│   ├── codex-responses-adapter/# Responses↔chat translation for the gateway
│   ├── codex-protocol/   # Codex wire protocol types
│   ├── session-tools-core/     # Session tool defs/handlers
│   ├── session-mcp-server/     # Bundled MCP server exposing those tools
│   ├── messaging-gateway/, messaging-whatsapp-worker/  # Messaging surfaces
│   └── ui/               # Shared renderer UI primitives
├── docs/                 # Architecture records, specs, plans, testing
├── docs-site/            # Public docs pages kept in sync with releases
├── scripts/              # Build, release, validation, CDP, doc tooling
├── fastlane/             # Signing, notarization, publish lanes
├── resources/, build/, sources/
├── package.json          # Bun workspaces: packages/*, apps/*
└── tsconfig.base.json    # Strict, ESNext, bundler resolution
```

## Directory Purposes

**`apps/electron/src`:**
- Purpose: the desktop app
- Contains: `main/` (Electron main process + native handlers), `preload/`, `renderer/` (React), `transport/` (ws clients + routing), `runtime/` (platform services), `shared/`, `__tests__/`
- Key files: `main/index.ts`, `renderer/main.tsx`, `renderer/App.tsx`, `transport/routed-client.ts`

**`apps/electron/src/renderer`:**
- Purpose: UI
- Contains: `components/` (grouped by feature: `chat`, `settings`, `plugins`, `browser`, `sources`, `marketplace`, `ui`…), `pages/`, `atoms/`, `hooks/`, `actions/`, `contexts/`, `event-processor/`, `playground/`
- Key files: `App.tsx`, `playground.tsx`

**`packages/shared/src`:**
- Purpose: the shared brain — everything both hosts need
- Contains: `agent/` (backends, core rules, pi-harness), `config/`, `credentials/`, `plugins/`, `protocol/`, `sessions/`, `skills/`, `mcp/`, `workspaces/`, `i18n/`, `auth/`, `feature-flags.ts`
- Key files: `agent/backend/factory.ts`, `agent/base-agent.ts`, `protocol/channels.ts`, `feature-flags.ts`

**`packages/server-core/src`:**
- Purpose: the server the desktop embeds and the headless binary runs
- Contains: `transport/`, `handlers/rpc/` (one file per domain), `sessions/`, `bootstrap/`, `model-fetchers/`, `services/`, `workspaces/`, `mcp/`, `pi-harness/`, `webui/`
- Key files: `sessions/SessionManager.ts`, `transport/server.ts`, `handlers/rpc/sessions.ts`

**`packages/pi-agent-server/src`:**
- Purpose: the Pi runtime subprocess
- Contains: `harness/`, `orchestrator/`, `extensions/`, `gateway-proxy/`, `local-tools/`, `tools/`, `compat/`
- Key files: `index.ts`, `context-usage.ts`, `model-resolution.ts`

**`docs/`:**
- Purpose: durable records; `docs/README.md` is the index and must be updated when files move
- Contains: `architecture/` (11 accepted records), `superpowers/plans/` and `superpowers/specs/` (trackers, parity audit, deviation register), `testing/`

## Key File Locations

**Entry Points:**
- `apps/electron/src/main/index.ts`: Electron main process
- `apps/electron/src/renderer/main.tsx`: renderer root
- `apps/electron/src/preload/bootstrap.ts`: preload bridge
- `packages/server/src/index.ts`: headless `nessy-server`
- `apps/cli/src/index.ts`: CLI
- `packages/pi-agent-server/src/index.ts`: Pi subprocess
- `packages/session-mcp-server/src/index.ts`: bundled MCP server

**Configuration:**
- `package.json`: workspaces + every build/test/lint script
- `tsconfig.base.json`, per-package `tsconfig.json` / `tsconfig.typecheck.json`
- `bunfig.toml`, `policy.yml`, `.gitlab-ci.yml`, `fastlane/Fastfile`
- `packages/shared/src/config/paths.ts`: `CONFIG_DIR` (`~/.nessy`)

**Core Logic:**
- `packages/server-core/src/sessions/SessionManager.ts`: orchestration core
- `packages/shared/src/agent/backend/factory.ts`: runtime selection
- `packages/shared/src/protocol/channels.ts`: RPC contract
- `packages/shared/src/plugins/format-adapters/`: Claude/Codex plugin import

**Testing:**
- Co-located `*.test.ts` beside sources, plus `__tests__/` directories
- `packages/shared/tests/` for a few package-level suites
- `scripts/cdp/` live-case driver; `docs/testing/cdp-live-checklist.md`

## Naming Conventions

**Files:**
- kebab-case for modules: `claude-runtime-agents.ts`, `routed-client.ts`
- PascalCase for React components and class-owning modules: `ChatPage.tsx`, `SessionManager.ts`
- Tests mirror the subject: `SessionManager.fork-subagent.test.ts`, `permission-dsl.test.ts`
- Isolated suites: `*.isolated.ts` (run separately by `bun run test`)

**Directories:**
- lowercase, hyphenated, feature-named: `model-fetchers/`, `format-adapters/`, `pi-harness/`, `right-sidebar/`

**Packages:**
- Scope `@nessy-agent/*`; binaries `nessy-general-agent`, `nessy-server`

## Where to Add New Code

**New RPC endpoint:**
- Channel name: `packages/shared/src/protocol/channels.ts`
- Handler: `packages/server-core/src/handlers/rpc/<domain>.ts` (register in `handlers/rpc/index.ts`)
- Client call: `apps/electron/src/renderer/actions/` via the routed client
- Tests: `packages/server-core/src/handlers/rpc/__tests__/`

**New agent runtime / provider:**
- Backend: `packages/shared/src/agent/backend/<runtime>/`
- Selection: `packages/shared/src/agent/backend/factory.ts`
- Flag: `packages/shared/src/feature-flags.ts` + mirror in the five build scripts

**New UI feature:**
- Components: `apps/electron/src/renderer/components/<feature>/`
- Page: `apps/electron/src/renderer/pages/`
- State: `apps/electron/src/renderer/atoms/`, hooks in `hooks/`
- Reusable primitive: `packages/ui/src/components/`
- i18n keys in every locale under `packages/shared/src/i18n`

**New session tool:**
- Definition: `packages/session-tools-core/src/tool-defs.ts`; handler in `src/handlers/`

**Shared types:**
- Cross-package wire types: `packages/core/src/types/`
- Agent-internal types: `packages/shared/src/agent/backend/types.ts`

**Utilities:**
- `packages/shared/src/utils/`, `packages/core/src/utils/`

**Docs for a shipped decision:**
- `docs/architecture/<record>.md` and add the row to `docs/README.md`
- Plans/trackers: `docs/superpowers/plans/` (never delete a plan)
- Release notes: new `apps/electron/resources/release-notes/<version>.md`

## Special Directories

**`.references/`:**
- Purpose: upstream reference material
- Generated: No — Committed: Yes — **Never modify**

**`.codegraph/`:**
- Purpose: code-intelligence index; query with `codegraph explore`
- Generated: Yes — Committed: repo-local

**`release/`, `release-publish/`, `output/`, `dist/`:**
- Purpose: build artifacts
- Generated: Yes — Committed: No. Delete `release/` before running `bun test` (packaged renderer copies get collected).

**`apps/electron/resources/release-notes/`:**
- Purpose: append-only per-version changelog read by in-app "What's New"
- Generated: No — Committed: Yes; never edit or delete an existing file

**`node_modules/`:**
- Generated by Bun workspaces — Committed: No

---

*Structure analysis: 2026-08-16*
