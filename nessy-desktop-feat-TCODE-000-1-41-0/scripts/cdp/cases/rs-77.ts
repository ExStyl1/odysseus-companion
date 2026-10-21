/**
 * RS-77 (D1.74) — how settings families COMBINE across files, read off the
 * product's own provenance surface, and cross-checked against the claude
 * child's own account of which files it opened.
 *
 * ## The row
 *
 * D1.74 is *"whether list keys such as `permissions.allow` combine across
 * settings files or one file replaces another, on all three"*, carried from
 * P6.434, with the instruction that *"a null is a result: if Pi and codex have
 * no merge rule, the row records that verbatim rather than inventing one."*
 *
 * The product answers it directly. `getSettingsProvenance` publishes, per
 * FAMILY, the rule the host applies — `config/config-doctor.ts`'s
 * `SettingsProvenanceCombineV1` is `'last-wins' | 'union' | 'winner-takes-all'`,
 * and the surface's own docblock says why the three are separate: *"three
 * different answers, none assumable"*. So the row's question is answered by a
 * read, per family, not per runtime — and that shape is itself the finding: the
 * rule is HOST-side and the same for all three runtimes.
 *
 * ## The cross-check, and why it belongs in this case rather than beside it
 *
 * The same report carries a SECOND stack, `claudeChildSettingSources` — the
 * files the host tells a claude child to read through `settingSources:
 * ['user','project','local']`. Its docblock states the reason it exists:
 * *"Showing one stack would be the silent divergence this view removes, so the
 * honest surface shows two."* A surface built to remove a divergence is worth
 * asking whether it has one, and the answer is READABLE on a packaged build
 * without any new instrumentation: the vendored claude binary logs every
 * `settings.json` path it tries, at `[DEBUG]`, into the per-session diagnostic
 * this product points it at (RS-71 measured that file: 238 lines, six domain
 * tags).
 *
 * So the case reads both and compares them. **The control is NOT that the two
 * lists overlap** — measured on this case's own first drive, where that spelling
 * stopped it dead: the surface publishes exactly ONE file and that file is the
 * finding, so "no overlap" was the control failing and the subject failing at
 * once, indistinguishably. The control is narrower and independent of the
 * surface: does the child's own account name a settings path belonging to THIS
 * profile? A reader that cannot see one has not earned the comparison.
 *
 * ## What it does NOT do
 *
 * It writes no settings file and drives no permission decision, so it does not
 * measure a merge END TO END — it measures what the host says it does, which is
 * the strongest reading available without a fixture writing at two scopes. The
 * row's behavioural arm (two files supplying the same family, then a decision)
 * stays owed, and the verdict says so rather than implying this covers it.
 *
 * ## What it creates
 *
 * One session it names itself, bound to a claude card so that a child exists to
 * have written a diagnostic. No configuration is written, no connection edited,
 * no credential read.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { appEnvBlockReason, readAppEnvContamination } from '../lib/app-env.ts'
import { lastAssistantText, sendPrompt } from '../lib/chat.ts'
import type { CdpSession } from '../lib/connect.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import { configDir } from '../lib/runtime-session-log.ts'
import { listConnections, runtimeOf, switchRuntime } from '../lib/runtime-switch.ts'
import { assertElectronApi, freshSession } from '../lib/state.ts'
import type { CaseMeta, SittingRecipe } from '../lib/sitting.ts'

const ID = 'RS-77'
const TITLE = 'the settings combine rules, and the claude child\'s own account of which files it opened'

interface ProvenanceEntry { scope: string; file: string; state: string }
interface ProvenanceFamily { id: string; combine: string; entries: ProvenanceEntry[] }
interface Provenance {
  families: ProvenanceFamily[]
  claudeChildSettingSources: ProvenanceEntry[]
  projectDirectory?: string
}

export const meta = {
  id: ID,
  title: TITLE,
  row: 'D1.74',
  runtimes: ['claude', 'pi', 'codex'],
  credentials:
    'owner: a claude-runtime card (the cross-check needs a child that has written a diagnostic). No key is read '
    + 'and no settings file is written.',
} as const satisfies CaseMeta

export const manual = {
  steps: [
    '1. PACKAGED build, a config dir created for the run, launched with the `env -u` launcher AND NESSY_DEBUG=1 — the per-session diagnostic is written only in host debug mode.',
    '2. Read `getSettingsProvenance`: per family, the `combine` rule and the files, in the order the host applies them.',
    '3. Run ONE turn on a claude card so a child exists and has written its diagnostic.',
    '4. Read every `settings.json` path the child itself logged, out of `<config>/logs/runtime/<id>-claude.txt`.',
    '5. Compare the two. The CONTROL is that the child\'s list contains a path under this profile\'s config dir — never that the two lists overlap, which the finding itself can falsify. A path the surface reports and the child never opened is the finding.',
  ],
  expected:
    'A `combine` rule per family — `last-wins`, `union` or `winner-takes-all` — which is D1.74\'s answer, host-side '
    + 'and identical for all three runtimes. And the claude stack the surface publishes should be the stack the '
    + 'child actually reads.',
  detector:
    '`getSettingsProvenance` for the host\'s own account, and the CHILD\'s own `[DEBUG]` lines naming each '
    + '`settings.json` it tried, in the per-session diagnostic the host points it at. Never the source tree\'s '
    + 'resolver, and never a merged object — `config-doctor.ts` says in its own words that inventing one would be '
    + '"a second, fictional resolver".',
  positiveControl:
    'the child\'s own account naming a settings path that belongs to THIS profile. It answers the only question a '
    + 'control can answer here — can this reader see a real settings path? — without reference to what the '
    + 'surface said. An overlap-based control cannot be used: the surface publishes ONE file, and when that file '
    + 'is the finding, "no overlap" is the control and the subject at once (measured on this case\'s first drive).',
  doneMeans:
    'D1.74 records the combine rule per family with the reading behind it, and states that the rule is host-side '
    + 'rather than per runtime — or records the null verbatim if the surface has none.',
  doNotConflate:
    'This measures what the HOST says it does. A merge driven end to end — two files supplying one family, then a '
    + 'decision — is a different arm and stays owed; the verdict says so.',
} as const satisfies SittingRecipe

/** Every `settings.json` path the CHILD itself logged, from its own diagnostic. */
function childSettingsPaths(root: string): { file: string; paths: string[]; lines: number } {
  const dir = join(root, 'logs', 'runtime')
  if (!existsSync(dir)) return { file: '', paths: [], lines: 0 }
  const candidates = readdirSync(dir)
    .filter(name => name.endsWith('-claude.txt'))
    .map(name => join(dir, name))
  let best = { file: '', paths: [] as string[], lines: 0 }
  for (const file of candidates) {
    let text: string
    try { text = readFileSync(file, 'utf8') } catch { continue }
    const paths = new Set<string>()
    for (const match of text.matchAll(/(?:for settings\.json at path|Watching for changes in setting files)[: ]+(\S+?)(?:\.\.\.)?\s*$/gm)) {
      const found = match[1]
      if (found) paths.add(found)
    }
    const lines = text.split('\n').filter(Boolean).length
    // Keep the RICHEST file rather than the newest: a session that never
    // reached the settings load would answer with an empty set and the
    // comparison below would report a disagreement that is really a short log.
    if (paths.size > best.paths.length) best = { file, paths: [...paths].sort(), lines }
  }
  return best
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)
  const root = configDir()

  const appEnv = readAppEnvContamination()
  run.observe('app-env', { pids: appEnv.pids.length, present: appEnv.present, controlSeen: appEnv.controlSeen })
  const contaminated = appEnvBlockReason(appEnv, 'the settings stack this case reads')
  if (contaminated !== undefined) blocked(contaminated)

  // ---- the row's own answer -------------------------------------------------
  const provenance = await session.call<Provenance>(`
    return await window.electronAPI.getSettingsProvenance()
  `)
  const families = provenance.families ?? []
  run.observe('the combine rule per family', families.map(family => ({
    id: family.id,
    combine: family.combine,
    entries: (family.entries ?? []).map(entry => ({ scope: entry.scope, state: entry.state, inRig: entry.file.startsWith(root) })),
  })))
  run.require(
    'THE CONTROL — the provenance surface answers for THIS profile',
    families.length > 0
      && families.some(family => (family.entries ?? []).some(entry => entry.file.startsWith(root))),
    `the surface returned ${families.length} family(ies) and none of them names a file inside ${root}. A report `
    + 'about some other profile, or an empty one, cannot answer what this profile combines',
  )
  const permissions = families.find(family => family.id === 'permissions')
  run.check(
    'D1.74 — the `permissions` family publishes a combine rule',
    typeof permissions?.combine === 'string' && permissions.combine.length > 0,
    `no \`permissions\` family in ${JSON.stringify(families.map(f => f.id))}. The row's null branch applies: the `
    + 'host publishes no merge rule for it and the row records that verbatim',
  )
  run.observe('D1.74 — the answer', {
    perFamily: Object.fromEntries(families.map(family => [family.id, family.combine])),
    shape:
      'the rule is published per FAMILY and host-side, not per runtime — so the row\'s "on all three" is answered '
      + 'by one reading rather than three, and that is itself the finding.',
    owed:
      'a merge driven END TO END — two files supplying one family, then a decision — is a different arm and is '
      + 'not taken here.',
  })

  // ---- the cross-check ------------------------------------------------------
  const card = (await listConnections(session)).find(row => runtimeOf(row.providerType) === 'anthropic')
  if (!card) {
    blocked(
      'this profile lists no claude-runtime card. The second half of this case compares the claude stack the '
      + 'surface publishes against the stack the CHILD opened, and without a child there is no account to compare',
    )
  }
  const key = await freshSession(session, `CDP ${ID} ${new Date().toISOString().slice(11, 19)}`)
  run.check('the case ran in a session it created', key.fresh, key.fresh ? undefined : `inherited ${key.inheritedMessages} messages`)
  const bind = await switchRuntime(session, key.sessionId, card.slug)
  run.check(`the session is bound to ${card.slug}`, bind.ok, bind.ok ? undefined : `switchRuntime refused: ${bind.error}`)
  const ready = await sendPrompt(session, key, 'Reply with the single word ready. Do not use any tool.', 300_000)
  run.observe('the turn that produced a child diagnostic', { answer: lastAssistantText(ready.added).trim().slice(0, 40) }) // F1.521

  const child = childSettingsPaths(root)
  const published = (provenance.claudeChildSettingSources ?? []).map(entry => ({ ...entry }))
  run.observe('the claude stack, both accounts', {
    publishedBySurface: published,
    openedByChild: child.paths,
    childDiagnostic: child.file ? child.file.slice(root.length) : null,
    childDiagnosticLines: child.lines,
  })
  run.require(
    'THE CONTROL — the child\'s own diagnostic names settings paths at all',
    child.paths.length > 0,
    `no \`settings.json\` path in any \`*-claude.txt\` under ${join(root, 'logs', 'runtime')} (richest file had `
    + `${child.lines} lines). Without the child's own account there is nothing to compare the surface against, and `
    + 'a disagreement below would be an empty read rather than a finding. The diagnostic is written only while the '
    + 'host is in debug mode',
  )
  const unopened = published.filter(entry => !child.paths.includes(entry.file))
  // THE CONTROL, and it is deliberately NOT "the two lists overlap".
  //
  // The first spelling of this case required an overlap, and it stopped there on
  // its own first drive: the surface publishes exactly ONE file and that file is
  // the finding, so "no overlap" was simultaneously the control failing and the
  // subject failing, and the case could not tell them apart. The question a
  // control has to answer here is narrower — CAN this reader see a real settings
  // path from this profile? — and a path under the rig's own config dir answers
  // it without reference to what the surface said.
  const fromThisProfile = child.paths.filter(path => path.startsWith(root))
  run.require(
    'THE CONTROL — the child\'s account names settings paths belonging to THIS profile',
    fromThisProfile.length > 0,
    `the child opened ${JSON.stringify(child.paths)} and none of them is under ${root}. Either this reader is `
    + 'parsing something other than settings paths, or the child is reading another profile entirely — and until '
    + 'that is settled the comparison below says nothing',
  )
  run.check(
    'every file the surface publishes as the claude child\'s stack is one the child actually opened',
    unopened.length === 0,
    `the surface publishes ${JSON.stringify(unopened.map(entry => `${entry.file} (${entry.state})`))}, which the `
    + `child never opened: its own log names ${JSON.stringify(child.paths)}. A view whose stated purpose is to `
    + 'remove a silent divergence is publishing one — and a file reported as SUPPLYING that the runtime does not '
    + 'read sends a user to edit a file that will not take effect',
  )
}

if (import.meta.main) {
  await main(ID, TITLE, drive)
}
