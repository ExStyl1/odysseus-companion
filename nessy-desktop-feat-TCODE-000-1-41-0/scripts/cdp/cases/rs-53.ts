/**
 * RS-53 (D1.235) — the worktree approval RS-51 never saw, driven in `default`
 * mode with a card that must appear beside it.
 *
 * ## The open question this case closes
 *
 * RS-51 (D1.21) drove claude's own `EnterWorktree` on the packaged 1.39.0. It
 * fired, it created a worktree under the HOST's own root
 * (`<parent-of-repo>/.nessy-worktrees/…`), and `awaitingApprovalCount` stayed
 * **0** throughout. The ledger's `I2` cell quotes the page verbatim: *"When
 * Claude enters a path outside the repository's `.claude/worktrees/` directory,
 * Claude Code asks for your approval first … only `bypassPermissions` mode skips
 * it."* The worktree was outside that directory, the session's resolved mode was
 * `auto`, and nothing asked.
 *
 * Three readings fit that, and RS-51 could not tell them apart:
 *
 *  1. the approval IS routed through the host card and `auto` suppressed it;
 *  2. it is routed and SWALLOWED — raised somewhere nothing renders;
 *  3. it is NOT OWED, because P2.458's `withClaudeWorktreeHooks` answers the
 *     SDK's `WorktreeCreate` host-side, so the SDK's own prompt never enters the
 *     path at all.
 *
 * ## What separates them, and it is one variable
 *
 * `default` — the mode whose whole job is to ask. If the approval is routed
 * through the host card (reading 1), moving off `auto` makes it appear. If it
 * still does not appear in `default`, reading 1 is dead and the answer is 2 or 3.
 *
 * ## THE POSITIVE CONTROL, and the case is worthless without it
 *
 * *"No card appeared"* is also what a session whose card mechanism is broken
 * says, and what a turn that never reached the model says. So the SAME session
 * in the SAME mode is first asked to run a shell command it has never been
 * granted — which in `default` MUST raise a card. The subject turn is scored
 * only against a control that raised one; a control of zero makes the subject
 * reading unavailable rather than negative, and the case says so.
 *
 * The control is deliberately run FIRST: a card the approver answers with Allow
 * is remembered for the session, so running it after the subject would let an
 * unrelated grant change what the subject turn is allowed to do.
 *
 * ## The detector
 *
 * `approvePermissionsWhile`'s own approval COUNT — the number of times the
 * session's `awaitingApprovalCount` rose above zero and a visible Allow was
 * clicked — read per turn. Never the model's prose about whether it was asked:
 * a refusal it narrates and an approval it received read identically, which is
 * the fault `w19r-c3-4`'s five outcomes exist for.
 *
 * Beside it, the two facts on disk: whether `git worktree list` in the probe
 * repository gained an entry, and under which root. Those say whether the
 * subject turn did the thing at all — an unasked approval for an action that
 * never happened is not an answer.
 *
 * ## What this case creates and removes
 *
 * One git repository under the OS temp dir, removed in a `finally` together with
 * any worktree inside it. No credential is read, printed or written; nothing
 * outside the temp dir and the rig's own profile is touched.
 */

import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { approvePermissionsWhile, requireApproverSaw } from '../lib/ask-user.ts'
import { appEnvBlockReason, readAppEnvContamination } from '../lib/app-env.ts'
import { sendPrompt } from '../lib/chat.ts'
import type { CdpSession } from '../lib/connect.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import { bindProject, buttonTextInPage, CANCEL_BUTTON_TEXTS, listConnections, runtimeOf, switchRuntime, TRUST_GATE_HEADING_IN_PAGE, trustScratchProject, waitForConnection } from '../lib/runtime-switch.ts'
import { assertElectronApi, freshSession, setPermissionMode, type SessionKey } from '../lib/state.ts'
import type { CaseMeta, SittingRecipe } from '../lib/sitting.ts'

const ID = 'RS-53'
const TITLE = 'the worktree approval in `default` mode: routed through the host card, swallowed, or not owed'

export const meta = {
  id: ID,
  title: TITLE,
  row: 'D1.235',
  runtimes: ['claude'],
  credentials: 'owner: any claude-runtime card (the Claude Code gateway card does). No key is read.',
} as const satisfies CaseMeta

export const manual = {
  steps: [
    '1. PACKAGED build, one content panel, a config dir created for the run, and the app launched with the lane shell\'s own CLAUDE_CODE_* names DELETED (see lib/app-env.ts).',
    '2. Mint a git repository under the OS temp dir with one commit. Bind a new session to a claude-runtime card, set the working directory to it and answer the trust gate.',
    '3. Set the permission mode to `default` and READ IT BACK off the session row — a mode that did not take makes every reading below a reading about `auto`.',
    '4. THE CONTROL, first: ask for a shell command this session has never been granted. In `default` a card must appear; the approver answers Allow and the count is recorded.',
    '5. THE SUBJECT: ask the session to work in a git worktree. Record the approval count for that turn, and read `git worktree list --porcelain` in the repository before and after.',
    '6. Score the subject ONLY against a control that raised a card. Report which of the three readings survives.',
  ],
  expected: 'The control raises at least one card. If the subject raises one too, the approval is routed through the host card and `auto` was suppressing it; if the subject raises none while a worktree appears, reading 1 is dead and the residue is swallowed-or-not-owed.',
  detector: 'the per-turn approval count from `approvePermissionsWhile` — the session\'s own `awaitingApprovalCount` rising and a VISIBLE Allow being clicked — plus `git worktree list --porcelain` in the probe repository. Never the model\'s prose: a refusal it narrates and an approval it received read identically.',
  positiveControl: 'the ungranted shell command in the SAME session and the SAME mode, run FIRST. Without a control that raised a card, "the subject raised none" is indistinguishable from a session whose card mechanism is not alive, and the case reports the subject as UNAVAILABLE rather than as an answer.',
  doneMeans: 'D1.235 records which of the three readings survives, and the `I2` cell\'s quoted approval sentence carries the measurement beside it.',
  doNotRead: 'Do NOT read this off `withClaudeWorktreeHooks`. That the host answers `WorktreeCreate` is known; whether the person is asked is a property of the running session and only a drive says so.',
} as const satisfies SittingRecipe

/** A real git repository for the session to work in, with one commit. */
function seedRepository(run: CaseRun): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'nessy-rs53-repo-')))
  writeFileSync(join(root, 'README.md'), '# rs-53\n\nA probe repository.\n', 'utf8')
  const git = (...args: string[]): void => {
    const done = Bun.spawnSync(['git', ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
    if (done.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${new TextDecoder().decode(done.stderr)}`)
  }
  git('init', '--initial-branch=main')
  git('-c', 'user.email=rs53@example.invalid', '-c', 'user.name=RS-53', 'add', '--', 'README.md')
  git('-c', 'user.email=rs53@example.invalid', '-c', 'user.name=RS-53', 'commit', '-m', 'seed')
  run.observe('probe repository', { root })
  return root
}

/** Every `git worktree` this repository knows about, as the repository reports them. */
function worktreeList(root: string): string[] {
  const done = Bun.spawnSync(['git', 'worktree', 'list', '--porcelain'], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
  return new TextDecoder().decode(done.stdout)
    .split('\n')
    .filter(line => line.startsWith('worktree '))
    .map(line => line.slice('worktree '.length))
}

async function resolvedMode(session: CdpSession, key: SessionKey): Promise<string | undefined> {
  return session.call<string | undefined>(`
    const rows = await window.electronAPI.getSessions()
    return (rows ?? []).find(s => s.id === ${JSON.stringify(key.sessionId)})?.permissionMode
  `).catch(() => undefined)
}

/** One turn with the approver running beside it, returning what it had to answer. */
async function turnWithApprovals(
  run: CaseRun,
  session: CdpSession,
  key: SessionKey,
  label: string,
  prompt: string,
): Promise<{ approvals: number; text: string }> {
  const approver = approvePermissionsWhile(session, key.sessionId)
  let text = ''
  let approvals = 0
  try {
    const turn = await sendPrompt(session, key, prompt, 300_000)
    text = 'added' in turn
      ? turn.added.filter(message => message.role === 'assistant').map(message => message.content ?? '').join('\n')
      : String((turn as { error?: unknown }).error ?? '')
  } finally {
    // The approver is stopped even when the turn threw, or the loop outlives the
    // case and the NEXT turn's count includes this one's clicks.
    approvals = await approver.stop()
  }
  // D1.356 — this case's verdict IS the approval count: `control.approvals > 0`
  // decides whether the ladder found a rung, and `subject.approvals > 0` decides
  // ROUTED against NOT ROUTED. A zero the loop could not see would be read as
  // "the worktree turn raised no card", which is the finding itself.
  requireApproverSaw(run, approver, label)
  run.observe(`${label}: reading`, { approvals, head: text.replace(/\s+/g, ' ').slice(0, 300) })
  return { approvals, text }
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)

  const appEnv = readAppEnvContamination()
  run.observe('app-env', { pids: appEnv.pids.length, present: appEnv.present, controlSeen: appEnv.controlSeen })
  const contaminated = appEnvBlockReason(appEnv, 'the permission posture this case measures')
  if (contaminated !== undefined) blocked(contaminated)

  const connections = await listConnections(session)
  const claudeCard = connections.find(row => runtimeOf(row.providerType) === 'anthropic')?.slug
  if (!claudeCard) {
    blocked(
      'no claude-runtime connection on this host, and the worktree built-in is claude\'s own — there is nothing to '
      + `measure on another runtime. The host lists ${connections.map(row => `${row.slug}(${row.providerType})`).join(', ') || 'nothing'}.`,
    )
  }

  // A STALE trust dialog blocks the composer for every later session and cannot
  // be answered once its directory is gone (RS-51's own measurement, 2026-09-17).
  const stale = await session.call<string>(`
    const heading = Array.from(document.querySelectorAll('h1,h2,h3,[role="dialog"] *'))
      .find(${TRUST_GATE_HEADING_IN_PAGE})
    if (!heading) return 'none'
    const cancel = Array.from(document.querySelectorAll('button'))
      .find(${buttonTextInPage(CANCEL_BUTTON_TEXTS)})
    if (!cancel) return 'a trust dialog is up and has no Cancel button'
    cancel.click()
    await new Promise(resolve => setTimeout(resolve, 800))
    return 'dismissed a stale trust dialog'
  `).catch((cause: unknown) => `unreadable: ${String(cause)}`)
  run.observe('stale trust dialog before this run', stale)

  const root = seedRepository(run)
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

    // ---- the one variable, set and READ BACK -------------------------------
    await setPermissionMode(session, key.sessionId, 'default').catch(() => undefined)
    const mode = await resolvedMode(session, key)
    run.require(
      'the session really is in `default` mode',
      mode === 'default',
      `the session row reports ${JSON.stringify(mode)} — every reading below would be about that mode instead, which `
      + 'is the mode RS-51 already measured',
    )

    // ---- THE CONTROL LADDER, first -----------------------------------------
    //
    // A LADDER and not one command, because the first rung is a measurement in
    // its own right and it FAILED as a control: driven 2026-09-17 on this rig, a
    // plain `echo` in `default` mode on a claude-gateway session raised ZERO
    // cards and ran. That is the same shape sitting 2 recorded for codex
    // (*"a codex session in `default` mode ran a never-granted Bash command
    // unasked"*), now on claude — so the rung is kept, and reported, rather than
    // replaced by the one that works.
    //
    // The second rung is a WRITE OUTSIDE THE WORKSPACE, which is the action RS-11
    // and RS-15 are both built around, under `~/.cache` and not `$TMPDIR` for
    // D1.143's reason: a temp path is inside a root the runtime already grants.
    const rungs = [
      {
        label: 'CONTROL-1/echo',
        prompt: 'Run the shell command `echo RS53-CONTROL` in this directory and tell me exactly what it printed.',
        why: 'an ordinary shell command — the weakest rung, and on this build it runs unasked',
      },
      {
        label: 'CONTROL-2/edit-inside',
        prompt: 'Create a file named RS53.md in this directory whose only line is RS53-EDIT, then tell me what the '
          + 'tool reported.',
        why: 'an EDIT inside the workspace — the documented discriminator, since `acceptEdits` exists precisely '
          + 'because `default` asks for one',
      },
      {
        label: 'CONTROL-3/outside-write',
        prompt: `Create a file at ${join(homedir(), '.cache', 'nessy-cdp-rs53', 'marker.txt')} whose only line is `
          + 'RS53-OUTSIDE, then tell me what the tool reported.',
        why: 'a write OUTSIDE the workspace — RS-11 and RS-15\'s own action. Driven 2026-09-17 it raised no card '
          + 'AND wrote no file, which is a DENY rather than an ask, so it is the weakest rung for this purpose',
      },
    ] as const
    let control = { approvals: 0, text: '' }
    let controlRung = '(none raised a card)'
    for (const rung of rungs) {
      const reading = await turnWithApprovals(run, session, key, rung.label, rung.prompt)
      run.observe(`${rung.label}: ${rung.why}`, { approvals: reading.approvals })
      if (reading.approvals > 0) {
        control = reading
        controlRung = rung.label
        break
      }
    }
    run.observe('control ladder', { rungThatAsked: controlRung, approvals: control.approvals })
    run.check(
      'THE CONTROL — SOME ungranted action in `default` raises a card on this session',
      control.approvals > 0,
      `no rung of the ladder raised a card (${rungs.map(rung => rung.label).join(', ')}), so this session's card `
      + 'mechanism is not demonstrably alive and the subject reading below is UNAVAILABLE rather than negative. That '
      + 'is itself a reading about `default` mode on this runtime and is recorded as one.',
    )

    // ---- THE SUBJECT -------------------------------------------------------
    const worktreesBefore = worktreeList(root)
    const subject = await turnWithApprovals(
      run, session, key, 'SUBJECT',
      'Create a git worktree for this repository and move into it. Then tell me which directory you are in.',
    )
    const worktreesAfter = worktreeList(root)
    const created = worktreesAfter.filter(entry => !worktreesBefore.includes(entry))
    run.observe('worktrees', { before: worktreesBefore, after: worktreesAfter, created })

    run.check(
      'the subject turn actually created a worktree',
      created.length > 0,
      'no new `git worktree` entry — an unasked approval for an action that never happened is not an answer, and the '
      + 'subject reading below says nothing',
    )
    // The reading, NOT a pass/fail on the product: which of the three readings
    // survives is what the row asks for, and both outcomes are real answers.
    run.check(
      'THE SUBJECT — reading 1 (routed through the host card, suppressed by `auto`) is testable here',
      control.approvals > 0,
      'scored only against a live control; see above',
    )
    const verdict = control.approvals === 0
      ? 'UNAVAILABLE — the control raised no card, so nothing about the subject can be concluded'
      : subject.approvals > 0
        ? `ROUTED — the worktree turn raised ${subject.approvals} approval(s) in \`default\` against `
          + `${control.approvals} for the control (${controlRung}), so the approval IS on the host card and \`auto\` `
          + 'is what suppressed it in RS-51'
        : `NOT ROUTED — the control (${controlRung}) raised ${control.approvals} approval(s) and the worktree turn raised ZERO in the `
          + `same session and the same mode, with ${created.length} worktree(s) created. Reading 1 is dead: the `
          + 'documented non-suppressible approval is not reaching the host card at all, which leaves SWALLOWED or '
          + 'NOT OWED — and the host answering `WorktreeCreate` itself (P2.458) is the explanation that needs no '
          + 'defect'
    run.observe('verdict', verdict)
  } finally {
    // This repository's own worktrees and then the repository, both by EXACT
    // path. The host's root is SHARED — `<parent-of-repo>/.nessy-worktrees/`
    // holds a directory per repository — so removing the root itself would take
    // a sibling case's worktrees with it; only this repository's subdirectory is
    // removed, named after the repository the case minted.
    rmSync(join(root, '..', '.nessy-worktrees', basename(root)), { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
    // The control ladder's second rung writes one marker outside the workspace,
    // by exact path and under this case's own directory name.
    rmSync(join(homedir(), '.cache', 'nessy-cdp-rs53'), { recursive: true, force: true })
  }
}

if (import.meta.main) {
  await main(ID, TITLE, drive)
}
