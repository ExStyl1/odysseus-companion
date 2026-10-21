/**
 * Workflow governance settings — `settings.md` (`disableWorkflows`,
 * `workflowSizeGuideline`, `workflowKeywordTriggerEnabled`) and `workflows.md`
 * §Set a size guideline / §Turn workflows off.
 *
 * The load-bearing distinction these tests pin: the size guideline is ADVICE
 * (it moves a warning threshold and reaches the model as prose, it never
 * blocks), while `disableWorkflows` is a hard off switch no lower layer can
 * relax.
 */
import { describe, expect, it, setDefaultTimeout } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { pathToFileURL } from 'url'

import {
  LARGE_WORKFLOW_AGENT_THRESHOLD,
  LARGE_WORKFLOW_TOKEN_THRESHOLD,
  WORKFLOW_SETTINGS_DEFAULTS,
  evaluateLargeWorkflowWarning,
  largeWorkflowAgentThreshold,
  parseWorkflowSettingsV1,
  resolveWorkflowSettings,
  workflowDisableEnvLayer,
  workflowSizeGuidanceText,
} from '../workflow-settings.ts'

/**
 * The envelope case below spawns a REAL bun child that imports `storage.ts` and
 * its graph, so its cost is a module-graph transpile, not assertion work, and
 * on bun's 5 s default it dies under concurrent-lane load — a named failure in
 * the one test that proves the loader accepts the key at all.
 *
 * 300 s is set against the worst MEASURED wall time rather than the resting one
 * (a knob set near the resting state manufactures its own failures). Readings,
 * all with the suite alone: **17.46 s** (2026-09-06, lane W7-l2), **77.84 s**
 * for all 11 tests at load 10.07 and **99.46 s** for this ONE case filtered at
 * load 10.00 (2026-09-07). The filtered run being the SLOWER of the two is the
 * proof that the cost is the child's graph and not the test count. It has never
 * failed alone; the budget costs nothing on the fast path.
 *
 * RELABELLED 2026-09-07 (`P6.677`): "never failed alone" was the evidence for
 * class (c) STARVATION, and it cannot tell starvation from an I/O-bound timer
 * lottery. Zero-case control on this file (a `-t` name nothing matches, so no case
 * runs): **72.01 s at 1.3 % cpu** (0.63 s user / 0.37 s sys, load 8.75), then
 * **0.49 s at 118 % cpu** on the repeat — 146x, total CPU flat at ~1 s. The wall
 * is blocked on reads, not descheduled. Budget unchanged; the name changes.
 */
setDefaultTimeout(300_000)

describe('workflow key survives the strict stored-config envelope', () => {
  // Regression: the StoredConfig TYPE declared `workflow` but the strict
  // top-level Zod envelope (validators.ts StoredConfigTopLevelSchema) did not,
  // so a real config.json that SET the key failed loadStoredConfig() with
  // UnsupportedStorageLayoutError and bricked app startup. Only a disk
  // round-trip through the production loader proves the envelope accepts it.
  it('loads a config.json that sets workflow.disableWorkflows', () => {
    const configDir = mkdtempSync(join(tmpdir(), 'nessy-workflow-envelope-'))
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({
      storageLayoutVersion: 2,
      workspaceRefs: [{ id: 'ws-1', lastAccessedAt: Date.now() }],
      activeWorkspaceId: 'ws-1',
      activeSessionId: null,
      workflow: { disableWorkflows: true },
    }), 'utf-8')
    const storageModule = pathToFileURL(join(import.meta.dir, '..', 'storage.ts')).href
    const run = Bun.spawnSync([
      process.execPath,
      '--eval',
      `import * as S from '${storageModule}'; S.loadStoredConfig(); console.log(JSON.stringify(S.getUserWorkflowSettings()))`,
    ], { env: { ...process.env, NESSY_CONFIG_DIR: configDir }, stdout: 'pipe', stderr: 'pipe' })
    expect(run.exitCode, run.stderr.toString()).toBe(0)
    expect(JSON.parse(run.stdout.toString().trim())).toEqual({ disableWorkflows: true })
  })
})

describe('workflow settings parser', () => {
  it('accepts the three documented keys', () => {
    expect(parseWorkflowSettingsV1({
      disableWorkflows: true,
      sizeGuideline: 'medium',
      keywordTriggerEnabled: false,
    })).toEqual({ disableWorkflows: true, sizeGuideline: 'medium', keywordTriggerEnabled: false })
    expect(parseWorkflowSettingsV1({})).toEqual({})
  })

  it('throws on an unknown key, a bad enum value, and a non-object layer', () => {
    expect(() => parseWorkflowSettingsV1({ disableWorkflow: true })).toThrow('invalid workflow setting')
    expect(() => parseWorkflowSettingsV1({ sizeGuideline: 'huge' })).toThrow('invalid workflow sizeGuideline')
    expect(() => parseWorkflowSettingsV1({ disableWorkflows: 'yes' })).toThrow('invalid workflow disableWorkflows')
    expect(() => parseWorkflowSettingsV1([])).toThrow('invalid workflow settings')
    expect(() => parseWorkflowSettingsV1(null)).toThrow('invalid workflow settings')
  })
})

describe('workflow settings resolution', () => {
  it('defaults to enabled, unrestricted, keyword trigger on', () => {
    expect(resolveWorkflowSettings([])).toEqual(WORKFLOW_SETTINGS_DEFAULTS)
    expect(WORKFLOW_SETTINGS_DEFAULTS).toEqual({
      disableWorkflows: false,
      sizeGuideline: 'unrestricted',
      keywordTriggerEnabled: true,
    })
  })

  it('lets any layer turn workflows off and no later layer turn them back on', () => {
    // Managed is the org switch (`workflows.md`: set it in managed settings to
    // turn workflows off for a whole organization); a user layer after it must
    // not relax the decision.
    const resolved = resolveWorkflowSettings([
      { disableWorkflows: true },
      { disableWorkflows: false, keywordTriggerEnabled: true },
    ])
    expect(resolved.disableWorkflows).toBe(true)
    // "the `ultracode` keyword no longer triggers a run" — the off switch takes
    // the keyword trigger with it regardless of the keyword toggle.
    expect(resolved.keywordTriggerEnabled).toBe(false)
  })

  it('disables only the keyword trigger when the keyword toggle is off on its own', () => {
    const resolved = resolveWorkflowSettings([{ keywordTriggerEnabled: false }])
    expect(resolved.keywordTriggerEnabled).toBe(false)
    expect(resolved.disableWorkflows).toBe(false)
  })

  it('takes the last explicit size guideline', () => {
    expect(resolveWorkflowSettings([{ sizeGuideline: 'large' }, {}]).sizeGuideline).toBe('large')
    expect(resolveWorkflowSettings([{ sizeGuideline: 'large' }, { sizeGuideline: 'small' }]).sizeGuideline).toBe('small')
  })

  it('reads the env off switch as its own layer', () => {
    expect(workflowDisableEnvLayer({ NESSY_DISABLE_WORKFLOWS: '1' })).toEqual({ disableWorkflows: true })
    expect(workflowDisableEnvLayer({ NESSY_DISABLE_WORKFLOWS: '0' })).toEqual({})
    expect(workflowDisableEnvLayer({})).toEqual({})
  })
})

describe('size guideline is advice, not a cap', () => {
  it('renders prose for the model that names the agent count and says it is not a cap', () => {
    expect(workflowSizeGuidanceText('unrestricted')).toBeUndefined()
    const medium = workflowSizeGuidanceText('medium')
    expect(medium).toContain('fewer than 15')
    expect(medium).toContain('not a cap')
    expect(workflowSizeGuidanceText('small')).toContain('fewer than 5')
    expect(workflowSizeGuidanceText('large')).toContain('fewer than 50')
  })

  it('moves the large-run warning threshold and leaves the default at 25', () => {
    expect(LARGE_WORKFLOW_AGENT_THRESHOLD).toBe(25)
    expect(LARGE_WORKFLOW_TOKEN_THRESHOLD).toBe(1_500_000)
    expect(largeWorkflowAgentThreshold('unrestricted')).toBe(25)
    expect(largeWorkflowAgentThreshold('small')).toBe(5)
    expect(largeWorkflowAgentThreshold('medium')).toBe(15)
    expect(largeWorkflowAgentThreshold('large')).toBe(50)
  })

  it('warns advisorily past either threshold and stays silent at max effort', () => {
    const base = { sizeGuideline: 'unrestricted' as const, projectedTokens: 0, maxEffort: false }
    expect(evaluateLargeWorkflowWarning({ ...base, scheduledAgents: 25 })).toBeUndefined()
    expect(evaluateLargeWorkflowWarning({ ...base, scheduledAgents: 26 })).toContain('Large workflow')
    expect(evaluateLargeWorkflowWarning({ ...base, scheduledAgents: 16, sizeGuideline: 'medium' }))
      .toContain('Large workflow')
    expect(evaluateLargeWorkflowWarning({ ...base, scheduledAgents: 14, sizeGuideline: 'medium' }))
      .toBeUndefined()
    expect(evaluateLargeWorkflowWarning({ ...base, scheduledAgents: 1, projectedTokens: 1_500_001 }))
      .toContain('Large workflow')
    // "Sessions with ultracode on don't show the warning."
    expect(evaluateLargeWorkflowWarning({ ...base, scheduledAgents: 500, maxEffort: true })).toBeUndefined()
  })
})
