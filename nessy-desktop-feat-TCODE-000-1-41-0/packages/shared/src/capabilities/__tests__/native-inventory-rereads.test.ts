/**
 * F1.794 / F1.212 — the offline diagnosis the rows asked for, as a measurement
 * that runs without the packaged app.
 *
 * ## The chain that puts synchronous file IO on the Electron main thread
 *
 * The desktop host runs `server-core` INSIDE the Electron main process (the
 * DA1.65 docblock in `apps/electron/src/main/logger.ts`: the handlers' `deps.platform.logger`
 * "is this same electron-log when they run inside the desktop"). Every send
 * resolves capabilities (`createCapabilityTurn` → `createCapabilityResolver`'s
 * `resolve` → `buildCapabilityResolutionInputsV2`, `storage-runtime.ts:888`),
 * and the inputs builder calls `buildNativeCapabilityInventory`
 * (`storage-runtime.ts:963`) — which is ALL synchronous file IO
 * (`native-sources.ts`: `readFileSync` :393/:413/:482/:528, `statSync` :550,
 * `existsSync`/`readdirSync`/`realpathSync` throughout), over the workspace's
 * skills, agents, memory and instruction files, with NO cache: this file's
 * re-read arm proves every call walks the tree again.
 *
 * That is the named file and caller F1.794 asked for ("name the file and the
 * synchronous caller before sizing") as far as offline reading can take it:
 * SIT-o's `sample` put the packaged app's main thread inside `uv_fs_open` →
 * `open()` for 775 of 775 samples under load 14-30 (`work/sitting/SIT-o/verdicts.md`),
 * and a per-send, main-thread, uncached synchronous tree walk is the one
 * structure on that thread that matches — it also prices F1.642's 22.8 s
 * `createCapabilityTurn` (the same walk is inside every resolve).
 *
 * ## What is measured here, and what is NOT
 *
 * MEASURED (deterministic): the inventory re-reads the whole tree on every
 * call — an edit between two calls is visible in the second result — so the
 * per-send synchronous IO is proportional to the whole capability tree, not a
 * delta. SAMPLED (reported, never asserted — wall clock is machine-dependent):
 * the duration of each pass at two tree sizes, as the shape of the per-send
 * cost.
 *
 * NOT measured here, and what the RC4 sitting owes both rows: a `sample` of
 * the main thread during a reproduced 30 s-timeout window, reading whether
 * `buildNativeCapabilityInventory`'s frames are the ones on the thread (this
 * file names the suspect; only the packaged sample can confirm the
 * attribution), and the quiet-machine sizing reading F1.212's fix decision
 * needs (the renderer's 30 s RPC budget vs a loaded host).
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildNativeCapabilityInventory, nativeSourceReadCacheStatsForTest, resetNativeSourceReadCacheForTest } from '../native-sources.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  roots.push(dir)
  return dir
}

function writeSkill(skillsDir: string, slug: string, description: string): void {
  const dir = join(skillsDir, slug)
  mkdirSync(dir, { recursive: true })
  const lines = ['---', `name: ${slug}`, `description: ${description}`, '---', 'Body']
  writeFileSync(join(dir, 'SKILL.md'), lines.join('\n'))
}

function tree(root: string, skills: number, agents: number): void {
  const skillsDir = join(root, 'skills')
  for (let i = 0; i < skills; i++) writeSkill(skillsDir, `skill-${i}`, `skill ${i} description`)
  const agentsDir = join(root, 'agents')
  mkdirSync(agentsDir, { recursive: true })
  for (let i = 0; i < agents; i++) writeFileSync(join(agentsDir, `agent-${i}.md`), `---\nname: agent-${i}\ndescription: agent ${i}\n---\nBody`)
  writeFileSync(join(root, 'CLAUDE.md'), `# Workspace rules\n\nGenerated for the F1.794 probe.\n`)
  // The env seams below name these; create them so the pass starts from
  // existing (empty) directories rather than depending on ENOENT handling.
  mkdirSync(join(root, 'config'), { recursive: true })
  mkdirSync(join(root, 'home-agents'), { recursive: true })
}

function inventoryOf(root: string): ReturnType<typeof buildNativeCapabilityInventory> {
  return buildNativeCapabilityInventory(
    {
      workspaceId: 'ws-f1794',
      workspaceRootPath: root,
      projectTrustState: 'none',
      projectTrustRevision: '',
    },
    {
      configDir: join(root, 'config'),
      homeAgentsSkillsDir: join(root, 'home-agents'),
      adminSkillsDirs: [], // P2.461 — hermetic: never scan the machine's own administrator roots
      instructionExcludes: [],
      nestedSkillRoots: [],
    },
  )
}

describe('F1.794/F1.212 — the capability inventory re-reads its whole tree synchronously, per resolve', () => {
  it('THE MEASURE — an edit between two resolves is visible in the second: no cache, the per-send cost is the full tree', () => {
    const root = tmp('f1794-reread-')
    tree(root, 12, 4)
    const first = inventoryOf(root)
    const before = JSON.stringify(first)
    expect(before).toContain('skill 7 description')

    // The edit a user (or another app instance) makes between two sends.
    writeSkill(join(root, 'skills'), 'skill-7', 'skill 7 EDITED between resolves')
    writeSkill(join(root, 'skills'), 'skill-new', 'brand new between resolves')

    const second = inventoryOf(root)
    const after = JSON.stringify(second)
    expect(after).toContain('skill 7 EDITED between resolves')
    expect(after).toContain('brand new between resolves')
    expect(after).not.toBe(before)
  })

  it('SAMPLE — the per-pass duration at two tree sizes (reported; never asserted)', () => {
    const small = tmp('f1794-small-')
    const large = tmp('f1794-large-')
    tree(small, 40, 10)
    tree(large, 320, 80)
    // Warm both once (page cache parity), then sample each three times.
    inventoryOf(small)
    inventoryOf(large)
    const sample = (root: string) => {
      const started = performance.now()
      const inventory = inventoryOf(root)
      return { ms: Math.round((performance.now() - started) * 10) / 10, records: inventory.records.length }
    }
    const readings = {
      small: [sample(small), sample(small), sample(small)],
      large: [sample(large), sample(large), sample(large)],
    }
    // Reported for the sitting's record; the assertion is only that both
    // resolves RETURNED (the cost is the sitting's to attribute on RC4).
    console.log(`[F1.794] per-resolve inventory duration (ms, records): small(40 skills/10 agents)=${JSON.stringify(readings.small)} large(320/80)=${JSON.stringify(readings.large)}`)
    expect(readings.small.every(reading => reading.records > 0)).toBe(true)
    expect(readings.large.every(reading => reading.records > 0)).toBe(true)
  })
})

// UB12.4 (F1.212's fix rows) — the mtime-keyed read cache under the walk: the
// unchanged-tree case pays `statSync` per file instead of open+read, and the
// edit visibility the F1.794 measure pinned above is the cache's MISS rule.
describe('UB12.4 — the inventory read cache serves unchanged files and still sees edits', () => {
  afterEach(() => resetNativeSourceReadCacheForTest())

  it('positive: a second resolve over an unchanged tree is identical AND served from the cache', () => {
    const root = tmp('ub124-cache-')
    tree(root, 12, 4)
    resetNativeSourceReadCacheForTest()
    const first = inventoryOf(root)
    const afterFirst = nativeSourceReadCacheStatsForTest()
    expect(afterFirst.misses).toBeGreaterThan(0)

    const second = inventoryOf(root)
    const afterSecond = nativeSourceReadCacheStatsForTest()
    // Byte-identical result...
    expect(JSON.stringify(second)).toEqual(JSON.stringify(first))
    // ...and the reads were cache hits, not a second walk's worth of opens.
    expect(afterSecond.hits).toBeGreaterThanOrEqual(afterFirst.misses)
  })

  it('negative control: an edit between resolves is STILL visible — the cache misses, not hides, a change', () => {
    const root = tmp('ub124-edit-')
    tree(root, 8, 2)
    resetNativeSourceReadCacheForTest()
    expect(JSON.stringify(inventoryOf(root))).toContain('skill 3 description')

    writeSkill(join(root, 'skills'), 'skill-3', 'skill 3 EDITED under the cache')
    const second = JSON.stringify(inventoryOf(root))
    expect(second).toContain('skill 3 EDITED under the cache')
    expect(second).not.toContain('skill 3 description')
  })

  it('boundary: a same-size, different-content edit is visible (mtime, not length, is the identity)', () => {
    const root = tmp('ub124-samesize-')
    tree(root, 4, 1)
    const skillsDir = join(root, 'skills')
    const before = inventoryOf(root)
    expect(JSON.stringify(before)).toContain('skill 1 description')

    // Same byte length, different bytes: "descriptioo" ↔ "description" + the
    // mtime bump is what the cache keys on, so this must NOT be served stale.
    writeSkill(skillsDir, 'skill-1', 'skill 1 descriptioo')
    expect(JSON.stringify(inventoryOf(root))).toContain('skill 1 descriptioo')
  })
})
