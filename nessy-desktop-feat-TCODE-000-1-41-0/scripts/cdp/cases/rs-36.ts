/**
 * RS-36 (plan row C5.29, denominator F40) — what a BRANCH inherits at the
 * keyboard: the session's allow-for-this-session grants, and background work
 * already in flight.
 *
 * C3.72 answered F39 host-side (W16-h, 2026-09-11): a branch mints a new session
 * id, so session-keyed grants do not travel, while a Bash always-allow that
 * became a `.claude/settings.local.json` rule does — *by design, nothing
 * loosens silently*. That is a reading of the host's own code. F40 is the same
 * question asked of the shipped product with a finger on the key, and the row is
 * explicit about why it was pulled forward: the expected answer leans toward
 * LOOSENING security, and a refusal cannot be recorded without the measurement.
 *
 * ## The affordance, which R1 could not find and which is not a `sessionCommand`
 *
 * R1's 2026-09-12 report parked this row partly on *"the product's BRANCH
 * affordance has no `sessionCommand` spelling this lane could find
 * (`branchSession` appears nowhere in `packages/core`, the preload, or the
 * slash-command actions)"*. It is not a session command at all. The chat pane's
 * own branch control is `ChatDisplay.tsx`'s `onBranch`, gated on
 * `session.supportsBranching`, and it calls **`createSession`** with
 * `branchFromMessageId` + `branchFromSessionId` and the parent's
 * `llmConnection` / `model` / `permissionMode` / `enabledSourceSlugs` — the
 * comment there says why: *"Keep branch on the same backend/provider by
 * inheriting parent session settings."* This case drives that exact call, so it
 * measures the product's branch and not a path invented for the harness.
 *
 * ## Why each arm needs the control it has
 *
 * **Arm A — the grant.** "The same command raises no card in the branch" has
 * three explanations and only one of them is inheritance: the grant travelled,
 * the branch is in a wider permission mode, or the branch's gate is not running
 * at all. So the arm carries two controls, both inside the branch:
 *
 *  - the PARENT re-issue, sent before branching, which must raise no card —
 *    without it a grant that never took looks like a grant that did not travel;
 *  - a NEVER-GRANTED command in the branch, which must raise one — without it
 *    "no card" is equally true of a branch whose gate is dead.
 *
 * And the branch's own resolved `permissionMode` is read back from the app
 * rather than assumed from what was passed, which is the correction R1 had to
 * make to `RS-13` (*the setter returning is not the posture applying*).
 *
 * **Arm B — work in flight.** A backgrounded command is started in the parent,
 * the branch is taken WHILE it runs, and then BOTH transcripts are polled for
 * the completion marker. The two answers are different findings — the parent
 * keeping its own completion is the ordinary one; the branch receiving it would
 * mean a child inherits a running process's output — and "neither" is a third,
 * so the arm records which of the three happened rather than asserting one.
 *
 * ## The detector
 *
 * The permission CARD's appearance measured as a RISE above a baseline taken
 * immediately before each prompt goes out — never an absolute count, which on
 * 2026-09-12 scored a card left standing by a previous arm as the current arm's
 * (R1, `rs-13.ts`). For arm B, the marker in `getSessionMessages` of each
 * session, which is the persisted transcript and not the screen.
 *
 * Pi cannot be driven on this rig at all while the `dp` CLI session is lapsed
 * (R5 2026-09-12 07:57: `pi-api-key` answers `auth-request` where claude and
 * codex both complete a turn), so the runtimes are selectable and a family with
 * no card is recorded as unmeasured rather than skipped silently.
 */

import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { findCardButton } from '../lib/ask-user.ts'
import { sendPrompt } from '../lib/chat.ts'
import { readComposer } from '../lib/composer.ts'
import type { CdpSession } from '../lib/connect.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import {
  bindWorkingDirectory, listConnections, runtimeOf, switchRuntime, trustScratchProject, waitForConnection,
} from '../lib/runtime-switch.ts'
import {
  assertElectronApi, createSessionDirectly, freshSession, selectorCount, setPermissionMode, transcript, waitFor,
  type SessionKey, type TranscriptMessage,
} from '../lib/state.ts'
import { clickAt, clickSelector } from '../lib/viewport.ts'

import type { CaseMeta, SittingRecipe } from '../lib/sitting.ts'

const ID = 'RS-36'
const TITLE = 'what a branch inherits at the keyboard — the session\'s allow-for-this-session grants, and background work already in flight'

export const meta = {
  id: ID,
  title: TITLE,
  row: 'C5.29',
  runtimes: ['pi', 'claude', 'codex'],
  credentials: 'owner: one card per runtime, already signed in. The card is named in the run notes; no key '
    + 'is read. Pi is unreachable while the dp CLI session is lapsed and is recorded unmeasured.',
} as const satisfies CaseMeta

const PERMISSION_CARD = '[data-tutorial="permission-banner"]'

/** The families to drive — Pi is off by default for the reason in the header. */
const RUNTIME_WANTED = (process.env.NESSY_CDP_BRANCH_RUNTIMES ?? 'claude,codex')
  .split(',').map(name => name.trim()).filter(Boolean)

/**
 * Did a card appear FOR THIS CALL — a RISE above the baseline read immediately
 * before the prompt, never an absolute count.
 *
 * The absolute form scored a standing card from the previous arm as this arm's
 * floor holding (R1, 2026-09-12). A baseline makes a standing card mask a new
 * one — a conservative miss — instead of manufacturing one.
 */
async function cardRose(session: CdpSession, timeoutMs: number, baseline: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if ((await selectorCount(session, PERMISSION_CARD)) > baseline) return true
    if (Date.now() >= deadline) return false
    await Bun.sleep(500)
  }
}

/**
 * Press the card's ALWAYS-ALLOW button, by its own label, in ONE page call.
 *
 * `[data-tutorial="permission-allow-button"]` is the plain Allow, which grants
 * this ONE call and would leave nothing for a branch to inherit — this arm needs
 * the durable grant, and the card says in its own words what that means:
 * *"\"Always Allow\" saves this command for the repository"*.
 *
 * Three readings are baked in here rather than left to the next reader, and the
 * third is why this is one call instead of a read followed by a click:
 *
 *  - `[data-tutorial="permission-banner"]` matches TWO NESTED elements for one
 *    card, so `querySelectorAll('<card> button')` returns the inner element's
 *    buttons twice and a positional index into that flattened list means
 *    nothing (R1, `rs-13.ts`, 2026-09-12);
 *  - the label list is NOT stable: measured on this rig 2026-09-12 the banner
 *    read `["Allow","Always Allow","Deny","Add a note"]` at one moment and
 *    `["Allow","Yes, and switch to auto mode","Always Allow","Deny","Add a
 *    note"]` a few seconds later — the auto-mode option renders late. So a rect
 *    computed from an index read earlier lands on a DIFFERENT button, which is
 *    what *"pressed Always Allow but the card did NOT clear"* was;
 *  - therefore: match the label and take the LAST match (the innermost, most
 *    recently rendered element) and return its rect **in the same evaluation**,
 *    so nothing can shift between the decision and the coordinates.
 *
 * All three are `lib/ask-user.ts` symbol `findCardButton`'s since C3.374, which
 * collapsed the three private copies of this scan into one — and the migration
 * corrected this one on the way: it took its index over the UNFILTERED button
 * list and relied on `r.width === 0` to catch the measuring copy, which the
 * `visibility: hidden` twin defeats because it keeps its box (trap 1 in
 * `lib/ask-user.ts`). `prefer: 'last'` keeps this case's own rule.
 */
async function alwaysAllow(session: CdpSession, run: CaseRun, label: string): Promise<string> {
  const target = await findCardButton(session, {
    card: PERMISSION_CARD, labels: ['always allow'], prefer: 'last',
  })
  run.observe(`${label}: the card's buttons`, target?.labels ?? [])
  if (!target) return 'no-always-allow-button among the VISIBLE copy (see the labels observed above)'
  await clickAt(session, { x: target.x, y: target.y },
    `${PERMISSION_CARD} visible button[${target.index}] (Always Allow)`)
  // The card must GO: one still standing is the next reading's false positive.
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if ((await selectorCount(session, PERMISSION_CARD)) === 0) return target.text || 'Always Allow'
    await Bun.sleep(500)
  }
  return `pressed ${target.text} but the card did NOT clear`
}

/** The app's OWN resolved permission mode — the setter returning is not the posture applying. */
async function resolvedMode(session: CdpSession, sessionId: string): Promise<string | undefined> {
  return session.call<string | undefined>(`
    const all = await window.electronAPI.getSessions()
    const s = (all ?? []).find(x => x.id === ${JSON.stringify(sessionId)})
    return s ? (s.permissionMode ?? undefined) : undefined
  `)
}

interface BranchResult {
  ok: boolean
  sessionId?: string
  supportsBranching?: boolean
  error?: string
  /** The branch's mode as the app reports it — the inheritance, read back. */
  inheritedMode?: string
}

/** The parent's own row, the five fields `ChatDisplay.tsx`'s `onBranch` passes on. */
interface BranchParent {
  workspaceId: string
  name: string | null
  supportsBranching: boolean
  llmConnection: string | null
  model: string | null
  permissionMode: string | null
  enabledSourceSlugs: string[] | null
}

/**
 * Take a branch the way the chat pane does — `createSession` with
 * `branchFromMessageId`, `branchFromSessionId` and the parent's own settings.
 *
 * `supportsBranching` is read off the parent FIRST and reported, because the
 * pane hides the control entirely when it is false and a case that branched
 * anyway would be driving a path no user can reach.
 */
async function branchFrom(
  session: CdpSession,
  parent: SessionKey,
  messageId: string,
): Promise<BranchResult> {
  // The parent's own row first, because the branch inherits its settings and
  // the pane's `onBranch` reads exactly these five fields.
  const row = await session.call<BranchParent | null>(`
    const all = await window.electronAPI.getSessions()
    const p = (all ?? []).find(x => x.id === ${JSON.stringify(parent.sessionId)})
    if (!p) return null
    return {
      workspaceId: p.workspaceId,
      name: p.name ?? null,
      supportsBranching: p.supportsBranching === true,
      llmConnection: p.llmConnection ?? null,
      model: p.model ?? null,
      permissionMode: p.permissionMode ?? null,
      enabledSourceSlugs: p.enabledSourceSlugs ?? null,
    }
  `)
  if (!row) return { ok: false, error: 'parent-session-not-found' }
  // F1.173 — one shared spelling of `electronAPI.createSession`
  // (`lib/state.ts`), so a harness-wide default reaches this path too. The mode
  // is `from-options` and that is the SUBJECT: the branch must inherit the
  // parent's `permissionMode`, because the product's own `onBranch` does and
  // because a harness default written over it would remove the card arm A
  // exists to see. `createSessionDirectly` reads the resulting mode BACK, so
  // the inheritance is measured rather than assumed.
  const created = await createSessionDirectly(
    session,
    row.workspaceId,
    {
      branchFromMessageId: messageId,
      branchFromSessionId: parent.sessionId,
      name: `CDP RS-36 branch of ${row.name ?? 'Untitled'}`,
      ...(row.llmConnection !== null ? { llmConnection: row.llmConnection } : {}),
      ...(row.model !== null ? { model: row.model } : {}),
      ...(row.permissionMode !== null ? { permissionMode: row.permissionMode } : {}),
      ...(row.enabledSourceSlugs !== null ? { enabledSourceSlugs: row.enabledSourceSlugs } : {}),
    },
    'from-options',
  )
  return created.sessionId
    ? { ok: true, sessionId: created.sessionId, supportsBranching: row.supportsBranching, inheritedMode: created.permissionMode }
    : { ok: false, supportsBranching: row.supportsBranching, error: created.error }
}

/**
 * The REPOSITORY rule file the card promises, read at every point that matters.
 *
 * The claude permission card's own footnote says, verbatim: *"Always Allow"
 * saves this command for the repository* — so the grant is not only a
 * session-keyed entry, it is a settings file in the working directory, and
 * `C3.72` settled host-side that *a Bash always-allow that became a
 * `.claude/settings.local.json` rule DOES travel*. Whether it travels at the
 * keyboard is this row.
 *
 * Reading it once at the end cannot answer that, and the first run proved why:
 * the file was on disk holding `Bash(touch *)`, `Bash(mkdir *)` and
 * `Bash(sleep *)` — but the case presses Always Allow on the BRANCH's card too,
 * and on CONTROL 2's, so a single end-of-run read cannot say which press wrote
 * which entry, and *"the rule was on disk and the branch asked anyway"* stays an
 * inference. It is read after the parent grant, again immediately before the
 * branch's subject turn, and again after — three readings, so the ordering is a
 * fact.
 */
function repositoryRules(root: string): { path: string; exists: boolean; allow?: string[]; raw?: string } {
  const path = join(root, '.claude', 'settings.local.json')
  if (!existsSync(path)) return { path, exists: false }
  try {
    const raw = readFileSync(path, 'utf8')
    const parsed = JSON.parse(raw) as { permissions?: { allow?: string[] } }
    return { path, exists: true, allow: parsed.permissions?.allow ?? [], raw: raw.slice(0, 400) }
  } catch (error) {
    return { path, exists: true, raw: `unreadable: ${String(error)}` }
  }
}

/**
 * OPEN the branch, so the composer belongs to it.
 *
 * **This is the fault that made the first four runs of this case measure the
 * PARENT**, measured 2026-09-12 (R6a). `sendPrompt` types into whichever
 * composer is on screen and then waits for the KEY's transcript to grow
 * (`lib/chat.ts`), and `window.electronAPI.createSession` does not move the
 * renderer: `ChatDisplay.tsx`'s own `onBranch` calls
 * `navigate(routes.view.allSessions(child.id))` immediately after it, and this
 * case did not. So every prompt meant for the branch went into the parent, and
 * the waits resolved anyway — the branch's INHERITED history lands
 * asynchronously, so the child's message count rises past the `before` reading
 * with no turn of its own having run. A clean claude verdict came out of it
 * ("the grant TRAVELS"), every control green, and it was a reading of the
 * parent's own session.
 *
 * The remedy is the one `freshSession` already documents for the same surface:
 * drive the renderer's OWN `nessy-agent-navigate` event, then wait for the
 * sidebar row to be the child's, then wait for the composer to be empty — a
 * functional check on the very surface about to be driven, not a delay.
 * `freshSession` uses `action/new-session`; an existing session's route is
 * `allSessions/session/<id>` (`apps/electron/src/shared/route-parser.ts`).
 */
async function openSession(session: CdpSession, sessionId: string): Promise<{ ok: boolean; selected?: string | null; composer?: string }> {
  await session.call<null>(`
    window.dispatchEvent(new CustomEvent('nessy-agent-navigate', {
      detail: { route: ${JSON.stringify(`allSessions/session/`)} + ${JSON.stringify(sessionId)} },
      bubbles: true,
    }))
    return null
  `)
  const selected = await waitFor(
    () => session.call<string | null>(`
      const rows = document.querySelectorAll('.session-item[data-selected]')
      return rows.length === 1 ? rows[0].getAttribute('data-session-id') : null
    `),
    value => value === sessionId,
    { timeoutMs: 20_000, intervalMs: 500, label: `the branch ${sessionId} to become the selected row` },
  ).catch(() => null)
  if (selected !== sessionId) {
    // The row may exist without the route having taken; a click is the remedy
    // the checklist records for exactly this surface.
    await clickSelector(session, `.session-item[data-session-id="${sessionId}"]`).catch(() => undefined)
  }
  const finalSelected = await session.call<string | null>(`
    const rows = document.querySelectorAll('.session-item[data-selected]')
    return rows.length === 1 ? rows[0].getAttribute('data-session-id') : null
  `).catch(() => null)
  const composer = await waitFor(
    () => readComposer(session),
    text => text.trim().length === 0,
    { timeoutMs: 15_000, intervalMs: 500, label: `the pane to switch to the empty composer of ${sessionId}` },
  ).then(() => '').catch(() => readComposer(session).catch(() => '(unreadable)'))
  return { ok: finalSelected === sessionId && composer === '', selected: finalSelected, composer }
}

/** The last message id a branch can be taken from — the pane branches from a MESSAGE. */
function lastMessageId(messages: TranscriptMessage[]): string | undefined {
  for (const message of [...messages].reverse()) {
    if (message.id) return message.id
  }
  return undefined
}

function marked(messages: TranscriptMessage[], marker: string): boolean {
  return messages.some(message =>
    String(message.content ?? '').includes(marker) || String(message.toolResult ?? '').includes(marker))
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)

  const connections = await listConnections(session)
  const cards: Array<[string, string | undefined]> = [
    ['pi', connections.find(row => runtimeOf(row.providerType) === 'pi')?.slug],
    ['claude', connections.find(row => runtimeOf(row.providerType) === 'anthropic')?.slug],
    ['codex', connections.find(row => runtimeOf(row.providerType) === 'codex-runtime')?.slug],
  ]
  run.observe('cards', Object.fromEntries(cards))
  const selected = cards.filter(([name]) => RUNTIME_WANTED.includes(name))
  if (selected.length === 0) blocked(`NESSY_CDP_BRANCH_RUNTIMES=${RUNTIME_WANTED.join(',')} names no runtime family`)

  const root = realpathSync(mkdtempSync(join(tmpdir(), 'nessy-rs36-')))
  try {
    for (const [runtime, card] of selected) {
      if (!card) {
        run.observe(`${runtime}: no card on this host`, 'arm recorded as UNMEASURED, never as a pass')
        continue
      }

      // ================= ARM A — the allow-for-this-session grant ============
      const parent = await freshSession(session, `CDP RS-36 ${runtime} ${new Date().toISOString().slice(11, 19)}`)
      // The REASON, not just the count: `inherited 0 messages` says the fallback
      // session was empty and nothing about WHY the helper fell back, and on
      // 2026-09-12 the why was a trust dialog left standing by a previous run —
      // which is actionable where the count is not.
      run.check(`${runtime}/A: ran in a session it created`, parent.fresh,
        parent.fresh ? undefined
          : `inherited ${parent.inheritedMessages} messages; reason: ${parent.reason ?? '(none given)'}`)
      await switchRuntime(session, parent.sessionId, card)
      run.require(`${runtime}/A: the parent runs on ${card}`,
        (await waitForConnection(session, parent.sessionId, card)) === card, card)
      // F1.121 — the bind is STARTED, the gate answered beside it (awaiting the
      // mutation first is the `pkg-4.ts` deadlock), and the verdict is the
      // session's OWN `workingDirectory`, polled: every rule reading below is
      // taken under this root, and SIT-9 measured a session staying bound to a
      // PREVIOUS repository in 2 of 3 drives with nothing reported.
      const parentBind = bindWorkingDirectory(session, parent.sessionId, root)
      run.observe(`${runtime}/A: trust gate`, await trustScratchProject(session, root).catch(error => String(error)))
      const parentRoot = await parentBind
      run.require(`${runtime}/A: the parent is bound to the scratch repository`,
        parentRoot.bound, parentRoot.reason ?? '')
      // The SHIPPED default is `auto`, not `default`, and `auto` asks for
      // nothing on an ordinary in-workspace read — measured 2026-09-12 (R6a) on
      // the first run of this case, where the granting turn raised no card and
      // the whole arm was void. A grant arm has to be driven in a mode that
      // ASKS, so the mode is set explicitly and READ BACK (the setter returning
      // is not the posture applying, R1's RS-13 correction).
      const wantedMode = process.env.NESSY_CDP_BRANCH_MODE ?? 'default'
      await setPermissionMode(session, parent.sessionId, wantedMode).catch(() => undefined)
      const parentMode = await resolvedMode(session, parent.sessionId)
      run.observe(`${runtime}/A: the parent's resolved permission mode`, { wanted: wantedMode, resolved: parentMode })
      run.require(`${runtime}/A: the parent really is in ${wantedMode}, so a grant arm is possible`,
        parentMode === wantedMode,
        `resolved ${String(parentMode)} — the shipped default is \`auto\`, which asks for nothing`)

      // BOTH commands WRITE, and that is a correction measured on this case's
      // first two runs (R6a, 2026-09-12): a read-only `wc -c` of a file inside
      // the trusted working directory raised no card even in `default`, because
      // a read-only shell command is exactly what `default` allows without
      // asking — so the granting turn had nothing to grant and the arm was void
      // twice before the command changed. They differ in their BINARY, so a
      // grant scoped to the first cannot cover the second however the rule is
      // written, which is what CONTROL 2 depends on.
      const granted = `touch ${join(root, 'granted-by-always-allow.txt')}`
      const ungranted = `mkdir ${join(root, 'never-granted-dir')}`

      const grantBaseline = await selectorCount(session, PERMISSION_CARD)
      const grantTurn = sendPrompt(session, parent,
        `Please run this shell command exactly once and tell me its output: ${granted}`, 240_000)
      const grantCard = await cardRose(session, 90_000, grantBaseline)
      run.check(`${runtime}/A: the granted command RAISED a card in the parent`, grantCard,
        'no card rose above the baseline, so there is nothing to grant and the whole arm is void — either '
        + 'this session is in a mode that asks for nothing (read the resolved mode above) or the gate did '
        + 'not see the call')
      const pressed = grantCard ? await alwaysAllow(session, run, `${runtime}/A`) : '(no card)'
      run.observe(`${runtime}/A: pressed`, pressed)
      run.observe(`${runtime}/A: the granting turn`, await grantTurn
        .then(turn => `${turn.messages.length} messages`).catch(error => `failed: ${String(error)}`))

      // CONTROL 1 — the parent re-issue. A grant that never took looks exactly
      // like a grant that did not travel, and this is what tells them apart.
      const reissueBaseline = await selectorCount(session, PERMISSION_CARD)
      const reissueTurn = sendPrompt(session, parent,
        `Please run this shell command exactly once again and tell me its output: ${granted}`, 240_000)
      const reissueCard = await cardRose(session, 45_000, reissueBaseline)
      // Gated on the granting card, because "no card on the re-issue" is
      // trivially true of a command nothing ever asked about — the shape that
      // let this arm read green twice while measuring nothing.
      run.check(`${runtime}/A: CONTROL 1 — the grant TOOK, so the parent re-issue raises no card`,
        grantCard && !reissueCard,
        grantCard
          ? 'the same command asked again in the SAME session, so "Always Allow" granted nothing durable '
            + 'and no branch reading below can be attributed to inheritance'
          : 'VACUOUS — nothing asked in the first place, so this control cannot discriminate and is '
            + 'reported failed rather than banked')
      run.observe(`${runtime}/A: the re-issue turn`, await reissueTurn
        .then(turn => `${turn.messages.length} messages`).catch(error => `failed: ${String(error)}`))
      const rulesAfterGrant = repositoryRules(root)
      run.observe(`${runtime}/A: the REPOSITORY rule file after the parent's grant`, rulesAfterGrant)

      const parentMessages = await transcript(session, parent)
      const branchPoint = lastMessageId(parentMessages)
      const branch = branchPoint
        ? await branchFrom(session, parent, branchPoint)
        : { ok: false, error: 'no-message-to-branch-from' }
      run.observe(`${runtime}/A: supportsBranching on the parent`, branch.supportsBranching)
      run.check(`${runtime}/A: the branch was taken through the pane's own path`, branch.ok === true,
        branch.error ?? 'createSession with branchFromMessageId refused')
      if (!branch.ok || !branch.sessionId) {
        run.observe(`${runtime}/A: VERDICT`, 'the branch could not be taken — F40 unmeasured on this runtime')
        continue
      }
      const child: SessionKey = { sessionId: branch.sessionId, workspaceId: parent.workspaceId }
      const opened = await openSession(session, child.sessionId)
      run.observe(`${runtime}/A: opened the branch's pane`, opened)
      run.require(`${runtime}/A: THE BRANCH'S PANE IS ON SCREEN, so the composer belongs to it`, opened.ok,
        `selected row ${String(opened.selected)}, composer ${JSON.stringify(opened.composer)} — without this `
        + 'every prompt below goes into the PARENT and the waits resolve anyway, because the branch\'s '
        + 'inherited history lands asynchronously and pushes its message count past the baseline with no '
        + 'turn of its own having run')
      run.observe(`${runtime}/A: the branch's resolved permission mode`, await resolvedMode(session, child.sessionId))

      // THE SUBJECT: the same command in the branch.
      const rulesBeforeSubject = repositoryRules(root)
      run.observe(`${runtime}/A: the REPOSITORY rule file immediately BEFORE the branch's subject turn`,
        rulesBeforeSubject)
      const inheritBaseline = await selectorCount(session, PERMISSION_CARD)
      const inheritTurn = sendPrompt(session, child,
        `Please run this shell command exactly once and tell me its output: ${granted}`, 240_000)
      const inheritCard = await cardRose(session, 90_000, inheritBaseline)
      if (inheritCard) await alwaysAllow(session, run, `${runtime}/A branch subject`)
      run.observe(`${runtime}/A: THE READING — does the branch ask again for the granted command`,
        inheritCard ? 'YES, it asks again — the grant did NOT travel' : 'NO, it runs unasked — the grant TRAVELLED')
      run.observe(`${runtime}/A: the branch subject turn`, await inheritTurn
        .then(turn => `${turn.messages.length} messages`).catch(error => `failed: ${String(error)}`))

      // CONTROL 2 — a never-granted command in the same branch. Without it "no
      // card" is equally true of a branch whose gate is not running.
      const gateBaseline = await selectorCount(session, PERMISSION_CARD)
      const gateTurn = sendPrompt(session, child,
        `Please run this shell command exactly once and tell me its output: ${ungranted}`, 240_000)
      const gateCard = await cardRose(session, 90_000, gateBaseline)
      if (gateCard) await alwaysAllow(session, run, `${runtime}/A branch control`)
      run.check(`${runtime}/A: CONTROL 2 — the branch's gate is alive (a never-granted command asks)`,
        gateCard,
        'a command this session never granted also ran unasked, so the subject reading above cannot be '
        + 'attributed to the grant travelling — this branch asks for nothing at all')
      run.observe(`${runtime}/A: the branch control turn`, await gateTurn
        .then(turn => `${turn.messages.length} messages`).catch(error => `failed: ${String(error)}`))

      const grantedRuleWasOnDisk = (rulesBeforeSubject.allow ?? []).some(rule => /touch/.test(rule))
      run.observe(`${runtime}/A VERDICT (F40, the grant clause)`, {
        parentAsked: grantCard,
        grantTook: !reissueCard,
        repositoryRuleOnDiskBeforeTheBranchAsked: grantedRuleWasOnDisk,
        repositoryRules: rulesBeforeSubject.allow,
        branchAsksAgain: inheritCard,
        branchGateAlive: gateCard,
        reading: !grantCard || reissueCard
          ? 'VOID — the grant did not take, so nothing about the branch is established'
          : !gateCard
            ? 'VOID — the branch asks for nothing at all, so the subject reading is uninterpretable'
            : inheritCard
              ? grantedRuleWasOnDisk
                ? 'the grant does NOT travel: the branch asks again EVEN THOUGH the rule the card promised '
                  + '("saves this command for the repository") was already on disk in the branch\'s own '
                  + 'working directory — which the branch inherits'
                : 'the session grant does NOT travel across a branch: the branch asks again, and no '
                  + 'repository rule was on disk for it to inherit'
              : 'the session grant TRAVELS across a branch: the branch runs it unasked',
      })
      run.observe(`${runtime}/A: the REPOSITORY rule file after the branch's turns`, repositoryRules(root))

      // ================= ARM B — work already in flight =======================
      const marker = `RS36-${Math.random().toString(16).slice(2, 10).toUpperCase()}`
      const flight = await freshSession(session, `CDP RS-36 ${runtime} flight ${new Date().toISOString().slice(11, 19)}`)
      await switchRuntime(session, flight.sessionId, card)
      await waitForConnection(session, flight.sessionId, card)
      const flightBind = bindWorkingDirectory(session, flight.sessionId, root)
      await trustScratchProject(session, root).catch(() => undefined)
      run.observe(`${runtime}/B: the in-flight session's working directory`, await flightBind)
      await setPermissionMode(session, flight.sessionId, wantedMode).catch(() => undefined)
      const flightBaseline = await selectorCount(session, PERMISSION_CARD)
      const flightTurn = sendPrompt(session, flight,
        `Please start this shell command in the BACKGROUND and do not wait for it: sleep 40 && echo ${marker}`,
        240_000)
      if (await cardRose(session, 90_000, flightBaseline)) await alwaysAllow(session, run, `${runtime}/B`)
      // Branch WHILE it runs. The branch point is whatever the transcript has by
      // now, which is the same thing a user clicking mid-turn would get.
      await Bun.sleep(8_000)
      const flightMessages = await transcript(session, flight)
      const flightPoint = lastMessageId(flightMessages)
      const flightBranch = flightPoint
        ? await branchFrom(session, flight, flightPoint)
        : { ok: false, error: 'no-message-to-branch-from' }
      run.observe(`${runtime}/B: branched mid-flight`, { ok: flightBranch.ok, error: flightBranch.error })
      run.observe(`${runtime}/B: the starting turn`, await flightTurn
        .then(turn => `${turn.messages.length} messages`).catch(error => `failed: ${String(error)}`))

      const flightChild: SessionKey | undefined = flightBranch.ok && flightBranch.sessionId
        ? { sessionId: flightBranch.sessionId, workspaceId: flight.workspaceId }
        : undefined
      // Arm B reads TRANSCRIPTS rather than typing, so the pane matters less —
      // but it is opened anyway, because `getSessionMessages` on a session the
      // renderer has never shown can answer before its inherited history has
      // landed, and a marker read against a half-loaded transcript is the same
      // class of fault as arm A's.
      if (flightChild) run.observe(`${runtime}/B: opened the branch's pane`, await openSession(session, flightChild.sessionId))
      const landing = await waitFor(
        async () => ({
          parent: marked(await transcript(session, flight), marker),
          branch: flightChild ? marked(await transcript(session, flightChild), marker) : false,
        }),
        value => value.parent || value.branch,
        { timeoutMs: 120_000, intervalMs: 4_000 },
      ).catch(() => ({ parent: false, branch: false }))
      run.observe(`${runtime}/B VERDICT (F40, the in-flight clause)`, {
        marker,
        landedInParent: landing.parent,
        landedInBranch: landing.branch,
        reading: landing.branch && !landing.parent
          ? 'the BRANCH received the completion of work the PARENT started — a child inheriting a running '
            + 'process’s output, which is the finding this clause exists to catch'
          : landing.parent && landing.branch
            ? 'BOTH sessions received it'
            : landing.parent
              ? 'the parent kept its own completion and the branch saw nothing — the ordinary answer'
              : 'neither session received the marker inside the window; recorded as such rather than as '
                + 'either answer (the runtime may have refused to background the command at all)',
      })
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
    run.observe('fixture removed', root)
  }
}

export const manual = {
  steps: [
    '1. PACKAGED build, one content panel, a card per runtime signed in. A dev build runs from stale bundles and is not the artefact.',
    '2. New session on the runtime under test, working directory set to a scratch directory OUTSIDE any config dir, and the permission mode set EXPLICITLY to one that asks. The shipped default resolves to `auto`, which asks for nothing on an ordinary in-workspace read — measured 2026-09-12, where a grant arm left at the default raised no card and was void — so set it and read it back from getSessions().',
    '3. Ask for one shell command and answer its card with ALWAYS ALLOW — not Allow, which grants the single call and leaves nothing to inherit.',
    '4. CONTROL 1: re-issue the SAME command in the SAME session. No card may appear. A grant that never took is indistinguishable from a grant that did not travel, and this is the step that tells them apart.',
    '5. Branch the way the pane does — `createSession(workspaceId, { branchFromMessageId, branchFromSessionId, llmConnection, model, permissionMode, enabledSourceSlugs })`, which is `ChatDisplay.tsx`\'s own `onBranch`. Read `supportsBranching` off the parent first: the pane hides the control when it is false.',
    '6. Read the BRANCH\'s resolved `permissionMode` back from `getSessions()` — the value passed in is not the posture applied.',
    '7. OPEN THE BRANCH first — `createSession` does not move the renderer, and the composer belongs to whichever session the PANE shows. Dispatch the app\'s own `nessy-agent-navigate` at `allSessions/session/<childId>`, confirm the sidebar row and an empty composer, and only then re-issue the granted command in the branch. Measured 2026-09-12: without this every prompt goes into the PARENT and the waits resolve anyway, because the branch\'s inherited history pushes its message count past the baseline with no turn of its own having run — a full claude verdict with every control green came out of it and was a reading of the parent.',
    '7b. THE SUBJECT: record whether a card rises above the baseline taken immediately before the branch re-issue.',
    '8. CONTROL 2: a command the session never granted, in the same branch. It MUST ask. Without it, "no card" in step 7 is equally true of a branch whose gate is not running.',
    '8b. Read `<cwd>/.claude/settings.local.json` after the parent grant, again immediately BEFORE the branch\'s subject turn, and again after. The card promises the grant "saves this command for the repository", and the branch inherits the working directory — so whether the rule was ALREADY on disk when the branch asked is the whole difference between a session-scoped grant behaving correctly and a repository rule the branch ignores. One end-of-run read cannot say: the case also presses Always Allow on the branch\'s own card and on CONTROL 2\'s, so the file accumulates.',
    '9. ARM B: new session, start a backgrounded command that will finish in ~40 s, branch mid-flight, then poll BOTH transcripts for its marker. Record which of the three outcomes happened — parent only, branch too, or neither.',
    '10. Repeat per runtime. Pi is unreachable while the dp CLI session is lapsed; record it unmeasured with that reason rather than as absent.',
  ],
  expected: 'per runtime: whether an allow-for-this-session grant survives a branch, with both controls green; '
    + 'and which session receives the completion of work the parent had in flight.',
  detector: 'the permission card\'s appearance as a RISE above the baseline read immediately before each prompt '
    + '(an absolute count scored a standing card from a previous arm as the current arm\'s, R1 2026-09-12), and '
    + 'for arm B the marker in each session\'s own `getSessionMessages` — the persisted transcript, not the screen.',
  positiveControl: 'CONTROL 1, the parent re-issue, which must raise no card — it proves the grant took at all; '
    + 'and CONTROL 2, a never-granted command inside the branch, which must raise one — it proves the branch\'s '
    + 'gate is running. Either one failing makes the subject reading VOID, and the case says so rather than '
    + 'banking it.',
  doneMeans: 'F40 carries a driven verdict per runtime — does a session grant travel across a branch, and which '
    + 'session receives in-flight work — with both controls recorded; a grant that survives is a SILENT-LOOSER '
    + 'finding to record beside A7, not a pass.',
  safety: 'the shell commands read a file the case wrote in its own scratch directory and nothing else; no '
    + 'command names a home directory, and the fixture is removed at the end.',
} as const satisfies SittingRecipe

if (import.meta.main) await main(ID, TITLE, drive)
