/**
 * RS-47 (D1.3) — the playground page inside the PACKAGED artefact: does it ship,
 * can a user reach it, and what would it hold if reached.
 *
 * ## The arm this case exists for
 *
 * D1.3 (source `P2.491`) is 🟨 with one clause owed: *"whether the page is
 * reachable in a packaged build, what it can drive, and whether any state it can
 * reach is the real session's rather than a fixture's"* — and the row says the
 * answer must come from a PACKAGED build, because this plan has recorded the
 * electron dev/packaged gap enough times. `W8-x` answered it from SOURCE on
 * 2026-09-07: the page ships, no measurable route reaches it, and
 * `ensureMockElectronAPI()` installs only `if (!window.electronAPI)`, so in an app
 * window the playground would drive the REAL bridge. Latent, one navigation away.
 *
 * This case takes the same three readings on the artefact itself.
 *
 * ## Three questions, and they are NOT one question
 *
 * 1. **Does it ship?** Read off the `.app` on disk, not off `electron-builder.yml`.
 * 2. **Can a user reach it?** Drive the two routes the source names as guarded —
 *    a window open, and an in-page link — and count the app's own page targets
 *    before and after. The control is that the count is READ correctly: the case
 *    prints it, and a route that did open a window moves it.
 * 3. **If it were reached, what would it hold?** This is the security-shaped half,
 *    and answering it means FORCING a navigation no user route offers. The case
 *    does that deliberately and last, then restores the window.
 *
 * Scoring them together would hide the actual shape of the finding, which is
 * "ships + unreachable + would be live if reached".
 *
 * ## The detector for question 3, and why it is not the key count
 *
 * `ensureMockElectronAPI()` installs a FIXTURE bridge when `window.electronAPI`
 * is absent. Counting keys cannot tell the two apart — a fixture written to look
 * like the bridge has the same shape by construction. The detector is DATA the
 * fixture cannot have: `getSessions()` answering with the id of the session THIS
 * CASE created seconds earlier, in this profile. A mock returns its own canned
 * rows and can never name it.
 *
 * ## Safety
 *
 * The forced navigation is the one destructive step, and it is bounded: it runs
 * last, it only ever READS through the bridge (`getSessions`), and the window is
 * navigated back to the app's own entry afterwards. Nothing is written, no
 * credential is read, and the profile is the rig's own.
 */

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import type { CdpSession } from '../lib/connect.ts'
import { listTargets } from '../lib/connect.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import { assertElectronApi, freshSession } from '../lib/state.ts'
import type { CaseMeta } from '../lib/sitting.ts'

const ID = 'RS-47'
const TITLE = 'the playground page inside the packaged artefact: ships, unreachable, and live if reached'

export const meta = {
  id: ID,
  title: TITLE,
  row: 'D1.3',
  runtimes: ['pi'],
  credentials:
    'none. The case reads the packaged bundle from disk and drives the renderer; the one bridge call it makes is '
    + '`getSessions()`, a read. `NESSY_CDP_APP_ROOT` names the packaged `Contents/Resources/app` when it is not the '
    + 'repo default.',
} as const satisfies CaseMeta

const DEFAULT_APP_ROOT = join(
  '/Users/i.i.gavrikov/Desktop/work/nessy-desktop',
  'release', 'mac-arm64', 'Nessy Desktop.app', 'Contents', 'Resources', 'app',
)

function appRoot(): string {
  return process.env.NESSY_CDP_APP_ROOT?.trim() || DEFAULT_APP_ROOT
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)

  // ---- question 1: does the page ship? ------------------------------------
  const root = appRoot()
  const rendererDir = join(root, 'dist', 'renderer')
  if (!existsSync(rendererDir)) {
    blocked(
      `no packaged renderer at ${rendererDir}. This case reads the ARTEFACT, not the repo — point `
      + 'NESSY_CDP_APP_ROOT at the packaged Contents/Resources/app.',
    )
  }
  const shipped = readdirSync(rendererDir)
  const assets = existsSync(join(rendererDir, 'assets')) ? readdirSync(join(rendererDir, 'assets')) : []
  const playgroundAssets = assets.filter(name => /playground/i.test(name))
  run.observe('what the packaged renderer directory holds', shipped)
  run.observe('its playground-named asset chunks', playgroundAssets)
  run.check(
    'the playground page SHIPS inside the packaged artefact',
    shipped.includes('playground.html'),
    'no playground.html in the packaged renderer — D1.3\'s first clause is refuted on this build and the two '
    + 'questions below are moot',
  )
  run.check(
    'THE CONTROL — the app\'s own entry ships beside it (the read is of a real renderer directory)',
    shipped.includes('index.html'),
    'index.html is missing too, so this is not the renderer directory and the reading above says nothing',
  )
  run.check(
    'and it ships with its OWN code, not only a shell',
    playgroundAssets.length > 0,
    'playground.html ships with no playground-named chunk beside it, so what it would load is worth reading before '
    + 'anything else here is believed',
  )

  // ---- question 2: can a user reach it? -----------------------------------
  const session_ = await freshSession(session, `CDP ${ID} ${new Date().toISOString().slice(11, 19)}`)
  run.check('the case ran in a session it created', session_.fresh, session_.reason ?? '')

  const entryUrl = await session.call<string>('return String(location.href)')
  const playgroundUrl = entryUrl.replace(/[^/]*$/, 'playground.html')
  run.observe('the app window\'s own URL, and the sibling this case is about', { entryUrl, playgroundUrl })

  const targetsBefore = (await listTargets(process.env.NESSY_CDP_PORT)).filter(t => t.type === 'page').length
  const opened = await session.call<string>(`
    try {
      const win = window.open(${JSON.stringify('playground.html')}, '_blank')
      return win ? 'window.open returned a Window' : 'window.open returned null'
    } catch (error) { return 'window.open threw: ' + String(error) }
  `)
  await Bun.sleep(2_500)
  const targetsAfterOpen = (await listTargets(process.env.NESSY_CDP_PORT)).filter(t => t.type === 'page').length
  run.observe('window.open("playground.html")', { opened, targetsBefore, targetsAfterOpen })
  run.check(
    'a window open on the playground creates NO new page target',
    targetsAfterOpen === targetsBefore,
    `page targets went ${targetsBefore} -> ${targetsAfterOpen}: something opened. Read the new target's URL before `
    + 'recording anything — the row\'s whole claim is that no route reaches this page',
  )

  const clicked = await session.call<string>(`
    const a = document.createElement('a')
    a.href = 'playground.html'
    a.textContent = 'cdp probe'
    document.body.appendChild(a)
    const before = String(location.href)
    a.click()
    await new Promise(resolve => setTimeout(resolve, 800))
    const after = String(location.href)
    a.remove()
    return before === after ? 'the anchor click did not navigate' : ('NAVIGATED: ' + after)
  `)
  await Bun.sleep(1_500)
  const targetsAfterClick = (await listTargets(process.env.NESSY_CDP_PORT)).filter(t => t.type === 'page').length
  const hrefAfterClick = await session.call<string>('return String(location.href)')
  run.observe('an in-page anchor to playground.html', { clicked, targetsAfterClick, hrefAfterClick })
  run.check(
    'an in-page link to the playground does not navigate the app window either',
    hrefAfterClick === entryUrl,
    `the app window is now at ${hrefAfterClick}. That IS a route, and D1.3 stops being latent`,
  )

  // ---- question 3: what it would hold, forced ------------------------------
  // THE CONTROL FIRST. "The forced navigation did not move the window" is
  // equally true of a probe that cannot see a navigation at all — `location.assign`
  // is fire-and-forget, the evaluate returns before anything happens, and the
  // read is taken seconds later. So the same call is made against a destination
  // the app must accept (its OWN entry, with a marker query), and the href must
  // move. Without this arm the playground reading below says nothing.
  const controlUrl = `${entryUrl}${entryUrl.includes('?') ? '&' : '?'}cdpNavProbe=${ID}`
  await session.call<string>(`
    location.assign(${JSON.stringify(controlUrl)})
    return 'assigned'
  `).catch(() => 'assign threw')
  await Bun.sleep(5_000)
  const controlWhere = await session.call<string>('return String(location.href)').catch(() => '(unreadable)')
  run.observe('THE CONTROL — the same forced assign, to a destination the app accepts', controlWhere)
  run.check(
    'THE CONTROL — a forced location.assign CAN move this window',
    controlWhere.includes(`cdpNavProbe=${ID}`),
    'the window did not move for a navigation the app has no reason to refuse, so this probe cannot see a navigation '
    + 'and the playground reading below is uninterpretable',
  )

  // Deliberately NOT a route: this is the "one navigation away" clause, and the
  // only way to answer it is to take the navigation the guards deny to a user.
  const forced = await session.call<string>(`
    location.assign(${JSON.stringify('playground.html')})
    return 'assigned'
  `).catch(error => `assign threw: ${String(error)}`)
  await Bun.sleep(5_000)
  const where = await session.call<string>('return String(location.href)').catch(() => '(unreadable)')
  run.observe('FORCED navigation (not a user route)', { forced, where })

  if (!where.includes('playground.html')) {
    run.observe(
      'question 3 — NOT ANSWERED',
      `the forced navigation did not land on the playground (the window is at ${where}), so this run cannot say what `
      + 'the page would hold. That is a stronger reading than the row expects and should be read rather than assumed.',
    )
  } else {
    const bridge = await session.call<{ keys: number; sessionIds: string[]; error?: string }>(`
      try {
        const keys = Object.keys(window.electronAPI ?? {}).length
        const rows = await window.electronAPI.getSessions()
        return { keys, sessionIds: (rows ?? []).map(s => s.id).slice(0, 40) }
      } catch (error) { return { keys: Object.keys(window.electronAPI ?? {}).length, sessionIds: [], error: String(error) } }
    `).catch(() => ({ keys: -1, sessionIds: [] as string[], error: 'the page did not answer' }))
    const knowsThisSession = bridge.sessionIds.includes(session_.sessionId)
    run.observe('what the playground page holds once loaded', {
      electronApiKeys: bridge.keys,
      knowsThisSession,
      sampledSessionIds: bridge.sessionIds.length,
      error: bridge.error,
    })
    run.check(
      'THE SECURITY READING — the loaded playground drives the REAL bridge, not its own fixture',
      knowsThisSession,
      'the page did not name the session this case created seconds ago, so on this build it is holding a fixture '
      + 'rather than the live bridge — which is the BENIGN answer to D1.3 and should be recorded as such, with the '
      + 'key count and the error above',
    )
  }

  // ---- restore -------------------------------------------------------------
  await session.call<string>(`
    location.assign(${JSON.stringify(entryUrl)})
    return 'restored'
  `).catch(() => 'restore threw')
  await Bun.sleep(5_000)
  run.observe('the window after the case restored it', await session.call<string>('return String(location.href)').catch(() => '(unreadable)'))
}

if (import.meta.main) await main(ID, TITLE, drive)
