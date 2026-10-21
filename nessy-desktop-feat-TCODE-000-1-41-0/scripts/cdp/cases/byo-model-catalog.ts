/**
 * BYO-CATALOG (D6 case 3, assertion half) — what the save actually LANDED.
 *
 * The interactive half is the owner's: they type the key, press Fetch, watch
 * the catalog group itself by availability and pick models. This case is the
 * half that can be measured, and it runs straight after that save.
 *
 * FIVE THINGS IT CHECKS, and why each is a real claim rather than a restatement:
 *
 * 1. `contextWindow` reached config.json for the saved models (C1/C3). The
 *    picker DISPLAYS a window; that display is fed by the fetch response, so
 *    seeing it on screen says nothing about what was persisted.
 * 2. `modelsSyncedAt` is stamped (C2, and G2's always-on sync). The tristate
 *    means an absent stamp is indistinguishable from "left alone" at the wire,
 *    so the only place the difference is visible is the stored connection.
 * 3. A restart WITHIN the TTL does not refetch. Asserted from the stamp, which
 *    the refresh service rewrites when it runs: if the value survives a restart
 *    unchanged, no refetch happened. Reading a log line would be weaker — the
 *    stamp is what the feature itself writes.
 * 4. The wire is recorded for anything the probe reached on Anthropic Messages
 *    (G3). Observed, not required: it depends on the key's entitlement.
 * 5. `miniModel`, when set, is one of the saved models. The server enforces it;
 *    this is the end-to-end check that the form's Select fed it correctly.
 *
 * READ-ONLY BY CONSTRUCTION. The case asserts on a connection the OWNER just
 * saved; it never creates, edits or deletes one, and it never handles a key.
 * Point it at a slug with NESSY_CATALOG_SLUG, or let it take the most recently
 * created llm-proxy connection.
 *
 * The restart half is a SECOND invocation:
 *   bun run scripts/cdp/cases/byo-model-catalog.ts            # right after the save
 *   …restart the app…
 *   NESSY_CATALOG_BASELINE=<stamp> bun run … --after-restart  # same stamp = no refetch
 */

import type { CdpSession } from '../lib/connect.ts'
import { minPlausibleContextWindow } from '../lib/model-window.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import { assertElectronApi } from '../lib/state.ts'

const ID = 'BYO-CATALOG'
const TITLE = 'A saved llm-proxy connection carries contextWindow, modelsSyncedAt and its wires'

const LLM_PROXY = 'llm-proxy.t-tech.team'

interface StoredModel {
  id: string
  contextWindow?: number
  wire?: string
}

interface StoredConnection {
  slug: string
  providerType?: string
  baseUrl?: string
  createdAt?: number
  miniModel?: string
  modelsSyncedAt?: number | null
  models?: Array<string | StoredModel>
}

async function connections(session: CdpSession): Promise<StoredConnection[]> {
  return session.call(`
    const res = await window.electronAPI.listLlmConnections()
    return (res?.connections ?? res ?? []).map(c => ({
      slug: c.slug, providerType: c.providerType, baseUrl: c.baseUrl ?? undefined,
      createdAt: c.createdAt ?? 0, miniModel: c.miniModel ?? undefined,
      modelsSyncedAt: c.modelsSyncedAt ?? null, models: c.models ?? [],
    }))
  `)
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)
  const afterRestart = process.argv.includes('--after-restart')

  const all = await connections(session)
  const wanted = process.env.NESSY_CATALOG_SLUG
  const candidates = all
    .filter(c => (wanted ? c.slug === wanted : (c.baseUrl ?? '').includes(LLM_PROXY)))
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))

  if (candidates.length === 0) {
    blocked(
      wanted
        ? `no connection with slug ${wanted}`
        : `no connection points at ${LLM_PROXY} — run the owner's form walk first, or pass NESSY_CATALOG_SLUG`,
    )
  }

  const connection = candidates[0]!
  const models = connection.models ?? []
  run.observe('connection', {
    slug: connection.slug,
    providerType: connection.providerType,
    baseUrl: connection.baseUrl,
    modelCount: models.length,
  })
  run.observe('models as stored', models.map(m => typeof m === 'string'
    ? `${m} (string — no metadata)`
    : `${m.id}${m.contextWindow ? ` ctx=${m.contextWindow}` : ''}${m.wire ? ` wire=${m.wire}` : ''}`))

  // --- (3) the restart half, when asked for --------------------------------
  if (afterRestart) {
    const baseline = process.env.NESSY_CATALOG_BASELINE
    if (!baseline) blocked('pass NESSY_CATALOG_BASELINE=<the stamp printed by the pre-restart run>')
    run.observe('stamp before restart', baseline)
    run.observe('stamp now', String(connection.modelsSyncedAt))
    run.check(
      'a restart within the TTL did NOT refetch — the stamp is unchanged',
      String(connection.modelsSyncedAt) === baseline,
      'the refresh service rewrites this stamp whenever it runs, so an unchanged value IS the negative',
    )
    return
  }

  // SUBSTRATE GUARD. A connection saved by an older build carries bare string
  // ids and no stamp, and every check below would FAIL on it — reading as "the
  // feature is broken" when the truth is "this connection predates it". That
  // misreading is the whole reason this guard exists: BLOCKED says "wrong
  // substrate", FAIL says "wrong behaviour", and they must not be confused.
  const objects = models.filter((m): m is StoredModel => typeof m !== 'string')
  if (objects.length === 0 && connection.modelsSyncedAt == null) {
    blocked(
      `${connection.slug} carries only bare model ids and no sync stamp — the shape a build before `
      + 'lane E/G produced. Run the owner\'s form walk to save a connection with this build, then '
      + 're-run (or pass NESSY_CATALOG_SLUG to name a different one).',
    )
  }

  // --- (1) contextWindow reached the config --------------------------------
  run.check(
    'the saved models are stored as objects carrying metadata, not bare ids',
    objects.length > 0,
    `${objects.length}/${models.length} carry metadata`,
  )
  const withWindow = objects.filter(m => typeof m.contextWindow === 'number' && m.contextWindow > 0)
  run.observe('createdAt', connection.createdAt ?? null)
  run.check(
    'contextWindow landed in config.json for the saved models (C1/C3)',
    withWindow.length > 0,
    withWindow.map(m => `${m.id}=${m.contextWindow}`).join(', ')
      // The guard above cannot catch this shape: a connection saved between
      // G2's always-on stamping and the metadata fix HAS a stamp and bare ids,
      // which is indistinguishable from a fresh regression by inspection alone.
      // Compare `createdAt` with the build before reading this as a defect.
      || 'none — if this connection predates the metadata fix, re-save it through the edit path and re-run',
  )
  // A window of 1 means "unfilled" upstream and must never be persisted as a
  // number — llm-proxy served it for 63 of its 387 rows as measured 2026-08-28
  // (68 of 383 at the 2026-08-14 reading; the catalogue moves weekly, which is
  // why the count carries its date instead of standing as a fact).
  //
  // The floor is READ from the product, not restated here. This check asserted a
  // hand-copied 4096 until P3.159, three commits after `e3959bac5` unified both
  // catalogue paths onto 1024 — so it would have flagged a credible 2048-token
  // window as incredible, failing on correct behaviour.
  const floor = minPlausibleContextWindow()
  run.observe('placeholder floor read from the product', `MIN_PLAUSIBLE_CONTEXT_WINDOW=${floor}`)
  run.check(
    'no model carries an incredible window',
    objects.every(m => m.contextWindow === undefined || m.contextWindow >= floor),
    objects.filter(m => (m.contextWindow ?? floor) < floor).map(m => `${m.id}=${m.contextWindow}`).join(', ') || 'none',
  )

  // --- (2) the sync stamp --------------------------------------------------
  run.observe('modelsSyncedAt', connection.modelsSyncedAt)
  run.check(
    'create stamped modelsSyncedAt — G2 made the sync always-on',
    typeof connection.modelsSyncedAt === 'number' && connection.modelsSyncedAt > 0,
  )
  run.observe('BASELINE for the restart half', String(connection.modelsSyncedAt))

  // --- (4) the wire, observed ---------------------------------------------
  const wired = objects.filter(m => m.wire)
  run.observe('models carrying a wire (G3)', wired.map(m => `${m.id} → ${m.wire}`))
  run.observe(
    'wire note',
    wired.length > 0
      ? 'an Anthropic-wire model is stored — G3-WIRE can run'
      : 'no wire recorded: either no anthropic/* model was picked, or this key is not entitled to one',
  )

  // --- (5) the utility model ----------------------------------------------
  if (connection.miniModel) {
    const ids = models.map(m => (typeof m === 'string' ? m : m.id))
    run.check(
      'the utility model is one of the saved models',
      ids.includes(connection.miniModel),
      `${connection.miniModel} ∈ [${ids.join(', ')}]`,
    )
  } else {
    run.observe('utility model', 'not set — the heuristic decides, which is a valid choice')
  }
}

if (import.meta.main) {
  await main(ID, TITLE, drive)
}

export const meta = { id: ID, title: TITLE }
