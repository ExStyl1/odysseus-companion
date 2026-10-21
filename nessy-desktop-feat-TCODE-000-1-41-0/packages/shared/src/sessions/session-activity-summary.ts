/**
 * P6.504 — one line saying what a session is doing, derived from the session's
 * OWN OUTPUT and costing no model call.
 *
 * ## Why this shape and not the documented one
 *
 * Delegated decision Q-den 22 of 2026-09-05 is **option A**. Option B — spend
 * the connection's mini model on one summarising turn per row — was refused
 * because it is a recurring charge the user cannot see, and because on our
 * default gateway the page's own fallback rule lands it on the MAIN model:
 * `agent-view.md`, verbatim — *"On a third-party provider or gateway with no
 * Haiku-class model configured, the request uses the session's main model
 * instead"*. A list of forty sessions would have been forty main-model turns.
 *
 * So the line is EXTRACTED, never written. Nothing here asks a model anything;
 * the whole cost is a string scan at session-save time, beside the `preview`
 * this file's neighbours already precompute.
 *
 * ## The honest limits, which the row states rather than hides
 *
 * A last turn that is long, or that ends in tool work with no closing sentence,
 * reads worse than one that ends in a plain summary sentence — and there is no
 * cheap fix for that without the model call option A refused. Two consequences
 * are deliberate:
 *
 * - **Nothing is invented.** A session whose last output has no readable
 *   sentence returns `undefined` and the row shows no line, rather than a
 *   confident-looking fragment of a diff.
 * - **The line is the session's own words**, so the surface that renders it
 *   says so (`session.lastOutput.hint`). A line the user reads as *our*
 *   summary of the session would be a claim we are not making.
 *
 * ## Uniform across runtimes by construction
 *
 * The input is the stored message list, which every runtime writes through the
 * same store. There is no runtime input to this function, so Pi, claude and
 * codex cannot produce different lines from the same transcript.
 */

/** The minimum a stored message needs. `StoredMessage` is assignable to it. */
export interface SessionOutputMessage {
  type: string;
  content?: string;
  isIntermediate?: boolean;
}

/** Long enough for a sentence, short enough for one list row. */
export const SESSION_OUTPUT_SUMMARY_MAX_CHARS = 120;

/**
 * Everything a transcript carries that is not the model talking to the user.
 * Stripped before the first sentence is taken, because a last turn that ends in
 * a fenced diff would otherwise put ``` on the row.
 */
function sanitizeOutput(raw: string): string {
  return raw
    // Fenced code, including an unterminated final fence.
    .replace(/```[\s\S]*?(?:```|$)/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    // Our own structured blocks, CONTENT AND ALL — not just their tags.
    // `extractPreview` already does this for `<edit_request>` on the user side,
    // and reasoning needs it more than any of them: a `<thinking>` block is the
    // model addressing itself, and `Message.reasoning`'s own contract calls it
    // the most sensitive thing on a turn. Dropping only the tags would put its
    // text on a list row that is visible without opening the session.
    .replace(/<(thinking|edit_request|system-reminder)>[\s\S]*?(?:<\/\1>|$)/g, ' ')
    // Mention syntax and any residual markup.
    .replace(/<[^>]+>/g, ' ')
    .replace(/\[(?:skill|source|file|folder):[^\]\r\n]+\]/g, ' ')
    // Markdown furniture: headings, list bullets, emphasis, links.
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}[-*+]\s+/gm, '')
    .replace(/^\s{0,3}>\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The first sentence, or the first {@link SESSION_OUTPUT_SUMMARY_MAX_CHARS}
 * characters when the text has no sentence end in range.
 *
 * A truncation is marked with an ellipsis; a complete sentence is not. That
 * difference is the only thing telling a reader whether they are seeing the
 * whole of what the session said.
 */
function firstSentence(text: string): string {
  const end = text.search(/[.!?](?:\s|$)/);
  if (end !== -1 && end + 1 <= SESSION_OUTPUT_SUMMARY_MAX_CHARS) {
    return text.slice(0, end + 1);
  }
  if (text.length <= SESSION_OUTPUT_SUMMARY_MAX_CHARS) return text;
  const cut = text.slice(0, SESSION_OUTPUT_SUMMARY_MAX_CHARS);
  const lastSpace = cut.lastIndexOf(' ');
  // Never end mid-token: the tail of a path or an identifier reads as a typo.
  return `${(lastSpace > SESSION_OUTPUT_SUMMARY_MAX_CHARS / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/**
 * The session's own last words, in one line, or `undefined`.
 *
 * `undefined` for: no messages, no final assistant or plan message, and a final
 * message whose content is nothing but code, markup or whitespace. All three
 * are the same answer on purpose — the row draws nothing, which is honest,
 * where a placeholder would be a claim.
 */
export function summarizeSessionOutput(
  messages: readonly SessionOutputMessage[] | null | undefined,
): string | undefined {
  if (!messages?.length) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message) continue;
    // A plan IS the session's output, and the plan card is often the last thing
    // a session produced before it stopped for an answer.
    if (message.type !== 'assistant' && message.type !== 'plan') continue;
    if (message.isIntermediate) continue;
    if (!message.content) return undefined;
    const sanitized = sanitizeOutput(message.content);
    if (!sanitized) return undefined;
    return firstSentence(sanitized);
  }
  return undefined;
}
