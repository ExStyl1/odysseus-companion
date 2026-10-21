/**
 * Child-process probe for `agent/__tests__/claude-telemetry-optout.test.ts`
 * (P6.483) — the two vendor-neutral opt-out names, read from the environment an
 * operator actually exports.
 *
 * A FILE rather than a string written at run time, for the reasons its siblings
 * record: a freshly created temp script pays macOS's first-execution scan on
 * every run, and a fixture under `src/` is typechecked like everything else.
 *
 * WHY A CHILD. The row's `done_means` names it: *"measured on a THROWAWAY child
 * and never by overwriting an inherited value, because of Bun's env-slot trap"*.
 * The first arm therefore touches nothing — its values are the launch
 * environment the test gave this process, which is what an operator exports —
 * and it is also the CONTROL, because its launch env carries
 * `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`: the name the host writes itself
 * on every gateway session and the one the predicate must NOT read as an
 * opt-out.
 */
import { buildClaudeSubprocessEnv } from '../../options.ts'

/** What the probe reports, in every arm. */
export const CLAUDE_TELEMETRY_OPTOUT_NAMES = [
  'CLAUDE_CODE_ENABLE_TELEMETRY',
  'DO_NOT_TRACK',
  'DISABLE_TELEMETRY',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  'NESSY_ENABLE_TELEMETRY',
] as const

export const CLAUDE_TELEMETRY_OPTOUT_ARMS = {
  /**
   * Untouched. The operator opted IN and the host's own gateway name is set;
   * telemetry must stay on, which is what proves the third name is not read as
   * an opt-out.
   */
  'launch-env': undefined,
  /** The plain case the row is named for. */
  'do-not-track': { DO_NOT_TRACK: '1' },
  /** `DO_NOT_TRACK` is a BOOLEAN, so `0` is not an opt-out. */
  'do-not-track-zero': { DO_NOT_TRACK: '0' },
  /** `DISABLE_TELEMETRY` is SET-AT-ALL, so even `0` opts out. */
  'disable-telemetry-zero': { DO_NOT_TRACK: undefined, DISABLE_TELEMETRY: '0' },
} as const satisfies Record<string, Record<string, string | undefined> | undefined>

/** `delete` first, then assign — on the unset path too (Bun 1.3.14). */
function applyArm(values: Record<string, string | undefined>): void {
  for (const [name, value] of Object.entries(values)) {
    delete process.env[name]
    if (value !== undefined) process.env[name] = value
  }
}

/** Every side effect is behind this guard: the test imports the tables above. */
if (import.meta.main) {
  const spread = { ...process.env }
  const launchEnv: Record<string, string | null> = {}
  for (const name of CLAUDE_TELEMETRY_OPTOUT_NAMES) launchEnv[name] = spread[name] ?? null

  const arms: Record<string, Record<string, string | null>> = {}
  for (const [arm, values] of Object.entries(CLAUDE_TELEMETRY_OPTOUT_ARMS)) {
    if (values) applyArm(values)
    const env = buildClaudeSubprocessEnv()
    const built: Record<string, string | null> = {}
    for (const name of CLAUDE_TELEMETRY_OPTOUT_NAMES) built[name] = env[name] ?? null
    arms[arm] = built
  }

  console.log(JSON.stringify({ arms, launchEnv }))
  process.exit(0)
}
