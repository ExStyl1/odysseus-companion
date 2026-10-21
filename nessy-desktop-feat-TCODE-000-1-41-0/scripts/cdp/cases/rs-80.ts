/**
 * RS-80 (D1.67) — nested skill discovery: does touching a file inside a
 * subdirectory make that subdirectory's own skills reachable, on all three
 * runtimes, and does a same-named skill at the project root survive beside it?
 *
 * ## The row
 *
 * D1.67, carried from P6.407: ledger L69 is `have` on ALL THREE and every one of
 * those verdicts is a propagation from the shared base agent — *"Host-supplied
 * on the shared base agent, so the same discovery, activation gate and qualified
 * name reach all three"*. The rig it asks for:
 *
 * > one session per runtime with a nested skills root plus a same-named skill at
 * > the project root, touching a file in the subtree; control = the same session
 * > with the nested root removed. done_means: the qualified `<dir>:<name>`
 * > appears in the roster on each runtime and the activation fires on the
 * > trigger path, recorded per runtime.
 *
 * The mechanism is `BaseAgent.activateNestedSkillRoots(triggerFilePath)`, which
 * `discoverNestedSkillRoots` feeds and which emits a capability invalidation so
 * the skill *"becomes reachable on the turn AFTER the read — the same ordering
 * `skills.md:154`'s 'load the first time Claude reads or edits a file inside
 * that subdirectory' describes"*. That ordering is why this case needs three
 * turns and not two.
 *
 * ## The row's title says `.claude/skills`; the shipped discovery does not
 *
 * `skills.md:124` is quoted verbatim in the base agent, and the row's title
 * follows the page. The directories the code scans are this fork's own:
 * `nestedSkillDirectories` (`capabilities/native-sources.ts`) returns
 * `<dir>/.agents/skills` and `<dir>/.nessy-agent/skills`, from
 * `PROJECT_AGENT_SKILLS_DIR` and `NESSY_AGENT_PROJECT_DIR`. So the project this
 * case mints uses `.agents/skills`, and the `.claude/skills` spelling is planted
 * ALONGSIDE it as a NEGATIVE reading: whether the page's own directory name is
 * discovered here at all is a fact the row should carry rather than assume.
 *
 * ## The detector
 *
 * The skill listing is host-rendered into the composed prompt, so the fact lands
 * in the session's OWN runtime session file under
 * `<config>/sessions/<workspace>/<sessionId>/`. Each of the three skills carries
 * a token that exists nowhere else, so "the nested skill is reachable" is a
 * literal that can only have come from that file's body.
 *
 * ## The controls
 *
 *  1. **the ROOT skill's token is in the prompt from the first turn.** It is the
 *     positive control for the whole reader: a listing that shows nothing would
 *     otherwise make every nested absence look like the gate working.
 *  2. **the nested token is ABSENT before the trigger read** — the row's own
 *     control in its stronger form. `skills.md:154` says a nested skill is not
 *     loaded at startup, so an already-present token would mean the gate is not
 *     a gate and the third turn proves nothing.
 *  3. **the trigger read really happened** — the marker inside the touched file
 *     appears in the turn's transcript, so "the activation did not fire" is
 *     never confused with "the model never read the file".
 *
 * ## What it creates
 *
 * One scratch project under the OS temp directory, removed in a `finally`, and
 * one session per runtime family inside the config dir the run was launched
 * with. It writes no configuration and reads no credential.
 */

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { appEnvBlockReason, readAppEnvContamination } from '../lib/app-env.ts'
import { sendPrompt } from '../lib/chat.ts'
import type { CdpSession } from '../lib/connect.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import { configDir } from '../lib/runtime-session-log.ts'
import { bindWorkingDirectory, buttonTextInPage, DIALOG_DISMISS_BUTTON_TEXTS, listConnections, runtimeOf, switchRuntime, trustScratchProject } from '../lib/runtime-switch.ts'
import { assertElectronApi, freshSession, transcript } from '../lib/state.ts'
import type { CaseMeta, SittingRecipe } from '../lib/sitting.ts'

const ID = 'RS-80'
const TITLE = 'nested skill discovery and the same-named root skill, on all three runtimes'

/** The one skill NAME both variants share — `skills.md:126`'s "both stay available". */
const SKILL_NAME = 'cdp-deploy'
/** The subdirectory that owns the nested root; its qualifier is `pkg/web`. */
const NESTED_QUALIFIER = 'pkg/web'

function token(prefix: string): string {
  return `${prefix}-${Math.random().toString(16).slice(2, 10).toUpperCase()}`
}

function writeSkill(dir: string, name: string, body: string[]): void {
  mkdirSync(join(dir, name), { recursive: true })
  writeFileSync(join(dir, name, 'SKILL.md'), `${body.join('\n')}\n`, 'utf8')
}

interface Project {
  root: string
  trigger: string
  triggerMarker: string
  rootToken: string
  nestedToken: string
  claudeToken: string
}

/**
 * A project with three skill bodies, each carrying its own token:
 *
 *   <root>/.agents/skills/cdp-deploy          — loads eagerly (the control)
 *   <root>/pkg/web/.agents/skills/cdp-deploy   — the nested one, same NAME
 *   <root>/pkg/web/.claude/skills/cdp-deploy-c — the PAGE's directory name
 */
function mintProject(): Project {
  // CANONICALISED, and it is load-bearing: on macOS `tmpdir()` answers
  // `/var/folders/…` while the real path is `/private/var/folders/…`, and
  // `trustScratchProject` refuses a directory that is not under the OS temp dir
  // BY STRING — the first drive of this case lost all three arms to exactly that
  // (`refusing-to-trust: /var/folders/… is not under /private/var/folders/…`).
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cdp-rs80-')))
  const rootToken = token('CDP-ROOTSKILL')
  const nestedToken = token('CDP-NESTEDSKILL')
  const claudeToken = token('CDP-CLAUDEDIRSKILL')
  const triggerMarker = token('CDP-TRIGGER')

  writeSkill(join(root, '.agents', 'skills'), SKILL_NAME, [
    '---', `name: ${SKILL_NAME}`,
    // The token goes in the DESCRIPTION, not the body. Measured on this case's
    // third drive: the body is loaded on ACTIVATION, while what rides the
    // composed prompt at listing time is the name plus the description — so a
    // body token answers 0 for the root skill too, and the control fails on a
    // listing that is working.
    `description: CDP fixture, the PROJECT-ROOT variant. ROOT-TOKEN=${rootToken}`,
    '---', '', `ROOT-TOKEN=${rootToken}`,
  ])
  mkdirSync(join(root, 'pkg', 'web'), { recursive: true })
  writeSkill(join(root, 'pkg', 'web', '.agents', 'skills'), SKILL_NAME, [
    '---', `name: ${SKILL_NAME}`,
    `description: CDP fixture, the NESTED variant under pkg/web. NESTED-TOKEN=${nestedToken}`,
    '---', '', `NESTED-TOKEN=${nestedToken}`,
  ])
  writeSkill(join(root, 'pkg', 'web', '.claude', 'skills'), `${SKILL_NAME}-c`, [
    '---', `name: ${SKILL_NAME}-c`,
    `description: CDP fixture in the PAGE's own directory name. CLAUDEDIR-TOKEN=${claudeToken}`,
    '---', '', `CLAUDEDIR-TOKEN=${claudeToken}`,
  ])
  const trigger = join(root, 'pkg', 'web', 'main.txt')
  writeFileSync(trigger, `This file exists to be read. Its marker is ${triggerMarker}.\n`, 'utf8')
  return { root, trigger, triggerMarker, rootToken, nestedToken, claudeToken }
}

export const meta = {
  id: ID,
  title: TITLE,
  row: 'D1.67',
  runtimes: ['pi', 'claude', 'codex'],
  credentials:
    'owner: one card per family (pi, claude-runtime, codex-runtime). No key is read, no credential file is '
    + 'touched, and nothing is written outside a scratch project under the OS temp directory.',
} as const satisfies CaseMeta

export const manual = {
  steps: [
    '1. PACKAGED build, a config dir created for the run, launched with the `env -u` launcher.',
    '2. The case mints a project with a root skill, a same-named skill under `pkg/web`, and one in `pkg/web/.claude/skills`.',
    '3. Per runtime: a session bound to the card, its working directory set to that project and the project trusted.',
    '4. Turn 1 — a plain question. Read the composed prompt: the ROOT token must be there, the NESTED one must not.',
    '5. Turn 2 — ask the model to READ `pkg/web/main.txt`. That is `skills.md:154`\'s trigger path.',
    '6. Turn 3 — another plain question. The NESTED token must now be in the composed prompt, on the turn AFTER the read.',
  ],
  expected:
    'The nested skill is absent at startup, becomes reachable on the turn after a file under its directory is '
    + 'read, and the same-named root skill is still there beside it — on all three runtimes, because the mechanism '
    + 'is one shared base-agent method.',
  detector:
    'the SESSION\'s own runtime session file under `<config>/sessions/<workspace>/<sessionId>/`, which carries the '
    + 'host-rendered skill listing. Each skill body holds a token that exists nowhere else, so a hit can only have '
    + 'come from that body.',
  positiveControl:
    'the ROOT skill\'s token present in the very first turn\'s prompt. A listing that reached the model empty would '
    + 'make every nested absence look like the activation gate working, and this is the read that separates them. '
    + 'The row\'s own control is the BEFORE state of the same session: the nested token must be absent until the '
    + 'trigger file is read, or the gate is not a gate.',
  doneMeans:
    'L69 records, per runtime, that the nested root activates on the trigger path and that the qualified variant '
    + 'coexists with the root one — or refutes the propagated `have` on whichever runtime it does not.',
  doNotConflate:
    'The row\'s title says `.claude/skills`, which is the PAGE\'s directory name. This fork scans `.agents/skills` '
    + 'and `.nessy-agent/skills` (`nestedSkillDirectories`), so a `.claude/skills` subtree is planted as a separate '
    + 'reading and its absence is not a defect of the nested mechanism.',
} as const satisfies SittingRecipe

function jsonlUnder(dir: string, out: string[] = []): string[] {
  let entries: string[]
  try { entries = readdirSync(dir) } catch { return out }
  for (const entry of entries) {
    const path = join(dir, entry)
    let stat
    try { stat = statSync(path) } catch { continue }
    if (stat.isDirectory()) jsonlUnder(path, out)
    else if (entry.endsWith('.jsonl')) out.push(path)
  }
  return out
}

interface PromptRead { files: number; bytes: number; root: number; nested: number; claudeDir: number; qualified: number }

function promptRead(configRoot: string, workspaceId: string, sessionId: string, project: Project): PromptRead {
  const files = jsonlUnder(join(configRoot, 'sessions', workspaceId, sessionId))
  let bytes = 0
  let root = 0
  let nested = 0
  let claudeDir = 0
  let qualified = 0
  for (const file of files) {
    let text: string
    try { text = readFileSync(file, 'utf8') } catch { continue }
    bytes += text.length
    root += text.split(project.rootToken).length - 1
    nested += text.split(project.nestedToken).length - 1
    claudeDir += text.split(project.claudeToken).length - 1
    qualified += text.split(`${NESTED_QUALIFIER}:${SKILL_NAME}`).length - 1
  }
  return { files: files.length, bytes, root, nested, claudeDir, qualified }
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)
  const configRoot = configDir()

  const appEnv = readAppEnvContamination()
  run.observe('app-env', { pids: appEnv.pids.length, present: appEnv.present, controlSeen: appEnv.controlSeen })
  const contaminated = appEnvBlockReason(appEnv, 'the skill roster a session composes')
  if (contaminated !== undefined) blocked(contaminated)

  const cards = await listConnections(session)
  const byFamily = new Map<string, typeof cards[number]>()
  for (const card of cards) {
    const raw = runtimeOf(card.providerType)
    const family = raw === 'anthropic' ? 'claude' : raw === 'codex-runtime' ? 'codex' : raw
    if ((family === 'pi' || family === 'claude' || family === 'codex') && !byFamily.has(family)) byFamily.set(family, card)
  }
  run.observe('the cards this profile offers', [...byFamily].map(([family, card]) => ({ family, slug: card.slug })))
  if (byFamily.size === 0) blocked('this profile lists no pi, claude-runtime or codex-runtime card')

  const project = mintProject()
  run.observe('the scratch project', {
    root: project.root,
    rootSkill: join('.agents', 'skills', SKILL_NAME),
    nestedSkill: join('pkg', 'web', '.agents', 'skills', SKILL_NAME),
    pageDirSkill: join('pkg', 'web', '.claude', 'skills', `${SKILL_NAME}-c`),
    trigger: project.trigger,
  })
  try {
    for (const [family, card] of byFamily) {
      try {
        const key = await freshSession(session, `CDP ${ID} ${family} ${new Date().toISOString().slice(11, 19)}`)
        if (!key.fresh) { run.check(`[${family}] ran in a session it created`, false, `inherited ${key.inheritedMessages}`); continue }
        const bind = await switchRuntime(session, key.sessionId, card.slug)
        if (!bind.ok) { run.check(`[${family}] bound to ${card.slug}`, false, bind.error); continue }
        // F1.182 — started, not awaited: the gate is answered while the
        // mutation is in flight, and the bind's own reading is the check.
        const binding = bindWorkingDirectory(session, key.sessionId, project.root)
        const trust = await trustScratchProject(session, project.root, 30_000)
        run.observe(`[${family}] the trust gate`, trust)
        const bound = await binding
        run.check(`[${family}] the session is bound to the project`, bound.bound, bound.reason ?? '')
        // The dialog itself ENUMERATES what the project provides, and that is a
        // second, product-side reading of the same gate: at bind time it should
        // name the ROOT skill and not the nested one.
        const gateText = await session.call<string>(`
          const d = document.querySelector('[role="dialog"]')
          return d ? (d.innerText || '').replace(/\\s+/g, ' ').slice(0, 400) : ''
        `).catch(() => '')
        if (gateText) run.observe(`[${family}] what the trust dialog says the project provides`, gateText)

        // --- turn 1: the BEFORE state -------------------------------------
        await sendPrompt(session, key, 'Reply with the single word ready. Do not use any tool.', 300_000)
        const before = promptRead(configRoot, key.workspaceId, key.sessionId, project)

        // --- turn 2: the trigger read -------------------------------------
        // F1.562 — THIS turn's rows (`added`), not the session's: turn 1 precedes it.
        const triggerTurn = (await sendPrompt(
          session,
          key,
          `Read the file ${project.trigger} and quote its marker back to me. Use your file-reading tool.`,
          420_000,
        )).added
        const sawMarker = triggerTurn.some(message =>
          (message.content ?? '').includes(project.triggerMarker)
          || (message.toolResult ?? '').includes(project.triggerMarker))

        // --- turn 3: the AFTER state, one turn later ----------------------
        await sendPrompt(session, key, 'Reply with the single word done. Do not use any tool.', 300_000)
        const after = promptRead(configRoot, key.workspaceId, key.sessionId, project)

        run.observe(`[${family}] the three reads`, { card: card.slug, before, triggerRead: sawMarker, after })

        run.require(
          `[${family}] THE CONTROL — the project-root skill is in the composed prompt from turn one`,
          before.root > 0,
          `the session's own runtime file (${before.files} file(s), ${before.bytes} bytes) carries the root `
          + 'skill\'s token 0 times. With no skill listing reaching the model at all, every nested reading below '
          + 'is an empty read rather than a gate',
        )
        run.require(
          `[${family}] THE CONTROL — the model really read the trigger file`,
          sawMarker,
          'the trigger file\'s own marker appears nowhere in the turn, so the read that is supposed to activate '
          + 'the nested root never happened and turn three measures nothing',
        )
        run.check(
          `[${family}] D1.67 — the nested skill is NOT loaded before its directory is touched`,
          before.nested === 0,
          `the nested skill's token is already in the prompt ${before.nested} time(s) at turn one. `
          + '`skills.md:154` — a nested skill loads "the first time Claude reads or edits a file inside that '
          + 'subdirectory" — so a skill present at startup means there is no gate to measure',
        )
        run.check(
          `[${family}] D1.67 — after the trigger read, the nested skill IS reachable`,
          after.nested > 0,
          `the nested skill's token appears ${after.nested} time(s) after the read (root token: ${after.root}, `
          + `qualified name \`${NESTED_QUALIFIER}:${SKILL_NAME}\`: ${after.qualified}). The activation is `
          + '`activateNestedSkillRoots`, and it is supposed to reach all three runtimes through the shared base agent',
        )
        run.check(
          `[${family}] D1.67 — the same-named ROOT skill survives beside it`,
          after.root > 0,
          `\`skills.md:126\` — "If a nested skill shares a name with another skill, both stay available" — but the `
          + `root token is in the prompt ${after.root} time(s) after the nested one arrived`,
        )
        run.observe(`[${family}] the PAGE's own directory name, as a separate reading`, {
          claudeDirToken: after.claudeDir,
          note:
            'this fork scans `.agents/skills` and `.nessy-agent/skills` (`nestedSkillDirectories`), not the page\'s '
            + '`.claude/skills`; a zero here is that design, not a defect of the nested mechanism',
        })
      } catch (error) {
        run.check(
          `[${family}] the arm ran to a reading`,
          false,
          `the arm threw before it could answer: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
  } finally {
    // The project is removed ONLY when nothing is still pointing at it. Measured
    // on this case's second drive: an arm that threw left the app's "Trust this
    // project?" modal up, the `finally` deleted the directory under it, and the
    // modal then answered `Could not update project trust` to every click —
    // blocking every LATER case in the profile, not just this one. So the case
    // dismisses any dialog it left behind first, and only then deletes.
    await session.call<string>(`
      const d = document.querySelector('[role="dialog"]')
      if (!d) return 'none'
      const b = Array.from(d.querySelectorAll('button')).find(${buttonTextInPage(DIALOG_DISMISS_BUTTON_TEXTS)})
      if (!b) return 'no-button'
      b.click()
      return 'dismissed'
    `).catch(() => 'unreadable')
    try { rmSync(project.root, { recursive: true, force: true }) } catch { /* the temp dir is the OS's problem */ }
  }
}

if (import.meta.main) {
  await main(ID, TITLE, drive)
}
