/**
 * Browser tool naming helpers and the read-only command classifier.
 *
 * Canonical runtime tool is `browser_tool`, but we retain compatibility with
 * legacy split tool names (browser_open, browser_snapshot, etc.) that may
 * appear in older sessions/tests/logs.
 */

import { splitBatchCommands, tokenizeCommand } from './browser-tool-command-parse.ts';

/** Legacy split browser tool aliases that map to canonical `browser_tool`. */
export const LEGACY_BROWSER_TOOL_ALIASES = new Set<string>([
  'browser_open',
  'browser_navigate',
  'browser_snapshot',
  'browser_click',
  'browser_click_at',
  'browser_fill',
  'browser_select',
  'browser_screenshot',
  'browser_screenshot_region',
  'browser_console',
  'browser_window_resize',
  'browser_network',
  'browser_wait',
  'browser_key',
  'browser_downloads',
  'browser_scroll',
  'browser_back',
  'browser_forward',
  'browser_evaluate',
]);

/**
 * Strip known session prefixes from tool names.
 */
function stripSessionPrefix(toolName: string): string {
  return toolName.replace(/^(mcp__session__|session__)/, '');
}

/**
 * Normalize canonical browser tool names (`browser_tool`) with optional namespaces.
 * Does NOT accept legacy aliases.
 */
export function normalizeCanonicalBrowserToolName(toolName: string): 'browser_tool' | null {
  const normalized = toolName.trim();
  if (!normalized) return null;

  // Accept direct and namespaced canonical forms, e.g.:
  // - browser_tool
  // - mcp__session__browser_tool
  // - mcp__workspace__browser_tool
  return /(?:^|__)browser_tool$/i.test(normalized) ? 'browser_tool' : null;
}

/**
 * Normalize browser tool names (canonical + legacy aliases) to `browser_tool`.
 */
export function normalizeBrowserToolName(toolName: string): 'browser_tool' | null {
  const canonical = normalizeCanonicalBrowserToolName(toolName);
  if (canonical) return canonical;

  const normalized = toolName.trim();
  if (!normalized) return null;

  const stripped = stripSessionPrefix(normalized);
  return LEGACY_BROWSER_TOOL_ALIASES.has(stripped) ? 'browser_tool' : null;
}

/**
 * True when a tool name is the canonical browser tool (with optional namespace prefix).
 */
export function isCanonicalBrowserToolName(toolName: string): boolean {
  return normalizeCanonicalBrowserToolName(toolName) === 'browser_tool';
}

/**
 * True when a tool name is the canonical browser tool or a supported legacy alias.
 */
export function isBrowserToolNameOrAlias(toolName: string): boolean {
  return normalizeBrowserToolName(toolName) === 'browser_tool';
}

/**
 * The browser_tool verbs that only read the page or browser state.
 *
 * chrome.md ("Browser tools in plan mode") splits plan mode by the CALL, not
 * the tool name: "browser tool calls that only read the page or browser state
 * run without a permission prompt, and calls that change state prompt for
 * approval". Its read-only class is reading the page tree, console messages,
 * network requests and taking a screenshot; clicks, typing, navigation, and
 * tab/window management are state-changing — which is why `open`, `focus`,
 * `release`, `close`, `hide` and `window-resize` are NOT in this set.
 *
 * Every verb the executor (browser-tool-runtime.ts) implements and that is not
 * listed here classifies as state-changing, and so does any UNKNOWN verb: the
 * set fails closed so a verb added to the runtime cannot silently bypass the
 * permission gate.
 */
export const BROWSER_READ_ONLY_COMMANDS: ReadonlySet<string> = new Set([
  'snapshot',
  'help',
  '--help',
  '-h',
  'find',
  'screenshot',
  'screenshot-region',
  'console',
  'network',
  'windows',
  'wait',
  'downloads',
  'get-clipboard',
]);

/**
 * State-changing input flags that flip an otherwise read-only verb to
 * state-changing (chrome.md: "an otherwise read-only call that sets a
 * state-changing input flag, such as `createIfEmpty` on `tabs_context_mcp`,
 * `clear` on the console and network readers, or `save_to_disk` on a
 * screenshot, also prompts for approval").
 *
 * Covered flags: `clear`/`--clear` on `console` and `network`, and
 * `save_to_disk`/`--save-to-disk` (both separator spellings) on `screenshot`
 * and `screenshot-region`. The executor's own flag vocabulary on read-only
 * verbs is state-neutral today — `screenshot` parses only
 * `--annotated`/`-a`/`--png`, `screenshot-region` only
 * `--png`/`--padding`/`--ref`/`--selector`, and `console`/`network`/`wait`/
 * `downloads` take positional filters — so these entries are pinned
 * PRE-EMPTIVELY: if the runtime ever grows the documented flags, the gate
 * prompts by default instead of silently allowing. chrome.md's third example,
 * `createIfEmpty`, has no analogue here: our `windows` verb takes no arguments
 * and creates nothing. Matched case-insensitively (broader than the executor's
 * case-sensitive flag checks — a superset is the safe direction for a gate).
 */
const BROWSER_STATE_CHANGING_FLAGS_BY_COMMAND: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
  console: new Set(['clear', '--clear']),
  network: new Set(['clear', '--clear']),
  screenshot: new Set(['save_to_disk', '--save_to_disk', 'save-to-disk', '--save-to-disk']),
  'screenshot-region': new Set(['save_to_disk', '--save_to_disk', 'save-to-disk', '--save-to-disk']),
});

/** One tokenized command: read-only verb, carrying no state-changing flag. */
function isReadOnlyCommandTokens(tokens: readonly string[]): boolean {
  const verb = tokens[0]?.toLowerCase();
  // No verb: the executor renders help (executeSingleCommand treats a missing
  // or empty first token as `--help`), which reads nothing from the page.
  if (!verb) return true;
  if (!BROWSER_READ_ONLY_COMMANDS.has(verb)) return false;
  const stateFlags = BROWSER_STATE_CHANGING_FLAGS_BY_COMMAND[verb];
  if (stateFlags) {
    for (const token of tokens.slice(1)) {
      if (stateFlags.has(token.toLowerCase())) return false;
    }
  }
  return true;
}

/**
 * True when a `browser_tool` input only reads page or browser state.
 *
 * Mirrors `executeBrowserToolCommand` exactly, using the executor's OWN parser
 * (browser-tool-command-parse.ts):
 * - array form is ONE command whose verb is element 0 (the executor never
 *   batch-splits arrays);
 * - string form is `splitBatchCommands` then the first token of each
 *   sub-command, and EVERY sub-command must be read-only — chrome.md: "A
 *   `browser_batch` call runs without a prompt only when every action inside
 *   it is read-only";
 * - the quote rule is UB4.20's, shared with the executor through
 *   browser-tool-command-parse.ts: a quote at a token start opens a span
 *   closed by the same quote before whitespace/`;`/end; mid-token quotes are
 *   literal and protect `;`. A plain-text apostrophe (`fill @e5 Don't do
 *   this`) therefore classifies and runs identically — the desync this gate
 *   warns about cannot reappear through quoting;
 * - a missing/empty/malformed `command` returns true: the runtime throws
 *   "Missing command" (or the parser's own unclosed-quote error, from the very
 *   same functions imported here) before touching the page, so the call cannot
 *   change state — and this keeps existing `{}`-input call sites allowed.
 */
export function isReadOnlyBrowserToolInput(toolInput: unknown): boolean {
  const command = toolInput && typeof toolInput === 'object'
    ? (toolInput as { command?: unknown }).command
    : undefined;

  if (Array.isArray(command)) {
    if (command.length === 0) return true; // runtime throws 'Missing command'
    // A non-string element is outside the tool schema; the verb is unknowable,
    // so fail closed.
    if (!command.every((part): part is string => typeof part === 'string')) return false;
    return isReadOnlyCommandTokens(command);
  }

  if (typeof command !== 'string') return true; // runtime throws 'Missing command'
  const trimmed = command.trim();
  if (!trimmed) return true; // runtime throws 'Missing command'

  let batch: string[];
  try {
    batch = splitBatchCommands(trimmed);
    return batch.every(single => isReadOnlyCommandTokens(tokenizeCommand(single)));
  } catch {
    // Unclosed quote: the executor runs the SAME parser on the same string
    // before any page interaction, so it throws identically and no state can
    // change.
    return true;
  }
}
