import { parseBooleanEnv } from '../feature-flags.ts';
import { resolveOptionalNumericSetting } from './numeric-setting.ts';

export interface ResolvedAutoCompactionSettings {
  readonly enabled: boolean;
  readonly thresholdPercent?: number;
  readonly contextWindow?: number;
}

export interface AutoCompactionSettingsInput {
  readonly userEnabled?: boolean;
  readonly managedEnabled?: boolean;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

function runtimeEnv(): Readonly<Record<string, string | undefined>> {
  return typeof process === 'undefined' ? {} : process.env;
}

/**
 * P6.565 · the two keys this file reads sit on OPPOSITE sides of the page's
 * "except" clause, so one function with one rule was wrong for one of them.
 *
 * `env-vars.md#variables` grants scientific notation and digit separators to
 * every numeric variable *"except where a variable's row notes it takes plain
 * digits only"*.
 *
 * - `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` — its row notes nothing of the kind
 *   (*"Set the percentage (1-100) of the auto-compact window at which
 *   auto-compaction triggers…"*), so the GENERAL rule applies.
 * - `CLAUDE_CODE_AUTO_COMPACT_WINDOW` — its row DOES, in its own words:
 *   *"Accepts a plain integer such as `500000` only: a value like `500k` reads
 *   as `500` and clamps to the 100K minimum."* That is a SIXTH plain-digits-only
 *   row, spelled differently from the five `numeric-setting.ts` lists, which is
 *   why a search for the phrase "plain digits" missed it.
 *
 * `undefined` on rejection rather than a fallback is deliberate and unchanged:
 * an unset field here means "this layer says nothing", and each backend then
 * applies its own documented default — a number invented at this layer would
 * override a default we do not know.
 *
 * **P6.708 · what changed is that the rejection is now SAID.** Returning
 * `undefined` is right; doing it in silence was not. An operator writing the
 * page's own refused example — `NESSY_AUTO_COMPACT_WINDOW=500k` — got a session
 * with the runtime's default window and no indication that the value they set
 * had been thrown away, which is the exact failure `numeric-setting.ts`'s header
 * names ("a number that quietly becomes its default is a control that silently
 * stops controlling"). The `name` argument exists only so the diagnostic can
 * quote the variable the operator actually wrote, and
 * {@link resolveOptionalNumericSetting} is the fallback-free reporter, so the
 * sentence never invents a number to fall back to. This function is host-side
 * and shared, so the report is identical on all three runtimes.
 */
function boundedInteger(
  name: string,
  value: string | undefined,
  min: number,
  max: number,
  plainDigitsOnly = false,
): number | undefined {
  return resolveOptionalNumericSetting(name, value, { min, max, plainDigitsOnly });
}

/**
 * Resolve process-lifetime auto-compaction policy. Every layer can narrow:
 * managed/user false and a truthy disable env are terminal; no layer can force
 * another layer back on.
 *
 * ## Where each of the three fields lands, and what it costs (P3.235)
 *
 * `enabled` reaches every backend since P6.53. The two knobs below reached Pi
 * only until P3.235 measured their SDK counterparts, which are DIRECT — so this
 * is configuration, not construction, and the projection plus its measurement
 * live in `agent/claude-auto-compaction-knobs.ts`:
 *
 * | this field         | env                              | claude counterpart                |
 * | ------------------ | -------------------------------- | --------------------------------- |
 * | `thresholdPercent` | `NESSY_AUTOCOMPACT_PCT_OVERRIDE` | `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` |
 * | `contextWindow`    | `NESSY_AUTO_COMPACT_WINDOW`      | `CLAUDE_CODE_AUTO_COMPACT_WINDOW` |
 *
 * ONE residual difference, and it is in the bounds this function applies rather
 * than in the projection. `contextWindow` is accepted here from 1 upward, and
 * the Claude SDK floors its own window env at 100 000 (`settings-reference.md#autocompactwindow`:
 * "number of tokens, from `100000` to `1000000`"). A value below that therefore
 * narrows a Pi session as written and a claude session only to 100 000. The
 * bound is NOT tightened here — Pi obeys the smaller number today and taking
 * that away to make two runtimes agree would be a regression dressed as
 * consistency — so the claude side reports the clamp instead
 * (`claudeAutoCompactionKnobDiagnostics`).
 *
 * What deliberately does NOT cross is the arithmetic each runtime wraps around
 * these: Pi's default reserve is priced off the MCP tool-result cap
 * (`resolvePiAutoCompactionSettings`, live from `NESSY_MCP_OUTPUT_TOKENS`) and
 * the SDK's is `window − 13000`. Both then take `min(default, percent)`, so the
 * knob itself binds the same way on both.
 */
export function resolveAutoCompactionSettings(
  input: AutoCompactionSettingsInput = {},
): ResolvedAutoCompactionSettings {
  const env = input.env ?? runtimeEnv();
  const thresholdPercent = boundedInteger(
    'NESSY_AUTOCOMPACT_PCT_OVERRIDE',
    env.NESSY_AUTOCOMPACT_PCT_OVERRIDE,
    1,
    100,
  );
  const contextWindow = boundedInteger(
    'NESSY_AUTO_COMPACT_WINDOW',
    env.NESSY_AUTO_COMPACT_WINDOW,
    1,
    Number.MAX_SAFE_INTEGER,
    // P6.565 · plain digits only — `CLAUDE_CODE_AUTO_COMPACT_WINDOW`'s own row
    // says so in its own words, and the projection has to mean the same thing
    // on both spellings of the key.
    true,
  );
  return Object.freeze({
    enabled: input.userEnabled !== false
      && input.managedEnabled !== false
      && parseBooleanEnv(env.DISABLE_AUTO_COMPACT) !== true,
    ...(thresholdPercent === undefined ? {} : { thresholdPercent }),
    ...(contextWindow === undefined ? {} : { contextWindow }),
  });
}

/**
 * How many times a context may refill immediately after a SUCCESSFUL compaction
 * before the runtime stops compacting and ends the turn with
 * `auto_compaction_thrashing`.
 *
 * ## Why it lives here rather than beside either guard
 *
 * `how-claude-code-works.md#when-context-fills-up` describes ONE behaviour —
 * "If a single file or tool output is so large that context refills immediately
 * after each summary, Claude Code stops auto-compacting after a few attempts and
 * shows an error instead of looping." — and
 * `troubleshooting.md#auto-compaction-stops-with-a-thrashing-error` fixes the
 * shape of "a few": "automatic compaction succeeded but a file or tool output
 * immediately refilled the context window several times in a row."
 *
 * Until P6.55 the number was a private constant in `pi-agent-server`, so the
 * guard had exactly ONE producer and a second runtime implementing the same
 * documented behaviour would have had to restate it. Two copies of one
 * documented threshold is the silent-divergence class this fork is closing, so
 * the value is shared and both producers import it.
 *
 * ## Why THREE, measured against the resting state and not against zero
 *
 * The count is REFILLS, never compactions: a healthy long turn compacts, and on
 * a small window it can legitimately compact more than once. The floor is
 * therefore "one compaction per turn is normal", not zero — a limit derived
 * from zero fires on the healthy path and manufactures its own failure. Three
 * refills is the smallest bounded reading of "several times in a row" that is
 * still more than a pair, and it means the fourth compaction in an uninterrupted
 * run is the one that trips.
 */
export const AUTO_COMPACTION_THRASHING_REFILL_LIMIT = 3;
