/**
 * RS-51 (D1.21) — does claude's own `EnterWorktree` built-in FIRE in a packaged
 * session, and does what it produces carry a host lease?
 *
 * ## The premise, re-taken at HEAD before anything was driven
 *
 * `CLAUDE_SESSION_DISALLOWED_TOOLS` (`packages/shared/src/agent/claude-agent.ts`)
 * holds exactly five names — `EnterPlanMode`, `ExitPlanMode`, `Skill`,
 * `Monitor`, `ScheduleWakeup` — and neither `EnterWorktree` nor `ExitWorktree`
 * is among them. `worktrees.md#ask-claude-to-create-a-worktree`, verbatim: *"You
 * can also ask Claude to 'work in a worktree' during a session, and it creates
 * one with the `EnterWorktree` tool."* So the built-in is offered.
 *
 * **D1.21's own quotation of the ledger is STALE, and this case does not repeat
 * it.** The row says *"Ledger I2/claude (`absent ᵗ`)"*. At HEAD `I2` reads
 * `covered` | `covered` | `absent` over Pi | Claude | Codex — the `absent` is
 * the CODEX cell, and the claude cell has said covered since C3.251, whose own
 * text records RS-28 arm A driving `EnterWorktree` on a claude card at the
 * packaged 1.36.0 sitting. So this case is not a refutation of an `absent`
 * verdict; it is a re-take on the packaged **1.39.0** plus the two things that
 * cell does not carry — where the worktree LANDS, and whether anything asked.
 *
 * ## The rig needs a GIT REPOSITORY, and the row's recipe does not say so
 *
 * A Nessy session's working directory is `<config>/sessions/<ws>/<session>`,
 * which is not a git repository. `EnterWorktree` creates a git worktree, so in
 * the default directory it would fail for want of a repository and the case
 * would score "the built-in does not fire" against a rig that gave it nothing to
 * work with. The case therefore mints its own repository under the OS temp dir,
 * binds the session to it, and removes it in a `finally`.
 *
 * ## The detector, and its positive control
 *
 * The session's own transcript through `getSessionMessages`: a tool row reads
 * `Running <ToolName>…`, so an `EnterWorktree` call is visible by name. And
 * `sdkCwd` on the session row — the working directory the SDK itself reports —
 * which is the second, independent half: a worktree that was entered moves it.
 *
 * **The positive control is NOT `TaskCreate`**, the obvious choice, because that
 * name sits in the very list under test (`PI_ONLY_WITH_A_CLAUDE_BUILT_IN`) and
 * could fail for exactly the unknown reason the subject fails — a null would
 * then be uninterpretable. It is a built-in named in no pi-only list: the case
 * asks for a shell command first and requires a tool row to appear. Without it,
 * "no `EnterWorktree` row" is equally true of a probe that cannot see tool rows
 * at all.
 *
 * ## The artefact probe, and why it is not the answer
 *
 * The built-ins live in the vendored BINARY, not in our bundle, and for claude
 * the binary is the strongest evidence obtainable. Occurrences over the packaged
 * `claude` (instrument named: `grep -aoF … | wc -l`, occurrences and not lines —
 * on a minified file the two disagree by up to 4x). Presence is not semantics,
 * so this arm is recorded and the DRIVE is what scores.
 *
 * ## Arm 3 is the safety half, and the DRIVE refuted the source reading it was
 * written from
 *
 * The arm was designed around this: P6.20 refused `--worktree` for the
 * no-lease/no-sweep shape, and at HEAD `worktreeLeaseId` occurs only in
 * `pi-agent-server/src/orchestrator` and `packages/core/src/types/pi-harness-runtime.ts`,
 * on no claude path — so a worktree a claude session entered looked like a
 * directory the host neither leased nor sweeps.
 *
 * **Measured, that is wrong, and the PATH is what says so.** The worktree
 * landed under `<parent-of-repo>/.nessy-worktrees/…` — Nessy's OWN worktree root
 * (`packages/server-core/src/pi-harness/isolation/shared-git.ts` names it in
 * those words) — because P2.458 installs `withClaudeWorktreeHooks` over the
 * merged SDK hook map and binds `claudeWorktreePort` on every `anthropic`
 * session (`SessionManager`), so the SDK's `WorktreeCreate` is answered by the
 * HOST. The comment at that call site records the other branch verbatim: with
 * the port absent *"the binary keeps creating worktrees with `git worktree`"*.
 * The discriminator needs no source reading at all: `.nessy-worktrees` occurs
 * **0** times in the packaged SDK binary (same instrument as the needle counts
 * above) and does occur in our own tree, so the root a worktree appears under
 * names which side created it.
 *
 * What survives as a residue is one thing, not two. `sdkCwd` on the session row
 * did NOT move while the child reported working inside the worktree — and that
 * is BY DESIGN, not a divergence: `SessionManager`'s own field comment reads
 * *"SDK cwd for session storage - set once at creation, never changes. Ensures
 * SDK can find session transcripts regardless of workingDirectory changes."*
 * Calling it a divergence would have been this case's own wrong finding, caught
 * by reading the field before writing the sentence. The open residue is
 * `awaitingApprovalCount`, which stayed 0: nothing asked the person before a
 * worktree and a branch were created on the model's word. Recorded, not
 * asserted — whether a card is owed there is a product posture.
 *
 * ## Safety
 *
 * The repository is minted under the OS temp dir and removed in a `finally`,
 * together with any worktree the session created inside it. No credential is
 * read, printed or written; the prompt is phrased POSITIVELY (AGENTS.md: a
 * prompt that names a tool and forbids calling it trips the Guardian, and the
 * wreckage reads like a dispatch bug).
 */

import { mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { sendPrompt } from '../lib/chat.ts'
import type { CdpSession } from '../lib/connect.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import { bindProject, buttonTextInPage, CANCEL_BUTTON_TEXTS, listConnections, runtimeOf, switchRuntime, TRUST_GATE_HEADING_IN_PAGE, trustScratchProject, waitForConnection } from '../lib/runtime-switch.ts'
import { assertElectronApi, freshSession, type SessionKey } from '../lib/state.ts'
import type { CaseMeta, SittingRecipe } from '../lib/sitting.ts'

const ID = 'RS-51'
const TITLE = 'whether claude’s own EnterWorktree built-in fires in a packaged session, and what it leaves behind'

export const meta = {
  id: ID,
  title: TITLE,
  row: 'D1.21',
  runtimes: ['claude'],
  credentials:
    'owner: a `claude-runtime` card that answers a turn — the one-click Claude Code gateway card is enough and the '
    + 'case never touches the credential file. Run it on a NESSY_CONFIG_DIR created for the run.',
} as const satisfies CaseMeta

/** The two built-ins under test, plus the two controls the binary probe needs. */
const BINARY_NEEDLES = [
  { name: 'EnterWorktree', role: 'subject' },
  { name: 'ExitWorktree', role: 'subject' },
  { name: 'ExitPlanMode', role: 'positive control — a built-in this product disallows, so the binary must carry it' },
  { name: 'ZZZ_NOT_A_TOOL_NAME_RS51', role: 'negative control — a fabricated name' },
  { name: '.nessy-worktrees', role: 'arm 3’s discriminator — the HOST’s worktree root, which the SDK cannot know' },
] as const

/** The packaged binary, relative to the artefact root. */
const BINARY_PATH = 'Contents/Resources/app/node_modules/@anthropic-ai/claude-agent-sdk-binary/claude'

/**
 * The host's OWN worktree root, and the arm-3 discriminator.
 *
 * `packages/server-core/src/pi-harness/isolation/shared-git.ts`: *"Nessy creates
 * worktrees at `<parent-of-repo>/.nessy-worktrees/…`"*. It is in {@link
 * BINARY_NEEDLES} as well, where it must score ZERO: a name the SDK binary does
 * not contain cannot have been chosen by the SDK, so the root a worktree appears
 * under names which side created it — without reading either side's source.
 */
const HOST_WORKTREE_ROOT = '.nessy-worktrees'

function appRoot(): string {
  return process.env.NESSY_CDP_APP_ROOT?.trim()
    || join(process.cwd(), 'release', 'mac-arm64', 'Nessy Desktop.app')
}

/** Occurrences, never lines — a minified binary puts thousands on one line. */
function occurrences(binary: string, needle: string): number {
  const done = Bun.spawnSync(['grep', '-aoF', needle, binary], { stdout: 'pipe', stderr: 'pipe' })
  const text = new TextDecoder().decode(done.stdout)
  return text.split('\n').filter(Boolean).length
}

/** A real git repository for the session to work in, with one commit. */
function seedRepository(run: CaseRun): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'nessy-rs51-repo-')))
  writeFileSync(join(root, 'README.md'), '# rs-51\n\nA probe repository.\n', 'utf8')
  const git = (...args: string[]): void => {
    const done = Bun.spawnSync(['git', ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
    if (done.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${new TextDecoder().decode(done.stderr)}`)
  }
  git('init', '--initial-branch=main')
  git('-c', 'user.email=rs51@example.invalid', '-c', 'user.name=RS-51', 'add', '--', 'README.md')
  git('-c', 'user.email=rs51@example.invalid', '-c', 'user.name=RS-51', 'commit', '-m', 'seed')
  run.observe('probe repository', { root })
  return root
}

/** Every `git worktree` this repository knows about, as the repository itself reports them. */
function worktreeList(root: string): string[] {
  const done = Bun.spawnSync(['git', 'worktree', 'list', '--porcelain'], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
  return new TextDecoder().decode(done.stdout)
    .split('\n')
    .filter(line => line.startsWith('worktree '))
    .map(line => line.slice('worktree '.length))
}

/** The session row the app itself reports, for `sdkCwd` and the approval count. */
async function sessionRow(
  session: CdpSession,
  key: SessionKey,
): Promise<{ sdkCwd?: string; awaitingApprovalCount?: number; permissionMode?: string }> {
  return session.call<{ sdkCwd?: string; awaitingApprovalCount?: number; permissionMode?: string }>(`
    const rows = await window.electronAPI.getSessions()
    const row = (rows ?? []).find(s => s.id === ${JSON.stringify(key.sessionId)})
    if (!row) return {}
    return { sdkCwd: row.sdkCwd, awaitingApprovalCount: row.awaitingApprovalCount, permissionMode: row.permissionMode }
  `).catch(() => ({}))
}

/** Tool rows a turn added, by the name the transcript prints (`Running <Tool>…`). */
function toolNames(added: readonly { role: string; content?: string }[]): string[] {
  return added
    .filter(message => message.role === 'tool')
    .map(message => /Running\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(message.content ?? '')?.[1] ?? '(unnamed)')
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)

  // ---- arm 0: the artefact ------------------------------------------------
  const binary = join(appRoot(), BINARY_PATH)
  let readable = true
  try {
    statSync(binary)
  } catch {
    readable = false
  }
  if (readable) {
    const counts = Object.fromEntries(BINARY_NEEDLES.map(needle => [needle.name, occurrences(binary, needle.name)]))
    run.observe('the packaged claude binary — occurrences (grep -aoF … | wc -l)', { binary, counts })
    run.check(
      'THE CONTROL — the binary probe can tell a real built-in name from a fabricated one',
      (counts.ExitPlanMode ?? 0) > 0 && (counts.ZZZ_NOT_A_TOOL_NAME_RS51 ?? 0) === 0,
      `ExitPlanMode=${String(counts.ExitPlanMode)} fabricated=${String(counts.ZZZ_NOT_A_TOOL_NAME_RS51)} — with `
      + 'either of those wrong the two subject counts are not readings',
    )
    run.check(
      `arm 3's discriminator holds — the SDK binary does not contain the host's worktree root (${HOST_WORKTREE_ROOT})`,
      (counts[HOST_WORKTREE_ROOT] ?? 0) === 0,
      `${HOST_WORKTREE_ROOT}=${String(counts[HOST_WORKTREE_ROOT])} in the shipped binary — if the SDK knows that `
      + 'name, a worktree appearing under it no longer says which side created it, and arm 3 below needs another '
      + 'discriminator',
    )
    run.check(
      'the shipped binary carries BOTH worktree built-ins',
      (counts.EnterWorktree ?? 0) > 0 && (counts.ExitWorktree ?? 0) > 0,
      `EnterWorktree=${String(counts.EnterWorktree)} ExitWorktree=${String(counts.ExitWorktree)} — presence is not `
      + 'semantics, and the drive below is what scores; an ABSENCE here would settle the row without one',
    )
  } else {
    run.observe('the packaged claude binary', `not readable at ${binary} — set NESSY_CDP_APP_ROOT to the .app`)
  }

  // ---- the card -----------------------------------------------------------
  const connections = await listConnections(session)
  const claudeCard = connections.find(row => runtimeOf(row.providerType) === 'anthropic')?.slug
  if (!claudeCard) {
    blocked(
      'no claude-runtime connection on this host, and `EnterWorktree` is claude’s own built-in — there is nothing '
      + `to measure on another runtime. The host lists ${connections.map(row => `${row.slug}(${row.providerType})`).join(', ') || 'nothing'}.`,
    )
  }
  run.observe('card under test', claudeCard)

  // A STALE trust dialog from an earlier run blocks the composer for every later
  // session, and the app cannot answer it once its directory is gone — measured
  // on this case's second drive, where the dialog still named the FIRST run's
  // repository (which this case's own `finally` had removed) and said *"Could
  // not update project trust."* under the heading. `answerTrustGate` then clicked
  // Trust for a directory that no longer existed and reported
  // `trust-dialog-did-not-close`. Dismiss whatever is up before binding anything.
  const stale = await session.call<string>(`
    const heading = Array.from(document.querySelectorAll('h1,h2,h3,[role="dialog"] *'))
      .find(${TRUST_GATE_HEADING_IN_PAGE})
    if (!heading) return 'none'
    const cancel = Array.from(document.querySelectorAll('button'))
      .find(${buttonTextInPage(CANCEL_BUTTON_TEXTS)})
    if (!cancel) return 'a trust dialog is up and has no Cancel button'
    cancel.click()
    await new Promise(resolve => setTimeout(resolve, 800))
    const still = Array.from(document.querySelectorAll('h1,h2,h3,[role="dialog"] *'))
      .some(${TRUST_GATE_HEADING_IN_PAGE})
    return still ? 'a trust dialog is STILL up after Cancel' : 'dismissed a stale trust dialog'
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
      claudeCard,
    )
    // The trust gate, or the composer is inside a hidden subtree behind the
    // dialog and the next `focusComposer` reports `composer-not-focusable` —
    // measured on this case's first drive, where that read exactly like a
    // product defect. `trustScratchProject` refuses any directory outside the
    // OS temp dir, which is the whole reason the repository is minted there.
    await bindProject(run, session, key.sessionId, root, {
      gate: () => trustScratchProject(session, root),
    })
    const before = await sessionRow(session, key)
    run.observe('the session before the subject turn', { ...before, worktrees: worktreeList(root) })

    // ---- THE CONTROL: a built-in named in no pi-only list ------------------
    const control = await sendPrompt(
      session,
      key,
      'Run the shell command `echo RS51-CONTROL` in this directory and tell me what it printed.',
      180_000,
    )
    const controlTools = toolNames(control.added)
    run.observe('THE CONTROL — the tool rows an ordinary built-in produces', {
      tools: controlTools,
      roles: control.added.map(message => message.role),
    })
    run.check(
      'THE CONTROL — a built-in in NO pi-only list produces a visible tool row',
      controlTools.length > 0,
      'the session ran a turn and this case saw no tool row at all, so every "EnterWorktree did not fire" reading '
      + 'below is equally true of a probe that cannot see tool rows. `TaskCreate` is deliberately NOT used as this '
      + 'control: it sits in the very pi-only list under test and could fail for the same unknown reason',
    )

    // ---- arm 1: the subject, phrased POSITIVELY ---------------------------
    const subject = await sendPrompt(
      session,
      key,
      'Please work in a git worktree for this task, then tell me which directory you are working in.',
      300_000,
    )
    const subjectTools = toolNames(subject.added)
    const after = await sessionRow(session, key)
    const worktrees = worktreeList(root)
    run.observe('arm 1 — what the worktree request produced', {
      tools: subjectTools,
      roles: subject.added.map(message => message.role),
      lastText: subject.added.filter(message => message.role === 'assistant').map(message => (message.content ?? '').slice(0, 400)).slice(-2),
      sdkCwdBefore: before.sdkCwd,
      sdkCwdAfter: after.sdkCwd,
      awaitingApprovalCount: after.awaitingApprovalCount,
      gitWorktrees: worktrees,
    })
    const fired = subjectTools.includes('EnterWorktree')
    run.observe(
      'D1.21 — did the built-in FIRE?',
      fired
        ? 'YES — a tool row named EnterWorktree is in this session’s own transcript'
        : 'NO tool row named EnterWorktree. Read the control above first; then read the tool names that DID appear '
          + 'and the assistant’s own last words, which say whether the model declined, used shell `git worktree` '
          + 'instead, or was refused',
    )
    run.check(
      'the request produced SOME tool activity, so the reading above is about EnterWorktree and not about an idle turn',
      subjectTools.length > 0,
      `the worktree request produced no tool row at all (roles: ${subject.added.map(m => m.role).join(', ')}) — that `
      + 'is a reading about the model’s compliance, not about whether the built-in is offered',
    )

    // ---- arm 3: the safety half -------------------------------------------
    const movedOut = after.sdkCwd !== undefined && before.sdkCwd !== undefined && after.sdkCwd !== before.sdkCwd
    const created = worktrees.filter(path => path !== root)
    const hostOwned = created.filter(path => path.includes(`/${HOST_WORKTREE_ROOT}/`))
    run.observe('arm 3 — the containment reading', {
      sdkCwdMoved: movedOut,
      sdkCwd: after.sdkCwd,
      awaitingApprovalCount: after.awaitingApprovalCount,
      createdWorktrees: created,
      underHostRoot: hostOwned,
    })
    if (created.length > 0) {
      run.check(
        `the worktree is under the HOST's own root (${HOST_WORKTREE_ROOT}), not one the binary chose`,
        hostOwned.length === created.length,
        `created ${JSON.stringify(created)} — a worktree OUTSIDE ${HOST_WORKTREE_ROOT} is the binary's own `
        + '`git worktree` branch, which is what `withClaudeWorktreeHooks` falls back to when `claudeWorktreePort` is '
        + 'absent, and is P6.20’s no-lease/no-sweep shape found live',
      )
      // `sdkCwd` staying put is NOT a divergence, and saying so would be the
      // wrong finding: `SessionManager`'s own field comment reads *"SDK cwd for
      // session storage - set once at creation, never changes. Ensures SDK can
      // find session transcripts regardless of workingDirectory changes."* So it
      // is reported as the control it is — the session's storage anchor held
      // while the child moved — and the only open residue is the approval count.
      run.observe(
        'arm 3 — the residue, recorded and not asserted',
        `sdkCwd ${movedOut ? 'MOVED, which its own field comment says it never does' : 'did not move, which is what '
          + 'its field comment says it must do: it is the session storage anchor, not the child working directory'} `
        + `(${String(after.sdkCwd)}); awaitingApprovalCount is ${String(after.awaitingApprovalCount)}. Whether the `
        + 'host should raise a card for a worktree it created under its own root on the model'
        + '’s word is a product posture rather than this case’s verdict.',
      )
    } else {
      run.observe('arm 3 — no worktree was created, so the containment question has no subject in this run', worktrees)
    }
  } finally {
    // Every worktree first — `rm -rf` on the repository alone leaves a worktree
    // registered elsewhere on disk if the model put one outside it.
    for (const path of worktreeList(root)) {
      if (path === root) continue
      Bun.spawnSync(['git', 'worktree', 'remove', '--force', path], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
      try {
        rmSync(path, { recursive: true, force: true })
      } catch { /* already gone */ }
    }
    try {
      readdirSync(root)
      rmSync(root, { recursive: true, force: true })
    } catch { /* already gone */ }
  }
}

if (import.meta.main) await main(ID, TITLE, drive)

export const manual = {
  steps: [
    '1. PACKAGED build, dark theme, ONE content panel, a NESSY_CONFIG_DIR created for the run, and a claude-runtime card that answers a turn (the one-click Claude Code gateway card does).',
    '2. `bun run scripts/cdp/cases/rs-51.ts`. It mints its own git repository under the OS temp dir, binds the session to it, and removes it — and any worktree inside it — in a `finally`.',
    '3. Read the CONTROL turn first: an ordinary built-in must produce a visible tool row, or nothing below it is a reading.',
    '4. Then read whether a tool row named EnterWorktree appeared, where `sdkCwd` ended up, and what `git worktree list` says inside the probe repository.',
  ],
  expected: 'the binary carries both built-in names; the control turn produces a tool row; and the worktree request either produces an `EnterWorktree` tool row with `sdkCwd` moved into the new worktree, or does not — both are readings, and the row is scored from the drive rather than from the binary probe.',
  detector: 'the session’s own transcript through `getSessionMessages` (a tool row prints `Running <ToolName>…`, so the built-in is visible BY NAME), plus `sdkCwd` on the session row — the working directory the SDK itself reports — and `git worktree list --porcelain` inside the probe repository, which is the repository’s own answer rather than the app’s.',
  positiveControl: 'one ordinary built-in in the same session, asked for first. It is deliberately NOT `TaskCreate`: that name sits in the pi-only list under test and could fail for exactly the unknown reason the subject fails, which would make a null uninterpretable. For the binary probe the controls are `ExitPlanMode` (must be present) and a fabricated name (must be 0).',
  doneMeans: 'D1.21 carries a packaged reading of whether `EnterWorktree` fires, with the tool rows that DID appear beside it, and the containment half recorded: whether the session moved, whether a worktree exists, and that `worktreeLeaseId` is a Pi concept at HEAD so nothing leased it.',
  safety: 'the repository is minted under the OS temp dir and removed in a `finally` together with any worktree inside it; no credential is read, printed or written; the prompt is phrased POSITIVELY, because a prompt that names a tool and forbids calling it trips the Guardian and the wreckage reads like a dispatch bug.',
  doNotConflate: 'the model using shell `git worktree` with the built-in firing. Only the tool NAME separates them, and the containment answer is different for each: a shell worktree passed the ordinary permission gate, a built-in one did not.',
} as const satisfies SittingRecipe
