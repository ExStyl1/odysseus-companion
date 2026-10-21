/**
 * The two names the claude child env builder PROJECTS, because the child
 * already has the mechanism and only lacks our spelling of it.
 *
 * ## P6.255 (C12) — `NODE_USE_ENV_PROXY`
 *
 * We set `HTTP_PROXY`/`HTTPS_PROXY` on every child, from the in-app Settings
 * projection and from the host's own environment. On the claude child those
 * variables were INERT, and that is measured rather than suspected: the vendored
 * 2.1.247 binary gates its own env-proxy support on a flag that defaults off —
 * `shouldUseEnvProxy(){let value=process.env.NODE_USE_ENV_PROXY; if(Boolean(value)===!1||value==="0")return!1; …}`
 * — and carries the remedy in its own prose (*"Some clients do not read
 * HTTPS_PROXY: Node's built-in fetch (run that command with
 * `NODE_USE_ENV_PROXY=1` on Node >= 22.21)"*). Binary counts re-measured
 * 2026-09-12 on the vendored 2.1.247, each as lines/occurrences because on a
 * minified artefact the two instruments disagree (C3.294): the name → 2/2,
 * control `NODE_EXTRA_CA_CERTS` → 27/49 (the superseded reading said 55, at
 * 2.1.233, with no instrument named), fabricated name → 0/0.
 * The codex arm landed in `c7d5e13dc`; this is the claude builder arm.
 *
 * ## P6.696 — `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS`
 *
 * `backgroundTasksDisabled()` is the one predicate every detach site consults,
 * and its readers were the Pi orchestrator, the local-tool runtime and
 * `PiAgent`; the claude path scored zero. An operator who turned background
 * tasks off got a Pi session that honoured it and a claude session that did not,
 * from the same setting, with nothing saying so. `env-vars.md`'s row for the
 * vendor spelling, quoted verbatim on `backgroundTasksDisabled` itself: *"Set to
 * `1` to disable all background task functionality, including the
 * `run_in_background` parameter … and auto-backgrounding."* The name scores
 * 4 lines / 4 occurrences in the vendored 2.1.247 binary against a fabricated
 * control's 0/0 (re-measured 2026-09-12; the superseded reading was "6", taken
 * at 2.1.233 with no instrument named), and
 * `background-task-settings.ts` heads its family table with exactly this pair —
 * so this is the projection that table always implied.
 *
 * ## What this suite pins, and why an off value is not the opposite of an on one
 *
 * Both projections are ADDITIVE ONLY. Neither writes `0` when its condition does
 * not hold, because `0` is a decision — it disables the child's env-proxy
 * support outright, and it force-enables background tasks — where absence lets
 * the child resolve its own default. And neither overwrites a value already
 * present: an operator who exported the vendor spelling has decided, in either
 * direction, and a hidden knob must not replace a documented one.
 *
 * MEASURED ON A THROWAWAY CHILD whose LAUNCH environment carries the operator's
 * exports, never by overwriting a value inherited by this runner: `HTTPS_PROXY`
 * is a name Bun pre-creates a slot for, so an in-suite assignment is invisible to
 * the `{...process.env}` spread the builder is made of, and the unlock is sticky
 * for the rest of the process. The probe then spawns a REAL grandchild from the
 * built env, so every assertion is "the subprocess received it".
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CLAUDE_CHILD_ENV_PROJECTION_ARMS,
  CLAUDE_CHILD_ENV_PROJECTION_NAMES,
} from './fixtures/claude-child-env-projection-probe.ts'

const PROBE = fileURLToPath(new URL('./fixtures/claude-child-env-projection-probe.ts', import.meta.url))

interface ArmResult {
  built: Record<string, string | null | undefined>
  inherited: Record<string, string | null> | null
  grandchildStderr: string
}

interface ProbeReport {
  arms: Record<string, ArmResult>
  /** What the probe saw in its OWN launch environment, before any arm mutated it. */
  launchEnv: Record<string, string | null>
}

/**
 * Its sibling `claude-child-env-refusal.test.ts` measured a ~28 s floor at load
 * average 11 for one `agent/options.ts` import, and this box may be busier. Set
 * against that measured floor rather than bun's 5 s default, because a timeout
 * here reads exactly like a failure and is not one.
 */
const PROBE_BUDGET_MS = 240_000

const LAUNCH_PROXY = 'http://launch.proxy.invalid:3128'

let probe: ProbeReport
let report: Record<string, ArmResult>
let configDir: string

beforeAll(() => {
  // An empty config directory, so the in-app proxy settings `getProxyEnvVars()`
  // reads cannot let the developer's own machine decide an arm. Exported into
  // the child's LAUNCH env, which is the only form that isolates.
  configDir = mkdtempSync(join(tmpdir(), 'nessy-w7s1-env-projection-'))
  const base: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    // Removed so an ambient value on the developer's machine cannot decide the
    // launch-env arm.
    if (CLAUDE_CHILD_ENV_PROJECTION_NAMES.includes(key as never)) continue
    base[key] = value
  }
  const child = Bun.spawnSync({
    cmd: [process.execPath, PROBE],
    env: {
      ...base,
      NESSY_CONFIG_DIR: configDir,
      // The operator's own exports — the whole shape of both rows.
      HTTPS_PROXY: LAUNCH_PROXY,
      NESSY_DISABLE_BACKGROUND_TASKS: '1',
      NESSY_W7S1_ARBITRARY_CONTROL: 'control',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const out = child.stdout.toString().trim()
  if (out === '') throw new Error(`probe produced no output: ${child.stderr.toString()}`)
  probe = JSON.parse(out.split('\n').at(-1)!) as ProbeReport
  report = probe.arms
}, PROBE_BUDGET_MS)

afterAll(() => {
  if (configDir) rmSync(configDir, { recursive: true, force: true })
})

describe('the rig itself', () => {
  it('ran every arm the fixture declares, so a silently skipped arm is a failure', () => {
    expect(Object.keys(report).sort()).toEqual(Object.keys(CLAUDE_CHILD_ENV_PROJECTION_ARMS).sort())
  })

  it('launched with the operator exports the rows are about, and neither vendor name', () => {
    expect(probe.launchEnv.HTTPS_PROXY).toBe(LAUNCH_PROXY)
    expect(probe.launchEnv.NESSY_DISABLE_BACKGROUND_TASKS).toBe('1')
    expect(probe.launchEnv.NODE_USE_ENV_PROXY).toBeNull()
    expect(probe.launchEnv.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).toBeNull()
  })

  it('the positive control proves the rig reads a real environment, on every arm', () => {
    for (const [arm, result] of Object.entries(report)) {
      expect(result.grandchildStderr, `${arm}: grandchild wrote to stderr`).toBe('')
      expect(result.inherited, `${arm}: grandchild produced no report`).not.toBeNull()
      expect(result.built.NESSY_W7S1_ARBITRARY_CONTROL, arm).toBe('control')
      expect(result.inherited!.NESSY_W7S1_ARBITRARY_CONTROL, arm).toBe('control')
    }
  })
})

describe('P6.255 — the proxy we set is actually read by the claude child', () => {
  it('turns the child\'s env-proxy support on when a proxy is configured', () => {
    expect(report['launch-env']!.built.NODE_USE_ENV_PROXY).toBe('1')
    expect(report['launch-env']!.inherited!.NODE_USE_ENV_PROXY).toBe('1')
    // The proxy it is turned on FOR is still there — this gate enables a read,
    // it does not carry the value.
    expect(report['launch-env']!.inherited!.HTTPS_PROXY).toBe(LAUNCH_PROXY)
  })

  it('sees the lowercase spelling too, which is the one the page names first', () => {
    const arm = report['lowercase-proxy-only']!
    expect(arm.built.http_proxy).toBe('http://lowercase.proxy.invalid:3128')
    expect(arm.built.HTTPS_PROXY ?? null).toBeNull()
    expect(arm.inherited!.NODE_USE_ENV_PROXY).toBe('1')
  })

  it('writes nothing at all when no proxy is configured', () => {
    // Absence, not `0`: `0` disables the child's env-proxy support outright.
    expect(report['neither-configured']!.built.NODE_USE_ENV_PROXY ?? null).toBeNull()
    expect(report['neither-configured']!.inherited!.NODE_USE_ENV_PROXY).toBeNull()
  })

  it('never overrides an operator who set the flag themselves', () => {
    expect(report['operator-decided']!.built.HTTPS_PROXY).toBe(LAUNCH_PROXY)
    expect(report['operator-decided']!.inherited!.NODE_USE_ENV_PROXY).toBe('0')
  })
})

describe('P6.696 — the background-task off switch reaches the claude child', () => {
  it('projects the host setting onto the vendor spelling', () => {
    expect(report['launch-env']!.built.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).toBe('1')
    expect(report['launch-env']!.inherited!.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).toBe('1')
  })

  it('writes nothing when the switch is off, because `0` force-ENABLES background tasks', () => {
    expect(report['neither-configured']!.built.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS ?? null).toBeNull()
    expect(report['neither-configured']!.inherited!.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).toBeNull()
  })

  it('never overwrites a value the operator inherited into the session', () => {
    // The host switch is ON in this arm and the vendor name still reads `0`:
    // whoever exported the vendor spelling has already decided.
    expect(report['operator-decided']!.built.NESSY_DISABLE_BACKGROUND_TASKS).toBe('1')
    expect(report['operator-decided']!.inherited!.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).toBe('0')
  })
})
