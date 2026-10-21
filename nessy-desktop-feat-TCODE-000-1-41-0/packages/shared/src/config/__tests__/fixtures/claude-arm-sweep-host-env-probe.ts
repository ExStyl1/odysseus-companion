/**
 * Child-process probe for P6.80(a): what survives the CLAUDE-ARM sweep
 * `clearClaudeCloudProviderRoutingEnvVars()` on the host `process.env`, and
 * what a real grandchild then inherits.
 *
 * This is the second copy of the defect P3.346 fixed. That row narrowed
 * `resetManagedAnthropicAuthEnvVars` (boot) and left this function alone — and
 * this one runs with NO ARGUMENT, i.e. straight on `process.env`, from
 * `claude-agent.ts`'s auth-injection path, once per claude session. So the
 * ordering `claude session → Pi Bedrock session` inside ONE host process
 * reproduced the whole thing with no connection change.
 *
 * A FILE rather than a string written at run time, for the reason its siblings
 * `boot-auth-env-reset-probe.ts` and `managed-env-spread-probe.ts` record: a
 * freshly created temp script pays macOS's first-execution scan on every run,
 * and a fixture under `src/` is typechecked like everything else.
 *
 * Why a child, and why a grandchild inside it:
 *
 *  - The Bun `process.env` unlock is STICKY for the rest of a process, so an
 *    in-suite assertion can pass with the fix removed. Only a fresh child whose
 *    LAUNCH environment carries the names can see the real behaviour.
 *  - Every non-Claude child in this repo is built by spreading the host
 *    `process.env`, so `inherited` — a real grandchild launched from
 *    `{ ...process.env }` — is the verdict that matters: "the subprocess
 *    received it", not "an object literal contained it".
 *
 * EVERY side effect is behind `import.meta.main`. The test imports
 * {@link CLAUDE_ARM_SWEEP_PROBE_NAMES} from here so the two halves cannot
 * drift, and an unguarded body — this one calls `process.exit` — would kill the
 * runner at import time and report exit 0 with ZERO tests executed.
 */
import { spawnSync } from 'node:child_process'
import { clearClaudeCloudProviderRoutingEnvVars } from '../../llm-connections.ts'

/**
 * The names the probe reports on.
 *
 *  - The first four are `CLAUDE_PROVIDER_ENDPOINT_CREDENTIAL_ENV_KEYS`, the set
 *    the host must now preserve. `AWS_BEARER_TOKEN_BEDROCK` is the one with
 *    teeth: pi-ai's `amazon-bedrock` resolver reads it as credential source 3
 *    of 6 and falls through SILENTLY to `AWS_PROFILE` and then to access keys,
 *    so deleting it changes which AWS identity the Bedrock card is, without an
 *    error anywhere.
 *  - `CLAUDE_CODE_USE_BEDROCK` is a provider TOGGLE and must STILL be stripped
 *    from the host — a run where it survives means the sweep was disabled
 *    wholesale rather than narrowed.
 *  - `AWS_REGION` is read by pi-ai but is in no strip list: the surviving
 *    control.
 *  - `P680_ARBITRARY_CONTROL` is in no list at all, so a run where it goes
 *    missing is a broken rig rather than a caught defect.
 */
export const CLAUDE_ARM_SWEEP_PROBE_NAMES = [
  'AWS_BEARER_TOKEN_BEDROCK',
  'ANTHROPIC_BEDROCK_BASE_URL',
  'ANTHROPIC_BEDROCK_MANTLE_BASE_URL',
  'CLAUDE_CODE_SKIP_MANTLE_AUTH',
  'CLAUDE_CODE_USE_BEDROCK',
  'AWS_REGION',
  'P680_ARBITRARY_CONTROL',
] as const

if (import.meta.main) {
  const read = (): Record<string, string | null> =>
    Object.fromEntries(CLAUDE_ARM_SWEEP_PROBE_NAMES.map(name => [name, process.env[name] ?? null]))

  if (process.argv.includes('--report-inherited')) {
    console.log(JSON.stringify(read()))
    process.exit(0)
  }

  const launch = read()

  // The claude arm, verbatim: `claude-agent.ts` calls this with no argument.
  clearClaudeCloudProviderRoutingEnvVars()
  const hostAfterSweep = read()

  // The CHILD arm on the same process, so one run answers both halves: an
  // explicit env object is a subprocess env under construction and still loses
  // all twelve names, which is the layer that has to strip them.
  const childEnv: Record<string, string | undefined> = Object.fromEntries(
    CLAUDE_ARM_SWEEP_PROBE_NAMES.map(name => [name, launch[name] ?? undefined]),
  )
  clearClaudeCloudProviderRoutingEnvVars(childEnv)
  const childEnvAfterSweep = Object.fromEntries(
    CLAUDE_ARM_SWEEP_PROBE_NAMES.map(name => [name, childEnv[name] ?? null]),
  )

  const grandchild = spawnSync(
    process.execPath,
    [import.meta.path, '--report-inherited'],
    { env: { ...process.env }, encoding: 'utf8' },
  )
  console.log(JSON.stringify({
    launch,
    hostAfterSweep,
    childEnvAfterSweep,
    inherited: JSON.parse(grandchild.stdout || '{}') as Record<string, string | null>,
  }))
  process.exit(0)
}
