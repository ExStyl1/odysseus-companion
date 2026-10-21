/**
 * SKL-P1 — a `paths:`-gated plugin skill survives installation with its whole
 * `allowed-tools` ceiling, including the entry that carries a comma.
 *
 * Two halves, and this file is deliberately only the first one:
 *
 *   1. **METADATA (here).** After a real install through the app's own
 *      marketplace RPC, the app's stored record for the skill carries `paths`
 *      with both patterns and `allowedTools` with all four entries — the fourth
 *      of which is `Agent(cdp-paths-probe:alpha, cdp-paths-probe:beta)`. This is
 *      deterministic, needs no model turn, and is exactly the read that caught
 *      the defect: the independent audit of the signed 1.25.0 found
 *      `claude-security`'s stored capability to be
 *      `{"slug":…,"path":…,"disableModelInvocation":true}` with **no
 *      `allowedTools`** while its `SKILL.md` declared twenty entries.
 *   2. **ACTIVATION (not here).** That the gated skill is invocable by the MODEL
 *      only while the session is working with a matching file is an operator
 *      half, written out in the `SKL-P1` row of
 *      `docs/testing/cdp-live-checklist.md`. It needs two model turns and a
 *      tool-driven file read, and this repo's own history is unambiguous that a
 *      model's self-report is the weakest instrument in the table — automating
 *      it here would convert a nondeterministic observation into a red check
 *      nobody can act on. The row names what to assert and what the positive
 *      control is; it is not automated, and it is not claimed as passing.
 *
 * The metadata read is taken off DISK, from `<config>/plugins/installed.json`,
 * because that file is what the app itself consults — `store-v2.ts`
 * `readInstalledRegistry`. Reading a renderer projection instead would leave
 * "the field survived install" and "the field reaches the view" fused into one
 * check that cannot say which half broke.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { FIXTURE, fixturePaths, readMarkers } from '../fixtures/paths-skill.ts'
import type { CdpSession } from '../lib/connect.ts'
import { catalogRows, ensureDarkTheme, fixtureWorkspaceId, type CatalogRow } from '../lib/mcp-fixture.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import { configDir } from '../lib/runtime-session-log.ts'
import { assertElectronApi } from '../lib/state.ts'

const ID = 'SKL-P1'
const TITLE = 'A paths-gated plugin skill installs with its paths AND its whole comma-bearing allowed-tools list'

interface StoredSkill {
  pluginId: string
  slug: string
  path: string
  allowedTools?: string[]
  paths?: string[]
}

/**
 * Every skill capability the app has on record for the fixture plugin.
 *
 * `installed.json` is a v2 registry: `plugins[]` holds one entry per installed
 * INSTANCE and `active` maps a stable plugin key to the live one. Both are read
 * — an install that left two instances behind is reported rather than silently
 * resolved, because a stale instance still carrying the old (broken) shape would
 * otherwise pass this case while the running app used the other one.
 */
function storedSkills(pluginId: string): { skills: StoredSkill[]; instances: number; registryPath: string } {
  const registryPath = join(configDir(), 'plugins', 'installed.json')
  if (!existsSync(registryPath)) {
    blocked(
      `no plugin registry at ${registryPath} — build the fixture (bun run scripts/cdp/fixtures/paths-skill.ts), `
      + 'start the app with NESSY_CONFIG_DIR=<root>/config and install the probe plugin '
      + '(recipe: the SKL-P1 row in docs/testing/cdp-live-checklist.md).',
    )
  }
  const registry = JSON.parse(readFileSync(registryPath, 'utf8')) as {
    plugins?: {
      pluginId?: string
      manifest?: { capabilities?: { kind?: string; skill?: Record<string, unknown> }[] }
    }[]
  }
  const entries = (registry.plugins ?? []).filter(entry => entry.pluginId === pluginId)
  const skills: StoredSkill[] = []
  for (const entry of entries) {
    for (const capability of entry.manifest?.capabilities ?? []) {
      if (capability.kind !== 'skill' || !capability.skill) continue
      const skill = capability.skill
      skills.push({
        pluginId,
        slug: typeof skill.slug === 'string' ? skill.slug : '',
        path: typeof skill.path === 'string' ? skill.path : '',
        ...(Array.isArray(skill.allowedTools) ? { allowedTools: skill.allowedTools as string[] } : {}),
        ...(Array.isArray(skill.paths) ? { paths: skill.paths as string[] } : {}),
      })
    }
  }
  return { skills, instances: entries.length, registryPath }
}

function skillRows(rows: CatalogRow[], slug: string): CatalogRow[] {
  return rows.filter(row => row.kind === 'skill' && row.logicalName === slug)
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)
  const paths = fixturePaths()
  const markers = readMarkers()
  if (!markers) {
    blocked(
      `no fixture tree at ${paths.root} — run \`bun run scripts/cdp/fixtures/paths-skill.ts\`, then start the app `
      + `with NESSY_CONFIG_DIR=${paths.configDir} and install ${FIXTURE.pluginId} from ${paths.market} `
      + '(recipe: the SKL-P1 row in docs/testing/cdp-live-checklist.md).',
    )
  }
  run.observe('theme', await ensureDarkTheme(session))
  run.observe('fixture-root', paths.root)

  // ---- the app's own stored record ----------------------------------------
  const { skills, instances, registryPath } = storedSkills(FIXTURE.pluginId)
  run.observe('installed-registry', { registryPath, instances, skills })
  run.require(
    `${FIXTURE.pluginId} is installed exactly once`,
    instances === 1,
    `${instances} registry entries carry pluginId ${FIXTURE.pluginId}`,
  )
  run.require(
    'both fixture skills are on record',
    skills.length === 2,
    `stored skill slugs: ${skills.map(s => s.slug).join(', ') || '(none)'}`,
  )

  const gated = skills.find(skill => skill.slug === FIXTURE.gatedSkill)
  const control = skills.find(skill => skill.slug === FIXTURE.controlSkill)
  run.require(`the gated skill ${FIXTURE.gatedSkill} is on record`, Boolean(gated))
  run.require(`the control skill ${FIXTURE.controlSkill} is on record`, Boolean(control))
  if (!gated || !control) return

  // ---- 1. `paths` survives the install ------------------------------------
  // `skills.md`, the `paths` row: "Glob patterns that limit when this skill is
  // activated. Accepts a comma-separated string or a YAML list." The fixture
  // declares a YAML list; both patterns have to arrive, in the order declared.
  run.observe('gated-paths', gated.paths ?? '(absent)')
  run.check(
    'the gated skill keeps BOTH of its paths patterns',
    JSON.stringify(gated.paths ?? []) === JSON.stringify([...FIXTURE.paths]),
    `stored ${JSON.stringify(gated.paths ?? null)}, declared ${JSON.stringify(FIXTURE.paths)}`,
  )

  // ---- 2. the whole `allowed-tools` list survives, comma and all -----------
  // The defect this exists for is TOTAL, not partial: one item containing a
  // comma used to abort the entire block list, so the assertion is on the whole
  // array rather than on the presence of the comma-bearing entry alone. A
  // regression that keeps three of four entries has to fail here too.
  for (const [label, skill] of [['gated', gated], ['control', control]] as const) {
    run.observe(`${label}-allowed-tools`, skill.allowedTools ?? '(absent)')
    run.check(
      `the ${label} skill keeps all ${FIXTURE.allowedTools.length} allowed-tools entries`,
      JSON.stringify(skill.allowedTools ?? []) === JSON.stringify([...FIXTURE.allowedTools]),
      `stored ${JSON.stringify(skill.allowedTools ?? null)}`,
    )
    run.check(
      `the ${label} skill keeps the parenthesized grant intact (one entry, not two fragments)`,
      (skill.allowedTools ?? []).includes(FIXTURE.allowedTools[2]),
      `stored ${JSON.stringify(skill.allowedTools ?? null)} — a shredded grant reads as two entries `
      + 'neither of which can ever match a tool',
    )
  }

  // ---- 3. the control skill is NOT path-gated ------------------------------
  // The negative half of the fixture's own shape. Without it, a build that
  // attached `paths` to every imported skill would pass check 1 and destroy the
  // gate's meaning.
  run.check(
    'the control skill carries NO paths (it is the ungated positive control)',
    control.paths === undefined,
    `stored ${JSON.stringify(control.paths ?? null)}`,
  )

  // ---- 4. both skills are live in the running app -------------------------
  const workspaceId = await fixtureWorkspaceId(session)
  const rows = await catalogRows(session, workspaceId)
  for (const slug of [FIXTURE.gatedSkill, FIXTURE.controlSkill]) {
    const matches = skillRows(rows, slug)
    run.observe(`catalog-${slug}`, matches.map(row => ({ state: row.state, reason: row.unavailableReason, codes: row.diagnosticCodes })))
    run.check(
      `${slug} is ACTIVE in the running catalog`,
      matches.length === 1 && matches[0]!.state === 'active',
      matches.length === 1
        ? `state=${matches[0]!.state} reason=${String(matches[0]!.unavailableReason)}`
        : `${matches.length} catalog rows carry this logical name`,
    )
  }

  // The two subagents the parenthesized grant names. They are the reason the
  // grant is a realistic one rather than a string, and on a build that still
  // throws on parametrized grants they are also what the Pi turn dies naming —
  // so their presence is recorded even though nothing here asserts on it.
  run.observe(
    'catalog-agents',
    rows.filter(row => row.kind === 'agent').map(row => `${row.logicalName}=${row.state}`),
  )

  // The activation half is the operator's; say so in the result rather than
  // leaving a reader to infer that a PASS here covered it.
  run.observe('activation-half', {
    automated: false,
    where: 'the SKL-P1 row in docs/testing/cdp-live-checklist.md',
    markers,
    matchingFile: paths.matchingFile,
    nonMatchingFile: paths.nonMatchingFile,
  })
}

if (import.meta.main) {
  await main(ID, TITLE, drive)
}

export const meta = { id: ID, title: TITLE }
