/**
 * P6.669 — a gateway fixture that omits `supportsThinking` is not
 * under-specified, it is WRONG, and this is the guard that says which files
 * still are.
 *
 * `ModelDefinition.supportsThinking` is documented *"Defaults to true when
 * undefined"* while both rows of the shipped Nessy Gateway card declare
 * `false`. So a fixture that stands for that card and leaves the field out does
 * not leave it unset — it flips it. `supportsImages` is the opposite shape: no
 * default, so an omission genuinely means *undeclared*, which is the third state
 * that manufactured P3.152's false positive. One field, two failure modes, and
 * only one of them is visible by reading the fixture.
 *
 * ## Two guards, and the second is the one that can cry wolf
 *
 * 1. The BUILDER, {@link gatewayModelFixture}, fills every tri-state the card
 *    declares — derived from the catalogue, so a third tri-state added to the
 *    card appears in every fixture on the next run rather than in a comment. Its
 *    negative case is the pre-fix hand-written shape from
 *    `runtime-switch-session.test.ts`, kept verbatim below: that specimen is what
 *    a file with an adoption owing looks like, and it is what the builder must
 *    differ from. (How MANY such files there are is a reading with a date, and
 *    it lives in {@link RESTATE_THE_CARD_BY_HAND} rather than in this sentence.)
 * 2. The LEDGER: the files that still restate the card by hand. It is an
 *    allowlist that may only SHRINK, because the row's own decision was that the
 *    adoptions ride the lanes that next touch each file rather than landing as
 *    32 edits from here. P6.784 split it in two — the files with an adoption
 *    owing, and the ones the sweep names for a reason that is not one. Read
 *    {@link NAMES_AN_ID_WITHOUT_STANDING_FOR_THE_CARD} before adopting: 18 of
 *    the original 32 needed no change at all.
 *
 * The sweep below reproduces P3.179's own instrument exactly, and its numbers
 * were the check that it does: **34 tracked test files spell a shipped gateway
 * model id and build a model definition, 2 declare `supportsThinking` and 32 do
 * not** — the same 34/2/32 the row measured. An instrument that cried wolf would
 * not land on that split, and a rule that cries wolf is a rule people stop
 * running.
 *
 * ## D1.335 — and "a shipped gateway model id" is not only the ids shipping TODAY
 *
 * The sweep asked `NESSY_GATEWAY_MODEL_IDS`, and on 2026-09-11 P6.1080 ROTATED
 * that constant: the coder id the card had seeded since the repo's first commit
 * was answered `404 … больше не поддерживается` by the gateway and was replaced.
 * The ~360 occurrences of the old id left in fixtures were deliberately NOT
 * renamed (AGENTS.md §Gateway Facts: *"valid as strings and deliberately not
 * renamed"*), so from that day the sweep could no longer see the files this
 * ledger is made of — 16 candidates against a ledger of 18 — and both cases
 * below were red for a week.
 *
 * A file that restates the 2026-08 card is exactly a file that restates the
 * card. So the corpus is BOTH generations ({@link SWEPT_MODEL_IDS}), and that is
 * not a widening of P3.179's instrument but a restoration of it: P3.179's own
 * corpus WAS the retired generation. Measured 2026-09-18 over a quiet tree
 * (index equal to HEAD, no tracked test file modified in the working tree): the
 * union names 36 files and 19 omitters, and 18 of those 19 are this ledger
 * unchanged, entry for entry — 13 of them visible only through the retired id.
 * The nineteenth is `mini-model-degradation.test.ts`, born 2026-09-11 with the
 * NEW ids on the same day as the rotation, which is why no lane ever got a red
 * naming it: the guard was already down when it landed.
 *
 * That reading has a DATE, and the three numbers are no longer asserted as
 * facts (P6.784): a shrink-only ledger whose count is frozen at the day it was
 * measured fails on the first correct adoption, which is the one movement it
 * exists to invite. What is asserted now is the DIRECTION each may move, with
 * the ledger itself as the live count.
 *
 * ADOPTING A FILE IS NOT A NO-OP, which is why this is a ledger and not a
 * codemod: moving a fixture onto the builder changes `supportsThinking` from an
 * implicit `true` to an explicit `false`, and reasoning-carry switch costs read
 * that field. The assertion that moves is the point of the row; it still has to
 * be read by whoever moves it.
 *
 * TRACKED FILES ONLY (`git ls-files`): an untracked file in a sibling lane's
 * working tree is not this guard's business, and reading them is how a
 * tree-scanning check ends up measuring the neighbours.
 */
import { describe, expect, it, setDefaultTimeout } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  NESSY_GATEWAY_DECLARED_TRI_STATES,
  NESSY_GATEWAY_DEFAULT_MODEL,
  NESSY_GATEWAY_MODELS,
  NESSY_GATEWAY_MODEL_IDS,
} from '../nessy-gateway'
import {
  gatewayConnectionFixture,
  gatewayModelFixture,
} from '@nessy-agent/shared/config/__tests__/fixtures/gateway-connection-fixture.ts'

/**
 * An explicit budget against the MEASURED floor, never bun's 5 s default.
 * The module graph under `apps/electron` is the cost here — 650 s of wall for
 * 21 assertions on the first run of this file, of which 448 s was one sweep
 * before it was rewritten onto `git grep` (see {@link sweep}).
 */
setDefaultTimeout(120_000)

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..', '..', '..')

/**
 * D1.322 — what a fixture standing for "the card" must declare for a field the
 * card's two rows DISAGREE on: the value its DEFAULT row declares.
 *
 * Read from `NESSY_GATEWAY_MODELS` rather than from the fixture module's own
 * constant, on purpose. Asserting the builder against a map the builder spreads
 * is a tautology; asserting it against the CARD is the link this file exists to
 * keep, and it is the link that broke when the two rows stopped agreeing.
 */
const CARD_DEFAULT_ROW = NESSY_GATEWAY_MODELS.find(model => model.id === NESSY_GATEWAY_DEFAULT_MODEL)!

/**
 * D1.335 — the ids this card has SHIPPED and the gateway has since retired.
 *
 * Exactly one, and it is read from the history rather than guessed: the pair has
 * rotated once inside this repo's tracked history (`93c819ba5`, P6.1080,
 * 2026-09-11), and only its FIRST member moved — `tgpt/qwen36-35b-a3b-fp8` is
 * the same `fast` row it always was. Counted the same day over tracked test
 * files, the retired id is spelled 358 times and the two live ids 35 and 75, so
 * the retired generation is where almost all of this ledger's evidence lives.
 *
 * A retired id may leave this list only when the last fixture spelling it has
 * gone; until then dropping it re-creates the exact red D1.335 repaired, and the
 * case *"reads BOTH generations"* below is what says so out loud.
 */
const RETIRED_GATEWAY_MODEL_IDS = ['tgpt/qwen35-397b-a17b-fp8'] as const

/** The corpus the ledger is measured over: every id the card has ever seeded. */
const SWEPT_MODEL_IDS: readonly string[] = [...NESSY_GATEWAY_MODEL_IDS, ...RETIRED_GATEWAY_MODEL_IDS]

/**
 * The files that still restate the shipped card by hand. MAY ONLY SHRINK.
 *
 * A file here that has since adopted the builder fails this suite too, with a
 * message saying to delete the line — the ledger is only true while it is
 * exact, and a stale allowlist is the thing it exists instead of.
 *
 * P6.784, 2026-09-08: `packages/pi-agent-server/src/custom-endpoint-models.test.ts`
 * left this list because `f0f82dae2` (P6.367's pi half) taught the BYO
 * normalizer to carry `supportsThinking` and wrote the field into that suite —
 * which is not an adoption at all, because that file never stood for the
 * gateway card. The sweep is a TEXT heuristic and cannot tell the two apart, so
 * the ledger went red on a commit that had nothing to do with it. That is the
 * shape to expect from this guard: an entry can leave for the right reason or
 * for an unrelated one, and the line is deleted either way.
 */
const RESTATE_THE_CARD_BY_HAND: readonly string[] = []

/**
 * The sweep's OVER-CAPTURE: files that spell a shipped gateway model id and
 * contain the word `contextWindow`, and build no model definition standing for
 * the card. Adopting the builder in one of these is not a no-op either — it is
 * WRONG.
 *
 * P6.784 read all 32 original entries one at a time, and this is the finding:
 * the ledger was a to-do list of 32 where 18 of them had nothing to do. The
 * membership test is `git grep` for an id AND the string `contextWindow`
 * ANYWHERE in the file, so a suite that names a gateway model in a config
 * field, a usage map, a verdict map or an assertion about a FETCHER's output
 * lands in it. A rule that hands a lane 18 files needing no change is the rule
 * people stop running — which is the same failure §Component path fields in
 * AGENTS.md records for a different guard.
 *
 * The two lists are one ratchet: a file may move from the first to neither, and
 * a file in NEITHER fails the guard. What a file may not do is sit here without
 * a reason, so each carries one.
 */
const NAMES_AN_ID_WITHOUT_STANDING_FOR_THE_CARD: readonly string[] = [
  // `contextWindow` is the PAYLOAD under test (`promoteModels`' displayed
  // window) and the ids sit in a verdict map, not in a model definition.
  'apps/electron/src/renderer/components/apisetup/__tests__/byo-runtime.test.ts',
  // The id is a KEY in a per-model usage map; `contextWindow` is session usage.
  'apps/electron/src/renderer/components/app-shell/__tests__/ChatDisplay.usage-overlay.test.tsx',
  // `model` and `contextWindow` are `buildCodexConfigToml` OPTIONS — the config
  // the writer emits, not a catalogue row.
  'packages/codex-responses-adapter/src/__tests__/config-writer-auto-compaction.test.ts',
  'packages/codex-responses-adapter/src/__tests__/config-writer-compact-prompt.test.ts',
  'packages/codex-responses-adapter/src/__tests__/config-writer.test.ts',
  // Asserts what the FETCHERS return for a gateway id. Imposing the card's
  // tri-states on the expectation would assert that the fetcher invents them.
  'packages/server-core/src/model-fetchers/__tests__/context-window-per-backend.test.ts',
  'packages/server-core/src/model-fetchers/__tests__/openai-compat.test.ts',
  // `{ enabled, contextWindow, thresholdPercent }` is the auto-compaction KNOB.
  'packages/shared/src/agent/__tests__/auto-compaction-knob-visibility.test.ts',
  // The id keys the SDK's `modelUsage`, whose `contextWindow` is the SDK's.
  'packages/shared/src/agent/__tests__/claude-event-adapter.test.ts',
  // `usage.contextWindow` — the whole subject is that this is NOT the model's.
  'packages/shared/src/agent/__tests__/claude-sdk-context-window.test.ts',
  // Both are `buildCodexConfigToml`/`BackendRuntimePayload` fields again.
  'packages/shared/src/agent/__tests__/codex-auto-compaction-off-diagnostic.test.ts',
  'packages/shared/src/agent/__tests__/codex-auto-compaction-off-switch.test.ts',
  // `model` is a `BackendConfig` name; the window hangs off `runtime`.
  'packages/shared/src/agent/__tests__/codex-context-window-warning.test.ts',
  // Its subject is that a gateway id is ABSENT from `MODEL_REGISTRY`: it
  // asserts `getModelById(GATEWAY_MODEL)?.contextWindow` is undefined.
  'packages/shared/src/agent/__tests__/pi-context-window-drift.test.ts',
  // A connection whose model rows are id-only on purpose — the subject is
  // default-model resolution, and no row carries a window at all.
  'packages/shared/src/agent/backend/internal/drivers/anthropic.test.ts',
  // Asserts the two window TABLES. There is no model definition in the file.
  'packages/shared/src/auth/__tests__/nestor.test.ts',
  // The gateway rows here are deliberately THIN — `{ id, contextWindow }`, the
  // shape `BackendRuntimePayload.customModels` carries — and one case's title
  // is *"reads a thin runtime catalogue entry, not just a full
  // ModelDefinition"*. The builder would delete the case's subject.
  'packages/shared/src/config/__tests__/context-window-resolver.test.ts',
  // Its own comment: *"produces partial entries (no provider/contextWindow) —
  // mirror that shape"*. The partiality is the fixture.
  'packages/shared/src/config/__tests__/llm-connections.test.ts',
  // D1.335 — the nineteenth entry, and the only file the restored corpus adds
  // to the ledger. Its two gateway ids go through the file's OWN generic
  // `model(id)` helper, which stamps `provider: 'anthropic'` and a flat 200 000
  // window on every id it is handed — `claude-opus-4-8` and `claude-haiku-4-5`
  // in the same file — so nothing here stands for the card. The subject is
  // `getMiniModel` picking the `fast` row by its `shortName` where
  // `isSmallClassModelId` cannot, which is a claim about the ALIAS and not
  // about a tri-state. Adopting the builder would mean branching that helper on
  // the id, which is more fixture than the case has subject.
  'packages/shared/src/config/__tests__/mini-model-degradation.test.ts',
]

/** Every file the sweep may name, for whichever of the two reasons. */
const LEDGERED = [...RESTATE_THE_CARD_BY_HAND, ...NAMES_AN_ID_WITHOUT_STANDING_FOR_THE_CARD]

/**
 * P3.179's instrument, re-run here rather than quoted.
 *
 * The candidate set comes from ONE `git grep -l`, not from reading every test
 * file: the naive shape — `git ls-files '*.test.ts'` then `readFileSync` on all
 * ~2 000 of them — measured **448 s for one call** on this box, I/O bound, and
 * turned a two-assertion guard into the slowest file in the package. `git grep`
 * does the same scan in its own process in well under a second, and only the
 * ~34 files that match are read here.
 *
 * `-l` with several `-e` patterns is an OR, and `--cached` keeps it to TRACKED
 * content for the reason the header gives. The result is memoised PER ID LIST —
 * D1.335's own case asks the same question of a narrower corpus, and the two
 * answers must not share a cache slot.
 */
const sweepCache = new Map<string, { all: string[]; omitting: string[] }>()

/**
 * P6.941 — whether a file has ADOPTED the builder, in two arms.
 *
 * The first arm is the one that was missing. Until this row the only test was
 * the raw substring `supportsThinking`, and {@link gatewayModelFixture} never
 * writes that string into its callers — so adopting the builder did NOT take a
 * file off the ledger, and every adopted file in this tree passes only through
 * its adoption COMMENT. It works, and it is the shape AGENTS.md §Traps records
 * as *a substring guard cannot tell code from the prose beside it*: the next
 * lane that adopts the builder without writing a comment gets a red naming the
 * wrong thing (*"a NEW file the sweep names"*), and the rule that would explain
 * it lives in a different file.
 *
 * The substring stays as the SECOND arm, because it is not redundant: a fixture
 * may legitimately declare the tri-state by hand — the builder is the easy road,
 * not the only one — and a file that spells the field has answered the question
 * this ledger asks whether or not it imports anything.
 */
function declaresTheTriState(text: string): boolean {
  return text.includes('gatewayModelFixture') || text.includes('supportsThinking')
}

function sweep(ids: readonly string[] = SWEPT_MODEL_IDS): { all: string[]; omitting: string[] } {
  const key = ids.join('\u0000')
  const cached = sweepCache.get(key)
  if (cached) return cached
  const grep = Bun.spawnSync([
    'git', 'grep', '-l', '--cached',
    ...ids.flatMap(id => ['-e', id]),
    '--', '*.test.ts', '*.test.tsx',
  ], { cwd: REPO_ROOT })
  const candidates = new TextDecoder().decode(grep.stdout).split('\n').filter(Boolean)
  const all: string[] = []
  const omitting: string[] = []
  for (const file of candidates) {
    let text: string
    try {
      text = readFileSync(join(REPO_ROOT, file), 'utf8')
    } catch {
      continue
    }
    if (!text.includes('contextWindow')) continue
    all.push(file)
    if (!declaresTheTriState(text)) omitting.push(file)
  }
  const result = { all: all.sort(), omitting: omitting.sort() }
  sweepCache.set(key, result)
  return result
}

/**
 * The pre-fix shape, copied from `runtime-switch-session.test.ts` as it stood
 * before this row. That file ADOPTED the builder in P6.784 and no longer looks
 * like this — the specimen is kept verbatim because it is the negative case,
 * and a negative case sourced from a live file stops being negative the day the
 * file is fixed. Its `supportsImages` is optional-and-usually-omitted and its
 * `supportsThinking` does not exist at all.
 */
function preFixModelDef(id: string, contextWindow: number, provider: string, supportsImages?: boolean) {
  return {
    id,
    name: id,
    shortName: id,
    description: '',
    provider,
    contextWindow,
    ...(supportsImages === undefined ? {} : { supportsImages }),
  }
}

describe('the gateway fixture builder fills every tri-state the card declares', () => {
  it('declares them all, at the card’s own values, derived rather than restated', () => {
    // Derived on BOTH sides: the expectation is the card's own declaration map,
    // so a third tri-state added to `NESSY_GATEWAY_MODELS` is asserted here on
    // the next run without this file being edited.
    //
    // D1.322 — `supportsThinking` is no longer in that map, because the card's
    // two rows disagree on it (the catalogue publishes a reasoning block for
    // `coder` and none for `fast`), and a map that includes a field only while
    // every row agrees is doing exactly what it says. The field did NOT stop
    // being declared on the fixture: it moved to the default row, asserted from
    // the card below.
    const declared = Object.keys(NESSY_GATEWAY_DECLARED_TRI_STATES)
    expect(declared).toContain('supportsImages')
    expect(declared).not.toContain('supportsThinking')

    const model = gatewayModelFixture({ id: 'gw-a', contextWindow: 200_000, provider: 'anthropic' })
    for (const field of declared) {
      expect(model).toHaveProperty(field, NESSY_GATEWAY_DECLARED_TRI_STATES[field])
    }
    // The half the map can no longer carry, and the one an omission would get
    // WRONG rather than leave undeclared.
    expect(model.supportsThinking).toBe(CARD_DEFAULT_ROW.supportsThinking)
    expect(model.supportsThinking).toBe(true)
    expect(model.contextWindow).toBe(200_000)
    expect(model.provider).toBe('anthropic')
  })

  it('lets a case whose SUBJECT is the divergence say so out loud', () => {
    // The escape hatch is an explicit override, never an omission — which is the
    // whole distinction the row is about.
    const model = gatewayModelFixture({ id: 'gw-a', overrides: { supportsImages: true } })
    expect(model.supportsImages).toBe(true)
    expect(model.supportsThinking).toBe(CARD_DEFAULT_ROW.supportsThinking)
  })

  it('can leave supportsImages ABSENT, and absent is not undefined', () => {
    // P6.784 — the third state, and the reason it needs an escape rather than a
    // value: after `ebbfca53d` an undeclared model is deliberately un-gated, so
    // a fixture whose subject is *"nobody said"* cannot say it with `false`.
    // The key must be GONE, not present-and-undefined — `in` is what a gate
    // keyed on "was this declared" asks, and it answers `true` for a key whose
    // value is `undefined`.
    const model = gatewayModelFixture({ id: 'gw-a', imagesUndeclared: true })
    expect('supportsImages' in model).toBe(false)
    expect(Object.keys(model)).not.toContain('supportsImages')
    // And it undeclares ONLY that one: `supportsThinking` has a documented
    // default, so removing it would state the opposite of the card.
    expect(model.supportsThinking).toBe(CARD_DEFAULT_ROW.supportsThinking)
  })

  it('seeds the window from the card when the caller names no other', () => {
    const model = gatewayModelFixture({ id: NESSY_GATEWAY_MODEL_IDS[0] })
    expect(typeof model.contextWindow).toBe('number')
    expect(model.contextWindow as number).toBeGreaterThan(0)
  })

  it('builds a whole connection whose every row carries them', () => {
    const connection = gatewayConnectionFixture({
      slug: 'claude-gateway',
      name: 'Claude Code (Nessy Gateway)',
      providerType: 'claude-runtime',
      modelIds: ['claude-gw-model-a', 'claude-gw-model-b'],
      contextWindow: 200_000,
      provider: 'anthropic',
    })
    expect(connection.defaultModel).toBe('claude-gw-model-a')
    for (const row of connection.models as Record<string, unknown>[]) {
      expect(row).toHaveProperty('supportsThinking', CARD_DEFAULT_ROW.supportsThinking)
    }
  })

  it('differs from the pre-fix hand-written shape — the guard’s own negative case', () => {
    // This is what a file in `RESTATE_THE_CARD_BY_HAND` looks like:
    // `supportsThinking` is ABSENT, so the model reads as the documented default
    // rather than as anything the card says. D1.322 is why the assertion below
    // is about presence and about the CARD's value rather than about `false` —
    // the card's default row declares `true` now, and a negative case pinned to
    // a literal would have gone green for the wrong reason the day it moved.
    const before = preFixModelDef('claude-gw-model-a', 200_000, 'anthropic', false)
    expect(before).not.toHaveProperty('supportsThinking')
    expect(Object.keys(before)).not.toContain('supportsThinking')

    const after = gatewayModelFixture({
      id: 'claude-gw-model-a',
      contextWindow: 200_000,
      provider: 'anthropic',
    })
    expect(after).toHaveProperty('supportsThinking')
    expect(after.supportsThinking).toBe(CARD_DEFAULT_ROW.supportsThinking)
  })
})

describe('the ledger of fixtures that still restate the card by hand', () => {
  it('tracks P3.179’s split as it SHRINKS, rather than freezing the day it was measured', () => {
    const { all, omitting } = sweep()
    // P3.179 measured 34 files spelling a shipped id and building a model
    // definition, 2 declaring the tri-state and 32 not. Those were written here
    // as three frozen numbers, and frozen is the wrong shape for a shrink-only
    // ledger: the FIRST correct adoption makes `omitting` 31 and fails the
    // guard that asked for it, so the rule went red on the lane obeying it.
    // (It did, on `f0f82dae2`, for an unrelated reason — see the ledger's own
    // note.) Bounded in the direction each number may move instead:
    // `all` may only grow, a new fixture file is the case below's business, and
    // `omitting` is the ledger, exactly, so the two are ONE fact.
    //
    // D1.335 re-derived both over the restored corpus on 2026-09-18, from a
    // quiet tree: 36 and 19. The floor moves with the reading — it is a
    // direction, not a fact — and the header says which files entered it.
    expect(all.length).toBeGreaterThanOrEqual(36)
    expect(omitting.length).toBe(LEDGERED.length)
    // The third number P3.179 measured — how many files DECLARE the tri-state —
    // used to be asserted here as `all - omitting >= 2`, and D1.335 deleted it
    // rather than re-pinning it: it is arithmetic on the two lines above
    // (`all >= 36` with `omitting` pinned exactly at 19 gives `>= 17` and can
    // give nothing else), so it could not fail on its own and re-pinning it
    // would have dressed a dead arm as a fresh reading. What replaces it is the
    // case below, which can fail: the corpus itself.
  })

  it('reads BOTH generations of the card’s ids — the retired one is where the ledger lives (D1.335)', () => {
    // The regression this guards is the tidy-looking one: the retired id is a
    // string no shipped code path can resolve any more, so deleting it from
    // `SWEPT_MODEL_IDS` reads as removing dead weight. It is the opposite —
    // the sweep then stops seeing the files the ledger is made of, which is
    // exactly the red D1.335 repaired.
    const both = sweep()
    const liveOnly = sweep(NESSY_GATEWAY_MODEL_IDS)
    // The retired generation contributes candidates the live ids cannot see.
    expect(liveOnly.all.length).toBeLessThan(both.all.length)
    // And it contributes LEDGER entries, which is the half that matters: a
    // corpus that grew by files nobody ledgered would prove nothing.
    const onlyThroughTheRetiredId = LEDGERED.filter(file => !liveOnly.all.includes(file))
    expect(onlyThroughTheRetiredId.length).toBeGreaterThan(0)
    // The positive control, on the same instrument: the live ids are not a dead
    // pattern either — they name files of their own, so a zero on the line
    // above would be a real absence rather than a broken `git grep`.
    expect(liveOnly.all.length).toBeGreaterThan(0)
    // Measured 2026-09-18 on a quiet tree: live-only 16 files / 6 omitters,
    // both generations 36 / 19, and 13 of the 19 are reachable only through the
    // retired id. Those numbers are a reading with a date and are deliberately
    // not asserted; the relations above are what may not move.
  })

  it('reads an ADOPTION as an adoption, not only the spelled field (P6.941)', () => {
    // The arm the ledger was missing: the builder writes no `supportsThinking`
    // into its caller, so a file that imports it and never spells the field is
    // adopted and must leave `omitting`.
    expect(declaresTheTriState("const m = gatewayModelFixture({ id: 'gw-a' })")).toBe(true)
    // The second arm, kept: a fixture may declare the tri-state by hand.
    expect(declaresTheTriState('{ id: "gw-a", supportsThinking: false }')).toBe(true)
    // And the negative that keeps both arms meaningful.
    expect(declaresTheTriState('{ id: "gw-a", contextWindow: 200_000 }')).toBe(false)
  })

  it('names no file the ledger does not, and no ledger entry that has been adopted', () => {
    const { omitting } = sweep()
    const unlisted = omitting.filter(file => !LEDGERED.includes(file))
    // A NEW file the sweep names. Either it stands for the card and omits the
    // field — build it with `gatewayModelFixture` — or it is another
    // over-capture, and it goes in the second list WITH ITS REASON.
    expect(unlisted).toEqual([])

    const adopted = LEDGERED.filter(file => !omitting.includes(file))
    // Already fixed — delete the line. An allowlist is only true while exact.
    expect(adopted).toEqual([])

    // The two lists are disjoint: a file cannot both restate the card and not.
    const both = RESTATE_THE_CARD_BY_HAND.filter(
      file => NAMES_AN_ID_WITHOUT_STANDING_FOR_THE_CARD.includes(file),
    )
    expect(both).toEqual([])
  })
})
