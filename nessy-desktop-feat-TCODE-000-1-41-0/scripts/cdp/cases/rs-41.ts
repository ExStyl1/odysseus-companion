/**
 * RS-41 (DA1.13) — the three gateway cards keep NO stored credential, and stay
 * selectable anyway. Plus RS-42, its negative control, which rides here.
 *
 * ## The pair this is, and why they are one file
 *
 * DA1.13 stopped the one-click cards snapshotting the shared dp JWT into the
 * credential store, and DELETES any snapshot an older install left behind — at
 * every re-run of the card, which is the migration. The risk it carries is a
 * PAIR, because three presence readers each take a card away when they see no
 * credential: `LIST_WITH_STATUS`'s `isAuthenticated` disables the row in the
 * picker and labels it *"Not authenticated"*, and two more refuse the card
 * elsewhere. So "no snapshot" and "still selectable" have to be read together,
 * in one profile, or each half is true of a build the other half is broken on.
 *
 * RS-42 is the other side of the same rule: `isGatewayBackedConnection` is a
 * STRICT whole-URL predicate, so a BYO endpoint that merely lives on the gateway
 * HOST must keep its own key across a gateway card re-run. The checklist carries
 * it as its own row and its own sitting is this one — it is a control, and a
 * control measured in a different run on a different profile is not a control.
 *
 * ## The detectors, and neither of them is the screen
 *
 * - **`listLlmConnectionsWithStatus()`** — the app's own `isAuthenticated`, the
 *   value `ConnectionRow.tsx` disables a row on. Read per card.
 * - **`getLlmConnectionApiKey(slug)`** — the STORE's own record, masked by the
 *   handler before it leaves the main process (provider prefix + last four), so
 *   a run narrative can quote its presence without quoting a credential. `null`
 *   is "no snapshot"; a masked string is "a key is stored".
 * - **the app's own log line** for the migration: *"Discarded the stored
 *   credential snapshot on gateway connection …"*, written by
 *   `packages/server-core/src/handlers/rpc/llm-connections.ts` only when a
 *   snapshot really was deleted.
 *
 * ## Why the migration arm has to PLANT a snapshot first
 *
 * On a profile created today nothing ever writes one, so re-running a card
 * deletes nothing and logs nothing — and a case that asserted the line on a
 * fresh profile would fail against a build that is working perfectly. The plant
 * is the older install's own shape rather than a poke at the store: the slug is
 * created as an ordinary BYO connection (a key, a non-gateway endpoint), which
 * the handler stores, and the one-click card is then re-run over it, which is
 * exactly what an upgrading user does. The plant is verified through
 * `getLlmConnectionApiKey` before the re-run, so a plant that silently failed
 * cannot look like a migration that worked.
 *
 * ## Safety
 *
 * Every key this case writes is FABRICATED. The one-click cards sign in through
 * the app's own dp module reading its own file, which is the product path; the
 * case never reads, prints or writes that file, and it drives no turn.
 */

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'

import type { CdpSession } from '../lib/connect.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import { assertElectronApi } from '../lib/state.ts'
import { clickAt } from '../lib/viewport.ts'
import type { CaseMeta, SittingRecipe } from '../lib/sitting.ts'

const ID = 'RS-41'
const TITLE = 'the three gateway cards keep no stored credential and stay selectable, with RS-42 as the control'

export const meta = {
  id: ID,
  title: TITLE,
  row: 'DA1.13',
  runtimes: ['pi', 'claude', 'codex'],
  credentials:
    'owner: the machine must already hold the shared dp sign-in the one-click cards use — the case presses the '
    + 'product’s own buttons and never touches the file. Launch the packaged build on a NESSY_CONFIG_DIR created for '
    + 'the run with NESSY_DEBUG=1, capture its output, and hand the path to the case as NESSY_CDP_APP_LOG: the '
    + 'migration line is the only source that says a snapshot was deleted.',
} as const satisfies CaseMeta

/** The three one-click GATEWAY cards, by the product's own button copy. */
const GATEWAY_CARDS = [
  { label: /Pi agent/i, slug: 'pi-api-key' },
  { label: /Codex agent/i, slug: 'codex-gateway' },
  { label: /Claude Code agent/i, slug: 'claude-gateway' },
] as const

/** RS-42's card: the gateway HOST on a path that is not a gateway endpoint. */
const BYO_SLUG = 'pi-api-key-3'
const BYO_URL = 'https://code-completion-nestor.tcsbank.ru/api/v1/cli/other/v1'
/** The plant's endpoint — somewhere the strict predicate cannot call gateway-backed. */
const PLANT_URL = 'https://cdp-rs41.invalid/v1'
/** The gateway's own base URL, spelled by hand — what `buildGatewaySetup` sends. */
const GATEWAY_URL = 'https://code-completion-nestor.tcsbank.ru/api/v1/cli/openai-like/v1'
const MODELS = ['tgpt/deepseek-v4-flash-0731', 'tgpt/qwen36-35b-a3b-fp8']
/** The migration's own sentence, matched on its stable head. */
const DISCARD_LINE = /Discarded the stored credential snapshot on gateway connection "([^"]+)"/g
/**
 * The SIBLING line, and the control for the one above.
 *
 * `Saved API key to LLM connection` is written by the same
 * `deps.platform.logger?.info` in the same handler, on the branch the PLANT
 * takes. So if the discard line is missing and this one is too, the silence
 * belongs to that logger and not to the migration — which is a different
 * finding, and the only one of the two that a case can tell apart.
 */
const SAVED_KEY_LINE = /Saved API key to LLM connection/g

function fakeKey(): string {
  return `sk-cdp-${randomUUID().replace(/-/g, '')}`
}

/** Every slug the app has reported discarding a snapshot for, in order. */
function discarded(logPath: string): string[] {
  try {
    return [...readFileSync(logPath, 'utf8').matchAll(DISCARD_LINE)].map(match => match[1] ?? '')
  } catch {
    return []
  }
}

/** How many times the handler's SIBLING info line has been written. */
function savedKeyLines(logPath: string): number {
  try {
    return [...readFileSync(logPath, 'utf8').matchAll(SAVED_KEY_LINE)].length
  } catch {
    return 0
  }
}

interface StatusRow { slug: string; name?: string; providerType: string; baseUrl?: string; isAuthenticated?: boolean }

async function statuses(session: CdpSession): Promise<StatusRow[]> {
  return session.call<StatusRow[]>(`
    const rows = await window.electronAPI.listLlmConnectionsWithStatus()
    return (rows ?? []).map(c => ({ slug: c.slug, name: c.name, providerType: c.providerType, baseUrl: c.baseUrl, isAuthenticated: c.isAuthenticated }))
  `)
}

/** The store's own record, masked by the handler before it leaves the main process. */
async function storedKey(session: CdpSession, slug: string): Promise<string | null> {
  return session.call<string | null>(`
    return (await window.electronAPI.getLlmConnectionApiKey(${JSON.stringify(slug)})) ?? null
  `).catch(() => null)
}

interface Rect { x: number; y: number; text: string }

/**
 * The centre of a button matched by its visible text, SCROLLED INTO VIEW first.
 *
 * The scroll is not a convenience. Measured 2026-09-17 on this case's second
 * drive: *"+ Add Connection"* sits at y=958 on a 1400x900 window, and
 * `lib/viewport.ts` refuses a click outside the viewport rather than sending one
 * that would dismiss a popover instead of hitting the row — a refusal that is
 * correct and that reads, three lines later, as a missing button. The rect is
 * re-measured AFTER the scroll, so the coordinate and the layout agree.
 */
async function buttonByText(session: CdpSession, pattern: RegExp): Promise<Rect | undefined> {
  return session.call<Rect | undefined>(`
    const wanted = ${pattern.toString()}
    const button = Array.from(document.querySelectorAll('button')).find(el => wanted.test((el.innerText || '').replace(/\\s+/g, ' ')))
    if (!button) return undefined
    const first = button.getBoundingClientRect()
    if (first.bottom > window.innerHeight || first.top < 0) {
      button.scrollIntoView({ block: 'center' })
      await new Promise(resolve => setTimeout(resolve, 400))
    }
    const r = button.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) return undefined
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), text: (button.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 80) }
  `)
}

/**
 * Press one of the product's own one-click cards, opening the surface that
 * carries it if it is not already on screen.
 *
 * Both surfaces show the same five cards: the ONBOARDING overlay on a profile
 * with no connection, and the Add-Connection overlay behind Settings → AI. The
 * case takes whichever is reachable, because which one a profile shows depends
 * on whether it has a card yet — and this case deliberately drives both states.
 */
async function pressOneClick(session: CdpSession, label: RegExp): Promise<string | undefined> {
  // Leave the ONBOARDING first if the previous press put us on its last screen.
  // Measured 2026-09-17 on this case's first drive: after the Pi card is created
  // the app stays on the onboarding's "You're all set … Get Started" screen, the
  // other two cards are no longer on it, and everything downstream reported "the
  // one-click button was not found" — which reads as three missing cards and was
  // one unpressed button. Same trap `rs-32.ts` records for `freshSession()`.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const done = await buttonByText(session, /get started/i)
    if (!done) break
    await clickAt(session, { x: done.x, y: done.y }, 'the onboarding’s Get Started button')
    await Bun.sleep(2_000)
  }
  const direct = await buttonByText(session, label)
  if (direct) {
    await clickAt(session, { x: direct.x, y: direct.y }, direct.text)
    await Bun.sleep(3_000)
    return direct.text
  }
  await session.call<null>(`
    window.dispatchEvent(new CustomEvent('nessy-agent-navigate', { detail: { route: 'settings/ai' }, bubbles: true }))
    return null
  `)
  await Bun.sleep(2_500)
  const section = await buttonByText(session, /^AI Model, thinking/i)
  if (section) {
    await clickAt(session, { x: section.x, y: section.y }, 'the AI settings section')
    await Bun.sleep(2_000)
  }
  const add = await buttonByText(session, /Add Connection/i)
  if (!add) return undefined
  await clickAt(session, { x: add.x, y: add.y }, 'Add Connection')
  await Bun.sleep(2_000)
  const card = await buttonByText(session, label)
  if (!card) return undefined
  await clickAt(session, { x: card.x, y: card.y }, card.text)
  await Bun.sleep(3_000)
  return card.text
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)

  const logPath = process.env.NESSY_CDP_APP_LOG?.trim()
  if (!logPath) {
    blocked(
      'the migration arm needs the app’s own output. Launch the packaged build with NESSY_DEBUG=1, redirect its '
      + 'stdout and stderr to a file, and export NESSY_CDP_APP_LOG=<that file>. Without it the "Discarded the stored '
      + 'credential snapshot" line — the only source that says a snapshot was really deleted — cannot be read.',
    )
  }

  // ---- arm 1: the three cards, created through the product's own buttons ---
  const pressed: Record<string, string | undefined> = {}
  for (const card of GATEWAY_CARDS) {
    const existing = await statuses(session)
    if (existing.some(row => row.slug === card.slug)) { pressed[card.slug] = '(already present)'; continue }
    pressed[card.slug] = await pressOneClick(session, card.label)
  }
  run.observe('the one-click buttons this case pressed', pressed)

  const afterSeed = await statuses(session)
  run.observe('every connection the app lists, with its own isAuthenticated', afterSeed)

  for (const card of GATEWAY_CARDS) {
    const row = afterSeed.find(entry => entry.slug === card.slug)
    run.check(
      `the ${card.slug} gateway card exists`,
      row !== undefined,
      `the app lists ${afterSeed.map(entry => entry.slug).join(', ') || 'nothing'} — the one-click button for this `
      + `card was ${JSON.stringify(pressed[card.slug] ?? 'not found')}`,
    )
    if (!row) continue
    run.check(
      `DA1.13 — ${card.slug} is SELECTABLE (isAuthenticated), with no stored credential to prove it with`,
      row.isAuthenticated === true,
      'isAuthenticated is false, which is what `ConnectionRow.tsx` disables the row and labels "Not authenticated" '
      + 'on. That is the exact failure the removal had to be paired against: the credential of record is the live dp '
      + 'sign-in, and the presence readers had to learn it',
    )
    const stored = await storedKey(session, card.slug)
    run.check(
      `DA1.13 — ${card.slug} keeps NO stored credential snapshot`,
      stored === null,
      `the store answers ${JSON.stringify(stored)} (masked) for a gateway slug — a snapshot with no lifecycle is `
      + 'exactly what this row removed',
    )
  }

  // ---- arm 2 (RS-42): a BYO card on the gateway HOST, with its own key -----
  const byoSetup = await session.call<{ success?: boolean; error?: string }>(`
    return await window.electronAPI.setupLlmConnection(${JSON.stringify({
      slug: BYO_SLUG,
      credential: fakeKey(),
      baseUrl: BYO_URL,
      customEndpoint: { api: 'openai-completions' },
      defaultModel: MODELS[0],
      models: MODELS,
    })})
  `)
  const byoKeyBefore = await storedKey(session, BYO_SLUG)
  run.observe('RS-42 — the BYO card on the gateway HOST', { setup: byoSetup, storedKeyBefore: byoKeyBefore })
  run.require(
    'RS-42’s PRECONDITION — the BYO card on the gateway host really did store a key',
    byoKeyBefore !== null,
    `setup answered ${JSON.stringify(byoSetup)} and the store answers ${JSON.stringify(byoKeyBefore)}. Without a key `
    + 'stored here, "the key survived" below would be equally true of a key that was never written',
  )

  // ---- arm 3: PLANT a legacy snapshot, then re-run the card ----------------
  //
  // The plant is the older install's own shape: the slug is created as an
  // ordinary BYO connection with a key and a non-gateway endpoint, which the
  // handler stores because `isGatewayBackedConnection` is false for it.
  const plant = await session.call<{ success?: boolean; error?: string }>(`
    return await window.electronAPI.setupLlmConnection(${JSON.stringify({
      slug: 'pi-api-key',
      credential: fakeKey(),
      baseUrl: PLANT_URL,
      customEndpoint: { api: 'openai-completions' },
      defaultModel: MODELS[0],
      models: MODELS,
    })})
  `)
  const plantedKey = await storedKey(session, 'pi-api-key')
  run.observe('the planted legacy snapshot', { setup: plant, storedKey: plantedKey })
  run.require(
    'THE PLANT — a snapshot really is stored under the gateway slug before the re-run',
    plantedKey !== null,
    `the store answers ${JSON.stringify(plantedKey)} after the plant (${JSON.stringify(plant)}). Without it the `
    + 'migration has nothing to delete and its line has no reason to be written, so the arm below would fail against '
    + 'a build that is working',
  )

  // THE RE-RUN, through the same RPC the one-click button uses.
  //
  // Not through the BUTTON, and the reason is a measurement rather than a
  // shortcut (2026-09-17, this case's third drive): with `pi-api-key` diverged to
  // a non-gateway endpoint by the plant, pressing the one-click card MINTED A NEW
  // SLUG — `pi-api-key-2` — instead of upserting the existing one, so the
  // migration had nothing to run over and the arm scored a red against a build
  // that was working. That behaviour is recorded below as its own reading. What
  // the row is about is the handler's rule, and `buildGatewaySetup`'s Pi payload
  // is a gateway base URL and NO credential, which is what is sent here.
  const before = discarded(logPath).length
  const buttonRerun = await pressOneClick(session, GATEWAY_CARDS[0].label)
  const afterButton = await statuses(session)
  run.observe('pressing the one-click card again, with the slug diverged by the plant', {
    pressed: buttonRerun ?? '(the button was not reachable)',
    slugsAfter: afterButton.map(row => row.slug),
    note: 'a NEW slug here rather than an upsert is the product’s own answer to a diverged card, and it means the '
      + 'migration below has to be driven through the handler the button calls',
  })
  const rerun = await session.call<{ success?: boolean; error?: string }>(`
    return await window.electronAPI.setupLlmConnection(${JSON.stringify({
      slug: 'pi-api-key',
      baseUrl: GATEWAY_URL,
      customEndpoint: { api: 'openai-completions' },
      defaultModel: MODELS[0],
      models: MODELS,
    })})
  `)
  run.observe('the card re-run through setupLlmConnection (the RPC the button calls)', rerun)
  await Bun.sleep(2_000)
  const lines = discarded(logPath)
  const duringRerun = lines.slice(before)
  const afterRerun = await statuses(session)
  const piKeyAfter = await storedKey(session, 'pi-api-key')
  const byoKeyAfter = await storedKey(session, BYO_SLUG)
  run.observe('what the re-run did', {
    discardLinesBefore: before,
    discardedDuringTheRerun: duringRerun,
    piStoredKeyAfter: piKeyAfter,
    byoStoredKeyAfter: byoKeyAfter,
  })

  // THE CONTROL for the line, and it decides what a silence means. The plant
  // took the `else if` branch of the SAME handler, whose own info line is
  // `Saved API key to LLM connection`. If neither line is in the capture, the
  // silence belongs to that logger — not to the migration, which the store read
  // below answers for independently.
  const siblingLines = savedKeyLines(logPath)
  run.observe('THE CONTROL — the same handler’s sibling info line', {
    savedApiKeyLines: siblingLines,
    note: 'written by the same `deps.platform.logger?.info` on the branch the PLANT takes. Zero here means this '
      + 'handler’s logger reaches nowhere in the capture, and the discard line’s absence says nothing about the '
      + 'migration',
  })
  run.check(
    'DA1.13 — re-running the card DISCARDS the snapshot and SAYS SO',
    duringRerun.includes('pi-api-key'),
    `the app wrote ${JSON.stringify(duringRerun)} during the re-run, and the same handler’s sibling info line `
    + `appears ${siblingLines} time(s) in the same capture. With the sibling at ZERO this is the LOGGER being `
    + 'unreachable rather than the migration failing — read the store check below, which answers the migration '
    + 'independently of any log',
  )
  run.check(
    'DA1.13 — the snapshot is gone from the store afterwards',
    piKeyAfter === null,
    `the store still answers ${JSON.stringify(piKeyAfter)} (masked) for the gateway slug`,
  )
  const piAfter = afterRerun.find(row => row.slug === 'pi-api-key')
  run.check(
    'DA1.13 — and the card did NOT go disabled by losing it',
    piAfter?.isAuthenticated === true,
    `isAuthenticated is ${JSON.stringify(piAfter?.isAuthenticated)} after the discard — the pair this row had to `
    + 'land as one: remove the snapshot AND teach the presence readers the live dp sign-in',
  )
  run.check(
    'RS-42 — the BYO card on the gateway HOST keeps its OWN key across the gateway re-run',
    byoKeyAfter !== null && byoKeyAfter === byoKeyBefore,
    `the store answered ${JSON.stringify(byoKeyBefore)} before the re-run and ${JSON.stringify(byoKeyAfter)} after. `
    + '`isGatewayBackedConnection` is the STRICT whole-URL predicate precisely so a connection that merely lives on '
    + 'the gateway host is not swept by the migration',
  )
  const byoAfter = afterRerun.find(row => row.slug === BYO_SLUG)
  run.check(
    'RS-42 — and that card is still selectable',
    byoAfter?.isAuthenticated === true,
    `isAuthenticated is ${JSON.stringify(byoAfter?.isAuthenticated)} for a BYO card whose key is still stored`,
  )
  run.observe('no card went disabled', afterRerun.map(row => ({ slug: row.slug, isAuthenticated: row.isAuthenticated })))
}

if (import.meta.main) await main(ID, TITLE, drive)

export const manual = {
  steps: [
    '1. PACKAGED build, dark theme, ONE content panel, a NESSY_CONFIG_DIR created for the run and NOTHING seeded — the case presses the product’s own one-click buttons, and a profile that already has the cards measures a different thing.',
    '2. Launch it with NESSY_DEBUG=1, redirecting stdout and stderr to a file.',
    '3. `NESSY_CDP_APP_LOG=<that file> bun run scripts/cdp/cases/rs-41.ts` with NESSY_CONFIG_DIR pointing at the same dir.',
    '4. Read: the three cards’ `isAuthenticated`, the store’s answer per gateway slug, the discard line during the re-run, and RS-42’s BYO key before and after.',
    '5. Remove the scratch config dir afterwards, by its full path.',
  ],
  expected: 'the three gateway cards exist, each `isAuthenticated` with NO stored credential; a re-run over a planted snapshot writes "Discarded the stored credential snapshot on gateway connection \\"pi-api-key\\"", empties the store for that slug, and leaves the card selectable; the BYO card on the gateway HOST keeps its own key.',
  detector: 'the app’s own `listLlmConnectionsWithStatus().isAuthenticated` (the value `ConnectionRow.tsx` disables a row on), `getLlmConnectionApiKey(slug)` (the STORE’s own record, masked before it leaves the main process), and the migration’s own log line. Never the screen and never a file this case opens itself.',
  positiveControl: 'the PLANT, verified through the same store read before the re-run. On a profile created today nothing ever writes a snapshot, so a re-run deletes nothing and logs nothing — and an unplanted assertion would fail against a build that is working perfectly. RS-42’s own precondition is the second one: its key is read before the re-run as well as after.',
  doneMeans: 'DA1.13 carries one packaged run of the pair — no snapshot AND still selectable, read together on one profile — and RS-42’s row carries the same run’s control arm.',
  safety: 'every key written here is fabricated; no turn is driven; the one-click sign-in is the app’s own dp module reading its own file and this case never touches it.',
  doNotConflate: 'an absent snapshot with a working migration. They are different claims and only the planted arm can tell them apart — a fresh profile has nothing to discard, so silence there proves nothing.',
} as const satisfies SittingRecipe
