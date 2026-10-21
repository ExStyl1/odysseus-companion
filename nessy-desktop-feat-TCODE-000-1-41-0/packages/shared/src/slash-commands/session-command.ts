/**
 * The ONE place that decides "this text is an instruction to the SESSION, not a
 * prompt".
 *
 * {@link ParsedSessionCommand} IS the list of them, and this paragraph used to
 * re-spell part of it: ten names beside a union of twenty (read 2026-09-17,
 * D1.249). None is a prompt — each tells the session to do something to itself, and the model must never see it. Every layer that needs that answer asks THIS function — the send path
 * (`BaseAgent.chat`, which must not wrap a command in per-turn context, and
 * which executes `/clear` itself), the host guard
 * (`SessionManager.sendMessage`, which refuses to turn `/btw`/`/recap` into a
 * model turn), the backend that executes it (`PiAgent.chatImpl`), and the
 * model-facing `SlashCommand` tool (`PiAgent.dispatchSlashCommand`, which
 * passes a BARE command and keeps rejecting everything but `/compact`/`/help`).
 *
 * It exists because each of those layers used to carry its own anchored regex.
 * `BaseAgent.chat` composes the pinned capability block onto the front of every
 * turn — and that block is never empty while a capability runtime is active,
 * which is every normal send — so the backend's `^\/compact` and
 * `parseSubtaskCommand` never saw the leading slash and BOTH commands reached
 * the model as prose. A second parser somewhere else would only move the seam;
 * the next command added would break the same way.
 */
import { parseBtwCommand } from './btw.ts';
import { parseSubtaskCommand } from './subtask.ts';

/** `/compact [instructions]` — compact the active session context. */
export interface ParsedCompactCommand {
  kind: 'compact';
  /** Present only when the user supplied instructions after the command. */
  customInstructions?: string;
}

/** `/subtask <task>` — fork this conversation (`sub-agents.md:1013`). */
export interface ParsedSubtaskSessionCommand {
  kind: 'subtask';
  /** Empty when the user typed the bare command; the caller reports usage. */
  task: string;
}

/**
 * `/clear` — reset the conversation to an empty context
 * (`agent-sdk/slash-commands.md:212`). Whole-message, no argument: `/clear`
 * takes nothing, so `/clear please` is prose and belongs to the model.
 * Executed at the `BaseAgent.chat` seam, never dispatched to a backend.
 */
export interface ParsedClearCommand {
  kind: 'clear';
}

/**
 * `/btw <question>` — side question answered out-of-band, never a model turn
 * (`interactive-mode.md:359-365`). Empty `question` is the documented bare-form
 * REOPEN (`:374`), not a usage error; the renderer owns reopen behaviour.
 */
export interface ParsedBtwSessionCommand {
  kind: 'btw';
  question: string;
}

/**
 * `/recap` — one-line on-demand session summary (`interactive-mode.md:398-404`).
 * Whole-message, no argument; answered out-of-band like `/btw`.
 */
export interface ParsedRecapSessionCommand {
  kind: 'recap';
}

/**
 * `/heapdump` — write a heap snapshot and memory breakdown to `~/Desktop`
 * (troubleshooting.md:39). Whole-message, no argument, like `/clear`:
 * `/heapdump now` is prose and belongs to the model. Deliberately NOT in the
 * slash-command menu — the doc says the command "doesn't appear in the command
 * menu; type it in full" — so this classifier is its only typed entry point.
 */
export interface ParsedHeapdumpCommand {
  kind: 'heapdump';
}

/**
 * `/quota` — report the account's remaining usage budget. Whole-message, no
 * argument, like `/clear`: `/quota now` is prose and belongs to the model.
 * Answered at the `BaseAgent.chat` seam by `describeQuota()`, so it is never a
 * model turn on ANY runtime; only the runtime that has a quota endpoint behind
 * it overrides the base "not available here" answer.
 */
export interface ParsedQuotaCommand {
  kind: 'quota';
}

/**
 * `/advisor [on|off]` — report or set whether the model may consult the advisor
 * (P2.1). `advisor.md` names `/advisor` as the interactive switch, and the bare
 * form reports rather than toggling: a blind toggle makes the command's effect
 * depend on state the user cannot see from the composer.
 *
 * TWO DELIBERATE DEVIATIONS from the upstream contract, named here because the
 * line above reads like parity and is not (P2.278):
 *  - `advisor.md#use-the-/advisor-command`: "Run `/advisor` without arguments to
 *    open a picker listing the available advisor models, or pass the model
 *    directly:". A composer has no picker, so our bare form REPORTS instead.
 *  - Upstream has no `/advisor on`: it enables by naming a model (the picker,
 *    `advisorModel`, or `--advisor`). We carry a separate `advisorEnabled`
 *    switch, so `on` is ours and `off` is `advisor.md#turn-the-advisor-off`
 *    minus its "clear your saved `advisorModel`" half — see the arm.
 *
 * Answered at the `BaseAgent.chat` seam like `/clear` and `/quota`, so one arm
 * covers every runtime and the model never sees it. That arm was MISSING until
 * P2.278 — this sentence described it for a release in which it did not exist,
 * and all three forms went to the model as prose. Anything after `on`/`off`
 * is prose and belongs to the model — `/advisor use opus` is a request, not
 * this command; the model is chosen with the `advisorModel` setting.
 */
export interface ParsedAdvisorCommand {
  kind: 'advisor';
  action: 'status' | 'on' | 'off';
}

/**
 * `/approve` — the user overrules a guardian auto-review DENIAL (P3.2/P3.25).
 * Whole-message, no argument, like `/clear`: `/approve this` is prose and
 * belongs to the model, because this command takes no target — it applies to the
 * denial the session is already holding.
 *
 * Answered at the `BaseAgent.chat` seam like `/quota` and `/advisor`, so ONE arm
 * covers every runtime and the model never sees the command on any of them.
 * Before this entry existed, `parseSessionCommand('/approve')` returned `null`
 * and the composed turn — capability block and all — went to the model, which
 * was asked to approve something on the user's behalf.
 */
export interface ParsedApproveCommand {
  kind: 'approve';
}

/**
 * `/help` — list the product's OWN commands (P3.158). Whole-message, no
 * argument, like `/clear`: `/help compact` is a question about compaction and
 * belongs to the model.
 *
 * Answered at the `BaseAgent.chat` seam from `help.ts`'s table, so ONE arm
 * covers every runtime — the owner's decision of 2026-09-02, "implement /help
 * host-side once, from our own command table, with per-runtime unavailability
 * marks".
 *
 * Until this kind existed the classifier returned `null` for `/help` and the
 * composed turn — capability block and all — went to the MODEL, on all four
 * runtimes. That is worse than it sounds on a fork of Claude Code: the model
 * answers from its training and describes a DIFFERENT product's commands, so
 * the failure is a confident wrong answer rather than a blank one.
 *
 * NOT the shape `/rewind` took. `/rewind` deliberately stays out of this union
 * because it is answered entirely in the renderer and reaches no backend; a
 * `help` that stayed out would keep reaching the model from every non-composer
 * sender, and would also lose `SessionManager.sendMessage`'s `isSessionCommand`
 * suppression — which is what stops the shell-context prefix and the
 * interruption reminder being composed onto the front of the command, exactly
 * the composition that broke `/compact` and `/subtask` before the seam existed.
 */
export interface ParsedHelpCommand {
  kind: 'help';
}

/**
 * P6.830 — the four SEAM READS, merged into this union.
 *
 * `/mcp`, `/diff`, `/hooks` and `/status` all answer at the `BaseAgent.chat`
 * seam and are all whole-message reads that take no argument, exactly like
 * `/help` above. They lived in a parallel `parseSeamReadCommand` for one
 * reason, stated at the time and now expired: extending this union requires an
 * arm in `PiAgent`'s dispatcher, which narrows BY ELIMINATION down to
 * `ParsedSubtaskSessionCommand`, and `pi-agent.ts` was held by another lane in
 * the hour the first two landed — so widening the union would have left
 * `packages/shared` failing to compile for every concurrent lane.
 *
 * Merging them is what the old function's own docblock prescribed, and it buys
 * two things beyond one parser: the exhaustiveness guard now covers them (a
 * fifth seam read cannot be added without claiming it in `PiAgent`), and they
 * inherit the ATTACHMENT REFUSAL every other session command already gets —
 * before this, `/mcp` with a file attached answered the command and dropped the
 * file without a word.
 */
export interface ParsedMcpCommand { kind: 'mcp'; }
/** @see ParsedMcpCommand */
export interface ParsedDiffCommand { kind: 'diff'; }
/** @see ParsedMcpCommand */
export interface ParsedHooksCommand { kind: 'hooks'; }
/** @see ParsedMcpCommand */
export interface ParsedStatusCommand { kind: 'status'; }

/**
 * The four as one type, for a reader that wants to name them together.
 *
 * FOUR interfaces rather than one with `kind: SeamReadCommandKind`, and the
 * difference is not stylistic: TypeScript narrows a discriminated union by
 * REMOVING a constituent only when that constituent's discriminant is a unit
 * type. With one interface carrying all four literals, `PiAgent`'s elimination
 * left `ParsedSeamReadCommand` in the union with its `kind` narrowed to `never`
 * — the exhaustiveness guard failed on `command.task` even with all four arms
 * claimed. Measured while landing P6.830.
 */
export type ParsedSeamReadCommand =
  | ParsedMcpCommand
  | ParsedDiffCommand
  | ParsedHooksCommand
  | ParsedStatusCommand;

/**
 * `/config` — read or change a setting from the prompt (P6.410).
 *
 * Three forms, and the whole message must be one of them: bare (list), `<key>`
 * (read one), `<key>=<value>` (write one). `/config the memory setting` is prose
 * and belongs to the model, exactly as `/help compact` does.
 *
 * Answered at the `BaseAgent.chat` seam like `/help`, `/quota` and `/advisor`, so
 * ONE arm covers every runtime and the model never sees it — which is also what
 * makes the row's "behaves identically on all three runtimes" true by
 * construction rather than by three parallel implementations.
 *
 * The reachable keys and the reason they are an ALLOWLIST live in
 * `slash-commands/config-command.ts`; this classifier deliberately does not
 * validate the key, so an unknown one is answered by the command with the list
 * rather than falling through to the model as prose.
 */
export interface ParsedConfigCommand {
  kind: 'config';
  key?: string;
  value?: string;
}

/**
 * `/resume [session-id]` — continue the runtime session `/clear` set aside
 * (P6.106).
 *
 * `/clear` empties the conversation and the previous one "remains on disk"
 * (`agent-sdk/slash-commands.md` §/clear), and the rewind menu documents
 * `/resume <session-id> (previous session)` as the way back to it. Until this
 * kind existed there was no `resume` row in this classifier at all, so the
 * documented command reached the MODEL as prose on every runtime.
 *
 * The id is OPTIONAL, and the bare form is the useful one: a session has
 * exactly one set-aside runtime session — the one it just cleared — so there is
 * nothing to disambiguate. A supplied id is honoured only when it names that
 * session, and the arm says which id it does hold otherwise. Accepting an
 * arbitrary id would let a typo start an empty conversation that LOOKS resumed,
 * which is the failure this command exists to end.
 *
 * Answered at the `BaseAgent.chat` seam like `/clear`, so one arm covers every
 * runtime; the anchor it restores is per-backend and the three that publish one
 * override {@link BaseAgent.runtimeSessionAnchor}.
 */
export interface ParsedResumeCommand {
  kind: 'resume';
  /** Absent for the bare form, which resumes the session `/clear` set aside. */
  sessionId?: string;
}

/**
 * `/cd <path>` — move this session's working directory (P6.509).
 *
 * ## What this command is, and what it deliberately is NOT
 *
 * The MOVE already existed and is already gated: `SessionManager`'s
 * `mutateWorkingDirectory` runs the whole transaction (drain, runtime commit or
 * rollback, project rebind) and `assertCdRulesPermit` refuses it against the
 * compiled `Cd` rules, naming the rule and the scope. What was missing was only
 * the COMMAND — the two existing surfaces are the folder picker and the
 * `updateWorkingDirectory` RPC, neither of which a `-p` session, the CLI or a
 * headless server can reach.
 *
 * `permissions.md` § Cd: "`Cd` is not a model-invocable tool: Claude can't call
 * it, and the rules apply only when you run `/cd` yourself" — so this arm is
 * the *only* place in the product where those rules were ever meant to apply,
 * and until it existed they compiled for a control nobody could reach.
 *
 * ## Owner decision B-prime (2026-09-07), and why the sentence it replaced was false
 *
 * The delegated option B was "move the working directory only, re-resolve
 * NOTHING, and say so in the result". W8-j measured that this product does not
 * behave that way: every successful move already calls `invalidateSkillsCache()`
 * and `capabilityResolver.invalidate(..., 'session-project-changed',
 * 'revoke-active-snapshot')`, so B's result line would have been false the
 * moment it was printed, and implementing B literally would have meant DELETING
 * an existing invalidation — moving a session into a directory whose skills and
 * capability snapshot are stale. The owner confirmed **B-prime**: the command
 * rides `mutateWorkingDirectory` AS IT IS, and the result line says what WAS
 * re-resolved and what was not. The wording lives at the executor, beside the
 * code that decides it.
 *
 * ## The argument is the rest of the line, verbatim
 *
 * Unlike `/config` and `/resume`, whose arguments are `[\w.-]+` so a sentence
 * starting with the command reaches the model as prose, a directory may contain
 * spaces. So `/cd` takes everything after it. The cost is stated rather than
 * hidden: `/cd to the other project` is answered "that is not a usable
 * directory" instead of reaching the model. That is the better failure — the
 * user asked for a move, and a validation answer says so, while the model would
 * have been asked to perform a host operation it cannot perform.
 *
 * Executed by `SessionManager.sendMessage` BEFORE the turn boundary is claimed,
 * not at the `BaseAgent.chat` seam: the seam has no working-directory
 * transaction to run, and `mutateWorkingDirectory` takes the very mutation
 * boundary a started turn holds. The seam and `PiAgent.runSessionCommand` carry
 * backstop arms for a direct caller, exactly as `/config` and `/resume` do.
 */
export interface ParsedCdCommand {
  kind: 'cd';
  /** Empty when the user typed the bare command; the executor reports usage. */
  path: string;
}

/**
 * `/branch` — fork this conversation from its LAST turn into a new session
 * (P6.881).
 *
 * ## Why the command takes no argument
 *
 * The affordance already exists on every turn: the branch button on a message
 * forks in place and switches the user in. What has never had a name is the one
 * a person types, and the composer sits at the END of the conversation — so a
 * `/branch` typed there means "branch from where I am". That is a reading of
 * where the command is entered, not a new product rule; branching from an
 * EARLIER turn stays the button's job, because only the transcript can say which
 * turn is meant.
 *
 * ## Executed by `SessionManager.sendMessage`, before the turn boundary
 *
 * Exactly `/cd`'s placement and for the same reason: a branch creates a SESSION,
 * which is a host object no runtime has a turn-level mechanism for, and doing it
 * after the boundary is claimed would run the mutation against a turn that
 * exists only to carry the command. One arm serves all four backends, so it
 * works in `-p`, in `apps/cli` and in the headless server too. The
 * `BaseAgent.chat` seam and `PiAgent.runSessionCommand` carry backstop arms for
 * a direct caller, exactly as `/cd`, `/config` and `/resume` do.
 */
export interface ParsedBranchCommand {
  kind: 'branch';
}

/**
 * `/tasks` — list the background work this session is holding (D1.14).
 *
 * ## The command existed on paper and nowhere else
 *
 * `commands.md` documents it — *"View and manage background work in the current
 * session, including subagents that have finished. Also available as
 * `/bashes`"* — and this product had no parser row of that name on ANY runtime.
 * Measured on the packaged 1.39.0 (`RS-46`, `docs/testing/cdp-runs/2026-09-17-measure-sitting-1.md`):
 * the palette carries no row named `tasks`, and the typed token reached the
 * MODEL, which answered with a tool call. So this is an absence rather than the
 * advertised-then-refused shape — a build starts from nothing, not from a broken
 * menu row.
 *
 * ## Whole message, no argument
 *
 * `/help`'s rule exactly: `/tasks now` is prose and belongs to the model, and
 * that sentence is also the control `RS-46` drives — a parser row that swallowed
 * it would have eaten every question about background work.
 *
 * ## Executed by `SessionManager.sendMessage`, and the placement is the answer
 *
 * NOT at the `BaseAgent.chat` seam, where `/mcp`, `/diff`, `/hooks` and
 * `/status` answer, and the reason is measured rather than stylistic. A seam
 * answer is a bare `yield { type: 'info' }`: it reaches the screen and it does
 * NOT reach `getSessionMessages` — `RS-46` scored `/help` as producing no
 * non-user row at all while the listing was plainly on screen (D1.209). The
 * owner asked for this one to be visible in the TRANSCRIPT, so it is recorded
 * through `SessionManager`'s durable info channel, which appends, mirrors and
 * persists — `/cd`'s and `/branch`'s placement, for a reason of its own.
 *
 * The inventory is the same projection the `background_tasks` hook payload
 * reports, so a hook that listed the work and a user who asked for it are
 * looking at one list. That includes WATCHES: the monitor service files its
 * entries under the documented `monitor` type (D1.98), so they need no second
 * spelling here.
 */
export interface ParsedTasksCommand {
  kind: 'tasks';
}

/**
 * `/workflows` — the running work, and `/workflows stop` — the all-stop
 * (D1.14 + D1.37, re-spelled by D1.247).
 *
 * ## TWO FORMS, and this is what CLOSES the divergence the first spelling had
 *
 * `commands.md`, verbatim: *"Open the [workflow](/docs/en/workflows#watch-the-run)
 * progress view to watch, pause, resume, or save running and completed
 * workflows"*. The first build of this row gave the bare token to the ALL-STOP
 * (the owner's decision of 2026-09-17 on D1.14 and D1.37), which meant a user
 * who typed the documented name got the documented name's opposite — a
 * same-named command that does something else, the divergence class this fork
 * keeps closing, recorded as such at the time and reconsidered as D1.247.
 *
 * So the bare token READS and the verb STOPS. Both forms exist, the documented
 * one does the documented kind of thing, and the owner's gesture keeps a
 * spelling of its own. `'list'` is the default because that is the direction a
 * mistake is cheap in: a user who meant to stop and read a listing presses
 * again; a user who meant to read and stopped ten running items cannot undo it.
 *
 * ## What the bare form lists, and why it is not `/tasks` twice
 *
 * The RUNNING half only — exactly the population
 * `SessionManager.stopAllBackgroundWork` acts on (`projectBackgroundTasks(…)`
 * filtered to `status === 'running'`), through the same shared projection and
 * the same formatter. `/tasks` is the whole inventory including the cron
 * records that will fire later and the subagents that have already finished;
 * this is the progress view of what is running NOW, which is also the list the
 * stop form empties. Upstream draws the same distinction between its own
 * `/tasks` (*"View and manage background work in the current session"*) and
 * this command.
 *
 * ## Whole message, ONE optional word, executed by `SessionManager.sendMessage`
 *
 * Otherwise exactly {@link ParsedTasksCommand}: `/workflows for the release` is
 * prose and belongs to the model, and both forms run over host state before any
 * turn exists, so one arm serves all four backends and it works in `-p`, in
 * `apps/cli` and in the headless server.
 */
export interface ParsedWorkflowsCommand {
  kind: 'workflows';
  /**
   * `'stop'` only for the explicit `/workflows stop`. A FIELD rather than a
   * second kind, so the three arms that narrow on `kind` — `BaseAgent.chat`'s
   * backstop, `PiAgent.runSessionCommand`'s mandatory arm and the dispatch —
   * keep working unchanged and only the one that acts reads it.
   */
  action: 'list' | 'stop';
}

export type ParsedSessionCommand =
  | ParsedBranchCommand
  | ParsedCompactCommand
  | ParsedSubtaskSessionCommand
  | ParsedClearCommand
  | ParsedBtwSessionCommand
  | ParsedRecapSessionCommand
  | ParsedHeapdumpCommand
  | ParsedQuotaCommand
  | ParsedAdvisorCommand
  | ParsedApproveCommand
  | ParsedHelpCommand
  | ParsedConfigCommand
  | ParsedResumeCommand
  | ParsedCdCommand
  | ParsedTasksCommand
  | ParsedWorkflowsCommand
  | ParsedSeamReadCommand;

const COMPACT_PATTERN = /^\/compact(?:\s+([\s\S]+))?$/i;
const CLEAR_PATTERN = /^\/clear$/i;
const RECAP_PATTERN = /^\/recap$/i;
const HEAPDUMP_PATTERN = /^\/heapdump$/i;
const QUOTA_PATTERN = /^\/quota$/i;
const ADVISOR_PATTERN = /^\/advisor(?:\s+(on|off))?$/i;
const APPROVE_PATTERN = /^\/approve$/i;
// Whole message only and no argument: `/branch off this idea` is prose and
// belongs to the model. See {@link ParsedBranchCommand} for why the command
// takes nothing.
const BRANCH_PATTERN = /^\/branch$/i;
// D1.14 — whole message only, on `/help`'s rule: `/tasks now` and `/workflows
// for the release` are prose and belong to the model. `/tasks now` is the
// control `RS-46` drove on the packaged build, so the negative is a measured
// sentence rather than an invented one. See {@link ParsedTasksCommand} and
// {@link ParsedWorkflowsCommand} — the second carries a stated divergence from
// the upstream page and should be read before it is re-spelled.
const TASKS_PATTERN = /^\/tasks$/i;
// D1.247 — ONE optional word, and only the literal `stop`: `/workflows please
// stop` stays prose for the reason above. The capture is what selects the
// action, so the bare token cannot reach the aggregate by accident.
const WORKFLOWS_PATTERN = /^\/workflows(?:\s+(stop))?$/i;
const HELP_PATTERN = /^\/help$/i;
// Whole message only, for `/help`'s reason: `/mcp add a server` and `/diff the
// last turn` are prose and belong to the model. See {@link ParsedSeamReadCommand}.
const SEAM_READ_PATTERNS: readonly (readonly [SeamReadCommandKind, RegExp])[] = [
  ['mcp', /^\/mcp$/i],
  ['diff', /^\/diff$/i],
  ['hooks', /^\/hooks$/i],
  ['status', /^\/status$/i],
];
// `/config`, `/config key`, `/config key=value`. The key is `[\w.-]+` so a
// sentence starting with `/config the` is prose and reaches the model, and the
// value takes the rest of the line verbatim (an output-style id may contain a
// space).
const CONFIG_PATTERN = /^\/config(?:\s+([\w.-]+)(?:\s*=\s*([\s\S]*))?)?$/i;
// `/resume`, `/resume <id>`. The id is `[\w.-]+` — every runtime session id in
// this product is a uuid or a `thread_`/`msg_`-style token — so a sentence
// beginning `/resume the conversation` is prose and reaches the model.
const RESUME_PATTERN = /^\/resume(?:\s+([\w.-]+))?$/i;
// `/cd`, `/cd <path>`. The argument is the REST OF THE LINE and not `[\w.-]+`
// like `/config`'s and `/resume`'s, because a directory may contain spaces; see
// {@link ParsedCdCommand} for what that costs and why it is the better failure.
const CD_PATTERN = /^\/cd(?:\s+([\s\S]+))?$/i;

/**
 * Returns the parsed command when `input` IS a session command, `null`
 * otherwise. The whole message must be the command: a mention of `/compact`
 * inside a sentence is prose and belongs to the model.
 */
export function parseSessionCommand(input: string): ParsedSessionCommand | null {
  const trimmed = input.trim();

  const compact = trimmed.match(COMPACT_PATTERN);
  if (compact) {
    const customInstructions = compact[1]?.trim();
    return customInstructions ? { kind: 'compact', customInstructions } : { kind: 'compact' };
  }

  const subtask = parseSubtaskCommand(trimmed);
  if (subtask) return { kind: 'subtask', task: subtask.task };

  if (CLEAR_PATTERN.test(trimmed)) return { kind: 'clear' };

  const btw = parseBtwCommand(trimmed);
  if (btw) return { kind: 'btw', question: btw.question };

  if (RECAP_PATTERN.test(trimmed)) return { kind: 'recap' };

  if (HEAPDUMP_PATTERN.test(trimmed)) return { kind: 'heapdump' };

  if (QUOTA_PATTERN.test(trimmed)) return { kind: 'quota' };

  if (APPROVE_PATTERN.test(trimmed)) return { kind: 'approve' };

  if (BRANCH_PATTERN.test(trimmed)) return { kind: 'branch' };

  if (TASKS_PATTERN.test(trimmed)) return { kind: 'tasks' };

  const workflows = WORKFLOWS_PATTERN.exec(trimmed);
  if (workflows) return { kind: 'workflows', action: workflows[1] ? 'stop' : 'list' };

  if (HELP_PATTERN.test(trimmed)) return { kind: 'help' };

  // P6.830 — the four seam reads, walked from the SAME table their patterns are
  // declared in. Beside `/help` because they share its rule exactly: the whole
  // message must be the command, so `/mcp add a server` and `/diff the last
  // turn` are prose and belong to the model.
  for (const [kind, pattern] of SEAM_READ_PATTERNS) {
    if (pattern.test(trimmed)) return { kind };
  }

  const config = trimmed.match(CONFIG_PATTERN);
  if (config) {
    const key = config[1];
    const value = config[2];
    return {
      kind: 'config',
      ...(key ? { key } : {}),
      ...(value !== undefined ? { value: value.trim() } : {}),
    };
  }

  const resume = trimmed.match(RESUME_PATTERN);
  if (resume) {
    const sessionId = resume[1];
    return sessionId ? { kind: 'resume', sessionId } : { kind: 'resume' };
  }

  const cd = trimmed.match(CD_PATTERN);
  if (cd) return { kind: 'cd', path: cd[1]?.trim() ?? '' };

  const advisor = trimmed.match(ADVISOR_PATTERN);
  if (advisor) {
    const argument = advisor[1]?.toLowerCase();
    return { kind: 'advisor', action: argument === 'on' ? 'on' : argument === 'off' ? 'off' : 'status' };
  }

  return null;
}

/**
 * The host-answered READ commands that are classified beside
 * {@link parseSessionCommand} rather than inside it.
 *
 * - `mcp` — this session's MCP servers, their connection state and their tool
 *   counts (P6.352). Reads whatever source THIS runtime has:
 *   `Query.mcpServerStatus()` on claude, `mcpServerStatus/list` on codex, the
 *   host pool on Pi and on anything else that leases one.
 * - `diff` — what has changed in the working tree, plus the honest statement
 *   about a turn's own edits (P6.278). Uniform by construction: it is `git`,
 *   not a runtime.
 *
 * Both are answered at the `BaseAgent.chat` seam like `/help` and `/config`, so
 * they work in non-interactive `-p` mode — the clause of both rows' `done_means`
 * that a panel can never satisfy — and both are READS that change nothing.
 *
 * ## They ARE members of {@link ParsedSessionCommand} now (P6.830)
 *
 * They were not, for one stated reason: that union carries a DELIBERATE
 * exhaustiveness guard in `PiAgent.runSessionCommand` — after eliminating every
 * non-`subtask` kind it reads `command.task`, so a kind added without an arm
 * there fails the compiler — and `pi-agent.ts` was held by another lane in the
 * hour the first two landed, so widening the union would have left
 * `packages/shared` failing to compile for every concurrent lane.
 *
 * That reason expired, and this section used to end with the recipe: *"add
 * `{ kind: 'mcp' }`, `{ kind: 'diff' }` and `{ kind: 'hooks' }` to the union,
 * return them from `parseSessionCommand` by walking this same table beside the
 * `/help` branch, and delete this function together with its call in
 * `BaseAgent.chat`."* That is exactly what happened, plus `/status` and the four
 * `PiAgent` arms. Two things came with it that the recipe did not name: the
 * exhaustiveness guard now covers these four, so a fifth seam read cannot be
 * added without claiming it; and they inherit the attachment refusal every other
 * session command already had, so `/mcp` with a file attached now REFUSES and
 * names the reason instead of answering and dropping the file
 *
 * P6.294 added the third, `/hooks`, on the same terms: a read of what the
 * session will run, answered at the seam so it works in `-p` and reads the same
 * on all three runtimes.
 *
 * P6.447 added the fourth, `/status`: which base URL, credential source,
 * provider and proxy this session is actually using. It belongs here rather than
 * in the union for exactly the reasons above, and it belongs at the SEAM for one
 * more of its own — claude's `/status` is a TUI command inside the closed binary
 * and unreachable from an SDK-hosted session, and codex publishes no equivalent,
 * so a panel would answer for one runtime and leave `-p` with nothing. Its
 * producer is `describeConnectionProvenance` (`agent/diagnostics.ts`), the same
 * function the settings page's connection pane reads, so the two surfaces cannot
 * word the answer differently.
 */
export type SeamReadCommandKind = 'mcp' | 'diff' | 'hooks' | 'status';
