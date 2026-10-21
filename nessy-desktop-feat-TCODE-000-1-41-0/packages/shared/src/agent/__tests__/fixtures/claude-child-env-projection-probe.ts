/**
 * Child-process probe for `agent/__tests__/claude-child-env-projection.test.ts`
 * — the two names `buildClaudeSubprocessEnv` PROJECTS onto the claude child
 * because the child has its own mechanism and does not know our name for it:
 * `NODE_USE_ENV_PROXY` (P6.255, the claude builder arm) and
 * `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` (P6.696, the claude half).
 *
 * A FILE rather than a string written at run time, for the two reasons its
 * siblings `claude-child-env-refusal-probe.ts` / `managed-env-spread-probe.ts`
 * record: a freshly created temp script pays macOS's first-execution scan on
 * every run, and a fixture under `src/` is typechecked like everything else.
 *
 * WHY A CHILD AT ALL. Both projections are conditional on names an operator
 * exports in their own shell, and one of them — `HTTPS_PROXY` — is a name Bun
 * pre-creates a slot for, so an in-suite `process.env.HTTPS_PROXY = …` is
 * invisible to the `{...process.env}` spread this builder is made of. The unlock
 * is also STICKY for the rest of a process, so a suite that deleted the name in
 * its own setup would pass with the projection removed. The first arm below
 * therefore touches nothing: its value is the launch environment the test gave
 * this process, which is what an operator actually exports.
 *
 * WHY THE OTHER ARMS MUTATE, AND HOW THAT STAYS HONEST. One import of
 * `agent/options.ts` dominates this probe's wall clock, so a process per arm
 * would make the suite unaffordable. The remaining arms use `delete` then assign
 * — the documented Bun 1.3.14 workaround — and every arm reports its own inputs
 * back, so an assignment lost to the spread fails a test instead of silently
 * measuring nothing.
 *
 * TWO HOPS per arm:
 *  - `built` is what `buildClaudeSubprocessEnv` returned — the object the SDK is
 *    handed.
 *  - `inherited` is a REAL grandchild launched with that object as its `env`, so
 *    the verdict is "the subprocess received it", not "an object literal
 *    contained it". The grandchild is a bare `bun -e`, deliberately: re-entering
 *    this file would pay the same import cost again per arm.
 *
 * The test launches this probe with `NESSY_CONFIG_DIR` pointing at an empty temp
 * directory, so the in-app proxy settings `getProxyEnvVars()` reads cannot make
 * the developer's own machine decide an arm.
 */
import { buildClaudeSubprocessEnv } from '../../options.ts'

/** The names the probe reports on, in both hops. */
export const CLAUDE_CHILD_ENV_PROJECTION_NAMES = [
  // P6.255 — the gate that decides whether the proxy variables we already set
  // are read at all by the child's undici-based HTTP client.
  'NODE_USE_ENV_PROXY',
  // P6.696 — the vendor's spelling of the host's background-task off switch.
  'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS',
  // The inputs each projection is conditional on, reported so an arm whose
  // assignment was lost to Bun's env-slot behaviour fails loudly.
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'NESSY_DISABLE_BACKGROUND_TASKS',
  // Positive control — an arbitrary name rides the spread untouched, so a run in
  // which this one is missing is a broken rig rather than a caught defect.
  'NESSY_W7S1_ARBITRARY_CONTROL',
] as const

/** The arms, by name, and what each one puts in `process.env` before building. */
export const CLAUDE_CHILD_ENV_PROJECTION_ARMS = {
  /**
   * Untouched: whatever the test launched this process with — an operator with a
   * proxy exported in their shell and the host's background-task switch on.
   * Both projections must fire.
   */
  'launch-env': undefined,
  /**
   * Neither condition holds. Both names must stay ABSENT rather than be written
   * with an off value: `NODE_USE_ENV_PROXY=0` and
   * `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=0` are not "unset", they are the
   * child's own opposite decision, and writing one would overrule a setting the
   * child resolves for itself.
   */
  'neither-configured': {
    HTTPS_PROXY: undefined,
    https_proxy: undefined,
    HTTP_PROXY: undefined,
    http_proxy: undefined,
    NESSY_DISABLE_BACKGROUND_TASKS: undefined,
  },
  /**
   * The operator set the vendor spellings themselves, in the direction that
   * DISABLES what we would have enabled. An operator who wrote the name has
   * already decided, in either direction, and is never overridden — otherwise
   * our projection is a hidden knob replacing a documented one.
   */
  'operator-decided': {
    HTTPS_PROXY: 'http://launch.proxy.invalid:3128',
    NESSY_DISABLE_BACKGROUND_TASKS: '1',
    NODE_USE_ENV_PROXY: '0',
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '0',
  },
  /**
   * The boundary for P6.255: only the LOWERCASE spelling is exported. It is the
   * one `network-config.md` names first, and a gate that only looked at the
   * uppercase pair would leave exactly that operator's proxy inert.
   */
  'lowercase-proxy-only': {
    HTTPS_PROXY: undefined,
    NODE_USE_ENV_PROXY: undefined,
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: undefined,
    NESSY_DISABLE_BACKGROUND_TASKS: undefined,
    http_proxy: 'http://lowercase.proxy.invalid:3128',
  },
} as const satisfies Record<string, Record<string, string | undefined> | undefined>

/**
 * `delete` first, then assign — on the unset path too. Assigning straight to
 * `process.env.X` in Bun 1.3.14 can leave the name readable by property and
 * INVISIBLE to `{...process.env}`, which is how this builder makes a child env.
 * Every name in the proxy family is one Bun pre-creates a slot for, so this is
 * the arm where it bites.
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
  // absence assertion in the suite. Read from a spread rather than by `in` —
  // `in` lies for Bun's pre-created slots.
  const spread = { ...process.env }
  const launchEnv: Record<string, string | null> = {}
  for (const name of CLAUDE_CHILD_ENV_PROJECTION_NAMES) launchEnv[name] = spread[name] ?? null

  const arms: Record<string, unknown> = {}

  for (const [arm, values] of Object.entries(CLAUDE_CHILD_ENV_PROJECTION_ARMS)) {
    if (values) applyArm(values)
    const env = buildClaudeSubprocessEnv()

    const built: Record<string, string | undefined> = {}
    for (const name of CLAUDE_CHILD_ENV_PROJECTION_NAMES) built[name] = env[name]

    const script = `console.log(JSON.stringify(Object.fromEntries(${
      JSON.stringify(CLAUDE_CHILD_ENV_PROJECTION_NAMES)
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
