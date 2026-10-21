/**
 * RS-54 (D1.33) — an Always Allow issued INSIDE a worktree, and where the rule
 * lands.
 *
 * ## The claim under test, and it is a claim about a PATH
 *
 * `SessionManager.persistBashAlwaysAllowRule` writes through
 * `resolveClaudeSettingsRoot(startDir)` into `addClaudePermissionRules('localSettings', …)`,
 * and `claude-settings-store.ts` resolves a worktree's `.git` FILE through
 * `gitdir` → `commondir` back to the MAIN CHECKOUT. So the source says an
 * approval granted inside a worktree is written to the main checkout's
 * `.claude/settings.local.json` and is therefore visible from every worktree of
 * that repository. P6.216 recorded that as delivered and unrowed; nothing has
 * driven it, and the row's two carve-outs — a NON-Bash approval staying session
 * scoped, and a non-repo-root start directory — have never been measured at all.
 *
 * ## Why a file on disk and not the card
 *
 * The card says *"Always allow"*; the question is whether a rule EXISTS
 * afterwards and WHERE. Those are different claims, and only the second one is a
 * fact the model cannot narrate: `.claude/settings.local.json` in the main
 * checkout either carries a `permissions.allow` entry naming the command or it
 * does not. The worktree's own copy is read in the same breath, because *"the
 * rule is in the main checkout"* and *"the rule is in both"* are different
 * answers and the row's propagation claim needs the first.
 *
 * ## The two controls
 *
 * 1. **A NON-Bash approval in the same run** — an EDIT inside the workspace,
 *    which this rig has measured raises a card in `default` mode. It must leave
 *    NO durable rule: the row's own residue says non-Bash approvals stay session
 *    scoped, and without this arm *"the Bash rule is on disk"* cannot be told
 *    from *"this build writes a rule for everything"*.
 * 2. **The card LADDER itself.** Measured 2026-09-17 on this rig: a plain `echo`
 *    in `default` mode on a claude-gateway session raises NO card and runs. So
 *    "no card appeared for the Bash arm" is a rig state, not a product verdict,
 *    and the case climbs spellings until one asks — reporting which, or blocking
 *    when none does.
 *
 * ## What this case creates and removes
 *
 * One git repository under the OS temp dir with a worktree inside it, both
 * removed in a `finally` along with this repository's own subdirectory of the
 * SHARED host worktree root. The settings files it reads are inside that
 * repository and go with it. No credential is read, printed or written.
 */

import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { approvePermissionsWhile, findCardButton, PERMISSION_BANNER } from '../lib/ask-user.ts'
import { appEnvBlockReason, readAppEnvContamination } from '../lib/app-env.ts'
import { sendPrompt } from '../lib/chat.ts'
import type { CdpSession } from '../lib/connect.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import { bindProject, listConnections, runtimeOf, switchRuntime, trustScratchProject, waitForConnection } from '../lib/runtime-switch.ts'
import { assertElectronApi, freshSession, selectorCount, setPermissionMode, type SessionKey } from '../lib/state.ts'
import { clickAt } from '../lib/viewport.ts'
import type { CaseMeta, SittingRecipe } from '../lib/sitting.ts'

const ID = 'RS-54'
const TITLE = 'an Always Allow granted inside a worktree, and whether the rule lands in the main checkout'

export const meta = {
  id: ID,
  title: TITLE,
  row: 'D1.33',
  runtimes: ['claude'],
  credentials: 'owner: any claude-runtime card. No key is read.',
} as const satisfies CaseMeta

export const manual = {
  steps: [
    '1. PACKAGED build, a config dir created for the run, the app launched with the lane shell\'s own CLAUDE_CODE_* names DELETED (lib/app-env.ts).',
    '2. Mint a git repository under the OS temp dir with one commit and a SECOND worktree added by hand — the second reader, which must see the same rule.',
    '3. A session on a claude-runtime card, working directory set to the repository, trust answered, permission mode `default` and READ BACK.',
    '4. Ask the session to create a worktree and move into it (`EnterWorktree`), and confirm from `git worktree list` that it did.',
    '5. THE SUBJECT: run a shell command from inside the worktree and answer its card with ALWAYS ALLOW, climbing spellings until one asks.',
    '6. Read `.claude/settings.local.json` in the main checkout, in the session\'s worktree and in the hand-made worktree.',
    '7. THE CONTROL: an EDIT approval in the same session answered with Allow — it must leave no durable rule.',
    '8. Remove the session\'s worktree and read the main checkout again: the rule must survive the worktree that produced it.',
  ],
  expected: 'The Bash rule is in the MAIN checkout\'s settings.local.json and therefore visible from both worktrees; it survives the worktree\'s removal; the edit approval leaves nothing.',
  detector: '`.claude/settings.local.json`\'s `permissions.allow` array, read from disk in three roots. Never the card\'s own words and never the model\'s: "always allow was offered" and "a rule exists" are different claims.',
  positiveControl: 'the EDIT approval, which must leave NO durable rule — without it, a rule on disk cannot be told from a build that writes one for every approval. And the card ladder: a plain `echo` raises no card in `default` on this build, so a silent Bash arm is a rig state and the case blocks rather than scoring it.',
  doneMeans: 'the A54 denominator carries the driven propagation reading and the two carve-outs stop being unmeasured.',
  doNotRead: 'Do NOT read this off `resolveClaudeSettingsRoot`. That the resolver walks `gitdir`/`commondir` is known; whether an approval issued by a real session lands there is what the row asks.',
} as const satisfies SittingRecipe

const SETTINGS = join('.claude', 'settings.local.json')

/** The `permissions.allow` entries at `root`, or `undefined` when there is no file. */
function allowRules(root: string): string[] | undefined {
  const file = join(root, SETTINGS)
  if (!existsSync(file)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { permissions?: { allow?: unknown } }
    const allow = parsed.permissions?.allow
    return Array.isArray(allow) ? allow.map(entry => String(entry)) : []
  } catch {
    return []
  }
}

function git(root: string, ...args: string[]): { ok: boolean; out: string } {
  const done = Bun.spawnSync(['git', ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
  return { ok: done.exitCode === 0, out: new TextDecoder().decode(done.stdout) + new TextDecoder().decode(done.stderr) }
}

function seedRepository(run: CaseRun): { root: string; sibling: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'nessy-rs54-repo-')))
  writeFileSync(join(root, 'README.md'), '# rs-54\n\nA probe repository.\n', 'utf8')
  const id = ['-c', 'user.email=rs54@example.invalid', '-c', 'user.name=RS-54']
  git(root, 'init', '--initial-branch=main')
  git(root, ...id, 'add', '--', 'README.md')
  git(root, ...id, 'commit', '-m', 'seed')
  // The SECOND reader, made by hand so it exists before any approval: a rule
  // that reaches it can only have come through the main checkout.
  const sibling = join(root, '..', `${basename(root)}-sibling`)
  git(root, 'worktree', 'add', '-b', 'rs54-sibling', sibling)
  run.observe('probe repository', { root, sibling })
  return { root, sibling }
}

function worktreeList(root: string): string[] {
  return git(root, 'worktree', 'list', '--porcelain').out
    .split('\n').filter(line => line.startsWith('worktree ')).map(line => line.slice('worktree '.length))
}

/** Press ALWAYS ALLOW on the visible card, and require that the card GOES. */
async function alwaysAllow(session: CdpSession, run: CaseRun, label: string): Promise<string> {
  const target = await findCardButton(session, { card: PERMISSION_BANNER, labels: ['always allow'], prefer: 'last' })
  run.observe(`${label}: the card's buttons`, target?.labels ?? [])
  if (!target) return 'no-always-allow-button among the VISIBLE copy'
  await clickAt(session, { x: target.x, y: target.y }, `${label}: Always Allow`)
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if ((await selectorCount(session, PERMISSION_BANNER)) === 0) return target.text || 'Always Allow'
    await Bun.sleep(500)
  }
  return `pressed ${target.text} but the card did NOT clear`
}

async function awaiting(session: CdpSession, key: SessionKey): Promise<number> {
  return session.call<number>(`
    const s = (await window.electronAPI.getSessions() ?? []).find(x => x.id === ${JSON.stringify(key.sessionId)})
    return s && typeof s.awaitingApprovalCount === 'number' ? s.awaitingApprovalCount : 0
  `).catch(() => 0)
}

/** Send `prompt` and answer the FIRST card it raises with Always Allow. */
async function turnAnsweredWithAlwaysAllow(
  run: CaseRun, session: CdpSession, key: SessionKey, label: string, prompt: string,
): Promise<{ asked: boolean; pressed: string }> {
  let asked = false
  let pressed = '(no card)'
  const turn = sendPrompt(session, key, prompt, 300_000)
  const watch = (async () => {
    const deadline = Date.now() + 290_000
    while (Date.now() < deadline) {
      await Bun.sleep(1_500)
      if ((await awaiting(session, key)) < 1) continue
      asked = true
      pressed = await alwaysAllow(session, run, label)
      return
    }
  })()
  await turn.catch(() => undefined)
  await watch
  run.observe(`${label}: reading`, { asked, pressed })
  return { asked, pressed }
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)

  const appEnv = readAppEnvContamination()
  run.observe('app-env', { pids: appEnv.pids.length, present: appEnv.present, controlSeen: appEnv.controlSeen })
  const contaminated = appEnvBlockReason(appEnv, 'the approval posture this case measures')
  if (contaminated !== undefined) blocked(contaminated)

  const connections = await listConnections(session)
  const claudeCard = connections.find(row => runtimeOf(row.providerType) === 'anthropic')?.slug
  if (!claudeCard) blocked('no claude-runtime connection on this host — `persistBashAlwaysAllowRule` is on the claude path')

  const { root, sibling } = seedRepository(run)
  try {
    const key = await freshSession(session, `CDP ${ID} ${new Date().toISOString().slice(11, 19)}`)
    run.check('the case ran in a session it created', key.fresh, key.reason ?? '')
    await switchRuntime(session, key.sessionId, claudeCard)
    run.check(
      `the session runs on ${claudeCard}`,
      (await waitForConnection(session, key.sessionId, claudeCard)) === claudeCard,
      String(claudeCard),
    )
    await bindProject(run, session, key.sessionId, root, {
      gate: () => trustScratchProject(session, root),
    })
    await setPermissionMode(session, key.sessionId, 'default').catch(() => undefined)

    const before = allowRules(root)
    run.require(
      'the main checkout carries NO allow rule before the run',
      before === undefined || before.length === 0,
      `the probe repository already holds ${JSON.stringify(before)} — a rule found later would not be this run's`,
    )

    // ---- into a worktree ---------------------------------------------------
    const worktreesBefore = worktreeList(root)
    await sendPrompt(session, key, 'Create a git worktree for this repository and move into it. Then tell me which directory you are in.', 300_000).catch(() => undefined)
    const created = worktreeList(root).filter(entry => !worktreesBefore.includes(entry))
    run.observe('worktrees', { before: worktreesBefore, created })
    run.require(
      'the session is working inside a worktree',
      created.length > 0,
      'no new `git worktree` entry — every reading below would be about the main checkout, which is the arm this row '
      + 'already has',
    )
    const worktree = created[0] as string

    // ---- THE SUBJECT: a Bash card, answered with Always Allow --------------
    //
    // A LADDER: measured 2026-09-17 on this rig a plain `echo` raises NO card in
    // `default` on a claude-gateway session and simply runs, so a silent arm is
    // a rig state and not the product's answer.
    //
    // AND the spelling must not be in `DANGEROUS_COMMANDS` (`permission-manager.ts`),
    // which is the OTHER half and was measured the hard way: `curl` raised a card
    // on the first drive, Always Allow was pressed, the card cleared and NOTHING
    // was written — correctly, because `persistBashAlwaysAllowRule` returns early
    // for a dangerous base command with *"stays session-scoped (dangerous or
    // unparsed base command)"*. `curl`, `chmod`, `rm`, `mv`, `cp`, `ssh` and
    // `git push` are all in that set, so every obvious "risky enough to ask"
    // spelling is also one this row cannot use. The ladder therefore needs a
    // command that is gated by the CARD and not by the persister.
    const spellings = [
      { label: 'SUBJECT-1/touch', command: 'touch rs54-probe.txt' },
      { label: 'SUBJECT-2/git-tag', command: 'git tag rs54-probe' },
      { label: 'SUBJECT-3/uname', command: 'uname -a' },
    ] as const
    let asked: { label: string; pressed: string } | undefined
    for (const spelling of spellings) {
      const reading = await turnAnsweredWithAlwaysAllow(
        run, session, key, spelling.label,
        `Run the shell command \`${spelling.command}\` and tell me what it printed.`,
      )
      if (reading.asked) { asked = { label: spelling.label, pressed: reading.pressed }; break }
    }
    run.observe('subject ladder', asked ?? '(no spelling raised a card)')
    if (!asked) {
      blocked(
        'no Bash spelling raised a permission card in `default` mode on this session '
        + `(${spellings.map(spelling => spelling.command).join(', ')}), so there was no Always Allow to grant and the `
        + 'propagation question cannot be reached. That is a reading about this build\'s `default` posture — the same '
        + 'shape RS-53 measured for `echo` — and it belongs in the row rather than being scored as a failure.',
      )
    }

    // ---- where the rule landed --------------------------------------------
    const afterMain = allowRules(root)
    const afterWorktree = allowRules(worktree)
    const afterSibling = allowRules(sibling)
    // AND the reading that actually answers the propagation clause, which the
    // first two do not. A worktree is its own directory and does NOT contain the
    // main checkout's `.claude/`, so `allowRules(sibling)` is `undefined` even
    // when propagation works perfectly — the first drive of this case scored
    // exactly that as a FAIL against a product that was right. What the claim
    // means is that a session started IN the sibling resolves its settings root
    // back to the main checkout, which is what `resolveClaudeSettingsRoot` does
    // through `gitdir` -> `commondir`. That walk is RESTATED here with git's own
    // `rev-parse`, never imported: this harness restates what it asserts, and a
    // reader derived from the module under test would agree with it whatever it
    // said.
    const siblingCommonDir = git(sibling, 'rev-parse', '--path-format=absolute', '--git-common-dir').out.trim()
    const siblingSettingsRoot = siblingCommonDir.endsWith('/.git')
      ? siblingCommonDir.slice(0, -'/.git'.length)
      : siblingCommonDir
    const afterSiblingResolved = allowRules(siblingSettingsRoot)
    run.observe('rules after the Always Allow', {
      main: afterMain,
      worktree: afterWorktree,
      siblingOwnDirectory: afterSibling,
      siblingSettingsRoot,
      siblingResolved: afterSiblingResolved,
    })
    run.check(
      'THE SUBJECT — the rule is written to the MAIN checkout',
      (afterMain ?? []).length > 0,
      `the main checkout holds ${JSON.stringify(afterMain)} after an Always Allow granted inside ${worktree}`,
    )
    // NOT vacuous: `undefined === undefined` is what a run with no rule anywhere
    // produces, and reading that as propagation is the exact shape of a control
    // that agrees for the wrong reason. The main checkout must carry a rule for
    // this arm to mean anything, so its emptiness fails HERE as well as above.
    // NOT vacuous: `undefined === undefined` is what a run with no rule anywhere
    // produces, and reading that as propagation is the exact shape of a control
    // that agrees for the wrong reason. The main checkout must carry a rule for
    // this arm to mean anything, so its emptiness fails HERE as well as above.
    run.check(
      'and a SECOND worktree made before the grant resolves to the same settings root',
      (afterMain ?? []).length > 0
      && siblingSettingsRoot === root
      && JSON.stringify(afterSiblingResolved ?? []) === JSON.stringify(afterMain ?? []),
      (afterMain ?? []).length === 0
        ? 'the main checkout carries no rule, so "the sibling agrees" is two empties agreeing and says nothing'
        : `the sibling's own git metadata resolves to ${siblingSettingsRoot} (expected ${root}) and the rules there `
          + `read ${JSON.stringify(afterSiblingResolved)} against the main checkout's ${JSON.stringify(afterMain)}. `
          + `Its OWN directory holds ${JSON.stringify(afterSibling)}, which is `
          + 'expected to be undefined and is not the question.',
    )

    // ---- THE CONTROL: a non-Bash approval stays session-scoped -------------
    const rulesBeforeEdit = JSON.stringify(allowRules(root) ?? [])
    const approver = approvePermissionsWhile(session, key.sessionId)
    await sendPrompt(session, key, 'Create a file named RS54.md in this directory whose only line is RS54-EDIT.', 300_000).catch(() => undefined)
    const editApprovals = await approver.stop()
    const rulesAfterEdit = JSON.stringify(allowRules(root) ?? [])
    run.observe('edit control', { editApprovals, rulesBeforeEdit, rulesAfterEdit })
    run.check(
      'THE CONTROL — a non-Bash approval leaves NO durable rule',
      editApprovals > 0 && rulesAfterEdit === rulesBeforeEdit,
      editApprovals === 0
        ? 'the edit raised no card, so this control proves nothing about what an approval writes'
        : `the allow list moved from ${rulesBeforeEdit} to ${rulesAfterEdit} on an EDIT approval — the rule store is `
          + 'not Bash-only and the subject reading above is about approvals in general',
    )

    // ---- and it survives the worktree that produced it ---------------------
    git(root, 'worktree', 'remove', '--force', worktree)
    const afterRemoval = allowRules(root)
    run.observe('after the worktree was removed', { main: afterRemoval, worktrees: worktreeList(root) })
    run.check(
      'the rule survives the removal of the worktree it was granted in',
      (afterMain ?? []).length > 0 && JSON.stringify(afterRemoval ?? []) === JSON.stringify(afterMain ?? []),
      `the main checkout reads ${JSON.stringify(afterRemoval)} after the worktree was removed, against `
      + `${JSON.stringify(afterMain)} before`,
    )
  } finally {
    rmSync(join(root, '..', '.nessy-worktrees', basename(root)), { recursive: true, force: true })
    rmSync(sibling, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  await main(ID, TITLE, drive)
}
