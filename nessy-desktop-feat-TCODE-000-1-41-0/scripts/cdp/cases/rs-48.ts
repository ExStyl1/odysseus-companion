/**
 * RS-48 (D1.13) — a Pi session that Nessy did not create is neither browsable
 * nor searchable, measured on the packaged build with a control that must be.
 *
 * ## The row
 *
 * D1.13 (source `P6.108`) is ledger `F4/pi`, a `—` cell: no claim was ever made.
 * Our store answers browse / search / archive for every runtime, and the host
 * deliberately does not write into `.pi-sessions` — `SessionManager.continueRecent`
 * says why in its own comment. What nobody has asked is the other direction: does
 * anything of ours READ a Pi session the host did not write?
 *
 * ## Why no relaunch is needed, and how that was established
 *
 * The row's rig says *restart the app, then search*. Read at HEAD, the search RPC
 * (`packages/server-core/src/handlers/rpc/sessions.ts`) calls
 * `searchSessions(query, sessionsDir, …)` — it takes the sessions directory and
 * scans it per call rather than consulting a cache built at boot. So a plant made
 * while the app is running is visible to the very next call, and a relaunch would
 * only make the case slower and its failure modes wider.
 *
 * ## The plant, and why it is a COPY rather than a hand-written file
 *
 * "Pi wrote this" is a claim about a file FORMAT, and a hand-written sidecar that
 * the reader rejects for being malformed would score exactly like a reader that
 * refuses to look. So the case copies a sidecar Pi itself wrote in this profile,
 * substitutes its token, and files it under a session id the Nessy store has
 * never heard of — which is the whole of "created outside Nessy, in the same
 * workspace".
 *
 * A profile with no Pi sidecar at all BLOCKS rather than passing: with nothing to
 * copy there is no plant, and an empty search would be a reading about an empty
 * rig.
 *
 * ## The control, and it is the reason this case is worth running
 *
 * A search that finds nothing is the expected answer AND the answer a broken
 * search gives. So a second token is put where the store certainly has it — a
 * message submitted in a session this case created — and that one MUST be found.
 * Both searches run in the same run, on the same rig, through the same RPC.
 *
 * The control needs no model reply: the user row carries the token the moment it
 * is submitted, so the case waits for the row rather than for a turn, and a card
 * that cannot answer does not weaken it.
 *
 * ## Safety
 *
 * The plant is inside this run's own `NESSY_CONFIG_DIR`, under a session id the
 * case generates, and it is removed in a `finally`. No credential is read or
 * written, and nothing outside the rig config dir is touched.
 */

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { clearComposer, focusComposer, submitComposer, typeIntoComposer } from '../lib/composer.ts'
import type { CdpSession } from '../lib/connect.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import { writableConfigDir } from '../lib/runtime-session-log.ts'
import { assertElectronApi, freshSession, transcript, waitFor } from '../lib/state.ts'
import type { CaseMeta } from '../lib/sitting.ts'

const ID = 'RS-48'
const TITLE = 'a Pi session Nessy did not create is neither browsable nor searchable'

export const meta = {
  id: ID,
  title: TITLE,
  row: 'D1.13',
  runtimes: ['pi'],
  credentials:
    'whatever card the profile has — the control needs a submitted message, not an answered turn. The case must be '
    + 'run with NESSY_CONFIG_DIR set to the SAME directory the app was launched with: it plants a file inside it.',
} as const satisfies CaseMeta

/** A token nothing else in the tree can hold. */
function token(tag: string): string {
  return `WIF${tag}${randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase()}`
}

interface Sidecar { readonly path: string; readonly text: string }

/** The newest Pi sidecar this profile carries, or `undefined`. */
function findSidecar(sessionsDir: string): Sidecar | undefined {
  if (!existsSync(sessionsDir)) return undefined
  for (const workspace of readdirSync(sessionsDir)) {
    const workspaceDir = join(sessionsDir, workspace)
    let sessions: string[] = []
    try { sessions = readdirSync(workspaceDir) } catch { continue }
    for (const session of sessions) {
      const dir = join(workspaceDir, session, '.pi-sessions')
      if (!existsSync(dir)) continue
      for (const file of readdirSync(dir)) {
        if (!file.endsWith('.jsonl')) continue
        const path = join(dir, file)
        const text = readFileSync(path, 'utf8')
        if (text.trim().length > 0) return { path, text }
      }
    }
  }
  return undefined
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)

  // D1.210 — the refusal this case wrote by hand now lives in the lib, where the
  // NEXT case that writes into the profile can reach it, and it announces the
  // directory it resolved so a run's log says which profile was read.
  const configDir = writableConfigDir('the Pi sidecar this case plants')
  const sessionsDir = join(configDir, 'sessions')
  const sidecar = findSidecar(sessionsDir)
  if (!sidecar) {
    blocked(
      `no Pi sidecar under ${sessionsDir} to copy, so there is nothing to plant and an empty search would be a `
      + 'reading about an empty rig. Run one Pi turn in this profile first (RS-32 does).',
    )
  }
  run.observe('the sidecar this plant is a copy of', sidecar.path.replace(configDir, '<configDir>'))

  const plantedToken = token('PLANT')
  const controlToken = token('CTRL')
  const plantedSessionId = randomUUID()
  const workspaceId = sidecar.path.slice(sessionsDir.length + 1).split('/')[0] ?? ''
  const plantDir = join(sessionsDir, workspaceId, plantedSessionId, '.pi-sessions')
  const plantPath = join(plantDir, `2026-09-17T00-00-00-000Z_${randomUUID()}.jsonl`)

  try {
    // ---- the plant --------------------------------------------------------
    mkdirSync(plantDir, { recursive: true })
    // Every JSON string in the copied sidecar that is long enough to be prose
    // gets the token appended, so whatever field the reader would look at has
    // it. Substituting one guessed field would make a negative a reading about
    // the guess.
    const planted = sidecar.text
      .split('\n')
      .map(line => line.replace(/"((?:[^"\\]|\\.){12,})"/g, (_whole, body: string) => `"${body} ${plantedToken}"`))
      .join('\n')
    writeFileSync(plantPath, planted, 'utf8')
    run.observe('the plant', {
      sessionId: plantedSessionId,
      path: plantPath.replace(configDir, '<configDir>'),
      bytes: planted.length,
      tokenOccurrences: planted.split(plantedToken).length - 1,
    })
    run.check(
      'the plant really carries its token (the file the reader would have to miss)',
      planted.includes(plantedToken),
      'the substitution produced a file without the token, so every negative below is a property of the plant',
    )

    // ---- the control: a token the store certainly has ----------------------
    const key = await freshSession(session, `CDP ${ID} ${new Date().toISOString().slice(11, 19)}`)
    run.check('the case ran in a session it created', key.fresh, key.reason ?? '')
    await focusComposer(session)
    await clearComposer(session)
    await typeIntoComposer(session, `remember nothing, this is a search probe ${controlToken}`, { charDelayMs: 6 })
    await submitComposer(session)
    // The USER row, not a turn: the control is "the store holds this text", and
    // waiting for a model reply would make the control depend on a card.
    const landed = await waitFor(
      async () => (await transcript(session, key)).some(message => (message.content ?? '').includes(controlToken)),
      found => found,
      { timeoutMs: 60_000, intervalMs: 1_000, label: 'the control token to land in the transcript' },
    ).catch(() => false)
    run.check(
      'THE CONTROL — the control token is in a session the store owns',
      landed,
      'the submitted message never reached the transcript, so the search arm below cannot be interpreted',
    )
    // The store writes on its own schedule; give it a moment before searching.
    await Bun.sleep(4_000)

    // ---- the two searches, same RPC, same run -----------------------------
    // `searchSessionContent(workspaceId, query)` is the bridge's own name for it
    // — read off the live `window.electronAPI` rather than guessed, because a
    // `searchSessions` that does not exist would answer every query with a
    // thrown error and both arms would agree for the wrong reason.
    const search = async (query: string): Promise<{ count: number; sample: string[] }> => session.call<{ count: number; sample: string[] }>(`
      try {
        const rows = await window.electronAPI.searchSessionContent(${JSON.stringify(workspaceId)}, ${JSON.stringify(query)})
        const list = Array.isArray(rows) ? rows : (rows?.results ?? rows?.sessions ?? [])
        return { count: list.length, sample: list.slice(0, 5).map(r => String(r.sessionId ?? r.id ?? r.name ?? '?')) }
      } catch (error) { return { count: -1, sample: [String(error).slice(0, 160)] } }
    `)

    const controlHits = await search(controlToken)
    run.observe('THE CONTROL — searching for the token the store owns', controlHits)
    run.check(
      'THE CONTROL — the product\'s own search FINDS a token it wrote itself',
      controlHits.count > 0,
      'the search found nothing for a token in a session it created seconds ago — so "the planted token is not found" '
      + 'below would be a property of the search, not of the Pi sidecar',
    )

    const plantedHits = await search(plantedToken)
    run.observe('the planted Pi sidecar', plantedHits)
    run.check(
      'a Pi session Nessy did not create is NOT searchable (D1.13\'s question, answered)',
      plantedHits.count === 0,
      `the search returned ${plantedHits.count} row(s) for a token that exists only inside a .pi-sessions file the `
      + 'host never wrote — that REFUTES the row\'s premise and is the more interesting answer',
    )

    const browsed = await session.call<{ total: number; knowsPlanted: boolean }>(`
      const rows = (await window.electronAPI.getSessions()) ?? []
      return { total: rows.length, knowsPlanted: rows.some(s => s.id === ${JSON.stringify(plantedSessionId)}) }
    `)
    run.observe('the session list', browsed)
    run.check(
      'and it is not BROWSABLE either — the session list does not carry it',
      browsed.knowsPlanted === false,
      'the session list names the planted id, so the store does read the sidecar directory and the row\'s premise is '
      + 'refuted on the browse arm too',
    )
    run.check(
      'THE CONTROL — the session list is not simply empty',
      browsed.total > 0,
      'the list carries nothing at all, so "it does not carry the plant" says nothing',
    )
  } finally {
    // The plant lives in the rig's own config dir and is removed whatever
    // happens above — a sitting that leaves a fabricated Pi session behind would
    // poison every later case in the same profile.
    try { rmSync(join(sessionsDir, workspaceId, plantedSessionId), { recursive: true, force: true }) } catch { /* best effort */ }
  }
}

if (import.meta.main) await main(ID, TITLE, drive)
