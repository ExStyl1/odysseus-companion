/**
 * The documented cap on a URL handed to the OS as a COMMAND-LINE ARGUMENT.
 *
 * `mcp.md#respond-to-mcp-elicitation-requests`, verbatim: *"In URL mode, Claude
 * Code passes the URL as a command-line argument to your system's URL handler,
 * and caps how long that argument can be. When the URL, once escaped for the
 * command line, is over that cap, you can only decline the request. Every
 * character that needs escaping, such as `%` or `&`, counts four times toward
 * the cap: its own character plus three escape characters. A URL with none of
 * them reaches the cap at about 8,000 characters. A URL built largely of
 * percent-escapes, where every third character is a `%`, reaches it at roughly
 * 4,000."*
 *
 * The cap is on the ESCAPED length, not the raw one, which is why it is a
 * function rather than a `url.length` comparison — and why the page's two
 * worked examples land 8,000 apart on a number that is one constant.
 */
export const OPEN_URL_COMMAND_LINE_CAP_CHARS = 8000;

/**
 * Which characters count FOUR times, decided here because the page does not say.
 *
 * `mcp.md` names `%` and `&` as examples and stops. Under the standing rule for
 * where the documentation is silent — transparent and simple — this is the
 * smallest honest set: a character counts ONCE when it is `A-Z`, `a-z`, `0-9`
 * or one of `-`, `.`, `_`, `/`, `:` — the characters that neither the POSIX
 * shell family nor `cmd.exe`/PowerShell treats specially and that make up the
 * bulk of any URL — and FOUR times otherwise. `%` and `&` are both outside it,
 * as the page requires.
 *
 * It is calibrated, not guessed: it reproduces BOTH of the page's worked
 * examples exactly. A URL of nothing but safe characters reaches 8,000 escaped
 * at 8,000 raw; a URL where every third character is a `%` and the other two
 * are hex digits costs `4 + 1 + 1 = 6` per three characters, i.e. twice its raw
 * length, so it reaches 8,000 escaped at 4,000 raw.
 *
 * Erring on the conservative side is deliberate: over-counting a character
 * refuses a URL slightly sooner, which is recoverable and visible, while
 * under-counting hands an over-long argv to a spawn that fails opaquely.
 */
const SAFE_COMMAND_LINE_CHARS = /[A-Za-z0-9\-._/:]/;
const ESCAPED_CHAR_COST = 4;

/**
 * The URL's length ONCE ESCAPED FOR THE COMMAND LINE, by the page's own
 * arithmetic. Exported so the rule can be pinned against the two worked
 * examples rather than only through the refusal.
 */
export function commandLineEscapedUrlLength(url: string): number {
  let total = 0;
  for (const char of url) {
    total += SAFE_COMMAND_LINE_CHARS.test(char) ? 1 : ESCAPED_CHAR_COST;
  }
  return total;
}

/** Whether this URL is over the documented cap and can therefore only be declined. */
export function exceedsCommandLineUrlCap(url: string): boolean {
  return commandLineEscapedUrlLength(url) > OPEN_URL_COMMAND_LINE_CAP_CHARS;
}

/**
 * Opens a URL in the default browser.
 *
 * Prefers Electron's shell.openExternal() which uses native OS APIs and
 * works reliably in packaged apps (no PATH dependency).  Falls back to
 * the 'open' npm package for non-Electron environments.
 *
 * The 'open' package spawns `open` (macOS) / `xdg-open` (Linux) as a
 * child process, which fails with `spawn open ENOENT` in some packaged
 * Electron builds where PATH is stripped.
 *
 * ALWAYS use this instead of importing 'open' directly.
 *
 * ## Why the length cap is on the FALLBACK only (P6.569)
 *
 * The two branches have different failure modes, and the documented cap belongs
 * to exactly one of them. `shell.openExternal` hands the string to a native OS
 * API — no argv, no shell, no length ceiling — which is precisely why the cap
 * *"Claude Code passes the URL as a command-line argument"* describes does not
 * apply there. The `open` package DOES spawn `open`/`xdg-open`/PowerShell with
 * the URL as an argument, so on that path an over-long URL is the documented
 * situation, and an unbounded one is a server-supplied string reaching a spawn.
 *
 * URL-mode MCP elicitation is the caller that makes this reachable by an
 * untrusted party: `mcp/elicitation.ts` passes a URL the SERVER chose. Its
 * `handleUrlElicitation` already turns a throw from here into a visible decline,
 * which is what the page prescribes — *"you can only decline the request"* — so
 * refusing here needs no change on that side.
 *
 * Native mechanism: none. This is a host opener on every runtime; the cap is a
 * property of the OS spawn, and no runtime exposes a setting for it. Searched
 * the shipped SDK binary for the vendor's own implementation by four routes
 * (`URL is too long`, `url_too_long`, an `8000` constant in JS context,
 * `xdg-open`) and every hit was unrelated — google-auth service-account
 * impersonation, the web_fetch provenance check, the REPL footer-link scanner,
 * assorted timeouts. Recorded as a null: the page is the contract here.
 *
 * @param url - The URL to open in the default browser
 * @throws when the non-Electron fallback would exceed the documented cap
 */
export async function openUrl(url: string): Promise<void> {
  // Prefer Electron's native API — no child process spawn, no PATH issues.
  try {
    const { shell } = await import('electron');
    await shell.openExternal(url);
    return;
  } catch {
    // Not in Electron main process — fall back to 'open' package.
  }

  // Refuse BY NAME before the spawn, never after: the point of the cap is that
  // the argument never reaches the handler.
  const escapedLength = commandLineEscapedUrlLength(url);
  if (escapedLength > OPEN_URL_COMMAND_LINE_CAP_CHARS) {
    throw new Error(
      `[open-url] Refused: this URL is ${escapedLength} characters once escaped for the command line, `
      + `over the ${OPEN_URL_COMMAND_LINE_CAP_CHARS}-character cap on an argument passed to the system URL `
      + 'handler (mcp.md, "Respond to MCP elicitation requests"). Characters that need escaping, such as '
      + '% or &, count four times. The request can only be declined.',
    );
  }

  const open = await import('open');
  const openFn = open.default || open;
  await openFn(url);
}
