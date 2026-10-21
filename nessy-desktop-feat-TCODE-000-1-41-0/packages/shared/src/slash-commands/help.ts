/**
 * `/help` — the product's own command table, answered by the HOST once.
 *
 * ## Why this module exists (P3.158)
 *
 * `/help` was offered in the composer menu on all four runtimes and implemented
 * by no seam at all: `parseSessionCommand` had no `help` kind, so the text
 * composed an ordinary turn and asked the MODEL. That burns tokens, it can
 * hallucinate, and on a fork of Claude Code the answer describes a product that
 * is not this one — `/nessy-general-agent`'s commands are not Claude Code's, and
 * a model asked "what are your slash commands" answers from its training.
 *
 * The shape of the defect is worth keeping: it is **uniformly weak** rather
 * than divergent, which is why the per-runtime enumeration that found it did
 * not flag it. A check for "do the runtimes disagree" cannot see a gap that is
 * the same everywhere.
 *
 * Owner decision, 2026-09-02: *"Implement `/help` host-side once, from our own
 * command table, with per-runtime unavailability marks."* So: one table here,
 * one arm at the `BaseAgent.chat` seam, and the answer is identical on Pi,
 * claude, codex and the remote agent except for the marks.
 *
 * ## The marks, and what they can and cannot cover
 *
 * A mark is only written where the SEAM can decide it, from the same predicate
 * the seam's own refusal reads — {@link SessionCommandHelpAvailability}. Two
 * commands qualify today: `/subtask` (`BaseAgent.canForkConversation()`) and
 * `/compact` (`BaseAgent.canCompactContext()`), which are exactly the two kinds
 * P2.292 measured as genuinely per-backend.
 *
 * Three more commands ARE per-runtime and cannot be marked from the two
 * predicates above, because the fact lives somewhere the seam cannot read:
 * `resolveComposerCapabilities` withdraws `/quota` off the Nessy gateway
 * connection and `/btw`+`/recap` on the remote agent, and that resolver takes a
 * provider and a connection the agent does not hand to `chat()`. Inventing a
 * second spelling of those predicates here is precisely the divergence this
 * plan keeps removing.
 *
 * P3.298 closes the half that belongs to this module: it now ACCEPTS the
 * already-resolved `ComposerCapabilities.slash.excludedCommandIds`
 * ({@link SessionCommandHelpRuntime.excludedCommandIds}) and marks those rows
 * from it, so menu, dispatch and listing read ONE value. The remaining half is
 * the hand-off — the send-path seam has to be given the field — and until it
 * is, a caller that omits it gets {@link SESSION_COMMAND_HELP_UNTOLD_LINE}
 * rather than a listing that quietly asserts nothing is withdrawn.
 *
 * A fourth source exists on claude alone, and P6.410 closes it: the Agent SDK
 * publishes `SDKSystemMessage.terminal_slash_commands` — the subset of ITS
 * commands bound to a local terminal. It is not a source of marks for OUR rows
 * (none of the names below is ever in it); it is a set of OTHER commands this
 * listing's last line silently invites the user to type. So it arrives as
 * {@link SessionCommandHelpRuntime.runtimeTerminalCommandNames} and is printed
 * as its own line — see {@link SESSION_COMMAND_TERMINAL_ONLY_PREFIX}.
 *
 * ## What that field actually contains (measured in the vendored bundle, not inferred)
 *
 * The SDK's typing states the intent — *"Subset of slash_commands whose UX is
 * bound to the local terminal (e.g. exit, statusline). Phone/remote UIs should
 * hide these from command menus; desktop surfaces may keep them. Present only
 * when non-empty; absent on CLIs that predate the field, and on sessions where
 * no advertised command carries the tag."* — and the bundle states the
 * mechanism. In `claude-agent-sdk-darwin-arm64/claude` at `2.1.233` the `init`
 * producer is, verbatim (the `terminalOriented` tag it reads is still in the
 * vendored `2.1.247`, 8 lines / 15 occurrences, re-measured 2026-09-12; C3.252):
 *
 * ```
 * let n = e.commands.filter((i) => i.userInvocable !== !1 && i.terminalOriented === !0).map((i) => i.name)
 * … ...n.length > 0 && { terminal_slash_commands: n },
 * ```
 *
 * so membership is one per-command flag, `terminalOriented`. Grepping that flag
 * in the same binary returns **13 occurrences, of which five are commands
 * declaring `terminalOriented:!0`**: `color`, `exit` (alias `quit`),
 * `reload-plugins`, `statusline` and `doctor`. Two of them are declared twice —
 * an ink (`local-jsx`) variant and a `local` variant carrying
 * `supportsNonInteractive:!0` — which is why the vendor's advice matters to a
 * desktop at all: `/exit` is not inert on the transport we drive, it is a
 * command whose stated purpose is to end the CLI.
 *
 * The names are NOT hard-coded here. That list is a reading with a date and the
 * bundle is lifted at plan close-out; the field is the fact, and this module
 * prints whatever the session was told.
 *
 * The vendor says *"desktop surfaces may keep them"*, and this listing keeps
 * them — it does not hide or refuse anything. What it refuses is silence: the
 * final line of every listing tells the user that anything else starting with
 * `/` is a project, plugin or MCP command, and without this line those five are
 * exactly the counter-examples to it.
 *
 * ## The OTHER `/help`, which this one does not replace
 *
 * `PiAgent.dispatchSlashCommand` answers a `/help` for the MODEL — the
 * `SlashCommand` tool's own two-line list — and that is a different question
 * with a different correct answer: *what may I, the model, call*, whose answer
 * is the deliberate `/compact` + `/help` allowlist and not this table. The two
 * are not merged, and the model's list must not grow to match this one; the
 * reasons the allowlist is short are written at that site (`/clear` would let
 * the model erase the user's context, `/btw` would hand it a channel the user
 * cannot see). Named here so the next reader finds the relationship instead of
 * a second list that looks like drift.
 *
 * ## Language
 *
 * Plain English literals, no `t()`, for the measured reason the seam's other
 * answers are: the headless `nessy-server` entry never calls `setupI18n()` and
 * an uninitialised `t()` returns `undefined` — an empty info line, which is
 * indistinguishable from a command that did nothing. `/clear`'s arm is the
 * precedent. A localized `/help` needs the guard the advisor and quota arms
 * carry, and it is a separate decision from this one.
 */

export const HELP_COMMAND_NAME = 'help';
export const HELP_COMMAND_LABEL = `/${HELP_COMMAND_NAME}`;

/**
 * Which predicate decides whether a row works on THIS runtime.
 *
 * - `session` — the session answers it on every runtime; nothing to mark.
 * - `fork` — needs `BaseAgent.canForkConversation()`.
 * - `compact` — needs `BaseAgent.canCompactContext()`.
 * - `composer` — the DESKTOP COMPOSER answers it (a panel, an overlay, a menu),
 *   so it never reaches a runtime at all. Typed into a surface that is not the
 *   desktop composer — `apps/cli`, a relayed send, a headless server — a
 *   `composer` row reaches the model as prose, exactly as `/rewind`'s own
 *   module records for itself. That residue is stated in the listing.
 */
export type SessionCommandHelpAvailability = 'session' | 'fork' | 'compact' | 'composer';

export interface SessionCommandHelpEntry {
  /**
   * The composer menu's `SlashCommandId`, or `null` for a command deliberately
   * absent from the menu (`/heapdump` — troubleshooting.md says it "doesn't
   * appear in the command menu; type it in full" — and `/rewind`, which opens a
   * menu of its own). The id is what
   * `apps/electron/.../__tests__/slash-command-help-table.test.ts` diffs this
   * table against, so the listing and the menu cannot drift apart.
   */
  id: string | null;
  /** What the user types, argument placeholder included. */
  label: string;
  /** One line. English by the same rule the module header states. */
  summary: string;
  availability: SessionCommandHelpAvailability;
}

/**
 * THE table. Ordered as a reader wants it — what the session does to itself
 * first, then what the app opens — not alphabetically and not by id.
 */
export const SESSION_COMMAND_HELP_ENTRIES: readonly SessionCommandHelpEntry[] = [
  { id: 'help', label: '/help', summary: 'Show this list of commands.', availability: 'session' },
  { id: 'clear', label: '/clear', summary: 'Clear the conversation; the next prompt starts with empty context.', availability: 'session' },
  { id: 'compact', label: '/compact [instructions]', summary: 'Summarize the context to free token budget.', availability: 'compact' },
  { id: 'subtask', label: '/subtask <task>', summary: 'Fork this conversation into a background agent that inherits it.', availability: 'fork' },
  { id: 'advisor', label: '/advisor [on|off]', summary: 'Show or change whether the model may consult the advisor.', availability: 'session' },
  // P2.217. `/approve` parses and executes at the same seam as `/advisor` and
  // was announced NOWHERE — not here, not in the composer menu — so only a user
  // who already knew it existed could reach it. `session`, like `/advisor`:
  // every runtime answers it, and off codex the answer is the seam's own
  // sentence saying the guardian it overrules is codex's. That per-runtime fact
  // is withdrawn from the MENU through `resolveExcludedCommandIds`, which is
  // the resolver this module deliberately does not re-spell — see the header.
  { id: 'approve', label: '/approve', summary: 'Overrule a Codex auto-review guardian denial.', availability: 'session' },
  { id: 'quota', label: '/quota', summary: 'Report the account\'s remaining usage budget, where the connection reports one.', availability: 'session' },
  // P6.881. `id: null` — no menu row, on `/resume`'s reasoning rather than
  // `/rewind`'s: the transcript's branch button is the RICHER surface (it can
  // branch from any turn, and it switches you in), so a permanent menu row
  // beside it would offer the weaker half of the same affordance. This row is
  // the typed spelling, which is the only one that exists in `-p`, in
  // `apps/cli` and in the headless server.
  //
  // `availability: 'session'` on `/approve`'s precedent: ONE arm in
  // `SessionManager.sendMessage` serves every runtime, and where the runtime
  // cannot branch the answer is that arm's own sentence rather than a mark this
  // module could compute — `supportsBranching` is a per-connection fact neither
  // seam predicate can read.
  { id: null, label: '/branch', summary: 'Branch this conversation from its last turn into a new session; this one is unchanged.', availability: 'session' },
  // D1.14 — `availability: 'session'` on `/branch`'s precedent: ONE arm in
  // `SessionManager.sendMessage` serves every runtime, because the inventory is
  // host state and there is no per-backend mark to make. `id: null` for
  // `/branch`'s reason too — the background-task panel is the RICHER surface,
  // so a permanent menu row beside it would offer the weaker half of the same
  // affordance; the typed spelling exists because it is the only one that
  // reaches `-p`, `apps/cli` and the headless server.
  { id: null, label: '/tasks', summary: 'List the background work this session is running, and what it will run later.', availability: 'session' },
  // D1.14 + D1.37, re-spelled by D1.247 — TWO forms, and the summary carries
  // both because this listing is the ONE place the command is documented. The
  // bare token is upstream's own sense (`commands.md`: "Open the workflow
  // progress view…"); the all-stop the owner asked for on 2026-09-17 keeps a
  // spelling of its own, so neither form surprises the user who typed the other.
  //
  // The LABEL stays the bare token rather than growing a `[stop]` the way
  // `/resume [session-id]` does: the renderer's `TYPED_ONLY_LABELS` pins this
  // exact string, so the two must move in one commit and that file is another
  // lane's this wave. The summary names the argument meanwhile.
  { id: null, label: '/workflows', summary: 'List the background work running in this session right now; `/workflows stop` stops all of it.', availability: 'session' },
  // P6.410. `session`, like `/advisor` and `/approve`: one host arm over the
  // settings store we already own, so all three runtimes answer it identically.
  { id: 'config', label: '/config [key[=value]]', summary: 'Show or change a setting from the prompt.', availability: 'session' },
  // P6.509 — `availability: 'session'` because ONE arm in
  // `SessionManager.sendMessage` serves every runtime: the working directory is
  // a host record, so there is no per-backend mark to make.
  { id: 'cd', label: '/cd <path>', summary: 'Move this session\'s working directory, if the Cd permission rules allow it.', availability: 'session' },
  // P6.352. `session` for `/config`'s reason and one more: the row's own
  // done_means asks for "a text status summary in NON-INTERACTIVE mode", which
  // only a seam arm can give — a panel is unreachable from `-p`, from
  // `apps/cli` and from the headless server.
  { id: 'mcp', label: '/mcp', summary: 'List this session\'s MCP servers with their status and tool counts.', availability: 'session' },
  // P6.278. `session` for the same reason, and the producer is `git` rather than
  // a runtime — so this row is the one place in the table where "identical on
  // all three" is true without any per-runtime work at all.
  { id: 'diff', label: '/diff', summary: 'Summarize the uncommitted changes in this session\'s directory.', availability: 'session' },
  // P6.294. `session` for the same reason again, and one specific to this row:
  // claude's own `/hooks` is a TUI command inside the binary that a host-driven
  // session cannot reach, so a panel here would answer for one runtime and
  // leave `-p` and `apps/cli` with nothing.
  { id: 'hooks', label: '/hooks', summary: 'List the hooks this session will run, grouped by event.', availability: 'session' },
  // P6.447 — `availability: 'session'` like `/mcp`, `/diff` and `/hooks`: the
  // `BaseAgent.chat` seam answers it for every runtime from ONE producer, which
  // is also what makes the row's "identically worded on all three" true.
  { id: 'status', label: '/status', summary: 'Show which endpoint, credential source, provider and proxy this session is using.', availability: 'session' },
  { id: 'usage', label: '/usage', summary: 'Show this session\'s token usage.', availability: 'composer' },
  { id: 'context', label: '/context', summary: 'Show the context-window breakdown.', availability: 'composer' },
  { id: 'model', label: '/model', summary: 'Open model selection.', availability: 'composer' },
  { id: 'agents', label: '/agents', summary: 'Show agent definitions.', availability: 'composer' },
  { id: 'automations', label: '/automations', summary: 'Open automations.', availability: 'composer' },
  { id: 'memory', label: '/memory', summary: 'Open this session\'s MEMORY.md.', availability: 'composer' },
  { id: 'export', label: '/export', summary: 'Export the session transcript.', availability: 'composer' },
  // P6.322 half 2 — `availability: 'composer'` like `/init` and `/create-skill`:
  // it is a PROMPT MACRO the composer expands, not a seam-answered command.
  { id: 'goal', label: '/goal', summary: 'Interview you about the outcome and constraints, then set a session goal with a checkable condition.', availability: 'composer' },
  { id: 'btw', label: '/btw [question]', summary: 'Ask a side question that never enters the conversation history.', availability: 'composer' },
  { id: 'recap', label: '/recap', summary: 'Generate a one-line recap of this session.', availability: 'composer' },
  { id: 'init', label: '/init', summary: 'Draft a starter AGENTS.md for this project.', availability: 'composer' },
  { id: 'create-skill', label: '/create-skill', summary: 'Create a new skill with the skill-creator.', availability: 'composer' },
  { id: 'create-plugin', label: '/create-plugin', summary: 'Create a new plugin with the plugin-creator.', availability: 'composer' },
  // The two with no menu row. Both are real commands a user can type, and a
  // help listing that omitted them would be the only place they are documented
  // failing to document them.
  { id: null, label: '/rewind', summary: 'Open the rewind menu for this session.', availability: 'composer' },
  { id: null, label: '/heapdump', summary: 'Write a heap snapshot and memory breakdown to the Desktop.', availability: 'composer' },
  // P6.106. A THIRD typed-only row, and its reason is its own rather than a
  // borrowed one: the command is meaningful for exactly as long as a session
  // has a cleared runtime session to go back to, and a menu row is permanent.
  // Standing in the list it would answer "nothing to set aside" almost every
  // time it was picked. The offer is made where it is true instead — `/clear`'s
  // own reply names the id and the command to type.
  { id: null, label: '/resume [session-id]', summary: 'Continue the runtime session /clear set aside; the bare form resumes it.', availability: 'session' },
];

/**
 * The permission-mode commands, listed as ONE line rather than seven rows.
 *
 * Their per-runtime set is `ComposerCapabilities.permissions.modes` — resolved
 * from the connection, narrowed by managed policy, and NOT reachable from the
 * send-path seam. Naming the modes individually here would be the same invented
 * second spelling the module header refuses for `/quota`, so the line points at
 * the picker, which is the surface that knows.
 */
export const PERMISSION_MODE_HELP_LINE =
  'Permission modes are set from the same menu (and with SHIFT+TAB); the picker lists the ones this runtime allows.';

export interface SessionCommandHelpRuntime {
  /** `BaseAgent.canForkConversation()`. */
  canForkConversation: boolean;
  /** `BaseAgent.canCompactContext()`. */
  canCompactContext: boolean;
  /**
   * `ComposerCapabilities.slash.excludedCommandIds` for THIS session's
   * provider + connection pair, when the seam has been handed it (P3.298).
   *
   * This is the ONE resolved value — `resolveComposerCapabilities(...)` — and
   * not a second spelling of its predicates, which is the whole point: the
   * menu already subtracts these ids from what it offers, so a listing that
   * reads the same array cannot claim a command the menu has withdrawn.
   *
   * OMITTED, not `[]`, when the caller does not know. The two are different
   * facts and this module must not conflate them: `[]` asserts *nothing is
   * withdrawn on this connection*, which is false on the Nessy gateway
   * (`/quota`) and on the remote agent (`/btw`, `/recap`); `undefined` says
   * *this surface was never told*, which is what the send-path seam can
   * honestly claim until the field reaches it. {@link SESSION_COMMAND_HELP_UNTOLD_LINE}
   * is printed for the second and not the first, so the listing never goes
   * silently from "I don't know" to "nothing is withdrawn".
   */
  excludedCommandIds?: readonly string[];
  /**
   * P6.410 — `SDKSystemMessage.terminal_slash_commands`, verbatim, for a claude
   * session that was told it. Bare names without the leading slash, exactly as
   * the SDK sends them.
   *
   * NOT a mark on the rows above and never confused with one: these are the
   * RUNTIME's own commands, not this product's, and the two failure modes are
   * opposite. A row above marked unavailable is a command we offer and this
   * runtime cannot serve; a name here is a command we never offered, which the
   * runtime will happily accept and whose effect is bound to a terminal this
   * app does not have.
   *
   * OMITTED, not `[]`, when there is nothing to say — and here, unlike
   * {@link excludedCommandIds}, the two really are the same fact rather than
   * two: the SDK itself sends the field only when non-empty, so "absent" and
   * "no advertised command carries the tag" are one state upstream and are
   * printed as one state here.
   */
  runtimeTerminalCommandNames?: readonly string[];
}

/**
 * Printed when the caller passed no {@link SessionCommandHelpRuntime.excludedCommandIds}.
 *
 * Three commands really are withdrawn per connection and this listing cannot
 * see it from the seam; saying so is the honest residue. It disappears the
 * moment the field is handed in — which is the ONE-FIELD fix named in the
 * module header, and the reason this sentence is a constant rather than prose
 * inside the formatter: its disappearance is what a test asserts.
 */
export const SESSION_COMMAND_HELP_UNTOLD_LINE =
  'A few commands are withdrawn on some connections (for example /quota, /btw and /recap); this listing was not told which, so the composer menu is the surface that knows.';

/**
 * The lead-in for {@link SessionCommandHelpRuntime.runtimeTerminalCommandNames}.
 *
 * A constant rather than prose inside the formatter for
 * {@link SESSION_COMMAND_HELP_UNTOLD_LINE}'s reason: its presence and its
 * absence are both asserted, and a listing that started printing this line for
 * an empty set would be inventing a warning.
 */
export const SESSION_COMMAND_TERMINAL_ONLY_PREFIX =
  'This runtime also advertises commands whose behaviour is bound to a local terminal this app does not have, so they will not do what their name suggests here:';

/** The mark appended to a row this runtime cannot serve. */
const UNAVAILABLE_MARK = '— unavailable on this runtime';

/**
 * The mark for a row this CONNECTION withdraws.
 *
 * Deliberately a different sentence from {@link UNAVAILABLE_MARK}: the two
 * causes are different and the repair is different. `/subtask` is missing
 * because the runtime cannot fork; `/quota` is missing because this connection
 * publishes no budget. Collapsing them would tell a user to switch runtime for
 * something switching runtime does not fix.
 */
const WITHDRAWN_MARK = '— unavailable on this connection';

/** Which mark, if any, a row earns. `null` means the row works here. */
function unavailableMark(entry: SessionCommandHelpEntry, runtime: SessionCommandHelpRuntime): string | null {
  // The connection's own withdrawal is read FIRST: a command the composer will
  // not offer is gone whatever the runtime can do. Rows with `id: null`
  // (`/rewind`, `/heapdump`) carry no menu id and can never be in this array.
  if (entry.id !== null && runtime.excludedCommandIds?.includes(entry.id)) return WITHDRAWN_MARK;
  if (entry.availability === 'fork') return runtime.canForkConversation ? null : UNAVAILABLE_MARK;
  if (entry.availability === 'compact') return runtime.canCompactContext ? null : UNAVAILABLE_MARK;
  return null;
}

/**
 * Render {@link SESSION_COMMAND_HELP_ENTRIES} for one runtime.
 *
 * The two sections are not cosmetic: they answer the question a user asking for
 * help actually has, which is *what happens when I type this*. A `session` row
 * is answered by the session on every runtime and never reaches a model; a
 * `composer` row is answered by the desktop app and reaches no runtime at all —
 * so the second section carries the residue sentence rather than hiding it.
 */
export function formatSessionCommandHelp(runtime: SessionCommandHelpRuntime): string {
  const session = SESSION_COMMAND_HELP_ENTRIES.filter(entry => entry.availability !== 'composer');
  const composer = SESSION_COMMAND_HELP_ENTRIES.filter(entry => entry.availability === 'composer');
  const width = Math.max(...SESSION_COMMAND_HELP_ENTRIES.map(entry => entry.label.length));

  const row = (entry: SessionCommandHelpEntry): string => {
    const line = `  ${entry.label.padEnd(width)}  ${entry.summary}`;
    const mark = unavailableMark(entry, runtime);
    return mark === null ? line : `${line} ${mark}`;
  };

  return [
    'Commands this session answers itself — they never reach the model:',
    ...session.map(row),
    '',
    'Commands the app answers — they open a panel or an overlay and reach no runtime:',
    ...composer.map(row),
    '',
    PERMISSION_MODE_HELP_LINE,
    ...(runtime.excludedCommandIds === undefined ? [SESSION_COMMAND_HELP_UNTOLD_LINE] : []),
    'Anything else beginning with "/" is a project, plugin or MCP command; the composer menu lists the ones this session has.',
    // P6.410 — printed LAST, immediately after the sentence it qualifies. The
    // names are the runtime's, so they are slashed here rather than stored
    // slashed: the SDK sends bare names and a second spelling in the store is
    // how the two drift.
    ...(runtime.runtimeTerminalCommandNames && runtime.runtimeTerminalCommandNames.length > 0
      ? [`${SESSION_COMMAND_TERMINAL_ONLY_PREFIX} ${runtime.runtimeTerminalCommandNames.map(name => `/${name}`).join(', ')}.`]
      : []),
  ].join('\n');
}
