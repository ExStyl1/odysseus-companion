/**
 * Child-process probe for `agent/__tests__/claude-child-env-refusal.test.ts` —
 * the names `buildClaudeSubprocessEnv` DECIDES for the claude child rather than
 * passing through: one it refuses outright (P6.530), one whose default it
 * converges on the other two runtimes (P6.348), and the five telemetry content
 * opt-ins it drops (P6.539).
 *
 * A FILE rather than a string written at run time, for the two reasons its
 * siblings `managed-env-spread-probe.ts` / `claude-telemetry-env-probe.ts`
 * record: a freshly created temp script pays macOS's first-execution scan on
 * every run, and a fixture under `src/` is typechecked like everything else.
 *
 * WHY A CHILD AT ALL. Bun's env-slot unlock is STICKY for the rest of a process,
 * so a suite that deleted a name in its own setup would pass with the refusal
 * REMOVED. The first arm below therefore touches nothing: its value is the
 * launch environment the test gave this process, which is what an operator
 * actually exports.
 *
 * WHY THE OTHER ARMS MUTATE, AND HOW THAT STAYS HONEST. One import of
 * `agent/options.ts` dominates this probe's wall clock (a sibling measured 22.7 s
 * of a 28 s run at load average 11, against 0.5 s of user CPU — contention, not
 * work), so a process per arm would make the suite unaffordable. The remaining
 * arms use `delete` then assign — the documented Bun 1.3.14 workaround — and
 * every arm reports its own inputs back, so an assignment lost to the spread
 * fails a test instead of silently measuring nothing.
 *
 * TWO HOPS per arm:
 *  - `built` is what `buildClaudeSubprocessEnv` returned — the object the SDK is
 *    handed.
 *  - `inherited` is a REAL grandchild launched with that object as its `env`, so
 *    the verdict is "the subprocess received it", not "an object literal
 *    contained it". The grandchild is a bare `bun -e`, deliberately: re-entering
 *    this file would pay the same import cost again per arm.
 */
import { buildClaudeSubprocessEnv } from '../../options.ts'

/** The names the probe reports on, in both hops. */
export const CLAUDE_CHILD_ENV_REFUSAL_NAMES = [
  // P6.530 — the PowerShell tool switch. Refused by name and pinned to the
  // vendor's own off value, because a strip alone leaves the Windows default on.
  'CLAUDE_CODE_USE_POWERSHELL_TOOL',
  // P6.539 — the five OTEL content opt-ins. Dropped by name, never by value:
  // `OTEL_LOG_RAW_API_BODIES` also accepts `file:<dir>`, so a truthiness test
  // would miss the mode that writes the whole conversation to disk.
  'OTEL_LOG_USER_PROMPTS',
  'OTEL_LOG_ASSISTANT_RESPONSES',
  'OTEL_LOG_TOOL_DETAILS',
  'OTEL_LOG_TOOL_CONTENT',
  'OTEL_LOG_RAW_API_BODIES',
  // P6.348 — the Glob ignore knob. Defaulted to the value that makes claude's
  // Glob agree with Pi's `find` and codex's file search, and ONLY defaulted: an
  // operator's own value survives, which is the arm below that proves it.
  'CLAUDE_CODE_GLOB_NO_IGNORE',
  // Positive control ONE — a real `CLAUDE_CODE_*` name in no strip list, so a
  // run where this one also disappears proves the refusal is by PREFIX rather
  // than by name. `claude-provider-routing-env.ts` records it as the bundle's
  // own alphabetical neighbour of the scrubbed shell names.
  'CLAUDE_CODE_SESSION_NAME',
  // Positive control TWO — an arbitrary name rides the spread untouched, so a
  // run in which this one is missing is a broken rig rather than a caught defect.
  'NESSY_W8I_ARBITRARY_CONTROL',
] as const

/** The arms, by name, and what each one puts in `process.env` before building. */
export const CLAUDE_CHILD_ENV_REFUSAL_ARMS = {
  /**
   * Untouched: whatever the test launched this process with, which is the arm
   * that matters — an operator exporting the name in their shell.
   */
  'launch-env': undefined,
  /** Nobody set it. The refusal is unconditional, so the pin must still be there. */
  unset: { CLAUDE_CODE_USE_POWERSHELL_TOOL: undefined },
  /** The operator already asked for off. Nothing to refuse; the value is kept. */
  'operator-off': { CLAUDE_CODE_USE_POWERSHELL_TOOL: '0' },
  /**
   * P6.348's boundary: the operator exported the Glob knob themselves, which is
   * the route the page names (*"set `CLAUDE_CODE_GLOB_NO_IGNORE=false` before
   * launching Claude Code"*). A default that overrode it would be a hidden knob
   * replacing a documented one.
   */
  'glob-operator-override': { CLAUDE_CODE_GLOB_NO_IGNORE: 'true' },
  /**
   * P6.539's `file:<dir>` arm — the value a truthiness test would let through.
   * Set here rather than in the launch env so the launch arm measures the
   * ordinary `=1` case and this one measures the mode that writes untruncated
   * bodies to a directory.
   */
  'otel-raw-bodies-file-mode': { OTEL_LOG_RAW_API_BODIES: 'file:/tmp/nessy-w8i-not-a-real-dir' },
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
 * the two tables above so the halves cannot drift; without the guard that import
 * runs this module's body — including its `process.exit(0)` — inside the TEST
 * process, which terminates the runner at import time and reports exit 0 with
 * ZERO tests executed.
 */
if (import.meta.main) {
  // Captured BEFORE any arm mutates anything: the positive control for every
  // absence assertion in the suite. Without it, "the grandchild did not receive
  // OTEL_LOG_RAW_API_BODIES" is equally consistent with a rig that never set it.
  // Read here rather than re-derived in the test, and read from a spread rather
  // than by `in` — `in` lies for Bun's pre-created slots.
  const spread = { ...process.env }
  const launchEnv: Record<string, string | null> = {}
  for (const name of CLAUDE_CHILD_ENV_REFUSAL_NAMES) launchEnv[name] = spread[name] ?? null

  const arms: Record<string, unknown> = {}

  for (const [arm, values] of Object.entries(CLAUDE_CHILD_ENV_REFUSAL_ARMS)) {
    if (values) applyArm(values)
    const env = buildClaudeSubprocessEnv()

    const built: Record<string, string | undefined> = {}
    for (const name of CLAUDE_CHILD_ENV_REFUSAL_NAMES) built[name] = env[name]

    const script = `console.log(JSON.stringify(Object.fromEntries(${
      JSON.stringify(CLAUDE_CHILD_ENV_REFUSAL_NAMES)
    }.map(n => [n, process.env[n] ?? null]))))`
    const grandchild = Bun.spawnSync({
      cmd: [process.execPath, '-e', script],
      env: env as Record<string, string>,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const out = grandchild.stdout.toString().trim()

    arms[arm] = {
      built,
      inherited: out === '' ? null : JSON.parse(out.split('\n').at(-1)!),
      grandchildStderr: out === '' ? grandchild.stderr.toString() : '',
    }
  }

  console.log(JSON.stringify({ arms, launchEnv }))
  // The config graph leaves the loop alive; exit rather than wait it out.
  process.exit(0)
}
