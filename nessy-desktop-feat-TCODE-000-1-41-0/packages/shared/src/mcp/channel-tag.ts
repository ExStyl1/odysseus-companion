/**
 * The `<channel …>` delivery envelope for one pushed MCP channel event.
 *
 * `channels-reference.md:244` — "The event arrives in Claude's context wrapped
 * in a `<channel>` tag. The `source` attribute is set automatically from your
 * server's configured name", rendered at `:246`-`:250` as
 * `<channel source="your-channel" severity="high" run_id="1234">` with the
 * `content` string as the body. `:230` adds the attribute rule: each surviving
 * `meta` entry becomes one attribute.
 *
 * ONE renderer, so every consumer emits the same envelope and the escaping below
 * cannot be half-applied.
 *
 * ## `source` is the pool slug, decided once
 *
 * The page says "your server's configured name" and every example makes the
 * handshake name and the config entry key identical (`{ name: 'webhook' }` under
 * a `webhook` entry, `:81`, `:344`, `:609`). We use the pool's connection slug
 * (`mcp-pool.ts`, `channelServer`) because that is the name the user configured
 * and the name the gate's `allowedSources`/`deniedSources` match on — a tag
 * naming something else than the thing the user permitted would be its own bug.
 * `getServerInfo()` is the alternative if evidence ever says otherwise.
 *
 * ## The escaping order, and why the shared neutraliser is NOT used here
 *
 * `neutralizeHarnessMarkers` (`prompts/untrusted-text.ts`) defangs a CLOSED
 * three-name list — `untrusted`, `system-reminder`, `nessy_agent_environment`.
 * `channel` is deliberately NOT in it, so that helper passes a literal
 * `</channel>` through untouched and cannot defend this fence.
 *
 * Adding `channel` to that list would be worse, not better: the constant is read
 * at 20+ production call sites (every `scanSubagentOutput` in the orchestrator
 * tools), and the host routes a channel event through
 * `buildTaskNotificationDelivery`, which runs `neutralizeHarnessMarkers` over
 * every queued event — so it would neutralise the very element this module
 * emits.
 *
 * The order is therefore, and must stay:
 *   1. escape the BODY here ({@link neutralizeChannelFence}), channel-locally;
 *   2. build the wrapper around the escaped body;
 *   3. let the shared neutraliser run over the RESULT downstream — it does not
 *      know `channel`, so it leaves this fence intact while still defanging any
 *      harness marker the body carried.
 *
 * The NAME list stays separate; the tag SHAPE does not (F1.1016). This file
 * spelled its own pattern and so missed F1.1014's format-character gap: `</` +
 * U+2060 + `channel>` renders as the closer and passed. The pattern and its
 * defang now come from `untrusted-text.ts`'s one builder, a leaf module, so
 * this file stays importable from anywhere.
 */

import { defangFormatTolerantTag, formatTolerantTagPattern } from '../prompts/untrusted-text.ts';

/**
 * Any `<channel`/`</channel` token, however the server spelled its case, with an
 * invisible format character in the gap after `<` or between its letters.
 */
const CHANNEL_TAG = formatTolerantTagPattern(['channel']);

/**
 * `channels-reference.md:230` — "Keys must be identifiers: letters, digits, and
 * underscores only. Keys containing hyphens or other characters are silently
 * dropped."
 *
 * Defined HERE (a module whose one import is the leaf `untrusted-text.ts`), and
 * imported by the transport parser and the pool's guard, so the three places
 * that decide what an identifier is cannot drift apart. Not a shared `RegExp`
 * instance with `g`/`y` — `lastIndex` state would make one caller's `test()`
 * depend on another's.
 */
export function isChannelMetaKey(key: string): boolean {
  return /^[A-Za-z0-9_]+$/.test(key);
}

/**
 * Defang `<channel`-shaped tokens in an untrusted event body.
 *
 * DEFANG, do not delete — the same rule the sibling module states: an event
 * legitimately reporting *about* a channel tag must stay legible rather than be
 * mangled. Idempotent as a FIXED POINT: the inserted zero-width space is a
 * format character the pattern admits, so a second pass matches the defanged
 * form and writes the same bytes ({@link defangFormatTolerantTag}).
 */
export function neutralizeChannelFence(body: string): string {
  return body.replace(CHANNEL_TAG, defangFormatTolerantTag);
}

/**
 * Escape one attribute VALUE for the double-quoted attribute context.
 *
 * Values arrive control-stripped and length-bounded from the transport parser
 * (`client.ts` `boundedChannelMeta`); quoting is deliberately left to this one
 * place so nothing is escaped twice. `"` would close the attribute, `<`/`>`
 * would close or forge the tag, and a newline would let a value masquerade as
 * the body.
 */
function escapeAttributeValue(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/[\r\n]+/g, ' ');
}

/** The subset of a channel message this renderer needs. */
export interface ChannelEventInput {
  server: string;
  text: string;
  meta?: Readonly<Record<string, string>>;
}

/**
 * Render one channel event as the documented `<channel …>` element.
 *
 * Attributes are emitted in insertion order after `source`, which is always
 * first and always ours. A `meta` key that does not survive the identifier rule
 * is dropped here too, so a message that reached this function without passing
 * through the transport parser still cannot inject an attribute name.
 */
export function formatChannelEvent(message: ChannelEventInput): string {
  // Step 1 — escape the body BEFORE it is wrapped. A literal `</channel>` in an
  // event must not be able to close the fence and forge trusted structure after
  // it.
  const body = neutralizeChannelFence(message.text);

  const attributes = [`source="${escapeAttributeValue(message.server)}"`];
  for (const [key, value] of Object.entries(message.meta ?? {})) {
    if (!isChannelMetaKey(key) || key === 'source') continue;
    if (typeof value !== 'string') continue;
    attributes.push(`${key}="${escapeAttributeValue(value)}"`);
  }

  // Step 2 — wrap. Step 3 (the shared neutraliser) happens downstream and must
  // leave this fence alone; see the module docblock.
  return `<channel ${attributes.join(' ')}>\n${body}\n</channel>`;
}
