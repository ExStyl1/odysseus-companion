/**
 * P6.483 — one telemetry opt-out with two meanings.
 *
 * `DO_NOT_TRACK` and `DISABLE_TELEMETRY` silenced Pi and codex
 * (`otlp-telemetry.ts:341`, `codex-agent.ts:1451`, both a hard disable over the
 * opt-in) and left the claude child exporting. Owner ruling 2026-09-05 (Q13,
 * option 3): override those two for the claude child, and NEVER
 * `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`.
 *
 * THE EXCLUSION IS THE LOAD-BEARING HALF, and its arm is the control below. The
 * host WRITES that third name itself on every gateway session, and the shared
 * `telemetryOptedOut` treats any non-empty value of it as an opt-out — so
 * reusing that predicate here would silence the exporter on every gateway
 * session while looking exactly like a working feature. Hence a narrower
 * predicate, and hence an arm whose launch environment sets that name and
 * expects telemetry to stay ON.
 *
 * MEASURED ON A THROWAWAY CHILD, whose LAUNCH environment carries the operator's
 * exports, because the predicate's question is "was this set at launch" and
 * Bun's env-slot behaviour makes an in-suite assignment an unreliable way to ask
 * it. The first arm touches nothing at all.
 *
 * The two readings differ on purpose and match `telemetryOptedOut`'s own halves:
 * `DISABLE_TELEMETRY` is set-at-all (`0` still opts out), `DO_NOT_TRACK` is a
 * plain boolean (`0` does not).
 */
import { beforeAll, describe, expect, it } from 'bun:test'
import { fileURLToPath } from 'node:url'
import {
  CLAUDE_TELEMETRY_OPTOUT_ARMS,
  CLAUDE_TELEMETRY_OPTOUT_NAMES,
} from './fixtures/claude-telemetry-optout-probe.ts'

const PROBE = fileURLToPath(new URL('./fixtures/claude-telemetry-optout-probe.ts', import.meta.url))

interface ProbeReport {
  arms: Record<string, Record<string, string | null>>
  launchEnv: Record<string, string | null>
}

/** Set against the measured `agent/options.ts` import floor, not bun's 5 s. */
const PROBE_BUDGET_MS = 240_000

let probe: ProbeReport

beforeAll(() => {
  const base: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (CLAUDE_TELEMETRY_OPTOUT_NAMES.includes(key as never)) continue
    base[key] = value
  }
  const child = Bun.spawnSync({
    cmd: [process.execPath, PROBE],
    env: {
      ...base,
      // The operator opted IN…
      NESSY_ENABLE_TELEMETRY: '1',
      // …and the host's own gateway name is present. The control.
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const out = child.stdout.toString().trim()
  if (out === '') throw new Error(`probe produced no output: ${child.stderr.toString()}`)
  probe = JSON.parse(out.split('\n').at(-1)!) as ProbeReport
}, PROBE_BUDGET_MS)

describe('the rig', () => {
  it('ran every arm the fixture declares', () => {
    expect(Object.keys(probe.arms).sort()).toEqual(Object.keys(CLAUDE_TELEMETRY_OPTOUT_ARMS).sort())
  })

  it('launched with the opt-in set and neither opt-out name', () => {
    expect(probe.launchEnv.NESSY_ENABLE_TELEMETRY).toBe('1')
    expect(probe.launchEnv.DO_NOT_TRACK).toBeNull()
    expect(probe.launchEnv.DISABLE_TELEMETRY).toBeNull()
  })
})

describe('the two vendor-neutral names silence the claude child', () => {
  it('DO_NOT_TRACK=1 leaves the child with no telemetry switch at all', () => {
    // Absence, not `0`: the SDK reads only truthiness, and writing an off value
    // would be a second vocabulary for the same fact.
    expect(probe.arms['do-not-track']!.CLAUDE_CODE_ENABLE_TELEMETRY).toBeNull()
  })

  it('DISABLE_TELEMETRY is SET-AT-ALL, so even `0` opts out', () => {
    expect(probe.arms['disable-telemetry-zero']!.DISABLE_TELEMETRY).toBe('0')
    expect(probe.arms['disable-telemetry-zero']!.CLAUDE_CODE_ENABLE_TELEMETRY).toBeNull()
  })

  it('DO_NOT_TRACK is a BOOLEAN, so `0` is not an opt-out', () => {
    expect(probe.arms['do-not-track-zero']!.CLAUDE_CODE_ENABLE_TELEMETRY).toBe('1')
  })

  it('outranks the opt-in, exactly as it does on Pi and codex', () => {
    // `NESSY_ENABLE_TELEMETRY=1` is set in every arm's launch env, so the
    // silenced arms are the opt-out winning rather than the opt-in missing.
    expect(probe.arms['do-not-track']!.NESSY_ENABLE_TELEMETRY).toBe('1')
  })
})

describe('the name the host writes itself is NOT read as an opt-out', () => {
  it('a session with CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC set still exports', () => {
    // The control the row demands: reusing the shared `telemetryOptedOut`
    // predicate here would have silenced every gateway session.
    expect(probe.arms['launch-env']!.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('1')
    expect(probe.arms['launch-env']!.CLAUDE_CODE_ENABLE_TELEMETRY).toBe('1')
  })
})
