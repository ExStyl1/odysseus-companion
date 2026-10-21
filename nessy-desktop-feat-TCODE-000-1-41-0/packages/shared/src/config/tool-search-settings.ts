/**
 * Deferred MCP tool loading — the trigger and its override (S14).
 *
 * Claude calls this "tool search" and controls it with `ENABLE_TOOL_SEARCH`
 * (`agent-sdk/tool-search.md:36-42`, `mcp.md:1189-1204`, `env-vars.md:393`).
 * Our env name follows the repo's mapping convention:
 *
 * - `ENABLE_TOOL_SEARCH` → `NESSY_ENABLE_TOOL_SEARCH`
 *
 * TWO CONTRACT POINTS THAT ARE EASY TO GET BACKWARDS, both from the same table:
 *
 * 1. Claude's DEFAULT is not a threshold. The `(unset)` row of `auto`'s table
 *    says tool search is simply on: "Tool search is on by default, with the
 *    exceptions listed in Configure tool search." No count and no percentage is
 *    consulted. The 10% belongs to a DIFFERENT, opt-in value — the `auto` row:
 *    "Counts the tokens in the tool definitions that tool search can defer and
 *    compares the total against the model's context window. When the total
 *    reaches 10% of the window, tool search activates." Reading them as one
 *    rule ("on by default, activates at 10%") produces a mechanism that is
 *    neither.
 *
 *    **The `auto` sentence above is the CURRENT one and it replaced the one
 *    this file used to quote** (re-fetched 2026-08-15). The superseded wording
 *    was "Checks the combined token count of ALL tool definitions … If they
 *    EXCEED 10%", and both halves moved: the count narrowed from every
 *    definition to only the deferrable ones, and `exceed` became `reaches`.
 *    Line numbers are deliberately not cited — a page grows and a number
 *    decays, while a quoted sentence does not.
 * 2. A count threshold and a context percentage are DIFFERENT QUANTITIES, not
 *    two spellings of one. At the measured ~250 estimated tokens per MCP tool
 *    definition, our 48-tool threshold is ~12,000 tokens: 1.2% of a 1M window,
 *    6.0% of 200K, 9.2% of 131K, 36.6% of 32K. A count is a percentage for
 *    exactly one window size and drifts in both directions from there, so the
 *    two ship as two values of one variable rather than one recast as the other.
 *
 * Our mechanism is CLIENT-SIDE — two ordinary tools (`mcp__tool_search`,
 * `mcp__tool_load`) plus a host catalog — not Claude's API beta
 * (`defer_loading` tool definitions and `tool_reference` content blocks). Every
 * platform fallback on that page is downstream of that wire dependency (Google
 * Cloud's Agent Platform, a non-first-party `ANTHROPIC_BASE_URL`, Azure-hosted
 * Microsoft Foundry, and `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS`), so none of
 * them has a counterpart here. Notably the Nessy Gateway IS a non-first-party
 * host: on Claude's rules our own default connection would fall back to upfront
 * loading, and ours does not have to.
 */

/** `NESSY_ENABLE_TOOL_SEARCH`, parsed. */
export type ToolSearchMode =
  /** Unset or unrecognized: the workspace preference and the count threshold decide. */
  | { kind: 'default' }
  /** `true` — defer every deferrable tool, no threshold. */
  | { kind: 'always' }
  /** `false` — load every tool definition upfront. */
  | { kind: 'never' }
  /** `auto` / `auto:N` — defer when tool definitions exceed N% of the context window. */
  | { kind: 'auto'; percentOfContextWindow: number }

/**
 * `agent-sdk/tool-search.md`, the `auto` row: "Counts the tokens in the tool
 * definitions that tool search can defer and compares the total against the
 * model's context window. When the total reaches 10% of the window, tool search
 * activates."
 */
export const TOOL_SEARCH_AUTO_DEFAULT_PERCENT = 10

export type EnvRecord = Record<string, string | undefined>

/**
 * `auto:N` with an unreadable or out-of-range N falls back to `auto` at 10%,
 * NOT to the unset default. The value unambiguously selected threshold mode;
 * only the number is unreadable, and the page defines `auto`'s own number. A
 * typo in the number must not silently switch the mechanism off.
 */
export function parseToolSearchMode(raw: string | undefined): ToolSearchMode {
  const value = (raw ?? '').trim().toLowerCase()
  if (value.length === 0) return { kind: 'default' }
  if (['1', 'true', 'yes', 'on'].includes(value)) return { kind: 'always' }
  if (['0', 'false', 'no', 'off'].includes(value)) return { kind: 'never' }
  if (value === 'auto') return { kind: 'auto', percentOfContextWindow: TOOL_SEARCH_AUTO_DEFAULT_PERCENT }
  if (value.startsWith('auto:')) {
    // `Number('')` is 0, and a bare `auto:` must not silently mean "defer
    // everything" — the emptiest possible number is the loudest possible rule.
    const raw = value.slice('auto:'.length).trim()
    const percent = raw.length === 0 ? Number.NaN : Number(raw)
    return {
      kind: 'auto',
      percentOfContextWindow: Number.isFinite(percent) && percent >= 0 && percent <= 100
        ? percent
        : TOOL_SEARCH_AUTO_DEFAULT_PERCENT,
    }
  }
  return { kind: 'default' }
}

/**
 * The environment variable's ONE spelling.
 *
 * D1.36 — an administrator keeps tool search on by carrying this name in the
 * managed policy's `env` block, and the disposition report says so by asking
 * `isManagedOriginEnvVar` about this exact string. Two spellings of it would
 * make the report answer about a name nothing reads.
 */
export const TOOL_SEARCH_ENV_VAR = 'NESSY_ENABLE_TOOL_SEARCH'

export function toolSearchMode(env: EnvRecord = process.env): ToolSearchMode {
  return parseToolSearchMode(env[TOOL_SEARCH_ENV_VAR])
}

/**
 * Why deferral is on or off for this manifest. Carried so the decision is
 * inspectable rather than a bare boolean whose cause has to be reconstructed;
 * it is NOT part of the manifest projection and cannot move a contract hash.
 */
export type DeferredMcpToolLoadingReason =
  | 'loader-unavailable'
  | 'uncached-source'
  | 'override-always'
  | 'override-always-no-candidates'
  | 'override-never'
  | 'auto-over-percent'
  | 'auto-under-percent'
  | 'auto-context-window-unknown-over-count'
  | 'auto-context-window-unknown-under-count'
  | 'preference-off'
  | 'preference-on'
  | 'preference-no-candidates'

export interface DeferredMcpToolLoadingDecision {
  enabled: boolean
  reason: DeferredMcpToolLoadingReason
}

/**
 * The single deferral decision, in precedence order.
 *
 * THE UNCACHED-SOURCE FLOOR OUTRANKS THE OVERRIDE, INCLUDING `false`. A desired
 * MCP server that has contributed no descriptors yet has nothing to load
 * upfront, so without the discovery tools its tools are unreachable — there is
 * no third state where they load. Claude's answer in that situation is a
 * different tool: `mcp.md:189` — "In configurations without tool search … Claude
 * uses the `WaitForMcpServers` tool instead." We have no `WaitForMcpServers`, so
 * an `ENABLE_TOOL_SEARCH=false` that also killed this fallback would do what the
 * page says and still be wrong for us: it would silently remove the only path to
 * those tools. The override therefore governs the PREFERENCE and the THRESHOLD,
 * and this floor is unconditional. Recorded as a deviation rather than hidden.
 *
 * ONE THING OUTRANKS THE FLOOR: THE LOADER ITSELF (UB12.9). Deferral hides every
 * candidate behind `mcp__tool_search`/`mcp__tool_load`; a manifest that lost
 * either half — a whole-tool `deny ToolSearch` (bound to both halves since
 * F1.1111), Pi's own `deny mcp__tool_load`, or a session pool narrowed past
 * them — would hide its tools behind a loader it does not have, and keeping
 * the floor on there reaches nothing. mcp.md, section "Configure tool search",
 * gives `{"permissions":{"deny":["ToolSearch"]}}` as the way to "disable the
 * `ToolSearch` tool specifically", beside the switch that loads every MCP tool
 * upfront; so without its loader a session loads upfront, and the deny stays
 * meaningful instead of turning every deferred tool unreachable.
 *
 * The `alwaysLoad` exemption is NOT applied here: it acts on the candidate set
 * before this function is reached, which is what makes it hold "regardless of
 * the `ENABLE_TOOL_SEARCH` setting" (`mcp.md:1221`) structurally rather than by
 * a branch that could be forgotten in one arm.
 */
export function resolveDeferredMcpToolLoading(input: {
  mode: ToolSearchMode
  /** `workspaceDefaults.deferredMcpToolLoading`. */
  workspacePreference: boolean
  hasUncachedMcpSource: boolean
  /** Deferrable candidates only — pinned and static tools are already excluded. */
  candidateCount: number
  /**
   * Estimated model-visible token cost of those candidates.
   *
   * Already the NARROWED denominator the current page describes — "each MCP
   * tool that isn't marked `alwaysLoad`, from any server, plus the built-in
   * tools that load on demand", with core built-ins excluded because the SDK
   * "always loads core built-in tools such as Bash, Read, and Edit upfront and
   * doesn't count them toward the threshold". **We already do this correctly**;
   * only the citation above was stale. Recorded rather than silently left
   * alone, so the next reader does not re-derive it.
   */
  candidateEstimatedTokens: number
  countThreshold: number
  /** Absent for a model whose window we do not know (arbitrary gateway models). */
  modelContextWindow?: number
  /**
   * UB12.9 — both discovery tools survive into the manifest (the permission
   * filter and the session's tool pool left them in). `false` turns deferral
   * off above every other input; absent means available.
   */
  loaderAvailable?: boolean
}): DeferredMcpToolLoadingDecision {
  if (input.loaderAvailable === false) return { enabled: false, reason: 'loader-unavailable' }
  if (input.hasUncachedMcpSource) return { enabled: true, reason: 'uncached-source' }

  const overCount = input.candidateCount > input.countThreshold

  switch (input.mode.kind) {
    case 'never':
      return { enabled: false, reason: 'override-never' }
    case 'always':
      // Nothing deferrable means nothing to defer: registering the discovery
      // tools would advertise an empty catalog. Narrowing only — it cannot make
      // a tool unreachable, because there is no candidate to hide.
      return input.candidateCount > 0
        ? { enabled: true, reason: 'override-always' }
        : { enabled: false, reason: 'override-always-no-candidates' }
    case 'auto': {
      if (input.modelContextWindow === undefined || input.modelContextWindow <= 0) {
        // No window, no percentage. Falling back to the COUNT keeps threshold
        // semantics, which is what `auto` asked for, and bypasses the workspace
        // preference for the same reason. Falling back to "off" would answer an
        // explicit request for a threshold with silence.
        return overCount
          ? { enabled: true, reason: 'auto-context-window-unknown-over-count' }
          : { enabled: false, reason: 'auto-context-window-unknown-under-count' }
      }
      const budget = (input.modelContextWindow * input.mode.percentOfContextWindow) / 100
      // `>=`, not `>`: the page says the threshold fires when the total
      // "REACHES 10% of the window". Our `>` matched the SUPERSEDED sentence,
      // which said "if they EXCEED 10%" — so the comparison was right against
      // the wording of its day and drifted when the page was reworded. At
      // exactly 10% upstream defers and we did not.
      return input.candidateEstimatedTokens >= budget
        ? { enabled: true, reason: 'auto-over-percent' }
        : { enabled: false, reason: 'auto-under-percent' }
    }
    case 'default':
      if (!input.workspacePreference) return { enabled: false, reason: 'preference-off' }
      // NO COUNT IS CONSULTED HERE, and that is contract point 1 at the top of
      // this file rather than a shortcut. The `(unset)` row says "Tool search is
      // on by default, with the exceptions listed in Configure tool search" —
      // the 10% belongs to the opt-in `auto` row, and a count belongs to
      // neither. While the preference shipped OFF this arm's count threshold was
      // unreachable and therefore harmless; the moment the preference ships ON
      // it becomes the whole behaviour, and it was WRONG.
      //
      // Measured before changing it, on the profile C.4 recorded: mode
      // `default`, 43 candidates, threshold 48 → `preference-under-count`,
      // deferral OFF. So flipping the two config sites and nothing else would
      // have shipped a default that reads as "on" everywhere, passes its tests,
      // and defers nothing — the row's own stated failure mode, wearing a
      // different disguise. It needed 49 tools to fire, and the machine that
      // measured 20 078 tokens of eager MCP definitions had 43.
      return input.candidateCount > 0
        ? { enabled: true, reason: 'preference-on' }
        // Same guard, same reason, as the `always` arm: with nothing deferrable
        // the discovery tools would advertise an empty catalog. Narrowing only.
        : { enabled: false, reason: 'preference-no-candidates' }
  }
}
