<!-- refreshed: 2026-08-16 -->
# Architecture

**Analysis Date:** 2026-08-16

## System Overview

```text
┌─────────────────────────────────────────────────────────────┐
│                      Clients (UI surfaces)                   │
├──────────────────┬──────────────────┬───────────────────────┤
│ Electron renderer│   CLI client     │  iOS app / web UI     │
│ `apps/electron/  │  `apps/cli/src`  │  `apps/ios`,          │
│  src/renderer`   │                  │  `apps/webui`         │
└────────┬─────────┴────────┬─────────┴──────────┬────────────┘
         │  WsRpcClient / RoutedClient (channel-routed JSON RPC over ws/wss)
         ▼                  ▼                     ▼
┌─────────────────────────────────────────────────────────────┐
│  Transport + RPC handler layer                               │
│  `packages/server-core/src/transport/server.ts`              │
│  `packages/server-core/src/handlers/rpc/*.ts`                │
│  channel names: `packages/shared/src/protocol/channels.ts`   │
└──────────────────────────┬──────────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  SessionManager — the orchestration core                     │
│  `packages/server-core/src/sessions/SessionManager.ts`       │
└──────────────────────────┬──────────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  Agent backends (one per providerType)                       │
│  `packages/shared/src/agent/backend/factory.ts`              │
│  PiAgent │ ClaudeAgent │ CodexAgent │ NestorCloudAgent       │
└────────┬───────────────┬──────────────────┬─────────────────┘
         ▼               ▼                  ▼
┌──────────────────┬──────────────────┬──────────────────────┐
│ Pi subprocess    │ Claude Agent SDK │ codex-app-server     │
│ `packages/       │ + loopback       │ `packages/codex-     │
│  pi-agent-server`│ gateway adapter  │  agent-server`,      │
│                  │                  │ `codex-responses-    │
│                  │                  │  adapter`            │
└──────────────────┴──────────────────┴──────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  Nessy Gateway / provider APIs, config + session storage     │
│  `~/.nessy`, storage v2 (`packages/shared/src/workspaces`)   │
└─────────────────────────────────────────────────────────────┘
```

## Component Responsibilities

| Component | Responsibility | File |
|-----------|----------------|------|
| Electron main | App lifecycle, windows, embedded server bootstrap, native IPC | `apps/electron/src/main/index.ts` |
| Renderer | React UI, atoms/state, event processing | `apps/electron/src/renderer/App.tsx` |
| Preload | Bridged surfaces (MCPB import, OAuth orchestration) | `apps/electron/src/preload/bootstrap.ts` |
| Client router | Local-vs-workspace channel routing, re-subscribe on switch | `apps/electron/src/transport/routed-client.ts` |
| RPC server | WebSocket transport, auth, sequencing, push | `packages/server-core/src/transport/server.ts` |
| RPC handlers | One module per domain (sessions, plugins, settings…) | `packages/server-core/src/handlers/rpc/` |
| SessionManager | Session lifecycle, permissions, tool orchestration, events | `packages/server-core/src/sessions/SessionManager.ts` |
| Agent factory | providerType → backend + credential routing | `packages/shared/src/agent/backend/factory.ts` |
| Base agent | Shared agent behavior (prompt, tools, usage) | `packages/shared/src/agent/base-agent.ts` |
| Pi harness | Pi-side capability/permission contracts | `packages/shared/src/agent/pi-harness/` |
| Pi subprocess | Pi SDK wrapper, orchestrator, extensions | `packages/pi-agent-server/src/index.ts` |
| Codex runtime | app-server client, event mapping, approvals | `packages/codex-agent-server/src/runtime-manager.ts` |
| Codex adapter | Responses↔chat translation against the gateway | `packages/codex-responses-adapter/src/server.ts` |
| Session tools | Tool definitions/handlers shared with the MCP server | `packages/session-tools-core/src/tool-defs.ts` |
| Wire types | Cross-package message/session/workspace types | `packages/core/src/types/` |
| Headless server | Standalone `nessy-server` binary | `packages/server/src/index.ts` |

## Pattern Overview

**Overall:** Bun workspace monorepo; a client/server split where every UI surface (desktop renderer, CLI, iOS, web) is a thin client over one RPC contract, and a single `SessionManager` owns agent orchestration behind pluggable agent backends.

**Key Characteristics:**
- One wire contract, many transports — the Electron app runs the *same* server-core in-process that `packages/server` runs headless.
- Runtime pluggability: Pi, Claude and Codex runtimes sit behind `AgentBackend`, selected by `providerType` and gated by build-time feature flags (`packages/shared/src/feature-flags.ts`).
- Adapter pattern at every foreign boundary: plugin format adapters (`packages/shared/src/plugins/format-adapters/`), Responses↔chat adapter, Anthropic Messages↔gateway loopback adapter.
- Capability negotiation: clients advertise capabilities and the server fails closed on unknown (`packages/server-core/src/transport/capabilities.ts`, `docs/architecture/transport-locality.md`).

## Layers

**Client layer:**
- Purpose: render state, send RPC, subscribe to sequenced events
- Location: `apps/electron/src/renderer`, `apps/cli/src`, `apps/ios`, `apps/webui`
- Depends on: `packages/shared/src/protocol`, `packages/ui`
- Used by: end users

**Transport layer:**
- Purpose: websocket RPC + push, TLS/self-signed certs, sequencing barrier, locality gating
- Location: `packages/server-core/src/transport/`
- Depends on: `packages/shared/src/protocol/channels.ts`
- Used by: all clients, both hosts

**Handler layer:**
- Purpose: one module per RPC domain, validates and delegates
- Location: `packages/server-core/src/handlers/rpc/`
- Depends on: `handler-deps.ts` injected services
- Used by: transport layer

**Orchestration layer:**
- Purpose: sessions, permission modes, hooks, subagents, approvals, transcript
- Location: `packages/server-core/src/sessions/`
- Depends on: `packages/shared/src/agent`
- Used by: handler layer

**Agent/runtime layer:**
- Purpose: talk to the actual model runtime and stream events back
- Location: `packages/shared/src/agent/backend/{pi,claude,codex,nestor-cloud}`, `packages/pi-agent-server`, `packages/codex-agent-server`
- Depends on: credentials, config, gateway
- Used by: orchestration layer

**Platform layer:**
- Purpose: swap Electron-native services for headless equivalents
- Location: `apps/electron/src/runtime/platform.ts`, `packages/server-core/src/runtime/platform-headless.ts`

## Data Flow

### Primary request path (send a message)

1. Renderer action calls RPC channel `sessions:sendMessage` (`packages/shared/src/protocol/channels.ts`)
2. `RoutedClient` picks local vs workspace client (`apps/electron/src/transport/routed-client.ts`)
3. RPC server dispatches to the sessions handler (`packages/server-core/src/handlers/rpc/sessions.ts`)
4. `SessionManager` resolves the session, permission mode and tools (`packages/server-core/src/sessions/SessionManager.ts`)
5. `createBackend` returns the runtime backend (`packages/shared/src/agent/backend/factory.ts`)
6. Backend streams model/tool events; `SessionManager` normalizes and pushes sequenced events (`packages/server-core/src/transport/push.ts`)
7. Renderer's event processor applies them to atoms (`apps/electron/src/renderer/event-processor/`)

### Permission / approval flow

1. Backend requests a tool; pre-tool-use rules evaluate (`packages/shared/src/agent/core/pre-tool-use.ts`)
2. Permission DSL and mode decide allow/ask/deny (`packages/shared/src/agent/pi-harness/permission-dsl.ts`, `packages/shared/src/agent/mode-types.ts`)
3. An "ask" surfaces as a push event; the client replies over `sessions:respondToPermission`
4. Remote clients are ceiling-capped server-side in `packages/server-core/src/handlers/rpc/sessions.ts`

### Startup flow

1. Host bootstraps storage + server (`packages/server-core/src/bootstrap/`)
2. Managed policy, trust chain and gateway auth are applied (`packages/shared/src/auth/dp`)
3. Model refresh runs (`packages/server-core/src/model-fetchers/nestor.ts`)

**State Management:**
- Renderer: Jotai-style atoms in `apps/electron/src/renderer/atoms/` fed by the event processor.
- Server: `SessionManager` in-memory session state, persisted through storage v2 (`packages/shared/src/workspaces`) and `.pi-sessions/*.jsonl` transcripts.

## Key Abstractions

**AgentBackend:**
- Purpose: uniform interface over Pi / Claude / Codex / Nestor Cloud
- Examples: `packages/shared/src/agent/backend/types.ts`, `packages/shared/src/agent/pi-agent.ts`, `claude-agent.ts`, `codex-agent.ts`
- Pattern: factory + strategy

**RPC channel map:**
- Purpose: the stable wire contract; keys are internal, string values are the API
- Examples: `packages/shared/src/protocol/channels.ts`, `apps/electron/src/transport/channel-map.ts`

**Capability IR (plugins):**
- Purpose: normalize Claude/Codex plugin formats into one capability set
- Examples: `packages/shared/src/plugins/format-adapters/claude.ts`, `.../codex.ts`, `docs/architecture/unified-plugin-adapter-runtime.md`

**PlatformServices:**
- Purpose: inject Electron vs headless implementations
- Examples: `apps/electron/src/runtime/platform.ts`, `packages/server-core/src/runtime/platform-headless.ts`

**Session tools:**
- Purpose: single definition consumed by the in-process runtime and the bundled MCP server
- Examples: `packages/session-tools-core/src/tool-defs.ts`, `packages/session-mcp-server/src/index.ts`

## Entry Points

**Electron main:**
- Location: `apps/electron/src/main/index.ts`
- Triggers: app launch
- Responsibilities: shell env, i18n, storage/server bootstrap, RPC handler registration, windows

**Renderer:**
- Location: `apps/electron/src/renderer/main.tsx` → `App.tsx`
- Triggers: window load

**Headless server:**
- Location: `packages/server/src/index.ts`
- Triggers: `nessy-server` / `bun run server:start`

**CLI:**
- Location: `apps/cli/src/index.ts`
- Triggers: `nessy-general-agent`

**Pi subprocess:**
- Location: `packages/pi-agent-server/src/index.ts`
- Triggers: spawned per session by the Pi backend

## Architectural Constraints

- **Threading:** single Node/Bun event loop per host; every runtime is a child process (Pi subprocess, `codex-app-server`), not a thread.
- **Global state:** module-scope singletons for config/credentials/i18n (`packages/shared/src/config`, `packages/shared/src/credentials`, `getCredentialManager`), plus `setSessionPlatform`/`setSearchPlatform`/`setFetcherPlatform` injection setters called once at bootstrap. Tests mutate `process.env.NESSY_CONFIG_DIR` at module scope — concurrent `bun test` runs manufacture failures.
- **Feature flags are build-time:** `packages/shared/src/feature-flags.ts` is mirrored in five build scripts; the Claude flags OR into `isAnthropicBackendEnabled()`.
- **Gateway scoping:** `Nestor-Token` rewriting is only allowed on the verified gateway URL prefix; `~/.nessy/dp_auth_creds.json` has exactly one writer (`packages/shared/src/auth/dp`) and is read-only elsewhere.
- **Locality:** remote clients get a reduced permission-mode ceiling; enforcement lives server-side, not in the client picker.
- **Size:** `packages/server-core/src/sessions/SessionManager.ts` is ~22 000 lines — the single largest coupling point in the repo.

## Anti-Patterns

### Adding a runtime branch inside SessionManager

**What happens:** runtime-specific behavior is added with an `if (providerType === …)` in `SessionManager.ts`.
**Why it's wrong:** it grows the 22k-line god object and skips the backend contract every other runtime honors.
**Do this instead:** implement it behind `AgentBackend` in `packages/shared/src/agent/backend/` and let `factory.ts` select it.

### Inventing a channel string at the call site

**What happens:** an RPC name is typed as a literal in a handler or client.
**Why it's wrong:** the string values are the stable wire contract shared with the CLI and iOS client; a literal drifts silently.
**Do this instead:** add it to `packages/shared/src/protocol/channels.ts` and reference `RPC_CHANNELS`.

### Client-side-only gating of a privileged action

**What happens:** a control is hidden in the renderer to prevent a remote client from using it.
**Why it's wrong:** the client is the replaceable piece; hiding is a suggestion.
**Do this instead:** enforce in the handler (`packages/server-core/src/handlers/rpc/sessions.ts` `setPermissionMode` is the reference) and let the UI merely mirror it.

### Writing `dp_auth_creds.json` from a new module

**What happens:** a feature persists gateway auth itself.
**Why it's wrong:** the file is nessy-cli's shared contract; a non-merging write drops unknown keys and its 0600 mode.
**Do this instead:** go through `packages/shared/src/auth/dp`.

### Deriving a foreign format empirically

**What happens:** a plugin/hook field is inferred from observed data.
**Why it's wrong:** two production bugs came from exactly this (`Task`→`Agent`, `lsp`→`lspServers`).
**Do this instead:** cite the Claude/Codex doc page and diff the component tables against the adapter constants.

## Error Handling

**Strategy:** typed errors at boundaries, mapped into user-facing state rather than thrown across the wire.

**Patterns:**
- Named error classes with a `code` (`WorkspaceRoutingError` in `apps/electron/src/transport/routed-client.ts`, `HeadlessStorageReadinessError`, `ManagedSettingsStartupError`).
- SDK errors normalized per runtime (`packages/shared/src/agent/claude-sdk-error-mapper.ts`, `packages/shared/src/agent/errors.ts`, `packages/codex-responses-adapter/src/errors.ts`).
- Retry with explicit, surfaced status for gateway 429s (`packages/codex-responses-adapter/src/retry.ts`, `packages/pi-agent-server/src/gateway-retry-settings.ts`).

## Cross-Cutting Concerns

**Logging:** `apps/electron/src/main/logger.ts` (electron-log) on the desktop; `packages/shared/src/utils/debug.ts` `enableDebug` / `NESSY_DEBUG` elsewhere.
**Validation:** `packages/shared/src/validation`, `packages/session-tools-core/src/validation.ts`, config validators in `packages/shared/src/agent/core/config-validator.ts`.
**Authentication:** bearer token on the RPC transport (`NESSY_SERVER_TOKEN`), provider credentials via `packages/shared/src/credentials`, gateway JWT via `packages/shared/src/auth/dp`.
**i18n:** `packages/shared/src/i18n`, parity/sorted lint gates over all locale files.

---

*Architecture analysis: 2026-08-16*
