/**
 * P6.80 — the claude-arm sweep must not delete a credential a DIFFERENT runtime
 * reads, and no ambient name may reroute a pinned Pi session.
 *
 * ## (a) The ordering hazard, which was live
 *
 * P3.346 narrowed `resetManagedAnthropicAuthEnvVars` (boot) so the host keeps
 * `CLAUDE_PROVIDER_ENDPOINT_CREDENTIAL_ENV_KEYS`. It left
 * `clearClaudeCloudProviderRoutingEnvVars` alone — and that one is called with
 * NO ARGUMENT, i.e. on `process.env`, from `claude-agent.ts`'s auth-injection
 * path, once per claude session. So `claude session → Pi Bedrock session` in one
 * host process deleted `AWS_BEARER_TOKEN_BEDROCK` again, with no connection
 * change and nothing saying so; pi-ai's `amazon-bedrock` resolver reads it as
 * credential source 3 of 6 and falls through silently to `AWS_PROFILE` and then
 * to access keys, so the failure is a DIFFERENT AWS identity rather than an
 * error.
 *
 * The narrowing is host-only on purpose: an explicit env object is a subprocess
 * env under construction and still loses all twelve, because that is the layer
 * which has to strip them (`agent/options.ts`). Both arms are asserted here off
 * ONE probe run.
 *
 * ## (b) The reroute question, and why it is answered by a provider id
 *
 * Enumerated over the vendored `@earendil-works/pi-ai` (175 dist JS files, read
 * with `find … -type f -exec grep`), pi-ai's ambient reads are NOT the twelve
 * `env("LITERAL")` sites an earlier reading counted: `getProviderEnvValue` takes
 * 25 more literals, among them `AZURE_OPENAI_BASE_URL` — a real base URL — plus
 * `AWS_BEDROCK_SKIP_AUTH` and three OAuth hosts. Every one of them is reached
 * only through a PROVIDER ID (`env-api-keys.js`'s 36-entry map plus
 * `github-copilot`, `anthropic`, `google-vertex`, `amazon-bedrock`), and a
 * pinned session is registered as `custom-endpoint`, which is in none of them,
 * with its base URL and key handed in at `registerProvider`. That reasoning is
 * recorded where it is actionable — the docblock on
 * `clearClaudeCloudProviderRoutingEnvVars` — rather than re-derived here from a
 * vendored tree this suite would then be pinned to.
 *
 * ## Why a child process, and a grandchild inside it
 *
 * The Bun `process.env` unlock is sticky for the rest of a process, so an
 * in-suite assertion can pass with the fix removed; and every non-Claude child
 * in this repo is built by spreading the host `process.env`, so the verdict that
 * matters is what a real grandchild received.
 *
 * No real credential appears here: every value is an obvious stub.
 */
import { describe, it, expect } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { CLAUDE_ARM_SWEEP_PROBE_NAMES } from './fixtures/claude-arm-sweep-host-env-probe.ts'

const PROBE = join(import.meta.dir, 'fixtures', 'claude-arm-sweep-host-env-probe.ts')

/** Stubs, never credentials — the probe only reports presence. */
const LAUNCH_ENV: Record<string, string> = {
  AWS_BEARER_TOKEN_BEDROCK: 'stub-bearer-not-a-real-token',
  ANTHROPIC_BEDROCK_BASE_URL: 'https://stub-bedrock.invalid',
  ANTHROPIC_BEDROCK_MANTLE_BASE_URL: 'https://stub-mantle.invalid',
  CLAUDE_CODE_SKIP_MANTLE_AUTH: '1',
  CLAUDE_CODE_USE_BEDROCK: '1',
  AWS_REGION: 'eu-north-1',
  P680_ARBITRARY_CONTROL: 'control',
}

/** The four the host must keep — `CLAUDE_PROVIDER_ENDPOINT_CREDENTIAL_ENV_KEYS`. */
const PRESERVED = [
  'AWS_BEARER_TOKEN_BEDROCK',
  'ANTHROPIC_BEDROCK_BASE_URL',
  'ANTHROPIC_BEDROCK_MANTLE_BASE_URL',
  'CLAUDE_CODE_SKIP_MANTLE_AUTH',
] as const

type Report = {
  launch: Record<string, string | null>
  hostAfterSweep: Record<string, string | null>
  childEnvAfterSweep: Record<string, string | null>
  inherited: Record<string, string | null>
}

function runProbe(): Report {
  const result = spawnSync(process.execPath, [PROBE], {
    env: { ...process.env, ...LAUNCH_ENV },
    encoding: 'utf8',
    timeout: 60_000,
  })
  expect(result.error).toBeUndefined()
  const line = (result.stdout || '').trim().split('\n').at(-1) ?? ''
  expect(line.startsWith('{')).toBe(true)
  return JSON.parse(line) as Report
}

describe('clearClaudeCloudProviderRoutingEnvVars — the host env on a claude session', () => {
  it('keeps the endpoint/credential four on the host, strips the toggle, and still strips all twelve from a child env', () => {
    const report = runProbe()

    // The rig proves itself first: every name really was present at launch.
    for (const name of CLAUDE_ARM_SWEEP_PROBE_NAMES) {
      expect({ name, atLaunch: report.launch[name] }).toEqual({ name, atLaunch: LAUNCH_ENV[name]! })
    }

    // THE FIX. All four survive the claude-arm sweep and reach a real
    // grandchild, which is what Pi's Bedrock card needs — `buildAwsEnv` never
    // re-supplies the token.
    for (const name of PRESERVED) {
      expect({ name, host: report.hostAfterSweep[name], inherited: report.inherited[name] })
        .toEqual({ name, host: LAUNCH_ENV[name]!, inherited: LAUNCH_ENV[name]! })
    }

    // THE NARROWING, not a removal: a provider TOGGLE is still stripped from the
    // host. A run where this survives means the sweep was disabled wholesale.
    expect(report.hostAfterSweep.CLAUDE_CODE_USE_BEDROCK).toBeNull()
    expect(report.inherited.CLAUDE_CODE_USE_BEDROCK).toBeNull()

    // THE BOUNDARY: an explicit env object is a subprocess env under
    // construction and loses the four as well as the toggle.
    for (const name of [...PRESERVED, 'CLAUDE_CODE_USE_BEDROCK'] as const) {
      expect({ name, childEnv: report.childEnvAfterSweep[name] }).toEqual({ name, childEnv: null })
    }

    // Controls. `AWS_REGION` is read by pi-ai but in no strip list;
    // `P680_ARBITRARY_CONTROL` is in no list at all. Either going missing is a
    // broken rig rather than a caught defect.
    expect(report.inherited.AWS_REGION).toBe(LAUNCH_ENV.AWS_REGION!)
    expect(report.childEnvAfterSweep.AWS_REGION).toBe(LAUNCH_ENV.AWS_REGION!)
    expect(report.inherited.P680_ARBITRARY_CONTROL).toBe(LAUNCH_ENV.P680_ARBITRARY_CONTROL!)
    // Budget against the MEASURED FLOOR, never the default. The probe spawns a
    // bun child that imports `llm-connections.ts` and then a grandchild: timed
    // three times at load ~9 it took 13.07 s / 16.04 s / 17.97 s, so bun's 5 s
    // default is below the floor and the suite would report a timeout with no
    // assertion failure — a shape that reads like starvation and is not.
  }, 120_000)
})
