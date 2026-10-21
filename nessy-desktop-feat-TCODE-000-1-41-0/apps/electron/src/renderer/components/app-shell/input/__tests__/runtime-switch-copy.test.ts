import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { RUNTIME_SWITCH_REASON_KEYS, runtimeSwitchCopyKey } from '../runtime-switch-copy'
import type { HistoryCarryReason } from '@nessy-agent/shared/protocol'

describe('runtimeSwitchCopyKey', () => {
  it('asks nothing for a model change', () => {
    expect(runtimeSwitchCopyKey('model', true)).toBeNull()
  })

  it('asks nothing on an empty session, whatever the tier', () => {
    expect(runtimeSwitchCopyKey('connection-cross-runtime', false)).toBeNull()
    expect(runtimeSwitchCopyKey('connection-same-runtime', false)).toBeNull()
  })

  it('warns about the restart for a same-runtime switch', () => {
    expect(runtimeSwitchCopyKey('connection-same-runtime', true)?.bodyKey)
      .toBe('chat.runtimeSwitch.sameRuntimeBody')
  })

  it('warns about lost runtime memory for a cross-runtime switch', () => {
    expect(runtimeSwitchCopyKey('connection-cross-runtime', true)?.bodyKey)
      .toBe('chat.runtimeSwitch.crossRuntimeBody')
  })

  // The two tiers must not collapse onto one another: the same-runtime body
  // promises the conversation is kept, the cross-runtime body says the
  // runtime's working memory is not. A map that returned one copy for both
  // would pass each assertion above in isolation.
  it('gives the two tiers different titles and bodies', () => {
    const same = runtimeSwitchCopyKey('connection-same-runtime', true)!
    const cross = runtimeSwitchCopyKey('connection-cross-runtime', true)!
    expect(same.titleKey).not.toBe(cross.titleKey)
    expect(same.bodyKey).not.toBe(cross.bodyKey)
  })

  // P3 · the line the modal was missing. G6 (answered 2026-08-20, option A):
  // the dialog stays accept/decline and gains exactly one thing — a sentence
  // saying WHAT WILL CROSS.
  it('names a different promise for each carry plan', () => {
    const keys = (['native', 'anchor', 'text'] as const)
      .map(planKind => runtimeSwitchCopyKey('connection-cross-runtime', true, planKind)!.carryKey)
    expect(keys).toEqual([
      'chat.runtimeSwitch.carryNative',
      'chat.runtimeSwitch.carryAnchor',
      'chat.runtimeSwitch.carryText',
    ])
    // Three DISTINCT promises: a map that collapsed two of them would say
    // "the whole conversation crosses" for a returning leg, which is exactly
    // what D7 forbids.
    expect(new Set(keys).size).toBe(3)
  })

  // A preview that did not answer must leave the line out rather than guess
  // one. A missing sentence is honest; an invented one is the false promise
  // this whole task exists to prevent.
  it('omits the promise when the plan is unknown, and always for a same-runtime switch', () => {
    expect(runtimeSwitchCopyKey('connection-cross-runtime', true)!.carryKey).toBeNull()
    expect(runtimeSwitchCopyKey('connection-cross-runtime', true, null)!.carryKey).toBeNull()
    expect(runtimeSwitchCopyKey('connection-same-runtime', true, 'native')!.carryKey).toBeNull()
  })

  // T1b · the Codex BODY is now chosen on the TIER, not on the target runtime
  // alone. `crossRuntimeBodyCodex` says "{{toRuntime}} receives what was said,
  // not what was done" — true of the text and anchor tiers, and FALSE of a
  // native carry since T1b, which crosses tool calls and their results. So the
  // native tier takes the shared body, whose every word stays true.
  it('gives a switch INTO Codex its own body on the tiers where it is true', () => {
    for (const plan of ['anchor', 'text', null] as const) {
      expect(runtimeSwitchCopyKey('connection-cross-runtime', true, plan, 'codex-runtime')!.bodyKey)
        .toBe('chat.runtimeSwitch.crossRuntimeBodyCodex')
    }
    // THE T1b ROW: the one tier where the Codex body would now lie.
    expect(runtimeSwitchCopyKey('connection-cross-runtime', true, 'native', 'codex-runtime')!.bodyKey)
      .toBe('chat.runtimeSwitch.crossRuntimeBody')
    // Every other target keeps the shared body — including the one whose
    // native carry T2 builds.
    expect(runtimeSwitchCopyKey('connection-cross-runtime', true, 'native', 'anthropic')!.bodyKey)
      .toBe('chat.runtimeSwitch.crossRuntimeBody')
    expect(runtimeSwitchCopyKey('connection-cross-runtime', true, 'native', 'pi')!.bodyKey)
      .toBe('chat.runtimeSwitch.crossRuntimeBody')
  })

  // The CARRY line stays Codex-specific, but the reason this comment gave until
  // P2.507 was refuted: it said Codex's inject "crosses no attachment at all",
  // and P3.102 passes `attachmentBlock` on every plan and every target. What
  // still separates the two is model-visible history with nothing trimmed, and
  // Codex's own reasoning items not being carried. See the ROUTING assertions
  // here and the COPY assertion in
  // "makes the same image promise on both native carry lines" below.
  it('keeps a Codex-specific NATIVE carry line, and only for Codex', () => {
    expect(runtimeSwitchCopyKey('connection-cross-runtime', true, 'native', 'codex-runtime')!.carryKey)
      .toBe('chat.runtimeSwitch.carryNativeCodex')
    // The other two tiers say the same thing on every runtime: an anchored
    // Codex leg is impossible and a text tier carries no tool rows anywhere.
    expect(runtimeSwitchCopyKey('connection-cross-runtime', true, 'text', 'codex-runtime')!.carryKey)
      .toBe('chat.runtimeSwitch.carryText')
    expect(runtimeSwitchCopyKey('connection-cross-runtime', true, 'anchor', 'codex-runtime')!.carryKey)
      .toBe('chat.runtimeSwitch.carryAnchor')
    // T2's target keeps the full promise, which is what it will deliver.
    expect(runtimeSwitchCopyKey('connection-cross-runtime', true, 'native', 'anthropic')!.carryKey)
      .toBe('chat.runtimeSwitch.carryNative')
  })

  /**
   * P3.55 · Pi and Claude take the SAME native line again, and this test used
   * to assert the opposite.
   *
   * T7 added `chat.runtimeSwitch.carryNativePi` because `carryNative` ended
   * "…which the model cannot open" — a claim about the TARGET's read tool that
   * T7 believed true on Claude and false on Pi. It is false on **both**:
   * `tools-reference.md#read-tool-behavior` says verbatim *"**Images**: PNG,
   * JPG, and other image formats are returned as visual content that Claude can
   * see, not as raw bytes"*, and the pinned Pi SDK's own `read` tool says the
   * same (`pi-coding-agent/dist/core/tools/read.js:136`). A key whose whole
   * reason for existing was a false premise has nothing left to say, so the two
   * collapsed and the SURVIVING text is T7's, which was already true.
   *
   * The two strings were not "identical but for the image clause" — T7's opener
   * also says the conversation crosses "as its own history". The merged line
   * keeps it, and it is true of both targets that reach this key:
   * `NATIVE_HISTORY_CARRY_IMPLEMENTED` is `true` for `pi` and `anthropic` only,
   * Codex takes its own key, and `nestor-cloud-agent` is refused as a switch
   * target before the plan is consulted.
   */
  it('gives Pi and Claude ONE native carry line, and only Codex a different one', () => {
    expect(runtimeSwitchCopyKey('connection-cross-runtime', true, 'native', 'pi')!.carryKey)
      .toBe('chat.runtimeSwitch.carryNative')
    expect(runtimeSwitchCopyKey('connection-cross-runtime', true, 'native', 'anthropic')!.carryKey)
      .toBe('chat.runtimeSwitch.carryNative')
    expect(runtimeSwitchCopyKey('connection-cross-runtime', true, 'text', 'pi')!.carryKey)
      .toBe('chat.runtimeSwitch.carryText')
    expect(runtimeSwitchCopyKey('connection-cross-runtime', true, 'anchor', 'pi')!.carryKey)
      .toBe('chat.runtimeSwitch.carryAnchor')
    // TWO distinct native promises, not three: the host-side carry and Codex's,
    // which still differs — over model-visible history and reasoning items, no
    // longer over attachments (P2.507).
    const natives = (['pi', 'anthropic', 'codex-runtime'] as const)
      .map(runtime => runtimeSwitchCopyKey('connection-cross-runtime', true, 'native', runtime)!.carryKey)
    expect(new Set(natives).size).toBe(2)
  })

  /**
   * The removal has to be COMPLETE, and neither i18n lint can say so: parity
   * compares the locales against each other, so a stale key left in both passes
   * it, and sorting is indifferent to a key nothing reads. This is the assertion
   * that fails if `carryNativePi` is resurrected in one locale or left in both.
   *
   * The second half is the defect itself rather than its bookkeeping: the
   * sentence the row refuted must be gone from the shipped catalogue, in both
   * languages, and the positive control below proves the file was actually read.
   */
  it('ships no carryNativePi in either locale, and no "cannot open" claim', () => {
    const load = (name: string) => JSON.parse(readFileSync(
      fileURLToPath(new URL(`../../../../../../../../packages/shared/src/i18n/locales/${name}.json`, import.meta.url)),
      'utf8',
    )) as Record<string, string>
    const en = load('en')
    const ru = load('ru')
    for (const messages of [en, ru]) {
      expect(messages['chat.runtimeSwitch.carryNativePi']).toBeUndefined()
      // POSITIVE CONTROL — an emptied or moved catalogue would satisfy the
      // absence above for the wrong reason.
      expect(messages['chat.runtimeSwitch.carryNative']).toBeTruthy()
    }
    expect(en['chat.runtimeSwitch.carryNative']).not.toContain('cannot open')
    expect(ru['chat.runtimeSwitch.carryNative']).not.toContain('не сможет')
    // What replaced it: the loss is still NAMED, it is just named truthfully.
    expect(en['chat.runtimeSwitch.carryNative']).toContain('file paths')
  })

  /**
   * P2.507 · the Codex line told the user their image attachments stay behind,
   * and they have not since P3.102.
   *
   * `carryNativeCodex` ended *"What stays behind: the model's own reasoning
   * from before the switch, and image attachments."* The second half was
   * justified by a comment in `runtime-switch-copy.ts` reading *"Codex's inject
   * crosses no attachment at all"*. P3.102 passes `attachmentBlock` on EVERY
   * plan and EVERY target — `runtime-handoff.ts` says *"P3.102 passes the hook
   * on every plan and every target, so Codex has received this block since that
   * landed"* — and Codex opens the pointer with `view_image`, measured against
   * the shipped binary at `rust-v0.148.0` (P3.116, `config-writer.ts`). So the
   * user was told they would lose something they keep, on the one runtime where
   * the on-demand route is least proven.
   *
   * The invariant this pins is not the wording but the AGREEMENT: an image
   * crosses the same way on all three runtimes, so both native carry lines must
   * make the SAME image promise, in both languages. Rewording one and not the
   * other is the divergence that produced this defect, and it fails here.
   *
   * The routing tests above cannot see this — they assert which KEY is chosen,
   * and the defect was entirely in the key's VALUE. Neither i18n lint can see
   * it either: parity compares the locales to each other and sorting is
   * indifferent to what a string claims.
   */
  /**
   * P6.87 · every carry line that describes a HANDOVER names the reasoning it
   * leaves behind — and the three cells the ledger scored `honest_surface:
   * missing` were not all missing.
   *
   * Measured at HEAD before building: `carryNativeCodex` has carried *"What
   * stays behind: the model's own reasoning from before the switch"* since
   * P2.507, so one of the four carry lines already said it and three did not.
   * The drop itself is ours and is made in three places by decision —
   * `RuntimeHandoffRow` declares `isIntermediate` and no `isThinking`, the
   * claude event adapter discards the attestation, and codex's inject builder
   * excludes reasoning items in a comment carrying its own reason — while the
   * gateway leg drops them regardless. None of that reached the user on the two
   * lines a Pi or Claude target actually gets.
   *
   * `carryAnchor` is DELIBERATELY not in this list, and the exclusion is the
   * assertion's other half: an anchored target resumes its own session file, so
   * the reasoning it recorded during its previous stint is still there, and
   * saying it "stays behind" would be false in the one direction where it is
   * not lost. Only the missed span crosses as text, which that line says.
   *
   * Neither i18n lint can see any of this — parity compares the locales to each
   * other and sorting is indifferent to what a string claims — and the routing
   * tests above assert which KEY is chosen, never the key's VALUE.
   */
  it('names the reasoning left behind on every handover line, and not on the anchor line', () => {
    const load = (name: string) => JSON.parse(readFileSync(
      fileURLToPath(new URL(`../../../../../../../../packages/shared/src/i18n/locales/${name}.json`, import.meta.url)),
      'utf8',
    )) as Record<string, string>
    const en = load('en')
    const ru = load('ru')
    for (const key of [
      'chat.runtimeSwitch.carryNative',
      'chat.runtimeSwitch.carryNativeCodex',
      'chat.runtimeSwitch.carryText',
    ]) {
      // POSITIVE CONTROL first: an absent key would satisfy a `toContain` on
      // `undefined` with a thrown error rather than a legible failure.
      expect(en[key], `en is missing ${key}`).toBeTruthy()
      expect(ru[key], `ru is missing ${key}`).toBeTruthy()
      expect(en[key], `${key} does not name the reasoning left behind`).toContain('reasoning')
      // Lowercased: the clause opens the sentence on one line and closes it on
      // another, so the stem is capitalised in one locale string and not the other.
      expect(ru[key]!.toLowerCase(), `${key} (ru) does not name the reasoning left behind`).toContain('рассужд')
    }
    expect(en['chat.runtimeSwitch.carryAnchor']).not.toContain('reasoning')
    expect(ru['chat.runtimeSwitch.carryAnchor']!.toLowerCase()).not.toContain('рассужд')
  })

  it('makes the same image promise on both native carry lines', () => {
    const load = (name: string) => JSON.parse(readFileSync(
      fileURLToPath(new URL(`../../../../../../../../packages/shared/src/i18n/locales/${name}.json`, import.meta.url)),
      'utf8',
    )) as Record<string, string>
    const en = load('en')
    const ru = load('ru')
    const shared = 'chat.runtimeSwitch.carryNative'
    const codex = 'chat.runtimeSwitch.carryNativeCodex'

    // POSITIVE CONTROL — an emptied or moved catalogue would satisfy every
    // absence below for the wrong reason.
    for (const key of [shared, codex]) {
      expect(en[key]).toBeTruthy()
      expect(ru[key]).toBeTruthy()
    }

    // The one image promise, shared. Keeping the two in step is the point: if a
    // later row rewords the shared clause, this fails until the Codex line is
    // reworded with it.
    const imagesEn = 'Image attachments cross as file paths rather than as images'
    const imagesRu = 'Картинки передаются как пути к файлам, а не как изображения'
    expect(en[shared]).toContain(imagesEn)
    expect(en[codex]).toContain(imagesEn)
    expect(ru[shared]).toContain(imagesRu)
    expect(ru[codex]).toContain(imagesRu)

    // The refuted clause, in both languages. These are the two sentences the
    // Codex user actually read.
    expect(en[codex]).not.toContain('and image attachments')
    expect(ru[codex]).not.toContain('вложенные картинки')

    // What genuinely still separates the Codex line survives, or the key has
    // nothing left to say and should have been folded into the shared one.
    expect(en[codex]).toContain('model-visible history')
    expect(en[codex]).toContain('reasoning')
    expect(ru[codex]).toContain('видимая модели история')
    expect(ru[codex]).toContain('рассуждения')
  })

  // The caller that only asks "is there copy for this tier at all?"
  // (`ConnectionRow`, deciding whether to open a dialog) passes no runtime, and
  // must keep getting the shared, runtime-neutral answer.
  it('falls back to the shared copy when no target runtime is named', () => {
    const copy = runtimeSwitchCopyKey('connection-cross-runtime', true, 'native')!
    expect(copy.bodyKey).toBe('chat.runtimeSwitch.crossRuntimeBody')
    expect(copy.carryKey).toBe('chat.runtimeSwitch.carryNative')
  })
})

/**
 * P3.266 — the modal now says WHY it is degrading, not only that it is.
 *
 * The behaviour under test is a distinction: three ways of ending up on the text
 * tail that a user would answer differently, and which the dialog collapsed into
 * one silent outcome. So the cases below assert that the three DIFFER, not merely
 * that each returns something.
 */
describe('the switch modal names the reason it degraded (P3.266)', () => {
  const cross = (plan: 'native' | 'anchor' | 'text', reason: HistoryCarryReason) =>
    runtimeSwitchCopyKey('connection-cross-runtime', true, plan, 'anthropic', reason)!

  /** KILLS: one shared "we could not carry it" line for three different causes. */
  it('gives each degrading reason its own line, all distinct', () => {
    const keys = (['no-native-carry-implemented', 'context-window-unknown', 'context-window-unenforced', 'does-not-fit'] as const)
      .map(reason => cross('text', reason).reasonKey)
    expect(keys.every(key => key !== null)).toBe(true)
    expect(new Set(keys).size).toBe(keys.length)
    // Every one of them is a key the locale files must carry.
    for (const key of keys) expect(RUNTIME_SWITCH_REASON_KEYS).toContain(key!)
  })

  /**
   * KILLS: a sentence explaining a degradation that did not happen. `fits` is
   * the `native` arm and `target-already-anchored` is already the whole of
   * `carryAnchor`, so a line under either would restate or contradict the
   * promise above it.
   */
  it('says nothing when the plan is not a degradation', () => {
    expect(cross('native', 'fits').reasonKey).toBeNull()
    expect(cross('anchor', 'target-already-anchored').reasonKey).toBeNull()
  })

  /**
   * KILLS: a reason surviving without the carry line it explains. The two are
   * one decision on the server; a modal that shows the explanation for a promise
   * it is not making is worse than one that shows neither.
   */
  it('withholds the reason whenever the carry line is withheld', () => {
    expect(runtimeSwitchCopyKey('connection-cross-runtime', true, null, 'anthropic', 'does-not-fit')!.reasonKey)
      .toBeNull()
    expect(runtimeSwitchCopyKey('connection-cross-runtime', true, undefined, 'anthropic', 'does-not-fit')!.reasonKey)
      .toBeNull()
    expect(runtimeSwitchCopyKey('connection-same-runtime', true, 'text', 'anthropic', 'does-not-fit')!.reasonKey)
      .toBeNull()
  })

  /**
   * KILLS: the pre-P3.266 wire reaching a post-P3.266 renderer and losing the
   * carry line it used to have. A server that answers the plan and not the
   * reason must render exactly the modal it rendered before.
   */
  it('keeps the carry line when the server named no reason', () => {
    const copy = runtimeSwitchCopyKey('connection-cross-runtime', true, 'text', 'anthropic')!
    expect(copy.carryKey).toBe('chat.runtimeSwitch.carryText')
    expect(copy.reasonKey).toBeNull()
  })

  /**
   * KILLS: a key shipped in the module and missing from a locale — the failure
   * i18next answers with the raw key on a confirmation dialog.
   */
  it('ships every reason key in both locales', async () => {
    const en = await import('@nessy-agent/shared/i18n/locales/en.json')
    const ru = await import('@nessy-agent/shared/i18n/locales/ru.json')
    expect(RUNTIME_SWITCH_REASON_KEYS.length).toBeGreaterThan(0)
    for (const key of RUNTIME_SWITCH_REASON_KEYS) {
      expect((en as Record<string, unknown>)[key] ?? (en.default as Record<string, unknown>)[key], `en.json is missing ${key}`)
        .toBeTruthy()
      expect((ru as Record<string, unknown>)[key] ?? (ru.default as Record<string, unknown>)[key], `ru.json is missing ${key}`)
        .toBeTruthy()
    }
  })
})

describe('parseRuntimeSwitchMarker', () => {
  it('turns the persisted marker into two runtime labels', async () => {
    const { parseRuntimeSwitchMarker } = await import('../runtime-switch-copy')
    expect(parseRuntimeSwitchMarker('runtime_switched:pi:anthropic'))
      .toEqual({ from: 'Pi', to: 'Claude' })
    expect(parseRuntimeSwitchMarker('runtime_switched:anthropic:codex-runtime'))
      .toEqual({ from: 'Claude', to: 'Codex' })
  })

  // Negative subject: every other `info` row in the transcript must fall
  // through to the ordinary notice renderer. A parser that matched loosely
  // would silently replace unrelated rows with a switch divider.
  it('does not claim an ordinary info row', async () => {
    const { parseRuntimeSwitchMarker } = await import('../runtime-switch-copy')
    expect(parseRuntimeSwitchMarker('Session mirror error: disk full')).toBeNull()
    expect(parseRuntimeSwitchMarker('the runtime_switched: word mid-sentence')).toBeNull()
    expect(parseRuntimeSwitchMarker('runtime_switched:pi')).toBeNull()
  })
})

/**
 * R1 · the marker's JSON tail, and the compatibility it is shaped around.
 *
 * The transcript is DURABLE and read by more than one client, so both
 * directions have to hold at once: a row written before R1 must render the copy
 * it has always rendered, and a row written by a newer server must not break a
 * reader that does not know its tail. D3's implementation note is the reason
 * the tail is JSON appended after the two segments rather than a fourth
 * colon-delimited field — `[from, to]` stays exactly where it was.
 */
describe('the switch marker says what crossed (R1)', () => {
  it('reads the carry out of the JSON tail, without disturbing the two segments', async () => {
    const { parseRuntimeSwitchMarker } = await import('../runtime-switch-copy')
    expect(parseRuntimeSwitchMarker('runtime_switched:pi:anthropic:{"carry":"native"}'))
      .toEqual({ from: 'Pi', to: 'Claude', carry: 'native' })
    expect(parseRuntimeSwitchMarker('runtime_switched:anthropic:codex-runtime:{"carry":"text"}'))
      .toEqual({ from: 'Claude', to: 'Codex', carry: 'text' })
    expect(parseRuntimeSwitchMarker('runtime_switched:codex-runtime:pi:{"carry":"anchor"}'))
      .toEqual({ from: 'Codex', to: 'Pi', carry: 'anchor' })
  })

  /**
   * BACKWARD COMPAT, the half that is easy to lose. Every switch notice already
   * in a user's transcript carries no tail, and must keep rendering the exact
   * sentence it rendered yesterday — hence a `carry`-less marker and the
   * ORIGINAL key, not a defaulted one. Guessing `native` here would put a claim
   * in an old row that the switch never made.
   */
  it('leaves a pre-R1 two-segment marker exactly as it was', async () => {
    const { parseRuntimeSwitchMarker, runtimeSwitchNoticeKey } = await import('../runtime-switch-copy')
    const parsed = parseRuntimeSwitchMarker('runtime_switched:pi:anthropic')!
    expect(parsed).toEqual({ from: 'Pi', to: 'Claude' })
    expect('carry' in parsed).toBe(false)
    expect(runtimeSwitchNoticeKey(parsed.carry)).toBe('chat.runtimeSwitch.notice')
  })

  /**
   * A tail this build does not understand degrades to the pre-R1 copy rather
   * than to a broken row. All three arms matter: a newer server may add a field
   * (`{"carry":"native","model":"…"}` is the shape D3 sketches for the model
   * delta), a value may be one this build has no key for, and a truncated row
   * must not throw out of the render path.
   */
  it('ignores a tail it cannot use instead of failing the row', async () => {
    const { parseRuntimeSwitchMarker, runtimeSwitchNoticeKey } = await import('../runtime-switch-copy')
    for (const tail of ['{"carry":"teleport"}', '{"model":"tgpt/qwen"}', '{not json', '']) {
      const parsed = parseRuntimeSwitchMarker(`runtime_switched:pi:anthropic:${tail}`)
      expect(parsed?.from).toBe('Pi')
      expect(parsed?.to).toBe('Claude')
      expect(runtimeSwitchNoticeKey(parsed?.carry)).toBe('chat.runtimeSwitch.notice')
    }
    // POSITIVE CONTROL — the same shape with a value this build DOES know is
    // taken, so the three refusals above are the tail and not the parser.
    const good = parseRuntimeSwitchMarker('runtime_switched:pi:anthropic:{"carry":"native","model":"tgpt/qwen"}')
    expect(good?.carry).toBe('native')
  })

  /**
   * A model id may contain `:` under our own charset (D3's note), which is what
   * kills a `split(':')` parser the moment the tail carries one. Pinned now, on
   * the shape the tail is already permitted to grow into, rather than after it
   * has shipped.
   */
  it('survives a colon inside the tail', async () => {
    const { parseRuntimeSwitchMarker } = await import('../runtime-switch-copy')
    expect(parseRuntimeSwitchMarker('runtime_switched:pi:anthropic:{"carry":"text","model":"a:b:c"}'))
      .toEqual({ from: 'Pi', to: 'Claude', carry: 'text' })
  })

  /**
   * One key per outcome family, and three DIFFERENT ones. A map that answered
   * the same key twice would pass every assertion above while leaving two of
   * the three outcomes unnamed — which is the state R1 exists to end.
   */
  it('names a different notice for each outcome, and none of them is the old one', async () => {
    const { runtimeSwitchNoticeKey } = await import('../runtime-switch-copy')
    const keys = (['native', 'anchor', 'text'] as const).map(runtimeSwitchNoticeKey)
    expect(new Set(keys).size).toBe(3)
    expect(keys).not.toContain('chat.runtimeSwitch.notice')
  })

  /**
   * The keys have to EXIST, and the parity/sorted lints cannot say so: parity
   * compares the locales against each other, so a key absent from both passes.
   * i18next would then render the key name itself into the transcript divider.
   * Both interpolation slots are checked too — the anchor line uses `{{to}}`
   * twice, and a copy edit that dropped one would leave the sentence
   * grammatical and wrong.
   */
  it('resolves every notice key in the shipped English catalogue', async () => {
    const { runtimeSwitchNoticeKey } = await import('../runtime-switch-copy')
    const en = JSON.parse(readFileSync(
      fileURLToPath(new URL('../../../../../../../../packages/shared/src/i18n/locales/en.json', import.meta.url)),
      'utf8',
    )) as Record<string, string>
    for (const carry of [undefined, 'native', 'anchor', 'text'] as const) {
      const value = en[runtimeSwitchNoticeKey(carry)]
      expect(value).toBeTruthy()
      expect(value).toContain('{{from}}')
      expect(value).toContain('{{to}}')
    }
  })
})

describe('classifyConnectionSwitch', () => {
  it('is a model change when the connection does not move', async () => {
    const { classifyConnectionSwitch } = await import('../runtime-switch-copy')
    expect(classifyConnectionSwitch({ slug: 'a', runtime: 'pi' }, { slug: 'a', runtime: 'pi' }))
      .toBe('model')
  })

  it('is same-runtime when two connections share a runtime', async () => {
    const { classifyConnectionSwitch } = await import('../runtime-switch-copy')
    expect(classifyConnectionSwitch({ slug: 'a', runtime: 'anthropic' }, { slug: 'b', runtime: 'anthropic' }))
      .toBe('connection-same-runtime')
  })

  it('is cross-runtime when the runtime changes', async () => {
    const { classifyConnectionSwitch } = await import('../runtime-switch-copy')
    expect(classifyConnectionSwitch({ slug: 'a', runtime: 'pi' }, { slug: 'b', runtime: 'codex-runtime' }))
      .toBe('connection-cross-runtime')
  })
})
