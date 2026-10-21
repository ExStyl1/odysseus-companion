/**
 * Per-event hook decision contract (R9).
 *
 * `hooks.md` § "Decision control" does not define one decision shape — it
 * defines FIVE patterns, and which one an event speaks decides what its hook
 * output is allowed to do. Before this table the codebase carried a single
 * `event === 'PreToolUse'` gate, which made every other event observational by
 * construction: a `PermissionRequest` hook returning
 * `hookSpecificOutput.decision.behavior: "allow"` executed on the real app and
 * the permission prompt was raised anyway, because its decision was dropped one
 * layer below the band that was written to consume it.
 *
 * The five documented patterns:
 * - `top-level` — a top-level `decision: "block"` + `reason`; the reason is fed
 *   back to the model rather than cancelling a tool call.
 * - `hook-specific` — `hookSpecificOutput` with a different shape per event.
 * - `exit-code-only` — exit 2 or `continue: false` and nothing else; these
 *   events have no `decision` field at all.
 * - `path-return` — `WorktreeCreate` returns a path.
 * - `context-only` — no decision surface; observational context only.
 *
 * Every emission-site gate reads this table instead of naming an event, so an
 * event can never gain a decision the docs do not give it, and can never lose
 * one the docs do.
 */

import type { AgentEvent, PreToolUseDecision, PreToolUseDecisionValue } from './types.ts';

export type HookDecisionPattern =
  | 'top-level'
  | 'hook-specific'
  | 'exit-code-only'
  | 'path-return'
  | 'context-only';

/** Decision-object keys an event's pattern may carry through to its consumer. */
export type HookDecisionField = keyof PreToolUseDecision;

/** The nine events whose documented output is a top-level `decision`/`reason`. */
const TOP_LEVEL_BLOCK_EVENTS = [
  'UserPromptSubmit',
  'UserPromptExpansion',
  'PostToolUse',
  'PostToolUseFailure',
  'PostToolBatch',
  'Stop',
  'SubagentStop',
  'ConfigChange',
  'PreCompact',
] as const satisfies readonly AgentEvent[];

/**
 * `hookSpecificOutput` events. `PostToolUse` speaks BOTH patterns (a top-level
 * block and `hookSpecificOutput.updatedToolOutput`); its primary pattern is the
 * top-level one and the extra field rides its surface below.
 *
 * `TeammateIdle` is a documented member of the exit-code-only pattern but is not
 * an event we emit (deferred — see `plugins/hook-events.ts`), so it cannot appear in an
 * `AgentEvent`-keyed table.
 */
const HOOK_SPECIFIC_EVENTS = [
  'PreToolUse',
  'PermissionRequest',
  'PermissionDenied',
  // R32. `hookSpecificOutput` in shape, and nothing else: hooks.md:1313 —
  // "MessageDisplay hooks have no decision control."
  'MessageDisplay',
  // Claude's `Elicitation`/`ElicitationResult` pair (`McpElicitation` is this
  // codebase's spelling of `Elicitation` — see `format-adapters.ts`). R24 built
  // the response channel their documented `{action, content}` shape needs, so
  // the surface below is now real rather than deferred to context-only.
  'McpElicitation',
  'ElicitationResult',
  // P3.374 · hooks.md#premodelswitch-decision-control: "`hookSpecificOutput` or
  // top-level `decision`" with "`permissionDecision` (allow/deny/ask),
  // `permissionDecisionReason`". The primary documented pattern is the
  // hook-specific one, and the top-level `decision: "block"` is the second
  // spelling of the same cancel — both reach `isBlockingHookDecision`.
  'PreModelSwitch',
] as const satisfies readonly AgentEvent[];

/** Exit 2 / `continue: false` only — no `decision` field on these events. */
const EXIT_CODE_ONLY_EVENTS = ['TaskCreated', 'TaskCompleted'] as const satisfies readonly AgentEvent[];

const PATH_RETURN_EVENTS = ['WorktreeCreate'] as const satisfies readonly AgentEvent[];

function patternFor(event: AgentEvent): HookDecisionPattern {
  // Order matters: `PostToolUse` is in both lists and its primary documented
  // pattern is the top-level block.
  if ((TOP_LEVEL_BLOCK_EVENTS as readonly AgentEvent[]).includes(event)) return 'top-level';
  if ((HOOK_SPECIFIC_EVENTS as readonly AgentEvent[]).includes(event)) return 'hook-specific';
  if ((EXIT_CODE_ONLY_EVENTS as readonly AgentEvent[]).includes(event)) return 'exit-code-only';
  if ((PATH_RETURN_EVENTS as readonly AgentEvent[]).includes(event)) return 'path-return';
  // `SessionStart`/`Setup`/`SubagentStart` are the documented context-only
  // events; every remaining event we emit is observational with no documented
  // decision surface, which is the same thing. Context-only is about DECISIONS:
  // hooks.md:947 gives the three "No blocking or decision control" and in the
  // same row gives SessionStart alone four more output FIELDS, which is why
  // `surfaceFor` has an explicit `SessionStart` case and `SubagentStart` keeps
  // the bare `additionalContext` fallback. (`Setup` is the third name in that
  // doc row and is not an `AgentEvent` here at all — see
  // `UNEMITTED_HOOK_EVENT_REASONS`.)
  return 'context-only';
}

/** A top-level block is spelled `block`; `deny` is this codebase's synonym. */
const BLOCK_VALUES: readonly PreToolUseDecisionValue[] = ['block', 'deny'];
const NO_VALUES: readonly PreToolUseDecisionValue[] = [];

export interface HookEventDecisionSurface {
  readonly pattern: HookDecisionPattern;
  /** Permission-decision values the event's output may carry. */
  readonly decisionValues: readonly PreToolUseDecisionValue[];
  /** Non-`decision` keys the event's output may carry. */
  readonly fields: readonly HookDecisionField[];
}

/**
 * Per-event decision surface. Anything absent here is dropped from a parsed
 * hook output before it reaches a consumer — the single place that answers
 * "what is this event's hook allowed to decide?".
 */
function surfaceFor(event: AgentEvent): HookEventDecisionSurface {
  const pattern = patternFor(event);
  switch (event) {
    case 'PreToolUse':
      // `defer` is PreToolUse-only (hooks.md "Defer a tool call for later"):
      // suspends the call for a later resume on the headless surface. The
      // consumer enforces the headless/single-call constraints; here it is
      // simply part of the documented vocabulary. `reason`, `updatedInput`
      // and `additionalContext` are ignored when a defer is honored.
      return {
        pattern,
        decisionValues: ['allow', 'ask', 'block', 'deny', 'defer'],
        fields: ['reason', 'additionalContext', 'updatedInput'],
      };
    case 'PermissionRequest':
      // hooks.md#permissionrequest: `decision: {behavior, updatedInput,
      // updatedPermissions, message, interrupt}`. There is no `applyRule`.
      return {
        pattern,
        decisionValues: ['allow', 'ask', 'block', 'deny'],
        fields: ['reason', 'additionalContext', 'updatedInput', 'updatedPermissions', 'interrupt'],
      };
    case 'PermissionDenied':
      // The denial itself is final; the documented output is `{retry: true}`,
      // never a decision reversal.
      return { pattern, decisionValues: NO_VALUES, fields: ['additionalContext', 'retry'] };
    case 'MessageDisplay':
      // hooks.md:1311 — the whole documented output is
      // `hookSpecificOutput.displayContent`, "Text displayed in place of the
      // delta. Omit it to display the original". `NO_VALUES` because ":1313
      // MessageDisplay hooks have no decision control. They can't block the
      // message or change what is stored in the transcript or sent to Claude" —
      // so a `decision`/`reason`/`continue`-derived block is projected away here
      // rather than reaching the display path. `additionalContext` is absent for
      // the same sentence: context is what the MODEL sees, and this event is not
      // allowed to change that.
      return { pattern, decisionValues: NO_VALUES, fields: ['displayContent'] };
    case 'McpElicitation':
    case 'ElicitationResult':
      // hooks.md §Elicitation / §ElicitationResult: the whole documented output
      // is `hookSpecificOutput.{action, content}`. `BLOCK_VALUES` is here for
      // the documented "Exit 2: blocks the elicitation (action becomes
      // decline)" — it is what routes these events through
      // `getHookCommandPreToolDecision`, the only branch that reads an exit
      // code (the same R20 mechanism as TaskCreated). The consumer maps a block
      // to `decline`; there is no permission decision on these events.
      return {
        pattern,
        decisionValues: BLOCK_VALUES,
        fields: ['reason', 'additionalContext', 'elicitationAction', 'elicitationContent'],
      };
    case 'SessionStart':
      // hooks.md:947 — "`hookSpecificOutput.additionalContext` adds context for
      // Claude. SessionStart also accepts [`initialUserMessage`, `watchPaths`,
      // `sessionTitle`, and `reloadSkills`]. No blocking or decision control".
      // `NO_VALUES` keeps the second sentence true; the four extra fields are
      // this event's and only this event's — `SubagentStart` shares the row's
      // first sentence and nothing else, so it stays on the bare context-only
      // fallback below.
      return {
        pattern,
        decisionValues: NO_VALUES,
        fields: ['additionalContext', 'initialUserMessage', 'sessionTitle', 'watchPaths', 'reloadSkills'],
      };
    case 'PreModelSwitch':
      // hooks.md#premodelswitch-decision-control: "When multiple PreModelSwitch
      // hooks return different decisions, precedence is `deny` > `ask` >
      // `allow`", and `decision: "block"` cancels the switch. No
      // `additionalContext`: the page gives that field to PostModelSwitch alone
      // ("Claude Code takes your hook's plain-text stdout … and delivers it to
      // Claude with the next request AFTER the switch"), so accepting it here
      // would invent a delivery point that does not exist.
      return { pattern, decisionValues: ['allow', 'ask', 'block', 'deny'], fields: ['reason'] };
    case 'UserPromptSubmit':
      // hooks.md:1266 adds `sessionTitle` to this event's output table — "Sets
      // the session title. Use to name sessions automatically based on the
      // prompt content" — on top of the shared top-level block surface. Added
      // as an explicit case rather than to the `top-level` default below: the
      // other eight events in that group never document the field, and widening
      // the default would hand a session rename to `PostToolUse`, `Stop` and
      // `ConfigChange` hooks as well.
      return {
        pattern,
        decisionValues: BLOCK_VALUES,
        fields: ['reason', 'additionalContext', 'sessionTitle'],
      };
    case 'PostToolUse':
      // The top-level block feeds `reason` back to the model;
      // `updatedToolOutput` replaces what the model sees.
      //
      // P7.14 · `classifierContext` is the one field of this pair the FAILURE
      // twin below does not share, and the split is the vendored declaration's
      // rather than a preference: `PostToolUseHookSpecificOutput` declares
      // `classifierContext` (since `0.3.247`) and
      // `PostToolUseFailureHookSpecificOutput` is `{ hookEventName;
      // additionalContext? }` — no note, no rewrite of any kind. So the two
      // events stopped being one wire on this field only.
      return {
        pattern,
        decisionValues: BLOCK_VALUES,
        fields: ['reason', 'additionalContext', 'updatedToolOutput', 'classifierContext'],
      };
    case 'PostToolUseFailure':
      // Same tool-result wire as `PostToolUse` above for the replacement field,
      // and deliberately without its classifier note — see that case.
      return {
        pattern,
        decisionValues: BLOCK_VALUES,
        fields: ['reason', 'additionalContext', 'updatedToolOutput'],
      };
    default:
      break;
  }
  if (pattern === 'top-level') {
    return { pattern, decisionValues: BLOCK_VALUES, fields: ['reason', 'additionalContext'] };
  }
  if (pattern === 'path-return') {
    // The returned path is the surface, and hooks.md:699 adds the abort: "The
    // exception is `WorktreeCreate`, where any non-zero exit code aborts
    // worktree creation." A block derived from the EXIT CODE therefore
    // survives projection; there is still no `decision` field on stdout, which
    // `hookEventStdoutCanDecide` enforces by excluding this pattern.
    return { pattern, decisionValues: BLOCK_VALUES, fields: ['reason', 'additionalContext', 'worktreePath'] };
  }
  if (pattern === 'exit-code-only') {
    // R20. "Exit-code-only" names how the hook SPEAKS, not whether it decides:
    // `hooks.md:708-709` gives exit 2 real authority — it "Rolls back the task
    // creation" and "Prevents the task from being marked as completed" — and
    // `:2064` feeds stderr back to the model as the reason. Carrying
    // `decisionValues: NO_VALUES` here is what made `hookEventCanDecide` false,
    // which sent `automation-system.ts` down the stdout-parsing branch that
    // never reads an exit code. There is still no `decision` FIELD to parse out
    // of stdout; the block is synthesised from the exit code and from the
    // universal `continue: false`.
    return { pattern, decisionValues: BLOCK_VALUES, fields: ['reason', 'additionalContext'] };
  }
  // Whatever is left is context-only: it reaches its consumer as observational
  // context and nothing more. Every `hook-specific` event now has an explicit
  // case above, so falling through here with that pattern would be a table gap.
  return { pattern, decisionValues: NO_VALUES, fields: ['additionalContext'] };
}

const SURFACE_CACHE = new Map<AgentEvent, HookEventDecisionSurface>();

export function hookEventDecisionSurface(event: AgentEvent): HookEventDecisionSurface {
  const cached = SURFACE_CACHE.get(event);
  if (cached) return cached;
  const surface = Object.freeze(surfaceFor(event));
  SURFACE_CACHE.set(event, surface);
  return surface;
}

/** Which of the five documented decision patterns this event speaks. */
export function hookDecisionPattern(event: AgentEvent): HookDecisionPattern {
  return hookEventDecisionSurface(event).pattern;
}

/** True when the event's documented output can carry a permission decision. */
export function hookEventCanDecide(event: AgentEvent): boolean {
  return hookEventDecisionSurface(event).decisionValues.length > 0;
}

/**
 * True when a hook's STDOUT may carry a `decision` field for this event.
 *
 * Distinct from `hookEventCanDecide` since R20: an `exit-code-only` event CAN
 * decide — exit 2 rolls back a task creation — but its two documented
 * mechanisms are the exit code and the universal `continue: false`. There is no
 * documented `decision` field on its stdout, so an exit-0 hook printing
 * `{"decision":"block"}` decides nothing. `path-return` is the same shape
 * since the WorktreeCreate abort landed: the exit code aborts, the stdout is
 * the PATH, never a decision. Both parse sites read this rather than
 * re-deriving it, so the two cannot drift apart.
 */
export function hookEventStdoutCanDecide(event: AgentEvent): boolean {
  const pattern = hookDecisionPattern(event);
  return hookEventCanDecide(event) && pattern !== 'exit-code-only' && pattern !== 'path-return';
}

/**
 * Documented per-event matrix for what a `decision: "block"` DOES
 * (hooks.md § Decision control + the `continueOnBlock` matrix):
 * - `UserPromptSubmit`, `UserPromptExpansion`, `PostToolBatch` "end the turn on
 *   `decision: block` regardless of `continue`".
 * - `PreToolUse` denies the CALL and the turn continues — see
 *   {@link hookBlockEndsTurn} for the sentence that decided it (P3.195). Until
 *   that row this list's second arm ended the turn on a plain deny, which is the
 *   PROMPT-hook default rather than the command-hook one; the kind-dependent
 *   half moved to {@link promptHookBlockEndsTurn}, which is where the kind is
 *   known.
 * - `Stop`/`SubagentStop` feed the reason back and continue — that is the
 *   documented "keep going, here is why" channel.
 * - `PostToolUse`/`PostToolUseFailure`/`TaskCreated` return as a tool error and
 *   continue.
 * - `ConfigChange` and `PreCompact` block a NON-TURN action, so neither belongs
 *   in the list below even though both really do block. This line used to call
 *   them "advisory", which the page contradicts for both: hooks.md's exit-code-2
 *   table gives ConfigChange "Blocks the configuration change from taking effect
 *   (except `policy_settings`)" and PreCompact "Blocks compaction", and both are
 *   named in the top-level-`decision` row of § Decision control. A blocked
 *   config change leaves the running session on its previous settings; a blocked
 *   compaction is skipped and "the conversation continues uncompacted". In
 *   neither case is the turn terminated, so `hookBlockEndsTurn` stays `false`
 *   for both — that is what this list decides, and only that.
 */
const ALWAYS_TERMINAL_BLOCK_EVENTS: readonly AgentEvent[] = [
  'UserPromptSubmit',
  'UserPromptExpansion',
  'PostToolBatch',
];

/**
 * `PostToolUse` output rewriting (hooks.md): `updatedToolOutput` replaces the
 * tool result the model sees, with one documented constraint — "For built-in
 * tools, a value that doesn't match the tool's output schema is ignored and the
 * original output is used."
 *
 * Our built-ins declare no JSON output schema (their results travel the Pi wire
 * as text), so the enforceable contract is the shape the result actually has: a
 * string, and — when the original result is a JSON envelope — a replacement that
 * is still parseable JSON of the same top-level kind. A hook that turns a JSON
 * envelope into prose has produced something the model's caller cannot read,
 * which is exactly the mismatch the rule is about. MCP tool results carry no
 * such guarantee and the docs scope the constraint to built-ins, so they pass.
 */
export type HookToolOutputRewrite =
  | { output: string }
  | { ignoredReason: 'not-a-string' | 'schema-mismatch' };

function jsonKind(value: string): 'object' | 'array' | 'other' | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) return 'array';
    if (parsed && typeof parsed === 'object') return 'object';
    return 'other';
  } catch {
    return null;
  }
}

export function resolveHookToolOutputRewrite(args: {
  toolName: string;
  originalOutput: string;
  updatedToolOutput: unknown;
}): HookToolOutputRewrite {
  if (typeof args.updatedToolOutput !== 'string') return { ignoredReason: 'not-a-string' };
  // `mcp__<server>__<tool>` is the qualified proxy name for an external tool.
  if (args.toolName.startsWith('mcp__')) return { output: args.updatedToolOutput };
  const originalKind = jsonKind(args.originalOutput);
  if (originalKind === null) return { output: args.updatedToolOutput };
  return jsonKind(args.updatedToolOutput) === originalKind
    ? { output: args.updatedToolOutput }
    : { ignoredReason: 'schema-mismatch' };
}

/** `block` is Claude's spelling, `deny` this codebase's synonym for it. */
export function isBlockingHookDecision(decision: PreToolUseDecision | undefined): boolean {
  return decision?.decision === 'block' || decision?.decision === 'deny';
}

/**
 * Does a hook's `decision: "block"` on this event END THE TURN, for a hook whose
 * output is the documented JSON schema — `command`, `http` and `mcp_tool`?
 *
 * ## P3.195 — THE CONTRACT, DECIDED ONCE
 *
 * **A command-family hook's PreToolUse deny denies the CALL and the turn
 * continues. Only the hook's own `continue: false` ends it.** This function had
 * the opposite default, and `continue: false` outranks every event-specific
 * field, so P3.176's move of the decision onto `permissionDecision` was
 * cosmetic: the deny travelled through the documented field and the turn ended
 * anyway.
 *
 * The deciding sentence is `hooks.md#response-schema`, in the prompt-hook
 * per-event list, because it states BOTH halves in one breath:
 *
 * > "`PreToolUse`: the tool call is denied; by default the turn ends and the
 * > deny reason appears in the chat as a warning line. Set `continueOnBlock:
 * > true` to instead return the reason to Claude as the tool error so it can
 * > adjust and continue, equivalent to a command hook's `permissionDecision:
 * > "deny"`."
 *
 * The equivalence is the ruling: the shape that CONTINUES is the one that is
 * *equivalent to a command hook's deny*, so a command hook's deny continues.
 * Three independent readings agree — `hooks.md#exit-code-2-behavior-per-event`
 * gives `PreToolUse` "Blocks the tool call" where the event that really does end
 * the loop says so ("`PostToolBatch` … Stops the agentic loop before the next
 * model call"); `hooks.md#pretooluse-decision-control` says
 * `permissionDecisionReason` is, for `"deny"`, "shown to Claude", which is only
 * an effect if Claude keeps going; and `hooks.md#json-output` reserves stopping
 * for `continue` — "If `false`, Claude stops processing entirely after the hook
 * runs. Takes precedence over any event-specific decision fields."
 *
 * It also ends a disagreement this fork had with ITSELF: the live claude gate
 * has always answered a hook deny with `denyToolWithReason` — a bare
 * `permissionDecision: 'deny'`, no `continue` — so the matrix here and the
 * runtime it describes now say the same thing.
 *
 * ## The parameter that is gone
 *
 * `continueRequested` was the `continue: true` that `continueOnBlock` compiles
 * to, and it existed only to suppress the PreToolUse arm above. With that arm
 * gone it could not change any answer: the three events below end the turn
 * "regardless of `continue`", and everything else already continued. The
 * kind-dependent default it approximated now lives on
 * {@link promptHookBlockEndsTurn}, applied by the PRODUCER — the one place that
 * knows whether the block came from a prompt hook or a command hook.
 */
export function hookBlockEndsTurn(event: AgentEvent): boolean {
  return ALWAYS_TERMINAL_BLOCK_EVENTS.includes(event);
}

/**
 * The events on which a PROMPT hook's block ends the turn unless the author set
 * `continueOnBlock: true` — the other half of the sentence quoted on
 * {@link hookBlockEndsTurn}, and the reason that sentence needed a home.
 *
 * `hooks.md#response-schema` lists five events and gives three different rules;
 * these two are the ones whose DEFAULT is terminal:
 *
 * > "`PreToolUse`: the tool call is denied; by default the turn ends …"
 * > "`PostToolUse`: by default the turn ends and the reason appears in the chat
 * > as a warning line. Set `continueOnBlock: true` to feed the reason back to
 * > Claude and continue the turn instead"
 *
 * The other three are deliberately absent and stay absent: `PostToolUseFailure`,
 * `TaskCreated` and (in its in-turn case) `TaskCompleted` continue "regardless
 * of `continueOnBlock`". `TeammateIdle` is the fourth documented member and has
 * no {@link AgentEvent} of its own in this fork — nothing emits it — so naming
 * it here would not compile and would describe an event no hook can match.
 *
 * AGENT hooks are not prompt hooks for this purpose: `hooks.md#response-schema`
 * says an agent hook's `ok: false` is handled "the way it handles a prompt hook
 * with `continueOnBlock: true`", so they never reach this rule.
 */
const PROMPT_HOOK_TERMINAL_BLOCK_EVENTS: readonly AgentEvent[] = ['PreToolUse', 'PostToolUse'];

/**
 * Does a PROMPT hook's block end the turn on this event?
 *
 * Separate from {@link hookBlockEndsTurn} rather than a flag on it, because the
 * two answer different questions and only the producer can tell them apart: by
 * the time a merged decision reaches the SDK translator, the hook KIND that
 * produced it is gone. The producer therefore writes the terminality it knows
 * about into the universal `continue: false`, which the page already makes
 * authoritative over every event-specific field — one mechanism, not two.
 */
export function promptHookBlockEndsTurn(event: AgentEvent, continueOnBlock: boolean): boolean {
  if (hookBlockEndsTurn(event)) return true;
  return !continueOnBlock && PROMPT_HOOK_TERMINAL_BLOCK_EVENTS.includes(event);
}

/**
 * The two `SessionStart` sources that must NOT take a hook's `sessionTitle`.
 *
 * hooks.md:1060 — "Applies when `source` is `"startup"`, `"resume"`, or
 * `"fork"`; ignored on `"clear"` and `"compact"`". Written as the exclusion
 * half rather than the allow-list half on purpose: the two halves agree on all
 * five documented sources, and an emitter that sends SessionStart without a
 * `source` at all would silently lose every hook title under an allow-list,
 * turning an unrelated payload gap into a dropped rename.
 *
 * A `/clear` or a compaction keeps the session it started in, so a rename there
 * would retitle a conversation the user never restarted — which is the reason
 * the sentence exists.
 */
const SESSION_START_TITLE_EXCLUDED_SOURCES: readonly string[] = ['clear', 'compact'];

/**
 * Apply hooks.md:1060's source gate to an already-projected decision.
 *
 * The gate reads the hook INPUT, so it cannot live in the per-event surface
 * table — that table answers "what may this EVENT decide?" and knows nothing
 * about the payload. Every executor applies it to its own result, before any
 * consumer can see the field, so the exclusion cannot be bypassed by adding a
 * consumer later.
 */
export function applySessionStartTitleSourceGate(
  event: AgentEvent,
  source: string | undefined,
  decision: PreToolUseDecision | undefined,
): PreToolUseDecision | undefined {
  if (event !== 'SessionStart' || decision?.sessionTitle === undefined) return decision;
  if (!source || !SESSION_START_TITLE_EXCLUDED_SOURCES.includes(source)) return decision;
  const { sessionTitle: _dropped, ...rest } = decision;
  return Object.keys(rest).length > 0 ? rest : undefined;
}

/**
 * Project one parsed hook decision onto the event's documented surface.
 * Returns `undefined` when nothing survives — the caller then treats the hook
 * as having produced no output at all.
 */
export function projectHookDecisionForEvent(
  event: AgentEvent,
  decision: PreToolUseDecision | undefined,
): PreToolUseDecision | undefined {
  if (!decision) return undefined;
  const surface = hookEventDecisionSurface(event);
  const projected: PreToolUseDecision = {};
  if (decision.decision && surface.decisionValues.includes(decision.decision)) {
    projected.decision = decision.decision;
  }
  for (const field of surface.fields) {
    const value = decision[field];
    if (value === undefined) continue;
    // `reason` without a decision is not a decision surface — it would read as
    // an unexplained block. Keep it only alongside the decision it explains.
    if (field === 'reason' && projected.decision === undefined) continue;
    Object.assign(projected, { [field]: value });
  }
  return Object.keys(projected).length > 0 ? projected : undefined;
}

/**
 * Documented multi-hook precedence, and the ONE place that spells it.
 *
 * `hooks.md#pretooluse-decision-control`: "When multiple PreToolUse hooks
 * return different decisions, precedence is `deny` > `defer` > `ask` >
 * `allow`." `agent-sdk/hooks.md` states the same rule for callback hooks —
 * "When multiple hooks or permission rules apply, `deny` takes priority over
 * `defer`, which takes priority over `ask`, which takes priority over `allow`.
 * If any hook returns `deny`, the operation is blocked regardless of other
 * hooks." — so the ordering is identical on every route a hook can arrive by,
 * and it is not a per-runtime or per-host choice.
 *
 * `block` is this codebase's spelling of a deny and ranks with it.
 *
 * P3.193/P3.194 — this table existed THREE times: `hook-command.ts`'s
 * (typed, correct), `automation-system.ts`'s (`Record<string, number>`), and
 * an inline one in `plugins/hooks-automation.ts`. The untyped copies are how
 * `defer` went missing and scored 0 — BELOW `allow` — so a later allow erased
 * an earlier defer. The total `Record<PreToolUseDecisionValue, number>` is the
 * load-bearing part: a value added to the union without a rank is a compile
 * error rather than a silent 0.
 */
export const PRE_TOOL_USE_DECISION_PRECEDENCE: Record<PreToolUseDecisionValue, number> = {
  deny: 4,
  block: 4,
  defer: 3,
  ask: 2,
  allow: 1,
};

/** Rank of one decision value; an absent or off-union value ranks below all of them. */
export function preToolUseDecisionRank(value: PreToolUseDecisionValue | undefined): number {
  if (!value) return 0;
  return PRE_TOOL_USE_DECISION_PRECEDENCE[value] ?? 0;
}

/**
 * Fold two hook decisions for one event into one, under the documented
 * precedence above. A later decision of EQUAL-or-higher rank wins, which keeps
 * the pre-`defer` behaviour where a later hook overrode an earlier one of the
 * same strength.
 *
 * THE ONLY IMPLEMENTATION (P3.194). There were two: this one, and a near-copy
 * in `automations/automation-system.ts` that both routes reached through
 * different callers. They drifted twice — on `defer`'s rank and on whether the
 * merge rebuilt the object from a hand-written field list — and the *reason* a
 * collapse was possible is the measurement, not the resemblance: over all 49
 * ordered pairs of decision values the two agreed on every DECISION, and
 * differed only where the near-copy was wrong (see `reason` below and the four
 * field gates further down). Delegating in the other direction, which the row
 * proposed, would have imported those four.
 *
 * Last-writer-wins over BOTH objects is the base, and the rules below are the
 * only departures from it.
 *
 * This used to rebuild the object from a hand-written seven-field list, which
 * made the merge lossy the moment two hooks matched one event — and
 * `mergeExecutionResults` nests FOUR sources (native + user-global + project +
 * plugin) on every event, so an untouched pass-through only ever happened while
 * exactly one source produced a decision. With one hook everything worked; with
 * two — an imported plugin bundle plus a user-global hook, the ordinary case —
 * the fields absent from that list vanished with no error. Measured on the
 * pre-fix code: two `WorktreeCreate` hooks each returning a path merged to `{}`
 * (both paths lost, so the worktree gets no path at all), and an
 * `McpElicitation` hook's `accept` + form values merged with a second hook's
 * `additionalContext` lost the accept. Spreading also means a field added to
 * `PreToolUseDecision` survives without editing this function again.
 */
export function mergePreToolUseDecisionObjects(
  current: PreToolUseDecision | undefined,
  next: PreToolUseDecision | undefined,
): PreToolUseDecision | undefined {
  if (!next) return current;
  if (!current) return next;

  // Equal rank means the later hook wins; a strictly higher-ranked earlier
  // decision survives. Spelled as one boolean because every field below that
  // belongs to the winning decision has to agree with it.
  const nextWins = preToolUseDecisionRank(next.decision) >= preToolUseDecisionRank(current.decision);
  const decision = nextWins ? next.decision ?? current.decision : current.decision;
  const updatedInput = next.updatedInput ?? current.updatedInput;
  const updatedToolOutput = next.updatedToolOutput ?? current.updatedToolOutput;
  const additionalContext = [current.additionalContext, next.additionalContext]
    .filter((part): part is string => Boolean(part))
    .join('\n\n') || undefined;
  // P7.14 · JOINED like `additionalContext` and unlike every last-writer-wins
  // field beside it, because the vendor combines rather than replaces:
  // `hooks.md#annotate-a-result-for-the-auto-mode-classifier` — *"The cap is
  // shared across every hook that responds to that call"*, and *"When hooks
  // from both groups annotate the same call, the classifier treats the combined
  // note as unverified"*. Under the generic copy below, a second hook's note
  // would silently erase the first hook's assertion.
  const classifierContext = [current.classifierContext, next.classifierContext]
    .filter((part): part is string => Boolean(part))
    .join('\n\n') || undefined;
  // The reason belongs to the decision that won, and both former merges took
  // `next.reason` unconditionally — so a deny that outranked a later `ask`
  // kept the deny and displayed the ASK's sentence. `permissionDecisionReason`
  // is what the page shows to Claude on a deny
  // (`hooks.md#pretooluse-decision-control`: "For `\"deny\"`, shown to
  // Claude"), which makes a mis-attributed reason a wrong denial message, not
  // a cosmetic one.
  const reason = nextWins ? next.reason ?? current.reason : current.reason ?? next.reason;
  // PermissionRequest `interrupt` is deny-only at parse time; it survives the
  // merge only while a deny/block wins (a later allow cannot un-interrupt a
  // deny because deny outranks it, and an interrupt without a deny is noise).
  const interrupt = (current.interrupt || next.interrupt)
    && (decision === 'block' || decision === 'deny');
  // `updatedPermissions` is allow-only: it is dropped once a deny wins.
  const updatedPermissions = decision === 'block' || decision === 'deny'
    ? undefined
    : next.updatedPermissions ?? current.updatedPermissions;

  const merged: PreToolUseDecision = {};
  for (const source of [current, next]) {
    for (const [key, value] of Object.entries(source)) {
      // Skipped rather than assigned: the near-copy left explicit `undefined`
      // keys behind, and spreading one of those would erase the earlier hook's
      // value instead of leaving it alone.
      if (value !== undefined) Object.assign(merged, { [key]: value });
    }
  }
  if (decision) merged.decision = decision; else delete merged.decision;
  if (updatedInput) merged.updatedInput = updatedInput; else delete merged.updatedInput;
  if (updatedToolOutput !== undefined) merged.updatedToolOutput = updatedToolOutput;
  else delete merged.updatedToolOutput;
  if (additionalContext) merged.additionalContext = additionalContext; else delete merged.additionalContext;
  if (classifierContext) merged.classifierContext = classifierContext; else delete merged.classifierContext;
  if (reason) merged.reason = reason; else delete merged.reason;
  if (interrupt) merged.interrupt = true; else delete merged.interrupt;
  if (updatedPermissions) merged.updatedPermissions = updatedPermissions; else delete merged.updatedPermissions;
  // `elicitationContent` is accept-only at parse time (hooks.md §Elicitation: a
  // decline or cancel has no values to send). Keep that true across the merge
  // too, so a decline that wins cannot carry the other hook's form values.
  if (merged.elicitationAction !== 'accept') delete merged.elicitationContent;
  return merged;
}
