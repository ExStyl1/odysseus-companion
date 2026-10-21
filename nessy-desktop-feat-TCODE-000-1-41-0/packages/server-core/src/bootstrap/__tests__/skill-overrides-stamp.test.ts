/**
 * `skillOverrides` (`skills.md:663`) — the stamping half.
 *
 * Sibling of `bundled-skills-switch.test.ts`, and the interesting difference is
 * what each does to the record list: that switch DROPS records, this one leaves
 * every record in place and stamps a state onto it. An overridden skill has to
 * stay in the catalog or the Skills list can never show it, let alone take the
 * override back off.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CapabilityPolicyStore } from '@nessy-agent/shared/capabilities/policy-store'
import type { PluginStoreV2 } from '@nessy-agent/shared/plugins'
import type { NativeCapabilitySourceRecord } from '@nessy-agent/shared/capabilities/types'
import type { CapabilityContext } from '@nessy-agent/shared/capabilities/resolver'
import {
  buildCapabilityResolutionInputsV2,
  type CapabilityInputsV2Deps,
} from '../storage-runtime'

let root: string
let configDir: string
let workspaceRoot: string
let projectRoot: string

function writeSkill(dir: string, slug: string): void {
  mkdirSync(join(dir, slug), { recursive: true })
  writeFileSync(
    join(dir, slug, 'SKILL.md'),
    `---\nname: ${slug}\ndescription: The ${slug} skill\n---\n\nBody.\n`,
  )
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'skill-overrides-stamp-'))
  configDir = join(root, 'config')
  workspaceRoot = join(root, 'workspace')
  projectRoot = join(root, 'project')
  mkdirSync(workspaceRoot, { recursive: true })
  mkdirSync(join(projectRoot, '.claude'), { recursive: true })
  for (const slug of ['deploy', 'review', 'legacy-context']) {
    writeSkill(join(configDir, 'skills'), slug)
  }
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
    ...overrides,
  }
}

async function skillRecords(
  storedConfig: unknown,
  context: Partial<CapabilityContext> = {},
): Promise<NativeCapabilitySourceRecord[]> {
  const inputs = await buildCapabilityResolutionInputsV2(
    { workspaceId: 'ws_a', projectTrustState: 'none', projectTrustRevision: '', ...context },
    deps({ storedConfig }),
  )
  return inputs.nativeInventory.records.filter(record => record.kind === 'skill')
}

const stateOf = (records: NativeCapabilitySourceRecord[], name: string) =>
  records.find(record => record.logicalName === name)?.skillOverrideState

describe('skillOverrides stamping', () => {
  it('stamps the user-scope map onto native skill records, leaving every record present', async () => {
    // skills.md:680-687, the documented snippet verbatim.
    const records = await skillRecords({
      skillOverrides: { 'legacy-context': 'name-only', deploy: 'off' },
    })

    expect(records.map(record => record.logicalName).sort()).toEqual(['deploy', 'legacy-context', 'review'])
    expect(stateOf(records, 'legacy-context')).toBe('name-only')
    expect(stateOf(records, 'deploy')).toBe('off')
    // skills.md:678 — absent means `"on"`, expressed as an ABSENT field so the
    // capability generation does not move for an unoverridden catalog.
    expect(stateOf(records, 'review')).toBeUndefined()
  })

  it('leaves an explicit "on" unstamped, since it is the documented default', async () => {
    const records = await skillRecords({ skillOverrides: { review: 'on' } })
    expect(stateOf(records, 'review')).toBeUndefined()
  })

  it('ignores a state no release of the page defines', async () => {
    const records = await skillRecords({ skillOverrides: { deploy: 'listed-quietly' } })
    expect(stateOf(records, 'deploy')).toBeUndefined()
  })

  it('reads the .claude destination the page names, local over project over user', async () => {
    // skills.md:663 — the `/skills` menu saves to `.claude/settings.local.json`.
    writeFileSync(
      join(projectRoot, '.claude', 'settings.json'),
      JSON.stringify({ skillOverrides: { deploy: 'name-only', review: 'off' } }),
    )
    writeFileSync(
      join(projectRoot, '.claude', 'settings.local.json'),
      JSON.stringify({ skillOverrides: { deploy: 'off' } }),
    )

    const records = await skillRecords({ skillOverrides: { deploy: 'on' } }, {
      workingDirectory: projectRoot,
      projectRoot,
      projectTrustState: 'trusted',
    })

    expect(stateOf(records, 'deploy')).toBe('off')
    expect(stateOf(records, 'review')).toBe('off')
  })

  it('does not read a repository-owned settings file for an untrusted project', async () => {
    writeFileSync(
      join(projectRoot, '.claude', 'settings.local.json'),
      JSON.stringify({ skillOverrides: { deploy: 'off' } }),
    )

    const records = await skillRecords({}, {
      workingDirectory: projectRoot,
      projectRoot,
      projectTrustState: 'none',
    })

    expect(stateOf(records, 'deploy')).toBeUndefined()
  })

  it('never stamps a record that is not a skill', async () => {
    const inputs = await buildCapabilityResolutionInputsV2(
      { workspaceId: 'ws_a', projectTrustState: 'none', projectTrustRevision: '' },
      deps({ storedConfig: { skillOverrides: { deploy: 'off' } } }),
    )
    for (const record of inputs.nativeInventory.records) {
      if (record.kind === 'skill') continue
      expect(record.skillOverrideState).toBeUndefined()
    }
    // And plugin skills never pass through the stamping map at all — they ride
    // `pluginCandidates`, which is how skills.md:689's exemption holds by
    // construction rather than by a check.
    expect(inputs.pluginCandidates).toEqual([])
  })
})
