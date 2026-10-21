/**
 * NCA-3 — the composer's Plan/Act chips come from the LIVE agent card.
 *
 * T2's finding is the reason this row exists: `agent-card-modes.ts` read only
 * the top-level `extension(s)` and never `capabilities.extensions`, where BOTH
 * wires nest them. The remote mode catalog was therefore dead on the real card
 * — and nobody could see it, because the static fallback produces the same two
 * chips the card would have produced.
 *
 * ## The trap this case is built around
 *
 * `KNOWN_REMOTE_MODES` (`nestor-cloud/agent-card-modes.ts:12-29`) maps a card's
 * `plan` and `act` onto options that are **byte-identical** to
 * `NESTOR_CLOUD_MODE_OPTIONS` (`backend/composer-capabilities.ts:11-28`), the
 * static pair used when the card is unreadable. So for the ordinary card —
 * `mode.enum = ["plan","act"]` — the composer state is the SAME in both worlds:
 *
 * - card parsed → `cloudModes = [plan, act]` → `resolveNestorCloudPermissions` uses it
 * - card dead → `cloudModes = undefined` → the same two, from the constant
 *
 * **Reading `modeOptions` therefore cannot, on its own, tell a live card from a
 * dead parse.** That is precisely the world T2 shipped in. A case that compared
 * the chips against Plan/Act would have passed throughout the bug's life.
 *
 * ## What actually discriminates
 *
 * `NestorCloudAgent.postInit` CONFESSES when it falls back, on `this.debug`:
 *
 * - `Nestor Cloud AgentCard did not advertise composer modes; using static composer modes`
 * - `Nestor Cloud AgentCard unavailable; using static composer modes: <err>`
 *
 * and `this.debug` is not a debug-mode line — `SessionManager` wires
 * `agent.onDebug` to `sessionLog.info` (`SessionManager.ts:16023,:16045`), an
 * always-on record. Their ABSENCE across the window that contains this session's
 * postInit is the proof the card was read. Their presence is the T2 bug, named.
 *
 * The case therefore requires an app log and BLOCKS without one, rather than
 * falling back to the mode list — because falling back to the mode list is the
 * vacuous pass.
 *
 * ## And when the card names more than plan/act
 *
 * Then `remoteModeId` values outside the fallback pair appear in `modeOptions`,
 * and that IS a positive discriminator on its own. The case reports which of the
 * two situations it was in, so a reader knows how much the run proved.
 */

import { sendPrompt } from '../lib/chat.ts'
import type { CdpSession } from '../lib/connect.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import { assertElectronApi, visibleElements } from '../lib/state.ts'
import {
  CARD_FALLBACK_CONFESSIONS,
  CLOUD_PROVIDER_TYPE,
  FALLBACK_REMOTE_MODE_IDS,
  appLogSince,
  composerCapabilities,
  countIn,
  createSessionOn,
  currentWorkspaceId,
  linesContaining,
  openAppLog,
  openSessionInUi,
  requireCloudConnection,
} from '../lib/nestor-cloud.ts'

const ID = 'NCA-3'
const TITLE = 'The remote agent\'s composer modes come from the LIVE agent card, proven by the absence of postInit\'s own fallback confession'

/** The composer footer's mode chip. `FreeFormInput` gives it no testid, so the
 * read is the toolbar button whose text is the active mode's `shortLabel`. */
const TOOLBAR_BUTTON = '.input-toolbar-btn'

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)

  // Opened BEFORE the session exists: `postInit` — and with it the card fetch
  // and any confession — runs at session construction, not at the first turn.
  const log = openAppLog('NCA-3 (postInit\'s fallback confession)')
  run.observe('app log', log)

  const cloud = await requireCloudConnection(session, {
    pinnedSlug: process.env.NESSY_CDP_CLOUD_SLUG,
    purpose: 'NCA-3',
  })
  run.observe('cloud connection', { slug: cloud.slug, baseUrl: cloud.baseUrl ?? '(built-in)' })

  const workspaceId = await currentWorkspaceId(session)
  const key = await createSessionOn(run, session, { workspaceId, slug: cloud.slug, label: 'modes', caseId: ID })
  if (!key) blocked('could not create a session on the remote-agent connection; postInit never ran')
  run.check('the pane followed the new session', await openSessionInUi(session, key), key.sessionId)

  // One trivial turn. Two reasons, both mechanical: it forces the backend to be
  // constructed if creation alone did not, and it puts a `Nestor request id`
  // line in the window so the log read has a positive control of its own.
  const turn = await sendPrompt(session, key, 'Reply with exactly OK and nothing else.', 300_000).catch(() => undefined)
  run.observe('warm-up turn', turn ? `${turn.added.length} messages added` : 'did not complete')

  const caps = await composerCapabilities(session, key.sessionId)
  run.observe('composer capabilities', caps)
  run.require(
    'the session reports the remote agent as its active runtime',
    caps.activeRuntime === CLOUD_PROVIDER_TYPE,
    `activeRuntime=${String(caps.activeRuntime)}`,
  )

  const window = appLogSince(log)
  run.observe('app log bytes read since the case started', window.length)
  const decodes = countIn(window, ['Nestor request id'])['Nestor request id'] ?? 0
  run.observe('decode evidence in the window', decodes)

  // --- the discriminator --------------------------------------------------
  const confessions = countIn(window, CARD_FALLBACK_CONFESSIONS)
  run.observe('postInit fallback confessions', confessions)
  const confessed = CARD_FALLBACK_CONFESSIONS.filter(line => (confessions[line] ?? 0) > 0)
  for (const line of CARD_FALLBACK_CONFESSIONS) {
    const count = confessions[line] ?? 0
    run.check(
      `postInit did not fall back: no "${line}"`,
      count === 0,
      count === 0 ? '0' : `${count} — ${linesContaining(window, line).join(' ⏎ ')}`,
    )
  }

  // --- the mode catalog ----------------------------------------------------
  const remoteIds = caps.modeOptions.map(option => option.remoteModeId).filter((id): id is string => Boolean(id))
  run.observe('remote mode ids the composer carries', remoteIds)
  run.check(
    'the composer carries at least one remote mode option',
    caps.modeOptions.length > 0,
    `${caps.modeOptions.length} options`,
  )
  run.check(
    'every mode option names the remote mode it maps to',
    caps.modeOptions.length > 0 && caps.modeOptions.every(option => Boolean(option.remoteModeId)),
    JSON.stringify(caps.modeOptions.map(o => ({ mode: o.mode, remoteModeId: o.remoteModeId }))),
  )

  const beyondFallback = remoteIds.filter(id => !FALLBACK_REMOTE_MODE_IDS.includes(id as 'plan' | 'act'))
  const identicalToFallback = beyondFallback.length === 0
    && FALLBACK_REMOTE_MODE_IDS.every(id => remoteIds.includes(id))
    && remoteIds.length === FALLBACK_REMOTE_MODE_IDS.length
  run.observe('discrimination', identicalToFallback
    ? 'the card names exactly plan+act, so the mode list alone cannot distinguish card from fallback — the log is the only discriminator on this run'
    : `the card names ${JSON.stringify(remoteIds)}, which the static fallback cannot produce`)

  // --- the chips on screen -------------------------------------------------
  const buttons = await visibleElements(session, TOOLBAR_BUTTON)
  const buttonTexts = buttons.map(b => b.text)
  run.observe('composer toolbar buttons', buttonTexts)
  const shortLabels = caps.modeOptions
    .map(option => option.shortLabel ?? option.label)
    .filter((label): label is string => Boolean(label))
  const chipRendered = shortLabels.some(label => buttonTexts.some(text => text.includes(label)))
  run.check(
    'the composer renders a chip carrying one of the mode labels the backend supplied',
    chipRendered,
    `labels ${JSON.stringify(shortLabels)} vs buttons ${JSON.stringify(buttonTexts)}`,
  )

  // --- the honest verdict --------------------------------------------------
  // Everything above is scored. The BLOCK below is reached only when the run
  // could not DISTINGUISH the two worlds, and it is deliberately last: a check
  // that already failed makes the case FAIL, not BLOCKED (`report.ts`), so a
  // real confession is never laundered into "could not run".
  if (decodes === 0 && confessed.length === 0) {
    blocked(
      `the log window carries neither a decode ("Nestor request id") nor a fallback confession, so the absence of a `
      + `confession is not evidence. Either the app is not writing to ${log.path} (a PACKAGED build never does), or `
      + 'this session\'s postInit is not in the window. Relaunch with `nohup bun run electron:dev > /tmp/app.log '
      + '2>&1 & disown` and re-run.',
    )
  }
}

if (import.meta.main) {
  await main(ID, TITLE, drive)
}

export const meta = { id: ID, title: TITLE }
