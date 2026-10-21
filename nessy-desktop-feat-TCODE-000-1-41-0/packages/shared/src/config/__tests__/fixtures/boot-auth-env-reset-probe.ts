/**
 * Child-process probe for P3.346: which managed-auth names survive
 * `resetManagedAnthropicAuthEnvVars()` and actually reach a subprocess.
 *
 * A FILE rather than a string written at run time, for the two reasons its
 * siblings `managed-env-spread-probe.ts` and `proxy-env-spread-probe.ts` record:
 * a freshly created temp script pays macOS's first-execution scan on every run,
 * and a fixture under `src/` is typechecked like everything else.
 *
 * It must run in a process whose launch environment actually CARRIES the names,
 * and it must read the answer out of a real grandchild:
 *
 *  - `MANAGED_ANTHROPIC_AUTH_ENV_BASELINE` is captured at MODULE LOAD, so a test
 *    that sets `process.env` after importing `llm-connections.ts` measures a
 *    baseline taken before its own setup. Only a fresh child can supply a
 *    launch environment.
 *  - The Bun `process.env` unlock is sticky for the rest of a process, so an
 *    in-process assertion can pass with the fix removed.
 *  - `spread` is what every spawn site in this repo performs
 *    (`{ ...process.env }`); `inherited` is a REAL grandchild launched with that
 *    spread, so the verdict is "the subprocess received it" rather than "an
 *    object literal contained it".
 *
 * EVERY side effect is behind `import.meta.main`. The test imports
 * {@link BOOT_AUTH_ENV_PROBE_NAMES} from here so the two halves cannot drift,
 * and an unguarded body — this one calls `process.exit` — kills the runner at
 * import time and reports exit 0 with ZERO tests executed.
 */
import { spawnSync } from 'node:child_process'
import { resetManagedAnthropicAuthEnvVars } from '../../llm-connections.ts'

/**
 * The names the probe reports on.
 *
 *  - The first two are the endpoint/credential companions P3.346 restores.
 *  - `CLAUDE_CODE_USE_BEDROCK` is a provider TOGGLE and must still be stripped —
 *    a run where it survives means the strip was disabled wholesale rather than
 *    narrowed.
 *  - `AWS_REGION` is in the baseline but was never in the stripped set: it is
 *    the surviving control that proves the fixture restores what it should.
 *  - `P3346_ARBITRARY_CONTROL` is in no list at all, so a run where it goes
 *    missing is a broken rig rather than a caught defect.
 */
export const BOOT_AUTH_ENV_PROBE_NAMES = [
  'AWS_BEARER_TOKEN_BEDROCK',
  'ANTHROPIC_BEDROCK_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'AWS_REGION',
  'P3346_ARBITRARY_CONTROL',
] as const

if (import.meta.main) {
  const read = (): Record<string, string | null> =>
    Object.fromEntries(BOOT_AUTH_ENV_PROBE_NAMES.map(name => [name, process.env[name] ?? null]))

  if (process.argv.includes('--report-inherited')) {
    console.log(JSON.stringify(read()))
    process.exit(0)
  }

  const launch = read()
  resetManagedAnthropicAuthEnvVars()
  const spread = read()
  const grandchild = spawnSync(
    process.execPath,
    [import.meta.path, '--report-inherited'],
    { env: { ...process.env }, encoding: 'utf8' },
  )
  console.log(JSON.stringify({
    launch,
    spread,
    inherited: JSON.parse(grandchild.stdout || '{}') as Record<string, string | null>,
  }))
  process.exit(0)
}
