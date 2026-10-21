# Runtime Icons, Plate Alignment, BYO Model Sync

Status: EXECUTABLE — dispatched to builder 2026-08-14. Verified 3×,
re-verified 3× after §Adapter-audit growth, plus a dispatch-readiness pass
over lane D and the whole document (see §Verification Log).
Branch: `feat/models-fetch` (owner-created; execution continues here — do
NOT create a new branch)
Owner intent (2026-08-14): fix runtime icons everywhere they render, align the
above-composer plates with the design system, and start consuming model
metadata (display name, context window) from llm-proxy for BYO-key
connections. Executed autonomously by a builder agent; the planner reviews.

## Evidence base

- Icon-site map, plate diagnosis, surface inventory, icon-set research:
  workflow `wf_95008e79-499` (4 scouts + completeness critic), 2026-08-14.
- Model-metadata contracts: workflow `wf_25446ee7-a75` + live probes
  2026-08-14 — see memory `model-metadata-contracts` and
  `docs/superpowers/plans/` context below.
- llm-proxy deployed contract verified live: `GET https://llm-proxy.t-tech.team/models`
  (Bearer API key) → `data[]: {id, context_length, description, owned_by,
  criticality_level, default_tpm, max_tpm, eol, created, tenant}`; swagger
  `https://llm-proxy.t-tech.team/swagger/doc.json` matches repo
  `llm-platform/llm-proxy/docs/proxyapi_swagger.yaml`.

## Adapter audit — the decision it settles (2026-08-14, workflow `wf_8a20eb78-74d`)

Question: does a BYO llm-proxy connection need new wire adapters? **No.**
Evidence is a live sweep of all 383 catalog ids over
`POST /v1/chat/completions` plus source reading of the proxy, re-verified by
the planner on six representative ids.

- **The proxy translates nothing.** Its LLM surface is a `gin` NoRoute
  catch-all (`internal/api/proxy/server.go:114`); the body is round-tripped
  and the only edits are the `model` splice and
  `stream_options.include_usage`. Each provider whitelists its own paths:
  anthropic only `/v1/messages`, gemini only `:generateContent`, perplexity
  only `/chat/completions` with no `/v1`. A mismatch is a hard 400.
- **The catalog is a global directory, not an entitlement list.** Of 383
  ids: **27 → HTTP 200, 306 → HTTP 404 `quota not found`, 50 → 400.** The
  entitled 27 are 16 `tgpt/*`, 8 `openrouter/*`, 2 `xai/*`. Zero entitled in
  `openai/`, `azure/`, `cloud/`, `anthropic/`, `gemini/`, `perplexity/` and
  zero `openrouter/anthropic/*`.
- Therefore the three families we cannot speak to have **no entitled models
  at all**, and one OpenAI-Chat-Completions client reaches **27 of 27**.
  Gemini is already reachable through the entitled `openrouter/google/*`
  mirrors over plain chat completions (verified: HTTP 200).
- **opencodex has nothing worth porting here.** MIT, already vendored once
  (`packages/codex-responses-adapter/vendor/opencodex/UPSTREAM.md`), carries
  no GigaChat/Perplexity/t-tech provider, and its `openai-chat.ts` reasoning
  handling is structured-field only — it would not fix the `<think>` leak
  below, which our own `think-splitter.ts` already fixes.
- Do NOT build: an outbound Anthropic Messages adapter, a native Gemini
  adapter, a perplexity base-path variant, an OpenAI Responses upstream.

Consequences folded into the tasks: C1's filtering rules (below) were
CORRECTED by this audit; C6 (new) closes a real defect it measured.

## Non-goals

- No rebrand of Nessy marks (NessySymbol/NessyLogo shapes, app icns/ico/png,
  SessionViewer's duplicated `NessyLogo` with hardcoded `#9570BE`) — separate
  effort. The completeness critic mapped the full app-icon runtime pipeline
  for that future effort: `main/index.ts:446` dock.setIcon,
  `main/notifications.ts:218` badge round-trip,
  `renderer/hooks/useNotifications.ts:18` canvas redraw,
  `main/window-manager.ts:250` BrowserWindow icon, webui favicons
  (`#9570BE`), docs-site logo, tool-icon catalog render sites
  (`TurnCard.tsx:835`, `AppearanceSettingsPage.tsx:57`).
- No change to the 10 non-runtime BYO provider SVGs (aws/azure/google/…)
  beyond what A2 requires; they keep static assets and favicon fallbacks.
- No server-side work on the Nestor gateway, and no proposal to that team
  either (C4 CUT by owner 2026-08-14; the findings live in the
  `model-metadata-contracts` memory and §Evidence base).
- No effort/reasoning metadata from APIs — nothing serves it (verified in
  llm-proxy swagger + nestor/code-completion source); `supportsThinking`
  stays client-defined.
- No new wire adapters, and no port of opencodex provider adapters — see
  §Adapter audit for the measurement that settles this.
- Top-strip banner family (SafeModeBanner et al.) untouched — that shape was
  rejected 3× for sign-in surfaces (owner decision 2026-08-01, recorded at
  `PendingAuthNotice.tsx:15-28`).

## Design decisions (defaults an executor must not re-litigate)

1. **Icon delivery = inline TSX mono components with `fill="currentColor"`**,
   24×24 viewBox, following the existing `NessySymbol` pattern
   (`apps/electron/src/renderer/components/icons/NessySymbol.tsx`). Static
   `<img>` cannot inherit currentColor — this is why `pi.svg` renders black
   today. Source SVGs are ALREADY VENDORED at
   `docs/superpowers/plans/assets/2026-08-14-lobehub-mono/` (five files +
   SOURCE.md; `@lobehub/icons-static-svg@1.94.0`, MIT, Copyright 2023
   LobeHub) — copy path data from there; do NOT add the npm dependency and
   do NOT fetch from the network. Record source+license in a comment in
   each icon file.
2. **Mark assignment** (owner decisions 2026-08-14 — do not substitute the
   product-specific ClaudeCode/Codex marks; the recognizable brand marks won):
   - `claude-runtime` connections + the `nessy_claude` card → **Claude** mark.
   - `codex-runtime` connections + the `nessy_codex` card → **OpenAI** mark.
   - Built-in Nessy Gateway Pi connection (baseUrl starts with
     `NESTOR_CLI_BASE_PREFIX`) + the `nessy` card → **NessySymbol** (accent),
     replacing the OpenAI logo it shows today.
   - `nestor-cloud-agent` (remote) + the `nessy_cloud` card → **NessySymbol**,
     replacing the current thin `pi.svg`. Nessy branding therefore appears on
     exactly two integrations: the default Pi agent and remote.
   - `anthropic` (Claude Pro/Max) → Claude mark; `openai`/ChatGPT card →
     OpenAI mark (same shapes as today, but currentColor instead of a fixed
     fill, so dark theme works).
   - Plugin format badges: claude format → Claude mark, codex format →
     OpenAI mark, nessy format → NessySymbol; all switch from static `<img>`
     to the mono components.
   - **Pi (lobehub) mark — CONFIRMED (owner 2026-08-14).** `PiIcon` becomes
     the fallback mark for `pi`/`pi_compat` connections whose upstream
     provider the mapping cannot identify (today they fall through to the
     lucide Brain box). Resolution order in the `pi`/`pi_compat` branch:
     gateway baseUrl → NessySymbol; known provider →
     `piAuthProviderToIcon`/URL sniffing; favicon-listed providers → the
     existing Google-favicon fallback; otherwise → PiIcon (was: null/Brain).
     The old thin `apps/electron/src/renderer/assets/provider-icons/pi.svg`
     is then DEAD (single importer `provider-icons.ts`, its
     `nestor-cloud-agent` case moves to NessySymbol) — delete it in A2.
   - ClaudeCode and Codex marks are NOT used. Keep them out of the icon
     directory; the vendored SVGs stay in the plan assets for the record.
3. **Plate alignment = one shared gutter**, taken from the composer:
   `compactMode ? 'px-2' : 'px-3 @xs/panel:px-4'`, applied by ONE wrapper for
   the three plates (PendingAuthNotice, TaskChecklistPanel, AgentPanel) in
   `ChatDisplay.tsx`, plus `space-y-1.5` for the stack and keeping the
   existing `mt-1` on `ChatInputZone`. Message-list `px-5` stays (reading
   column ≠ control column). The `px-px` on `ActiveOptionBadges` stays (it
   exists for focus-ring clearance inside the composer zone).
4. **SystemCard extraction (B2) is in scope**: the chrome
   `rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-xs` is
   copy-pasted ×3 with a comment admitting it; consolidation is not new
   design. Slots: leading icon, `font-medium` title, `ml-auto` meta, body;
   destructive inline-error strip as an exported sub-block.
5. **BYO model sync is user-triggered first** (a "Fetch models" action in the
   custom-endpoint form) and persisted via the existing
   `updateLlmConnection(slug, { models })` path. The C3 auto-refresh toggle
   writes/clears `modelsSyncedAt`, which is the SOLE enrollment marker for
   the startup refresh loop (C2); `modelSelectionMode` is never consulted
   for enrollment. No Nestor-Token logic anywhere near this path
   (AGENTS.md: Nestor rewriting stays scoped to the verified gateway
   prefix).
6. **Sync semantics — the backend owns metadata, the user owns the
   selection** (owner intent 2026-08-14: "источник был бэкенд"). The catalog
   is 383 rows, so the user picks a subset at integration time; the daily
   refresh then does a KEYED MERGE, not a replace:
   - for each persisted model id still present upstream — overwrite
     `contextWindow`, `description` (and `name` if we ever get a display
     name) from the API; never resurrect a stale local value;
   - ids the user did not pick are NOT added, and picked ids that vanished
     upstream are NOT silently deleted — keep the entry and surface it (an
     `eol`/unavailable marker) so a session does not lose its model
     mid-flight;
   - user-owned fields — which models are in the list, which is default —
     are never touched by the refresh.
   The keyed merge is what makes the backend authoritative for metadata
   while keeping the picker to the handful of models the user chose.

## Step 0 — before any lane work

Commit the plan file + `docs/superpowers/plans/assets/2026-08-14-lobehub-mono/`
ALONE as `docs(plan): runtime icons, plates, model sync — plan + vendored
icon assets`. Both are untracked today; a worktree lane checks out only
committed files, so without this commit A1 finds no vendored SVGs (and
network fetch is forbidden), and the first task commit would sweep the plan
in as a side effect. All lanes start from this commit.

## Parallel lanes

Lanes are file-disjoint; run as parallel subagents in separate worktrees or
sequentially. i18n locale files (exactly two:
`packages/shared/src/i18n/locales/en.json`, `ru.json`) are touched ONLY in
lane C (C3). Playground registry files split: lane A touches
`registry/icons.tsx`, `registry/onboarding.tsx`, `registry/marketplace.tsx`;
lane B touches `registry/chat.tsx`, `registry/orchestration.tsx`,
`registry/pending-auth-notice.tsx`; lane C touches
`registry/api-key-input.tsx`. Lane D owns `packages/session-tools-core`,
`packages/shared/src/agent/plugin-management-tools.ts`,
`packages/shared/src/marketplace/service.ts`, `packages/shared/src/sources/`,
`packages/server-core/src/handlers/rpc/marketplace.ts` and `.../sources.ts`,
and `SessionManager.ts`, plus
`packages/shared/src/agent/claude-context.ts`,
`packages/shared/src/marketplace/proposal-registry.ts` (+ its tests) and
`packages/shared/src/marketplace/registry-source.ts` (no other lane touches
any of these; C3's handler file is `.../rpc/llm-connections.ts` — different
file, verified). D4 runs after D1-D3; D4/D5 share the checklist file — run
in sequence.
**Lane mechanics:** sequential on the execution branch is the DEFAULT for
an autonomous run. If parallel: each lane branches
`feat/models-fetch--lane-<a|b|c|d>` off Step 0's commit, flips only its own
tracker rows, and merges back into `feat/models-fetch` in lane order;
tracker-table conflicts are disjoint lines — resolve by union.
Lane Z runs last, after A+B+C+D merge. `registry/index.ts` is NOT expected to change
(no new categories; the Icons category already exists in `categoryOrder`,
index.ts:80); if a lane must edit it anyway, it takes the file exclusively
and says so in its tracker note. Cross-lane type constraint: lane A's
`registry/onboarding.tsx` imports `ApiKeySubmitData` from apisetup — any C3
change to that type MUST be an optional field so lane A's file stays
untouched.

**Screenshot evidence recipe** (used by every UI gate below): start the
playground with `bun run playground:dev` (vite, port 5173), open it in the
session's browser tooling, select the entry in the sidebar (selection
persists via localStorage; there is no URL deep-link), switch to DARK theme
first (standing preference), screenshot, then repeat in light. Live-app
screenshots are OWNER-OPTIONAL everywhere in this plan (they need a
dp-authed profile; playground evidence is the merge gate).

### Lane A — runtime icons

**A1 `feat(icons): mono runtime marks as inline components`**
Files: `apps/electron/src/renderer/components/icons/runtime/` (new:
`ClaudeIcon.tsx`, `OpenAiIcon.tsx`, `PiIcon.tsx`, `index.ts`).
Create THREE components only — `ClaudeIcon.tsx`, `OpenAiIcon.tsx`,
`PiIcon.tsx` (plus `index.ts`). No ClaudeCode, no Codex component: the
owner assigned the Claude and OpenAI brand marks to those runtimes.
Steps: TSX mono components (24×24, `fill="currentColor"`, `size` prop
defaulting `1em` — a new small API; NessySymbol has no size-prop precedent)
with paths from the VENDORED SVGs at
`docs/superpowers/plans/assets/2026-08-14-lobehub-mono/` (claude.svg,
openai.svg, pi.svg; the claudecode.svg/codex.svg files there stay unused).
Network fetch forbidden. Add playground entries in
`playground/registry/icons.tsx` (id per mark, size + `text-accent` knobs;
no registry/index.ts change — Icons category exists).
Gate: `bun run typecheck:electron`; playground marks per the Screenshot
evidence recipe (dark, then light).

**A2 `feat(icons): runtime-aware provider icon mapping`**
Files: `apps/electron/src/renderer/lib/provider-icons.ts`,
`apps/electron/src/renderer/components/icons/ConnectionIcon.tsx`,
`apps/electron/src/renderer/components/plugins/PluginOriginBadge.tsx`,
`apps/electron/src/renderer/components/plugins/__tests__/PluginOriginBadge.test.tsx`,
`packages/shared/src/auth/index.ts` (re-export only),
new mapping test beside provider-icons.ts (e.g.
`apps/electron/src/renderer/lib/__tests__/provider-icons.test.ts`).
Steps: extend the mapping result to
`{ kind: 'component', Component } | { kind: 'url', url }`; add cases:
`claude-runtime` → ClaudeIcon, `codex-runtime` → OpenAiIcon,
`anthropic` → ClaudeIcon, `openai`/`openai_compat` → OpenAiIcon,
`nestor-cloud-agent` → NessySymbol (was `pi.svg`); unknown-provider
`pi`/`pi_compat` → PiIcon instead of null (Brain stays the fallback only
for non-pi provider types); DELETE the now-dead
`assets/provider-icons/pi.svg`; in the
`pi`/`pi_compat` branch, return NessySymbol when the baseUrl is the
gateway's — the constants live in `packages/shared/src/auth/nestor.ts:1-4`
(`NESTOR_CLI_BASE_PREFIX`, `isNestorCliBaseUrl`) but are NOT re-exported
from `src/auth/index.ts`, and the package exports map has NO
`./auth/nestor` subpath — importing that subpath would typecheck green
(tsconfig path-maps to src/*) yet FAIL Vite module resolution at runtime.
Fix: re-export both from `packages/shared/src/auth/index.ts` (add that
file to this task's zone) and import from `@nessy-agent/shared/auth`.
Typecheck cannot prove the import resolves — the playground sweep is the
gate that would catch a bad path. ConnectionIcon
renders component-kind marks inline (mono inherits `text-foreground`; keep
`size` behavior and tooltip); url-kind keeps `<img>`. The union's
component type is pinned: `ComponentType<{ className?: string }>`;
ConnectionIcon sizes component-kind marks with its existing
`style={{width:size,height:size}}` wrapper. Do NOT edit NessySymbol.tsx
in THIS task (A4 owns it). PluginOriginBadge
switches its two `<img>` uses to ClaudeIcon/OpenAiIcon components.
KEEP: favicon fallbacks, Brain fallback for unknowns, existing exports.
Gate: `bun test apps/electron/src/renderer/components/plugins/__tests__/PluginOriginBadge.test.tsx`
+ the new provider-icons mapping test (component kind for the three runtime
providerTypes + gateway-pi override + url kind preserved for BYO providers);
`bun run typecheck:electron`. Playground sweep per the Screenshot evidence
recipe, including the mobile-webui demo
(`playground/demos/mobile-webui/mock-mobile-data.ts:243` feeds
MOCK_LLM_CONNECTIONS through ConnectionIcon). Live-app dropdown/settings
shots owner-optional. Absence claims (no leftover `<img>` for brand marks)
must use `rg -uuu` / `grep -ra` (NUL-byte trap).

**A3 `feat(icons): onboarding and settings provider cards use the marks`**
Files: `apps/electron/src/renderer/components/onboarding/ProviderSelectStep.tsx`,
`apps/electron/src/renderer/playground/registry/onboarding.tsx`,
`apps/electron/src/renderer/playground/registry/marketplace.tsx`.
Steps: replace direct `claude.svg`/`openai.svg` `<img>` imports with
ClaudeIcon/OpenAiIcon; differentiate the gateway cards: `nessy` +
`nessy_cloud` keep NessySymbol, `nessy_claude` → ClaudeIcon,
`nessy_codex` → OpenAiIcon (runtime identity over uniform branding — this is
the "сейчас не совсем понятно" complaint). Sweep playground onboarding +
marketplace entries; verify PROVIDER_ICONS map has no leftover `<img>` for
brand marks (`rg -uuu` for the absence claim).
Gate: playground ProviderSelectStep + marketplace entries per the
Screenshot evidence recipe; `git diff --check`.

**A5 `chore(icons): playground shows all provider cards; drop orphaned brand SVGs`**
(added during execution 2026-08-14 — two A3 findings, planner-approved.)
Why: (1) the playground `provider-select-step` entry gates cards through the
mocked `getProviderFlags`, whose default hides four of the six cards A3
changed — the canonical entry cannot display the very states this lane
exists to fix, violating the playground-as-design-surface mandate ("extend
canonical entries with knobs for new states"). (2) After A2+A3,
`assets/provider-icons/claude.svg` and `openai.svg` have ZERO importers
(builder-measured, planner re-verified) — dead assets.
Files: `apps/electron/src/renderer/playground/registry/onboarding.tsx`, the
playground's electronAPI mock (builder located it during A3 — record the
exact file in the tracker note), and `git rm` of the two orphaned SVGs.
Steps: give the entry an "all providers visible" state — either a knob/
variant that overrides the mocked `getProviderFlags`, or an all-on preset
in the mock wired to this entry; sweep it dark then light. Delete the two
SVGs; re-run the absence check (`rg -uuu` for both filenames — zero hits
outside `.references/` and git binaries).
Gate: `bun run typecheck:electron`; playground provider-select-step shows
all seven cards with the new marks in both themes.

**A4 `fix(icons): NessySymbol carries its accessible name`**
(added during execution 2026-08-14 — pre-existing a11y hole found by the
builder in A2, planner-approved as a row: `PluginOriginBadge.tsx:57`
passes `aria-label={label}` to NessySymbol, which accepts only
`className`, so the nessy badge has rendered with NO accessible name since
it shipped.)
Files: `apps/electron/src/renderer/components/icons/NessySymbol.tsx`,
`apps/electron/src/renderer/components/plugins/__tests__/PluginOriginBadge.test.tsx`
(one assertion).
Steps: mirror the A1 components' pattern — accept an optional
`'aria-label'` prop, set `role="img"` when it is present; no other API
change. Add the badge-test assertion that the nessy format badge exposes
`aria-label="Nessy"` (or the actual label string used).
Gate: `bun test apps/electron/src/renderer/components/plugins/__tests__/PluginOriginBadge.test.tsx`
+ `bun run typecheck:electron`.

### Lane B — plate alignment

**B1 `fix(chat): plates share the composer gutter`**
Files: `apps/electron/src/renderer/components/app-shell/ChatDisplay.tsx`,
`apps/electron/src/renderer/components/app-shell/input/ChatInputZone.tsx`,
`packages/ui/src/lib/layout.ts`,
`apps/electron/src/renderer/components/app-shell/__tests__/PendingAuthNotice.test.tsx`
(CORRECTED during execution, rule-8 stop: that test's width-contract
assertion pins the OLD three-wrapper `px-3` string verbatim ×3 —
`PendingAuthNotice.test.tsx:151,171-176` — i.e. B1's own gate asserted the
structure B1 deletes while the file sat in B2's zone. The contract pin
co-evolves with the contract IN THIS COMMIT: pin the shared wrapper
expression (`CHAT_LAYOUT.controlGutterCompact : CHAT_LAYOUT.controlGutter`)
occurring ONCE in ChatDisplay, with all three plates inside that one
wrapper window; keep the not-inside-ScrollArea and no-strip controls
untouched. This is a strictly stronger contract — it fails if the plates
and the composer ever drift apart, which is the product complaint itself.
B2 re-pins the same test onto SystemCard when it lands.)
Steps: add to `CHAT_LAYOUT` two constants — `controlGutter:
'px-3 @xs/panel:px-4'` and `controlGutterCompact: 'px-2'` (px ONLY — no
pb; keep comments pointing at ChatInputZone as the source of truth).
Replace the three per-plate wrapper divs (ChatDisplay.tsx ~2321/2331/2339)
with ONE wrapper `cn(CHAT_LAYOUT.maxWidth, 'mx-auto w-full space-y-1.5
empty:hidden', compact ? CHAT_LAYOUT.controlGutterCompact :
CHAT_LAYOUT.controlGutter)` around the three plates — `empty:hidden` is the
pinned collapse mechanism (plates render null internally; the wrapper has
no vertical padding so it is 0-height when empty anyway). In
ChatInputZone.tsx line ~155 split the fused ternary so padding-bottom stays
local: `cn(compact ? CHAT_LAYOUT.controlGutterCompact :
CHAT_LAYOUT.controlGutter, compact ? 'pb-3' : 'pb-4')` (no visual change —
same values).
Gate: `bun test apps/electron/src/renderer/components/app-shell/__tests__/PendingAuthNotice.test.tsx`
`.../AgentPanel.test.tsx` `.../TaskChecklistPanel.test.tsx`; playground
sweep of `pending-auth-notice`, `agent-panel`,
`orchestration-task-checklist`, `input-container`, `active-option-badges`
(incl. the "All ready (renders nothing)" state) per the Screenshot
evidence recipe, normal + compact; left edges of plate/chip-row/composer
aligned in the shots.

**B2 `refactor(ui): SystemCard primitive for the plate family`**
Files: `apps/electron/src/renderer/components/ui/system-card.tsx` (new),
`PendingAuthNotice.tsx`, `AgentPanel.tsx`, `TaskChecklistPanel.tsx`,
`apps/electron/src/renderer/components/app-shell/__tests__/PendingAuthNotice.test.tsx`,
`playground/registry/pending-auth-notice.tsx`,
`playground/registry/chat.tsx`, `playground/registry/orchestration.tsx`.
FIRST (execution finding, B1): the `agent-panel` playground entry crashes
the WHOLE playground on its base state — `AgentPanel.tsx:56` maps over
`rows === undefined` because `chat.tsx` supplies rows only via `variants`,
and the playground mounts no error boundary (pre-existing; reproduced at
HEAD with the B1 diff stashed). Fix as part of this task: add `rows: []`
to the entry's `mockData` (base state = empty panel) so the entry is
sweepable — B1's sweep was recorded as 4/5 because of this.
Steps: extract the shared chrome (`rounded-lg border border-border/60
bg-muted/30 px-3 py-2 text-xs`) + header-row pattern into `SystemCard`
(props: `icon?`, `title`, `meta?`, `children`, `className` merge —
PendingAuthNotice appends ` select-none` to the otherwise-identical string —
and `role`/aria passthrough); rebase the three plates; delete the
"copied from" comments (one cites a stale `AgentPanel:183`); update the
class-string test to read the primitive; extend the three playground
entries' descriptions to name SystemCard (design-surface rule: sweep ALL
states, add knobs only if a state became reachable).
Gate: same test set as B1 rerun on the final lane diff; playground sweep;
no visual diff vs B1 screenshots (chrome strings identical).

### Lane C — BYO model sync from llm-proxy

**C1 `feat(models): OpenAI-compatible model fetcher`**
Files: `packages/server-core/src/model-fetchers/openai-compat.ts` (new),
`packages/server-core/src/model-fetchers/__tests__/openai-compat.test.ts`
(new — the package's tests live in `__tests__/`, next to `nestor.test.ts`).
Steps: `fetchOpenAiCompatModels(connection, credentials)` — GET
`${baseUrl}/models` with `Authorization: Bearer ${credentials.apiKey}`,
`redirect: 'error'`, `AbortSignal.timeout(3000)` (mirror nestor.ts safety
comments); accept BOTH `{data: [...]}` and bare-array bodies; map
`id → id`, `name = id`, `description ← description`, `contextWindow ←
context_length | contextWindow | context_window` (positive finite int);
spread previously-persisted per-model overrides FIRST, then write explicit
fields (the nestor.ts:69 discipline — API fields after the spread). Return
`{ models }` (no serverDefault — endpoint has none).
FILTERING — read this before writing any filter (an earlier revision of
this plan got it wrong; corrected by the live sweep in §Adapter audit):
- **NEVER filter on `context_length <= 1`.** 68 rows carried it when this plan
  was written (measured 2026-08-14); **re-measured 2026-08-28 it is 63 of 387,
  plus 2 more under 1024** — the rule is unaffected, the count is not a standing
  fact about a catalogue that changes weekly, and this is the fourth site the
  original 68 reached (see P3.92 / P3.159). It means
  "unfilled", not "classifier": the set includes real chat models
  (`tgpt/qwen3-vl-235b-instruct`, `tgpt/gemma-4-31b-it`,
  `tgpt/nlp-platform-qwen3-235b-a22b-instruct-2507-fp8`). Dropping them
  would hide working models.
- Embeddings: an id-substring filter (`text-embedding`) is an OPTIONAL
  display nicety, not a safety requirement — the proxy rejects them itself
  (`tgpt/text-embedding-bge-m3` → HTTP 400 `invalid model type`, verified
  live). The catalog does not serialize `model_type`
  (`internal/api/proxy/api/models.go:58-72`), so no principled type filter
  is possible client-side. Keep the heuristic out of the fetcher; if the
  picker wants it, do it at display time.
- **CONTEXT-WINDOW SANITY FLOOR (required).** Treat `context_length < 4096`
  as absent and fall back to the existing default rather than writing it —
  a window of 1 would poison the auto-compaction arithmetic (same class as
  the `NESSY_AUTO_COMPACT_WINDOW` trap in AGENTS.md).
Carry `owned_by` onto the ModelDefinition ONLY if C3 uses it for grouping;
otherwise do not widen the shared type.
Tests: happy path with llm-proxy-shaped payload (context_length flows to
contextWindow), bare-array payload, non-OK status throws, redirect rejects,
override-precedence (stale persisted contextWindow replaced by API value;
unknown persisted extras survive), and the sanity floor (a
`context_length: 1` row SURVIVES as a model but gets no contextWindow) —
use the real shapes recorded in C5. Test file lives in the existing
`packages/server-core/src/model-fetchers/__tests__/` next to
`nestor.test.ts`.
Gate: `bun test packages/server-core/src/model-fetchers` +
`cd packages/server-core && bun run typecheck`.

**C2 `feat(models): enroll BYO endpoints in the model refresh (24h TTL)`**
Files: `packages/server-core/src/model-fetchers/index.ts`,
`packages/server-core/src/model-fetchers/__tests__/service.test.ts`,
`packages/shared/src/config/llm-connections.ts`,
`packages/shared/src/config/validators.ts`,
`packages/shared/src/config/storage.ts`.
New field: optional `modelsSyncedAt?: number` (epoch ms) — mirror
`modelSelectionMode`'s three sites: the type (llm-connections.ts:171
area), the validator (validators.ts:91 area), and the update-merge
allowlist (storage.ts ~2586/2631 — a field missing from that allowlist is
silently dropped on update).
`modelSelectionMode` itself is already persisted — no change there.
Credentials already flow: the refresh service takes a CredentialResolver
(index.ts:33,45) wired in `packages/server/src/index.ts:250-262` to
`getCredentialManager().getLlmApiKey(slug)`, surfacing as
`credentials.apiKey`.
Steps: in the refresh loop where compat providers are skipped except
`isNestorConnection` (index.ts:86-89), add: `pi_compat` connections that
carry a `customEndpoint` with `api === 'openai-completions'` AND a
`modelsSyncedAt` stamp (the opt-in marker written by C3) refresh via
`fetchOpenAiCompatModels`.
**BOTH skip gates must open, or the feature never runs at startup:**
besides the `_doRefresh` compat-skip (index.ts:86-89), `startAll()`
(index.ts:180-205) independently `continue`s past compat non-Nestor
connections at :183 and at :187 — let stamped openai-completions
`pi_compat` connections through BOTH (startup fetch only, no periodic
timer — matches the 24h TTL); `refreshNow()`'s compat early-return at
:229 stays (it only guards timers). `MODEL_SYNC_TTL_MS` lives beside the
other interval constants at the top of `model-fetchers/index.ts`.
Mechanism past gate :187: execution reaches
`fetcher.refreshIntervalMs` at :203 where `this.fetchers['pi_compat']` is
undefined today — a naive gate-opening TypeErrors at every startup. Either
register the openai-compat fetcher in `this.fetchers` under a `pi_compat`
key with `refreshIntervalMs: 0` (gate :187 then opens by itself and the
timer branch stays inert; `FetchableProvider` may need to admit
'pi_compat'), or guard :203 with `fetcher &&`. The startAll-driven test
must also assert NO timer is scheduled for the stamped BYO connection.
**MERGE, NEVER REPLACE — this differs from the Nestor path by design.** The
user's selected list is the source of truth for WHICH models the connection
has; the backend is the source of truth for their METADATA. The refresh
matches persisted `connection.models` ids against the fetched catalog and
updates `contextWindow`/`description` in place (and `name` only when it is
id-derived); catalog rows the user did not select are IGNORED (383-row
catalogs must never land in `connection.models` wholesale); selected rows
missing from the catalog stay untouched. `modelSelectionMode` is NOT
consulted for enrollment and stays whatever the form wrote
(`userDefined3Tier` for a hand-pruned list — ApiKeyInput.tsx:465-467
unchanged).
SCOPE PINS (verified on HEAD — do not widen):
- `customEndpoint.api` is a two-value union, `'openai-completions' |
  'anthropic-messages'` (`llm-connections.ts:112`). Only the former
  gets this fetcher: an Anthropic-shaped `/v1/models` returns
  `{data:[{id, display_name, created_at}]}` with NO context length, so it
  would add nothing. Skip `anthropic-messages` endpoints silently.
- The API key is OPTIONAL, not required: a local endpoint (Ollama card,
  `authType: 'none'`) serves `/v1/models` unauthenticated. Send the
  `Authorization` header only when `credentials.apiKey` is truthy; do not
  gate enrollment on it.
- The `userDefined3Tier` early-return at index.ts:150 is scoped to
  `providerType === 'pi'` and does NOT cover `pi_compat`. Leave it exactly
  as it is — the keyed merge above lives on the pi_compat path only.
SYNC CADENCE (owner decision 2026-08-14): the
refresh runs at app startup only (existing behavior) AND skips the
connection when `Date.now() - modelsSyncedAt < MODEL_SYNC_TTL_MS`
(constant, 24h) — net effect: at most one catalog fetch per day, zero
during normal operation (runtime always reads the persisted list). Every
successful fetch (here and in C3) writes `modelsSyncedAt`. Failure = keep
stale list AND stale timestamp (retry next startup). Nestor path untouched
— no TTL there (its cadence is an existing product behavior; changing it is
out of scope).
Tests (in service.test.ts): a stamped BYO connection merges metadata for
matching ids WITHOUT changing the id set (catalog-only rows do not appear;
user rows absent from the catalog survive); an unstamped connection is
skipped; fresh `modelsSyncedAt` (<24h) skips the fetch; stale (>24h)
fetches and rewrites the timestamp; an `anthropic-messages` custom endpoint
is skipped; a keyless (Ollama-shaped) endpoint still fetches, without an
Authorization header; Nestor connection still uses fetchNestorModels;
`nestor-cloud-agent` still returns early (index.ts:76); and a
startAll()-driven case — a stamped BYO connection fetches at startup
(both `continue` gates open).
Gate: `bun test packages/server-core/src/model-fetchers` +
`cd packages/server-core && bun run typecheck`.

**C3 `feat(apisetup): fetch models from the endpoint in the BYO form`**
Files: `apps/electron/src/renderer/components/apisetup/ApiKeyInput.tsx`
(the BYO form: `customEndpoint` at line ~56, `resolveCustomEndpointPayload`
~450, submit ~468), `apps/electron/src/renderer/components/apisetup/byo-runtime.ts`
(authType mapping ~185, read-mostly),
`packages/server-core/src/handlers/rpc/llm-connections.ts` (handler of
`RPC_CHANNELS.settings.TEST_LLM_CONNECTION_SETUP`,
`packages/shared/src/protocol/channels.ts:233`),
`packages/shared/src/protocol/dto.ts` (result type),
`apps/electron/src/renderer/playground/registry/api-key-input.tsx`,
`packages/shared/src/i18n/locales/en.json`, `ru.json`.
PINNED DESIGN: NO new RPC channel. Extend `TEST_LLM_CONNECTION_SETUP` with
an optional request flag (e.g. `fetchModels?: true`) and an optional
`models?: ModelDefinition[]` in its result — this avoids touching
channel-map.ts / shared/types.ts /
`apps/electron/src/transport/__tests__/channel-map-parity.test.ts`
entirely (verified: optional DTO fields on TestLlmConnectionParams/Result,
dto.ts:784/807, touch none of them). Label collision warning: dto.ts
already carries a `runtimeProviderType` field whose comment cites "C3" —
that is the Codex-BYO plan's C3 (a prior release), NOT this task; ignore
it, this task only ADDS the optional `fetchModels`/`validateModels`/`models`
fields. The
handler runs `fetchOpenAiCompatModels` against the payload's baseUrl+key.
Steps: add a "Fetch models" button that calls the extended RPC and
populates the form's model list (user can prune).
SCALE + HONESTY: the endpoint returns 383 rows, but on the owner's account
only 27 are actually usable (306 answer `quota not found`) — see §Adapter
audit. The fetched list is a CATALOG, not an entitlement list: present it
as "models this endpoint publishes", searchable and grouped by `owned_by`,
and let the user prune. Do NOT label it "available", and do NOT probe all
383 ids to find out (that is 383 requests). A model that turns out to be
unentitled surfaces as a normal request error at use time.
Never render 383 rows as a flat comma-separated string: keep the fetched
catalog in a selectable panel; write only the chosen ids into the field.
PICKER COMPOSITION IS PINNED — build it from existing primitives, no new
ones (owner rule "своего ничего писать не нужно"):
`EntityList` (`components/ui/entity-list.tsx` — grouped layout, groups =
`owned_by`, collapsible with item count, header slot documented "e.g.
search bar" takes an `Input`, footer slot free) + `EntityRow`
(`entity-row.tsx` — multi-select styling built in; selection state lives in
the form, per the component's own contract) + `EntityListBadge`
(`entity-list-badge.tsx`) for the per-model probe verdict + the
`entity-list-empty` empty state. The pattern is the proven Sources/Skills
list (playground `entity-list-sources` / `entity-list-interactive`). Add an
"auto-refresh model metadata" toggle whose ONLY effect is the
`modelsSyncedAt` stamp: on = stamp now (enrolls the connection in C2's
daily metadata merge), off = clear the stamp. The existing
`modelSelectionMode` auto-submit logic at ApiKeyInput.tsx:465-467 stays
UNTOUCHED — a hand-pruned list keeps meaning 'userDefined3Tier'.
VALIDATION OF SELECTED MODELS (in scope): extend the same RPC with an
optional `validateModels: string[]` — the probe is a helper beside
`fetchOpenAiCompatModels` in `openai-compat.ts`: non-streaming
`POST {baseUrl}/chat/completions`, `max_tokens: 1`,
`AbortSignal.timeout(10000)`, classify 200→`ok` / 404→`no-quota` /
else→`error`; the RPC handler calls it directly — NEVER through
`testBackendConnection` (the 45s agent-subprocess test is the wrong
vehicle). The picker renders the verdict next to each SELECTED model. Probe only user-selected ids (a handful), NEVER
the whole catalog. This answers "which of these do I actually have" without
pretending the catalog is an entitlement list.
Manual entry stays the fallback. Any
`ApiKeySubmitData` change MUST be an optional field (lane A's
registry/onboarding.tsx imports the type). Extend the playground
`api-key-input.tsx` Custom-preset entry with knobs for the
fetched-models/sync-toggle states and sweep it.
Gate: `bun run lint:i18n:parity && bun run lint:i18n:sorted`; focused form
test (button populates models from mocked RPC); `bun run typecheck:electron`
+ `cd packages/server-core && bun run typecheck`; playground api-key-input
sweep per the Screenshot evidence recipe.

**C6 `fix(pi): reasoning split and Qwen dialect key off model id, not URL`**
(confirmed in scope by owner 2026-08-14 — one plan for everything)
Files: `packages/pi-agent-server/src/gateway-proxy/nestor-reasoning-proxy.ts`,
`packages/pi-agent-server/src/gateway-proxy/tool-schema-dialect.ts`,
`packages/pi-agent-server/src/index.ts` (proxy-creation gate `shouldProxy`
at :1246 inside applyNestorReasoningProxy :1243-1263;
`gatewayRuntimeActive()` at :850-857),
`packages/pi-agent-server/src/gateway-proxy/nestor-reasoning-proxy.test.ts`,
`packages/pi-agent-server/src/gateway-proxy/tool-schema-dialect.test.ts`.
Why (measured live 2026-08-14): a BYO connection pointed at llm-proxy and
running `tgpt/qwen35-397b-a17b-fp8` returns assistant content starting
`<think>Thinking Process:…` — raw reasoning leaks into the answer. The
splitter exists and is shared, but on the Pi path it is gated on the
gateway URL, so a BYO connection to the SAME models does not get it. The
`codex-runtime`/`claude-runtime` path already splits unconditionally
(`from-chat-stream.ts:48`, `from-chat.ts:10`) — this task brings pi_compat
in line.
PINNED DESIGN — a naive "re-key everything to model id" BREAKS BYO AUTH;
the four points below are the task (caught in plan verification):
1. Proxy creation (`shouldProxy`, index.ts:1246): start the proxy when
   `customEndpoint.api === 'openai-completions'` AND
   (`isNestorGatewayUrl(baseUrl)` OR the connection's model set intersects
   `NESTOR_GATEWAY_QWEN_MODELS`) — a UNION, so gateway connections keep
   today's splitting for every model while BYO-Qwen gains it.
2. **The `Authorization: Bearer` → `Nestor-Token` swap becomes EXPLICITLY
   gateway-keyed.** Today the swap in `upstreamHeaders`
   (nestor-reasoning-proxy.ts:313-317) is UNCONDITIONAL and only
   implicitly gateway-only (the proxy never runs elsewhere) — the function
   does not even receive the upstream base URL. C6 threads
   `upstreamBaseUrl` (or the handle's `isGatewayUpstream` flag from point
   3) into `upstreamHeaders` and wraps the swap in `isNestorGatewayUrl(…)`.
   Running the proxy on BYO URLs WITHOUT adding this condition strips the
   Bearer key and 401s every BYO request — this is the load-bearing edit
   of the task.
3. The gateway 429 retry ladder stays gateway-only: add an
   `isGatewayUpstream` flag to `NestorReasoningProxyHandle` and re-key
   `gatewayRuntimeActive()` (index.ts:850-857) to that flag, not to "a
   proxy handle exists".
4. Split + dialect fire PER-REQUEST off `body.model` inside `proxyRequest`
   (the body is already parsed there): apply when `body.model ∈
   NESTOR_GATEWAY_QWEN_MODELS` — in `adaptToolRequestForDialect` drop only
   the URL clause, keep its existing model check. Do NOT widen the dialect
   to all models: the schema weakening is a quality mitigation for two ids,
   not a protocol requirement (verified live — strict schema and forced
   `tool_choice` work unadapted through llm-proxy).
Tests (per-request semantics): Qwen `body.model` on a non-gateway base URL
→ split applied AND `Authorization` header survives (no Nestor-Token);
non-Qwen `body.model` on the same connection → untouched; gateway URL →
swap + split for any model (no regression); `gatewayRuntimeActive()` is
false for a BYO-Qwen proxy handle; dialect keyed identically.
Gate: `bun test packages/pi-agent-server/src/gateway-proxy`; typecheck the
touched test files explicitly (the package tsconfig excludes
`**/*.test.ts` — AGENTS.md hole). RECIPE CORRECTED (D7 executor, 2026-08-14
— the bare-flags command that used to sit here omits `--target`, so tsc
downlevels and emits 20+ phantom TS2802/TS1501 errors from unrelated code;
C6's two files merely happened not to trip it): write a temp config INSIDE
the package that `extends: "./tsconfig.typecheck.json"`, `include`s the
test files, and drops the `**/*.test.ts` exclude — it inherits
target/strict/paths from the base. `bunx tsc --noEmit -p <that config>`,
then delete the temp config; never commit it.

**C4 — CUT (owner decision 2026-08-14).** A proposal to the Nestor team was
dropped: "мы не можем на них влиять". The findings stay recorded in the
memory note `model-metadata-contracts` and in §Evidence base above; our
client already parses `contextWindow|context_window|context_window_tokens`
(`nestor.ts:84-89`), so if that team ever ships the field it needs no work
here.

**C5 — DONE 2026-08-14 (planner, pre-dispatch).** Owner supplied a personal
llm-proxy API key; `GET https://llm-proxy.t-tech.team/models` with
`Authorization: Bearer <key>` returned HTTP 200, `object: "list"`, **383
models, every one carrying `context_length`**. Field set exactly as
specified: `id, context_length, description, owned_by, criticality_level,
default_tpm, max_tpm, eol, created, tenant`. Families by id prefix:
openrouter 121, tgpt 110, cloud 88, openai 22, gemini 12, anthropic 11,
azure 10, xai 5, perplexity 4. Context windows range 1 … 2 000 000 (34
distinct values); `criticality_level` ∈ {OP 194, BO 117, ZERO 71, BC 1};
4 rows carry an `eol` date. Sample row shapes for C1's fixtures:
`tgpt/qwen35-397b-a17b-fp8` ctx 262144 crit BO,
`anthropic/claude-opus-5` ctx 1000000 crit OP,
`tgpt/text-embedding-bge-m3` ctx 8192 (embedding),
`tgpt/context-intents-summ` ctx 1 (classifier stub).
The key was used read-only and is NOT stored in the repo.
**Two consequences for C1/C3:**
(a) SUPERSEDED by §Adapter audit — the filter this line originally mandated
is now FORBIDDEN; C1's FILTERING block is authoritative (`context_length
<= 1` rows are kept — they include real chat models; the embedding
id-filter is an optional display-time nicety; the mandatory piece is the
<4096 sanity floor on `contextWindow` only);
(b) 383 entries need search/grouping in the picker, not a flat list — group
by the `owned_by` field the API already returns.

### Lane D — agent-driven install gaps

Provenance: owner 2026-08-14 ("этот план — корректировка всего"); source =
audit `wf_2b80baed-a80`, whose skeptic re-verified every anchor by reading
the code; planner re-checked the four load-bearing lines on HEAD.

Background: the agent-driven install path is CORRECT w.r.t. wire names (no
changes needed — same service instance, same normalizer, names minted only
at resolve). Lane D closes the three functional gaps the audit recorded.
Codex is out of scope for all three: the whole session-tool surface is
gated off there by design (`SESSION_TOOLS_REQUIRING_HOST_CALLBACK`,
tool-defs.ts:1167).

**D1 `fix(agent): agent plugin install acquires dependencies like the UI`**
Files: `packages/shared/src/agent/plugin-management-tools.ts` (install at
:199, deps type `PluginManagementMarketplaceApi` at :60),
`packages/shared/src/marketplace/service.ts` (install wrapper +
`acquireDependencies` at :181-330),
`packages/shared/src/marketplace/proposal-registry.ts` (+ its
`__tests__/proposal-registry.test.ts`),
`packages/server-core/src/sessions/SessionManager.ts` (deps field type at
:2310), plus the existing tests beside each.
Today the agent path calls `deps.pluginManagement.install` directly,
entering BELOW `MarketplaceService.install` — so a plugin with declared
dependencies installs but sits disabled until deps are hand-installed, and
hub items lose `connectorAuthTiming`/`catalogAuthenticationPolicy`.
Steps: route the agent install through `MarketplaceService.install`
(MarketplaceInstallRequest accepts a bare `source`, so the
proposal-consume contract survives: consume → source →
`service.install({source, activateIn})`). Two supporting edits the naive
reading misses: (a) the proposal does NOT carry the catalog item today
(ProposalRecord = clientId/source/displaySource/detectedFormat/
diagnosticCodes only) — extend IssueProposalInput/ProposalRecord to carry
`connectorAuthTiming`/`catalogAuthenticationPolicy` at issue time in
planInstall's marketplaceItemId branch and return them from `consume`;
(b) widen `PluginManagementMarketplaceApi`
(Pick<MarketplaceService,'proposeInstall'|'inspect'>, both files) to
include `'install'` — hosts already pass the full service, only the type
narrows.
Tests: agent-install a fixture plugin declaring a dependency → BOTH appear
in `status()` as installed+enabled (mirror the UI enable-cascade test).
Gate: `bun test packages/shared/src/agent` (focused files) +
`cd packages/shared && bun run typecheck`.

**D2 `fix(agent): plugin_plan_install resolves BYO-registry listings`**
Files: `packages/shared/src/agent/plugin-management-tools.ts` (hub lookup
at :153 — `marketplaceService.inspect` only),
`packages/server-core/src/handlers/rpc/marketplace.ts` (the UI fallback to
share: `requireRegistrySource().findCatalogItem` at :142/:207),
`packages/server-core/src/sessions/SessionManager.ts` (deps binding
:14454-14461 — the registry source is already passed as
`marketplaceCatalogReader`).
Add `packages/shared/src/marketplace/registry-source.ts` to the zone: the
agent deps see the `CachedMarketplaceCatalogReader` type (:365), which
exposes only `peekCachedItems()` — add `findCatalogItem` to it (cache-only
by design, :599-620: no fetch, no retry-budget spend — consistent with the
narrowing rationale at plugin-management-tools.ts:69-76).
Steps: extract the UI's listing-resolution fallback into a shared helper —
it lives in `packages/shared/src/marketplace/` (e.g.
`listing-resolution.ts`) and takes the catalog reader as a parameter
(dependency direction: server-core imports shared, never the reverse;
SessionManager already injects `marketplaceCatalogReader`, the server-core
handler passes `requireRegistrySource()`) — and use it in the agent's
planInstall, so `<registryId>:<name>` ids stop 404ing against the
Skills-Market client. Record the helper's final file in the tracker note.
Tests: planInstall with a stubbed BYO-registry item id returns an
installable proposal; Skills-Market ids keep working.
Gate: same as D1 + `bun test packages/server-core` (focused files).

**D3 `feat(agent): source disable/remove tool with the UI's cleanup`**
Files: `packages/session-tools-core/src/tool-defs.ts`,
`packages/session-tools-core/src/handlers/` (new handler beside
source-test.ts), `packages/shared/src/sources/` (extract the DELETE
cleanup into a shared helper), `packages/server-core/src/handlers/rpc/sources.ts`
(DELETE at :38-52 — today it does `deleteSource` + workspace-defaults
cleanup + snapshot invalidation; the UI channel switches to the shared
helper), `packages/shared/src/agent/claude-context.ts` (binding),
`packages/server-core/src/sessions/SessionManager.ts` (callback wiring,
mirror source_test's).
Why: today an agent asked to remove a source can only raw-edit files,
forking the UI DELETE channel's cleanup — the exact "two writers" shape
the wire-names work existed to kill.
Steps: one tool `source_manage {slug, action: 'disable'|'remove'}`;
`disable` flips `enabled:false` via the shared validated
`saveSourceConfig` (already bound as ctx.saveSourceConfig,
claude-context.ts:269-271); `remove` calls the extracted DELETE helper.
The UI DELETE cleanup is exactly THREE operations — enumerate them so "the
same cleanup set" is testable: (1) `deleteSource(workspaceRootPath, slug)`
from `@nessy-agent/shared/sources`; (2) strip the slug from
`workspace.config.defaults.enabledSourceSlugs` via
`workspaceService.updateSettings`; (3) capability-change notification with
`revoke-active-snapshot`. Op (3) takes the RPC server handle, so the
shared helper accepts an injected notify callback: the RPC channel passes
its server-bound one, the agent path passes the SessionManager-bound
invalidation (the callback wiring this task already mirrors from
source_test).
Both actions require the host callback (auto-gated off on Codex via
`SESSION_TOOLS_REQUIRING_HOST_CALLBACK`). Approval semantics — PINNED,
mode-dependent: `safeMode: 'block'` plus the NORMAL permission-gate ask;
in auto/dontAsk modes the tool runs unprompted like any other approved
tool (no bespoke always-ask floor exists for registry session tools, and
this task does not build one — a "never silent" guarantee would require
new permission-gate machinery out of scope here). Server resolves scope
from the session, never client-supplied (source_test precedent).
Tests: disable persists enabled:false through the validated writer; remove
runs the same three-op cleanup as the RPC channel (assert via the shared
helper, not a copy; notify seam invoked); Codex context exposes neither
action.
Gate: `bun test packages/session-tools-core packages/shared/src/sources`
(focused) + package typechecks.

**D4 `test(live): agent-driven install smoke on the CDP rig`**
Files: `docs/testing/cdp-live-checklist.md` (new case row; live cases live
there by repo convention), tracker note with evidence.
Steps: run the recipe on a dev session (Pi or Claude runtime, NOT
Codex). Fixture: build/refresh with `bun run
scripts/cdp/fixtures/mcp-naming.ts` (operator-step builder; the tree lands
under `NESSY_CDP_G6_ROOT`, default `~/nessy-cdp-g6` — the `cdp-echo-probe`
plugin bundles a credential-free stdio MCP server + a skill whose
allowed-tools names it, mcp-naming.ts:178-205).
FIXTURE FIX REQUIRED FIRST (rule-8 stop #3, measured, planner-verified):
the registry route also cannot work against the CURRENT fixture — a
registry's catalog is located by one of four manifest files
(`REGISTRY_CATALOG_MANIFEST_FILES`, registry-catalog-fetcher.ts:38-46) and
`mcp-naming.ts` writes NONE of them, so `market-a` adds as a registry but
lists nothing (D2's own "no listing" message answered — D2's path is live
and reached). Fix as its OWN commit
(`test(cdp): fixture registries carry a catalog manifest`): teach
`scripts/cdp/fixtures/mcp-naming.ts` to emit a root `marketplace.json` in
market-a/market-b listing their plugins, in the shape
`parseExternalPluginCatalog` accepts. ADDITIVITY IS MEASURED, NOT ASSUMED:
after the fixture change, re-run MCP-W1 live (cheapest of the three) and
record its verdict before re-running the D4 stretch; the attempt chain
(path refusal `unsupported_url` = security property; empty-catalog D2
answer; `upgradeRegistry not-git`) goes into D4's evidence as
correct-behavior observations.
ROUTE CORRECTED (measured 2026-08-14, first D4 drive): `plugin_plan_install`
refuses a local filesystem path BY DESIGN
(`marketplace.repository.unsupported_url` — that refusal is itself a
correct-behavior observation, record it). The fixture's `market-a` is a
marketplace REGISTRY, not a clonable repository. The route is the
`marketplaceItemId` branch: (1) register `~/nessy-cdp-g6/market-a` as a
BYO registry (a run-created artifact — its deregistration joins the
cleanup contract), (2) `plugin_plan_install` with
`<registryId>:cdp-echo-probe`, (3) `plugin_install` with the proposalId at
workspace scope. This path is EXACTLY what D2 fixed (pre-`f18f98db0` it
404'd against the Skills Market), so D4 doubles as D2's live proof — run
it in ONE uninterrupted stretch (registry add → install → observations →
uninstall → registry remove → verify pre-case state); then verify
OWNER OVERRIDE (2026-08-14, supersedes the planner's short-lived park
ruling): "нужно все корректно реализовать, ничего пропускать не нужно, мы
не спешим." NOTHING is parked. Execution order is D4 → D5 → D6 → Z1, each
run to honest completion — there is no time pressure, so a long rig setup,
session compaction, or waiting for the owner's Figma login are all
acceptable; a half-run recorded as done remains forbidden. Z1's final
regression must cover any fixes the live phase produces, which is exactly
why Z1 goes last.
(1) `<configDir>/plugins/installed.json` — skill capability carries
`allowedTools`+`paths`, mcp capability carries only the logical
serverName; (2) `rg -a wireName <configDir>` → zero hits;
(3) the session tool list shows `mcp__plugin_<pluginId>_<serverName>__<tool>`;
(4) source half: agent-create a source config, `source_test`, config gains
`enabled:true` + `connectionStatus:'connected'`. Run AFTER D1-D3 land so
the smoke covers the new code too. Dark theme for any screenshots
(standing preference).
Gate: the four recorded observations in the tracker note; failure on any =
file the defect, do not paper over.

**D5 `test(live): figma MCP OAuth — the post-login half of MCP-AUTH`**
(owner request 2026-08-14: "не проверили, не понятно работает ли
авторизация вовсе". Status quo, from the checklist and release memory: the
live case `scripts/cdp/cases/mcp-auth.ts` PASSED its pre-OAuth halves —
figma reports an honest `needs-auth` with a negative control, dp half fully
green — and stopped at "BLOCKED (owner OAuth)": the browser login is the
owner's, nobody has ever run the flow past it.)
Files: `docs/testing/cdp-live-checklist.md` (flip the `MCP-AUTH` row),
tracker note with evidence. No product code unless the run finds a defect.
Steps: (1) executor re-runs `mcp-auth.ts` on the CDP rig up to the OAuth
handoff and confirms the browser window/URL opens (OAuth discovery +
callback server up); (2) BLOCKED-ON-OWNER: owner completes the Figma
browser login once; (3) executor re-runs the case: tokens must land in the
encrypted source credential store (never in config.json), the figma source
flips to `connected`, its tools materialize in the session tool list and
one tool call answers with real data; (4) bonus assertion while there:
`source_oauth_trigger` from the agent reaches the same host flow (it binds
the same onAuthRequest callback — one screenshot of the auth panel
suffices). Token values never appear in logs or the tracker.
Gate: the four observations recorded in the tracker note + the checklist
row flipped from BLOCKED to PASS. A failure at step 3 = file the defect
with the transcript, do not work around it.
PARK RULE (autonomous run): if the owner login does not happen during the
run, record step 1's evidence (OAuth handoff reached, browser window/URL
opened), flip D5 to ⏸ — not ✅ — with that note, and PROCEED to Z1. Steps
2-4 complete in a follow-up session; the checklist row stays BLOCKED until
then.
ROOT CAUSE FOUND LIVE (2026-08-14, instrumented retry + planner metadata
read — verdict (a), OUR bug, fully mechanized):
1. Figma's AS metadata (https://mcp.figma.com/.well-known/… →
   issuer api.figma.com) advertises
   `token_endpoint_auth_methods_supported: [client_secret_basic,
   client_secret_post]` — NO `none`. Every DCR client is CONFIDENTIAL;
   the exchange REQUIRES a secret (live rejection verbatim:
   `{"error":"Client secret is required"}` after a successful callback).
2. Our pipeline obtains and carries the secret to the door —
   `registerMcpOAuthClient` (oauth.ts:755) parses `client_secret`,
   `prepareMcpOAuth` (:958) stores it, the RPC threads `flow.clientSecret`
   — and then `exchangeMcpCodeForTokens` (oauth.ts:791) DROPS it: no
   secret parameter, body = grant_type/code/redirect_uri/client_id/
   code_verifier[/resource] only. Generic defect: ANY confidential-client
   MCP registration fails identically.
3. FIX (small): add optional clientSecret to exchangeMcpCodeForTokens and
   send `client_secret` (client_secret_post; keep PKCE) when present;
   AUDIT THE REFRESH PATH for the same hole (a confidential client must
   also authenticate refresh_token grants); registration may keep
   requesting 'none' but must honor what the server registers. Secret
   never logged. Regression test: exchange body carries client_secret when
   the flow has one, does not when absent.
4. The observability fix `911bf10f6` is what made this diagnosable in 4s;
   the silence it removed is recorded as its own defect.
5. FIX LANDED `717a4e039` (both grants: exchange + refresh; secret never
   logged; planner-reviewed). OWED DEBT, declared not hidden: the
   body-shape regression test (secret present → client_secret on the body
   with code_verifier intact; absent → byte-identical to before) was
   written but its harness stub mismatched the real `OAuthPinnedFetch`
   signature via `withOAuthNetworkDependenciesForTests` — it was REMOVED
   rather than committed red or weakened green. Z1 MUST pay this debt
   before the final regression (ten minutes with the real seam signature)
   or record it as an explicit follow-up row with the reason.
6. End-to-end proof pending: rebuild+relaunch, then the owner's third
   click → MCP-AUTH post-login assertions (summary row gone, figma call
   succeeds) → D5 flip.

**D6 `test(live): CDP cases extended for this plan's surface + real-profile run`**
(owner directive 2026-08-14: "прогоните cdp тестирование на моем реальном
профиле в проекте react-ui-kit … пополните кейсы … если что исправляйтесь
автономно через builder сессию". Runs after D4/D5, BEFORE Z1 — the final
regression must cover any fixes this phase produces.)
Files: `docs/testing/cdp-live-checklist.md` (new rows, indexed by product
feature), `scripts/cdp/cases/` (new case files following the existing
`run.ts` driver conventions), tracker notes with evidence.
REAL-PROFILE RULES (binding — and they govern D4/D5 as well, not just D6:
owner directive 2026-08-14 after the isolated fixture config dir died at
launch with the unsafe-root/custom-root-reset-required gate — the known
dead end already recorded in project memory; the REAL profile is the rig):
- The rig runs on the OWNER'S REAL profile; workspace = the `react-ui-kit`
  project (already present there). `NESSY_CDP_WORKSPACE_ID` is mandatory;
  DARK theme before any screenshot (standing preference).
- The owner's Guardian may kill probe calls as `credential_probing` — that
  is environment, not a product defect; record and continue.
- DESTRUCTIVE live ops (source remove, plugin uninstall, connection
  deletion) run ONLY against artifacts the run itself created — never
  against the owner's real sources/plugins/connections. The owner's
  llm-proxy key may be used read-only (fetch/probe); it never lands in the
  repo, logs, or checklist rows.
- CLEANUP IS PART OF EACH CASE: because the rig is the real profile, every
  run-created artifact (the probe plugin, test sources, the test BYO
  connection) is removed at case end — preferably through the agent tools
  this plan shipped (plugin_manage uninstall, source_manage remove — a free
  live exercise of D3) — and the removal is VERIFIED (config/installed.json
  back to pre-case state) and recorded in the row's evidence.
- Defects found live are fixed AUTONOMOUSLY by the builder (planner
  reviews each fix as usual); a live failure is filed with its transcript,
  never papered over.
LIVE-PHASE EXECUTION STATE (handoff record 2026-08-14, first builder
session ended here on its own honesty call — deep context, refused to
half-start D4's install/cleanup cycle):
- Committed through D3 + fixes (`…36a208395`, sha-fix `6e0825342`), 16
  commits, full wave 13165/0. Z1's tree files (two package.json = 1.26.0,
  release-notes/1.26.0.md, docs-site custom-endpoint en+ru) prepared,
  UNCOMMITTED, stage-by-path. Third writer's files in tree — do not touch.
- Rig LIVE on the real profile: no NESSY_CONFIG_DIR, `NESSY_CDP_PORT=9224`,
  running app reports 1.26.0. Isolated-config recipe confirmed dead
  (zero CDP targets on the custom-root-reset-required gate).
- CORRECTION (measured): there is NO workspace named react-ui-kit — it is
  a PROJECT inside "test workspace", workspace id
  `f9b80031-d9d9-4bcf-b665-05935f96079a`
  (defaults.defaultProject.workingDirectory
  `/Users/i.i.gavrikov/Desktop/react-ui-kit`, projectKey
  `p_56fff7e69ef80d4a13c8bbdf98dbf0f1`). Wherever this plan says
  "react-ui-kit workspace", read THAT id.
- CORRECTION (measured): `NESSY_CDP_WORKSPACE_ID` DID NOT TAKE — MCP-AUTH
  created its session in `d98cc70e…` (My Workspace) despite the env var.
  Before D6 relies on it: read `scripts/cdp/run.ts` + the case to pin how
  the workspace is actually selected (likely the app's ACTIVE workspace),
  then either fix the driver or set the active workspace as an explicit
  case pre-step. Until pinned, the variable guarantees nothing.
  **PINNED (measured 2026-08-14, second builder turn):** the mechanism is
  split, and that is the whole answer. `lib/mcp-fixture.ts:45`
  `fixtureWorkspaceId()` DOES honour `NESSY_CDP_WORKSPACE_ID` (validates it
  against `getWorkspaces()` and returns it). `lib/state.ts:189`
  `freshSession()` does NOT — it dispatches the app's own new-session
  navigation, so the session lands in the app's ACTIVE workspace, whatever
  that is. MCP-AUTH uses `freshSession` (`cases/mcp-auth.ts:108`, `:203`),
  which is exactly why its session appeared in `d98cc70e…` while the env var
  named `f9b80031…`. Consequence for D6: a case that must run in the
  react-ui-kit project cannot get there by env var alone — it must either
  switch the app's ACTIVE workspace first (drive the switcher over CDP) or
  create its session explicitly against `fixtureWorkspaceId()` instead of
  `freshSession()`. Do this before writing D6's six cases, not after.
  OWNER FALLBACK (2026-08-14): "если что пусть использует My Workspace" —
  if the selection mechanism resists a quick pin, run the cases in
  My Workspace (`d98cc70e…`) rather than burning time on workspace
  plumbing; record which workspace each case actually ran in.
- MCP-AUTH on the real profile: 4/4 pre-OAuth checks PASS (figma
  `needs-auth` honesty + negative control `NO-FIGMA-TOOL`); the dp half is
  BLOCKED because built-in dp servers are disabled in the owner's
  settings — flipping an owner setting is the OWNER's call, never the
  run's (the first builder correctly refused). D5 step 1 is therefore
  PARTIALLY evidenced; the figma Connect handoff has not been driven yet.
  OWNER RESOLUTION (2026-08-14): enable dpGitlab **through the UI, driven
  over CDP, exactly as a real user would** — that path IS the test. The
  flip is owner-desired end state, NOT a run-created artifact: do not
  revert it at cleanup; record the click path and the resulting settings
  state in the case's evidence.
New cases to add (one row + case each; formalize don't improvise):
1. Runtime marks live: settings AI list + composer selector show the
   Claude/OpenAI/Nessy marks per the owner's assignment, legible in dark
   (the A2 mapping, on the real connections).
2. Plate gutter: screenshot assert — left edges of plates / Todo-Info row /
   composer aligned, normal + compact (B1's product complaint).
3. BYO model catalog: create a TEST llm-proxy connection with the owner's
   key → Fetch models → grouped picker → select → Check access verdicts →
   save → `contextWindow` + `modelsSyncedAt` land in config.json (C1-C3
   end-to-end); then a restart within TTL does NOT refetch (C2, observed
   via logs/no network).
4. C6 live: a turn on that BYO connection with `tgpt/qwen35-397b-a17b-fp8`
   yields assistant text with NO `<think>` leak AND the request carried
   `Authorization: Bearer` (not Nestor-Token) — the two halves of C6.
5. D4's recipe formalized as the agent-driven install case (fixture via
   `scripts/cdp/fixtures/mcp-naming.ts`) — as the BYO-REGISTRY route
   (register market-a → `<registryId>:cdp-echo-probe` plan-install →
   install → cleanup incl. deregistration), which makes the case D2's
   standing live proof; NOT a local-path install (refused by design).
6. `source_manage` live: agent disables then removes a source the run
   created; config + capability snapshot behave per D3.
Gate: checklist rows flipped with evidence per case; failures → autonomous
fix loop via the builder with planner review, then re-run.

**D7 `fix(pi): stale runtime agent definitions degrade and refresh instead of killing the session`**
FOUND LIVE by case 6 (2026-08-14), banked with full evidence. THE DEFECT: a
mid-session manifest re-registration that bumps `snapshotGeneration`
(capability change: source disable/remove, plugin install/uninstall), with
≥1 runtime agent definition present at init, permanently kills EVERY
subsequent turn of the session — `Stale runtime agent definition: <key>`,
unrecoverable from the user's side. MECHANISM (independently confirmed on
code by planner + builder): `register_tools` (`pi-agent-server/src/index.ts:3820-3845`)
swaps `activeExecutionManifest` to a NEW generation and flags `toolsChanged`
→ session recreated on next prompt → `buildSessionDefinition` (:1525)
rebuilds agent definitions from the ORIGINAL `initConfig.piRuntimeAgentDefinitions`
(descriptors stamped with the INIT-time generation; nothing on the
register_tools path re-sends them; host-side `pi-agent.ts:1633` reads
`this.config.piRuntimeAgentDefinitions`, and `updateRuntimeConfig` never
touches definitions) → strict check at
`orchestrator/runtime-agent-definitions.ts:286` THROWS inside session
construction. EVIDENCE: sessions 7e8995f2 (D3's own re-proof — 3 turns,
source_manage, died), 491556a8 + 1a967178 (case 6 runs 1-2, died on every
post-bump turn); positive control 690b2fe7 (3 turns, no capability change,
0 errors); D4's five arms are all ONE-turn fresh sessions, which is exactly
why D4 passed — obs 3's tool call ran in its own new session whose
descriptors matched. SECOND CONTROL (banked 2026-08-14, run 3): the four
fixture agent files MOVED aside, the IDENTICAL disable→remove sequence →
session 30560339, 26+ rows, 0 errors — the ≥1-definition precondition is
proven from both directions.
PRECONDITION WIDENED (run 5, 2026-08-14 — CORRECTS an earlier statement):
"an empty `~/.nessy-agent/agents/` can never hit it" is FALSE. With all
four fixture files still parked, run 5 hit the same throw on a
PLUGIN-PROVIDED agent capability:
`plugin://registry-…/claude-security@0.10.0#…#agent.claude-security@workspace:d98cc70e-…`.
The precondition is ≥1 runtime agent definition from ANY source —
hand-written file OR plugin agent capability. On the owner's ordinary
profile: claude-security ships 7 agent capabilities, figma ships 4.
SEVERITY, restated: any user with ANY agent-providing marketplace plugin
installed loses the session — permanently, every subsequent turn — the
first time anything bumps the capability generation mid-session. This is a
NORMAL-USAGE path, not a fixture-only one. Run 5 also delivered case 6's
first honest half: `disable` PASSED live; `remove` is BLOCKED by D7 and
only by D7. SEQUENCING (planner decision 2026-08-14): D7 runs BEFORE case
5 — case 5's cleanup arm is a multi-turn session after a plugin install,
exactly the shape D7 kills.
LOGGED, NOT CHASED (candidate follow-up task after D7, NOT part of it): a
`bypassPermissions` session (41da7400, mode confirmed set by user,
acknowledged) still showed `pendingPermissions:[{type:"file_write",
source:"session-permission"}]` with `risk:"pending-approval"` and a Write
sat unanswered for a full 300 s window. Not the protected-path floor
(`protectedPathOutcome('bypassPermissions')` returns 'allow' and the floor
is skipped). Reproduced twice, self-resolved once, uncharacterised. A1-POLICY VIOLATION: `SessionManager.ts:13172` pins
"a malformed definition is skipped and NAMED, never session-fatal"; a STALE
definition is the same class one layer down.
FIX, both halves in one commit:
1. SUBPROCESS DEGRADES: `buildPiRuntimeAgentDefinitions` skips a
   generation-mismatched descriptor with a NAMED diagnostic (debugLog, same
   voice as `reportUnresolvedTools`) instead of throwing — after a bump the
   session survives with imported agents absent-and-named until refreshed,
   which is the A1 shape.
2. HOST REFRESHES: the capability-change re-registration path carries
   freshly materialized definitions — extend the `register_tools` message
   with optional `piRuntimeAgentDefinitions` (wire change — risk trigger:
   run the shared+pi-agent-server contract suites on the final diff), and
   the subprocess adopts them into `initConfig` before the recreation, so
   the recreated session gets CURRENT agents rather than none.
Observability (small, in-scope): the register_tools debug line gains the
generation value, closing run 2's stated gap (the bump was provable only
structurally).
Tests: (a) unit — mismatched-generation descriptor is SKIPPED with the
diagnostic while a matching one loads (the throw case DELETED, not kept
beside the skip); (b) adoption — a register_tools payload carrying
definitions updates what the next `buildSessionDefinition` reads (fresh
stamps, agents present); (c) live re-proof — case 6 re-run WITH a fixture
agent definition restored: disable → remove → next turn SURVIVES and the
agent list is current; then park/clean the fixture per the cleanup
contract. The four Q6-LIVE fixture files are parked at
`<scratchpad>/agents-parked/` — restore ONE for (c), then remove them all
(they are run-created artifacts; reproduction is banked in this task text
and the session ids above).

### Lane E — merged personal-key form (INCOMING; owner decision 2026-08-14)

Owner folded the form merge into THIS plan («лучше в текущий так как тут
затрагивается эта форма с фетчем моделей из бэка»). Z1 now closes after E.
Research LANDED (workflow `wf_dfef867d-f79`, 3 agents, 11 claims verified on
code, 1 REFUTED — see the masked-key finding in E3). Full output preserved at
`assets/2026-08-14-byo-form-merge-research.json` (apiKey map / byo map /
design spec+delta+risks) — read it before executing any E task; the tasks
below inline only the load-bearing pins.
Owner sequencing (2026-08-14): lane E lands BEFORE D6 cases 3-4 — they
drive the BYO form surface E rebuilds, so proving them against the old form
would be evidence about a form we are deleting. Cases 5-6 are
form-independent (agent-driven install recipe, source_manage) and finish
first. Order: case 6 → case 5 → lane E → cases 3-4 (against the merged
form) → Z1.
Owner-confirmed shape (2026-08-14, chat):
- ONE form, «почти как сейчас custom runtime endpoint»: ByoRuntimeStep stays,
  the api_key card («I use other provider» → ApiKeyInput) is removed.
- Runtime radio gains a Pi arm (today Claude/Codex only).
- Protocol choice is TWO-valued: OpenAI-compatible | Anthropic-compatible.
  NO third «Custom» protocol arm — Qwen is not a protocol, it is dialect
  quirks inside chat-completions already auto-fixed per-request by model id
  (`tool-schema-dialect.ts`). Owner confirmed («понял хорошо»).
- Instead: optional advanced hint «Диалект: Auto | Qwen» — Auto = current
  two-id detection; Qwen forces both mitigations (think-split + schema
  weakening) for the connection's models, covering Qwen-family under
  non-allowlisted ids.
- After key+URL entered (llm-proxy case): model-list area gets SCROLL and
  the dialog gets BIGGER — C3's picker embedded, entitlement marked via
  Check access (probe), context window shown. No per-model protocol/runtime
  badges: protocol is a connection property; all entitled models fit all
  three runtimes through the adapters (server has no such field — badges
  would be invented data).

**Planner decisions on the spec's two open questions (owner may override):**
(1) A build with `NESSY_FEATURE_PROVIDER_API_KEY=0` AND both runtime flags
`0` has NO personal-key entry at all — ACCEPTED as a legitimate flag-matrix
corner (that is what the flags mean); document in the AGENTS.md flag-table
note, do not forbid. (2) ApiKeyInput survives EDIT-ONLY for exotic
CLI-created Pi connections (amazon-bedrock, openrouter 3-tier, google —
apps/cli writes arbitrary `piAuthProvider` into the shared config); deleting
its Bedrock/3-tier arms would strand those connections and is a SEPARATE
owner decision, not part of this lane.

**LANE E TREE DISCIPLINE (stage-by-path, ALWAYS — F6):** the tree carries
two other owners' files. Third writer (session-runtime-switching lane):
`FreeFormInput.tsx`, `playground/registry/index.ts` (modified),
`playground/registry/runtime-switch.tsx` (untracked) — never touch, never
stage. Z1 prep (uncommitted): both `package.json` (already 1.26.0),
untracked `release-notes/1.26.0.md`, docs-site custom-endpoint en+ru —
Z1's to commit, not yours. NO `git commit -a` anywhere in lane E; every
commit stages its own files by path.

**THE CENTRAL LANDMINE (every E task orbits it):** the SETUP handler
rewrites any customEndpoint+baseUrl payload to providerType `pi_compat`
(`server-core/handlers/rpc/llm-connections.ts:111-127`), which kills the
local codex/claude adapters — the historical conversion production bug. One
form now holds BOTH sides: the Pi/Custom arm MUST emit `customEndpoint` (to
be rewritten to pi_compat on purpose), the runtime arms must NEVER emit it,
and the official Anthropic/OpenAI presets must NEVER emit it either (else
the server pins pi_compat and the Pi default-model install +
`automaticallySyncedFromProvider` path at `:154-166` is silently lost). Two
payload builders, never a shared spread; tests pin BOTH directions.

**E1 `feat(models): miniModel — explicit utility-model slot on connections`**
Files: `packages/shared/src/config/llm-connections.ts` (interface ~:144 +
`getMiniModel` :276-280), `validators.ts`, `storage.ts` update-merge
allowlist (:2575-2602 — the #838 drop trap: a field missing there silently
vanishes on the next save), protocol `LlmConnectionSetup.miniModel?: string`,
`server-core/handlers/rpc/llm-connections.ts` (~:96-110: apply with
validation — pinned (F9): validate against the POST-MERGE effective model
list, not `setup.models` alone, since an edit payload may carry `miniModel`
without `models`).
`getMiniModel`: explicit field first when set AND managed-allowlist-clean;
otherwise today's `findSmallModel` heuristic BYTE-FOR-BYTE, incl. the
last-entry fallback every existing claude-runtime connection relies on.
CITATIONS CORRECTED (E1 executor, 2026-08-14): `claudeGatewayConnectionDefaults`
is NOT a symbol — it is prose inside comments (renderer
`apisetup/nessy-gateway.ts:123-131` and
`server-core/domain/connection-setup-logic.ts:215`); the order pin
`claude-connection-setup.test.ts` lives at
`apps/electron/src/renderer/components/apisetup/__tests__/` (not shared)
and must stay green UNTOUCHED. Pinned (F8): the explicit
field drives `getMiniModel` ONLY — `getSummarizationModel` (:326) keeps its
own delegation untouched; letting the two diverge is that function's stated
purpose, and one-knob-for-both would be a separate owner decision.
Gate: focused tests (explicit-first; fallback preserved; allowlist
persistence round-trip; SETUP rejects out-of-list miniModel) +
`typecheck:shared` + server-core typecheck.

**E2 `feat(models): BYO runtime connections enroll in metadata sync`**
Files: `packages/server-core/src/model-fetchers/index.ts` (registry.ts
untouched). Widen `isModelSyncEnrolled` (:48-52) to:
`[pi_compat && customEndpoint.api==='openai-completions'] OR
[isAdapterRuntimeProvider(providerType) && !isNessyGatewayBaseUrl(baseUrl)]`,
AND numeric `modelsSyncedAt` — gateway one-click connections can never
enroll (no stamp is ever written for them; the URL guard is belt-and-braces).
GUARD SYMBOL PINNED (fact-check blocker fixed): `isNessyGatewayBaseUrl`
from `@nessy-agent/shared` (`agent/backend/internal/drivers/upstream-target.ts:34`),
the whole-URL matcher `model-fetchers/registry.ts:46` ALREADY imports. NOT
pi-agent-server's `isNestorGatewayUrl` — prefix-tolerant (wrong semantics:
prefix matching is the exact hole registry.ts's docstring warns about) and
in a package server-core cannot import. Route
enrolled adapter-runtime connections into the merge-never-replace branch
(`fetchOpenAiCompatModels` + `mergeModelMetadata` + 24h TTL + restamp)
BEFORE the `GatewayRuntimeModelFetcher` dispatch; suppress the HOURLY
gateway-fetcher timer for enrolled runtime connections (extend the
`isNestor || isEnrolledByo` continue at :277 — the design agent measured
`refreshIntervalMs=3600000`, so today a non-gateway runtime connection
carries an hourly no-op timer).
Gate: C2's `runService` harness pattern (fetch calls + setInterval count on
stdout): runtime-enrolled fetches and merges; gateway one-click untouched;
unenrolled runtime keeps today's behavior; timer count 0 for enrolled.

**E3 `feat(ui): merged form logic — arm model, validation matrix, router`**
Files: `apps/electron/src/renderer/components/apisetup/byo-runtime.ts` +
`__tests__`. `MergedEndpointArm = 'pi' | 'claude-runtime' | 'codex-runtime'`
('pi' is an ARM id, not a providerType — the server derives pi/pi_compat/
anthropic from payload shape). Validation matrix (first failure wins, per
the spec's §5 table): endpoint required + gateway-URL whole-match rejection
on ALL arms EXCEPT the Pi official presets (F11: those hide baseUrl and
submit `undefined` — the llm-connections.ts:83-88 reset path depends on the
blank), Pi/Custom included (new but forced:
`NESSY_GATEWAY_PROVIDER_TYPES` includes pi_compat, so a Pi-arm save on that
URL becomes permanently un-editable); ≥1 model id on runtime arms + Pi/
Custom; miniModel ∈ models when set; key required unless isEditing OR
loopback. `buildByoRuntimeSetup` extended with `miniModel` +
`modelsSyncedAt` (tristate, touched-only) — still NEVER customEndpoint/
piAuthProvider/modelSelectionMode. Pi-arm submit shapes assembled via the
EXISTING `pi_api_key` pipeline (`apiSetupMethodToConnectionSetup` +
`resolveCustomEndpointPayload` semantics), NOT a new builder: Anthropic/
OpenAI presets → no-customEndpoint official shapes; Custom → customEndpoint
{api: protocol} + protocol-derived piAuthProvider; `lastNonCustomPreset`
silent fallback: PATH CLOSED BY VALIDATION, CODE UNTOUCHED (F10) — Custom
now requires baseUrl so the merged form can never reach the fallback, but
`resolvePiAuthProviderForSubmit` in `submit-helpers.ts` stays as-is: the
legacy ApiKeyInput edit surface still calls it, and submit-helpers.ts is
outside this task's zone. `resolveConnectionEditTarget` becomes the FOUR-target router:
codex/claude-runtime → merged form arm-locked; pi_compat → merged Pi arm,
preset 'custom', customApi + sync + miniModel prefilled; pi with
piAuthProvider ∈ {anthropic, openai, undefined} and plain 'anthropic' →
merged Pi arm, preset from piAuthProvider (plain-anthropic submit keeps
mapping through the anthropic_api_key setup shape to preserve the byte-level
reset semantics at llm-connections.ts:83-88); EVERYTHING ELSE (exotic
piAuthProvider) → legacy ApiKeyInput edit surface.
MASKED-KEY UNIFICATION (fixes the workflow's REFUTED-claim finding):
`GET_API_KEY` masks for EVERY caller (llm-connections.ts:475-484), and
today's ApiKeyInput edit path submits that mask VERBATIM to the pre-save
test (`handleSubmitCredential` has no `'••'` detection — verified absent).
The merged Pi arm adopts the BYO semantics: masked counts as key-present,
never sent in any payload, `keyIsUnverifiable` skips only the key verdict
on edit.
Gate: table-driven matrix tests; submit-shape invariants in BOTH directions
(runtime payload never carries customEndpoint; Pi/Custom always does when
baseUrl set; official presets never do); router table incl. exotic
fallback; masked-key edit case.

**E4 `feat(ui): merged form UI — three arms, protocol, catalog, sizing`**
Files: `apps/electron/src/renderer/components/onboarding/ByoRuntimeStep.tsx`
(+ i18n en/ru; `ModelCatalogPicker.tsx` reused UNCHANGED). Layout per spec
§2: (1) runtime segmented control [Pi | Claude Code | Codex] — availability
'pi' iff `flags.api_key`, runtime arms iff their flags; same
getProviderFlags IPC + optimistic all-on default (extended to 3 keys) +
settle effect + dead-form guard; hidden when one arm or edit-locked;
default 'pi' when available. (2) Pi arm: preset dropdown {Anthropic,
OpenAI, Custom} — port exactly the three VISIBLE presets and
`resolvePresetStateForBaseUrlChange`; official presets hide baseUrl.
(3) Protocol [OpenAI Compatible | Anthropic Compatible] — Pi/Custom ONLY;
pinned+hidden 'openai-completions' on runtime arms (UpstreamTarget union is
{nestor, openai-compatible} only — adapter fact, not UX); hidden on
official presets. (4) key field with unified masked semantics. (5) Models
comma field — NO COMPAT_ANTHROPIC_DEFAULTS prefill (wrong for every
non-Anthropic endpoint); placeholder "e.g. deepseek-v3, deepseek-r1";
hidden on Pi official presets (server installs Pi catalogs). (6) C3
catalog block (Fetch + picker + Check access) on EVERY arm whose effective
protocol is openai-completions — the RPC branch needs only baseUrl+key, so
runtime arms get it too; Anthropic-protocol Pi arm gets a helper line
instead (no catalog RPC). (7) miniModel select over parsed models +
free-text escape, "Defaults to the last model in the list." (8) sync
toggle, tristate preserved, edit prefill from `modelsSyncedAt != null` —
fixing the AiSettingsPage :882-889 gap. (9) OWNER POINT 3 — sizing: when
the catalog block is visible the dialog gets BIGGER and the model list
SCROLLS in its own `overflow-y-auto` container with a max-height; verify
in playground at both normal and compact widths, dark first.
i18n: new keys both locales (arm labels, per-arm helpers, preset labels,
protocol strings — today untranslated English literals in ApiKeyInput —
miniModel label/placeholder, dialect label, card copy); parity+sorted green.
PLAYGROUND CONSTRAINT (F7, corrected): NO existing entry mounts
ByoRuntimeStep, so ADD NEW ENTRIES inside the existing FILES
`onboarding.tsx` / `api-key-input.tsx` — `registry/index.ts` spreads
per-file arrays (`...onboardingComponents`), so a new entry inside those
files needs NO index.ts edit. Do NOT touch `playground/registry/index.ts`
or `runtime-switch.tsx` — third writer's files (in-flight
session-runtime-switching lane).
Gate: form tests; `typecheck:electron`; i18n parity+sorted; playground
sweep dark→light of all three arms + catalog-open + enrolled + anthropic-
protocol + edit-locked variants; sizing проверен на catalog-open variant.

**E5 `feat(ui): wizard, card and edit routing switch to the merged form`**
Files: `apps/electron/src/renderer/hooks/useOnboarding.ts`,
`components/onboarding/ProviderSelectStep.tsx`,
`pages/settings/AiSettingsPage.tsx`. `handleSubmitByoRuntime` grows the
Pi-arm branch (delegates to the pi_api_key pipeline with loopback/masked/
edit semantics; runtime branch byte-identical); `jumpToByoRuntime` prefill
extended (preset, customApi, syncModelsFromEndpoint, miniModel);
CHOICE_TO_METHOD drops the api_key row; the api_key card is REMOVED;
custom_runtime card visibility becomes
`flags.api_key || flags.nessy_codex || flags.nessy_claude` with the new
"Use your own key or endpoint" copy; `handleEditConnection` dispatches on
the E3 router and passes the sync + miniModel prefills; legacy
`jumpToCredentials` remains EXCLUSIVELY for exotic Pi connections.
`ApiKeySubmitData` is a cross-lane type (lane A's playground imports it) —
do not delete or narrow it; ApiKeyInput stays compiled as the edit-only
exotic surface.
MINI-MODEL THROUGH THE PI ARM (F5 — the silently-missing step): the Pi arm
submits through `ApiKeySubmitData` → `handleSubmitCredential`/
`handleSaveConfig` → `apiSetupMethodToConnectionSetup` (:135), NONE of
which carries `miniModel` today. Extend all three (optional field, same
tristate-free plumbing as `defaultModel`) so a miniModel picked on the Pi
arm actually persists — the llm-proxy case this lane exists for. Gate case:
the Pi-arm payload carries `miniModel` end-to-end.
Gate: flag-matrix UNIT tests over mocked `getProviderFlags` (F13 — the four
corner matrices, not four packaged builds: api_key=0 removes the Pi arm but
keeps runtime arms; both-runtimes=0 + api_key=1 SHOWS the card Pi-arm-only —
the visibility formula flips vs today); edit-routing tests; the Pi-arm
miniModel case above; `typecheck:electron`; the E3+E4+E5 diff reviewed as
ONE unit (they are one feature across three zones).

**E6 `feat(pi): per-connection Qwen dialect hint`**
Owner-confirmed (chat 2026-08-14): protocol radio stays two-valued; the
escape hatch for Qwen-family models under non-allowlisted ids is an
optional advanced hint «Dialect: Auto | Qwen», Pi arm + Custom preset +
openai-completions only (the proxy runs only there). RUNS STRICTLY AFTER
E4+E5 (F4 — the select lives in ByoRuntimeStep's advanced area and the
payload threading runs through E5's files; parallel execution is a
same-file collision). ZONE (complete, F4): shared config
(`llm-connections.ts` customEndpoint type + `validators.ts`
CustomEndpointSchema — non-strict today so an unknown key survives, but add
the field properly), `ByoRuntimeStep.tsx` (the select; default Auto; omit
the field entirely when Auto), `submit-helpers.ts` +
`hooks/useOnboarding.ts` (thread `dialect` into the submitted
`customEndpoint` on the Pi/Custom path), and the FOUR rebuild/type sites
the fact-check found — the two E6 verify-questions are ANSWERED, both YES
with caveats: (1) storage.ts:2591 persists `customEndpoint` as a WHOLE
object — nothing to add there; (2) the host passes it verbatim at spawn
(`pi-agent.ts:1614` via `factory.ts:862`) and mid-session
(`SessionManager.ts:10744`), BUT the subprocess-side type literals pin
`{api; supportsImages?}` at `pi-agent-server/src/index.ts:251/:283/:1248`
(widen all three) AND `buildBackendRuntimeSignature`
(`server-core/src/sessions/runtime-config.ts:84-90`) rebuilds
customEndpoint FIELD-BY-FIELD — without adding `dialect` there, a
live-session dialect edit never drifts the runtime signature and the
running adapter keeps the old dialect until restart. Then
`applyNestorReasoningProxy` (index.ts:1260) — `shouldProxy` union gains
`config.customEndpoint?.dialect === 'qwen'`;
`gateway-proxy/nestor-reasoning-proxy.ts` — handle gains
`forceDialect?: 'qwen'`, and the per-request gates become the FULL unions
(F12 — do not drop the landed clauses): reasoning split fires when
`isGatewayUpstream || forceDialect || isNestorGatewayQwenModel(body.model)`;
dialect (`adaptToolRequestForDialect` schema weakening + `tool_choice`
drop) fires when `forceDialect || isNestorGatewayQwenModel(body.model)`.
Gateway behavior byte-identical when forceDialect absent.
Gate: proxy tests — hint connection with an arbitrary model id gets split +
weakened schemas + `tool_choice` dropped; Auto connection unchanged
(non-Qwen id passes through verbatim — the existing C6 case must stay
green); gateway unchanged; runtime-signature test (dialect edit drifts the
signature); form test (Pi/Custom payload carries dialect, Auto omits it);
`bunx tsc` per the C6 test-typecheck recipe (the package tsconfig excludes
tests).

**OWNER REVIEW AFTER E5 (2026-08-14, mid-E4):** the owner saw the
in-progress form live, questioned the Pi-arm preset dropdown («провайдер…
нам же не нужно если мы даем урл и ключ и выбираем протокол») and the
runtime radio restructuring fields, then explicitly DEFERRED: «давай
дождемся исправлений по плану и поправим уже после что б понять что мы
сделали». So: E4/E5 land AS SPECCED (dropdown stays), then the owner
reviews the LIVE merged form and presentation is adjusted in a follow-up
task written from that review. TIMING PINNED (owner 2026-08-14): the
review happens BEFORE lane F starts, on the CDP run — «делайте автономно
до F1 и перед F1 посмотрим форму в живую на cdp тесте». Execution is
AUTONOMOUS through E4 → E5 → E6 → D6 cases 3-4 (the builder commits on
green gates without per-task approval, messaging summaries; the planner
intervenes only on problems), then STOP before F1 for the owner's live
form review. Candidates already scoped: replace the
visible preset selector with URL+protocol inference (a one-function change
— `usesOfficialPiEndpoint` + the JSX; validation/submit shapes/router
untouched). CONSTRAINT for any inference design (executor flag, recorded):
with an empty URL and no selector, the protocol radio is the ONLY carrier
of the official Anthropic-vs-OpenAI distinction — it must stay visible on
the Pi arm or one of the two official shapes becomes unreachable.
Arm-switch VALUE PRESERVATION (URL/key/models/miniModel survive switching)
is pinned by an E4 test regardless.

**E-sequencing (corrected per F3/F4):** E1 FIRST — E3's
`buildByoRuntimeSetup.miniModel` needs E1's `LlmConnectionSetup` field to
typecheck (file-zone disjointness ≠ type independence), and E6's
validators.ts edit shares E1's file. Then E2 ∥ E3 (genuinely disjoint:
server model-fetchers vs renderer byo-runtime.ts) → E4 → E5 → E6 (strictly
last — same-file with E4/E5). Single-session builder: just run E1 → E2 →
E3 → E4 → E5 → E6. Then D6 cases
3-4 run AGAINST the merged form (case 3's click-path = Pi arm / Custom /
llm-proxy URL + owner's key already in the encrypted store → Fetch →
grouped picker → Check access → save → config assertions → TTL restart),
then Z1. Z1 additionally verifies: `rg -uuu` zero hits for the removed
api_key card strings, i18n parity, and the release notes name the merged
form.

LIVE-PHASE HANDOFF #2 (2026-08-14, second builder session ended at context
limit — honest stop BEFORE case 4 rather than a half-driven measurement):
- DONE beyond the tracker: lane E complete (E1-E6), masked-key fetch defect
  found live by case 3 and fixed (`fd51699b2`, slug-aware-RPC follow-up
  logged in its commit message). D6: cases 1-2, 5, 6 PASS; case 3 yielded
  its defect, its interactive half FOLDED INTO the owner's live form
  review (the scheduled stop-before-F1); case 4 untouched.
- CASE 4 PREREQUISITES (do not re-derive):
  (1) SUBSTRATE: the owner's `pi-api-key-2` connection carries only
  claude-* ids — NO Qwen. The case must not run on a non-Qwen model (the
  `<think>` half passes vacuously). The Qwen ids arrive via the owner's
  review (case 3 interactive: Fetch → pick `tgpt/qwen35-397b-a17b-fp8` →
  save) — run case 4 AFTER that.
  (2) BEARER INSTRUMENT: observe the header on the reasoning proxy's own
  upstream request LIVE (`attachUpstreamCredential` gates Nestor-Token on
  the verified gateway URL; the proxy now fronts BYO endpoints too).
  Reading the code is not the measurement — D5/D7 discipline.
  (3) E6 INTERPLAY: the dialect hint is a third way into the proxy gate —
  measure the header half both WITH and WITHOUT `dialect: 'qwen'` set,
  because the hint changes whether the proxy fronts the request at all.
- NEXT after case 4: lane F (F1→F5, sequencing block below), then Z1.

LIVE-PHASE HANDOFF #3 (2026-08-14, third builder stop — context exhausted
again; took ONLY G1(a) because the exact call site was already in front of
him from the attribution check):
- G1(a) DONE, committed `4a0f238af`: piAuthProvider derived from protocol
  (one fact in one place — the derivation mirrors resolveCustomEndpointPayload)
  + the mask no longer forwarded on the Pi-arm pre-save test; tests hold
  BOTH arms to ONE rule (the drift shape that caused it). ATTRIBUTION
  recorded: both defects were E5's own; the mask was fixed for the catalog
  RPC in fd51699b2 but the same reasoning was not carried to the pre-save
  path in the same file.
- REMAINING QUEUE for the next session: G1(b) scroller (Radix
  max-height-on-Root → move to VIEWPORT, loopback-stub live re-measure,
  recipe in the task) + the stale guard message rewrite at
  connection-setup-logic.ts:65-69 (now unreachable from the merged form —
  truth fix, its test moves with it) → G2 → G3 → owner check-in (typed
  keys: llm-proxy for create walk, anthropic-entitled for G3 proof) →
  case 3 assertions on form v2 → case 4 (substrate STILL unresolved: no
  Qwen id on the owner's connection; the <think> half passes vacuously if
  run as-is; check the header half with AND without the E6 dialect hint)
  → lane F → Z1.

### Lane F — context-window correctness across the three runtimes
(INCOMING; owner directive 2026-08-14: «нужно убедиться что данные от бэка
по моделям мы используем корректно и правильно отображаем контекст в 3ех
рантаймах и делаем корректную компакцию и автокомпакцию»)

Scope: the fetched `contextWindow` (C1/C2's 24h sync, llm-proxy
`context_length`) must be (a) DISPLAYED correctly in the session context
indicator on Pi, claude-runtime and codex-runtime, and (b) CONSUMED
correctly by compaction/auto-compaction thresholds on all three. Audit
LANDED (workflow `wf_ccfce9a4-54b`, three per-runtime maps, full output at
`assets/2026-08-14-context-window-audit.json` — read the relevant runtime's
map before executing any F task). Verdict per runtime:
- **Pi — the only runtime where the synced window actually flows** (driver
  → customModels → SDK model → snapshot → donut; compaction reads the SAME
  model window). Defects: M1 an absent window is FABRICATED as 131 072 and
  labeled `contextWindowSource: 'runtime'` — a real 32k model then carries
  a threshold ABOVE its actual window and 400s before compaction can fire;
  M2 the pre-snapshot renderer fallback divides by the static registry
  (zero Pi/gateway ids) with a differently-composed counter.
- **claude-runtime — the synced window is DEAD.** The SDK believes 200 000
  for any non-`claude-*` id (binary fallback), while we store 262 144: the
  donut overstates fullness ~31%, picker and tooltip show two different
  windows, and SDK auto-compaction fires at ≈167k — giving away ~95k (36%)
  of the gateway model's usable context. The SDK's own escape hatch exists
  and is unused: `CLAUDE_CODE_MAX_CONTEXT_TOKENS` applies exactly to
  non-`claude-*` ids and can carry the stored window via `envOverrides`
  (claude-agent.ts:981-1001). The composer warning threshold is an
  invented 77.5%, unrelated to the SDK's real one.
- **codex-runtime — worst of the three.** (1) WIRE-CASING BUG:
  `codex-agent.ts:383-384` reads `last.input_tokens`/`output_tokens`
  (snake_case) while the pinned generated contract is camelCase
  (`TokenUsageBreakdown.ts:5`) — `modelContextWindow` in the SAME payload
  is read camelCase and works, so per contract every notification records
  0 tokens: donut 0%, token line never renders, usage metrics zero; only
  self-consistent snake_case fixtures cover it. (2) The synced window is
  never consulted (codex config knobs `model_context_window` /
  `model_auto_compact_token_limit` exist in the schema and
  `buildCodexConfigToml` writes NONE). (3) `thread/compacted` is unhandled
  in the event adapter — codex compaction is invisible. (4) The meter's
  warning button submits `/compact`, which CodexAgent sends to the MODEL
  AS PROSE (codex-agent.ts:686 — "no command branch of its own yet"): the
  offered remedy is a no-op; the wire HAS `ThreadCompactStartParams` with
  zero non-generated references. (5) The 77.5% invented threshold has no
  relation to codex's real internal limit.

**F tasks (VERIFIED — fact-check 9/9 OK first-hand incl. the binary's env
gate read verbatim; executability pass wf_e7a95d57-fef, 22 findings, ALL
resolved below):**

**F SEQUENCING (hard):** F starts only after BOTH lane E's last commit AND
the session-runtime-switching lane's commit land — `FreeFormInput.tsx` is
that lane's live file and F1/F3/F4 all touch it; never worktree-parallel.
Two E∩F files exist (the header's old "disjoint" claim was false):
`pi-agent-server/src/index.ts` (E6∩F1) and i18n en/ru (E4∩F1/F4).
Within F: F1 → F2 → F3 → F4 → F5; D6 cases 3-4 run BEFORE F5 (right after
lane E, against the merged form), F5 is the last CDP work before Z1.

**F1 `fix(pi): absent context window is honest, and the fallback divisor
dies`** — `custom-endpoint-models.ts` keeps the 131 072 operational floor
(the SDK needs a number) but the mechanism is PINNED (finding 1):
`buildCustomEndpointModelDef` returns `{def, windowIsFallback}`;
`registerCustomEndpointModels` (index.ts:1369-1401) keeps a
`Set<modelId>` of fallback-window models; the set is a new dep of
`buildContextUsageSnapshot`, which labels those `contextWindowSource:
'fallback'`, never `'runtime'`. WIRE CHANGE (finding 2): `'fallback'` is a
new member of the `contextWindowSource` union in
`packages/core/src/types/message.ts:625` — risk trigger; zone therefore
also includes `ChatDisplay.tsx:152` `formatContextWindowSource`
(exhaustive switch + overlay consumers :2580/:2697) and a `context.source.*`
i18n key in BOTH locales. The composer tooltip marks a fallback window as
estimated. Pre-snapshot fallback divisor (M2): the predicate is PINNED
(finding 3) — gate on the composer capability `contextUsage.kind ===
'fresh-local'` (the same gate FreeFormInput already reads as
`providerReportsFreshUsage`); for such sessions ChatDisplay must NOT fall
back to `tokenUsage`+static-registry — the donut waits for the first
snapshot. RESIDUAL, ACCEPTED (finding 6): F1 fixes the LABEL; a
genuinely-unknown real-32k model still carries a threshold above its
window — accepted, post-C1/C2 sync it only hits models the catalog cannot
credibly cover; do not invent a fix.
LIVE FACT for F1 (measured 2026-08-15, BYO-QWEN run): on the owner's
profile a ONE-LINE prompt spends ~70 000 input tokens (system prompt +
the full agentic tool surface). A model whose real window is 40 960
(several llm-proxy models are ≤ that) OVERFLOWS on the FIRST turn —
`400 "maximum context length is 40960 tokens. However, your request has
70042 input tokens"` — before any history exists. So the synced
contextWindow decides USABILITY, not just the donut. Two consequences F1
must carry: (a) the fabricated 131 072 default is actively harmful here —
it hides that a 40 960 model cannot serve this profile at all, so the
honest-fallback labeling is not cosmetic; (b) NEW CANDIDATE (owner
decision): the model picker should mark/​warn models whose window is below
the session's resting base (~70k here) as unusable-on-this-profile, the
same honest-surface principle as the availability probe — sizeable enough
to be its own F task or next-plan item, flagged not buried.
BASE-CONTEXT BREAKDOWN (measured 2026-08-15, fresh session AFTER one turn —
system_prompt/mcp_tools read 0 before the turn, so measure post-turn):
system_tools 20 182 (28.5%), mcp_tools 20 078 (28.4%), system_prompt
19 351 (27.3%), custom_subagents 8 622 (12.2%, = claude-security's 7
agents), skills 1 048, messages 603, memory 0, unaccounted 939 → total
70 823. THREE comparable trim targets, not one: 20k built-in tool schemas
+ 20k MCP tool schemas + 20k prompt; tool-only trims cap at ~57%. NEXT-PLAN
CANDIDATE "context diet" — its first measurement is the deferred-vs-eager
split of mcp_tools (how much of the 20k rode the deferred-MCP mechanism vs
eager, i.e. the deferrable→deferred headroom); not measured yet, do NOT
guess. This is the concrete «что режем» answer to the owner's «почему 70k».
USABILITY FACT (measured live 2026-08-15, BYO-QWEN run, checklist carries
the verbatim 400): the owner's profile spends ~70 000 input tokens on a
ONE-LINE prompt (system prompt + agentic tool surface), so a
40 960-window model cannot answer AT ALL — the FIRST turn overflows
before any history exists. The synced contextWindow decides wh
Gate: core+shared+server-core typechecks; snapshot source labeling both
ways; exhaustive-switch/overlay tests; no static-registry divisor for
fresh-local sessions; i18n parity+sorted.

**F2 `fix(claude): the SDK believes the synced window`** — SCOPE NARROWED
(finding 15): this commit is `claude-agent.ts` + tests ONLY; ALL renderer
threshold work moves to F4. envOverrides gain
`CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(storedWindow)` — gating PINNED
(finding 8): the window is read from the connection entry of the SESSION'S
SPAWN MODEL (`config.model ?? connection.defaultModel`); one env per
subprocess; a mid-session model switch accepts staleness, with a comment.
Set only when that entry carries a contextWindow AND the spawn model id
does not start with `claude-` — the SDK's own gate, read VERBATIM from the
binary (fn `NKc`: known-model table `JZn` consulted BEFORE the env, so the
env is inert for ids the binary knows — harmless for `tgpt/*`; and under
`DISABLE_COMPACT` the env is honored UNCONDITIONALLY, fn `MKc` — carry
both nuances as comments). Display AND the SDK's auto-compaction threshold
then both derive from the real window — one env fixes both.
Tests (finding 9's phrasing): env present for a gateway spawn model with a
synced window; ABSENT when the SPAWN model is `claude-*`; absent when no
stored window.

**F3 `fix(codex): usage per pinned contract, window into config,
compaction visible`** — (a) casing: read camelCase per
`TokenUsageBreakdown`, with a defensive snake_case fallback when the
camelCase key is absent; fixtures corrected to camelCase. The snake_case
read was DELIBERATE — codex-agent.ts:410-412 carries a written belief
citing the hand-written local type, i.e. CIRCULAR evidence — so the live
probe settles the wire's actual shape FIRST; if it contradicts the
generated contract, STOP and report, do not guess. (b) window threading
PINNED (finding 10): the smallest path is the Pi driver's pattern —
`codexDriver.buildRuntime` (drivers/codex.ts:72-84, in zone) passes the
spawn model's synced `contextWindow`; `buildCodexConfigToml` writes
`model_context_window` from it when present. config.toml is read at
app-server start: VERIFY whether codex-agent already tears down/respawns
on model switch — if yes the window rides naturally, if no accept
staleness with a comment. DELIBERATELY NOT WRITTEN (finding 11, planner
decision): `model_auto_compact_token_limit` — no derivation source and no
renderer transport exist; codex therefore gets NO threshold warning this
plan (see F4), and F5-codex asserts compaction-existence + context-drop,
never a threshold value. (c) the event adapter handles `thread/compacted`
→ compacting status + `Compacted context` info row. (d) `/compact` on
codex: VERIFY FIRST whether rust-v0.147.0 actually serves
`thread/compact/start` (the pinned contract HAS the type; a live probe
decides); if yes, CodexAgent implements the command through it; if no,
the affordance is hidden for codex — a named composer capability
(finding 13) consumed BOTH by the command surface and by the
warning-donut's `/compact` button in `FreeFormInput.tsx:2483` — never a
prose turn. Contract-suite risk trigger applies (codex-protocol reads).
Zone adds: `drivers/codex.ts`, `FreeFormInput.tsx` (post
runtime-switch-lane only).

**F4 `fix(ui): no invented thresholds`** — owns ALL renderer threshold
work (finding 15). `resolveContextMeterState` needs a NEW discriminant
(finding 14): today codex and legacy are the identical branch — pin
`thresholdKind: 'real' | 'formula-claude' | 'none' | 'legacy'` derived
from the composer capability, threaded composer-capabilities →
ChatDisplay/`FreeFormInput` → `ContextMeterInput` (both files in zone,
post runtime-switch-lane). Per runtime: Pi — snapshot's
`autoCompactionThreshold` (already real); claude — the formula computed
RENDERER-SIDE as `tokenUsage.contextWindow − 20 000 − 13 000` (finding 7:
post-F2 `tokenUsage.contextWindow` IS the SDK-believed window echoed via
`modelUsage.contextWindow`; the `min(maxOutput, 20 000)` arm is pinned to
the constant with a comment that the bundled SDK's default maxOutput
≥ 20 000 — no maxOutput source exists in the repo, do not invent one);
codex — NO threshold warning (F3's decision); legacy providers keep the
77.5% fabrication (they genuinely lack data). Precision from fact-check:
the fabricated value is the THRESHOLD (77.5% of window, warning at 80% of
it ≈ 62% of window) and only fires once a window was actually reported.
Gate (finding 16): per-runtime table-driven `context-meter-state` unit
tests + `typecheck:electron` + i18n parity if strings move.

**F5 CDP cases ×3 (owner-pinned shape)** — per runtime: fill to ~half →
manual compact → context provably drops (product-written source) → keep
filling → auto-compaction triggers → drops again. KNOBS CORRECTED
(finding 17 — the naive claude env knob is silently CLOBBERED once F2
lands, because envOverrides spread AFTER process.env): both the Pi and
claude cases narrow the window through the PRODUCT PATH — write a small
`contextWindow` into the connection's `models[]` entry in config.json
(which live-proves C2's sync consumption AND F2's threading end-to-end —
a strictly better case than an env override); Pi may still combine with
`NESSY_AUTO_COMPACT_WINDOW`, sized above the ~46k resting base. Claude:
measure the first turn's `inputTokens` first and size the window so the
threshold ≈ 2× that. Codex: runs AFTER F3 (the casing bug pins the
detector's counter at 0 until fixed); detector = Nessy's own
`session.jsonl` tokenUsage sequence — NO `CODEX_HOME` retention needed
(finding 18: the earlier retention sentence is WITHDRAWN; no F task adds
such a knob). Detectors per audit §5: Pi = `.pi-sessions/*.jsonl`
compaction entries for THIS session id; claude = `compact_boundary` in
the SDK's own session jsonl + tokens drop; codex = tokenUsage sequence
drop. Manual-compact half, BOTH branches pinned (finding 19): Pi+claude
via composer `/compact`; codex — if F3(d) landed `thread/compact/start`,
via the composer the same way; if the affordance was hidden instead, the
codex case DROPS the manual half and records the owner-shape amendment in
its checklist row. Threshold assertion: Pi+claude assert the trigger fired
at the computed threshold; codex asserts existence + drop only (F3's
decision). Order: D6 cases 3-4 first, F5 last before Z1 (finding 20).

KNOWN TRAPS that already cost
measurements (AGENTS.md): `ContextUsageSnapshot.lastCompaction` is typed
but never filled on the Pi path; `TokenUsage.contextTokens` and
`ContextUsageSnapshot.inputTokens` are DIFFERENT counters; a threshold
sized below the session's resting base (~46k) compacts after every turn
forever; `context_length: 1` from llm-proxy means "unfilled", and the
fetcher's `MIN_CREDIBLE_CONTEXT_WINDOW = 4096` floor treats small values
as absent. Owner addendum (2026-08-14): lane F's verification lands in the
CDP suite too — per-runtime live cases (the context indicator shows the
synced window; compaction/auto-compaction fires off the correct threshold),
joining the D6 checklist family.
OWNER-PINNED CASE SHAPE (2026-08-14, verbatim intent): ONE test per runtime
that (a) fills the session to ROUGHLY HALF the effective window and invokes
MANUAL compaction there — asserting the context actually comes back down
(the product-written detector: the session's own record, per the 2026-08-08
discipline — never a typed-but-unfilled field); then (b) keeps filling
until the auto-compaction threshold TRIGGERS on its own, asserting the
trigger fired at the right threshold and the context dropped again. Knob
discipline from AGENTS.md is mandatory: if `NESSY_AUTO_COMPACT_WINDOW` (or
equivalent) narrows the window to make the threshold reachable, size it
ABOVE the session's resting base (~46k) — a threshold below the floor
compacts every turn forever and reads exactly like "compaction is broken".
The audit must also answer WHERE manual compaction is exposed per runtime
(command/UI) so the case drives it the way a real user would.
F is DISPATCH-READY (verified 2026-08-14, wf_e7a95d57-fef) — but per the
F SEQUENCING block above, it starts only after lane E's last commit AND
the session-runtime-switching lane's commit both land.

### Lane G — form v2: llm-proxy-first presentation (owner review verdict
2026-08-14, discussed and AGREED point by point in chat)

The owner reviewed the live merged form and redesigned the presentation.
Full decision set (each confirmed explicitly):
- ONE field set on ALL runtime arms — the runtime radio chooses ONLY the
  harness (providerType), it never restructures the form. The two server
  submit shapes REMAIN under the hood (the landmine still stands); the UI
  just no longer shows the difference.
- URL: HARDCODED to `https://llm-proxy.t-tech.team` and HIDDEN on create
  («фактически урл можно зашить по дефолту и скрыть поле, просто потом мы
  откроем поле»). On EDIT of a connection whose stored URL differs (old,
  CLI-created, loopback/Ollama), the URL field IS shown so nothing breaks
  (owner: «да, хорошо»).
- Provider preset dropdown: REMOVED from the UI. The official
  Anthropic/OpenAI paths become unreachable from CREATE (existing such
  connections keep working and remain editable).
- Protocol: HIDDEN, pinned `openai-completions` (owner: «тогда можем
  скрыть?» after the measured rationale — llm-proxy serves every entitled
  model over OpenAI chat-completions and translates no protocols, so an
  Anthropic-protocol choice against it can only break; the radio returns
  when the URL field opens up; model FAMILY ≠ endpoint protocol; Qwen
  quirks auto-detected per model id, orthogonal).
- Dialect control: REMOVED from the UI; the E6 field stays config-level as
  an escape hatch; auto-detection by id does the work (owner: «я бы убрать
  и детектил при выборе модели»).
- Sync toggle: REMOVED; always ON («это не нужно юзеру мы это должны и
  так делать») — create stamps `modelsSyncedAt`, edit never withdraws.
  Tristate plumbing stays; the UI just always submits true on create and
  omits on edit.
- Model picker: after Fetch, AUTO-PROBE the ENTIRE catalog (1-token
  probes, batched ~8 concurrent, ~10-15s with a progress line), then group
  by AVAILABILITY — «Доступные (N)» first (families within), «Недоступные»
  collapsed below with RED minus/cross-in-circle marks (a11y label kept);
  only available models selectable; probe results cached per form session.
  Replaces both the by-provider grouping and the manual Check access
  button (owner asked for exactly this split).
- Utility model: the PROJECT's select component (Select or cmdk searchable
  — whichever the surrounding form code already uses), list = the SELECTED
  models (confirmed).

**PROTOCOL DISCOVERY (2026-08-14, measured with the owner's SECOND key —
CORRECTS the decision-set's premise):** llm-proxy is NOT single-protocol.
Measured live: `anthropic/*` models (11 in catalog) answer ONLY on
`/v1/messages` (Anthropic Messages; real completion received) and return
`400 {"error":"unsupported endpoint"}` on chat-completions — a PROTOCOL
verdict, distinct from entitlement's `404 {"error":"quota not found"}`.
Key 2 owns 10 anthropic models incl. claude-fable-5/opus-5/sonnet-5 plus
azure/gpt-4o. The remaining ~12 `unsupported endpoint` rows are the gemini
family (own Google path, out of scope). Probe corrections measured:
`azure/o4-mini` rejects `max_tokens` (needs `max_completion_tokens`) — the
probe must retry on that error shape or it manufactures a false
"unavailable"; a burst-throttled 429 maps to 'error' today and would
poison the grouping — batching + retry-on-429 required. OWNER DECISION:
Variant C — ship Anthropic-wire support NOW (G3), «нам нужно дать конечный
продукт». The URL base is SETTLED by the same measurements: bare
`https://llm-proxy.t-tech.team` serves `/models`, `/chat/completions` AND
`/v1/messages` — hardcode exactly that string.

**LANE G TREE DISCIPLINE:** the lane E discipline applies VERBATIM —
stage-by-path always; never touch/stage `FreeFormInput.tsx`,
`playground/registry/index.ts`, `runtime-switch.tsx` (third writer) or
Z1's prep (both package.json, release-notes/1.26.0.md, docs-site en+ru).
Lane G does NOT inherit F-SEQUENCING (G's zone is disjoint from the third
writer's files) — G runs now; F still waits. The F-block's line "D6 cases
3-4 run right after lane E" is SUPERSEDED: cases 3-4 run against form v2
after G.

**G1 `fix(ui): merged form live defects from the owner review`**
(1) STALE SERVER ERROR + TWO WIRING GAPS (path pinned by verification —
not the catalog RPC, which sends provider:'anthropic' and returns before
validateSetupTestInput): `handleSubmitByoRuntime`'s Pi-arm delegation
(useOnboarding.ts:821-839) passes `customEndpoint` but NO `piAuthProvider`
(the field doesn't exist on the Pi member of ByoRuntimeSubmitData) →
`handleSubmitCredential` computes setupTestProvider='pi' → the guard at
connection-setup-logic.ts:65-69 fires. BLAST RADIUS: EVERY Pi/Custom
CREATE is blocked, and EDIT too (the mask prefill is non-blank so the
skip-test early-return never triggers) — this is what the owner hit. Fix:
derive `piAuthProvider` from the effective protocol exactly as the save
path does (anthropic-messages→'anthropic', else 'openai') and pass it
through the delegation; rewrite the guard's message for the merged-form
world (+ its test in connection-setup-logic.test.ts, the sole other
consumer). SECOND GAP behind the guard: the Pi-arm delegation forwards the
MASK verbatim as apiKey (:824→:504) — the runtime arms strip it, the Pi
arm does not; once the guard is fixed the mask reaches a real agent-spawn
test. Fix both; regression tests for both.
(2) SCROLL — REAL DIAGNOSIS (verification overturned the "live vs
playground" premise): TWO NESTED SCROLLERS. ByoRuntimeStep wraps the
picker in `max-h-72 overflow-y-auto`, while ModelCatalogPicker passes
`scrollAreaClassName="max-h-64"` onto a Radix ScrollArea ROOT — and
max-height on a Root whose height is auto means the Viewport's `h-full`
cannot resolve, so the Root merely CLIPS (overflow-hidden), which is not
wheel-scrollable. Same in playground and live; E4's measurement measured
the OUTER wrapper's ~60px travel, not the list. Fix: move the max-height
onto the ScrollArea VIEWPORT (the known Radix pitfall), drop the
double-wrapping, re-measure the VIEWPORT's clientHeight/scrollHeight +
wheel response live. Autonomous live recipe (form v1 still has the URL
field at G1 time): point the create form at a local loopback stub serving
~300 `/models` rows — keyless-loopback is allowed, Fetch enabled.
Gate: live re-measure of the Radix viewport; both wiring gaps as
regression tests; `typecheck:electron` + server-core typecheck.

**G2 `feat(ui): form v2 — llm-proxy-first presentation`**
Implement the decision set with the verification's pins:
- SUBMIT INVARIANT IS CREATE-SCOPED (blocker fix): on CREATE the Pi arm
  always submits the custom shape (preset pinned 'custom', hardcoded URL,
  customEndpoint api:'openai-completions'); on EDIT the preset from
  initialValues still decides, exactly as today. `preset` SURVIVES as
  non-UI state — the radio dies, the matrix, `usesOfficialPiEndpoint`,
  the four-target router and the E3 invariant tests stay UNCHANGED
  (protected: byo-runtime.test.ts :388-:405, :551, :557, :608).
- OFFICIAL-CONNECTION EDIT (blocker fix): an official connection stores NO
  baseUrl — the URL-visibility rule is ORDERED: official (from
  initialValues.preset) → hide URL/models exactly as today, submit through
  the unchanged delegation, static provider caption where the radio was;
  the foreign-URL rule applies only to non-official shapes. OWNER
  REFINEMENT (2026-08-14): the foreign-URL field on edit is shown
  DISABLED — visible so the user knows where the connection points, but
  not editable («нужно будет его задизеблить что б нельзя было
  изменить»). The submit keeps the stored URL verbatim; the
  arm-switch-preservation test's typed-URL round trip therefore moves to
  a unit-level builder test instead of the edit-path UI.
- STORED-KEY EDIT + GATE (blocker fix, replaces the fictitious
  stored-key branch): extend TEST_LLM_CONNECTION_SETUP with optional
  `slug` — the handler resolves the STORED credential server-side for
  fetch/probe (the mask never crosses the wire). This makes the edit path
  fetch WITHOUT retyping (the fd51699b2 refusal stays for the no-slug
  case) and makes most of the live walk autonomous; the CREATE walk's
  typed-key half folds into the owner's check-in.
- PROBE: client chunks the catalog into ~8-id `validateModels` calls,
  sequential awaits, progress = chunks done/total; NEVER one full-list
  call (the handler's Promise.all is unbounded — 386 simultaneous
  sockets); abort = stop issuing chunks on unmount; results cached per
  form MOUNT. Verdicts are THREE-class: available(wire) / unavailable
  (no quota) / unsupported-endpoint → carried per model. OWNER REFINEMENT
  (2026-08-14) — NON-BLOCKING LOADER: use the PROJECT's existing
  spinner/skeleton component (whatever the surrounding surfaces already
  use — reuse, don't invent), and the probe must NOT block the UI: the
  catalog renders immediately after Fetch, verdicts STREAM in per chunk
  (rows update/regroup as their verdict arrives, pending rows carry the
  loader mark), and the user can already select verified-available models
  while later chunks are still probing. The form stays fully interactive
  throughout. Probe fixes:
  retry with `max_completion_tokens` on that error shape; 429 → retry
  with backoff, never 'unavailable'. Rewrite the stale header comment in
  openai-compat.ts (:86-89 "never for the catalog" is now false).
- PICKER (shared with legacy — no fork): availability grouping engages
  ONLY when probe verdicts exist; with none, today's by-prefix
  presentation + manual Check access survive (the legacy ApiKeyInput
  surface keeps them). Two-level grouping synthesized as ordered flat
  groups (available families first, then ONE collapsed «Недоступные»
  group; section-prefix the collapse keys to avoid collisions). RED
  minus/cross for unavailable (restyle VERDICT_STYLE's no-quota — don't
  add a parallel style); `EntityRow` gains a small `disabled` extension
  (aria-disabled + styling) — only available rows selectable.
- RUNTIME-ARM SUBMIT GAP (lane-E defect found by verification, fix here
  with regression test): the runtime-arm call at useOnboarding.ts:872-882
  passes NEITHER `modelsSyncedAt` NOR `miniModel` — buildByoRuntimeSetup
  accepts both, the call drops both, so claude/codex creates never stamp
  and the utility model is a no-op on those arms.
- Always-on sync: create stamps via the existing tristate (submit true),
  edit omits (leave persisted). Consequence, stated so it isn't refiled:
  an existing unstamped connection is never enrolled by editing it.
- DIALECT PRESERVED ON EDIT: the control dies, but
  `initialValues.dialect` threads through the submit unchanged — an
  existing forced 'qwen' survives re-save (test: edit round-trip).
- KEYLESS-LOOPBACK CREATE dies with the hidden URL — ACCEPTED consequence
  (the owner's «потом мы откроем поле» makes it temporary); loopback
  tests stay alive via the edit path.
- Utility model: `ui/select.tsx` Select (list ≤ selected models — search
  unneeded). Submit derivation that moves into useOnboarding: the
  protocol→piAuthProvider derivation (G1) and always-on sync stamping.
- i18n: dies — onboarding.byoRuntime.dialect* (control removed); born —
  group headers with counts, probe progress, red-mark a11y label,
  «unsupported-endpoint» reason strings; preset*/protocol*/endpoint keys
  SURVIVE (edit path + the radio's planned return). Delete dead keys in
  BOTH locales same commit (parity checks parity, not deadness).
- Tests rewritten-not-deleted (each records its change of answer):
  'never labels the fetched list available' → "available" appears ONLY in
  probe-result strings, never raw-catalog strings; 'probes only the
  selection' → v2 probes the catalog, the LEGACY surface still probes
  selection-only (surviving half); arm-switch preservation extends to v2
  (typed-URL round trip moves to the edit-path variant); ByoRuntimeStep
  gains a source-pin for `isEditing ? omit : stamp`. E4 playground
  entries reworked to v2 states (existing files only).
Gate: form tests incl. extended invariants + the three-class probe;
`typecheck:electron` + server-core typecheck (slug RPC); i18n
parity+sorted; playground sweep dark+light of v2 states; autonomous live
walk of the EDIT path via the slug RPC against the owner's connection
(read-only); the CREATE typed-key walk at the owner's check-in.

**G3 `feat(claude): Anthropic-wire models through llm-proxy (owner:
Variant C — конечный продукт)`**
The Claude runtime learns to PASS THROUGH Anthropic Messages to an
upstream that speaks it natively — the SDK already emits Messages; the
loopback adapter stops translating for those models:
- `UpstreamTarget` gains its long-anticipated third member
  `{kind:'anthropic-messages', baseUrl, apiKey}` (nestor-client.ts:32-36
  — the comment predicts it; the exhaustiveness-checked switch names
  every site to update). resolveUpstreamRequest for it: POST
  `{base}/v1/messages`, body passthrough, `Authorization: Bearer`,
  `anthropic-version` preserved.
- PER-REQUEST routing by model wire: the connection's models carry the
  probe's wire verdict — `ModelDefinition` gains optional
  `wire?: 'anthropic-messages'` (absent = openai) — persisted via the
  storage allowlist (the #838 trap: add it there or it vanishes), written
  by G2's probe on save, and the claude adapter routes each request by
  the REQUESTED model's wire. Mixed connections (qwen + claude-fable-5)
  work on the claude arm: chat-completions for one, passthrough for the
  other.
- PER-ARM AVAILABILITY in the picker: anthropic-wire models are
  AVAILABLE on the claude arm; on Pi and codex arms they land in
  «Недоступные» with the honest reason «доступна только на Claude Code
  рантайме» (Pi single-protocol per connection; codex adapter
  chat-completions-only — both recorded as the reason, not hidden).
- The 24h metadata sync for a connection carrying anthropic-wire models
  must not clobber them: the openai-compat fetcher won't see them in
  `/models`? — VERIFY: GET /models lists all 386 incl. anthropic (it
  does — measured), so contextWindow merge works unchanged; the `wire`
  field is NOT in the merge's overwrite set (merge-never-replace).
- Live proof (the lane's acceptance): a claude-runtime BYO llm-proxy
  connection turns with an anthropic-wire model end-to-end (real
  completion via /v1/messages passthrough) AND a mixed-model session
  routes both wires correctly. Needs an entitled key typed at the
  owner's check-in (key 2 is anthropic-entitled — the owner types it
  into the form themselves; the planner's chat copy is never forwarded).
Gate: adapter unit tests (routing table both wires + exhaustive switch);
contract-suite risk trigger (codex-responses-adapter + shared drivers);
the live proof above; `typecheck:all` on the final G diff.

**G2 `feat(ui): form v2 — llm-proxy-first presentation`**
Implement the decision set above in `ByoRuntimeStep.tsx` + `byo-runtime.ts`
(+ `useOnboarding.ts` where submit derivation moves). Key invariants:
- Submit shapes UNCHANGED at the server boundary: Pi arm always emits
  customEndpoint {api:'openai-completions'} + the hardcoded URL (→
  pi_compat, protocol-derived piAuthProvider='openai'); claude/codex arms
  keep the no-customEndpoint runtime shape with the hardcoded baseUrl. The
  E3 bidirectional invariant tests EXTEND, never weaken.
- Edit of foreign-URL connections shows the URL field (read-write), and
  the four-target router keeps sending exotic Pi connections to the legacy
  surface.
- Auto-probe: extend the existing validateModels RPC path to accept the
  full catalog id list (it already probes per-id; batching client-side);
  cache per mount; abort on unmount/URL-of-edit change.
- Availability grouping + red marks in `ModelCatalogPicker` (extend, do
  not fork); only-available selectable; the by-prefix family grouping
  survives INSIDE the available section.
- Always-on sync: create stamps `modelsSyncedAt` via the existing tristate
  (submit true); edit omits (leave persisted). E2's enrollment predicate
  is untouched.
- i18n both locales; playground entries updated to v2 states (existing
  files only); arm-switch value preservation test extends to the v2 field
  set.
Gate: form tests incl. the extended invariants; `typecheck:electron`;
i18n parity+sorted; playground sweep dark+light of v2 states; live CDP
walk of the create path against the real llm-proxy (the owner's key is in
the encrypted store for the existing connection; the CREATE walk needs a
typed key — fold into the owner's next check-in OR use the stored-key
edit path for the interactive half).
Then: case 3's assertions re-run against form v2 (Fetch → availability
groups → save → config carries contextWindow + modelsSyncedAt → TTL
restart no-refetch), case 4 per its pinned prerequisites, lane F, Z1.

**LLM-PROXY TOOL-ALLOWLIST GUARDRAIL (found live 2026-08-15, owner-deferred):**
a claude-runtime turn against llm-proxy with the real tool surface returns
`403 Security Guardrail Triggered: Malicious MCP detected. Invalid tools:
mcp__…` — llm-proxy admits only basic tools/integrations per ITS OWN
allowlist; our minted `mcp__session__*` / `mcp__plugin_*` / `mcp__dpGitlab__*`
names are not on it. NOT our defect: G3's wire mechanics are proven
(negative control ok+wire; the owner's real save persisted wire+1M window;
gateway positive control GW-OK with the same tool surface). Owner decision:
DEFER — the fix is a conversation with the llm-proxy team (align the
allowlist or our naming), later plan. Known blast-radius question, being
answered free by the queue: BYO-QWEN and CODEX-TURN run tool-carrying
chat-completions turns against llm-proxy — they reveal whether the
guardrail polices that wire too or only `/v1/messages`. Related defect
filed: the SDK maps this 403 to «Your API key may be invalid or expired»
(claude-sdk-error-mapper.ts:253) — a misdirecting message that sends users
to re-enter a working key; fix = honest guardrail-rejection text.
GUARDRAIL RULE CORRECTED BY DIRECT PROBE (2026-08-15, planner, two probe
runs against /v1/messages with the anthropic-entitled key — supersedes the
naming-mismatch hypothesis): (1) our `mcp__dpGitlab__*` READ tools PASS
(200) — and so do corp-segment names, `mcp__dpJira__*`, `mcp__wixie__*`:
the guardrail recognizes dp integrations regardless of segment spelling;
(2) within known integrations there is a PER-TOOL DENY mirroring tclaude's
corp deny list exactly (`create-merge-request`, `fork`, `whoami` → 403 —
platform policy on write/identity operations, not our defect); (3) UNKNOWN
servers are rejected wholesale: `mcp__session__*`, `mcp__plugin_*`, and
even native-form user MCP (`mcp__linear__createIssue`) → 403. Therefore
RENAMING CANNOT FIX the Anthropic path (native-form names are rejected
too); the fix is REGISTRATION of `mcp__session__*` (finite, we are the
sole minter) + a negotiated pattern for plugins/user sources, via
~nestor-ask + the ИБ ADR round. Bare names (`Bash`, `source_manage`) pass
— relevant to the unification candidate below. ALSO live-proven by the
dpGitlab smoke on the default gateway session: `mcp__dpGitlab__dp_gitlab_merge-requests`
called end-to-end, real MR data returned (the branch's own MR #45) — the
llm-proxy restriction is path-local, confirmed by execution.
FILED FROM THE SMOKE, two candidates: (a) Explore mode (the DEFAULT)
misclassifies the READ-ONLY dp MR listing as an "external mutation" and
blocks it — a default-mode user cannot list MRs; review dp-tool
classification (small fix, candidate for this plan's tail or next);
(b) dp tools require a `tenant` the model cannot infer — derivable from
the workspace git remote; a tool-description hint would save a round trip
(minor, next plan).
CANDIDATE (owner 2026-08-15, decision after their llm-proxy allowlist
look): UNIFY session-tool wire names across the three runtimes
(«привести тулы для pi, claude, codex в идентичный вид»). Current state
per the t-agents analysis (assets/2026-08-15-t-agents-analysis.json):
integrations/plugins/dp are ALREADY identical on all runtimes (single
mint); only the SESSION family diverges — Pi sends bare names
(source_manage, TodoWrite), Claude/Codex ride the MCP bridge as
mcp__session__* (the Claude SDK cannot register bare-named tools, so the
only unifiable direction is Pi ADOPTING the mcp__session__* prefix).
Benefit: ONE canonical registrable list covers all three runtimes at the
proxy allowlist. Cost (moderate, next plan): Pi binding/wire renames touch
session transcripts, permission rules, the guardian policy's tool
references, pre-tool-use classifiers and the harness baseline — the
manifest-digest discipline catches drift, but this is a lane, not a
drive-by.

### Lane H — Guardian honesty + entitlement-aware judge model (owner
directive 2026-08-15; analysis at `assets/2026-08-15-guardian-analysis.json`)

Findings (planner workflow wf_f9528ac5-825, all code-verified): the judge
is Pi-only (port wired only for provider='pi'; claude/codex/anthropic/
cloud runtimes have ZERO guardian code) while the settings section renders
unconditionally and promises the deny-net with no runtime qualifier — a
silent whole-runtime fail-open; the global `guardianJudgeModelId` picker
offers the DEFAULT connection's catalog but applies to every Pi session on
every connection (per-key entitlement variance → 403 → unsure → ask per
risky action, fail-closed but silently degraded, judge failures invisible
— the downgraded prompt is indistinguishable from a normal one); Ollama
cold models routinely blow the judge's 15s timeout; gitBranch/
protectedBranch facts declared but never populated; the subprocess
guardian-runner has no production call site.

**H1 `fix(guardian): honest scope + judge model resolves per session
connection`** — owner-pinned semantics («нужно предоставить некий выбор,
если модель вовсе одна — она и будет работать»):
(1) The judge model is configured PER INTEGRATION — owner refinement
2026-08-15: «нужно добавить еще селект который будет выбирать интеграцию
и второй селект который будет выбирать модель в зависимости от выбраной
интеграции, потому что не может быть одна модель судьей для разных
интеграций». Settings UI: TWO dependent selects — integration
(connection) → model from THAT integration's catalog only. Storage: a
per-connection map `guardianJudgeModels?: Record<slug, modelId>` (type +
validators + the storage update-merge allowlist — the #838 drop trap —
+ settings RPC), replacing the global `guardianJudgeModelId` in the UI.
Resolution at consult time, per session: this connection's map entry
(present in catalog and allowlist-clean) → legacy global id if valid on
THIS connection (no data migration; kept as silent fallback) → gateway
`fast` alias when the catalog has one → the session model. A single-model
connection trivially uses its model — no choice needed. Stale map entries
(connection deleted / model gone from catalog) resolve down the chain,
never error.
(2) Settings honesty: the Guardian section states the Pi-runtime scope
(both locales) until coverage widens.
(3) Failure visibility: when a band consult falls back to ask because the
judge FAILED (spawn error/timeout/schema), the resulting prompt carries a
small marker (i18n) so a broken judge is distinguishable from a normal
question; the debug line stays.
(4) CUT ✂️ — DEFERRED to the next plan (planner decision 2026-08-15 after
a rule-8 stop, independently verified). The task said to reuse «the source
the protected-branch enforcement in pre-tool-use already reads». THAT
ENFORCEMENT DOES NOT EXIST: `pre-tool-use.ts` imports protected PATHS, not
branches; the ONLY branch reader in the repo is
`RPC_CHANNELS.git.GET_BRANCH` (`server-core/handlers/rpc/system.ts:186`,
an execSync handler serving the RENDERER, unreachable from the shared
consult site); the nearest default-branch notion is
`worktree-git-plan.ts`'s `refs/remotes/origin/HEAD`. So the only two ways
to do (4) are to invent the detector the task forbids, or to thread a NEW
host→shared seam for branch state — a scope decision, not an executor
call. The finding stands and is worth keeping: the guardian policy's
hard-deny list cites protected-branch git while
`GuardianSessionFacts.gitBranch/protectedBranch` are never populated, so
the judge is asked to reason about a fact it never receives. NEXT-PLAN
SHAPE (cheapest, recorded): SessionManager already runs git in the
workspace root — cache the branch on the session and pass it at consult
time, reusing that rather than adding a second detector.
(5) The DEAD subprocess judge-runner
(`pi-agent-server/src/orchestrator/guardian-runner.ts`, tests-only
importers): check the inert-worklist/plan history first (the repo's
standing discipline — some "dead" code is a recorded decision); if no
owner decision protects it, DELETE it with its tests, recording in the
commit that the host-side port superseded it; if protected, record why it
stays.
Gate: resolution unit tests (preference-on-this-connection; absent →
fast → session; single-model case; allowlist veto), settings copy tests,
marker render test, judge-facts population test (branch + protected flag
reach buildGuardianJudgeTask); typechecks; i18n parity+sorted.

RUNTIME-COVERAGE RESEARCH LANDED (workflow wf_76e848bb-151, doc-cited,
full output at `assets/2026-08-15-guardian-docs-research.json`) — the
follow-up is now CHEAP and precisely specced:
- **claude-runtime — NEEDED, HOSTABLE-VIA-PreToolUse-hook.** Claude Code
  ships a native classifier judge (auto mode) but `auto-mode-config.md`
  gates it on first-party models/providers — unusable on gateway models
  through our loopback adapter. The docs name the hosting point: a
  PreToolUse hook's deny "applies even in bypassPermissions mode" while
  `canUseTool` is documented as SHADOWED there. Our `claude-agent.ts`
  already owns the sole internal PreToolUse hook running
  `runPreToolUseChecks` — OUR judge becomes one more check in the
  existing pipeline, same bands as Pi. Cost: S-M.
- **codex-runtime — NATIVE auto-review exists, enable don't port.**
  `approvals_reviewer = "auto_review"` routes approvals through codex's
  own reviewer agent (fail-closed; its own 3-consec/10-in-50 breaker;
  `/approve` override). First-class per-thread field `approvalsReviewer`
  on `thread/start` — no TOML rewrite, no respawn. We set neither today
  and the event adapter silently DROPS all three guardian notifications
  (started/completed/guardianWarning) — surface them. PRACTICE CHECKS
  required against the pinned binary: eligibility needs an interactive
  `approval_policy` ("with `never` there is nothing to review" — verify
  what our config emits), and whether `features.guardianv2` gates the v2
  notifications. `[auto_review].policy` can carry our policy additions.
  Cost: S-M. Both = the opening tasks of the NEXT plan unless the owner
  pulls them into this one.

LIVE-PHASE HANDOFF #4 (2026-08-15, builder session went DEAD-SILENT mid-F5
— 23 min, no commits, no tree movement, no reply to two pings; its socket
was alive and the app answered CDP, but ZERO session-store writes in the
window, so it was a hung tool call, not a long live run):
- LANDED through `6fa907d71`: H1 ✅ (per-integration judge, Pi-scope
  honesty, failure marker; (4) cut, runner kept), lane F1-F4 ✅
  (`f9de3fdff` `5f9f82b33` `546c79368` `c68934a78`), D6 cases 3-4 ✅, and
  the F5 driver `scripts/cdp/cases/compaction-lifecycle.ts` WRITTEN but
  NEVER RUN.
- REMAINING: F5 live (three runtimes, owner-pinned shape: fill to ~half →
  manual compact → context provably drops → fill to threshold →
  auto-compaction → drops again; detectors per lane F's task text; Pi and
  claude narrow the window through the PRODUCT path — a small
  contextWindow written into the connection's models[] — never the env
  knob F2 now clobbers), then Z1 close-out.
- Z1 prep already on disk UNCOMMITTED: both package.json at 1.26.0,
  `release-notes/1.26.0.md`, docs-site custom-endpoint en+ru. Z1 must
  AMEND those notes for lanes E/F/G/H and the live findings before the
  first commit, pay or re-file the D5 OAuth regression-test debt, run the
  full wave (`rm -rf release` FIRST), and regenerate the deviation
  register.
- THE PARKED STASH IS INTACT: ref `878a29fae2610648ebe45cf3ef0c8c04a455608c`
  (four files, verified by the orchestrator to apply onto this HEAD with
  zero conflicts). Hand the REF to the runtime session, never the index.

**F6 `fix(claude): the session reports context occupancy`** — FOUND BY F5,
and it makes F4's claude half inert: after a completed turn the session
reports `inputTokens: 0` / `contextTokens: 0` / `cacheReadTokens: 0` while
the SDK's own `modelUsage['tgpt/…'].inputTokens` for that SAME turn is
58 392. Reproduced on the owner's own `claude-gateway` sessions (0 against
58 377 / 86 540 / 86 554) — PRE-EXISTING, not lane F's doing. Consequence:
the donut has a correct denominator (F2 works — 240 000 reaches the SDK
and echoes back) over a permanently ZERO numerator, and F4's
`formula-claude` threshold has nothing to compare against. `modelUsage`
cannot substitute: `mergeModelUsage` SUMS input across turns. CANDIDATE
CAUSE, unverified by the finder and to be verified not assumed:
`event-adapter.ts` `isSidechain = parent_tool_use_id !== null` treats an
ABSENT field as a sidechain (`undefined !== null` is true), which would
drop every main-line usage event. Gate: a unit pin that an assistant
message with NO `parent_tool_use_id` yields a usage event, plus one live
turn showing non-zero occupancy on a claude-runtime session.

**F7 `fix(codex): auto-compaction has a limit to fire on`** — FOUND BY F5:
manual `/compact` works (124 162 → 63 681 via `thread/compact/start`), but
the automatic net never fires — five turns reached 208 731 of a 228 000
window (91.5%) and a settling turn moved it UP to 210 499. Cause is F3's
own recorded decision to leave `model_auto_compact_token_limit` unwritten;
that decision was made when we had no window to derive from, and F3(b) now
writes `model_context_window`, so the limit IS derivable. Write it from
the same source (keep it strictly below codex's measured ~5% reserve —
240 000 → 228 000 usable), and assert live that auto-compaction fires and
the context comes down. Owner's requirement was «корректная компакция И
автокомпакция» — manual alone does not meet it.

FILED, NOT FIXED HERE (own tasks; the first is URGENT and environmental):
- **`getStableMachineId()` is not stable, and its failure reads to the
  user as credential-store corruption.** It shells out to `ioreg` (in
  `/usr/sbin`) and silently falls back to `username:homedir`; the two
  derive DIFFERENT v2 keys with no migration, so a launch with a different
  PATH reports «Credential store is corrupt … decryption failed with all
  known keys» and every connection appears to lose its credential. Hit
  LIVE between two identical `electron:dev` launches during F5. Nothing
  was lost (the store fails closed; an out-of-band read confirmed all 11
  entries decrypt with the fallback key), but the failure mode is
  indistinguishable from data loss for a user. NOTE FOR ANYONE RUNNING THE
  APP: the currently-running instance was started with `/usr/sbin` removed
  from PATH to match the key the store was written under — a plain
  `bun run electron:dev` from a full shell PATH will show the "corrupt"
  message again.
- `Session.contextUsage` is projected by `getSessionMessages(id)` but never
  by `getSessions()` (0 of 383); composer capabilities do not refresh when
  a session's connection is switched (a claude session created on the pi
  default kept `thresholdKind: 'real'`). Minor, next plan.

**F8 `fix(ui): the usage overlay's Context row stops reading zero`** —
FOUND BY F5's re-run, and it means F6 is only half-delivered:
`formatContextUsage` takes `contextTokens ?? inputTokens` while
`ensureTokenUsage` INITIALISES `contextTokens` to 0, so `??` never falls
through and the row reads 0 on claude and codex even though F6 made
`inputTokens` correct. Positive control already measured on the real
formatter with the run's own DTO: `"0 / 240,000 (0%)"` against a Pi-shaped
`"132,377 / 240,000 (55%)"`. The donut is correct — only the overlay lies.
Fix the fallback (a 0 is "no observation", not a reading) at every
consumer of that pair; `applyContextUsageSnapshot` remains the only writer
of `contextTokens` and stays Pi-only. Gate: a formatter unit test with
both DTO shapes, plus a grep-driven sweep for other `contextTokens ??`
sites.

**F9 `claude-runtime automatic compaction: fix it or state it`** — F5
measured, with the manual path working in the SAME session as the control:
carried to **227 337 tokens, 94.7% of the 240 000 window the SDK itself
reports**, 20 337 past F4's 207 000 formula point — no drop, no second
`compact_boundary`, no errors. `DISABLE_AUTO_COMPACT` is Pi-path-only and
is never set for the Claude subprocess, so that is not the cause. VERIFY
the real reason before deciding (the SDK's own auto-compaction gating —
model/provider allowlists are documented in `auto-mode-config.md` for auto
MODE; check whether compaction has its own gate, and whether our
bypassPermissions + custom-hook configuration suppresses it). Then EITHER
enable it if it is ours to enable, OR record the limitation honestly with
the evidence and make sure the user is not left unwarned (F4's threshold
warning and the working manual `/compact` are the current mitigations).
Do not fake it: a compaction that never fires must not be described as
working.

FILED, NOT FIXED (own task, next plan — severity above its size):
**an upstream 400 reaches the user as «Unknown Error: An unexpected error
occurred.» AND the runtime then silently starts a NEW conversation**
(`parentUuid: null`), discarding history with no notice, while the
transcript holds the exact upstream sentence. F5's re-run hit this when a
filler step overshot the fitting band, and the resulting occupancy drop
was INDISTINGUISHABLE from a working compaction — it passed a check
dishonestly until the driver was hardened to require an empty error-row
diff. Two halves: the message (same class as the 403 mis-mapping already
fixed in this plan) and the silent conversation reset (the dangerous one).

### Lane Z — integration + close-out (single-threaded, after A+B+C+D+E)

**Z1 `chore(release): close out runtime-icons/plates/model-sync`**
NOTE (F14): the pre-staged 1.26.0 files (`release-notes/1.26.0.md`,
docs-site custom-endpoint en+ru) were written BEFORE lane E existed and
describe the catalog picker on the OLD form. They are UNCOMMITTED prep —
the append-only release-notes rule applies to committed history, not to
prep that never landed — so they MUST be amended with the merged-form and
D7 content before their first commit.
Steps per AGENTS.md close-out: bump version in BOTH root `package.json` and
`apps/electron/package.json` — **1.26.0, minor** (owner decision 2026-08-14,
confirmed directly in the builder's session, superseding this plan's
original patch-bump default: the train carries new user-facing features —
model catalog sync, the source_manage tool, runtime marks); add
`apps/electron/resources/release-notes/<version>.md` (`# Nessy Desktop
<version>`, date line, `## NEW` / `## IMPROVED` / `## FIXED`); update
affected `docs-site/` pages (settings/connections page for C3 sync, any
screenshots that show the old icons if the site carries them).
Final regression (verification-wave boundary): `bun run typecheck:all`,
`bun run lint`, `bun run test:shared:all`, `bun test` (with `release/`
absent), `bun run lint:i18n:parity`, `bun run lint:i18n:sorted`.
Deviation register: this plan carries no deviation category strings, so
`python3 scripts/regenerate-deviation-register.py` is a no-op — run it
anyway and record "no-op, no categories in this plan" in Z1's tracker note
(silent skip is indistinguishable from a forgotten one).
`rm -rf release` BEFORE `bun test` if a packaged build was made for
evidence. Check `docs/superpowers/specs/2026-07-29-known-failing-tests.md`
before recording any new failure; compare against `master`'s pipeline, not
only this branch's base.

## Risks / traps for the executor

- **NEVER redirect `electron:dev` output to a file you keep for the whole
  session.** Its log writes a `[sessions:get] result` line every ~2 seconds
  carrying the full id list of ALL sessions on the profile (358 on the
  owner's), forever, idle or not — a kept redirect ate the entire volume
  twice on 2026-08-14 (ENOSPC killed the builder session mid-command both
  times). Pipe through a `grep -E` filter for the lines the arm needs,
  truncate between arms, or `/dev/null` it and read the product's own
  session jsonl — the better evidence source anyway (D5/D7 discipline).
  Run the dev server only for arms that need it. The 2s full-payload
  `sessions:get` line itself is LOGGED, NOT CHASED as a chatty-IPC
  observation — not this plan's task.

- `mock.module` without spread+restore amputates modules process-wide —
  follow `claude-gateway-adapter.test.ts:79` pattern in any new test mocks.
- Two concurrent `bun test` runs manufacture failures — serialize gates.
- `provider-icons.ts` return-type change: update BOTH consumers in the same
  commit (A2 file zone) — a half-migrated union breaks settings rows.
- The overrides-spread trap (stale persisted fields silently win) applies to
  C1 exactly as documented at nestor.ts:64-76 — explicit fields AFTER spread.
- Playground `registry/index.ts` categoryOrder silently drops unknown
  categories — no new categories are planned; if adding one anyway, update
  `types.ts:23` + `index.ts:79` together.
- `pi-agent-server` test files are NOT covered by `typecheck:all`, and C6
  DOES touch two of them — typecheck those files with the exact command
  pinned in C6's gate (the package tsconfig excludes `**/*.test.ts`;
  AGENTS.md records one green-exit citation that hid 15 real errors).
- Any ABSENCE claim in a gate ("no leftover `<img>`", "no remaining static
  imports") must run through `rg -uuu` or `grep -ra` — several files carry
  a NUL byte and plain rg/grep skips them silently.

## Tracker

Each task = ONE commit using the message in its heading; flip the row glyph
and write the note IN THAT SAME COMMIT (AGENTS.md tracker rule). No MRs, no
tags, no Co-Authored-By trailers. Glyphs: the AGENTS.md set ⬜/🔄/✅/⏸ plus
✂️ = deliberately cut by owner decision (extension, declared here).

| Task | Status | Commit | Note |
| --- | --- | --- | --- |
| A1 mono runtime marks | ✅ | `28819f312` | `components/icons/runtime/{ClaudeIcon,OpenAiIcon,PiIcon}.tsx` + `index.ts`; paths copied from the vendored lobehub SVGs (no network, no npm dep), license line in each file. Props are declared inline per component (`{ className?, size? }`) rather than in a shared `types.ts` — the plan's file list names only the three components + index. `bun run typecheck:electron` → tsc --noEmit, exit 0. Playground: three `runtime-mark-*` entries under Icons, swept dark then light — Claude/OpenAI marks inherit `text-foreground` in both themes, PiIcon on the `text-accent` knob renders purple in both (currentColor proven). |
| A2 provider icon mapping | ✅ | `fd9aec9f3` | `{kind:'component',Component}\|{kind:'url',url}` union; claude-runtime→ClaudeIcon, codex-runtime→OpenAiIcon, anthropic→ClaudeIcon, openai/openai_compat→OpenAiIcon, nestor-cloud-agent→NessySymbol, gateway-baseUrl pi/pi_compat→NessySymbol, unknown pi/pi_compat→PiIcon (Brain stays for non-pi unknowns); providerIcons map now holds ProviderIcon values, brand keys are components. Both consumers migrated in this commit; `pi.svg` deleted. DEVIATION (planner-approved): the plan's `shared/auth/index.ts` re-export + `@nessy-agent/shared/auth` import BLANKS the renderer — that barrel re-exports `callback-server.ts`, which imports node `http`; measured `Uncaught Error: Module "http" has been externalized for browser compatibility` and an empty playground page while `typecheck:electron` stayed exit 0. Landed instead: one additive line in `packages/shared/package.json` (`"./auth/nestor": "./src/auth/nestor.ts"`, matching the existing ./auth/dp\|callback-page\|types entries) + import from `@nessy-agent/shared/auth/nestor`; `src/auth/index.ts` is byte-identical to HEAD. Also in scope by the same approval: the A1 marks accept `'aria-label'` and set `role="img"` — a function component silently DROPS an unknown aria-label, so the naive `<img alt>`→component swap lost the accessible name (A4 covers the same hole in NessySymbol). Gates: `bun test` on PluginOriginBadge + the new provider-icons mapping test → 11 pass / 0 fail / 29 expect(); `bun run typecheck:electron` exit 0; `rg -uuu 'provider-icons/pi\.svg'` → zero in apps/packages (only `.references/` snapshots + stale `.git/worktrees/*/index` binaries). Playground swept dark→light: marketplace-browse badges render the OpenAI/Claude/Nessy marks inline (currentColor in both themes), mobile-webui SessionList/ChatDisplay load clean. The mobile composer's "input failed to load" is PRE-EXISTING — reproduced identically at HEAD with the diff stashed (`window.electronAPI.listRecentProjects is not a function`, absent from the playground mock). |
| A3 onboarding/settings cards | ✅ | `b660cb01a` | `PROVIDER_ICONS` now differentiates by runtime: `nessy`/`nessy_cloud` keep NessySymbol (accent), `nessy_codex`→OpenAiIcon, `nessy_claude`→ClaudeIcon, `claude`→ClaudeIcon, `chatgpt`→OpenAiIcon; both `@/assets/provider-icons/{claude,openai}.svg` imports deleted. One file changed — neither playground registry carried a brand `<img>` (checked), so `registry/onboarding.tsx` and `registry/marketplace.tsx` were sweep targets only. Gates: `bun run typecheck:electron` exit 0; `git diff --check` clean; `rg -uuu 'claudeIcon\|openaiIcon' apps` → zero. Playground `provider-select-step` swept dark→light with all seven cards forced visible (the playground mock resolves the default flag set, which hides four of them; overrode `window.electronAPI.getProviderFlags` in-page and remounted — inspection only, no product change): Pi/Cloud purple N, Codex agent + ChatGPT Plus the OpenAI knot, Claude Code agent + Claude Pro/Max the Claude sunburst, all inheriting foreground in both themes. NOTE for the planner: `assets/provider-icons/{claude,openai}.svg` are now orphaned (zero importers) — NOT deleted, since only pi.svg's deletion was planned. |
| A4 NessySymbol aria-label | ✅ | `80d3130c1` | NessySymbol accepts optional `'aria-label'` and sets `role="img"` only when it is present (decorative otherwise) — same pattern as the A1 marks. The badge test now asserts `aria-label="Nessy"` on the nessy-format badge, which was RED before the component change (the prop was silently dropped) and is green after. Gates: `bun test PluginOriginBadge.test.tsx` → 5 pass / 0 fail / 17 expect(); `bun run typecheck:electron` exit 0. Prop is optional, so the other NessySymbol call sites are untouched. |
| A5 playground flags + orphaned SVGs | ✅ | `e23152f03` | The playground's electronAPI mock is `apps/electron/src/renderer/playground/mock-utils.ts` (`mockElectronAPI`, injected by `ensureMockElectronAPI`) — it had NO `getProviderFlags`, so the optional call never resolved and ProviderSelectStep kept its conservative pre-resolve seed (`DEFAULT_PROVIDER_FLAGS`), hiding four of the six cards A3 changed. Added `getProviderFlags` returning all EIGHT `ProviderFlagId`s true — deliberately more permissive than any real build, with the reason in a comment; the entry's description now says so too. No knob and no product-code change: the component reads flags from the API, so the mock is the seam. Deleted the two orphaned assets `provider-icons/{claude,openai}.svg` (zero importers since A2+A3). Gates: `bun run typecheck:electron` exit 0; `git diff --check` clean; `rg -uuu 'provider-icons/(claude\|openai)\.svg'` → no source hits (only this plan's prose, the codegraph binary index and stale `.superpowers/sdd/*.diff` review artifacts). Playground `provider-select-step` swept dark→light with NO in-page override: all seven cards render, Codex/ChatGPT on the OpenAI knot, Claude Code/Claude Pro-Max on the sunburst, Pi/Cloud on the purple N. |
| B1 shared plate gutter | ✅ | `105d3cf05` | `CHAT_LAYOUT.controlGutter`/`controlGutterCompact` added in `packages/ui/src/lib/layout.ts` (px only, comment points at ChatInputZone as source of truth; the renderer reaches them through `@/config/layout`, which re-exports the UI package). ChatDisplay's three `px-3` wrappers collapsed into ONE `cn(maxWidth, 'mx-auto w-full space-y-1.5 empty:hidden', compactMode ? controlGutterCompact : controlGutter)`, each plate's rationale comment moved inside beside its plate (the W1 owner-decision text kept verbatim). ChatInputZone's fused ternary split so `pb-3`/`pb-4` stay local — identical computed classes, no visual change. CORRECTION LANDED (rule-8 stop, planner-approved): `PendingAuthNotice.test.tsx` pinned the OLD three-wrapper string (`:151`, `:171-177`, `occurrences(...)===3`) and was RED by construction — 32 pass / 1 fail before the fix. The pin now co-evolves: `CONTROL_GUTTER = 'CHAT_LAYOUT.controlGutterCompact : CHAT_LAYOUT.controlGutter'` must occur exactly ONCE in ChatDisplay, all three plates must sit between it and `<ChatInputZone`, and the COMPOSER source must contain the same expression — so plate↔composer drift now fails a test instead of a screenshot. The unused `enclosingWrapper` helper went with it. Gates: `bun test` over PendingAuthNotice + AgentPanel + TaskChecklistPanel → **33 pass / 0 fail / 127 expect()**; `bun run typecheck:electron` exit 0; `git diff --check` clean. Playground swept dark→light: `pending-auth-notice` (incl. the 'All ready (renders nothing)' state — preview empty, the collapse control), `orchestration-task-checklist`, `input-container`, `active-option-badges`. DEFECT FOUND, PRE-EXISTING, NOT FIXED HERE: the `agent-panel` playground entry crashes the whole playground to a blank page — `AgentPanel.tsx:56` `Cannot read properties of undefined (reading 'map')`, because `chat.tsx`'s entry supplies `rows` only through its variants, never through props defaults or `mockData`, and the playground has no error boundary. Reproduced identically at HEAD with the B1 diff stashed, so it is not B1's. It makes that entry unsweepable for B1 and B2 — planner has it. |
| B2 SystemCard primitive | ✅ | `d66c4ccf5` | New `components/ui/system-card.tsx`: `SystemCard` owns the chrome (`rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-xs`, className-merged) plus the header row (icon / `font-medium` title / `ml-auto` meta), and `SystemCardError` is the destructive inline strip. All three plates rebased; the 'chrome copied from' comment in PendingAuthNotice deleted with the copy it described (it cited a stale `AgentPanel:183`). The chrome literal now exists in exactly ONE source file — verified with `grep -ra`. One API call beyond the plan's slot list: `titleClassName`, used only by PendingAuthNotice to keep its `text-foreground` heading against the shared muted header row — without it that card's title would have silently changed color, which the gate's 'no visual diff' forbids. Title renders as `<h3>` for all three (PendingAuthNotice already had one; the other two gain heading semantics, no visual change under Tailwind preflight). `SystemCardError` currently has ONE caller (AgentPanel's row error) — recorded as such. Also landed here per planner: `rows: []` in the `agent-panel` entry's mockData, which fixes the pre-existing crash B1 found. Gates: `bun test` PendingAuthNotice + AgentPanel + TaskChecklistPanel → **33 pass / 0 fail / 129 expect()** (B1's 127 plus the two new source-level pins: the notice contains `<SystemCard` and NO copy of the chrome literal); `bun run typecheck:electron` exit 0; `git diff --check` clean. Playground swept dark→light — `pending-auth-notice`, `agent-panel` (now renderable, 'One running fork' variant), `orchestration-task-checklist`: pixel-for-pixel the same rows and header positions as the B1 shots. The three entry descriptions now name SystemCard. |
| C1 openai-compat fetcher | ✅ | `927a24c22` | `model-fetchers/openai-compat.ts` + `__tests__/openai-compat.test.ts`. GET `{baseUrl}/models` with trailing slashes trimmed (so a `…/v1/` endpoint never asks for `//models`), `redirect: 'error'`, `AbortSignal.timeout(3000)`, and the `Authorization: Bearer` header ONLY when a key exists — a keyless Ollama endpoint must not get an empty Bearer. Accepts both `{data:[…]}` and bare-array bodies; maps `id→id`, `name = id`, `description`, and `contextWindow ← context_length \| contextWindow \| context_window`. Persisted per-model overrides are spread FIRST and API fields written after (the nestor.ts:69 discipline), so a stale local window cannot win. Returns `{models}` with no serverDefault. FILTERING per the corrected block: no `context_length <= 1` filter — those rows survive as models; no embeddings heuristic; the only rule is the required sanity floor, `MIN_CREDIBLE_CONTEXT_WINDOW = 4096`, which treats a smaller reported window as ABSENT (the row keeps whatever the user had persisted, or no window at all) rather than writing a 1 into auto-compaction arithmetic. `owned_by` deliberately NOT carried onto ModelDefinition — deferred to C3, which is the task that would need it for grouping. Tests use the row shapes recorded live in C5 (`tgpt/qwen35-397b-a17b-fp8` 262144, `anthropic/claude-opus-5` 1000000, `tgpt/context-intents-summ` 1): happy path incl. header/redirect/timeout assertions, bare array, keyless endpoint, non-OK throws, redirect rejection propagates, override precedence (stale window replaced, unknown extras survive), the floor keeps the row and drops the number, and the floor falls back to a persisted window. Gates: `bun test packages/server-core/src/model-fetchers` → **26 pass / 0 fail / 67 expect()** across 3 files; `cd packages/server-core && bun run typecheck` exit 0. |
| C2 refresh enrollment | ✅ | `363b8abf4` | `modelsSyncedAt?: number` added at all three sites `modelSelectionMode` occupies — type (`llm-connections.ts`), validator (`validators.ts`), and the update-merge allowlist (`storage.ts`), the last being the one whose omission silently drops a field on update. BOTH startup gates opened for an enrolled BYO connection: `_doRefresh`'s compat skip and `startAll()`'s two `continue`s. The `:203` TypeError is avoided WITHOUT registering a fake `pi_compat` fetcher — the enrolled connection `continue`s right after its immediate fetch, before the timer block that would dereference `this.fetchers['pi_compat']`. `refreshNow()`'s compat early-return is untouched (it only guards timers). Enrollment = `pi_compat` + `customEndpoint.api === 'openai-completions'` + a `modelsSyncedAt` stamp; `modelSelectionMode` is never read for it. TTL `MODEL_SYNC_TTL_MS` = 24h, beside `COPILOT_REFRESH_INTERVAL_MS`. Failure keeps BOTH the stale list and the stale stamp, so the next startup retries. `mergeModelMetadata` is a keyed merge, never a replace: only `contextWindow`/`description` are overwritten on ids the user persisted, catalog-only rows are ignored, ids the catalog forgot survive, string entries pass through, and `name` is deliberately NOT merged (this fetcher derives name from id, so writing it could only be a no-op or clobber a user-chosen name — proven by the test asserting `name: 'My Qwen'` survives a merge). `defaultModel` and `modelSelectionMode` are never written. Tests extend `service.test.ts` with a `runService` harness that reports the subprocess's fetch calls AND its `setInterval` count on stdout, so both the request and the absence-of-timer are measured rather than assumed: keyed merge; unstamped skipped; fresh stamp skipped; stale stamp fetches and rewrites the stamp; `anthropic-messages` skipped; keyless Ollama endpoint fetches with NO Authorization header; `nestor-cloud-agent` untouched; and the startAll-driven case (fetch happens, `timers === 0`). Gates: `bun test packages/server-core/src/model-fetchers` → **33 pass / 0 fail / 94 expect()**; `cd packages/server-core && bun run typecheck` exit 0; `bun run typecheck:shared` exit 0 (the three shared-config sites). |
| C3 BYO form fetch action | ✅ | `f359ecb32` | NO new RPC channel: `TEST_LLM_CONNECTION_SETUP` gained optional `fetchModels` / `validateModels` params and optional `models` / `modelProbes` results (+ a `ModelProbeResult` type). The handler answers both from the fetcher directly and returns BEFORE `testBackendConnection` — the 45s agent-subprocess test never runs for a list. `probeOpenAiCompatModel` sits beside the fetcher: non-streaming POST `/chat/completions`, `max_tokens: 1`, 10s timeout, 200→ok / 404→no-quota / else→error. Picker is a standalone `ModelCatalogPicker.tsx` (props in, selection out, zero ApiKeyInput coupling — pinned by a test) built from EntityList + EntityRow + EntityListBadge + EntityListEmptyScreen + Input, no new primitives. Grouping is by ID PREFIX via a pure `model-catalog.ts` helper, so `ModelDefinition` was NOT widened with `owned_by` — the llm-proxy prefix (`tgpt/`, `openrouter/`, `anthropic/`) is exactly what `owned_by` reports, and a flat id stays ungrouped. Selected ids are written back into the existing comma-separated model field; only the SELECTION is probed, never the catalog. Nothing is ever labelled 'available' — a test asserts that over the en.json strings themselves. TOGGLE SEMANTICS (defect avoided): the sync flag is submitted ONLY after the user touches it. `initialValues` has no prefill path from the settings page yet, so an untouched edit would otherwise have sent `false` and silently WITHDRAWN an enrolled connection. `modelsSyncedAt` is therefore `number \| null` in the shared type — `undefined` means 'leave as persisted' in the update-merge, so a nullable value is what makes withdrawal expressible at all. ZONE DEVIATIONS (recorded): `hooks/useOnboarding.ts` (one options field + one spread at the single setup call site + two forwards — the toggle has nowhere else to travel) and `playground/mock-utils.ts` (a mocked `testLlmConnectionSetup`, without which the picker's states are unreachable in the playground). Gates: `bun test apps/electron/src/renderer/components/apisetup/__tests__/` → **91 pass / 0 fail / 174 expect()** (8 files, incl. the new `ModelCatalogPicker.test.tsx`); `bun run typecheck:electron` exit 0; `cd packages/server-core && bun run typecheck` exit 0; `bun run lint:i18n:parity` → OK 2224 keys; `bun run lint:i18n:sorted` → OK; `git diff --check` clean. Playground `api-key-input` swept dark→light on the new 'Model catalog — fetch + pick' variant, INTERACTIVELY: Fetch models → '5 models published', grouped OTHER/ANTHROPIC/TGPT/OPENROUTER; clicking two rows → '2 selected' and the model field reads `llama3.2, anthropic/claude-opus-5`; Check access → green ok on one row, amber no-quota on the other. The 'already enrolled' variant (toggle ON) did not re-render on variant switch — the playground reuses the mounted instance, so `initialValues` only applies on mount; the prop path is covered by the source test instead. |
| C4 Nestor proposal doc | ✂️ | | CUT by owner 2026-08-14 — we cannot influence that team |
| C5 live key validation | ✅ | (planner, pre-dispatch) | 383-row catalog, all with context_length; only 27 entitled — see §Adapter audit |
| C6 think-split + dialect key off model id | ✅ | `17fa1e784` | All four pinned points landed. (1) `applyNestorReasoningProxy`'s gate is now a UNION — `openai-completions` AND (gateway URL OR the connection's model set intersects `NESTOR_GATEWAY_QWEN_MODELS`); the model set comes from `model` + `customModels`, both of which every call site already passes. (2) THE load-bearing edit: `upstreamHeaders` takes `isGatewayUpstream` and the `Authorization: Bearer` → `Nestor-Token` swap happens ONLY for the gateway — it was unconditional and merely implicitly gateway-only, so running the proxy on a BYO URL without this would have stripped the key and 401'd every request. Asserted directly: a BYO upstream receives `Bearer BYO-KEY` and no `Nestor-Token`. (3) `NestorReasoningProxyHandle.isGatewayUpstream` added and `gatewayRuntimeActive()` re-keyed to it, so the 429 retry ladder stays gateway-only instead of firing wherever a proxy handle exists. (4) Split and dialect fire PER-REQUEST off `body.model` inside `proxyRequest`: split when `isGatewayUpstream \|\| body.model ∈ QWEN` (so the gateway keeps splitting for every model — no regression), dialect purely on the model after dropping the URL clause from `adaptToolRequestForDialect`; a non-split request is now piped through verbatim (`pipeResponseBody`). TEST CONSEQUENCE worth noting: the real-server e2e always ran against a LOCAL stub, so under the new rule it was no longer a splitting case — it now runs `tgpt/qwen35-397b-a17b-fp8`, which makes it the BYO-Qwen case C6 exists for rather than a gateway simulation. The dialect test lost its URL assertions by design and gained `isNestorGatewayQwenModel` coverage. Gates: `bun test packages/pi-agent-server/src/gateway-proxy` → **15 pass / 0 fail / 73 expect()** across 3 files (11 before, +4 per-request cases: BYO keeps its Bearer; BYO-Qwen gets split+dialect; non-Qwen on the same BYO upstream passes through with `<think>` intact and `tool_choice` untouched; gateway swaps+splits for any model). The package tsconfig excludes `**/*.test.ts`, so the two test files were typechecked with the plan's verbatim `bunx tsc` command → exit 0. `bun run typecheck:all` → exit 0. `git diff --check` clean. |
| D1 agent install acquires dependencies | ✅ | `4881e7f50` | The agent install now enters at `MarketplaceService.install` (bare `source`, so the proposal-consume contract is untouched) instead of the mutation boundary beneath it — that door is what runs `acquireDependencies`, so a plugin declaring dependencies stops landing installed-but-inert. Both supporting edits the naive reading misses are in: `IssueProposalInput`/`ProposalRecord` now carry `connectorAuthTiming`/`catalogAuthenticationPolicy`, captured in planInstall's marketplaceItemId branch, and `consume()` returns a `ConsumedProposal` ({source, hints}) instead of a bare source; `PluginManagementMarketplaceApi` widened to include `'install'` (SessionManager's deps field uses that same alias, so it followed automatically). `MarketplaceInstallRequest` gained the two hint fields for a caller that has the hints but not the whole catalog item — `item`'s own values still win. The RPC path's `consume(...)` call site takes `.source` (one character of churn). Test fixtures had to become REAL rather than stubs: `plugin-management-tools.test.ts`'s `fakeMarketplace` is now a real `MarketplaceService` over the harness's own `PluginManagementServiceV2`, because a stubbed install would test exactly the wiring this task removes. New D1 case asserts the install request reached the marketplace door carrying `source` + both hints (plan → proposal → install), which the old path dropped; plus two proposal-registry cases (hints survive consume; absent when the item had none, and never leaked into the client-visible DTO). Gates: `bun test` over `agent/__tests__/plugin-management-tools.test.ts` + `marketplace/__tests__/` + server-core's `sessions/__tests__/plugin-management-tools.test.ts` → **277 pass / 0 fail / 883 expect()** across 16 files; full `bun test packages/shared/src/agent packages/shared/src/marketplace` → 2973 pass / 3 skip / 0 fail; `cd packages/shared && bun run tsc --noEmit` exit 0; `cd packages/server-core && bun run typecheck` exit 0. TRAP HIT AND RECORDED: `packages/shared/src/marketplace/service.ts` carries a NUL byte — plain `grep -n 'class MarketplaceService'` returned NOTHING and `grep -an` found it at :117. Exactly the AGENTS.md case; every absence check in this lane uses `-a`. |
| D2 plan_install resolves BYO registries | ✅ | `f18f98db0` | Helper filename (as asked): **`packages/shared/src/marketplace/listing-resolution.ts`**, exporting `resolveMarketplaceListingItem`, `splitListingId` and `SAFE_MARKETPLACE_ID` — the last moved here from server-core's local const, so the two channels cannot disagree about which id is built-in. Both callers now use it: the RPC channel (`rpc/marketplace.ts`'s `resolveListingItem`) and the agent's `planInstall`. `findCatalogItem` added to `CachedMarketplaceCatalogReader` as an OPTIONAL member — required would have broken five narrower stubs (the update-availability probe genuinely needs only `peekCachedItems`), and the resolver's `?.()` handles absence; cache-only either way. TWO DEFECTS FOUND WHILE WIRING, both fixed here: (a) passing `requireRegistrySource()` eagerly into the resolver's deps broke FOUR existing handler tests with 'Marketplace registries are unavailable before storage readiness' — a Skills Market listing must not need a registry at all, so the reader is now resolved lazily per call; (b) a registry-shaped id that no local catalog holds fell through to the Skills Market, whose failure says nothing about the id SHAPE — planInstall now catches that and returns the `<registryId>:<pluginName>` message, matching the A6 wording the RPC channel already had. Resolution order: explicit `marketplaceId` (RPC) or an inferred `<prefix>:` (agent) → cache-only `findCatalogItem`; an EXPLICIT registry that misses is a miss (it must not ask the Skills Market about someone else's listing), while an INFERRED prefix that misses still falls back to inspect, because a Skills Market id may legitimately contain a colon. Gates: `bun test packages/shared/src/marketplace packages/shared/src/agent/__tests__/plugin-management-tools.test.ts packages/server-core/src/handlers` → **515 pass / 0 fail / 1681 expect()** across 44 files, incl. 7 new resolver cases and 2 new agent cases (a BYO id resolves cache-only with the peek counter untouched; a miss names both halves); `cd packages/shared && bun run tsc --noEmit` exit 0; `cd packages/server-core && bun run typecheck` exit 0. |
| D3 source disable/remove tool | ✅ | `1d3f57c1f` + fix `36a208395` | One tool `source_manage {sourceSlug, action:'disable'\|'remove'}`, `executionMode:'registry'`, **`safeMode:'block'`** plus the normal permission gate — mode-dependent as pinned, with no invented always-ask floor — and listed in `SESSION_TOOLS_REQUIRING_HOST_CALLBACK`, which is what gates it off on Codex. Scope never comes from the model: the workspace is the session's own. `disable` writes through the validated `ctx.saveSourceConfig` (config and credentials stay on disk). `remove` calls the NEW shared helper `packages/shared/src/sources/removal.ts` → `removeSourceEverywhere`, which enumerates the three ops the UI channel used to inline: (1) `deleteSource`, (2) strip the slug from `defaults.enabledSourceSlugs`, (3) capability-change notify with `revoke-active-snapshot`. The RPC channel (`rpc/sources.ts` DELETE) now calls the same helper — so the two channels cannot drift — and the notify seam is INJECTED: the RPC passes its server-bound `notifyCapabilityChange`, SessionManager passes `afterAgentPluginMutation(..., 'remove')`. Wiring: `SessionToolContext.removeSource?`, bound in `claude-context.ts` from a new `removeSourceFn` on the session-scoped callback registry, registered by SessionManager beside `setSessionLabelsFn` (two of the three ops need host handles no agent has, which is why it is SessionManager-bound rather than agent-bound like `resolvePluginMcpServerFn`). An unbound host produces a refusal, not a thrown turn. FOLLOW-UP FIX `06a1ec5b2`, found by Z1's full wave and NOT by any focused gate: a session tool with no Pi BINDING is silently skipped from the Pi execution manifest — so `source_manage` would never have existed on a Pi session — and worse, the skip desynced `tools`/`dynamicTools`, which `pi-agent.ts` mapped BY INDEX, so `dynamicTools[index]!.promptSnippet` threw and took down EVERY Pi turn (27 failures across `PiAgent fallbackModel/maxAgentTurns/maxBudgetUsd`, the slash-command seam and the R0 baseline). Fixed both halves: `harness-tool-descriptor.ts` gains `mutate('source_manage', {mutationScope:'workspace', sandboxProfile:'host'})` + `sessionBinding('source_manage','source_manage')`, and the manifest map is now keyed by binding name so the documented 'degrade, do not fail the manifest' `continue` can no longer turn into a session-wide TypeError. Harness baseline updated: 54→55 session tools, the fixture row, the live schema contract (digest regenerated, not hand-written) and the host-callback audit list. Gates: `bun test packages/session-tools-core packages/shared/src/sources` → **491 pass / 0 fail / 1504 expect()** across 51 files (incl. 5 new `source-manage.test.ts` cases: disable calls the validated writer with only `enabled` flipped; remove calls the host seam and writes NO config on its way out; unbound seam refuses; a throwing seam is reported not propagated; unknown source and unknown action refused). `bun test packages/server-core/src/handlers` → 236 pass / 0 fail. Typechecks: shared, session-tools-core and server-core all exit 0. `git diff --check` clean. |
| D4 live agent-install smoke | ✅ | `89e299780` | **PASS 4/4 on the OWNER'S REAL PROFILE** (workspace `d98cc70e…`/My Workspace — the fixture config dir is the dead `custom-root-reset-required` gate). Checklist section: 'Run of 2026-08-14 — D4'. Obs1: skill capability carries `allowedTools` + `path`, mcp carries only the LOGICAL `serverName` — read from `installed.json`. Obs2: `wireName` zero hits across plugin records and capability snapshots. Obs3: the model FOUND AND CALLED `mcp__plugin_cdp-echo-probe_echo__whoami`. Obs4: `source_test` wrote `enabled:true` + `connectionStatus:'connected'`. Cleanup through the agent's own tools each cycle, restored to the owner's original 3 plugins / 5 registries / 1 source, verified by reading back. ROUTE CORRECTED THREE TIMES BY MEASUREMENT: a local path is refused by design (`marketplace.repository.unsupported_url` — a security property, not a bug to route around); a registry folder needs a ROOT catalog manifest or its catalog stays silently empty (fix `9b4452780`); catalog delivery is async with a `marketplace.registry.fetch_pending` window. TWO PRODUCT DEFECTS FOUND LIVE AND FIXED: `d18f2b34c` — the agent path derived install sources from the absent DTO descriptor instead of the row's `structuredInstallSource`, so D2 could FIND a BYO listing it could never install; `4e07f3abd` — `source_manage: remove` was unreachable on Pi because `onRemoveSource` was threaded only through `session-scoped-tools.ts` while Pi builds its own context (D3's own divergence class, reintroduced one layer down; construction-level test added, re-proven live). FIVE DETECTOR FAULTS caught before any became a finding: transcript rows returning empty text, `piRuntime()` having no `tools` field, an unscoped `wireName` grep hitting a session log, `loadSourceConfig` not existing on the renderer API, and `sendPrompt` rejecting multi-line prompts. Plus one MODEL-REFUSAL finding settled from the Pi session record (`{"status":"blocked","reason":"appears to be a probe or test"}` with no `tool_use` at all) — the case now re-prompts once with honest framing and reports BLOCKED-on-model rather than FAIL. |
| D5 figma OAuth post-login half | ✅ | `911bf10f6` + `717a4e039` | **PASS end to end, and the lane was not a verification — it found the reason the feature never worked.** Pre-login halves banked first: dp 5/5, and the negative control `NO-FIGMA-TOOL` (no figma tool on the session surface while unauthenticated) — an absence claim with a positive control beside it, per AGENTS.md. The owner's browser login then completed three times and the credential slot stayed empty with NOTHING reported anywhere. Two defects, in the order they became findable: (1) `packages/server-core/src/handlers/rpc/oauth.ts` discarded the exchange's own outcome at TWO sites — a rejected `result.error` and a thrown exchange both ended as silence, so a failing flow was indistinguishable from a succeeding one. Fixed `911bf10f6` (both sites now log the cause, and the "no reason reported by the exchange" branch keeps the absence honest rather than inventing a message). That fix produced the verbatim cause in four seconds: `{"error":"Client secret is required"}`. (2) `exchangeMcpCodeForTokens` in `packages/shared/src/auth/oauth.ts` could not send a client secret AT ALL — the parameter did not exist. Figma's dynamic registration returns a CONFIDENTIAL client, and RFC 6749 §2.3.1 `client_secret_post` is what it expects; a public-client exchange can never satisfy it. Fixed `717a4e039`, threading an optional `clientSecret` through `exchangeMcpOAuth` and — the half a narrow fix would have missed — through `refreshAccessToken`, where the identical hole would have killed the session an hour later. Owner's 4th click: `2026-08-14T15:19:02.756Z INFO [OAuth] Plugin-server flow started for figma (flow=6f34fd6b…)` → `15:19:06.934Z INFO [OAuth] Flow complete for figma (success=true)`, and `credentials.enc` is stamped the same minute. Post-login: the pending-auth summary row is GONE from the composer plate, `mcp__plugin_figma_figma__get_metadata` MATERIALIZED on the session surface, and the call returned the owner's real document — `4706:1582: Форма отчета`, `<frame … name="Форма отчета" x="192" y="196" width="1280" height="768">` with its child instances — read from the Pi session jsonl because the rig's transcript reader returns empty text for that row (known detector fault; the product's own record is the honest witness, same as D4 obs 3). DETECTOR FAULT CAUGHT: the first post-login call failed with `Validation failed … fileKey: must have required properties fileKey / Received arguments: {}` — the CASE had no file key, not an auth refusal; reported as case incompleteness and re-run with a real file rather than banked as a defect. PROCESS COST RECORDED: the 3rd click was spent against a committed-but-not-rebuilt bundle — my error, one wasted owner click, and exactly the `electron:dev` trap AGENTS.md already names. **DEBT, open and named:** the regression test for `717a4e039` is NOT committed — my `fetchImpl` stub did not match `OAuthPinnedFetch`'s signature, and a weakened or red test is worse than a named gap. Carried into Z1. **DEBT PAID IN Z1 (`d86696b35`), not re-filed.** The stub was never needed: `oauth.test.ts` already carries `withTestNetwork`, an async-scoped seam whose `fetchImpl` matches `OAuthPinnedFetch` exactly (`(url, options, addresses)`), so the signature that blocked the debt was already solved one import away. Four cases appended to `packages/shared/src/auth/__tests__/oauth.test.ts`: the code exchange sends `client_secret` AND still sends `code_verifier`/`client_id` (PKCE rides alongside `client_secret_post`, it is not replaced by it), the refresh grant sends it too — the half a narrow fix would have missed, and the half no live walk exercises until an hour after login — plus a PUBLIC-client negative control on each grant. VERIFIED RED, not assumed: with both `params.set('client_secret', …)` lines disabled, **2 fail / 78 pass** and the two failures are exactly the two positive cases while both negative controls stay green (which is what a control should do); restored, **80 pass / 0 fail / 140 expect()**, and `oauth.ts` is byte-identical to HEAD (`git diff --stat` empty). `cd packages/shared && bun run tsc --noEmit` exit 0. |
| D6 CDP cases + real-profile run | ✅ | `2b8e6d8a6` `0386b2129` `21224054e` | cases 1-2 live-proven; RESEQUENCED (owner 2026-08-14): cases 6 and 5 done, cases 3-4 ON HOLD until lane E lands (they drive the form E rebuilds). **Case 6 `SOURCE-MANAGE` PASS 4/4** and **case 5 `AGENT-INSTALL` PASS 8/8**, both on the D7-fixed build, both cleaned back to the operator's baseline and verified. Case 6 is the case that FOUND D7 — its first run reported "remove does not reach its host binding", verbatim a defect already fixed, and the session's own error rows showed the turn had never run. Three detector faults fixed along the way, each of which would have produced a wrong finding: `getSources` does not exist on the renderer API (read `<config>/workspaces/<id>/sources/<slug>/config.json` instead); `plugins/registry-catalogs/<id>.json` is NOT written for a local folder registry, so a case reading it reports an empty catalog forever and blames the fixture's `marketplace.json` (ask `marketplace.list`, the door the Plugins page uses); and `installed.json` is `{schemaVersion, updatedAt, active, plugins:[…]}` with capabilities keyed `kind` not `type` and payloads nested (`cap.mcp.serverName`), while uninstall keys on the opaque base64 `pluginKey`, never `pluginId`. Also fixed: case 5's registry cleanup sat in a `finally` that began AFTER the catalog assertion, so a failure there left a fixture registry on the operator's real profile — cleanup now starts at the first mutation. **CASES 3-4 CLOSED 2026-08-15** (the "ON HOLD until lane E lands" above is now historical — lane E is ✅ E1-E6): case 3 `BYO-CATALOG` **PASS 5/5 both halves** — the owner's own save gave 7/7 models a `contextWindow` (40 960 … 262 144), `modelsSyncedAt` stamped, and a restart inside the TTL left the stamp untouched; the SAME connection had failed the case an hour earlier, so before/after sits on one substrate. Case 4 `BYO-QWEN` **PASS across all three arms** (unforced on an allowlisted id, forced via E6's `dialect` hint on `…-fp8-vl`, and the boundary arm on a connection with no allowlisted sibling), each with `upstream auth: bearer` — 1 bearer, 0 nestor-token — from the proxy's own line, and the forced arm's config edit restored byte-identically. |
| D7 stale agent defs kill session | ✅ | `4b31ddc63` | **Both halves in one commit, plus the observability the diagnosis needed.** (1) DEGRADE — `buildPiRuntimeAgentDefinitions` no longer throws on a generation mismatch; `.map`→`.flatMap`, the stale descriptor returns `[]` after a `debugLog` naming BOTH generations. The throw ran inside `buildSessionDefinition`, so one stale descriptor killed not the turn but every turn of the session, permanently, unrecoverable from the UI — and that contradicted the A1 policy the sibling route states verbatim ("a malformed definition is skipped and NAMED, never session-fatal"). Its own neighbouring test already argued the identical case one field over: "fail-closed on the session is not a safety property, it is an outage." (2) REFRESH — `register_tools` gains optional `piRuntimeAgentDefinitions` (typed off `InitMessage[...]` so the two can never drift), the subprocess adopts them into `initConfig` before the recreation flag, and `publishExecutionManifest` re-MATERIALIZES them via the same `materializePiRuntimeAgentDefinitions` call init makes. Materialized, never re-stamped: the digest is computed from content and generation together, so a re-stamp would trade this bug for `runtime-agent-definition-identity-mismatch` on every spawn. Site chosen because it already asserts `runtime.view.generation === manifest.snapshotGeneration` on entry AND after the ack. (3) OBSERVABILITY — the register line now reads `at generation <new> (was <old>), agent definitions refreshed: K`; its absence is why a dead session had to be diagnosed from source instead of read off the log. **DEFECT IN THE FIRST DRAFT OF THIS FIX, caught on re-read before commit:** the adopt seated `msg.piRuntimeAgentDefinitions` RAW, bypassing the per-entry ingress revalidation `init` applies — the same trust boundary reached a second time, which would have made `register_tools` a way to seat descriptors `init` would have refused. Now routed through `parsePiRuntimeAgentDefinitions` with its own `dropped at re-registration ingress` diagnostic. **SCOPE BOUNDARY, so nobody misreads the fix:** the refresh is gated on init having dispatched definitions at all, so a session that started with ZERO agents still does not grow them mid-session — pre-existing behaviour, deliberately unchanged. Tests: the `rejects a stale capability generation without fallback` case is REPLACED (not quietly deleted) by two — a stale descriptor is dropped AND named with both generations, and a mixed list keeps the healthy one; NEW `shared/.../pi-agent-manifest-agent-refresh.test.ts` pins the host half (new stamp present; field absent when init never dispatched); NEW `pi-agent-server/src/__tests__/pi-runtime-agent-refresh-real-server.test.ts` pins the COMPOSITION on a real subprocess — init at gen A → turn → `register_tools` at gen B → turn — because with the degrade half in place an adopt regression is SILENT (agents vanish, no death, no CI signal). That spawn test was **verified genuinely red**: with the adopt disabled it fails on `custom_subagents` tokens → 0, exactly the silent vanish. Gates: `bun test packages/pi-agent-server` 679 pass/0 fail; `bun test packages/shared/src/agent` 2738 pass/3 skip/0 fail; the three D7 files 88 pass/0 fail after the ingress fix; `bun run typecheck:all` exit 0; `bun run lint` exit 0 (120 pre-existing warnings). TRAP HIT: the C6 no-exclusion recipe at ~line 638 omits `--target`, so it downlevels and buries a clean file under 20+ unrelated TS2802/TS1501 errors — used a temp config extending `./tsconfig.typecheck.json` with the `**/*.test.ts` exclude dropped instead; both test files exit 0. |
| E1 miniModel field | ✅ | `842cb8489` | Six files: the field + `getMiniModel` preference (shared/config/llm-connections.ts), schema (validators.ts), the update-merge allowlist (storage.ts — the #838 trap, reason stated inline), `LlmConnectionSetup.miniModel?` (protocol/dto.ts), NEW `validateMiniModel` (server-core/domain/connection-setup-logic.ts, a sibling of `validateModelList`), and the SETUP application (handlers/rpc/llm-connections.ts). Rule put in DOMAIN rather than inline in the handler: it is domain logic, it is where `validateModelList` already lives, and it makes the gate testable without standing up an RpcServer + HandlerDeps + storage harness for one predicate. `findSmallModel` untouched byte-for-byte incl. the last-entry arm; `getSummarizationModel` untouched (F8). An explicit value wins only if it clears the managed allowlist — a forbidden one falls THROUGH to the heuristic rather than being honoured or hard-refused (`model-config.md:167`: the tier "falls back to the inherited or default model rather than failing the request"); `isDeniedMiniModelId` deliberately NOT applied to it, since that is a provider-auth heuristic `findSmallModel` itself overrides when nothing else survives. TWO GAPS THE CODE FORCED, neither in F9: (a) the Pi branch rewrites ids to `pi/<id>`, so an unprefixed miniModel could never match the list it is validated against — it now goes through the same `toPiModelId` beside `defaultModel`; (b) an EMPTY effective list is NOT a validation failure, because the Pi `automaticallySyncedFromProvider` path has the server install the catalog after this point and refusing there would block a legal save. F8 CONFIRMED AT THE TYPE LEVEL: the first draft of the summarization test failed to compile — `getSummarizationModel`'s parameter type does not include `miniModel` — so the test widens the value explicitly and records that the compile error IS the contract. Gates: `bun test packages/shared/src/config/__tests__ packages/server-core/src/domain/connection-setup-logic.test.ts` → **829 pass / 0 fail / 2028 expect()** across 69 files; `packages/shared/tests/llm-connections.test.ts` → 20 pass / 0 fail; the order-pin `claude-connection-setup.test.ts` (real path `apps/electron/src/renderer/components/apisetup/__tests__/`) → 5 pass / 0 fail, untouched; `typecheck:shared` 0; server-core typecheck 0; `git diff --check` clean. New tests: 5 on `getMiniModel` (heuristic fallback preserved, explicit wins, blank ignored, allowlist not escapable, summarization untouched), 2 storage round-trip (persists; survives an unrelated save — the #838 guard), 5 on `validateMiniModel`. |
| E2 BYO runtime sync enrollment | ✅ | `73c21c358` | One file (`model-fetchers/index.ts`; `registry.ts` untouched as specified). `isModelSyncEnrolled` widened exactly as pinned — stamp required for both shapes, then `pi_compat && customEndpoint.api==='openai-completions'` OR `isAdapterRuntimeProvider && !isNessyGatewayBaseUrl(baseUrl)`. Both guard symbols verified at their pinned locations (`upstream-target.ts:34`, already imported by `registry.ts:10`; `llm-connections.ts:533`). Routing decided BEFORE the compat/else split, because the runtimes are not compat providers and the split would hand them to the gateway fetcher — which REPLACES the list, the exact merge-never-replace violation C2 exists to prevent. The merge body is now ONE shared private method instead of a copy: the two callers differ only in how they were routed, and a duplicate is the divergence class that already cost this repo twice (two install channels, two source-removal channels). **THE PLAN NAMED HALF THE TIMER PROBLEM.** `startAll`'s `:277` continue needed NO change — widening the predicate satisfies it automatically. But `refreshNow()` (`:368`) is a SECOND timer-start path the plan does not mention, and its guard excluded only nestor-cloud-agent, nestor and compat providers. It runs on connection-created, auth-completed and the manual refresh button — the path a user actually takes when SAVING the very connection this lane exists for — so without a stop there an enrolled adapter-runtime connection picked up the fetcher's hourly timer the moment it was saved, every tick a no-op the 24h TTL refuses, against someone else's endpoint. Closed with `if (isModelSyncEnrolled(connection)) return`; interval confirmed real at `registry.ts:44` (`60*60*1000`). Also corrected the `startAll` comment, which justified its stop by `this.fetchers['pi_compat']` being undefined — true for that shape, FALSE for the new one (an adapter runtime has a fetcher); both reasons now stated. Gates: `bun test packages/server-core/src/model-fetchers` → **37 pass / 0 fail / 106 expect()** across 3 files; server-core typecheck 0; `git diff --check` clean. Four new tests on C2's `runService` harness: enrolled runtime fetches+merges (id set unchanged, user's `name` survives, stamp advances); unenrolled runtime keeps today's behaviour; a gateway one-click runtime never enrolls even carrying a stamp; `startAll` schedules ZERO timers for an enrolled runtime. VERIFIED RED, not assumed: reverting the widening to `return false` fails the merge and timer tests while both negative controls pass either way — which is what a control should do. |
| E3 merged form logic + router | ✅ | `31ef504fe` | `byo-runtime.ts` + its tests. `MergedEndpointArm`/`PiEndpointPreset`, and the F11 exemption expressed ONCE as the named predicate `usesOfficialPiEndpoint` — deliberately a function, not an inline condition, because three consumers (validation, submit shape, E4's field visibility) must read the most breakable rule in the matrix the same way. `validateMergedEndpointForm`: first-failure-wins over endpoint → models → utility model → key; the gateway URL is now rejected on the PI arm too (`NESSY_GATEWAY_PROVIDER_TYPES` includes `pi_compat`, so a Pi/Custom save there is permanently un-editable); official presets exempt from the endpoint checks AND the model requirement (the server installs the provider catalog, so an empty list is the CORRECT payload, not a missing one) but still key-required, loopback being impossible on them. Masked-key unification via `isMaskedCredential`/`hasCredential`, docstring naming the REFUTED-claim finding and what the legacy path still does wrong. `buildByoRuntimeSetup` gains `miniModel` (sent even when blank so clearing the field clears the slot) + tristate `modelsSyncedAt`; the landmine invariant is RE-PINNED against the richer payload — the absence test now asserts no `customEndpoint`/`piAuthProvider`/`modelSelectionMode` WHILE the new fields are populated, rather than guarding a shape that no longer exists. Four-target router, with the exotic-`piAuthProvider` fallback tested on four real values (`amazon-bedrock`, `openrouter`, `google`, `github-copilot`) because `apps/cli` writes arbitrary values there and the merged form cannot express Bedrock IAM or the 3-tier shape. TWO OUT-OF-ZONE EDITS, planner-approved: widening the two unions broke `ByoRuntimeStep.tsx` (exhaustive `ERROR_KEY` record) and `AiSettingsPage.tsx` (`editTarget.method` absent on the new variant), so each got the minimal edit that keeps the repo typechecking — one unreachable-until-E4 map entry, and a `merged` branch that maps back to the surface it resolved to before, byte-identical to today. A repo that typechecks at every commit outranks zone purity. TWO SUPERSEDED C3-era pins REWRITTEN, not deleted, with the change of answer recorded. New i18n key in both locales. Gates: `bun test apps/electron/src/renderer` → **1249 pass / 0 fail / 3075 expect()** across 145 files; apisetup folder 125 pass / 0 fail; `typecheck:electron` 0; i18n parity + sorted OK; `git diff --check` clean. |
| E4 merged form UI + sizing | ✅ | `6b5facd20` | ByoRuntimeStep rewritten: 3 arms, Pi presets, protocol (Pi/Custom only), C3 catalog block on all openai arms, miniModel, sync toggle. SIZING MEASURED both halves: dialog 241px→720px rendered with catalog open (the first width measurement was honestly discarded — the default playground pane is ~243px, narrower than either cap, so the class was in the DOM but "a width that cannot change cannot be evidence that it changed"; entry got `layout: 'full'` and was re-measured), scroller `max-h-72 overflow-y-auto` with clientHeight 270 < scrollHeight 325 → actually scrolls, no page overflow. Verified dark, all three radiogroups labelled. Arm-switch VALUE PRESERVATION pinned as a validator contract (Custom→Anthropic→Custom round trip; the official preset does not SUBMIT the endpoint but does not reject the form for having one — that is what lets the value survive). 12 new i18n keys both locales; 4 new playground entries INSIDE onboarding.tsx (no registry/index.ts edit; third writer untouched). RODE ALONG as sweep-unblocker: the un-closable "Set up this plugin" playground modal fixed (harness `onDismiss` was a no-op against an unconditionally-open Dialog whose overlay ate every click incl. the sidebar) — classified PRE-EXISTING by file history (last commit f7c0f723e, D15-era; lane E never touched it). One false alarm recorded: `docW: 0` was the headless viewport quirk, not a layout defect. Gate: `typecheck:electron` 0; `bun test apps/electron/src/renderer` 1251 pass / 0 fail across 145 files; i18n parity + sorted OK; `git diff --check` clean. TRACKER DEBT: this row was flipped AFTER the commit (planner backfill from the builder's gate report) — the same-commit rule was missed on E4-E6; recovery commit noted in the row's own sha column. |
| E5 wizard/card/edit switch | ✅ | `7ea125935` | The merged form became the ONLY personal-key entrance. api_key card removed; custom_runtime visibility `flags.api_key \|\| flags.nessy_codex \|\| flags.nessy_claude` (the api_key term keeps a runtimes-off build from hiding the only key entrance); `api_key` EXCLUDED from CHOICE_TO_METHOD rather than mapped, routed to the merged form so a stale pre-merge choice lands correctly instead of in a missing Record row. Pi arm delegates through the pi_api_key pipeline; ONLY the Custom preset emits customEndpoint; Anthropic preset → anthropic_api_key for the byte-level reset semantics. `handleSubmitCredential` gained a METHOD OVERRIDE mirroring handleSaveConfig's (the merged form mounts as the byo-runtime step, so state.apiSetupMethod is stale/null while the arm's preset decides — its three internal handleSaveConfig calls now pass the effective method). F5 mini-model threading END-TO-END: ApiKeySubmitData → handleSaveConfig options → apiSetupMethodToConnectionSetup's two model-bearing branches → every call site already forwarding models (the silently-missing step — a utility model picked on the Pi arm previously died between form and payload). Edit routing on the four-target router replaces E3's byte-identical stopgap; prefill carries preset/protocol/miniModel/sync-from-modelsSyncedAt (closing the AiSettingsPage gap where every edit silently withdrew enrollment). Dependency-array fix recorded: handleSubmitByoRuntime now depends on handleSubmitCredential — omitting it pinned the callback to the first render's closure and saved Pi-arm connections against a stale editingSlug. Gate: `typecheck:electron` 0; 1251 pass / 0 fail; i18n parity OK; `git diff --check` clean. |
| E6 Qwen dialect hint | ✅ | `b346a935a` | Additive per-connection hint, THREE decisions wired (the plan's zone list named the sites; the narrative understated that the FIRST decision makes the other two reachable): (1) `applyNestorReasoningProxy`'s gate gains the hint as a third way in — without it the proxy never starts for the very connection the feature exists for; (2) per-request reasoning split beside the id check; (3) `adaptToolRequestForDialect` gains a `force` option. Wire-boundary literals done FIRST (index.ts:251/:283/:1248 — the silent failure: a dialect only on the shared type is dropped there and the form looks wired while inert). Judgment calls recorded: the schema field added to CustomEndpointSchema properly (a key surviving via the non-strict object is a key nothing validates); OMITTED from the payload when Auto, so every existing connection's saved shape is byte-identical — additive, not a behaviour change. `buildBackendRuntimeSignature` + the three subprocess type literals widened per the fact-check caveats. Gate: gateway-proxy suite 18 pass / 0 fail; package typecheck 0; edited test file via the no-exclusion temp config 0; shared 0; electron 0; i18n parity + sorted OK; `git diff --check` clean. Three new tests: unrecognised model untouched by default, weakened when forced, unknown dialect refused even when forced. Test-idiom note: the file uses `test(` not `it(`. |
| G1 live-review defect fixes | ✅ | `4a0f238af` + `63e87a8ac` | (a) DONE — piAuthProvider derivation + mask strip on the Pi-arm pre-save test, both E5's own defects (attribution in the commit); every Pi/Custom create/edit unblocked. (b) DONE — cap moved from the ScrollArea ROOT to the VIEWPORT (new `viewportClassName` on ScrollArea + EntityList) and ByoRuntimeStep's second scroller dropped. LIVE RE-MEASURE on a 300-row keyless loopback catalog (18 305px of content), same rig, cap flipped back and forth via HMR: BEFORE — viewport scroll range **0** (client == scroll == 18 305), Root clipping at 240px with `overflow-y: hidden` → 18 065px of catalog unreachable; AFTER — viewport range **18 066px** at `overflow-y: scroll`, Root range 0. One real `synthesizeScrollGesture(-600)` moved the fixed viewport 600px before the compositor path started timing out on this window; the range numbers above are the assertion (compositor-independent), the gesture is corroboration. Stale guard message rewritten (+ the sibling `parseTestConnectionError` line naming the same two removed cards); both tests moved with it. `typecheck:all` exit 0; 205 tests across the affected files pass. |
| G2 form v2 llm-proxy-first | ✅ | `a8aac0eb6` | Decision set implemented. URL hardcoded+hidden via `resolveEndpointField` (4 ordered branches, official-first — an official connection stores no baseUrl, so the foreign-URL test must not run before it); foreign-URL EDIT shows the field DISABLED and submits the stored value verbatim. Preset/protocol/dialect/sync controls removed from the UI, all four SURVIVE as state — create pins them, edit round-trips them (E6's forced dialect survives a re-save). Always-on sync: create stamps, edit omits. PROBE: `unsupported-endpoint` is now its OWN verdict class (llm-proxy answers 400 for anthropic/* on chat-completions — before this they were reported `error`), plus the `max_completion_tokens` retry matched on the MESSAGE not the status, and a 429 backoff. Chunked 8/sequential in the renderer, generation-guarded, streaming: catalog renders first, verdicts merge per chunk, pending rows carry the spinner, unavailable rows are `disabled` (EntityRow extension) in one collapsed red-marked group. STORED-KEY EDIT: `TEST_LLM_CONNECTION_SETUP` gained optional `slug`; the handler resolves the credential server-side so the mask never travels. TWO DEFECTS FOUND BY THIS TASK, both fixed here: (1) the runtime-arm submit dropped `miniModel` and `modelsSyncedAt` (lane-E defect — claude/codex connections never enrolled in the 24h sync); (2) `jumpToByoRuntime` read the hook's `editingSlug` in the same tick `openApiSetup` scheduled it, so it was always the PREVIOUS value — measured live, Fetch came up disabled on every first edit; the slug is now passed in, and cleared on the create path so an abandoned edit cannot lend its credential to a create fetch. LIVE (owner's `pi-api-key-2`, read-only, nothing saved — re-verified unchanged after): slug-only fetch → 386 models, with the identical keyless call as negative control → fails. All four verdict classes measured: tgpt→ok, openai/openrouter/azure/perplexity/xai→no-quota, anthropic+gemini→unsupported-endpoint, garbage id→error. Full catalog probe **386 models in ~11s**; final grouping **17 available / 369 unavailable, 369 disabled rows and 369 red marks (1:1)**. Playground: 4 v2 entries reworked, swept dark+light. Gates: `typecheck:all` 0; `lint` 0 errors (4 pre-existing warnings, identical with the diff stashed); i18n parity+sorted green, dialect keys deleted in both locales; 2822 tests across renderer+server-core, 0 fail. **WALK-A REVERSAL + DEFECT, 2026-08-15 (`fab904c96`):** the owner's first live walk of v2 hit two blockers. (1) EVERY ROW CLICK SUBMITTED THE FORM — `entity-row.tsx`'s main `<button>` carried no `type`, and an HTML button inside a `<form>` defaults to `type="submit"`, so the first model picked SAVED the connection and multi-select was impossible. Both sibling buttons in that file already had it; nothing had ever put an EntityRow inside a form until this form did. Fixed + pinned, plus a broader pin that no `<button>` in that file is typeless. (2) **E4's measured dialog GROWTH (28rem → 3xl on catalog open) is SUPERSEDED by owner verdict** — «скачет ширина». The width is now constant `max-w-3xl` from mount; E4's growth measurement was correct and is no longer the wanted behaviour. Both verified live on the edit path (read-only, connection re-checked untouched afterwards). **WIDTH, FINAL (`b2414a7f6`):** the constant is the ORIGINAL narrow width, per the owner verbatim — «ширину формы нужно оставить изначальную как была, что бы она не расширялась». The step passes NO width class and inherits `StepFormLayout`'s `max-w-[28rem]`; the intermediate constant-`max-w-3xl` state in `fab904c96` came from crossed messages and is superseded. E4's measured 28rem→3xl growth is REVERSED, not merely restyled. **PLACEHOLDER (owner addition):** the picker renders from mount with an empty catalog, so placeholder → streaming rows → grouped list are the SAME component and the region reserves its space once; copy reuses `EntityListEmptyScreen`, i18n both locales. LIVE across all three states: form width **420px / 420px / 420px** and list width **420 / 420 / 420** — constant. List HEIGHT 295 → 310 → 310: a **15px residual** between the placeholder and the filled frame, because EntityList's empty branch renders `header + emptyState` while its list branch adds `pt-1`/`pb-2`. Matching it by number was tried and overshot; the residual is left visible in a comment rather than hidden behind a constant the next header change would break. Row buttons report `type="button"`, the form survives two consecutive row clicks, the model list changes on each. **FINAL SHAPE (`688f6cff7`):** list height equalised STRUCTURALLY at the owner's request. The first pass left 295 vs 310 because `emptyState` takes EntityList's early-return branch (`header + emptyState`) while the list branch renders `header + ScrollArea(pt-1…pb-2)`, and matching totals by number overshot to 325. The placeholder now rides through the LIST branch as `footer` — no `emptyState` prop, and its absence is exactly what skips the early return — with the viewport's floor and cap set to the SAME token. One assumption was corrected by measurement on the way: **`min-h-60` is 225px in this config, not 240**, so the first structural pass still moved 15px. Measured live, one form, all three states: **420 wide, list 420×310 in every one** — placeholder, streaming (356 rows), probed (17 available). MODELS FIELD: the typed comma-separated field is HIDDEN on CREATE (the picker is the only route in — «мы и так выбираем из того что нам ключ предоставляет») and SURVIVES on every EDIT path, where a stored connection may be one no catalog can be fetched for. In its place a chip summary whose FIRST chip is marked default, which is true at the wire (`models[0]` → `defaultModel`; the picker's toggle appends rather than sorts, pinned with a negative control whose first element would not survive sorting). **WALK-A DEFECT, FOUND BY `BYO-CATALOG` ON THE OWNER'S OWN CREATE (`f6bfdfee8`):** C1/C3's promise was not met — `pi-api-key-4` came out stamped but carrying a BARE model id with no `contextWindow`. Diagnosis: **always-on stamping disabled the fetch it was meant to guarantee.** The create submits `modelsSyncedAt: Date.now()`; the post-create `refreshNow` reaches `refreshEnrolledMetadata`, whose first line is `if (isModelSyncFresh(connection)) return` — and the stamp it reads is the one the create wrote a moment earlier. Before G2 the create did not stamp, so that first refresh ran. The window would not have arrived until the 24h TTL expired. FIX (owner option 3): the form persists WHAT IT DISPLAYED. `modelMeta` carries the catalog's per-model `contextWindow` (and G3's wire) into the payload, and `promoteModels` turns picked ids into `ModelDefinition` objects — on BOTH arms, since the Pi arm never reaches `buildByoRuntimeSetup`. No refresh dependency remains; `refreshNow` legitimately no-ops. Verified per the planner's checkpoint (a): the SETUP handler's Pi normalization already handles object models (`llm-connections.ts:213` maps `typeof m === 'string' ? … : { ...m, id: … }`) — checked, not assumed. **CHIPS, click-to-choose-default (owner):** the summary chips are real buttons; a click moves that model to the FRONT, which IS `models[0]` → `defaultModel`, so position and meaning cannot drift. First-pick remains the initial default until a click overrides it. ONE ROW, `flex-nowrap` with its own `overflow-x-auto` and a new `mask-fade-right` utility (horizontal twin of the existing vertical ones); the row owns its overflow so the page never gains a horizontal scrollbar. Live in the playground with the owner's own 17-model count: **17 chips, 1 row, row scrollWidth 2459 vs client 424, form still 420 wide, page h-scroll false**; clicking the 9th chip moved it to index 0 with the rest keeping their relative order and the default marker + aria following it. **UTILITY SELECT (owner, 2026-08-15):** it could not be opened in the app at all. The playground opened it with 17 options, which ruled out a stale option source — the list already comes from the chips. The difference is the fullscreen overlay: Radix portals `SelectContent` to `document.body`, the shape `AddWorkspaceStep_ConnectRemote` already solved with a container ref. Fixed by rendering the list INSIDE the form. Verified in the playground at the owner's 17-model count: **18 options, first `Automatic (last model in the list)`, the rest equal to the chips IN ORDER, content mounted inside the form**. Automatic maps to no `miniModel` (E1's blank-clears contract), a pick maps to that model. |
| G3 anthropic-wire through llm-proxy | ✅ | `44f4ef201` | ROW ADDED BY THE EXECUTOR — lane G's prose specifies G3 and the tracker had no row for it. CODE COMPLETE; the live proof of a real Anthropic-wire turn is deferred to the owner's check-in (it needs the entitled key — key 1 is not). `UpstreamTarget` third member `{kind:'anthropic-messages'}` → `{base}/v1/messages`, `Authorization: Bearer`, `anthropic-version` FORWARDED not invented; `postChat` REFUSES it, since a chat body there yields a confusing endpoint 400 instead of a clear local failure. The `/v1/messages` passthrough is decided on the RAW inbound body BEFORE translation and piped back byte-for-byte, SSE included. PER-REQUEST routing via `AdapterOptions.upstreamForModel`, built by `buildClaudeRuntimeWireRouter` from the connection's models — undefined when nothing is wired (every pre-G3 session unchanged) and undefined in GATEWAY mode (the corp gateway serves no /v1/messages and authenticates by Nestor-Token). **THE WIRE IS MEASURED, NOT INFERRED** — the design correction this task made against the plan's own wording: on `400 unsupported endpoint` the probe now ASKS `/v1/messages`, and only a real answer sets `wire`. Inferring it from the chat-completions refusal would have claimed `gemini/*` speaks Anthropic Messages — it refuses BOTH wires and has its own Google path — which is a worse lie than the one G2 fixed. `ModelDefinition.wire` persists through a string→object promotion on the claude arm only; the 24h sync preserves it (merge order now pinned by a test). Per-arm availability: `resolveArmVerdicts` projects an anthropic-wire model to `wrong-runtime` on Pi/codex with its own reason string in both locales. `CredentialsStep`'s dead "use Anthropic API Key mode" line rewritten — the third instance of that stale text. LIVE, owner's `pi-api-key-2`, read-only: tgpt→ok · anthropic/*→**no-quota** (was `unsupported-endpoint`: the second wire IS asked and answers 404 quota-not-found on this key, so the verdict now names entitlement rather than protocol) · gemini/*→unsupported-endpoint with NO wire claimed · openai→no-quota. That contrast is the discrimination the design exists for, measured rather than argued. Gates: `typecheck:all` 0; `lint` 0 errors; i18n parity+sorted; 3071 tests across renderer+server-core+adapter and 2712 across shared/agent, 0 fail. **LIVE SITTING 2026-08-15 — the wire is PROVEN, the end-to-end turn is blocked by EXTERNAL POLICY (owner-deferred).** PROVEN, ours: the owner's real walk-B save persisted both models with `wire: anthropic-messages` AND `contextWindow: 1000000` — G2's metadata and G3's wire, from the form, unassisted. `G3-WIRE`'s negative control returns `{verdict:'ok', wire:'anthropic-messages'}`, a POSITIVE proof that chat-completions does not serve that model. Gateway positive control on the same runtime and the same tool surface: `GW-OK`, zero errors. BLOCKED, not ours: a Claude-runtime turn against llm-proxy returns **403** `… Security Guardrail Triggered: Malicious MCP detected. Invalid tools: mcp__dpGitlab__*, mcp__plugin_figma_*, mcp__session__BashOutput, mcp__session__TodoWrite, mcp__session__call_llm, …` — the proxy's allowlist rejects agentic tool names, INCLUDING Nessy's own built-in session tools. The request authenticated; the tool list was refused. BLAST RADIUS, measured rather than assumed: `BYO-QWEN` sends the SAME full tool surface over chat-completions to the SAME host with the same key and gets a clean answer, so **the guardrail polices `/v1/messages` only** — Pi and Codex BYO on llm-proxy are unaffected. TWO DEFECTS FOUND ON THE WAY: (1) the SDK reports this 403 as `authentication_failed` and our mapper said «Your API key may be invalid or expired», sending an hour of work after a credential bug that did not exist — fixed with the upstream reason carried through and a 401 positive control; (2) `setSessionModel(sessionId, workspaceId, model)` — three CDP drivers fed the model into the workspaceId slot, which silently no-ops and looked correct on a single-model connection. Owner decision 2026-08-15: the guardrail is a platform-policy conversation, deferred; G3 closes on what OUR side promises. |
| H1 guardian honesty + per-connection judge model | ✅ | `2e5c784da` | (1) PER-INTEGRATION judge model DONE. `guardianJudgeModels?: Record<slug, modelId>` on the stored config + validators entry; `getGuardianJudgeModels` / `setGuardianJudgeModelForConnection` (an empty id REMOVES the entry, so the chain sees "no preference" rather than an unusable one); two RPC channels; TWO DEPENDENT SELECTS in settings — integration → that integration's catalog only, and the integration select hides itself when there is one connection. Resolution lives in a pure `resolveGuardianJudgeModel` with 9 tests: this connection's entry → the legacy global IF valid here (no migration) → the gateway `fast` alias → the caller's default. A stale entry falls THROUGH rather than erroring, and an allowlist veto falls back too — a model restriction must not become a safety reduction, since the judge is the deny-net. The single-model case works by NOT being special-cased. `fast` is matched exactly or as `*/fast`, never as a substring (`breakfast` is not the alias). The consult site reads the catalog from `getBackendRuntime`, the same resolver the subprocess config is built from, so the two cannot drift. (2) SCOPE HONESTY DONE: the Guardian section's description now states the Pi-runtime scope in both locales — the section promised the deny-net unconditionally while the port is wired for `provider='pi'` only. (5) DEAD RUNNER — **DEVIATION, recorded rather than taken.** The plan says delete `pi-agent-server/src/orchestrator/guardian-runner.ts` unless an owner decision protects it; I found no such decision, and I did not delete it. Evidence: its only importers are two tests, but one of them (`child-output-neutraliser.test.ts`) uses it as one ARM of a cross-cutting property — that every spawner-backed child-output surface neutralises untrusted text. The wrapper's own job is adapting the orchestrator spawner's richer result to the shared core's minimal spawn contract, so deleting it either drops that arm or duplicates the adaptation inside a test. Removing 60 lines at the cost of a weaker cross-cutting test is a bad trade; the file stays with this note. (3) failure marker and (4) git facts remain. **(3) FAILURE MARKER DONE (`0a85984fd`):** both consult sites now route their ask through `markJudgeFailure`, which appends an i18n marker to the prompt's `reason` when — and ONLY when — `outcome.reason === 'failure'` (spawn error, timeout, malformed verdict). `unsure` is the judge working and declining; `disabled`/`override`/`circuit-open` are states the user chose or can already see. The user is still asked either way — fail-closed to a human is unchanged — they simply learn WHY. Both locales. **(4) STOPPED — the plan's premise is false, rule 8.** It says to reuse «the source the protected-branch enforcement in pre-tool-use already reads» and warns against inventing a second branch detector. **There is no protected-branch enforcement.** `pre-tool-use.ts` imports `protectedPaths` — file PATHS, not branches — and a repo-wide search (`-a`, for the NUL-byte trap) finds exactly one branch reader: `RPC_CHANNELS.git.GET_BRANCH` in `server-core/handlers/rpc/system.ts`, an `execSync` handler serving the RENDERER, unreachable from the shared consult site. The nearest default-branch notion is `worktree-git-plan.ts`'s `refs/remotes/origin/HEAD`. So the only ways to do (4) are to invent the detector the plan forbids, or to thread a new host→shared seam — a scope decision, not an executor's. The judge's own policy text cites protected-branch git, so the fact is worth having; it needs a decision on WHERE the branch comes from. **(4) CUT ✂️ AND DEFERRED (planner decision 2026-08-15, after independently verifying the stop):** the task text was written on a mechanism that does not exist, so it moves to the next guardian-adjacent plan rather than being improvised here. The finding stands and is worth carrying: the judge's policy text cites protected-branch git while `gitBranch`/`protectedBranch` are never populated. Cheapest shape when it is picked up — `SessionManager` already runs git in the workspace root, so cache the branch on the session and pass it at consult time; no second detector. |
| F1 Pi honest fallback window | ✅ | f9de3fdff | M1: `windowIsFallback` out of `buildCustomEndpointModelDef`, recomputed set on the registry state, `contextWindowSource: 'fallback'`; M2: `mayFallBackToTokenUsage` kills the tokenUsage+static-registry divisor for fresh-local at 3 sites; switch → `Record<ContextWindowSource,…>` table (positive control: dropping a member is TS2741) |
| F2 claude synced window via env | ✅ | 5f9f82b33 | `buildClaudeMaxContextTokensEnv` into `startLocalAdapterRuntime`'s envOverrides; gate = the binary's own `!startsWith('claude-')`, re-read verbatim from fn `NKc`. PLAN CORRECTION: `JZn` is not a known-model table — it returns non-null only for `claude-sonnet-4-6` from remote config; the protection for known ids is the `claude-` guard on the next line plus three 1e6 early returns. The `MKc`/DISABLE_COMPACT nuance is verbatim correct. |
| F3 codex usage casing + window + compaction visibility | ✅ | 546c79368 | (a) wire is camelCase — settled against the generated contract AND the shipped binary's string tables (both casings exist; snake_case is the rollout struct + OTel attrs + config.toml keys), fixtures corrected. (b) `model_context_window` from the spawn model's synced window; VERIFY answer: codex does NOT respawn on model switch (`setModel` only sets `_model`), staleness accepted with a comment; no `model_auto_compact_token_limit`. (c) both `thread/compacted` AND the `contextCompaction` item — the contract deprecates the first in favour of the second and the bundled binary still emits it. (d) VERIFY answer: YES, `thread/compact/start` is in the binary's client-request method table beside `thread/start`/`thread/fork`; `/compact` is now a request, not prose. Completion ORDERING is unverified — queue closes on the response so it can lose the row but never hang; F5-codex settles it. FreeFormInput capability-gating NOT done (plan defers it post runtime-switch lane). |
| F4 no invented meter thresholds | ✅ | c68934a78 | `thresholdKind: real\|formula-claude\|none\|legacy` on the composer capability → `ContextMeterInput`; claude formula computed renderer-side (window − 20 000 − 13 000, the 20 000 arm pinned with its reason); codex silent; legacy keeps 77.5%. ChatDisplay NOT in zone after all — FreeFormInput already receives the capability. Plan's "post runtime-switch-lane" precaution MEASURED rather than assumed: the third writer's stash 878a29fae applies onto this HEAD with zero conflicts (temp worktree, all four files restored). |
| F5 compaction CDP cases ×3 | ✅ | (this commit) | **Three arms run live on the owner's real profile; the claude and codex arms RE-RUN against F6 (`16b4445c6`) and F7 (`754efa7fd`), which the first sitting produced. FINAL: PI PASS 10/10; CODEX PASS 9/9; CLAUDE manual PASS / auto FAIL — and the auto FAIL is a new product finding, not a blocked arm.** Substrate unchanged: the case creates its own gateway connection per arm (`pi-api-key-91` / `claude-gateway-92,93` / `codex-gateway-91`), writes the narrow `contextWindow` into ITS models[] entry, and deletes it in a `finally` that opens at creation with the deletion verified by re-listing; the owner's 11 connections were re-listed intact at the end and `credentials.enc` was rewritten by the product on every create/delete, which a store that failed to decrypt would have refused to do (it fails closed and never overwrites). **F6 LIVE-PROVEN:** occupancy reads **58 396** after the first turn where all 15 claude sessions before it read 0; it then tracked every turn (80 182 → 101 982 → 123 782). The counter is `tokenUsage.inputTokens` — `contextTokens` is still 0 on both non-Pi arms, so any surface reading `contextTokens ?? inputTokens` reads zero (see the new finding below). **F7 LIVE-PROVEN on disk:** the running session's own `CODEX_HOME/config.toml` carries `model_context_window = 240000` AND `model_auto_compact_token_limit = 204000`, and the net fired: 119 415 → 63 635 manual, then five turns to **208 660** and auto-compaction took it to **71 824** (−136 836), 4 660 past the limit, zero error rows. **SCOPE SETTLED** (F7 flagged it as undocumented): the base was 32 622, so `body_after_prefix` would have charged ~176 000 at the trigger — under the limit, nothing would fire. It fired at 208 660 of TOTAL context, so codex's default scope behaves as `total` and F7's under-set hedge was not needed. **CLAUDE AUTO-COMPACTION DOES NOT EXIST:** carried to 225 523 and then **227 337 — 94.7% of the 240 000 window the SDK itself reports**, 20 337 past F4's 207 000 point — with no drop, no second `compact_boundary`, no error rows; `DISABLE_AUTO_COMPACT` is Pi-path-only and never set for the Claude subprocess. Positive control in the same session: manual `/compact` 123 782 → 59 261 with the SDK's own record (`trigger: "manual"`, `preTokens: 123816`, `postTokens: 2135`). **DRIVER FIXES, and the first attempt is why they exist.** (1) A THRESHOLD IS A BAND: one 60 000-char filler is 29 075 tokens, claude's band (207 000 → 230 144, the latter being the model's real 262 144 less the adapter's 32 000 completion reserve) is 23 144 wide, so the fixed step jumped it — 175 610 → 204 685 → a 233 764-token request the gateway refused. The last approach turn is now sized from the tokens-per-char rate the run measures for itself. (2) The codex arm was aiming BELOW its trigger by construction: 0.88 × the REPORTED 228 000 = 200 640 against F7's 0.85 × the CONFIGURED 240 000 = 204 000; the target is now the limit. (3) A DROP IS NOT A COMPACTION — the headline check now requires an empty error-row diff, because that refused request produced a 204 685 → 87 118 fall that looked exactly like a working compaction. (4) `readClaudeSessionLog` reads EVERY jsonl in the session's own directory: the SDK rotates files and the boundary count read 1 → 0 across a step that added none. (5) `tokensBefore`/`compactionTrigger` read claude's `compactMetadata.preTokens`/`trigger` beside Pi's `tokensBefore`/`fromHook`. (6) The threshold assertion is skipped with its reason stated when no automatic record exists, instead of printing "the trigger fired early" about the MANUAL compaction. **THREE NEW PRODUCT FINDINGS, reported not fixed:** (a) claude has no automatic compaction; (b) the upstream 400 reaches the user as "Unknown Error: An unexpected error occurred." while the transcript holds the exact sentence, and the runtime then silently continues in a NEW conversation (`parentUuid: null`) with the history discarded and no notice; (c) the usage overlay's Context row still reads 0 on claude/codex — `formatContextUsage` takes `contextTokens ?? inputTokens` and `ensureTokenUsage` initialises `contextTokens` to 0, so `??` never falls through; positive control on the real formatter with this run's measured DTO returns "0 / 240,000 (0%)" against "132,377 / 240,000 (55%)" for a Pi-shaped one. The donut itself is correct — it reads `inputTokens`. Gates: `bunx tsc -p scripts/cdp/tsconfig.json` exit 0; `git diff --check` clean. Checklist: "Run of 2026-08-15 — F5 `COMPACT-LIFE`" (arm table, the per-runtime table, the three new findings and the six detector faults) plus the `COMPACT-LIFE` row in Context & compaction. |
| F6 claude occupancy is zero | ✅ | (this commit) | **THE PLAN'S CANDIDATE CAUSE IS REFUTED BY MEASUREMENT.** `isSidechain = parent_tool_use_id !== null` is not it: the shipped binary sends the field explicitly as `null` on every main-line `assistant` and `stream_event` wrapper. REAL CAUSE, `event-adapter.ts:311` (pre-fix): the per-message snapshot was taken from `assistant.message.usage`, which is the `message_start` snapshot verbatim — and a gateway turn cannot know its input count at `message_start`, so `anthropic/outbound.ts:129` opens with `{input_tokens: 0, output_tokens: 0}` and settles the real figures in `message_delta`. `adaptResult` then PREFERRED that zero over the result's own correct `usage`. DETECTOR: the shipped SDK binary driven through the REAL `codex-responses-adapter` against a stub gateway — `assistant.message.usage` `{0, 0}` against the same turn's `message_delta.usage` `{input_tokens: 58392, output_tokens: 38}`, and the probe reproduced the owner's persisted triple (58 392 / 38 / $0.29291) byte-for-byte. Corroborated on disk: 15 of 15 `claude-gateway` sessions carry `inputTokens: 0` beside a large `modelUsage`, while all 372 `pi-*` and 4 `codex-gateway-91` sessions do not — the positive control. FIX: `recordAssistantUsage()` reads BOTH frames, last positive reading wins, a zero total is "no observation" (neither announced nor allowed to clobber). `result.usage` deliberately NOT used as the substitute — it is cumulative over a turn's requests and would inflate every tool-using turn; that is pinned by its own test. `!== null` → `!= null` hardened anyway, with the measurement recorded. Red-then-green: 2 fail / 49 pass before, 51 pass after (`claude-event-adapter.test.ts`). |
| F7 codex auto-compaction limit | ✅ | (this commit) | `model_auto_compact_token_limit` now rides the same gate and the same source as `model_context_window` — no window, no invented limit — via `autoCompactTokenLimit()`. **CHOSEN: 0.85 of the window** (240 000 → 204 000; 272 000 → 231 200), which SUPERSEDES F3's «no derivation source» decision now that F3(b) supplies one. Rationale, in the constant's own comment: codex's wall is 0.95, not 1.0 (its `effective_context_window_percent` reserve, measured live at both 240 000 → 228 000 and 272 000 → 258 400), and the trigger must clear that wall by enough for the compaction request to re-send the conversation and produce a summary — F5 watched a settling turn push occupancy UP by 1 768 after the peak. 0.85 leaves a tenth of the window (24 000 at 240 000) between trigger and wall, twice the reserve, and lands the three runtimes at comparable occupancy (Pi's measured 206 808, F4's claude formula 207 000, this 204 000 on the same window). Under-set on purpose: `model_auto_compact_token_limit_scope` is left at codex's own default and the non-`total` scope charges FEWER tokens against the limit, so a low limit still fires while a high one would not fire at all. Contract read from `packages/codex-protocol/schema/config-schema.json` + the generated `AutoCompactTokenLimitScope`, and `validateConfigAgainstSchema` now requires the key to be a real top-level property. Red-then-green: the F7 assertions fail with the emission disabled, 17 pass with it; 244 pass across the package. The two F5 checklist findings carry a pointer to their fix so the re-runner does not chase the refuted lead. |
| F8 overlay context row reads zero | ✅ | (this commit) | One shared resolver, `resolveContextTokens` in `ChatDisplay.usage-format.ts`: a `contextTokens` of 0 is `ensureTokenUsage`'s INITIALISER, not a reading, so it falls through to `inputTokens`; a session where neither counter observed anything yields `null` and renders `? / 240,000` rather than a confident `0 / 240,000 (0%)`. **SWEEP RESULT — the pair has exactly TWO consumers, both fixed**: `formatContextUsage` (`ChatDisplay.usage-format.ts:101` pre-fix — the usage overlay's Context row) and `getContextTokenTotal` (`context-overlay.tsx:93` pre-fix), the latter feeding THREE surfaces the finding did not name: the `/context` overlay's Current row and its derived Remaining/Used% (`ChatDisplay.tsx:2496`), the breakdown's percentage denominator (`context-overlay.tsx:202`) and the legacy totals rows' unattributed remainder (`:112`). The other three `contextTokens ??` sites are NOT that pair and are deliberately untouched: `handlers/session.ts:1016` carries the previous value forward on a usage merge (a writer), `views/evaluator.ts:151` exposes the raw field to user-written view expressions (its own documented contract, `views/validation.ts:34`), and `SessionManager.ts:2068` prints the raw field in the markdown transcript export. The donut is untouched — it reads `inputTokens` and was already right; `getContextTokenTotal` has no caller in the composer. RED-THEN-GREEN with the measured control values: with the old expression restored, 3 fail and the failure prints `Expected "132,377 / 240,000 (55%)" / Received "0 / 240,000 (0%)"` — F5's two strings, byte-for-byte; 31 pass after (`ChatDisplay.usage-overlay` + `usage-format` + `context-overlay`), 26 before the new tests. Gates: `bun run typecheck:all` exit 0; `git diff --check` clean. |
| F9 claude auto-compaction | ✅ | (this commit) | **FIXED, not merely recorded — and the cause is one line of the shipped binary.** The SDK's only proactive auto-compaction gate is `pY_`, whose fourth line is `if(Vbe()&&!cGe(t,r))return!1`. `cGe(model,window)` is `NK(model,window).source!=="auto"`, and `NK` walks env → settings → clientdata → experiment → a THREE-id table of known Claude models (`NYg`) → `{window:<model max>, source:"auto"}`. A gateway id reaches that last arm, so `cGe` is false, `Vbe()` is true (false only under `CLAUDE_CODE_REMOTE`), and the caller `pRs` answers `{kind:"not_needed"}` every turn, forever. **The `source==="auto"` diagnosis is MEASURED, not inferred:** F5's run had the SDK reporting 240 000, which is `NKc`'s env value — had the known-id arm matched, `JE` would have returned its 200 000 constant (`XQt`) instead. The plan's suspects are all refuted: `DISABLE_AUTO_COMPACT` is never set (and `QI()` is a separate, earlier line that passed); `bypassPermissions` and our PreToolUse hook appear nowhere in the gate; there is no model/provider allowlist for compaction — `NYg` is a *window-tuning* table, and missing it costs the window's SOURCE, not permission to compact. Nothing else rescues it either: the post-turn reactive ARMING path is behind a remote gate defaulting off (`vtn` → `Je("tengu_sepia_moth",!1)`), and the last net (`OSo` from the PTL branch) fires only on a recognised `prompt_too_long` — which this gateway's 400 does not present as, i.e. the separately-filed silent-conversation-reset defect is also why the fallback missed. **THE DOCS DESCRIBE A NEWER BINARY, and the version is the proof.** `model-config.md` § *Default auto-compact thresholds* says an unrecognised id "compact[s] at the context window Claude Code assumes for the ID", and env-vars.md adds `CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT` to opt OUT of exactly that, "Requires Claude Code v2.1.223 or later". Our bundle is **v2.1.218** (349 occurrences of the version string) and that variable appears **0 times** in it — the positive control on the version claim. **FIX:** `buildClaudeAutoCompactWindowEnv` emits `CLAUDE_CODE_AUTO_COMPACT_WINDOW` from the same stored window, behind the same gate, beside F2's `CLAUDE_CODE_MAX_CONTEXT_TOKENS`; it is `NK`'s FIRST branch, so source becomes `"env"`, `cGe` true, and `pY_` proceeds to the threshold — `window − min(maxOutput,20 000) − 13 000`, the SAME subtraction F4's `formula-claude` already draws the composer's warning against, so the displayed 207 000 becomes the number the SDK acts on. Documented: model-config.md § *Set the auto-compact window* — "In scripts and cloud environments: set `CLAUDE_CODE_AUTO_COMPACT_WINDOW`. While it's set, it takes precedence over the command, the flag, and the setting". Two binary details the tests pin: the value must be a plain integer (env-vars.md: "`500k` reads as `500` and clamps to the 100K minimum"), and a window below the documented 100 000 floor is still emitted, because the binary floors the CONFIGURED value and then takes `Math.min(modelWindow, configured)` — a 40 960 model keeps 40 960 and gains a non-`"auto"` source, which is the entire point. The `claude-*` exclusion is inherited from F2 but is OUR choice here, not the binary's (`NK` reads this env for every id) — stated in the comment so it is not mistaken for a copy. Red-then-green: 4 fail / 3 pass with the emission disabled, 11 pass restored (`claude-auto-compact-window-env` + `claude-max-context-tokens-env`), including a lockstep test that the two env vars can never describe different models or numbers; 1 758 pass / 0 fail across `packages/shared/src/agent/__tests__/`. Gates: `bun run typecheck:all` exit 0; `git diff --check` clean. **NO PRODUCT SURFACE HAD TO BE CORRECTED** — audited before deciding: the anthropic branch of `resolveContextUsageCapability` carries no `compact` field at all (it claims neither manual nor auto), `context.remainingAutoCompact` renders from the Pi-only snapshot and shows `?` here, and the composer's `chat.contextUsage.combined` ("% of compaction threshold") named a threshold nothing acted on — this fix makes that existing copy true rather than needing new words. `compact: {auto: true}` is deliberately NOT added to the capability: absence claims nothing, and a positive claim is owed the live proof. **LIVE-PROVEN 2026-08-15 — the SDK acts on it, and the number it acts on is F4's.** The owed `NESSY_F5_RUNTIME=claude` re-run is done, on a `main.cjs` rebuilt from this commit and grepped for `CLAUDE_CODE_AUTO_COMPACT_WINDOW` before a single prompt was sent (0 occurrences in the 07:01 bundle, 1 in the 08:38 one — the stale-bundle trap this repo pays for repeatedly). `COMPACT-LIFE` claude arm: **PASS 13/13**. A SECOND `compact_boundary` in the SDK's own transcript, `compactMetadata: {trigger: "auto", preTokens: 217844, postTokens: 14748, durationMs: 5845}` — **10 844 tokens past the 207 000 point F4 displays**, on the same 240 000 window, with the manual compaction from earlier in the SAME session carrying `trigger: "manual"` as the control and the error-row diff across the whole auto half **empty** (a drop with an error row is the silent conversation reset, not a compaction). Occupancy 204 509 → 66 229. Before this commit the identical fill reached 227 337 (94.7% of the window) with one boundary and no drop; the count is now 0 → 1 (manual) → 2 (auto). **The free stderr detector did NOT work and the checklist now says so** — the gate's `autocompact: tokens=… level=… effectiveWindow=…` line never appeared, on the app's stderr or in `main.log`, through a run in which the gate demonstrably ran and compacted; the binary logs it through a minified logger whose own gating could not be read out of the bundle, so its silence proves nothing in either direction. **The runtime's own `preTokens` is what made the threshold assertion possible:** the sampled peak was 204 509, *below* 207 000, while the record's own figure was 217 844 — a case asserting on its sample would have called a correct trigger an early one. One driver change, in `compaction-lifecycle.ts`: a second record is not yet an automatic one (the manual `/compact` writes one too), so the arm now asserts the runtime's own LABEL — `compactMetadata.trigger !== "manual"` on claude, `fromHook === true` on pi, an absent label failing on purpose. **Cross-package invariant added** (`claude-compaction-threshold-lockstep.test.ts`): F4's `formula-claude` threshold and the window this env hands the SDK were one number computed in two packages with nothing between them. The test pins them against the binary's own subtraction written out as literals, so a drift on either side fails rather than agreeing with whichever side moved; `resolveThreshold` is exported for it because `resolveContextMeterState` only ever returns a rounded, 99-capped PERCENTAGE of that threshold, which is exactly the resolution at which a drifting constant hides. Red-then-green both ways: 2 fail with F4's 13 000 buffer moved to 12 000, 2 fail with this env clamped to a 100 000 floor, 4 pass restored. Gates: `bunx tsc -p scripts/cdp/tsconfig.json` 0, `typecheck:shared` 0, `typecheck:electron` 0, `bun test` on the three claude window/env suites 15 pass / 0 fail, `context-meter-state.test.ts` 14 pass / 0 fail, `git diff --check` clean. Run-owned `claude-gateway-91` deleted and verified gone; the owner's 11 connections are byte-identical by slug and `credentials.enc` is back to its pre-run 7 530 bytes. |
| Z1 close-out | ✅ | (this commit) + `d86696b35` + `e16df6563` | **Version** 1.25.1 → **1.26.0** in both package.json, in lockstep, minor per the owner's decision; each diff is the version line and nothing else. **RELEASE NOTES REWRITTEN, not shipped as staged** — the F14 note said they were stale and they were stale in two ways that mattered: the draft described the C3-era **auto-refresh switch** (G2 DELETED it; sync is always on and merely stated — `ByoRuntimeStep.tsx:745-751`, «это не нужно юзеру мы это должны и так делать») and a **Check access** button probing «only your selection, never the whole catalog» (the merged form passes no `onProbeSelected`; `handleFetchCatalog` calls `probeCatalog(fetched.map(m => m.id))` — the WHOLE catalog, streaming in chunks of 8). Both claims were the opposite of what shipped. The final notes carry A–H: the merged one-entrance form with its runtime radio and hidden endpoint, streaming availability marks, anthropic-wire models on the Claude runtime **with the llm-proxy guardrail stated rather than hidden**, always-on metadata sync, `source_manage`, the per-integration guardian judge, correct windows + working auto-compaction on all three runtimes, no invented thresholds, runtime marks, the plate gutter — and the user-visible fixes: the session-killer (D7), claude's zero occupancy (F6), the overlay's zero Context row (F8), think-split by model (C6/E6), BOTH halves of the OAuth failure (D5), the honest upstream error message (G3), D1/D2, A4. Intra-train defects (the row-click submit, the width jump, the un-openable utility select, the unstamped context window) are deliberately absent — they were introduced and fixed inside this same release. **docs-site: 10 files, both locales.** `custom-endpoint` — the toggle prose replaced by the always-on merge, a five-row availability-marks table, and the anthropic-wire second-wire probe; `llm-connections` — the custom-runtime section rewritten for three arms, the hidden/locked endpoint, picker + chips, `miniModel` and automatic enrollment; `config-file` — `guardianJudgeModels` documented with its fall-through resolution order, plus the Pi-scope note on `guardianEnabled`; `installation` + `introduction` — stopped advertising the **API key** card E5 deleted. **D5 DEBT PAID, not re-filed** (`d86696b35`) — see D5's own row; the `OAuthPinnedFetch` signature that blocked it was already solved by `withTestNetwork` in the same file. **Deviation register: regenerated, NO-OP** — `python3 scripts/regenerate-deviation-register.py` exit 0, 552 lines, byte-identical, exactly as Z1 predicted (this plan carries no category strings); run and recorded rather than silently skipped. **Parity report regenerated, +1 row, and the cause is NOT this plan:** `2026-08-15-session-tool-wire-name-unification.md:136` cites `2026-08-14-session-runtime-switching.md`, a plan file that no longer exists on disk, so the generator reclassifies the citation as a foreign doc page (§3b 48 → 49). Dangling citation, another lane's to fix — recorded here so the next regenerator does not chase it. **FOUR FAILURES IN THE FIRST WAVE, none on the known-failing register, and `master` is green on all four** — the AGENTS.md merge-gate trap paying off, because a per-base check could not have seen them. ONE cause, and it was a real defect: `40160696d` registered `session:getRecentStderr` in `rpc/settings.ts` and never declared it in that module's `HANDLED_CHANNELS`, so `registration.test.ts` and `registration-profiles.test.ts` both reported an undeclared channel; the frozen wire-format inventory was additionally stale for it AND for H1's two guardian channels. Fixed in `e16df6563`: one declaration line, and the frozen list **regenerated from `RPC_CHANNELS` itself** (343 → 346, `UNIQUE=346`, a strictly-additive 3-line diff) rather than hand-typed. Its header names `scripts/ipc-inventory.ts` as its generator and **that script does not exist in this repo** — which is how it went stale in silence; filed as a follow-up. **FINAL WAVE, `release/` removed FIRST, sequential, nothing else running:** `typecheck:all` **exit 0** · `lint` **exit 0** (124 warnings — 120 electron + 4 shared — 0 errors) · `test:shared:all` **exit 0** (20 + 5 + 70 + 244 pass, 0 fail) · `bun test` **exit 0 — 13 501 pass / 19 skip / 0 fail, 51 320 expect() across 1 148 files** · `lint:i18n:parity` **OK, 2 257 keys** · `lint:i18n:sorted` **OK**. No known-failing row had to be invoked: the register's four candidates (`pre-tool-use-checks.isolated`, `session-branch-rollback.isolated` ×3, the codex live-gateway conformance pair, `capability-info-pages` ×6) did not appear in either run. |

## Verification Log

Three independent planner passes ran 2026-08-14 (workflow `wf_515ee376-269`),
each against HEAD `af13d312c`:

1. **Fact check — PASS.** Every load-bearing anchor verified; minor line
   drifts noted inline (PluginOriginBadge img at 55-56, categoryOrder at
   index.ts:80). Resolved into the plan: modelSelectionMode already
   persisted (llm-connections.ts:171); BYO form = ApiKeyInput.tsx;
   `NESTOR_CLI_BASE_PREFIX` importable from `@nessy-agent/shared/auth/nestor`;
   lobehub filenames verified on unpkg; PendingAuthNotice chrome carries an
   extra ` select-none` vs its two siblings.
2. **Autonomy audit — was FAIL, fixes applied.** Blockers closed: (a) five
   source SVGs vendored at `assets/2026-08-14-lobehub-mono/` (v1.94.0,
   fetch verified from this machine 2026-08-14) so A1 needs no network;
   (b) C3 rewritten with resolved files and a pinned no-new-channel design
   (extend TEST_LLM_CONNECTION_SETUP). Majors closed: ChatInputZone.tsx
   added to B1's zone with the pb-split instruction; screenshot gates now
   carry a runnable recipe (playground:dev + sidebar select + dark-first);
   live-app shots downgraded to owner-optional; typecheck gates pinned to
   `bun run typecheck:electron` / package `typecheck` scripts;
   PluginOriginBadge.test.tsx added to A2; empty-collapse pinned to
   `empty:hidden`; C5 commit shape stated.
3. **Rules + parallelism — PASS with fixes applied.** Playground mandate
   now covered for C3 (api-key-input entry assigned to lane C and swept);
   ApiKeySubmitData optional-field constraint recorded (lane A's
   registry/onboarding.tsx is a type-only importer); NUL-byte trap bullet
   added; tracker same-commit rule spelled out above the table. Lanes
   A/B/C confirmed pairwise file-disjoint after the zone fixes.

Second series 2026-08-14 (workflow `wf_e0ad8db2-7d1`), after the plan grew
by §Adapter audit, C4-cut/C5-done/C6, the 24h-TTL merge semantics and the
final mark assignment. Anchors re-verified against the EXECUTION branch
HEAD `a30894762` (feat/models-fetch; the earlier series' pin `af13d312c`
sits on update/master, squashed here as d74050e40 — the AGENTS.md
compare-against-target trap is thereby visibly handled):

1. **Fact check — PASS.** All new anchors exact; one 3-line citation drift
   (CustomEndpointApi at llm-connections.ts:112) fixed.
2. **Autonomy — was FAIL, fixes applied.** Blocker closed: C6 rewritten
   with the pinned four-point design — the Authorization→Nestor-Token swap
   STAYS URL-keyed (a naive model-id re-key would 401 every BYO request),
   429 ladder re-keyed to an isGatewayUpstream flag, split/dialect fire
   per-request off body.model, union gate keeps gateway-wide splitting.
   Majors closed: A2's import pinned to a real mechanism (re-export via
   shared/auth/index.ts — the ./auth/nestor subpath does not exist in the
   exports map and would typecheck green yet fail Vite; helper name is
   isNestorCliBaseUrl); C2 now opens BOTH startup skip gates
   (startAll():183/:187 in addition to _doRefresh:86-89) with a
   startAll-driven test. Minors: TTL constant home, probe helper pinned
   (10s timeout, never testBackendConnection), channel-map-parity.test.ts
   name corrected, C6 typecheck command pinned verbatim.
3. **Rules + lanes — was FAIL, fixes applied.** Blocker closed: C5's stale
   pre-audit "mandatory filter" superseded in place by C1's corrected
   FILTERING block. C6's file zone completed (+ index.ts). Lane matrix
   re-verified pairwise-disjoint on HEAD (pi.svg single importer
   provider-icons.ts:19; ApiKeySubmitData type-only cross-lane import
   guarded). Tracker ✂️ glyph declared; Z1 gains the deviation-register
   no-op line; stale pi-agent-server risk bullet reworded for C6.

Addendum 2026-08-14: lane D (agent-driven install gaps) added on owner
decision after the agent-driven audit (`wf_2b80baed-a80`). Its anchors come
from that audit's skeptic pass, which re-read every load-bearing hop in the
code itself; the planner re-verified the four key lines on HEAD before
writing them in (plugin-management-tools.ts:153/:199, marketplace.ts:142,
tool-defs.ts:1167, sources.ts:38-41). Lane-D file zone checked disjoint
from A/B/C (C3's RPC file is llm-connections.ts, not marketplace/sources).

Dispatch-readiness pass 2026-08-14 (workflow `wf_78b6e1b0-eed`: lane-D fact
check + executor dry read, both against HEAD a30894762) — was NOT-READY,
all findings applied:
- Protocol blockers: Step 0 added (plan + vendored assets were untracked —
  worktree lanes would miss them; commit them alone first); branch header
  already pinned to `feat/models-fetch`.
- D1's "the proposal already knows the item" was FALSE — proposal registry
  extension + `PluginManagementMarketplaceApi` widening written in.
- D2: `CachedMarketplaceCatalogReader` lacks `findCatalogItem` — interface
  addition + helper home (`shared/src/marketplace/`, reader as parameter)
  pinned.
- D3's "never silent" promised a lever that does not exist — downgraded to
  pinned mode-dependent approval (safeMode block + normal permission gate);
  the three-op DELETE cleanup enumerated with the notify seam.
- C6 point 2 reworded: today's swap is unconditional (implicitly
  gateway-only); the task makes it explicitly URL/flag-keyed.
- C2: naive gate-opening TypeErrors at :203 (`fetcher.refreshIntervalMs` on
  undefined) — mechanism pinned (register pi_compat fetcher with
  refreshIntervalMs 0, or guard), no-timer assertion added.
- D5 park rule (owner login absent → ⏸ and proceed to Z1); D4 fixture
  builder named (`scripts/cdp/fixtures/mcp-naming.ts`); lane mechanics
  (sequential default, lane-branch naming, tracker-union merges); A2
  component-type pin + NessySymbol out-of-zone guard; decision 5 aligned
  with C2's modelsSyncedAt enrollment; stale C4/Z-ordering/heading seams
  cleaned; C3 dto "C3" label-collision warning added.
