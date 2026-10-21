/**
 * The ONE tier whose marketplace `headersHelper` command this app runs: a
 * marketplace that MANAGED settings themselves declare (P6.479, owner decision
 * 2026-09-05 Q7, option C).
 *
 * ## What the page says, and which half is here
 *
 * `plugins/host-marketplace.md#authenticate-archive-downloads` (fetched 2026-09-07,
 * `https://code.claude.com/docs/en/plugin-marketplaces.md`) puts a
 * `headersHelper` in two places, and they are governed differently:
 *
 *   "If the value you would put in `headers` is short-lived, such as a token
 *   your registry mints on request, set a `headersHelper` command in the same
 *   place instead. Claude Code runs the command and sends the JSON object it
 *   prints as that place's headers."
 *
 * The PLUGIN ENTRY place is refused here and permanently — a catalog's own
 * command, gated on the page by a per-install acceptance dialog this fork does
 * not build. That refusal is `plugins/archive-headers.ts`.
 *
 * The MARKETPLACE `url` SOURCE place is this module, and only when the source
 * is one MANAGED settings declare (`extraKnownMarketplaces`). The page's own
 * reason for treating that tier differently, from
 * `#when-a-marketplace-url-sources-command-runs`:
 *
 *   "A marketplace `url` source's `headersHelper` is declared in a settings
 *   file … rather than in the catalog the marketplace publishes, so Claude Code
 *   doesn't ask the user to accept it on each install or update."
 *
 * and the row for our tier — "a managed settings file on the machine" — reads
 * "Without asking, including during a background marketplace refresh". Our
 * `extraKnownMarketplaces` is parsed out of the root-owned `managed-policy.json`
 * (plus its `managed-policy.d/`), so the command is written by whoever already
 * owns the machine's policy file.
 *
 * `#when-claude-code-skips-a-headershelper-command-or-drops-its-output` also
 * makes this tier the exception that survives the operator's own off switch:
 *
 *   "Under either block, Claude Code still runs the command for a marketplace
 *   that managed settings themselves declare."
 *
 * so `disableCommandPluginSources` and `allowManagedHooksOnly` are deliberately
 * NOT consulted here. They still refuse every other command source, which is
 * the whole of what they governed before this module existed.
 *
 * ## The gates, each one the page's own sentence
 *
 * From `#write-the-headershelper-command`:
 *
 *  - "**Command text**: at most 500 characters of printable ASCII, with no run
 *    of four or more spaces." — {@link isDocumentedHelperCommandText}. A command
 *    outside that shape is NOT RUN; the fetch proceeds with the static `headers`
 *    alone, which is the behaviour the page gives its neighbouring skip
 *    conditions ("sends only the headers listed in its `headers` field"). Where
 *    the page is silent — it states this as a requirement on the author, not as
 *    a skip condition — the choice is the smaller one and it is stated in the
 *    outcome this module returns rather than left to a 401.
 *  - "**Output**: print one JSON object of header names and string values on
 *    stdout, then exit 0 within 10 seconds." — the runner in
 *    `../mcp/headers-helper.ts` already implements exactly this contract, so it
 *    is reused rather than copied.
 *  - "**Shell and working directory**: Claude Code runs the command through
 *    `sh`, or `cmd.exe` on Windows, from the configuration directory" — the
 *    runner's `shell: true` plus `cwd` = this fork's own configuration
 *    directory, `CONFIG_DIR`, which is the Nessy spelling of the `~/.claude` the
 *    page names.
 *  - "**Variables Claude Code removes**: … Claude Code doesn't apply this
 *    removal to a command set in user settings, a `--settings` file, or managed
 *    settings." — so there is deliberately NO env scrub on this path. The tier
 *    that gets the scrub is the tier this module refuses to run at all.
 *  - "**Variables Claude Code sets**: `CLAUDE_CODE_MARKETPLACE_URL` and
 *    `CLAUDE_CODE_MARKETPLACE_NAME` for a `url` source's command" — passed
 *    through the runner's `extraEnv`. The runner also sets its own
 *    `CLAUDE_CODE_MCP_SERVER_NAME`/`_URL` pair, to the same marketplace name and
 *    URL: the page's list says which variables Claude Code SETS, not which ones
 *    it withholds, and one runner with two spellings of the same two values is
 *    smaller than two runners.
 *
 * From `#when-claude-code-skips-a-headershelper-command-or-drops-its-output`:
 *
 *  - "**Marketplace URL doesn't start with `https://`**: Claude Code doesn't run
 *    that `url` source's command and sends only the headers listed in its
 *    `headers` field." — {@link resolveManagedMarketplaceHeaders} returns
 *    `not-run` with that reason and the caller keeps its static headers.
 *  - "**Command fails**: if the command exits non-zero, runs past 10 seconds, or
 *    prints anything other than a JSON object of string values, Claude Code
 *    doesn't make the fetch or download it ran the command for." — FAIL-CLOSED,
 *    and the opposite polarity to the MCP caller of the same runner, which
 *    degrades to static headers. Both are their own page's answer; the runner
 *    itself takes no position.
 *  - "Claude Code drops request-routing and client-identity names such as
 *    `Host`, `Cookie`, and `X-Forwarded-*` … and keeps authentication names such
 *    as `Authorization`." — the command's OUTPUT goes through the same
 *    `filterDeclaredRequestHeaders` the static `headers` already pass through.
 *
 * From the place table: "Before each fetch of the marketplace's
 * `marketplace.json` and before each archive download on that origin. Claude
 * Code reuses one run's output for up to 60 seconds." — {@link
 * MANAGED_HEADERS_HELPER_REUSE_MS}. The reuse window is what makes the second
 * clause affordable here: a named install refreshes its marketplace first
 * (`refreshForInstall`), so one run covers the catalog fetch and the archive
 * download that follows it, and the archive download inherits the minted headers
 * through the same same-origin path P6.177 built for static ones.
 *
 * ## Two limits, stated rather than discovered
 *
 * **The approval tier cannot be told apart here.** The page gives
 * server-managed settings their own row — the command runs "Only after the user
 * approves the delivered settings in the security approval dialog" — and this
 * fork does implement that gate, one layer up in
 * `config/managed-delivery.ts` + `config/managed-approval.ts`. But the policy
 * slice this module is handed is the COMPOSED one, with no record of which
 * source delivered a given entry, so on a host with no approval gate wired
 * (`managed-delivery.ts`'s "applied for this run, never cached" shape) a
 * server-delivered entry's command would run where the page says the fetch
 * should fail instead. Closing that needs an origin on the composed entry, which
 * is a managed-composition change, not a marketplace one.
 *
 * **A minted header reaches the on-disk catalog cache**, exactly as a static one
 * already does: the fetch's headers ride the resolved source into the parsed
 * items (`registry-catalog-fetcher.ts`), and a successful entry is persisted.
 * The minted value expires, which the static one does not, so this row makes an
 * existing exposure smaller rather than larger — but it is an exposure and it is
 * named here so the next reader does not have to rediscover it.
 */
import { CONFIG_DIR } from '../config/paths.ts';
import { filterDeclaredRequestHeaders } from '../plugins/request-header-filter.ts';
import { McpHeadersHelperError, resolveMcpDynamicHeaders } from '../mcp/headers-helper.ts';

/** "Claude Code reuses one run's output for up to 60 seconds." */
export const MANAGED_HEADERS_HELPER_REUSE_MS = 60_000;

/** "at most 500 characters of printable ASCII, with no run of four or more spaces." */
export const MANAGED_HEADERS_HELPER_MAX_COMMAND_CHARS = 500;

/**
 * The command-text rule, spelled as three independent clauses so a refusal can
 * say which one failed.
 */
export function isDocumentedHelperCommandText(command: string): boolean {
  if (command.length === 0 || command.length > MANAGED_HEADERS_HELPER_MAX_COMMAND_CHARS) return false;
  // Printable ASCII: space (0x20) through `~` (0x7E). A tab, a newline or any
  // non-ASCII byte is outside the documented shape.
  for (let index = 0; index < command.length; index += 1) {
    const code = command.charCodeAt(index);
    if (code < 0x20 || code > 0x7e) return false;
  }
  return !command.includes('    ');
}

export type ManagedHeadersHelperOutcome =
  /** The command ran and its (filtered) output is the marketplace's headers. */
  | { readonly state: 'headers'; readonly headers: Record<string, string>; readonly fromCache: boolean }
  /**
   * The command was NOT run and the caller keeps its static headers — the two
   * documented skip conditions this tier can meet.
   */
  | { readonly state: 'not-run'; readonly reason: 'not-https' | 'command-text' }
  /** The command ran and failed. The caller makes no fetch. */
  | { readonly state: 'failed'; readonly reason: string };

export interface ManagedHeadersHelperRequest {
  /** `CLAUDE_CODE_MARKETPLACE_NAME` — always set here: a managed entry names itself. */
  readonly marketplaceName: string;
  /** `CLAUDE_CODE_MARKETPLACE_URL` — the `url` source, which is also the https subject. */
  readonly url: string;
  /** The command, verbatim from managed settings. */
  readonly command: string;
}

interface ReuseSlot {
  readonly headers: Record<string, string>;
  readonly expiresAt: number;
}

/**
 * Process-wide reuse, keyed by every input that could change the answer. Keyed
 * on the COMMAND too, so an administrator who rewrites the command in the policy
 * is not served the previous command's token for up to a minute.
 */
const reuse = new Map<string, ReuseSlot>();

/** Test seam only — production never needs to forget a slot early. */
export function clearManagedHeadersHelperReuse(): void {
  reuse.clear();
}

/**
 * Run one managed marketplace's `headersHelper`, or say why it was not run.
 *
 * `options.now` and `options.timeoutMs` are TEST seams; production uses the
 * clock and the runner's documented 10-second budget.
 */
export async function resolveManagedMarketplaceHeaders(
  request: ManagedHeadersHelperRequest,
  options: { now?: () => number; timeoutMs?: number; cwd?: string } = {},
): Promise<ManagedHeadersHelperOutcome> {
  const command = request.command.trim();
  if (!isDocumentedHelperCommandText(command)) return { state: 'not-run', reason: 'command-text' };
  // `URL` is deliberately not parsed here: the page's condition is written on
  // the literal text ("doesn't start with `https://`"), and a scheme check that
  // accepted anything a parser normalises into https would be a wider gate than
  // the sentence.
  if (!request.url.startsWith('https://')) return { state: 'not-run', reason: 'not-https' };

  const now = options.now ?? Date.now;
  const key = `${request.marketplaceName}\u0000${request.url}\u0000${command}`;
  const cached = reuse.get(key);
  const at = now();
  if (cached && cached.expiresAt > at) {
    return { state: 'headers', headers: { ...cached.headers }, fromCache: true };
  }

  let printed: Record<string, string>;
  try {
    printed = await resolveMcpDynamicHeaders(
      {
        command,
        cwd: options.cwd ?? CONFIG_DIR,
        extraEnv: {
          CLAUDE_CODE_MARKETPLACE_URL: request.url,
          CLAUDE_CODE_MARKETPLACE_NAME: request.marketplaceName,
        },
      },
      { serverName: request.marketplaceName, url: request.url },
      { ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }) },
    );
  } catch (error) {
    // The REASON, never the output: a failing helper's message may quote the
    // very value the stdout contract exists to keep out of logs. The runner
    // already guarantees its messages carry exit codes and reasons only.
    return {
      state: 'failed',
      reason: error instanceof McpHeadersHelperError
        ? error.reason
        : 'spawn-error',
    };
  }

  // Same name filter as the static `headers`: one credential filter, one rule.
  const filtered = filterDeclaredRequestHeaders(printed);
  const headers = filtered?.headers ?? {};
  reuse.set(key, { headers, expiresAt: at + MANAGED_HEADERS_HELPER_REUSE_MS });
  return { state: 'headers', headers: { ...headers }, fromCache: false };
}
