/**
 * RS-49 (D1.18) — is the SDK's dynamic-Workflows tool in a PACKAGED claude
 * session's own tool roster, or held by the remote flag?
 *
 * ## What the row needs and what has already moved
 *
 * D1.18 (source `P6.125`) is ledger `H2/claude`, `absent ᵗ`, and the STRUCTURAL
 * reason on file — *"the SDK has no orchestration seam to hand a recipe to"* —
 * is true of our saved recipes and false of the SDK's own dynamic workflows. The
 * row costs the delivery path as *"already open"*; at HEAD it is BUILT, because
 * `enableWorkflows` is part of claude's managed-settings key set under C3.116.
 *
 * So the one question a source read cannot answer is whether the tool is
 * DELIVERED. The vendored typings at `0.3.251` still declare all four keys, and
 * the packaged binary carries `ultracode`, `workflowKeywordTriggerEnabled` and
 * the gate name `tengu_workflows_enabled` — a remote flag. A negative therefore
 * means ENTITLEMENT rather than absence, and the cell must record WHICH.
 *
 * ## The detector, and why it is the runtime's own file
 *
 * Not the screen and not the model's prose: the SDK writes its own session
 * transcript, and the roster the host was given is in it. `readClaudeSessionLog`
 * is the existing reader for exactly that file on a packaged build, which is the
 * row's own instruction — a packaged build, because `electron:dev` runs built
 * bundles and a main-process change can be absent from the running app.
 *
 * ## The control, which is the whole reason a negative here is worth anything
 *
 * `Task` and `TodoWrite` are SDK tools every session gets. If the roster read
 * cannot find THEM, then "no `Workflow` entry" is a property of the read. Both
 * are asserted before the row's own question is scored, and the case reports the
 * whole roster it found so the next reader can see what it was looking at.
 *
 * ## What this case deliberately does NOT do
 *
 * It does not write `.claude/settings.json` itself. The row's rig suggested it
 * when the delivery path was only "open"; now that the host writes the key, a
 * case that wrote its own file would measure the file it wrote rather than the
 * product. If the tool is absent here, the follow-up arm — flipping the host's
 * own setting and re-reading — is the honest next step and it needs the setting
 * surface, not a hand-written file.
 *
 * ## MEASURED 2026-09-17 on the packaged 1.39.0: this detector does not work yet
 *
 * The case ran, the claude turn answered, and the SDK session file was read — and
 * `Task` and `TodoWrite` occur ZERO times in it. The only capitalised identifier
 * in the whole file is `HEAD`. So the persisted transcript is NOT where the init
 * tool roster lives on this build, and the case BLOCKS on its own control rather
 * than recording an absence its instrument could not have seen. Whoever takes
 * D1.18 next needs the SDK `system`/`init` message as the HOST receives it; the
 * transcript file is the wrong surface and this file records why.
 *
 * ## Safety
 *
 * One turn on whichever claude-runtime card the profile already has. No
 * credential is read or written, no connection is created, and the prompt asks
 * for a single word so the turn is as short as the card allows.
 */

import { readClaudeSessionLog } from '../lib/runtime-session-log.ts'
import { sendPrompt } from '../lib/chat.ts'
import type { CdpSession } from '../lib/connect.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import { assertElectronApi, freshSession } from '../lib/state.ts'
import type { CaseMeta } from '../lib/sitting.ts'

const ID = 'RS-49'
const TITLE = 'the SDK dynamic-Workflows tool in a packaged claude session roster, or the entitlement'

export const meta = {
  id: ID,
  title: TITLE,
  row: 'D1.18',
  runtimes: ['claude'],
  credentials:
    'owner: a claude-runtime card the profile already has (the Nessy gateway one-click card is enough). The case '
    + 'creates no connection. Run it with NESSY_CONFIG_DIR set to the directory the app was launched with — the '
    + 'detector is a file under it.',
} as const satisfies CaseMeta

/** SDK tools every session gets — the roster read's positive control. */
const CONTROL_TOOLS = ['Task', 'TodoWrite'] as const

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)

  const cards = await session.call<Array<{ slug: string; providerType: string }>>(`
    const rows = await window.electronAPI.listLlmConnections()
    return (rows ?? []).map(c => ({ slug: c.slug, providerType: c.providerType }))
  `)
  run.observe('the cards this profile has', cards)
  const claudeCard = cards.find(card => card.providerType === 'claude-runtime')
  if (!claudeCard) {
    blocked(
      'this profile lists no claude-runtime card, so there is no SDK session to read a roster from. The case refuses '
      + 'rather than passing vacuously on a Pi-only host.',
    )
  }
  run.observe('the card under test', claudeCard.slug)

  process.env.NESSY_CDP_CARD = claudeCard.slug
  const key = await freshSession(session, `CDP ${ID} ${new Date().toISOString().slice(11, 19)}`)
  run.check('the case ran in a session it created', key.fresh, key.reason ?? '')
  await session.call<null>(`
    await window.electronAPI.sessionCommand(${JSON.stringify(key.sessionId)}, { type: 'switchRuntime', connectionSlug: ${JSON.stringify(claudeCard.slug)} })
    return null
  `).catch(() => null)
  await Bun.sleep(2_500)

  const turn = await sendPrompt(session, key, 'Reply with the single word ready and nothing else.', 180_000)
    .catch(error => ({ added: 0, text: `turn failed: ${String(error).slice(0, 200)}` }))
  run.observe('the turn that had to happen for a session file to exist', turn)

  const cwd = await session.call<string | undefined>(`
    const rows = await window.electronAPI.getSessions()
    const row = (rows ?? []).find(s => s.id === ${JSON.stringify(key.sessionId)})
    return row?.workingDirectory ?? row?.cwd ?? undefined
  `).catch(() => undefined)
  // POLL, do not sample. Measured on this case's first drive: `sendPrompt`
  // returned as soon as the user row landed, the SDK's own `projects` directory
  // did not exist yet, and the case BLOCKED on a session whose turn answered
  // `ready` seconds later. The directory is created by the first claude turn in
  // a workspace, so the read has to outlive the turn rather than race it.
  let log = readClaudeSessionLog(key.workspaceId, undefined, key.sessionId, cwd)
  for (let attempt = 0; attempt < 30 && log.entries.length === 0; attempt += 1) {
    await Bun.sleep(3_000)
    log = readClaudeSessionLog(key.workspaceId, undefined, key.sessionId, cwd)
  }
  run.observe('the SDK session file this case read', { file: log.file, entries: log.entries.length, reason: log.reason })
  if (log.entries.length === 0) {
    blocked(
      `the claude SDK wrote no session file this case could read (${log.reason ?? 'no reason given'}), so the roster `
      + 'is unreadable and neither the control nor the row\'s question can be scored.',
    )
  }

  // The roster lives on the SDK's own init/system entry. Rather than guess its
  // field name — which has moved between SDK versions — the case collects every
  // string in every entry that looks like a tool-name list and reports what it
  // found, then asks the two questions of the union.
  const serialised = log.entries.map(entry => JSON.stringify(entry.raw)).join('\n')
  const named = (needle: string): number => serialised.split(`"${needle}"`).length - 1
  const roster = Array.from(new Set(
    (serialised.match(/"[A-Z][A-Za-z]{2,24}"/g) ?? []).map(match => match.slice(1, -1)),
  )).sort()
  run.observe('every capitalised identifier in the session file (the roster this case read)', roster.slice(0, 120))

  const missing = CONTROL_TOOLS.filter(tool => named(tool) === 0)
  run.observe('THE CONTROL — SDK tools every session gets', Object.fromEntries(CONTROL_TOOLS.map(tool => [tool, named(tool)])))
  if (missing.length > 0) {
    // BLOCKED, not FAIL. "No `Workflow` in this file" would be a property of the
    // READ, and a case that scored it as a product verdict would fill H2/claude
    // from an instrument that cannot see a tool roster at all. Measured on this
    // case's second drive against the packaged 1.39.0: the SDK session file
    // exists and carries the conversation, and `Task` and `TodoWrite` occur ZERO
    // times in it — the only capitalised identifier in the whole file is `HEAD`.
    blocked(
      `the SDK session file at ${log.file} carries no tool roster: ${missing.join(' and ')} occur zero times in it, `
      + 'and they are tools every claude session gets. So this file is the wrong detector for D1.18 and the row stays '
      + 'unanswered rather than being filled from a read that cannot see the roster. The next arm needs a surface '
      + 'that carries the init tool list — the SDK `system`/`init` message as the host receives it, not the '
      + 'transcript the SDK persists.',
    )
  }

  const workflowHits = named('Workflow')
  const ultracodeHits = serialised.split('ultracode').length - 1
  run.observe('the row\'s own question', {
    Workflow: workflowHits,
    ultracode: ultracodeHits,
    note: workflowHits > 0
      ? 'the tool IS delivered to a packaged claude session — H2/claude is not absent'
      : 'the tool is NOT in this session\'s file. The binary carries the gate name `tengu_workflows_enabled`, so this '
        + 'is ENTITLEMENT rather than absence unless a later arm shows the host never asked for it',
  })
  run.check(
    'a `Workflow` entry reaches a packaged claude session',
    workflowHits > 0,
    'no `Workflow` identifier in a roster read whose controls DID answer. Read the note above: a negative here means '
    + 'the cell is filled `partial` by entitlement, not `absent`, and the row asks for WHICH — do not fill it from '
    + 'this line alone',
  )
}

if (import.meta.main) await main(ID, TITLE, drive)
