/**
 * P6.294 — `/hooks`: the one place that lists the hooks this session will
 * actually run, grouped by the event that triggers them.
 *
 * ## The row, and which half this is
 *
 * *"There is no one place that lists the hooks this session will actually run,
 * with each hook's matcher, type, source file and command"*, `partial` on all
 * three runtimes. W8-n built the DATA half at `0eda1a71a`:
 * `AgentAutomationSystem.describeHookBindings?()` projects every hook that
 * SURVIVED the six locks — not every hook that was registered — with its event,
 * tier, handler type, matcher, `if` rule and a relative source. Nothing
 * consumed it. This module is the consumer.
 *
 * ## Native mechanism, re-confirmed rather than re-derived
 *
 * The row's clause, verbatim: *"claude: `/hooks` is a TUI command in the binary,
 * unreachable from a host-driven session … NONE — vendored SDK 0.3.233 probed,
 * `listHooks` 0 hits. codex: HAS ONE — `hooks/list` publishes
 * `source`/`enabled`/`trustStatus`/`currentHash` per hook … pi: host-owned; the
 * catalog already holds every scope."* So tier 2 of the native-first rule: the
 * host supplies ONE view for all three, and codex's own `hooks/list` stays a
 * cross-check rather than a second, differently-shaped surface a user has to
 * learn twice.
 *
 * ## Why the seam and not a panel
 *
 * The same reason `/mcp` and `/diff` answer there: a panel is unreachable from
 * `-p`, from `apps/cli` and from the headless server, and the answer must not
 * differ by runtime. It is a READ that changes nothing.
 *
 * ## What is withheld, and why that is not a compromise
 *
 * The projection already drops the command string and the absolute path — the
 * controller posture for this row, and the Safe-projection rule everywhere
 * else. The row's `done_means` names "command" among the fields, and this
 * module deliberately does not print one: a hook's command is an executable
 * line an operator may have written with a token in it, and a transcript is
 * copied into bug reports. The handler TYPE plus the relative source answers
 * the question the row exists for — *which hook is this, and where did it come
 * from* — without turning a listing into an exfiltration surface. Stated here
 * rather than left as a silent narrowing.
 *
 * ## Absence is not emptiness
 *
 * Three different states, three different sentences, because collapsing them is
 * how a user concludes their hooks are gone:
 *
 *  - the runtime published no listing at all ({@link HOOKS_UNSUPPORTED_LINE}) —
 *    `describeHookBindings` is OPTIONAL (the user-disabled system publishes an
 *    EMPTY one since F1.222, so a user who turned hooks off reads the next line);
 *  - the listing exists and is empty ({@link HOOKS_NONE_LINE});
 *  - the listing has rows, which is every other case.
 */

import type { HookBindingView } from '../automations/types.ts';
import type { HookRunRecord, HookRunReport } from '../agent/hook-run-report.ts';

/** No listing was published — the session cannot answer, and says so. */
export const HOOKS_UNSUPPORTED_LINE =
  'This session does not publish a hook listing, so nothing can be shown here.';

/** A listing was published and is empty. */
export const HOOKS_NONE_LINE = 'No hooks will run in this session.';

/** The line that states what a listing deliberately does not print. */
export const HOOKS_WITHHELD_LINE =
  'Commands and absolute paths are withheld; each entry names its handler type and its source relative to the scope that owns it.';

/** Every-call matchers have no pattern; this is what stands in for one. */
const EVERY_CALL = 'every call';

/**
 * One entry's line, without the leading indent.
 *
 * Order is the order the question is asked in: WHAT matches, WHAT KIND of
 * handler runs, WHERE it came from. A disabled matcher is marked rather than
 * hidden — the author kept it deliberately, and a listing that silently omits
 * it cannot answer "why is my hook not firing". An INERT action (UA12.33: a
 * `script` action on an agent event never runs) is marked for the same reason —
 * a bare `command` row would promise a hook this session will never run.
 */
export function formatHookBindingLine(binding: HookBindingView): string {
  const parts: string[] = [binding.matcher ?? EVERY_CALL];
  if (binding.ifRule) parts.push(`if ${binding.ifRule}`);
  parts.push(binding.handlerType);
  parts.push(binding.tier);
  if (binding.name) parts.push(binding.name);
  if (binding.source) parts.push(binding.source);
  if (!binding.enabled) parts.push('disabled');
  if (binding.inert) parts.push('inert (never runs on this event)');
  return parts.join(' · ');
}

/**
 * Group by event, preserving the order the events first appear in the listing.
 *
 * Not sorted alphabetically: the projection orders by tier within an event and
 * the events themselves arrive in the system's own registration order, which is
 * closer to "the order things happen in a turn" than the alphabet is. Sorting
 * here would throw that away and buy nothing a reader wants.
 */
export function groupHookBindingsByEvent(
  bindings: readonly HookBindingView[],
): readonly (readonly [string, readonly HookBindingView[]])[] {
  const grouped = new Map<string, HookBindingView[]>();
  for (const binding of bindings) {
    const bucket = grouped.get(binding.event);
    if (bucket) bucket.push(binding);
    else grouped.set(binding.event, [binding]);
  }
  return [...grouped.entries()];
}

/**
 * The whole `/hooks` answer.
 *
 * `undefined` means the session published no listing — the OPTIONAL half of
 * `describeHookBindings` — and is a different statement from an empty array.
 */
export function formatHookBindingsReport(
  bindings: readonly HookBindingView[] | undefined,
): string {
  if (!bindings) return HOOKS_UNSUPPORTED_LINE;
  if (bindings.length === 0) return HOOKS_NONE_LINE;

  const groups = groupHookBindingsByEvent(bindings);
  const total = bindings.length;
  const lines: string[] = [
    `Hooks that will run in this session (${total === 1 ? '1 hook' : `${total} hooks`}, ${groups.length === 1 ? '1 event' : `${groups.length} events`}):`,
  ];
  for (const [event, entries] of groups) {
    lines.push('', `${event}:`);
    for (const entry of entries) lines.push(`  ${formatHookBindingLine(entry)}`);
  }
  lines.push('', HOOKS_WITHHELD_LINE);
  return lines.join('\n');
}

/**
 * P6.643 - what this session's hooks actually DID, beside what they will do.
 *
 * P6.294 built the bindings half above: `/hooks` lists every hook that survived
 * the six locks. It could not answer the question a user asks the moment a hook
 * misbehaves - *did it run, and what happened* - because nothing stored a run.
 * `HookRunStore` (`agent/hook-run-report.ts`) is that store and `reportHookRun`
 * is its formatter, so a run reads here exactly as it reads in the transcript.
 *
 * ## What a line prints, and the one thing it does not
 *
 * Outcome and text, which is the row's `done_means`. The text is
 * {@link HookRunReport.detail} - the capped join of stderr and stdout - and NOT
 * {@link HookRunReport.message}: the message is the transcript's sentence and
 * already names the hook, which this listing has just printed as its own
 * heading. A successful run has no message at all by `hooks.md#exit-code-0`'s
 * rule, and its detail is exactly what that rule sends to the debug log - which
 * is what this view is. So this is the one surface where a quiet success is
 * legible, and that is the point of it.
 *
 * The command string stays withheld, for {@link HOOKS_WITHHELD_LINE}'s reason:
 * a transcript is copied into bug reports.
 */
export function formatHookRunGroupLine(group: HookRunGroupView): string {
  const runs = [...group.runs].reverse()
  const head = `${group.label} (${group.event}) - ${runs.length} run${runs.length === 1 ? '' : 's'}`
  const lines = runs.map(run => {
    const detail = run.report.detail ? `: ${run.report.detail}` : ''
    return `    ${run.outcome}${detail}`
  })
  return [`  ${head}`, ...lines].join('\n')
}

/** A hook's window, as {@link HookRunStore.groups} publishes it. */
export interface HookRunGroupView {
  readonly key: string
  readonly event: string
  readonly label: string
  readonly runs: readonly HookRunRecord[]
}

/** Nothing has run yet in this session - not the same as "no hooks are configured". */
export const HOOK_RUNS_NONE_LINE = 'No hook has run in this session yet.';

/** The heading the run listing sits under. */
export const HOOK_RUNS_HEADING = 'Hook runs in this session (most recent hook first, newest run first):';

/**
 * The run half of `/hooks`. Returns `undefined` when there is nothing to add, so
 * the caller appends nothing rather than a heading over an empty list.
 *
 * The bound is announced whenever a hook's window is full: a listing that
 * silently showed five of forty runs would let a reader conclude a hook fired
 * five times.
 */
export function formatHookRunHistoryReport(
  groups: readonly HookRunGroupView[],
  maxPerHook: number,
): string {
  if (groups.length === 0) return HOOK_RUNS_NONE_LINE;
  const capped = groups.some(group => group.runs.length >= maxPerHook);
  return [
    HOOK_RUNS_HEADING,
    ...groups.map(formatHookRunGroupLine),
    ...(capped ? [`Only the last ${maxPerHook} runs of each hook are kept.`] : []),
  ].join('\n');
}
