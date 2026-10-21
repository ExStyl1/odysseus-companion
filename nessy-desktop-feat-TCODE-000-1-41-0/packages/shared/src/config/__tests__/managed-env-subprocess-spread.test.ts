/**
 * P2.487 — a managed `env` block has to reach the agent's SUBPROCESSES, not
 * just the host that applied it.
 *
 * ## What was wrong
 *
 * `writeResolution` did `target[name] = value` with no preceding `delete`. On
 * Bun 1.3.14 that leaves the name readable by property access and ABSENT from
 * `Object.keys(process.env)` and from `{...process.env}` — which is how every
 * subprocess environment in this repo is built (`buildPiSubprocessEnv`,
 * `buildClaudeSubprocessEnv`, `CodexRuntimeManager.spawn`). So an
 * administrator's managed environment applied to the host and silently not to
 * the agent's children, identically on all three runtimes.
 *
 * ## Why this suite runs in a CHILD PROCESS
 *
 * The unlock is STICKY: once a name has been deleted in a process, every later
 * assignment to it is visible for the rest of that process. This repo's test
 * preload and several neighbouring suites delete the proxy names in their
 * setup, so an in-process assertion here would pass with the fix REMOVED. A
 * throwaway Bun child whose managed names have never been deleted is the only
 * rig on which the assertion is a detector — the same reason
 * `host-loopback-proxy-exemption.test.ts` keeps its own child arm.
 *
 * ## The two conditions, both measured
 *
 * The defect needs BOTH a name Bun special-cases AND that name being absent
 * from the launch environment. Overwriting an inherited `HTTPS_PROXY` was
 * always visible; INTRODUCING one was not — which is why the child's env is
 * built without the probe names, and why the bug reads as machine-dependent.
 */
import { describe, it, expect } from 'bun:test'
import { resolve } from 'node:path'
import { MANAGED_ENV_PROBE_NAMES } from './fixtures/managed-env-spread-probe.ts'

interface ProbeReport {
  read: Record<string, string | undefined>
  inSpread: Record<string, boolean>
  set: string[]
  inherited: Record<string, string | undefined> | null
  grandchildStderr: string
}

/**
 * Spawned ONCE and shared. Every assertion below reads the same run, because
 * the probe costs two processes and the report is a pure observation — three
 * spawns measured 84s on this box under a load average of 11.7, one measures a
 * third of that, and nothing here depends on a fresh child per case.
 */
let cached: ProbeReport | undefined
function probe(): ProbeReport {
  cached ??= runProbe()
  return cached
}

function runProbe(): ProbeReport {
  const result = Bun.spawnSync({
    cmd: [process.execPath, resolve(import.meta.dir, 'fixtures', 'managed-env-spread-probe.ts')],
    // A plain env object built WITHOUT the probe names, so the child's slots
    // have never been written or deleted before `applyManagedEnv` runs — the
    // condition the assertion depends on.
    env: childEnvWithoutProbeNames(),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const stdout = result.stdout.toString().trim()
  // Never let a child that failed to start read as a silent pass.
  if (stdout === '') throw new Error(`probe produced no output; stderr: ${result.stderr.toString()}`)
  return JSON.parse(stdout.split('\n').at(-1)!) as ProbeReport
}

function childEnvWithoutProbeNames(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if ((MANAGED_ENV_PROBE_NAMES as readonly string[]).includes(key)) continue
    env[key] = value
  }
  return env
}

/**
 * Generous, and it costs nothing on an idle machine. It is here because two
 * spawns are the one thing in this suite whose latency is set by the HOST
 * rather than by the code under test — a sibling suite measured its single
 * spawn timing out at bun's default under build load, and again at 30s.
 */
const SPAWN_BUDGET_MS = 120_000

describe('P2.487 — what a subprocess env spread receives from a managed block', () => {
  it('carries every applied name into `{...process.env}`, including the ones Bun special-cases', () => {
    const report = probe()
    // The positive control FIRST: an arbitrary name was never affected, so if
    // it is missing the rig is broken and the rest of this test means nothing.
    expect(report.inSpread.P2487_ARBITRARY_CONTROL).toBe(true)
    expect(report.inSpread.HTTPS_PROXY).toBe(true)
    expect(report.inSpread.NO_PROXY).toBe(true)
    // NOT a proxy name, and affected all the same — the premise this row
    // corrected. `transport` classifies it for a security reason.
    expect(report.inSpread.NODE_TLS_REJECT_UNAUTHORIZED).toBe(true)
  }, SPAWN_BUDGET_MS)

  it('delivers the managed values to a real subprocess launched from that spread', () => {
    const report = probe()
    expect(report.grandchildStderr).toBe('')
    expect(report.inherited).toEqual({
      HTTPS_PROXY: 'http://managed.proxy:3128',
      NO_PROXY: 'internal.corp',
      NODE_TLS_REJECT_UNAUTHORIZED: '0',
      P2487_ARBITRARY_CONTROL: 'control',
    })
  }, SPAWN_BUDGET_MS)

  it('leaves the host\'s own property read and the reported `set` unchanged', () => {
    const report = probe()
    // The pre-fix behaviour was a PASS on this axis — the host always read the
    // value back. Pinned so a future change cannot "fix" the spread by
    // breaking the reader, and so `set` keeps reporting what was written.
    expect(report.read.HTTPS_PROXY).toBe('http://managed.proxy:3128')
    expect(report.set.sort()).toEqual([
      'HTTPS_PROXY',
      'NODE_TLS_REJECT_UNAUTHORIZED',
      'NO_PROXY',
      'P2487_ARBITRARY_CONTROL',
    ].sort())
  }, SPAWN_BUDGET_MS)
})
