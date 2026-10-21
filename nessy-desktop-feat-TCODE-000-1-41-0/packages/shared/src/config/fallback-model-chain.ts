/**
 * The fallback-model CHAIN — pure parsing, no Pi SDK.
 *
 * `model-config.md:364` — "Configure one or more fallback models and Claude
 * Code tries them in order, showing a notice when it switches. The switch lasts
 * for the current turn only, so your next message tries the primary model first
 * again. Chains are capped at three models after duplicate removal, and extra
 * entries are ignored."
 *
 * `:366` — "Set a chain for one session with the `--fallback-model` flag, which
 * accepts a comma-separated list"; `:373` persists the same chain as an array
 * in settings; `:381` — "The `--fallback-model` flag takes precedence over the
 * `fallbackModel` setting."
 *
 * WHY ITS OWN MODULE. `config/storage.ts` normalizes the persisted value and is
 * renderer-reachable; `config/models-pi.ts` imports `@earendil-works/pi-ai/compat`
 * and its header forbids exactly that import direction. So the pure rule lives
 * here, where both sides may take it, and anything Pi-aware stays in models-pi.ts.
 */

/** `:364` — "capped at three models after duplicate removal". */
export const FALLBACK_MODEL_CHAIN_LIMIT = 3;

/**
 * The env channel behind the CLI's `--fallback-model` flag.
 *
 * Nessy-only, deliberately unaliased: `:366`'s flag is a launch flag and no
 * Claude env var spells it, so there is no `CLAUDE_CODE_*` twin to pair with.
 * The CLI exports it into the server it spawns the same way `--safe-mode` and
 * print mode already reach the host.
 */
export const FALLBACK_MODEL_ENV_VAR = 'NESSY_FALLBACK_MODEL';

/**
 * Parse any accepted spelling of the chain into an ordered, deduplicated,
 * capped list. `[]` means "no fallback", which is what an empty string, an
 * empty array and any non-string/non-array value all mean.
 *
 * Accepts the legacy scalar forever: `"fallbackModel": ""` is on disk in every
 * install that predates the widening, and a single id stays a valid one-entry
 * chain.
 *
 * ORDER OF OPERATIONS IS THE CONTRACT: split, trim, drop empties, dedupe, and
 * only THEN cap — `:364` says "capped at three models after duplicate removal",
 * so `[a, a, b, c, d]` yields `[a, b, c]` and not `[a, b]`.
 */
export function normalizeFallbackModelChain(raw: unknown): string[] {
  const rawEntries: string[] = [];
  if (typeof raw === 'string') {
    rawEntries.push(...raw.split(','));
  } else if (Array.isArray(raw)) {
    // Array entries are split on commas too, so one comma-separated string
    // inside an array cannot mean something different from the same string on
    // its own. Non-string entries are dropped, never stringified.
    for (const entry of raw) {
      if (typeof entry === 'string') rawEntries.push(...entry.split(','));
    }
  } else {
    return [];
  }

  const chain: string[] = [];
  for (const entry of rawEntries) {
    const trimmed = entry.trim();
    if (!trimmed || chain.includes(trimmed)) continue;
    chain.push(trimmed);
  }
  return chain.slice(0, FALLBACK_MODEL_CHAIN_LIMIT);
}

/**
 * `:381` — the flag beats the setting. A flag chain that normalizes to empty is
 * not a flag chain, so a stray `--fallback-model ""` cannot silently disable a
 * configured one.
 */
export function resolveFallbackModelChain(
  configured: unknown,
  env: Record<string, string | undefined>,
): string[] {
  const fromFlag = normalizeFallbackModelChain(env[FALLBACK_MODEL_ENV_VAR]);
  if (fromFlag.length > 0) return fromFlag;
  return normalizeFallbackModelChain(configured);
}
