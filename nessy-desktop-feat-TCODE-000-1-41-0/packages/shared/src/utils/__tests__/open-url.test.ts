/**
 * P6.569 — the documented cap on a URL handed to the OS as a command-line
 * argument, applied on the path that actually spawns one.
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
 * The page's TWO worked examples are what pins the arithmetic: a single
 * constant that produces both 8,000 and 4,000 is a much stronger check than a
 * length comparison against either number on its own.
 */
import { describe, expect, it } from 'bun:test';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  OPEN_URL_COMMAND_LINE_CAP_CHARS,
  commandLineEscapedUrlLength,
  exceedsCommandLineUrlCap,
} from '../open-url.ts';

/** A URL of nothing but characters the page counts once. */
function plainUrl(rawLength: number): string {
  const prefix = 'https://example.com/';
  return prefix + 'a'.repeat(Math.max(0, rawLength - prefix.length));
}

/**
 * The page's second example: *"a URL built largely of percent-escapes, where
 * every third character is a `%`"*. `%41` repeated is exactly that shape — one
 * `%` and two hex digits per three characters, so the raw length is a multiple
 * of three and the page's "roughly 4,000" is bracketed rather than hit exactly.
 */
function percentHeavyUrl(escapes: number): string {
  return '%41'.repeat(escapes);
}

const PROBE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'open-url-fallback-probe.ts');

describe('the documented command-line cap (P6.569)', () => {
  it('reproduces BOTH of the page worked examples from one constant', () => {
    // Positive: a URL with no escapable character costs one per character, so
    // it reaches the cap at the cap — "about 8,000".
    expect(commandLineEscapedUrlLength(plainUrl(8000))).toBe(8000);
    expect(exceedsCommandLineUrlCap(plainUrl(8000))).toBe(false);

    // And the percent-heavy shape costs 4 + 1 + 1 per three characters, i.e.
    // twice its raw length, so it reaches the same cap at "roughly 4,000" —
    // 3,999 raw is the largest multiple of three that still fits.
    const percentHeavy = percentHeavyUrl(1333);
    expect(percentHeavy.length).toBe(3999);
    expect(commandLineEscapedUrlLength(percentHeavy)).toBe(7998);
    expect(exceedsCommandLineUrlCap(percentHeavy)).toBe(false);

    // The page's own two examples, side by side: the same escaped ceiling, half
    // the raw length. That ratio is the claim, not either number alone.
    expect(commandLineEscapedUrlLength(percentHeavy) / percentHeavy.length).toBe(2);
    expect(commandLineEscapedUrlLength(plainUrl(8000)) / 8000).toBe(1);

    // `%` and `&` are the two characters the page names, so neither may be free.
    expect(commandLineEscapedUrlLength('%')).toBe(4);
    expect(commandLineEscapedUrlLength('&')).toBe(4);
    expect(commandLineEscapedUrlLength('a')).toBe(1);
  });

  it('counts one character over the cap as over it, on both documented shapes', () => {
    // Negative/boundary. One character past the cap on each of the page's two
    // shapes — the plain one at 8,001 raw, the percent-heavy at 4,002 raw
    // (4,002 = 8,004 escaped, the next multiple of three past 4,000).
    const overPlain = plainUrl(OPEN_URL_COMMAND_LINE_CAP_CHARS + 1);
    expect(exceedsCommandLineUrlCap(overPlain)).toBe(true);
    const overPercent = percentHeavyUrl(1334);
    expect(overPercent.length).toBe(4002);
    expect(commandLineEscapedUrlLength(overPercent)).toBe(8004);
    expect(exceedsCommandLineUrlCap(overPercent)).toBe(true);
  });

  it('refuses through the REAL fallback, by name, in a process the electron mock does not reach', async () => {
    // The wiring, not just the predicate — and it needs a child. This repo's
    // `bunfig.toml` preloads an electron mock for `bun run` AND `bun test`, and
    // that mock's `shell.openExternal` resolves, so in-process `openUrl` takes
    // its Electron branch and never reaches the fallback the cap guards. The
    // child is launched with a CWD outside the repo, where bunfig does not
    // apply: `import('electron')` then yields the real `index.js` (a string,
    // `shell` undefined), `shell.openExternal` throws, and the fallback runs —
    // which is the shape every non-Electron production process sees.
    const proc = Bun.spawn(['bun', PROBE, plainUrl(OPEN_URL_COMMAND_LINE_CAP_CHARS + 1)], {
      cwd: tmpdir(),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const out = (await new Response(proc.stdout).text()).trim();
    await proc.exited;

    expect(out.startsWith('REFUSED:')).toBe(true);
    expect(out).toContain('[open-url] Refused:');
    expect(out).toContain(String(OPEN_URL_COMMAND_LINE_CAP_CHARS));
    expect(out).toContain('Respond to MCP elicitation requests');
    expect(out).toContain('can only be declined');
    // Negative control on the same rig: had the child taken the Electron
    // branch — the failure this test exists to rule out — it would print
    // OPENED, and the assertions above would be vacuous.
    expect(out).not.toContain('OPENED');
  }, 60_000);
});
