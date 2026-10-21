/**
 * F1.1100 — what the MODEL reads when it calls a tool a whole-tool deny rule removed.
 *
 * A deny rule that names a whole tool takes it out of the Pi manifest (F1.756), so a model that saw the tool before the
 * rule landed and calls it anyway meets the Pi SDK's own answer: `prepareToolCall` in `@earendil-works/pi-agent-core`
 * (`dist/agent-loop.js`) returns the immediate error result `Tool <name> not found` for any name the context's tools
 * do not hold, and no extension hook runs on that path (`beforeToolCall`/`afterToolCall` see found tools only). The
 * model then told the user the tool "isn't registered". Claude names the rule instead: with tool search active the
 * definition stays and Claude Code refuses the call (`prompt-caching.md#denying-an-entire-tool`).
 *
 * The seam is Pi's own `context` extension event — fired before every model call, it may replace the messages the
 * model is sent (`ContextEvent` / `ContextEventResult`, `dist/core/extensions/types.d.ts`). The host sends the refusal
 * of each removed tool with every manifest registration (`register_tools.wholeToolDenyRefusals`, the same sentences
 * F1.756 puts on the user's card), and {@link rewriteWholeToolDenyNotFound} replaces exactly the SDK's not-found
 * sentence for exactly those names. The session file keeps the SDK's text; only the model's view changes.
 */

/** Removed tool's Pi name → the refusal naming its rule. Replaced whole on every registration. */
const refusals = new Map<string, string>();

const MAX_REFUSALS = 256;
const MAX_REFUSAL_LENGTH = 4000;

/** Adopt the host's list (`register_tools.wholeToolDenyRefusals`); anything malformed is dropped, absent clears. */
export function setWholeToolDenyRefusals(list: unknown): void {
  refusals.clear();
  if (!Array.isArray(list)) return;
  for (const entry of list.slice(0, MAX_REFUSALS)) {
    if (!entry || typeof entry !== 'object') continue;
    const { name, refusal } = entry as { name?: unknown; refusal?: unknown };
    if (typeof name !== 'string' || !name || typeof refusal !== 'string' || !refusal) continue;
    refusals.set(name, refusal.slice(0, MAX_REFUSAL_LENGTH));
  }
}

interface ToolResultLike {
  role?: unknown;
  toolName?: unknown;
  isError?: unknown;
  content?: unknown;
}

/**
 * The messages with each not-found result of a deny-removed tool replaced by its rule's refusal, or `undefined` when
 * nothing changed (the `context` handler then returns nothing and Pi keeps its own array).
 */
export function rewriteWholeToolDenyNotFound<T>(messages: readonly T[]): T[] | undefined {
  if (refusals.size === 0) return undefined;
  let changed = false;
  const next = messages.map(message => {
    const result = message as ToolResultLike;
    if (result?.role !== 'toolResult' || result.isError !== true || typeof result.toolName !== 'string') return message;
    const refusal = refusals.get(result.toolName);
    if (!refusal || !Array.isArray(result.content) || result.content.length !== 1) return message;
    const [part] = result.content as Array<{ type?: unknown; text?: unknown }>;
    if (part?.type !== 'text' || part.text !== `Tool ${result.toolName} not found`) return message;
    changed = true;
    return { ...message, content: [{ type: 'text', text: refusal }] } as T;
  });
  return changed ? next : undefined;
}
