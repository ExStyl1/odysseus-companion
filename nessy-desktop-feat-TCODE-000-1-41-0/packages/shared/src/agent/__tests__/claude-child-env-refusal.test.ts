/**
 * P6.530 — PowerShell is switched on by an environment variable we forwarded,
 * and a `Bash`-scoped deny rule does not bind to it.
 *
 * `buildClaudeSubprocessEnv` spreads `process.env` wholesale, so an operator who
 * exported `CLAUDE_CODE_USE_POWERSHELL_TOOL` switched on a SECOND command
 * executor inside the claude child — one our `Bash(...)` deny rules do not match
 * and Pi and codex have no counterpart to. Delegated decision 2026-09-05
 * (Q-den 67) took option 2: refuse it by name.
 *
 * WHAT THIS SUITE PINS, and why it is not "the name is absent". The refusal is a
 * PIN to the vendor's own off value rather than a delete, because
 * `tools-reference.md#powershell-tool` says the tool is on by DEFAULT on
 * "Windows with Git Bash installed" for claude.ai and Console accounts — a strip
 * there would leave enabled exactly the executor being refused, and this repo
 * ships a Windows build. So the assertion is `=== '0'` on every arm, and the two
 * positive controls carry the load a bare absence assertion would have carried:
 * a real `CLAUDE_CODE_*` name in no strip list proves the refusal is by NAME and
 * not by prefix, and an arbitrary name proves the rig is reading a real
 * environment at all.
 *
 * MEASURED ON A THROWAWAY CHILD, whose LAUNCH environment carries the operator's
 * `=1` — never by overwriting a value inherited by this runner, because Bun's
 * env-slot unlock is sticky for the rest of a process and an in-suite assertion
 * would pass with the refusal removed. The probe then spawns a REAL grandchild
 * from the built env, so every assertion is "the subprocess received it" rather
 * than "an object literal contained it".
 */
import { beforeAll, describe, expect, it } from 'bun:test'
import { fileURLToPath } from 'node:url'
import {
  CLAUDE_CHILD_ENV_REFUSAL_ARMS,
  CLAUDE_CHILD_ENV_REFUSAL_NAMES,
} from './fixtures/claude-child-env-refusal-probe.ts'
import {
  CLAUDE_GLOB_NO_IGNORE_CONVERGED_VALUE,
  CLAUDE_GLOB_NO_IGNORE_ENV_VAR,
  CLAUDE_POWERSHELL_TOOL_ENV_VAR,
  CLAUDE_POWERSHELL_TOOL_REFUSED_VALUE,
  CLAUDE_TELEMETRY_CONTENT_OPT_IN_ENV_KEYS,
} from '../options.ts'

const PROBE = fileURLToPath(new URL('./fixtures/claude-child-env-refusal-probe.ts', import.meta.url))

interface ArmResult {
  built: Record<string, string | null | undefined>
  inherited: Record<string, string | null> | null
  grandchildStderr: string
}

/**
 * The sibling probe measured a ~28 s floor at load average 11, almost all of it
 * one `agent/options.ts` import, and this box may be busier. Set against that
 * measured floor rather than bun's 5 s default, because a timeout here reads
 * exactly like a failure and is not one.
 */
const PROBE_BUDGET_MS = 240_000

interface ProbeReport {
  arms: Record<string, ArmResult>
  /**
   * What the probe saw in its OWN launch environment, snapshotted before any arm
   * mutated anything — the positive control for every absence assertion below.
   * Read from a spread inside the probe rather than re-derived here, because
   * `in` lies for Bun's pre-created slots and this runner's environment is not
   * the probe's.
   */
  launchEnv: Record<string, string | null>
}

let probe: ProbeReport
let report: Record<string, ArmResult>

beforeAll(() => {
  const base: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    // Removed so an ambient value on the developer's machine cannot decide the
    // launch-env arm.
    if (CLAUDE_CHILD_ENV_REFUSAL_NAMES.includes(key as never)) continue
    base[key] = value
  }
  const child = Bun.spawnSync({
    cmd: [process.execPath, PROBE],
    env: {
      ...base,
      // The operator's own export — the whole shape of the row.
      CLAUDE_CODE_USE_POWERSHELL_TOOL: '1',
      // P6.539 — every content opt-in exported in the operator's login shell,
      // which is exactly how the row found them reaching the child.
      OTEL_LOG_USER_PROMPTS: '1',
      OTEL_LOG_ASSISTANT_RESPONSES: '1',
      OTEL_LOG_TOOL_DETAILS: '1',
      OTEL_LOG_TOOL_CONTENT: '1',
      OTEL_LOG_RAW_API_BODIES: '1',
      CLAUDE_CODE_SESSION_NAME: 'w8i-control',
      NESSY_W8I_ARBITRARY_CONTROL: 'control',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const out = child.stdout.toString().trim()
  if (out === '') throw new Error(`probe produced no output: ${child.stderr.toString()}`)
  probe = JSON.parse(out.split('\n').at(-1)!) as ProbeReport
  report = probe.arms
}, PROBE_BUDGET_MS)

describe('P6.530 — the claude child never receives an enabled PowerShell tool', () => {
  it('ran every arm the fixture declares, so a silently skipped arm is a failure', () => {
    expect(Object.keys(report).sort()).toEqual(Object.keys(CLAUDE_CHILD_ENV_REFUSAL_ARMS).sort())
  })

  it('the positive controls prove the rig reads a real environment, on every arm', () => {
    for (const [arm, result] of Object.entries(report)) {
      expect(result.grandchildStderr, `${arm}: grandchild wrote to stderr`).toBe('')
      expect(result.inherited, `${arm}: grandchild produced no report`).not.toBeNull()
      // A `CLAUDE_CODE_*` name in no strip list: the refusal is by NAME.
      expect(result.built.CLAUDE_CODE_SESSION_NAME, arm).toBe('w8i-control')
      expect(result.inherited!.CLAUDE_CODE_SESSION_NAME, arm).toBe('w8i-control')
      // An arbitrary name rides the spread untouched.
      expect(result.built.NESSY_W8I_ARBITRARY_CONTROL, arm).toBe('control')
      expect(result.inherited!.NESSY_W8I_ARBITRARY_CONTROL, arm).toBe('control')
    }
  })

  it('an operator who exported =1 in their launch shell gets the refusal, in the grandchild', () => {
    const arm = report['launch-env']!
    expect(arm.built[CLAUDE_POWERSHELL_TOOL_ENV_VAR]).toBe(CLAUDE_POWERSHELL_TOOL_REFUSED_VALUE)
    expect(arm.inherited![CLAUDE_POWERSHELL_TOOL_ENV_VAR]).toBe(CLAUDE_POWERSHELL_TOOL_REFUSED_VALUE)
    expect(arm.inherited![CLAUDE_POWERSHELL_TOOL_ENV_VAR]).not.toBe('1')
  })

  it('the pin is unconditional, so the Windows-with-Git-Bash default is off too', () => {
    // The boundary the row's own `done_means` did not cover: nobody set the
    // name, and the page says the tool is on by default on that platform. An
    // absent name would be indistinguishable from an enabled tool there.
    const arm = report.unset!
    expect(arm.built[CLAUDE_POWERSHELL_TOOL_ENV_VAR]).toBe(CLAUDE_POWERSHELL_TOOL_REFUSED_VALUE)
    expect(arm.inherited![CLAUDE_POWERSHELL_TOOL_ENV_VAR]).toBe(CLAUDE_POWERSHELL_TOOL_REFUSED_VALUE)
  })

  it("an operator who already asked for off keeps their value, so the refusal overrides nothing it needn't", () => {
    const arm = report['operator-off']!
    expect(arm.built[CLAUDE_POWERSHELL_TOOL_ENV_VAR]).toBe(CLAUDE_POWERSHELL_TOOL_REFUSED_VALUE)
    expect(arm.inherited![CLAUDE_POWERSHELL_TOOL_ENV_VAR]).toBe(CLAUDE_POWERSHELL_TOOL_REFUSED_VALUE)
  })
})

/**
 * P6.348 (the Glob half of J36) — claude's Glob is the only file search of the
 * three that ignores `.gitignore`, and the only one with a knob, so the knob is
 * where the three are made to agree.
 *
 * Measured 2026-09-07, all three: `env-vars.md`'s `CLAUDE_CODE_GLOB_NO_IGNORE`
 * row — *"By default, Glob returns all matching files including gitignored
 * ones"*; Pi's `find` tool describes itself as *"Find files by glob pattern
 * (respects .gitignore)"* and exposes no knob to turn; codex's
 * `codex-rs/file-search/src/lib.rs` at `rust-v0.150.1` defaults
 * `respect_gitignore` to `true`. So the row's own `done_means` was inverted in
 * both halves, and the fix is one line on the runtime that can take it.
 */
describe('P6.348 — the claude child\'s Glob is defaulted to agree with Pi and codex', () => {
  it('defaults the knob to the converged value when nobody set it', () => {
    for (const arm of ['launch-env', 'unset', 'operator-off'] as const) {
      expect(report[arm]!.built[CLAUDE_GLOB_NO_IGNORE_ENV_VAR], arm)
        .toBe(CLAUDE_GLOB_NO_IGNORE_CONVERGED_VALUE)
      expect(report[arm]!.inherited![CLAUDE_GLOB_NO_IGNORE_ENV_VAR], arm)
        .toBe(CLAUDE_GLOB_NO_IGNORE_CONVERGED_VALUE)
    }
  })

  it('NEGATIVE CONTROL for P6.348: an operator\'s own value survives — this is a default, not a floor', () => {
    // The distinction the docblock draws against the PowerShell/cron/marketplace
    // blocks: those pin a policy floor an ambient value must not re-arm; this
    // one decides what the model can SEE, with no safety edge, so overriding it
    // would replace a documented knob with a hidden one.
    const arm = report['glob-operator-override']!
    expect(arm.built[CLAUDE_GLOB_NO_IGNORE_ENV_VAR]).toBe('true')
    expect(arm.inherited![CLAUDE_GLOB_NO_IGNORE_ENV_VAR]).toBe('true')
  })
})

/**
 * P6.539 — an ambient `OTEL_LOG_RAW_API_BODIES=1` exported the whole
 * conversation out of the claude child, on an inherited variable no host
 * decision authorised. Owner decision 2026-09-05 (D14), option A: strip them.
 *
 * The measurement that matters is the one this suite is built for — the names
 * are set in the probe's LAUNCH ENVIRONMENT, the way an operator exports them,
 * and the verdict is read off a REAL GRANDCHILD spawned from the built env.
 * "The object literal did not contain it" and "the subprocess did not receive
 * it" are different claims, and only the second one is this row's.
 *
 * FIVE names, not the four the row enumerated. `monitoring-usage.md`'s
 * `OTEL_LOG_ASSISTANT_RESPONSES` row: *"Enable logging of assistant response
 * text on `assistant_response` events (default: disabled). When unset, falls
 * back to the value of `OTEL_LOG_USER_PROMPTS`."* That fallback is why a
 * four-name strip looks total and is not: an operator who set only
 * `OTEL_LOG_ASSISTANT_RESPONSES=1` would have kept exporting every assistant
 * turn through it.
 */
describe('P6.539 — no telemetry content opt-in reaches the claude child', () => {
  it('drops all five, on every arm, in the grandchild', () => {
    for (const [arm, result] of Object.entries(report)) {
      for (const name of CLAUDE_TELEMETRY_CONTENT_OPT_IN_ENV_KEYS) {
        expect(result.built[name], `${arm}: ${name} in the built env`).toBeUndefined()
        expect(result.inherited![name], `${arm}: ${name} in the grandchild`).toBeNull()
      }
    }
  })

  it('drops OTEL_LOG_RAW_API_BODIES in its file:<dir> mode too — by name, never by value', () => {
    // The page: "`1` for inline bodies truncated at the content limit … or
    // `file:<dir>` for untruncated bodies on disk". A truthiness test would let
    // the UNTRUNCATED mode through, which is the worse of the two.
    const arm = report['otel-raw-bodies-file-mode']!
    expect(arm.built.OTEL_LOG_RAW_API_BODIES).toBeUndefined()
    expect(arm.inherited!.OTEL_LOG_RAW_API_BODIES).toBeNull()
  })

  it('POSITIVE CONTROL: the probe\'s own launch environment really did carry all five', () => {
    // Without this, every `toBeUndefined()` above is equally consistent with a
    // rig that never set the names at all. The two pass-through controls prove
    // the spread works; this proves the values were there to be dropped — read
    // out of the probe's own pre-mutation snapshot, so it costs no extra spawn
    // (an earlier version spawned one and timed out at load 14, which reads
    // exactly like a failure and was not one).
    for (const name of CLAUDE_TELEMETRY_CONTENT_OPT_IN_ENV_KEYS) {
      expect(probe.launchEnv[name], name).toBe('1')
    }
  })
})
