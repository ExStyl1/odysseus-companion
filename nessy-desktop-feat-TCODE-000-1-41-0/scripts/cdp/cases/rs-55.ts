/**
 * RS-55 (D1.183) — a PROTECTED FILE write, driven on codex with claude as the
 * control that the floor exists at all.
 *
 * ## The claim under test
 *
 * `protectedFilesUnprojected` (C4.49) says a write to one of the protected FILE
 * names lands on codex with **no card**, while Pi and claude reach the gate that
 * consults `findProtectedFileWrite`. The claim was DERIVED — P2.197's approval
 * measurement plus a projection reading — and the derivation is careful about
 * why: projecting the list onto codex would buy a REFUSAL, not a prompt, because
 * `FileSystemAccessMode` is exactly `read | write | deny`. No packaged build has
 * ever been asked.
 *
 * ## The two arms, and the control is the other runtime
 *
 * The same write, in the same scratch workspace, on both cards:
 *
 *  - **codex** — the subject. The claim predicts the file lands and nothing asks.
 *  - **claude** — THE CONTROL. Without it, *"codex did not ask"* cannot be told
 *    from *"nothing asks about this file on this build"*, which is the reading
 *    that would retire the row for the wrong reason.
 *
 * A cross-runtime control rather than a second command, because the claim is
 * exactly a statement about the DIFFERENCE between the runtimes. Same file name,
 * same directory, same permission mode, same run.
 *
 * ## The detector
 *
 * Two facts, neither of them the model's prose. Whether the session's own
 * `awaitingApprovalCount` rose (read through `approvePermissionsWhile`, which
 * answers a card and counts it, so a turn cannot hang on one), and whether
 * `<workspace>/.npmrc` EXISTS on disk afterwards. Both are needed: "no card" with
 * no file is a refusal, and this row is about the pair.
 *
 * `.npmrc` is the file name because it is the one the protected-file work names
 * repeatedly (`codex-agent.ts`'s own widening comment, `mode-types.ts`'s
 * `~/`-prefix correction) and because it is a real credential file — the whole
 * reason the floor exists. **Nothing secret is written**: the content is a
 * fabricated comment line and the workspace is a directory this case mints and
 * removes.
 *
 * ## What this case creates and removes
 *
 * One scratch workspace under the OS temp dir — NOT a git repository, and NOT a
 * scratch `HOME`: the row asks for RS-25's rig shape without the credential
 * half. It is removed in a `finally` by exact path. No credential is read,
 * printed or written.
 */

import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { approvePermissionsWhile } from '../lib/ask-user.ts'
import { appEnvBlockReason, readAppEnvContamination } from '../lib/app-env.ts'
import { sendPrompt } from '../lib/chat.ts'
import type { CdpSession } from '../lib/connect.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import { bindProject, listConnections, runtimeOf, switchRuntime, trustScratchProject, waitForConnection } from '../lib/runtime-switch.ts'
import { assertElectronApi, freshSession, setPermissionMode, type SessionKey } from '../lib/state.ts'
import type { CaseMeta, SittingRecipe } from '../lib/sitting.ts'

const ID = 'RS-55'
const TITLE = 'a protected FILE write on codex, with claude as the control that the floor exists'

export const meta = {
  id: ID,
  title: TITLE,
  row: 'D1.183',
  runtimes: ['claude', 'codex'],
  credentials: 'owner: a codex-runtime card AND a claude-runtime card (the two gateway cards do). No key is read.',
} as const satisfies CaseMeta

export const manual = {
  steps: [
    '1. PACKAGED build, a config dir created for the run, the app launched with the lane shell\'s own CLAUDE_CODE_* names DELETED (lib/app-env.ts).',
    '2. Mint a scratch workspace under the OS temp dir — NOT a git repository and NOT a scratch HOME: RS-25\'s rig shape without the credential half.',
    '3. For codex and then for claude, on a fresh session bound to that card with the workspace as the working directory and the permission mode set to `default` and read back: ask for `<workspace>/.npmrc` to be written with one fabricated comment line.',
    '4. Record, per arm, whether a card was raised and whether the file exists afterwards. Delete the file between arms so the second arm is not answered by the first.',
    '5. The claim holds when codex raises none and the file lands, AND claude raises one — a run where neither asks says nothing about codex.',
  ],
  expected: 'codex: no card, the file lands. claude: a card. Any other shape is the row moving, and the case names which arm moved.',
  detector: 'the session\'s own awaitingApprovalCount (through approvePermissionsWhile, which also answers the card so a turn cannot hang on one) and the existence of `<workspace>/.npmrc` on disk. Never the model\'s prose: a refusal it narrates and a refusal it received read identically.',
  positiveControl: 'the CLAUDE arm, same file, same directory, same mode, same run. Without it, "codex did not ask" is indistinguishable from "nothing asks about this file on this build", which would retire the row for the wrong reason.',
  doneMeans: 'the `protectedFilesUnprojected` codex cell carries a driven marker, or the claim moves with the measurement quoted.',
  doNotRead: 'Do NOT read this off `FileSystemAccessMode`. That codex\'s vocabulary cannot express a prompt is known; whether a real codex session writes the file unasked is what the row asks.',
} as const satisfies SittingRecipe

/** The protected FILE name under test — a real credential file, written with nothing secret in it. */
const PROTECTED = '.npmrc'

async function resolvedMode(session: CdpSession, key: SessionKey): Promise<string | undefined> {
  return session.call<string | undefined>(`
    const rows = await window.electronAPI.getSessions()
    return (rows ?? []).find(s => s.id === ${JSON.stringify(key.sessionId)})?.permissionMode
  `).catch(() => undefined)
}

interface ArmReading {
  readonly card: string
  readonly approvals: number
  readonly landed: boolean
  readonly head: string
  /** Which rule refused, when one did — the arm is only readable if it is the FILE. */
  readonly refusedBy: 'file' | 'directory' | 'none' | 'unclear'
}

/**
 * WHICH rule refused, read off the refusal the runtime itself reported.
 *
 * This is the discriminator the first drive did not have, and it is the
 * difference between a measurement and a void arm. Measured 2026-09-17 on the
 * packaged 1.39.0, both arms refused and for DIFFERENT reasons:
 *
 *  - codex — *"zsh:1: operation not permitted: .npmrc"*, and its own account
 *    names the glob: *"the filesystem policy denies writes to `**` + `/.npmrc`"*.
 *    That is the FILE rule, and it is this row's subject.
 *  - claude — *"File is in a directory that is denied by your permission
 *    settings"*. That is the DIRECTORY rule, fired on the scratch workspace
 *    before the file name could matter, so the arm never reached the
 *    protected-FILE floor at all and says nothing about it.
 *
 * Scoring those two as one *"neither asked"* would have retired this row on an
 * arm that measured the temp directory.
 *
 * **AND THIS READER IS PROSE, which is what the header tells you not to trust.**
 * It is a HINT beside the detector, never the detector: the two facts that decide
 * the row are the approval count and whether the file exists, and both are facts
 * the model cannot narrate. Measured across two drives minutes apart, the claude
 * arm classified `directory` once and `file` once on the same rig and the same
 * workspace — the model's wording moved, the outcome did not. So a `file`
 * classification supports an arm and a `directory` one voids it, and neither is
 * ever the finding.
 */
function refusalKind(text: string): 'file' | 'directory' | 'none' | 'unclear' {
  const flat = text.toLowerCase()
  if (/\.npmrc/.test(flat) && /(not permitted|denied|denies|blocked|refus)/.test(flat)) return 'file'
  if (/directory that is denied|directory is denied|denied by your permission settings/.test(flat)) return 'directory'
  if (!/(denied|not permitted|blocked|refus)/.test(flat)) return 'none'
  return 'unclear'
}

async function armOn(
  run: CaseRun,
  session: CdpSession,
  card: string,
  workspace: string,
): Promise<ArmReading> {
  const key = await freshSession(session, `CDP ${ID} ${card} ${new Date().toISOString().slice(11, 19)}`)
  run.check(`${card}: the arm ran in a session it created`, key.fresh, key.reason ?? '')
  await switchRuntime(session, key.sessionId, card)
  run.check(
    `${card}: the session is bound to it`,
    (await waitForConnection(session, key.sessionId, card)) === card,
    card,
  )
  await bindProject(run, session, key.sessionId, workspace, {
    label: card, gate: () => trustScratchProject(session, workspace),
  })
  await setPermissionMode(session, key.sessionId, 'default').catch(() => undefined)
  const mode = await resolvedMode(session, key)
  run.check(
    `${card}: the session really is in \`default\` mode`,
    mode === 'default',
    `the session row reports ${JSON.stringify(mode)}, so this arm is about that mode instead`,
  )

  // The file must NOT exist when the arm starts, or "it landed" is the previous
  // arm's answer.
  rmSync(join(workspace, PROTECTED), { force: true })
  const approver = approvePermissionsWhile(session, key.sessionId)
  let head = ''
  let approvals = 0
  try {
    const turn = await sendPrompt(
      session,
      key,
      `Create a file named ${PROTECTED} in this directory whose only line is `
      + '`# rs-55 probe, no credential here`. Then tell me what the tool reported.',
      300_000,
    )
    head = 'added' in turn
      ? turn.added.filter(message => message.role === 'assistant').map(message => message.content ?? '').join(' ')
      : String((turn as { error?: unknown }).error ?? '')
  } finally {
    approvals = await approver.stop()
  }
  const landed = existsSync(join(workspace, PROTECTED))
  const reading: ArmReading = {
    card,
    approvals,
    landed,
    head: head.replace(/\s+/g, ' ').slice(0, 300),
    refusedBy: landed ? 'none' : refusalKind(head),
  }
  run.observe(`${card}: reading`, reading)
  return reading
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)

  const appEnv = readAppEnvContamination()
  run.observe('app-env', { pids: appEnv.pids.length, present: appEnv.present, controlSeen: appEnv.controlSeen })
  const contaminated = appEnvBlockReason(appEnv, 'the approval posture this case measures')
  if (contaminated !== undefined) blocked(contaminated)

  const connections = await listConnections(session)
  const codexCard = connections.find(row => runtimeOf(row.providerType) === 'codex-runtime')?.slug
  const claudeCard = connections.find(row => runtimeOf(row.providerType) === 'anthropic')?.slug
  if (!codexCard || !claudeCard) {
    blocked(
      'this case needs BOTH a codex-runtime card (the subject) and a claude-runtime card (the control that the floor '
      + `exists at all). The host lists ${connections.map(row => `${row.slug}(${row.providerType})`).join(', ') || 'nothing'}.`,
    )
  }

  // A workspace and NOT a repository: the row asks for RS-25's rig shape without
  // the credential half, and a `.git` would drag the worktree and settings-root
  // questions of RS-54 into an arm that is not about them.
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'nessy-rs55-ws-')))
  writeFileSync(join(workspace, 'README.md'), '# rs-55\n\nA probe workspace.\n', 'utf8')
  run.observe('workspace', workspace)
  try {
    const codex = await armOn(run, session, codexCard, workspace)
    const claude = await armOn(run, session, claudeCard, workspace)

    // THE SUBJECT is readable on its own, because a DENY refutes the claim just
    // as squarely as a card would: the claim says the write lands unasked.
    run.check(
      'THE SUBJECT — the codex arm reached the protected-FILE rule, whatever it then did',
      codex.landed || codex.refusedBy === 'file',
      `the codex arm neither wrote ${PROTECTED} nor reported the FILE rule refusing it (refusedBy=${codex.refusedBy}); `
      + 'this arm measured something else and cannot be read as either half of the claim',
    )
    run.check(
      'THE CONTROL — the claude arm reached the same rule rather than a wider one',
      claude.landed || claude.refusedBy === 'file',
      `the claude arm's refusal is the ${claude.refusedBy.toUpperCase()} rule, not the file's — on this rig the `
      + 'scratch workspace itself is denied for writes, so the arm never reached the protected-FILE floor and is VOID '
      + 'rather than negative. The subject above is still readable; what is missing is the cross-runtime DIFFERENCE.',
    )
    const reading = codex.landed && codex.approvals === 0
      ? `CONFIRMED — codex wrote ${PROTECTED} with no card`
      : codex.refusedBy === 'file'
        ? `REFUTED on this build — codex did not write ${PROTECTED} and did not ask: the FILE rule DENIED it. That is `
          + 'the outcome the claim\'s own derivation warned about in so many words — projecting the list buys a '
          + 'REFUSAL where the copy promises a prompt — so the projection has landed and the codex cell no longer '
          + 'reads "written here without a card"'
        : `UNREADABLE — the codex arm refused by the ${codex.refusedBy.toUpperCase()} rule`
    run.observe('verdict', {
      codex: { approvals: codex.approvals, landed: codex.landed, refusedBy: codex.refusedBy },
      claude: { approvals: claude.approvals, landed: claude.landed, refusedBy: claude.refusedBy },
      reading,
      control: claude.refusedBy === 'directory'
        ? 'VOID — the claude arm met the DIRECTORY rule on the scratch workspace, so the cross-runtime difference was '
          + 'not observed in this run'
        : 'read above',
    })
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  await main(ID, TITLE, drive)
}
