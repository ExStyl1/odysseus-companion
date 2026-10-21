/**
 * `/btw` — the side-question command.
 *
 * `interactive-mode.md:359`: "Use `/btw` to ask a quick question about your
 * current work without adding to the conversation history." The question and
 * answer "appear in a dismissible overlay and never enter the conversation
 * history" (`:365`), so this command must never become a model turn or a
 * transcript entry — it is answered out-of-band over the non-persisting
 * `sideQuestion` session command.
 *
 * The BARE form is NOT a usage error, unlike `/subtask`'s empty-arg handling.
 * `interactive-mode.md:374`: "To return to the overlay after dismissing it, run
 * `/btw` with no question. The overlay reopens on your most recent exchange."
 * (Before v2.1.212 the bare form printed a usage message; we implement the
 * current contract.) So `/btw` parses successfully with `question: ''` and the
 * RENDERER decides what an empty question means (reopen); the server answers
 * only non-empty questions.
 */
export const BTW_COMMAND_NAME = 'btw';
export const BTW_COMMAND_LABEL = `/${BTW_COMMAND_NAME}`;

const BTW_PATTERN = /^\/btw(?:\s+([\s\S]+))?$/i;

export interface ParsedBtwCommand {
  /** The question after the command; empty when the user typed the bare command (reopen). */
  question: string;
}

/**
 * Returns the parsed command when `input` IS a `/btw` invocation, and `null`
 * otherwise. A bare `/btw` parses with an empty question — that is the
 * documented "reopen the overlay" form, not a mistake to report.
 */
export function parseBtwCommand(input: string): ParsedBtwCommand | null {
  const match = input.trim().match(BTW_PATTERN);
  if (!match) return null;
  return { question: (match[1] ?? '').trim() };
}
