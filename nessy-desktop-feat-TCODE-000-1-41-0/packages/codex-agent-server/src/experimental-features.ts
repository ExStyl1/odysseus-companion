/**
 * P6.455 — codex publishes its own feature STAGES over the app-server we
 * already speak, and until this file we had never sent the method outside one
 * live test.
 *
 * ## What was missing, precisely
 *
 * `experimentalFeature/list` is in the shipped `ClientRequest` enumeration
 * (`packages/codex-protocol/generated/ClientRequest.ts`) and answers, per
 * feature, with a `stage` drawn from
 * `packages/codex-protocol/generated/v2/ExperimentalFeatureStage.ts`:
 * `"beta" | "underDevelopment" | "stable" | "deprecated" | "removed"`. At HEAD
 * the method had **no production call site** — `git grep -a experimentalFeature`
 * found the generated enum, five comments recording one-off measurements
 * (`server-warning.ts`, `config-writer.ts` ×3) and ONE live test
 * (`__tests__/server-warning-live.test.ts`). Every stage figure this repo
 * reasons from was therefore a COMMENT written on a day someone happened to
 * probe, not a runtime fact — including the "114 features" reading behind
 * P3.347's `max_threads` decision.
 *
 * That matters because two `[features]` keys our own config writer sets are
 * load-bearing, and their stages are the thing that can move under us:
 * `multi_agent` (codex's model-driven multi-agent tools) and `view_image` (the
 * one image-capable tool on codex, which P3.54's cross-runtime image handover
 * rests on). A release moving either to `deprecated` or `removed` breaks those
 * with **nothing failing** — the key stays schema-valid, the write still
 * succeeds, the capability simply stops existing.
 *
 * ## `stage`, and NEVER `enabled` — this is the whole reading rule
 *
 * `ExperimentalFeature` carries `enabled: boolean` beside `stage`, and it is a
 * trap. P2.374 measured a `Stage::Removed` key still reporting
 * `enabled: true`, and a bogus key yielding *"no error, no warning, no stderr
 * line"*. So `enabled` answers "did the config parse set this flag", which is
 * true of a flag that does nothing; `stage` answers "does the feature behind it
 * exist". {@link readCodexFeatureStages} reads `name` and `stage` and drops
 * every other field on purpose, so no later caller can reach for the wrong one.
 *
 * ## MEASURED on the pinned binary, 2026-09-05, with its controls
 *
 * `apps/electron/resources/bin/codex/darwin-arm64/codex-app-server`, driven
 * through the real `CodexRuntimeManager` + `AppServerClient` against a scratch
 * `CODEX_HOME` written by the real `writeCodexConfig`, load average 16.5. The
 * numbers below are that reading, taken on the tag shipped then; re-driven at
 * `rust-v0.150.1` on 2026-09-11 the SHAPE is unchanged — one page,
 * `nextCursor: null`, five stages — and every count moved: **124 entries**, with
 * `stable` 40, `underDevelopment` 44, `removed` 35, `deprecated` 3, `beta` 2.
 *
 * | Reading | Value |
 * | --- | --- |
 * | `experimentalFeature/list` with **no params** | **114 entries in ONE page, `nextCursor: null`** |
 * | stage histogram | `stable` 36, `underDevelopment` 40, `removed` 33, `deprecated` 3, `beta` 2 (= 114) |
 * | `multi_agent` | `stable` |
 * | `view_image` | `stable` |
 * | same call with `limit: 5` | 20 pages of 5, `nextCursor` a numeric-offset string (`"5"`, `"10"`, …) |
 *
 * Re-run independently later the same day at load average 9.3 (P6.266's rig,
 * which drives the same binary): every figure identical — 114 in one page, the
 * same histogram, both depended features `stable`, 20 pages of 5 under `limit`.
 *
 * The last row is why {@link CodexFeatureStageReading} carries `partial` at all.
 * One call answers completely on THIS binary because we send no `limit` and its
 * server-side default covers 114 — but `ExperimentalFeatureListParams` documents
 * that default as *"a reasonable server-side value"*, so a binary with more
 * features than its own page size would answer partially, with no error. A
 * reader that treated a short page as the whole set would then report a feature
 * we depend on as GONE the day codex merely grew. `partial` makes that
 * distinguishable: a missing name is only reported as missing when the page was
 * complete.
 *
 * ## Cost, and why this is configuration rather than construction
 *
 * One request between `initialized` and `thread/start`. Pi and claude publish no
 * feature-stage surface at all, so there is nothing to unify at the host level;
 * the native mechanism exists on exactly one runtime and this file enables it.
 */

/**
 * The method name, verbatim from the shipped `ClientRequest` enumeration.
 *
 * `packages/codex-protocol/generated/ClientRequest.ts` carries
 * `{ "method": "experimentalFeature/list", … }`; the sibling
 * `experimentalFeature/enablement/set` is deliberately NOT spelled here — this
 * row reads stages, it does not flip features, and a constant for the setter
 * would be an invitation.
 */
export const CODEX_EXPERIMENTAL_FEATURE_LIST_METHOD = 'experimentalFeature/list';

/**
 * The five stages codex publishes, re-confirmed at `rust-v0.150.1`.
 *
 * Declared locally rather than imported: `packages/codex-protocol`'s own
 * package description states that *nothing imports `generated/*.ts` as a
 * module, and `generated/` is in no typecheck program*, so an import here would
 * be typechecked by nobody. `experimental-features.test.ts` ties this array to
 * the generated file's source text instead, which is the drift guard that
 * actually runs.
 *
 * A stage OUTSIDE this set is not an error — {@link readCodexFeatureStages}
 * keeps whatever string arrived. A future binary adding a sixth stage must not
 * make this reader blind to the five it does know.
 */
export const CODEX_FEATURE_STAGES = [
  'beta',
  'underDevelopment',
  'stable',
  'deprecated',
  'removed',
] as const;

export type CodexFeatureStage = (typeof CODEX_FEATURE_STAGES)[number];

/**
 * The `[features]` keys THIS product's codex config sets to `true`, and whose
 * disappearance would therefore be silent.
 *
 * Read off `packages/codex-responses-adapter/src/config-writer.ts`'s
 * `[features]` block. Every one of these is `stable` on the pinned binary —
 * `multi_agent` and `view_image` measured 2026-09-05, and P6.533's six measured
 * 2026-09-06 in the same one-page 114-entry answer, all
 * `{stage:"stable", enabled:true, defaultEnabled:true}`.
 *
 * `goals` is deliberately ABSENT: the writer sets it `false`, so it is refused
 * rather than depended on, and a notice saying "the feature you turn on is going
 * away" would be false about it.
 *
 * P6.726 · `apps` and `remote_plugin` LEFT this list on 2026-09-07 for exactly
 * that reason and not because the keys went away — the owner answered P6.533 by
 * turning both off (ChatGPT connectors and the PS-backed remote catalog are
 * unreachable through this product's gateway; the reason is written at each key
 * in `config-writer.ts`). They are now refused, so their disappearance from a
 * future binary costs us nothing and must not be announced as a loss.
 *
 * Kept as a default rather than the only possible input so the notice can be
 * asked about a different set without editing this file — and so the writer's
 * block and this list can be tied together by a test rather than by hope.
 * `experimental-features.test.ts` asserts the EQUALITY, so a key added to that
 * block without a name here fails rather than becoming silently undepended.
 */
export const CODEX_DEPENDED_FEATURES: readonly string[] = [
  'multi_agent',
  'view_image',
  // P6.533 · the stable user-facing subset, each with its reason at the writer's
  // own emit site — FOUR since P6.726 turned `apps` and `remote_plugin` off, plus
  // `write_stdin_approval`, stable and default-on since `rust-v0.159.3` (F1.1215).
  'hooks',
  'unified_exec',
  'shell_snapshot',
  'fast_mode',
  'write_stdin_approval',
];

/**
 * P6.266 — the `[features]` keys this product REFUSES by name, with the
 * measurement behind each refusal.
 *
 * The precedent is P3.306 (`4eac7ac8f`): a codex key we decline is recorded
 * where someone would otherwise add it, so the next reader meets the reason
 * rather than the silence. `experimental-features.test.ts` ties this list to
 * `config-writer.ts`'s emitted `[features]` block, so a later commit adding one
 * of these names fails a test rather than passing unnoticed.
 *
 * ## `context_management` — REFUSED, and the row's own premise is refuted
 *
 * Denominator E11 said codex *"ships an experimental context-management key"*,
 * sourced from `learn.chatgpt.com/docs/models.md#experimental-context-management`
 * and marked **weak** by this repo's own codex evidence tier — page-only intent,
 * with no source read at the tag then pinned. Driven against the pinned darwin-arm64
 * `codex-app-server` on 2026-09-05 (real `CodexRuntimeManager` + `AppServerClient`,
 * scratch `CODEX_HOME` written by the real `writeCodexConfig`, our synthetic API
 * key, load average 9.3), the binary disagrees with the page in three ways:
 *
 * | Arm | Result |
 * | --- | --- |
 * | `[features.context_management] experimental_mode = true` — the page's exact shape | **the WHOLE config is refused**: `failed to load configuration: config.toml:23:1: invalid type: map, expected a boolean` |
 * | `context_management = true` inside `[features]` | accepted; no `warning`, no `configWarning`, no stderr line |
 * | top-level `[context_management] experimental_mode = true` | accepted; nothing said |
 * | `experimentalFeature/list` (114 features) | **`context_management` is not among them** — no name contains "context" |
 *
 * Two controls make those readings mean something. A bogus boolean
 * (`zzz_nessy_not_a_real_feature = true`) is ALSO accepted in silence, so the
 * second arm's silence is indistinguishable from a key that does not exist —
 * P2.374's *"no error, no warning, no stderr line"*, reproduced. And a real
 * under-development key (`executed_tool_call_metadata = true`) DOES raise a
 * `warning` naming itself, which `server-warning.ts` classifies — so the rig can
 * see a warning when there is one, and the absence above is real rather than a
 * blind harness.
 *
 * So the honest verdict is not *"adopt this experiment"* but **the key does not
 * exist on the binary we ship**: the documented table form is a boot-fatal config
 * error, and the flat form is inert. Writing it would be worse than useless —
 * a config that fails to load is not an ignored key, it is a session that does
 * not start. The page's own disqualifier points the same way (*"isn't available
 * with Business, Enterprise, or API-key sign-in at launch"*), and we authenticate
 * with a synthetic API key.
 *
 * Should codex later ship it, the mechanism to reach for is the runtime pair
 * (`experimentalFeature/list` + `experimentalFeature/enablement/set`), not the
 * config file — the stage this module already reads is what would say it arrived.
 */
export const CODEX_REFUSED_FEATURES: readonly string[] = [
  'context_management',
  // P6.507 · the two token-budget keys, refused BY NAME at this tag. See the
  // block below for the measurement and the exit condition.
  'token_budget',
  'rollout_budget',
];

/**
 * P6.507 — codex's THREE token-budget mechanisms, and why none is adoptable at
 * `rust-v0.150.1`.
 *
 * The row's premise is that codex is the one runtime that can honour a token
 * budget and we do not express it. Measured, the first half is true and the
 * second is a DECISION rather than an oversight. All three, read from the source
 * at the tag `packages/codex-protocol/manifest.json` pins and confirmed against
 * the shipped `darwin-arm64/codex-app-server` on 2026-09-06 (load average 9.19,
 * 114 features in one page, negative control `zzz_nessy_not_a_real_feature` NOT
 * LISTED):
 *
 * | mechanism | what it does | stage on the shipped binary |
 * | --- | --- | --- |
 * | `[features.token_budget]` | `Feature::TokenBudget`, *"Add current context-window metadata to model-visible context"* — `core/src/session/token_budget.rs` records a `TokenBudgetReminder` fragment once the remaining window crosses `reminder_threshold_tokens` | `underDevelopment`, `defaultEnabled: false`, `enabled: false` |
 * | `[features.rollout_budget]` | `core/src/rollout_budget.rs` — weighted-token accounting across the WHOLE root-thread session tree, a `RolloutBudgetContext { remaining_tokens }` fragment at each crossed threshold, and `CodexErr::SessionBudgetExceeded` when `limit_tokens` is reached. This is the pacing budget the row is asking for | `underDevelopment`, `defaultEnabled: false`, `enabled: false` |
 * | `[goals] max_goal_token_budget` | *"Maximum token budget allowed for a goal and default budget for new goals"* (`GoalsToml`) | `Stage::Stable` — **but it belongs to codex's own goal engine, which THIS PRODUCT TURNS OFF**: `goals = false`, owner decision Q20 / P6.487 |
 *
 * ## Why the two under-development keys are refused rather than written
 *
 * The same posture P6.99 records for `retain_client_developer_messages`, and it
 * applies harder here. `Stage::UnderDevelopment` is codex's own words for
 * *"still under development, not ready for external use"*; enabling any such key
 * emits a per-session `EventMsg::Warning` that reaches the client as
 * `ServerNotification::Warning` (P2.384's measurement), so every session of a
 * shipped product would carry it. And `rollout_budget` adds a failure mode the
 * others do not have: `core/src/config/mod.rs`'s `resolve_rollout_budget_config`
 * REJECTS the configuration outright when the feature is enabled without
 * `limit_tokens` or without `reminder_at_remaining_tokens`
 * (*"features.rollout_budget.limit_tokens is required when rollout_budget is
 * enabled"*), and a rejected configuration is not an ignored key — it is a
 * session that does not start.
 *
 * ## What this does NOT settle
 *
 * Owner-delegated Q-den 30 = option A: keep the USD cap where a price exists and
 * ADD a token budget every runtime can honour. That decision is about the
 * DENOMINATION. This entry answers only *"is codex's own flag the mechanism"* —
 * at this tag, no — and a host-side budget fed by the token usage all three
 * runtimes already report is untouched by it.
 *
 * ## EXIT CONDITION, so this is a decision and not a dead end
 *
 * The day either key's stage moves off `underDevelopment` at the tag we ship,
 * revisit: `rollout_budget` is the right shape for a task that must pace itself,
 * and the only objections recorded here are readiness and the boot-fatal
 * required sub-keys. RE-CHECKED at the `rust-v0.159.3` lift (F1.1215): both
 * still `underDevelopment`, so the refusal stood across a fourth lift. RE-CHECKED
 * again at the `rust-v0.162.0` lift (UA12.211, 2026-10-10), which is what moving
 * this constant is for rather than a re-label: `token_budget` and
 * `rollout_budget` are both still `underDevelopment`, `enabled: false`,
 * `defaultEnabled: false` on the wire (re-driven 2026-10-10 on the shipped
 * binary, 167 features reported in one page), so the exit condition is not met
 * and the refusal stands across a fifth lift. {@link readCodexFeatureStages} is
 * what would say it arrived, and `experimental-features.test.ts` fails the day
 * one of these names appears in the writer's `[features]` block without this
 * entry being revisited.
 */
export const CODEX_TOKEN_BUDGET_REFUSAL_TAG = 'rust-v0.162.0';

/** What one `experimentalFeature/list` answer told us. */
export interface CodexFeatureStageReading {
  /** Feature name -> the `stage` string codex reported, verbatim. */
  stages: Map<string, string>;
  /**
   * `true` when the answer carried a `nextCursor`, i.e. this is one page of
   * several and an absent name proves nothing.
   */
  partial: boolean;
  /** How many entries were read. `0` with `partial: false` means "it answered nothing". */
  count: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

/**
 * Read one `experimentalFeature/list` result into name -> stage.
 *
 * Structurally no-throw on every shape: this runs on the spawn critical path,
 * where a throw would take the session down over a question nobody asked. A
 * result that is null, the wrong type, missing `data`, or carrying entries with
 * no usable `name`/`stage` degrades to an EMPTY reading — which the callers
 * below treat as "no answer", never as "the feature is gone".
 */
export function readCodexFeatureStages(result: unknown): CodexFeatureStageReading {
  const root = asRecord(result);
  const data = root?.data;
  const stages = new Map<string, string>();
  const entries = Array.isArray(data) ? data : [];
  for (const entry of entries) {
    const row = asRecord(entry);
    const name = row?.name;
    const stage = row?.stage;
    if (typeof name !== 'string' || !name) continue;
    if (typeof stage !== 'string' || !stage) continue;
    stages.set(name, stage);
  }
  const cursor = root?.nextCursor;
  return {
    stages,
    partial: typeof cursor === 'string' && cursor.length > 0,
    count: stages.size,
  };
}

/** Most names anyone would put in one line; a longer list is truncated, not dropped. */
const MAX_NAMED_FEATURES = 12;

function joinNames(names: string[]): string {
  const head = names.slice(0, MAX_NAMED_FEATURES).join(', ');
  return names.length > MAX_NAMED_FEATURES ? `${head}, …` : head;
}

/**
 * One durable session-fact line: what codex says about the features we set.
 *
 * A standing property of the session rather than a log line — the same shape
 * `CodexAgent.recordSessionFact` exists for, so a user asking the diagnostics
 * accessor on turn sixty gets the same answer as one who asked on turn one.
 *
 * Returns `null` when there is nothing to state (no answer at all), so a codex
 * build that does not implement the method leaves no misleading sentence
 * behind.
 */
export function codexFeatureStageSessionFact(
  reading: CodexFeatureStageReading,
  depended: readonly string[] = CODEX_DEPENDED_FEATURES,
): string | null {
  if (reading.count === 0) return null;
  const known = depended
    .map(name => `${name}=${reading.stages.get(name) ?? 'not listed'}`)
    .join(', ');
  const page = reading.partial ? ' (one page of several — an unlisted name proves nothing)' : '';
  return `codex feature stages: ${reading.count} features reported${page}; `
    + `the keys this product sets — ${known}.`;
}

/**
 * The operator notice, or `null` when there is nothing to say.
 *
 * Fires on exactly two conditions, and the second is gated on the page being
 * complete:
 *
 *  - a depended feature whose stage is `deprecated` or `removed` — codex's own
 *    words for "going away" and "the flag is useless but kept for backward
 *    compatibility reason";
 *  - a depended feature codex did not list at all, which is the RENAME case, and
 *    is reported only when `partial` is false.
 *
 * `beta` and `underDevelopment` do NOT fire. A depended key at either of those
 * would be a posture question rather than a degradation, and codex already
 * announces under-development features on its own `warning` channel, which
 * `server-warning.ts` classifies — a second sentence for the same fact is how a
 * notice channel becomes noise.
 */
export function codexDependedFeatureStageNotice(
  reading: CodexFeatureStageReading,
  depended: readonly string[] = CODEX_DEPENDED_FEATURES,
): string | null {
  if (reading.count === 0) return null;
  const retiring: string[] = [];
  const unlisted: string[] = [];
  for (const name of depended) {
    const stage = reading.stages.get(name);
    if (stage === undefined) {
      if (!reading.partial) unlisted.push(name);
      continue;
    }
    if (stage === 'deprecated' || stage === 'removed') retiring.push(`${name} (${stage})`);
  }
  if (retiring.length === 0 && unlisted.length === 0) return null;
  const parts: string[] = [];
  if (retiring.length > 0) {
    parts.push(`codex now stages ${joinNames(retiring)} as going away`);
  }
  if (unlisted.length > 0) {
    parts.push(`codex no longer lists ${joinNames(unlisted)} at all`);
  }
  return `Codex: this session turns on features whose support is changing — ${parts.join('; ')}. `
    + 'They are still written into the config and still accepted, so nothing here will fail; '
    + 'the capability behind them may simply stop working.';
}
