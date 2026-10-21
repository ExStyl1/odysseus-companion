# Claude SDK Runtime on Nessy Integrations — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the Claude Agent SDK as a user-selectable agent runtime (alongside Pi,
Codex, Nestor cloud) that runs on Nessy integrations: the built-in Nessy Gateway
(one-click dp auth, same endpoint as the Pi card) and bring-your-own keys to any
OpenAI-like endpoint — while the Claude Pro/Max subscription card stays behind its
existing flag, unchanged.

**Architecture:** The Claude Agent SDK speaks only the Anthropic Messages protocol
(`POST /v1/messages`, SSE) and officially supports endpoint override via
`ANTHROPIC_BASE_URL`. We add a `/v1/messages` facade to the existing
`packages/codex-responses-adapter` (localhost, ephemeral port) by vendoring two MIT
translation modules from opencodex, chained onto our existing Responses→Nestor-chat
pipeline. A new `claude-runtime` providerType mirrors `codex-runtime`: the driver
starts the adapter per session and injects `ANTHROPIC_BASE_URL` through the existing
`envOverrides` seam.

**Tech Stack:** TypeScript/Bun monorepo; `@anthropic-ai/claude-agent-sdk` (already a
dependency; native binary bundled conditionally); vendored opencodex `claude/inbound.ts`
+ `claude/outbound.ts` (MIT); existing `codex-responses-adapter` pipeline
(`to-chat.ts`, `from-chat-stream.ts`, `retry.ts`, `sanitize.ts`, `nestor-auth.ts`).

## Where this came from

Two multi-agent research passes on 2026-08-04 (workflow runs `wf_85ad5c8d-22a`,
`wf_5da29d94-34b`): official Claude Code gateway docs, community practice, license
review, repo scout, opencodex source scan, OSS adapter survey. Key contract facts
(Claude Code docs are a contract source per AGENTS.md — quoted sentences, not line
numbers):

- "`ANTHROPIC_BASE_URL` | Override the API endpoint to route requests through a proxy
  or gateway." — https://code.claude.com/docs/en/env-vars.md
- "Inference requests post to `/v1/messages?beta=true`, so match on the path, not the
  full URL." and "Inference responses must stream." —
  https://code.claude.com/docs/en/llm-gateway-protocol.md
- "Token-counting endpoints are the only optional ones: when they're absent, Claude
  Code estimates context usage locally." —
  https://code.claude.com/docs/en/llm-gateway-protocol.md
- "…behind an LLM gateway or a custom `ANTHROPIC_BASE_URL`, your provider or gateway
  defines the model names, so Claude Code passes any string through without checking
  it." — https://code.claude.com/docs/en/model-config.md
- "The Agent SDK has no gateway-specific options; it passes environment variables to
  the Claude Code process it spawns." —
  https://code.claude.com/docs/en/llm-gateway-connect.md
- Risk register: "Anthropic doesn't endorse, maintain, or audit other gateway
  products, and doesn't support routing Claude Code to non-Claude models through any
  gateway." — https://code.claude.com/docs/en/gateways.md. The mechanism is
  documented; non-Claude upstreams are unsupported territory. The adapter must absorb
  Claude-specific fields (`thinking: {"type":"adaptive"}` is sent even to unrecognized
  model names).

## Reuse manifest — what we take vs what we write

**Taken from the Claude Agent SDK (no work):** the whole runtime — agent loop,
built-in tools (Read/Edit/Bash/Glob/Grep/WebFetch/WebSearch), subagents, hooks,
permissions, sessions, compaction, MCP. Already integrated as `ClaudeAgent`
(`packages/shared/src/agent/claude-agent.ts`) with auth env resolution, per-session
`envOverrides`, `miniModel` override, `CLAUDE_CONFIG_DIR` isolation.

**Vendored from opencodex (`/Users/i.i.gavrikov/Desktop/work/opencodex`, MIT,
github.com/lidge-jun/opencodex, v2.7.17, HEAD 16bef04):**

| opencodex file | becomes | what it does |
|---|---|---|
| `src/claude/inbound.ts` (481 L) | `packages/codex-responses-adapter/src/anthropic/inbound.ts` | Anthropic Messages request → internal Responses body (system folding, tool_result→function_call_output, tool_use→function_call, tool_choice, thinking budget→effort) |
| `src/claude/outbound.ts` (564 L, zero imports) | `packages/codex-responses-adapter/src/anthropic/outbound.ts` | Responses SSE/JSON → Anthropic SSE/JSON (message_start/ping/content_block lifecycle, input_json_delta, thinking_delta, stop_reason mapping, usage, error taxonomy, fail-closed 502) |
| slices of `tests/claude-*.test.ts` (2877 L total) | `packages/codex-responses-adapter/src/__tests__/anthropic-*.test.ts` | adapted contract tests |

Verified compatible with our pipeline: `from-chat-stream.ts` emits exactly the
Responses SSE events `outbound.ts` consumes (`response.created`,
`response.output_item.added/done`, `response.output_text.delta`,
`response.reasoning_text.delta`, `response.function_call_arguments.delta`,
`response.completed`); `to-chat.ts` accepts exactly the items `inbound.ts` emits
(`instructions`, `message`, `function_call`, `function_call_output`).

**Reused from our own repo (no new code):** `to-chat.ts`, `from-chat-stream.ts`,
`retry.ts`, `sanitize.ts`, `errors.ts`, `nestor-auth.ts` (rotating dp JWT),
`ensureNessyGatewayAuth` one-click flow, `NESSY_GATEWAY_MODELS` preset,
`resolveAuthEnvVars`, connection templates/one-click machinery, model allowlist.

**Written by us (the only new code):**
1. `UpstreamTarget` parameterization of the adapter's outbound client (~60 L).
2. `/v1/messages` route glue in `server.ts` (~120 L).
3. `finish_reason: "length"` → `response.incomplete` emission in
   `from-chat-stream.ts` (~15 L).
4. `gatewayAdapter` lifecycle in `ClaudeAgent.postInit`/teardown (~60 L).
5. `claude-runtime` providerType plumbing + feature flag + card/template/i18n
   (mechanical, compile-time-exhaustive maps).

## Tracker

Status: ⬜ open · 🔄 in progress · ✅ done · ⏸ parked on an owner decision

| # | task | status | commit | dep | note |
|---|---|---|---|---|---|
| T0 | Bump `@anthropic-ai/claude-agent-sdk` 0.3.183 → 0.3.215 | ✅ | fc720b9b | | core peer aligned in follow-up + f55bdf63 |
| T1 | Vendor opencodex Anthropic translation modules + contract tests | ✅ | c588943d | | vendored @16bef04; ClaudeInboundTranslation narrowed to {body} (cacheKeySource stripped — T3 must not destructure it); outbound.ts needs DOM in tsconfig lib (T7/T8) |
| T2 | Parameterize adapter upstream target (nestor \| openai-compatible bearer) | ✅ | | | UpstreamTarget union extensible for anthropic-messages |
| T3 | `/v1/messages` route + length→max_tokens mapping | ✅ | | T1, T2 | serialize-reparse glue; incomplete emission matched to vendored consumer (`incomplete_details.reason: "max_output_tokens"`). Deviations: upstream status passes through (Anthropic clients key retry off 429/529); type-only fix inside vendored `outbound.ts` reader plumbing (final review 2026-08-05: 4 hunks vs upstream, two value-level but behavior-preserving — see `vendor/opencodex/UPSTREAM.md` re-sync warning) — importing it from `server.ts` pulled it into `packages/shared`'s typecheck, so T1's "needs DOM in tsconfig lib (T7/T8)" is resolved in-file instead; truncation frame gated per-route; max_output_tokens→max_tokens mapping added |
| T3b | Stream-integrity hardening vendored from opencodex | ✅ | | T3 | failed/incomplete/[DONE]/heartbeat to both routes; length stays gated; sequential-block invariant pinned; stall/EOF rewritten to failed on messages route; heartbeat now default on codex route (T8 smoke) |
| T4 | `claude-runtime` providerType plumbing | ✅ | | | maps mirrored from codex-runtime; agent provider anthropic; fetcher gated on isNestorConnection |
| T5 | Feature flag `NESSY_FEATURE_CLAUDE_RUNTIME` + build/bundling split | ✅ | | T4 | nessy_claude flag; backend gates claude\|\|claude_runtime; bundling either-flag across 5 build files |
| T6 | ClaudeAgent gateway-adapter lifecycle | ✅ | | T3, T4 | adapter lifecycle in postInit/teardown; validateStoredConnection choice: cheap structural check (no adapter spawn, no SDK probe), mirroring codexDriver. Upstream derived per-session from the connection by a driver-exported resolver — no `ClaudeAgentConfig.gatewayAdapter` field (see report §2); gateway match is the whole verified base URL, not the `…/cli/` prefix; oauth token neutralized; transfer-summary path postInits |
| T7 | Gateway card, one-click, template, models seed, i18n | ✅ | | T4, T5 | card + one-click + i18n; composer caps branch (reasoning capped at high, images per-model — `modelSupportsImages` had to learn `claude-runtime` or 'per-model' resolved to YES); test button routed structural via a new `anthropicDriver.testConnection` (declines → null for direct anthropic); refresh gated in `anthropicDriver.fetchModels` (stored catalog, no network — T5's gate marker row updated); fast model seeded LAST **and** resolved by gateway `fast` alias first, because the startup refresh reorders the catalog; switcher bucket + settings labels fixed |
| T8 | Packaged-build live smoke + full regression wave | ✅ | | T1–T7 | Smoke 13 ✅ / 2 ⚠️ / 0 ❗ on packaged 1.17.0 arm64 vs the live gateway (`CLR-1…15`, post-review). Heartbeat + `response.incomplete{upstream_stall_timeout}` + `[DONE]` read off the wire on the codex route; messages route ends `event: error`, never `message_stop`. ⚠️ `CLR-12` (product, → T9 hand-off): the SDK retries that error at +92/+268/+301 s and switches to `stream:false`, so a hard-stalled upstream shows `Responding…` for 14 min+; fix = `CLAUDE_CODE_MAX_RETRIES` in the claude env block. ⚠️ `CLR-10` (evidence): codex-app-server tolerance is INFERRED from a turn whose measured ttfb clears the 2 s threshold — no frame-level capture, because `codex-agent.ts` calls `startAdapter({})` and a codex session cannot be pointed at a slow endpoint until the BYO plan lands. `CLR-15` narrowed: the summary works cold, but whether it opens its own adapter was NOT measured (the port first cited was the app's websocket server). Images dropped silently on BOTH runtimes, no crash/400. `build-linux.sh` CLAUDE_ENABLED gate landed (parse + truth table; no Linux build on this machine). Default-flags dmg ships an EMPTY `claude-agent-sdk-binary/`. Regression: all gates green except 4 `bun test` failures, none this plan's — 3 fail at `e9fe8999` (between T0's two commits) and pass at the merge-base `master`, 1 flaky under load. NOT EXERCISED: none. |
| T9 | Close-out: version bump, release notes, docs-site, AGENTS.md flag table | ✅ | | T8 | `1.18.0` in both package.json files; new `release-notes/1.18.0.md`; docs-site gained a `Claude Code (Nessy Gateway)` section + `claude-runtime` providerType row + config example in **both** languages, plus the flag-gated card in introduction/installation; AGENTS.md flag table gained `NESSY_FEATURE_CLAUDE_RUNTIME` with the two-flag split spelled out and the `1`/`0`-only rule (Fastfile's `boolean_option` also takes `y`; the other four parsers do not); `build-dmg.sh` units reconciled to match `build-linux.sh` (stale "~210 MB" → ~247 MB at SDK 0.3.215, `MB` → `MiB` on both size echoes). **`CLR-12` stays open** — the retry-budget hand-off below is the durable record, not a to-do this task closed. Found in passing: `package.json`'s `check-version` script points at a `scripts/check-version.ts` that does not exist, so version lockstep has no gate. |

## Global Constraints

- Branch `feat/TCODE-000` (or assigned task number). One commit per task, message as
  specified in the task. No `Co-Authored-By` trailers. No MRs/tags during autonomous
  execution.
- **`~/.nessy/dp_auth_creds.json` is read-only** outside `packages/shared/src/auth/dp`
  (the adapter reads it via the existing `nestor-auth.ts`, precedent: codex).
- **Nestor-specific request rewriting stays scoped to the verified gateway URL
  prefix.** `Nestor-Token` is sent ONLY in `kind: 'nestor'` upstream mode; every other
  endpoint gets standard `Authorization: Bearer` semantics.
- Implementation-First Verification Budget applies: focused tests + affected-package
  typecheck per task; full repo gates only at T8.
- `bun run typecheck:all` does NOT cover `apps/cli` — run its typecheck separately at
  T8.
- No concurrent `bun test` processes. i18n: keys in ALL locale files, keep
  `lint:i18n:parity` / `lint:i18n:sorted` green (T7).
- Vendored files carry a provenance header (source repo, commit, MIT license) — the
  repo rule "record the source and license" is satisfied in-file plus the note in this
  plan; MIT permits copying with attribution.
- Do not modify `.references/`. Preserve GitLab/signing infra ownership boundaries
  (Fastfile edits in T5 are limited to mirroring the existing
  `NESSY_FEATURE_PROVIDER_CLAUDE` conditionals).
- **SDK version (verified 2026-08-04 against `artifactory…/npm/npm-all`; owner
  decision 2026-08-04: align on the latest Artifactory version):** this plan bumps
  `@anthropic-ai/claude-agent-sdk` from the current 0.3.183 pin to **0.3.215** — the
  latest Artifactory serves (0.3.216 appeared later the same day; the pin deliberately
  stays 0.3.215) (npmjs is ahead at ~0.3.221 — do NOT pin past what
  Artifactory serves). All eight platform binary packages (incl. two linux musl variants)
  `@anthropic-ai/claude-agent-sdk-{darwin,win32,linux}-{x64,arm64}` are present at the
  same 0.3.215, so the pin is safe for every packaged platform.
  `@anthropic-ai/claude-agent-sdk-binary` is a local install alias
  (runtime-resolver.ts:334), not a registry package — its absence from the registry is
  expected. The bump is T0 and is a dependency-lock **risk trigger** per the
  verification budget: expanded verification runs once on the final diff (T8).

---

### Task T0: Bump `@anthropic-ai/claude-agent-sdk` to 0.3.215

**Files:**
- Modify: `package.json` (~:133 — `"@anthropic-ai/claude-agent-sdk": "0.3.183"`)
- Modify: `packages/shared/package.json` (~:159 — same pin)
- Modify: `bun.lock` (via install, never by hand)

- [ ] **Step 1:** Change both pins to `0.3.215` (exact pin, no range — the platform
  binary packages must resolve at the identical version).
- [ ] **Step 2:** Run: `bun install` (updates the lockfile; the repo forbids registry
  bypasses — everything must come from the configured Artifactory `npm-all`). Then
  verify the platform binary resolved:
  `ls node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/ 2>/dev/null || rg -o "claude-agent-sdk-(darwin|win32|linux)-(x64|arm64)@0\.3\.215" bun.lock | sort -u`
  Expected: all six platform entries at `0.3.215`.
- [ ] **Step 3:** Breaking-change sweep — renames are this repo's recurring
  Claude-SDK failure mode (the `Task`→`Agent` tool rename shipped a production bug).
  Diff the SDK's exported option types between the two versions:
  `diff <(git show HEAD:bun.lock | rg -o 'claude-agent-sdk@[0-9.]+') <(rg -o 'claude-agent-sdk@[0-9.]+' bun.lock)` for the version proof, then compare
  `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` (or the package's types
  entry) against the call sites in `packages/shared/src/agent/claude-agent.ts` and
  `packages/shared/src/agent/options.ts` — every `Options` field we set must still
  exist (`env`, `model`, `pathToClaudeCodeExecutable`, permission/hook surfaces).
  Typecheck is the backstop: `bun run typecheck:all`.
- [ ] **Step 4:** Run the focused suites that exercise the SDK boundary:
  `bun run test:shared:all` (contains the claude-agent/event-adapter suites; check
  `docs/superpowers/specs/2026-07-29-known-failing-tests.md` before recording any new
  failure as caused by the bump).
- [ ] **Step 5:** Commit: `chore(deps): bump @anthropic-ai/claude-agent-sdk to 0.3.215 [T0]`

### Task T1: Vendor opencodex Anthropic translation modules

**Files:**
- Create: `packages/codex-responses-adapter/src/anthropic/inbound.ts`
  (from `/Users/i.i.gavrikov/Desktop/work/opencodex/src/claude/inbound.ts`)
- Create: `packages/codex-responses-adapter/src/anthropic/outbound.ts`
  (from `/Users/i.i.gavrikov/Desktop/work/opencodex/src/claude/outbound.ts`)
- Create: `packages/codex-responses-adapter/src/__tests__/anthropic-inbound.test.ts`
- Create: `packages/codex-responses-adapter/src/__tests__/anthropic-outbound.test.ts`

**Interfaces:**
- Produces (used by T3): `anthropicToResponsesTranslation(raw: unknown): ClaudeInboundTranslation`
  (from inbound.ts — keep the exported name), `responsesSseToAnthropicSse(...)`,
  `responsesJsonToAnthropicMessage(json: unknown, model: string)`,
  `collectAnthropicMessage(stream, model)`, `anthropicErrorBody(status, message, type?)`
  (from outbound.ts — keep exported names).

- [ ] **Step 1:** Copy both files. Add a provenance header to each:
  `// Vendored from opencodex (github.com/lidge-jun/opencodex) @ 16bef04, MIT.`
  `// Local changes: opencodex-specific config/routing stripped; see plan 2026-08-04.`
- [ ] **Step 2:** Strip opencodex-specifics from `inbound.ts`:
  - remove imports of `alias`, `desktop-3p`, `context-windows` and every
    `OcxClaudeCodeConfig` (`cc?`) parameter;
  - delete `resolveInboundModel`, `extractOcxRouteDirective`, `DEFAULT_BLOCKED_SKILLS`
    and the ChatGPT-specific `prompt_cache_key`/session synthesis (`cache_control`
    blocks remain deliberately ignored — correct for an OpenAI-like upstream);
  - keep `anthropicToResponsesTranslation`, `anthropicToResponsesBody`,
    `effortForThinkingBudget`, `effortFromOutputConfig`, `AnthropicRequestError`,
    `ClaudeInboundTranslation`.
  `outbound.ts` has zero imports — copy as-is (only the provenance header added).
- [ ] **Step 3:** Adapt tests from opencodex `tests/claude-*.test.ts` covering, at
  minimum: system string+blocks folding; `tool_result` order preservation and
  `is_error`; `tool_use`→`function_call`; `tool_choice` auto/none/any/tool;
  thinking `budget_tokens`→effort ladder; outbound event order
  (message_start → content_block_start/delta/stop → message_delta → message_stop);
  `input_json_delta` for parallel tool calls; stop_reason mapping
  (end_turn/tool_use/max_tokens); error body taxonomy. Table-driven where possible.
- [ ] **Step 4:** Run: `bun test packages/codex-responses-adapter/src/__tests__/anthropic-inbound.test.ts packages/codex-responses-adapter/src/__tests__/anthropic-outbound.test.ts` — expect PASS.
  Run the package typecheck (`bunx tsc -p packages/codex-responses-adapter --noEmit`
  or the package's existing typecheck script).
- [ ] **Step 5:** Commit: `feat(claude-runtime): vendor opencodex Anthropic Messages translation modules [T1]`

### Task T2: Parameterize adapter upstream target

**Files:**
- Modify: `packages/codex-responses-adapter/src/nestor-client.ts`
- Modify: `packages/codex-responses-adapter/src/retry.ts` (the `sendWithRetry` options)
- Modify: `packages/codex-responses-adapter/src/server.ts` (`AdapterOptions`)
- Test: `packages/codex-responses-adapter/src/__tests__/upstream-target.test.ts`

**Interfaces:**
- Produces (used by T3, T6):

```ts
export type UpstreamTarget =
  | { kind: 'nestor' } // NESTOR_CHAT_URL, `Nestor-Token: <jwt>` from dp_auth_creds
  | { kind: 'openai-compatible'; baseUrl: string; apiKey?: string }; // `Authorization: Bearer`
```

`AdapterOptions` gains `upstream?: UpstreamTarget` (default `{ kind: 'nestor' }` —
existing behavior unchanged for codex).

- [ ] **Step 1:** Write failing tests: (a) `kind:'nestor'` sends `Nestor-Token` header
  to `NESTOR_CHAT_URL` and NEVER `Authorization`; (b) `kind:'openai-compatible'` posts
  to `${baseUrl}/chat/completions`, sends `Authorization: Bearer <apiKey>` and NEVER
  `Nestor-Token`; (c) `apiKey` absent → no auth header; (d) default (no `upstream`) ≡
  nestor. Use injected `fetchImpl` capturing requests.
- [ ] **Step 2:** Run tests, expect FAIL (option not implemented).
- [ ] **Step 3:** Implement: thread `upstream` from `AdapterOptions` through
  `handleResponses`→`sendWithRetry`→the outbound POST. For `kind:'nestor'` keep the
  current `readNestorJwt()` + 401-on-missing-creds path verbatim; for
  `openai-compatible` skip JWT reading entirely (creds error must not fire).
- [ ] **Step 4:** Run new tests + the package's existing adapter tests (codex path
  must stay green untouched). Expect PASS.
- [ ] **Step 5:** Commit: `feat(claude-runtime): parameterize adapter upstream target with scoped auth modes [T2]`

### Task T3: `/v1/messages` route

**Files:**
- Modify: `packages/codex-responses-adapter/src/server.ts` (route dispatch in
  `startAdapter`, new `handleMessages`)
- Modify: `packages/codex-responses-adapter/src/from-chat-stream.ts`
  (emit `response.incomplete` on `finish_reason: "length"`)
- Test: `packages/codex-responses-adapter/src/__tests__/anthropic-route.test.ts`

**Interfaces:**
- Consumes: T1 exports, T2 `UpstreamTarget`.
- Produces: `POST /v1/messages` (path match: `path.endsWith('/messages')`, per the
  gateway protocol doc match on path — the SDK requests `/v1/messages?beta=true`);
  unknown paths (incl. `/v1/messages/count_tokens`) keep returning 404 — documented
  graceful fallback ("Claude Code estimates context usage locally").

- [ ] **Step 1:** Write failing end-to-end route tests with a fake upstream
  (injected `fetchImpl` returning canned chat-completions SSE):
  - text turn → Anthropic SSE in pinned order: `message_start` → `content_block_start`
    → `content_block_delta(text_delta)` → `content_block_stop` → `message_delta`
    (`stop_reason: "end_turn"`, usage present) → `message_stop`;
  - tool-call turn (two parallel calls) → two `tool_use` blocks with
    `input_json_delta` streams, `stop_reason: "tool_use"`;
  - upstream `finish_reason: "length"` → `stop_reason: "max_tokens"` (this is the
    bridge test for the `response.incomplete` emission);
  - `stream: false` request → single JSON Anthropic message;
  - upstream 401 → Anthropic-shaped error body (`anthropicErrorBody`);
  - `GET /v1/messages/count_tokens` → 404.
- [ ] **Step 2:** Run, expect FAIL (route missing).
- [ ] **Step 3:** Implement `handleMessages` mirroring `handleResponses`
  (`server.ts:51-139`): parse body → `anthropicToResponsesTranslation` →
  `toChatRequest` → `sendWithRetry` (T2 upstream) → streaming: wrap the
  `streamResponsesFromChat` frame-writer into a `ReadableStream<Uint8Array>` of
  Responses SSE frames and pipe through `responsesSseToAnthropicSse` to `res`
  (serialize→reparse keeps both vendored and existing modules unmodified);
  non-stream: `toResponsesResponse` → `responsesJsonToAnthropicMessage`. Reuse the
  same AbortController client-disconnect threading. Register the route in
  `startAdapter` next to the `/responses` branch.
- [ ] **Step 4:** Implement the `from-chat-stream.ts` change: on
  `finish_reason === "length"` emit `response.incomplete` (with usage) instead of
  `response.completed`; confirm the vendored `outbound.ts` maps it to
  `stop_reason: "max_tokens"` (it does — if the vendored copy keys off a different
  event name, adjust the emission to match the vendored consumer, not vice versa).
- [ ] **Step 5:** Run all package tests (anthropic + codex suites). Expect PASS.
- [ ] **Step 6:** Commit: `feat(claude-runtime): serve /v1/messages on the local adapter [T3]`

### Task T3b: Stream-integrity hardening vendored from opencodex

The 2026-08-04 comparison (opencodex Responses core vs ours) found our shared
pipeline reports a cut socket or a mid-stream provider error as
`response.completed`. These fixes sit in the exact files T3 touches and improve the
codex path and the new Claude facade alike. All items are copied blocks from
opencodex @ 16bef04 (MIT — same provenance-header rule as T1).

**Files:**
- Modify: `packages/codex-responses-adapter/src/from-chat-stream.ts`
- Modify: `packages/codex-responses-adapter/src/errors.ts`
- Test: `packages/codex-responses-adapter/src/__tests__/stream-integrity.test.ts`

**Vendor list (source lines at opencodex 16bef04):**
1. Fail-closed truncation + inline `chunk.error` envelope + residual-frame flush —
   `src/adapters/openai-chat.ts:340-461` (`sawFinish` tracking, error at :366-371,
   residual buffer :448-450, EOF-without-terminal :456-459).
2. Terminal trio — `response.failed` with classified `last_error` (codes codex-rs
   recognizes: `server_is_overloaded`, `context_length_exceeded`;
   `src/lib/errors.ts:7-86`, `src/bridge.ts:628-664`), `response.incomplete` on
   generator EOF (`bridge.ts:669-686`), trailing `data: [DONE]` (`bridge.ts:163,688`).
3. Heartbeat/stall watchdog — parser-ignored keepalive after 2 s of upstream
   silence, escalating to `response.incomplete` on stall timeout
   (`bridge.ts:182-211`).
4. Empty tool-args guard `""`→`"{}"` + synthesized `call_N` ids
   (`bridge.ts:341-344`, `openai-chat.ts:329`) — fixes our own loop where
   `call_id:""` is later dropped by `sanitize.ts` on next-turn replay.

- [x] **Step 1:** Failing tests: (a) upstream stream ends without `[DONE]`/finish →
  `response.failed`, NOT `response.completed`; (b) mid-200-stream
  `{"error":{...}}` chunk → `response.failed` with classified code; (c) 429/529
  upstream text → `server_is_overloaded` in `last_error`; (d) silent upstream for
  >2 s → heartbeat frames on the wire; (e) tool call with empty args → `"{}"`;
  (f) existing conformance + T3 anthropic-route tests still green (the Anthropic
  facade's `outbound.ts` already consumes failed/incomplete — assert the mapped
  `stop_reason`/error event on the `/v1/messages` side too).
- [x] **Step 2:** Run, expect FAIL on (a)-(e).
- [x] **Step 3:** Vendor the blocks, adapting names to our
  `parseChatSse`/`streamResponsesFromChat` structure; keep our
  `<think>`-splitter and retry rungs untouched.
- [x] **Step 4:** Run the full package test suite. Expected: PASS, including the
  untouched codex conformance suite.
- [x] **Step 5:** Commit: `fix(codex-adapter): fail-closed stream termination, error taxonomy, heartbeat, empty-args guard [T3b]`

### Task T4: `claude-runtime` providerType plumbing

**Files:**
- Modify: `packages/shared/src/config/llm-connections.ts` (`LlmProviderType` union
  ~:56-63; `getDefaultAuthType`; `isValidProviderAuthCombination` ~:797-808;
  `getModelsForProviderType`)
- Modify: `packages/shared/src/agent/backend/factory.ts`
  (`providerTypeToAgentProvider` ~:278-302 → maps `'claude-runtime'` to agent provider
  `'anthropic'`; `BACKEND_CAPABILITIES` ~:608-616; `defaultMidStreamBehavior`;
  the model-resolution fallback at ~:708 — a claude-runtime connection must use its
  `defaultModel`, never fall back to the Claude `DEFAULT_MODEL` id)
- Modify: `packages/server-core/src/model-fetchers/registry.ts` (compile-time
  exhaustive `MODEL_FETCHERS` — add `'claude-runtime'` reusing the codex-runtime
  fetcher, which already calls `fetchNestorModels` for gateway connections; non-Nestor
  claude-runtime connections keep their static `connection.models`)
- Test: `packages/shared/src/config/__tests__/` (extend the existing
  provider/auth-combination test file with `claude-runtime` rows)

**Interfaces:**
- Produces: `LlmProviderType` member `'claude-runtime'`, default auth
  `api_key_with_endpoint`, agent provider `'anthropic'` (reuses `ClaudeAgent`).

- [x] **Step 1:** Write failing test rows: `claude-runtime` + `api_key_with_endpoint`
  is valid; `claude-runtime` + `oauth` is invalid; `getDefaultAuthType('claude-runtime')
  === 'api_key_with_endpoint'`.
- [x] **Step 2:** Run, expect FAIL. Add the union member; let the compiler enumerate
  every exhaustive map that now fails to typecheck — fix each (that IS the task's
  checklist; do not silence with `default:` branches).
- [x] **Step 3:** Run: focused tests + `bun run typecheck:all`. Expect PASS/green.
- [x] **Step 4:** Commit: `feat(claude-runtime): add claude-runtime provider type [T4]`

### Task T5: Feature flag split + binary bundling

**Files:**
- Modify: `packages/shared/src/feature-flags.ts` (`ProviderFlagId` + defaults + env
  override `NESSY_FEATURE_CLAUDE_RUNTIME`, id `nessy_claude`, default `false`;
  pattern: the existing `nessy_codex`/`isCodexRuntimeEnabled`)
- Modify: `packages/shared/src/agent/backend/factory.ts` — the `'anthropic'`
  availability gates (~:182,:247,:430,:470,:580,:748,:897) become
  `PROVIDER_CLAUDE || CLAUDE_RUNTIME`; the `claude-runtime` providerType is gated on
  `CLAUDE_RUNTIME` alone. The `claude-max` subscription card stays gated on
  `NESSY_FEATURE_PROVIDER_CLAUDE` only.
- Modify: `scripts/electron-build-main.ts` (~:55 define allowlist — add the new env)
- Modify: `apps/electron/scripts/ensure-claude-sdk-binary-dir.cjs`,
  `apps/electron/scripts/build-dmg.sh` (~:99), `apps/electron/scripts/build-win.ps1`
  (~:15, ~:308), `fastlane/Fastfile` (~:136, ~:260) — every
  `NESSY_FEATURE_PROVIDER_CLAUDE` bundling/verification conditional becomes
  "either flag truthy" (mirror the existing parse, no new logic).
- Test: `packages/shared/src/__tests__/feature-flags.test.ts` (extend existing)

- [x] **Step 1:** Failing tests: flag default off; `NESSY_FEATURE_CLAUDE_RUNTIME=1`
  enables it; subscription flag stays independent.
- [x] **Step 2:** Implement flag + factory gates. Run focused tests + shared package
  typecheck. Expect PASS.
- [x] **Step 3:** Build-script edits. Verify by grep, not by building:
  `rg -n "NESSY_FEATURE_PROVIDER_CLAUDE|NESSY_FEATURE_CLAUDE_RUNTIME" apps/electron/scripts scripts fastlane/Fastfile apps/electron/electron-builder.yml`
  — every bundling site must mention both flags. (Packaged-build proof lands in T8.)
- [x] **Step 4:** Commit: `feat(claude-runtime): NESSY_FEATURE_CLAUDE_RUNTIME flag and binary bundling split [T5]`

### Task T6: ClaudeAgent gateway-adapter lifecycle

**Files:**
- Modify: `packages/shared/src/agent/claude-agent.ts` (`ClaudeAgentConfig` ~:327,
  `postInit` ~:900-941, the teardown path)
- Modify: `packages/shared/src/agent/backend/internal/drivers/anthropic.ts`
  (config construction for `claude-runtime` connections)
- Test: `packages/shared/src/agent/__tests__/claude-gateway-adapter.test.ts`

**Interfaces:**
- Consumes: `startAdapter`/`AdapterHandle` from
  `@nessy-agent/codex-responses-adapter` (already a shared dependency — see
  `codex-agent.ts` imports), `UpstreamTarget` (T2).
- Produces on `ClaudeAgentConfig`:

```ts
/** When set, start the local Anthropic Messages adapter and point the SDK at it. */
gatewayAdapter?: { upstream: UpstreamTarget };
```

- [x] **Step 1:** Failing tests (fake `startAdapter` injected or module-mocked):
  (a) with `gatewayAdapter` set, the subprocess env contains
  `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>`, `ANTHROPIC_API_KEY='not-needed'`,
  `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC='1'`, and connection-level
  `resolveAuthEnvVars` base-URL/key application is skipped;
  (b) teardown closes the `AdapterHandle`;
  (c) without `gatewayAdapter`, behavior is byte-identical to today (subscription and
  direct-API connections untouched).
- [x] **Step 2:** Run, expect FAIL.
- [x] **Step 3:** Implement in `postInit`: if `gatewayAdapter` set → `await
  startAdapter({ upstream })`, store handle, apply the env trio via the existing
  `envOverrides` seam (mirror `CodexAgent.createRuntime`'s transactional
  rollback-on-failure at `codex-agent.ts:188-260`); close the handle in the same
  place session teardown disposes backend resources. Driver: for connections whose
  `providerType === 'claude-runtime'`, build `upstream` as `{ kind: 'nestor' }` when
  `connection.baseUrl` matches the verified gateway prefix — compare against the
  constant exported by `@nessy-agent/codex-responses-adapter/nestor-client` (shared
  already imports it in `codex-agent.ts:36`; do NOT import renderer's
  `isNessyGatewayConnection` — renderer code is not importable from shared) — else
  `{ kind: 'openai-compatible', baseUrl: connection.baseUrl, apiKey: <connection credential> }`.
  Set `miniModel` from the connection (gateway default: the fast model id in
  `NESSY_GATEWAY_MODELS`) so WebFetch summarization never asks for a Haiku id the
  gateway doesn't serve (`claude-agent.ts:932-935` documents why).
- [x] **Step 4 (T4-review finding — this task owns it):** `drivers/anthropic.ts`
  now serves BOTH `anthropic` and `claude-runtime` connections. Fix three things:
  (a) `validateStoredConnection` (~:115-154) currently runs the direct Claude SDK
  against raw `connection.baseUrl` — for a `claude-runtime` connection that bypasses
  the local adapter and the Settings "Test connection" button would report a healthy
  gateway connection as failed. Route claude-runtime validation through the adapter
  lifecycle (start adapter → probe → close), or return a cheap structural check if a
  full probe is disproportionate — record the choice.
  (b) The `const testModel = connection.defaultModel!` non-null assertion is
  reachable as `undefined` for claude-runtime (default models list is `[]`) — remove
  the assertion, fail with a clear message instead.
  (c) The stale comment at ~:116 ("only direct 'anthropic' connections reach this
  driver") is now false — update it.
- [x] **Step 5:** Run focused tests + `bun run test:shared:all` (this task touches the
  shared agent — affected-package scope). Expect PASS.
- [x] **Step 6:** Commit: `feat(claude-runtime): per-session local adapter lifecycle in ClaudeAgent [T6]`

### Task T7: Gateway card, template, one-click, models, i18n

**Files:**
- Modify: `packages/server-core/src/domain/connection-setup-logic.ts`
  (`BUILT_IN_CONNECTION_TEMPLATES` — add
  `'claude-gateway': { name: 'Claude Code (Nessy Gateway)', providerType: 'claude-runtime', authType: 'api_key_with_endpoint' }`)
- Modify: `apps/electron/src/renderer/components/apisetup/nessy-gateway.ts`
  (`claudeGatewayConnectionDefaults()` mirroring `codexGatewayConnectionDefaults()` —
  baseUrl `NESSY_GATEWAY_BASE_URL`, models `NESSY_GATEWAY_MODELS`, `defaultModel` set
  explicitly; extend `isNessyGatewayConnection()` to recognize `claude-runtime`)
- Modify: `apps/electron/src/renderer/components/apisetup/gateway-one-click.ts`
  (`GatewayKind` += `'claude'`; `buildGatewaySetup()` branch)
- Modify: `apps/electron/src/renderer/hooks/useOnboarding.ts` (card in the
  `gateway-connect` step, visibility keyed to the `nessy_claude` provider flag via the
  existing `nessy:getProviderFlags` IPC)
- Modify: every locale file (new card title/description keys — ALL locales)
- Test: extend the existing connection-setup-logic tests with the new template row

**BYO-key path:** the same card's connection form (api_key_with_endpoint) lets the
user replace the one-click JWT flow with their own key, endpoint, and model string
(e.g. `deepseek-v4-flash` against the LLM proxy) — no separate template. Model ids are
free-form: behind a custom base URL the SDK "passes any string through without
checking it". The existing `anthropic-api` card (direct Anthropic / pi_compat upgrade)
is NOT touched.

- [x] **Step 0 (T4-review finding — this task owns it):** add
  `packages/shared/src/agent/composer-capabilities.ts` to this task's files. The
  `PROVIDER_DEFAULTS` map is `AgentProvider`-keyed, so `claude-runtime` silently
  inherits `anthropic`'s `images: 'yes'` and the full reasoning-levels list — wrong
  for gateway models. Add a providerType-aware branch mirroring what
  `codex-runtime` declares (`images: 'per-model'`, reduced levels), with a test.
- [x] **Step 0b (T6-review handoff — this task owns it):** the card's two buttons
  must not hit the T4 defect: (a) `testBackendConnection` (factory.ts ~:876-881)
  sets raw `envOverrides.ANTHROPIC_BASE_URL = connection.baseUrl` and never calls
  `postInit`, so the setup form's Test button would run the direct SDK against the
  gateway URL for a claude-runtime connection — route claude-runtime through the
  driver's structural validation (or postInit the test agent) and pin it with a
  test; (b) model refresh for claude-runtime connections must not reach
  `anthropicDriver.fetchModels` (Anthropic-only endpoint semantics) — non-Nestor
  claude-runtime connections keep stored models, Nestor ones use the T4 fetcher.
  (c) mini-model seeding: `claudeGatewayConnectionDefaults()` must seed the fast
  model as the LAST entry of `connection.models` (T6's resolution reads the last
  entry) or explicitly set `miniModel` — pin whichever with a test.
- [x] **Step 1:** Failing test: `createBuiltInConnection('claude-gateway', …)` yields
  `providerType: 'claude-runtime'`, `authType: 'api_key_with_endpoint'`, seeded models
  and `defaultModel`.
- [x] **Step 2:** Implement template + defaults + one-click branch + onboarding card +
  i18n keys.
- [x] **Step 3:** Run: focused tests, `bun run lint:i18n:parity`,
  `bun run lint:i18n:sorted`, renderer typecheck. Expect green.
- [x] **Step 4:** Commit: `feat(claude-runtime): Claude Code gateway card with one-click auth and BYO keys [T7]`

### Task T8: Packaged-build live smoke + full regression wave

Dev builds are not shipping evidence (repo trap: `electron:dev` runs built bundles /
unpatched subprocesses) — the smoke MUST run on a packaged artifact.

- [x] **Step 1:** Build:
  `NESSY_FEATURE_CLAUDE_RUNTIME=1 CSC_IDENTITY_AUTO_DISCOVERY=false bash apps/electron/scripts/build-dmg.sh arm64`.
  Verify the native binary is present in the artifact (the Fastfile check mirrors
  this) and that a default-flags build still produces the empty
  `claude-agent-sdk-binary` dir.
  **Done — three artifacts, all `1.17.0`, arm64.** Runtime-on: 288 MB dmg,
  `…/app/node_modules/@anthropic-ai/claude-agent-sdk-binary/claude` = 247 124 336 B.
  Runtime+codex: 352 MB dmg, same binary plus
  `…/app/resources/bin/codex/darwin-arm64/codex-app-server` (207 037 840 B).
  Default flags: 211 MB dmg, `claude-agent-sdk-binary/` present and **EMPTY**, no
  `resources/bin/codex/` at all. **`build-dmg.sh` needs two env vars this plan did
  not mention** — `NESSY_DESKTOP_UPDATE_URL` and `NESSY_DESKTOP_UPDATE_CHANNEL`;
  without them electron-builder dies at
  `cannot expand pattern "${env.NESSY_DESKTOP_UPDATE_URL}"` (README § local
  unsigned packaging).
- [x] **Step 1b (T5-review finding — this task owns it):**
  `apps/electron/scripts/build-linux.sh` stages the ~210MB Claude binary
  UNCONDITIONALLY (no flag gate at all — pre-existing; the afterPack hook never
  deletes a staged binary and electron-builder.yml's Linux include is
  unconditional). Add the `CLAUDE_ENABLED` gate mirroring `build-dmg.sh:102-108`
  (either-flag), and verify by grep + a `bash -n` parse. A runtime-off Linux build
  must not ship a binary the factory gate refuses to use.
  **Done.** `build-linux.sh:79-87` computes `CLAUDE_ENABLED` from either flag;
  step 4a's staging is inside `if [ "$CLAUDE_ENABLED" = "1" ]`, with `ALIAS_DEST`
  created (and left empty) OUTSIDE it so electron-builder's unconditional `from:`
  entry still has a directory. `bash -n` parses; the truth table was executed for
  unset / `1` / `true` / `off` and prints disabled / enabled / enabled / disabled.
  No Linux build runs on this machine — the gate is parse-and-truth-table
  verified, the dmg is the packaged proof.
- [x] **Step 2:** Live smoke checklist (record each with evidence in this plan's
  tracker note or a linked findings file; add rows to
  `docs/testing/cdp-live-checklist.md`):
  1. One-click connect Claude gateway card (dp auth reused, no credential form).
  2. Simple text turn on `tgpt/qwen35-397b-a17b-fp8` — streams, completes.
  3. Tool turn: ask for a small file edit in a scratch workspace — `tool_use` blocks
     round-trip, edit lands, turn ends `end_turn`.
  4. Thinking output sanity: no raw `<think>` leakage into visible text.
  5. Abort mid-turn — session recovers, adapter port freed.
  6. BYO mode: same card, custom key + model string (any second gateway model or
     `deepseek-v4-flash` if served) — request carries `Authorization: Bearer`, NEVER
     `Nestor-Token` (assert via adapter debug log or injected fetch capture in a
     harness run).
  7. Subscription card: with `NESSY_FEATURE_PROVIDER_CLAUDE` unset it is absent; the
     runtime card still works.
  8. WebFetch tool turn — summarization uses the connection `miniModel` (no 404 on a
     Haiku id).
  9. **T3b heartbeat/terminal-frame tolerance (codex route).** A codex turn on the
     packaged build with at least one >4 s gap in upstream output: confirm
     `codex-app-server` tolerates `response.heartbeat` (now emitted by DEFAULT after
     2 s of silence, so every slow turn carries it) and `response.incomplete`, and
     that the trailing `data: [DONE]` does not end the turn early. Grepping the
     shipped binary for these strings is NOT evidence — the positive control fails
     (`response.created`, pinned live in Phase 1, also returns zero hits).
  10. **T3b stall path (messages route).** Force >90 s of upstream silence (or run
     with a lowered `stallTimeoutSec`): the SDK must surface an ERROR, not a silent
     truncation — `server.ts:failUnmappedIncomplete` rewrites the stall
     `response.incomplete` to `response.failed` so the vendored translator emits an
     Anthropic `error` event instead of defaulting to `end_turn`.

  **Done — 13 ✅ / 2 ⚠️ / 0 ❗ (post-review; `CLR-10` downgraded, see below), rows
  `CLR-1…15` in `docs/testing/cdp-live-checklist.md`**
  (that file carries the per-row evidence and the packaged-app driving recipe).
  Highlights and the two corrections the pass had to make:

  - **9 and 10 are the strongest results, and neither needed a real codex turn to
    prove the frames.** Both routes are served by the SAME adapter, so a plain
    `curl` at a live adapter whose upstream stalls reads the wire directly.
    Codex route: `response.created` → 44 × `response.heartbeat` (one per 2 s) →
    `response.incomplete` with `incomplete_details.reason:"upstream_stall_timeout"`
    → `data: [DONE]`. Messages route: `message_start` → 49 × `ping` →
    `event: error` `{"type":"api_error","message":"upstream turn did not complete:
    upstream_stall_timeout"}` and **no `message_stop`**. `failUnmappedIncomplete`
    does exactly what T3b claimed.
  - **Item 9's second half (codex-app-server's tolerance) is INFERRED, not shown
    — downgraded at review.** The gateway's ttfb is 0.33 s on a normal prompt, so
    an ordinary turn never crosses the 2 s heartbeat threshold and proves nothing.
    `curl -w %{time_starttransfer}`: 335 kB → 1.59 s (not enough — would have been
    a false pass), 510 kB → 2.34 s (enough, and the in-app request adds
    system+tools on top). The 510 kB turn answered `ACK` in 10.3 s. What that
    shows is a turn whose MEASURED upstream ttfb exceeds the threshold completing
    normally; it is not a frame-level capture of a heartbeat crossing into
    `codex-app-server`. **The deterministic rig the review asked for does not
    exist yet:** `codex-agent.ts` calls `startAdapter({})`, i.e. `DEFAULT_UPSTREAM`
    = nestor, so a codex session cannot be pointed at a slow local endpoint —
    that seam is the separate codex BYO-endpoints plan. `CLR-10` is marked ⚠️ and
    says so; re-run it as a hard pass once that seam lands. A 719 kB prompt 400s on
    context length — and the 400 surfaces verbatim as an `error` message, which is
    a free bonus check on the codex error taxonomy.
  - **Item 5's "adapter port freed" has a positive control:** four adapters
    started across the run, deleting one session freed exactly its port and left
    the others listening.
  - **⚠️ 10, seen from the session rather than the wire (checklist `CLR-12`).**
    The adapter is correct, but the Claude SDK **retries** the errored stream with
    escalating backoff — upstream re-POSTs at +92 s, +268 s, +301 s — so a
    hard-stalled endpoint leaves the session on `Responding…` for 14 min+ instead
    of surfacing the error. Fail-closed holds (no silent truncation); the latency
    does not. Carried to T9 as a concern, not fixed here.
  - **Two near-misses worth the reader's time.** The image-drop check (review item
    a) first "passed" because `red.png` sat in the session cwd and the model
    `ls`-ed and `Read` it; moved outside with a colourless name, both runtimes
    answer `NO-IMAGE-RECEIVED`. And item 8 is meaningless without its control —
    the gateway 400s `claude-3-5-haiku-20241022` and 200s
    `tgpt/qwen36-35b-a3b-fp8`, which is what makes a successful WebFetch
    summarization proof that `ANTHROPIC_DEFAULT_HAIKU_MODEL` seeding is live.
  - Review items e and f also PASS, with e narrowed at review:
    `exportRemoteSessionTransfer` returns a real summary on a `claude-runtime`
    session (1488 chars warm, 1132 on a cold app whose session has run no turn
    since launch), and each of three consecutive calls logs a matching
    `session-scoped-tools Registered`/`Unregistered` pair for
    `<sessionId>-remote-transfer-summary`. **Whether the summary agent opens its
    own adapter was NOT measured** — the first write of this row said it did, on
    the strength of a loopback port that is in fact the app's own websocket
    server (`Nessy Desktop server listening on ws://127.0.0.1:57227`); that run
    has zero `adapter listening` lines, and `SessionManager` wires `onDebug` onto
    the managed session agent only, so their absence is not evidence either way.
    `getProviderFlags()` on the packaged build returns
    `claude:false, nessy_claude:true` with no Pro/Max card in onboarding.
- [x] **Step 3:** Full regression: `bun run typecheck:all`, `apps/cli` typecheck,
  `bun run lint`, `bun run test:shared:all`, `bun test`, `bun run lint:i18n:parity`,
  `bun run lint:i18n:sorted`, `bun run validate:ci`. Check
  `docs/superpowers/specs/2026-07-29-known-failing-tests.md` before recording any new
  failure; compare against `master`'s pipeline, not only this branch's base.
  **Done, sequentially, nothing else running.** typecheck:all ✅ · `apps/cli`
  typecheck ✅ · lint ✅ (0 errors, 4 pre-existing unused-disable warnings) ·
  `test:shared:all` **297 pass / 0 fail** (the two live-gateway conformance rows
  pass here — this machine has credentials) · `bun test` **11 442 pass / 18 skip /
  4 fail** · i18n parity ✅ (2138 keys) · i18n sorted ✅ · `validate:ci` ✅.
  **None of the 4 is this plan's.** Three (`lifecycle-bridge` frozen inventory,
  `system.open-url` ×2) were measured three ways — fail at `e9fe8999` (which sits
  BETWEEN T0's two commits: after the dep bump `fc720b9b`, before every line of
  functional work), fail at `becd7138`, and **pass at `master` `ed678070`, which
  IS the branch's merge-base** — so they are branch-introduced and pre-date this
  plan's functional work; rows added to the known-failing register. The fourth (`pi-runtime-cwd-transaction`) passes 3/3 alone at HEAD: a
  real-server timing test that loses a race under full-suite load.
  **`rm -rf release` before `bun test`** — a dmg build leaves the packaged copy of
  the renderer sources in the tree and the runner collects them (12 928 tests
  collected with `release/` present, 11 464 without, and the difference is 14
  phantom failures).
- [x] **Step 4:** Commit smoke-evidence/doc updates:
  `test(claude-runtime): packaged live smoke evidence and cdp checklist rows [T8]`

### Task T9: Close-out

- [x] **Step 1:** Bump version in BOTH root `package.json` and
  `apps/electron/package.json` (minor bump — new user-facing runtime). → `1.18.0`.
- [x] **Step 2:** Add `apps/electron/resources/release-notes/<version>.md`
  (`# Nessy Desktop <version>`, date line, `## NEW` section for the Claude Code
  runtime card; match `1.0.2.md` style; never edit older files).
- [x] **Step 3:** Update `docs-site/` (runtime selection page + connections page) and
  the AGENTS.md build-flag table (add `NESSY_FEATURE_CLAUDE_RUNTIME`, default off,
  note that it also bundles the SDK native binary; note
  `NESSY_FEATURE_PROVIDER_CLAUDE` now gates only subscription cards and implies the
  runtime). Also folded in: the T8 `build-dmg.sh` MB/MiB twin, and the T5-review
  one-liner that flag values must be written `1`/`0`.
- [x] **Step 4:** Update this plan's Tracker to all-✅ in the same commit.
  Commit: `chore(release): <version> — Claude Code runtime on Nessy integrations [T9]`

**`CLR-12` is NOT closed by T9 and was deliberately not attempted in the release
commit (owner direction, 2026-08-05).** The block below is the durable record for
the follow-up, not a T9 step: a retry budget is a behaviour change to a shipped
runtime and does not belong in a version-bump/docs commit. It needs its own task,
with the `PRV-N10`-style live case as its gate.

**Hand-off from T8 — the one product finding (`CLR-12`).** A
`claude-runtime` session against a hard-stalled upstream never surfaces an error
in bounded time. The adapter is correct — `CLR-11` reads
`event: error {"type":"api_error","message":"upstream turn did not complete:
upstream_stall_timeout"}` with **no** `message_stop` straight off the wire — but
the Claude SDK **retries** that errored stream: upstream re-POSTs measured at the
capture endpoint at **+92.4 s, +268.3 s, +301.4 s**, and the retries switch to
**non-streaming** (`capture.jsonl` entries 4-6 and 10-11, 13 carry
`stream: false` while the first attempt of each turn carries `stream: true`).
Fourteen minutes in, the session still read `isProcessing: true` with one user
message and no error. Cross-reference `PRV-N10` in
`docs/testing/cdp-live-checklist.md` — the mid-turn network-cut case asserts the
`Connection Error` band with a working Retry, which is the behaviour this path
fails to reach.

**Prescribed direction (reviewer's ruling): a retry budget in the Claude env
block, NOT a status-class change on the adapter.** The lever is
`CLAUDE_CODE_MAX_RETRIES`, which is present in both the SDK core
(`node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs`) and the bundled native
binary (4 hits), and it belongs beside `ANTHROPIC_BASE_URL` in
`claude-agent.ts`'s `this.config.envOverrides` block (`:1004`) so it is
per-session and never touches `process.env`. *Correction to the review note:* the
cited `codex-agent.ts:690 maxRetries` is `rmSync({ maxRetries: 5, retryDelay: 50 })`
deleting `codexHome` — a filesystem retry, not a network-retry precedent. The
ruling stands; only the citation is replaced.

## Future work — parked with pointers (owner-reviewed 2026-08-04)

**BYO Anthropic-format keys on the codex runtime** (user prefers the Codex harness
but wants Claude/Anthropic-format models — own Anthropic key, or
anthropic-compatible endpoints like DeepSeek `/anthropic`, GLM, Kimi). NOT vendored
now — deliberately: the module is not self-contained (drags opencodex's
`ProviderAdapter` interface and reasoning-envelope machinery), a frozen unused copy
would rot against an active upstream, and this repo's inert-code audits would flag
846 dead lines forever. The case is also narrow today: BYO-Anthropic already lands
on the Claude SDK runtime natively (no adapter) and on Pi via the
`anthropic-messages` CustomEndpointApi.

What "ready" means instead:
- T2's `UpstreamTarget` is an extensible union — a third member
  `{ kind: 'anthropic-messages', baseUrl, apiKey }` slots in without signature
  changes.
- When the need arrives, vendor from opencodex's **then-current HEAD** (not the
  16bef04 snapshot): the cluster is `src/adapters/anthropic.ts` (~846 L — Messages
  outbound with extended thinking + budget mapping + image guard),
  `src/responses/reasoning-envelope.ts` (thinking-signature round-trip via codex's
  `encrypted_content` slot — signature-less thinking replay 400s at Anthropic),
  the reasoning-replay branch of `src/responses/parser.ts` (~:333-351 at 16bef04),
  and the `thinking_delta`/`thinking_signature`/`redacted_thinking` handling in
  `src/bridge.ts`. License MIT; same provenance-header rule as T1.

## Not doing in v1 (recorded so nobody re-files)

- **`/v1/messages/count_tokens` route** — officially optional; absent ⇒ local
  estimation ("Token-counting endpoints are the only optional ones…").
- **Vision/images through the adapter** — `to-chat.ts` has no image mapping; the
  vendored `inbound.ts` emits `input_image` parts that will be dropped. v2 if needed.
- **Gateway model discovery** (`CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY`) — the
  discovery filter ignores ids not starting `claude`/`anthropic`, so `tgpt/*` would
  never appear; models are seeded on the connection instead.
- **Prompt caching semantics** — `cache_control` is a deliberate no-op over an
  OpenAI-like upstream; cache token counters will read zero.
- **Changing the `anthropic-api` card's pi_compat upgrade** — untouched.
- **Serving user OpenAI-like endpoints from the `anthropic-api` card** — the
  claude-gateway card's BYO form covers it; one card, one path.

## Risks (accepted, owner-visible)

- Anthropic states it "doesn't support routing Claude Code to non-Claude models
  through any gateway" — a Claude Code release may add fields the adapter must learn
  to absorb. Mitigation: adapter strips/ignores unknown Anthropic-side fields; the
  contract tests in T1/T3 pin the surface we depend on.
- Licensing: the SDK/CLI are proprietary ("All rights reserved", Commercial Terms);
  embedding to power our own product is contemplated by the terms, non-Anthropic
  models are a gray zone. Internal distribution + flag-gated builds lower exposure;
  formal legal review is an owner decision outside this plan. Subscription (OAuth)
  credentials are never used for the gateway runtime — API-key-style auth only, per
  Claude Code's legal page.
- Qwen tool_calls are shape-fragile on this gateway (probed earlier); the existing
  retry/sanitize rungs are in the path, and T8's smoke is the gate that decides
  whether more sanitize rungs are needed.
