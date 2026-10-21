/**
 * Live tool-call INPUT, while it is still arriving.
 *
 * Two of the three runtimes stream a tool call's arguments as a JSON *string*
 * built up in fragments — Pi's `toolcall_delta.delta`
 * (`@earendil-works/pi-ai` `AssistantMessageEvent`) and claude's
 * `input_json_delta.partial_json` (the SDK sends them because
 * `includePartialMessages: true` is already set). Neither fragment boundary is
 * a JSON boundary, so an accumulated buffer is almost never parseable on its
 * own, which is why both adapters ignored the frames and the input landed in
 * one block at the end of the call.
 *
 * P6.158 reads them. `parsePartialToolInput` turns an accumulated buffer into
 * the best-effort object view of what has arrived so far; the adapters re-emit
 * `tool_start` with it, which is the re-emission path that already exists
 * (`tool-matching.ts`, the `hasNewInput` branch — the SDK's own
 * empty-then-complete pair uses it).
 *
 * Two rules the callers must keep, both of them load-bearing:
 *
 *  1. **Never register a partial input in `ToolIndex`.** `ToolIndex.register`
 *     overwrites only when the stored input is EMPTY, so a partial registered
 *     there would be frozen and the complete input would never replace it —
 *     tool-result matching would then read a truncated input for the rest of
 *     the session. The adapters push the incremental `tool_start` directly
 *     rather than going through `extractToolStarts`.
 *  2. **Re-emit on a doubling schedule, not per frame.** Each `tool_start` the
 *     host receives with a non-empty input costs a `loadAllSources` walk in
 *     `SessionManager.resolveToolDisplayMeta`, and a large `Write` arrives in
 *     hundreds of frames. `nextPartialToolInputThreshold` bounds the count to
 *     O(log n) — about ten re-emissions for a 50 KB input, three for a 500-byte
 *     one — with `PARTIAL_TOOL_INPUT_FLOOR_CHARS` as the floor so a short input
 *     that fits in one or two frames emits nothing extra at all.
 */

/**
 * Smallest accumulated buffer worth re-emitting. Below this a tool call has
 * effectively arrived in one block and the incremental view adds nothing.
 */
export const PARTIAL_TOOL_INPUT_FLOOR_CHARS = 64;

/**
 * The buffer length at which the NEXT incremental re-emission is due, given the
 * length just emitted at. Doubling, floored — see rule 2 above.
 */
export function nextPartialToolInputThreshold(emittedAtLength: number): number {
  return Math.max(emittedAtLength * 2, PARTIAL_TOOL_INPUT_FLOOR_CHARS);
}

interface JsonScan {
  /** Closers for everything still open, outermost last. */
  closers: string;
  /** True when the buffer ends inside a string literal. */
  inString: boolean;
  /** Index to cut at for the last complete member, and that prefix's closers. */
  safeEnd: number;
  safeClosers: string;
}

function closersOf(stack: string[]): string {
  return [...stack].reverse().join('');
}

function scanJson(source: string): JsonScan {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  let safeEnd = 0;
  let safeClosers = '';
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === '{' || c === '[') {
      stack.push(c === '{' ? '}' : ']');
      safeEnd = i + 1;
      safeClosers = closersOf(stack);
      continue;
    }
    if (c === '}' || c === ']') {
      stack.pop();
      continue;
    }
    if (c === ',') {
      // Cut BEFORE the comma: everything up to here is complete members.
      safeEnd = i;
      safeClosers = closersOf(stack);
    }
  }
  return { closers: closersOf(stack), inString, safeEnd, safeClosers };
}

/**
 * Best-effort object view of a partially-arrived tool input.
 *
 * Returns `null` when nothing coherent can be read yet — the caller emits
 * nothing rather than guessing. An empty object is also nothing to report, so
 * callers skip it; it is returned rather than nulled because `{}` is a real
 * parse of `{`.
 */
export function parsePartialToolInput(buffer: string): Record<string, unknown> | null {
  const source = buffer.trimEnd();
  if (source.length === 0) return null;
  const scan = scanJson(source);
  const candidates = [
    // 1. It already parses — the whole input arrived inside one frame.
    source,
    // 2. Close the string and the containers that are still open.
    source + (scan.inString ? '"' : '') + scan.closers,
    // 3. The tail is a half-written key or a key with no value yet: cut back to
    //    the last complete member and close there.
    source.slice(0, scan.safeEnd) + scan.safeClosers,
  ];
  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  }
  return null;
}
