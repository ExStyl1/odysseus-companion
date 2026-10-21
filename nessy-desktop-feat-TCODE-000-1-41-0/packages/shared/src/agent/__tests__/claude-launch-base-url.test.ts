/**
 * F1.966 — the integration decides the endpoint; the launch environment never
 * overrides it (owner rule, 2026-09-25).
 *
 * A direct Claude connection with no base URL used to take its endpoint from
 * whatever the host's `process.env.ANTHROPIC_BASE_URL` held when
 * `buildClaudeSubprocessEnv` ran: the vendor default right after `postInit`'s
 * delete, and the operator's LAUNCH value again after any connection save, whose
 * reset restores it — so the next turn respawned with the session's key sent to
 * an endpoint the connection never named. The builder now keeps the name only
 * from the session's overrides.
 *
 * The probe runs in a child launched WITH a fabricated value (the defect) and
 * WITHOUT it (the control), for the reason its header gives: the launch value is
 * snapshotted at module load, which no in-suite assignment can reach.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { REJECTED_LAYER_REASON_MAX } from '../../config/managed-drops.ts'
import { LOOPBACK_BASE_URL } from './fixtures/claude-launch-base-url-probe.ts'

const PROBE = fileURLToPath(new URL('./fixtures/claude-launch-base-url-probe.ts', import.meta.url))
const PROBE_BUDGET_MS = 240_000
/** Fabricated. `openrouter` in the host makes the diagnostics label discriminate. */
const LAUNCH_BASE_URL = 'https://f1966-launch.openrouter.invalid/api'

interface ProbeReport {
  arms: Record<string, { hostHas: boolean; child: string | null }>
  runtimeChild: string | null
  providerLabel: string
  record: { source: string; reason: string } | null
}

let configDir: string
let withLaunch: ProbeReport
let withoutLaunch: ProbeReport

async function runProbe(launchBaseUrl: string | undefined): Promise<ProbeReport> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    // Removed so the developer's own export cannot decide an arm.
    if (value === undefined || key === 'ANTHROPIC_BASE_URL') continue
    env[key] = value
  }
  env.NESSY_CONFIG_DIR = configDir
  if (launchBaseUrl !== undefined) env.ANTHROPIC_BASE_URL = launchBaseUrl
  const child = Bun.spawn({ cmd: [process.execPath, PROBE], env, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
  await child.exited
  const out = stdout.trim()
  if (out === '') throw new Error(`probe produced no output: ${stderr}`)
  return JSON.parse(out.split('\n').at(-1)!) as ProbeReport
}

beforeAll(async () => {
  // An empty config directory, exported into the child's LAUNCH env — the only
  // form that isolates — so the developer's own config cannot decide an arm.
  configDir = mkdtempSync(join(tmpdir(), 'nessy-f1966-launch-base-url-'))
  // Concurrently: each probe pays the same module-graph import, and neither
  // shares anything with the other but the empty config directory it reads.
  ;[withLaunch, withoutLaunch] = await Promise.all([runProbe(LAUNCH_BASE_URL), runProbe(undefined)])
}, PROBE_BUDGET_MS)

afterAll(() => {
  if (configDir) rmSync(configDir, { recursive: true, force: true })
})

describe('F1.966 — a launch ANTHROPIC_BASE_URL never reaches a direct Claude child', () => {
  it('the rig: the launch value IS in the host env after the boot reset and after a save — the state the defect needs', () => {
    expect(withLaunch.arms['boot-reset']!.hostHas).toBe(true)
    expect(withLaunch.arms['after-postInit-delete']!.hostHas).toBe(false)
    expect(withLaunch.arms['after-save-reset']!.hostHas).toBe(true)
  })

  it('THE CLAIM: a direct connection without a base URL gets NO endpoint on every step — boot, after postInit, after a save', () => {
    expect(withLaunch.arms['boot-reset']!.child).toBeNull()
    expect(withLaunch.arms['after-postInit-delete']!.child).toBeNull()
    expect(withLaunch.arms['after-save-reset']!.child).toBeNull()
  })

  it('CONTROL: a claude-runtime connection keeps the loopback base URL its overrides carry, launch value or not', () => {
    expect(withLaunch.runtimeChild).toBe(LOOPBACK_BASE_URL)
    expect(withoutLaunch.runtimeChild).toBe(LOOPBACK_BASE_URL)
  })

  it('CONTROL: without a launch value nothing changes — no endpoint on any step', () => {
    for (const arm of Object.values(withoutLaunch.arms)) {
      expect(arm).toEqual({ hostHas: false, child: null })
    }
  })

  it('diagnostics name the vendor default for a connection with no base URL, never the environment\'s endpoint', () => {
    expect(withLaunch.providerLabel).toBe('Anthropic')
    expect(withoutLaunch.providerLabel).toBe('Anthropic')
  })

  it('the ignored value is reported on the rejected-layers surface — named, never echoed, whole', () => {
    const record = withLaunch.record
    expect(record).not.toBeNull()
    expect(record!.source).toBe('process environment')
    expect(record!.reason).toContain('IGNORED')
    expect(record!.reason).toContain('base URL on the connection')
    expect(record!.reason).not.toContain(LAUNCH_BASE_URL)
    expect(record!.reason).not.toContain('openrouter')
    expect(record!.reason.length).toBeLessThanOrEqual(REJECTED_LAYER_REASON_MAX)
    // Collected by the probe right after `postInit`'s delete, while the host
    // copy was gone: the report reads the launch presence.
  })

  it('CONTROL: nothing is reported when the app was launched without the name', () => {
    expect(withoutLaunch.record).toBeNull()
  })
})
