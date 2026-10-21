/**
 * `/subtask` — the in-session conversation fork the user starts.
 *
 * The NAME is the load-bearing part of this module. `sub-agents.md:1013`:
 * "You can start a fork yourself with `/subtask` followed by a task, with or
 * without the variable set. On v2.1.161 through v2.1.211 the command is
 * `/fork`." And `:895` names the split explicitly: "An in-session fork you
 * start yourself with `/subtask` counts too … A session you create with `/fork`
 * doesn't count; it runs as a separate background session with its own budget.
 * Before v2.1.212, the in-session fork was named `/fork`."
 *
 * So `/fork` and `/subtask` are now two DIFFERENT features. `/subtask` is the
 * in-session forked subagent, which is what this repo's fork engine implements;
 * `/fork` copies the whole session into a separate background session, which we
 * do not have. Registering the fork engine under `/fork` would ship the
 * opposite command.
 *
 * The one caveat in `:997` — "When agent view is turned off, `/subtask` isn't
 * available and `/fork` starts the forked subagent instead" — is a fallback for
 * a surface we do not have (there is no agent-view toggle here), so `/subtask`
 * is unconditional for us.
 */
export const SUBTASK_COMMAND_NAME = 'subtask';
export const SUBTASK_COMMAND_LABEL = `/${SUBTASK_COMMAND_NAME}`;

const SUBTASK_PATTERN = /^\/subtask(?:\s+([\s\S]+))?$/i;

export interface ParsedSubtaskCommand {
  /** The task text after the command; empty when the user typed the bare command. */
  task: string;
}

/**
 * Returns the parsed command when `input` IS a `/subtask` invocation, and
 * `null` otherwise. A bare `/subtask` parses with an empty task so the caller
 * can report the missing argument rather than silently sending the word to the
 * model.
 */
export function parseSubtaskCommand(input: string): ParsedSubtaskCommand | null {
  const match = input.trim().match(SUBTASK_PATTERN);
  if (!match) return null;
  return { task: (match[1] ?? '').trim() };
}
