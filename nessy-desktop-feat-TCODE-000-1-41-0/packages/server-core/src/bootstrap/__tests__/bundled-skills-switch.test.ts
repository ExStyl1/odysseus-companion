/**
 * `disableBundledSkills` (`settings-reference.md#disablebundledskills`,
 * `env-vars.md:225`) — "Claude Code removes bundled skills and workflows
 * entirely, while built-in commands such as `/init` stay typable but are hidden
 * from the model."
 *
 * The interesting half is the already-seeded profile: Nessy SEEDS its bundled
 * skills into the managed skills root on first run, so a switch that only
 * guarded seeding would do nothing on the profile that has been running.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CapabilityPolicyStore } from '@nessy-agent/shared/capabilities/policy-store'
import type { PluginStoreV2 } from '@nessy-agent/shared/plugins'
import { ensureBundledSkills } from '@nessy-agent/shared/skills'
import {
  resolveWorkflowSettings,
  workflowDisableEnvLayer,
} from '@nessy-agent/shared/config/workflow-settings'
import {
  buildCapabilityResolutionInputsV2,
  type CapabilityInputsV2Deps,
} from '../storage-runtime'

let root: string
let bundledRoot: string
let configDir: string
let skillsRoot: string
let workspaceRoot: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bundled-skills-switch-'))
  bundledRoot = join(root, 'resources', 'skills')
  configDir = join(root, 'config')
  skillsRoot = join(configDir, 'skills')
  workspaceRoot = join(root, 'workspace')
  mkdirSync(join(bundledRoot, 'nessy-bundled'), { recursive: true })
  mkdirSync(workspaceRoot, { recursive: true })
  writeFileSync(
    join(bundledRoot, 'nessy-bundled', 'SKILL.md'),
    '---\nname: nessy-bundled\ndescription: A bundled skill\n---\n\nBody.\n',
  )
})

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

function deps(overrides: Partial<CapabilityInputsV2Deps> = {}): CapabilityInputsV2Deps {
  return {
    resolveWorkspaceRootPath: () => workspaceRoot,
    nativeSourcesEnv: {
      // P2.455 / P2.461 — `[]` is "no administrator tier", pinned so this rig
      // cannot read the machine's real administrator roots. Why the field is
      // required rather than defaulting: `NativeSourcesEnv.adminSkillsDirs`.
      adminSkillsDirs: [],
      configDir,
      homeAgentsSkillsDir: join(root, 'agents', 'skills'),
    },
    pluginStore: {
      readInstalledRegistry: async () => ({ schemaVersion: 2, updatedAt: 1, active: {}, plugins: [] }),
      cachePathFor: () => join(root, 'cache'),
      acquireInstanceLease: () => () => {},
    } as unknown as PluginStoreV2,
    policyStore: new CapabilityPolicyStore({
      globalPath: join(configDir, 'capabilities.json'),
      workspacePolicyPath: workspaceId => join(root, 'workspaces', workspaceId, 'capabilities.json'),
    }),
    trustStore: { resolve: () => 'trusted' } as unknown as CapabilityInputsV2Deps['trustStore'],
    credentialBackend: {
      bind: () => { throw new Error('unexpected credential bind') },
      getRuntimeCredentialStatus: () => ({ state: 'missing', revision: 0 }),
    } as CapabilityInputsV2Deps['credentialBackend'],
    safeModeEnv: {},
    bundledSkillsEnv: {},
    storedConfig: {},
    bundledSkillRoots: { bundledRoot, skillsRoot },
    ...overrides,
  }
}

async function skillNames(overrides: Partial<CapabilityInputsV2Deps> = {}): Promise<string[]> {
  const inputs = await buildCapabilityResolutionInputsV2(
    { workspaceId: 'ws_a', projectTrustState: 'none', projectTrustRevision: '' },
    deps(overrides),
  )
  return inputs.nativeInventory.records
    .filter(record => record.kind === 'skill')
    .map(record => record.logicalName)
}

describe('disableBundledSkills — the skills half', () => {
  it('seeds nothing when the setting is on, and seeds normally when it is off', () => {
    expect(ensureBundledSkills({
      bundledRoot, skillsRoot, storedConfig: { disableBundledSkills: true }, env: {},
    })).toEqual([])
    expect(ensureBundledSkills({ bundledRoot, skillsRoot, storedConfig: {}, env: {} }))
      .toEqual(['nessy-bundled'])
  })

  it.each([
    ['NESSY_DISABLE_BUNDLED_SKILLS', { NESSY_DISABLE_BUNDLED_SKILLS: '1' }],
    ['CLAUDE_CODE_DISABLE_BUNDLED_SKILLS', { CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: '1' }],
  ] as const)('seeds nothing under %s', (_name, env) => {
    expect(ensureBundledSkills({ bundledRoot, skillsRoot, storedConfig: {}, env })).toEqual([])
  })

  it('makes an ALREADY-SEEDED bundled skill inert, and leaves a user skill alone', async () => {
    // The profile that has been running: the copy is already on disk.
    expect(ensureBundledSkills({ bundledRoot, skillsRoot, storedConfig: {}, env: {} }))
      .toEqual(['nessy-bundled'])
    // A user skill in the SAME root must survive — only bundled slugs go.
    mkdirSync(join(skillsRoot, 'my-own'), { recursive: true })
    writeFileSync(
      join(skillsRoot, 'my-own', 'SKILL.md'),
      '---\nname: my-own\ndescription: A user skill\n---\n\nBody.\n',
    )

    expect((await skillNames()).sort()).toEqual(['my-own', 'nessy-bundled'])
    expect(await skillNames({ storedConfig: { disableBundledSkills: true } })).toEqual(['my-own'])
    expect(await skillNames({ bundledSkillsEnv: { NESSY_DISABLE_BUNDLED_SKILLS: '1' } }))
      .toEqual(['my-own'])
    expect(await skillNames({ bundledSkillsEnv: { CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: '1' } }))
      .toEqual(['my-own'])
  })
})

describe('disableBundledSkills — the workflows half', () => {
  const resolve = (env: Record<string, string | undefined>, layers = [{}]) =>
    resolveWorkflowSettings([...layers, workflowDisableEnvLayer(env)]).disableWorkflows

  it('turns workflows off on its own', () => {
    expect(resolve({})).toBe(false)
    expect(resolve({ NESSY_DISABLE_BUNDLED_SKILLS: '1' })).toBe(true)
    expect(resolve({ CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: '1' })).toBe(true)
  })

  it('composes tighter-wins with the workflows switch, in both directions', () => {
    // The switches disagree: whichever asks for OFF wins, and neither can turn
    // workflows back on. `disableWorkflows: false` beside `disableBundledSkills`.
    expect(resolve({ NESSY_DISABLE_BUNDLED_SKILLS: '1' }, [{ disableWorkflows: false }])).toBe(true)
    // And the reverse: workflows off, bundled skills left alone.
    expect(resolve({ NESSY_DISABLE_WORKFLOWS: '1', NESSY_DISABLE_BUNDLED_SKILLS: '0' })).toBe(true)
  })
})
