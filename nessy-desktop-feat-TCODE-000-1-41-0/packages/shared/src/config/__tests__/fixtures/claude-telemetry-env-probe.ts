/**
 * Child-process probe for `agent/__tests__/telemetry-env-alias-claude-child.test.ts`
 * (P6.178) — does our own telemetry spelling reach the claude child?
 *
 * A FILE rather than a string written at run time, for the two reasons its
 * siblings `managed-env-spread-probe.ts` / `proxy-env-spread-probe.ts` record: a
 * freshly created temp script pays macOS's first-execution scan on every run,
 * and a fixture under `src/` is typechecked like everything else.
 *
 * WHY A CHILD AT ALL. The whole measurement happens here rather than in the test
 * runner because Bun's env-slot unlock is STICKY for the rest of a process: a
 * suite that deleted a name in setup would pass with the fix removed. The FIRST
 * arm below therefore touches nothing — its value is the launch environment the
 * test gave this process, which is what an operator actually sets.
 *
 * WHY THE OTHER ARMS MUTATE, AND HOW THAT STAYS HONEST. One import of
 * `agent/options.ts` costs the great majority of this probe's wall clock
 * (measured 22.7 s of a 28 s run on a loaded box, against 0.5 s of user CPU), so
 * one process per arm would make the suite unaffordable. The remaining arms use
 * `delete` then assign — the documented workaround — and every arm reports
 * `built.NESSY_ENABLE_TELEMETRY` back, so an assignment that did NOT survive the
 * spread shows up as the launch value and fails the test instead of silently
 * measuring nothing.
 *
 * TWO HOPS per arm, the same shape as `managed-env-spread-probe.ts`:
 *  - `built` is what `buildClaudeSubprocessEnv` returned — the object the SDK is
 *    handed.
 *  - `inherited` is a REAL grandchild launched with that object as its `env`, so
 *    the verdict is "the subprocess received it", not "an object literal
 *    contained it". The grandchild is a bare `bun -e`, deliberately: re-entering
 *    this file would pay the same import cost a second time per arm.
 */
import { buildClaudeSubprocessEnv } from '../../../agent/options.ts'

/** The names the probe reports on, in both hops. */
export const CLAUDE_TELEMETRY_PROBE_NAMES = [
  // Ours: the primary spelling, which had no reader inside the claude child.
  'NESSY_ENABLE_TELEMETRY',
  // The vendor's: the ONLY name the shipped SDK's exporter reads.
  'CLAUDE_CODE_ENABLE_TELEMETRY',
  // Positive control: an arbitrary name rides the spread untouched, so a run in
  // which this one is ALSO missing is a broken rig rather than a caught defect.
  'P6178_ARBITRARY_CONTROL',
] as const

/** The arms, by name, and what each one puts in `process.env` before building. */
export const CLAUDE_TELEMETRY_PROBE_ARMS = {
  /** Untouched: whatever the test launched this process with. */
  'launch-env': undefined,
  /** Our name says off, the vendor's says on — our documented precedence. */
  'nessy-off-vendor-on': { NESSY_ENABLE_TELEMETRY: '0', CLAUDE_CODE_ENABLE_TELEMETRY: '1' },
  /** We say nothing; the operator's own spelling must still decide. */
  'vendor-only': { NESSY_ENABLE_TELEMETRY: undefined, CLAUDE_CODE_ENABLE_TELEMETRY: '1' },
  /** Neither name set. */
  neither: { NESSY_ENABLE_TELEMETRY: undefined, CLAUDE_CODE_ENABLE_TELEMETRY: undefined },
} as const satisfies Record<string, Record<string, string | undefined> | undefined>

/**
 * `delete` first, then assign — on the unset path too. Assigning straight to
 * `process.env.X` in Bun 1.3.14 can leave the name readable by property and
 * INVISIBLE to `{...process.env}`, which is how every spawn site in this tree
 * builds a child env.
 */
function applyArm(values: Record<string, string | undefined>): void {
  for (const [name, value] of Object.entries(values)) {
    delete process.env[name]
    if (value !== undefined) process.env[name] = value
  }
}

/**
 * EVERY side effect below is behind `import.meta.main`. The test file imports
 * {@link CLAUDE_TELEMETRY_PROBE_NAMES} from here so the two halves cannot drift;
 * without the guard that import runs this module's body — including its
 * `process.exit(0)` — inside the TEST process, which terminates the runner at
 * import time and reports exit 0 with ZERO tests executed.
 */
if (import.meta.main) {
  const report: Record<string, unknown> = {}

  for (const [arm, values] of Object.entries(CLAUDE_TELEMETRY_PROBE_ARMS)) {
    if (values) applyArm(values)
    const env = buildClaudeSubprocessEnv()

    const built: Record<string, string | undefined> = {}
    for (const name of CLAUDE_TELEMETRY_PROBE_NAMES) built[name] = env[name]

    const script = `console.log(JSON.stringify(Object.fromEntries(${
      JSON.stringify(CLAUDE_TELEMETRY_PROBE_NAMES)
    }.map(n => [n, process.env[n] ?? null]))))`
    const grandchild = Bun.spawnSync({
      cmd: [process.execPath, '-e', script],
      env: env as Record<string, string>,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const out = grandchild.stdout.toString().trim()

    report[arm] = {
      built,
      inherited: out === '' ? null : JSON.parse(out.split('\n').at(-1)!),
      grandchildStderr: out === '' ? grandchild.stderr.toString() : '',
    }
  }

  console.log(JSON.stringify(report))
  // The config graph leaves the loop alive; exit rather than wait it out.
  process.exit(0)
}
