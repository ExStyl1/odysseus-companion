/**
 * P3.235 — the two auto-compaction knobs that bound on Pi and reached claude
 * never, projected onto the SDK's OWN counterparts.
 *
 * ## WIRED — the three call sites, and why each is where it is
 *
 * This module landed as the projection plus its measurement, with the wiring
 * deferred because `claude-agent.ts` belonged to another lane that round. It is
 * wired now (P3.235, second half), at exactly the three places the deferred note
 * named:
 *
 *  - `startLocalAdapterRuntime`'s `envOverrides` block spreads
 *    {@link buildClaudeAutoCompactionKnobEnv} AFTER `buildClaudeAutoCompactionEnv`
 *    — after, because the operator's explicit window must win over the
 *    catalogue-derived one, and they are the same variable;
 *  - the direct-Anthropic path merges the same fragment into
 *    `this.config.envOverrides` beside the existing `DISABLE_AUTO_COMPACT`
 *    assignment, guarded on a non-empty fragment so a spawn with neither knob
 *    set keeps a byte-identical env;
 *  - `postInit` emits {@link claudeAutoCompactionKnobDiagnostics} to the
 *    session's degradation notices (P6.96; it went to `debug` until then)
 *    BEFORE the two paths branch, so the one residual difference below is
 *    visible rather than inferred, and visible on whichever path runs.
 *
 * ## Native-first, and nothing here is built
 *
 * `resolveAutoCompactionSettings` reads `NESSY_AUTOCOMPACT_PCT_OVERRIDE` and
 * `NESSY_AUTO_COMPACT_WINDOW` into `thresholdPercent` / `contextWindow`, and
 * only its third field (`enabled`) had a claude projection. The SDK carries a
 * direct counterpart for each of the other two, so this is CONFIGURATION, not
 * construction — and both counterparts are documented AND present in the
 * vendored bundle (`@anthropic-ai/claude-agent-sdk` 0.3.247, `claudeCodeVersion`
 * 2.1.247; re-measured 2026-09-12 — `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` scores
 * 5 lines / 5 occurrences in the native binary and 2/2 in `sdk.mjs`, both
 * instruments named because they disagree on a minified artefact, C3.294), so
 * neither side of the AGENTS.md membership rule is being guessed.
 *
 * ### `thresholdPercent` → `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`
 *
 * `env-vars.md`: "Set the percentage (1-100) of the auto-compact window at which
 * auto-compaction triggers. Use lower values like `50` to compact earlier; the
 * variable can't raise the threshold, so values above the default percentage are
 * ignored. […] Applies to both main conversations and subagents".
 *
 * Read verbatim out of `claude-agent-sdk-darwin-arm64/claude`, the same binary
 * P6.53 read its gate from — the producer and the consumer:
 *
 *     function Vvs(e,t,r){
 *       let n=process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, …;
 *       return{enabled:Uk(),precomputeBufferFraction:r1_(e,t,r),
 *              testPctOverride:n?parseFloat(n):void 0, …}
 *     }
 *     function TEo(e,t){
 *       let r=e-13000, n=t.testPctOverride;
 *       if(n!==void 0&&!isNaN(n)&&n>0&&n<=100)
 *         return Math.min(Math.floor(e*(n/100)),r);
 *       return r
 *     }
 *
 * Same units (a PERCENT in 1…100, not a fraction — the field is named
 * `testPctOverride` and the `n/100` is what settles it), and the same direction:
 * `Math.min(pctThreshold, defaultThreshold)` is the identical narrow-only clamp
 * `resolvePiAutoCompactionSettings` applies with its own
 * `Math.min(defaultThreshold, percentageThreshold)`. Our own parse is already
 * bounded 1…100, so every value we can emit is a value the binary accepts.
 *
 * ### `contextWindow` → `CLAUDE_CODE_AUTO_COMPACT_WINDOW`
 *
 * `settings-reference.md#autocompactwindow`: "number of tokens, from `100000` to
 * `1000000`. Claude Code caps the value at your model's context window". The
 * binary agrees — `WBe` floors at {@link CLAUDE_AUTO_COMPACT_WINDOW_MIN}, caps at
 * {@link CLAUDE_AUTO_COMPACT_WINDOW_MAX}, and `v9` then takes
 * `Math.min(modelWindow, configured)`:
 *
 *     function v9(e,t,r=mC()){
 *       let n=to(e),o=Ew(e,r);
 *       if(process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW){
 *         let l=WBe("CLAUDE_CODE_AUTO_COMPACT_WINDOW",
 *                   process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW,vEo,jvs);
 *         if(l.status!=="invalid"){
 *           let c=Math.max(vEo,l.effective);
 *           return{window:Math.min(o,c),configured:c,source:"env"}
 *         }
 *       }
 *       …
 *     }                                    // vEo = 1e5, jvs = 1e6
 *
 * so the value is emitted RAW: the min against the real window is the SDK's own,
 * and re-doing it here would be a second copy of a rule that can drift. Pi's is
 * the same rule, spelled `Math.min(configuredWindow ?? modelWindow, modelWindow)`.
 *
 * ## What is NOT forwarded, and why — the P6.16 caution applied
 *
 * P6.16's refuted half is the standing warning: a Pi-priced formula must not
 * cross to claude just because its inputs are shaped alike. Checked against both
 * knobs, and the answer is different for the KNOBS than for the ARITHMETIC
 * around them:
 *
 *  - Neither knob is Pi-shaped. A percentage of a context window and a token
 *    count for that window are runtime-neutral quantities: no RAM term, no
 *    subprocess count, no per-child amplification (the SDK's own page says the
 *    percent "applies to both main conversations and subagents", which is the
 *    dimension P6.16 was actually about).
 *  - The arithmetic they feed on Pi very much IS. Pi's SDK exposes no threshold
 *    field, so `resolvePiAutoCompactionSettings` translates the threshold back
 *    into `reserveTokens = modelWindow − thresholdTokens`, and its DEFAULT
 *    reserve is priced off the MCP tool-result cap — `Math.max(16384,
 *    mcpOutputTokenLimit(env) + 8192)`, read live from `NESSY_MCP_OUTPUT_TOKENS`,
 *    capped at a third of capacity. None of that crosses. The SDK's own default
 *    is `window − 13000` and it is the SDK's business.
 *
 * The consequence is stated rather than hidden: with the percent set, both
 * runtimes take `min(theirDefault, percent)`, so the knob binds identically
 * whenever it is the tighter of the two and the two runtimes still differ by
 * their own default reserves when it is not. That difference is not this knob's,
 * and forwarding a reserve to make the numbers match would be exactly the
 * mistake P6.16 recorded.
 *
 * ## The one residual difference, reported rather than smoothed
 *
 * The SDK FLOORS the configured window at 100 000 and Pi does not floor it at
 * all. So `NESSY_AUTO_COMPACT_WINDOW=50000` narrows a Pi session to 50 000 and a
 * claude session to `min(modelWindow, 100000)` — the operator asked for one
 * number and two runtimes obey different ones. That is a property of the SDK's
 * published range, not something a host can fix without re-implementing
 * compaction beside it, so {@link claudeAutoCompactionKnobDiagnostics} says it
 * out loud instead. Same for the 1 000 000 cap at the other end, which no window
 * this app ships can reach today.
 */
import type { ResolvedAutoCompactionSettings } from '../config/auto-compaction-settings.ts'

/**
 * The SDK's own bounds on `CLAUDE_CODE_AUTO_COMPACT_WINDOW` — `vEo`/`jvs` in the
 * vendored binary, and the "from `100000` to `1000000`" of
 * `settings-reference.md#autocompactwindow`. Exported so the test can pin them
 * against the bundle rather than against this comment.
 */
export const CLAUDE_AUTO_COMPACT_WINDOW_MIN = 100_000
export const CLAUDE_AUTO_COMPACT_WINDOW_MAX = 1_000_000

/** What {@link buildClaudeAutoCompactionKnobEnv} may emit, and nothing else. */
export interface ClaudeAutoCompactionKnobEnvV1 {
  readonly CLAUDE_AUTOCOMPACT_PCT_OVERRIDE?: string
  readonly CLAUDE_CODE_AUTO_COMPACT_WINDOW?: string
}

/** The two operator knobs, without the `enabled` field P6.53 already projects. */
type KnobPolicy = Pick<ResolvedAutoCompactionSettings, 'enabled' | 'thresholdPercent' | 'contextWindow'>

/**
 * The host's two operator knobs as the SDK's own env.
 *
 * Empty when auto-compaction is OFF: `Uk()` short-circuits before either value
 * is read, so emitting a threshold beside `DISABLE_AUTO_COMPACT` would be a
 * variable that describes behaviour the session does not have — and a reader who
 * greps the spawn env would conclude the opposite of the truth.
 *
 * Meant to be spread AFTER `buildClaudeAutoCompactionEnv`: both can write
 * `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, and the operator's explicit number outranks
 * the one derived from our model catalogue.
 */
export function buildClaudeAutoCompactionKnobEnv(
  policy: KnobPolicy | undefined,
): ClaudeAutoCompactionKnobEnvV1 {
  if (!policy || policy.enabled === false) return {}
  return {
    ...(policy.thresholdPercent === undefined
      ? {}
      : { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: String(policy.thresholdPercent) }),
    ...(policy.contextWindow === undefined
      ? {}
      : { CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(policy.contextWindow) }),
  }
}

/**
 * Say out loud where claude will not obey the number the operator wrote.
 *
 * One line, only when it applies. An operator who sets a window under the SDK's
 * floor has done something that WORKS on Pi and silently means something else
 * here; that is the "a control that silently stops controlling" shape, and the
 * cheapest honest answer is a sentence naming both numbers.
 */
export function claudeAutoCompactionKnobDiagnostics(
  policy: KnobPolicy | undefined,
): readonly string[] {
  if (!policy || policy.enabled === false) return []
  const window = policy.contextWindow
  if (window === undefined) return []
  if (window < CLAUDE_AUTO_COMPACT_WINDOW_MIN) {
    return [
      `NESSY_AUTO_COMPACT_WINDOW=${window} is below the Claude SDK's minimum auto-compact window `
      + `(${CLAUDE_AUTO_COMPACT_WINDOW_MIN}); this session compacts against `
      + `${CLAUDE_AUTO_COMPACT_WINDOW_MIN} or the model's own window, whichever is smaller, `
      + 'while a Pi session would use the value as written.',
    ]
  }
  if (window > CLAUDE_AUTO_COMPACT_WINDOW_MAX) {
    return [
      `NESSY_AUTO_COMPACT_WINDOW=${window} is above the Claude SDK's maximum auto-compact window `
      + `(${CLAUDE_AUTO_COMPACT_WINDOW_MAX}); this session compacts against `
      + `${CLAUDE_AUTO_COMPACT_WINDOW_MAX} or the model's own window, whichever is smaller.`,
    ]
  }
  return []
}
