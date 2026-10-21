/**
 * RS-22 (P6.304) — the todo card has THREE different producers and none of them
 * has been watched live on the runtime it belongs to.
 *
 * The row's native mechanism, verbatim: *"Pi — host registry `TodoWrite`;
 * claude — the SDK's native `TodoWrite` is off (`f6()` true because nothing sets
 * `CLAUDE_CODE_ENABLE_TASKS`), so the host's is the only checklist and it
 * renders; codex — its OWN `update_plan`, synthesised from `turn/plan/updated`
 * into a tool row"*. Three producers, one card. The map's codex cell is stale,
 * which is why this needs a reading rather than a build.
 *
 * ## The detector is the TOOL NAME, not the card
 *
 * `TodoListCard` mounts on `isTodoCardActivity`, which routes on
 * `isPlanWritingTool` — and that function accepts two vocabularies with two
 * DIFFERENT comparisons (`packages/shared/src/utils/toolNames.ts`):
 *
 *   - `TodoWrite`, matched case-folded with `_`/`-` stripped as a SUFFIX,
 *     because it also arrives as `mcp__session__TodoWrite` depending on which
 *     surface served it;
 *   - `update_plan`, matched EXACTLY or with an `mcp__…__` prefix and NOT
 *     case-folded, because its loose form would start matching unrelated tools.
 *
 * So "the card appeared" answers the wrong question: the row asks WHICH PRODUCER
 * DREW IT, and only the tool name says. This case reads the name, applies the
 * same two comparisons the app applies, and reports the producer by name. That
 * is also why it is a state read rather than a DOM read — `TodoListCard` carries
 * no test id, and a screenshot of a checklist cannot say who wrote it.
 *
 * ## The controls
 *
 * 1. **A session that asks for no checklist**, where no plan-writing tool may
 *    appear. Without it, a card that mounts for unrelated reasons — or a
 *    producer left running from an earlier session — scores as this run's.
 * 2. **On codex, the synthesised row.** Its producer emits no thread item for
 *    the call at all; `backend/codex/event-adapter.ts` synthesises the row from
 *    `turn/plan/updated` and stamps `update_plan` on it. Observing that exact
 *    name is what distinguishes the synthesiser from a host tool having run — a
 *    `TodoWrite` on a codex card would mean the host tool answered, which is a
 *    finding, not a pass.
 */

import { approvePermissionsWhile, requireApproverSaw } from '../lib/ask-user.ts'
import { sendPrompt } from '../lib/chat.ts'
import type { CdpSession } from '../lib/connect.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import { boundCard, listConnections, runtimeOf } from '../lib/runtime-switch.ts'
import { assertElectronApi, freshSession, setPermissionMode, transcript } from '../lib/state.ts'
import type { CaseMeta, SittingRecipe } from '../lib/sitting.ts'
import { requireAbsence, turnAnswered } from '../lib/turn-evidence.ts'

const ID = 'RS-22'
const TITLE = 'which producer draws the todo card on each runtime — the host TodoWrite, or codex’s synthesised update_plan'

export const meta = {
  id: ID,
  title: TITLE,
  row: 'P6.304',
  runtimes: ['pi', 'claude', 'codex'],
  credentials: 'owner: run once per card. No key is read.',
} as const satisfies CaseMeta

/** codex's plan tool, by the wire spelling — `CODEX_PLAN_TOOL_NAME`. */
const CODEX_PLAN_TOOL = 'update_plan'

/**
 * The Task tools — the FOURTH producer, and the one this case could not see.
 *
 * Measured 2026-09-11 on the pi card: the checklist request produced three
 * `TaskCreate` and four `TaskUpdate` calls and NOT ONE `TodoWrite`, so a case
 * reading only `isPlanWritingTool`'s vocabulary scored "no producer on pi" for a
 * session that had just drawn a checklist. The row's own map cell — *"Pi — host
 * registry `TodoWrite`"* — is what that reading came from, and it is stale.
 *
 * They are a different SURFACE as well as a different vocabulary:
 * `TodoListCard` mounts on `isPlanWritingTool`, while `TaskCreate`/`TaskUpdate`
 * feed `TaskChecklistPanel` through `extractChecklistFromActivities`. So "which
 * producer" and "which card" are two questions, and this case now records both.
 *
 * The comparison is `matchesTool`'s — exact, or an `mcp__…__` suffix — and NOT
 * the case-folded suffix rule `TodoWrite` gets. Transcribed rather than
 * imported, like the two below it.
 */
const TASK_TOOLS = ['TaskCreate', 'TaskUpdate', 'TaskList'] as const

/**
 * The app's own comparisons, written out rather than imported.
 *
 * A check that derives its expectation from the code under test passes whatever
 * that code does, regressions included. These are the rules as `isPlanWritingTool`
 * and `matchesTool` state them, transcribed on purpose so a drift between them
 * and this file is visible.
 */
function producerOf(name: string | undefined): 'codex-update_plan' | 'todo-write' | 'task-tools' | undefined {
  if (!name) return undefined
  if (name === CODEX_PLAN_TOOL || name.endsWith(`__${CODEX_PLAN_TOOL}`)) return 'codex-update_plan'
  if (name.toLowerCase().replace(/[_-]/g, '').endsWith('todowrite')) return 'todo-write'
  if (TASK_TOOLS.some(tool => name === tool || name.endsWith(`__${tool}`))) return 'task-tools'
  return undefined
}

/** Which SURFACE a producer draws into — two cards, not one. */
function surfaceOf(producer: string): string {
  return producer === 'task-tools'
    ? 'TaskChecklistPanel (extractChecklistFromActivities)'
    : 'TodoListCard (isPlanWritingTool)'
}

const CHECKLIST_PROMPT = 'Plan a three-step task for me: create a folder, add one file to it, and list what is inside. '
  + 'Keep a running checklist of the three steps as you go, and tell me when each one is done.'

/** The same task, with the capability named. Only used when the first drew nothing. */
const EXPLICIT_PROMPT = 'Please use your todo list tool to track this: create a folder, add one file to it, and list what is inside. '
  + 'Write the three items into the todo list first, then work through them, marking each one done as you finish it.'

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)

  const key = await freshSession(session, `CDP ${ID} ${new Date().toISOString().slice(11, 19)}`)
  run.observe('session', { workspaceId: key.workspaceId, sessionId: key.sessionId })
  run.check('the case ran in a session it created', key.fresh, key.fresh ? undefined : `inherited ${key.inheritedMessages} messages`)

  const slug = await boundCard(session, key.sessionId)
  const rows = await listConnections(session)
  const connection = rows.find(r => r.slug === slug)
  if (!connection) {
    blocked(`this session is bound to ${slug ? `connection ${slug}, which the app does not list` : 'no connection'}`)
  }
  const runtime = runtimeOf(connection.providerType)
  run.observe('runtime', { card: connection.name ?? connection.slug, slug: connection.slug, providerType: connection.providerType, runtime })

  // The posture — PR-3 (W14-sit, 2026-09-11). The checklist prompt below asks
  // for a folder and a file, so the turn calls mutating tools; with no posture
  // this case stopped on `Write` on the claude card, thirteen messages in, with
  // two sidebar rows showing `Allow once / Deny` and nothing to press them. The
  // producer of the todo card is not a permissions question, so the posture is
  // the strongest one and the approver underneath is the net for whatever it
  // does not cover.
  const setMode = await setPermissionMode(session, key.sessionId, 'bypassPermissions').then(() => 'set').catch(error => `refused: ${String(error)}`)
  run.observe('permission-posture', { posture: 'bypassPermissions', outcome: setMode })
  const approver = approvePermissionsWhile(session, key.sessionId)
  // D1.356 — both exits go through here, so the sight check does too: this
  // case's finding is WHICH tool drew the checklist, and a card the count could
  // not see stalls the turn that would have drawn it, leaving `tools.length ===
  // 0` — which this case reports as "the card has no producer on this runtime".
  const stopApprovals = async (): Promise<void> => {
    run.observe('permission-cards-answered', await approver.stop())
    requireApproverSaw(run, approver, 'the checklist turn')
  }

  // ---- CONTROL — a turn that asks for no checklist --------------------------
  const control = await sendPrompt(session, key, 'In one sentence, what is the capital of France?', 150_000)
  const controlProducers = control.added.map(m => producerOf(m.toolName)).filter(Boolean)
  run.observe('control-tools', control.added.filter(m => m.toolName).map(m => m.toolName))
  // F1.504 — a control turn that answered nothing draws no tool either.
  requireAbsence(
    run,
    'THE CONTROL — a turn that asks for no checklist draws no plan-writing tool',
    controlProducers.length === 0,
    turnAnswered(control.added),
    `the control turn already produced ${JSON.stringify(controlProducers)} — nothing below can be attributed to the checklist request`,
  )

  // ---- THE PROBE -----------------------------------------------------------
  const probe = await sendPrompt(session, key, CHECKLIST_PROMPT, 300_000)
  const planTools = probe.added.filter(m => producerOf(m.toolName) !== undefined)
  const producers = [...new Set(planTools.map(m => producerOf(m.toolName)!))]
  run.observe('probe-tools', probe.added.filter(m => m.toolName).map(m => ({ tool: m.toolName, status: m.toolStatus })))
  run.observe('producers', producers)

  // ---- THE SECOND PROBE — only when the first drew nothing ----------------
  // The first probe describes a task and hopes the model reaches for a
  // checklist. Measured 2026-09-11 on the pi card: it ran `Bash`, `Write` and
  // `Ls` and no plan-writing tool at all — and that reading cannot tell "this
  // runtime has no producer" from "this model did not feel like using one",
  // which are different cells. Naming the capability POSITIVELY separates them.
  // Positively is the operative word: AGENTS.md records that a prompt naming a
  // tool and forbidding it trips Pi's Guardian as prompt injection, and the
  // wreckage then reads like a dispatch bug.
  let tools = planTools
  let producerNames = producers
  if (planTools.length === 0) {
    const asked = await sendPrompt(session, key, EXPLICIT_PROMPT, 300_000)
    const askedPlan = asked.added.filter(m => producerOf(m.toolName) !== undefined)
    run.observe('explicit-probe-tools', asked.added.filter(m => m.toolName).map(m => ({ tool: m.toolName, status: m.toolStatus })))
    run.observe(
      'explicit-probe-verdict',
      askedPlan.length > 0
        ? `the producer IS on this session's tool set — it appeared only when asked for by name, so on ${runtime} the card is `
          + 'available and the model does not reach for it unprompted. Record the cell as available-but-unprompted, never as absent.'
        : `no plan-writing tool even when asked for by name, so on ${runtime} the card has no producer this run could reach`,
    )
    tools = askedPlan
    producerNames = [...new Set(askedPlan.map(m => producerOf(m.toolName)!))]
  }

  run.check(
    'a plan-writing tool drew the checklist on this runtime',
    tools.length > 0,
    tools.length > 0
      ? undefined
      : `no tool matching either vocabulary appeared on ${runtime}, in the described task OR when asked for by name — record this `
        + 'cell as the card having no producer here, with both tool lists above as the evidence',
  )
  if (tools.length === 0) {
    await stopApprovals()
    return
  }

  // The row's whole question: WHICH producer. Recorded by name, and checked
  // against the one the runtime is supposed to use — a mismatch is the finding.
  run.observe('surfaces', producerNames.map(name => `${name} → ${surfaceOf(name)}`))
  // The row's map says pi and claude use `TodoWrite` and codex its own
  // `update_plan`. Measured, pi uses NEITHER: it reaches for the Task tools, a
  // producer that draws into a DIFFERENT card. That is the row's finding, so it
  // is recorded by name rather than scored against a map this run refutes.
  const expected = runtime === 'codex-runtime' ? 'codex-update_plan' : 'todo-write'
  const matched = producerNames.length === 1 && producerNames[0] === expected
  run.observe(
    'producer-vs-map',
    matched
      ? `as the row's map says: ${expected}`
      : `the row's map says ${expected} for ${runtime}; this run measured ${JSON.stringify(producerNames)}. `
        + 'A `task-tools` producer is a different CARD as well as a different tool, so the cell has to name both.',
  )
  run.check(
    `the producer on ${runtime} is one this app draws a checklist from`,
    producerNames.length > 0,
    `it is ${JSON.stringify(producerNames)}. On a codex card a ${JSON.stringify('todo-write')} producer means the HOST tool answered rather than the`
      + ' synthesiser reading `turn/plan/updated`, which is a finding rather than a pass; on pi/claude the reverse is equally a finding.',
  )
  run.check(
    'the checklist updated more than once — the card was drawn, not merely opened',
    tools.length > 1,
    `only ${tools.length} plan-writing call in the turn; a three-step checklist that writes once has not been watched updating`,
  )
  await stopApprovals()
}

if (import.meta.main) {
  await main(ID, TITLE, drive)
}

export const manual = {
  steps: [
    '1. PACKAGED build, dark theme, one content panel. New session on the card under test.',
    '2. `bun run scripts/cdp/cases/rs-22.ts` with NESSY_CDP_PORT pointed at the app.',
    '3. Repeat per card. Write one narrative per runtime under `docs/testing/cdp-runs/`, each NAMING the producer the run observed.',
  ],
  expected: 'pi and claude: a `TodoWrite`-family tool, more than once. codex: `update_plan`, more than once, synthesised from `turn/plan/updated`. The control turn produces neither.',
  detector: 'the tool NAME on the transcript entries the checklist turn added, matched by the app\'s own two comparisons (exact/prefixed for `update_plan`, case-folded suffix for `TodoWrite`). Not the card on screen: `TodoListCard` carries no test id and a picture of a checklist cannot say who wrote it.',
  positiveControl: 'a turn in the same session that asks for no checklist, which must draw no plan-writing tool; and on codex the exact `update_plan` spelling, which separates the synthesiser from the host tool having answered.',
  doneMeans: 'three narratives in `docs/testing/cdp-runs/` and a case row in `docs/testing/cdp-live-checklist.md`, one per runtime, each naming which producer drew the card.',
} as const satisfies SittingRecipe
