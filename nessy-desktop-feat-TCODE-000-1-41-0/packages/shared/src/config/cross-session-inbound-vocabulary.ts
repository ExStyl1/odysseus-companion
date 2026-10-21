/**
 * The cross-session-inbound VOCABULARY — the three accepted values, their type,
 * and the operator env-var name. Nothing else, and deliberately nothing else.
 *
 * WHY IT IS ITS OWN MODULE (P6.971, 2026-09-10). These three names were declared
 * in `config/storage.ts`, and `AppSettingsPage.tsx` imported them from there.
 * That single import edge was the entire second chain of the release blocker:
 * `storage.ts` reads `fs`, `path` and `crypto`, and through it the RENDERER
 * bundle reached **175 modules that import a node builtin BY NAME** — the whole
 * of `sources/*`, `sessions/*`, `automations/*`, `session-tools-core` and the
 * Claude Agent SDK. In a Vite production build every browser-externalized
 * builtin resolves to one stub whose body is `export default {}`, so each of
 * those named imports is a HARD rollup error; `build-dmg.sh` failed on the first
 * one and would have failed on the next 174 one at a time.
 *
 * Measured by walking value-only static imports from the four renderer entries:
 * with the edge in place, 1026 modules and 175 named-builtin importers reached;
 * with this module in its place, **830 modules and 0**. One edge, all of it.
 *
 * So the rule this file exists to keep: a constant the RENDERER needs lives in a
 * module with no Node import, and `storage.ts` re-exports it for the main-process
 * callers that already name it. Adding an `fs`/`path`/`crypto` import here — or
 * an import of a module that has one — puts the whole of the main process back in
 * the renderer bundle and fails the packaged build.
 */

/**
 * P6.182 clause (i) · `accept` | `hold` | `refuse`, spelled exactly as the vendor
 * spells it (`crossSessionInbound?: 'accept' | 'hold' | 'refuse'`,
 * `claude-agent-sdk` 0.3.233 `sdk.d.ts`).
 */
export const CROSS_SESSION_INBOUND_SETTINGS = ['accept', 'hold', 'refuse'] as const;

export type CrossSessionInboundSetting = (typeof CROSS_SESSION_INBOUND_SETTINGS)[number];

/**
 * The operator control this host substitutes for the page's "managed settings or
 * the `--settings` flag".
 *
 * P6.872 · READ AS THE MANAGED HALF of that pair, and the difference is visible:
 * `settings-reference.md#crosssessioninbound` treats an unrecognized value in a
 * user/project/local/`--settings` file as a HOLD and one in managed settings as a
 * REFUSE, and this variable is set where the machine is provisioned rather than in
 * a file the session's user can open. Both page sentences are quoted at
 * `resolveCrossSessionInboundMode` (`server-core/src/sessions/cross-session-inbound.ts`),
 * which is the reader that enforces it.
 *
 * DUPLICATED BY NECESSITY, AND PINNED: the enforcement point is
 * `server-core/src/sessions/cross-session-inbound.ts`, which exports the same
 * literal as `CROSS_SESSION_INBOUND_ENV` and cannot be imported from this
 * package (server-core depends on shared, not the other way round).
 * `never-persist`-style drift is prevented by
 * `cross-session-inbound.test.ts`, which asserts the two equal — the pattern
 * `unattended-approval-defaults.test.ts` uses for its four sites.
 */
export const CROSS_SESSION_INBOUND_ENV_NAME = 'NESSY_CROSS_SESSION_INBOUND';

/**
 * DA1.72 — MOVED HERE FROM `config/storage.ts`, unchanged.
 *
 * `config/validators.ts` imported the two functions below from `storage.ts`,
 * and that import was one of the two edges that put the whole config graph
 * behind `loadStoredConfig`: `stored-config-load.ts` needs
 * `StoredConfigTopLevelSchema`, `validators.ts` imported `storage.ts`, and
 * `storage.ts` imports `credentials`, `sessions` and `docs`. The value they
 * render is this module's own vocabulary, so this is where they belonged
 * anyway — the header above already says so in as many words.
 */
/**
 * P6.866/P6.868 · render an unrecognized value for the warning that names it.
 *
 * Here rather than beside the resolver so there is ONE renderer: the enforcement
 * module (`server-core/src/sessions/cross-session-inbound.ts`) reads the two
 * settings FILES, this module reads the user rung, and two spellings of the same
 * quoted value in one warning family is exactly the drift a shared home prevents.
 *
 * `JSON.stringify` does two jobs: it quotes a string the way the page's own
 * warning quotes it (*received `"reject"`*), and it escapes the control
 * characters a settings file can carry into a log line. Truncated first for a
 * string, after for anything else, so the bound holds either way.
 */
export const CROSS_SESSION_INBOUND_VALUE_MAX = 64;

export function describeUnrecognizedCrossSessionInbound(value: unknown): string {
  const clamp = (text: string): string =>
    text.length > CROSS_SESSION_INBOUND_VALUE_MAX
      ? `${text.slice(0, CROSS_SESSION_INBOUND_VALUE_MAX)}…`
      : text;
  if (typeof value === 'string') return JSON.stringify(clamp(value));
  try {
    return clamp(JSON.stringify(value) ?? String(value));
  } catch {
    return clamp(String(value));
  }
}

/**
 * P6.939 · the page's warn-and-hold sentence, and the ONE place it is written.
 *
 * `errors.md#crosssessioninbound-must-be-one-of-accept-hold-refuse` prints the
 * user/project/local wording as a fenced block, verbatim:
 *
 *   `"crossSessionInbound" must be one of "accept", "hold", "refuse"; received
 *   "reject". This value was ignored; while it is present, cross-session
 *   messages are held for your approval instead of being delivered. Set it to
 *   one of the values above.`
 *
 * TWO SURFACES SAID DIFFERENT THINGS ABOUT ONE TYPO, and the second only became
 * proactive recently. `StoredConfigSchema` types this key as an enum, so
 * `validateConfig()` named a bad value — with zod's bare list and none of the
 * page's three clauses (the value was ignored, messages are held meanwhile, fix
 * it to clear the hold). The enforcement module
 * (`server-core/src/sessions/cross-session-inbound.ts`) said the page's whole
 * sentence, for the two `.claude/` files AND the user rung. P6.874 measured that
 * two voices were then the smaller answer because the validator reached nobody
 * unasked; P6.878 (`d402a36af` + `2e1fe2e8a`) gave `doctor-collectors.ts` a
 * collector that calls `validateConfig()`, so the settings-doctor page and the
 * CLI doctor now both name a bad value without anyone asking — and the trigger
 * that paragraph named for merging fired.
 *
 * It lives HERE because `packages/shared` cannot import `packages/server-core`
 * (the dependency runs the other way), beside
 * {@link describeUnrecognizedCrossSessionInbound} so the sentence and the value
 * it quotes have one home between them.
 *
 * It takes an ALREADY-RENDERED value, so the P6.868 rule holds unchanged: one
 * renderer, called by both callers, and no second spelling of the same value.
 * The SCOPE PREFIX stays the enforcement module's: only that module reads three
 * files and can say which one holds the value, which is the one thing the
 * vendor's line cannot carry (*"The warning's second sentence depends on which
 * file holds the value"*).
 */
export function crossSessionInboundUnrecognizedSentence(rendered: string): string {
  return '"crossSessionInbound" must be one of "accept", "hold", "refuse"; '
    + `received ${rendered}. This value was ignored; while it is present, `
    + 'cross-session messages are held for your approval instead of being delivered. '
    + 'Set it to one of the values above.';
}
