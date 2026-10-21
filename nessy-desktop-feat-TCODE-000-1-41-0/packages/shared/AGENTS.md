# AGENTS.md — `@nessy-agent/shared`

## Purpose
Core business logic package for Nessy Desktop:
- Agent backends and session-scoped tools
- Sources, credentials, sessions, and config
- Permission modes and validation

## Key folders
- `src/agent/` — `claude-agent.ts`, `pi-agent.ts`, `base-agent.ts`, tools, permissions
- `src/sources/` — source storage/types/services
- `src/sessions/` — session persistence/index
- `src/projects/` — workspace-scoped projects (config + assets); sessions bind via `projectId` (v0.13.4 `packages/shared/CLAUDE.md`)
- `src/pages/` — workspace-scoped pages: per-`{slug}` storage, refresh, share bundle, data store, and the `PageActionBroker` action bridge (v0.13.4 `packages/shared/CLAUDE.md`, adapted)
- `src/tasks/` — the board task SPEC core, ours since UA3.2: `task.yaml` schema/roundtrip, slug, validation, folder storage
- `src/config/` — config/preferences/theme/watcher
- `src/credentials/` — encrypted credential management

## Commands
From repo root:
```bash
bun run typecheck:shared
bun run test:shared:all
```

## Hard rules
- Permission modes are fixed and are exactly Claude Code's six (since F1.1050,
  2026-09-29): `dontAsk`, `plan`, `default`, `acceptEdits`, `auto`,
  `bypassPermissions`. Nessy's own `explore` is retired: a stored or sent
  `explore` (and its older `safe`) is read as `plan` forever and never written.
  Legacy spellings (`explore`, `safe`, `ask`, `allow-all`, `execute`, `manual`, …) are
  PERMANENT read-path aliases via the one table in `src/agent/mode-types.ts` —
  never remove one. `PERMISSION_MODE_ORDER` lists the modes least-to-most
  permissive and is the index `clampPermissionModeToParent` uses to bound a
  subagent — a wrong position there is a silent widening.
- Source types are fixed: `mcp`, `api`, `local`.
- Keep credential handling in `src/credentials/` pathways (no ad-hoc secret storage).
- Keep user-facing tool contracts backward-compatible where possible.

## Notes
- `ClaudeAgent` is the primary class in `src/agent/claude-agent.ts`.
- Claude SDK subprocess env is sanitized to strip every Claude-specific cloud-provider routing var — the single source of truth is `src/config/claude-provider-routing-env.ts`, and since P3.113 the two strip sites iterate its UNION `CLAUDE_SDK_STRIPPED_ENV_KEYS`, not `CLAUDE_CLOUD_PROVIDER_ROUTING_ENV_KEYS` alone: the union adds `CLAUDE_FIRST_PARTY_ASSUMPTION_ENV_KEYS`, the single non-provider name `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL` (a boolean despite its suffix), which makes the child treat our loopback gateway adapter as `api.anthropic.com` and thereby turns on Anthropic error reporting, first-party request-correlation headers and capability assumptions the gateway cannot honour — it is kept in its OWN constant because the SDK-array guard beside the file must not be asked for a name that array never had. A THIRD list, `CLAUDE_LAUNCHER_ENV_KEYS`, is scrubbed from the CHILD env only and with a `debug()` diagnostic naming the variable, because dropping an administrator's deliberate launcher setting silently would be the same one-runtime divergence with the sign flipped (P3.300; the all-three seam is P6.9). Its membership rule is one question — *does this name decide WHICH PROCESS actually runs the agent's shell command, on claude alone?* — so P6.587 added `CLAUDE_CODE_SHELL` (the interpreter override) beside the prefix and the wrapper argv; the names are not restated here for the same reason the toggles are not, ask the constant. The cloud-provider half is **every provider toggle the shipped SDK selects on** (`CLAUDE_PROVIDER_SELECTION_TOGGLE_ENV_KEYS`), plus the documented credential/endpoint names that are ALSO companions (`CLAUDE_PROVIDER_ENDPOINT_CREDENTIAL_ENV_KEYS`) — measured in the native binary 2026-08-28, every skip-auth flag and every base URL is read only after a toggle has already selected its provider, so the "route on their own" this line used to claim is false; they are in the list because they are the ones the pages document and R40 shipped them (reason recorded in the constant's header, P3.112). Do not restate the toggle names anywhere, and do not restate the sizes either — this line said "SEVEN … plus four" until 2026-09-01, and a size is the same drift the names are: ask the constant, which now exports both halves (`bun -e "const m=await import('./packages/shared/src/config/claude-provider-routing-env.ts');console.log(m.CLAUDE_PROVIDER_SELECTION_TOGGLE_ENV_KEYS.length,m.CLAUDE_PROVIDER_ENDPOINT_CREDENTIAL_ENV_KEYS.length,m.CLAUDE_CLOUD_PROVIDER_ROUTING_ENV_KEYS.length)"`). The list said five for a month while the SDK had seven, and the two missing ones (`CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD`, `CLAUDE_CODE_USE_GATEWAY`) are in **zero** of the 191 published doc pages, so a doc-derived list is structurally blind to them (citations for the documented five: authentication.md § Authentication precedence tier 1, amazon-bedrock.md § Mantle environment variables; the other two are vendored-source-only — `Mn()`/`Pba()` in the SDK's native binary). Provider-input companions (`ANTHROPIC_VERTEX_PROJECT_ID`, `ANTHROPIC_GOOGLE_CLOUD_*`, `CLOUD_ML_REGION`, …) are deliberately NOT stripped: with every toggle gone they are unreachable. Extend the constant, not a call site; `config/__tests__/claude-provider-routing-env.test.ts` reads the SDK's own array and fails on an eighth toggle. `ClaudeAgent.postInit` additionally deletes ambient `ANTHROPIC_AUTH_TOKEN` (precedence tier 2, above the tier-3 `ANTHROPIC_API_KEY` it writes). Generic `AWS_*` stays untouched; Pi Bedrock uses its own AWS env path instead.
- Legacy branded aliases were removed during the Nessy rename.
- Prefer routing new model vendors through the existing Pi path (`providerType: 'pi'` + `piAuthProvider`) unless they truly need a distinct runtime/backend. The Pi provider catalog and display metadata live in `src/config/models-pi.ts`.
- Custom endpoint model capabilities must preserve explicit per-model overrides end-to-end. In particular, `supportsImages: true` enables image input for one model and `supportsImages: false` must remain available to override a global endpoint image default. Active Pi custom-endpoint sessions refresh runtime capabilities via `updateRuntimeConfig`; capability changes are pushed proactively from the `llmConnections.SAVE` handler through `SessionManager.refreshConnectionRuntime`, with the lazy `getOrCreateAgent` path acting as a backstop. The session layer still gates image attachments at send time so disabled images are not sent even if a subprocess refresh fails.
- `update_runtime_config` IPC carries `model, miniModel, providerType, authType, baseUrl, customEndpoint, customModels` only (`miniModel` since UB12.11: the refresh re-resolves it, so a rotated gateway `fast` id reaches a live Pi) — `piAuthProvider`, `slug`, and the broader credential/provider routing state cannot be re-routed inside a live Pi subprocess. `runtime-config.ts:buildRestartRequiredSignature` hashes those fields separately from the in-place-safe ones; when the restart signature drifts, `tryRefreshAgentRuntime` skips the in-place attempt and goes straight to dispose + recreate so the new auth/provider state actually takes effect.
- Session lifecycle distinguishes **hard aborts** from **UI handoff interrupts**:
  - use hard aborts for true teardown — the session is meant to end (redirect
    fallback, capability revoke, internal error, `abort()`/`destroy()`)
  - **This list named `close()` until P2.378 and there is no such entry point.**
    P2.362 deleted `ClaudeAgent.close()` in `a56252134` after proving it sat on
    no interface, was the only `close()` on any backend, and had zero callers.
    The line stayed, which is the shape that sends the next reader belting a
    method that is not there — the same class as the stale comments this fork
    keeps finding. Re-measured 2026-09-03 (P2.378): of the five backends
    (`base-agent.ts`, `claude-agent.ts`, `codex-agent.ts`, `pi-agent.ts`,
    `nestor-cloud-agent.ts`) all five declare `abort()`, three declare
    `destroy()` (`base-agent.ts`, `claude-agent.ts`, `pi-agent.ts` — codex and
    the cloud agent do not), and **none declares `close()`**. Two `close()`
    methods do exist under
    `agent/backend/` — `claude/turn-slot.ts` (a turn slot) and
    `codex/session-callback-bridge.ts` (a bridge interface) — and neither is a
    session-lifecycle entry point. **The check to run rather than to trust: a
    `close()` on any of those five classes makes this line wrong again.**
  - use handoff interrupts for pause points where control moves to the UI
    (`AuthRequest`, `PlanSubmitted`)
  - **`UserStop` moved from the first bullet to the second on 2026-08-17, and on
    the Claude backend it is now an interrupt.** This rule used to read "use hard
    aborts for true cancellation/teardown (`UserStop`, …)", which was right while
    a Claude turn was a whole process: the SDK registers `() => this.close()` as
    its abort handler and `close()` ends stdin then SIGTERMs, and the process was
    dying anyway because a STRING prompt makes the transport end input at the
    first result. It is wrong under one `query()` per agent, where the same call
    kills the conversation. `Query.interrupt()` is the turn-scoped cancel —
    documented "Only available in streaming input mode", with its receipt
    arriving before the interrupted turn's `SDKResultMessage`, so the turn
    settles on a normal terminal event and the child is untouched.
    `ClaudeAgent.forceAbort` therefore DISPATCHES ON THE REASON rather than
    always killing: `UserStop` and `MaxBudgetUsd` interrupt, `SourceActivated`
    respawns deliberately, everything else is still session death. **The
    parenthetical here used to read "its MCP server set is a construction option
    with no live equivalent" — that is false** (`Query.setMcpServers` is one; see
    the live-settings bullet below). The respawn stays for a different reason,
    written out on `endTurnForSourceActivation`, and L4 additionally MEASURED
    that the interrupt on that path never fires: every caller closes the slot on
    the line above, and `interruptLiveTurn` returns at `slot.settled`. Two
    obligations ride with the dispatch, and both were holes:
    an interrupted result must reach `BaseAgent.chat`'s pass loop carrying a
    `terminalReason`, or the loop HOLDS IT BACK AND CONTINUES — i.e. resumes the
    turn the user just stopped; and the interrupt path must perform
    `cancelPendingPermissions()` and `modelQuestionAsk.cancelAll(…)`, which no
    turn-end or Stop path did before, or a Stop leaves a permission card on
    screen holding a promise nobody will resolve.
- **One `query()` per Claude agent, and it outlives the turn.** `chatImpl` no
  longer iterates the SDK stream: `ClaudeAgent` owns one long-lived reader over
  `currentQuery`, and `chatImpl` opens a per-turn SLOT
  (`backend/claude/turn-slot.ts`) that the reader feeds and the turn drains.
  `SessionManager.sendMessage` is UNCHANGED — it still returns on `complete` and
  still calls `chatIterator.return?.()`, and that stops mattering because
  `.return()` now abandons a queue instead of unwinding the SDK stream. Keeping
  the whole change on this side of the frozen `AgentInstance.chat()` contract is
  what leaves Pi, Codex and Nestor untouched. Consequences to respect:
  - `currentQuery` is SESSION-scoped. Do not null it per turn, and do not read it
    as "a turn is running" — `isProcessing()` is the open slot.
  - **MOST `Options` fields are construction options, and a drifted one
    RESPAWNS.** `claudeLiveSessionSignature` is the whitelist that decides; the
    resume anchor is compared separately, against the session id the live stream
    reported, because hashing it would respawn on turn two of every session.
  - **THREE are not, and the rule that said otherwise was wrong.** This bullet
    read "the SDK has exactly three live setters: `setModel`,
    `setPermissionMode`, `supportedCommands`". `Query` in
    `@anthropic-ai/claude-agent-sdk@0.3.218` declares 27 methods,
    `supportedCommands` is a GETTER, and the setter that claim omitted —
    `setMcpServers` — is the one whose absence was used to justify respawning on
    every source change. `model`, `permissionMode` and the `mcpServers` NAME SET
    are therefore reconciled onto the running child by
    `ClaudeAgent.applyLiveSettings`, and are NOT hashed into the signature.
    Rules for that path:
    - **Every failure degrades to the respawn the signature used to force.** A
      missing setter, a CLI refusal, an incomplete result and a control channel
      that never answers all return `false`, and `ensureLiveSession` rebuilds.
      Keep it that way — the fallback is what makes the whole thing safe.
    - **`setMcpServers` resolves rather than throws on a connect failure**
      (`{added, removed, errors}`), so the RESULT is checked against what was
      asked for. An un-thrown call is not evidence.
    - **`allowDangerouslySkipPermissions` stays in the signature**, so entering
      or leaving `bypassPermissions` still respawns. It is a spawn-time CLI flag
      and the CLI refuses the live transition by name: "Cannot set permission
      mode to bypassPermissions because the session was not launched with
      --dangerously-skip-permissions".
    - **The permission mode is read back OFF THE OPTIONS**, already translated by
      `buildClaudePermissionModeOptions`. Do not re-derive it here — `plan`
      maps to SDK `default`, not SDK `plan`, and a second mapping is how the two drift apart.
    - **`thinking` and `effort` are still hashed AND are derived from the model**; `maxThinkingTokens` is hashed only
      through `sdkThinkingConfig` (`backend/claude/live-session.ts`, F1.802), the SDK's own fold of it into `thinking`,
      so both spellings of "off" are one value. A model switch is live only while that folded shape is unchanged:
      non-Haiku Claude ↔ non-Haiku Claude is live; crossing into Haiku or out of the Claude family respawns. Their only
      live setter is the deprecated `setMaxThinkingTokens`, which cannot express `effort` — bar F1.821: an `effort` moved only by the model's reported-level clamp goes live through `applyFlagSettings` (`claudeEffortClampDrift`).
    - **`cwd`, `systemPrompt`, `tools`, `agents` and our SDK-callback `hooks`
      have NO setter** and must not be promised one. That is asserted
      mechanically against the installed `sdk.d.ts` in
      `__tests__/claude-live-settings.test.ts`, because the hand-written version
      of this claim rotted silently once already.
  - per-turn state belongs on the SLOT, never on the agent: the reader is shared
    and a compaction drain nests a whole `chatImpl` inside the outer one.
  - never start a turn from inside the reader's own loop — the reader would be
    waiting on a turn whose events only the reader can deliver.
  - **PER-PROCESS state on the EVENT ADAPTER is a third category, and it is the
    one with no natural home.** `ClaudeEventAdapter` is an agent field, so it
    survives every respawn `ensureLiveSession` performs — a drifted construction
    option, L4's fall-through when a live setter is missing/refused/unanswered,
    a source activation, the turn after L3's reaper. State that is neither
    per-turn (reset by `startTurn()`) nor per-session (correct to keep) but
    per-CHILD leaks across those respawns, and before L2 nothing could: a turn
    was a process and a process got a fresh adapter. Most such state self-heals
    because `system/init` arrives per turn and re-seeds it (`_sdkTools`,
    `_sdkSlashCommands`); the ones that do NOT are the LEVEL signals, whose own
    contracts say they emit nothing at startup. `background_tasks_changed` is
    one, and `resetBackgroundTaskLevel()` is called from the spawn line of
    `ensureLiveSession` for exactly that reason. **If you add a level-semantics
    handler, reset it there too** — and reset it audibly when the user has
    already been told the thing it tracked exists, because a restart is a LOSS
    and not a completion.
- Remote workspace handoff summaries are injected as one-shot hidden context on the destination session's first turn.
- Automations matching is unified through canonical matcher adapters in `src/automations/utils.ts` (`matcherMatches*`). Avoid direct primitive-only matcher checks in feature code so condition gating stays consistent across app and agent events.
- The OpenAI Chat Completions strip stream (`unified-network-interceptor.ts:createOpenAiSseStrippingStream`) emits **one consolidated SSE event per logical tool call** with `id + name + cleanArgs` together — never split across init + args-only deltas. Some downstream SDKs (Pi SDK) treat args-only deltas as new tool_calls instead of merging by index, which produces duplicate empty-id entries on parallel-tool turns from DeepSeek and other relays. `sanitizeOpenAiHistoryInPlace` recovers sessions whose history was persisted by the pre-fix split-emit version.
- `LlmConnection.midStreamBehavior` controls whether mid-stream user sends try to steer the in-flight turn or hold for the next turn. Default is per-`providerType` via `defaultMidStreamBehavior()` — `'queue'` for `nestor-cloud-agent` and `'steer'` for every other providerType, `claude-runtime` included. **Read everywhere via `resolveMidStreamBehavior(connection)`** — never branch on `providerType` directly for this decision; legacy connections without the field rely on the resolver's fallback. New connections persist the explicit default at `createBuiltInConnection` time so the Settings → AI submenu shows a checkmark on first load. The decision is made in `SessionManager.sendMessage`'s mid-stream branch only — backend code (`claude-agent.ts`, `pi-agent.ts`) is unchanged: `'queue'` mode skips `agent.redirect()` entirely and lets the current turn finish before replay.
- The network interceptor (`unified-network-interceptor.ts`) is currently **Pi-only**: it preloads into the Pi subprocess via Bun `--preload`. The Claude SDK no longer runs under Bun (since 0.2.113 it spawns a per-platform native `claude` binary), so `--preload` is not available there. Features that used to live in the interceptor for Claude (rich tool intent, fast-mode override, MalformedBodyError validation, etc.) are Phase-2 work — they'll need to move to SDK hooks or a local proxy. In dev / monorepo runs, the Pi interceptor still preloads from the .ts source so changes propagate without a rebuild; packaged builds use `apps/electron/dist/interceptor.cjs`. See `agent/backend/internal/runtime-resolver.ts:resolveInterceptorBundlePath`. The headless server distribution ships the same bundle at `<dist>/dist/interceptor.cjs` — the same app-root-relative layout, so the resolver finds it unchanged — and `bin/nessy-server` additionally `--preload`s it into the server's own process. **That last preload is why "Pi-only" describes the PRELOAD SITE and not the traffic: a `claude-runtime` session's `anthropic-messages` passthrough hop is forwarded by that server process's own patched `fetch`, so on the headless distribution the interceptor meets claude requests too** (C3.158, 2026-09-11; `packages/shared/src/agent/__tests__/claude-child-cache-ttl-and-marketplace.test.ts` pins the agreement between that rewrite and the child's own env, both reading `packages/shared/src/interceptor-common.ts` symbol `resolvePromptCacheTtl`). The repo-root `bunfig.toml` preload only ever covered `bun run` **inside the repo** (bunfig is resolved from the CWD, never from the script path), so a distribution that does not carry its own copy runs unpatched. `scripts/build/interceptor-pairing.ts:verifyInterceptorPairing` fails the server build if either half goes missing.
- Per-message context is split into **volatile** vs **stable** blocks (`PromptBuilder.buildVolatileContextParts()` / `buildStableContextParts()`, composed by `buildContextParts()`). Volatile = date/time, `session_state`, `sources`, and project context file content (change per turn); stable = workspace capabilities, working directory (invariant per session). The project-context-file block is the legacy route only: `buildVolatileContextParts` skips it whenever the capability runtime is active, which is every normal send, and instruction/memory layers ride `BaseAgent.buildPinnedCapabilityContext()` instead — composed once per capability generation, not once per turn. **Claude** keeps all blocks on the user-message tail (system prompt stays cacheable). **Pi** folds only stable blocks into the system prefix and routes volatile blocks to the user tail — otherwise a per-minute re-stamp invalidates pi-ai's cached system prefix and all downstream history (#862). `buildVolatileContextParts` consumes the one-shot mode-change signal (`consumeModeChangeUserSignal`), so call it **exactly once per turn** — never re-invoke a builder to compute a cache-debug hash (hash the produced string instead).
- `prompts/system.ts:getNessyAssistantPrompt()` owns static safety and engineering guidance via `getSafetyAndEngineeringSections()`; keep new cache-invariant safety/tool-routing prose there, and route per-turn facts through `PromptBuilder`. That block is bullet-tagged: a bullet marked `coding: true` is built-in software-engineering guidance an output style with `keep-coding-instructions: false` subtracts, and every untagged bullet is safety/identity/irreversible-action guidance no style can remove. Tag new bullets deliberately — an untagged coding bullet survives a style that was supposed to replace it, and a tagged safety bullet disappears with one.
- Anthropic OAuth identity (account/org) is captured from the token-exchange response in `auth/claude-oauth.ts` (`parseClaudeOAuthIdentity`; fields are optional/fail-soft, never block login) and persisted on `LlmConnection` (`oauthAccountUuid/Email`, `oauthOrganizationUuid/Name`, `oauthProfileVerifiedAt`) by threading it through the `SETUP_LLM_CONNECTION` payload (`oauthIdentity`), **not** the EXCHANGE handler — the connection record is created by SETUP, which runs after the exchange. `updateLlmConnection` rebuilds connections from a hardcoded allowlist, so any new persisted field must be added there too or it is dropped on the next save (#838).
- **Nessy Gateway one-click auth (`src/auth/dp/`).** `ensureNessyGatewayAuth()`
  is the single facade both gateway cards call: env bypass (`NESSY_DP_AUTH_TOKEN`,
  headless/CI) → cached creds → system `dp` (`resolveDpBinary()` — the ONLY seam
  that knows where dp lives; NO downloader per frozen decision, missing dp = hard
  error) → `dp auth print-token`/`login` → exchange at `/api/v2/token` → decode
  JWT → `saveCreds`. It is the **only writer** of `~/.nessy/dp_auth_creds.json`
  (shared with nessy-cli; shape is nessy-cli's contract — merge-preserve unknown
  keys, atomic write, mode 0600). Token values (dp token or JWT) NEVER go to
  logs, errors, or status payloads — statuses carry codes only.
- **Always-on thinking (every Fable and Mythos model, Opus 5.5, Sonnet 5.5).** These models have adaptive thinking **always on** and the Messages API **rejects `thinking: { type: 'disabled' }`** with a 400 (Opus 5, Sonnet 5, the 4.x models and Haiku still accept it — the per-model table of `platform.claude.com/docs/en/build-with-claude/thinking.md`). `resolveClaudeThinkingOptions` therefore detects them via `isAdaptiveThinkingAlwaysOnModel()` (`config/models.ts`) and maps the "off"/`minimizeThinking` case to `{ thinking: { type: 'adaptive' }, effort: 'low' }` instead of `disabled` — there is no way to turn thinking off on these models. `runMiniCompletion` applies the same rule (F1.1214): its mini model is the connection's choice, not always Haiku. Model id is the dateless pinned snapshot `claude-fable-5` (1M context, 128k max output); registered in `MODEL_REGISTRY`.
- **Reserved "Task" labels** (UA1.6; v0.13.4 `packages/shared/CLAUDE.md`, Apache-2.0). Task flows tag each task's whole family (orchestrator + subtasks) with a per-task ITEM label — a child of the plain root `Task` label, named `TASK-<slug>-<N>` (no valueType; N = max counter across the root's TASK-named children + 1, never recycled — unrelated children of an adopted user root don't feed it). Mint/inherit only via `SessionManager.applyTaskLabel` (which uses `ensureTaskLabel`/`ensureTaskItemLabel` in `labels/crud.ts`); resolve only via `findTaskLabel` / `findTaskItemLabelId` / `resolveTaskScopeLabelId` (`labels/filter.ts`). Never assume literal ids — slugs collide-shift, so always use the id `applyTaskLabel` returns. Legacy `task::N` valued entries still filter under the root; `ensureTaskLabel` converges a legacy `valueType: 'number'` root to a plain label but adopts a user's own root "Task" label as-is (shape + children untouched).
- **Single label-filter predicate.** `matchesLabelFilter` (`labels/filter.ts`, browser-safe) is the only implementation of "session matches a label filter" (descendants, `__all__`, optional `projectId` scope). The session list (`useSessionSearch`), the NavigationContext auto-select (F1.353), the sidebar label counts (`lib/label-session-counts.ts`, F1.357) and AppShell's primary `'label'` filter (UA12.13) route through it; AppShell's secondary label-chip filter expands ids through `expandLabelFilterIds` (`task-scope-filters.ts`, UA12.154), which deliberately differs for a deleted label (it matches nothing) and is the only other expansion — do not hand-roll label matching in new feature code.
- **Task creation is a shared core** (UA3.4; v0.13.4 `packages/shared/CLAUDE.md`, Apache-2.0, adapted). `createTaskFromSpec` / `finishTaskOrchestrator` (`packages/server-core/src/tasks/create-task.ts`) implement "create the task on the board without running it" (task.yaml + orchestrator session + the reserved Task label + spec sources, fail-soft on label/sources). The `tasks:create` RPC (fresh path) calls it, and so does the agent-facing `create_board_task` tool, through `createBoardTaskForCaller` (`packages/server-core/src/tasks/create-board-task.ts`, UA3.5), which adds the restrictions on the invoking agent (its own folder, project, enabled sources and connection; no mode) — never re-implement the flow. Two NESSY guards sit beside it and every create path runs them BEFORE anything is saved: `assertTaskSlugFree` (create mode never overwrites another task: `task-slug-taken:<slug>`, unless the attach/adopt target already carries that slug) and `resolveTaskFolderHandle` (a folder enters only as a TRUSTED project handle — `spec.cwd` through `validateProjectDirectory`, the editor's `projectHandleId` through `resolveHandle` — else `task-cwd-untrusted`). Attach/adopt (`SessionManager.bindExistingSessionToTask` / `adoptGeneratedTaskOrchestrator`) never move a folder, never raise a mode, and never switch the runtime of a session with messages (`task-attach-connection-locked`). The agent tool derives its slug via `uniqueTaskSlug` (`shared/tasks/slug.ts`; the editor keeps a byte-identical `slugify` copy because the `./tasks` barrel pulls Node fs code). Running remains exclusively `tasks:run` / the Conductor (UA4.x). `tasks:run` requires the task's own orchestrator, and a run resumes from its own spec snapshot and recorded params, never the live `task.yaml` (`TaskRunner` header item 13, UA4.3). Task folders are removed only by `deleteTaskFolder` (`shared/tasks/storage.ts`, UA3.8): `tasks:delete` and the orchestrator delete cascade (`SessionManager.deleteSession`, rule `taskFolderDeletedWith` in `server-core/src/tasks/orchestrator-folder.ts`, also read by the delete dialog). Archiving never removes a folder.
- **Page tools** (UA6.3): the six page tools resolve ONE grouped host closure — the registry slot `pages`, bound by `SessionManager.pagesToolCallbacksForAgent` (`server-core/src/pages/tool-callbacks.ts`) — in process on Pi and Claude and over the six `/page/*` host-callback routes on codex; the tool types live in `session-tools-core/src/context.ts`. Never re-implement page storage or the delete card in a runtime.
- **Page publishing** (UA6.7): a page is published only through `server-core/src/pages/page-publishing.ts`. That module runs the ONE `runArtifactPublish` chain with the page bundle (`pages/share-bundle.ts`) as its source. A page's publication lives in the workspace artifact registry (a `'page'` row with the `page` facet), never in page.json. Read it through `LoadedPage.publication` or `findPageRegistryEntry`. Never add a second publish path for page bytes.
- **Page action bridge** (UA9.2; v0.13.4 `packages/shared/CLAUDE.md` L52, Apache-2.0, adapted). Page JS never calls sources — `PageActionBroker` (`pages/action-bridge.ts`) validates render leases (nonce + content digest of the page's BYTES + replay cache) and grants read from the host-approvals ledger on every invocation (`page-grant` entries, MAC-verified, content-digest-bound and expiring; never `page.json`), executes via injected executors under AbortSignal, and audit-logs every decision to `{CONFIG_DIR}/logs/page-actions.jsonl` (redacted via `utils/redaction.ts`). Write and read grants only through `pageGrantRecord` / `issuePageGrant` / `readPageGrant` / `listPageGrants` / `revokePageGrant`; a script grant pins the script's sha256 and runs only through `runApprovedScript` (`server-core/src/pages/script-executor-bridge.ts`), an MCP grant only through the workspace pool leased as `page:<slug>` (`server-core/src/pages/mcp-executor.ts`). Endpoint/tool policy lives in the freestanding `agent/source-policy.ts` (`evaluateApiEndpointPolicy` / `evaluateMcpToolPolicy`) — `shouldPromptInAskMode` delegates to it; use it for any non-hook policy check instead of re-implementing. Pass the API tool's own name (`api_<slug>`) to `evaluateApiEndpointPolicy`: a source's own `allowedApiEndpoints` reach only that tool (F1.1152), and a call naming no tool gets the workspace rules alone. `sources/api-tools.ts:executeApiRequest` is the API fetch path for page actions (supports `signal`/`timeoutMs`; never logs header or query values).

## i18n (Internationalization)

Translations live in `src/i18n/locales/{lang}.json`. All user-facing strings must use `t()` (React) or `i18n.t()` (non-React).

### Locale registry (single source of truth)

All locale metadata lives in **`src/i18n/registry.ts`**. To add a new locale:

1. Create `src/i18n/locales/{code}.json` with all keys (copy from `en.json`)
2. Import the messages and `date-fns` locale in `registry.ts`
3. Add one entry to `LOCALE_REGISTRY`

**That's it.** `SUPPORTED_LANGUAGE_CODES`, `LANGUAGES`, i18n resources, and `getDateLocale()` are all derived automatically. No other file needs to change.

### Key naming convention

Keys use **flat dot-notation** with a category prefix:

| Prefix | Scope | Example |
|--------|-------|---------|
| `common.*` | Shared labels (Cancel, Save, Close, Edit, Loading...) | `common.cancel` |
| `menu.*` | App menu items (File, Edit, View, Window) | `menu.toggleSidebar` |
| `sidebar.*` | Left sidebar navigation items | `sidebar.allSessions` |
| `sidebarMenu.*` | Sidebar context menu actions | `sidebarMenu.addSource` |
| `sessionMenu.*` | Session context menu actions | `sessionMenu.archive` |
| `settings.*` | Settings pages — nested by page ID | `settings.ai.connections` |
| `chat.*` | Chat input, session viewer, inline UI | `chat.attachFiles` |
| `toast.*` | Toast/notification messages | `toast.failedToShare` |
| `errors.*` | Error screens | `errors.sessionNotFound` |
| `onboarding.*` | Onboarding flow — nested by step | `onboarding.welcome.title` |
| `dialog.*` | Modal dialogs | `dialog.reset.title` |
| `apiSetup.*` | API connection setup | `apiSetup.modelTier.best` |
| `workspace.*` | Workspace creation/management | `workspace.createNew` |
| `sourceInfo.*` | Source detail page | `sourceInfo.documentation` |
| `skillInfo.*` | Skill detail page | `skillInfo.instructions` |
| `automations.*` | Automation list/detail/menus | `automations.runTest` |
| `sourcesList.*` | Sources list panel | `sourcesList.noSourcesConfigured` |
| `skillsList.*` | Skills list panel | `skillsList.addSkill` |
| `editPopover.*` | EditPopover labels/placeholders | `editPopover.label.addSource` |
| `status.*` | Session status names (by status ID) | `status.needs-review` |
| `mode.*` | Permission mode names (by mode ID) | `mode.safe` |
| `hints.*` | Empty state workflow suggestions | `hints.summarizeGmail` |
| `table.*` | Data table column headers | `table.access` |
| `time.*` | Relative time strings | `time.minutesAgo_other` |
| `session.*` | Session list UI | `session.noSessionsYet` |
| `shortcuts.*` | Keyboard shortcuts descriptions | `shortcuts.sendMessage` |
| `sendToWorkspace.*` | Send to workspace dialog | `sendToWorkspace.title` |
| `webui.*` | WebUI-specific strings | `webui.connectionFailed` |
| `auth.*` | Auth banner/prompts | `auth.connectionRequired` |
| `browser.*` | Browser empty state | `browser.readyTitle` |

### Rules

1. **Never call `i18n.t()` at module level** — store `labelKey` strings and resolve in components/functions.
2. **Use i18next pluralization** (`_one`/`_other`), never manual `count === 1 ?` logic. A family needs **both** forms in **every** locale, `en.json` included — one without the other is what `lint:i18n:parity` gates since P6.973, because a family incomplete *identically* in both locales has identical key sets and the key comparison cannot see it. Non-English locales add their own `_zero`/`_two`/`_few`/`_many` on top of that pair.
3. **Keep brand/provider names in English**: Nessy Desktop, Nessy Gateway, Claude, Anthropic, OpenAI, MCP, API, SDK.
4. **Include `...` in the translation value** if the UI needs an ellipsis — don't append it in JSX.
5. **Use `<Trans>` component** for translations containing HTML tags (e.g. `<strong>`).
6. **Use `i18n.resolvedLanguage`** (not `i18n.language`) when comparing against supported language codes.
7. **Keys must exist in all locale files** (`en.json`, `ru.json`, and any future locales). Keep alphabetically sorted.
8. **Watch translation length for constrained UI elements.** Translations can be 20-100%+ longer than English. For buttons, badges, tab labels, and dropdown items, keep translations concise — use shorter synonyms if needed. High-risk areas:
   - Permission mode badges (3-5 characters max)
   - Settings tab labels (≤10 characters ideal)
   - Button labels (avoid exceeding 2x the English length)
   - Menu items (flexible, but avoid 3x+ growth)

### Validation

Two root-level checks gate i18n correctness:

| Script | Catches |
|--------|---------|
| `lint:i18n:sorted` | locale keys not alphabetical |
| `lint:i18n:parity` | non-EN locale missing keys present in `en.json`, or vice versa; a plural family carrying `_one` and no `_other` (or the reverse) in ANY locale, `en.json` included |

`parity` alone is insufficient to prove every runtime callsite is covered, but
it prevents locale drift. Literal callsite coverage is not currently wired into
the root scripts; use runtime missing-key warnings and focused tests for dynamic
i18n-heavy changes.

When resolving locale merge conflicts, run `bun run lint:i18n:sorted` and
`bun run lint:i18n:parity` from the repo root and trust the result — no manual
key auditing needed if both pass.

### Adding a new translated string

1. Add the key + English value to `en.json` (alphabetical order)
2. Add the key + translated value to all other locale files (`ru.json`)
3. Use `t("your.key")` in the component (add `useTranslation()` hook if not present)
4. For non-React code, use `i18n.t("your.key")` — but only inside functions, never at module level

### Adding a new locale

1. Create `src/i18n/locales/{code}.json` with all keys from `en.json`
2. Add the entry to `LOCALE_REGISTRY` in `src/i18n/registry.ts` (messages + date-fns locale + native name)
3. Run tests — the registry tests will catch any missing wiring

### Cross-process language persistence

The main-process i18n instance has **no detection plugin** (no `localStorage` in Node) and would otherwise reset to `fallbackLng: 'en'` on every restart. To keep main + renderer in sync across launches:

- **Renderer** uses `i18next-browser-languagedetector` → `localStorage` (`i18nextLng`). Survives restart.
- **Main** hydrates on startup from `preferences.uiLanguage` in `~/.nessy-agent/preferences.json`. Maintained only by the `i18n:changeLanguage` IPC handler in `apps/electron/src/main/index.ts`.
- **Renderer → main sync** happens on every Appearance change AND once at renderer startup (so a freshly-installed app immediately learns the persisted language).
- The IPC handler validates the incoming code against `SUPPORTED_LANGUAGE_CODES` and `setPersistedUiLanguage()` no-ops if the value is unchanged — startup pushes don't churn the file or the config watcher.

`uiLanguage` is **not** user-editable through `update_user_preferences`. The Appearance dropdown is the only writer.

**Session-title language** resolves from this same persisted `uiLanguage` via `resolveTitleLanguageName()` (`config/preferences.ts`), **not** `i18n.resolvedLanguage`. The main-process i18n value hydrates asynchronously at startup and can still read the `'en'` fallback when an early title generates, which forced English titles for non-English chats (#885). When no language is persisted the helper returns `undefined`, so the title prompt auto-detects the conversation language instead of defaulting to English. Used at both `SessionManager` title sites (`generateTitle`, `refreshTitle`).

## Token refresh for API sources

API sources can auto-refresh tokens via two paths:
- **OAuth** — Google or generic OAuth (`authType: 'oauth'`)
- **Renew endpoint** — custom bearer-token APIs with `api.renewEndpoint` in config.json

For renew-endpoint sources, the current access token is sent to the configured endpoint and a new token is extracted from the response. No separate refresh token is needed (MVP scope).

Key integration points:
- `isRefreshableSource()` in `types.ts` — single guard for "can this source auto-refresh?"
- `SourceCredentialManager.refreshApiRenew()` — calls the renew endpoint
- `TokenRefreshManager` — treats renew-endpoint sources as refreshable even without `refreshToken`
- `server-builder.ts` — passes a token getter (not static credential) for renew-endpoint sources

## `queryLlm` backend contract

Every `AgentBackend.queryLlm(request: LLMQueryRequest)` implementation MUST:
- honor `request.model` (with backend-specific fallback only when the model is
  unresolvable/unsupported; always report the *effective* model in
  `LLMQueryResult.model`)
- honor `request.systemPrompt`

SHOULD:
- honor `request.outputSchema` (at minimum via prompt injection — see
  `buildCallLlmRequest` in `agent/llm-tool.ts`, which already handles this
  pre-backend)

MAY:
- honor `request.maxTokens` and `request.temperature` if the underlying SDK
  supports passing these to its generation call

MUST NOT:
- return a fabricated `LLMQueryResult.model` that doesn't match what was actually
  used — downstream UI treats this as authoritative

IPC envelopes between the main process and any subprocess backend (Pi today,
potentially others) MUST carry the full `LLMQueryRequest`, not a subset.
A backend that invents a narrower envelope is guaranteed to drift over time
(see #596). The round-trip invariant is guarded by
`packages/shared/src/agent/__tests__/pi-query-llm.test.ts`.

## Source of truth
- Package exports: `packages/shared/src/index.ts` and subpath export entries.
- Agent exports: `packages/shared/src/agent/index.ts`
