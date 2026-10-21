import type { PiRuntimeAgentDefinitionDescriptor } from './pi-harness/runtime-agent-definition.ts';
import { getClaudeExplorePlanAgentsEnabled } from '../config/storage.ts';

/**
 * P6.527 — the SDK's own off switch for its built-in subagents, set exactly on
 * the turns that ship agent definitions of our own.
 *
 * ## The gap
 *
 * A claude-runtime session that registers our agents ALSO carries the SDK's
 * built-in set, `general-purpose` first among them — an unvetted full-tool agent
 * that exists on one runtime of three and to which none of our disallowed-tools,
 * compatibility or budget checks were ever applied. Pi and codex have no
 * counterpart: on Pi our four bundled definitions are the whole set, and on
 * codex a role is guidance with spawning authorized independently. Denominator
 * H32; the posture was settled by the delegated decision of 2026-09-05 (Q-den
 * 64, option B — set the switch when we supply definitions).
 *
 * ## Native-first: this is CONFIGURATION, not construction
 *
 * The runtime documents and ships the switch, so nothing is built beside it.
 *
 * - `agent-sdk/subagents.md#filesystem-based-definition-alternative`, verbatim:
 *   "When Claude calls the Agent tool without a `subagent_type`, it gets the
 *   built-in `general-purpose` subagent, which Claude can spawn even when you
 *   define no agents of your own. Setting `CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS=1`
 *   removes that default, and such a call fails with `subagent_type is required`."
 * - `env-vars.md#variables`, verbatim: "Set to `1` to disable all built-in
 *   subagent types such as Explore and Plan. Only applies in non-interactive
 *   mode (the `-p` flag). Useful for SDK users who want a blank slate. This also
 *   removes `general-purpose`, the subagent Claude Code runs when an Agent tool
 *   call omits `subagent_type`. Such a call then fails with `subagent_type is
 *   required`".
 * - measured in the vendored binary (darwin-arm64) rather than assumed, and
 *   located by CONTENT rather than by minified name — the two names this bullet
 *   used to give were reassigned by the 0.3.233 → 0.3.247 bump, which is the rot
 *   `scripts/check-minified-citations.ts` exists to catch. Find it again with the
 *   two byte sequences that survive a minifier, each scoring 1 in the binary at
 *   `2.1.247`: the mode selector is the function containing
 *   `CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS&&` — at `2.1.247` it reads
 *   `if(V.CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS&&<isNonInteractive>())return"none";`
 *   followed by a coordinator branch and a `"default"` tail — and its consumer is
 *   the roster builder that opens `if(e==="none")return[]`. The gate is therefore
 *   `<env var> AND not interactive`, i.e. the page's "only applies in
 *   non-interactive mode" is the binary's own, and every SDK session we spawn is
 *   on that side of it. The value is parsed by the env registry's `bool()`, whose
 *   truthy set is `["1","true","yes","on"]` — hence `'1'`.
 *
 * ## The residue, stated rather than hidden (owner rule: transparent and simple)
 *
 * Turning the built-ins off is not free, and both costs are named here because
 * neither is visible at the call site:
 *
 * 1. **An Agent call that omits `subagent_type` now fails** with the runtime's
 *    own `subagent_type is required`. That is a legible failure, and it is the
 *    behaviour Pi and codex already have — neither has a nameless-delegation
 *    default — so this REMOVES a one-runtime divergence rather than adding one.
 * 2. **`Explore` and `Plan` go with the rest.** They are not re-declared, and
 *    they are not lost either: the four we seed on exactly this branch
 *    (`buildClaudeRuntimeBuiltinAgents`, from `BUILTIN_AGENT_DEFINITIONS`) carry
 *    `scout` — read-only `Read`/`Grep`/`Glob`, the Explore shape — and
 *    `planner`. What a thin definition set loses is the SDK's wording of those
 *    two agents, not the capability, and it gains the property that the roster
 *    is identical to Pi's.
 *
 * ## Why the switch is not simply always on
 *
 * The `definitions === undefined` case is a runtime that dispatches no agent
 * definitions at all. There we send no `agents` option either
 * ({@link buildClaudeRuntimeAgentOptions} omits an empty record ENTIRELY), so
 * disabling the built-ins would leave that session with NO subagents whatever —
 * a capability deleted, not a divergence closed. The gate below is the same pair
 * of conditions that builder already computes, and
 * `claude-runtime-builtin-agent-env.test.ts` pins the two against each other on
 * every input shape so they cannot drift apart.
 *
 * ## Why this lives beside `claude-runtime-agents.ts` rather than inside it
 *
 * Wave-8 file zoning: that module carried another lane's in-flight hunk for the
 * whole of this lane's window, and committing it would have swept work that is
 * not ours. The equivalence test is what keeps the split honest.
 */
export const CLAUDE_SDK_DISABLE_BUILTIN_AGENTS_ENV = 'CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS';

/**
 * P6.313 — the SECOND documented off switch, and the one that was set by nobody
 * while this module set its sibling.
 *
 * ## Native-first: configuration again, and the pair is NOT one switch
 *
 * `env-vars.md#variables`, verbatim: *"Set to `1` to disable the built-in
 * Explore and Plan subagents. Claude explores with its search tools or the
 * general-purpose subagent instead, and plan mode reads files directly rather
 * than launching Explore and Plan agents. Custom subagents named `Explore` or
 * `Plan` are unaffected. To remove every built-in subagent type in the Agent SDK
 * or non-interactive mode, use `CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS`
 * instead. Requires Claude Code v2.1.198 or later"*.
 *
 * Measured in the vendored binary (2.1.233, darwin-arm64, 2026-09-08) rather
 * than assumed, and the measurement is what makes the gate below honest.
 * `getBuiltInAgents()` is one builder and BOTH switches act on it:
 *
 *     function getBuiltInAgents(){
 *       let e = builtinMode();            // "none" when the SDK switch is set AND non-interactive
 *       if (e === "none") return [];
 *       …
 *       if (explorePlanEnabled()) t.push(Explore, Plan);
 *       …
 *     }
 *
 * with `explorePlanEnabled()` = `latched ??= !env.CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS`.
 * Three consequences, none of them guessable from the page:
 *
 * 1. It gates EXACTLY two entries, not the list. The `general-purpose` default
 *    the SDK switch removes is untouched by it.
 * 2. It is a plain truthiness read, so any non-empty value disables — `'1'` is
 *    chosen for the sibling's reason, not because the parser demands it.
 * 3. It is **latched** per process, so this belongs in the SPAWN environment and
 *    could not be a live setter even if the SDK published one.
 *
 * ## Where it actually changes something, stated rather than implied
 *
 * On a turn that supplies definitions of our own, the sibling switch above
 * already returns the built-in list as `[]` — Explore and Plan are gone with the
 * rest, and this variable changes nothing. So the turn shape it governs is the
 * OTHER one: a session that dispatches no definitions (a `mini` completion, or a
 * runtime carrying none), where the built-ins are deliberately KEPT. That is the
 * roster a user asking for "no Explore and Plan" is actually looking at, and it
 * is the one nothing could reach before this row.
 *
 * ## The codex arm is UNAVAILABLE, and is said so here rather than ignored
 *
 * Denominator H31's verdict for codex is `absent`, and it is absent by
 * construction rather than by omission: codex has no per-agent deny — a role is
 * declared in `[agents]` or it is not — so there is no switch to enable and
 * nothing for the host to supply uniformly. A user who turns this off is
 * choosing a claude-runtime roster; the same choice on codex is a no-op because
 * codex ships no Explore/Plan pair to remove (its own two are `explorer` and
 * `awaiter`, measured on the shipped binary by P6.262 and carried in the
 * runtime-switch table's `codexBuiltinAgents` row). Pi is unaffected for the
 * same reason its own built-in set is ours: it has no vendor roster underneath.
 */
export const CLAUDE_DISABLE_EXPLORE_PLAN_AGENTS_ENV = 'CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS';

/**
 * True when this turn hands the SDK an `agents` record of our own — the exact
 * condition {@link buildClaudeRuntimeAgentOptions} uses to decide whether to
 * emit one.
 *
 * Both gates are that builder's, restated rather than re-derived:
 *
 * - `mini` returns early there, so a lean internal completion registers nothing
 *   and must keep the runtime's own set;
 * - `definitions` is checked for PRESENCE, not for length: an empty array is
 *   "this session dispatches definitions and the user authored none", and the
 *   builder seeds our four built-ins on that branch.
 *
 * One stated exception, where the builder sends NO record and this still
 * answers true: F1.1203 lets a trusted project's `.claude/agents` files take
 * over the bundled names, and when they take over all four (and the session
 * has no other definition of ours) the record is empty. The switch stays set
 * on purpose: the roster is then the files Claude loads itself, which is the
 * set the session dispatches, and `general-purpose`, `Explore` and `Plan`
 * stay off as on every other turn that dispatches definitions. The drift test
 * pins that shape as the exception.
 */
export function claudeRuntimeSuppliesAgentDefinitions(input: {
  definitions: readonly PiRuntimeAgentDefinitionDescriptor[] | undefined;
  mini: boolean;
}): boolean {
  if (input.mini) return false;
  return input.definitions !== undefined;
}

/**
 * The env fragment for one Claude turn, in the shape `getDefaultOptions`'s
 * `envOverrides` parameter takes (`Record<string, string>`), so the call site is
 * one spread and no new plumbing.
 *
 * Absent means absent: `{}` rather than an explicit `undefined` value, because
 * the SDK's `env` REPLACES the child environment wholesale and an
 * `undefined`-valued key there is not the same as an unset one.
 */
export function buildClaudeRuntimeBuiltinAgentEnv(input: {
  definitions: readonly PiRuntimeAgentDefinitionDescriptor[] | undefined;
  mini: boolean;
  /**
   * P6.313 — the user's three-state answer, defaulted from `config.json` for the
   * reason the neighbouring flag builders do it: the caller is one spread inside
   * a several-hundred-line options literal, and a second read there would be a
   * second place for the default to drift.
   *
   * `undefined` (unset) emits NOTHING, and that is not the same as `true`: the
   * vendor's default is ON, so an install that never touched the key must spawn
   * byte-identically to one built before this row.
   */
  explorePlanAgentsEnabled?: boolean | undefined;
}): Record<string, string> {
  const explorePlan = input.explorePlanAgentsEnabled === undefined
    ? getClaudeExplorePlanAgentsEnabled()
    : input.explorePlanAgentsEnabled;
  return {
    ...(claudeRuntimeSuppliesAgentDefinitions(input)
      ? { [CLAUDE_SDK_DISABLE_BUILTIN_AGENTS_ENV]: '1' }
      : {}),
    // Independent of the gate above, deliberately. The two switches are one
    // roster but not one condition: the sibling is bound to whether WE supply a
    // definition set, and this one is the user's standing answer, which must
    // hold on every turn shape they meet — including the `mini` completions the
    // sibling deliberately leaves alone.
    ...(explorePlan === false ? { [CLAUDE_DISABLE_EXPLORE_PLAN_AGENTS_ENV]: '1' } : {}),
  };
}
