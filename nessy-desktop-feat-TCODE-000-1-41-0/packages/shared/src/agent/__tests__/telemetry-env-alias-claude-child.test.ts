/**
 * P6.178 — our own primary telemetry spelling has a reader inside the claude
 * child, in both directions.
 *
 * The shipped SDK's exporter reads ONLY `CLAUDE_CODE_ENABLE_TELEMETRY` (binary
 * probe of the vendored `claude`, re-measured 2026-09-12 at 0.3.247 /
 * `claudeCodeVersion 2.1.247`, each count as lines/occurrences because the two
 * instruments disagree on a minified artefact (C3.294):
 * `CLAUDE_CODE_ENABLE_TELEMETRY` -> 8/12, `NESSY_ENABLE_TELEMETRY` -> 0/0,
 * control `ZZQQNOTAREALNAME` -> 0/0; the superseded reading was "10 … 0 … 0" at
 * 0.3.233 / 2.1.233 with no instrument named), so `NESSY_ENABLE_TELEMETRY` — the name
 * `telemetryOptedIn` documents as primary, and the one Pi and codex both honour
 * — reached the claude child and did nothing at all.
 *
 * MEASURED ON A THROWAWAY CHILD. The whole measurement runs in a child process
 * whose LAUNCH environment carries the opt-in, never by overwriting a value
 * inherited by this runner: Bun's env-slot unlock is sticky for the rest of a
 * process, so an in-suite assertion would pass with the fix removed. The probe
 * then spawns a REAL grandchild from the built env, so every assertion below is
 * "the subprocess received it" rather than "an object literal contained it".
 *
 * ONE child for four arms, with an explicit budget. One import of
 * `agent/options.ts` dominates the probe's wall clock — 22.7 s of a 28 s run at
 * load average 11, against 0.5 s of user CPU, so it is contention rather than
 * work — and a process per arm would make this unaffordable. The three mutating
 * arms use `delete`-then-assign and each reports its own `NESSY_ENABLE_TELEMETRY`
 * back, so an assignment lost to the spread fails a test instead of silently
 * measuring nothing.
 */
import { beforeAll, describe, expect, it } from 'bun:test'
import { fileURLToPath } from 'node:url'
import {
  CLAUDE_TELEMETRY_PROBE_ARMS,
  CLAUDE_TELEMETRY_PROBE_NAMES,
} from '../../config/__tests__/fixtures/claude-telemetry-env-probe.ts'

const PROBE = fileURLToPath(
  new URL('../../config/__tests__/fixtures/claude-telemetry-env-probe.ts', import.meta.url),
)

interface ArmResult {
  built: Record<string, string | null | undefined>
  inherited: Record<string, string | null> | null
  grandchildStderr: string
}

/**
 * Measured floor is ~28 s at load average 11 and the box may be busier; a budget
 * set against that floor rather than at bun's 5 s default, because a timeout
 * here reads exactly like a failure and is not one.
 */
const PROBE_BUDGET_MS = 240_000

let report: Record<string, ArmResult>

beforeAll(() => {
  const base: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    // Removed so an ambient value on the developer's machine cannot decide the
    // launch-env arm.
    if (key === 'NESSY_ENABLE_TELEMETRY' || key === 'CLAUDE_CODE_ENABLE_TELEMETRY') continue
    base[key] = value
  }
  const child = Bun.spawnSync({
    cmd: [process.execPath, PROBE],
    env: { ...base, P6178_ARBITRARY_CONTROL: 'control', NESSY_ENABLE_TELEMETRY: '1' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const out = child.stdout.toString().trim()
  if (out === '') throw new Error(`probe produced no output: ${child.stderr.toString()}`)
  report = JSON.parse(out.split('\n').at(-1)!) as Record<string, ArmResult>
}, PROBE_BUDGET_MS)

describe('NESSY_ENABLE_TELEMETRY reaches the claude child', () => {
  it('turns the child exporter on by itself, from the launch environment', () => {
    const arm = report['launch-env']!

    // The vendor's name is what the exporter reads, and it is now set.
    expect(arm.built.CLAUDE_CODE_ENABLE_TELEMETRY).toBe('1')
    expect(arm.inherited?.CLAUDE_CODE_ENABLE_TELEMETRY).toBe('1')
    // Positive control on the same rig: an ordinary name rode the spread, so a
    // missing value above would be a real absence rather than a broken probe.
    expect(arm.inherited?.P6178_ARBITRARY_CONTROL).toBe('control')
    expect(arm.grandchildStderr).toBe('')
  })

  it('turns it OFF beside an ambient vendor value, which is our documented precedence', () => {
    // `telemetryOptedIn`: "the Nessy name wins when both are set". Before this
    // row the ambient `1` reached the child untouched and won.
    const arm = report['nessy-off-vendor-on']!

    // The arm's own mutation survived the spread — otherwise this reads '1' from
    // the launch env and the assertion below would be measuring nothing.
    expect(arm.built.NESSY_ENABLE_TELEMETRY).toBe('0')
    expect(arm.built.CLAUDE_CODE_ENABLE_TELEMETRY).toBeUndefined()
    expect(arm.inherited?.CLAUDE_CODE_ENABLE_TELEMETRY).toBeNull()
    expect(arm.inherited?.P6178_ARBITRARY_CONTROL).toBe('control')
  })

  it('leaves an operator-set vendor value alone when we say nothing', () => {
    // The negative control for the arm above: with no Nessy opinion, the
    // operator's own spelling still decides.
    const arm = report['vendor-only']!

    expect(arm.built.NESSY_ENABLE_TELEMETRY).toBeUndefined()
    expect(arm.built.CLAUDE_CODE_ENABLE_TELEMETRY).toBe('1')
    expect(arm.inherited?.CLAUDE_CODE_ENABLE_TELEMETRY).toBe('1')
  })

  it('exports nothing when neither name is set', () => {
    const arm = report['neither']!

    expect(arm.built.CLAUDE_CODE_ENABLE_TELEMETRY).toBeUndefined()
    expect(arm.inherited?.CLAUDE_CODE_ENABLE_TELEMETRY).toBeNull()
    expect(arm.inherited?.P6178_ARBITRARY_CONTROL).toBe('control')
  })

  it('the probe reports on exactly the names and arms the fixture declares', () => {
    // The import that keeps the two halves from drifting — and the reason the
    // fixture's side effects sit behind `import.meta.main`.
    expect([...CLAUDE_TELEMETRY_PROBE_NAMES]).toEqual([
      'NESSY_ENABLE_TELEMETRY',
      'CLAUDE_CODE_ENABLE_TELEMETRY',
      'P6178_ARBITRARY_CONTROL',
    ])
    expect(Object.keys(report)).toEqual(Object.keys(CLAUDE_TELEMETRY_PROBE_ARMS))
  })
})
