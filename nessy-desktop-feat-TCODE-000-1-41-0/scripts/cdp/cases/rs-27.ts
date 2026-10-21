/**
 * RS-27 (P6.854) — is claude's native `EnterWorktree` OFFERED at all, and what
 * cwd results.
 *
 * ## The premise this case exists to test
 *
 * Ledger I2's claude verdict rests on a premise three measurements contradict.
 * The vendored `@anthropic-ai/claude-agent-sdk/sdk-tools.d.ts` declares
 * `EnterWorktreeInput` and `ExitWorktreeInput` in its `ToolInputSchemas` union;
 * `CLAUDE_SESSION_DISALLOWED_TOOLS` does not subtract them; and `worktrees.md`
 * documents the RUNTIME's own approval prompt for a path outside the
 * repository's `.claude/worktrees/` directory. **A type declaration is not a
 * behaviour** — which is the whole reason this is a measure. One session says
 * whether the tool is really there.
 *
 * Our own `EnterWorktree` is `visibility: 'pi-only'`, so on a claude session the
 * NATIVE tool is the only candidate. Anything that answers here is the runtime's.
 *
 * ## The ambiguity a naive run walks into, and the control that removes it
 *
 * "I asked for a worktree and no `EnterWorktree` entry appeared" has two causes
 * that look identical: the tool is not on the session's tool set, or the model
 * declined to use it. So the case first establishes COMPLIANCE — one turn asking
 * for an ordinary tool call that must appear — and only then reads the absence
 * as evidence about the tool set. Without it this case would file a model's mood
 * as a capability finding.
 *
 * ## The cwd half
 *
 * The row asks *"what cwd results"*, and that is a state read rather than a
 * model claim: `getSessions()` carries the session's own `workingDirectory`,
 * before and after. A model saying "I am now in the worktree" is not evidence;
 * the session's own record of where it is, is.
 *
 * This also decides the fate of P2.108's retirement — *"a Claude-backed session
 * can NEVER be in the worktree isolation state"*. If the cwd moves, that sentence
 * is refuted by a run and the retirement is revisited.
 *
 * ## The rig
 *
 * A scratch git repository the case creates under the OS temp dir, with one
 * commit, because a worktree needs a repository and the operator's own tree must
 * never be the subject. It is removed at the end.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { approvePermissionsWhile, requireApproverSaw } from '../lib/ask-user.ts'
import { sendPrompt } from '../lib/chat.ts'
import type { CdpSession } from '../lib/connect.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import { bindProject, boundCard, listConnections, runtimeOf, trustScratchProject } from '../lib/runtime-switch.ts'
import { assertElectronApi, freshSession, listSessions, setPermissionMode, type TranscriptMessage } from '../lib/state.ts'
import type { CaseMeta, SittingRecipe } from '../lib/sitting.ts'

const ID = 'RS-27'
const TITLE = 'whether claude’s native EnterWorktree is offered on a real session, and what working directory results'

export const meta = {
  id: ID,
  title: TITLE,
  row: 'P6.854',
  runtimes: ['claude'],
  credentials: 'owner: a claude-runtime card (the "Claude Code (Nessy Gateway)" card is enough), already signed in. No key is read.',
} as const satisfies CaseMeta

/**
 * A repository to cut a worktree from — scratch, disposable, never the operator's.
 *
 * The path is REALPATHED, and that is not tidiness. On macOS `tmpdir()` answers
 * `/var/folders/…`, `/var` is a symlink to `/private/var`, and the app resolves
 * the directory before it records it — so the session reports
 * `/private/var/folders/…` and a string compare against what this function
 * returned fails on two spellings of one directory. RS-27 scored exactly that
 * FAIL on the packaged 1.36.0 (2026-09-11), on a session that was working in the
 * right tree, with the message "a worktree cut from the wrong tree would be
 * measured here" — a detector reporting the defect it exists to catch, about
 * itself.
 */
export function scratchRepository(label: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `nessy-${label}-`)))
  writeFileSync(join(dir, 'README.md'), `# ${label}\n\nA scratch repository created by the CDP harness.\n`, 'utf8')
  const git = (...args: string[]): void => { execFileSync('git', args, { cwd: dir, stdio: 'ignore' }) }
  git('init', '-q')
  git('config', 'user.email', 'cdp@example.invalid')
  git('config', 'user.name', 'CDP harness')
  git('add', '--', 'README.md')
  git('commit', '-q', '-m', 'scratch')
  return dir
}

/** Every `EnterWorktree` spelling a transcript entry might carry. */
export function worktreeEntries(messages: readonly TranscriptMessage[]): TranscriptMessage[] {
  return messages.filter(m => typeof m.toolName === 'string' && /enter[_-]?worktree/i.test(m.toolName))
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)

  const key = await freshSession(session, `CDP ${ID} ${new Date().toISOString().slice(11, 19)}`)
  run.observe('session', { workspaceId: key.workspaceId, sessionId: key.sessionId })
  run.check('the case ran in a session it created', key.fresh, key.fresh ? undefined : `inherited ${key.inheritedMessages} messages`)

  const slug = await boundCard(session, key.sessionId)
  const rows = await listConnections(session)
  const connection = rows.find(r => r.slug === slug)
  if (!connection || runtimeOf(connection.providerType) !== 'anthropic') {
    blocked(
      'this case is about claude\'s NATIVE worktree tool and refuses to pass vacuously elsewhere. '
      + `This session is on ${connection ? `${connection.slug}(${connection.providerType})` : 'no connection'}; `
      + `the app lists: ${rows.map(r => `${r.slug}(${r.providerType})`).join(', ') || 'nothing'}`,
    )
  }
  run.observe('card', { slug: connection.slug, name: connection.name, providerType: connection.providerType })

  // The posture — PR-3 (W14-sit, 2026-09-11). `acceptEdits` rather than
  // `bypassPermissions`, and the difference is load-bearing for the PAIR: RS-28
  // reads our own floor's refusal sentence as its instrument, and
  // `pre-tool-use.ts` grants `bypassPermissions` the one documented escape from
  // the worktree approval. Standing the floor down here would leave the two
  // halves of one question measured under two different regimes. The approver
  // underneath answers whatever `acceptEdits` does not cover, and its count is
  // recorded rather than hidden — a run that needed five cards is not the same
  // reading as one that needed none.
  const setMode = await setPermissionMode(session, key.sessionId, 'acceptEdits').then(() => 'set').catch(error => `refused: ${String(error)}`)
  run.observe('permission-posture', { posture: 'acceptEdits', outcome: setMode })
  const approver = approvePermissionsWhile(session, key.sessionId)

  const repository = scratchRepository('rs27-repo')
  run.observe('repository', repository)
  try {
    await bindProject(run, session, key.sessionId, repository, {
      gate: () => trustScratchProject(session, repository),
    })
    const before = (await listSessions(session)).find(s => s.id === key.sessionId)?.workingDirectory
    run.observe('cwd-before', before)
    run.require(
      'the session is working in the scratch repository',
      before === repository,
      `it reports ${String(before)} — a worktree cut from the wrong tree would be measured here`,
    )

    // ---- THE COMPLIANCE CONTROL ------------------------------------------
    const compliance = await sendPrompt(
      session,
      key,
      'Read the file README.md in your working directory and tell me its first line.',
      180_000,
    )
    const complianceTools = compliance.added.filter(m => m.toolName).map(m => m.toolName)
    run.observe('compliance-tools', complianceTools)
    run.require(
      'THE CONTROL — this session calls tools when asked',
      complianceTools.length > 0,
      'the model answered without calling a tool, so an absent EnterWorktree below would say nothing about the tool set',
    )

    // ---- THE PROBE --------------------------------------------------------
    const probe = await sendPrompt(
      session,
      key,
      'Move your work into an isolated git worktree of this repository using your worktree tool, '
      + 'then tell me which directory you are working in now.',
      300_000,
    )
    const probeTools = probe.added.filter(m => m.toolName).map(m => ({ tool: m.toolName, status: m.toolStatus }))
    const entries = worktreeEntries(probe.added)
    run.observe('probe-tools', probeTools)
    run.observe('enter-worktree-entries', entries.map(m => ({ tool: m.toolName, status: m.toolStatus, result: m.toolResult?.slice(0, 400) })))

    run.check(
      'claude’s native EnterWorktree is on this session’s tool set and was called',
      entries.length > 0,
      entries.length > 0
        ? undefined
        : 'no EnterWorktree entry in the turn, with the compliance control green — evidence the tool is NOT offered on a Nessy claude session,'
          + ' which is the reading I2 rests on and this run is here to confirm or refute',
    )

    const after = (await listSessions(session)).find(s => s.id === key.sessionId)?.workingDirectory
    run.observe('cwd-after', after)
    run.observe(
      'p2-108-retirement',
      after !== before
        ? `REFUTED by this run: the session moved to ${String(after)}, so a Claude-backed session CAN be in the worktree isolation state — revisit P2.108`
        : 'not refuted by this run: the working directory did not move',
    )
    run.check(
      'the resulting working directory is recorded either way',
      typeof after === 'string',
      'the session reports no working directory after the turn, so the cwd half cannot be written',
    )
  } finally {
    run.observe('permission-cards-answered', await approver.stop().catch(() => -1))
    try { rmSync(repository, { recursive: true, force: true }) } catch { /* the scratch dir, not evidence */ }
  }
  // D1.356 — the `-1` above says the STOP threw; it says nothing about what the
  // polls read, and this case's cwd reading comes out of a turn the approver had
  // to keep moving.
  requireApproverSaw(run, approver, 'the worktree turn')
}

if (import.meta.main) {
  await main(ID, TITLE, drive)
}

export const manual = {
  steps: [
    '1. PACKAGED build, dark theme, one content panel. New session on the claude-runtime card.',
    '2. `bun run scripts/cdp/cases/rs-27.ts` with NESSY_CDP_PORT pointed at the app.',
    '3. Read `enter-worktree-entries` and `cwd-after` off the result line, and `p2-108-retirement` for whether the retirement is refuted.',
    '4. Run RS-28 next, in the same sitting: it answers the adjacent question — whether the SDK routes that same tool through our `canUseTool` floor.',
  ],
  expected: 'either an EnterWorktree entry with a working directory that moved (the tool is real and the isolation state is reachable on claude), or no entry with the compliance control green (the tool is not offered, and I2 stands).',
  detector: 'the tool ENTRY in the transcript for whether it was called, and `getSessions().workingDirectory` before and after for what resulted. A model saying it moved is not evidence; the session\'s own record of where it is, is.',
  positiveControl: 'one turn asking for an ordinary tool call, which must produce a tool entry — otherwise an absent EnterWorktree measures the model\'s mood rather than the tool set.',
  doneMeans: 'drive one claude session (packaged sitting), record whether the tool is offered and what cwd results, re-score; revisit P2.108\'s ‘a Claude-backed session can NEVER be in the worktree isolation state’ retirement.',
} as const satisfies SittingRecipe
