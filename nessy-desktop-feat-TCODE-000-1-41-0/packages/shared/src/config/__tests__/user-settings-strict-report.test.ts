/**
 * `managed-settings.md#keys-that-fail-closed` — "This tolerance applies only to
 * managed settings. User, project, and local settings files remain strict: a
 * file whose JSON or top-level shape fails validation is rejected as a whole and
 * reported, and an individual entry that fails, such as a malformed permission
 * rule, is skipped with a warning while the rest of the file applies."
 *
 * Rejecting was already the behaviour. REPORTING was not: two of the three
 * user-tier getters were bare `catch { return {} }`, and `getUserSandboxSettings`
 * had no validation at all — it handed the raw layer downstream, where
 * `resolveSandboxSettings` threw inside session construction.
 *
 * Exercised through the production loader in a subprocess, because that is the
 * only way to prove the strict top-level config envelope still accepts these
 * blocks AND that the diagnostic reaches stderr.
 */
import { describe, expect, it, setDefaultTimeout } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { REJECTED_LAYER_REASON_MAX } from '../managed-drops.ts'

/**
 * An explicit budget, set against the MEASURED floor rather than bun's 5 s
 * default — the treatment `…specs/2026-07-29-known-failing-tests.md` §(c) asks
 * the owner of these files to apply ("whoever owns them should give each an
 * explicit budget with the measurement beside it — not raise the global
 * default"). This file is registered there for exactly ten starved cases.
 *
 * Every test here spawns a real `bun` child that imports `storage.ts`, and that
 * spawn is the whole cost. Measured 2026-09-07 with five other lanes on the box:
 * this file ALONE ran **11 pass / 0 fail in 3.65 s at load 12.82**, and the same
 * eleven tests in a batch with one sibling spawn-heavy file went **11 fail, every
 * one a timeout at exactly 5 000 ms with zero assertion failures**, at load 9.8.
 * Passing alone at high load is the separating control AGENTS.md names for
 * starvation, so the code is right and the default is wrong for a case that
 * spawns a child.
 *
 * 60 s is the sibling's number (`load-stored-config-fail-closed.test.ts`'s
 * `SPAWN_BUDGET_MS`), whose floor was measured on the same box at **34.87 s wall
 * for 0.53 s of user CPU** for ONE such spawn. Same box, same spawn, same budget.
 *
 * ## D1.110 — RE-MEASURED 2026-09-17, and 60 000 is CONFIRMED rather than moved
 *
 * The row asked for a re-measure, not a change, and the re-measure says leave
 * it — but the margin is thinner than the warm reading makes it look, so both
 * numbers are written down. This file ALONE under the test lock, twice:
 *
 *   * **3.59 s** at load 10.70, `user 4.36 / sys 1.08` against `real 3.60` —
 *     151 % cpu, a WARM reading and NOT a floor; slowest body **516 ms**
 *     (`--reporter=junit`);
 *   * **139.41 s** at load 10.21, `user 5.67 / sys 1.71` against `real 139.42` —
 *     5 % cpu, the I/O regime, **39x** the warm reading at the SAME load. Twelve
 *     cases in 139 s averages 11.6 s a case against a 5 s default, which is the
 *     starvation this budget exists for, measured rather than argued.
 *
 * The ZERO-CASE CONTROL prices the static graph at **0.32 s with 0 cases
 * executed**: nothing here is expensive except the children. Eleven cases at the
 * time of the note above, twelve today.
 *
 * Not raised to `MODULE_GRAPH_CASE_BUDGET_MS` (300 000): 60 000 is ~1.7x the
 * contended floor of one spawn and ~5x the average case of the slowest run
 * observed, and the budgets module's own rule is that sizing UP is a cost — a
 * hung case has to be heard about. **Re-measure before lowering, and re-read
 * this if a case is ever added:** the 139 s run is the reading that would decide
 * it, not the 3.59 s one. Two siblings now carry the same number for the same spawn on the
 * same box (`session-mirror-settings.test.ts`, `powershell-cmdlet-gate.test.ts`,
 * both D1.110).
 */
setDefaultTimeout(60_000)

const storageModule = pathToFileURL(join(import.meta.dir, '..', 'storage.ts')).href

function readUserLayers(
  config: Record<string, unknown>,
): { stdout: string; stderr: string; configDir: string } {
  const configDir = mkdtempSync(join(tmpdir(), 'nessy-user-layer-'))
  writeFileSync(join(configDir, 'config.json'), JSON.stringify({
    storageLayoutVersion: 2,
    workspaceRefs: [{ id: 'ws-1', lastAccessedAt: Date.now() }],
    activeWorkspaceId: 'ws-1',
    activeSessionId: null,
    ...config,
  }), 'utf-8')
  const run = Bun.spawnSync([
    process.execPath,
    '--eval',
    `import * as S from '${storageModule}';`
    + 'S.loadStoredConfig();'
    + 'console.log(JSON.stringify({'
    + ' sandbox: S.getUserSandboxSettings(),'
    + ' worktree: S.getUserWorktreeSettings(),'
    + ' workflow: S.getUserWorkflowSettings(),'
    + '}))',
  ], { env: { ...process.env, NESSY_CONFIG_DIR: configDir }, stdout: 'pipe', stderr: 'pipe' })
  expect(run.exitCode, run.stderr.toString()).toBe(0)
  return { stdout: run.stdout.toString().trim(), stderr: run.stderr.toString(), configDir }
}

function collectUserLayers(config: Record<string, unknown>): { stdout: string; stderr: string } {
  const configDir = mkdtempSync(join(tmpdir(), 'nessy-user-layer-collect-'))
  writeFileSync(join(configDir, 'config.json'), JSON.stringify({
    storageLayoutVersion: 2,
    workspaceRefs: [{ id: 'ws-1', lastAccessedAt: Date.now() }],
    activeWorkspaceId: 'ws-1',
    activeSessionId: null,
    ...config,
  }), 'utf-8')
  const run = Bun.spawnSync([
    process.execPath,
    '--eval',
    `import * as S from '${storageModule}';`
    + 'S.loadStoredConfig();'
    + 'console.log(JSON.stringify(S.collectRejectedUserSettingsLayers()))',
  ], { env: { ...process.env, NESSY_CONFIG_DIR: configDir }, stdout: 'pipe', stderr: 'pipe' })
  expect(run.exitCode, run.stderr.toString()).toBe(0)
  return { stdout: run.stdout.toString().trim(), stderr: run.stderr.toString() }
}

// `settings.md#fix-a-broken-settings-file` — "**Settings Error**: a user,
// project, or local file has invalid JSON or a value the schema rejects." and
// "After you continue, run `/status` to see the affected files and `claude
// doctor` for the details of each error."
describe('collectRejectedUserSettingsLayers', () => {
  it('returns exactly what the getters reject, and prints nothing while doing it', () => {
    // The collector drives the REAL getters with the reporter redirected, so it
    // cannot report a layer the app still applies or miss one it dropped. The
    // silence matters too: a diagnosis run must not double-log the startup
    // diagnostics it is enumerating.
    const { stdout, stderr } = collectUserLayers({
      sandbox: { excludedComands: ['docker *'] },
      worktree: { bgIsolaton: 'worktree' },
      workflow: { disableWorkflow: true },
      sessionMirror: { enabld: true },
    })
    const layers = JSON.parse(stdout) as { source: string; key: string; reason: string }[]
    expect(layers.map(layer => layer.key)).toEqual(['sandbox', 'worktree', 'workflow', 'sessionMirror'])
    expect(layers.every(layer => layer.source.endsWith('config.json'))).toBe(true)
    expect(layers[0]!.reason).toContain('excludedComands')
    expect(stderr).not.toContain('[settings] Invalid')
    expect(stderr).not.toContain('[SessionMirror] Invalid')
  })

  it('reports nothing for a configuration whose layers all parse', () => {
    const { stdout } = collectUserLayers({
      sandbox: { excludedCommands: ['docker *'] },
      workflow: { disableWorkflows: true },
    })
    expect(JSON.parse(stdout)).toEqual([])
  })

  // R51 · f022. This returned one row for `sandbox` before the nested path keys
  // were accepted, which is the only place the loss was visible at all.
  it("reports nothing for the doc's sandbox.filesystem stanza", () => {
    const { stdout } = collectUserLayers({
      sandbox: {
        excludedCommands: ['docker *'],
        filesystem: { allowWrite: ['/tmp/build', '~/.kube'], denyRead: ['~/.aws/credentials'] },
      },
    })
    expect(JSON.parse(stdout)).toEqual([])
  })

  it('still reports the sandbox layer for an unknown nested key', () => {
    const { stdout } = collectUserLayers({ sandbox: { filesystem: { denyReed: ['/etc'] } } })
    const layers = JSON.parse(stdout) as { key: string; reason: string }[]
    expect(layers.map(layer => layer.key)).toEqual(['sandbox'])
    expect(layers[0]!.reason).toContain('denyReed')
  })
})

describe('a rejected user settings layer is REPORTED', () => {
  it('reports each malformed layer by name and still starts', () => {
    const { stdout, stderr } = readUserLayers({
      // One unknown key each — the "single typo" case, which is exactly what
      // used to vanish without a trace.
      sandbox: { excludedComands: ['docker *'] },
      worktree: { bgIsolaton: 'worktree' },
      workflow: { disableWorkflow: true },
    })

    // Rejected as a WHOLE, per the doc: not partially salvaged.
    expect(JSON.parse(stdout)).toEqual({ sandbox: {}, worktree: {}, workflow: {} })

    for (const key of ['sandbox', 'worktree', 'workflow']) {
      expect(stderr).toContain(`[settings] Invalid \`${key}\` in the user config`)
    }
    // The parser's own message rides along, so the user can find the typo.
    expect(stderr).toContain('excludedComands')
  })

  it('keeps the REST of the file in effect while naming the one layer it rejected', () => {
    // P6.438(2), and the control the row asks for by name: "a single invalid
    // entry raises a Settings Warning naming `{source, key, reason}` while the
    // REST of the file still applies — proven by a second, valid key in the same
    // file taking effect".
    //
    // The two tests around this one each prove half of it (all layers broken,
    // all layers valid) and neither proves the MIX, which is the only shape a
    // real user has: one typo in a file they otherwise rely on. Without this,
    // a change that widened the rejection from the layer to the FILE would pass
    // both of them.
    const { stdout, stderr } = readUserLayers({
      sandbox: { excludedComands: ['docker *'] },   // the typo
      workflow: { disableWorkflows: true },          // valid, same file
    })

    expect(JSON.parse(stdout)).toEqual({
      sandbox: {},
      worktree: {},
      workflow: { disableWorkflows: true },
    })
    // Named, with the parser's own reason — a dropped layer nobody is told about
    // is the defect this whole suite was written for.
    expect(stderr).toContain('[settings] Invalid `sandbox` in the user config')
    expect(stderr).toContain('excludedComands')
    // …and the layer that parsed is NOT reported, so the line means what it says.
    expect(stderr).not.toContain('[settings] Invalid `workflow`')
  })

  it('carries a reason past the old 200 default, and never past the shared cap', () => {
    // P6.639. Every producer of a `RejectedSettingsLayerV1` and the renderer that
    // displays one read ONE exported number, `REJECTED_LAYER_REASON_MAX`. This
    // producer used to take `sanitizeSettingsDiagnostic`'s 200 default while the
    // `env` producer beside it and `buildConfigDoctorReport` both used 400, so the
    // two halves of one field disagreed by producer. Nothing was wrong at the
    // reasons in the tree — the strict parser's messages are short — which is
    // exactly why it would have drifted.
    //
    // Written against the CONSTANT, not against 400: a cap change must move the
    // assertion with it rather than leaving a test that pins the old number. The
    // padding sits INSIDE the offending key, so the part a truncation would eat
    // is the only actionable word the sentence has.
    const survives = 'excludedComands'.padEnd(240, 'x')
    const whole = JSON.parse(collectUserLayers({ sandbox: { [survives]: ['docker *'] } }).stdout) as
      { key: string; reason: string }[]
    expect(whole.map(layer => layer.key)).toEqual(['sandbox'])
    expect(whole[0]!.reason.length).toBeGreaterThan(200)
    expect(whole[0]!.reason.length).toBeLessThanOrEqual(REJECTED_LAYER_REASON_MAX)
    expect(whole[0]!.reason).toContain(survives)
    expect(whole[0]!.reason.endsWith('…')).toBe(false)

    // The boundary in the other direction: past the cap the reason is exactly
    // the cap, ending in the ellipsis, so it can never exceed the stated number.
    const overruns = 'excludedComands'.padEnd(REJECTED_LAYER_REASON_MAX + 200, 'x')
    const capped = JSON.parse(collectUserLayers({ sandbox: { [overruns]: ['docker *'] } }).stdout) as
      { key: string; reason: string }[]
    expect(capped[0]!.reason).toHaveLength(REJECTED_LAYER_REASON_MAX)
    expect(capped[0]!.reason.endsWith('…')).toBe(true)
  })

  it('a valid layer still passes through untouched', () => {
    const { stdout, stderr } = readUserLayers({
      sandbox: { excludedCommands: ['docker *'], allowUnsandboxedCommands: false },
      workflow: { disableWorkflows: true },
    })
    expect(JSON.parse(stdout)).toEqual({
      sandbox: { excludedCommands: ['docker *'], allowUnsandboxedCommands: false },
      worktree: {},
      workflow: { disableWorkflows: true },
    })
    expect(stderr).not.toContain('[settings] Invalid')
  })

  /**
   * R51 · f022 f023. The stanza `settings-reference.md#sandbox-filesystem` shows
   * (`"allowWrite": ["/tmp/build", "~/.kube"]` beside
   * `"denyRead": ["~/.aws/credentials"]`) used to be rejected
   * WHOLE at this tier: `filesystem.allowWrite` was not an accepted key, and
   * `~/.aws/credentials` was not an accepted value — so a user who copied the
   * doc lost every sandbox setting in the file and saw one console line.
   */
  it("accepts the doc's sandbox.filesystem stanza and expands its prefixes", () => {
    const { stdout, stderr } = readUserLayers({
      sandbox: {
        excludedCommands: ['docker *'],
        filesystem: {
          allowWrite: ['/tmp/build', '~/.kube'],
          denyRead: ['~/.aws/credentials'],
        },
      },
    })
    expect(JSON.parse(stdout).sandbox).toEqual({
      excludedCommands: ['docker *'],
      filesystem: {
        allowWrite: ['/tmp/build', join(homedir(), '.kube')],
        denyRead: [join(homedir(), '.aws', 'credentials')],
      },
    })
    expect(stderr).not.toContain('[settings] Invalid')
  })

  // `settings-reference.md#sandbox-path-prefixes` anchors a `./`-or-no-prefix
  // path "Relative to the project root for project settings, or to `~/.claude`
  // for user settings"; this tier's equivalent directory is the Nessy config
  // dir, which is what `getUserSandboxSettings` passes as the scope root.
  it('anchors a bare user-tier path at the config directory', () => {
    const { stdout, configDir } = readUserLayers({
      sandbox: { filesystem: { allowWrite: ['./build', 'cache'] } },
    })
    expect(JSON.parse(stdout).sandbox.filesystem.allowWrite)
      .toEqual([join(configDir, 'build'), join(configDir, 'cache')])
  })

  it('still rejects the layer whole for a genuinely unknown nested key', () => {
    // The strict tier must not widen by accident: accepting four new nested
    // keys is not accepting a fifth, and a typo of one of them is still a
    // whole-layer rejection (`managed-settings.md#keys-that-fail-closed`: user,
    // project and local files "remain strict").
    const { stdout, stderr } = readUserLayers({
      sandbox: { filesystem: { allowWrit: ['/tmp/build'] } },
    })
    expect(JSON.parse(stdout).sandbox).toEqual({})
    expect(stderr).toContain('invalid sandbox filesystem setting: allowWrit')
  })

  it('a malformed sandbox layer no longer reaches resolveSandboxSettings', () => {
    // The distinct half of this row: `getUserSandboxSettings` had NO try/catch
    // and no validation, so the throw surfaced from
    // `SessionManager.resolveSandboxSettingsForHost` — an app failure, not a
    // rejected settings layer. An empty layer is the correct rejection, and it
    // cannot widen anything: sandbox grants come from the layer, not its absence.
    const { stdout } = readUserLayers({ sandbox: { network: { allowedDomains: 'example.com' } } })
    expect(JSON.parse(stdout).sandbox).toEqual({})
  })
})
