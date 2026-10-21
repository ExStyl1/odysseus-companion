/**
 * P2.456 — the two tool-search keys stay UNWRITTEN, and the row's premise is
 * why: it said codex's deferred-tool state was "absent because we never enabled
 * it". Measured, that is false in the strongest possible way — **the keys cannot
 * enable anything**, so there is nothing to enable and this file pins them out.
 *
 * ## Read from the source at `rust-v0.148.0`, the tag our manifest pinned then
 *
 * Both are `Stage::Removed`, whose own definition is *"The feature flag is
 * useless but kept for backward compatibility reason"*
 * (`codex-rs/features/src/lib.rs:56`):
 *
 *   - `tool_search` — *"Removed compatibility flag retained as a no-op now that
 *     tool_search is always enabled."* (`lib.rs:187`), spec at `lib.rs:1147`
 *     with `default_enabled: false`.
 *   - `tool_search_always_defer_mcp_tools` — *"Removed compatibility flag. MCP
 *     tools are always deferred when tool_search is available."* (`lib.rs:189`),
 *     spec at `lib.rs:1153` with `default_enabled: **true**`.
 *
 * Three independent readings of the source say the value we would write is
 * discarded:
 *
 *  1. **Zero readers.** `Feature::ToolSearch` and
 *     `Feature::ToolSearchAlwaysDeferMcpTools` appear in the ENTIRE codex tree
 *     only in their own `FeatureSpec` declarations — no `features.enabled(…)`
 *     call anywhere. Positive control on the same rig: `Feature::ViewImage`
 *     scores two real readers (`core/src/tools/spec_plan.rs:917` and `:1116`),
 *     so the absence is a finding and not a broken grep. (It was broken once:
 *     macOS `xargs` has no `-a`, and that spelling scored 0 for the control
 *     too — `find … -exec grep +` is the instrument that works here.)
 *  2. **`apply_map` never applies them.** `lib.rs:527` matches
 *     `"tool_search" | "tool_search_always_defer_mcp_tools" | …` and `continue`s
 *     BEFORE the `feature_for_key` → `enable`/`disable` arm at the bottom of the
 *     loop. The boolean is parsed and thrown away.
 *  3. **`emit_metrics` skips them.** `lib.rs:477` does
 *     `if matches!(feature.stage, Stage::Removed) { continue; }`, so codex's own
 *     feature-state counter — the one wire that reports a feature sitting off its
 *     default — cannot report these two either. A key written here would be
 *     inert AND unobservable.
 *
 * ## What actually gates codex's tool search — not a feature flag at all
 *
 * `core/src/tools/spec_plan.rs:581`:
 *
 *     pub(crate) fn search_tool_enabled(turn_context: &TurnContext) -> bool {
 *         turn_context.model_info.supports_search_tool && namespace_tools_enabled(turn_context)
 *     }
 *
 * and that predicate is the whole switch: `core/src/mcp_tool_exposure.rs:90`
 * sets every MCP tool's exposure to `ToolExposure::Deferred` when it holds and
 * `ToolExposure::Direct` when it does not, and `spec_plan.rs:339` registers the
 * `tool_search` tool itself only when it holds. Neither operand is reachable
 * from `config.toml`: `namespace_tools` is a `ProviderCapabilities` field
 * (`model-provider/src/provider.rs:48`), and `supports_search_tool` is model
 * metadata (`protocol/src/openai_models.rs:452`, `#[serde(default)]` → false)
 * that appears NOWHERE in `config/src/config_toml.rs` and has no branch in
 * `models-manager`'s `with_config_overrides`.
 *
 * **CORRECTED, W1-a 2026-09-02 (P2.462), and the correction is the interesting
 * part.** "Neither operand is reachable from `config.toml`" is FALSE as written,
 * and so is the companion claim in P2.456's own note that the GATEWAY owns this
 * switch. `supports_search_tool` is a `ModelInfo` field, and there are two config
 * routes to `ModelInfo` that neither the identifier grep above nor
 * `with_config_overrides` can see:
 *
 *  1. `model_catalog_json` — a `config_toml.rs` key (`:355`) naming a file that
 *     **replaces** codex's catalog for the process (`core/src/config/mod.rs:905`).
 *  2. With that key unset, `ConfiguredModelProvider::models_manager`
 *     (`model-provider/src/provider.rs:390`) builds an `OpenAiModelsManager` that
 *     fetches `GET {base_url}/models` (`codex-api/src/endpoint/models.rs`) — and
 *     `base_url` is OUR loopback adapter, not the gateway. It 404s today, which
 *     is the only reason the operand stays false.
 *
 *     **REFINED one layer deeper, W2-d 2026-09-03, measured on the shipped
 *     binary: the request is never made at all.** The 404 is real but it is not
 *     what keeps the operand false — nothing reaches it. `should_refresh_models`
 *     gates the fetch on `uses_codex_backend() || has_command_auth()`, and
 *     `has_command_auth` is the `[model_providers.<key>.auth]` table, which this
 *     writer does not emit: we authenticate with `env_key`. Control on the same
 *     rig: swap `env_key` for that table and the `/models` fetch appears. So
 *     serving `/models` from the loopback adapter does not by itself turn the
 *     operand on — the auth SHAPE decides whether codex ever asks. Recorded here
 *     rather than left implied, because a reader acting on the 404 sentence
 *     alone would fix the endpoint and measure no change.
 *
 * So the ON state is reachable, by a decision we are choosing not to take, from a
 * surface we own. Everything below about the two FEATURE KEYS is unaffected and
 * still exactly right: they are `Stage::Removed`, they enable nothing, and this
 * file's job is to keep them unwritten. The rest of the reasoning lives beside
 * the reader that would consume it, in `shared/src/agent/codex-agent.ts`.
 *
 * ## Measured on the bundled binary, control first, same binary same run
 *
 * darwin-arm64 `codex-app-server` (`apps/electron/resources/bin/codex/…`),
 * 2026-08-31, three arms over `experimentalFeature/list` (114 features):
 *
 * | arm | `tool_search` | `…_always_defer_mcp_tools` | `view_image` |
 * | --- | --- | --- | --- |
 * | baseline, the home this repo ships | `removed`, enabled **false** (default false) | `removed`, enabled **true** (default true) | `stable`, enabled true |
 * | positive control: `view_image = false` | false | true | **false** — flipped |
 * | under test: `tool_search = true`, `…_always_defer_mcp_tools = false` | **still false** | **still true** | true |
 *
 * So the binary ignores BOTH keys in BOTH directions while honouring
 * `view_image` in the same run, exactly as `apply_map`'s `continue` predicts.
 * No `warning` and no `configWarning` fired in any arm — the keys are
 * schema-valid (`[features]` is `additionalProperties: false` and carries both),
 * and `Stage::Removed` is not `Stage::UnderDevelopment`, so
 * `unstable_features_warning_event` (`lib.rs:1515`) stays silent as well. A lane
 * that added one would therefore get **no signal at all** that it had written a
 * dead key, which is what this tripwire is for.
 *
 * ## The self-protection P6.23 told this row to look for — codex has one
 *
 * On claude only `false` crosses, because the SDK's `true` path sends a beta
 * header through proxies and our own default card IS that proxy. Codex's
 * equivalent is not a header check but the model half of the predicate above,
 * and it falls the same way: measured on the same binary with a control,
 * `model = "tgpt/qwen35-397b-a17b-fp8"` (the gateway's default coder model)
 * makes the binary log `codex_models_manager::model_info` WARN *"Unknown model
 * tgpt/qwen35-397b-a17b-fp8 is used. This will use fallback model metadata."*,
 * while the control `model = "gpt-5.2-codex"` logs no such line. Fallback
 * metadata hardcodes `supports_search_tool: false`
 * (`models-manager/src/model_info.rs:176`). `namespaceTools` read `true` for our
 * provider, so the model half is the operand that closes it.
 *
 * Net: codex's native tool search is OFF on every Nessy gateway session, for
 * structurally the same reason claude-runtime's is — a native fallback that
 * declines to defer tools when the upstream is not one the runtime knows — and
 * unlike claude's, codex's is **not overridable at all**. The OFF state is
 * already uniform across both host-driven runtimes; there is no divergence here
 * to close and no override to refuse.
 *
 * Who owns the switch is worth naming, because it is not us: the gateway. A
 * `/models` response that declared `supports_search_tool: true` for a served
 * model would turn codex's tool search on with no config change on this side.
 * If that ever happens the ON state is at least legible — `tool_search_call`
 * and `tool_search_output` are first-class items in the pinned v2 protocol,
 * which is strictly better than claude's ON state (P2.457) where the searches
 * happen inside the subprocess and reach us on no wire at all. Nothing in this
 * tree reads those two item types today; that is dead code while the gate is
 * closed, and it is not this row's to write.
 */
import { describe, expect, test } from 'bun:test';
import {
  buildCodexConfigToml,
  type CodexPermissionMode,
} from '../config-writer.ts';

/** A codex home that is never written to; only interpolated into the TOML. */
const BASE = { codexHome: 'unused-home', model: 'tgpt/qwen35-397b-a17b-fp8', adapterPort: 54321 } as const;

/**
 * Every mode, in the spelling `config-writer-sandbox-egress.test.ts` uses, so a
 * mode-scoped emission cannot slip past a single-shape check.
 */
const ALL_MODES: readonly CodexPermissionMode[] = [
  'dontAsk', 'plan', 'default', 'acceptEdits', 'auto', 'bypassPermissions',
];

describe('P2.456 tripwire — codex tool-search keys stay unwritten', () => {
  const FORBIDDEN = [
    // `Stage::Removed`, `continue`d in `apply_map`, zero readers in the tree,
    // and measured inert in both directions against the bundled binary. Writing
    // it would add a key that LOOKS like the switch for deferred tools and is
    // not one — and codex would not warn about it.
    'tool_search',
    // Same, and the one whose name promises the most: it would read as control
    // over what the model can see without asking. It is `default_enabled: true`
    // on a Removed flag with no readers; the real MCP-deferral decision is
    // `search_tool_enabled`, which no config key reaches.
    'tool_search_always_defer_mcp_tools',
  ] as const;

  /**
   * Positive controls, for the reason every absence claim in this tree carries
   * one: these two ARE emitted under `[features]`. A run scoring 0 for all four
   * strings would be an instrument failure, not a finding — and `web_search` is
   * here because it is the emitted key most likely to make a sloppy substring
   * search for `search` look like a hit.
   */
  const CONTROLS = ['[features]', 'multi_agent = true', 'view_image = true', 'web_search = "disabled"'] as const;

  test('no mode in either sandbox switch position emits either key', () => {
    for (const sandboxGloballyEnabled of [true, false]) {
      for (const mode of ALL_MODES) {
        const toml = buildCodexConfigToml({ ...BASE, mode, sandboxGloballyEnabled });
        for (const control of CONTROLS) expect(toml).toContain(control);
        for (const key of FORBIDDEN) expect(toml).not.toContain(key);
      }
    }
  });

  test('a bare call — no mode, no sandbox flag — emits neither either', () => {
    const toml = buildCodexConfigToml(BASE);
    for (const control of CONTROLS) expect(toml).toContain(control);
    for (const key of FORBIDDEN) expect(toml).not.toContain(key);
  });
});
