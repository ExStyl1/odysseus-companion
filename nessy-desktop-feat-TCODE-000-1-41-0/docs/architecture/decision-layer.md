# Decision layer

Status: accepted, implemented (1.43.0, plan `docs/superpowers/plans/2026-10-14-upstream-adoption-0-15-1.md`,
Phase 6, rows UB6.1–UB6.15; spec `docs/superpowers/specs/2026-10-14-upstream-adoption-0-15-1-spec.md` §5.1 and
§6.A). Ported from craft-agents-oss v0.15.1 (Apache-2.0; the layer first shipped in v0.13.6, the providers in
v0.14.0, the cold-start floor and usage notes in v0.14.1) and adapted to three runtimes and the T-Bank network posture.

**Ship status — provisional.** This record was written from landed code before any 1.43.0 live case was driven. The
core (UB6.1–UB6.5) is on the provisional ship list with its live case, RS-128, owed to the END sitting. Each feature in
"Zero authority" below ships only if its live case passes with a decision provider the controller may use — the plan's
one rule for Phase 6 feature rows — and OQ-43.13's default (d) names no such provider. UB11.1 removes, in its own
commit, the content of everything it holds out, this record's rows included. The capability ledger states the same per
feature (section Q, rows Q5–Q15 of `docs/superpowers/specs/2026-08-28-capability-ledger.md`).

The decision model is a classifier, not a chat model. The host sends it a piece of **state** (text or JSON) and up to
64 typed **questions** — `choice` (2–255 options), `score` (an ordered rubric of 2–10 levels) or `noul` (a yes/no
probability) — over one wire, `POST {base}/v1/systemone`, and gets **probabilities** back, never prose. The guide the
agent and the user read is the shipped `apps/electron/resources/docs/decisions.md` (`DOC_REFS.decisions`).

## The pieces and where they live

| Piece | Where | Row |
| --- | --- | --- |
| The wire client | `packages/shared/src/decisions/client.ts` (`SystemOneClient`: request validation, state cap, deadline, zod-checked answers) | UB6.1 |
| Settings and resolution | `packages/shared/src/decisions/settings.ts`, `resolve.ts` (`resolveDecisionClient`, `getDecisionClient`); stored as `StoredConfig.decisionLayer` through `config/storage.ts` `getDecisionLayerSettings` / `setDecisionLayerSettings` | UB6.1 |
| The key | the `decision_api_key::{provider}` credential (`packages/shared/src/credentials/types.ts`) | UB6.1 |
| Provider presets | `packages/shared/src/decisions/providers.ts` (`DECISION_PROVIDER_PRESETS`) | UB6.2 |
| Records, usage, status, health | `packages/shared/src/decisions/records.ts`, `usage.ts` (`DECISION_RECORD_TAGS`, `readDecisionToggleUsage`), `status.ts`, `health.ts` | UB6.1, UB6.4 |
| The decision point | `packages/server-core/src/decisions/decision-point.ts` (`openDecisionPoint`, `recordDecisionOutcome`, `recordDecisionFollowUp`) | UB6.3 |
| The renderer's channels | `packages/server-core/src/handlers/rpc/decisions.ts` (eight `decisions:*` channels, `HANDLED_CHANNELS`) | UB6.3 |
| The Settings card | `apps/electron/src/renderer/pages/settings/DecisionModelCard.tsx`, `decision-model-shared.ts` | UB6.5 |
| The features | `packages/server-core/src/decisions/` — `task-verdict.ts`, `task-repairs.ts`, `turn-outcome.ts`, `semantic-labels.ts`, `automation-condition.ts`, `permission-risks.ts`, `smart-titles.ts`, `mid-turn-messages.ts`, `suggestions.ts`; the verdict rules in `packages/server-core/src/tasks/verdict-decision.ts` | UB6.6–UB6.15 |
| The `decide` tool | `packages/session-tools-core/src/handlers/decide.ts`; its host closure `packages/server-core/src/decisions/tool-callbacks.ts` (`buildDecisionToolCallbacks`) | UB6.11 |
| The usage report | `scripts/decisions-report.ts` (run it with `bun`) | UB6.4 |

## A host-only client

Native-first, recorded (the Phase 6 Native-first line): none of the three runtimes has a typed probability classifier
to enable. Claude's auto-mode classifier and codex's `auto_review` judge permission requests only; neither answers
arbitrary typed questions. So the layer is built once, in the host (native-first step 2), and **no runtime ever sees
the client**: no runtime environment, subprocess argument or tool definition carries its endpoint or its key.

Every feature reads host state (the user's message, the final reply, a task's output, the permission request the host
publishes) and acts on host state (labels, session status, the title, the message queue, the task runner, the card's
badges). A Pi, a Claude and a codex session therefore get the same behaviour from the same code.

The one surface a runtime sees is the `decide` session tool, and it reaches the model only through the host:

- **The binding.** When the host creates a session's agent (`SessionManager.getOrCreateAgentUnchecked`), it binds
  `ctx.decide` in the session-scoped tool-callback registry if the master switch and the `decideTool` toggle are both on
  (`SessionManager.decisionFeatureActive('decideTool')`, a sync local read — upstream's
  `isDecisionFeatureActive('decideTool')`). The key is not part of this check, as upstream.
- **The offer, per runtime,** derives from that one slot: Pi re-projects its session tools per turn from the registry
  (`pi-agent.ts`, `getSessionToolProxyDefs({ decidePort })`); Claude's session MCP list is filtered by
  `withHostPortGate` (`packages/shared/src/agent/session-scoped-tools.ts`); codex gets a `--decide-port` spawn flag
  beside its host-callback bridge port (`codex-agent.ts` `decisionToolConfigured`) and reaches the closure over the
  `/decide` bridge route. This is a capability condition — `SessionToolFilterOptions.decidePort`, on the
  `reviewDiffPort` precedent — and the plan's stated deviation from the inherited Session-tools rule (OQ-43.5 (a)).
- **When it changes.** The slot is bound when the agent is created, so switching the layer or the toggle on reaches a
  session whose agent already exists only once that agent is rebuilt; the card says "Applies to new sessions"
  (`settings.ai.decisions.featureDecideToolDesc`). A codex tool list is also fixed at thread start. Switching the layer
  off never needs a rebuild: every `decide` call re-resolves the client (reused for at most one second,
  `DECISION_RESOLUTION_TTL_MS`), so a session that still lists the tool gets the resolution's own failure — switched
  off, no key, no base URL — and no network call.

## The gate order

`resolveDecisionClient` (`packages/shared/src/decisions/resolve.ts`) passes four gates in this order — upstream's
order, kept as the owner's 2026-10-02 answer asks — and any failure means no client:

1. **The master switch** `decisionLayer.enabled`, set in Settings › AI › Decision model. Off by default. It is the only
   master gate: there is no environment variable, build flag or managed key. Keeping it off by default is upstream's
   user setting, not a feature gate (spec §3.4).
2. **The feature's toggle**, when the caller names one (every decision point does; the `decide` closure names
   `decideTool`).
3. **A key**, from the first source that applies: an unsaved key typed into the card (Settings › Test only); a reused
   LLM connection (`connectionSlug`, accepted only for an OpenRouter or Vercel AI Gateway connection, and then the
   connection decides the provider); the stored `decision_api_key::{provider}`. Laya and Custom do not require one.
4. **A valid endpoint**: the base URL (Custom has no default, so it needs one) plus `/v1/systemone`, which must parse as
   a URL; the model is the setting's or the preset's.

Settings › Test passes `skipGates`, which skips gates 1 and 2 only, so a provider can be tested before the layer is
switched on.

**Fail closed.** `getDecisionClient` returns `null` on any failure, and `openDecisionPoint`
(`packages/server-core/src/decisions/decision-point.ts`) returns `null` when the client does not resolve. Each call it
returns then answers `null` on a timeout, an HTTP failure, a network failure or a malformed answer (the client rejects
the body with zod). On `null`, every caller does exactly what it did before the layer existed. Changing the provider or
the connection drops the old `baseUrl` and `model` overrides (`mergeDecisionLayerSettings`), so a stale custom URL never
receives the new provider's key.

**Deadlines.** Background features wait `deadlineMs` (default 1,500 ms, clamped to 250–60,000 ms). A provider that has
not answered for 30 s gets at least 2,800 ms on the next call (the v0.14.1 cold start). A point that someone waits on —
the acknowledgement of a mid-turn message — is capped at 3,000 ms (`FOREGROUND_MAX_DEADLINE_MS`). The `decide` tool,
which the agent waits on, defaults to 10 s. The state is cut at 96 KB (48 KB for Laya) with a visible truncation marker.

**Toggle defaults** are upstream's: `decideTool`, `taskVerdicts` and `semanticLabels` on, because they act only when
invoked (an agent's call, a reply without a verdict, a label tree with a semantic rule); every feature that changes what
the app does on its own starts off. The card shows the ten adopted toggles (`buildDecisionFeatureGroups`) and usage
counts the same ten (`DECISION_RECORD_TAGS`). The stored settings shape keeps upstream's thirteen names: `guardedMode`,
`adaptiveThinking` and `largeResults` have no reader and no switch in this tree, so a `true` stored under one of them
changes nothing.

## Zero authority

An answer is advice. It can add information, add friction, or choose between two behaviours the app already had. It
never turns a prompt or a refusal into an allow and never runs anything, and with no answer the app does exactly what
it did without the layer. This is upstream's invariant, kept verbatim, and the one upstream feature whose answer reached the
permission path — the Guarded permission mode, which turned risky calls into prompts — is not ported (OQ-43.4 (a):
`auto` already fills that slot with each runtime's own judge; see `guardian-command-judge.md`).

What each feature sends, what an answer can change, and what happens with no answer:

| Feature (toggle, default) | State sent to the provider | What an answer can change | Off, or no answer | Row |
| --- | --- | --- | --- | --- |
| `decide` tool (`decideTool`, on) | whatever the agent chooses: one state, or up to 200 items, with up to 20 questions | the agent's next step, through a read-only tool result | the tool is not offered, or the call returns the failure | UB6.11 |
| Task verdicts (`taskVerdicts`, on) | the verify reply that carries no `VERDICT:` line (up to 8,000 characters) | the reply is read as PASS or FAIL at confidence ≥ 0.8 and probability ≥ 0.7, shown as "inferred (n %)"; a parseable `VERDICT:` line always wins | the runner re-asks, as before (`MAX_UNPARSED_REASKS`) | UB6.6 |
| Repair scoping (`taskRepairs`, off) | a FAIL reason that names no node (up to 4,000 characters) and each subtask's description (up to 300, at most 64 subtasks) | only the implicated subtasks (≥ 0.7) and their dependents are repaired | the whole frontier is repaired | UB6.6 |
| Node outcome (`turnOutcome`, off) | the request (first 800 characters) and the reply (last 3,000) | a child node that stalled stays running, with its reason shown | today's completion rule | UB6.7 |
| Session outcome (`turnOutcome`, off) | the same | an open chat session moves to Needs Review, marked "set by the decision model" with the outcome and probability; a closed or user-set status is never changed | nothing moves | UB6.15 |
| Semantic labels (`semanticLabels`, on) | every user message in a workspace whose label tree has a semantic rule the session does not already satisfy | the rule's label is applied at or above its threshold (default 0.9); a `LabelAdd` automation may then fire | regex rules only | UB6.8 |
| Automation condition (`automationConditions`, off) | the event, its payload, and the last user and assistant messages (up to 1,500 characters each) — asked only after the deterministic conditions pass | a run whose yes-probability is below its threshold (default 0.5) is skipped, with a "skipped" history entry showing the probability | the run happens | UB6.9 |
| Risk badges (`riskBadges`, off) | the tool name, the card's description and the command (up to 4,000 characters) | badges and the danger tone on the card; the buttons and the outcome are unchanged | no badge slot | UB6.10 |
| Smart titles (`smartTitles`, off) | a first message of at most 200 characters; or the current title and the last three user messages (up to 400 characters each) | small talk gets no AI title yet; an automatic title that no longer fits is refreshed; a title the user set is never touched | titles are generated as before | UB6.12 |
| Mid-turn messages (`midTurnMessages`, off) | the request being worked on and the new message (up to 1,500 characters each); two queued messages for the continuation check | one message is steered or queued (confidence ≥ 0.7); a continuation merges with the message queued before it (≥ 0.75) | the connection's `midStreamBehavior` | UB6.13 |
| Source suggestions (`suggestions`, off) | the user message (up to 2,000 characters) and the names and descriptions of up to 60 inactive sources | a one-turn hint names a source; nothing is activated | no hint | UB6.14 |

Two of these sit next to a permission or a delivery decision, and each was checked:

- **Risk badges.** A card waits for its badges, bounded by the background deadline. If the request was answered, the
  session stopped or deleted, or the agent rebuilt while the badges were computed, the card is dropped and the agent's
  request is **denied** (`SessionManager.handleAgentPermissionRequest`). The only outcome the layer can produce here is
  a refusal of a card nobody can answer any more — never an allow. Admin approval cards get no badges. On codex, a
  `GuardianApprovalReview`'s native `riskLevel` is shown on the auto-review line with its source; an ordinary
  default-mode codex card goes through the host classifier like Pi's and Claude's.
- **Mid-turn messages.** The answer only picks between the two delivery paths the app already has, and whether a turn
  was interrupted still comes from the runtime. The steer happens only while the message is still queued, in the same
  session and run, with no Stop since and the runtime able to take it (`canSteerNow`).

No suggestion is asked for a hidden message, a slash command, a message that names a skill or source, or the re-send
that follows a source activation (`wantsSuggestion`).

## Records: what the layer did, never what it saw

Every call appends one JSON line to `CONFIG_DIR/logs/decisions.jsonl` (`records.ts`). The line carries the feature
tag, the provider, the pinned model and the model the provider reported, the question keys and types, the
probabilities, the latency and usage, the failure kind, `coldStart`, and the state's **sha256 and byte count — never the
state text**. A failure is recorded without the provider's own text, because a validating gateway may echo the state in
its error body; caller metadata is redacted by key name. Appends are fire-and-forget: a failed write never fails the
call.

The same file holds outcome lines (what the point did with the answer, including "changed nothing") and follow-up lines
(what came of it later, such as whether a suggested source was used), keyed by the decision's id. Past 10 MiB the log
rotates to `decisions.prev.jsonl`, keeping one previous file. Settings shows each toggle's checks, changes and failures
over the last seven days (`decisions:getUsage`) and adds "has not changed anything" once a feature has had 30 answered
checks with no change. `scripts/decisions-report.ts` prints the same per feature, with the cold-start failures and the
follow-ups.

## The provider posture

| Preset | Base URL | Default model | Key | Where the state goes |
| --- | --- | --- | --- | --- |
| TypeSafe AI (direct) | `https://api.typesafe.ai` | `jev-1.13.0` | required | a hosted third party |
| OpenRouter | `https://openrouter.ai/api` | `typesafe/jev-1.13` | required; an OpenRouter connection's key may be reused | hosted, through OpenRouter |
| Vercel AI Gateway | `https://ai-gateway.vercel.sh/typesafe` | `typesafe-ai/jev` (an alias; the served model is recorded) | required; a Vercel AI Gateway connection's key may be reused | hosted, through Vercel |
| Laya (local, open source) | `http://127.0.0.1:8000` | `auto` | optional | loopback: the user's own machine |
| Custom (Jev-compatible server) | the user's URL | `jev-1.13.0` | optional | the URL the user enters |

- **The decision behind the presets.** The T-Bank posture (spec §3.5) adds no third party that receives session content
  without an owner decision. The owner made it for this layer on 2026-10-02 (OQ-43.2 and OQ-43.2b): «я предлагаю
  сделать идентично как в craft agents, то есть если есть ключ то используем а если нет то не используется фича» ("I
  propose doing it identically to craft agents: if there is a key we use it, if not the feature is not used"). All five
  presets therefore ship as upstream has them, Laya's install hint (`pip install "laya[serve]" && laya-serve`) and its
  docs link included.
- **When session content leaves the machine.** Only after the user switches the layer on AND either a hosted preset
  resolves a key or Custom points at a remote URL. The default provider id is TypeSafe (upstream's default); with no
  key it resolves nothing. Laya, and a Custom server on loopback, keep the state on the machine.
- **Our changes to the presets:** OpenRouter's `X-Title: Craft Agents` attribution header is dropped (the rebrand rule).
  Model ids are pinned per preset, never `jev-latest`, so a silent model change cannot move decisions; the model the
  provider reports is recorded beside the pinned one.
- **`Nestor-Token` never reaches a decision endpoint.** The client authenticates with `Authorization: Bearer` only, and
  with no auth header at all when no key is configured (pinned by `packages/shared/src/decisions/resolve.test.ts`,
  "posture (SEC-8)", and `client.test.ts`). The host's one seam that turns a Bearer into `Nestor-Token`,
  `rewriteNestorAuthHeaders` in `packages/shared/src/unified-network-interceptor.ts`, rewrites only the URLs
  `isNestorGatewayCredentialUrl` names, so a decision request is left alone even where that interceptor is preloaded
  (the Pi subprocess and the headless server process).
- **No Nessy Gateway preset.** The gateway serves chat completions, not this wire. A gateway preset waits until the
  gateway team publishes a route with its contract (UB6.18, blocked); emulating the wire over chat completions was
  rejected as invented (no calibrated probabilities, seconds of latency against the 3 s cap; spec §5.1).
- **Proxy.** The client uses the host's global `fetch`; in the Electron main process that already goes through the
  user's proxy (`apps/electron/src/main/network-proxy.ts`).
- **Laya's licence** — the package and all three checkpoints `laya-serve` loads — read Apache-2.0 on 2026-10-15 (the
  UB6.2 premise, recorded in the header of `providers.ts`). Whether the controller may install Laya for the live cases
  is a separate supply-chain question, OQ-43.13; its default (d) says no, which is why the feature cases still owe a
  provider.

## SEC-8: only a local window chooses where state and keys go

Upstream marks every decision channel remote-eligible, so a remote client could repoint the classifier that receives
user messages, tool arguments and card text (spec §4, SEC-8). Ours keeps all eight channels `REMOTE_ELIGIBLE` in
`packages/shared/src/protocol/routing.ts`, so a remote client may read everything, and puts the refusal in the handler
(`assertLocalClient` in `packages/server-core/src/handlers/rpc/decisions.ts`, error
`decision-provider-change-local-only`):

- `decisions:setSettings` with `provider`, `baseUrl` or `connectionSlug` in the patch;
- `decisions:setApiKey` and `decisions:deleteApiKey`;
- `decisions:test` with an endpoint patch or an unsaved key, and `decisions:probeServer` with a `baseUrl` override —
  an extension beyond the three channels the row named, because each lets a client hand the server a URL or key
  material (logged in the plan's Extensions log, 2026-10-15).

**Local means a known Electron window:** the request's `webContentsId` resolves through the window manager, the shape
`isLocalElectronOwner` uses for the dp login. That is stricter than the capability-set locality behind the remote
permission-mode ceiling (`transport-locality.md`): an `apps/cli` client on the same machine and every client of the
headless server count as non-local here. The narrower test was chosen because the question is where session content
and key material go, and it errs toward refusing.

A non-local client may still change `enabled`, the feature toggles, `model` and `deadlineMs`. It can switch the layer
on toward the destination a local user already chose; it cannot choose the destination or supply a key. Stated because
switching on is what starts the traffic.

**Residue:** a headless server has no window, so its provider, URL, connection and key cannot be set over RPC at all;
its operator edits `decisionLayer` in that server's `config.json`.

Pins: `packages/server-core/src/handlers/rpc/__tests__/decision-lifecycle.test.ts` (a local client sets Laya and its
test reaches the wire; a remote client's provider, URL, connection and key changes are refused while its reads and
non-endpoint patches pass; the headless shape is non-local; a foreground decision past the 3 s cap resolves `null` and
the caller proceeds).

## What is not here

- **Guarded permission mode** — not ported (OQ-43.4 (a)); `auto` covers the slot on all three runtimes.
- **Adaptive thinking** — not ported (spec DEC-10): Claude already has the runtime's own adaptive thinking, and whether
  gateway models honour a lowered effort is unmeasured.
- **Skill suggestions** — not ported: skills are already listed on every runtime; suggestions cover inactive sources
  only.
- **The large-result relevance filter** (UB6.16) — not built. It waits on UB5.6's measurement at the END sitting; until
  then it has no toggle and no record tag, and `decision-model-card.test.tsx` asserts the card shows none.
- **A Nessy Gateway preset** — UB6.18, blocked on the gateway team (above).

## Where the evidence is

- The gate order and fail-closed: `packages/shared/src/decisions/resolve.test.ts` (switch off, no key, Bearer only),
  `packages/shared/src/decisions/client.test.ts` (timeout, HTTP status, network failure and malformed body each become
  a failure; the key and provider text never reach a recorded failure), `packages/server-core/src/decisions/decision-point.test.ts`
  (the cold-start floor, the point's cap, a failed call not counted as warm).
- Records: `packages/shared/src/decisions/records.test.ts` (never the state; failures without provider detail; one
  rotated file), `packages/shared/src/decisions/usage.test.ts`.
- The stored key: `packages/shared/src/config/__tests__/decision-layer-stored-key.test.ts`.
- SEC-8: `packages/server-core/src/handlers/rpc/__tests__/decision-lifecycle.test.ts`.
- The `decide` offer and its closure: `packages/session-tools-core/src/tool-defs-filtering.test.ts`,
  `packages/session-tools-core/src/handlers/decide.test.ts`, `packages/server-core/src/decisions/tool-callbacks.test.ts`.
- Each feature: the `.test.ts` beside its module in `packages/server-core/src/decisions/`, plus
  `packages/server-core/src/tasks/verdict-decision.test.ts` and the card's
  `apps/electron/src/renderer/pages/settings/__tests__/decision-model-card.test.tsx`.
- Live: the core case RS-128 (`scripts/cdp/cases/rs-128.ts`, UB6.17: the honest not-configured card) is owed to the
  END sitting; the feature cases owe a provider (OQ-43.13).
