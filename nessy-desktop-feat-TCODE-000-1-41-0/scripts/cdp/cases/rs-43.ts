/**
 * RS-43 (DA2.11) — the app's own `sessions:command` reply ceiling, on the
 * packaged build, while an operator proxy refuses the app's own auth hosts.
 *
 * ## The reading this exists to re-take
 *
 * Rig day 2026-09-12, lane R2, packaged 1.37.0: with a proxy refusing everything
 * but the gateway host, a run died on `Request timeout: sessions:command
 * (30000ms)` — the app's own IPC ceiling — and the proxy's log named
 * `as.tbank.ru` six times and `devplatform.tcsbank.ru` three times inside the
 * same window, all refused. That is the app's own sign-in infrastructure, being
 * retried while the main process could not answer a UI command. The user meets
 * it as a session command that fails rather than as a network refusal.
 *
 * The prescribed remedy — exempt those hosts from the proxy — is REFUTED
 * (`packages/shared/src/config/network-proxy-utils.ts` symbol `shouldBypassProxy`
 * carries the refusal and its three reasons): on a corporate network the proxy is
 * frequently the only route to a remote host, so exempting our own hosts makes
 * the app unreachable for exactly the deployment that configured a proxy because
 * it needs one. What is left is a LATENCY defect with an unlocated contributor,
 * and this case is the instrument for locating it rather than guessing at a
 * timeout.
 *
 * ## What it measures, and why it measures it in the RENDERER
 *
 * Each command is timed inside the page, around
 * `window.electronAPI.sessionCommand`, and its rejection is caught and returned
 * rather than thrown. So the number is the one the UI itself waits for, and a
 * command that hits the ceiling is DATA — the string `Request timeout:
 * sessions:command (30000ms)` — instead of an exception that ends the run before
 * the rest of the sequence has been measured. Timing from the harness would add
 * the CDP round trip to every reading and would measure the rig.
 *
 * `getSessions` is timed beside them as the DISCRIMINATOR: it rides the same
 * transport and the same main process, so a slow `sessions:command` next to a
 * fast `getSessions` is a slow HANDLER, and both slow together is a starved
 * transport. Without it every verdict here would be equally true of a machine
 * under load — which is not a hypothetical: `lib/runtime-switch.ts` symbol
 * `boundCard` already carries a note that this reply can time out under load
 * alone, so LOAD is quoted beside every number this case produces.
 *
 * ## The detector is the PROXY'S OWN LOG
 *
 * One JSONL line per refusal, written by `fixtures/refusing-proxy.ts` — a source
 * neither the app nor the model can touch. The case slices it to each command's
 * own window, so the answer is not "the app was slow" but "the app was slow
 * while it was being refused THESE hosts". An empty slice beside a slow command
 * is just as much a reading: it says the contributor is not egress at all.
 *
 * ## The positive control, run FIRST
 *
 * `curl` to a public host through the same proxy from this case's own process:
 * it must be refused AND leave a line in the log. Without it, every empty slice
 * below is equally true of a proxy that is not running, a log path nobody
 * writes, and a rig that was never wired up — and the case BLOCKS rather than
 * scoring a silence.
 *
 * ## The other arm is a SECOND RUN, not a branch — and it ALTERNATES
 *
 * A timing claim needs a control run on unmodified code at the same moment
 * (AGENTS.md §Traps), and on this rig one pair is not enough: the first proxied
 * run of the turn arm took 431 s and the unproxied run that FOLLOWED it on the
 * same profile took 58 s, which reads as a 7x proxy cost and is not one — the
 * second run was also the warmer. Driven as alternating arms (proxied,
 * unproxied, proxied, unproxied) on one profile, the same turn costs seconds in
 * both. So the sitting runs A, B, A, B and compares ADJACENT arms. The case
 * records which arm it is in from the APP's own settings rather than from a
 * flag, so two runs cannot be mixed up after the fact.
 *
 * ## The RE-MINT arm (DA2.19), which the 1.38.0 sitting could only record as a NULL
 *
 * Everything above was measured on a machine whose `~/.nessy/dp_auth_creds.json`
 * already held a usable JWT, so nothing ever re-minted, so `dp` never ran, so a
 * proxy refusing `dp`'s hosts cost nothing — which is a legitimate reading and
 * is NOT the condition R2 met. Reaching the other condition needs the creds
 * store pointed somewhere empty, and the only way to do that without editing the
 * owner's own file is `NESSY_HOME` (DA1.5). It is absent from the 1.38.0
 * artefact (0 occurrences over `Contents/Resources/app`, control
 * `NESSY_CONFIG_DIR` 43) and present in the 1.39.0 one (20 against the same
 * control), which is why the arm is here and was a null there.
 *
 * Under `NESSY_CDP_RS43_REMINT=1` the case does three things it does not
 * otherwise do: it establishes WHICH re-mint outcome this rig is in; it drives
 * the turn arm unconditionally; and it reads the session's own `auth-request`
 * rows for the dp card DA1.4 raises, with the `DpAuthError` code it carries. The
 * card and the turn are SEPARATE questions — the target scheme (owner
 * 2026-09-12, option A) says no turn waits on the dp CLI session, so a hung turn
 * is the defect even when the card arrives, and a finished turn with no card is a
 * reading rather than a failure.
 *
 * **Establishing the outcome takes TWO readings, and the obvious one alone gets
 * it wrong — measured 2026-09-17 on the first drive of this arm.** The doctor
 * prints a reason CODE and no path, and on a rig where the app has already
 * re-minted into the relocated directory it says `ok` — which is byte for byte
 * what it says when `NESSY_HOME` was ignored. The first version of this guard
 * read only that and BLOCKED a run whose whole point had already happened: the
 * app wrote a fresh credential into the empty directory within six seconds of
 * launch. So the second reading is the relocated file's own EXISTENCE and mtime,
 * never a byte of its content — the rig creates that directory empty seconds
 * before launch and `packages/shared/src/auth/dp` is the only writer of that
 * file in the ecosystem, so a file there is the app's own re-mint and nothing
 * else. The case BLOCKS only when BOTH readings say this is an ordinary
 * signed-in profile.
 *
 * **And on that arm the ABSENT card is the answer, not a missing precondition
 * (D1.340, born from SIT-5d's first drive of it).** The seed step `require`d
 * *"the app lists at least one connection"*, which a CORRECT build cannot
 * satisfy here: the store is pointed at an empty directory on purpose, so the
 * one-click card needs a sign-in, and the rig proxy is refusing exactly the
 * hosts that sign-in uses. SIT-5d's run therefore read PASS on DA2.19 and FAIL
 * on the case in the same minute, which files the row's answer as a broken rig.
 * It is now a scored CHECK guarded by three conditions — the re-mint arm, a
 * configured proxy log the `curl` control has proven readable, and at least one
 * refusal inside the seeding window — and the `require` still fires without
 * them, because a proxy that is not running, an app that never egressed and a
 * click that missed the button all produce the same empty card list.
 *
 * ## Runtimes
 *
 * The ceiling is the HOST's, not a runtime's: `sessions:command` is one channel
 * for all three, and the sign-in infrastructure being refused is the same on
 * each. All three are declared because the answer covers all three, not because
 * the case drives three cards.
 *
 * ## Why RS-43 and not RS-39, which this case was born as
 *
 * RS-39 was already claimed. `docs/testing/cdp-live-checklist.md` has carried a
 * row for it since 2026-09-13 (born from wave A's WA-b, DA1.17 option B: whether
 * `/quota` on the two non-Pi gateway cards NAMES the budget it cannot show), with
 * its File column reading `— (case owed)`. A checklist row with no case file and
 * a case file with no checklist row are invisible to each other, and the harness
 * guard that enumerates the sitting cases checked the PLAN for the row id and not
 * the CHECKLIST for the case id — so nothing failed, and two different sittings
 * would have reported under one id. Found 2026-09-17 while writing the checklist
 * hand-back; `harness.test.ts` now carries the guard that makes it fail instead
 * (38 of 39 cases were already correct, which is why the guard is safe to
 * require). RS-40, RS-41 and RS-42 are claimed by the same wave, so this is 43.
 *
 * ## Safety
 *
 * A fresh `NESSY_CONFIG_DIR`, the lane's own proxy on `127.0.0.1` which forwards
 * nothing, and a public probe host. Nothing here reads, prints or writes a
 * credential: the one-click card's sign-in is the app's own `dp` module reading
 * its own file, and this case never touches it.
 */

import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { sendPrompt } from '../lib/chat.ts'
import type { CdpSession } from '../lib/connect.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import { listConnections, trustScratchProject, type ConnectionRow } from '../lib/runtime-switch.ts'
import { assertElectronApi, freshSession, listSessions } from '../lib/state.ts'
import { clickAt } from '../lib/viewport.ts'
import type { CaseMeta, SittingRecipe } from '../lib/sitting.ts'
import { checkAbsence, positive } from '../lib/turn-evidence.ts'

const ID = 'RS-43'
const TITLE = 'the app’s own sessions:command reply ceiling while a proxy refuses the app’s own auth hosts'

export const meta = {
  id: ID,
  title: TITLE,
  row: 'DA2.11',
  runtimes: ['pi', 'claude', 'codex'],
  credentials:
    'owner: the machine holds the shared dp sign-in the one-click card uses (`~/.nessy/dp_auth_creds.json`, outside the '
    + 'config dir) — the case never reads, prints or writes it. Launch the PACKAGED build with NESSY_CONFIG_DIR pointing at '
    + 'a directory created for the run, and export NESSY_CDP_PROXY_LOG (and NESSY_CDP_PROXY_URL for the control) for the '
    + 'proxied arm.',
} as const satisfies CaseMeta

/** The app's own IPC reply ceiling — `packages/server-core/src/transport/client.ts`. */
const IPC_CEILING_MS = 30_000

/** Public, unrelated to the product, and never a host the rig exempts. */
const PROBE_HOST = process.env.NESSY_CDP_PROBE_HOST ?? 'example.com'

/** The onboarding button this case may press, matched on the product's own words. */
const ONE_CLICK_LABEL = /pi agent/i
/** The onboarding's LAST button — the shell does not exist until it is pressed. */
const DONE_LABEL = /get started/i

interface ProxyLine { t: string; kind: string; host: string; verdict: string }

/** Every refusal the rig proxy has written so far. */
function proxyLog(path: string): ProxyLine[] {
  try {
    return readFileSync(path, 'utf8').split('\n').filter(Boolean)
      .map(line => { try { return JSON.parse(line) as ProxyLine } catch { return undefined } })
      .filter((line): line is ProxyLine => line !== undefined)
  } catch {
    return []
  }
}

/** The refusals inside one command's own window, counted per host. */
function hostsRefusedBetween(lines: readonly ProxyLine[], fromIso: string, toIso: string): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const line of lines) {
    if (line.t < fromIso || line.t > toIso) continue
    counts[line.host] = (counts[line.host] ?? 0) + 1
  }
  return counts
}

interface ButtonRect { x: number; y: number; text: string }

async function buttonByText(session: CdpSession, pattern: RegExp): Promise<ButtonRect | undefined> {
  return session.call<ButtonRect | undefined>(`
    const wanted = ${pattern.toString()}
    const button = Array.from(document.querySelectorAll('button')).find(el => wanted.test(el.innerText || ''))
    if (!button) return undefined
    const r = button.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) return undefined
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), text: (button.innerText || '').replace(/\\s+/g, ' ').trim() }
  `)
}

interface Timed {
  label: string
  ms: number
  ok: boolean
  error?: string
  hostsRefusedInWindow: Record<string, number>
}

/**
 * One measurement: the command timed in the page, its rejection kept as data,
 * and the proxy's refusals inside its own window.
 */
async function timeCommand(
  session: CdpSession,
  logPath: string | undefined,
  label: string,
  expression: string,
): Promise<Timed> {
  const from = new Date().toISOString()
  const reading = await session.call<{ ms: number; ok: boolean; error?: string }>(`
    const started = performance.now()
    try {
      ${expression}
      return { ms: Math.round(performance.now() - started), ok: true }
    } catch (e) {
      return { ms: Math.round(performance.now() - started), ok: false, error: String((e && e.message) || e) }
    }
  `)
  const to = new Date().toISOString()
  return {
    label,
    ms: reading.ms,
    ok: reading.ok,
    ...(reading.error ? { error: reading.error } : {}),
    hostsRefusedInWindow: logPath ? hostsRefusedBetween(proxyLog(logPath), from, to) : {},
  }
}

/**
 * The app's OWN reading of the shared gateway credential — DA2.19's precondition.
 *
 * Taken out of the packaged process's own config doctor (`GET_CONFIG_DOCTOR`,
 * section *"Nessy Gateway sign-in:"*), never by this case opening the file:
 * the rig sets `NESSY_HOME` at launch, and only the APP can say whether the
 * variable reached it and which path it then resolved. It carries codes,
 * lengths and booleans and no token value by construction
 * (`packages/shared/src/config/config-doctor.ts` symbol `gatewayAuthLines`),
 * which is why it is safe to print in a run narrative.
 *
 * `undefined` means the surface did not answer at all — a build without it, or
 * a collector that could not look — which is a different state from a
 * credential that is absent, and the two are never merged here.
 */
async function gatewaySignInSection(session: CdpSession): Promise<string | undefined> {
  const text = await session.call<string | undefined>(`
    const api = window.electronAPI
    if (!api || typeof api.getConfigDoctorReport !== 'function') return undefined
    const report = await api.getConfigDoctorReport()
    return report && typeof report.text === 'string' ? report.text : undefined
  `).catch(() => undefined)
  if (text === undefined) return undefined
  const section = text.split('\n\n').find(block => block.startsWith('Nessy Gateway sign-in:'))
  return section?.trim()
}

/**
 * The dp sign-in cards this session has been shown, as the SESSION recorded
 * them — `role: 'auth-request'`, `authRequestType: 'dp'`, and the `authError`
 * code DA1.4 attaches when a FORCED re-mint failed.
 *
 * The transcript and not the screen: the card's row is written by
 * `SessionManager.beginAuthRequest` before any renderer paints it, so a run that
 * scrolled past the card, or one driving a hidden window, reads the same answer.
 * Codes only — `authError` is a `DpAuthError` member and never a token.
 */
interface DpCardRow { authRequestType?: string; authStatus?: string; authError?: string; content: string }

async function dpAuthRows(session: CdpSession, sessionId: string): Promise<DpCardRow[]> {
  return session.call<DpCardRow[]>(`
    const s = await window.electronAPI.getSessionMessages(${JSON.stringify(sessionId)})
    return (s?.messages ?? [])
      .filter(m => m.role === 'auth-request')
      .map(m => ({
        authRequestType: m.authRequestType,
        authStatus: m.authStatus,
        authError: m.authError,
        content: typeof m.content === 'string' ? m.content.slice(0, 300) : '',
      }))
  `).catch(() => [])
}

/** The app's own view of whether this run is the proxied arm. */
async function proxyArm(session: CdpSession): Promise<{ enabled: boolean; noProxy?: string } | 'unreadable'> {
  const reading = await session.call<{ enabled?: boolean; noProxy?: string } | null>(`
    const api = window.electronAPI
    if (!api || typeof api.getNetworkProxySettings !== 'function') return null
    const settings = await api.getNetworkProxySettings()
    return settings ? { enabled: settings.enabled === true, noProxy: settings.noProxy } : { enabled: false }
  `).catch(() => null)
  if (reading === null) return 'unreadable'
  return { enabled: reading.enabled === true, ...(reading.noProxy ? { noProxy: reading.noProxy } : {}) }
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)

  const logPath = process.env.NESSY_CDP_PROXY_LOG?.trim()
  const proxyUrl = process.env.NESSY_CDP_PROXY_URL?.trim()

  // ---- the positive control, before anything is scored ---------------------
  if (logPath && proxyUrl) {
    const before = proxyLog(logPath).length
    const curl = Bun.spawnSync(
      ['curl', '-sS', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '20', `https://${PROBE_HOST}`],
      { env: { ...process.env, https_proxy: proxyUrl, HTTPS_PROXY: proxyUrl } },
    )
    const after = proxyLog(logPath)
    run.observe('THE CONTROL — curl through the rig proxy', {
      exitCode: curl.exitCode,
      stdout: curl.stdout.toString().trim(),
      newLogLines: after.length - before,
      lastHost: after.at(-1)?.host,
    })
    run.require(
      'THE CONTROL — the rig proxy refuses the driver’s own curl AND writes it down',
      curl.exitCode !== 0 && after.length > before,
      `curl exit ${curl.exitCode}, ${after.length - before} new log line(s) — a proxy that is not running, a log path `
      + 'nobody writes and a rig that was never wired up all produce the same silence as an app that never egressed',
    )
  } else if (logPath || proxyUrl) {
    blocked(
      'the proxied arm needs BOTH NESSY_CDP_PROXY_LOG (the detector) and NESSY_CDP_PROXY_URL (the control). '
      + 'With neither, this case runs as the UNPROXIED control arm.',
    )
  }

  run.observe('arm', logPath ? 'proxied — the rig proxy refuses everything the app does not exempt' : 'control — no rig proxy')
  run.observe('the app’s own networkProxy setting', await proxyArm(session))

  // ---- WHICH CREDENTIAL STATE these timings were taken under (DA2.19) -------
  //
  // Read in EVERY arm, not only the re-mint one. The 1.38.0 sitting's
  // explanation — "a machine whose creds file already holds a usable JWT never
  // re-mints, so `dp` is never run, so a proxy refusing its hosts costs nothing"
  // — was an inference about the rig rather than a reading of it, because
  // nothing in the run recorded the credential's state. This line is that
  // reading, and it is the app's own.
  const signIn = await gatewaySignInSection(session)
  run.observe('the app’s own Nessy Gateway sign-in section (codes, lengths and booleans only)', signIn ?? 'the surface did not answer')
  const reMintArm = process.env.NESSY_CDP_RS43_REMINT === '1'
  let reMintOutcome = 'not this arm'
  if (reMintArm) {
    // The rig claims it launched the app with NESSY_HOME at a directory holding
    // no JWT. Only the APP can confirm the variable reached it, so the claim is
    // CHECKED rather than trusted — a rig whose NESSY_HOME never arrived would
    // otherwise measure the ordinary signed-in path and report it under this
    // arm's name.
    //
    // TWO readings, because one of them cannot tell the two outcomes apart.
    // The doctor prints a reason code and no PATH, so on a machine where the
    // re-mint already SUCCEEDED it says `ok` — which is byte for byte what it
    // says when the variable was ignored. The second reading is the relocated
    // file's own EXISTENCE (never its content): a `dp_auth_creds.json` under
    // the rig's own directory can only have been written by the app, because
    // this lane created that directory empty seconds earlier and
    // `packages/shared/src/auth/dp` is the only writer in the ecosystem.
    const relocated = process.env.NESSY_CDP_RS43_NESSY_HOME?.trim()
    if (signIn === undefined) {
      blocked(
        'NESSY_CDP_RS43_REMINT=1 was set but the app’s config doctor did not answer, so there is no way to confirm the '
        + 'credential state this arm depends on. On a build carrying DA1.34 the section is "Nessy Gateway sign-in:".',
      )
    }
    if (!relocated) {
      blocked(
        'the re-mint arm needs NESSY_CDP_RS43_NESSY_HOME naming the same ABSOLUTE directory the app was launched with as '
        + 'NESSY_HOME. Without it this case cannot tell a relocation the app honoured from one it never saw, and the '
        + 'doctor cannot help: it prints a reason code and no path.',
      )
    }
    const written = ((): { exists: boolean; mtime?: string } => {
      try { return { exists: true, mtime: statSync(join(relocated, 'dp_auth_creds.json')).mtime.toISOString() } } catch { return { exists: false } }
    })()
    const forcing = /re-mint reason: (no_credentials|credentials_expired|credentials_unparseable|credentials_unreadable)/.test(signIn)
    if (!written.exists && !forcing) {
      blocked(
        'NESSY_HOME did not reach the app: it reports a usable credential and the relocated directory holds no file the '
        + `app wrote (${relocated}). This run would measure the ordinary signed-in path.\n` + signIn
        + '\nRelaunch the packaged build with NESSY_HOME set to an ABSOLUTE path — `creds-store.ts` symbol `getNessyDir` '
        + 'refuses a relative or tilde value — and never edit the owner’s own file to reach this arm.',
      )
    }
    reMintOutcome = written.exists && !forcing
      ? 're-mint REQUIRED and SUCCEEDED before the case attached'
      : 're-mint REQUIRED and has not produced a usable credential'
    run.observe('re-mint arm', {
      relocatedNessyHome: relocated,
      theAppWroteACredentialThere: written.exists,
      itsMtime: written.mtime,
      outcome: reMintOutcome,
      why: 'the directory was created EMPTY by this lane seconds before launch, and `packages/shared/src/auth/dp` is the '
        + 'only writer of this file in the ecosystem — so a file here is the app’s own re-mint, recorded by existence '
        + 'and mtime and never by reading a byte of it',
    })
  }

  // ---- the seed: the product's own onboarding, under whatever proxy is set --
  let rows: ConnectionRow[] = await listConnections(session)
  let refusedWhileSeeding: Record<string, number> = {}
  if (rows.length === 0) {
    const button = await buttonByText(session, ONE_CLICK_LABEL)
    if (!button) {
      blocked(
        'this profile lists no connection and the onboarding screen is not on screen, so there is no product path to a '
        + 'card. Relaunch the PACKAGED build with NESSY_CONFIG_DIR pointing at a directory created for the run.',
      )
    }
    const clickedAt = new Date().toISOString()
    await clickAt(session, { x: button.x, y: button.y }, 'the one-click Pi gateway card')
    const deadline = Date.now() + 90_000
    for (;;) {
      rows = await listConnections(session)
      if (rows.length > 0 || Date.now() >= deadline) break
      await Bun.sleep(1_000)
    }
    refusedWhileSeeding = logPath ? hostsRefusedBetween(proxyLog(logPath), clickedAt, new Date().toISOString()) : {}
    run.observe('the one-click seed', {
      cards: rows.map(row => row.slug),
      hostsRefusedWhileSeeding: refusedWhileSeeding,
    })
  }

  // ---- D1.340: on the proxied re-mint arm, no card IS the answer ------------
  //
  // The `require` below is right for every other arm and wrong for this one.
  // Under `NESSY_CDP_RS43_REMINT=1` the creds store is pointed at an empty
  // directory on purpose, so the one-click card can only exist if the app first
  // signs in — and the rig proxy is refusing exactly the hosts that sign-in
  // needs. A CORRECT build therefore seeds nothing here, and reading that as a
  // failed precondition files DA2.19's answer as a broken rig: SIT-5d measured
  // this arm PASS on the reading and FAIL on the case, in the same run.
  //
  // It is scored, not skipped, and the three conditions are what keep it from
  // excusing a rig that was never wired up:
  //   - the arm is the re-mint one, so the empty store is deliberate;
  //   - a rig proxy is configured AND its own log is the detector, which the
  //     `curl` control above has already proven this process can see;
  //   - the seed window itself recorded at least one refusal — so the app
  //     really tried and really was refused, in its own window.
  // With no refusals in that window the `require` still fires, because a proxy
  // that is not running, an app that never egressed and a click that missed the
  // button produce the same empty card list and must not share a verdict.
  const seedingWasRefused = Object.keys(refusedWhileSeeding).length > 0
  if (rows.length === 0 && reMintArm && logPath && seedingWasRefused) {
    run.check(
      'DA2.19 — the operator’s proxy reached the app’s own sign-in: no card could be seeded, and the refusals are in the '
      + 'proxy’s own log inside the seeding window',
      true,
      'the reading, not a missing precondition (D1.340)',
    )
    run.observe('DA2.19 — the reading this arm exists to take', {
      cardsSeeded: rows.length,
      hostsRefusedWhileSeeding: refusedWhileSeeding,
      reMintOutcome,
      why: 'with NESSY_HOME at an empty directory the one-click card needs a sign-in, and the rig proxy refused it — so '
        + 'the absent card is the app obeying a deny-all operator proxy, which is the subject of DA2.19. The timing '
        + 'table below needs a session and is deliberately not reached; it belongs to DA2.11 and its own arm.',
      control: 'the same artefact with the same NESSY_HOME and NO networkProxy block seeds the card and answers a turn '
        + '— run it in the same minute, it is what separates "the proxy blocked it" from "an empty HOME blocked it"',
    })
    return
  }

  run.require(
    'the app lists at least one connection',
    rows.length > 0,
    'no card was seeded, so there is no session to command — under the proxied arm this is itself the finding, and it '
    + 'belongs in the narrative rather than in a timing table',
  )

  const done = await buttonByText(session, DONE_LABEL)
  if (done) await clickAt(session, { x: done.x, y: done.y }, 'the onboarding’s Get Started button')
  const shellDeadline = Date.now() + 60_000
  for (;;) {
    const stillOnboarding = (await buttonByText(session, DONE_LABEL)) !== undefined
      || (await buttonByText(session, ONE_CLICK_LABEL)) !== undefined
    if (!stillOnboarding || Date.now() >= shellDeadline) {
      run.require(
        'the app left the onboarding screen',
        !stillOnboarding,
        'the onboarding is still on screen 60 s after its last button was pressed — `freshSession()` dispatches its '
        + 'navigate event into a renderer with no shell to hear it and creates nothing',
      )
      break
    }
    await Bun.sleep(1_000)
  }

  const scratch = mkdtempSync(join(realpathSync(tmpdir()), 'nessy-rs43-'))
  run.observe('the minted working directory', scratch)

  const key = await freshSession(session, `CDP ${ID} ${new Date().toISOString().slice(11, 19)}`)
  run.observe('session', { id: key.sessionId, sessions: (await listSessions(session)).length })

  // ---- the sequence ---------------------------------------------------------
  const id = JSON.stringify(key.sessionId)
  const readings: Timed[] = []
  readings.push(await timeCommand(session, logPath, 'getSessions (the discriminator — same transport, no session handler)',
    `await window.electronAPI.getSessions()`))
  readings.push(await timeCommand(session, logPath, 'sessions:command setPermissionMode',
    `await window.electronAPI.sessionCommand(${id}, { type: 'setPermissionMode', mode: 'default' })`))
  readings.push(await timeCommand(session, logPath, 'sessions:command rename',
    `await window.electronAPI.sessionCommand(${id}, { type: 'rename', name: 'CDP RS-43 renamed' })`))
  // A directory the CASE mints, under the OS temp dir — never the repository the
  // harness happens to be run from. Binding a large tree makes the reading the
  // indexer's rather than the proxy's, and it raises the app's own "Trust this
  // project?" modal over a directory nobody named, which then owns the screen
  // and kills the turn arm below with `composer-not-focusable` (measured
  // 2026-09-14, this case's first turn arm).
  readings.push(await timeCommand(session, logPath, 'sessions:command updateWorkingDirectory',
    `await window.electronAPI.sessionCommand(${id}, { type: 'updateWorkingDirectory', dir: ${JSON.stringify(scratch)} })`))
  run.observe('the trust gate for the minted directory', await trustScratchProject(session, scratch).catch(
    (cause: unknown) => (cause instanceof Error ? cause.message : String(cause)),
  ))
  for (const row of rows) {
    readings.push(await timeCommand(session, logPath, `sessions:command switchRuntime → ${row.slug} (${row.providerType})`,
      `await window.electronAPI.sessionCommand(${id}, { type: 'switchRuntime', connectionSlug: ${JSON.stringify(row.slug)} })`))
  }
  // The TURN arm, opt-in. R2 met the ceiling inside RS-33, whose sequence ENDS
  // in a real turn, and a turn is the one step that used to wait on the `dp`
  // CLI session before C3.381 removed that wait. It is behind an env var rather
  // than on by default because it costs a live model call, and because a rig
  // whose gateway host is NOT exempt measures its own exemption instead.
  if (process.env.NESSY_CDP_RS43_TURN === '1' || reMintArm) {
    const turnFrom = new Date().toISOString()
    const turnStarted = Date.now()
    const turn = await sendPrompt(session, key, 'Reply with the single word: ready.', 240_000).catch(
      (cause: unknown) => ({ error: cause instanceof Error ? cause.message : String(cause) }),
    )
    // The turn's OWN duration, because the proxy's cost turned out not to be in
    // `sessions:command` at all: the first paired reading had a proxied run take
    // 431 s against an unproxied 58 s with every command under 5 s. Whether that
    // is the proxy or a cold first turn is only answerable by ALTERNATING arms
    // (AGENTS.md §Traps), and it is unanswerable at all while the number is not
    // recorded.
    run.observe('the turn arm', {
      answered: 'error' in turn ? false : true,
      ms: Date.now() - turnStarted,
      ...('error' in turn ? { error: turn.error } : {}),
      hostsRefusedDuringTheTurn: logPath ? hostsRefusedBetween(proxyLog(logPath), turnFrom, new Date().toISOString()) : {},
    })
    readings.push(await timeCommand(session, logPath, 'sessions:command setPermissionMode (after the turn)',
      `await window.electronAPI.sessionCommand(${id}, { type: 'setPermissionMode', mode: 'default' })`))

    // ---- DA2.19: does the CARD arrive, and does the turn end? ---------------
    //
    // Two separate questions, and the row asks both. The card is the product's
    // answer to a failed re-mint (`SessionManager.beginAuthRequest`, `authError`
    // = the `DpAuthError` code); the turn ENDING is C3.381's clause — under the
    // target scheme no turn waits on the dp CLI session, so a failed re-mint
    // must produce a finished turn plus a card, never a turn that hangs while
    // `dp` is retried against hosts the proxy refuses.
    if (reMintArm) {
      const cards = await dpAuthRows(session, key.sessionId)
      const dpCards = cards.filter(row => row.authRequestType === 'dp')
      run.observe('the dp sign-in cards this session recorded', cards)
      run.observe('the app’s own sign-in section AFTER the turn', await gatewaySignInSection(session) ?? 'the surface did not answer')
      // F1.504 — "did not time out" is also true of a turn that never STARTED
      // (`turn-not-started:`) or was never sent; only a started turn measures it.
      checkAbsence(
        run,
        'THE TURN ENDED — a failed re-mint does not leave the turn waiting on dp',
        'error' in turn ? !/timeout/i.test(String(turn.error)) : true,
        positive(!('error' in turn) || /^wait-timeout/.test(String(turn.error)), 'turn that STARTED',
          'error' in turn ? String(turn.error).slice(0, 200) : 'the turn started and ended'),
        `the turn did not finish: ${'error' in turn ? String(turn.error) : ''} — under the target scheme (owner 2026-09-12, `
        + 'option A) no turn waits on the dp CLI session on any runtime, so a turn that times out here IS the row’s defect',
      )
      // RECORDED, not required. A card is one of two legitimate answers: the
      // other is a turn that simply fails with the gateway's own refusal and no
      // card at all, which is what happens when nothing forces a re-mint. Which
      // one this build gives is the reading DA2.19 asks for, and asserting one
      // of them would turn the measurement into its own expectation.
      run.observe('DA2.19 verdict', dpCards.length > 0
        ? `${dpCards.length} dp sign-in card(s), codes ${JSON.stringify(dpCards.map(row => row.authError ?? 'none'))} — the `
          + 'failed re-mint reached the user as the card carrying the one button that can fix it'
        : 'NO dp sign-in card was recorded on this session — read the turn’s own outcome and the sign-in section above '
          + 'before calling that a defect: a turn that never reached a gateway 401 never enters the auth-retry path at all')
    }
  }

  readings.push(await timeCommand(session, logPath, 'getSessions (the discriminator, again, after the sequence)',
    `await window.electronAPI.getSessions()`))

  run.observe('timings (ms), with the hosts the proxy refused inside each command’s own window', readings)

  const commands = readings.filter(reading => reading.label.startsWith('sessions:command'))
  const slowest = commands.reduce<Timed | undefined>((worst, reading) => (worst && worst.ms >= reading.ms ? worst : reading), undefined)
  const timedOut = commands.filter(reading => !reading.ok && /Request timeout/i.test(reading.error ?? ''))
  const discriminator = readings.filter(reading => reading.label.startsWith('getSessions'))

  run.observe('verdict', {
    slowestCommand: slowest ? { label: slowest.label, ms: slowest.ms, ok: slowest.ok } : undefined,
    ceilingMs: IPC_CEILING_MS,
    timedOutCommands: timedOut.map(reading => reading.label),
    discriminatorMs: discriminator.map(reading => reading.ms),
    hostsRefusedInTheSlowestWindow: slowest?.hostsRefusedInWindow ?? {},
  })

  run.check(
    'every sessions:command answered inside the app’s own 30 s ceiling',
    timedOut.length === 0,
    `${timedOut.length} command(s) hit the ceiling: ${timedOut.map(reading => `${reading.label} (${reading.ms} ms, refused in window: `
      + `${JSON.stringify(reading.hostsRefusedInWindow)})`).join('; ')}`
    + ' — read the discriminator beside it: a slow command next to a fast getSessions is a slow HANDLER, and both slow '
    + 'together is a starved transport rather than this row’s defect',
  )
  // Recorded rather than required: a command well under the ceiling but far
  // above the unproxied arm is the LOCATING reading this row asks for, and it
  // would be invisible if only the ceiling were asserted.
  run.check(
    'no sessions:command spent more than half the ceiling',
    (slowest?.ms ?? 0) < IPC_CEILING_MS / 2,
    slowest ? `${slowest.label} took ${slowest.ms} ms against a ${IPC_CEILING_MS} ms ceiling, with `
      + `${JSON.stringify(slowest.hostsRefusedInWindow)} refused inside its own window` : undefined,
  )

  rmSync(scratch, { recursive: true, force: true })
}

export const manual = {
  steps: [
    '1. Start the lane’s own refusing proxy: bun run scripts/cdp/fixtures/refusing-proxy.ts --port 9331 --log <rig>/proxy.log',
    '2. Create a FRESH config dir and let the APP write its own config.json first — launch once and quit. A config.json the rig writes from nothing blocks startup on the storage dialog (`custom-root-reset-required` in <rig>/config/logs/boot.log, and a packaged build shows that as a renderer that never appears), measured 2026-09-14. THEN merge the app’s own networkProxy into it: enabled true, httpProxy and httpsProxy the proxy’s URL, noProxy the gateway host the cards answer from (code-completion-nestor.tcsbank.ru) — the app adds the loopback hosts itself.',
    '3. Launch the PACKAGED build against that config dir on a port of your own. A dev build runs main and Pi from built bundles and is not the shipped artefact.',
    '4. NESSY_CDP_PROXY_LOG=<rig>/proxy.log NESSY_CDP_PROXY_URL=http://127.0.0.1:9331 bun run scripts/cdp/cases/rs-43.ts',
    '5. The TURN arm, when the rig has a card that can answer: add NESSY_CDP_RS43_TURN=1. R2 met the ceiling inside RS-33, whose sequence ends in a real turn, and the turn is the step that used to wait on the dp CLI session before C3.381 removed that wait.',
    '6. The CONTROL ARM, adjacent in time: repeat on a second fresh config dir with NO networkProxy block and NO proxy variables exported, and compare the two timing tables. Quote uptime beside both.',
    '7. The RE-MINT ARM (DA2.19), on a build carrying NESSY_HOME (DA1.5 — absent from the 1.38.0 artefact, 20 occurrences over Contents/Resources/app of the 1.39.0 one against a NESSY_CONFIG_DIR control of 43): launch the packaged build with NESSY_HOME pointing at an ABSOLUTE, EMPTY directory under the rig, so the creds store resolves a file that does not exist and a re-mint is forced, while the dp binary’s own session is untouched. Export NESSY_CDP_RS43_REMINT=1 AND NESSY_CDP_RS43_NESSY_HOME=<that same directory> to the case — the second is not a convenience, it is the only way the case can tell a relocation the app honoured from one it never saw. Never edit the owner’s own credential file to reach this arm.',
    '7b. The arm has TWO outcomes and the rig chooses which one by what the dp CHILD inherits. With the proxy configured only in the app’s own networkProxy setting, the re-mint SUCCEEDS: `packages/shared/src/auth/dp/internal.ts` symbol `dpExecEnv` spreads the main process’s own environment, which that setting never enters. Export the proxy as HTTPS_PROXY/HTTP_PROXY/ALL_PROXY in the environment the APP is launched with and the dp child inherits it, which is the failing-re-mint arm and the one that raises the card.',
    '8. Stop the proxy and remove the rig directories when the row is answered.',
  ],
  expected: 'a timing table per arm. The row is answered when the proxied arm either reproduces the 30 s ceiling — in which case the hosts refused inside the slow command’s own window NAME the contributor — or does not, in which case the ceiling is recorded as no longer reproducible on this build and the number that replaced it is written down.',
  detector: 'the rig proxy’s own JSONL log, sliced to each command’s window, beside the command’s own duration timed in the RENDERER around window.electronAPI.sessionCommand — never the harness’s round trip, and never the model’s prose.',
  positiveControl: 'curl to a public host through the same proxy from the case’s own process, before anything is scored: it must be refused AND leave a line in the log, because a proxy that is not running produces the same empty slices as an app that never egressed.',
  doNotConflate: 'a COLD first turn and a slow one. The turn arm\u2019s own duration moved 7x between the first proxied run and the unproxied one that followed it on the same profile, and the second was also the WARMER — only alternating arms (proxied, unproxied, proxied, unproxied) separate the two. And a slow sessions:command under LOAD and a slow one under the proxy. `lib/runtime-switch.ts` symbol `boundCard` already records that this reply can time out under load alone, so quote uptime and the unproxied control arm beside every number.',
  safety: 'a fresh NESSY_CONFIG_DIR under the scratchpad, never the owner’s profile; the proxy is the lane’s own on 127.0.0.1 and forwards nothing; no credential is read, printed or written.',
  doneMeans: 'DA2.11 carries a packaged reading: either the remaining contributor named by the hosts refused inside the offending window, or the ceiling recorded as not reproducible on 1.38.0 with the measured replacement number and the control arm beside it. DA2.19 is answered by one run of step 7 on a build carrying NESSY_HOME: the credential state read from the app’s own doctor, the turn’s outcome, and whether a dp sign-in card carrying its reason code arrived — all three, because a card with a hung turn and a finished turn with no card are different answers.',
} as const satisfies SittingRecipe

if (import.meta.main) await main(ID, TITLE, drive)
