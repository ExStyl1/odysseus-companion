/**
 * P3.346 — the boot env reset must not delete a credential a DIFFERENT runtime
 * reads.
 *
 * `resetManagedAnthropicAuthEnvVars` is awaited by
 * `SessionManager.reinitializeAuth` from `initialize()` in both hosts. It
 * restores every managed-auth name to its launch value except the ones in
 * `CLAUDE_SDK_STRIPPED_ENV_KEYS`, which it force-deleted — including
 * `AWS_BEARER_TOKEN_BEDROCK`. Every non-Claude child in this repo is built by
 * spreading the host `process.env`, and `pi-ai`'s `amazon-bedrock` resolver
 * reads that token as credential source 3 of 6, falling through to `AWS_PROFILE`
 * and then to access keys. So the deletion did not fail loudly; it silently
 * changed which AWS identity the Bedrock card authenticates as.
 *
 * ## Why a child process, and why a grandchild inside it
 *
 * The baseline map is captured at MODULE LOAD, so a test that mutates
 * `process.env` after importing `llm-connections.ts` measures a baseline taken
 * before its own setup — it cannot see this at all. And the Bun `process.env`
 * unlock is sticky for the rest of a process, so an in-process assertion can
 * pass with the fix removed. The fixture therefore runs in a throwaway child
 * with the names in its LAUNCH environment, and reports what a real grandchild
 * spawned from `{ ...process.env }` actually inherited.
 *
 * No real credential appears here: every value is an obvious stub.
 */
import { describe, it, expect } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { BOOT_AUTH_ENV_PROBE_NAMES } from './fixtures/boot-auth-env-reset-probe.ts'

const PROBE = join(import.meta.dir, 'fixtures', 'boot-auth-env-reset-probe.ts')

/** Stubs, never credentials — the probe only reports presence. */
const LAUNCH_ENV: Record<string, string> = {
  AWS_BEARER_TOKEN_BEDROCK: 'stub-bearer-not-a-real-token',
  ANTHROPIC_BEDROCK_BASE_URL: 'https://stub.invalid',
  CLAUDE_CODE_USE_BEDROCK: '1',
  AWS_REGION: 'eu-north-1',
  P3346_ARBITRARY_CONTROL: 'control',
}

type Report = {
  launch: Record<string, string | null>
  spread: Record<string, string | null>
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

describe('resetManagedAnthropicAuthEnvVars — the host env at boot', () => {
  it('restores the endpoint/credential companions, strips the toggle, keeps the controls', () => {
    const report = runProbe()

    // The rig proves itself first: every name really was present at launch.
    for (const name of BOOT_AUTH_ENV_PROBE_NAMES) {
      expect({ name, atLaunch: report.launch[name] }).toEqual({ name, atLaunch: LAUNCH_ENV[name] })
    }

    // THE FIX. Both companions survive the reset and reach a real grandchild —
    // which is what Pi's Bedrock card needs, since `buildAwsEnv` never
    // re-supplies the token.
    for (const name of ['AWS_BEARER_TOKEN_BEDROCK', 'ANTHROPIC_BEDROCK_BASE_URL'] as const) {
      expect({ name, spread: report.spread[name], inherited: report.inherited[name] })
        .toEqual({ name, spread: LAUNCH_ENV[name], inherited: LAUNCH_ENV[name] })
    }

    // THE NARROWING, not a removal: a provider TOGGLE is still stripped. A run
    // where this survives means the host strip was disabled wholesale.
    expect(report.spread.CLAUDE_CODE_USE_BEDROCK).toBeNull()
    expect(report.inherited.CLAUDE_CODE_USE_BEDROCK).toBeNull()

    // Controls. `AWS_REGION` is in the baseline and was never stripped;
    // `P3346_ARBITRARY_CONTROL` is in no list at all. Either going missing is a
    // broken rig rather than a caught defect.
    expect(report.inherited.AWS_REGION).toBe(LAUNCH_ENV.AWS_REGION!)
    expect(report.inherited.P3346_ARBITRARY_CONTROL).toBe(LAUNCH_ENV.P3346_ARBITRARY_CONTROL!)

    // Budget against the MEASURED FLOOR, added by P6.80. Timed directly at load
    // ~9 the probe takes 19.81 s — a bun child importing `llm-connections.ts`
    // plus a real grandchild — so bun's 5 s default was always below the floor
    // and this suite failed with an empty stdout and no assertion of its own.
  }, 120_000)
})
