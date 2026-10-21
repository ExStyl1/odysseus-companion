/**
 * RS-28 (P6.839's residual) — does the SDK route its native `EnterWorktree`
 * through OUR `canUseTool`?
 *
 * P6.839 is decided and built: option A minus the `bgIsolation` field — supply
 * the repository facts so the native tool passes the host floor once. The decision
 * tail names what is left: *"whether the SDK routes it through `canUseTool` is a
 * P7.5 case."* It is documented, not measured, and the two are different claims.
 *
 * ## Why "the tool worked" cannot answer it
 *
 * With the repository facts supplied, a successful `EnterWorktree` is exactly
 * what BOTH worlds produce: the floor saw it and allowed it, or the floor never
 * saw it at all. A pass proves nothing. The question needs a condition under
 * which the two worlds DISAGREE.
 *
 * ## The discriminator: a session whose cwd is not a repository
 *
 * `worktreeGateContext()` is what supplies the floor's input. Without it the
 * floor fails CLOSED with a sentence of its own — measured against
 * `runPreToolUseChecks` directly and recorded in `session-tools-core/tool-defs.ts`:
 * `EnterWorktree` with no worktree context is `block`, *"this session has no
 * repository to create or enter a worktree in"*; with it, `allow`; and
 * `prompt`/`worktree_approval` for a path outside the namespace.
 *
 * So point a claude session at a directory that is NOT a git repository and ask
 * for a worktree:
 *
 * | What comes back | What it means |
 * | --- | --- |
 * | the host's own sentence above | the SDK DOES route the native tool through `canUseTool` — our floor answered |
 * | the runtime's own words, or a plain failure | the floor never saw the call; the SDK owns this tool end to end |
 * | no `EnterWorktree` entry at all | the model did not attempt it — NOT a verdict. Recorded as `not-attempted`, because scoring it either way would be inventing a reading |
 *
 * The host sentence is the instrument precisely because it is OURS: no upstream
 * would produce it.
 *
 * ## The two controls
 *
 * 1. **Arm A, the repository session** — the same request against a real
 *    repository, which must NOT produce the host sentence. Without it, a rig
 *    where every worktree request fails for an unrelated reason would read as
 *    "the floor is in the path" on the strength of a coincidence.
 * 2. **A working session in arm B** — an ordinary read in the non-repository
 *    directory, which must succeed. Without it, "the worktree call was refused"
 *    is indistinguishable from a session that cannot do anything there.
 *
 * ## Pairing
 *
 * Run RS-27 first in the same sitting: it answers whether the tool is offered at
 * all, and this case is only meaningful once it is. The scratch-repository and
 * entry-matching helpers are imported from it deliberately, so the pair cannot
 * drift apart — importing a case module drives nothing (`import.meta.main` is
 * false under import, which `harness.test.ts` asserts for the whole cases
 * directory).
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { approvePermissionsWhile } from '../lib/ask-user.ts'
import { sendPrompt } from '../lib/chat.ts'
import type { CdpSession } from '../lib/connect.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import { bindProject, boundCard, listConnections, runtimeOf, trustScratchProject } from '../lib/runtime-switch.ts'
import { assertElectronApi, freshSession, setPermissionMode, type SessionKey } from '../lib/state.ts'
import { scratchRepository, worktreeEntries } from './rs-27.ts'
import type { CaseMeta, SittingRecipe } from '../lib/sitting.ts'
import { checkAbsence, positive } from '../lib/turn-evidence.ts'

const ID = 'RS-28'
const TITLE = 'whether the SDK routes claude’s native EnterWorktree through our canUseTool floor'

export const meta = {
  id: ID,
  title: TITLE,
  row: 'P6.839',
  runtimes: ['claude'],
  credentials: 'owner: a claude-runtime card, already signed in. No key is read.',
} as const satisfies CaseMeta

/**
 * The host floor's own words when `worktreeGateContext()` supplies nothing.
 *
 * Written out rather than imported: a check that derives its expectation from
 * the code under test passes whatever that code does, a regression included.
 * The literal is `session-tools-core/tool-defs.ts`'s recorded measurement of
 * `runPreToolUseChecks`.
 */
const HOST_FLOOR_SENTENCE = 'no repository to create or enter a worktree in'

const WORKTREE_PROMPT = 'Move your work into an isolated git worktree of this directory using your worktree tool, '
  + 'then tell me exactly what the tool reported.'

interface ArmReading {
  attempted: boolean
  hostSentence: boolean
  toolNames: string[]
  results: string[]
}

async function worktreeArm(session: CdpSession, key: SessionKey): Promise<ArmReading> {
  const turn = await sendPrompt(session, key, WORKTREE_PROMPT, 300_000).catch(() => undefined)
  const added = turn?.added ?? []
  const entries = worktreeEntries(added)
  const results = added.map(m => `${m.toolResult ?? ''}\n${m.content}`)
  return {
    attempted: entries.length > 0,
    hostSentence: results.some(text => text.includes(HOST_FLOOR_SENTENCE)),
    toolNames: added.filter(m => m.toolName).map(m => String(m.toolName)),
    results: entries.map(m => (m.toolResult ?? '').slice(0, 400)),
  }
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
      'this case measures the CLAUDE routing question and refuses to pass vacuously elsewhere. '
      + `This session is on ${connection ? `${connection.slug}(${connection.providerType})` : 'no connection'}.`,
    )
  }
  run.observe('card', { slug: connection.slug, providerType: connection.providerType })

  // The posture — PR-3 (W14-sit, 2026-09-11), and here the choice IS the
  // measurement. This case's instrument is our own floor's sentence ("no
  // repository to create or enter a worktree in"), and `pre-tool-use.ts` names
  // exactly one escape from the worktree approval: `bypassPermissions`. Setting
  // it would stand down the very layer whose presence the case is asking about,
  // and the run would then report "the floor never saw the call" about a floor
  // that was told not to look. `acceptEdits` clears the ordinary edit cards out
  // of the way and leaves the floor in the path.
  const setMode = await setPermissionMode(session, key.sessionId, 'acceptEdits').then(() => 'set').catch(error => `refused: ${String(error)}`)
  run.observe('permission-posture', { posture: 'acceptEdits', outcome: setMode })
  const approver = approvePermissionsWhile(session, key.sessionId)

  const repository = scratchRepository('rs28-repo')
  const bare = realpathSync(mkdtempSync(join(tmpdir(), 'nessy-rs28-plain-')))
  writeFileSync(join(bare, 'NOTES.md'), 'a plain directory, deliberately not a repository\n', 'utf8')
  run.observe('directories', { repository, bare })

  try {
    // The discriminator only works if the "plain" directory really is outside
    // any repository. Asserted, not assumed: a temp dir inside a checkout would
    // silently supply the very context this arm exists to withhold.
    let insideWorkTree = 'no'
    try {
      insideWorkTree = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: bare, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    } catch { insideWorkTree = 'no' }
    run.require(
      'the plain directory is outside any git repository',
      insideWorkTree !== 'true',
      `${bare} is inside a work tree, so the floor would receive its context and this arm would measure nothing`,
    )

    // ---- ARM A — the control: a real repository ---------------------------
    await bindProject(run, session, key.sessionId, repository, {
      label: 'arm A', gate: () => trustScratchProject(session, repository),
    })
    const armA = await worktreeArm(session, key)
    run.observe('arm-a-repository', armA)
    // F1.504 — the floor's silence means something only about a call put to it.
    checkAbsence(
      run,
      'THE CONTROL — against a real repository the host floor sentence does NOT appear',
      !armA.hostSentence,
      positive(armA.attempted, 'EnterWorktree call put to the floor', `tools this turn: ${JSON.stringify(armA.toolNames)}`),
      'the floor refused even WITH a repository — either the repository facts are not reaching it (P6.839\'s build) or this rig is broken;'
        + ' arm B cannot be read until this is understood',
    )

    // ---- ARM B — the discriminator: no repository -------------------------
    //
    // A NEW SESSION, and that is the whole arm. Re-pointing arm A's session at
    // the plain directory does NOT take its repository away: measured
    // 2026-09-11 on the packaged 1.36.0, the second `EnterWorktree` succeeded
    // and created `worktree-plain-worktree` INSIDE arm A's repository namespace
    // (`.nessy-worktrees/nessy-rs28-repo-…/`) while the host session's working
    // directory said the plain dir. RS-27 measured the same split from the other
    // side — the tool moves the SDK's cwd and not the host session's — so a
    // session that has entered a worktree carries that context for the rest of
    // its life and the discriminator is void. The run that found this scored
    // "the floor never saw the call" against a call the floor would have
    // ALLOWED, which is the wrong verdict rather than a weak one.
    const bareKey = await freshSession(session, `CDP ${ID} arm-b ${new Date().toISOString().slice(11, 19)}`)
    run.observe('arm-b-session', { sessionId: bareKey.sessionId, fresh: bareKey.fresh })
    run.require(
      'arm B ran in a session of its own',
      bareKey.fresh,
      `it inherited ${bareKey.inheritedMessages} messages — a session that has already entered a worktree cannot measure a session that has no repository`,
    )
    const bareSlug = await boundCard(session, bareKey.sessionId)
    run.require(
      'arm B’s session is on the same claude card',
      bareSlug === connection.slug,
      `it reports ${String(bareSlug)} against arm A's ${connection.slug}`,
    )
    await setPermissionMode(session, bareKey.sessionId, 'acceptEdits').catch(() => undefined)
    await bindProject(run, session, bareKey.sessionId, bare, {
      label: 'arm B', gate: () => trustScratchProject(session, bare),
    })
    const liveness = await sendPrompt(session, bareKey, 'Read the file NOTES.md in your working directory and tell me its first line.', 180_000)
    const livenessTools = liveness.added.filter(m => m.toolName).map(m => String(m.toolName))
    run.observe('arm-b-liveness-tools', livenessTools)
    run.require(
      'THE CONTROL — the session still works in the plain directory',
      livenessTools.length > 0,
      'no tool ran there, so a refused worktree call would say nothing about the floor',
    )

    const armB = await worktreeArm(session, bareKey)
    run.observe('arm-b-plain-directory', armB)

    if (!armB.attempted) {
      run.observe(
        'verdict',
        'not-attempted: no EnterWorktree entry in arm B, so the model never put the call to the floor. '
        + 'Record the cell UNMEASURED with this reason and re-run with a more explicit request; scoring it either way would be inventing a reading.',
      )
      run.check(
        'arm B put an EnterWorktree call to the floor',
        false,
        'the model did not attempt the tool in the plain directory — the run is inconclusive rather than negative',
      )
      return
    }

    run.observe(
      'verdict',
      armB.hostSentence
        ? 'the SDK DOES route its native EnterWorktree through canUseTool — the host floor answered, in its own words'
        : 'the host floor did NOT answer: the refusal carries the runtime\'s words, so the SDK owns this tool end to end and our floor never sees it',
    )
    // F1.522 — an OBSERVATION: both answers are verdicts, so a check here passed whatever happened.
    run.observe(
      'the routing question is answered, either way, by a sentence only our floor produces',
      armB.hostSentence ? 'ROUTED — the host floor answered' : 'NOT routed — this is a verdict, not a failure',
    )
  } finally {
    run.observe('permission-cards-answered', await approver.stop().catch(() => -1))
    for (const dir of [repository, bare]) {
      try { rmSync(dir, { recursive: true, force: true }) } catch { /* scratch, not evidence */ }
    }
  }
}

if (import.meta.main) {
  await main(ID, TITLE, drive)
}

export const manual = {
  steps: [
    '1. Run RS-27 first: this case is only meaningful once the tool is known to be offered.',
    '2. PACKAGED build carrying W10-a\'s P6.839 build (option A minus `bgIsolation`). New session on the claude-runtime card.',
    '3. `bun run scripts/cdp/cases/rs-28.ts` with NESSY_CDP_PORT pointed at the app.',
    '4. Read `verdict` off the result line. `not-attempted` is an inconclusive run, not a negative one — re-run with a more explicit request before recording anything.',
  ],
  expected: 'arm A (a real repository) produces no host-floor sentence; arm B (a plain directory) either produces it — the SDK routes through canUseTool — or does not, which is equally a verdict.',
  detector: 'the host floor\'s own sentence, "…no repository to create or enter a worktree in", which no upstream would produce. Not success or failure of the tool: with the repository facts supplied, both worlds succeed.',
  positiveControl: 'arm A, where the sentence must not appear; and an ordinary read in the plain directory, which must succeed, so a refusal cannot be blamed on a dead session.',
  doneMeans: 'whether the SDK routes its native `EnterWorktree` through `canUseTool` is documented, not live-measured → a CDP case in the packaged sitting.',
} as const satisfies SittingRecipe
