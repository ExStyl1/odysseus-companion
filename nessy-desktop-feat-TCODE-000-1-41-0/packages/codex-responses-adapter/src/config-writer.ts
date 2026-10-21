/**
 * Writes a managed `CODEX_HOME/config.toml` that points the codex app-server at
 * our local Responses adapter as a custom model provider.
 *
 * The provider key is `nessy_gateway` (00-context addendum 11) — a
 * Codex-INTERNAL provider name, distinct from the Nessy `providerType`
 * `codex-runtime`. `wire_api = "responses"` makes codex speak the Responses API
 * to `base_url`; our adapter (real, Phase 2) translates that to Nestor chat.
 *
 * Ownership (addendum 4): the caller (CodexAgent / spike) picks the ephemeral
 * adapter port and passes it here; this writer never picks a port.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { tomlString } from './config-writer-toml.ts';
// P3.273 · the `[permissions.*]` floor, mapping and emission, in a file of its
// own — see that module's header for why a SECTION of a file is not a zone.
import {
  buildCodexPermissionsOverride,
  buildCodexPermissionsTomlLines,
  buildCodexProjectDocTomlLines,
  CLAUDE_SETTINGS_CODEX_PROJECTION,
  CLAUDE_SETTINGS_UNREAD_BY_HOST,
  classifyClaudeSettingsFamilyKey,
  formatCodexClaudeSettingsProjectionDiagnostics,
  formatCodexCredentialFloorShellDiagnostics, formatCodexDenyReadDiscoveryCostDiagnostics, // F1.1027
  formatCodexDeniedPathDiagnostics,
  formatCodexInstructionExcludeDiagnostics,
  formatCodexProtectedPathFloorDiagnostics,
  hasCodexFilesystemPolicy,
  hasCodexRuntimePathPolicy,
  mapDeniedPathsToCodexFilesystemKeys,
  NESSY_RUNTIME_PERMISSION_PROFILE,
  resolveCodexRuntimePathPolicy,
  resolveDeniedPatternMapping,
  type CodexDeniedPatternMapping,
  type CodexDeniedPatternRejection,
  type CodexDeniedPatternRejectionReason,
  type ClaudeSettingsCodexProjection,
  type ClaudeSettingsCodexVerdict,
  type CodexRuntimePathPolicy,
} from './config-writer-permissions.ts';

// Re-exported so `./config-writer` keeps the exact surface it had before the
// move: the three functions are imported from here by
// `config-writer-denied-path-mirror.test.ts` (all three) and
// `sandbox-enforcement.test.ts` (the mapper), and the three types had no
// importer at all — kept anyway, because dropping an export from a package
// entry point is a contract change and this row is a file move.
// `NESSY_RUNTIME_PERMISSION_PROFILE` is deliberately NOT re-exported: it was
// private before and stays private.
export {
  // P6.167 — the per-family projection table and its two readers, on the same
  // entry point as the four diagnostics beside it, because `CodexAgent` is the
  // only consumer and it imports from `./config-writer`.
  CLAUDE_SETTINGS_CODEX_PROJECTION,
  CLAUDE_SETTINGS_UNREAD_BY_HOST,
  classifyClaudeSettingsFamilyKey,
  formatCodexClaudeSettingsProjectionDiagnostics,
  formatCodexCredentialFloorShellDiagnostics,
  formatCodexDeniedPathDiagnostics,
  formatCodexInstructionExcludeDiagnostics,
  formatCodexProtectedPathFloorDiagnostics,
  mapDeniedPathsToCodexFilesystemKeys,
};
export type {
  ClaudeSettingsCodexProjection,
  ClaudeSettingsCodexVerdict,
  CodexDeniedPatternMapping,
  CodexDeniedPatternRejection,
  CodexDeniedPatternRejectionReason,
};

export const CODEX_PROVIDER_KEY = 'nessy_gateway';
/** Env var codex reads for the provider API key (see config `env_key`). */
export const CODEX_API_KEY_ENV = 'COMPANY_LLM_API_KEY';
export const CODEX_POOL_MCP_TOKEN_ENV = 'NESSY_CODEX_MCP_POOL_TOKEN';

export interface CodexConfigOptions {
  /** Managed CODEX_HOME directory (config.toml is written here). */
  codexHome: string;
  /** Model id passed through to the provider, e.g. `tgpt/qwen35-397b-a17b-fp8`. */
  model: string;
  /** Nessy thinking level mapped to codex `model_reasoning_effort`. */
  thinkingLevel?: CodexThinkingLevel;
  /**
   * P6.368 — codex's own `plan_mode_reasoning_effort`, for a session that should
   * think HARDER while it is planning than while it is executing.
   *
   * The key is codex's, top-level in the release `config-schema.json` (and again
   * under `ConfigProfile`), typed `ReasoningEffort` — and it was written by
   * nothing: `git grep -a plan_mode_reasoning_effort -- packages` found only the
   * two schema occurrences.
   *
   * ## Where the value comes from, and why it has no documented name
   *
   * READ-DO-NOT-INVENT was applied and came back EMPTY on the claude side:
   * `env-vars.md` documents no plan-mode effort variable, and the shipped 2.1.247
   * binary scores 0 for `CLAUDE_CODE_PLAN_MODE_EFFORT` and 0 for
   * `PLAN_MODE_EFFORT` against the control `CLAUDE_CODE_EFFORT_LEVEL` at 10 lines
   * / 19 occurrences. Both instruments are named because on a minified artefact
   * they disagree (C3.294); re-measured 2026-09-12 (C3.252), negative control
   * `nessyNotARealSdkKey` 0/0. The superseded reading was "0 and 0 against 17"
   * at `2.1.233` with no instrument stated.
   * What claude has for plan mode is a MODEL alias (`opusplan`, 9 lines / 26
   * occurrences in the same binary; it read 35 at `2.1.233`),
   * not an effort. So there is no name to adopt and the host supplies one,
   * transparently: `NESSY_PLAN_MODE_EFFORT`, taking the same six level words every
   * other Nessy effort setting takes. No compat alias is offered, because there is
   * no documented spelling to be compatible WITH — inventing a `CLAUDE_CODE_`
   * variable would claim a contract that does not exist.
   *
   * Omitted when unset, so codex keeps its own behaviour rather than being handed
   * this session's execution effort under a second name — a no-op dressed as a
   * setting.
   *
   * The MODEL half of the same idea is STRUCTURAL here and is deliberately not
   * attempted: our loopback adapter pins ONE upstream per session, so a
   * plan-phase model switch has nowhere to land. That is a fact about our
   * transport, not a codex limit.
   */
  planModeThinkingLevel?: CodexThinkingLevel;
  /**
   * The model's synced context window → `model_context_window`.
   *
   * Omitted when the catalogue has no window for the model, so codex keeps its
   * own default rather than being handed a fabricated one — the same rule the
   * Pi and Claude sides now follow.
   *
   * **P3.286 — this key is written in BOTH switch positions, and that is the
   * fix rather than an oversight.** With it withheld codex does not fall back to
   * "no window": it falls back to 272 000 (see `autoCompactionEnabled`), which
   * is 10 000 above what the gateway publishes. The catalogue's figure is the
   * only honest number we have, and handing it over is what keeps every limit
   * codex derives inside the endpoint's real ceiling. Only
   * `model_auto_compact_token_limit` moves with the off-switch.
   */
  contextWindow?: number;
  /**
   * P3.234 + P3.286 — the host's auto-compaction policy, and the fact that
   * **codex cannot turn auto-compaction off at all**.
   *
   * ## The native-first question, asked at `rust-v0.148.0`, answered NO
   *
   * codex has **no named off-switch**, and this time the whole surface was
   * enumerated rather than grepped: `ConfigToml`
   * (`codex-rs/config/src/config_toml.rs`, the struct the whole
   * `~/.codex/config.toml` deserializes into) carries exactly three
   * window/compaction keys — `model_context_window`,
   * `model_auto_compact_token_limit`, `model_auto_compact_token_limit_scope` —
   * plus two that only choose the compaction PROMPT (`compact_prompt`,
   * `experimental_compact_prompt_file`) and the `features.token_budget`
   * fallback pair. None of them disables anything, and there is no `Feature`
   * for it either.
   *
   * ## The premise the first fix rested on was a TEST FIXTURE
   *
   * That fix withheld BOTH keys, on the reading that the fallback `ModelInfo`
   * for a slug codex does not ship carries `context_window: None`, citing
   * `protocol/src/openai_models.rs:906-908`. Those lines are inside
   * `#[cfg(test)] mod tests` (the attribute is at `openai_models.rs:871`) and
   * build a helper whose slug is literally `"test-model"`. The PRODUCTION
   * fallback is `models-manager/src/model_info.rs:139` `model_info_from_slug`,
   * and it carries `context_window: Some(272_000)`, `max_context_window:
   * Some(272_000)`, `auto_compact_token_limit: None`.
   *
   * So `ModelInfo::auto_compact_token_limit()` (`openai_models.rs:482`,
   * `min(config_limit, resolved_context_window * 9 / 10)`, falling back to the
   * 90 % term with no config key) returned `Some(244_800)` the whole time, and
   * `ContextWindowTokenStatus::token_limit_reached` was satisfiable the whole
   * time. **Withholding both keys never disabled anything; it only replaced our
   * catalogue window with a fabricated 272 000.**
   *
   * ## Measured on the shipped binary, four arms, brackets not single points
   *
   * `codex-app-server` at `rust-v0.148.0`, isolated `CODEX_HOME`, a stub
   * Responses server whose reported `usage.total_tokens` is the knob, a marker
   * string in `compact_prompt` as the compaction detector (`core/src/compact.rs`
   * puts that string on the wire verbatim), two turns per arm so
   * `run_pre_sampling_compact` sees the first turn's usage:
   *
   * | `model_context_window` | limit key | usage | reported window | compacted |
   * | --- | --- | --- | --- | --- |
   * | withheld | withheld | 240 000 | 258 400 | no |
   * | withheld | withheld | 250 000 | 258 400 | **YES** |
   * | 262 000 | withheld | 230 000 | 248 900 | no |
   * | 262 000 | withheld | 240 000 | 248 900 | **YES** |
   *
   * The two "no" arms are the controls that make the two "YES" arms mean
   * something. The reported window is `resolved_context_window *
   * effective_context_window_percent / 100` (95 by default), so 258 400 also
   * proves the withheld arm had a window rather than none.
   *
   * ## What this option therefore does, and the posture it cannot avoid
   *
   * ON  — write the window AND `model_auto_compact_token_limit` at 85 %.
   * OFF — write the window, withhold the limit key.
   *
   * OFF is **as close to off as codex allows, and no closer**. Because
   * `auto_compact_token_limit()` takes the `min`, the config key can only ever
   * LOWER the trigger; withholding it therefore buys the HIGHEST trigger codex
   * will accept — 90 % of the real window instead of our 85 %. Writing a huge
   * value, or `i64::MAX`, buys nothing: the `min` clamps it straight back to the
   * 90 % term.
   *
   * **This is a product posture and it is stated rather than implied: on codex a
   * user cannot turn auto-compaction off.** The host makes the residue honest
   * instead of uniform — `runtime-switch-costs.ts`'s `autoCompactionOff` row
   * says so at the switch, and `docs/architecture/runtime-capability-gaps.md`
   * records it in the Codex table. Turning it off silently, which is what
   * withholding both keys did, is the shape this repo calls a silent divergence.
   *
   * Absent means ON, which is codex's own behaviour and every existing caller's.
   */
  autoCompactionEnabled?: boolean;
  /**
   * P2.436 — codex's own compaction-prompt knob, `compact_prompt`.
   *
   * The pinned release schema (`codex-protocol/schema/config-schema.json`,
   * `.properties.compact_prompt`) types it as a top-level `string` and describes
   * it as *"Compact prompt used for history compaction."* Its sibling
   * `experimental_compact_prompt_file` takes an `AbsolutePathBuf` instead; this
   * option deliberately uses the STRING spelling — a path would mean writing and
   * owning a second file inside `CODEX_HOME` for content the caller already has
   * in hand, and an absolute path is the thing this repo's own gate refuses to
   * hand to a child process.
   *
   * Native-first: codex compacts SERVER-SIDE, so there is no host seam to inject
   * a prompt at the way the Pi path has. This key IS the mechanism; the caller
   * composes the steering and the leaf emits what it is handed. Blank or
   * whitespace-only emits nothing, so an absent section leaves codex's own
   * default compaction prompt untouched rather than replacing it with emptiness.
   */
  compactPrompt?: string;
  /**
   * P3.348 — codex's own `tool_output_token_limit`, and the ONE shape in which
   * the host's output ceiling is allowed to reach it.
   *
   * ## The gap
   *
   * The host's tool-output ceiling binds on Pi (the `ProcessStore` ring) and on
   * claude (the env spelling the vendored binary reads) and on codex not at all:
   * the shell runs INSIDE the binary, so neither reader is on the path. codex's
   * own key exists — the pinned release schema
   * (`codex-protocol/schema/config-schema.json`,
   * `.properties.tool_output_token_limit`, `format: uint`) describes it as
   * *"Token budget applied when storing tool/function outputs in the context
   * manager."* — and this writer emitted it in zero lines. What makes it silent
   * rather than merely unwired: `codexHome` is a fresh mkdtemp per session and
   * this writer has no raw-TOML passthrough, so there is no file for an operator
   * to hand-edit.
   *
   * ## codex's own default, MEASURED FIRST, because a smaller projection would
   * SHOW THE MODEL LESS
   *
   * Read at `rust-v0.148.0` (strong evidence — the source the shipped binary is
   * built from). The key is not a limit of its own; it OVERRIDES the model's
   * truncation policy, in the model's own unit:
   * `models-manager/src/model_info.rs::with_config_overrides` converts the token
   * value through `approx_bytes_for_tokens` (4 bytes per token,
   * `utils/string/src/truncate.rs`) when the model's policy is byte-shaped.
   *
   * The production fallback for a slug codex does not ship —
   * `model_info_from_slug`, the same function P3.286 measured for the context
   * window — carries `truncation_policy: TruncationPolicyConfig::bytes(10_000)`.
   * So codex's live default here is **10 000 bytes**, and
   * `context_manager/history.rs::process_item` multiplies it by 1.2 before
   * truncating. That is a THIRD of the host's own 30 000-character default, so a
   * projection RAISES what the model sees rather than lowering it — the check
   * this row demanded before anything was written.
   *
   * ## The decision, because nothing documents a projection
   *
   * The two knobs are not the same knob: the host's is CHARACTERS of one tool's
   * read-back window, codex's is TOKENS applied to every stored tool output. So
   * the caller forwards it **only when the operator explicitly set the host
   * value**, exactly as {@link CodexConfigOptions.compactPrompt} does — an
   * operator who never touched it keeps codex's own default rather than having a
   * Bash-shaped character budget applied to every tool on the runtime. The
   * character→token conversion uses codex's own constant (4), so the value
   * round-trips back to the character count the operator typed.
   *
   * A non-positive or non-integer value is dropped rather than written: a
   * wrong-TYPED value here is catastrophic and measured — `compact_prompt = 42`
   * produced *"Invalid configuration; using defaults."*, which discards the
   * WHOLE file.
   */
  toolOutputTokenLimit?: number;
  /**
   * P6.140 — a deadline on ONE codex MCP tool call, in seconds. The pinned `config-schema.json`
   * gives `RawMcpServerConfig` three transport deadlines
   * (`tool_timeout_sec`, `format: double`, `default: null`; `startup_timeout_sec`;
   * `startup_timeout_ms`) and this writer emitted none of them on either entry —
   * a hung transport had no deadline on codex while the host pool's own wall clock
   * bounds the same call on Pi and claude (tripwire: `shared/src/mcp/__tests__/codex-required-mcp-server-contract.test.ts`).
   *
   * ## `sources`: EXPLICIT-SET-ONLY (P3.348), one looser than the host ceiling
   *
   * Written only when the operator set `NESSY_MCP_TOOL_TIMEOUT` (or its
   * documented `MCP_TOOL_TIMEOUT` compat spelling) EXPLICITLY — the lever's own
   * host default, `MCP_DEFAULT_TOOL_TIMEOUT_MS`, is about 28 hours on purpose,
   * and projecting it would write a 100 001-second deadline onto codex for
   * every user who asked for nothing: noise pretending to be a setting. And
   * the emitted value is deliberately LOOSER than the host pool's own ceiling
   * for the same call, because the race must be won by the abort that NAMES
   * the server and the tool (P6.26) — codex's names neither. The caller adds
   * the margin; see `CodexAgent.codexMcpToolTimeoutOption` for its arithmetic.
   *
   * ## `session`: a floor, not a lever (UA12.24)
   *
   * A session tool call WAITS FOR A PERSON — the publish, archive and delete
   * cards — and codex's own default deadline (60 s; DOC-tier, weak — the
   * pinned schema says `default: null`) is shorter than the 110 s card window,
   * so an answer a minute slow arrived after codex had told the model the call
   * timed out. That entry therefore ALWAYS carries
   * {@link CODEX_SESSION_TOOL_TIMEOUT_SEC} — the session bridge's per-route
   * callback ceiling plus one, so every host outcome (a verdict, the card
   * timeout resolving to a deny, the bridge's own abort) beats codex's clock —
   * raised to the operator's lever when that is looser. The lever may loosen
   * the deadline, never tighten it below the card window; an explicit deadline
   * is honest under either evidence reading, hence unconditional.
   *
   * Non-positive or non-finite is dropped rather than written, for the reason
   * {@link CodexConfigOptions.toolOutputTokenLimit} records: a wrong-TYPED value
   * in this file is not an ignored key, it is *"Invalid configuration; using
   * defaults."* and the WHOLE file goes with it.
   *
   * The two startup keys stay unwritten and that is a decision, not an
   * oversight: they bound codex's own spawn of these two entries, where the host
   * pool has no part at all, so `NESSY_MCP_TIMEOUT` would be projected onto a
   * connect this host never makes. Reported as a proposed row rather than
   * invented here.
   */
  mcpToolTimeoutSec?: number;
  /**
   * P6.166 — the host's auto-memory OFF switch, in codex's own vocabulary.
   *
   * `false` writes `[memories] generate_memories = false` and
   * `use_memories = false`. Anything else writes NOTHING: an absent table means
   * codex's own defaults, and writing `true` would be us re-asserting a default
   * we did not choose.
   *
   * P6.754 — what the caller resolves into this boolean is THIS CHAT's memory
   * scope, not the app-wide switch alone, through the same projection it sends
   * on `thread/memoryMode/set`. A per-chat value is admissible in this file
   * because the file is per-chat: `CodexAgent.createRuntime` mints a fresh
   * `CODEX_HOME` per runtime. Nothing changes on this side — the writer still
   * sees one boolean and still writes only the OFF position — but a reader
   * comparing the table with the wire now finds them saying the same thing.
   *
   * ## MEASURED on the shipped binary before a line of this was written
   *
   * `codex-app-server` at `rust-v0.148.0`, isolated `CODEX_HOME`, the
   * `startStubAdapter` loopback Responses provider `codex-inject-items-e2e`
   * uses, one real `turn/start` per arm, then `state_5.sqlite` read directly:
   *
   * | `[memories]` | `threads.memory_mode` | developer prompt |
   * | --- | --- | --- |
   * | absent (control) | `enabled` | 20 751 chars, no memory block |
   * | both keys `false` | **`disabled`** | 20 751 chars, no memory block |
   *
   * So `generate_memories` IS honoured — the schema's own sentence, "When
   * `false`, newly created threads are stored with `memory_mode = \"disabled\"`
   * in the state DB", reproduced exactly. The `threads` table's column default
   * is `memory_mode TEXT NOT NULL DEFAULT 'enabled'`, read out of the live
   * schema, which is why the control arm is the meaningful half of that pair.
   *
   * **`use_memories` is UNOBSERVABLE on that rig and is recorded as such rather
   * than claimed.** Its sentence is "When `false`, skip injecting memory usage
   * instructions into developer prompts", and the developer prompt was
   * byte-identical at 20 751 characters in BOTH arms with no memory text in
   * either — a fresh `CODEX_HOME` has no memories to instruct about, so there
   * was nothing for the key to remove. It is written anyway: it is the same
   * switch's other half, it is a documented key of the pinned schema, and the
   * direction of a mistake here is toward LESS memory, which is what the user
   * asked for. The residue is that its effect is unproven, not that its meaning
   * is guessed.
   */
  memoriesEnabled?: boolean;
  /**
   * P6.534 — the host's bundled-skills OFF switch, in codex's own vocabulary.
   *
   * ## The gap
   *
   * `disableBundledSkills` / `NESSY_DISABLE_BUNDLED_SKILLS` stops the host
   * seeding its bundled skills and drops any copy already on disk. It reached
   * codex nowhere: a cold managed `CODEX_HOME` comes back holding codex's OWN
   * bundled tree — 87 entries measured on the shipped `darwin-arm64` build
   * (2026-09-03, two differing `installation_id`s as the positive control) — and
   * the host switch could not touch a single one of them. A documented off
   * switch that is half true is this fork's largest defect class.
   *
   * ## Native-first: this is codex's own key, unwritten
   *
   * `SkillsConfig` in the pinned `packages/codex-protocol/schema/config-schema.json`
   * carries `bundled` → `BundledSkillsConfig { enabled: boolean, default: true }`,
   * the exact analogue of the host switch, beside `include_instructions` and the
   * per-skill `[[skills.config]]` selectors. One key, no host machinery. Q-den 76
   * chose that projection (option 1) over leaving codex's tree on and saying so.
   *
   * ## Written only in the OFF position
   *
   * `false` writes `[skills.bundled] enabled = false`. Anything else writes
   * NOTHING — an absent table means codex's own default (`true`), and writing
   * `true` would be us re-asserting a default we did not choose. The same rule
   * {@link CodexConfigOptions.memoriesEnabled} follows, for the same reason.
   *
   * ## The consequence, stated because the user pays it
   *
   * Codex's own bundled skills are USEFUL, and they go with the switch —
   * including `$skill-installer`, the only skill-by-name installer in the
   * product. That sentence is repeated where the user meets the switch
   * (`shared/src/config/bundled-skills-settings.ts` and the docs-site
   * environment-variables page) rather than only here, because the person who
   * flips it never reads this file.
   */
  bundledSkillsEnabled?: boolean;
  /**
   * P6.155 — the cheap model a spawned codex subagent runs on.
   *
   * ## The gap, and the reader's claim that was refuted
   *
   * Codex has TWO of its own levers for this and we wrote neither. This is the
   * global one: `agents.default_subagent_model` in the pinned
   * `config-schema.json`, verbatim *"Default model for spawned subagents when
   * the spawn call does not select one."* — a real key of `AgentsToml`, in the
   * table this writer already emits, and known here only as a RESERVED role
   * name. The reading that per-role model selection is STRUCTURAL on codex is
   * refuted by `model_reasoning_effort`, which we already write into a role's
   * own `config_file` layer: the layer accepts root-level keys.
   *
   * ## Why a SERVED id is not the FOREIGN id this writer refuses
   *
   * `buildCodexAgentRoles` drops a role's `model` because one codex session
   * drives ONE upstream through the loopback adapter, so a foreign id can only
   * fail at spawn. That reason does not transfer: the caller passes the
   * connection's OWN mini model, served by the same upstream this session
   * already talks to.
   *
   * ## Written only when it says something
   *
   * The host resolves `miniModel` as `getMiniModel(connection) ?? defaultModel`,
   * so on a connection with no distinct cheap model it EQUALS the session model.
   * Writing it then would restate codex's own documented default — the
   * `spawn_agent` text is *"Spawned agents inherit your current model by
   * default"* — so the caller omits it, the same explicit-only discipline
   * `toolOutputTokenLimit` records.
   *
   * ## What is measured, and what is NOT
   *
   * Measured on the shipped `darwin-arm64` `codex-app-server` at
   * `rust-v0.148.0`: `default_subagent_model` occurs 9 times (positive controls
   * `spawn_agent` 28, `agent_type` 22; negative control `nessy_not_a_key` 0),
   * and a config carrying it is ACCEPTED — a driven turn against a loopback
   * Responses provider reached that provider, which it could not have done had
   * the file been discarded as *"Invalid configuration; using defaults."*
   *
   * NOT measured, and recorded rather than implied: the spawned subagent's own
   * first upstream request naming the id. Reaching it needs the model to call
   * `spawn_agent`, and that tool is inside the `multi_agent_v1` NAMESPACE on the
   * wire — a canned `function_call` named `spawn_agent`,
   * `multi_agent_v1.spawn_agent`, `multi_agent_v1__spawn_agent`,
   * `multi_agent_v1/spawn_agent` and `multi_agent_v1:spawn_agent` each came back
   * *"unsupported call"* from the binary, so the stub provider cannot dispatch a
   * namespaced tool as it stands. That arm needs the stub taught the namespaced
   * call shape, which is its own unit.
   */
  defaultSubagentModel?: string;
  /**
   * P3.347 — the two subagent ceilings, and the ONE shape in which the host's
   * knobs are allowed to reach codex's `[agents]` table.
   *
   * ## The gap
   *
   * This writer emits `multi_agent = true` unconditionally and then writes only
   * `[agents.<role>]` sub-tables — no bare `[agents]` key at all — while
   * `NESSY_MAX_SUBAGENT_SPAWN_DEPTH` and `NESSY_MAX_CONCURRENT_SUBAGENTS` bind on
   * Pi and claude (`buildClaudeSubprocessEnv`'s two appliers) and vanish here
   * with no diagnostic. Nesting is real on codex: the binary's own `spawn_agent`
   * text promises the spawned agent *"the ability to spawn its own subagents"*.
   *
   * ## Which backend is in force, MEASURED rather than assumed
   *
   * The schema offers `max_concurrent_threads_per_session` and `max_depth`, and
   * `max_depth` is documented *"Ignored by V2"* — so the row required the
   * multi-agent VERSION to be established before either key was written.
   *
   * Measured 2026-09-04 against the shipped `codex-app-server`
   * (`apps/electron/resources/bin/codex/darwin-arm64`, on a CODEX_HOME this
   * writer produced), `experimentalFeature/list`, 114 features:
   *
   *   multi_agent    → stage stable, enabled TRUE,  defaultEnabled true
   *   multi_agent_v2 → stage stable, enabled FALSE, defaultEnabled false
   *
   * Confirmed against the source at `rust-v0.150.1`: `features/src/lib.rs` maps
   * the key `multi_agent` to `Feature::Collab` (V1) and `multi_agent_v2` to
   * `Feature::MultiAgentV2`, and `core/src/config/mod.rs::
   * multi_agent_version_override` selects V2 only when the latter is enabled. So
   * **V1 is in force and BOTH keys are live**, with codex's own defaults being
   * `DEFAULT_AGENT_MAX_THREADS = Some(6)` and `DEFAULT_AGENT_MAX_DEPTH = 1`.
   *
   * (`multi_agent = true` is therefore also writing codex's own default. Left
   * alone: it is the declaration P3.116's sibling argues for, and removing it
   * would make the feature's state depend on a default that can move.)
   *
   * ## What the caller may forward, and what it may not
   *
   * ONLY an explicit operator value, never the host's RAM-derived ceiling —
   * P6.16's refutation, and it applies with full force here: a codex subagent is
   * a THREAD inside the existing child process, so a bound derived from "one
   * agent runtime per 2 GiB" describes a cost codex does not pay. An operator who
   * set nothing gets codex's own defaults.
   *
   * Both are dropped unless they are integers >= 1. The schema says
   * `minimum: 1` for the concurrency key, and a wrong-TYPED value is measured to
   * yield *"Invalid configuration; using defaults."*, which discards the WHOLE
   * file.
   */
  maxConcurrentSubagentThreads?: number;
  /** P3.347's other half — codex's `[agents].max_depth`. See above. */
  maxSubagentSpawnDepth?: number;
  /**
   * P6.309 (4) — codex's own delegation off-switch, `[agents] enabled`.
   *
   * ## What it is, and why it was deliberately unwritten
   *
   * `AgentsToml.enabled` is *"Whether multi-agent tools are enabled. Defaults to
   * true"*, so `spawn_agent`/`wait_agent`/`close_agent`/`resume_agent` are live
   * on every codex session we start. This writer's `[agents]`-LAST comment
   * records the reason it never wrote the key: the tools are already on and a
   * role is additive guidance, not an authorization. That reason answers "why
   * not write `true`". It does not answer "how does an operator turn delegation
   * OFF", which is what H33 asks, and until this option there was no answer.
   *
   * ## Explicit `false` only — never `true`
   *
   * Writing `true` would restate codex's own default and buy nothing; the
   * `view_image` argument for declaring a default does not transfer, because
   * this key's default flipping to `false` would be LOUD (every delegation stops
   * and the model says so) rather than silent. So the option is honoured only
   * when it is explicitly `false`; `undefined` and `true` both emit nothing, and
   * the config stays byte-identical for every caller that does not set it.
   *
   * ## THE HOST HALF IS NOT BUILT, and that is a decision with its reason
   *
   * There is no cross-runtime host notion of "no delegation" to project here.
   * The nearest documented candidate was measured and REFUTED:
   * `NESSY_MAX_SUBAGENT_SPAWN_DEPTH` / `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`
   * cannot express it — `env-vars.md`'s own row says *"Accepts a positive whole
   * number in plain digits … so the limit can be adjusted but not removed"*, and
   * `resolveMaxSubagentSpawnDepth` enforces `min: 1` for exactly that reason, so
   * `0` is a fallback and never a disable. Minting a NEW env variable read only
   * by codex is the shape this plan refuses by precedent (P6.533 option 3: a
   * single-runtime setting is a new silent divergence unless the switch report
   * carries it), and where the delegation tool is withheld on Pi and claude is
   * another lane's file.
   *
   * So the mechanism is built and proven by its own test while its caller does
   * not exist yet — the same explicitly-inert shape
   * {@link CodexConfigOptions.instructionExcludes} records — and the missing
   * half is one host setting, not one more line here.
   */
  subagentsEnabled?: boolean;
  /**
   * P6.488 — the OTLP headers, as LITERALS, for `[otel].exporter`'s
   * `otlp-http.headers` map.
   *
   * This is the one place this writer holds a credential VALUE rather than an
   * env var NAME, and it is deliberate: codex's `OtlpHttp.headers` is a literal
   * map in `config/src/types.rs` at `rust-v0.150.1`, with no env indirection
   * anywhere in `OtelExporterKind`, so there is no name form to adopt. Owner
   * decision 2026-09-05 Q24 option 3: the default keeps refusing and this
   * arrives only behind the caller's named opt-in.
   *
   * The caller owns the gate; this leaf emits what it is handed. The containment
   * is the caller's too — a per-session `mkdtemp` CODEX_HOME at 0700, the file
   * at 0600, removed on teardown.
   */
  otelLogsHeaders?: Readonly<Record<string, string>>;
  /**
   * P2.450 — the OTLP/HTTP **logs** endpoint codex's own `[otel]` exporter is
   * pointed at, already resolved from the host's telemetry env by the caller.
   *
   * Absent (the default) writes no exporter at all, which is codex's own
   * default: `core/src/config/otel.rs` at `rust-v0.150.1` resolves
   * `exporter`/`trace_exporter` to `OtelExporterKind::None`. The caller owns the
   * gate because the gate is the HOST's, shared with Pi's exporter and claude's
   * (`telemetryOptedIn`/`telemetryOptedOut`/`otelExporterDisabled`); this leaf
   * emits what it is handed, exactly as `compactPrompt` does.
   *
   * The value must be the FULL logs URL, `/v1/logs` and all. codex's own comment
   * on the field says why the base URL will not do: *"OTLP HTTP endpoints are
   * signal-specific in our config, so enabling log export must not implicitly
   * send spans to a /v1/logs endpoint."*
   */
  otelLogsEndpoint?: string;
  /**
   * P6.459 arm (1) — the OTLP/HTTP **traces** endpoint codex's own
   * `[otel] trace_exporter` is pointed at, already resolved by the caller and
   * gated on the same host rule all three runtimes read (`tracingOptedIn`).
   *
   * Absent (the default) writes no trace exporter, which is codex's own default:
   * `core/src/config/otel.rs` at `rust-v0.150.1` resolves `trace_exporter` to
   * `OtelExporterKind::None`, so writing `"none"` explicitly would add a key
   * that changes nothing.
   *
   * SEPARATE from {@link CodexConfigOptions.otelLogsEndpoint} and not derived
   * from it, for the reason codex's own comment on that field gives: *"OTLP HTTP
   * endpoints are signal-specific in our config, so enabling log export must not
   * implicitly send spans to a /v1/logs endpoint."* The value must be the FULL
   * traces URL.
   *
   * What this exports is CODEX'S OWN spans, unparented — genuine roots of its
   * own trace tree, not a fabricated context. The per-request `trace` field that
   * would parent them to a host trace stays unsent until a host span source
   * exists (P6.732), because filling it without one mints orphans.
   */
  otelTracesEndpoint?: string;
  /**
   * Ephemeral localhost port the Responses adapter is listening on.
   *
   * P6.532 — OPTIONAL only for a session that declared its own
   * {@link CodexConfigOptions.declaredModelProvider}: no adapter is started for
   * one (the host skips `startAdapter`, so no port is bound and no gateway
   * credential is held for a route nothing uses), and this field's ONE reader is
   * the `[model_providers.*]` loopback table, which such a session suppresses.
   *
   * Every other caller must still pass it, and that is ENFORCED rather than
   * documented: {@link buildCodexConfigToml} throws when it is absent without a
   * declared provider. A defaulted `0` would emit
   * `base_url = "http://127.0.0.1:0/v1"`, which codex accepts and no session can
   * reach — the silent shape this row exists to remove.
   */
  adapterPort?: number;
  /**
   * P6.532 — the codex `model_provider` this session routes to, when the
   * CONNECTION declared one. `undefined` means "keep the loopback pin", which
   * is every install that declared nothing.
   *
   * Resolved host-side by `resolveCodexModelProvider`
   * (`@nessy-agent/shared/config`), which reads the connection and the operator
   * switch **and no ambient AWS name** — that absence is the row's whole safety
   * property. Typed as the literal rather than imported because this package
   * declares no dependency on `shared`; the union lives there
   * (`CodexModelProvider`) and gaining a second member is a change in both
   * places, deliberately.
   *
   * `amazon-bedrock` is codex's OWN built-in provider id, so no
   * `[model_providers.amazon-bedrock]` table is written or needed — see the two
   * emit sites below, and `built_in_model_providers`
   * (`codex-rs/model-provider-info/src/lib.rs`, `rust-v0.150.1`).
   */
  declaredModelProvider?: 'amazon-bedrock' | 'openai'; // F1.202 — `openai`: the ChatGPT (Codex) card
  /**
   * P6.273 — the operator's retry ceiling, projected onto BOTH of codex's
   * per-provider retry counters.
   *
   * `ModelProviderInfo.request_max_retries` (*"Maximum number of times to retry
   * a failed HTTP request to this provider"*) and `.stream_max_retries`
   * (*"Number of times to retry reconnecting a dropped streaming response before
   * failing"*), both `uint64` with `minimum: 0` — read from the vendored
   * `codex-protocol/schema/config-schema.json`, which is generated from the
   * source the shipped binary is built from
   * (`codex-rs/model-provider-info/src/lib.rs`, `struct ModelProviderInfo`, at
   * `rust-v0.150.1`). P7.11: the path this cited before named a file that has
   * never existed at any tag this repo has shipped — it 404s at both — while the
   * one above resolves at both and was already cited correctly elsewhere in the
   * same tree.
   *
   * ONE host value feeds both, because the operator's question is "how many
   * times may a turn try again", and splitting it into two names on codex alone
   * would be a divergence the other two runtimes have no answer for. Unset, the
   * keys are omitted entirely and codex keeps its own defaults, byte for byte.
   */
  providerMaxRetries?: number;
  /**
   * P6.273 — the operator's streaming idle deadline, `ModelProviderInfo
   * .stream_idle_timeout_ms`: *"Idle timeout (in milliseconds) to wait for
   * activity on a streaming response before treating the connection as lost."*
   *
   * Same provenance and the same unset behaviour as {@link providerMaxRetries}.
   */
  providerStreamIdleTimeoutMs?: number;
  /** Nessy permission-mode-derived sandbox mode (default `workspace-write`). */
  sandboxMode?: CodexSandboxMode;
  /** codex approval policy (default `on-request`). */
  approvalPolicy?: CodexApprovalPolicy;
  /**
   * P6.224 — the payload for `approvalPolicy: 'granular'`, codex's object
   * variant of `AskForApproval`.
   *
   * Required when the policy is `granular` and ignored otherwise: the schema's
   * object variant is `{ "required": ["granular"] }`, so emitting the policy
   * without it would produce a config the app-server rejects — and codex's
   * config failure is WHOLE-FILE, taking the provider block and every deny floor
   * with it.
   *
   * NOT selected by any mode today. `CODEX_PERMISSION_MODE_TABLE` still emits
   * only `never` and `on-request`; which categories a Nessy session would
   * auto-reject is an owner posture, and this row makes the variant expressible
   * rather than choosing one.
   */
  granularApproval?: CodexGranularApprovalConfig;
  /**
   * P3.2 — route escalated approvals through codex's NATIVE auto-review guardian
   * subagent (`approvals_reviewer = "auto_review"`). Setting-gated and default
   * OFF: the caller (`CodexAgent`) reads the `codexAutoReviewEnabled` setting and
   * only then passes this; the leaf emits what it is handed.
   *
   * Emitted ONLY when the RESOLVED `approval_policy` is interactive. codex's own
   * eligibility rule is "with `never` there is nothing to review", so a `never`
   * policy — e.g. `dontAsk` with the sandbox master switch ON — DEGRADES to not
   * emitting the key rather than writing one the app-server would ignore
   * (probe/degrade, the protocol-drift posture the rest of this leaf takes).
   */
  approvalsReviewer?: CodexApprovalsReviewer;
  /**
   * Optional free-text policy instructions inserted into the guardian prompt,
   * emitted as `[auto_review].policy` (`AutoReviewToml.policy`, a `string`). Only
   * emitted alongside `approvals_reviewer = "auto_review"`; a blank/whitespace
   * value emits no `[auto_review]` table at all.
   */
  autoReviewPolicy?: string;
  /**
   * Nessy permission mode. When set, derives `sandbox_mode`/`approval_policy`
   * via `codexSandboxConfigForMode` (overrides the explicit fields above).
   */
  mode?: CodexPermissionMode;
  /**
   * T1 (2026-08-12) master switch, threaded to `codexSandboxConfigForMode`.
   * `false` emits `sandbox_mode: 'danger-full-access'` for every mode and leaves
   * `approval_policy` untouched — Nessy's PolicyEngine stays the gate on top
   * even with the codex OS wrap off — with the ONE exception R13 added: a
   * `never` policy degrades to `untrusted`, because `never` plus no sandbox is
   * the one combination that leaves no gate at all. Defaults `true` (unchanged
   * behaviour for any caller that never sets it).
   */
  sandboxGloballyEnabled?: boolean;
  /**
   * Optional bundled `session-mcp-server` stdio entry → emitted as
   * `[mcp_servers.session]`. The caller (CodexAgent) resolves the launcher
   * command + args (kept out of this dep-free leaf, which can't reach the runtime
   * resolver or session-path helpers).
   *
   * The server KEY is the model-facing name's middle segment — the codex binary
   * mints `mcp__<key>__<tool>` — so it is `session`, matching the Claude Agent
   * SDK's own server name and Pi's `mcp__session__` prefix. It used to be
   * `nessy_session`, which made Codex the one runtime whose session tools the
   * model called by a different name, and which no `'session'`-keyed consumer
   * (the built-in-server set in `pre-tool-use.ts`, the transcript display table
   * in `SessionManager.ts`) recognized.
   */
  sessionMcp?: CodexMcpServerSpec;
  /** Per-session host-owned MCP pool endpoint for enabled source tools. */
  poolMcpUrl?: string;
  /**
   * Host-owned files or directories that agent shell commands must never read.
   * The trusted app-server and MCP launcher remain outside this command sandbox.
   */
  deniedReadPaths?: readonly string[]; readOnlyPaths?: readonly string[]; // F1.670 — absolute paths agent commands may READ but never write (codex's own `read` access; see `resolveCodexRuntimePathPolicy`)
  /**
   * The host's `deniedPaths` credential floor, in OUR glob grammar, mirrored
   * onto codex's own filesystem deny map (P3.175).
   *
   * Distinct from {@link deniedReadPaths}, which is the host's own small set of
   * EXACT absolute paths and is validated as such. These are user- and
   * policy-authored PATTERNS; the subset codex can express faithfully is
   * translated by {@link mapDeniedPathsToCodexFilesystemKeys} and the rest is
   * dropped by name on {@link onDiagnostic}. Read that function's docstring
   * before changing the grammar — the rejection reasons are measured, not
   * defensive.
   */
  deniedReadPatterns?: readonly string[];
  /** Exact managed data roots writable by agent shell commands. */
  writablePaths?: readonly string[];
  /**
   * C3.343 — the host's protected-path floor, WORKSPACE-RELATIVE, projected into
   * codex's own `[permissions.<profile>.filesystem.":workspace_roots"]` table as
   * `read` entries.
   *
   * ## Why this is a projection and not a host gate
   *
   * The floor Pi and claude obey is `protectedPathOutcome`
   * (`shared/agent/pi-harness/protected-paths.ts`), reached from
   * `core/pre-tool-use.ts`. The codex path has no `runPreToolUseChecks`, and
   * codex's own pre-write announcement (`item/started`) is a NOTIFICATION that
   * codex does not wait on — `CodexAgent.checkpointCodexFileChange` records that
   * residue in its own docblock — so a host gate hung there would be a race, not
   * a floor. Codex's `[permissions]` profile is the one carrier that refuses the
   * write before it happens, which is why the list arrives here instead.
   *
   * ## What the shipped binary does with and without it (darwin-arm64
   * `codex-app-server`, `rust-v0.150.1`, 2026-09-12, `command/exec` under the
   * config THIS writer emits for `mode: 'default'` with the sandbox master
   * switch off — every row paired with an ordinary in-workspace `touch` that
   * must land, and with a read that must still succeed)
   *
   * | workspace | probe | HEAD | with this list |
   * | --- | --- | --- | --- |
   * | outside `/tmp` and `$TMPDIR` | write `<ws>/.git/x` | refused | refused |
   * | outside `/tmp` and `$TMPDIR` | create `<ws>/.claude`, `<ws>/.vscode` | **lands** | refused |
   * | under `$TMPDIR` | write `<ws>/.git/x` | **lands** | refused |
   * | under `$TMPDIR` | create `<ws>/.claude`, `<ws>/.vscode` | **lands** | refused |
   * | either | ordinary `touch`, `cat README.md`, `cat .git/HEAD` | ok | ok |
   *
   * So codex already protects the THREE names it knows (`.git`, `.agents`,
   * `.codex`) at the top level of a writable root, missing or present
   * (`default_read_only_subpaths_for_writable_root` and the
   * `protected_metadata_names` pair in `codex-rs/protocol/src/permissions.rs`) —
   * and that protection is DEFEATED when the workspace itself sits under a
   * broader writable root, because `workspace-write` grants `/tmp` and `$TMPDIR`
   * as roots of their own and the carve-out is computed per root. An explicit
   * narrower non-write entry is what survives that, and it is also what extends
   * the floor to the other names on the host's list.
   *
   * ## The residue, stated rather than hidden
   *
   * A `.git` BELOW the workspace root — a submodule, a vendored checkout,
   * `<ws>/sub/.git` — is still writable, measured on the same rig in both arms.
   * `":workspace_roots"` subpaths are resolved against each root, not matched at
   * any depth, and the one spelling that would match at any depth is a glob
   * pattern, which `compile_scoped_filesystem_pattern` accepts ONLY with `deny`
   * access — and a `deny` would take the READS with it, which is how `git status`
   * and every diff surface stop working. The host floor matches `.git` at any
   * depth on Pi and claude, so this is a per-runtime narrowing and is recorded as
   * one rather than papered over.
   */
  protectedWorkspaceSubpaths?: readonly string[];
  /** Per-thread shell environment for a selected plugin runtime. */
  shellEnvironment?: Readonly<Record<string, string>>;
  /**
   * Durable execpolicy allow-prefixes projected into `CODEX_HOME/rules/`.
   *
   * Each entry is one command's token prefix — an `ExecPolicyAmendment`
   * (`packages/codex-protocol/generated/ExecPolicyAmendment.ts`:
   * `type ExecPolicyAmendment = Array<string>`, "The `command` tokens form the
   * prefix that would be added as an execpolicy `prefix_rule(..., decision=
   * \"allow\")`"). The caller derives these from the DURABLE workspace
   * `permissions.json` store, so this is a pure PROJECTION rewritten on every
   * home build — never itself a persisted store (`CODEX_HOME` is an ephemeral
   * `mkdtemp` torn down on teardown). Empty and blank prefixes are dropped.
   *
   * ## AN ALLOW RULE ALSO TURNS THE SANDBOX OFF FOR THAT PREFIX (P3.80)
   *
   * The user who clicked "always allow" consented to the PROMPT going away.
   * codex reads the same grant as full trust and drops the SANDBOX with it, and
   * that second half is nowhere in the click. Read at the shipped tag
   * `rust-v0.148.0` — source, not the page — as three hops with no branch
   * between them:
   *  - `core/src/exec_policy.rs:415`: `Decision::Allow =>
   *    ExecApprovalRequirement::Skip { bypass_sandbox: … }`, whose own comment
   *    reads "Bypass sandbox only when every parsed command segment is
   *    explicitly allowed by execpolicy" — computed with
   *    `heuristics_fallback: None`, so ONLY an explicit rule match sets it. An
   *    `Allow` reached through codex's own heuristics leaves it false. Our
   *    projected `prefix_rule(..., decision="allow")` is exactly such a rule;
   *  - `core/src/tools/sandboxing.rs:250-260`: `Skip { bypass_sandbox: true }`
   *    returns `SandboxOverride::BypassSandboxFirstAttempt`, commented
   *    "ExecPolicy `Allow` can intentionally imply full trust … which supersedes
   *    `with_additional_permissions` sandboxed execution hints";
   *  - `core/src/tools/orchestrator.rs:236-253`: that override makes
   *    `sandbox_requested` false and `initial_sandbox` `SandboxType::None`.
   *
   * INTENDED BY CODEX ("intentionally imply full trust"), and ACCEPTED HERE
   * rather than worked around, for a reason that is a standing decision and not
   * a property of this file: isolation is OFF by owner decision, so the sandbox
   * is not today the thing protecting the user. That makes this cheap now and
   * expensive later, which is why it is written down at the projection site and
   * named on {@link CodexConfigOptions.onDiagnostic} instead of being left to be
   * rediscovered the day isolation comes back.
   *
   * There is no third state to project: `Decision` is `Allow | Prompt |
   * Forbidden` (`execpolicy/src/decision.rs`), so execpolicy cannot say "skip the
   * prompt but keep the sandbox". Refusing to project the grant at all is the
   * only alternative, and that deletes the feature the user asked for.
   *
   * MEASURED BOUND, and it is the reason this is a documented trade rather than
   * a hole: codex refuses the bypass whenever the session carries ANY denied-read
   * entry. `sandboxing.rs:246-248` returns `NoOverride` before it ever looks at
   * `bypass_sandbox` when `!unsandboxed_execution_allowed(policy)`, and
   * `protocol/src/permissions.rs:469-480` makes that true for a `Restricted`
   * policy holding any `Deny` entry — which is precisely what
   * {@link deniedReadPaths} and {@link deniedReadPatterns} write (P3.175). So a
   * session with a credential floor keeps its sandbox and the grant is
   * prompt-only; a session without one does not.
   * {@link formatCodexExecpolicyGrantSandboxDiagnostics} reports which of the two
   * a given home is.
   *
   * ## AND THE GRANT IS CONDITIONAL ON THE MODEL (P3.82)
   *
   * P3.1's durability claim — the grant is re-derived from the durable store on
   * every home build, so it survives a rebuild — is true of the FILE and not of
   * its EFFECT. codex drops every allow-prefix rule, ours included, for some
   * models. `core/src/session/turn_context.rs`'s `allow_prefix_rules`
   * (`rust-v0.150.1`) picks
   * `AllowPrefixRules::IgnoreForCyberModel` on either of TWO triggers:
   *  - `model_info.model_specialty == "cyber"`. That field is BACKEND CATALOG
   *    data (`protocol/src/openai_models.rs:37-38`, "Backend model-catalog
   *    specialty identifying cybersecurity-focused models"), so THE COVERED SET
   *    IS NOT ENUMERABLE FROM THE SOURCE and cannot be — it is whatever the
   *    serving catalog marks. Recorded as a null rather than guessed at;
   *  - the model's slug appears in `requirements.toml`'s
   *    `[auto_review].ignore_rules` (`config/src/config_requirements.rs:965-968`).
   *    codex's own app-server README puts it in one sentence: "Models in
   *    `ignore_rules` ignore saved command-prefix approvals."
   *
   * `core/src/exec_policy/model_policy.rs:23-35` then rebuilds the policy keeping
   * every rule EXCEPT a `PrefixRule` whose `decision == Decision::Allow`. Deny
   * and prompt prefix rules, network rules and host executables all survive. So
   * the direction is FAIL-SAFE, which is why nobody has noticed: the user's
   * Always-Allow silently stops applying and they are asked again.
   *
   * NOT HONOURED IN THE PROJECTION, because neither trigger is knowable here and
   * the writer must not pretend otherwise. `config.toml`'s own `AutoReviewToml`
   * carries `policy` and nothing else (`config/src/config_toml.rs:530-533`), so
   * {@link autoReviewPolicy} cannot reach `ignore_rules`; that key lives in
   * `requirements.toml`, an operator-deployed managed-policy file this writer
   * neither writes nor reads. And the catalog's `model_specialty` never crosses
   * into our config at all. Said here instead, which is what the row asked for.
   *
   * ONE CONSEQUENCE WORTH CARRYING FORWARD, because it is not fail-safe in the
   * same tidy way: on those models `auto_amendment_allowed` is false
   * (`core/src/exec_policy.rs:334-335`), so codex proposes NO
   * `proposed_execpolicy_amendment` either — the native half of P3.1's capture
   * path goes quiet, and a new "always allow" there is only as good as our own
   * argv-token fallback.
   */
  execpolicyAllowPrefixes?: readonly (readonly string[])[];
  /**
   * Durable execpolicy DENY-prefixes projected into `CODEX_HOME/rules/` as
   * `prefix_rule(..., decision="forbidden")` (P2.141b).
   *
   * `decision` is `allow|prompt|forbidden`, not allow-only —
   * `learn.chatgpt.com/docs/agent-configuration/rules.md` § Understand rule
   * fields (`#understand-rule-fields`), `:60` on the
   * 2026-08-25 fetch, re-fetched 2026-09-03 byte-identical (md5
   * `b901eebf5a984e0bf0886d8bd86eef50`): "Codex applies the most restrictive decision when more than
   * one rule matches (`forbidden` > `prompt` > `allow`)", and `:63` "`forbidden`:
   * Block the request without prompting". Driven on the shipped binary the same
   * day: a `forbidden` rule loads as `decision: Forbidden`, while
   * `decision="nonsense"` is rejected (`error: invalid decision: nonsense`).
   *
   * DEFENCE IN DEPTH ONLY. A single malformed line in this file drops EVERY
   * custom rule in it — measured: one good `allow` beside one bad rule loaded
   * zero rules and reported "Error parsing rules; custom rules not applied." —
   * and codex does not split a script using `$FOO`, `*`, `$(...)`, a redirect or
   * control flow, applying rules to one `["bash","-lc","<script>"]` invocation
   * instead (same page, § When Codex does not split the script,
   * `#when-codex-does-not-split-the-script`, `:100`-`:117`). The host prefix on
   * both citations is P2.377: `rules.md` bare 404s on `code.claude.com/docs/en/`
   * and is in no page of `scripts/claude-doc-pages.tsv`; it is a codex page and
   * therefore WEAK evidence on its own, which is why the driven-binary result
   * above carries the verdict. The enforcing floor stays host-side in
   * `core/pre-tool-use.ts`.
   */
  execpolicyDenyPrefixes?: readonly (readonly string[])[];
  /**
   * Durable execpolicy PROMPT-prefixes projected into `CODEX_HOME/rules/` as
   * `prefix_rule(..., decision="prompt")` — the DSL's middle tier, which codex
   * was never told about until P6.1.
   *
   * `ask` already worked for every call codex ASKS about
   * (`CodexAgent.consultPermissionRules` returns `null` and the card is shown).
   * What it could not reach is the calls codex auto-approves without asking —
   * `approval_policy = "on-request"` leaves that to the model by the release
   * schema's own words, `untrusted` auto-approves safe reads, and our own
   * `decision="allow"` grants exist precisely to "bypass approval". A projected
   * `prompt` pulls those back to a request, because
   * `Evaluation::from_matches` takes `.max()` over matched decisions and
   * `Decision` is ordered `Allow < Prompt < Forbidden`
   * (`execpolicy/src/policy.rs`, `execpolicy/src/decision.rs`, `rust-v0.150.1`).
   *
   * Same fail-open bound as {@link execpolicyDenyPrefixes}: one malformed line
   * drops every rule in the file, so this is defence in depth. Unlike the deny
   * half it is also not a floor in intent — it RAISES a call to the human, and
   * the human's answer is then judged by the host gate as it always was.
   */
  execpolicyPromptPrefixes?: readonly (readonly string[])[];
  /**
   * The session's RESOLVED instruction-file exclusions
   * (`resolveInstructionExcludes`), carried here for one purpose only: to be
   * REPORTED. See {@link formatCodexInstructionExcludeDiagnostics} — P3.257 (a)
   * measured that codex has no knob an exclusion glob can map onto, so this
   * value is never written into `config.toml` and must not be.
   *
   * **PRODUCER NOT WIRED YET (W3-c, 2026-09-03), and that is a stated residue
   * rather than a finished feature.** `CodexAgent` is the caller that holds the
   * value and it lives in another lane's file; the whole wiring is passing
   * `instructionExcludes: resolveInstructionExcludes({ … })` at its
   * `writeCodexConfig` call. Until that lands the diagnostic below is inert —
   * the formatter is proven by its own test, not by a live session.
   */
  instructionExcludes?: readonly string[];
  /**
   * The session's materialized agent definitions, translated into codex's own
   * `[agents.<role>]` mechanism. See {@link buildCodexAgentRoles} for which
   * fields survive the translation and which are denied by omission.
   */
  agents?: readonly CodexAgentRoleDescriptor[];
  /**
   * P6.14 — hooks written into codex's OWN inline `[hooks]` table, so codex's
   * hook vocabulary is reachable instead of merely documented.
   *
   * ABSENT BY DEFAULT, and the default is load-bearing: with no plan this writer
   * emits zero bytes and the config is byte-identical to the one it wrote
   * before this option existed. codex fails a config OPEN and WHOLE-FILE, so a
   * capability that nobody has passed yet must not be able to cost the deny
   * floors of every session that does not use it.
   *
   * See {@link buildCodexHooksToml} for what survives projection and why only
   * `command` handlers do.
   *
   * P2.414 — the TYPE is the first half of the authorship gate. Only
   * {@link mintHostAuthoredCodexHooks} can produce a value for this field, so a
   * plan assembled from a user's `settings.json` or a plugin manifest cannot be
   * passed here without a cast — and a cast is caught at emission by the
   * registry check inside {@link buildCodexHooksToml}.
   */
  hooks?: CodexHostAuthoredHooksPlan;
  /**
   * P6.540 — the absolute path of the project codex is being pointed at, i.e.
   * the session cwd or its repository root. Required for {@link projectTrusted}
   * to say anything, because codex's trust table is KEYED BY PATH.
   */
  projectRoot?: string;
  /**
   * P6.540 — the host's own `projectTrusted` decision, projected onto codex's
   * own `trust_level`.
   *
   * Owner decision 2026-09-05, D15 option 2. See
   * {@link buildCodexProjectTrustToml} for what trust turns on, which of codex's
   * four trust consequences this writer's own keys already pre-empt, and the one
   * that remains.
   */
  projectTrusted?: boolean;
  /**
   * Named-diagnostic sink for the roles this writer could not express. Emitted
   * once per `writeCodexConfig` call — the pure builders never log, so a
   * `buildCodexConfigToml` called for a signature hash cannot double-report.
   */
  onDiagnostic?: (message: string) => void;
}

/**
 * The subset of `PiRuntimeAgentDefinitionDescriptor` (`@nessy-agent/shared`)
 * this writer reads.
 *
 * Structural, and duplicated here for the same reason {@link CodexPermissionMode}
 * is: this adapter is a dep-free leaf and importing shared would close a
 * shared -> adapter cycle. It is deliberately a SUBSET rather than a copy —
 * every field a descriptor carries and this interface omits is a field codex
 * has no way to express, and the omission is the record of that.
 */
export interface CodexAgentRoleDescriptor {
  /** Fully qualified definition key, unique within a session. */
  key: string;
  /** The author's own `name` frontmatter. */
  name: string;
  /** True when this definition owns the unqualified `name` in this session. */
  selectedAsUnqualifiedAlias: boolean;
  description: string;
  systemPrompt: string;
  model?: string;
  effort?: CodexThinkingLevel;
  /**
   * P6.550 — the definition's declared model TIER, honoured through codex's own
   * per-role `config_file` layer.
   *
   * Structural, like every other field here: the object the caller passes is the
   * full `PiRuntimeAgentDefinitionDescriptor`, so declaring the field is the
   * whole of "threading it across the writer boundary" — no call site changes.
   *
   * `AgentTier` in `@nessy-agent/shared` (`agents/definitions.ts`) is exactly
   * these three, validated at parse time; duplicated here for the dep-free-leaf
   * reason the interface's own docblock gives.
   */
  tier?: CodexAgentTier;
  tools?: readonly string[];
  disallowedTools?: readonly string[];
  permissionMode?: CodexPermissionMode;
}

/** `AgentTier` from `@nessy-agent/shared`, duplicated for the dep-free-leaf reason. */
export type CodexAgentTier = 'small' | 'medium' | 'big';

/** One `[agents.<roleName>]` declaration plus the role file it points at. */
export interface CodexAgentRole {
  /** `[agents.<roleName>]` key, the role file's `name`, and its basename. */
  roleName: string;
  /** `[agents.<roleName>].description`. */
  description: string;
  /** Absolute path of the role's own config layer, inside CODEX_HOME. */
  configFile: string;
  /** Complete TOML text of that config layer. */
  configFileToml: string;
}

export interface CodexAgentRolePlan {
  roles: readonly CodexAgentRole[];
  /** One line per denied or narrowed declaration, for `onDiagnostic`. */
  diagnostics: readonly string[];
  /**
   * P3.337 — the definitions that produced NO role at all, separated from the
   * ones that were merely narrowed.
   *
   * `diagnostics` mixes the two: a dropped `model` leaves the role standing and
   * a denied tool grant removes it, and a reader cannot tell which from the
   * prose. The user-facing notice must name only the second kind — an agent the
   * model cannot spawn on this runtime and can on the other two — so the
   * distinction is recorded here rather than re-derived from a string.
   */
  denied: ReadonlyArray<{ key: string; reason: string }>;
  /**
   * P6.485 — the roles that WERE declared while their tool grant was not
   * honoured.
   *
   * A third state, separate from `denied` and from an ordinary narrowing,
   * because it is the only one where the model gets MORE than the definition
   * asked for: codex has no per-role tool policy, so a declared role runs with
   * the parent session's whole surface. It has its own array so the operator
   * notice can name it without parsing prose back out of `diagnostics` — the
   * same reason `denied` exists.
   */
  unhonouredToolGrants: ReadonlyArray<{ key: string; roleName: string }>;
}

export interface CodexMcpServerSpec {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
/**
 * `AskForApproval` in the release `config-schema.json` — the values this writer
 * may EMIT, which is now a strict subset of the values codex's WIRE enum still
 * carries.
 *
 * `on-failure` was REMOVED upstream in `rust-v0.143.0` (`#28418 chore(core) rm
 * AskForApproval::OnFailure`) and `granular` added, so a config carrying
 * `on-failure` no longer validates. `granular` is the OBJECT variant and was
 * unemittable until P6.224 — not because codex refused it, but because our own
 * `validateConfigAgainstSchema` flattened the `oneOf` to its string enums and so
 * did not list it as acceptable. That blocker was ours. It is emittable now,
 * paired with {@link CodexConfigOptions.granularApproval}; nothing SELECTS it
 * yet, because which categories a Nessy session would auto-reject is an owner
 * posture and not this writer's to choose.
 *
 * ## `untrusted` is GONE from this union, and it is not a tidy-up
 *
 * Upstream #39630 retired it, and the retirement is asymmetric in a way that is
 * easy to read backwards. The WIRE enum
 * (`packages/codex-protocol/generated/v2/AskForApproval.ts`) is BYTE-IDENTICAL
 * across the lift and still carries `"untrusted"` — so a reader who checks the
 * generated bindings concludes nothing moved. The release `config-schema.json`
 * tells the other half: its `AskForApproval` went from four members to three
 * and `untrusted` is the one that left. The variant survives for codex's own
 * INTERNAL use — `protocol/src/protocol.rs` renames it `UnlessTrusted` and
 * documents it as *"Internal policy for projects marked untrusted"*, and
 * `core/src/config/mod.rs` still selects it when `active_project.is_untrusted()`
 * — while the same file refuses it from a public config outright.
 *
 * DRIVEN on the shipped `rust-v0.150.1` binary, 2026-09-11, three arms:
 * `approval_policy = "on-request"` starts normally; `= "untrusted"` makes the
 * app-server **exit 1 before it answers `initialize`**, with one stderr line —
 * `Error: approval_policy = "untrusted" is no longer supported; remove this
 * setting` (`UnsupportedUntrustedApprovalPolicyError`); and a value that never
 * existed (`= "nessy-not-a-policy"`) is the control that shows the difference —
 * it starts fine, emits `configWarning` "Invalid configuration; using defaults."
 * and the serde error even LISTS `untrusted` among the accepted variants,
 * because the serde enum still has it and a purpose-built check rejects it
 * afterwards. So this is not an unknown value degrading quietly; it is a
 * dedicated, fatal refusal, and it is worse than every failure mode this
 * writer's drift guards were built for: the session never starts.
 *
 * Keeping it out of the union is the cheapest possible guard — a caller that
 * tries to emit it stops compiling — which is the level this belongs at, given
 * that the schema validator alone would have caught it only at run time and the
 * generated wire type says the opposite.
 */
export type CodexApprovalPolicy = 'on-request' | 'granular' | 'never';

/**
 * P6.224 — `GranularApprovalConfig`, typed from the release schema rather than
 * from prose.
 *
 * The schema's own words, verbatim: "Fine-grained controls for individual
 * approval flows. When a field is `true`, commands in that category are allowed.
 * When it is `false`, those requests are automatically rejected instead of shown
 * to the user."
 *
 * **Read that twice before choosing a value.** `false` does NOT mean "ask" — it
 * means the request is refused without ever reaching a person. So a category set
 * `false` is a silent denial, which is why this type exists and no default for
 * it does.
 *
 * Requiredness is the schema's: `mcp_elicitations`, `rules` and
 * `sandbox_approval` are in `required`; `request_permissions` and
 * `skill_approval` carry `"default": false` and are optional. The two optional
 * ones are therefore omitted when unset rather than written as `false` — writing
 * codex's own default back would look like a choice.
 */
export interface CodexGranularApprovalConfig {
  /**
   * "Whether to allow shell command approval requests, including inline
   * `with_additional_permissions` and `require_escalated` requests."
   */
  sandbox_approval: boolean;
  /** "Whether to allow prompts triggered by execpolicy `prompt` rules." */
  rules: boolean;
  /** "Whether to allow MCP elicitation prompts." */
  mcp_elicitations: boolean;
  /** "Whether to allow prompts triggered by the `request_permissions` tool." (default false) */
  request_permissions?: boolean;
  /** "Whether to allow approval prompts triggered by skill script execution." (default false) */
  skill_approval?: boolean;
}
/**
 * `ApprovalsReviewer` in the release `config-schema.json` — who an escalated
 * approval is routed to for review. Codex's default is `user` (never emitted,
 * it IS the default); the only value we ever SET is `auto_review`, codex's
 * native guardian-subagent reviewer. The legacy spelling `guardian_subagent` is
 * accepted by the schema but never emitted here.
 */
export type CodexApprovalsReviewer = 'auto_review';
/**
 * Nessy permission mode (internal keys). Mirrors `PermissionMode` in
 * `@nessy-agent/shared` — duplicated locally so this dep-free
 * adapter leaf need not import shared (avoids the shared → adapter cycle).
 */
export type CodexPermissionMode = 'dontAsk' | 'plan' | 'default' | 'acceptEdits' | 'auto' | 'bypassPermissions';

export type CodexThinkingLevel = 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
/**
 * P6.31 — the wire spelling codex accepts for `model_reasoning_effort`.
 *
 * This type used to stop at `high`, and the cap was OURS, not codex's. Read at
 * `openai/codex` @ `rust-v0.148.0` — the tag shipped when this was read —
 * `codex-rs/protocol/src/openai_models.rs`:
 *
 *   `pub enum ReasoningEffort { None, Minimal, Low, Medium, High, XHigh, Max,
 *   Ultra, Custom(String) }`, whose `as_str` spells `XHigh` as `"xhigh"` and
 *   `Max` as `"max"`, and whose `FromStr` accepts both by name. `FromStr` errors
 *   on EXACTLY ONE input — the empty string ("reasoning_effort must not be
 *   empty") — and turns every other unrecognised value into `Custom(effort)`.
 *
 * Three corroborating measurements, because a widen that spawn-fails is worse
 * than the downgrade it replaces:
 *
 *  1. **Config load cannot reject it.** `codex-rs/config/src/config_toml.rs`
 *     declares `pub model_reasoning_effort: Option<ReasoningEffort>`, so the TOML
 *     is parsed through that same total `FromStr`.
 *  2. **The release schema is an open string, not an enum.** `ReasoningEffort` in
 *     `packages/codex-protocol/schema/config-schema.json` is
 *     `{"description": "A non-empty reasoning effort value advertised by the
 *     model.", "minLength": 1, "type": "string"}` — no `enum`, no `oneOf` — so
 *     {@link validateConfigAgainstSchema}'s `enumOf('ReasoningEffort')` is empty
 *     and its membership check is a no-op. (It stays in place: if upstream ever
 *     closes the enum, that guard is what catches it before spawn.)
 *  3. **The request path does not narrow it either.** `codex-rs/core/src/client.rs`
 *     `build_reasoning` puts the effort straight into `Reasoning { effort }` via
 *     `reasoning_effort_for_request`, which rewrites only `Ultra -> Max` and
 *     passes everything else through. Nothing compares it to the model's
 *     advertised `ReasoningEffortPreset` list.
 *
 * The ledger recorded a blocker — "whether any gateway model advertises `xhigh`;
 * a blind widen could turn a silent downgrade into a spawn failure". MEASURED
 * AND REFUTED on our own side: this config only ever points codex at the
 * loopback adapter (`[model_providers.<CODEX_PROVIDER_KEY>] base_url =
 * http://127.0.0.1:<port>/v1`), and `to-chat.ts` translates Responses -> Chat
 * Completions with no `reasoning` member in `ResponsesRequest` and no `effort`
 * anywhere in `toChatRequest` (positive control: `max_output_tokens` IS
 * forwarded, as `max_tokens`). The effort therefore never reaches a gateway
 * model at all — it is consumed by codex locally.
 */
export type CodexReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * Nessy's six thinking levels -> codex's `model_reasoning_effort`.
 *
 * `xhigh` and `max` both used to land on `high`, so two of the six levels were
 * indistinguishable from the third on every codex turn and on every role file
 * {@link codexAgentRolesFor} writes. They are now themselves.
 *
 * `off -> none` (P3.226) is the decision the note above deferred, taken with the
 * source read and ONE of the row's two premises refuted.
 *
 *  - **The variant is real and reachable.** `protocol/src/openai_models.rs:45`
 *    declares `None` as the first `ReasoningEffort` variant and `as_str` spells
 *    it `"none"` (`:62`). The release schema types the key as an open string
 *    (`minLength: 1`), and `FromStr` rejects only the empty string, so `"none"`
 *    is accepted by the same total parser measurement 3 above describes.
 *  - **The row's COST claim does not survive.** It said a user who turned
 *    thinking off "is still billed for minimal reasoning on every codex turn".
 *    Measured on our side, the effort reaches no model at all: codex puts it in
 *    `Reasoning { effort }` on the Responses body it sends to the loopback
 *    adapter, and every codex upstream this fork has goes through
 *    `to-chat.ts::toChatRequest`, whose `ChatRequest` has no reasoning member
 *    (positive control: `max_output_tokens` IS carried, as `max_tokens`). The
 *    third upstream kind, `anthropic-messages`, is REFUSED for codex bodies by
 *    `postChat` outright. So nothing is billed differently either way.
 *
 * It is changed anyway, and the reason is legibility rather than money: the
 * config file, `codex/thread.reasoningEffort` in telemetry, and every role file
 * {@link codexAgentRolesFor} writes all said `minimal` for a user who chose OFF,
 * and `minimal` is a REAL level three of the six map to distinctly. The one
 * thing that made this a behaviour decision — cost — is measured absent, and the
 * one thing that would make it a risk is measured absent too: nothing in codex
 * branches on `Minimal` versus `None` (both variants appear in the whole tree
 * only in their own declaration plus one test fixture and one `unwrap_or`), and
 * the `supported_reasoning_levels` narrowing in `core/src/session/review.rs:53`
 * is guarded by `!used_fallback_model_metadata` — which our slug always is.
 */
// Exported for P6.365: `turn/start` carries codex's own per-turn `effort`
// override, and it must be the SAME table `model_reasoning_effort` is written
// from. A second copy in the agent would be two spellings of one mapping.
export const REASONING_EFFORT: Record<CodexThinkingLevel, CodexReasoningEffort> = {
  off: 'none',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
};

/** The two knobs codex's own config has for a permission mode. */
export interface CodexSandboxConfig {
  sandbox_mode: CodexSandboxMode;
  approval_policy: CodexApprovalPolicy;
}

/**
 * R5 — the CODEX COLUMN of the one mode vocabulary, whole, in one literal.
 *
 * The user sees one set of permission modes on every runtime (owner decision
 * 2026-08-16; a per-runtime vocabulary was rejected because a mode states user
 * INTENT, which does not change when the runtime under it does). Each runtime
 * translates that one set: Pi by identity (the vocabulary is Pi's and the
 * pre-tool-use gate IS the translation), Claude through
 * `CLAUDE_SDK_PERMISSION_MODE_TABLE`, and codex through this table.
 *
 * Blueprint §12: `bypassPermissions` deliberately keeps `on-request` — Nessy's
 * PolicyEngine stays the product-level gate on top of the codex sandbox; we
 * never map to codex's `danger-full-access` (admin/dev-gated, out of scope) —
 * UNLESS the T1 (2026-08-12) `sandboxGloballyEnabled` master switch is off,
 * which deliberately supersedes that "never" FOR THE SANDBOX KNOB ONLY
 * (category string `deviation: codex-danger-full-access-when-sandbox-off`).
 * §12's actual concern — the approval loop staying Nessy-gated — is what the
 * `approval_policy` column carries. That column is carried through untouched in
 * both switch positions, with the one exception R13 measured and fixed: `never`
 * IS the absence of an approval loop, so a `never` row degrades to `untrusted`
 * when the switch takes away the sandbox that made it safe.
 *
 * **§12's premise about `on-request` survives only while the sandbox bounds it,
 * and P2.197 measured where it stops.** "The approval loop staying Nessy-gated"
 * is not what `on-request` delivers: for a call the model does not itself
 * escalate it sends us nothing at all. Under `read-only` and `workspace-write`
 * that costs nothing, because codex's own sandbox refuses the call natively;
 * under `danger-full-access` with no permission profile nothing refuses it (a
 * real session always writes one — D1.357, F1.693). So `on-request` degrades
 * the same way `never` does — see {@link UNBOUNDED_ON_REQUEST_DEGRADES_TO}.
 *
 * ## WHAT THIS TABLE CANNOT EXPRESS, said rather than approximated
 *
 * Codex has two knobs and we have six modes (seven until F1.1050 retired `explore`), so the map is not injective.
 * Measured 2026-08-16 over all seven modes of the day, both switch positions:
 *
 * - master switch ON — three distinct configs; `plan` shared its pair with the
 *   retired `explore` (both `read-only`/`on-request`), and
 *   `{default, acceptEdits, auto, bypassPermissions}` all
 *   `workspace-write`/`on-request`. Only `dontAsk` is alone. THIS TABLE IS THE
 *   SWITCH-ON PAIRING and P2.197 left every row of it byte-unchanged.
 * - master switch OFF (the shipped default since 2026-08-12) — the table is no
 *   longer what is emitted: {@link codexSandboxConfigForMode} degrades the
 *   policy as well as the sandbox. `dontAsk`'s `never` became `untrusted` at
 *   R13; P2.197 (2026-09-03) does the same to `on-request` for every mode
 *   except `bypassPermissions`, for the same reason and on measured evidence,
 *   and **P6.61 (2026-09-05) removed that exception** once the answer path
 *   gained a mode answer. So ONE config remains off the switch: all seven modes
 *   on `danger-full-access`/`untrusted`, i.e. everything routes to us and the
 *   floors run in every mode.
 *
 * The two groups fail in opposite directions, and the difference is the whole
 * reason this is written down rather than left implied. `plan` (and the retired
 * `explore` before F1.1050) sits on the STRICTER end (`read-only`, so it loses
 * the session data-folder writes it grants on Pi) — a narrowing, and safe.
 * `{default, acceptEdits, auto, bypassPermissions}` collapse onto the LOOSER
 * end WITH THE SWITCH ON: all four emit the same `workspace-write`/`on-request`
 * pair, so nothing in the configuration distinguishes "ask me first" from "ask
 * about nothing" — the two ends of that group. With the switch off — the
 * shipped default — P2.197 split that group three-to-one and P6.61 closed the
 * split: the four now emit one policy, and what tells them apart is our own
 * answer path, where `bypassPermissions` answers YES with no card unless a floor
 * fired.
 *
 * Stated at the strength it is actually proven: what is measured here is that
 * the four emit an IDENTICAL config and that our answer path does not tell them
 * apart either (below). What `on-request` then DOES was left open here — "a
 * live record elsewhere (2026-08-11 MCP follow-ups) has a card appearing under
 * `on-request` even in `bypassPermissions`" — and P2.197 settled it by driving
 * the binary. Both readings survive and they are about different calls: a card
 * does appear for a `sandbox_permissions: "require_escalated"` call, i.e. one
 * the MODEL chose to raise; for a call the model does not raise there is no
 * card and no request at all, in any sandbox mode. See
 * {@link UNBOUNDED_ON_REQUEST_DEGRADES_TO}.
 *
 * The comments this table replaced said Nessy stays the gate, which was the
 * design intent. **It is not what the code does, and R5 measured that rather
 * than assuming it:** the codex path has no `runPreToolUseChecks` (R6's
 * measurement), and the one mode-sensitive call on its answer path —
 * `shouldAllowToolInMode`, inside `CodexAgent.consultPermissionRules` — returns
 * the identical result for all four of those modes for every probe tried, while
 * returning a different one for `plan` (the positive control). So on codex those
 * four modes are indistinguishable today in the config AND in our answer. The
 * tripwire is `permission-mode-runtime-translations.test.ts`; the fix belongs on
 * the answer path (`codex-agent.ts`), which is outside R5's zone.
 */
export const CODEX_PERMISSION_MODE_TABLE: Readonly<Record<CodexPermissionMode, Readonly<CodexSandboxConfig>>> =
  Object.freeze({
    // Don't ask: `never` is codex's own "failures are immediately returned to
    // the model", the one policy consistent with a mode that must not prompt,
    // and read-only keeps the sandbox fail-closed. The pair is load-bearing
    // TOGETHER — `never` is only safe because `read-only` bounds it; R13 enforces
    // that when the master switch removes the bound, and F1.1056 keeps the
    // profile's `:read-only` parent off the switch too (`codexModeKeepsReadOnlyParent`,
    // `config-writer-permissions.ts`). This row is the switch-ON pairing, unchanged.
    dontAsk: Object.freeze({ sandbox_mode: 'read-only', approval_policy: 'never' }),
    // F1.1050: the retired `explore` had the same pair as plan here; its row
    // left with the mode (a stored `explore` is read as `plan` upstream).
    //
    // Plan: codex's Read Only preset (`utils/approval-presets`). F1.1056 read codex's own PLAN
    // COLLABORATION mode (`ModeKind` "plan") too: a prompt-level persona on `turn/start`, not a
    // sandbox, and not sent today (F1.788). The data and plans writes ride `write` keys (F1.1003).
    plan: Object.freeze({ sandbox_mode: 'read-only', approval_policy: 'on-request' }),
    // Manual (`default`): codex's Default preset. No emittable policy asks before an in-workspace edit (F1.1056).
    default: Object.freeze({ sandbox_mode: 'workspace-write', approval_policy: 'on-request' }),
    // Accept edits: codex's Default preset — it also runs every sandboxed command, not only file commands.
    acceptEdits: Object.freeze({ sandbox_mode: 'workspace-write', approval_policy: 'on-request' }),
    // Auto: codex's classifier is its `auto_review` reviewer, when the operator turns it on (P3.2).
    auto: Object.freeze({ sandbox_mode: 'workspace-write', approval_policy: 'on-request' }),
    // Bypass permissions: never codex's Full Access preset (§12 above); the host answers yes (P6.61).
    bypassPermissions: Object.freeze({ sandbox_mode: 'workspace-write', approval_policy: 'on-request' }),
  });

/**
 * **P2.197 — with nothing bounding it, `on-request` is not a weak gate but no
 * gate at all; measured on the shipped binary, and degraded like `never`.**
 *
 * `docs/superpowers/plans/2026-08-22-runtime-parity-closure.md`, row P2.197,
 * decided by the owner on 2026-09-02 (§A1(a)): *"Forbid `on-request` where a
 * non-negotiable floor exists — measure the seven values on the binary first."*
 *
 * ## What was measured, by DRIVING the shipped binary
 *
 * The row's own instruction was "drive it, do not read the schema — this
 * subsystem has been wrong from reading three times". So: the bundled
 * `codex-app-server` (`rust-v0.148.0`, darwin-arm64, macOS 26.6.2), one turn per
 * row over a stub Responses adapter returning one `exec_command` call with NO
 * `sandbox_permissions: "require_escalated"` (the model asks for no escalation:
 * the row's whole case), NO permission profile; per row `echo <tag>` (read-only
 * safe) and `touch ~/<tag>` (outside every root), two runs agreeing on every cell.
 *
 * | `sandbox_mode` / `approval_policy` | approvals for `echo` | approvals for `touch ~/…` | the write |
 * | --- | --- | --- | --- |
 * | `read-only` / `on-request` | 0 | **0** | refused by codex, never asked |
 * | `workspace-write` / `on-request` | 0 | **0** | refused by codex, never asked |
 * | `danger-full-access` / `on-request` | 0 | **0** | **SUCCEEDED — file written to `$HOME`** |
 * | `read-only` / `untrusted` | 0 | **1** | on accept, succeeded |
 * | `workspace-write` / `untrusted` | 0 | **1** | on accept, succeeded |
 * | `danger-full-access` / `untrusted` | 0 | **1** | on accept, succeeded |
 *
 * The `echo` column is the rig's positive control: under `untrusted` a read-only
 * safe command is auto-approved (0) and the write is not (1) — `is_safe_command()`
 * as its schema line says. `on-request` asked about NOTHING, in any sandbox mode,
 * even where codex refused the write itself and returned the failure to the model.
 * **"On accept, succeeded" is this no-profile rig's reading (F1.720):** every real
 * session writes the `nessy_runtime` profile (D1.357), and on it F1.693 drove an
 * ACCEPTED `require_escalated` shell write (`rust-v0.156.1`, switch off and on) —
 * the OS refused it where the no-profile control wrote. An accepted `apply_patch`
 * still lands (codex applies it outside the profile): F1.693's host-side floor.
 *
 * ## Why the fix is a DEGRADATION and not a table edit
 *
 * Read the first three rows again. Under `read-only` and `workspace-write`,
 * `on-request` costing us the approval request costs the floor NOTHING: the
 * territory our removal breaker protects (`~`, `/`) is outside both sandboxes,
 * so codex refuses the command natively — native-first working. Under
 * `danger-full-access` with no profile nothing refuses it, and the same policy
 * becomes the single loosest configuration this product ships.
 *
 * **That is R13's sentence, word for word, about a different policy.** R13
 * degraded `never` to `untrusted` when the master switch took away the sandbox
 * that made `never` safe ({@link UNBOUNDED_NEVER_DEGRADES_TO}). `on-request`
 * unbounded is the same combination — no sandbox and, measured, no approval
 * channel — so it degrades the same way, in the same function, keyed off the
 * same condition. {@link CODEX_PERMISSION_MODE_TABLE} is therefore byte-
 * unchanged, and every switch-ON behaviour with it.
 *
 * ## Where a non-negotiable floor "exists": all seven modes
 *
 * `findNonNegotiableFloors` gates two of its four floors on
 * `protectedPathOutcome(mode) !== 'allow'` (the protected-path write and the
 * shell-`eval` construct), which is false only in `bypassPermissions`. The
 * other two — the root/home removal circuit breaker and the `Remove-Item`
 * ladder — carry no mode gate at all. So every mode in the vocabulary,
 * `bypassPermissions` included, has at least one floor that an unbounded
 * `on-request` prevents from ever running.
 *
 * ## THE SET IS EMPTY NOW — P6.61 met the exit condition written here
 *
 * `bypassPermissions` used to be the one member, and the reason was real while
 * it lasted: `untrusted` routes every non-`is_safe_command` call to
 * `CodexAgent.handleServerRequest`, whose no-rule path ended at a card, and that
 * path had NO mode-answer to end it earlier — `bypassPermissions` occurred
 * **0** times in `codex-agent.ts` (positive controls in the same file at that
 * commit: `dontAsk` 13, `getPermissionMode` 12), and `shouldAllowToolInMode` is
 * consulted only INSIDE `consultPermissionRules`, i.e. only once a user rule has
 * already matched. Degrading the mode then would have carded every non-read-only
 * command in the one mode whose own `modeGuidance` line is *"full autonomy, no
 * approval prompts; everything runs freely"* — replacing a missing gate with a
 * false sentence. The stated cost was that its two unconditional floors, the
 * removal circuit breaker and the `Remove-Item` ladder, never ran.
 *
 * The exit condition this docblock named was *"the moment `handleServerRequest`
 * can answer from the mode before it reaches the card"*. It can:
 * `codex-agent.ts` now answers `bypassPermissions` YES, with no card, at the
 * point after the rule consult and before the card — and only when NO floor
 * fired. So all four gates that could refuse still refuse (a `deny` floor
 * returns far above, a `prompt` floor falls through to the card, a `deny` rule
 * returns on its own), while the ordinary `touch`/`echo` the mode's sentence is
 * about is answered with zero approval cards. The mode keeps its promise AND
 * its floors run, which is why nothing is excluded any more.
 *
 * `permission-modes.md` still scopes that mode to *"isolated environments like
 * containers or VMs"*, and that is unchanged by any of this.
 *
 * ## What the degradation costs where it landed, said plainly
 *
 * In `acceptEdits` and `auto` a mutation that Pi's and Claude's classifier
 * would auto-run now reaches a card on codex, because codex's native low-risk
 * set is read-only-only. Those two lines therefore keep the half of their
 * guidance that promises prompts ("shell, network, and MCP mutations still
 * prompt") and put the other half at risk ("file edits auto-accept",
 * "low-risk actions auto-run"). **Whether a codex FILE EDIT prompts under
 * `untrusted` was NOT measurable on this rig**: an `apply_patch` arm produced
 * no tool call, no approval request and no exec item in all four
 * configurations, i.e. no positive control, so it proves nothing and is
 * recorded as unmeasured rather than as evidence. The direction of the risk is
 * toward firing, which is this plan's standing tie-break.
 */
export const CODEX_MODES_KEEPING_ON_REQUEST_UNBOUNDED: ReadonlySet<CodexPermissionMode> =
  Object.freeze(new Set<CodexPermissionMode>());

/**
 * The approval policy an `on-request` row degrades to once nothing bounds it.
 *
 * Same value and the same reason as {@link UNBOUNDED_NEVER_DEGRADES_TO}, which
 * carries the whole account: the policy R13 and P2.197 chose was retired
 * upstream, no remaining public value routes an ordinary command to us with the
 * sandbox off, and this is now a degradation with a STATED residue rather than
 * a fix. See {@link CODEX_MODES_KEEPING_ON_REQUEST_UNBOUNDED} and
 * {@link CODEX_UNBOUNDED_APPROVAL_NOTICE}.
 */
const UNBOUNDED_ON_REQUEST_DEGRADES_TO: CodexApprovalPolicy = 'on-request';

/**
 * The approval policy a `never` row degrades to once nothing bounds it.
 *
 * R13 — `never` is a safe policy only while a sandbox stands behind it, and the
 * T1 master switch removes exactly that. Carrying `never` through produced the
 * single loosest configuration this product ships: no sandbox AND no approval
 * channel, so `CodexAgent.handleServerRequest` never fires and the user's own
 * permission rules are never consulted. `dontAsk` — the STRICTEST mode in the
 * vocabulary — meant allow-everything on codex while its own description told
 * the user it "denies everything else".
 *
 * ## What this used to be, and why it cannot be that any more (P7.2, 2026-09-11)
 *
 * R13 and P2.197 both landed on `untrusted`, because of the three public
 * policies only it stated a routing GUARANTEE — the release schema's own words
 * were *"only \"known safe\" commands … that **only read files** are
 * auto-approved. Everything else will ask the user to approve"*, against
 * `on-request`'s *"The model decides when to ask the user for approval"*.
 * P2.197 turned that reading into a measurement: an unbounded `on-request` sent
 * zero approval requests across three sandbox modes while `untrusted` sent one
 * for the same write.
 *
 * **`untrusted` is no longer emittable.** Upstream #39630 retired it from the
 * public config at `rust-v0.150.1` and the refusal is FATAL — the shipped
 * binary exits 1 before answering `initialize`, so every codex session this
 * product starts with the sandbox master switch off would have failed to start
 * at all. {@link CodexApprovalPolicy} carries the three-arm drive and the
 * wire-versus-config asymmetry that makes the retirement easy to read backwards.
 *
 * ## The replacement was READ, not chosen, and there isn't one
 *
 * Asked of the source at the tag rather than of the remaining names. In
 * `core/src/exec_policy.rs`, for a non-dangerous command under an UNRESTRICTED
 * filesystem sandbox — which is exactly the `danger-full-access` state this
 * branch produces — the decision table is: `Never` → `Allow`, `OnRequest` →
 * `Allow`, `Granular(_)` → `Allow` (its own comment: *"Mirror on-request
 * behavior for unmatched commands"*), and `UnlessTrusted` → `Prompt`. So
 * `granular`, the one option that did not exist when R13 was written, is NOT a
 * successor: with the sandbox off it is `on-request` under another name. **No
 * public `approval_policy` value routes an ordinary command to our approval
 * bridge once the sandbox is gone.** The behaviour survives only behind PROJECT
 * TRUST — `core/src/config/mod.rs` still selects `UnlessTrusted` when
 * `active_project.is_untrusted()` — and reaching it that way would mean
 * asserting a trust state we do not mean, which upstream also uses to withhold
 * project-level `AGENTS.md` (release note, `rust-v0.150.0`). That is a product
 * posture, not a writer's call, and it is filed as a row.
 *
 * So this degrades to `on-request` — which is literally what codex's own error
 * tells an operator to do, since removing the setting falls through to
 * `AskForApproval::default()`, which is `OnRequest` — and the residue is made
 * AUDIBLE rather than silent: {@link CODEX_UNBOUNDED_APPROVAL_NOTICE} is
 * reported once per config write, because a floor that stopped running and says
 * nothing is the defect R13 existed to prevent, and it has come back by
 * upstream's hand rather than ours.
 *
 * What survives of the old contract: `dontAsk` is still strictly stricter than
 * its siblings by the OTHER half of its contract — `handleServerRequest` denies
 * what no rule pre-approves — for every request that does reach us. What does
 * not survive: with the sandbox off, ordinary commands no longer produce such a
 * request at all.
 */
const UNBOUNDED_NEVER_DEGRADES_TO: CodexApprovalPolicy = 'on-request';

/**
 * D1.358 — the machine prefix both approval-posture notices are stamped with,
 * and the ONLY reason the operator ever sees either of them.
 *
 * `CodexAgent` binds `writeCodexConfig`'s `onDiagnostic` to `debug` AND to
 * `noteCodexConfigWriterDiagnostic`, which lifts a message onto
 * `surfaceCodexOperatorNotice` — the queue a packaged build actually shows — only
 * when it starts with one of the prefixes that method lists. Until this constant
 * the two notices below carried none, the only config-writer diagnostics in that
 * state, so the posture reached `debug` and `debug` writes nothing on a packaged
 * build (P3.120's finding, and AGENTS.md's *"an empty packaged `main.log` is not
 * evidence"*). The POSITIVE CONTROL is on the same `writeCodexConfig` call: the
 * egress line starts `codex-sandbox-egress-denied:` and has been lifted since
 * P3.267.
 *
 * ONE prefix for both arms, where the execpolicy pair took two: those two
 * describe different FACTS (a grant that lost its sandbox, a grant that kept
 * it), while these two are one fact — this session's approval posture — in the
 * two states it can be in, and a reader filtering the channel wants both or
 * neither. The eight-notice ceiling is the other half of that argument: two
 * prefixes would have been two slots on a queue P3.267 deliberately refused to
 * widen.
 *
 * The prefix is VISIBLE to the operator, because the queue pushes the message
 * verbatim — the same as every lifted sibling, so this is the house shape.
 *
 * EXPORTED rather than restated, which its four siblings are not: they are
 * inline template literals and `noteCodexConfigWriterDiagnostic`'s docblock
 * records the restatement as a known cost —*"exporting them and importing them
 * is strictly better and is a one-line change in a file another lane holds this
 * wave"*. That lane released the file, so the sixth is imported; converting the
 * other five is a separate tidy and is not done here, because each one would
 * move a formatter this row has no reading on.
 */
export const CODEX_APPROVAL_POSTURE_PREFIX = 'codex-approval-posture: ';

/**
 * The one line an operator gets when the sandbox master switch has removed both
 * the OS wrap and — since `rust-v0.150.1` — the approval channel that used to
 * stand in for it.
 *
 * Transparent-and-simple, in the owner's sense: the narrow honest mechanism is a
 * sentence naming what stopped, beside the two nouns a reader can act on. The
 * alternative shapes were both worse. Saying nothing reproduces the exact defect
 * R13 was written for, with the added insult that nothing in this repo caused
 * it. Refusing to start a codex session unsandboxed would be a product posture
 * taken by a config writer.
 *
 * ## The posture was put to the owner and confirmed (QX4 = A, 2026-09-11)
 *
 * This is a degradation with a stated residue rather than a fix, so it was asked
 * rather than kept as a writer's choice: keep `on-request` plus this notice, or
 * build a host-side replacement for the routing `untrusted` used to give us on
 * top of `granular`. The owner answered **A on 2026-09-11** — codex publishes no
 * stricter posture any more, and a host replacement would be a second source of
 * truth for the sandbox. No behaviour changes with this record; it exists so the
 * next reader meets a decision instead of an open question.
 *
 * ## The two flip points a later reader must watch for
 *
 * 1. **A codex tag that republishes a policy routing ordinary commands to the
 *    client.** The whole basis of this notice is the decision table read at
 *    `rust-v0.150.1` (quoted in full on {@link UNBOUNDED_NEVER_DEGRADES_TO}):
 *    under an unrestricted filesystem sandbox every emittable approval policy
 *    answers `Allow` for a non-dangerous command. Re-read `core/src/exec_policy.rs`
 *    at each codex lift — the day one emittable value answers `Prompt` there, that
 *    value replaces `on-request` in {@link UNBOUNDED_ON_REQUEST_DEGRADES_TO} and
 *    {@link UNBOUNDED_NEVER_DEGRADES_TO}, and this notice retires with it.
 * 2. **A product decision to turn the sandbox master switch back on.** This notice
 *    lives only on the unbounded branch of {@link codexSandboxConfigForMode}; with
 *    the OS wrap back the mode table is bounded again and the floor returns with no
 *    change here.
 *
 * NOT a flip point, and not a way to shortcut either of them: the PROJECT-TRUST
 * route. `core/src/config/mod.rs` still selects `UnlessTrusted` when the active
 * project is untrusted, so the old routing is reachable by declaring the user's
 * project untrusted — which would mean asserting a trust state we do not mean, and
 * which upstream also reads as a reason to withhold project-level guidance files.
 * That is a product posture filed as a row of its own, not a config writer's call.
 *
 * ## D1.357 — THIS IS THE NO-PROFILE ARM, AND NO REAL SESSION IS EVER IN IT
 *
 * The sentence below says *no OS sandbox*. Measured 2026-09-18 on `rust-v0.154.0`,
 * that is FALSE for every session this product starts, and it was reaching all of
 * them: {@link formatCodexUnboundedApprovalDiagnostics} gated on the master switch
 * ALONE, so with the switch off it fired in both arms — 7 modes x 2, one line each.
 *
 * Every real session emits a permission profile, because the protected-folder floor
 * lives in it (C3.343; F1.1071: the credential floor F1.1057 removed no longer does):
 * every production site that builds a codex config passes `protectedWorkspaceSubpaths`
 * (`shared/agent/codex-agent.ts` `codexProtectedWorkspaceSubpaths`: `.git` and the other
 * protected folders as `read` entries), so the config a real session writes carries
 * `default_permissions = "nessy_runtime"` and `extends = ":workspace"` — read off the
 * emitted TOML, with the minimum-options call as the control, which carries neither.
 * The ONLY caller that reaches the no-profile arm is `codex-agent-server/src/spike.ts`,
 * a developer spike.
 *
 * And `extends = ":workspace"` is not decoration; WI-az drove it (ten `apply_patch`
 * arms plus four shell arms, one variable at a time, `on-request` throughout):
 * with the profile, `sandbox_mode = "danger-full-access"` REFUSED `touch ~/<tag>`
 * with `Operation not permitted`, `exitCode 1`, nothing written, and an
 * out-of-workspace `apply_patch` raised `item/fileChange/requestApproval` (answered
 * `accept`, the same arm applied it); WITHOUT the profile both wrote, reproducing
 * P2.197's row 3 as the control, with `echo` returning its output as the positive
 * control that the sandboxed arm is not simply failing everything.
 *
 * So this constant keeps ITS OWN case — no profile — unchanged, and the case every
 * user is in gets {@link CODEX_BOUNDED_APPROVAL_NOTICE}. The same defect and the
 * same repair as the sibling egress line (P6.149): keyed on the RESOLVED policy
 * rather than on the mode we wrote. Before it, one `writeCodexConfig` call emitted
 * both `codex-sandbox-egress-denied: sandbox_mode="workspace-write" (this session's
 * config text says sandbox_mode="danger-full-access" …)` and this notice's *no OS
 * sandbox* — two lines of the same write contradicting each other.
 */
export const CODEX_UNBOUNDED_APPROVAL_NOTICE = CODEX_APPROVAL_POSTURE_PREFIX
  + 'Codex is running with no OS sandbox and no approval channel for ordinary commands: '
  + 'codex retired the `untrusted` approval policy in rust-v0.150.1 (upstream #39630), and of the '
  + 'values it still accepts none routes a non-dangerous command to this app for approval once the '
  + 'sandbox is off. Dangerous commands and sandbox-escalation requests still reach you; an ordinary '
  + 'shell command no longer does. Turn the sandbox master switch back on to restore the floor.';

/**
 * D1.357 — the same line for the case every real session is actually in: the
 * master switch is off, AND a permission profile bounds the session anyway.
 *
 * ## Why a line at all, rather than silence
 *
 * The residue P7.2 made audible is still real and is the LAST clause here: an
 * ordinary command INSIDE the writable roots reaches no approval channel, so the
 * host floors get no subject there. What was wrong was never that a line is
 * emitted — it was that the line described a session nobody has. Silence would
 * re-create the P7.2 defect; the old wording tells an operator their home
 * directory is open when it is not, which is worse than both.
 *
 * ## What each clause is, and what measured it (2026-09-18, `rust-v0.154.0`)
 *
 *  - *the profile supersedes `sandbox_mode`* — codex's own precedence, already
 *    recorded twice in this tree from two directions: the egress line's P6.149
 *    block ({@link formatCodexSandboxEgressDiagnostics}) and
 *    `CodexAgent.noteResolvedSandboxPolicy`, which reads the binary's OWN answer
 *    per session and says the same thing (measured at `rust-v0.148.0`, both
 *    directions).
 *  - *bounded to the workspace plus `$TMPDIR` and `/tmp`* — `:workspace` grants
 *    those two by codex's own documented defaults: `SandboxWorkspaceWrite`'s
 *    `exclude_tmpdir_env_var` and `exclude_slash_tmp` are both `"default": false`
 *    in the pinned release's `config-schema.json`. This is stated rather than
 *    fixed: `exclude_tmpdir_env_var = true` would refuse the `mktemp` every
 *    ordinary build step does.
 *  - *plus any directory you added* — why the sentence names the user's own
 *    grants rather than stopping at the three roots above: every entry of
 *    `writablePaths` becomes a `filesystem` write key of the SAME profile
 *    (`resolveCodexRuntimePathPolicy`), filled from `codexAdditionalWritableRoots`.
 *    A line promising "the workspace" flat would be read as a guarantee by the
 *    one reader who had already widened it themselves.
 *  - *a file change outside those roots raises an approval* — driven: the arm
 *    answered `decline` left the file at its pre-image, the same arm answered
 *    `accept` applied it.
 *  - *a shell command outside them is refused by the OS with no card* — driven:
 *    `touch ~/<tag>` came back `Operation not permitted`, `exitCode 1`, nothing
 *    written, where the no-profile arm wrote it.
 *  - *an ordinary command inside them reaches no approval channel* — unchanged
 *    from {@link CODEX_UNBOUNDED_APPROVAL_NOTICE}, and the reason is on
 *    {@link UNBOUNDED_NEVER_DEGRADES_TO}: under an unrestricted filesystem sandbox
 *    codex's own decision table answers `Allow` for every public approval policy
 *    that remains since `untrusted` was retired at `rust-v0.150.1`.
 *
 * ## The flip points are the SAME TWO as its sibling, plus one of its own
 *
 * A tag whose `core/src/exec_policy.rs` answers `Prompt` for a non-dangerous
 * command retires BOTH notices; the sandbox master switch coming back on retires
 * both. The third is this line's alone: the day the host stops writing the
 * protected-folder floor into a permission profile, every session falls back to the
 * sibling's case, which is exactly what the shared gate below expresses.
 *
 * NOT localized, and that is the house shape rather than an omission:
 * `@nessy-agent/codex-responses-adapter` imports nothing but `node:*` and its own
 * two siblings, and every diagnostic this writer emits is a plain English string
 * on the `onDiagnostic` sink.
 *
 * ## Where an operator meets it
 *
 * `writeCodexConfig` hands the line to `onDiagnostic`, which `CodexAgent` binds
 * to `debug` AND to `noteCodexConfigWriterDiagnostic`; that lift is keyed on the
 * machine prefixes the formatters stamp, and D1.358 gave this pair theirs —
 * {@link CODEX_APPROVAL_POSTURE_PREFIX}, whose docblock carries the whole
 * account. Until that prefix existed both notices reached the developer log and
 * nothing else, which is what this paragraph said when it was written.
 */
export const CODEX_BOUNDED_APPROVAL_NOTICE = CODEX_APPROVAL_POSTURE_PREFIX
  + 'Codex is sandboxed by its permission profile rather than by the sandbox_mode line: this session '
  + 'writes `default_permissions = "nessy_runtime"` (`extends = ":workspace"`) to keep .git and the other '
  + 'protected folders read-only, and codex resolves that ahead of `sandbox_mode = "danger-full-access"` in the same file. '
  + 'So writes are bounded to the workspace plus $TMPDIR, /tmp (codex\'s own defaults — '
  + '`exclude_tmpdir_env_var` and `exclude_slash_tmp` are both false) and any directory you added to '
  + 'this workspace, a file change outside those '
  + 'roots raises an approval you answer, and a shell command outside them is refused by the OS '
  + '("Operation not permitted") with no card at all. What reaches no approval channel is an ordinary '
  + 'command INSIDE those roots: codex retired the `untrusted` approval policy in rust-v0.150.1 '
  + '(upstream #39630) and none of the values it still accepts routes a non-dangerous command to this '
  + 'app. Measured on rust-v0.154.0, 2026-09-18.';

/**
 * Map a Nessy permission mode to Codex's two sandbox knobs — one read of
 * {@link CODEX_PERMISSION_MODE_TABLE}, plus the T1 master-switch override.
 */
export function codexSandboxConfigForMode(
  mode: CodexPermissionMode,
  sandboxGloballyEnabled = true,
): CodexSandboxConfig {
  const mapped = CODEX_PERMISSION_MODE_TABLE[mode];
  if (!sandboxGloballyEnabled) {
    // The OS wrap goes, and with it the bound that made `never` safe — so a
    // `never` row degrades to a policy that still routes to us (R13). Keyed off
    // the POLICY rather than off `dontAsk`, because the defect is "no sandbox
    // and no approval channel", not that one mode's name.
    //
    // P2.197 — and `on-request` is the SAME defect wearing a different name.
    // Measured on the shipped binary, an unbounded `on-request` sends us no
    // approval request at all for a call the model does not itself escalate, so
    // no non-negotiable floor can run. It degrades to the same policy, for the
    // same reason. One mode is excluded and the exclusion is a stated posture,
    // not an oversight: {@link CODEX_MODES_KEEPING_ON_REQUEST_UNBOUNDED}.
    return {
      sandbox_mode: 'danger-full-access',
      approval_policy: degradeUnboundedApprovalPolicy(mode, mapped.approval_policy),
    };
  }
  return { ...mapped };
}

/**
 * The two unbounded degradations, in one place so neither can drift from the
 * other: `never` (R13) and `on-request` (P2.197) both mean "no approval channel"
 * once the sandbox is gone, and both land on `untrusted`.
 */
function degradeUnboundedApprovalPolicy(
  mode: CodexPermissionMode,
  policy: CodexApprovalPolicy,
): CodexApprovalPolicy {
  if (policy === 'never') return UNBOUNDED_NEVER_DEGRADES_TO;
  if (policy === 'on-request' && !CODEX_MODES_KEEPING_ON_REQUEST_UNBOUNDED.has(mode)) {
    return UNBOUNDED_ON_REQUEST_DEGRADES_TO;
  }
  return policy;
}

/**
 * Escape one token for an execpolicy rules file's double-quoted string.
 *
 * The bundled `codex-app-server`'s execpolicy parser (`execpolicy/src/parser.rs`,
 * `execpolicy/src/rule.rs`) reads `prefix_rule(pattern=[...], decision="allow")`,
 * where every pattern element is a double-quoted string. Command argv rarely
 * carries a quote or a backslash, but a token that does must not break out of
 * its string or inject a rule, so `\` and `"` are escaped and any control
 * character (a token can never legitimately contain one) is `\u`-escaped — the
 * same fail-closed posture {@link tomlString} takes for the same reason.
 */
function execpolicyString(value: string): string {
  let escaped = '';
  for (const char of value) {
    if (char === '\\') { escaped += '\\\\'; continue; }
    if (char === '"') { escaped += '\\"'; continue; }
    const code = char.codePointAt(0)!;
    escaped += code <= 0x1f || code === 0x7f
      ? `\\u${code.toString(16).padStart(4, '0')}`
      : char;
  }
  return '"' + escaped + '"';
}

/**
 * Project durable allow- and deny-prefixes into execpolicy `prefix_rule` lines.
 *
 * One line per prefix: `prefix_rule(pattern=["git", "status"], decision=
 * "allow")` — the exact form the bundled binary both emits ("prefix_rule(pattern="
 * … ", decision=\"allow\")") and parses. Each prefix is an `ExecPolicyAmendment`
 * (`Array<string>`): "The `command` tokens form the prefix that would be added
 * as an execpolicy `prefix_rule(..., decision=\"allow\")`, letting the agent
 * bypass approval for commands that start with this token sequence."
 *
 * A prefix with no non-empty token is dropped rather than emitted as an empty
 * pattern — the binary rejects those ("rules prefix_rule at index … has an empty
 * pattern"), which would fail the whole file to load. Returns `''` when nothing
 * projects, so the caller writes no file at all.
 */
export function buildCodexExecpolicyRules(
  prefixes: readonly (readonly string[])[],
  denyPrefixes: readonly (readonly string[])[] = [],
  promptPrefixes: readonly (readonly string[])[] = [],
): string {
  const lines: string[] = [];
  const emit = (
    list: readonly (readonly string[])[],
    decision: 'forbidden' | 'prompt' | 'allow',
    justify?: (tokens: readonly string[]) => string,
  ) => {
    for (const prefix of list) {
      const tokens = prefix.filter((token): token is string => typeof token === 'string' && token.length > 0);
      if (tokens.length === 0) continue;
      lines.push(
        `prefix_rule(pattern=[${tokens.map(execpolicyString).join(', ')}], decision="${decision}"`
        + (justify ? `, justification=${execpolicyString(justify(tokens))}` : '')
        + ')',
      );
    }
  };
  // FORBIDDEN FIRST, then PROMPT, then ALLOW — presentation only: codex
  // "applies the most restrictive decision when more than one rule matches
  // (`forbidden` > `prompt` > `allow`)"
  // (`learn.chatgpt.com/docs/agent-configuration/rules.md#understand-rule-fields`,
  // `:60` on the 2026-08-25 fetch), and the
  // source is the authority for that sentence: `Evaluation::from_matches`
  // (`execpolicy/src/policy.rs`, `rust-v0.150.1`) takes `.max()` over the
  // matched decisions and `Decision` derives `Ord` in the declaration order
  // `Allow < Prompt < Forbidden`. So the file's order cannot change an outcome;
  // it is written this way so a human reading it sees the refusals first.
  // P3.82 · AND THE SPELLING IS LOAD-BEARING BEYOND PRECEDENCE. A prefix rule
  // spelled `allow` is MODEL-CONDITIONAL — `AllowPrefixRules::IgnoreForCyberModel`
  // rebuilds the policy dropping every `PrefixRule` with `decision ==
  // Decision::Allow` and keeping all the others
  // (`core/src/exec_policy/model_policy.rs`, `current_for_prefix_rules` and the
  // `is_allow_prefix` filter inside it, `rust-v0.150.1`). So these two
  // lines survive on every model and the third does not. A refusal or an
  // escalation must therefore NEVER be projected as an allow, however
  // convenient: it would inherit the same silent per-model disappearance, in the
  // one direction where disappearing is not fail-safe.
  emit(denyPrefixes, 'forbidden', tokens => `${DENY_JUSTIFICATION_LEAD} ${tokens.join(' ')}`);
  emit(promptPrefixes, 'prompt', tokens => `${PROMPT_JUSTIFICATION_LEAD} ${tokens.join(' ')}`);
  // The grants carry NO justification: it is rendered only on a refusal or a
  // prompt (`derive_forbidden_reason` / `derive_prompt_reason`,
  // `core/exec_policy.rs`), so on an allow it is text nobody ever reads.
  //
  // P3.80 · EVERY LINE EMITTED HERE ALSO REMOVES THE SANDBOX for its prefix.
  // Not a property of how we spell the rule — `decision="allow"` is the only
  // spelling of a grant execpolicy has — but of what codex does with it:
  // `Decision::Allow => Skip { bypass_sandbox: … }`, and the flag is true
  // exactly when an explicit rule matched every segment
  // (`core/src/exec_policy.rs`, the `Decision::Allow => ExecApprovalRequirement::Skip`
  // arm, `rust-v0.150.1`). The full chain, the
  // decision to accept it and the one condition that suppresses it are on
  // {@link CodexConfigOptions.execpolicyAllowPrefixes}.
  emit(prefixes, 'allow');
  return lines.length > 0 ? lines.join('\n') + '\n' : '';
}

/**
 * What codex says when one of OUR projected rules is the thing that refused or
 * asked — P6.1's second half, taken natively rather than reconstructed.
 *
 * `prefix_rule` accepts a `justification` (`execpolicy/src/parser.rs`,
 * `rust-v0.148.0`; it must be non-empty or the whole file fails to parse), and
 * codex renders it into the two sentences a person and the model actually see
 * (`core/exec_policy.rs`):
 *   - forbidden: "`<cmd>` rejected: <justification>"
 *   - prompt:    "`<cmd>` requires approval: <justification>"
 * Without one it falls back to "policy forbids commands starting with `<prefix>`"
 * and "requires approval by policy" — true, but they attribute the decision to
 * codex's own policy, so a user meeting it has no way to know it came from a
 * rule they wrote here, still less where to change it.
 *
 * Measured on the shipped `codex-app-server` (darwin-arm64, `rust-v0.148.0`)
 * through the real `CODEX_HOME` boot: `decision="prompt"`, and `justification=`
 * on both `prompt` and `forbidden`, load with NO `configWarning`, against the
 * same rig's positive control where `decision="nonsense"` reports
 * `error: invalid decision: nonsense`.
 *
 * ## Naming WHICH rule, without threading an id anywhere
 *
 * The first cut of this said only the mechanism and the tier, and recorded the
 * follow-up as "an id would have to be threaded through all three collectors in
 * `permissions-config.ts` and through every caller". That premise was wrong in
 * the useful direction: the thing a user needs in order to FIND the rule is not
 * an id they have never seen, it is the rule's own prefix — and this function
 * already holds it, because the prefix IS the projected rule. So the
 * justification is built per line from the tokens being emitted, and nothing
 * upstream changes.
 *
 * codex renders the command it refused, which is the SPECIFIC call
 * (`rm -rf ./build`); the justification renders the PREFIX, which is the rule
 * (`rm -rf`). Those are different facts, and a user with a dozen deny rules
 * needs the second to know which line to edit. The full sentence a person sees:
 * "``rm -rf ./build`` rejected: blocked by the Nessy permission rule: deny rm -rf".
 *
 * WHAT IT STILL DOES NOT SAY: which SCOPE the rule came from — a project file, a
 * workspace file or a durable grant all render identically, because the
 * collectors flatten them into one list before this function sees them. That one
 * really would need threading, and it is a smaller loss: a prefix is unique
 * enough to search for across all of them.
 *
 * A rules file that fails to parse fails OPEN and WHOLE-FILE, so the longer
 * string is not free of risk and was not assumed: `config-warning-live.test.ts`
 * boots the shipped binary on a home this writer produced and asserts no
 * `configWarning`, with a `decision="nonsense"` arm as the positive control.
 */
const DENY_JUSTIFICATION_LEAD = 'blocked by the Nessy permission rule: deny';
const PROMPT_JUSTIFICATION_LEAD = 'approval required by the Nessy permission rule: ask';

/**
 * P3.267 · the machine-readable PREFIX each user-facing config-writer diagnostic
 * stamps, exported so the one consumer that has to recognise them does not have
 * to restate them.
 *
 * These three families describe what THIS SESSION can and cannot do — no egress,
 * and whether a durable Always-Allow grant also leaves the sandbox — so
 * `codex-agent.ts` lifts them out of the diagnostic stream onto the operator
 * notice surface a packaged build actually shows. It matched them on its own
 * copy of these literals, pinned against real formatter output; a rename here
 * would have failed that pin rather than turning the lift off silently, which is
 * the right failure but a needless one. With these exported there is one
 * definition and no pin to keep.
 *
 * The prefixes are part of the emitted STRING, so they are interpolated into the
 * messages below rather than written twice — a constant nobody uses is exactly
 * the drift this export exists to remove.
 *
 * Exported by W2-t as a hand-off; the switch-over in `codex-agent.ts` is W2-s's.
 */
export const CODEX_EXECPOLICY_GRANT_SANDBOX_RETAINED_PREFIX = 'codex-execpolicy-grant-sandbox-retained:';
export const CODEX_EXECPOLICY_GRANT_UNSANDBOXED_PREFIX = 'codex-execpolicy-grant-unsandboxed:';
export const CODEX_SANDBOX_EGRESS_DENIED_PREFIX = 'codex-sandbox-egress-denied:';

/**
 * Every prefix above, as the set a consumer filters the diagnostic stream by.
 *
 * Derived from the three constants rather than retyped, so a family added here
 * reaches the consumer without anyone remembering to widen a second list.
 */
export const CODEX_CONFIG_WRITER_USER_FACING_PREFIXES = [
  CODEX_SANDBOX_EGRESS_DENIED_PREFIX,
  CODEX_EXECPOLICY_GRANT_UNSANDBOXED_PREFIX,
  CODEX_EXECPOLICY_GRANT_SANDBOX_RETAINED_PREFIX,
] as const;
/**
 * Name the SECOND thing a durable Always-Allow grant does — P3.80's transparency
 * half, the part the click never said.
 *
 * The mechanism, its source citations and the decision to accept it are on
 * {@link CodexConfigOptions.execpolicyAllowPrefixes}; this function only reports
 * which of the two states a given home is actually in, because the answer is a
 * property of the SESSION and not of the projection. It mirrors codex's own
 * predicate rather than restating it: `unsandboxed_execution_allowed`
 * (`core/src/tools/sandboxing.rs`, `rust-v0.150.1` — byte-identical at the
 * cited lines across the lift, and cited by symbol anyway) is
 * `!policy.has_denied_read_restrictions()`, and that is
 * `kind == Restricted && any entry access == Deny`
 * (`protocol/src/permissions.rs:469-480`). Both halves are readable from here:
 * every `'deny'` value in {@link resolveRuntimePolicy}'s filesystem map is one of
 * those entries, and `sandbox_mode = "danger-full-access"` is the one mode that
 * builds a NON-`Restricted` policy (`permissions.rs:1320`,
 * `SandboxPolicy::DangerFullAccess => FileSystemSandboxPolicy::unrestricted()`).
 *
 * Three states, two lines, and the third is deliberately silent:
 *  - grants projected, no denied-read entry, a restricting `sandbox_mode` — the
 *    bypass BITES, and that is the line worth reading;
 *  - grants projected, at least one denied-read entry — codex refuses the bypass
 *    and the grant is prompt-only, which is the reassuring half and is reported
 *    so a reader can tell the two apart rather than assuming the bad one;
 *  - `danger-full-access` — there is no sandbox for a grant to remove, so a
 *    warning here would be noise attached to the wrong cause.
 *
 * Emitted on the same sink and at the same cadence as P3.175's dropped-floor
 * lines: once per `writeCodexConfig`, so a signature hash or a schema check
 * cannot repeat it.
 */
export function formatCodexExecpolicyGrantSandboxDiagnostics(opts: Pick<
  CodexConfigOptions,
  'execpolicyAllowPrefixes' | 'mode' | 'sandboxMode' | 'sandboxGloballyEnabled'
  | 'deniedReadPaths' | 'deniedReadPatterns' | 'writablePaths' | 'shellEnvironment'
>): string[] {
  // Counted the way `buildCodexExecpolicyRules` counts: a prefix whose every
  // token is blank projects no rule, so it grants nothing and unsandboxes
  // nothing. A diagnostic that disagreed with the file it describes would be
  // worse than none.
  const granted = (opts.execpolicyAllowPrefixes ?? []).filter(prefix =>
    prefix.some(token => typeof token === 'string' && token.length > 0)).length;
  if (granted === 0) return [];
  const derived = opts.mode ? codexSandboxConfigForMode(opts.mode, opts.sandboxGloballyEnabled ?? true) : undefined;
  const sandboxMode = derived?.sandbox_mode ?? opts.sandboxMode ?? 'workspace-write';
  if (sandboxMode === 'danger-full-access') return [];
  const policy = resolveRuntimePolicy(opts);
  // P3.175 · the workspace-scoped globs are denied-read entries too. codex's
  // `has_denied_read_restrictions` counts every compiled entry whose access is
  // `Deny`, and a `:workspace_roots` deny glob compiles to exactly that
  // (`FileSystemPath::GlobPattern` + `FileSystemAccessMode::Deny`). Counting only
  // the flat map would report "no denied-read entry" for a session that has nine,
  // and this function's whole job is to say which of the two states holds.
  const deniedEntries = Object.values(policy.filesystem).filter(access => access === 'deny').length
    + policy.workspaceDenyGlobs.length;
  const grants = `${granted} durable Always-Allow prefix${granted === 1 ? '' : 'es'}`;
  return deniedEntries > 0
    ? [`${CODEX_EXECPOLICY_GRANT_SANDBOX_RETAINED_PREFIX} ${grants} in ${CODEX_RULES_FILE} skip the approval prompt but stay`
      + ` sandboxed — ${deniedEntries} denied-read entr${deniedEntries === 1 ? 'y' : 'ies'} make codex refuse the`
      + ' bypass (unsandboxed_execution_allowed, rust-v0.150.1)']
    : [`${CODEX_EXECPOLICY_GRANT_UNSANDBOXED_PREFIX} ${grants} in ${CODEX_RULES_FILE} also run OUTSIDE the`
      + ` sandbox_mode="${sandboxMode}" sandbox, not only without a prompt — an execpolicy allow resolves to`
      + ' Skip{bypass_sandbox} (core/src/exec_policy.rs, rust-v0.150.1). No denied-read entry is present to'
      + ' suppress it'];
}

/**
 * P2.384 — the one line that says a sandboxed codex session has no egress, and
 * the record of the two native switches that were measured and NOT written.
 *
 * ## The state this describes
 *
 * With the sandbox master switch ON, {@link codexSandboxConfigForMode} emits
 * `read-only` or `workspace-write`, and the seatbelt profile the shipped
 * `codex-app-server` builds is `(deny default)` plus an allowlist whose only
 * network entries are `(allow network-outbound (remote ip "*:53"))` and
 * `(remote ip "localhost:*")`. DNS and loopback survive; everything else dies.
 * That is why the failure a user is handed reads as a NAME-RESOLUTION fault
 * rather than as "no network" — the resolver answers, the connection does not.
 *
 * ## Why neither native switch is written (measured, `rust-v0.148.0`)
 *
 * Native-first asks whether the runtime already has the mechanism and we merely
 * never enabled it. codex has two candidates. Both were read from
 * `github.com/openai/codex` at the tag our binary is built from and confirmed
 * against the bundled `darwin-arm64/codex-app-server` by string probe (control
 * `zzz_not_a_real_feature_key` = 0 on the same scan). Neither is adoptable:
 *
 * **1. `[features] network_proxy` — backwards.** `Feature::NetworkProxy`
 * (`features/src/lib.rs`) is `Stage::Experimental`, `default_enabled: false`,
 * and its own registry text is "Apply network proxy restrictions to sandboxed
 * sessions that **already have network access**" (3 hits in the binary). The
 * gate is `core/src/config/mod.rs`: `if enable_network_proxy &&
 * permission_profile.network_sandbox_policy().is_enabled()`. `NetworkSandboxPolicy`
 * (`protocol/src/permissions.rs`) is `Restricted | Enabled` with `#[default]
 * Restricted`, and a `read-only`/`workspace-write` config with no
 * `network_access` lands on `Restricted`. So in the exact state this diagnostic
 * describes the block never runs — enabling it is a NO-OP. In the state where it
 * WOULD run — our shipped default, `danger-full-access`, network `Enabled` — it
 * starts a managed MITM proxy and begins DENYING egress that flows freely today.
 * codex says so itself, beside `profile_allows_configured_network_proxy`:
 * "`Disabled` means no outer sandbox, so starting the managed proxy would narrow
 * the override." Inert where it is needed, a regression where it is live.
 *
 * **2. `[features] request_permissions_tool` — the right mechanism, under
 * development.** codex's own escalation path for "I need network" is the
 * `request_permissions` tool: it surfaces as `item/permissions/requestApproval`
 * carrying `RequestPermissionProfile.network`
 * (`AdditionalNetworkPermissions { enabled }`), and
 * `codex-agent-server/src/approval-bridge.ts` ALREADY maps it to a card that
 * reads "network access" and grants `network` verbatim at `scope: "turn"`. The
 * bridge is complete; the doorbell is not installed. Registration is gated at
 * `core/src/tools/spec_plan.rs` on `features.enabled(Feature::RequestPermissionsTool)`,
 * whose spec is key `request_permissions_tool`, **`Stage::UnderDevelopment`,
 * `default_enabled: false`** — "still under development, not ready for external
 * use". Writing it emits a per-session `EventMsg::Warning`, "Under-development
 * features enabled … `suppress_unstable_features_warning = true`"
 * (`core/tests/suite/unstable_features_warning.rs`; both strings in the binary).
 * That warning reaches the client as `ServerNotification::Warning`, method
 * `"warning"`.
 *
 * **THE "CONSUMES IN ZERO FILES" CLAIM IS RETRACTED, AND THE INSTRUMENT IS
 * REPLACED (P3.271a, W3-c 2026-09-03) — the fix is the probe, not the sentence.**
 * This paragraph read *"which THIS REPO CONSUMES IN ZERO FILES (`case 'warning'`
 * and `case 'configWarning'` both score 0 across the codex event adapter and the
 * app-server client, against `case 'guardianWarning'` as the live control)"*.
 * Both channels are consumed, and the probe cannot ever say so: consumption is
 * an equality test against a NAMED CONSTANT, never a `case '…'` label, so
 * re-running it reports 0 forever. That is the false-absence shape P3.213 named,
 * living inside a comment — and the `guardianWarning` control made it look
 * sound, because that family really is switched on a literal (1 hit,
 * `backend/codex/event-adapter.ts`).
 *
 * The instrument that can answer, and its reading:
 *
 * ```sh
 * git grep -ac "CODEX_WARNING_METHOD|CODEX_CONFIG_WARNING_METHOD" -- ':(glob)packages/**'
 * ```
 *
 * `packages/codex-agent-server/src/server-warning.ts` declares
 * `CODEX_WARNING_METHOD = 'warning'`, `config-warning.ts` declares
 * `CODEX_CONFIG_WARNING_METHOD = 'configWarning'`, and at `7a8477690` the two
 * names are read in **five production files, 17 occurrences** —
 * `app-server-client.ts` (both, at the one point every server→client
 * notification passes through), `codex-agent.ts`, `index.ts`, and the two
 * declaring modules. P2.408 wired the plain `warning` channel deliberately, with
 * an operator-visible half deferred into `CodexAgent` because its one measured
 * class lands before any turn exists.
 *
 * So the argument this paragraph was making no longer rests on that ground: the
 * notice would be HEARD. Flipping the feature is still a product decision with a
 * prerequisite and still not a line in this file, but say so on the merits — an
 * under-development feature — and not on a silence that is not there.
 *
 * ## The audit-receipt answer, which is what decided the shape
 *
 * A network DENIAL verdict cannot reach us at all on the seatbelt path.
 * `record_network_sandbox_violation` (`sandboxing/src/violation.rs`) accepts only
 * a `BlockedRequest` from `SandboxViolationBackend::ManagedNetworkProxy`, and its
 * entire output is a `tracing::warn!` line inside the codex process — it is never
 * a protocol event. The seatbelt path cannot even produce one:
 * `classify_filesystem_sandbox_violation` classifies filesystem denials only, and
 * `SANDBOX_DENIED_KEYWORDS` carries no network needle. codex itself does not know
 * the network died.
 *
 * The ASK is receipted — `CommandExecutionRequestApprovalParams.networkApprovalContext`
 * plus `item/autoApprovalReview/{started,completed}` whose `action` is
 * `{type: "networkAccess", target, host, protocol, port}` with `review.status`
 * and `decisionSource` — and we consume the autoApprovalReview channel already,
 * reading `review` and dropping `action`. But every one of those frames requires
 * the managed proxy to be running, which requires network to already be enabled.
 *
 * `AGENTS.md`: an unauditable influence on permission outcomes is worse than an
 * absent one. So no mechanism is built beside codex's, because its verdict
 * cannot be audited; what is built is the SIGNAL that the state exists, on the
 * sink the other three writer diagnostics already use.
 *
 * Pure and cadence-matched to its siblings: one line at most, emitted once per
 * `writeCodexConfig`, never from the builders.
 */
export function formatCodexSandboxEgressDiagnostics(opts: Pick<
  CodexConfigOptions,
  'mode' | 'sandboxMode' | 'sandboxGloballyEnabled'
  | 'deniedReadPaths' | 'deniedReadPatterns' | 'writablePaths' | 'shellEnvironment'
>): string[] {
  // Derived exactly as `formatCodexExecpolicyGrantSandboxDiagnostics` derives
  // it, so the two lines can never disagree about which sandbox is in force.
  const derived = opts.mode ? codexSandboxConfigForMode(opts.mode, opts.sandboxGloballyEnabled ?? true) : undefined;
  const written = derived?.sandbox_mode ?? opts.sandboxMode ?? 'workspace-write';
  // P6.149 · KEYED ON THE RESOLVED POLICY, NOT ON THE MODE WE WROTE.
  //
  // This line used to return `[]` for `danger-full-access` on the reasoning that
  // there is no sandbox to lose egress to — and with the master switch OFF, the
  // shipped default since 2026-08-12, `codexSandboxConfigForMode` returns
  // exactly that for every mode. So the diagnostic was DEAD in the shipped
  // configuration, which is the one P2.323 drove `curl: (7)` in.
  //
  // The mode we write is not the policy that runs. P3.315/P3.327 measured the
  // precedence at HEAD: with the real credential floor
  // (`permissionsConfigCache.getMergedConfig(...).deniedPaths`, 19 entries)
  // `resolveCodexRuntimePathPolicy` yields 10 filesystem keys and 9 workspace
  // globs, so `hasCodexFilesystemPolicy` is TRUE and a
  // `[permissions.<profile>]` block is emitted for every real session — against
  // `false` for empty options, which is the control that makes it a reading —
  // and codex then resolves `workspaceWrite`, not `dangerFullAccess`. That is
  // the restricted state, and it is the state the shipped default is in.
  //
  // Keyed on the profile rather than on a restatement of today's precedence, so
  // it cannot go dead again the next time precedence moves: the day we stop
  // emitting a profile the line stops, which is correct, and the day the mode
  // table changes the line follows without an edit. `noteResolvedSandboxPolicy`
  // is the run-time half of the same idea — it reads codex's OWN answer — and
  // this is the write-time half, which has no answer to read yet.
  //
  // A policy that cannot be resolved decides nothing and keeps the pre-P6.149
  // reading: `resolveCodexRuntimePathPolicy` throws on a
  // `codex-runtime-path-policy-conflict`, and `writeCodexConfig` will fail on
  // that anyway two calls later — a pure formatter must not be the thing that
  // raises it.
  let supersededByProfile = false;
  try {
    supersededByProfile = written === 'danger-full-access'
      && hasCodexFilesystemPolicy(resolveRuntimePolicy(opts));
  } catch {
    supersededByProfile = false;
  }
  const sandboxMode = supersededByProfile ? (resolveRuntimePolicy(opts).permissionParent === ':read-only' ? 'read-only' : 'workspace-write') : written; // F1.787
  if (sandboxMode === 'danger-full-access') return [];
  // The supersession is NAMED when it happened. Without it the line would say
  // `sandbox_mode="workspace-write"` about a config whose text says
  // `danger-full-access`, and a reader who greps the file would conclude the
  // diagnostic is lying.
  const because = supersededByProfile
    ? ` (this session's config text says sandbox_mode="${written}", but the [permissions] profile this`
      + ` host emits for the protected folders supersedes it and codex resolves ${sandboxMode === 'read-only' ? 'readOnly' : 'workspaceWrite'} —`
      + ' `noteResolvedSandboxPolicy` reports the binary\'s own answer per session)'
    : '';
  return [`${CODEX_SANDBOX_EGRESS_DENIED_PREFIX} sandbox_mode="${sandboxMode}"${because} leaves the codex shell DNS (*:53) and`
    + ' localhost only, so a blocked connection surfaces as a name-resolution failure rather than as "no'
    + ' network". Neither native switch is written: [features] network_proxy only RESTRICTS a session that'
    + ' ALREADY has network (its gate needs network_sandbox_policy().is_enabled(), which is Restricted here),'
    + ' and [features] request_permissions_tool — the tool codex would use to ASK — is'
    + ' Stage::UnderDevelopment, default off (rust-v0.148.0)'];
}

/**
 * Directory inside CODEX_HOME holding one config layer per declared role.
 *
 * CODEX_HOME is the right home and not merely a convenient one: `CodexAgent`
 * mints it per runtime at 0700 outside every agent-writable root (F1.652; `$TMPDIR` only as the stated fallback) and
 * removes it with `rmSync(..., { recursive: true, force: true })` on every
 * teardown path, so a role file's lifetime is exactly the runtime's and nothing
 * else has to own its cleanup. A permission-mode change tears the whole home
 * down and rebuilds it, so these files are never stale either.
 */
export const CODEX_AGENT_ROLE_DIR = 'agent-roles';

/**
 * Directory inside CODEX_HOME holding the projected execpolicy rules.
 *
 * codex loads `rules/*.rules` under every active config layer, and the managed
 * per-session `CODEX_HOME` IS such a layer (the bundled `codex-app-server`
 * carries "`.rules files in `", "loaded rules from " and "failed to load rules:
 * "). Same lifetime discipline as {@link CODEX_AGENT_ROLE_DIR}: `CodexAgent`
 * mints CODEX_HOME with `mkdtempSync` and removes it on teardown, and a
 * permission-mode change tears the whole home down and rebuilds it — so the
 * projected rules are never stale, and are re-derived from the durable store on
 * every build.
 */
export const CODEX_RULES_DIR = 'rules';

/** Basename of the single projected rules file written under {@link CODEX_RULES_DIR}. */
export const CODEX_RULES_FILE = 'nessy.rules';

/**
 * Keys `AgentsToml` claims for itself. Everything else under `[agents.*]` is a
 * role (`config-schema.json`, `rust-v0.147.0`: `AgentsToml.additionalProperties
 * -> AgentRoleToml`), and `AgentsToml` has no `additionalProperties: false`, so
 * the two namespaces are shared. An agent named `enabled` is read as
 * `AgentsToml.enabled: boolean`, and the consequence is worse than a role that
 * fails to load. Measured 2026-08-13 against the bundled binary: the whole file
 * is discarded — `configWarning` "Invalid configuration; using defaults.",
 * `config.toml:3:1: invalid type: map, expected a boolean` — so the session
 * silently loses `model_provider`, `sandbox_mode`, `[permissions]` and every
 * `[mcp_servers.*]` block and runs on codex's own defaults. It starts, and it
 * starts pointed somewhere else. Every other malformation measured here (blank
 * `developer_instructions`, a `config_file` that does not exist) costs only the
 * one role, with its own named `configWarning`.
 *
 * (The earlier record of this hazard named `max_threads` and
 * `job_max_runtime_seconds`; neither exists in `rust-v0.147.0`. This list is
 * the schema's, read at the pinned version.)
 */
const CODEX_AGENTS_RESERVED_KEYS: ReadonlySet<string> = new Set([
  'default_subagent_model',
  'default_subagent_reasoning_effort',
  'enabled',
  'interrupt_message',
  'max_concurrent_threads_per_session',
  'max_depth',
]);

/**
 * `PERMISSION_MODE_ORDER` from `@nessy-agent/shared` (`agent/mode-types.ts`,
 * "THE POSITIONS ARE THE CLAMP'S INDEX"), least-to-most permissive. Duplicated
 * for the dep-free-leaf reason above; the POSITIONS are the clamp's index, so a
 * reordered entry here is a silent widening with no type error.
 *
 * EXPORTED BY R5 so that "with no type error" stops meaning "with no test
 * either". Nothing in the product reads it from outside this file; the shared
 * package's `permission-mode-runtime-translations.test.ts` asserts it element-
 * for-element against `PERMISSION_MODE_ORDER`, which is the only check that can
 * catch the drift this comment has always warned about.
 */
export const CODEX_PERMISSION_MODE_ORDER: readonly CodexPermissionMode[] = Object.freeze([
  'dontAsk', 'plan', 'default', 'acceptEdits', 'auto', 'bypassPermissions',
] as const);

/**
 * The name the model passes as `agent_type`, chosen by the SAME rule Pi
 * (`runtime-agent-definitions.ts`) and the Claude SDK builder
 * (`claude-runtime-agents.ts:agentNameOf`) apply, so one agent answers to one
 * name on all three runtimes.
 */
function codexRoleNameOf(descriptor: CodexAgentRoleDescriptor): string {
  return descriptor.selectedAsUnqualifiedAlias ? descriptor.name : descriptor.key;
}

/**
 * Reduce a definition name to a bare TOML key that is also a safe basename.
 *
 * Two jobs in one function, deliberately: `[agents.<key>]` has to parse, and
 * `<key>.toml` is joined onto CODEX_HOME, so a key carrying `/` or `..` would
 * be a path escape. Restricting to `[A-Za-z0-9_-]` settles both, and it keeps
 * the name typable as `spawn_agent`'s `agent_type`.
 */
function sanitizeCodexRoleName(name: string): string {
  return name.trim().replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
}

/**
 * Translate the session's agent definitions into codex `[agents.<role>]`
 * declarations plus one role config layer each.
 *
 * ## What the format can carry, verified against the pinned schema and binary
 *
 * `config-schema.json` (`rust-v0.147.0`): top-level `agents` -> `AgentsToml`,
 * whose `additionalProperties` is `AgentRoleToml`. `AgentRoleToml` is
 * `additionalProperties: false` over exactly three fields — `description`
 * ("Human-facing role documentation used in spawn tool guidance. Required
 * unless supplied by the referenced agent role file"), `config_file` ("Path to
 * a role-specific config layer. Relative paths are resolved relative to the
 * `config.toml` that defines them") and `nickname_candidates`.
 *
 * The role file's own contract is not in that schema; it is enforced by name in
 * `core/src/config/agent_roles.rs`, whose messages are in the bundled
 * `codex-app-server` verbatim: "agent role file at <path> must contain a TOML
 * table", "... must define a non-empty `name`", "agent role `<name>` must
 * define a description", "... must define `developer_instructions`", "agent
 * role file at <path>.developer_instructions cannot be blank". Hence the three
 * keys emitted below, and hence `description` never being left to default.
 *
 * `nickname_candidates` is deliberately never emitted. The same file validates
 * it four further ways ("must contain at least one name", "cannot contain blank
 * names", "cannot contain duplicates", "may only contain ASCII letters, digits,
 * spaces, hyphens, and underscores"), it is optional, and it buys nothing a
 * role name does not already give.
 *
 * ## What is denied by omission, and why never a widening
 *
 * A declaration codex cannot express is dropped WITH ITS AGENT and named on the
 * diagnostic channel — never silently, never fatally. That is the same posture
 * `pi-agent-server/src/orchestrator/runtime-agent-definitions.ts` takes for an
 * unresolvable tool grant, and it is stricter here for one reason: on Pi an
 * unresolvable entry narrows the agent, while on codex an unexpressible
 * RESTRICTION would WIDEN it, because a spawned codex agent otherwise inherits
 * its parent's whole tool surface ("The spawned agent will have the same tools
 * as you and the ability to spawn its own subagents", `spawn_agent`'s own tool
 * text in the bundled binary).
 *
 * - `tools` / `disallowedTools` — codex has no per-role tool allowlist. Its
 *   `ToolsToml` is three feature toggles (`web_search`, `update_plan`,
 *   `experimental_request_user_input`) and its per-server `enabled_tools` /
 *   `disabled_tools` reach MCP servers only; neither can express "this agent may
 *   use Read and Grep". Declaring the role anyway would hand a read-only agent
 *   `shell` and `apply_patch`. Denied.
 * - `permissionMode` stricter than the session's — a role config layer CAN
 *   carry `sandbox_mode`/`approval_policy`, but our session's write policy also
 *   lives in a named `[permissions.nessy_runtime]` profile whose `extends`
 *   parent is derived from the session sandbox mode, so a role that only
 *   lowered `sandbox_mode` would keep the workspace-write profile and not
 *   actually be read-only. Rather than ship a half-honoured restriction, an
 *   agent asking for less than the session gets is denied. (A role-scoped
 *   permission profile is the way to honour it; it is named in the plan, not
 *   built unproven.) A mode at or above the session's is clamped away by
 *   {@link clampCodexPermissionMode} and changes nothing, so it does not deny.
 * - `model` — dropped, and reported unless it is `inherit` or already the
 *   session model. One session drives ONE upstream through the loopback
 *   adapter, so a foreign model id can only fail at spawn ("Unknown model `X`
 *   for spawn_agent"). codex asks for the same behaviour in its own words:
 *   "sub-agents ... inherit your current model by default. Do not set the
 *   `model` field unless ...". The role therefore inherits, which is what the
 *   Claude side does with an unresolvable model too.
 * - `tier` was in the list below and is NOT any more (P6.550). It IS a field of
 *   {@link CodexAgentRoleDescriptor} now and it IS honoured, through the per-role
 *   `config_file` layer this builder already writes `model_reasoning_effort`
 *   into — see {@link resolveCodexRoleTierModel} for the two directions and the
 *   codex precedence rule they rest on. `CodexAgent.reportUnexpressibleCodexAgentFields`
 *   still names it among the unexpressible eight; that list is one hand-off
 *   behind this line and belongs to the file that owns it.
 * - `maxTurns`, `memory`, `background`, `color`, `skillKeys`,
 *   `mcpServerKeys`, `initialPrompt` — no codex counterpart and no authority to
 *   widen, so they are absent from {@link CodexAgentRoleDescriptor} entirely.
 *   They no longer cost NOTHING (P6.309 (2)): this writer still never receives
 *   them, and `CodexAgent.reportUnexpressibleCodexAgentFields` now names every
 *   definition that declares one, per definition on the diagnostic channel and
 *   once in aggregate on the operator queue — the same two-channel shape
 *   `isolation` took in the entry below, and for the same reason (the full
 *   definitions exist on exactly one side of this boundary and it is not this
 *   one). What is lost is real: `maxTurns` and `background` are BOUNDS an author
 *   asked for, `memory` a per-child store Pi and the claude SDK both provide,
 *   and `skillKeys`/`mcpServerKeys` the child's declared surface — whose fuller
 *   answers are P6.309 (1) and P6.342.
 * - `isolation` was in that list and is NOT any more (P3.301, `f717d95d3`). It
 *   is still absent from {@link CodexAgentRoleDescriptor}, so this writer still
 *   never receives it and still reports nothing — but it no longer costs
 *   NOTHING: `CodexAgent.reportDroppedCodexAgentIsolation` now names every
 *   definition that declares it, on the diagnostic channel, in the same wording
 *   as the three siblings above. The report had to move there because the full
 *   definitions exist on exactly one side of this boundary and it is not this
 *   one. What is lost is real — `isolation: worktree` is an author's request
 *   that the subagent run against a scratch checkout, which Pi honours and the
 *   claude SDK accepts — so the same definition edits a throwaway worktree on
 *   two runtimes and the real repository on the third, and until P3.301 nothing
 *   said so. Grouping it with the silent seven read as completeness and was the
 *   opposite.
 */
/**
 * P6.485 — the role names this writer declares on codex EVEN THOUGH their tool
 * grant cannot be honoured. Owner decision 2026-09-05, Q17 option (b).
 *
 * ## Why this is a set of names and not a predicate
 *
 * There is no provenance on {@link CodexAgentRoleDescriptor} — a bundled role
 * and a user's `.claude/agents/*.md` arrive at this writer identically — so the
 * exception cannot be derived. Naming it is the narrowest form available and the
 * one a reviewer can check at a glance, which is what "narrow, reasoned
 * exception" has to mean when the general rule stays fail-closed.
 *
 * ## Why `reviewer` and nothing else, today
 *
 * `/code-review` was ALREADY spawning an agent with the parent session's full
 * tools on codex — an unnamed one, because the deny removed the declaration and
 * not the spawn. So the deny preserved a restriction nobody was enforcing
 * (option (a), declined) at the cost of the one agent name that exists on all
 * three runtimes. Declaring it changes what the model is TOLD, not what it can
 * do.
 *
 * ## What a name in here costs, so the next addition is deliberate
 *
 * The role runs with `shell` and `apply_patch` — the binary's own `spawn_agent`
 * text is "The spawned agent will have the same tools as you" — and the only
 * thing standing between that and a write is
 * {@link CODEX_READ_ONLY_ROLE_OBLIGATION}, which is prose a model may ignore.
 * Add a name here only for a role WE bundle, whose restriction is read-only, and
 * whose absence costs a user-visible capability. A user-authored definition
 * never belongs here: for that one, denying is the fail-closed answer and stays.
 *
 * The structural residue, stated rather than implied: codex has no per-role tool
 * allowlist AT ALL. `AgentRoleToml` is `description`, `config_file`,
 * `nickname_candidates` with `additionalProperties: false`, and no member of the
 * `*PermissionToml` family carries a `Tool*` field. So option (c) — a
 * `[permissions.<role>]` layer — could not express it either, which is why the
 * owner left it for a later row that proves a non-writing codex reviewer is
 * load-bearing.
 */
const CODEX_ROLES_DECLARED_DESPITE_UNHONOURABLE_TOOL_GRANT: ReadonlySet<string> = new Set([
  'reviewer',
]);

/**
 * P6.485 — the read-only obligation, prepended to a role file's
 * `developer_instructions` when the declaration went through without its tool
 * grant.
 *
 * Prose, because prose is the only carrier codex offers: `AgentRoleToml` has no
 * tool member and neither does any `*PermissionToml`. It is written as an
 * instruction the model is accountable to rather than as a note about our
 * plumbing — a sentence beginning "this runtime cannot…" reads as an excuse, and
 * the thing that has to change is the model's behaviour.
 *
 * It names the tools explicitly. The model is not told which tools it has, so
 * "do not modify anything" leaves it to work out that `shell` counts; naming
 * `shell` and `apply_patch` removes that step.
 */
const CODEX_READ_ONLY_ROLE_OBLIGATION = [
  'READ-ONLY OBLIGATION — this is a constraint on you, not a description of your tools.',
  'You have been given the same tools as the agent that spawned you, including `shell` and',
  '`apply_patch`. You must not use them to change anything: do not create, edit, move or delete',
  'a file, do not run a command that writes, installs or mutates state, and do not commit, push',
  'or amend. Read, search and run read-only commands freely. Report what you find, and propose',
  'changes in prose for the caller to apply.',
].join(' ');

/**
 * P6.550 — the model a declared TIER asks for, or `undefined` when there is
 * nothing for the role layer to say.
 *
 * ## Why this is expressible at all
 *
 * The reading that per-role model selection is STRUCTURAL on codex is refuted by
 * `model_reasoning_effort`, which this builder already writes into a role's own
 * `config_file` layer: the layer is a Config layer and accepts root-level keys,
 * `model` among them. So a tier is threaded, not built.
 *
 * ## Why it is silent without a distinct cheap model
 *
 * `cheapSubagentModel` is the caller's `defaultSubagentModel`, which the host
 * passes ONLY when the connection has a mini model distinct from the session
 * model (`getMiniModel(connection) ?? defaultModel`, omitted when equal). With
 * no distinct cheap model there is exactly one model on this connection, so
 * every tier resolves to it and writing the key would restate codex's own
 * documented default — *"Spawned agents inherit your current model by default"*.
 *
 * ## Why the NON-cheap tiers get a key too, which is the half a reader misses
 *
 * When a distinct cheap model exists the caller also writes the GLOBAL
 * `[agents] default_subagent_model`, and that moves EVERY spawned role onto the
 * cheap model together. A role declaring `medium` or `big` would then silently
 * run cheap — the declaration inverted rather than merely dropped.
 *
 * ## The precedence this rests on, READ FROM THE SOURCE at `rust-v0.148.0`
 *
 * `core/src/tools/handlers/multi_agents/spawn.rs` calls
 * `apply_requested_spawn_agent_model_overrides` FIRST — that is the step which
 * folds in `turn.config.agent_default_subagent_model`
 * (`multi_agents_common.rs`) — and `apply_spawn_agent_role` SECOND. The role
 * layer then decides, key by key: `core/src/agent/role.rs`'s
 * `build_next_config` opens with
 * `let preserve_current_model = role_layer_toml.get("model").is_none();`, so a
 * role layer carrying `model` OVERRIDES the global default, and a layer without
 * it PRESERVES whatever the global default just chose. Both halves of the rule
 * below are that one line, in its two directions. (`apply_role_to_config`'s own
 * docstring: *"The role layer is inserted at session-flag precedence so it can
 * override persisted config"*.)
 *
 * One consequence worth having written down: the role-layer path sets
 * `config.model` directly and does NOT go through `find_spawn_agent_model_name`,
 * the lookup that answers *"Unknown model `X` for spawn_agent"* on the
 * `default_subagent_model` path. So a session model pinned here cannot fail that
 * check.
 *
 * The `model` a descriptor names ITSELF is still dropped, with its diagnostic:
 * that is a FOREIGN id one loopback upstream cannot serve, whereas both ids here
 * are served by the connection this session already talks to.
 */
export function resolveCodexRoleTierModel(
  tier: CodexAgentTier | undefined,
  sessionModel: string,
  cheapSubagentModel: string | undefined,
): string | undefined {
  const cheap = cheapSubagentModel?.trim();
  if (!tier || !cheap || cheap === sessionModel) return undefined;
  return tier === 'small' ? cheap : sessionModel;
}

export function buildCodexAgentRoles(opts: {
  codexHome: string;
  /** The session model, so a descriptor naming it is not reported as a drop. */
  sessionModel: string;
  /**
   * P6.550 · the connection's own cheap model, i.e. the caller's
   * `defaultSubagentModel`. Present only when it differs from `sessionModel`.
   */
  cheapSubagentModel?: string;
  /** The session's permission mode, the ceiling a role may not go under. */
  sessionMode?: CodexPermissionMode;
  definitions?: readonly CodexAgentRoleDescriptor[];
}): CodexAgentRolePlan {
  const roles: CodexAgentRole[] = [];
  const diagnostics: string[] = [];
  const denied: Array<{ key: string; reason: string }> = [];
  const unhonouredToolGrants: Array<{ key: string; roleName: string }> = [];
  const claimed = new Set<string>();
  const deny = (descriptor: CodexAgentRoleDescriptor, reason: string): void => {
    diagnostics.push(`Imported agent ${descriptor.key} is not declared as a codex agent role: ${reason}`);
    // P3.337 · the same event, recorded structurally, because the aggregated
    // user-facing notice must not parse its own prose back out.
    denied.push({ key: descriptor.key, reason });
  };

  for (const descriptor of opts.definitions ?? []) {
    const roleName = sanitizeCodexRoleName(codexRoleNameOf(descriptor));
    if (!roleName) {
      deny(descriptor, 'its name reduces to an empty codex role key');
      continue;
    }
    if (CODEX_AGENTS_RESERVED_KEYS.has(roleName)) {
      deny(descriptor, `"${roleName}" is a reserved [agents] key in codex's own config schema`);
      continue;
    }
    if (claimed.has(roleName)) {
      deny(descriptor, `another definition already claims the codex role name "${roleName}"`);
      continue;
    }
    let unhonouredToolGrant = false;
    if (descriptor.tools || descriptor.disallowedTools) {
      // P6.485 · THE NARROW, REASONED EXCEPTION. Owner decision 2026-09-05, Q17
      // option (b): declare the role, carry the read-only obligation as PROSE,
      // and say out loud that the grant was not honoured.
      //
      // Why the deny is right in general and wrong for this one name: a grant
      // like `tools: Read, Grep` is a NARROWING, and codex has no per-role tool
      // policy to narrow with, so declaring such a role hands the child the
      // parent's whole surface — `shell` and `apply_patch` included, in the
      // binary's own `spawn_agent` words, "The spawned agent will have the same
      // tools as you". Denying is the fail-closed answer for a definition a user
      // authored.
      //
      // It is the wrong answer for a role WE bundle and WE invoke: `/code-review`
      // was already spawning an agent with the parent's full tools, just an
      // unnamed one — so the deny preserved a restriction nobody was enforcing
      // (option (a), declined) while costing the one agent name that exists on
      // all three runtimes.
      if (!CODEX_ROLES_DECLARED_DESPITE_UNHONOURABLE_TOOL_GRANT.has(roleName)) {
        deny(descriptor, 'it declares a tool grant, and codex has no per-role tool policy to honour it with');
        continue;
      }
      unhonouredToolGrant = true;
    }
    const systemPrompt = descriptor.systemPrompt.trim();
    if (!systemPrompt) {
      deny(descriptor, 'codex refuses a role whose developer_instructions is blank');
      continue;
    }
    if (opts.sessionMode && descriptor.permissionMode) {
      const clamped = clampCodexPermissionMode(descriptor.permissionMode, opts.sessionMode);
      if (clamped !== opts.sessionMode) {
        deny(descriptor, `it asks for permission mode "${clamped}", which codex cannot scope to one role`);
        continue;
      }
    }
    if (descriptor.model && descriptor.model !== 'inherit' && descriptor.model !== opts.sessionModel) {
      diagnostics.push(
        `Imported agent ${descriptor.key} declares model "${descriptor.model}", which this codex session `
        + `cannot serve; the role inherits ${opts.sessionModel} instead`,
      );
    }
    claimed.add(roleName);
    if (unhonouredToolGrant) {
      unhonouredToolGrants.push({ key: descriptor.key, roleName });
      diagnostics.push(
        `Imported agent ${descriptor.key} is declared as codex role "${roleName}" WITHOUT its tool `
        + 'grant: codex has no per-role tool policy, so the role runs with the parent session\'s '
        + 'tools and the restriction travels as prose in developer_instructions instead',
      );
    }
    const reasoningEffort = descriptor.effort ? REASONING_EFFORT[descriptor.effort] : undefined;
    // P6.550 · the declared tier, on the same role layer `model_reasoning_effort`
    // already uses. See {@link resolveCodexRoleTierModel} for why it is silent
    // when the connection has only one model, and why the non-cheap tiers need a
    // key at all.
    const tierModel = resolveCodexRoleTierModel(descriptor.tier, opts.sessionModel, opts.cheapSubagentModel);
    roles.push({
      roleName,
      // Same fallback string both other runtimes substitute. An empty one is
      // not merely unhelpful here: `agent role `<name>` must define a
      // description` refuses the role outright.
      description: descriptor.description.trim() || `Imported ${descriptor.name} agent.`,
      configFile: join(opts.codexHome, CODEX_AGENT_ROLE_DIR, `${roleName}.toml`),
      configFileToml: [
        `name = ${tomlString(roleName)}`,
        `developer_instructions = ${tomlString(
          unhonouredToolGrant ? `${CODEX_READ_ONLY_ROLE_OBLIGATION}\n\n${systemPrompt}` : systemPrompt,
        )}`,
        ...(reasoningEffort ? [`model_reasoning_effort = ${tomlString(reasoningEffort)}`] : []),
        ...(tierModel ? [`model = ${tomlString(tierModel)}`] : []),
        '',
      ].join('\n'),
    });
  }
  return { roles, diagnostics, denied, unhonouredToolGrants };
}

/**
 * P3.337 — ONE user-facing line for every agent this runtime cannot declare.
 *
 * ## The defect
 *
 * A descriptor carrying `tools` or `disallowedTools` is denied and `continue`d,
 * so there is no `[agents.<role>]` block and no role file: the model cannot
 * spawn it. Five other families deny the same way. Every one of those lines went
 * to `onDiagnostic`, which `CodexAgent` binds to `debug`, which a packaged build
 * never writes — the same P3.120/P3.267 finding, one surface further out. And
 * the blast radius is ordinary rather than exotic: `tools` is plain agent
 * frontmatter, and codex's OWN plugin fixture (`agents/reviewer.md`) declares
 * `tools: Read, Grep`. So an agent authored in codex's own format vanishes on
 * codex and runs on the other two, silently.
 *
 * ## Why ONE aggregated line rather than claude's per-definition digest
 *
 * `CodexAgent.surfaceCodexOperatorNotice` has a ceiling of eight notices per
 * session — that ceiling is why P3.301 left the isolation line on `debug` rather
 * than adding a per-definition notice. A session with nine tool-granting agents
 * would spend the whole queue on this one family and push out the sandbox-egress
 * and execpolicy notices that share it. One line names every dropped key, so the
 * cost is one notice whatever the count.
 *
 * The prefix is the stable machine-readable handle the three existing
 * user-facing formatters use; `CodexAgent` matches on it exactly as it does on
 * theirs, and `codex-operator-notice-lift.test.ts` pins the pair.
 *
 * Pure, and emitted on the same sink and at the same cadence as its siblings:
 * once per `writeCodexConfig`, never from the builders.
 */
/*
 * P3.377, MEASURED AND NOT BUILT at the close-out (2026-09-04), with the reason,
 * because the row assumed something smaller than what is there.
 *
 * Two surfaces answer differently about the same role: this notice tells the
 * user a definition "cannot be spawned in this session", while the capability
 * catalog still reports it `active`. The row proposed "one reader of the drop
 * verdict in `capabilities/resolver.ts`". There is no verdict to read: the
 * denial is minted HERE, per session, at `writeCodexConfig` time, inside a
 * package that deliberately does not import `@nessy-agent/shared` — and the
 * catalog is built in `packages/shared/src/capabilities` with no channel from
 * this side. So closing it means a NEW SEAM carrying `plan.denied` back to the
 * capability layer, not a reader; and the catalog is also per-workspace while
 * this verdict is per-session, so the seam has to answer what an `active` cell
 * means for a definition denied on one session and live on another.
 *
 * Left as two honest surfaces rather than one wrong one: the notice is correct
 * and reaches the user at the moment it matters. Whoever takes it starts from
 * `plan.denied` below.
 */
export function formatCodexAgentRoleDropDiagnostics(plan: CodexAgentRolePlan): string[] {
  if (plan.denied.length === 0) return [];
  const named = plan.denied.map(entry => `${entry.key} (${entry.reason})`).join('; ');
  const count = plan.denied.length;
  return [
    `codex-agent-roles-dropped: ${count} agent definition${count === 1 ? '' : 's'} could not be`
    + ` declared on codex and cannot be spawned in this session: ${named}.`
    + ' The same definitions run on the Pi and Claude runtimes, so this is a per-runtime'
    + ' difference rather than a fault — switching this session to another runtime restores them.',
  ];
}

/**
 * P6.485 — ONE user-facing line for every role declared WITHOUT its tool grant.
 *
 * A sibling of {@link formatCodexAgentRoleDropDiagnostics}, and deliberately a
 * SEPARATE line rather than a widening of it: that one says "this agent cannot
 * be spawned here", which is a loss, and this one says "this agent runs with
 * more tools than it declared", which is a widening. Reporting a widening in the
 * sentence a reader has learned means a loss is how the important half gets
 * skimmed past.
 *
 * The prefix is the stable machine-readable handle the other user-facing
 * formatters in this module use, so `CodexAgent` matches on it exactly as it
 * does on theirs.
 *
 * Pure, at most one line, and empty when nothing was declared this way — the
 * same bound every diagnostic here respects.
 */
export function formatCodexUnhonouredRoleToolGrantNotice(plan: CodexAgentRolePlan): string[] {
  if (plan.unhonouredToolGrants.length === 0) return [];
  const named = plan.unhonouredToolGrants.map(entry => `${entry.roleName} (${entry.key})`).join('; ');
  const count = plan.unhonouredToolGrants.length;
  return [
    `codex-agent-role-tool-grant-unhonoured: ${count} agent role${count === 1 ? ' is' : 's are'}`
    + ` declared on codex without the tool restriction ${count === 1 ? 'it' : 'they'} asked for:`
    + ` ${named}. Codex has no per-role tool policy at all — a spawned agent gets the parent`
    + " session's whole tool surface, `shell` and `apply_patch` included — so the restriction"
    + ' travels as an instruction in the role\'s own developer_instructions instead of as a'
    + ' boundary. On the Pi and Claude runtimes the same restriction is enforced, so this is a'
    + ' per-runtime difference a switch removes and restores.',
  ];
}

/**
 * `clampPermissionModeToParent` from `@nessy-agent/shared`
 * (`agent/mode-types.ts`), duplicated for the dep-free-leaf reason above.
 * An unknown mode never widens; the `plan` parent / `explore` child special
 * case left with `explore` (F1.1050), so the index compare alone decides.
 *
 * EXPORTED BY R5 for the same reason as the order above: a duplicate of a
 * permission clamp that no test compares against its original is a widening
 * waiting to happen. All 36 (requested, parent) pairs are asserted equal to the
 * shared function's answer in `permission-mode-runtime-translations.test.ts`.
 */
export function clampCodexPermissionMode(
  requested: CodexPermissionMode,
  parent: CodexPermissionMode,
): CodexPermissionMode {
  const requestedRank = CODEX_PERMISSION_MODE_ORDER.indexOf(requested);
  const parentRank = CODEX_PERMISSION_MODE_ORDER.indexOf(parent);
  if (requestedRank < 0) return parent;
  if (parentRank < 0) return requested;
  // F1.1050: the plan-parent / explore-child special case went with explore.
  return requestedRank <= parentRank ? requested : parent;
}

/**
 * Derive the sandbox mode, then hand the path policy to the permissions module.
 *
 * P3.273 moved the resolution itself into `config-writer-permissions.ts`; the
 * DERIVATION stays here because `codexSandboxConfigForMode` does, and that is
 * what keeps the new module a leaf. All four call sites read exactly as before.
 */
function resolveRuntimePolicy(opts: Pick<
  CodexConfigOptions,
  'mode' | 'sandboxMode' | 'sandboxGloballyEnabled' | 'deniedReadPaths' | 'deniedReadPatterns' | 'writablePaths' | 'shellEnvironment'
  | 'protectedWorkspaceSubpaths' | 'readOnlyPaths' // F1.670
>): CodexRuntimePathPolicy {
  const derived = opts.mode ? codexSandboxConfigForMode(opts.mode, opts.sandboxGloballyEnabled ?? true) : undefined;
  const sandboxMode = derived?.sandbox_mode ?? opts.sandboxMode ?? 'workspace-write';
  return resolveCodexRuntimePathPolicy(opts, sandboxMode);
}

/** Complete per-thread config layer used by `thread/start`/`thread/resume`. */
export function buildCodexRuntimeConfigOverride(opts: Pick<
  CodexConfigOptions,
  'mode' | 'sandboxMode' | 'sandboxGloballyEnabled' | 'deniedReadPaths' | 'deniedReadPatterns' | 'writablePaths' | 'shellEnvironment'
  | 'protectedWorkspaceSubpaths' | 'readOnlyPaths' // F1.670
>): Record<string, unknown> {
  const policy = resolveRuntimePolicy(opts);
  return {
    ...(Object.keys(policy.environment).length > 0
      ? { shell_environment_policy: { set: policy.environment } }
      : {}),
    ...buildCodexPermissionsOverride(policy),
  };
}

/**
 * Fraction of the model's context window at which codex should auto-compact.
 *
 * F7 — why 0.85 and not the wall. codex does not spend the whole window: it
 * keeps an effective-capacity reserve of ~5% (`effective_context_window_percent`
 * in its own model info), measured live at both 240 000 → 228 000 usable and
 * 272 000 → 258 400. So 0.95 is the wall, not the target.
 *
 * The trigger has to sit far enough below that wall for the compaction to have
 * somewhere to run: the compaction request re-sends the conversation and needs
 * output room for the summary, and the check is not instantaneous — the F5 run
 * watched a settling turn push occupancy UP by 1 768 tokens after the peak. At
 * 0.85 the gap is a tenth of the window (24 000 tokens on a 240 000 window;
 * 40 800 on 272 000), which covers the 5% reserve twice over.
 *
 * 0.85 also puts the three runtimes at comparable occupancy instead of each
 * inventing its own point: on the same 240 000 window Pi's measured threshold
 * was 206 808 and F4's claude formula gives 207 000, against 204 000 here.
 *
 * Conservative in the one direction that matters. codex's scope for this limit
 * (`model_auto_compact_token_limit_scope`) is left at its own default, and the
 * non-`total` scope charges FEWER tokens against the limit — so an under-set
 * limit still fires, while an over-set one would not fire at all, which is
 * exactly the failure F7 exists to fix.
 */
const AUTO_COMPACT_WINDOW_FRACTION = 0.85;

// ---------------------------------------------------------------------------
// P6.14 — codex's own inline `[hooks]` table
// ---------------------------------------------------------------------------

/**
 * The TWELVE keys a codex `[hooks]` table may be keyed by, in the order the
 * release `config-schema.json` declares `HooksToml`'s properties.
 *
 * ## Read from generated artifacts, not from prose
 *
 * Three of them agree and none of them is a sentence: `config-schema.json`'s
 * `definitions.HooksToml.properties`, `codex-protocol`'s generated
 * `ManagedHooksRequirements` (whose FIELD NAMES are exactly these), and the
 * shipped binary's own serde field table, where the same names appear beside
 * `HookEventsToml`. `AGENTS.md` miscounted this list on 2026-08-28 and the
 * miscount reached a lane brief, which is why this constant exists at all
 * instead of a count in a comment — and the count has since moved for a real
 * reason too: `Interrupt` arrived with `rust-v0.150.1` (upstream #40511, a
 * command or MCP handler run when an active top-level turn is interrupted).
 *
 * ## Case matters, and codex spells each event twice
 *
 * The WIRE spelling is lowerCamel (`preToolUse`, generated `HookEventName`,
 * what a `HookMetadata` notification carries). The CONFIG spelling is
 * PascalCase, and it is the only one a `[hooks]` table accepts. Writing the wire
 * spelling into TOML yields a key `HooksToml` has no field for — silently
 * dropped, hook registered nowhere, no warning. This list is the CONFIG
 * spelling.
 *
 * `config-writer-hooks.test.ts` pins it against `config-schema.json` IN BOTH
 * DIRECTIONS, so a codex bump that renames, adds or removes an event fails a
 * test rather than emitting a dead key or silently declining a live one. The
 * second direction was added at the 2026-09-11 lift, because the first alone is
 * a SUBSET tie: it stayed green through the arrival of `Interrupt` and said
 * nothing.
 *
 * It is deliberately NOT imported from `@nessy-agent/shared`: `shared` already
 * imports THIS package, so the dependency cannot run the other way. Both lists
 * are pinned to the same generated artifacts instead, which is a stronger tie
 * than a shared constant — either one drifting fails its own test. Note they
 * are no longer the same list, and that asymmetry is deliberate: this one is
 * CODEX's vocabulary, all twelve, because it is what the writer is allowed to
 * emit; `CODEX_NATIVE_HOOK_EVENTS` is the eleven that are also one of OUR
 * events, because it is what a Nessy hook can be projected from.
 * `Interrupt` is therefore a key this writer would emit faithfully and that
 * nothing upstream of it can produce — see that constant's sibling
 * `CODEX_ONLY_HOOK_EVENTS` for why no `AgentEvent` was minted for it.
 */
export const CODEX_HOOK_EVENTS = [
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'PreCompact',
  'PostCompact',
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'SubagentStart',
  'SubagentStop',
  'Stop',
  'Interrupt',
] as const;

export type CodexHookEvent = (typeof CODEX_HOOK_EVENTS)[number];

const CODEX_HOOK_EVENT_SET: ReadonlySet<string> = new Set(CODEX_HOOK_EVENTS);

/**
 * One `type = "command"` handler inside a matcher group.
 *
 * `command` is the ONLY handler kind this writer emits, and that is a decision
 * rather than a gap — see {@link buildCodexHooksToml}. codex's
 * `HookHandlerConfig` also admits `mcp_tool`, `prompt` and `agent`. `prompt` and
 * `agent` carry no payload at all in TOML (`{ type = "prompt" }`), resolve to
 * codex's own reviewer machinery, and are still refused by the binary.
 * `mcp_tool` is different on both counts — the binary RUNS it, and it names a
 * server and tool in codex's own `[mcp_servers]` table, two of which are ours —
 * so the reason it is not emitted here is measured rather than assumed, and it
 * is the FIELDS that decide: see {@link buildCodexHooksToml} §"Why `command`
 * only". Note what this interface has that an `mcp_tool` handler does not:
 * `command`/`commandWindows` (it takes `server`/`tool`/`input` instead) and
 * `async`, which is not a field of the `mcp_tool` variant at all.
 */
export interface CodexHookCommandHandler {
  /** Shell command codex runs. Rejected outright if blank or control-bearing. */
  command: string;
  /** Windows-only replacement (`commandWindows` in `HookHandlerConfig`). */
  commandWindows?: string;
  /**
   * Seconds. Emitted under the TOML key `timeout`, NOT `timeoutSec`.
   *
   * The two generated artifacts genuinely disagree, and the disagreement is not
   * a bug in either: `config-schema.json`'s `HookHandlerConfig` — the TOML
   * shape — calls it `timeout`, while `ConfiguredHookHandler` — the WIRE shape
   * codex reports a resolved hook back with — calls it `timeoutSec`. Writing
   * `timeoutSec` into TOML would be an unknown key.
   */
  timeoutSec?: number;
  /** Fire-and-forget; codex does not wait for the result. */
  async?: boolean;
  /** Spinner label while it runs. */
  statusMessage?: string;
}

/** A `matcher` plus the handlers that run when it matches. */
export interface CodexHookMatcherGroup {
  /** Codex regex over its SANITIZED hook tool name (F1.219, `codexHookToolName`); omitted = all. */
  matcher?: string;
  hooks: readonly CodexHookCommandHandler[];
}

/** What to write under `[hooks]`, keyed by codex's own event names. */
export type CodexHooksPlan = {
  readonly [Event in CodexHookEvent]?: readonly CodexHookMatcherGroup[];
} & {
  /**
   * `[hooks.state."<key>"]` — the TRUST half, and MEASURED to be required.
   *
   * ## What the binary does without it
   *
   * A `[hooks]` entry written into `CODEX_HOME/config.toml` comes back from
   * `hooks/list` as `source: "user"`, `enabled: true`, **`trustStatus:
   * "untrusted"`**, with a `currentHash` the binary computed itself. Writing
   * `[hooks.state."<key>"] enabled = true, trusted_hash = "<currentHash>"`
   * flips the same entry to `trustStatus: "trusted"` with no `configWarning`
   * — RE-MEASURED 2026-09-11 on the bundled `codex-app-server 0.150.1`
   * (`darwin-arm64`), unchanged from the 2026-08-29 reading against the tag
   * shipped then: two passes over ONE home, all three entries `untrusted` before
   * and `trusted` after, plus a state key naming no hook at all, which stayed
   * inert — it added no entry, removed none, and produced no `configWarning`.
   * The arms are executable now; see {@link buildCodexHooksToml} §"Proven
   * against the bundled binary".
   *
   * ## Why the caller supplies both halves, and does not compute them
   *
   * The key is `<config path>:<snake_case event>:<group>:<handler>` and the
   * hash is a sha256 of something this repo has not identified — it is NOT the
   * command string, tried with and without a trailing newline. It is published
   * with a literal `sha256:` prefix, and `trusted_hash` must repeat that prefix
   * verbatim: a state entry carrying the bare hex names nothing. Both are
   * PUBLISHED by `hooks/list`, so the honest source for both is a read from the
   * binary rather than a re-derivation of its private normalisation. That makes
   * trusting a projected hook a two-pass operation — write, boot, read
   * `hooks/list`, write the state — and this field is the second pass's input.
   * Deriving the key from three observed samples would be inventing a format
   * the binary is free to change.
   *
   * codex's OTHER route to a trusted hook is not open to us: `isManaged: true`
   * hooks come from a `requirements.toml` under an MDM or enterprise-managed
   * directory (`hooks/src/engine/discovery.rs`'s own `<mdm:` /
   * `<enterprise-managed:` source labels), and `config-schema.json` has no
   * top-level property that points codex at one — searched for `manage`, `mdm`
   * and `enterprise` across all 94 top-level keys, zero hits.
   */
  readonly state?: Readonly<Record<string, string>>;
};

export interface CodexHooksPlanResult {
  /** TOML lines, `[]` when nothing survives validation. */
  lines: string[];
  /** One line per REJECTED handler or group. Never silent. */
  diagnostics: string[];
}

// ---------------------------------------------------------------------------
// P2.414 — AUTHORSHIP is the boundary, and it is checked at CONSTRUCTION
// ---------------------------------------------------------------------------

/**
 * P2.414 — how a projected hook can be stopped while codex is running.
 *
 * ## Why this is a REQUIRED field rather than a comment
 *
 * On Pi a hook runs inside `ProcessSupervisor`, behind plugin-integrity
 * verification, and under the managed kill switches (`disableAllHooks`,
 * `allowPluginHooks`). A hook projected into codex's own `[hooks]` table runs
 * in NONE of those: codex's app-server executes the command itself, and the
 * host is not on the path. That is not a defect of this projection — it is the
 * price of using the runtime's own mechanism, and the owner took it knowingly
 * (P2.414, option 2). What must not happen is a later author assuming the Pi
 * containment came along for the ride.
 *
 * So the mint refuses to accept a plan that does not state its answer. There
 * are exactly two honest ones:
 *
 *  - `next-runtime-build` — NOT revocable inside a running session. Truthful
 *    for every host hook today, because `config.toml` is read when the
 *    app-server starts and nothing rereads it: the switch is the next runtime
 *    build, which `CodexAgent` performs on session start and on the
 *    permission-mode respawn. Admitted, and SAID (see
 *    {@link CODEX_HOOK_PROJECTION_NOTICE}).
 *  - `in-command` — the command consults something the host can change while
 *    codex runs, so revoking is a host-side write rather than a respawn. The
 *    `evidence` string must name what the command consults; an `in-command`
 *    claim with nothing behind it is refused, because a kill switch nobody can
 *    point at is not a kill switch.
 *
 * Deliberately NOT a boolean. "It cannot be revoked" and "it can, here is how"
 * are different facts, and a boolean collapses the second into the first the
 * moment someone builds one.
 */
export type CodexHostHookRevocation =
  | {
      readonly kind: 'in-command';
      /** What the command consults, and where the host writes it. Never blank. */
      readonly evidence: string;
    }
  | { readonly kind: 'next-runtime-build' };

/** Who constructed a host-authored plan, and how it can be stopped. */
export interface CodexHostHookProvenance {
  /**
   * The host call site that CONSTRUCTED this plan — a symbol name, not a
   * description. It is printed beside the projection, so the reader's next
   * question ("who put this in my config?") is already answered.
   */
  readonly origin: string;
  readonly revocation: CodexHostHookRevocation;
}

declare const HOST_AUTHORED_CODEX_HOOKS_BRAND: unique symbol;

/**
 * A hook plan the HOST ITSELF authored — the only thing this writer projects.
 *
 * Nominal on purpose. A structural type would let any caller hand
 * `writeCodexConfig` a plan assembled out of a user's `settings.json` or a
 * plugin manifest, and nothing in the type system would notice. The brand
 * cannot be produced by an object literal, so the ONE door is
 * {@link mintHostAuthoredCodexHooks} — which is what "the check belongs where
 * the hook is constructed" means in code rather than in a comment.
 *
 * The compile-time half is not the whole guard: a cast defeats it. The runtime
 * half is a module-private registry keyed by object identity, plus a snapshot
 * of the exact bytes minted — see {@link buildCodexHooksToml}.
 */
export type CodexHostAuthoredHooksPlan = CodexHooksPlan & {
  readonly [HOST_AUTHORED_CODEX_HOOKS_BRAND]: 'host-authored';
};

/**
 * The runtime half of authorship. Module-private and a `WeakMap`, so the only
 * way to be in it is to have come out of {@link mintHostAuthoredCodexHooks},
 * and a plan that is garbage-collected takes its entry with it.
 */
const HOST_AUTHORED_CODEX_HOOKS = new WeakMap<object, CodexHostHookProvenance>();

/** Freeze every object and array reachable from `value`, in place. */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  for (const inner of Object.values(value as Record<string, unknown>)) deepFreeze(inner);
  return Object.freeze(value);
}

/**
 * Mint a host-authored hook plan. **The only way to get one.**
 *
 * ## What it establishes, and what it deliberately does not
 *
 * It establishes AUTHORSHIP — that the plan handed here was built by host code
 * at this call site — and nothing else. It does NOT validate the content:
 * a blank command, a bad timeout and an unknown event key are still refused by
 * {@link buildCodexHooksToml}, one handler at a time, exactly as before. Those
 * are two different questions and collapsing them would make the authorship
 * gate look like a content gate, which is the boundary P2.414 explicitly did
 * not choose.
 *
 * ## Why the plan is CLONED and DEEP-FROZEN
 *
 * Consequence (1) of the owner's decision: "a host hook whose command was later
 * edited by anything else is no longer host-authored". A brand on a mutable
 * object would survive that edit, so the brand is put on a copy nobody else
 * holds a reference into, and every object reachable from it is frozen — an ESM
 * module is strict, so a later write THROWS rather than being ignored. A caller
 * who spread-copies the plan to change one command produces a DIFFERENT object,
 * which is not in the registry and is refused whole. Those two together are the
 * whole guarantee; there is deliberately no third check, because the third one
 * this file briefly carried was unreachable behind the freeze.
 *
 * The clone is a JSON round-trip on purpose: it also strips functions, symbols
 * and prototypes, so nothing reaches the emitter that a plain data plan could
 * not carry.
 *
 * ## What must never be minted
 *
 * A command built from input the host did not author — a user's settings file,
 * a plugin manifest, a model's output, a project file. codex executes this
 * string. There is no verification step on the far side and no kill switch that
 * reaches it, which is precisely why the owner drew the line at authorship:
 * a host-authored command's content is ours, so the plugin-integrity check it
 * loses has nothing to verify.
 */
export function mintHostAuthoredCodexHooks(
  provenance: CodexHostHookProvenance,
  plan: CodexHooksPlan,
): CodexHostAuthoredHooksPlan {
  const cloned = deepFreeze(JSON.parse(JSON.stringify(plan)) as CodexHooksPlan);
  HOST_AUTHORED_CODEX_HOOKS.set(cloned, { origin: provenance.origin, revocation: provenance.revocation });
  return cloned as CodexHostAuthoredHooksPlan;
}

/**
 * What a codex session SAYS about the hooks it does not project — consequence
 * (2) of the owner's decision, and the half that makes the residual difference
 * HONEST rather than merely absent.
 *
 * An empty `[hooks]` table reads as "this session has no hooks", which is false
 * twice over: the user's and the plugins' hooks exist, and they run — host-side,
 * on the events this runtime emits — they are simply not handed to codex to
 * execute. Saying only "not projected" would be the other half-truth, so the
 * sentence carries the REASON, which is the whole content of the owner's
 * decision.
 *
 * Emitted once per runtime build by `CodexAgent`, onto the session diagnostics
 * ring `SessionManager.getRecentAgentStderr` reads — not only `debug()`, whose
 * transports the packaged main process disables (P2.280 measured that, on this
 * same class, for exactly this kind of fact).
 */
export const CODEX_HOOK_PROJECTION_NOTICE =
  '[codex-hooks] only hooks the host itself authored are projected into codex\'s own [hooks] table.'
  + ' Your user- and plugin-authored hooks are NOT projected here: their content is not ours, so we do not hand'
  + ' codex something to execute that we neither wrote nor can revoke. They still run host-side, on the events'
  + ' this runtime emits.';

/**
 * A string safe to place in this config at all — no control characters.
 *
 * `tomlString` would happily escape a newline into `\n` and the file would
 * parse, so this is not about TOML. It is about what codex does with the value
 * afterwards: a hook `command` is handed to a shell, and a newline inside it is
 * a second command the author of the first never wrote. The brief for this row
 * is explicit — never emit a hook whose command string you would not run
 * yourself, and never one built from unvalidated input — so a control-bearing
 * command is REJECTED rather than escaped.
 *
 * Rejecting is also the only fail-closed option available. A projected hook that
 * silently loses a character is a hook whose author believes it is running as
 * written.
 */
const CODEX_HOOK_CONTROL_CHAR = /[\u0000-\u001f\u007f]/;

/**
 * Project a hook plan into codex's inline `[hooks]` table.
 *
 * ## Only what the HOST ITSELF authored (P2.414, owner decision 2026-08-29)
 *
 * A `command` handler here is executed by codex directly — outside the host's
 * `ProcessSupervisor`, outside plugin-integrity verification, and outside the
 * managed kill switches. The owner's ruling is that this is acceptable for a
 * hook whose content is OURS (there is nothing for plugin-integrity to verify)
 * and unacceptable for one that is not: projecting a user- or plugin-authored
 * hook would hand codex something to execute that we neither wrote nor can
 * revoke.
 *
 * So the filter is on AUTHORSHIP, not on content, and it is checked at
 * CONSTRUCTION: {@link mintHostAuthoredCodexHooks} is the only producer of the
 * branded plan this function accepts, it clones and deep-freezes what it is
 * given, and the check below re-compares the bytes so a plan edited after
 * minting is no longer host-authored. The content checks further down are
 * unchanged and still apply — authorship gets a plan considered, it does not
 * get it emitted.
 *
 * What the user is told about the hooks that are NOT projected is
 * {@link CODEX_HOOK_PROJECTION_NOTICE}; what happens to a projected hook when
 * an administrator engages a kill switch is {@link CodexHostHookRevocation}.
 *
 * ## Why `command` only, and why this is native-first rather than a port
 *
 * MEASURED against the shipped binary (`darwin-arm64`, `rust-v0.150.1`), and it
 * is the finding that made this row cheap: **codex's hook I/O contract IS the
 * contract our own hooks already speak.** The binary embeds 23 JSON schemas
 * (`<event>.command.input` / `.output`, twelve events, `SessionEnd` input-only
 * — re-measured at the 2026-09-11 lift, which took the event count up by one
 * and the schema count up by two), and `pre-tool-use.command.output` carries
 * `hookSpecificOutput.permissionDecision` with the enum `allow | deny | ask`
 * plus `permissionDecisionReason`, beside `continue`, `decision`, `reason`,
 * `stopReason`, `suppressOutput` and `systemMessage`; the input carries
 * `hook_event_name`, `session_id`, `transcript_path`, `cwd`, `tool_name`,
 * `tool_input` and a `permission_mode` whose enum is our own permission-mode
 * vocabulary. So there is no translation layer to write — which is exactly what
 * "the runtime already has the mechanism" is supposed to mean.
 *
 * The other three handler kinds are not a matter of taste, and the TYPE is
 * misleading about them: `HookHandlerConfig` admits `mcp_tool`, `prompt` and
 * `agent`. TWO of the three are still dead in the shipped binary, and the third
 * stopped being dead at the 2026-09-11 lift — a change this docblock would have
 * gone on denying, which is why the strings are re-read on every lift rather
 * than carried:
 *
 *  - `prompt` and `agent` are refused wholesale, in the same two strings as
 *    before — "skipping prompt hook in …: prompt hooks are not supported yet"
 *    and "skipping agent hook in …: agent hooks are not supported yet".
 *  - `mcp_tool` is now RUN — upstream #39296 between the tags, taking the flat "not
 *    supported yet" string with it. RE-DRIVEN at `rust-v0.154.0` on 2026-09-17: `McpTool`
 *    is refused only for `SessionEnd` and for a blank `server`/`tool`, every other event
 *    running it (`hooks/src/engine/discovery.rs`, the `HookHandlerConfig::McpTool` arm at
 *    that tag). Do NOT re-verify that by grepping the binary for the SessionEnd sentence
 *    — it is a format template now, so that literal scores 0 in the shipped
 *    `codex-app-server` while "skipping MCP tool hook in" scores 2 (`grep -aoF`,
 *    2026-09-17): an absence shaped exactly like a lifted gate.
 *
 * This writer still emits `command` and only `command`. P6.1068 went and read
 * the dispatch, and the reason CHANGED: the sentence this paragraph used to
 * carry — that an emitted `mcp_tool` handler would be "a hook the config
 * accepts, `hooks/list` reports, and nothing ever runs" — is REFUTED at
 * `rust-v0.150.1`. `execute_handler`'s `ConfiguredHandlerKind::McpTool` arm
 * calls `run_mcp_tool(engine.mcp_executor.as_ref(), handler, server, tool,
 * input, input_json, metadata)` (`codex-rs/hooks/src/engine/dispatcher.rs`), so
 * one emitted today WOULD run. What stops the projection is narrower and
 * sharper than "it would be dead", and it is three measured facts about what
 * such a handler RECEIVES and may RETURN:
 *
 *  1. **It never receives the hook payload.** `run_mcp_tool`
 *     (`codex-rs/hooks/src/engine/mcp_runner.rs`) calls
 *     `expand_mcp_argument_template(argument_template, &hook_event)`: the TOML
 *     `input` object is a STATIC template whose `${field.nested}` placeholders
 *     are substituted out of the hook event JSON, and its own doc comment says
 *     *"Missing fields fail the hook instead of passing unresolved arguments to
 *     the server."* There is no hand-the-whole-object form. A Nessy hook body
 *     reads a `hook_event_name`-keyed JSON object; a per-event template that
 *     enumerates that object's fields would fail the hook the first time an
 *     event carried one fewer than the template names.
 *  2. **It cannot use the exit-code channel.** `HookMcpExecutor::execute` is
 *     documented *"Returns text that is interpreted using ordinary command-hook
 *     output semantics"* (`codex-rs/hooks/src/mcp.rs`), and `run_mcp_tool` maps
 *     its result to `(Some(0), output, None)` on success and
 *     `(None, String::new(), Some(error))` on failure. So the JSON-on-stdout
 *     channel survives and the exit status does not: a hook that blocks by exit
 *     code has no way to say so, and a FAILED call yields empty stdout — there
 *     is nothing left for the output parser to read.
 *  3. **Two controls are `command`-only.** `async` is not a field of the
 *     `mcp_tool` variant (`ConfiguredHookHandler`), and `discovery.rs`'s
 *     `McpTool` arm sets `additional_context_limit: None` unconditionally. A
 *     projection would silently drop a hook's fire-and-forget and its
 *     context-spill budget.
 *
 * The frame mismatch is still true and is now the SECOND reason rather than the
 * only one: an `mcp_tool` handler names a server and tool in CODEX's own
 * `[mcp_servers]` table and a Nessy `mcp` hook handler names one of ours. That
 * half is bounded — this writer does emit two codex servers
 * (`[mcp_servers.session]` and `[mcp_servers.sources]`) — which is precisely why
 * facts (1)–(3) rather than the frame are what this decision now rests on.
 *
 * ## The posture this raises, STATED and not taken here (P6.1068)
 *
 * An `mcp_tool` handler hands codex no command string. It names one of OUR
 * servers, so the host would stay on the path — `ProcessSupervisor`,
 * plugin-integrity verification and the managed kill switches all reached
 * again — which is the exact property P2.414's authorship boundary was drawn to
 * protect. So it is the one handler kind that could reopen the 2026-08-29
 * ruling for USER- and PLUGIN-authored hooks. That is an owner's decision about
 * what the product is, not this writer's, and facts (1)–(3) price it: it needs a
 * per-event argument template, a model-visible dispatch tool on
 * `[mcp_servers.session]` (or a way to hide one), and an answer for the two
 * dropped controls. Filed as a row; nothing here widens on its own.
 *
 * Orthogonally, and it is why none of the above is urgent: the host authors NO
 * hooks today (`CodexAgent.hostAuthoredHookProjection` returns `{}`), so there
 * is nothing to project as `mcp_tool` or as anything else. The user hooks that
 * could match an MCP tool call already fire on codex host-side — the codex
 * adapter names an `mcpToolCall` item `mcp__<server>__<tool>`, byte-identical to
 * Pi's and Claude's, and `noteCodexToolCallForHooks` mints `PostToolUse` from
 * it. The events that do NOT fire there (`PreToolUse`, `PermissionRequest`) are
 * absent for EVERY tool, native and MCP alike, and are published as `unwired`
 * with their reason in `runtime-hook-events.ts` rather than being silent.
 *
 * ## Proven against the bundled binary, not against a string assertion
 *
 * RE-DRIVEN 2026-09-11 against the binary this repo ships TODAY —
 * `codex-app-server 0.150.1`, the artefact's own `--version`, `darwin-arm64`,
 * placed by `scripts/fetch-codex.mjs` from the release `packages/codex-protocol/manifest.json`
 * pins — booted on a home this writer built, `initialize` then `hooks/list`,
 * with no network call and no credential. Every claim below was first read
 * 2026-08-29 against the tag shipped then, and **every one of them SURVIVED the
 * two-tag lift unchanged** — worth saying beside a docblock whose neighbouring
 * paragraph records a handler kind that did NOT:
 *
 *  - **no `configWarning` at all** for a table carrying a matcher, a timeout, an
 *    async handler and a command with an embedded quote and backslash;
 *  - `hooks/list` returns all three entries with every field round-tripped —
 *    `matcher`, `timeoutSec: 12` (from the `timeout` key), `async: true`,
 *    `statusMessage`, `source: "user"`, `enabled: true` — and `warnings: []`,
 *    `errors: []`;
 *  - POSITIVE CONTROL on the same binary in the same run: one deliberately
 *    malformed line appended to the same file produces "Invalid configuration;
 *    using defaults." — the whole-file fail-open this validation exists to
 *    avoid, observed rather than assumed.
 *
 * Two facts the 2026-08-29 reading did not record, both owed to a lane that
 * runs the trust pass:
 *
 *  - `currentHash` is published with a literal `sha256:` PREFIX
 *    (`sha256:2f64925f…`), and `trusted_hash` must carry that prefix verbatim —
 *    a state entry written with the bare hex names nothing;
 *  - the fail-open is legible through `hooks/list` ITSELF, not only through the
 *    `configWarning` notification: the malformed arm returns `hooks: []` with an
 *    `errors` entry carrying `<config path>:<line>:<column>`, and the warning's
 *    own payload carries `details`, `path` and a `range` beside the summary. So
 *    the read-back pass can tell "this session has no hooks" from "the file did
 *    not parse", which is what makes the two-pass trust protocol safe to run
 *    unattended.
 *
 * **And this stopped being a dated prose reading at that re-drive.** The three
 * arms are now the executable suite `config-writer-hooks-live.test.ts`, which
 * boots the SHIPPED binary and skips loudly where it is absent, so the next lift
 * re-drives them instead of leaving a sentence here to decay. That file exists
 * because this section had already gone two tags stale once.
 *
 * The one thing the table does NOT get on its own is TRUST; see
 * {@link CodexHooksPlan.state}.
 *
 * ## Fail-closed, one handler at a time
 *
 * A codex config that fails to parse fails OPEN and WHOLE-FILE — one bad line
 * takes `[permissions]`, the execpolicy pointer and every deny floor with it,
 * and the only signal is a `configWarning`. So nothing questionable is emitted:
 * a blank command, a control-bearing command/matcher/label, a non-integer or
 * negative timeout, an unknown event key and an empty group are each DROPPED
 * with a diagnostic, and the rest of the table still writes. That is the same
 * posture `buildCodexExecpolicyRules` takes for the same reason.
 *
 * Returns `{ lines: [], diagnostics: [...] }` when nothing survives, so the
 * caller emits no `[hooks]` header at all rather than an empty one.
 */
export function buildCodexHooksToml(plan: CodexHostAuthoredHooksPlan | undefined): CodexHooksPlanResult {
  const lines: string[] = [];
  const diagnostics: string[] = [];
  if (!plan) return { lines, diagnostics };

  const reject = (event: string, why: string): void => {
    diagnostics.push(`Codex hook not projected for ${event}: ${why}`);
  };

  // P2.414 — THE AUTHORSHIP GATE, and it refuses the plan WHOLE.
  //
  // Per-handler refusal is right for content (one bad command must not cost the
  // rest of the table); it is wrong here. A plan that is not host-authored is
  // not a plan with a bad entry in it — it is a plan we have no business
  // projecting at all, and salvaging the parts that happen to look fine would
  // be exactly the widening the owner ruled out ("do not widen this later
  // without a new decision — the whole point is that authorship, not trust, is
  // the boundary").
  //
  // Consequence (1) — "a host hook whose command was later edited by anything
  // else is no longer host-authored" — is carried by IDENTITY plus the mint's
  // deep freeze, and by nothing else. A byte-snapshot compared here as well was
  // written first and then DELETED: the frozen clone cannot be edited in place
  // (an ESM module is strict, so the write throws), and anything that edits a
  // copy produces a different object, which this lookup already refuses. A
  // branch no mutant can kill is inert code, and inert code beside a security
  // boundary reads as protection that is not there.
  const authorship = HOST_AUTHORED_CODEX_HOOKS.get(plan);
  if (!authorship) {
    diagnostics.push(
      'Codex hooks not projected: the plan is not host-authored.'
      + ' Only a plan minted by mintHostAuthoredCodexHooks is projected into codex\'s [hooks] table;'
      + ' user- and plugin-authored hooks stay host-side, where the host wrote neither their content nor their trust.',
    );
    return { lines, diagnostics };
  }
  if (authorship.revocation.kind === 'in-command' && !authorship.revocation.evidence.trim()) {
    diagnostics.push(
      `Codex hooks not projected: ${authorship.origin} claims in-command revocation and names nothing that revokes it.`
      + ' A projected hook is outside ProcessSupervisor, plugin-integrity verification and the managed kill switches,'
      + ' so an unevidenced claim of revocability is worse than admitting there is none.',
    );
    return { lines, diagnostics };
  }

  for (const event of Object.keys(plan)) {
    // `state` is `HooksToml`'s twelfth property and is not an event — it is the
    // trust table, handled below.
    if (event === 'state') continue;
    if (!CODEX_HOOK_EVENT_SET.has(event)) {
      reject(event, `not one of codex's ${CODEX_HOOK_EVENTS.length} hook events`);
    }
  }

  // Iterated in the constant's order rather than the plan's, so the same plan
  // always produces the same bytes — `codexThreadConfigSignature` hashes this
  // file's output, and a key-order-dependent hash respawns the runtime for no
  // reason.
  for (const event of CODEX_HOOK_EVENTS) {
    for (const group of plan[event] ?? []) {
      const matcher = group.matcher;
      if (matcher !== undefined && CODEX_HOOK_CONTROL_CHAR.test(matcher)) {
        reject(event, 'matcher contains a control character');
        continue;
      }
      const handlers: string[] = [];
      for (const handler of group.hooks ?? []) {
        const command = handler.command?.trim() ?? '';
        if (!command) {
          reject(event, 'handler has no command');
          continue;
        }
        if (CODEX_HOOK_CONTROL_CHAR.test(command)) {
          reject(event, 'command contains a control character (a newline is a second command)');
          continue;
        }
        if (handler.commandWindows !== undefined && CODEX_HOOK_CONTROL_CHAR.test(handler.commandWindows)) {
          reject(event, 'commandWindows contains a control character');
          continue;
        }
        if (handler.statusMessage !== undefined && CODEX_HOOK_CONTROL_CHAR.test(handler.statusMessage)) {
          reject(event, 'statusMessage contains a control character');
          continue;
        }
        const timeout = handler.timeoutSec;
        if (timeout !== undefined && (!Number.isInteger(timeout) || timeout < 0)) {
          reject(event, `timeoutSec ${String(timeout)} is not a non-negative integer`);
          continue;
        }
        handlers.push(
          '[[hooks.' + event + '.hooks]]',
          `type = ${tomlString('command')}`,
          `command = ${tomlString(command)}`,
          ...(handler.commandWindows !== undefined ? [`commandWindows = ${tomlString(handler.commandWindows)}`] : []),
          ...(timeout !== undefined ? [`timeout = ${timeout}`] : []),
          ...(handler.async !== undefined ? [`async = ${handler.async ? 'true' : 'false'}`] : []),
          ...(handler.statusMessage !== undefined ? [`statusMessage = ${tomlString(handler.statusMessage)}`] : []),
          '',
        );
      }
      if (handlers.length === 0) {
        // Only when the group arrived EMPTY. A group whose handlers were each
        // rejected above has already named each reason; repeating a group-level
        // line for the same fact is the noise that trains a reader to skim past
        // these diagnostics, which is how the next real one gets missed.
        if ((group.hooks?.length ?? 0) === 0) reject(event, 'matcher group has no handler at all');
        continue;
      }
      // `matcher` belongs to the GROUP, so it must be written between the group
      // header and the first handler header — after `[[hooks.X.hooks]]` opens,
      // a bare key lands on the handler instead and codex sees a matcher-less
      // group carrying an unknown `matcher` field.
      lines.push(
        '[[hooks.' + event + ']]',
        ...(matcher !== undefined ? [`matcher = ${tomlString(matcher)}`] : []),
        '',
        ...handlers,
      );
    }
  }

  // The trust half. Emitted even when no group survived above: a state entry
  // names a hook by the key the BINARY assigned it, and an entry naming a hook
  // that is no longer in the table is inert — re-measured 2026-09-11 on
  // `codex-app-server 0.150.1`, a deliberately bogus key changed nothing and
  // produced no `configWarning`.
  //
  // Sorted so the same trust map always produces the same bytes, for the same
  // signature-hash reason the event loop above is ordered.
  for (const key of Object.keys(plan.state ?? {}).sort()) {
    const hash = plan.state?.[key] ?? '';
    if (CODEX_HOOK_CONTROL_CHAR.test(key)) {
      reject('hooks.state', 'trust key contains a control character');
      continue;
    }
    if (!hash.trim() || CODEX_HOOK_CONTROL_CHAR.test(hash)) {
      reject('hooks.state', `trust entry for ${key} has no usable hash`);
      continue;
    }
    lines.push(
      // A QUOTED key, always. The keys codex issues carry `/`, `.` and `:` —
      // an unquoted `a.b` would open nested tables instead of naming one hook.
      `[hooks.state.${tomlString(key)}]`,
      `enabled = true`,
      `trusted_hash = ${tomlString(hash)}`,
      '',
    );
  }

  return { lines, diagnostics };
}

/**
 * The auto-compaction trigger derived from the synced window, or `undefined`
 * when there is no window to derive it from.
 */
export function autoCompactTokenLimit(contextWindow: number | undefined): number | undefined {
  if (typeof contextWindow !== 'number' || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    return undefined;
  }
  const limit = Math.floor(contextWindow * AUTO_COMPACT_WINDOW_FRACTION);
  return limit > 0 ? limit : undefined;
}

/**
 * P6.95 — the window codex fabricates for itself when this writer emits none.
 *
 * Not a default of ours and not a guess: `models-manager/src/model_info.rs:139`
 * at `rust-v0.148.0` — the tag shipped when this was read —
 * `model_info_from_slug` returns `context_window: Some(272_000)`,
 * `max_context_window: Some(272_000)`, `auto_compact_token_limit: None` for any
 * slug codex does not ship a catalogue entry for, which is every gateway id we
 * hand it. The four measured arms behind that reading are in
 * {@link CodexConfigOptions.autoCompactionEnabled}'s docblock above, together
 * with the fixture that made the first fix rest on `#[cfg(test)]` code.
 *
 * It is exported because a SECOND reader now needs the same number:
 * `codex-agent.ts` warns the operator by name when a session lands on it, and a
 * warning that restates the constant would drift from the writer the day
 * upstream moves it. The predicate that decides whether a session lands here is
 * {@link resolveCodexContextWindow}, exported for exactly the same reason — its
 * own docblock records the bug that two spellings of one predicate already
 * caused inside this file.
 *
 * What the number reaches, so the warning can say it: codex derives the usage
 * it reports from `window * effective_context_window_percent / 100` (default 95
 * — `openai_models.rs:910` / `turn_context.rs:304`, i.e. 258 400 here), and with
 * `model_auto_compact_token_limit` withheld it triggers compaction at its own
 * 90 % term off the same figure (`openai_models.rs:482`, 244 800 here).
 */
export const CODEX_ASSUMED_CONTEXT_WINDOW = 272_000;

/**
 * The `model_context_window` value this writer will emit, or `undefined`.
 *
 * ONE function so the builder and `validateConfigAgainstSchema`'s "guard what we
 * WRITE" list cannot disagree. They previously each spelled the predicate out,
 * and the two spellings were not the same: the builder also required
 * `Number.isFinite` and `> 0`, so a caller handing `contextWindow: 0` made the
 * guard demand a key the builder had not written.
 */
export function resolveCodexContextWindow(opts: Pick<CodexConfigOptions, 'contextWindow'>): number | undefined {
  const { contextWindow } = opts;
  if (typeof contextWindow !== 'number' || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    return undefined;
  }
  return Math.floor(contextWindow);
}

/**
 * P3.347 — a `[agents]` ceiling this writer will emit, or `undefined`.
 *
 * One function for both keys and for both readers (the builder and the schema
 * guard), the discipline {@link resolveCodexContextWindow} records. The schema
 * gives `max_concurrent_threads_per_session` `minimum: 1`, and a depth of 0
 * would be a nesting ceiling that forbids the root agent itself, so 1 is the
 * floor for both.
 */
function resolveCodexSubagentCeiling(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) return undefined;
  return Math.floor(value);
}

/**
 * P6.140 — the `tool_timeout_sec` value this writer will emit, or `undefined`.
 *
 * ONE function for the builder and the schema guard, the discipline
 * {@link resolveCodexContextWindow} records. The schema types the key
 * `format: double` with no minimum; a zero or negative deadline would abort
 * every tool call before it started, so the floor here is any positive finite
 * number.
 */
function resolveCodexMcpToolTimeoutSec(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  return value;
}

/**
 * P6.273 — a `[model_providers.*]` retry value this writer will emit, or
 * `undefined`.
 *
 * ONE function for the builder and the schema guard, the discipline
 * {@link resolveCodexContextWindow} records. The schema types all three keys
 * `uint64` with `minimum: 0`; the FLOOR HERE IS 1 and it is ours, stated rather
 * than borrowed: a 0-attempt ladder fails the session on the first transient
 * 429, and a 0ms idle deadline aborts every stream that pauses to think. An
 * operator who wants no retries is asking for a different thing than an
 * operator who mistyped, and this writer cannot tell them apart — so the
 * schema's own floor is refused in favour of the one that cannot be a typo.
 * Rejected values fall back to codex's defaults rather than failing the file,
 * because the shared reader (`shared/config/api-retry-env.ts`) has already
 * reported a bad value BY NAME to the operator; failing here would be a second
 * punishment for a message they have already been given.
 */
function resolveCodexProviderRetryValue(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) return undefined;
  return Math.floor(value);
}

/**
 * P3.348 — the `tool_output_token_limit` value this writer will emit, or
 * `undefined`.
 *
 * ONE function for the same reason {@link resolveCodexContextWindow} is one:
 * the builder and the schema guard must not spell the predicate differently.
 * The schema types the key `format: uint, minimum: 0`, and a zero budget would
 * truncate every stored tool output to nothing, so the floor here is 1.
 */
function resolveToolOutputTokenLimit(limit: number | undefined): number | undefined {
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit < 1) return undefined;
  return Math.floor(limit);
}

/*
 * P2.28 — THERE IS NO USD CEILING TO WRITE HERE, AND THIS IS WHERE IT WOULD GO.
 *
 * The claude runtime arms the SDK's own `maxBudgetUsd` on its query
 * (`shared/src/agent/claude-agent.ts:buildClaudeMaxBudgetUsdOptions`). Codex has
 * no counterpart, measured rather than assumed:
 *
 * - `codex-protocol/schema/config-schema.json` (176 KB, every app-server config
 *   key) contains ZERO keys matching `usd`/`cost`/`dollar`/`spend`. Positive
 *   control on the same grep: `budget` DOES hit — `token_budget`,
 *   `rollout_budget.limit_tokens`, `max_goal_token_budget` — so the absence is
 *   the schema's, not the pattern's. Every codex budget knob is denominated in
 *   TOKENS.
 * - The v2 protocol's budget vocabulary is the same shape: `ThreadGoal
 *   .tokenBudget`, the `budgetLimited` goal status, and `CodexErrorInfo
 *   .sessionBudgetExceeded` — an account/usage verdict the server reports, not a
 *   ceiling a client sets.
 * - `ThreadUsage.estimatedUsageUsdMicros` is the only USD figure anywhere in the
 *   protocol, and nothing in this repo consumes it.
 *
 * A host-side codex loop is not the fallback either: `BaseAgent.chat`'s cap
 * already runs for codex (`enforcesMaxBudgetUsdInChatImpl` is true only on pi),
 * but it accumulates `usage.costUsd`, and the codex event adapter emits that
 * field nowhere — so it counts 0 forever. Closing codex's half needs a COST
 * SOURCE first, which is its own row, not a knob added here.
 *
 * P6.507 · AND THE TOKEN CEILING IS NOT WRITTEN HERE EITHER, WHICH IS A
 * DECISION. The block above says every codex budget knob is denominated in
 * TOKENS and stops there; owner-delegated Q-den 30 (option A) then settled the
 * DENOMINATION — keep the USD cap where a price exists and add a token budget
 * every runtime can honour — which makes "which token knob" a real question
 * rather than a rhetorical one. Measured, codex has three and NONE is adoptable
 * at `rust-v0.148.0`:
 *
 *  - `[features.token_budget]` and `[features.rollout_budget]` are both
 *    `Stage::UnderDevelopment` with `default_enabled: false` on the shipped
 *    binary — and `rollout_budget` is the one that would actually do the job
 *    (`core/src/rollout_budget.rs`: weighted-token accounting across the whole
 *    root-thread session tree, a `RolloutBudgetContext { remaining_tokens }`
 *    fragment at every crossed threshold, `CodexErr::SessionBudgetExceeded` at
 *    the limit). Enabling either emits a per-session under-development warning,
 *    and `resolve_rollout_budget_config` REFUSES the whole configuration when
 *    the feature is on without `limit_tokens` or `reminder_at_remaining_tokens`
 *    — a session that does not start, not an ignored key.
 *  - `[goals] max_goal_token_budget` is `Stage::Stable`, and it belongs to
 *    codex's own goal engine, which this product turns OFF three lines from
 *    here (`goals = false`, owner Q20 / P6.487).
 *
 * The refusal, its measurement and its exit condition live with the other
 * refused feature keys —
 * `codex-agent-server/src/experimental-features.ts`'s `CODEX_REFUSED_FEATURES`
 * and the `CODEX_TOKEN_BUDGET_REFUSAL_TAG` block beside it — so a lane adding
 * one of these names to the `[features]` block above meets the reason and a
 * test, rather than the silence this comment used to be.
 */

/**
 * P2.450 — codex's two telemetry sections, which this writer wrote none of.
 *
 * ## Native-first: the mechanism is complete and we had simply never reached it
 *
 * The bundled binary carries the whole exporter — `log_user_prompt` ×9,
 * `OtelExporter` ×11, `OTEL_RESOURCE_ATTRIBUTES` ×1, `statsig-api-key` ×1,
 * against a nonsense control of 0 on the same rig — and `[otel]` is a real
 * top-level property of the pinned `config-schema.json`. What made it
 * unreachable is ours: `CODEX_HOME` is an `mkdtemp` directory this process
 * creates, writes whole and deletes, so an operator has no file to put `[otel]`
 * in. The seam therefore has to be the host's, and it is the SAME one Pi and
 * claude already answer to — `telemetryOptedIn` / `telemetryOptedOut` /
 * `otelExporterDisabled` over the standard `OTEL_*` env. The caller resolves it;
 * this leaf emits what it is handed.
 *
 * ## `log_user_prompt`: the default is FALSE, read rather than assumed
 *
 * `core/src/config/otel.rs` at `rust-v0.150.1`, the `log_user_prompt` binding —
 * `let log_user_prompt = config.log_user_prompt.unwrap_or(false);` — agreeing
 * with `OtelConfig::default()`. When it is false, `SessionTelemetry::user_prompt`
 * logs `prompt = "[REDACTED]"` and keeps only `prompt_length`. It is written
 * EXPLICITLY, and always, for the reason `view_image = true` is written above:
 * an upstream default flip would otherwise start shipping prompt text out of
 * every codex session with nothing failing anywhere. There is deliberately no
 * option to set it true — the host's other two streams carry no prompt content
 * either (`monitoring-usage.md`'s `OTEL_LOG_USER_PROMPTS` is implemented in
 * neither), and a switch that only exists on one runtime is the silent
 * divergence the native-first rule exists to prevent.
 *
 * ## `[analytics] enabled = false`: an egress nobody had decided on
 *
 * Two independent consumers read `analytics_enabled`, and they disagree about
 * the default. `core/src/otel_init.rs:70` gates the METRICS exporter on
 * `config.analytics_enabled.unwrap_or(default_analytics_enabled)`, and the
 * app-server's own `main.rs:108` passes `false` for that argument (spelled there
 * as an inline `default_analytics_enabled` label on the literal) —
 * so codex's `metrics_exporter` default of `OtelExporterKind::Statsig`, which
 * `otel/src/config.rs:24` resolves in a release build to OTLP/HTTP JSON at
 * `https://ab.chatgpt.com/otlp/v1/metrics` under a hard-coded key, is already
 * off for this binary. `analytics/src/client.rs:230` does NOT agree:
 * `queue: (analytics_enabled != Some(false)).then(…)` means UNSET is ENABLED,
 * so the analytics event client is live, posting to
 * `{chatgpt_base_url}/codex/analytics-events/events` (both strings present ×1 in
 * the bundled binary). On a fork whose entire posture is that traffic goes to
 * the T-Bank gateway, that is an egress we never chose. `Some(false)` closes
 * both readers at once, which is why `metrics_exporter = "none"` is NOT also
 * written: with `enabled = false` the `unwrap_or` can never run, and a guard
 * that cannot fire reads as protection that is not there.
 *
 * Stated rather than slipped in, per AGENTS.md's transparent-and-simple rule:
 * this is a product-posture choice — codex sessions stop reporting to OpenAI's
 * analytics endpoint — taken because nothing in this fork ever decided they
 * should, and it is visible in the projected `config.toml` for anyone who looks.
 *
 * ## What is NOT projected, and why — the residue, stated
 *
 * - **Traces and metrics.** Only the LOG signal is projected, because only the
 *   log signal is what the host's gate speaks about (`OTEL_LOGS_EXPORTER`) and
 *   only it carries the fourteen event names. codex's own field comment warns
 *   that enabling log export must not implicitly send spans to a `/v1/logs`
 *   endpoint, so `trace_exporter` stays unwritten rather than guessed.
 * - **`OTEL_EXPORTER_OTLP_HEADERS`.** codex's `OtlpHttp.headers` is a literal
 *   map with no env indirection, so honouring it would mean writing a collector
 *   credential into a file on disk. Every credential in this writer is an env
 *   var NAME (`env_key`, `bearer_token_env_var`) and none is a value; the caller
 *   refuses the projection instead and says so.
 * - **`[otel].environment`.** Left at codex's `DEFAULT_OTEL_ENVIRONMENT`,
 *   `"dev"` — observed on the wire as `env=dev`. The host does not know whether
 *   it is running in production, and an operator who does can say so through
 *   `OTEL_RESOURCE_ATTRIBUTES`, which is read (measured below).
 * - **`span_attributes`.** Deliberately NOT the marker's channel: it is applied
 *   by `SpanAttributesProcessor::on_start`, i.e. to TRACE SPANS only, so the
 *   marker would be invisible on the very stream this projects. The marker rides
 *   `OTEL_RESOURCE_ATTRIBUTES` on the child env instead, in `CodexAgent`.
 *
 * ## Live proof, bundled `codex-app-server` 0.148.0 (darwin-arm64), one run
 *
 * Control first, on this very key: `[otel] log_user_prompt = 42` produced
 * `configWarning` *"Invalid configuration; using defaults."* with
 * `config.toml:18:19: invalid type: integer 42, expected a boolean` — the
 * WHOLE-FILE fail-open observed here rather than assumed, taking the provider
 * block and every deny floor with it. The real emission produced ZERO warnings.
 * A rename arm (`[otelx]`) produced ZERO warnings too — an unknown top-level
 * table is dropped in SILENCE — so `validateConfigAgainstSchema` is the only
 * detector for an upstream rename, which is why both keys are guarded there.
 * `[analytics] enabled` got its own pair, because arm 4 means silence proves
 * nothing on its own: `enabled = 42` rejected the whole file at
 * `config.toml:13:11`, `enabledx = 42` was silent, `enabled = false` was
 * accepted — so the key we write is one the binary genuinely reads.
 * With the exporter pointed at a loopback collector, two OTLP/HTTP JSON POSTs
 * arrived at `/v1/logs` carrying `codex.conversation_starts` and
 * `codex.startup_phase`, on a resource reading
 * `service.name=codex-app-server, service.version=0.148.0, env=dev,
 * nessy.telemetry.coverage=codex-events-only` — the marker travelling by env,
 * end to end, on the log signal.
 */
/**
 * P6.224 — the five `GranularApprovalConfig` members, in the schema's own order,
 * as an inline-table body.
 *
 * The two OPTIONAL members are omitted when unset rather than written as their
 * documented `false` default: writing a runtime's own default back looks like a
 * choice somebody made, and the next reader cannot tell the two apart.
 *
 * THROWS when the policy is `granular` and no config was handed over. The
 * schema's object variant is `{"required": ["granular"]}`, and codex's config
 * failure is WHOLE-FILE — an empty `granular = {}` would take the provider block
 * and every deny floor down with it. Failing at the writer is the loud
 * direction.
 */
function granularApprovalMembers(config: CodexGranularApprovalConfig | undefined): string {
  if (!config) {
    throw new Error(
      'approval_policy "granular" needs CodexConfigOptions.granularApproval: '
      + 'the schema requires the `granular` member and codex rejects the whole file without it',
    );
  }
  const bool = (value: boolean): string => (value ? 'true' : 'false');
  return [
    `sandbox_approval = ${bool(config.sandbox_approval)}`,
    `rules = ${bool(config.rules)}`,
    `mcp_elicitations = ${bool(config.mcp_elicitations)}`,
    ...(config.request_permissions === undefined
      ? []
      : [`request_permissions = ${bool(config.request_permissions)}`]),
    ...(config.skill_approval === undefined ? [] : [`skill_approval = ${bool(config.skill_approval)}`]),
  ].join(', ');
}

function buildCodexOtelToml(opts: CodexConfigOptions): string[] {
  const endpoint = opts.otelLogsEndpoint?.trim();
  const tracesEndpoint = opts.otelTracesEndpoint?.trim();
  // P6.488 · sorted, so the same header map always produces the same bytes —
  // `codexThreadConfigSignature` hashes this file's output and a key-order
  // dependent hash respawns the runtime for no reason.
  const headerEntries = Object.entries(opts.otelLogsHeaders ?? {}).sort(
    ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
  );
  const otlpHeaders = headerEntries.length > 0
    ? headerEntries.map(([key, value]) => `${tomlString(key)} = ${tomlString(value)}`).join(', ')
    : '';
  return [
    '[otel]',
    // The privacy pin. Always written, never configurable — see the docblock.
    'log_user_prompt = false',
    // An INLINE table rather than an `[otel.exporter.otlp-http]` header, so that
    // nothing bare can ever be emitted into a sub-table by a later edit — the
    // same swallow trap `[features]` and `[agents]` are placed around above.
    // `protocol = "json"` matches what the host's own Pi exporter posts
    // (`otlp-telemetry.ts` sets `Content-Type: application/json`), so one
    // collector sees one wire format whichever runtime is speaking.
    ...(endpoint
      ? [`exporter = { otlp-http = { endpoint = ${tomlString(endpoint)}, protocol = "json"`
        // P6.488 · the headers, when the caller's opt-in produced any. Written
        // INSIDE the same inline table for the reason the table itself exists:
        // a bare `headers = …` after this line would land in whatever table
        // opened next.
        + `${otlpHeaders ? `, headers = { ${otlpHeaders} }` : ''} } }`]
      : []),
    // P6.459 arm (1) · codex's OWN spans, on the same `OtelExporterKind` union
    // and in the same inline-table shape as the logs exporter above — one
    // collector, one wire format, whichever signal is speaking. Written only
    // when the caller's `tracingOptedIn` gate produced a traces endpoint; codex's
    // own default is `OtelExporterKind::None`, so `"none"` would be a key that
    // changes nothing.
    ...(tracesEndpoint
      ? [`trace_exporter = { otlp-http = { endpoint = ${tomlString(tracesEndpoint)}, protocol = "json"`
        + `${otlpHeaders ? `, headers = { ${otlpHeaders} }` : ''} } }`]
      : []),
    '',
    '[analytics]',
    'enabled = false',
    '',
  ];
}

/**
 * UA12.24 — the `tool_timeout_sec` floor on `[mcp_servers.session]`, in
 * seconds, ALWAYS emitted for that entry (see `CodexConfigOptions.mcpToolTimeoutSec`
 * for the two-clock story). Derived from the session bridge's own per-route
 * ceiling for host callbacks — `host-callback-bridge-client.ts` `BRIDGE_TIMEOUT_MS`,
 * 120 000 ms — plus one, the same margin discipline the caller's P6.140
 * arithmetic takes: every host outcome on a session tool call (a verdict, the
 * 110 s card timeout that resolves a publish/archive/delete card to a DENY —
 * `server-core` `sessions/artifact-publishing.ts` `PUBLISH_ARTIFACT_CARD_TIMEOUT_MS`
 * and `pages/tool-callbacks.ts` `DELETE_PAGE_CARD_TIMEOUT_MS` — or this
 * ceiling's own abort) lands BEFORE codex gives up, so the model receives the
 * host's own attributed answer instead of a bare timeout. The +1 is pinned
 * against the bridge's literal by
 * `__tests__/config-writer-session-tool-timeout.test.ts`, which reddens if the
 * ceiling moves without this floor moving.
 */
export const CODEX_SESSION_TOOL_TIMEOUT_SEC = Math.ceil(120_000 / 1000) + 1;

/**
 * Build the config.toml text. Kept as a plain string template (no TOML lib):
 * the shape is fixed and small.
 */
export function buildCodexConfigToml(opts: CodexConfigOptions): string {
  // P6.532 · the loopback table below is the only reader of `adapterPort`, and a
  // declared session suppresses that table — so the port is required exactly
  // when the table is written. Refusing here rather than defaulting keeps the
  // failure at the caller: a `0` would produce a syntactically valid
  // `base_url = "http://127.0.0.1:0/v1"` that no session can reach.
  if (!opts.declaredModelProvider && typeof opts.adapterPort !== 'number') {
    throw new Error('codex config: adapterPort is required unless the session declares its own model_provider');
  }
  const derived = opts.mode ? codexSandboxConfigForMode(opts.mode, opts.sandboxGloballyEnabled ?? true) : undefined;
  const sandboxMode = derived?.sandbox_mode ?? opts.sandboxMode ?? 'workspace-write';
  const approvalPolicy = derived?.approval_policy ?? opts.approvalPolicy ?? 'on-request';
  // P3.2 — auto-review is meaningful only while the approval loop is interactive.
  // codex's eligibility rule is "with `never` there is nothing to review", so a
  // `never` policy degrades to emitting nothing rather than an inert key.
  const emitAutoReview = codexConfigEmitsAutoReview(opts.approvalsReviewer, approvalPolicy); // F1.373 — the one gate
  const autoReviewPolicy = emitAutoReview && typeof opts.autoReviewPolicy === 'string'
    ? opts.autoReviewPolicy.trim()
    : '';
  const reasoningEffort = opts.thinkingLevel ? REASONING_EFFORT[opts.thinkingLevel] : undefined;
  const planModeReasoningEffort = opts.planModeThinkingLevel
    ? REASONING_EFFORT[opts.planModeThinkingLevel]
    : undefined;
  const runtimePolicy = resolveRuntimePolicy(opts);
  const hasFilesystemPolicy = hasCodexFilesystemPolicy(runtimePolicy);
  // P3.234 + P3.286 · the off-switch moves the LIMIT key only. The window is
  // written in both positions, because withholding it hands codex a fabricated
  // 272 000 rather than "no window" and the 90 % term fires off that. See
  // `autoCompactionEnabled` for the source read and the four binary arms.
  const contextWindow = resolveCodexContextWindow(opts);
  const autoCompactLimit = opts.autoCompactionEnabled === false
    ? undefined
    : autoCompactTokenLimit(contextWindow);
  // Trimmed before the emptiness test, so a caller handing us a composer's
  // whitespace-only output gets codex's own default rather than a blank prompt.
  const compactPrompt = opts.compactPrompt?.trim();
  // P3.348 · guarded at the leaf as well as at the caller, because a wrong-TYPED
  // value is not a bad key here — it is `Invalid configuration; using defaults.`,
  // which discards the provider block, the sandbox mode and every denied path
  // along with it. `format: uint` in the schema; anything else emits nothing.
  const toolOutputTokenLimit = resolveToolOutputTokenLimit(opts.toolOutputTokenLimit);
  // P3.347 · same leaf guard, same reason — see `resolveCodexSubagentCeiling`.
  const maxConcurrentSubagentThreads = resolveCodexSubagentCeiling(opts.maxConcurrentSubagentThreads);
  const maxSubagentSpawnDepth = resolveCodexSubagentCeiling(opts.maxSubagentSpawnDepth);
  // P6.140 · resolved ONCE for both `[mcp_servers.*]` entries below, so the two
  // cannot drift into different deadlines for one operator lever.
  const mcpToolTimeoutSec = resolveCodexMcpToolTimeoutSec(opts.mcpToolTimeoutSec);
  // P6.155 · trimmed and emptiness-checked at the leaf, the discipline every
  // other resolver in this function follows: a blank string here is not a
  // model, and a wrong-TYPED value in this file discards the WHOLE config.
  const defaultSubagentModel = typeof opts.defaultSubagentModel === 'string'
    && opts.defaultSubagentModel.trim().length > 0
    ? opts.defaultSubagentModel.trim()
    : undefined;
  const lines = [
    `model = ${tomlString(opts.model)}`,
    ...(contextWindow !== undefined ? [`model_context_window = ${contextWindow}`] : []),
    // The trigger. Absent, codex uses its own 90% of the window above — which is
    // higher than ours, never absent, and is exactly what the off position buys.
    ...(autoCompactLimit !== undefined
      ? [`model_auto_compact_token_limit = ${autoCompactLimit}`]
      : []),
    // P2.436 · the other half of compaction: WHEN it fires is the limit above,
    // WHAT it preserves is this. A top-level scalar string, so it belongs in
    // this block before the first table header — a `[features]` opened above
    // would swallow it, the same trap `approvals_reviewer` records below.
    //
    // Emitted only when there is something to say. codex ships its own
    // compaction prompt, and handing it an empty string would replace that
    // default with nothing — strictly worse than never writing the key.
    ...(compactPrompt ? [`compact_prompt = ${tomlString(compactPrompt)}`] : []),
    // P3.348 · the host's output ceiling, in codex's own unit. A bare top-level
    // integer, so it belongs in this block before the first table header, for
    // the reason `compact_prompt` above records. Written only when the caller
    // hands one over, which it does only for an operator who set the host value
    // explicitly — see `CodexConfigOptions.toolOutputTokenLimit` for codex's own
    // measured default (10 000 BYTES) and why a projection raises rather than
    // lowers what the model sees.
    ...(toolOutputTokenLimit !== undefined ? [`tool_output_token_limit = ${toolOutputTokenLimit}`] : []),
    ...(reasoningEffort ? [`model_reasoning_effort = ${tomlString(reasoningEffort)}`] : []),
    // P6.368 · codex's own plan-phase effort, beside the execution one and under
    // the same bare-scalar placement rule. See
    // `CodexConfigOptions.planModeThinkingLevel` for why the host owns the name.
    ...(planModeReasoningEffort
      ? [`plan_mode_reasoning_effort = ${tomlString(planModeReasoningEffort)}`]
      : []),
    // P6.532 · the pin was UNCONDITIONAL, and our own writer was the only thing
    // standing between an operator and a provider codex already ships.
    //
    // Source, `rust-v0.148.0` (STRONG tier): `built_in_model_providers`
    // (`codex-rs/model-provider-info/src/lib.rs`) returns `amazon-bedrock` and
    // `amazon-bedrock-runtime` beside `openai`, so a declared value resolves
    // against the built-in catalogue with no table of ours. Codex then looks the
    // id up in the merged map and FAILS the load when it is absent —
    // `format!("Model provider `{model_provider_id}` not found")`,
    // `codex-rs/core/src/config/mod.rs` — which is the failure mode this row
    // wants: a mis-resolved provider stops the session instead of quietly
    // routing somewhere else.
    `model_provider = ${tomlString(opts.declaredModelProvider ?? CODEX_PROVIDER_KEY)}`,
    // Hosted web_search executes on OpenAI's backend — unreachable through the
    // Nestor adapter, so keep it out of the model's tool list there (and on an
    // operator's Bedrock account, where nobody has measured it).
    //
    // F1.570 · ON THE CHATGPT (CODEX) CARD (`declaredModelProvider: 'openai'`)
    // turns go to exactly that backend, so this line is NOT written and codex
    // resolves its own default — `resolve_web_search_mode(&cfg, &features)
    // .unwrap_or(WebSearchMode::Cached)` (`core/src/config/mod.rs`,
    // `rust-v0.156.1`). Two things ride with it, both keyed on
    // {@link codexConfigFollowsCodexWebSearch}: the host's own `web_search`
    // session tool is withheld through `disabled_tools` on `[mcp_servers.session]`
    // (one search tool in front of the model, not two), and the operator's
    // P6.339 allowlist is written as `[tools.web_search] allowed_domains`.
    //
    // P6.339 said the mode and the allowlist share one slot, so both could not
    // be written. The pinned schema keeps them apart — the mode is the top-level
    // `web_search` (`WebSearchMode`), the allowlist is `tools.web_search`
    // (`ToolsToml` -> `WebSearchToolConfig`) — and codex reads them apart
    // (`resolve_web_search_mode` / `resolve_web_search_config`). What stands is
    // the other half: an allowlist on a tool that is off reads as protection
    // nobody has, so it is written only where the search is on. Host-side the
    // same list is live on Pi and on the host search
    // (`shared/config/web-search-allowlist.ts`).
    ...(codexConfigFollowsCodexWebSearch(opts) ? [] : [`web_search = "disabled"`]), // F1.1061 — also on the card when the user denies WebSearch
    // P6.224 · `granular` is the object variant of `AskForApproval`, so it is the
    // one policy that is NOT a bare string. An INLINE table, for the reason
    // every other inline table in this block records: nothing bare can then be
    // emitted into a sub-table by a later edit.
    approvalPolicy === 'granular'
      ? `approval_policy = { granular = { ${granularApprovalMembers(opts.granularApproval)} } }`
      : `approval_policy = ${tomlString(approvalPolicy)}`,
    // P3.2 · a top-level scalar, so it stays in this block BEFORE the first
    // table header — a `[features]`/`[auto_review]` opened above would swallow
    // it. Only present when eligible (interactive policy); `never` emits nothing.
    ...(emitAutoReview ? [`approvals_reviewer = ${tomlString('auto_review')}`] : []),
    // P3.315 · THESE TWO KEYS DISAGREE ON `danger-full-access`, THE BINARY OBEYS
    // THE SECOND, AND THE RESIDUE IS DELIBERATE.
    //
    // Source, `rust-v0.148.0` (strong): `resolve_permission_config_syntax`
    // (`core/src/config/mod.rs`) sets `Legacy` from `sandbox_mode` and then
    // UNCONDITIONALLY sets `Profiles` from `default_permissions` — the second
    // assignment is not guarded, so within ONE layer the profile wins, and
    // `sandbox_mode` is then read only in `Config::load`'s final `else`.
    //
    // Driven on the bundled `darwin-arm64/codex-app-server` (W3-a, 2026-09-03),
    // asserting `ThreadStartResponse.sandbox`, with the controls that make each
    // row a reading rather than an inference:
    //
    //   our shipped shape: `danger-full-access` + this profile -> workspaceWrite
    //   CONTROL:           `danger-full-access` alone           -> dangerFullAccess
    //   our read-only shape (profile extends `:read-only`)      -> readOnly (agrees)
    //   CONTROL:           `read-only` alone                    -> readOnly
    //
    // **So the sandbox-OFF master switch does not work on codex**: the host
    // writes `danger-full-access`, the binary enforces the `:workspace`-derived
    // `workspaceWrite`, and exactly one of our seven modes diverges (the
    // credential floor is unconditional, so a profile is always emitted, which
    // is why the other six agree).
    //
    // NOT FIXED HERE, and the reason is the criterion rather than the effort.
    // Every respelling is a PRODUCT POSTURE, and none of them both closes the
    // divergence and keeps the credential floor:
    //
    //   - `default_permissions = ":danger-full-access"` (dropping this profile)
    //     resolves to `dangerFullAccess`, driven — and takes the OS-level
    //     credential deny with it, because a deny is enforced BY the sandbox and
    //     that arm has none. Closes the divergence, drops the floor.
    //   - `sandbox_mode = "workspace-write"` whenever a profile is emitted makes
    //     the config honest at the cost of making sandbox-off INEXPRESSIBLE on
    //     codex — a user-visible policy change owing a switch-cost row.
    //   - `extends = ":danger-full-access"` is FATAL, not an option:
    //     `extensible_builtin_parent_profile` resolves only `:read-only` and
    //     `:workspace`, and the driven arm discards the WHOLE `config.toml`
    //     (`cannot extend unsupported built-in profile`, stderr only) — P2.330's
    //     fail-open shape.
    //   - A THIRD candidate W3-a measured but did not frame as an option, and
    //     the only one that might satisfy both halves: a profile with no
    //     `extends`, `"/" = "write"`, `network.enabled` and the deny kept
    //     resolved to `workspaceWrite` with `writableRoots: ["/"]`,
    //     `networkAccess: true` and **the deny retained**. It is still not
    //     `dangerFullAccess` — the sandbox mechanism stays engaged — so it
    //     redefines what "sandbox off" MEANS on codex rather than delivering it.
    //     That is an owner call, not a lane's.
    //
    // Nothing is silently wrong in the meantime: `CodexAgent.noteResolvedSandboxPolicy`
    // reads `thread/start`'s own resolved `sandbox` and raises a durable operator
    // notice naming which of the two is in force (W3-a, `6b9216811`). Reading
    // codex's answer survives the precedence changing; restating today's rule
    // here would not.
    `sandbox_mode = ${tomlString(sandboxMode)}`,
    ...(hasFilesystemPolicy
      ? [`default_permissions = ${tomlString(NESSY_RUNTIME_PERMISSION_PROFILE)}`]
      : []),
    '',
    // P6.392 · codex's instruction-discovery keys — `project_doc_fallback_filenames`
    // and `project_root_markers`. BARE top-level keys, so they belong in this
    // block before the first table header, for the reason `compact_prompt` above
    // records; the builder's own header carries the source reading and why the
    // byte cap is left unwritten (an install that configured nothing keeps
    // codex's own default rather than having ours pinned on top of it).
    ...buildCodexProjectDocTomlLines(),
    '',
    // Turn codex's model-driven multi-agent tools on explicitly. `multi_agent`
    // is a boolean under the release `config-schema.json` `[features]` table
    // ("Optional feature toggles scoped to this profile"), distinct from
    // `agents.enabled` (which defaults true and gates the tools; this gates the
    // FEATURE). Written HERE, among the top-level tables and BEFORE `[agents]`,
    // for the reason the `[agents]`-LAST comment records: every key under
    // `[agents]` is a role name, so a `[features]` opened after it would be
    // swallowed. Nothing bare follows this line — only table headers do — so
    // `multi_agent` stays scoped to `[features]`.
    '[features]',
    `multi_agent = true`,
    // P3.116 · DECLARE the dependency we were inheriting.
    //
    // `view_image` is codex's image-capable tool — codex has NO `read` tool, its
    // handlers do file reading through `shell`, and `view_image` is the one that
    // returns an IMAGE CONTENT ITEM rather than bytes
    // (`core/src/tools/handlers/view_image.rs` at `rust-v0.150.1`, the tag our
    // manifest pinned then). That is what makes P3.54's design work on the third
    // runtime: an image carried across a runtime switch is handed over as a
    // NAMED PATH the model reads back on demand, in position, one tool call — and
    // on codex the tool that reads it back is this one.
    //
    // MEASURED against the shipped binary, not read off a page (darwin-arm64,
    // `apps/electron/resources/bin/codex/darwin-arm64/codex-app-server`
    // self-reporting `0.148.0`, 2026-08-28): `experimentalFeature/list` reports
    // `view_image` as `{stage:"stable", defaultEnabled:true, enabled:true}` among
    // 114 features. Writing `view_image = false` flips `enabled` to `false` while
    // `defaultEnabled` stays `true` — so this key genuinely controls the tool,
    // measured in both directions.
    //
    // Until this line we set it NOWHERE and inherited `defaultEnabled` silently.
    // A future codex release flipping that default would remove the mechanism the
    // runtime-switch handover rests on **with nothing failing** — the pointer
    // would still be written, the model would simply have no way to open it.
    // Declared explicitly, a default flip cannot reach us; a RENAME still can, so
    // `validateConfigAgainstSchema` drift-guards the key name as well.
    `view_image = true`,
    // P6.487 · codex's OWN goal engine, turned OFF explicitly — the only key in
    // this block written `false`, and the reason it is written at all.
    //
    // P2.2 ruled the goal HOST-side: one goal per thread, held and enforced by
    // us, and `thread/goal/set` is deliberately never called (plan :1836,
    // Dev-9). But not calling a subsystem is not the same as it being off:
    // codex's own goal engine stayed running beside ours, able to hold a second
    // goal on the same thread, with the model told about a surface the host does
    // not read.
    //
    // MEASURED on the pinned binary before this line existed
    // (`apps/electron/resources/bin/codex/darwin-arm64/codex-app-server`,
    // `rust-v0.148.0`, 2026-09-06, load average 12.05), through the real
    // `CodexRuntimeManager` + `AppServerClient` against a scratch `CODEX_HOME`
    // written by this very writer: `experimentalFeature/list` answered 114
    // entries in one page (`nextCursor: null`) and reported
    // `goals` = `{stage:"stable", enabled:true, defaultEnabled:true}` — ON, by
    // default, with `multi_agent` as the positive control (same shape, and a
    // name that does not exist answered nothing at all). So the owner's Q20
    // condition — "option B, but ONLY after the probe" — is satisfied by a
    // reading rather than by an assumption, and the key is written.
    //
    // `= false` and not omitted: an omitted key inherits `defaultEnabled`, which
    // is exactly the silent inheritance P3.116 wrote `view_image` explicitly to
    // end, in the opposite direction.
    `goals = false`,
    // P6.533 · THE STABLE USER-FACING SUBSET, written explicitly — six keys that
    // decide what this product does and were, until this block, decided by a
    // vendor default nobody in this tree had read.
    //
    // ## Why write them at all, when every one of them is already the default
    //
    // codex's `[features]` table carries 124 keys in the pinned
    // `config-schema.json`; we wrote three. The other 121 are not "off" — they
    // are whatever `default_enabled` says on the binary we happen to ship, and a
    // codex bump can move any of them with NOTHING failing: the key stays
    // schema-valid, the config still loads, the capability behind it simply
    // changes. That is the same silent inheritance P3.116 wrote `view_image`
    // explicitly to end, and the answer is the same one — declare the pole, so a
    // default flip cannot reach a user through us.
    //
    // Owner-delegated decision 2026-09-05 (Q-den 74) chose exactly this: write
    // the stable user-facing subset with a stated reason AT THE SITE. Option 1
    // (leave them unwritten) was refused because the fork then cannot say what
    // its own product does; option 3 (expose them as settings) was refused
    // because it mints seven single-runtime settings and a new silent
    // divergence.
    //
    // ## The pole each one takes, and why it is `true` for all six
    //
    // MEASURED, both sides, 2026-09-06 at load average 9.19 — the SOURCE at the
    // tag `packages/codex-protocol/manifest.json` pins (`rust-v0.148.0`,
    // `features/src/lib.rs` registry + the `Feature` doc comments) AND the
    // shipped `darwin-arm64/codex-app-server` driven through the real
    // `CodexRuntimeManager` against a `CODEX_HOME` written by this very writer:
    // `experimentalFeature/list` answered 114 entries in ONE page
    // (`nextCursor: null`, histogram stable 36 / underDevelopment 40 / removed 33
    // / deprecated 3 / beta 2), and all six below read
    // `{stage:"stable", enabled:true, defaultEnabled:true}`. Negative control
    // `zzz_nessy_not_a_real_feature` was NOT LISTED; positive control — this
    // writer's own `goals = false` came back `enabled:false` against
    // `defaultEnabled:true`, which is what proves the block below actually
    // reaches the binary rather than being parsed and dropped.
    //
    // `true` was TODAY'S BEHAVIOUR for all six when the block was written, so
    // writing it changed nothing a user could see. That was deliberate: turning
    // one OFF is a PRODUCT POSTURE, the owner's call and not a lane's — while
    // leaving them unwritten keeps the posture hostage to the next vendor
    // default. Pinning today's pole was the only one of the three options that
    // was both honest and reversible.
    //
    // P6.726 · AND THE CALL WAS THEN TAKEN, for two of the six. The owner
    // answered P6.533 on 2026-09-07: `apps` and `remote_plugin` OFF, with the
    // reason at each key (below). So the block is now four ON and two OFF, plus
    // `goals`, and `CODEX_DEPENDED_FEATURES` lists only the four — a key we turn
    // off is refused rather than depended on, exactly as `goals` already was.
    //
    // ## The re-diff obligation, recorded where the next bump lane meets it
    //
    // P3.283 is the codex bump. On every bump, re-diff this block against the
    // 124 `properties/features` keys in `packages/codex-protocol/schema/config-schema.json`
    // and re-read the stages — a key that leaves `stable`, or a new user-facing
    // key that arrives, belongs in this decision and not in the silence.
    // `experimental-features.test.ts` ties every `= true` line here to
    // `CODEX_DEPENDED_FEATURES`, so a key added below without its name there
    // fails; `codexDependedFeatureStageNotice` then reports the day codex stages
    // any of them `deprecated`/`removed` or stops listing it.
    //
    // Codex's own hook mechanism — `Feature::CodexHooks`, "Enable Claude-style
    // lifecycle hooks loaded from hooks.json files". We WRITE an inline `[hooks]`
    // table (P6.14/P2.414) and `core/src/session/mod.rs` gates hook dispatch on
    // this flag, so a default flip would leave our table sitting in a config
    // codex parses and never runs.
    `hooks = true`,
    // `Feature::UnifiedExec`, "Use the single unified PTY-backed exec tool". It
    // decides WHICH exec tool the model is given, and therefore which tool names
    // our event adapter and approval bridge see; a flip would rename the surface
    // every codex turn is built around.
    `unified_exec = true`,
    // `Feature::ShellSnapshot`, "Experimental shell snapshotting" — stable stage
    // despite the word. It decides what environment a shell command inherits, so
    // a flip changes what every `shell` call in every session can see.
    //
    // C4.33 · and it needs NO bundled shell, which is the opposite of what the
    // row that asked assumed. MEASURED at `rust-v0.150.1`:
    // `shell-command/src/shell_snapshot.rs` emits a SCRIPT per shell type, and
    // the interpreter comes from `shell-command/src/shell_detect.rs`
    // `get_shell_path` — the user's login shell from `getpwuid`, then
    // `which::which("zsh")`, then `ZSH_FALLBACK_PATHS = ["/bin/zsh"]` (bash and
    // sh have their own fallbacks). Nothing in that chain is a path inside the
    // release archive, and the shipped `darwin-arm64` binary scores
    // `codex-resources/zsh` **0** against `/bin/zsh` **2** on the same scan.
    //
    // The bundled `codex-resources/zsh/bin/zsh` is real
    // (`scripts/codex_package/zsh.py`, `ZSH_RESOURCE_PATH`) and belongs to a
    // DIFFERENT feature: the patched zsh fork behind `shell_zsh_fork`
    // (`Stage::UnderDevelopment`, `default_enabled: false`) and
    // `unified_exec_zsh_fork` (`Stage::Removed`). This block writes neither, so
    // nothing this product turns on is missing a binary. `scripts/fetch-codex.mjs`
    // carries the same reading where the extraction list lives.
    `shell_snapshot = true`,
    // `Feature::Apps`, "Enable apps". Gates the connector surface and, with
    // `Feature::Plugins`, the recommended-plugin candidates codex injects into
    // the developer message (`core/src/session/mod.rs`).
    //
    // P6.726 · OFF, and the posture call above was taken: the owner answered
    // P6.533 on 2026-09-07 — turn both this and `remote_plugin` off, with the
    // reason at the key. THE REASON: apps are ChatGPT CONNECTORS, served by
    // OpenAI's own backend. Every session this product opens runs against the
    // Nessy Gateway (or a BYO endpoint) through our loopback Responses adapter,
    // which serves `/v1/responses` and nothing else, so the connector surface
    // cannot be reached from here at all. ON, it offers the model and the user a
    // surface that answers nothing; OFF, it is absent, which is what it already
    // effectively was.
    `apps = false`,
    // `Feature::FastMode`, "Enable Fast mode selection in the TUI and request
    // layer" — and the REQUEST half is the one that reaches us: it participates
    // in `get_service_tier` (`core/src/session/mod.rs`), so a flip changes what
    // this session asks the upstream for.
    `fast_mode = true`,
    // `Feature::RemotePlugin`, "Enable the PS-backed remote plugin catalog".
    // Narrower for us than it looks — the global catalog half is additionally
    // gated on `auth_mode.is_some_and(DomainAuthMode::uses_codex_backend)`
    // (`app-server/src/request_processors/plugins.rs`) and we authenticate with a
    // synthetic key against our own provider — but the marketplace list it
    // decides is user-visible, so the pole is stated rather than inherited.
    //
    // P6.726 · OFF, same owner answer, same reason in its own shape: the catalog
    // is PS-backed, its global half already refuses without codex-backend auth,
    // and this product's plugin marketplace is the host's own
    // (`plugins/marketplace-registry-store.ts`). ON, it can only ever show an
    // empty or unreachable list beside the one that works — a user-visible
    // surface that is exactly as inert as `apps`, which is why the owner
    // answered both keys at once.
    `remote_plugin = false`,
    // C3.253 · `Feature::Plugins`, "Enable plugins" — OFF, and this one is not a
    // posture about a surface, it is an EGRESS nobody in this fork had decided
    // on. Same shape as `[analytics] enabled = false` above, measured the same
    // way.
    //
    // ## What a boot did before this line, measured 2026-09-11 (W15-e)
    //
    // On the shipped `rust-v0.150.1` binary with `RUST_LOG=debug`, EVERY session
    // start — before a token, before a turn — logged *"failed to warm featured
    // plugin ids cache … remote featured plugin request to
    // `https://chatgpt.com/backend-api/plugins/featured?platform=codex` failed
    // with status 403"* and materialised `CODEX_HOME/.tmp/plugins-clone-<rand>/`
    // with 25 plugin directories. That clone is what makes a session home
    // 26–76 MB instead of 2.8 MB, and every byte of it is thrown away: the home
    // is an `mkdtemp` directory `CodexAgent.createRuntime` creates and
    // `cleanupRuntimeResources` deletes.
    //
    // ## The gate, read from the source rather than guessed
    //
    // `core-plugins/src/manager.rs` at `rust-v0.150.1`,
    // `maybe_start_plugin_startup_tasks_for_config`, opens `if
    // config.plugins_enabled {` and EVERY network task of the boot is inside it:
    // `maybe_start_curated_repo_sync_for_config` (→ `sync_openai_plugins_repo`,
    // whose `startup_sync.rs` constants are `https://api.github.com`,
    // `https://github.com/openai/plugins.git` and
    // `https://chatgpt.com/backend-api/plugins/export/curated`),
    // `maybe_start_remote_plugin_caches_refresh`,
    // `maybe_start_remote_installed_plugin_bundle_sync`,
    // `maybe_start_remote_catalog_cache_refresh`, and
    // `featured_plugin_ids_for_config` (→
    // `remote_legacy::fetch_remote_featured_plugin_ids`, `{chatgpt_base_url}/plugins/featured`).
    // `config.plugins_enabled` is `self.features.enabled(Feature::Plugins)`
    // (`core/src/config/mod.rs`, `plugins_config_input`), and the spec is
    // `Stage::Stable, default_enabled: true` (`features/src/lib.rs`) — so it was
    // ON by inheritance, never by a decision.
    //
    // Note that `remote_plugin = false` above does NOT close it and in one place
    // OPENS it wider: `maybe_start_curated_repo_sync_for_config` runs when
    // `plugins_enabled && !remote_global_catalog_active(config)`, and the remote
    // catalogue being off is exactly what makes the git clone the fallback.
    //
    // ## What turning it off costs us: nothing, and that is measurable
    //
    // codex's plugin subsystem loads plugins from `CODEX_HOME`. This product's
    // `CODEX_HOME` is a per-runtime `mkdtemp` outside every agent-writable root (F1.652), created
    // per session, written whole by THIS file (`config.toml`, `agents/<role>.toml`,
    // `rules/nessy.rules`, `installation_id`) and deleted at teardown — there has
    // never been a plugin in it. Nothing in this tree calls codex's `plugins/*`
    // RPCs; the host's own plugin store projects components through the seams
    // that already exist (`[hooks]`, `mcp_servers`, `[agents]`, `skills/*`). So
    // the subsystem this disables had no input and no reader here.
    //
    // `config-writer-plugin-egress-live.test.ts` drives both arms against the
    // shipped binary behind a refusing loopback proxy sink, so the control arm
    // RECORDS the egress without performing it.
    `plugins = false`,
    // F1.1215 · `Feature::WriteStdinApproval`, "Require approval before writing
    // input to escalated unified-exec terminals" — ON, and stated rather than
    // inherited because `rust-v0.159.3` FLIPPED it: `features/src/lib.rs` had it
    // `Stage::UnderDevelopment`, `default_enabled: false` at `rust-v0.156.1` and
    // has it `Stage::Stable`, `default_enabled: true` at the tag we ship now
    // (re-read on the wire 2026-10-01: `{stage:"stable", enabled:true,
    // defaultEnabled:true}`). This is P6.533's obligation on a bump: a new
    // stable user-facing key belongs in this decision, not in the silence.
    //
    // `true` is codex's own default (native-first) AND the safe pole: it only
    // ADDS an approval — typing into a terminal that runs with permissions beyond
    // the baseline, or whose policy drifted since launch, is asked first
    // (`core/src/unified_exec/stdin_approval.rs`). The host already renders that
    // frame honestly: `approval-bridge.ts` reads `kind: "writeStdin"` (P7.2),
    // names the act as sending input to the running terminal, and mints no
    // durable grant from it. OFF would remove a consent codex now asks for by
    // default — a safety trade no row has decided.
    `write_stdin_approval = true`,
    // P2.456 · the two keys this block does NOT contain, recorded here because
    // the row that named them assumed the opposite and the next lane will too.
    //
    // `tool_search` and `tool_search_always_defer_mcp_tools` are real
    // `[features]` properties in the pinned `config-schema.json`, so they look
    // exactly like the `multi_agent`/`view_image` switches above. They are not
    // switches. Both are `Stage::Removed` at `rust-v0.148.0` — "the feature flag
    // is useless but kept for backward compatibility reason" — `apply_map`
    // `continue`s past them before the arm that would apply the boolean, and
    // `Feature::ToolSearch`/`Feature::ToolSearchAlwaysDeferMcpTools` have ZERO
    // readers in the codex tree. Measured against the bundled binary in both
    // directions with `view_image` as the live control, neither key moves
    // anything, and nothing warns that a dead key was written.
    //
    // What actually decides deferral is `search_tool_enabled` —
    // `model_info.supports_search_tool && provider.capabilities().namespace_tools`
    // — and NEITHER operand is reachable from `config.toml`. Our gateway models
    // fall to codex's fallback model metadata, which hardcodes
    // `supports_search_tool: false`, so codex loads tools upfront on every Nessy
    // session and only the gateway's own `/models` could change that.
    //
    // So there is nothing to enable here, and a key written anyway would be
    // inert, unobservable (`emit_metrics` skips `Stage::Removed`) and shaped
    // like a control. `config-writer-tool-search.test.ts` carries the full
    // measurement and pins both keys out.
    '',
    // P6.99 · a FOURTH key, named here because "absent" and "refused" look the
    // same from outside and this one is neither inert nor inapplicable.
    //
    // `retain_client_developer_messages` — read at `rust-v0.148.0`,
    // `features/src/lib.rs`: `FeatureSpec { id:
    // Feature::RetainClientDeveloperMessages, key:
    // "retain_client_developer_messages", stage: Stage::UnderDevelopment,
    // default_enabled: false }` (`:1495`-`:1500`), doc comment at `:291`-`:292`
    // "Retain client-authored developer messages across compacted context
    // windows." It is in the pinned release schema TWICE
    // (`properties.features.properties.…` and the `ConfigProfile` twin) and
    // three times in the shipped `darwin-arm64` binary's strings — positive
    // control `multi_agent` 258, negative control `nessy_not_a_feature` 0 — so
    // it is real and settable.
    //
    // ## Three things that make it different from the two refusals above
    //
    // 1. **Its subject exists here.** We DO author developer messages into a
    //    codex thread: `developerInstructions` on `thread/start`, `thread/fork`
    //    and `thread/resume` (`codex-agent.ts:3169`, `:4643`), carrying the
    //    output style. So this is not `computerUse`-style inapplicability —
    //    the capability the flag offers is one this product would want.
    // 2. **It is APPLIED, not swallowed.** `Features::apply_map`
    //    (`features/src/lib.rs:494`-`:571`) `continue`s past fourteen named
    //    keys; this one is not among them, so it falls through to
    //    `feature_for_key` → `self.enable(feat)`. Writing it turns something on.
    // 3. **`Stage::UnderDevelopment` is codex's own words for "not ready".**
    //    `features/src/lib.rs:43`-`:44`: "Features that are still under
    //    development, not ready for external use". `Stage::Removed` (the two
    //    refusals above) means the flag does nothing; this one means the code
    //    behind it is unfinished.
    //
    // ## The decision, stated: REFUSED BY NAME, with an exit condition
    //
    // Turning on an upstream path its own author marks not-ready, on every
    // codex session of a shipped product, is a product posture and not a
    // plumbing choice — and the one thing that would justify it, being able to
    // SEE whether retention happened, we do not have: codex compacts
    // server-side, which is exactly why ledger E3 is STRUCTURAL for codex.
    // An unobservable influence on what the model is carrying is worse than an
    // absent one (AGENTS.md, native-first).
    //
    // It also does not close E3. E3 is STEERING the summary; this preserves
    // client-authored developer messages ACROSS one. Adjacent, not the same.
    //
    // EXIT CONDITION, so this is a decision and not a dead end: the day the
    // stage moves off `UnderDevelopment` at the tag we ship, revisit — the
    // capability is wanted, and the only objection recorded here is readiness
    // plus unobservability. `config-writer.test.ts` pins the refusal and the
    // reason at this site.
    // P3.306 · a THIRD key this block deliberately does not contain, and the one
    // that is worse than the two above: `codex_git_commit`.
    //
    // Found by W2-z asking P2.11's native-first question — an unattended commit
    // is a capability the host was about to BUILD, and codex appears to carry a
    // flag for it. It is in the pinned release schema TWICE (top-level
    // `[features]` and `ConfigProfile.features`) and twice in the shipped
    // binary's strings, so by the "bundle is the denominator" rule it is real
    // and settable. It is not a mechanism.
    //
    // Read at `rust-v0.148.0`: `FeatureSpec { id: Feature::CodexGitCommit, key:
    // "codex_git_commit", stage: Stage::Removed, default_enabled: false }`
    // (`features/src/lib.rs`), and `Stage::Removed` is codex's own words — "the
    // feature flag is useless but kept for backward compatibility reason".
    // `Feature::CodexGitCommit` has ZERO readers outside `features/` (0 in
    // `core`, `protocol`, `config`, `app-server`, `tui`, `exec`, `cli`,
    // `common`), against `Feature::MemoryTool` at 4 in `core` and 12 in `tui` as
    // the positive control that the same probe finds a consumed feature.
    //
    // ## Why it is worse than `tool_search`, and why that matters here
    //
    // `tool_search` is in `Features::apply_map`'s explicit `continue` list, so
    // writing it leaves the feature OFF. `codex_git_commit` is NOT in that list:
    // it falls through to `feature_for_key` and `self.enable(feat)`. So the key
    // IS applied — and then read by nobody. Measured on the shipped binary:
    // with the key written, `experimentalFeature/list` reports
    // `{"name":"codex_git_commit","stage":"removed","enabled":true,
    // "defaultEnabled":false}` while `tool_search` in the same response reads
    // `enabled:false`. A future lane probing "is it on?" would be told YES by
    // codex itself about a flag that does nothing — the false-assurance shape
    // this tree keeps having to delete, one step further along than P2.456's.
    //
    // ## The prompt sentence is NOT conditioned on it
    //
    // The row asked, because P2.11 leans on it: *"Do not `git commit` your
    // changes or create new git branches unless explicitly requested."* It sits
    // in FIVE static prompt files at the tag (`models-manager/prompt.md`, which
    // is the `include_str!` behind `BASE_INSTRUCTIONS` and therefore the one our
    // unknown-slug sessions actually get, plus `core/gpt_5_1_prompt.md`,
    // `core/gpt_5_2_prompt.md`, `core/prompt_with_apply_patch_instructions.md`
    // and `protocol/src/prompts/base_instructions/default.md`), ONCE each, with
    // zero `{{` templating in any of them. P2.11's note says the prompt says it
    // "twice"; it is once per file, five files.
    //
    // Driven on the shipped `codex-app-server`, one turn per arm against the
    // stub Responses server, comparing what the MODEL receives:
    //
    // | arm                        | tools | tools sha | instructions sha |
    // | -------------------------- | ----- | --------- | ---------------- |
    // | baseline                   | 9     | 864af923  | ac8ae107         |
    // | `codex_git_commit = true`  | 9     | 864af923  | ac8ae107         |
    // | `multi_agent = false` CTRL | 8     | fe8224e3  | ac8ae107         |
    //
    // Identical instructions (20 751 chars, the sentence present) and an
    // identical tool set with the flag ON; the control moved the tool set in the
    // same rig, so the probe can see a real feature change. Nothing the model is
    // told or may do moves.
    //
    // ## The decision, stated rather than left as an absent key
    //
    // REFUSED, by name. Emitting it from a user's commit grant would advertise a
    // control codex does not implement, and the grant would have to be honoured
    // somewhere real anyway — which, for all three runtimes, is the model
    // committing under an explicit instruction (`headless.md#create-a-commit`),
    // not a vendor flag. P2.11 is where that posture is decided; this line only
    // records that codex's apparent native answer is not one.
    // P6.540 · the project trust entry. A TABLE, so it sits among the tables and
    // never after the load-bearing `[agents]`-LAST block.
    ...buildCodexProjectTrustToml(opts),
    // P2.450 · codex's own telemetry sections, both of them. TABLES, so they sit
    // among the tables and never after the load-bearing `[agents]`-LAST block.
    ...buildCodexOtelToml(opts),
    // P3.2 · `[auto_review].policy` (`AutoReviewToml`, a lone `policy` string)
    // carries our additions to codex's guardian prompt. A TABLE, so it sits
    // among the tables and never after the load-bearing `[agents]`-LAST block;
    // only written when auto-review is eligible AND a non-blank policy is given.
    ...(autoReviewPolicy
      ? ['[auto_review]', `policy = ${tomlString(autoReviewPolicy)}`, '']
      : []),
    ...(Object.keys(runtimePolicy.environment).length > 0 || opts.poolMcpUrl
      ? [
          '[shell_environment_policy]',
          ...(opts.poolMcpUrl
            ? [`exclude = [${tomlString(CODEX_POOL_MCP_TOKEN_ENV)}]`]
            : []),
          '',
          ...(Object.keys(runtimePolicy.environment).length > 0
            ? [
                '[shell_environment_policy.set]',
                ...Object.entries(runtimePolicy.environment).map(([key, value]) => `${tomlString(key)} = ${tomlString(value)}`),
                '',
              ]
            : []),
        ]
      : []),
    // P6.532 · the loopback provider TABLE is written only when the loopback is
    // what we pinned, and the reason is NOT the one the hand-off gave.
    //
    // Shadowing is impossible either way, measured from the source: our key is
    // `nessy_gateway`, and `merge_configured_model_providers`
    // (`codex-rs/model-provider-info/src/lib.rs`, `rust-v0.150.1`) inserts a
    // configured entry with `entry(key).or_insert(provider)` — built-ins are not
    // overridable at all, and the two bedrock ids are the ONE exception, taking
    // only `base_url`, `auth`, `http_headers` and `aws.*` and erroring on any
    // other field. So keeping this table beside a declared provider would be
    // legal and inert.
    //
    // It is suppressed for two other reasons. It is a DISCLOSURE: a session
    // routed to an operator's own Bedrock account should not carry a Nessy
    // Gateway provider definition, because a reader of the config would
    // reasonably conclude traffic can go through the gateway, and the adapter is
    // not even listening on that port for such a session. And it makes the
    // failure loud: with no table, a loopback pin reintroduced by mistake is
    // `Model provider `nessy_gateway` not found` at config load, rather than a
    // silent reroute through a port another session owns.
    //
    // `validateConfigAgainstSchema` needs no change for this: `requiredKeys`
    // asserts that codex's SCHEMA declares a top-level property, not that our
    // file contains the key, and `model_providers` is declared unconditionally.
    ...(opts.declaredModelProvider
      ? []
      : [
          `[model_providers.${CODEX_PROVIDER_KEY}]`,
          `name = ${tomlString('Nessy Gateway')}`,
          `base_url = ${tomlString(`http://127.0.0.1:${opts.adapterPort}/v1`)}`,
          `wire_api = ${tomlString('responses')}`,
          `env_key = ${tomlString(CODEX_API_KEY_ENV)}`,
          // P6.273 · the three retry keys codex publishes on this table and we
          // wrote none of. Omitted when the operator set nothing, so an
          // unconfigured install gets the same four lines it got before that row.
          ...(resolveCodexProviderRetryValue(opts.providerMaxRetries) === undefined
            ? []
            : [
                `request_max_retries = ${resolveCodexProviderRetryValue(opts.providerMaxRetries)}`,
                `stream_max_retries = ${resolveCodexProviderRetryValue(opts.providerMaxRetries)}`,
              ]),
          ...(resolveCodexProviderRetryValue(opts.providerStreamIdleTimeoutMs) === undefined
            ? []
            : [`stream_idle_timeout_ms = ${resolveCodexProviderRetryValue(opts.providerStreamIdleTimeoutMs)}`]),
          '',
        ]),
  ];

  // P3.273 · the `[permissions.*]` tables, emitted by the module that owns the
  // floor. Pushed HERE — after the provider block and before every remaining
  // table header — because the ordering inside those tables is load-bearing;
  // see `buildCodexPermissionsTomlLines`.
  lines.push(...buildCodexPermissionsTomlLines(runtimePolicy));

  // F1.570 · the operator's allowlist, on the one card whose search is codex's
  // own. A table, so it sits among the tables. See `codexWebSearchToolTableLines`.
  lines.push(...codexWebSearchToolTableLines(opts));

  // P2.508 · `required = true` IS DELIBERATELY NOT WRITTEN ON EITHER ENTRY
  // BELOW, and the reason is not caution — it is that the key cannot mean here
  // what an operator means by it.
  //
  // Codex has the mechanism and it works. Measured against the shipped
  // `darwin-arm64` `codex-app-server` (SHA-256 byte-identical to
  // `codex-protocol/manifest.json`'s pinned `binarySha256`), on BOTH transports
  // this function emits: with `required = true` on a server that cannot start,
  // `thread/start` and `thread/resume` fail — "required MCP servers failed to
  // initialize: <name>: …" — and the same config without the key starts fine.
  // That is the control, and it makes this configuration rather than
  // construction, which is normally the end of the native-first argument.
  //
  // It is not, because of the granularity. This function emits exactly TWO
  // `[mcp_servers.*]` entries — `session` and `sources` — and every MCP server
  // an operator configured reaches codex aggregated behind `sources`, one
  // loopback HTTP endpoint. `required` is a per-ENTRY key, so writing it could
  // only ever mark OUR two infrastructure servers. The case the mark exists for
  // — an operator's own server, declared essential, failing — leaves `sources`
  // perfectly healthy, and codex's mechanism would never fire for it. So
  // writing the key would not honour the operator's mark; it would silently
  // mark something else, and buy a hard start failure for the privilege.
  //
  // The cost, stated because it is a product posture and not ours to slip in:
  // marking these two required would turn "the pool endpoint lost a race at
  // startup" into a session that refuses to open, and codex offers no middle
  // setting. Choosing that is an owner call, and it is worth taking only
  // together with a way to project per-server criticality — which needs the
  // pool to expose its members to codex as entries, not a key here.
  //
  // What we take instead is codex's other half, and the two are mutually
  // exclusive: with `required` the thread never starts, so the failure
  // notification never arrives. Measured, the hard arm emitted no `mcpServer/*`
  // frame at all. `CodexAgent` subscribes to `mcpServer/startupStatus/updated`
  // and surfaces the failure to the operator instead — see
  // `codexMcpStartupFailureNotice` in `shared/src/agent/codex-agent.ts`.
  if (opts.sessionMcp) {
    const { command, args, env } = opts.sessionMcp;
    lines.push(
      '[mcp_servers.session]',
      `command = ${tomlString(command)}`,
      `args = [${args.map(tomlString).join(', ')}]`,
    );
    if (env && Object.keys(env).length > 0) {
      const inline = Object.entries(env).map(([k, v]) => `${k} = ${tomlString(v)}`).join(', ');
      lines.push(`env = { ${inline} }`);
    }
    // UA12.24 · the deadline on ONE tool call through this entry, ALWAYS
    // written: its tools wait for a person (the publish, archive and delete
    // cards), and codex's own default deadline was shorter than the card
    // window — see `CODEX_SESSION_TOOL_TIMEOUT_SEC`. The operator's lever may
    // loosen this value, never tighten it below the floor.
    lines.push(`tool_timeout_sec = ${Math.max(mcpToolTimeoutSec ?? 0, CODEX_SESSION_TOOL_TIMEOUT_SEC)}`);
    // F1.378 · the user's exact-name mcp__ deny/ask rules, in codex's own
    // per-server levers. See `CodexConfigOptions.mcpToolLevers`. F1.570 · on the
    // ChatGPT (Codex) card the host's `web_search` joins the deny list, because
    // codex's own search is on there. See `codexSessionMcpToolLevers`.
    lines.push(...codexMcpToolLeverLines('session', codexSessionMcpToolLevers(opts)));
    lines.push('');
  }

  if (opts.poolMcpUrl) {
    lines.push(
      '[mcp_servers.sources]',
      `url = ${tomlString(opts.poolMcpUrl)}`,
      `bearer_token_env_var = ${tomlString(CODEX_POOL_MCP_TOKEN_ENV)}`,
      // P6.140 · the lever only, explicit-set-only (`session` keeps UA12.24's 121 s floor). `sources` is the loopback
      // pool endpoint, so this is the entry where the host's own wall clock is
      // also running — the margin at the caller is what keeps the two from
      // racing.
      ...(mcpToolTimeoutSec !== undefined ? [`tool_timeout_sec = ${mcpToolTimeoutSec}`] : []),
      // F1.378 · as on `session`, keyed by the pool's own tool names.
      ...codexMcpToolLeverLines('sources', opts.mcpToolLevers?.sources),
      '',
    );
  }

  // P6.166 · `[memories]`, and only in the OFF position. A TABLE, so it sits
  // here with the other tables rather than among the bare keys — anything bare
  // emitted after a table header lands inside that table, the trap
  // `approvals_reviewer` and the `[agents]` placement comment both record.
  if (opts.memoriesEnabled === false) {
    lines.push(
      '[memories]',
      // The half that is MEASURED: a new thread is recorded `memory_mode =
      // "disabled"` in `state_5.sqlite`. See `CodexConfigOptions.memoriesEnabled`
      // for the two-arm run on the shipped binary.
      'generate_memories = false',
      // The half that is UNOBSERVABLE on a fresh `CODEX_HOME` and is written
      // anyway, with its reason recorded at the option rather than implied here.
      'use_memories = false',
      '',
    );
  }

  // P6.534 · `[skills.bundled]`, and only in the OFF position. A TABLE, so it
  // sits with the other tables rather than among the bare keys — the placement
  // trap `[memories]` above and the `[agents]` comment below both record.
  //
  // Codex's own key, not a host invention: `SkillsConfig.bundled.enabled`
  // defaults to `true`, so the absent table is codex's default and this line is
  // the only thing the host has to say. See
  // `CodexConfigOptions.bundledSkillsEnabled` for the 87 entries this reaches
  // and for what the user loses with them.
  if (opts.bundledSkillsEnabled === false) {
    lines.push(
      '[skills.bundled]',
      'enabled = false',
      '',
    );
  }

  // P6.14 · `[hooks]` sits HERE — after every bare top-level assignment and
  // before `[agents]` — for the same placement reason the `[agents]`-LAST
  // comment below records, and one more of its own: the table is written as
  // ARRAYS OF TABLES (`[[hooks.PreToolUse]]`, `[[hooks.PreToolUse.hooks]]`), so
  // anything bare emitted after it would land inside the last handler rather
  // than at the top level. Nothing bare follows.
  //
  // Diagnostics are deliberately dropped here: the pure builders never log
  // (`onDiagnostic` fires once per `writeCodexConfig`), so a build called for a
  // signature hash cannot double-report a rejected hook.
  lines.push(...buildCodexHooksToml(opts.hooks).lines);

  // `[agents]` LAST, and that placement is load-bearing: every key under it is
  // a role name, so a table opened here can never swallow a later top-level
  // assignment. `agents.enabled` — "Whether multi-agent tools are enabled.
  // Defaults to true" — is never written `true`: the spawn tools are
  // already on, and a role is additive guidance, not an authorization ("Agent-
  // role guidance below only helps choose which agent to use after spawning is
  // already authorized; it never authorizes spawning by itself", the binary's
  // own `spawn_agent` text).
  //
  // P6.309 (4) · that reason answers "why not write `true`" and never answered
  // "how does an operator turn delegation OFF". `subagentsEnabled: false` now
  // writes `enabled = false` and nothing else changes — see
  // `CodexConfigOptions.subagentsEnabled` for why only the explicit `false` is
  // honoured, and why the missing half is one host setting rather than one more
  // line here.
  //
  // P3.347 · the two subagent ceilings are the ONLY bare keys in this table, and
  // they must precede the first `[agents.<role>]` header for the reason above,
  // one level down: a bare assignment after `[agents.reviewer]` becomes
  // `agents.reviewer.max_depth`, which `AgentRoleToml` — `additionalProperties:
  // false` over three fields — refuses. Emitted only for a value the operator
  // set explicitly; see `CodexConfigOptions.maxConcurrentSubagentThreads` for
  // the measurement that established V1 is the backend in force and that both
  // keys are therefore live.
  const subagentCeilings = [
    // P6.309 (4) · the delegation off-switch, and it goes FIRST among the bare
    // keys for the placement rule the comment above states: a bare assignment
    // after the first `[agents.<role>]` header becomes `agents.<role>.enabled`,
    // which `AgentRoleToml` — `additionalProperties: false` over three fields —
    // refuses. Explicit `false` only; see
    // `CodexConfigOptions.subagentsEnabled` for why `true` is never written and
    // why the host half is a setting rather than another line here.
    ...(opts.subagentsEnabled === false ? ['enabled = false'] : []),
    // P6.155 · the cheap-helper model, and the THIRD bare key in this table.
    // Same placement rule as the two ceilings below it: before the first
    // `[agents.<role>]` header, or `AgentRoleToml` refuses it. See
    // `CodexConfigOptions.defaultSubagentModel` for what is measured and what
    // is not.
    ...(defaultSubagentModel !== undefined
      ? [`default_subagent_model = ${tomlString(defaultSubagentModel)}`]
      : []),
    ...(maxConcurrentSubagentThreads !== undefined
      ? [`max_concurrent_threads_per_session = ${maxConcurrentSubagentThreads}`]
      : []),
    ...(maxSubagentSpawnDepth !== undefined
      ? [`max_depth = ${maxSubagentSpawnDepth}`]
      : []),
  ];
  if (subagentCeilings.length > 0) {
    lines.push('[agents]', ...subagentCeilings, '');
  }

  for (const role of codexAgentRolesFor(opts).roles) {
    lines.push(
      `[agents.${role.roleName}]`,
      `description = ${tomlString(role.description)}`,
      `config_file = ${tomlString(role.configFile)}`,
      '',
    );
  }

  return lines.join('\n');
}

/**
 * P6.540 + F1.750 — `[projects."<path>"] trust_level = "trusted"` for a project
 * the host trusted, `"untrusted"` for every other project with a path, and
 * nothing at all without one.
 *
 * ## The state before this, and why it was invisible
 *
 * We write the whole per-session `CODEX_HOME` ourselves and never wrote a trust
 * entry, so EVERY project was untrusted by default — and codex's own gate then
 * kept each repository's checked-in `.codex/` layer out, permanently, with the
 * user never told. Owner decision 2026-09-05, D15 option 2: project the host's
 * existing `projectTrusted` onto codex's own `trust_level`. Option 1 (say so and
 * stay untrusted) was refused because the project layer then stays permanently
 * inert; option 3 (trust, but load a named subset) because that subset ages
 * against 94 top-level properties and diverges from codex's own semantics.
 *
 * ## Native-first, exactly: codex's own gate decides
 *
 * Nothing is re-implemented beside it. `config/src/loader/mod.rs`
 * (`rust-v0.148.0`) resolves a `ProjectTrustDecision` for the cwd, and
 * `disabled_reason_for_decision` gates *"project-local config, hooks, and exec
 * policies"* on `decision.is_trusted()` — an untrusted or undecided project has
 * its discovered layer pushed with a `disabled_reason` instead. Writing the
 * entry is the whole mechanism.
 *
 * ## The KEY is a path, and this is why `projectRoot` is required
 *
 * `project_trust_context` reads `projects` off the MERGED USER config — which is
 * the `CODEX_HOME/config.toml` this writer produces — and looks the cwd up by
 * `normalized_project_trust_keys`, then the project root, then the git repo root.
 * So an absolute directory path is the key, and an entry for the repo root
 * covers every cwd inside it.
 *
 * ## THE ACCEPTED COST, stated because the owner is buying it
 *
 * A trusted project's checked-in `.codex/` gains REAL EFFECT, including config
 * keys we do not audit, and its hooks and exec policies with it. That is a
 * supply-chain posture and it is the owner's, recorded here rather than implied.
 * The credential floor is unchanged (owner sitting §3.1 already fixes its
 * precedence over `danger-full-access`).
 *
 * ## The `sandbox_mode` consequence, MEASURED rather than restated
 *
 * codex's own rule seeds more than the project layer from a trust decision. All
 * four sites, read at `rust-v0.148.0` — and three of them are INERT here,
 * because each falls back to trust only when the key we always write is absent:
 *
 *  - **`sandbox_mode`** — `config_toml.rs`'s `derive_permission_profile` takes
 *    `sandbox_mode_override.or(self.sandbox_mode)` and consults the trust
 *    decision only `.or_else(…)`, i.e. when neither is set. This writer emits
 *    `sandbox_mode` UNCONDITIONALLY, so the seeding cannot fire.
 *  - **`approval_policy`** — `core/src/config/mod.rs` picks `OnRequest` for a
 *    trusted project and `UnlessTrusted` for an untrusted one, but only inside
 *    `.unwrap_or_else(…)` after `approval_policy_override.or(cfg.approval_policy)`.
 *    This writer emits `approval_policy` unconditionally too.
 *  - **`default_permissions`** — `default_builtin_permission_profile_name`
 *    (`core/src/config/permissions.rs`) answers `workspace` for a project with a
 *    trust decision and `read-only` for one without, and it is reached only as
 *    the `unwrap_or_else` for an unselected profile id. Where this writer emits
 *    `default_permissions = "nessy_runtime"` (whenever a filesystem policy
 *    exists) it is pre-empted the same way.
 *  - **THE RESIDUAL, named rather than talked away:** in a session with NO
 *    filesystem policy, so no `default_permissions`, that implicit builtin can
 *    move from `read-only` to `workspace` on the strength of a trust decision
 *    alone. It is narrow today — the sandbox is OFF by standing owner decision
 *    and our shipped `sandbox_mode` is `danger-full-access`, under which the
 *    profile is unrestricted either way — but it is real the day the sandbox
 *    comes back, and it is written here so it is rediscovered then.
 *
 * ## F1.750 — an untrusted project is written `untrusted`, because ABSENT is not
 * ## the fail-closed pole any more
 *
 * This section used to say `untrusted` was deliberately never emitted, and that
 * absent was the fail-closed pole. MEASURED FALSE on the shipped 0.156.1
 * (WJ-crit-t, F1.723; re-measured by WJ-crit-aa): `thread_start_task`
 * (`app-server/src/request_processors/thread_processor.rs`, `rust-v0.156.1`)
 * AUTO-TRUSTS any cwd whose `active_project.trust_level.is_none()` — writing
 * `trust_level = "trusted"` into this very file and reloading — so absent became
 * trusted on the first thread open, and a project the user kept RESTRICTED had
 * its `.codex` layer loaded: its MCP server commands started, its
 * `rules/*.rules` applied. An explicit `untrusted` is `Some(..)`, so the
 * auto-trust never fires and `disabled_reason_for_decision` keeps the layer out.
 *
 * The two things `untrusted` does that absent did not, both accepted (DECIDED by
 * the controller, F1.750 — the user's "Keep restricted" must mean restricted):
 *
 *  - it seeds `workspace-write` / `UnlessTrusted` — but only as the fallback for
 *    an unset `sandbox_mode` / `approval_policy`, and this writer emits both
 *    unconditionally (and the host restates them as the request layer, F1.723),
 *    so neither seeding can fire;
 *  - `core/src/agents_md.rs` `load_project_instructions` reads NO project
 *    AGENTS.md for an `is_untrusted()` project (I2.27). That is the stated cost
 *    (said per session as the `codex-project-trust` fact), and it is content the
 *    host's own capability resolver already withholds from an untrusted project
 *    (`capabilities/native-sources.ts`, "Trust boundary").
 *
 * `projectTrusted` other than an explicit `true` is untrusted, the host's own
 * fail-closed rule. The KEY is the caller's (`CodexAgent`'s
 * `codexProjectTrustOptionsFor`): the cwd for `untrusted`, the git repo root for
 * `trusted` — see that function for why the two differ.
 */
export function buildCodexProjectTrustToml(opts: Pick<CodexConfigOptions, 'projectRoot' | 'projectTrusted'>): string[] {
  const root = opts.projectRoot?.trim();
  if (!root) return [];
  return [`[projects.${tomlString(root)}]`, `trust_level = ${opts.projectTrusted === true ? '"trusted"' : '"untrusted"'}`, ''];
}

/** The one place the writer's options are projected onto the role builder. */
function codexAgentRolesFor(opts: CodexConfigOptions): CodexAgentRolePlan {
  return buildCodexAgentRoles({
    codexHome: opts.codexHome,
    sessionModel: opts.model,
    // P6.550 · the same value P6.155 writes as the GLOBAL
    // `[agents] default_subagent_model`, so the per-role layer and the global
    // default can never name two different cheap models.
    ...(opts.defaultSubagentModel ? { cheapSubagentModel: opts.defaultSubagentModel } : {}),
    ...(opts.mode ? { sessionMode: opts.mode } : {}),
    ...(opts.agents ? { definitions: opts.agents } : {}),
  });
}

/**
 * Lightweight validation of the config values against the release
 * `config-schema.json` asset: confirms `approval_policy`, `sandbox_mode`, and
 * the provider `wire_api` are members of the schema's enums, and that the keys
 * we set are recognized top-level properties. The authoritative validation is
 * still `codex-app-server` accepting the config at `initialize` time (optionally
 * with `--strict-config`); this catches drift before spawn.
 */
/**
 * The string members of a named schema definition, whether it spells them as a
 * flat `enum` or as a `oneOf` of single-member enums (`OtelHttpProtocol` does
 * the latter). Module-level rather than a closure inside
 * `validateConfigAgainstSchema` so the `[otel]` guard, which runs early, is not
 * reading a `const` still in its temporal dead zone.
 */
function enumOfDefinition(
  defs: Record<string, { enum?: string[]; oneOf?: Array<{ enum?: string[] }> }>,
  name: string,
): string[] {
  const def = defs[name];
  if (!def) return [];
  if (def.enum) return def.enum;
  return (def.oneOf ?? []).flatMap(o => o.enum ?? []);
}

export function validateConfigAgainstSchema(
  opts: CodexConfigOptions,
  configSchemaPath: string,
): void {
  const schema = JSON.parse(readFileSync(configSchemaPath, 'utf8'));
  const props: Record<string, unknown> = schema.properties ?? {};
  const defs: Record<string, { enum?: string[]; oneOf?: Array<{ enum?: string[] }> }> =
    schema.definitions ?? {};

  // P2.450 · both telemetry tables are written unconditionally, so both are
  // guarded unconditionally. An unknown TOP-LEVEL table is IGNORED: silently up
  // to `rust-v0.154.0` (`[otelx]` → zero warnings), with one `configWarning` at
  // `rust-v0.156.1` (F1.255) — either way the privacy pin and the analytics
  // off-switch would stop arriving while the session ran, and only after it
  // started would anything say so. This check is the only one that refuses.
  const requiredKeys = ['model', 'model_reasoning_effort', 'model_provider', 'approval_policy', 'sandbox_mode', 'model_providers', 'features', 'otel', 'analytics'];
  if (hasCodexRuntimePathPolicy(opts)) {
    requiredKeys.push('default_permissions', 'permissions');
  }
  // P3.234 + P3.286 · the same gate the builder uses, through the same function,
  // for the same reason the rest of this function is written as "guard what we
  // WRITE": demanding schema properties for keys that are not in the file would
  // make a drift guard fire on a config it does not describe. The window is now
  // written in both switch positions; only the limit key follows the off-switch.
  const guardedWindow = resolveCodexContextWindow(opts);
  if (guardedWindow !== undefined) requiredKeys.push('model_context_window');
  if (opts.autoCompactionEnabled !== false && autoCompactTokenLimit(guardedWindow) !== undefined) {
    requiredKeys.push('model_auto_compact_token_limit');
  }
  // P2.436 · the same drift guard the rest of this function applies, and this
  // key needs it MORE than the ones above, not less. Both halves measured
  // against the bundled `codex-app-server`, control-first, same binary same run:
  //
  // - a WRONG-TYPED value is loud and catastrophic — `compact_prompt = 42`
  //   produced `configWarning` "Invalid configuration; using defaults." naming
  //   `config.toml:4:18`, and "using defaults" discards the WHOLE file: the
  //   provider block, the sandbox mode, every `deniedReadPath`.
  // - an UNKNOWN top-level key is IGNORED. The identical config with the key
  //   renamed produced ZERO warnings then (one `configWarning` naming the key at
  //   `rust-v0.156.1`, F1.255) — an upstream rename still costs the steering
  //   and the session still starts.
  //
  // This check is therefore the only detector for the second case.
  if (opts.compactPrompt?.trim()) requiredKeys.push('compact_prompt');
  // P3.348 · same drift guard, same reason: an unknown top-level NAME is ignored
  // (announced only after start, P2.509), so the ceiling would stop arriving.
  if (resolveToolOutputTokenLimit(opts.toolOutputTokenLimit) !== undefined) {
    requiredKeys.push('tool_output_token_limit');
  }
  // P6.540 · the same drift guard every other table gets, and this one needs it
  // in the direction that is hardest to notice: an unknown top-level NAME is
  // IGNORED by this binary (the P2.509 measurement below), so an upstream rename
  // of `projects` or of `trust_level` would leave the entry sitting in a config
  // codex parses and ignores — and the repository layer would go back to never
  // loading, with the user told nothing, which is the exact state this row exists
  // to end.
  if (buildCodexProjectTrustToml(opts).length > 0) {
    requiredKeys.push('projects');
    const projectProps: Record<string, unknown> =
      ((defs.ProjectConfig as { properties?: Record<string, unknown> } | undefined)?.properties) ?? {};
    if (!('trust_level' in projectProps)) {
      throw new Error('config-schema.json ProjectConfig has no property "trust_level"');
    }
    // F1.750 · the member THIS config spells, `untrusted` included: a value the
    // enum lacks fails deserialization rather than being ignored (read, not
    // measured — P2.436 measured a wrong-typed value discarding the whole file).
    const trustLevel = opts.projectTrusted === true ? 'trusted' : 'untrusted';
    const trustLevels = enumOfDefinition(defs, 'TrustLevel');
    if (trustLevels.length && !trustLevels.includes(trustLevel)) {
      throw new Error(`TrustLevel "${trustLevel}" not in schema enum [${trustLevels}]`);
    }
  }
  if (Object.keys(opts.shellEnvironment ?? {}).length > 0 || opts.poolMcpUrl) requiredKeys.push('shell_environment_policy');
  if (opts.sessionMcp || opts.poolMcpUrl) requiredKeys.push('mcp_servers');
  // P6.166 · the same nested guard `tool_timeout_sec` gets below, for the same
  // reason: an upstream rename of either key would leave the table sitting in a
  // config codex parses and ignores, and the user's off-switch would silently
  // stop reaching the runtime.
  if (opts.memoriesEnabled === false) {
    requiredKeys.push('memories');
    const memoriesProps: Record<string, unknown> =
      ((defs.MemoriesToml as { properties?: Record<string, unknown> } | undefined)?.properties) ?? {};
    for (const key of ['generate_memories', 'use_memories']) {
      if (!(key in memoriesProps)) {
        throw new Error(`config-schema.json MemoriesToml has no property "${key}"`);
      }
    }
  }
  // P6.534 · the same nested guard, and this table needs BOTH levels checked:
  // an upstream rename of `skills.bundled` or of its `enabled` would leave the
  // table sitting in a config codex parses and ignores — silent, the failure
  // mode P2.436 measured for unknown names on this binary — and the user's off
  // switch would go back to reaching codex nowhere while looking like it worked.
  if (opts.bundledSkillsEnabled === false) {
    requiredKeys.push('skills');
    const skillsProps: Record<string, unknown> =
      ((defs.SkillsConfig as { properties?: Record<string, unknown> } | undefined)?.properties) ?? {};
    if (!('bundled' in skillsProps)) {
      throw new Error('config-schema.json SkillsConfig has no property "bundled"');
    }
    const bundledProps: Record<string, unknown> =
      ((defs.BundledSkillsConfig as { properties?: Record<string, unknown> } | undefined)?.properties) ?? {};
    if (!('enabled' in bundledProps)) {
      throw new Error('config-schema.json BundledSkillsConfig has no property "enabled"');
    }
  }
  // P6.140/UA12.24 · the nested guard, in the `AgentsToml` shape above rather
  // than the top-level list: `tool_timeout_sec` is a property of
  // `RawMcpServerConfig`, so an upstream rename would leave the key sitting in
  // a table codex parses and ignores — silent, the failure mode P2.436 measured
  // for unknown names on this binary — and the hung transport would go back to
  // having no deadline. UNCONDITIONAL since UA12.24: the session entry always
  // emits the key, lever or no lever.
  {
    const toolTimeoutProps: Record<string, unknown> =
      ((defs.RawMcpServerConfig as { properties?: Record<string, unknown> } | undefined)?.properties) ?? {};
    if (!('tool_timeout_sec' in toolTimeoutProps)) {
      throw new Error('config-schema.json RawMcpServerConfig has no property "tool_timeout_sec"');
    }
  }
  // F1.378 · the MCP rule levers, guarded the same nested way: an unknown key
  // under `[mcp_servers.*]` is parsed and IGNORED, so a rename upstream would
  // quietly give a denied tool back to the model.
  if (codexMcpToolLeversEmitSomething(opts.mcpToolLevers)) {
    const mcpProps: Record<string, unknown> =
      ((defs.RawMcpServerConfig as { properties?: Record<string, unknown> } | undefined)?.properties) ?? {};
    for (const key of ['disabled_tools', 'tools'] as const) {
      if (!(key in mcpProps)) throw new Error(`config-schema.json RawMcpServerConfig has no property "${key}"`);
    }
    const toolProps: Record<string, unknown> =
      ((defs.McpServerToolConfig as { properties?: Record<string, unknown> } | undefined)?.properties) ?? {};
    if (!('approval_mode' in toolProps)) {
      throw new Error('config-schema.json McpServerToolConfig has no property "approval_mode"');
    }
    const approvalEnum = enumOfDefinition(defs, 'AppToolApproval');
    if (approvalEnum.length && !approvalEnum.includes('prompt')) {
      throw new Error(`approval_mode "prompt" not in schema AppToolApproval enum [${approvalEnum}]`);
    }
  }
  // F1.570 · the allowlist table and the withheld host search, guarded the same
  // nested way and for the same reason: a renamed key is ignored, so the
  // operator's allowlist would stop narrowing codex's search in silence.
  requiredKeys.push(...codexWebSearchSchemaGuard(opts, defs));
  // P6.273 · the three provider retry keys, guarded the way `tool_timeout_sec`
  // is: an unknown key under `[model_providers.*]` is IGNORED by this binary
  // (P2.436's measurement, recorded below), so an upstream rename would take the
  // operator's ceiling away in silence rather than loudly.
  if (
    resolveCodexProviderRetryValue(opts.providerMaxRetries) !== undefined
    || resolveCodexProviderRetryValue(opts.providerStreamIdleTimeoutMs) !== undefined
  ) {
    const providerProps: Record<string, unknown> =
      ((defs.ModelProviderInfo as { properties?: Record<string, unknown> } | undefined)?.properties) ?? {};
    const needed = [
      ...(resolveCodexProviderRetryValue(opts.providerMaxRetries) === undefined
        ? []
        : ['request_max_retries', 'stream_max_retries']),
      ...(resolveCodexProviderRetryValue(opts.providerStreamIdleTimeoutMs) === undefined
        ? []
        : ['stream_idle_timeout_ms']),
    ];
    for (const key of needed) {
      if (!(key in providerProps)) {
        throw new Error(`config-schema.json ModelProviderInfo has no property "${key}"`);
      }
    }
  }
  const hooksToml = buildCodexHooksToml(opts.hooks);
  if (hooksToml.lines.length > 0) requiredKeys.push('hooks');
  const rolePlan = codexAgentRolesFor(opts);
  // P3.347 · the two bare `[agents]` keys demand the table too, and their own
  // properties inside it — an unknown NAME under `[agents]` is not merely
  // ignored here, it is read as a ROLE (`AgentsToml.additionalProperties ->
  // AgentRoleToml`), so an upstream rename would turn a ceiling into a
  // half-formed agent rather than into silence.
  // P6.155 · the third bare key joins the same guard, for the same reason: an
  // unknown NAME under `[agents]` is read as a ROLE, so an upstream rename would
  // turn the cheap-helper model into a half-formed agent rather than into
  // silence.
  const emitsDefaultSubagentModel = typeof opts.defaultSubagentModel === 'string'
    && opts.defaultSubagentModel.trim().length > 0;
  // P6.309 (4) · the off-switch joins the same guard, and it is the bare key that
  // needs it MOST: `enabled` is ALSO a reserved role name, so an upstream rename
  // would not merely drop the switch — it would leave a bare boolean under a
  // table whose unknown names are read as ROLES, which is the arm measured to
  // discard the WHOLE file ("Invalid configuration; using defaults.").
  const emitsSubagentsDisabled = opts.subagentsEnabled === false;
  const emitsSubagentCeiling = emitsDefaultSubagentModel
    || emitsSubagentsDisabled
    || resolveCodexSubagentCeiling(opts.maxConcurrentSubagentThreads) !== undefined
    || resolveCodexSubagentCeiling(opts.maxSubagentSpawnDepth) !== undefined;
  if (emitsSubagentCeiling) {
    requiredKeys.push('agents');
    const agentsProps: Record<string, unknown> =
      ((defs.AgentsToml as { properties?: Record<string, unknown> } | undefined)?.properties) ?? {};
    for (const key of ['max_concurrent_threads_per_session', 'max_depth']) {
      if (resolveCodexSubagentCeiling(
        key === 'max_depth' ? opts.maxSubagentSpawnDepth : opts.maxConcurrentSubagentThreads,
      ) === undefined) continue;
      if (!(key in agentsProps)) {
        throw new Error(`config-schema.json AgentsToml has no property "${key}"`);
      }
    }
    if (emitsSubagentsDisabled && !('enabled' in agentsProps)) {
      throw new Error('config-schema.json AgentsToml has no property "enabled"');
    }
    if (emitsDefaultSubagentModel && !('default_subagent_model' in agentsProps)) {
      throw new Error('config-schema.json AgentsToml has no property "default_subagent_model"');
    }
  }
  if (rolePlan.roles.length > 0) {
    requiredKeys.push('agents');
    // The role config layer is a Config layer, so the two keys we set in it that
    // ARE ConfigToml properties have to still be ConfigToml properties. (`name`
    // is not one — it belongs to the role-file struct in `agent_roles.rs`,
    // which the release schema does not describe, so it cannot be checked here.)
    requiredKeys.push('developer_instructions');
  }
  for (const key of requiredKeys) {
    if (!(key in props)) {
      throw new Error(`config-schema.json has no top-level property "${key}"`);
    }
  }
  // P2.509 · `additionalProperties: false` IS DECLARED BY THE SCHEMA AND NOT
  // ENFORCED BY THE BINARY — read this once; the two checks below rest on it
  // too, and all three used to claim the opposite.
  //
  // Re-measured at `rust-v0.156.1` (F1.255, 2026-09-24) on the shipped
  // `darwin-arm64` `codex-app-server`, every arm on one rig in one run, each
  // with its control; what MOVED since `rust-v0.154.0` is the unknown NAME:
  //
  // - unknown NAME in `[features]`, `[otel]`, `[analytics]` or at the top
  //   level — now ONE `configWarning`, "Codex is ignoring 1 unrecognized
  //   configuration setting …", naming the key; the key is ignored and
  //   `thread/start` succeeds. (Until `rust-v0.154.0`: total silence.)
  // - a `[features]` key at stage `removed` (`tool_search_always_defer_…`):
  //   still silent — no warning, and its reported `enabled` ignores config.
  // - unknown NAME in `[agents.<role>]` — silent for the optional key
  //   (`config_file` renamed: no warning, session starts, the role simply
  //   loses its config file). Renaming `description` DOES warn, but the
  //   diagnostic is "must define a description" and the session STILL STARTS
  //   with the role dropped — a missing-required-field rule the loader applies
  //   and the schema does not even express (`AgentRoleToml` has no `required`
  //   list). Not a rejection; a silently absent role in a running session.
  // - POSITIVE CONTROLS, same rig: a wrong-TYPED value is loud everywhere.
  //   `view_image = "yes"` and `[otel] environment = 42` each yield the
  //   `configWarning` "Invalid configuration; using defaults." and
  //   `thread/start` failing `-32600 failed to load configuration` — and
  //   "using defaults" discards the WHOLE file.
  //
  // So codex rejects the whole config for a bad VALUE and never for a bad NAME.
  // A renamed key is now ANNOUNCED (a `configWarning`, which the host reports)
  // and still IGNORED — the steering stops arriving while the session runs —
  // and a key retired by stage, or an agent-role key, is still silent. **These
  // schema checks remain the only detector that REFUSES before spawn, on every
  // table below; codex's warning only arrives after the session has started
  // without the key.**
  //
  // Confirm the keys we write still exist, the same drift guard the role keys
  // get below.
  const featureProps: Record<string, unknown> =
    (props.features as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
  // P6.487 · `goals` joins the guard for the SAME reason and not a weaker one:
  // it is written `false`, so an upstream RENAME would leave codex's own goal
  // engine running beside the host's with nothing failing — the silent shape
  // this list exists to catch, in the off direction.
  // P6.533 · the six explicit user-facing keys join the same guard, and they need
  // it for the reason measured directly above: an unknown NAME in `[features]`
  // is TOTALLY SILENT on this binary, so an upstream rename would leave every one
  // of them inert while the session looked healthy — which is precisely the state
  // writing them was supposed to end.
  for (const key of [
    'multi_agent', 'view_image', 'goals',
    'hooks', 'unified_exec', 'shell_snapshot', 'apps', 'fast_mode', 'remote_plugin',
    // C3.253 · and `plugins` needs this guard MORE than the keys written `true`,
    // not less: it is written `false` to close an egress, so an upstream rename
    // would silently re-open `chatgpt.com` and `github.com` on every session
    // start with nothing failing anywhere — the same off-direction silence
    // `goals` joined this list for.
    'plugins',
  ]) {
    if (!(key in featureProps)) {
      throw new Error(`config-schema.json [features] has no property "${key}"`);
    }
  }
  // P2.450, corrected by P2.509 · `OtelConfigToml` and `AnalyticsConfigToml`
  // are both `additionalProperties: false` in the schema, and this comment used
  // to conclude that a rename of a key we write "makes codex reject the WHOLE
  // file, which is the loud failure". Measured, it does not: an unknown name in
  // either table is as silent as an unknown table, so BOTH halves of that
  // sentence are the quiet failure and this check is the only thing that sees
  // either. See the P2.509 block above for the arms and their controls.
  const otelProps: Record<string, unknown> =
    (schema.definitions?.OtelConfigToml as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
  if (!('log_user_prompt' in otelProps)) {
    throw new Error('config-schema.json OtelConfigToml has no property "log_user_prompt"');
  }
  const analyticsProps: Record<string, unknown> =
    (schema.definitions?.AnalyticsConfigToml as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
  if (!('enabled' in analyticsProps)) {
    throw new Error('config-schema.json AnalyticsConfigToml has no property "enabled"');
  }
  // P6.459 · the trace key gets the SAME guard as the logs key and for a sharper
  // reason: an unknown name in `[otel]` is silent, so a rename would leave a
  // session exporting no spans with nothing anywhere saying so.
  if (opts.otelTracesEndpoint?.trim() && !('trace_exporter' in otelProps)) {
    throw new Error('config-schema.json OtelConfigToml has no property "trace_exporter"');
  }
  if (opts.otelLogsEndpoint?.trim() || opts.otelTracesEndpoint?.trim()) {
    if (opts.otelLogsEndpoint?.trim() && !('exporter' in otelProps)) {
      throw new Error('config-schema.json OtelConfigToml has no property "exporter"');
    }
    // The exact variant shape emitted: `{ otlp-http = { endpoint, protocol } }`.
    // `OtelExporterKind` is an externally tagged enum, so the variant KEY is
    // part of the wire contract and a rename of it is as fatal as a field's.
    const kindVariants: Array<{ properties?: Record<string, unknown> }> =
      (schema.definitions?.OtelExporterKind as { oneOf?: Array<{ properties?: Record<string, unknown> }> } | undefined)?.oneOf ?? [];
    const httpVariant = kindVariants.find(variant => 'otlp-http' in (variant.properties ?? {}));
    const httpProps: Record<string, unknown> =
      ((httpVariant?.properties?.['otlp-http'] as { properties?: Record<string, unknown> } | undefined)?.properties) ?? {};
    for (const key of ['endpoint', 'protocol']) {
      if (!(key in httpProps)) {
        throw new Error(`config-schema.json OtelExporterKind otlp-http variant has no property "${key}"`);
      }
    }
    const protocolEnum = enumOfDefinition(defs, 'OtelHttpProtocol');
    if (protocolEnum.length && !protocolEnum.includes('json')) {
      throw new Error(`OtelHttpProtocol "json" not in schema enum [${protocolEnum}]`);
    }
  }
  if (hooksToml.lines.length > 0) {
    // P6.14 · the same drift guard `[features]` and `AgentRoleToml` get, and it
    // is the guard this surface most needs: `HooksToml` is keyed by EVENT NAME,
    // codex spells each of its events in two cases (PascalCase in TOML,
    // lowerCamel on the wire), and a key `HooksToml` has no field for is dropped
    // in silence — a hook registered nowhere, with no warning anywhere. Checking
    // the plan's keys against the schema's own property list is the only thing
    // between a codex rename and a session whose hooks quietly stopped running.
    const hookProps: Record<string, unknown> =
      (schema.definitions?.HooksToml as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
    for (const event of CODEX_HOOK_EVENTS) {
      if (!(event in hookProps)) {
        throw new Error(`config-schema.json HooksToml has no property "${event}"`);
      }
    }
    // The handler shape we actually emit. `timeout` rather than `timeoutSec` is
    // the one every reader gets wrong — the WIRE type spells it `timeoutSec`.
    const handlerVariants: Array<{ properties?: Record<string, unknown> }> =
      (schema.definitions?.HookHandlerConfig as { oneOf?: Array<{ properties?: Record<string, unknown> }> } | undefined)?.oneOf ?? [];
    const commandVariant = handlerVariants.find(
      variant => (variant.properties?.type as { enum?: string[] } | undefined)?.enum?.includes('command'),
    );
    if (!commandVariant) {
      throw new Error('config-schema.json HookHandlerConfig has no "command" variant');
    }
    for (const key of ['command', 'commandWindows', 'timeout', 'async', 'statusMessage']) {
      if (!(key in (commandVariant.properties ?? {}))) {
        throw new Error(`config-schema.json HookHandlerConfig command variant has no property "${key}"`);
      }
    }
    const groupProps: Record<string, unknown> =
      (schema.definitions?.MatcherGroup as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
    for (const key of ['matcher', 'hooks']) {
      if (!(key in groupProps)) {
        throw new Error(`config-schema.json MatcherGroup has no property "${key}"`);
      }
    }
  }
  if (rolePlan.roles.length > 0) {
    // Corrected by P2.509 · this said an upstream rename of either key "turns
    // every declared role into a config-load failure — a session that never
    // starts". Measured, the session always starts, and the two keys fail
    // DIFFERENTLY: a renamed `config_file` is wholly silent and the role just
    // loses its config file, while a renamed `description` warns "must define a
    // description" and DROPS the role from a session that runs anyway. Neither
    // is a load failure, so nothing downstream will notice a role that stopped
    // existing. Catch the drift before spawn — see the P2.509 block above.
    const roleProps: Record<string, unknown> =
      (schema.definitions?.AgentRoleToml as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
    for (const key of ['description', 'config_file']) {
      if (!(key in roleProps)) {
        throw new Error(`config-schema.json AgentRoleToml has no property "${key}"`);
      }
    }
  }

  const enumOf = (name: string): string[] => enumOfDefinition(defs, name);

  const derived = opts.mode ? codexSandboxConfigForMode(opts.mode, opts.sandboxGloballyEnabled ?? true) : undefined;
  const sandboxMode = derived?.sandbox_mode ?? opts.sandboxMode ?? 'workspace-write';
  const approvalPolicy = derived?.approval_policy ?? opts.approvalPolicy ?? 'on-request';
  const sandboxEnum = enumOf('SandboxMode');
  const approvalEnum = enumOf('AskForApproval');
  const reasoningEffortEnum = enumOf('ReasoningEffort');
  const wireEnum = enumOf('WireApi');
  const reasoningEffort = opts.thinkingLevel ? REASONING_EFFORT[opts.thinkingLevel] : undefined;
  const planModeReasoningEffort = opts.planModeThinkingLevel
    ? REASONING_EFFORT[opts.planModeThinkingLevel]
    : undefined;

  // P3.2 · validate exactly what `buildCodexConfigToml` would emit, under the
  // same eligibility gate. `approvals_reviewer` is a top-level ApprovalsReviewer
  // enum; `auto_review` is a top-level table whose `AutoReviewToml` carries a
  // lone `policy` string — drift-guard both, as `[features]`/`AgentRoleToml` are.
  const emitAutoReview = codexConfigEmitsAutoReview(opts.approvalsReviewer, approvalPolicy); // F1.373 — the one gate
  const autoReviewPolicy = emitAutoReview && typeof opts.autoReviewPolicy === 'string'
    ? opts.autoReviewPolicy.trim()
    : '';
  if (emitAutoReview) {
    if (!('approvals_reviewer' in props)) {
      throw new Error('config-schema.json has no top-level property "approvals_reviewer"');
    }
    const reviewerEnum = enumOf('ApprovalsReviewer');
    if (reviewerEnum.length && !reviewerEnum.includes('auto_review')) {
      throw new Error(`approvals_reviewer "auto_review" not in schema ApprovalsReviewer enum [${reviewerEnum}]`);
    }
  }
  if (autoReviewPolicy) {
    if (!('auto_review' in props)) {
      throw new Error('config-schema.json has no top-level property "auto_review"');
    }
    const autoReviewProps: Record<string, unknown> =
      (schema.definitions?.AutoReviewToml as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
    if (!('policy' in autoReviewProps)) {
      throw new Error('config-schema.json AutoReviewToml has no property "policy"');
    }
  }

  if (sandboxEnum.length && !sandboxEnum.includes(sandboxMode)) {
    throw new Error(`sandbox_mode "${sandboxMode}" not in schema SandboxMode enum [${sandboxEnum}]`);
  }
  // P6.224 · `granular` is the OBJECT variant of `AskForApproval`, and this check
  // is why it was unemittable: `enumOfDefinition` flattens a `oneOf` to its
  // string enums, so the object variant never appeared in `approvalEnum` and the
  // policy failed a guard codex itself would have accepted. The blocker was ours.
  //
  // Checked against the SCHEMA rather than waved through: the variant must still
  // exist upstream (a rename is exactly what this whole function detects), and
  // the payload's required members are the schema's list, not a copy of it.
  if (approvalPolicy === 'granular') {
    const askForApproval = (defs as Record<string, {
      oneOf?: Array<{ required?: string[]; properties?: Record<string, { $ref?: string }> }>;
    }>).AskForApproval;
    const objectVariant = (askForApproval?.oneOf ?? [])
      .find(variant => (variant.required ?? []).includes('granular'));
    if (!objectVariant) {
      throw new Error('approval_policy "granular" has no object variant in schema AskForApproval');
    }
    const granularDef = (defs as Record<string, { required?: string[]; properties?: Record<string, unknown> }>)
      .GranularApprovalConfig;
    if (!granularDef) {
      throw new Error('schema has no GranularApprovalConfig definition for approval_policy "granular"');
    }
    const supplied = opts.granularApproval;
    if (!supplied) {
      throw new Error('approval_policy "granular" needs CodexConfigOptions.granularApproval');
    }
    for (const key of granularDef.required ?? []) {
      if (typeof (supplied as unknown as Record<string, unknown>)[key] !== 'boolean') {
        throw new Error(`GranularApprovalConfig requires a boolean "${key}"`);
      }
    }
    for (const key of Object.keys(supplied)) {
      if (!(key in (granularDef.properties ?? {}))) {
        throw new Error(`GranularApprovalConfig has no property "${key}"`);
      }
    }
  } else if (approvalEnum.length && !approvalEnum.includes(approvalPolicy)) {
    throw new Error(`approval_policy "${approvalPolicy}" not in schema AskForApproval enum [${approvalEnum}]`);
  }
  if (reasoningEffort && reasoningEffortEnum.length && !reasoningEffortEnum.includes(reasoningEffort)) {
    throw new Error(`model_reasoning_effort "${reasoningEffort}" not in schema ReasoningEffort enum [${reasoningEffortEnum}]`);
  }
  if (wireEnum.length && !wireEnum.includes('responses')) {
    throw new Error(`wire_api "responses" not in schema WireApi enum [${wireEnum}]`);
  }
  if (hasCodexRuntimePathPolicy(opts) || Object.keys(opts.shellEnvironment ?? {}).length > 0) {
    const runtimePolicy = resolveRuntimePolicy(opts);
    const filesystemAccessEnum = enumOf('FileSystemAccessMode');
    // P3.175 · the workspace-scoped table's values are the same enum, so they are
    // checked with the same enum. Added to the set explicitly rather than left to
    // the flat map: a config whose ONLY floor entries are the nine has an empty
    // flat map, and the loop would then check nothing while reporting success.
    const accessModes = new Set<string>(Object.values(runtimePolicy.filesystem));
    if (runtimePolicy.workspaceDenyGlobs.length > 0) accessModes.add('deny');
    for (const access of accessModes) {
      if (filesystemAccessEnum.length && !filesystemAccessEnum.includes(access)) {
        throw new Error(`config schema does not support filesystem ${access} entries`);
      }
    }
  }
}

/**
 * Write config.toml into codexHome, creating the directory if needed.
 *
 * Role files are written FIRST. Measured against the bundled binary: a
 * `config_file` that is not on disk when the app-server reads the config costs
 * that role and only that role — `Ignoring malformed agent role definition:
 * agents.<role>.config_file must point to an existing file at <path>` — so the
 * failure is a quietly absent agent rather than a broken session, which is
 * exactly the shape worth ordering away rather than debugging later.
 */
export function writeCodexConfig(opts: CodexConfigOptions): string {
  if (!existsSync(opts.codexHome)) {
    mkdirSync(opts.codexHome, { recursive: true });
  }
  const plan = codexAgentRolesFor(opts);
  if (plan.roles.length > 0) {
    mkdirSync(join(opts.codexHome, CODEX_AGENT_ROLE_DIR), { recursive: true });
    for (const role of plan.roles) {
      writeFileSync(role.configFile, role.configFileToml, 'utf8');
    }
  }
  // Project the durable allow-prefixes into `rules/nessy.rules`. Rewritten from
  // scratch on every build (the home is ephemeral), and skipped entirely when
  // nothing projects so no empty rules dir is left behind.
  const rulesText = buildCodexExecpolicyRules(
    opts.execpolicyAllowPrefixes ?? [],
    opts.execpolicyDenyPrefixes ?? [],
    opts.execpolicyPromptPrefixes ?? [],
  );
  if (rulesText) {
    mkdirSync(join(opts.codexHome, CODEX_RULES_DIR), { recursive: true });
    writeFileSync(join(opts.codexHome, CODEX_RULES_DIR, CODEX_RULES_FILE), rulesText, 'utf8');
  }
  const path = join(opts.codexHome, 'config.toml');
  writeFileSync(path, buildCodexConfigToml(opts), 'utf8');
  // P6.488 · 0600, unconditionally. The per-session CODEX_HOME is already 0700
  // (`CodexAgent.createRuntime`) and that is the primary containment; this is the
  // second line of it, and it is written for EVERY session rather than only when
  // `otelLogsHeaders` is present — a mode that depends on the content is a mode
  // whose reason is invisible in a directory listing, and this file already
  // carries the whole permission profile and every provider key name.
  try {
    chmodSync(path, 0o600);
  } catch {
    // A filesystem with no POSIX modes (a Windows volume) is not a reason to
    // fail a session: the directory grant is the containment that matters and
    // it is applied by the caller.
  }
  // Reported here rather than in the builders: this is the one call a real
  // session makes exactly once per runtime, so a dropped agent names itself
  // without a signature hash or a schema check repeating the line.
  for (const message of plan.diagnostics) opts.onDiagnostic?.(message);
  // P3.337 · and ONE aggregated line above them that a packaged build can
  // actually show, because the per-definition lines above reach `debug` only.
  for (const message of formatCodexAgentRoleDropDiagnostics(plan)) opts.onDiagnostic?.(message);
  // P6.485 · its sibling, and a SEPARATE line on purpose: the one above reports
  // a loss, this one reports a widening, and a widening announced in the
  // sentence a reader has learned means "loss" is the half that gets skimmed.
  for (const message of formatCodexUnhonouredRoleToolGrantNotice(plan)) opts.onDiagnostic?.(message);
  // P3.175 · same cadence and the same reason: this is the one call a real
  // session makes exactly once per runtime, so a floor entry that did not reach
  // codex names itself without a signature hash or a schema check repeating it.
  const deniedPatternMapping = resolveDeniedPatternMapping(opts);
  for (const message of formatCodexDeniedPathDiagnostics(deniedPatternMapping)) {
    opts.onDiagnostic?.(message);
  }
  // P3.184 + P3.221 · same cadence, same reason, and this is the line that turns
  // `Operation not permitted` from an unexplained failure into a named one. It
  // follows the mirror lines deliberately: those say WHAT reached codex, this one
  // says what that costs inside a shell and how the other two runtimes differ.
  for (const message of [...formatCodexCredentialFloorShellDiagnostics(deniedPatternMapping), ...formatCodexDenyReadDiscoveryCostDiagnostics(opts)]) { // F1.1027: and the thread-open price
    opts.onDiagnostic?.(message);
  }
  // C3.343 · same cadence, same reason, and deliberately its own line rather
  // than a clause of the one above: that floor is about READS a user did not
  // choose, this one about WRITES the user may well have asked for and will meet
  // as a refusal Pi and claude would have offered to approve.
  for (const message of formatCodexProtectedPathFloorDiagnostics(opts.protectedWorkspaceSubpaths)) {
    opts.onDiagnostic?.(message);
  }
  // P3.257 (a) · same cadence, same reason. This one is about what codex reads
  // rather than what it refuses: an instruction file our host excluded is still
  // re-discovered by codex's own project-doc loader, and no config key can stop
  // that. See the option's docblock for why the producer is not wired yet.
  for (const message of formatCodexInstructionExcludeDiagnostics(opts.instructionExcludes)) {
    opts.onDiagnostic?.(message);
  }
  // P3.80 · same cadence, same reason, and it is the one line that says a grant
  // did MORE than the click asked for. Deliberately after the write: it
  // describes the file that now exists, so it cannot report a projection that
  // failed to land.
  for (const message of formatCodexExecpolicyGrantSandboxDiagnostics(opts)) {
    opts.onDiagnostic?.(message);
  }
  // P2.384 · same cadence, same reason. This one says the session has no egress
  // at all, which is the state that misreads as DNS — see the function's
  // docblock for why neither of codex's two native switches is written.
  for (const message of formatCodexSandboxEgressDiagnostics(opts)) {
    opts.onDiagnostic?.(message);
  }
  // P6.14 · same cadence, same reason. A hook this writer refused to project is
  // a hook its author believes is running: the plugin still reports itself
  // installed and enabled, and only this line says otherwise.
  for (const message of buildCodexHooksToml(opts.hooks).diagnostics) {
    opts.onDiagnostic?.(message);
  }
  // P7.2 · same cadence, and the newest of these because upstream removed the
  // mechanism rather than us failing to build one: with the sandbox master
  // switch off there is no longer ANY approval policy that routes an ordinary
  // command to this app, so the floor R13 and P2.197 installed stopped running
  // at `rust-v0.150.1`. It is reported for the same reason every line above it
  // is — a control that stopped and says nothing is indistinguishable from a
  // control that is working.
  //
  // D1.357 · the line now says which of the two states this session is in. The
  // residue is the same in both and is the reason either is emitted; what
  // differs is whether a permission profile bounds the writes, which for a real
  // session it always does.
  for (const message of formatCodexUnboundedApprovalDiagnostics(opts)) {
    opts.onDiagnostic?.(message);
  }
  return path;
}

/**
 * One approval-posture line for a sandbox-master-switch-off session, in the
 * wording its OWN config earns, or nothing.
 *
 * Gated on the state that causes it and not on the mode, because the loss is a
 * property of the sandbox master switch: with the OS wrap gone, every one of the
 * seven modes lands on `danger-full-access`, and under an unrestricted
 * filesystem sandbox codex's own decision table answers `Allow` for every public
 * approval policy that remains. See {@link UNBOUNDED_NEVER_DEGRADES_TO}.
 *
 * ## D1.357 — WHICH SENTENCE, read off the policy that RESOLVES
 *
 * The switch is one of two things this session's posture depends on, and until
 * 2026-09-18 only one was read. A `[permissions]` profile in the same file
 * SUPERSEDES the `sandbox_mode` scalar, so the config a real session writes is
 * bounded whatever its text says — measured, with the profile removed as the
 * control, on {@link CODEX_UNBOUNDED_APPROVAL_NOTICE}'s own docblock.
 *
 * Keyed EXACTLY as the emitters are keyed — `hasCodexFilesystemPolicy` over the
 * RESOLVED policy, which is what {@link buildCodexPermissionsTomlLines} gates the
 * block itself on — and deliberately not on `hasCodexRuntimePathPolicy`, which
 * asks the raw options the SCHEMA-DRIFT question. The two can disagree, and the
 * only honest subject for this line is the profile that was actually written.
 *
 * A policy that cannot be resolved decides nothing and keeps the pre-D1.357
 * reading, for the reason the egress line gives at its own `try`:
 * `resolveCodexRuntimePathPolicy` throws on a `codex-runtime-path-policy-conflict`
 * and `writeCodexConfig` will fail on it two calls later — a pure formatter must
 * not be the thing that raises it.
 */
export function formatCodexUnboundedApprovalDiagnostics(opts: CodexConfigOptions): string[] {
  if (opts.sandboxGloballyEnabled !== false) return [];
  if (!opts.mode) return [];
  let policy: CodexRuntimePathPolicy | undefined;
  try {
    policy = resolveRuntimePolicy(opts);
  } catch {
    policy = undefined;
  }
  return [!policy || !hasCodexFilesystemPolicy(policy) ? CODEX_UNBOUNDED_APPROVAL_NOTICE : policy.permissionParent === ':read-only' ? CODEX_READ_ONLY_PROFILE_APPROVAL_NOTICE : CODEX_BOUNDED_APPROVAL_NOTICE]; // F1.787
}

/**
 * F1.378 — the user's exact-name `mcp__` DENY and ASK rules, as codex's own
 * per-server levers (`RawMcpServerConfig.disabled_tools` and
 * `tools.<name>.approval_mode`, pinned `config-schema.json`). The projection
 * itself — which rule lands on which entry under which raw name, and which
 * rules no lever can carry — is `projectCodexMcpPermissionRules`
 * (`shared/src/agent/codex-permission-rule-support.ts`); this writer only
 * emits what it is handed.
 */
export interface CodexMcpToolLeversOption {
  readonly disabledTools?: readonly string[]; // raw tool names for `disabled_tools` (a deny rule)
  readonly promptTools?: readonly string[]; // raw tool names that get `approval_mode = "prompt"` (an ask rule)
  /** F1.1061 · `session` only: the user denied web search as a whole tool — see {@link codexConfigFollowsCodexWebSearch}. */
  readonly webSearchDenied?: boolean;
}

// Declared by interface MERGING, appended here so no cited line of the main
// declaration moves.
export interface CodexConfigOptions {
  /**
   * F1.378 · per `[mcp_servers.*]` entry, the tools a user's `deny` rule
   * removes (`disabled_tools`: `codex-mcp/src/tools.rs` `ToolFilter::allows`
   * compares the raw name exactly and `filter_tools` drops the tool from the
   * catalogue) and the tools an `ask` rule always prompts for
   * (`approval_mode = "prompt"`: `core/src/mcp_tool_call.rs`
   * `requires_mcp_tool_approval_for_mode` answers `true` whatever the tool's
   * `readOnlyHint`). Absent or empty lists emit nothing, so a policy with no
   * MCP rules writes HEAD's config byte for byte. Read when the app-server
   * starts, like every key in this file: a rule added mid-session lands at the
   * next runtime build, and until then the host's own consult of the asked
   * call is what judges it.
   */
  mcpToolLevers?: {
    readonly session?: CodexMcpToolLeversOption;
    readonly sources?: CodexMcpToolLeversOption;
  };
}

function codexMcpToolLeversEmitSomething(levers: CodexConfigOptions['mcpToolLevers']): boolean {
  return [levers?.session, levers?.sources].some(entry =>
    (entry?.disabledTools?.length ?? 0) > 0 || (entry?.promptTools?.length ?? 0) > 0);
}

/**
 * The lines one entry's levers add: `disabled_tools` as a key of the entry's own
 * table (so it must be emitted before any sub-table), then one
 * `[mcp_servers.<entry>.tools."<name>"]` sub-table per prompted tool. A name
 * that is blank or carries a control character is dropped rather than quoted —
 * a rule naming it could never have matched a real tool.
 */
function codexMcpToolLeverLines(entry: 'session' | 'sources', levers: CodexMcpToolLeversOption | undefined): string[] {
  const usable = (names: readonly string[] | undefined) =>
    [...new Set((names ?? []).filter(name => name.trim() !== '' && !/[\u0000-\u001f\u007f]/.test(name)))];
  const disabled = usable(levers?.disabledTools);
  const prompted = usable(levers?.promptTools).filter(name => !disabled.includes(name));
  return [
    ...(disabled.length > 0 ? [`disabled_tools = [${disabled.map(tomlString).join(', ')}]`] : []),
    ...prompted.flatMap(name => [`[mcp_servers.${entry}.tools.${tomlString(name)}]`, 'approval_mode = "prompt"']),
  ];
}

/**
 * F1.570 — the host's own search tool, by the raw name codex's `disabled_tools`
 * compares (`session-tools-core` `tool-defs.ts` registers it under this name;
 * the F1.570 test pins the two together, so a rename cannot withhold nothing).
 */
export const CODEX_HOST_WEB_SEARCH_TOOL = 'web_search';

// Declared by interface MERGING, appended so no cited line of the main
// declaration moves.
export interface CodexConfigOptions {
  /**
   * F1.570 · the operator's P6.339 web-search allowlist, already normalized by
   * the host (`resolveWebSearchAllowedDomains`,
   * `shared/config/web-search-allowlist.ts`). Written as `[tools.web_search]
   * allowed_domains` ONLY where codex's own search is on
   * ({@link codexConfigFollowsCodexWebSearch}); on every other card it is
   * ignored and the file is byte for byte what it was. Codex turns it into the
   * hosted tool's `filters.allowed_domains` (`protocol/src/config_types.rs`
   * `From<WebSearchToolConfig> for WebSearchConfig`, `rust-v0.156.1`).
   */
  webSearchAllowedDomains?: readonly string[];
}

/**
 * F1.570 — whether this config leaves web search to codex's own default instead of writing `web_search =
 * "disabled"`. True on the ChatGPT (Codex) card only (its turns go to OpenAI's backend, where the hosted search
 * runs; the gateway cannot reach it, Bedrock is unmeasured) — and, F1.1061, not when the user denied web search as
 * a whole tool: codex's own switch then removes the hosted tool under every permission profile (`Disabled` has no
 * spec in `hosted_spec.rs` and survives full access in `resolve_web_search_mode_for_turn`), and no allowlist is written.
 */
export function codexConfigFollowsCodexWebSearch(opts: Pick<CodexConfigOptions, 'declaredModelProvider' | 'mcpToolLevers'>): boolean {
  return opts.declaredModelProvider === 'openai' && opts.mcpToolLevers?.session?.webSearchDenied !== true;
}

/** A name that is blank or carries a control character is dropped, as in `codexMcpToolLeverLines`. */
function codexWebSearchAllowedDomains(opts: CodexConfigOptions): string[] {
  if (!codexConfigFollowsCodexWebSearch(opts)) return [];
  const printable = (value: string) => [...value].every(ch => ch.charCodeAt(0) > 0x1f && ch.charCodeAt(0) !== 0x7f);
  return [...new Set((opts.webSearchAllowedDomains ?? []).map(d => d.trim()).filter(d => d !== '' && printable(d)))];
}

/** `[tools.web_search] allowed_domains`, or nothing when there is no usable allowlist or the search is off. */
function codexWebSearchToolTableLines(opts: CodexConfigOptions): string[] {
  const domains = codexWebSearchAllowedDomains(opts);
  return domains.length > 0
    ? ['[tools.web_search]', `allowed_domains = [${domains.map(tomlString).join(', ')}]`, '']
    : [];
}

/**
 * The `session` entry's levers: the user's own (F1.378), plus the host
 * `web_search` on the card where codex's search is on — the P6.148 rule, one
 * search tool in front of the model. A user's deny list is kept and merged; a
 * user's ASK rule on the same name is dropped by the deny, as for any tool.
 */
function codexSessionMcpToolLevers(opts: CodexConfigOptions): CodexMcpToolLeversOption | undefined {
  const levers = opts.mcpToolLevers?.session;
  if (!codexConfigFollowsCodexWebSearch(opts)) return levers;
  return { ...levers, disabledTools: [...(levers?.disabledTools ?? []), CODEX_HOST_WEB_SEARCH_TOOL] };
}

/** The top-level keys F1.570's emits need, after the nested guards; throws on a renamed nested key. */
function codexWebSearchSchemaGuard(opts: CodexConfigOptions, defs: Record<string, unknown>): string[] {
  const propsOf = (name: string): Record<string, unknown> =>
    ((defs[name] as { properties?: Record<string, unknown> } | undefined)?.properties) ?? {};
  if (codexConfigFollowsCodexWebSearch(opts) && opts.sessionMcp && !('disabled_tools' in propsOf('RawMcpServerConfig'))) {
    throw new Error('config-schema.json RawMcpServerConfig has no property "disabled_tools"');
  }
  if (codexWebSearchAllowedDomains(opts).length === 0) return [];
  if (!('web_search' in propsOf('ToolsToml'))) throw new Error('config-schema.json ToolsToml has no property "web_search"');
  if (!('allowed_domains' in propsOf('WebSearchToolConfig'))) {
    throw new Error('config-schema.json WebSearchToolConfig has no property "allowed_domains"');
  }
  return ['tools'];
}

// F1.192 — re-exported on this entry point because `CodexAgent` imports the floor
// helpers from `./config-writer`; appended so no cited line moves.
export { anchorCodexFloorOnCredentialHome, codexDenyReadEntryCount } from './config-writer-permissions.ts'; // F1.1057 — the count F1.780 keys on

/**
 * F1.373 — whether a written `config.toml` carries `approvals_reviewer =
 * "auto_review"`: the eligibility gate {@link buildCodexConfigToml} and the
 * schema drift-guard both apply, now ONE function instead of two copies of one
 * line, because `CodexAgent` reads the same answer to decide what each
 * `turn/start` says about the reviewer. Codex's own rule is "with `never` there
 * is nothing to review", so a `never` policy emits nothing rather than an inert
 * key.
 */
export function codexConfigEmitsAutoReview(
  approvalsReviewer: CodexApprovalsReviewer | undefined,
  approvalPolicy: CodexApprovalPolicy,
): boolean {
  return approvalsReviewer === 'auto_review' && approvalPolicy !== 'never';
}

/**
 * **F1.787 — the posture line for `plan` (and, since F1.1056, `dontAsk`) with the sandbox master
 * switch off**, the third arm of {@link formatCodexUnboundedApprovalDiagnostics}.
 *
 * Those two modes now keep codex's built-in `:read-only` parent in both switch
 * positions (`codexModeKeepsReadOnlyParent`, `config-writer-permissions.ts`;
 * owner decision 2026-09-26), so {@link CODEX_BOUNDED_APPROVAL_NOTICE} — which
 * names `:workspace` and says writes are bounded to the workspace — would
 * misdescribe them. Same prefix, so `CodexAgent` lifts it unchanged. Measured on
 * the shipped `rust-v0.156.1` with the product's own `writeCodexConfig`
 * (DN-106, 2026-09-26): `thread/start` resolves `readOnly`; an in-project
 * `printf` exits 1 with "operation not permitted" and no request; an
 * `apply_patch` raises `item/fileChange/requestApproval` and lands only once
 * accepted; a `writablePaths` root stays writable with no request (resolved
 * `workspaceWrite` whose only writable root is that grant); the `default`
 * control lands both with no request. (F1.1003, F1.1179: in Plan the session's plans and data folders are such roots.)
 */
export const CODEX_READ_ONLY_PROFILE_APPROVAL_NOTICE = CODEX_APPROVAL_POSTURE_PREFIX
  + 'Codex is sandboxed by its permission profile rather than by the sandbox_mode line, and in Plan '
  + 'and Don\'t ask that profile is read-only: this session writes `default_permissions = "nessy_runtime"` '
  + '(`extends = ":read-only"`), and codex resolves that ahead of `sandbox_mode = "danger-full-access"` '
  + 'in the same file. So a shell command that writes a file is refused by the OS ("Operation not '
  + 'permitted") with no card at all, and a file change raises an approval (Don\'t ask refuses it unless a rule allows it); a directory you '
  + 'added to this workspace stays writable, and in Plan so do this session\'s plans and data folders. Measured on rust-v0.156.1, 2026-09-26.';
export { codexModeKeepsReadOnlyParent } from './config-writer-permissions.ts'; // F1.1124 — the F1.787 parent, read by CodexAgent.noteResolvedSandboxPolicy
