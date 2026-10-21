/**
 * RS-74 (D1.61) — which model the claude arm's MINI tier resolves to on a
 * gateway card, read off the child the packaged app actually spawned.
 *
 * ## The row, and the premise it was written from
 *
 * D1.61 is *"the claude arm's mini model falls to a gateway id matching no
 * small-class keyword, and the Opus-rate warning has no guard"*. Its source row
 * (P6.380, denominator K33) scores claude `partial` and names the failure it
 * feared in its own words: *"the most expensive model in each list, on every
 * background task."*
 *
 * The premise has moved TWICE since, in the source, and neither move has been
 * read on an artefact:
 *
 * - `resolveLocalAdapterMiniModel` now asks `resolveGatewayFastModelId` — the
 *   gateway's own `fast` ALIAS — before any keyword search;
 * - and the docblock beside it records the sentence the row rests on as REFUTED
 *   (2026-09-11, W12-f): the gateway's CODER id is `tgpt/deepseek-v4-flash-0731`,
 *   so a keyword list containing `flash` resolves the mini tier to the FLAGSHIP.
 *
 * Both are claims in the source tree. This case is the reading on the shipped
 * 1.40.0.
 *
 * ## The detector is the child's own environment
 *
 * `ANTHROPIC_DEFAULT_HAIKU_MODEL` is the name this fork writes from the
 * resolved mini model into the claude child — the SDK's own variable for the
 * tier its built-in tools (title generation, WebFetch summarisation) run on. So
 * the resolved value is readable, verbatim, off `ps eww` of the child the
 * packaged app spawned, filtered to THIS app instance by the `NESSY_CONFIG_DIR`
 * in the same environment. Four names are read and nothing else: the three tier
 * variables and the mini one. No credential name is read and no value length is
 * reported for anything outside those four.
 *
 * ## Three readings, and what each excludes
 *
 * 1. **The resolved id is one the CARD ITSELF lists.** This is the control that
 *    the value is a resolution against this catalogue rather than the SDK's own
 *    built-in default — the row's own note says that default is *"a Haiku id no
 *    gateway serves, so an unresolved value here is a guaranteed 404"*, and a
 *    `claude-3-5-haiku-*` here would be exactly that.
 * 2. **The resolved id is NOT the card's default model.** If the mini tier and
 *    the session tier are the same id, no fall-through happened and the row's
 *    feared outcome — the flagship on every background task — is what shipped.
 * 3. **The KEYWORD scan, over both catalogue ids, using the vocabulary
 *    `isSmallClassModelId` carries** (`haiku|mini|nano|flash|lite|small|sonnet|
 *    luna`). It is recorded rather than asserted: what it shows on a Nessy
 *    gateway catalogue is that the keyword rule INVERTS — the 524k coder id
 *    matches (`flash`) and the smaller `fast` id matches nothing — so a resolver
 *    that used keywords alone would pick the larger model, and the alias
 *    resolver is what makes the shipped answer right.
 *
 * ## What this case does NOT claim
 *
 * It does not read the model named on the upstream REQUEST, which is what the
 * row's rig asks for and what needs a loopback capture. What the child's
 * environment proves is which id the HOST resolved and handed over; that the
 * binary then uses it for its built-in tools is the SDK's documented behaviour
 * for that variable and is not re-measured here. The distinction is recorded in
 * the verdict rather than glossed.
 *
 * The Opus-rate warning half of the row is untouched: it is a guard on a
 * host-side warning, not a reading.
 *
 * ## What it creates
 *
 * One session it names itself, inside `NESSY_CONFIG_DIR`. No configuration is
 * written, no connection edited, no credential read.
 */

import { appEnvBlockReason, readAppEnvContamination } from '../lib/app-env.ts'
import { lastAssistantText, sendPrompt } from '../lib/chat.ts'
import type { CdpSession } from '../lib/connect.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import { configDir } from '../lib/runtime-session-log.ts'
import { listConnections, runtimeOf, switchRuntime } from '../lib/runtime-switch.ts'
import { assertElectronApi, freshSession } from '../lib/state.ts'
import type { CaseMeta, SittingRecipe } from '../lib/sitting.ts'

const ID = 'RS-74'
const TITLE = 'the claude arm\'s mini-tier model, read off the packaged child\'s own environment'

/** The SDK's own variable for the tier this fork writes the resolved mini into. */
const MINI_ENV = 'ANTHROPIC_DEFAULT_HAIKU_MODEL'

/** The three sibling tiers, read beside it so "everything is the session model" is visible. */
const TIER_ENV = ['ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_FABLE_MODEL'] as const

/**
 * `isSmallClassModelId`'s vocabulary, spelled here rather than imported.
 *
 * A case runs against a PACKAGED artefact; importing the repo's constant would
 * measure the source tree instead. Copied from
 * `packages/shared/src/config/llm-connections.ts` on 2026-09-18 and recorded in
 * the observation, so a reader can see what was matched rather than trusting it.
 */
const SMALL_CLASS = /haiku|mini|nano|flash|lite|small|sonnet|luna/i

/** The claude binary the packaged app spawns, by the path only the artefact has. */
const CHILD_MARKER = 'claude-agent-sdk-binary/claude'

export const meta = {
  id: ID,
  title: TITLE,
  row: 'D1.61',
  runtimes: ['claude'],
  credentials:
    'owner: a claude-runtime gateway card with a refreshed catalogue. No key is read; only four model-id '
    + 'variables are extracted from the child environment, never the whole of it.',
} as const satisfies CaseMeta

export const manual = {
  steps: [
    '1. PACKAGED build, a config dir created for the run, launched with the `env -u` launcher in scripts/cdp/README.md.',
    '2. Let the startup catalogue refresh land, so the card lists the gateway\'s own ids.',
    '3. One turn on the claude-runtime card, so the app spawns its claude child.',
    '4. Read ANTHROPIC_DEFAULT_HAIKU_MODEL and its three sibling tiers off that child, scoped to this app instance by NESSY_CONFIG_DIR.',
    '5. Compare the resolved id against the card\'s own catalogue and against its default model, and run the small-class keyword scan over both catalogue ids.',
  ],
  expected:
    'The mini tier resolves to an id the card lists and NOT to the card\'s default. On a Nessy gateway catalogue '
    + 'that is the `fast` alias id, and the keyword rule the row was written around would have picked the other '
    + 'one.',
  detector:
    '`ANTHROPIC_DEFAULT_HAIKU_MODEL` in the environment of the claude child the packaged app spawned, read with '
    + '`ps eww` and matched to this app instance by the NESSY_CONFIG_DIR in the same environment. Never '
    + '`resolveLocalAdapterMiniModel` in the source tree, and never the stored `miniModel`, which is unset on a '
    + 'one-click gateway card.',
  positiveControl:
    'the resolved id being a member of the CARD\'S OWN model list. The SDK\'s built-in default for this tier is a '
    + 'Haiku id no gateway serves, so a value outside the catalogue would be the unresolved case — which makes '
    + '"a real resolution happened" falsifiable on the same read. Its partner is the card\'s DEFAULT model: a mini '
    + 'equal to it is the fall-through the row feared.',
  doneMeans:
    'D1.61\'s claude cell carries a driven verdict with the resolved id recorded, and the row\'s keyword premise '
    + 'is confirmed or refuted on the artefact rather than in the source.',
  doNotRead:
    'Do NOT answer this from the stored connection. `miniModel` is unset on a one-click gateway card — the value '
    + 'is computed at spawn time, so only the spawned child carries it.',
} as const satisfies SittingRecipe

/** The four model-id variables of one process, and nothing else from its environment. */
function tierModels(pid: number): Record<string, string> {
  const out: Record<string, string> = {}
  try {
    const text = Bun.spawnSync(['ps', 'eww', '-p', String(pid)]).stdout.toString()
    for (const token of text.split(/\s+/)) {
      const eq = token.indexOf('=')
      if (eq <= 0) continue
      const name = token.slice(0, eq)
      if (name !== MINI_ENV && !(TIER_ENV as readonly string[]).includes(name)) continue
      out[name] = token.slice(eq + 1)
    }
  } catch { /* an unreadable process is reported by its absence */ }
  return out
}

/** Every claude child of THIS app instance, told apart from a sibling lane's by config dir. */
function claudeChildPids(root: string): number[] {
  try {
    return Bun.spawnSync(['pgrep', '-f', CHILD_MARKER]).stdout.toString()
      .split('\n').map(line => Number(line.trim())).filter(pid => Number.isFinite(pid) && pid > 0)
      .filter(pid => Bun.spawnSync(['ps', 'eww', '-p', String(pid)]).stdout.toString().includes(`NESSY_CONFIG_DIR=${root}`))
  } catch {
    return []
  }
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)
  const root = configDir()

  const appEnv = readAppEnvContamination()
  run.observe('app-env', { pids: appEnv.pids.length, present: appEnv.present, controlSeen: appEnv.controlSeen })
  const contaminated = appEnvBlockReason(appEnv, 'the mini-tier resolution this case reads')
  if (contaminated !== undefined) blocked(contaminated)

  const cards = await listConnections(session)
  const card = cards.find(row => runtimeOf(row.providerType) === 'anthropic')
  if (!card) blocked('this profile lists no claude-runtime card, and the subject is the claude child\'s mini tier')

  const catalogue = await session.call<{ models: string[]; defaultModel: string }>(`
    const rows = await window.electronAPI.listLlmConnections()
    const row = (rows ?? []).find(c => c.slug === ${JSON.stringify(card.slug)}) ?? {}
    return {
      models: (row.models ?? []).map(m => (typeof m === 'string' ? m : m.id)).filter(Boolean),
      defaultModel: row.defaultModel ?? '',
    }
  `)
  run.observe('the card\'s own catalogue', { slug: card.slug, ...catalogue })
  run.require(
    'THE PRECONDITION — the card lists more than one model, so a mini tier has something to choose',
    catalogue.models.length > 1,
    `the card lists ${JSON.stringify(catalogue.models)}. With one entry (or none) every tier resolves to the same `
    + 'id trivially and the row\'s question has no subject on this profile',
  )

  const key = await freshSession(session, `CDP ${ID} ${new Date().toISOString().slice(11, 19)}`)
  run.check('the case ran in a session it created', key.fresh, key.fresh ? undefined : `inherited ${key.inheritedMessages} messages`)
  const bind = await switchRuntime(session, key.sessionId, card.slug)
  run.check(`the session is bound to ${card.slug}`, bind.ok, bind.ok ? undefined : `switchRuntime refused: ${bind.error}`)
  const ready = await sendPrompt(session, key, 'Reply with the single word ready. Do not use any tool.', 300_000)
  run.observe('the turn that spawned the child', { answer: lastAssistantText(ready.added).trim().slice(0, 60) }) // F1.521

  const pids = claudeChildPids(root)
  run.require(
    'THE PRECONDITION — a claude child of this app instance is running and readable',
    pids.length > 0,
    'no process matching the packaged claude binary carries this rig\'s NESSY_CONFIG_DIR; the child may have '
    + 'exited between the turn and the read, in which case nothing below is about the product',
  )
  const tiers = tierModels(pids[0] ?? 0)
  run.observe('the tier variables the packaged child was spawned with', { pid: pids[0], ...tiers })

  const mini = tiers[MINI_ENV] ?? ''
  run.require(
    `THE SUBJECT EXISTS — the child carries ${MINI_ENV}`,
    mini.length > 0,
    'the child was spawned without the mini-tier variable at all, so the SDK falls back to its own built-in Haiku '
    + 'id, which no gateway serves — a guaranteed 404 on every built-in tool rather than a mis-resolution',
  )

  run.check(
    'THE CONTROL — the resolved mini id is one the CARD ITSELF lists, so a real resolution happened',
    catalogue.models.includes(mini),
    `the child carries ${JSON.stringify(mini)}, which is not in ${JSON.stringify(catalogue.models)}. A value `
    + 'outside the catalogue is the unresolved case the row names: the SDK\'s built-in default is a Haiku id no '
    + 'gateway serves',
  )
  run.check(
    'THE ROW\'S FEAR — the mini tier is NOT simply the card\'s default (flagship) model',
    mini !== catalogue.defaultModel,
    `the mini tier resolved to ${JSON.stringify(mini)}, the same id as the card's default. That is the outcome `
    + 'P6.380 names verbatim — "the most expensive model in each list, on every background task"',
  )

  const keywordScan = catalogue.models.map(id => ({ id, matchesSmallClass: SMALL_CLASS.test(id) }))
  run.observe('the small-class KEYWORD scan over this catalogue', {
    vocabulary: SMALL_CLASS.source,
    scan: keywordScan,
    resolvedMiniMatchesKeyword: SMALL_CLASS.test(mini),
    reading:
      'recorded, never asserted. On a Nessy gateway catalogue the keyword rule inverts: the 524k coder id matches '
      + 'on `flash` and the smaller `fast` id matches nothing. A resolver using keywords alone would therefore '
      + 'pick the LARGER model — which is why the shipped answer being right is a statement about the alias '
      + 'resolver and not about the keyword list.',
  })

  run.observe('verdict', {
    card: card.slug,
    catalogue: catalogue.models,
    defaultModel: catalogue.defaultModel,
    resolvedMini: mini,
    siblingTiers: Object.fromEntries(TIER_ENV.map(name => [name, tiers[name] ?? null])),
    scope:
      'this is the id the HOST resolved and handed to the child, read off the child\'s environment. The model '
      + 'named on the upstream REQUEST is a different reading and needs the loopback capture the row\'s rig names.',
  })
}

if (import.meta.main) {
  await main(ID, TITLE, drive)
}
