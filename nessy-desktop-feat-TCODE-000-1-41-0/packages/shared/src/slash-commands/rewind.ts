/**
 * `/rewind` — the command that OPENS the rewind menu.
 *
 * `checkpointing.md#rewind-and-summarize`: "Run `/rewind`, or press `Esc` twice
 * when the prompt input is empty, to open the rewind menu." Both openers were
 * absent from this product until P2.425; the rewind ACTIONS existed only on a
 * per-message right-click context menu, which is a thing you find rather than a
 * thing you open, and that difference is invisible to anyone comparing feature
 * lists.
 *
 * Whole-message, no argument, like `/clear` and `/heapdump`: `/rewind that edit`
 * is prose and belongs to the model. The menu takes its target by selection,
 * not by argument — `checkpointing.md#rewind-and-summarize`: "The rewind menu
 * lists each prompt you sent during the session. Select the point you want to
 * act on, then choose an action."
 *
 * DELIBERATELY NOT PART OF `parseSessionCommand`, and the reason is the whole
 * design of this command. `parseSessionCommand` is the classifier for text that
 * must reach the SESSION instead of the model, and every one of its non-test
 * consumers is a send-path seam — `BaseAgent.chat`, `SessionManager.sendMessage`,
 * `PiAgent.chatImpl`, `ClaudeAgent`/`CodexAgent`'s dispatchers and `App.tsx`'s
 * `/clear` mirror. `/rewind` never travels: it is answered entirely in the
 * renderer, by opening a menu, and reaches no backend on any runtime. Adding a
 * kind to `ParsedSessionCommand` would make all six of those seams newly branch
 * on a case none of them has an arm for, in files this change does not touch.
 * So the classifier stays where its only reader is — the renderer — and the
 * residue is named rather than hidden: text typed into a surface that is NOT the
 * desktop composer (`apps/cli`) still reaches the model as prose, exactly as it
 * did before this parser existed.
 */
export const REWIND_COMMAND_NAME = 'rewind';
export const REWIND_COMMAND_LABEL = `/${REWIND_COMMAND_NAME}`;

const REWIND_PATTERN = /^\/rewind$/i;

export interface ParsedRewindCommand {
  kind: 'rewind';
}

/**
 * Returns `{ kind: 'rewind' }` when the whole message IS `/rewind`, and `null`
 * otherwise. A mention of `/rewind` inside a sentence is prose and belongs to
 * the model — the same whole-message rule `parseSessionCommand` applies.
 */
export function parseRewindCommand(input: string): ParsedRewindCommand | null {
  if (!REWIND_PATTERN.test(input.trim())) return null;
  return { kind: 'rewind' };
}
