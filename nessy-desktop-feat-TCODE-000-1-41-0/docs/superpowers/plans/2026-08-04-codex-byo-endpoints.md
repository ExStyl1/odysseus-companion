# Codex BYO Endpoints — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users run the Codex runtime on their own keys — any OpenAI-like
endpoint (including our LLM proxy with any vendor's model on it) in Phase 1, and
optionally direct Anthropic-format keys in Phase 2 — matching the integration matrix
of the Claude runtime plan.

**Architecture:** The Codex runtime already flows through the local
`codex-responses-adapter` for ALL model traffic, and this is mandatory: Codex
**removed** the chat-completions wire (`wire_api = "chat"` fails config parse at our
pinned `rust-v0.142.5`; only `Responses` remains — verified against
`codex-rs/model-provider-info/src/lib.rs` at that tag, removal announced in
github.com/openai/codex/discussions/7782). So BYO is not a codex-config feature; it
is: build an `UpstreamTarget` from the connection and hand it to the adapter — the
seam the Claude plan's T2 creates. Phase 1 threads that seam through `CodexAgent`;
Phase 2 adds an `anthropic-messages` upstream kind by vendoring opencodex's
Anthropic outbound cluster.

**Depends on:** `2026-08-04-claude-sdk-runtime-on-nessy-integrations.md` tasks
**T2** (`UpstreamTarget` in `AdapterOptions`, default `{kind:'nestor'}`) and **T3b**
(stream-integrity hardening). **SATISFIED 2026-08-05** — T2 landed in `ceb62e16`,
T3b in `8cc17fa1`; the whole Claude plan closed at 1.18.0 (`d1664465`). This plan is
ready to execute.

## Execution-readiness update (2026-08-05) — precedents to MIRROR, not reinvent

The Claude plan built and double-reviewed the exact seams this plan threads. Each C
task below names its precedent; implementers should read the precedent first.

- **Upstream derivation:** `drivers/anthropic.ts` (~:22 onward) derives
  `UpstreamTarget` from the connection — nestor iff the connection baseUrl equals
  the verified gateway base derived from `NESTOR_CHAT_URL` (whole-URL match, an
  owner-reviewed decision: same host + different path must NOT get Nestor
  semantics), else `{kind:'openai-compatible', baseUrl, apiKey}` via the existing
  credential seam. `claude-agent.ts:996` shows `startAdapter({ upstream })` and the
  per-session env application with transactional rollback.
- **Refresh gating:** the claude-runtime `MODEL_FETCHERS` entry
  (`model-fetchers/registry.ts:42-52`) is already gated on `isNestorConnection` —
  C2 copies that shape onto the codex entry.
- **Form/card patterns:** the T7 commit `becd7138` shows every renderer surface a
  runtime connection needs: template row, `GatewayKind` branch, switcher bucket in
  `model-picker-helpers.ts`, settings label ladders in `AiSettingsPage.tsx`,
  composer capabilities branch. The codex side ALREADY HAS its bucket/labels/caps —
  C3 only adds creation/edit UI.
- **Stream integrity on the codex path** is already hardened and live-smoked
  (heartbeats, `response.incomplete`, `[DONE]` — CLR-9/10 rows in
  `docs/testing/cdp-live-checklist.md`).

## Why this is small (evidence from the 2026-08-04 gap analysis)

BYO on codex-runtime today is validation-theatre: the combination is *accepted* but
*dead* at runtime.

- `llm-connections.ts:831` (verified 2026-08-05) already validates `'codex-runtime':
  ['api_key_with_endpoint','api_key','none']`; default authType is
  `api_key_with_endpoint`.
- `codexDriver.buildRuntime` already passes `baseUrl: context.connection?.baseUrl`
  (`drivers/codex.ts:23`) — and nothing reads it.
- `CodexAgent.createRuntime` starts the adapter with no upstream:
  `startAdapter({})` (`codex-agent.ts:198`).
- `CodexAgent.queryLlm` is separately hardwired: `readNestorJwt()` +
  `fetch(NESTOR_CHAT_URL, {'Nestor-Token': jwt})` (`codex-agent.ts:565-573`).
- Model refresh always hits Nestor: `CodexModelFetcher` → `fetchNestorModels`
  (`model-fetchers/registry.ts:23-29,39`, `nestor.ts:9-10,41-43`).
- No UI path: the only creation flow is the zero-form one-click card
  (`gateway-one-click.ts:52-61`); `canEditLlmConnection` hides the edit form for
  gateway connections (`nessy-gateway.ts:48-66`); `codexDriver.validateStoredConnection`
  is a no-op (`drivers/codex.ts:34`).

## Tracker

Status: ⬜ open · 🔄 in progress · ✅ done · ⏸ parked on an owner decision

| # | task | status | commit | dep | note |
|---|---|---|---|---|---|
| C1 | Thread `UpstreamTarget` through CodexAgent (runtime + queryLlm) | ✅ | | claude-plan T2 ✅ | mirrors anthropic driver derivation; queryLlm parameterized |
| C2 | Gate codex model refresh on Nestor connections only | ✅ | | C1 | both fetchers on `isNessyGatewayBaseUrl` (one shared class, both map keys); re-exported from `shared/agent/backend`'s index so `internal/` stays internal (precedent: `runtime-resolver`) |
| C3 | Unified BYO connection form — codex-runtime AND claude-runtime + i18n | ✅ | | C1 | entry point: one `custom_runtime` provider card + in-form runtime selector; resolver arms; edit round-trip pinned; signature fix; empty endpoint forbidden |
| C4 | Packaged live smoke + focused regression | ✅ | | C1–C3 | CBX-1…7 all ✅ on the no-flag 1.18.0 build (ee84fe4e); CLR-10 upgraded ⚠️→✅ (deterministic heartbeat frames + completing turn; 6s frameless TTFB tolerated — TTFB emits NO frames by construction, heartbeats govern mid-stream silence only); C3 follow-up authType fix live-proven (keyless → 'none', health green, no auth header on wire); regression: typecheck:all + apps/cli tsc + test:shared:all + adapter 206 + i18n gates all green; 4 rig traps recorded in the checklist cycle notes (symlinked config ancestor blocks storage readiness; occluded-window rAF starvation; stale compositor screenshots; single-instance relaunch race); pointer-events lock chip filed |
| C5 | Phase 2 (⏸ until owner demand): `anthropic-messages` upstream kind | ✅ | | C4 CLOSED (backlog triage 2026-10-09): not adopted under the owner's 2026-10-08 simplest/runtime-native rule — anthropic-wire models run natively on the Claude Code runtime and are shown greyed on Pi/Codex (custom-endpoint.md); reopen on owner demand. | vendor opencodex anthropic cluster from then-current HEAD |
| C6 | Phase 2 smoke with a real Anthropic-format key | ✅ | | C5 CLOSED (backlog triage 2026-10-09): closes with C5 (not adopted); becomes live only if C5 is built. | |
| C7 | Close-out: version bump, release notes, docs-site codex+BYO coverage | ✅ | | C4 | 1.19.0 lockstep in both package.json; new release-notes/1.19.0.md (runtime defaults flip + BYO form + keyless fix); docs-site EN+RU: llm-connections gained Codex (Nessy Gateway) + Custom runtime endpoints sections, codex-runtime providerType row, codex-gateway/codex-custom examples, claude flag bullet updated to default-on; introduction + installation card lists restructured (runtimes+BYO in default build, subscriptions stay flag-gated) |

## Global Constraints

- Same repo rules as the Claude plan: branch `feat/TCODE-000`, one commit per task,
  no `Co-Authored-By`, no MRs/tags autonomously; `~/.nessy/dp_auth_creds.json`
  read-only outside `auth/dp`; `Nestor-Token` only for the verified gateway prefix
  (`UpstreamTarget kind:'nestor'`), everything else standard `Authorization: Bearer`;
  verification budget (focused per task, full wave at C4).
- Codex native `http_headers`/`env_http_headers` exist but carry **static** values
  (headers fixed when the provider is constructed) — they cannot carry our rotating
  dp JWT, which is why auth stays in the adapter. Do not move it into config.toml.
- Quality note for the card copy: any-vendor models through an OpenAI-like proxy
  lose vendor-specific extras (thinking signatures, cache_control) — that is a
  property of the proxy wire, not a defect to fix here.

---

### Task C1: Thread `UpstreamTarget` through CodexAgent

**Files:**
- Modify: `packages/shared/src/agent/codex-agent.ts` (`createRuntime` ~:188-260,
  `queryLlm` ~:565-573)
- Modify: `packages/shared/src/agent/backend/internal/drivers/codex.ts`
  (build the upstream from the connection)
- Test: `packages/shared/src/agent/__tests__/codex-byo-upstream.test.ts`

**Interfaces:**
- Consumes: `UpstreamTarget` and the parameterized `startAdapter`/`sendWithRetry`
  from claude-plan T2.
- Produces: `CodexAgent` config field `upstream?: UpstreamTarget`
  (default `{ kind: 'nestor' }` — current behavior byte-identical).

- [x] **Step 1:** Failing tests: (a) gateway connection (baseUrl matches the Nestor
  prefix constant from `@nessy-agent/codex-responses-adapter/nestor-client`) →
  adapter started with `{kind:'nestor'}`; (b) custom connection (other baseUrl +
  stored key) → `{kind:'openai-compatible', baseUrl, apiKey}` and `queryLlm` posts
  to that baseUrl with `Authorization: Bearer`, NEVER `Nestor-Token`; (c) no
  connection info → nestor default. Locate the credential seam first: find where
  SessionManager/driver context resolves the stored connection credential for
  backends (the Claude driver reads it for `resolveAuthEnvVars`) and reuse that
  exact path — do not invent a parallel credential read.
- [x] **Step 2:** Run, expect FAIL.
- [x] **Step 3:** Implement: driver builds `upstream` from the connection and passes
  it into the backend config; `createRuntime` forwards it to `startAdapter({ upstream })`;
  `queryLlm` uses the same target/auth (extract a small shared helper in
  `codex-agent.ts` rather than duplicating header logic).
- [x] **Step 4:** Run focused tests + `bun run test:shared:all`. Expect PASS.
- [x] **Step 5:** Commit: `feat(codex-byo): thread UpstreamTarget through CodexAgent [C1]`

### Task C2: Gate codex model refresh on Nestor connections

**Files:**
- Modify: `packages/server-core/src/model-fetchers/registry.ts` (~:23-29,39)
- Test: extend the existing model-fetcher tests

**Predicate correction (C1-review finding, 2026-08-05):** do NOT use
`isNestorConnection` — it is a PREFIX match (`nestor.ts:33-34`), while the runtime
upstream decision is a WHOLE-URL match. A BYO endpoint at
`https://code-completion-nestor.tcsbank.ru/api/v1/cli/<other>/v1` would be BYO for
the adapter but "Nestor" for model refresh, sending the user's own key to the
gateway as `Nestor-Token` and overwriting their catalog. Use
`isNessyGatewayBaseUrl` from `drivers/upstream-target.ts` (C1's module) for BOTH
fetcher entries — the codex one AND the claude-runtime one at `registry.ts:45`,
which has the same hole today.

- [x] **Step 1:** Failing tests: (a) a codex-runtime connection whose baseUrl is
  same-host-different-path keeps its stored `connection.models` untouched on
  refresh (no `fetchNestorModels` call, no `Nestor-Token` egress); (b) same for
  claude-runtime; (c) exact gateway baseUrl still refreshes for both.
- [x] **Step 2:** Implement the `isNessyGatewayBaseUrl` guard in both fetcher
  entries (import from `@nessy-agent/…/drivers/upstream-target` — check the actual
  import path shared→server-core allows; if server-core cannot import the shared
  internal driver module cleanly, re-export the predicate from a proper package
  surface and note it).
- [x] **Step 3:** Run focused tests + server-core typecheck. Expect PASS.
- [x] **Step 4:** Commit: `fix(codex-byo): only refresh models from Nestor for gateway connections [C2]`

**Executor notes (2026-08-05):**
- **Import path.** (Reason corrected by C2 review: a dedicated export-map subpath
  WOULD typecheck — TypeScript falls back to exports-map resolution when a `paths`
  pattern has no on-disk substitution; `storage-runtime.ts:15`'s
  `@nessy-agent/shared/agent/memory` already relies on exactly that. The chosen
  outcome stands on the surface-size argument alone.) The options were:
  the raw `…/agent/backend/internal/drivers/upstream-target` (resolvable via the
  existing `"./agent/backend/*"` wildcard, but reaches into `internal/`), or a
  re-export from the public `agent/backend` index. Chose the re-export: it keeps
  `internal/` internal, follows the precedent already in that file
  (`resolvePluginNodeRuntime` from `./internal/runtime-resolver.ts`), and
  `server-core/model-fetchers/{anthropic,pi}.ts` already import from that exact
  surface, so the module graph is unchanged.
- **One class, both keys.** `CodexModelFetcher` and `ClaudeRuntimeModelFetcher`
  became identical under the corrected predicate, so they collapsed into a single
  `GatewayRuntimeModelFetcher` instance registered under both map keys — two
  copies of "which URL is the gateway" is the drift that produced this hole.
- **Out of scope, observed:** `ModelRefreshService.startAll`/`refreshNow`
  (`model-fetchers/index.ts:182,194,229`) still schedule *timers* off
  `isNestorConnection`, so no periodic timer is created for any connection under
  the `…/api/v1/cli/` prefix, gateway or not. Harmless today (a BYO connection's
  fetcher now returns `{models: []}`, and gateway connections already behaved this
  way), but the runtime fetchers' `refreshIntervalMs` is effectively dead. Left
  alone: that code is shared with the `pi_compat` path C2 must not touch.

### Task C3: Unified BYO connection form — codex-runtime AND claude-runtime

Owner requirement (2026-08-04): users must be able to bring their own key to any
OpenAI-like endpoint (e.g. our LLM proxy with a different vendor's model) on either
runtime. The claude-runtime backend for this landed fully tested in the Claude plan
(T2/T6); ONLY the creation/edit UI is missing for both runtimes. One form, two
providerTypes.

**Files:**
- Modify: `apps/electron/src/renderer/components/apisetup/nessy-gateway.ts`
  (`canEditLlmConnection`: allow editing codex-runtime AND claude-runtime
  connections whose baseUrl is NOT the verified gateway URL; gateway one-click
  connections stay locked)
- Modify: the connection setup form component that renders `api_key_with_endpoint`
  for other providers (reuse it — endpoint + key + model list + default model
  fields). Study T7's commit `becd7138` for how the claude-gateway card wires the
  setup machinery; the BYO entry point is NEW (an "advanced" affordance on the two
  runtime cards, or a separate "Custom runtime endpoint" method — smallest coherent
  choice, record it).
- Modify: `apps/electron/src/renderer/components/settings/AiSettingsPage.tsx`
  (~:620-624): `getApiKeyMethodForConnection` maps non-pi connections to the
  `anthropic_api_key` form, whose SETUP path rewrites the connection to `pi_compat`
  — a hand-seeded or newly-created BYO runtime connection edited through it would
  be silently converted off its providerType. Route both runtime types to the new
  BYO form so Edit round-trips without providerType conversion.
- Modify: `packages/shared/src/agent/backend/factory.ts`
  (`resolveSetupTestConnectionHint` ~:433-457, claude-plan final-review handoff):
  today it can only emit `'pi' | 'pi_compat' | 'anthropic'`, so
  `anthropicDriver.testConnection`'s claude-runtime arm is UNREACHABLE from the RPC
  path. Add claude-runtime and codex-runtime arms so the setup form's Test button
  reaches the drivers' structural checks; pin the RPC→driver seam with a test, not
  only the driver unit.
- Modify: locale files (ALL) — card/form strings.
- Test: extend connection-setup-logic tests: creating codex-runtime AND
  claude-runtime connections with custom endpoint+key+models persists them,
  `validateStoredConnection` passes, and Edit round-trips WITHOUT providerType
  conversion.

- [x] **Step 1:** Failing tests: persistence + edit-round-trip (both runtimes) +
  the resolver arms (RPC→driver seam).
- [x] **Step 2:** Implement entry point + form + editability + resolver + i18n.
- [x] **Step 3:** Run: focused tests, `bun run lint:i18n:parity`,
  `bun run lint:i18n:sorted`, renderer typecheck, `bun run typecheck:all`. Expect
  green.
- [x] **Step 4:** Commit: `feat(codex-byo): unified BYO endpoint form for codex and claude runtimes [C3]`

**Executor notes (2026-08-05):**
- **Entry point — one `custom_runtime` provider card, runtime chosen inside the
  form.** The brief left this open between "an advanced affordance on the two
  runtime cards" and "a separate Custom runtime endpoint method". The affordance
  was ruled out on a mechanical fact, not taste: the runtime cards route to
  `GatewayConnectStep`, which starts the SSO flow on mount and auto-advances, so
  a link there is only visible during a loading window or after an error. Two
  separate BYO cards (one per runtime) were the other candidate; one card wins
  because the extra logic is a single line in the flag filter, whereas two cards
  would have to add two derived ids to `ProviderFlagId` / `resolveProviderFlags`
  in shared feature-flags. The card is shown iff `nessy_codex || nessy_claude`,
  and the form offers only the runtimes that shipped (selector hidden when
  there is one, and locked entirely on the Edit path).
- **The exact gateway URL is REJECTED by the form**, not accepted with a notice.
  Two traps make it a broken connection rather than a redundant one: a
  `{kind:'nestor'}` upstream never reads the connection credential, so the key
  the user typed is silently ignored; and `canEditLlmConnection` would classify
  the result as the corp connection and hide its Edit form immediately after
  creation. Same host, different path stays allowed (AGENTS.md).
- **`canEditLlmConnection` now agrees with the transport.** The renderer twin
  `isNessyGatewayConnection` was a `startsWith` prefix match while
  `isNessyGatewayBaseUrl` (the classification the adapter actually runs on) is a
  whole-URL match — so `…/openai-like/v1/<anything>` was routed as BYO and
  locked from editing. Now normalized whole-URL on both sides.
- **Two adjacent defects fixed in passing, both on paths C3 makes reachable:**
  `getDefaultModelsForConnection('codex-runtime')` fell through to
  `ANTHROPIC_MODELS` while its sibling `getModelsForProviderType` already
  returned `[]` (T7 fixed only the claude arm); and `attachUpstreamCredential`
  silently produced a keyless target for a slugless BYO endpoint, which now
  throws. Both are covered by new rows.
- **Grouping predicate:** `isAdapterRuntimeProvider` (shared config) is the one
  place that names the two runtime provider types, used by the runtime
  signature, the setup-test driver resolution and the model seeding.

**C3 follow-up (2026-08-06): keyless BYO endpoints persisted the wrong authType.**
The form allows a keyless loopback endpoint (Ollama-class), but runtime
connections never carry `customEndpoint`, so they never reach
`resolveCustomEndpointSetup` — the only place keyless-loopback maps onto
`authType: 'none'`. The connection persisted as `api_key_with_endpoint` with no
stored key, which `validateStoredBackendConnection` reads as "No credentials
configured" and `CredentialManager.checkHealth` as `no_default_credentials` (a
standing re-authenticate banner whenever it is the default connection — a first
connection always is). Fix: `LlmConnectionSetup.authType`
(`'none' | 'api_key_with_endpoint'`), sent unconditionally by
`buildByoRuntimeSetup` (Edit path passes `hasStoredKey` from the masked prefill
so a blank-key edit stays keyed and an added key flips a keyless connection
back), applied in the SETUP handler via `resolveAdapterRuntimeAuthType` — scoped
to `isAdapterRuntimeProvider` + `isValidProviderAuthCombination` so a stray
payload can never override the pi/pi_compat/anthropic branches.

### Task C4: Packaged live smoke + focused regression

**Owner decision 2026-08-06 (delivered mid-C4): the coding runtimes ship by
default.** `NESSY_FEATURE_CODEX_RUNTIME` and `NESSY_FEATURE_CLAUDE_RUNTIME`
defaults flipped off→on in `feature-flags.ts` and all five build-script mirrors;
only the subscription cards (`PROVIDER_CLAUDE`, `PROVIDER_CHATGPT`) stay
flag-gated. C4's build therefore runs with NO flags — that build IS the
default artifact now, which is exactly what the smoke should measure.

- [ ] **Step 1:** Build (no flags — defaults now bundle both runtimes):
  `NESSY_DESKTOP_UPDATE_URL=https://updates.invalid/dev NESSY_DESKTOP_UPDATE_CHANNEL=dev CSC_IDENTITY_AUTO_DISCOVERY=false bash apps/electron/scripts/build-dmg.sh arm64`.
- [ ] **Step 2:** Smoke (add rows to `docs/testing/cdp-live-checklist.md`):
  1. Existing gateway codex card still works end-to-end (regression).
  2. BYO connection → our LLM proxy endpoint with the user's own key and a
     non-default model string (e.g. a deepseek id if served) — text turn + tool
     turn complete; traffic carries `Authorization: Bearer`, never `Nestor-Token`
     (adapter debug log / harness fetch capture).
  3. Stream-integrity spot-check (T3b behaviors on the codex path): kill the
     upstream mid-turn → codex surfaces an error, not a silent completed turn.
  4. **CLR-10 re-run trigger fires here** (claude-plan T8 ⚠️): with the C1 BYO seam,
     build the `/slow` rig (3s delay before first chunk on a local capture server —
     T8's `capture-server.ts` in its report shows the shape) through a codex BYO
     connection: deterministic `response.heartbeat` + completing turn = the
     tolerance claim end-to-end. Upgrade the CLR-10 checklist row from ⚠️.
  5. Codex turn with `model_max_output_tokens` configured — `max_tokens` now
     reaches the gateway (T3 mapping); confirm no 400/clamp surprise (claude-plan
     T8 smoke-line carry-over).
  6. BYO claude-runtime connection created through the NEW form (not hand-seeded):
     text turn completes via the adapter; Edit round-trip keeps providerType.
  Dark theme before any screenshot (standing owner rule); `rm -rf release` before
  the wave (AGENTS.md trap).
- [ ] **Step 3:** Regression: `bun run typecheck:all` + `apps/cli` typecheck,
  `bun run test:shared:all`, `bun test` (adapter package), i18n gates. Compare
  failures against the known-failing register and against `master`, not the branch
  base.
- [ ] **Step 4:** Commit evidence/docs:
  `test(codex-byo): packaged live smoke evidence [C4]`

### Task C7: Close-out

- [ ] **Step 1:** Bump version in BOTH `package.json` files (patch or minor per the
  shipped surface — BYO form is user-facing: minor), lockstep.
- [ ] **Step 2:** New `apps/electron/resources/release-notes/<version>.md`
  (append-only; match the in-app style).
- [ ] **Step 3:** docs-site: the T9 close-out of the Claude plan documented the
  Claude runtime and left the asymmetry visible — **the Codex runtime has ZERO
  docs-site coverage**. Document the codex runtime card AND the new BYO form for
  both runtimes (EN+RU), mirroring the Claude runtime pages' depth.
- [ ] **Step 4:** Tracker all-green in the same commit. Commit:
  `chore(release): <version> — BYO endpoints for codex and claude runtimes [C7]`

### Task C5 (Phase 2, ⏸ parked): `anthropic-messages` upstream kind

Unpark only on owner demand (a real user asking for direct Anthropic-format keys on
the Codex harness — note the product slot is partially covered already: Claude
runtime takes Anthropic keys natively, Pi takes `anthropic-messages` custom
endpoints).

- Vendor from opencodex **then-current HEAD** (not 16bef04): the cluster and its
  role per the 2026-08-04 comparison — `src/adapters/anthropic.ts` (~846 L, Messages
  outbound with extended thinking/budget/image guard),
  `src/responses/reasoning-envelope.ts` (thinking-signature round-trip through
  codex's `encrypted_content` slot — signature-less thinking replay 400s at
  Anthropic), the reasoning-replay branch of `src/responses/parser.ts` (~:333-351 at
  16bef04), and the `thinking_delta`/`thinking_signature`/`redacted_thinking`
  handling in `src/bridge.ts`. MIT; provenance headers as usual.
- Add `{ kind: 'anthropic-messages', baseUrl, apiKey }` to `UpstreamTarget`; route
  the outbound in `sendWithRetry`/client by kind (chat vs messages).
- Contract tests: thinking replay after a tool call does not 400; images guard;
  stop_reason mapping.
- Commit: `feat(codex-byo): anthropic-messages upstream (phase 2) [C5]`

### Task C6 (Phase 2, ⏸ parked): Anthropic-key live smoke

- Packaged build; BYO connection with a real Anthropic-format key (direct or an
  anthropic-compatible endpoint), multi-turn with tool calls (the thinking-signature
  round-trip is exactly what breaks after turn 1 if wrong).
- Commit: `test(codex-byo): anthropic upstream live smoke (phase 2) [C6]`

## Not doing (recorded so nobody re-files)

- **ChatGPT subscription auth inside codex-runtime** (`requires_openai_auth`,
  app-server `account/login/*` flows) — the product slot is already filled by the
  `chatgpt-plus` card on the Pi runtime; wiring ChatGPT OAuth through our embedded
  app-server is a separate, larger effort with no current demand.
- **Static `Nestor-Token` via codex `http_headers`** — works only for non-rotating
  credentials; our dp JWT rotates, auth stays in the adapter.
- **Replacing our adapter with an OSS one** — surveyed 2026-08-04: nothing beats the
  in-repo adapter for this stack; `MetaFARS/codex-relay` (Rust, MIT) is kept as a
  reference/test-oracle for event-sequencing questions.
