/**
 * The bundled tier (R78) — `skills.md:122`: "A skill at any of these levels also
 * overrides a bundled skill with the same name", worked example "a `code-review`
 * skill in your project's `.claude/skills/` replaces the bundled `/code-review`".
 *
 * This fork has no bundled directory at runtime. `ensureBundledSkills` COPIES the
 * packaged skills into the managed skills root, which `native-sources.ts` pushes
 * at `global` scope — so once R70 inverted the skill chain to global-over-project,
 * a seeded bundle started beating a project skill of the same slug, which is the
 * opposite of that sentence. The fix is a provenance tag stamped in
 * `storage-runtime.ts` and ranked below `project` in `aliasScopeRank`.
 *
 * Every case here runs on REAL files through `buildCapabilityResolutionInputsV2`
 * and the REAL resolver, because the whole defect lived in the seam between the
 * two: the inventory could not see the bundle and the resolver could not see the
 * paths. The positive control strips the tag off the same records on the same rig
 * and shows the project skill losing, so "the project skill wins" is not passing
 * for a reason unrelated to this change.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CapabilityPolicyStore } from '@nessy-agent/shared/capabilities/policy-store'
import type { PluginStoreV2 } from '@nessy-agent/shared/plugins'
import { BUNDLED_SKILL_SEED_RECEIPT_FILE, ensureBundledSkills } from '@nessy-agent/shared/skills'
import type { NativeCapabilitySourceRecord } from '@nessy-agent/shared/capabilities/types'
import {
  createCapabilityResolver,
  type CapabilityContext,
  type CapabilityResolutionInputs,
} from '@nessy-agent/shared/capabilities/resolver'
import {
  buildCapabilityResolutionInputsV2,
  type CapabilityInputsV2Deps,
} from '../storage-runtime'

/** The four slugs the packaged bundle actually ships today. */
const BUNDLED_SLUGS = ['loop', 'plugin-creator', 'skill-creator', 'code-review'] as const

const PROJECT_KEY = 'p_00000000000000000000000000000000'

let root: string
let bundledRoot: string
let configDir: string
let skillsRoot: string
let workspaceRoot: string
let projectRoot: string

function writeSkill(dir: string, slug: string, body = 'Body.'): void {
  mkdirSync(join(dir, slug), { recursive: true })
  writeFileSync(
    join(dir, slug, 'SKILL.md'),
    `---\nname: ${slug}\ndescription: The ${slug} skill\n---\n\n${body}\n`,
  )
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bundled-skill-tier-'))
  bundledRoot = join(root, 'resources', 'skills')
  configDir = join(root, 'config')
  skillsRoot = join(configDir, 'skills')
  workspaceRoot = join(root, 'workspace')
  projectRoot = join(root, 'project')
  mkdirSync(workspaceRoot, { recursive: true })
  mkdirSync(projectRoot, { recursive: true })
  for (const slug of BUNDLED_SLUGS) writeSkill(bundledRoot, slug)
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

/** A trusted project context — project skills are only scanned for one. */
function context(withProject = true): CapabilityContext {
  return {
    workspaceId: 'ws_a',
    projectTrustState: 'trusted',
    projectTrustRevision: 'r1',
    ...(withProject
      ? { workingDirectory: projectRoot, projectRoot, projectKey: PROJECT_KEY }
      : {}),
  }
}

async function buildInputs(withProject = true): Promise<CapabilityResolutionInputs> {
  return buildCapabilityResolutionInputsV2(context(withProject), deps())
}

/**
 * The positive control's rig: the SAME inputs with the tag removed, which is
 * exactly the pre-R78 record shape.
 */
function withoutTier(inputs: CapabilityResolutionInputs): CapabilityResolutionInputs {
  return {
    ...inputs,
    nativeInventory: {
      ...inputs.nativeInventory,
      records: inputs.nativeInventory.records.map(record => {
        const { skillTier: _dropped, ...rest } = record as NativeCapabilitySourceRecord
        return rest as NativeCapabilitySourceRecord
      }),
    },
  }
}

/** Key of the entry that holds the BARE name for `slug`, via the real resolver. */
async function aliasWinnerKey(
  inputs: CapabilityResolutionInputs,
  slug: string,
  withProject = true,
): Promise<string | undefined> {
  const resolver = createCapabilityResolver({ inputs: () => inputs })
  const snapshot = await resolver.resolve(context(withProject))
  try {
    return snapshot.entries
      .filter(entry => entry.summary.kind === 'skill' && entry.summary.logicalName === slug)
      .find(entry => entry.summary.selectedAsUnqualifiedAlias)
      ?.summary.key
  } finally {
    resolver.releaseSnapshot(snapshot.leaseId)
  }
}

async function generationOf(
  inputs: CapabilityResolutionInputs,
  withProject = true,
): Promise<string> {
  const resolver = createCapabilityResolver({ inputs: () => inputs })
  const snapshot = await resolver.resolve(context(withProject))
  try {
    return snapshot.generation
  } finally {
    resolver.releaseSnapshot(snapshot.leaseId)
  }
}

const skillRecordsOf = (inputs: CapabilityResolutionInputs): NativeCapabilitySourceRecord[] =>
  inputs.nativeInventory.records.filter(record => record.kind === 'skill')

const tierOf = (records: NativeCapabilitySourceRecord[], name: string) =>
  records.find(record => record.logicalName === name)?.skillTier

describe('seeded bundled skills carry a tier', () => {
  it('stamps every seeded bundled slug and nothing else in the same root', async () => {
    expect(ensureBundledSkills({ bundledRoot, skillsRoot, storedConfig: {}, env: {} }).sort())
      .toEqual([...BUNDLED_SLUGS].sort())
    // A skill the user wrote, in the SAME managed root, at a slug the bundle
    // does not ship. The bundle is the only authority on which slugs are
    // bundled, so this one must stay untagged.
    writeSkill(skillsRoot, 'my-own')

    const records = skillRecordsOf(await buildInputs())
    for (const slug of BUNDLED_SLUGS) expect(tierOf(records, slug)).toBe('bundled')
    expect(tierOf(records, 'my-own')).toBeUndefined()
  })

  it('never stamps a record that is not a seeded bundled skill', async () => {
    ensureBundledSkills({ bundledRoot, skillsRoot, storedConfig: {}, env: {} })
    // Same slug as a bundled one, but in the PROJECT root: a different slot, so
    // the tag must not follow the name.
    writeSkill(join(projectRoot, '.nessy-agent', 'skills'), 'loop')

    const inputs = await buildInputs()
    const projectLoop = inputs.nativeInventory.records
      .find(record => record.kind === 'skill'
        && record.logicalName === 'loop'
        && record.scope.kind === 'project')
    expect(projectLoop).toBeDefined()
    expect(projectLoop!.skillTier).toBeUndefined()
    for (const record of inputs.nativeInventory.records) {
      if (record.kind === 'skill') continue
      expect(record.skillTier).toBeUndefined()
    }
  })

  it('keeps the tag on a seeded skill the user has EDITED in place', async () => {
    // The tag is PROVENANCE (a slot), not content, and it is kept DELIBERATELY.
    // This comment used to give the reason as "`seed.ts`'s frozen policy is
    // seed-once by slug-existence and never overwrite, so there is nothing on
    // disk that could tell an edited seed from a pristine one" — false since
    // P2.281, which decides per slug by CONTENT and leaves a receipt. The
    // surviving reason is the one that was always load-bearing: the same
    // identity decides `disableBundledSkills` and the origin lock, so a
    // content-sensitive answer here would make three decisions disagree.
    ensureBundledSkills({ bundledRoot, skillsRoot, storedConfig: {}, env: {} })
    writeSkill(skillsRoot, 'loop', 'Rewritten by the user, entirely.')

    expect(tierOf(skillRecordsOf(await buildInputs()), 'loop')).toBe('bundled')
  })

  // P3.208(a) — the seed receipt is unioned into the slug set, so a copy WE
  // wrote stays identifiable after the bundle stops shipping its slug. Before
  // this, such a copy was invisible to all three consumers of the one predicate
  // at once: `disableBundledSkills` would not remove it (against
  // `settings-reference.md#disablebundledskills`, "Claude Code removes bundled
  // skills and workflows entirely"), the origin lock would not keep it,
  // and untagged it outranked a project skill of the same name.
  it('keeps the tag on a slug an older bundle seeded and the current one no longer ships', async () => {
    ensureBundledSkills({ bundledRoot, skillsRoot, storedConfig: {}, env: {} })
    // The bundle drops the slug; the seeded copy and the receipt entry remain.
    rmSync(join(bundledRoot, 'code-review'), { recursive: true, force: true })
    // A directory the user wrote themselves, never seeded, so never in the
    // receipt: the control that separates "the receipt was read" from "every
    // directory in this root is now tagged".
    writeSkill(skillsRoot, 'my-own')

    const records = skillRecordsOf(await buildInputs())
    expect(tierOf(records, 'code-review')).toBe('bundled')
    expect(tierOf(records, 'loop')).toBe('bundled')
    expect(tierOf(records, 'my-own')).toBeUndefined()
  })

  it('is a UNION, so a profile with no receipt behaves exactly as before', async () => {
    // The regression this shape exists to avoid: reading the receipt INSTEAD of
    // the bundle would leave every pre-P2.281 profile with no stamps at all, and
    // a seeded bundle would go back to outranking a project skill.
    ensureBundledSkills({ bundledRoot, skillsRoot, storedConfig: {}, env: {} })
    rmSync(join(skillsRoot, BUNDLED_SKILL_SEED_RECEIPT_FILE), { force: true })

    const records = skillRecordsOf(await buildInputs())
    for (const slug of BUNDLED_SLUGS) expect(tierOf(records, slug)).toBe('bundled')
  })
})

describe('a project skill wins the bare name over a seeded bundled one', () => {
  it('gives `loop` to the project skill, through the real resolver', async () => {
    ensureBundledSkills({ bundledRoot, skillsRoot, storedConfig: {}, env: {} })
    writeSkill(join(projectRoot, '.nessy-agent', 'skills'), 'loop')

    const inputs = await buildInputs()
    const winner = await aliasWinnerKey(inputs, 'loop')
    const project = skillRecordsOf(inputs)
      .find(record => record.logicalName === 'loop' && record.scope.kind === 'project')!
    expect(winner).toBe(project.key)

    // POSITIVE CONTROL, same rig, tag removed: the pre-R78 shape, and the
    // seeded bundle takes the name back. Without this the assertion above could
    // be passing for any reason at all.
    const controlWinner = await aliasWinnerKey(withoutTier(inputs), 'loop')
    const seeded = skillRecordsOf(inputs)
      .find(record => record.logicalName === 'loop' && record.scope.kind === 'global')!
    expect(controlWinner).toBe(seeded.key)
    expect(controlWinner).not.toBe(winner)
  })

  it('leaves the losing bundled skill in the catalog, enabled and qualified', async () => {
    // `skills.md:122` says the project skill "replaces" the bundled one for the
    // NAME. It is not a removal: the record stays addressable under its own key,
    // exactly as the personal-over-project loser does.
    ensureBundledSkills({ bundledRoot, skillsRoot, storedConfig: {}, env: {} })
    writeSkill(join(projectRoot, '.nessy-agent', 'skills'), 'loop')

    const inputs = await buildInputs()
    const resolver = createCapabilityResolver({ inputs: () => inputs })
    const snapshot = await resolver.resolve(context())
    try {
      const seeded = snapshot.entries.find(entry => entry.summary.kind === 'skill'
        && entry.summary.logicalName === 'loop'
        && entry.summary.scope.kind === 'global')!
      expect(seeded.summary.selectedAsUnqualifiedAlias).toBe(false)
      expect(seeded.summary.enabled).toBe(true)
      expect(seeded.summary.unavailableReason).toBeUndefined()
      expect(seeded.summary.skillTier).toBe('bundled')
      expect(snapshot.diagnostics.some(d => d.code === 'capability.collision.unqualified-alias'))
        .toBe(true)
    } finally {
      resolver.releaseSnapshot(snapshot.leaseId)
    }
  })

  it('still gives an UNCONTESTED bundled skill its own short name', async () => {
    // The tag lowers the rank; it does not take a bundled skill out of
    // contention the way the plugin arm does. `plugin-creator` has no rival here.
    ensureBundledSkills({ bundledRoot, skillsRoot, storedConfig: {}, env: {} })
    writeSkill(join(projectRoot, '.nessy-agent', 'skills'), 'loop')

    const inputs = await buildInputs()
    const seeded = skillRecordsOf(inputs)
      .find(record => record.logicalName === 'plugin-creator')!
    expect(seeded.skillTier).toBe('bundled')
    expect(await aliasWinnerKey(inputs, 'plugin-creator')).toBe(seeded.key)
  })

  it('does not disturb the personal-over-project rule for an UNTAGGED global skill', async () => {
    // R70's inversion is what the tag qualifies, not what it replaces. A skill
    // the user wrote in the managed root still beats a project skill of the same
    // slug — `skills.md:122`, "personal overrides project".
    writeSkill(skillsRoot, 'deploy')
    writeSkill(join(projectRoot, '.nessy-agent', 'skills'), 'deploy')

    const inputs = await buildInputs()
    const personal = skillRecordsOf(inputs)
      .find(record => record.logicalName === 'deploy' && record.scope.kind === 'global')!
    expect(personal.skillTier).toBeUndefined()
    expect(await aliasWinnerKey(inputs, 'deploy')).toBe(personal.key)
  })
})

describe('the tag does not move a capability generation on its own', () => {
  it('produces a byte-identical generation for a seeded profile with no collision', async () => {
    // The field is deliberately absent from `computeGeneration`'s material: its
    // only consumer is `aliasScopeRank`, whose whole output is
    // `selectedAsUnqualifiedAlias`, which IS hashed. So a profile that has been
    // seeded — i.e. every profile that has ever run — must not be handed a fresh
    // generation on the first launch after this lands.
    ensureBundledSkills({ bundledRoot, skillsRoot, storedConfig: {}, env: {} })
    writeSkill(skillsRoot, 'my-own')

    const inputs = await buildInputs()
    expect(tierOf(skillRecordsOf(inputs), 'loop')).toBe('bundled')
    expect(await generationOf(inputs)).toBe(await generationOf(withoutTier(inputs)))
  })

  it('DOES move the generation for the profile that has the collision', async () => {
    // The negative half, and the reason the omission above is safe rather than
    // merely cheap: when the tag changes an outcome, the outcome it changes is
    // already in the hash.
    ensureBundledSkills({ bundledRoot, skillsRoot, storedConfig: {}, env: {} })
    writeSkill(join(projectRoot, '.nessy-agent', 'skills'), 'loop')

    const inputs = await buildInputs()
    expect(await generationOf(inputs)).not.toBe(await generationOf(withoutTier(inputs)))
  })
})
