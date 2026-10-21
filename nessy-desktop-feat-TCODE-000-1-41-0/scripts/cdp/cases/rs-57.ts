/**
 * RS-57 (D1.244) — what the gateway catalogue publishes for the `fast` and
 * `coder` rows, read off the file the app itself writes.
 *
 * ## The row, and why it has been a NULL twice
 *
 * D1.244 is the measurement `supportsThinking`'s flip is waiting on. The `coder`
 * row is measured (`reasoning: { effort: 'low' }` in the 2026-09-11 catalogue,
 * read directly off `/cli/models` by WA-e); the `fast` row's capability has never
 * been read, and `nessy-gateway-models.ts` says in its own comment that flipping
 * a row whose behaviour nobody has measured is inventing.
 *
 * Sitting 4 drove it twice on the packaged 1.39.0 and recorded a NULL both times
 * — correctly. That artefact was built from `b1f4f279c`, which does not contain
 * `4e3b57caf`, the commit that taught the fetcher to read the catalogue's
 * `reasoning` and `sampling_params` blocks at all. Its two model entries carried
 * neither field, and scoring that as *"the gateway publishes no reasoning
 * block"* would have been a confident false product finding about a build.
 *
 * So this case states the artefact question FIRST, out of
 * {@link ROW_ARTEFACT_MARKERS}, and BLOCKS rather than failing when the build
 * predates its own subject.
 *
 * ## The detector: `config.json`, because the fetcher is what writes it
 *
 * `ModelRefreshService` merges the catalogue into the stored connection, and the
 * merged rows land in `<config dir>/config.json` under the connection's `models`.
 * That is the file the feature itself writes. `listLlmConnections()` is read
 * BESIDE it rather than instead of it, because a disagreement between the app's
 * live record and what it persisted is itself worth seeing — and because a read
 * that only ever asks the renderer cannot tell "the fetcher wrote it" from "the
 * renderer defaulted it".
 *
 * ## Two controls, and the second is the one that makes an absence mean anything
 *
 *  1. **The refresh landed.** `catalogueRefreshedAt` is written AND both rows'
 *     descriptions are no longer the seed's own English sentence (*"Replaced by
 *     the gateway's own description on the first catalogue refresh."*). Without
 *     this, every field below is the seed's and the case is reading
 *     `nessy-gateway-models.ts` through a rig.
 *  2. **The block reader ran on BOTH rows.** `samplingParams` is written by the
 *     same commit and the same parser as `reasoningEffort`. If both rows carry
 *     sampling params, then a row WITHOUT a `reasoningEffort` is the catalogue
 *     being silent about that model — not the reader being absent. This is the
 *     whole difference between a measurement and sitting 4's NULL, and it is why
 *     the case does not stop at "the fast row has no effort".
 *
 * ## What this case does NOT do
 *
 * It does not flip anything. `supportsThinking` is a `[product]` tri-state whose
 * flip drops a field out of `NESSY_GATEWAY_DECLARED_TRI_STATES` the moment two
 * rows disagree, moving ~30 derived fixtures; the row prices that and the owner
 * takes it. The case's job is to make the reading exist.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { requireArtifactCarries, ROW_ARTEFACT_MARKERS } from '../lib/artifact-carries.ts'
import { resolveAppUnderTest } from '../lib/bundle.ts'
import type { CdpSession } from '../lib/connect.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import { configDir } from '../lib/runtime-session-log.ts'
import type { CaseMeta, SittingRecipe } from '../lib/sitting.ts'
import { assertElectronApi } from '../lib/state.ts'

const ID = 'RS-57'
const TITLE = 'what the gateway catalogue publishes for the `fast` and `coder` rows, off the file the app writes'

export const meta = {
  id: ID,
  title: TITLE,
  row: 'D1.244',
  runtimes: ['pi'],
  credentials:
    'owner: the one-click "Nessy · Pi agent" gateway card, signed in the way every gateway card is — the case reads '
    + 'no key and never touches the dp file. It drives no turn: the catalogue refresh the app performs at startup is '
    + 'the whole subject.',
} as const satisfies CaseMeta

/** The seed's own sentence, which a refreshed row must no longer carry. */
const SEED_DESCRIPTION_MARK = 'Replaced by the gateway\'s own description on the first catalogue refresh.'

interface StoredModel {
  id?: string
  name?: string
  shortName?: string
  description?: string
  contextWindow?: number
  supportsThinking?: boolean
  reasoningEffort?: string
  samplingParams?: Record<string, number>
}

interface StoredConnection {
  slug?: string
  providerType?: string
  baseUrl?: string
  catalogueRefreshedAt?: number
  models?: StoredModel[]
}

/** The connection rows as the app PERSISTED them, not as it renders them. */
function storedConnections(): StoredConnection[] {
  const path = join(configDir(), 'config.json')
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (cause) {
    blocked(
      `no config.json at ${path} — this case reads the file the refresh writes, so without it there is nothing to `
      + `measure (${cause instanceof Error ? cause.message : String(cause)}).`,
    )
    return []
  }
  const parsed = JSON.parse(raw) as { llmConnections?: StoredConnection[] }
  return parsed.llmConnections ?? []
}

/** The row whose `shortName` the gateway's own `alias` field became. */
function rowByAlias(models: StoredModel[], alias: string): StoredModel | undefined {
  return models.find(model => (model.shortName ?? '').toLowerCase() === alias)
}

function describe(model: StoredModel | undefined): Record<string, unknown> {
  if (!model) return { present: false }
  return {
    present: true,
    id: model.id,
    shortName: model.shortName,
    contextWindow: model.contextWindow,
    supportsThinking: model.supportsThinking,
    reasoningEffort: model.reasoningEffort ?? null,
    samplingParams: model.samplingParams ?? null,
    descriptionIsStillTheSeed: (model.description ?? '').includes(SEED_DESCRIPTION_MARK),
  }
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)

  // ---- the artefact question, before the product is asked anything ---------
  requireArtifactCarries(run, resolveAppUnderTest(session), ROW_ARTEFACT_MARKERS['D1.244']!)

  const stored = storedConnections()
  run.observe('the connections this profile persisted', stored.map(c => ({
    slug: c.slug, providerType: c.providerType, models: (c.models ?? []).length,
    catalogueRefreshedAt: c.catalogueRefreshedAt ?? null,
  })))

  const gateway = stored.find(c => (c.baseUrl ?? '').includes('code-completion-nestor.tcsbank.ru'))
  if (!gateway) {
    blocked(
      'this profile holds no connection on the gateway host, so there is no catalogue to have been refreshed. '
      + `It lists: ${stored.map(c => `${c.slug}(${c.baseUrl ?? 'no base url'})`).join(', ') || 'nothing'}. `
      + 'Press the onboarding\'s one-click "Nessy · Pi agent" button first — RS-32 drives exactly that.',
    )
  }

  const models = gateway.models ?? []
  const fast = rowByAlias(models, 'fast')
  const coder = rowByAlias(models, 'coder')
  run.observe('the `fast` row as persisted', describe(fast))
  run.observe('the `coder` row as persisted', describe(coder))

  // ---- control 1: the refresh landed --------------------------------------
  const refreshedAt = gateway.catalogueRefreshedAt
  const seedDescriptions = models.filter(m => (m.description ?? '').includes(SEED_DESCRIPTION_MARK)).length
  run.check(
    'THE CONTROL — the catalogue refresh LANDED on this profile',
    typeof refreshedAt === 'number' && refreshedAt > 0 && seedDescriptions === 0,
    `catalogueRefreshedAt=${String(refreshedAt)}, and ${seedDescriptions} of ${models.length} row(s) still carry the `
    + 'seed\'s own sentence — without a refresh every field below is `nessy-gateway-models.ts` read through a rig, '
    + 'and this case would be measuring the seed rather than the gateway',
  )

  // ---- control 2: the block reader ran on BOTH rows ------------------------
  const withSampling = models.filter(m => m.samplingParams !== undefined && Object.keys(m.samplingParams).length > 0)
  run.check(
    'THE CONTROL that makes an absence readable — the catalogue\'s BLOCKS are being parsed, on BOTH rows',
    withSampling.length === models.length && models.length > 0,
    `${withSampling.length} of ${models.length} row(s) carry samplingParams. `
    + '`sampling_params` and `reasoning` are read by the same commit and the same parser, so with sampling params '
    + 'present a MISSING reasoningEffort is the catalogue being silent about that model. With them absent it is the '
    + 'reader that is absent, which is exactly sitting 4\'s NULL on the 1.39.0 artefact and not a fact about the '
    + 'gateway',
  )

  // ---- the subject ---------------------------------------------------------
  run.check(
    'the `coder` row publishes a reasoning effort',
    typeof coder?.reasoningEffort === 'string' && coder.reasoningEffort !== '',
    `the coder row's reasoningEffort is ${JSON.stringify(coder?.reasoningEffort ?? null)} — WA-e read `
    + '`reasoning: {"effort":"low"}` off /cli/models directly on 2026-09-13, so an absence here is the shipped '
    + 'fetcher disagreeing with the endpoint rather than the endpoint having changed',
  )
  run.check(
    'THE SUBJECT — the `fast` row\'s reasoning capability is READ, either way',
    fast !== undefined,
    'no row on this card has `shortName: "fast"`. On a freshly seeded profile the short names are the display names '
    + 'until the refresh maps the API `alias` onto them, so this is the refresh not having landed rather than the '
    + 'gateway having no fast tier',
  )
  const fastEffort = fast?.reasoningEffort
  run.observe('D1.244 — the reading the flip is waiting on', {
    fastPublishesAReasoningBlock: typeof fastEffort === 'string' && fastEffort !== '',
    fastReasoningEffort: fastEffort ?? null,
    coderReasoningEffort: coder?.reasoningEffort ?? null,
    bothRowsDeclareSupportsThinking: [fast?.supportsThinking ?? null, coder?.supportsThinking ?? null],
  })

  // The two rows DIFFERING is the finding's own control: a build that wrote the
  // same thing everywhere — all `low`, or all absent — would be reporting its
  // own default rather than the catalogue's rows.
  run.check(
    'the two rows DIFFER on the reasoning block, so the reading is the catalogue\'s and not a default',
    (typeof coder?.reasoningEffort === 'string') !== (typeof fastEffort === 'string'),
    `fast=${JSON.stringify(fastEffort ?? null)} coder=${JSON.stringify(coder?.reasoningEffort ?? null)} — two rows `
    + 'agreeing is not wrong, but it cannot separate "the catalogue says so" from "the writer fills one value in for '
    + 'every row", and this case would then owe a second instrument before the flip is decided',
  )

  // ---- the live record beside the persisted one ---------------------------
  const live = await session.call<Array<{ slug?: string; models?: unknown }>>(`
    const res = await window.electronAPI.listLlmConnections()
    return (res?.connections ?? res ?? []).map(c => ({ slug: c.slug, models: c.models ?? [] }))
  `)
  const liveGateway = live.find(row => row.slug === gateway.slug)
  const liveModels = (liveGateway?.models ?? []) as StoredModel[]
  run.observe('the same two rows as the app LIVE reports them', {
    fast: describe(rowByAlias(liveModels, 'fast')),
    coder: describe(rowByAlias(liveModels, 'coder')),
  })
  run.check(
    'the app\'s live record agrees with what it persisted',
    rowByAlias(liveModels, 'coder')?.reasoningEffort === coder?.reasoningEffort
      && rowByAlias(liveModels, 'fast')?.reasoningEffort === fastEffort,
    'the renderer and `config.json` disagree about the reasoning block. Which one a consumer reads decides the '
    + 'behaviour, so the flip cannot be taken on either reading alone until they agree',
  )
}

export const manual = {
  why:
    'the arm a driver must NOT perform: re-reading `/cli/models` directly with the owner\'s corporate token to '
    + 'compare the endpoint against what the fetcher stored. This case reads only what the app itself wrote, which '
    + 'is the question D1.244 asks; the endpoint-side comparison needs a credential no case may spend.',
  detector:
    '`<config dir>/config.json` -> the gateway connection\'s `models[]`, matched by `shortName` (the gateway\'s own '
    + '`alias`, which `fetchNestorModels` writes): each row\'s `reasoningEffort` and `samplingParams`, plus '
    + '`catalogueRefreshedAt` on the connection.',
  positiveControl:
    'TWO. (1) The refresh landed: `catalogueRefreshedAt` is written and no row still carries the seed\'s own '
    + 'sentence. (2) The catalogue\'s blocks are parsed on BOTH rows: `samplingParams` present on every row, so a '
    + 'missing `reasoningEffort` is the catalogue\'s silence rather than the reader\'s absence — which is the exact '
    + 'distinction sitting 4 could not make on the 1.39.0 artefact.',
  expected:
    'both rows carry `samplingParams`; the `coder` row carries a `reasoningEffort` and the `fast` row is read either '
    + 'way. The two rows differing is what makes the reading the catalogue\'s rather than a writer\'s default.',
  doneMeans:
    'D1.244 can be decided: `supportsThinking` is flipped on exactly the rows that publish a reasoning block, '
    + 'together with the published default level, or the row records that neither row publishes one. A flip on a row '
    + 'whose reading is absent stays forbidden — that is inventing, which is what the row exists to prevent.',
  steps: [
    'Launch the packaged build with a fresh NESSY_CONFIG_DIR using the `env -u` launcher in scripts/cdp/README.md.',
    'Press the onboarding\'s one-click "Nessy · Pi agent" button (RS-32 does this) and let the startup catalogue '
      + 'refresh land — the control above says when it has.',
    'Run this case: `bun run scripts/cdp/cases/rs-57.ts`. It drives no turn and writes nothing.',
  ],
} as const satisfies SittingRecipe

if (import.meta.main) {
  await main(ID, TITLE, drive)
}
