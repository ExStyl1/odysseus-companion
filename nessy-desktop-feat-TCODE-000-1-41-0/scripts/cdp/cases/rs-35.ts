/**
 * RS-35 (rows C3.37 + C3.38) — the two sentences an ADMINISTRATOR writes and a
 * user reads, driven on a packaged build.
 *
 * P6.245 landed both carriers and neither had ever been seen on screen. The
 * owner's named exception inside option A says why a commit is not enough here:
 * *"for a string whose whole point is a surface a human reads, the commit proves
 * only that it is carried."*
 *
 * | row | key | where the user meets it | reader |
 * | --- | --- | --- | --- |
 * | C3.37 | `pluginTrustMessage` | the install-scope confirmation, before anything is installed | `PluginsPage.tsx` `managedTrustMessage` off the marketplace list's LAST page |
 * | C3.38 | `companyAnnouncements` | the session's own notice channel, once per session | `SessionManager` `announceCompanyAnnouncement` |
 *
 * ## Why this needs no model and no card
 *
 * The trust sentence rides the marketplace LIST result — `managedPluginTrustMessage()`
 * resolves it per list from the enforced managed composition — so it is on
 * screen before any install begins. The announcement is emitted inside
 * `sendMessage` **before the model-streaming work starts**, on the same call
 * that pushes the user message; a turn that then fails at the gateway has
 * already carried it. Measured: on the rig this was written for, `pi-api-key`
 * answered `auth-request` for every turn and the announcement arrived anyway.
 * The case records WHICH card the session was on rather than choosing one.
 *
 * ## The policy is a FIXTURE's write, never this case's
 *
 * `scripts/cdp/README.md`: a case never installs managed policy. The delivered
 * document is written by `fixtures/agent-surfaces.ts --trust-message … --announce …`,
 * which is the one reviewable place for the config-dir surfaces, and it goes
 * into a config dir the lane created. Neither key is in any of
 * `classifyManagedApproval`'s three categories (shell, sandbox, env), so the
 * payload applies straight from the cache with no approval and no root — which
 * is what makes a one-relaunch sitting possible at all.
 *
 * ## Two sittings, because a cache is read at startup
 *
 * Sitting 1 is the policy in force, with the sentences exported so the case can
 * assert them VERBATIM rather than assert that *something* appeared. Sitting 2
 * is the CONTROL — remove the file, RELAUNCH, run with
 * `NESSY_CDP_POLICY_WITHDRAWN=1` — and it is the arm that separates *"the
 * administrator's sentence is being shown"* from *"this dialog always says
 * something"*. Both are required before either row may be re-stamped; the case
 * refuses to guess the control from the same process, because the managed
 * composition is resolved once per process from a file read at startup.
 */
import { attach } from '../lib/connect.ts'
import { pressKey } from '../lib/keys.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import { freshSession, selectorCount, transcript } from '../lib/state.ts'
import { sendPrompt } from '../lib/chat.ts'
import { clickSelector } from '../lib/viewport.ts'
import type { CaseMeta } from '../lib/sitting.ts'
import type { CdpSession } from '../lib/connect.ts'
import { checkAbsence, positive } from '../lib/turn-evidence.ts'

const ID = 'RS-35'
const TITLE = 'The administrator\'s plugin-trust sentence and the organization\'s startup announcement, on screen'

export const meta = {
  id: ID,
  title: TITLE,
  row: 'C3.37',
  // Both surfaces are the HOST's — P6.245 renders them itself, on all three
  // runtimes, because the vendored CLI renders them in an interactive UI this
  // fork never shows. So the answer is per runtime only in the sense that it
  // must be the same on all three, which is what this case records.
  runtimes: ['pi', 'claude', 'codex'],
  credentials: 'none — the announcement is emitted before the model is called and the trust sentence rides the marketplace listing; a card that cannot answer a turn still produces both',
} as const satisfies CaseMeta

const INSTALL_BUTTON = '[data-testid="marketplace-card-install"]'
const SCOPE_DIALOG = '[data-testid="install-scope-dialog"]'

interface ListReading { total: number; items: number; trust: string | null }

async function marketplaceTrust(session: CdpSession, kind: string): Promise<ListReading> {
  return session.call<ListReading>(`
    const r = await window.electronAPI.marketplace.list({ kind: ${JSON.stringify(kind)}, page: 1, pageSize: 20 })
    return { total: r.total ?? 0, items: (r.items ?? []).length, trust: r.pluginTrustMessage ?? null }
  `)
}

async function waitForSelector(session: CdpSession, selector: string, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if ((await selectorCount(session, selector)) > 0) return true
    if (Date.now() >= deadline) return false
    await Bun.sleep(250)
  }
}

/**
 * How many times each announcement is on screen, read from the PANE.
 *
 * ## The detector this case got wrong first, and what the correction is worth
 *
 * The obvious read is `getSessionMessages`, the surface `README.md`'s own table
 * names for "transcript, roles, info messages". It scores ZERO here, and the
 * first run of this case therefore reported the announcement as never shown —
 * four FAILs against a feature that works. Measured 2026-09-12 on the packaged
 * build: with the token on screen (`document.body.innerText.includes(token)` is
 * `true` while the turn runs), the same session's `getSessionMessages` returns
 * `user`, one adapter `info` row and two `assistant` rows, and no announcement.
 *
 * So `sendEvent({ type: 'info' })` from `SessionManager` is a LIVE event the
 * pane renders and the transcript does not keep, while an `info` row an agent
 * adapter emits (`claude-webfetch-preflight-disabled`) is persisted — two rows
 * that look identical to a user and are different objects underneath. The
 * transcript is still read, as an observation, precisely so the divergence is on
 * the record rather than rediscovered.
 */
async function announcementSightings(session: CdpSession, announcements: string[]): Promise<number[]> {
  return session.call<number[]>(`
    const text = document.body.innerText || ''
    return ${JSON.stringify(announcements)}.map(entry => text.split(entry).length - 1)
  `)
}

/** Wait for any of the announcements to appear in the pane. */
async function waitForAnnouncement(session: CdpSession, announcements: string[], timeoutMs = 45_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if ((await announcementSightings(session, announcements)).some(n => n > 0)) return true
    if (Date.now() >= deadline) return false
    await Bun.sleep(500)
  }
}

/** Every `info` line the TRANSCRIPT kept — recorded, never asserted on (above). */
async function infoLines(session: CdpSession, key: { workspaceId: string; sessionId: string }): Promise<string[]> {
  const messages = await transcript(session, key)
  return messages.filter(m => m.role === 'info').map(m => String(m.content ?? ''))
}

/**
 * Send one prompt and do not care whether the model answers.
 *
 * The announcement is emitted before the model call, so an `auth-request` is as
 * good a carrier as an assistant message — and on the rig this was written for
 * it was the only one available on the default card. The turn's own outcome is
 * recorded rather than asserted.
 */
async function sendAndIgnoreOutcome(session: CdpSession, key: { workspaceId: string; sessionId: string }): Promise<string> {
  try {
    await sendPrompt(session, key, 'Say OK.', 90_000)
    return 'turn-completed'
  } catch (error) {
    return `turn-did-not-complete: ${String((error as Error).message).slice(0, 120)}`
  }
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  const withdrawn = process.env.NESSY_CDP_POLICY_WITHDRAWN === '1'
  const expectedTrust = process.env.NESSY_CDP_TRUST_MESSAGE?.trim() ?? ''
  const expectedAnnouncements = (process.env.NESSY_CDP_ANNOUNCEMENTS ?? '')
    .split('|').map(entry => entry.trim()).filter(Boolean)

  if (!withdrawn && (expectedTrust.length === 0 || expectedAnnouncements.length === 0)) {
    blocked(
      'RS-35 needs the delivered managed policy and the two sentences to match against. Write it with '
      + '`bun run scripts/cdp/fixtures/agent-surfaces.ts --trust-message "<sentence>" --announce "<first>" "<second>"` '
      + 'against the config dir the app was launched with, RELAUNCH the app (the cache is read at startup), then export '
      + 'NESSY_CDP_TRUST_MESSAGE and NESSY_CDP_ANNOUNCEMENTS (pipe-separated, in the order given). '
      + 'For the control sitting remove the file, relaunch, and set NESSY_CDP_POLICY_WITHDRAWN=1 instead.',
    )
  }
  run.observe('arm', withdrawn ? 'CONTROL — the policy has been withdrawn and the app relaunched' : 'the policy is in force')

  // ---- C3.37, half 1: does the sentence reach the renderer at all? --------
  const plugins = await marketplaceTrust(session, 'plugins')
  const skills = await marketplaceTrust(session, 'skills')
  run.observe('marketplace.list(plugins)', plugins)
  run.observe('marketplace.list(skills)', skills)
  // The anti-vacuum control for the whole trust arm: a listing with no rows
  // would make "no Install button" indistinguishable from "no trust message".
  run.require(
    'the marketplace has rows to install at all',
    plugins.items > 0 || skills.items > 0,
    `plugins=${plugins.items} skills=${skills.items}`,
  )
  if (withdrawn) {
    run.check(
      'CONTROL: with no policy the listing carries NO trust sentence',
      plugins.trust === null && skills.trust === null,
      `plugins=${JSON.stringify(plugins.trust)} skills=${JSON.stringify(skills.trust)}`,
    )
  } else {
    run.check(
      'the listing carries the administrator\'s sentence VERBATIM',
      plugins.trust === expectedTrust,
      `got ${JSON.stringify(plugins.trust)} want ${JSON.stringify(expectedTrust)}`,
    )
  }

  // ---- C3.37, half 2: the confirmation a human actually meets -------------
  await session.call<null>(`
    window.dispatchEvent(new CustomEvent('nessy-agent-navigate', { detail: { route: 'plugins' }, bubbles: true }))
    return null
  `)
  const haveRows = await waitForSelector(session, INSTALL_BUTTON)
  run.require('the marketplace rendered at least one Install affordance', haveRows, INSTALL_BUTTON)
  await clickSelector(session, INSTALL_BUTTON)
  const dialogUp = await waitForSelector(session, SCOPE_DIALOG)
  run.require('the install-scope confirmation opened', dialogUp, SCOPE_DIALOG)

  const dialogText = await session.call<string>(`
    const d = document.querySelector(${JSON.stringify(SCOPE_DIALOG)})
    return d ? (d.innerText || '') : ''
  `)
  run.observe('install-scope dialog text', dialogText.replace(/\n+/g, ' | ').slice(0, 400))
  if (withdrawn) {
    run.check(
      'CONTROL: the confirmation is the unchanged one — no managed notice',
      !/managed|organization|organisation/i.test(dialogText),
      dialogText.slice(0, 200),
    )
  } else {
    run.check(
      'C3.37 — the administrator\'s sentence is on the confirmation, VERBATIM',
      dialogText.includes(expectedTrust),
      `dialog=${JSON.stringify(dialogText.slice(0, 300))}`,
    )
  }
  // Out by the shipped route, and NOTHING is installed: this case confirms a
  // dialog, it does not accept it.
  await pressKey(session, 'Escape')
  await Bun.sleep(500)
  run.check('the confirmation was dismissed without installing', (await selectorCount(session, SCOPE_DIALOG)) === 0)

  // ---- C3.38: the announcement, once per session --------------------------
  const first = await freshSession(session, `CDP ${ID} a`)
  run.require('a fresh session for the first announcement', first.fresh, JSON.stringify(first))
  // WHICH card answered is recorded rather than chosen — the two surfaces are
  // the host's and must read the same on every runtime, so a case that picked
  // one would be reporting about that one.
  run.observe('the default card this session is on', await session.call<string>(`
    const rows = await window.electronAPI.listLlmConnections()
    return String((rows[0] && rows[0].slug) ?? 'unknown')
  `).catch(() => 'unknown'))

  const probe = withdrawn ? ['R5-ANNOUNCE', 'CDP-ANNOUNCE'] : expectedAnnouncements
  const sendFirst = sendAndIgnoreOutcome(session, first)
  const appeared = await waitForAnnouncement(session, probe)
  const firstOutcome = await sendFirst
  run.observe('first session, turn outcome', firstOutcome)
  const firstCounts = await announcementSightings(session, probe)
  run.observe('first session, sightings in the pane', firstCounts)
  run.observe('first session, info rows the TRANSCRIPT kept', (await infoLines(session, first)).map(l => l.slice(0, 90)))

  if (withdrawn) {
    // F1.504 — nothing in the pane after a turn that never ran is no control.
    checkAbsence(
      run,
      'CONTROL: with no policy nothing of the kind reaches the pane',
      !appeared && firstCounts.every(n => n === 0),
      positive(firstOutcome === 'turn-completed', 'completed turn in the session', firstOutcome),
      `sightings=${JSON.stringify(firstCounts)}`,
    )
    return
  }

  run.check(
    'C3.38 — the announcement reaches the pane',
    appeared,
    `sightings=${JSON.stringify(firstCounts)} of ${JSON.stringify(expectedAnnouncements)}`,
  )
  // The page's rule, and the reason the fixture takes a LIST: "on a person's
  // very first launch it shows the first entry". The nearest observable of a
  // first launch this process has is that it has announced to nobody yet, so
  // the FIRST session after a relaunch must get entry 0 and not a draw.
  run.check(
    'the FIRST session after the relaunch gets the FIRST entry, not a draw',
    firstCounts[0]! > 0 && firstCounts.slice(1).every(n => n === 0),
    `sightings=${JSON.stringify(firstCounts)}`,
  )
  run.check(
    'it is VERBATIM — the administrator\'s sentence with no host frame around it',
    await session.call<boolean>(`return (document.body.innerText || '').includes(${JSON.stringify(expectedAnnouncements[0])})`),
    JSON.stringify(expectedAnnouncements[0]),
  )

  // Once per SESSION, not once per turn.
  const secondOutcome = await sendAndIgnoreOutcome(session, first)
  run.observe('first session, second turn outcome', secondOutcome)
  const afterSecondTurn = await announcementSightings(session, expectedAnnouncements)
  // F1.504 — "nothing more" is a reading only about a second turn that RAN.
  checkAbsence(
    run,
    'once per SESSION — a second turn in the same session announces nothing more',
    afterSecondTurn.reduce((a, b) => a + b, 0) === 1,
    positive(secondOutcome === 'turn-completed', 'completed second turn in the same session', secondOutcome),
    `sightings=${JSON.stringify(afterSecondTurn)}`,
  )

  const second = await freshSession(session, `CDP ${ID} b`)
  run.require('a second fresh session', second.fresh, JSON.stringify(second))
  const sendSecond = sendAndIgnoreOutcome(session, second)
  const secondAppeared = await waitForAnnouncement(session, expectedAnnouncements)
  run.observe('second session, turn outcome', await sendSecond)
  const secondCounts = await announcementSightings(session, expectedAnnouncements)
  run.observe('second session, sightings in the pane', secondCounts)
  run.check(
    'a SECOND session draws exactly ONE entry from the list',
    secondAppeared && secondCounts.reduce((a, b) => a + b, 0) === 1,
    `sightings=${JSON.stringify(secondCounts)}`,
  )

  // Is it a RECORD or a flash? Re-select the first session and look again. This
  // is recorded as observations, never asserted — a check that passed whatever
  // happened measured nothing (F1.522) — and nothing in
  // `settings-reference.md#companyannouncements` says an announcement must
  // survive leaving the session; the answer is what a user who scrolls back
  // would meet.
  // By the SIDEBAR ROW, not by a navigate event. `freshSession`'s own docblock
  // records why: after a route change the sidebar row updates while the content
  // pane keeps showing the previous session, and the remedy is to click the row.
  // A first draft used `route: 'session/<id>'` and the pane never moved — the
  // reading below caught it, which is the whole reason it is there.
  await clickSelector(session, `.session-item[data-session-id="${first.sessionId}"]`).catch(() => undefined)
  await Bun.sleep(1500)
  const afterReselect = await announcementSightings(session, expectedAnnouncements)
  // WHICH session the pane is showing is read rather than assumed: a navigate
  // that did not take would make the sightings below a second reading of the
  // session we were already on, and the conclusion would be the opposite of
  // what the numbers say. The first draft of this arm did exactly that.
  const shown = await session.call<string>(`
    const row = document.querySelector('.session-item[data-selected]')
    return String(row ? row.getAttribute('data-session-id') : 'unknown')
  `)
  run.observe('after re-selecting the first session', { selected: shown, expected: first.sessionId, sightings: afterReselect })
  // Recorded, not asserted: this arm answers a question no page asks, so a rig
  // that could not re-select the session makes the reading INCONCLUSIVE rather
  // than makes the product wrong. The distinction is the observation below.
  run.observe('the pane re-selected the first session', shown === first.sessionId)
  run.observe(
    'the announcement after leaving and re-entering the session — recorded either way',
    shown !== first.sessionId
      ? 'INCONCLUSIVE: the pane was showing a different session'
      : afterReselect[0]! > 0
        ? 'it survives: the pane still carries the first session\'s entry'
        : 'it is GONE: the pane rendered it live and the transcript did not keep it, so a user who leaves the session never sees it again',
  )
}

if (import.meta.main) await main(ID, TITLE, drive)
