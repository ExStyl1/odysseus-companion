/**
 * DA2.23 — the two lines under a model list are ONE block, and BOTH pickers
 * render it.
 *
 * ## What this suite exists to catch
 *
 * RS-44 measured, on the packaged 1.39.0, that `FreeFormInput`'s desktop
 * `DropdownMenu` picker rendered NEITHER `model-list-provenance` nor
 * `model-target-tool-egress` while the compact picker rendered both for the same
 * card in the same minute. The mechanism worked; one of the two components did
 * not call it. So the invariant is not "the classifier answers" — the suite
 * beside this one (`lib/__tests__/model-target-disclosure.test.ts`) already pins
 * that — it is **rendered, in both pickers, from one source**.
 *
 * Rendering is `renderToStaticMarkup` against a real i18next instance built from
 * the shipped `en.json`, the pattern `PendingAuthNotice.test.tsx` established: no
 * DOM, no `@testing-library`, and the REAL copy, so a key that stopped resolving
 * fails here instead of shipping as a raw key under a model list.
 *
 * The last block is the anti-COPY guard and it reads source text on purpose. The
 * row's whole decision was *lift, do not duplicate* — two copies of a privacy
 * notice drift, and a notice that says different things in two widths of the
 * same window is worse than one missing from both. Nothing else in this tree can
 * fail the day someone pastes a second copy into a picker.
 */

import * as React from 'react'
import { beforeAll, describe, expect, it } from 'bun:test'
import { createInstance, type i18n as I18nInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { renderToStaticMarkup } from 'react-dom/server'
import en from '@nessy-agent/shared/i18n/locales/en.json'
import { NESSY_GATEWAY_BASE_URL } from '../../../apisetup/nessy-gateway'
import type { PickerMode } from '../picker-mode'
import {
  ModelListDisclosures,
  type ModelListDisclosureVariant,
} from '../ModelListDisclosures'

const COMPACT_PICKER = new URL('../CompactModelSelector.tsx', import.meta.url).pathname
/**
 * D1.214 — the desktop picker's menu left `FreeFormInput.tsx` and became a
 * component of its own, so it could have a playground harness. This constant
 * followed it, and the case below gains the composer as a THIRD read: the point
 * of that row was that there is now exactly ONE desktop menu, so the composer
 * must no longer spell any of this itself. UB14.30 renamed the file to
 * v0.15.1's `ComposerModelMenu.tsx` (it now owns the trigger too).
 */
const DESKTOP_PICKER = new URL('../ComposerModelMenu.tsx', import.meta.url).pathname
const COMPOSER = new URL('../FreeFormInput.tsx', import.meta.url).pathname
const SHARED_BLOCK = new URL('../ModelListDisclosures.tsx', import.meta.url).pathname

const EGRESS_TESTID = 'data-testid="model-target-tool-egress"'
const PROVENANCE_TESTID = 'data-testid="model-list-provenance"'
const WITHHOLDING_TESTID = 'data-testid="model-target-tool-withholding"'
const TRANSLATED_NOTE_TESTID = 'data-testid="model-translated-note"'
const TRANSLATED_MARK_TESTID = 'data-testid="model-translated-mark"'

/** A `claude-runtime` card: one connection, both wires, decided per model. */
const CLAUDE_RUNTIME = { providerType: 'claude-runtime', baseUrl: 'https://vendor.example.org/v1' }

/** A third-party endpoint serving a known external vendor namespace. */
const BYO = { providerType: 'pi_compat', baseUrl: 'https://vendor.example.org/v1' }
/** The verified corporate gateway — the one target that owes no disclosure. */
const GATEWAY = { providerType: 'pi_compat', baseUrl: NESSY_GATEWAY_BASE_URL }
/**
 * One model id for BOTH arms, so the gateway control cannot pass by accident:
 * the id names an external vendor namespace, which is exactly what makes the
 * BYO arm disclose. If the gateway arm still stays silent, the endpoint is the
 * difference and nothing else is.
 */
const VENDOR_MODEL = 'anthropic/claude-opus'

let testI18n: I18nInstance

beforeAll(async () => {
  testI18n = createInstance()
  await testI18n.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    resources: { en: { translation: en as Record<string, string> } },
    interpolation: { escapeValue: false },
  })
})

function render(params: {
  pickerMode?: PickerMode
  connection: { providerType?: string; baseUrl?: string } | null
  currentModel?: string
  models?: readonly (string | { readonly wire?: 'anthropic-messages' })[]
  variant?: ModelListDisclosureVariant
}): string {
  return renderToStaticMarkup(
    <I18nextProvider i18n={testI18n}>
      <ModelListDisclosures
        pickerMode={params.pickerMode ?? 'flat'}
        connection={params.connection}
        currentModel={params.currentModel ?? VENDOR_MODEL}
        // The default is a list of stored entries carrying an explicit
        // `anthropic-messages` wire, i.e. the arm that must NOT raise DA2.25's
        // note — so every case above it stays about the line it names.
        models={params.models ?? [{ wire: 'anthropic-messages' }]}
        variant={params.variant ?? 'drawer'}
      />
    </I18nextProvider>,
  )
}

describe('the shared disclosure block renders both lines (DA2.23)', () => {
  it('names the parsed host on the egress line and the endpoint on the provenance line', () => {
    const html = render({ connection: BYO })

    expect(html).toContain(PROVENANCE_TESTID)
    expect(html).toContain(EGRESS_TESTID)
    // Twice: once in each sentence. The host is PARSED — a path or a query
    // string can never reach either line.
    expect(html).toContain('vendor.example.org')
    expect(html).not.toContain('/v1')
  })

  it('says what is WITHHELD beside what is SENT, on the same condition (DA1.69)', () => {
    // The two lines are one decision. DA2.14 answered the owner question and
    // DA2.2's pool filter landed, so a restricted target now really does lose
    // every non-whitelisted MCP and api-transport server before `pool.sync`
    // (`applyExternalModelMcpWhitelist`) — and a user told only the SEND half
    // would read the picker as "everything goes there", which is false in the
    // direction that alarms.
    //
    // They share the classifier's own condition rather than testing twice: the
    // host gate is `modelTargetWithholdsMcpServers(v)` (`v.restricted === true`)
    // and `modelTargetDisclosure()` returns `null` on exactly
    // `!verdict.restricted`. Asserted as an ORDER, not just a presence, because
    // "what is sent" before "what is not" is the only sequence that reads.
    const html = render({ connection: BYO })

    expect(html).toContain(WITHHOLDING_TESTID)
    expect(html.indexOf(EGRESS_TESTID)).toBeLessThan(html.indexOf(WITHHOLDING_TESTID))
    // COUNT-FREE by construction: this component holds no server list, so a
    // number here could only come from a prop neither picker has, and a number
    // that can be wrong is worse than none where the reader is deciding whether
    // to trust the model with their tools. Sliced from the tag's `>` and not
    // from the testid, because the class attribute carries digits of its own
    // (`text-[11px]`, `pt-2`) — the first draft of this line asserted over them
    // and failed on correct copy.
    const fromTestid = html.slice(html.indexOf(WITHHOLDING_TESTID))
    const text = fromTestid.slice(fromTestid.indexOf('>') + 1, fromTestid.indexOf('</p>'))
    expect(text.length).toBeGreaterThan(0)
    expect(text).not.toMatch(/\d/)
  })

  it('renders the SAME block for either variant, differing only in how it wraps', () => {
    // `StyledDropdownMenuContent` is `w-fit whitespace-nowrap` and `white-space`
    // INHERITS, so an unwrapped sentence would set the width of the whole menu —
    // the trap `FreeFormInput` already records twice for model descriptions.
    // This is the boundary arm of the pair above, not a second styling opinion.
    const menu = render({ connection: BYO, variant: 'menu' })
    const drawer = render({ connection: BYO, variant: 'drawer' })

    expect(menu).toContain('whitespace-normal')
    expect(menu).toContain('max-w-[380px]')
    expect(drawer).not.toContain('whitespace-normal')
    // Both still carry both lines: the variant decides the wrapping and nothing
    // about what is said.
    for (const html of [menu, drawer]) {
      expect(html).toContain(PROVENANCE_TESTID)
      expect(html).toContain(EGRESS_TESTID)
    }
  })
})

describe('the controls — an absence that is the product being right', () => {
  it('the verified gateway owes NO egress line, and still says where its list came from', () => {
    // RS-44's own control, taken here on the same instrument as the positive
    // above. The provenance line is what makes this a reading rather than a
    // blank render: the block DID render, and the one line missing is the one
    // the classifier declined to owe.
    const html = render({ connection: GATEWAY })

    expect(html).toContain(PROVENANCE_TESTID)
    expect(html).not.toContain(EGRESS_TESTID)
    // DA1.69's negative, and it is the one that matters most: the gateway
    // withholds nothing, so a line claiming a withholding there would be false
    // about the product. Same predicate as the egress line, so the two can
    // never part company — this arm is what would fail if someone gave the
    // withholding line a condition of its own.
    expect(html).not.toContain(WITHHOLDING_TESTID)
  })

  it('renders NOTHING outside `flat`, for the very connection that discloses in it', () => {
    // The two modes that are not showing a list: `unavailable` has no connection
    // to describe and `locked-single` is the one-model form. Driven with the BYO
    // connection so the absence is the MODE — RS-44's field discriminator makes
    // the same distinction on the rendered DOM.
    for (const pickerMode of ['locked-single', 'unavailable'] as const) {
      const html = render({ connection: BYO, pickerMode })

      expect(html).toBe('')
    }
  })
})

describe('one block, never two copies (DA2.23)', () => {
  it('both pickers render the shared component and neither spells a testid of its own', async () => {
    const [compact, desktop, shared] = await Promise.all([
      Bun.file(COMPACT_PICKER).text(),
      Bun.file(DESKTOP_PICKER).text(),
      Bun.file(SHARED_BLOCK).text(),
    ])

    // The positive control of this case: the testids exist somewhere, so the
    // two `not.toContain` below cannot be satisfied by deleting the feature.
    expect(shared).toContain(PROVENANCE_TESTID)
    expect(shared).toContain(EGRESS_TESTID)
    expect(shared).toContain("t('chat.modelPicker.toolEgressDisclosure'")

    for (const picker of [compact, desktop]) {
      expect(picker).toContain('<ModelListDisclosures')
      expect(picker).not.toContain(PROVENANCE_TESTID)
      expect(picker).not.toContain(EGRESS_TESTID)
    }

    // D1.214 — and the composer renders the desktop menu rather than a second
    // copy of it, so "both pickers" is still exactly two.
    const composer = await Bun.file(COMPOSER).text()
    expect(composer).toContain('<ComposerModelMenu')
    expect(composer).not.toContain('<ModelListDisclosures')
  })

  /**
   * D1.162 — the provenance label PER ENTRY, in BOTH pickers.
   *
   * Ledger K34 is `partial` because C3.346 built the list-level sentence and the
   * page's rule is per entry. The per-row mark is the other half, and it lives
   * where DA2.25's translated mark does — inside each model button, which is why
   * it cannot move into the shared block that renders once under the list.
   *
   * Asserted as a PAIR with a positive control, for the reason the case above
   * is: two pickers that each carry a mark of their own could still carry
   * different ones, and the failure this whole file exists for is "the two
   * pickers disagree".
   */
  it('both pickers carry the per-entry catalogue mark, and the shared block does not', async () => {
    const [compact, desktop, shared] = await Promise.all([
      Bun.file(COMPACT_PICKER).text(),
      Bun.file(DESKTOP_PICKER).text(),
      Bun.file(SHARED_BLOCK).text(),
    ])
    for (const picker of [compact, desktop]) {
      expect(picker).toContain('data-testid="model-catalogue-unlisted"')
      // Read through the predicate rather than off `catalogueListed` directly,
      // so neither picker can render `undefined` as "not listed" — the third
      // value, and the one a hand-rolled `!model.catalogueListed` gets wrong.
      expect(picker).toContain('modelCatalogueMark(')
      expect(picker).not.toContain('catalogueListed')
    }
    // The control, and the boundary: it is a ROW mark, so the block that renders
    // once under the whole list must never spell it.
    expect(shared).not.toContain('data-testid="model-catalogue-unlisted"')
    expect(shared).toContain(PROVENANCE_TESTID)
  })
})
/**
 * DA2.25 — the translated-wire mark and note had the identical desktop absence
 * DA2.23 fixed for the two disclosure lines, and they are NOT one lift.
 *
 * The NOTE is list-level and moves into the shared block, which is what these
 * render cases pin. The MARK renders inside each model BUTTON, one per row, so
 * it cannot live in a component that renders once under the whole list — it is
 * a separate edit at each picker's row site, and the source case below is the
 * only thing that can see whether the desktop picker still has it.
 */
describe('the translated-wire note joins the shared block (DA2.25)', () => {
  it('raises the note when the list holds a model reached through a translated wire', () => {
    // A bare id on a `claude-runtime` connection: `models.ts` settles absence as
    // chat-completions, so this IS translated — the same answer a stored entry
    // with no `wire` gives, which is why the row mark and this note read one
    // predicate rather than two.
    const html = render({ connection: CLAUDE_RUNTIME, models: ['vendor/some-model'] })

    expect(html).toContain(TRANSLATED_NOTE_TESTID)
    // FIRST, above the provenance: it explains a mark the reader has just seen
    // in the rows above, and that is the order the compact picker already had.
    expect(html.indexOf(TRANSLATED_NOTE_TESTID)).toBeLessThan(html.indexOf(PROVENANCE_TESTID))
  })

  it('and stays silent on a list whose models are all native — two controls', () => {
    // (1) The same connection, every model carrying the native wire.
    expect(render({ connection: CLAUDE_RUNTIME, models: [{ wire: 'anthropic-messages' }] }))
      .not.toContain(TRANSLATED_NOTE_TESTID)
    // (2) A bare id, which arm (1) would raise, on a connection that is not
    //     `claude-runtime` — so the predicate is reading the connection too and
    //     not merely the shape of the entry.
    expect(render({ connection: BYO, models: ['vendor/some-model'] }))
      .not.toContain(TRANSLATED_NOTE_TESTID)
    // The positive control for both: the block really did render. Without it a
    // component that returned nothing at all would satisfy the two above.
    expect(render({ connection: BYO, models: ['vendor/some-model'] })).toContain(PROVENANCE_TESTID)
  })

  it('carries the block own flat-only rule rather than a second copy of it', () => {
    for (const pickerMode of ['locked-single', 'unavailable'] as const) {
      expect(render({ connection: CLAUDE_RUNTIME, models: ['vendor/some-model'], pickerMode }))
        .toBe('')
    }
  })

  it('the note has ONE home and the mark has two, which is the whole shape of this row', async () => {
    const [compact, desktop, shared] = await Promise.all([
      Bun.file(COMPACT_PICKER).text(),
      Bun.file(DESKTOP_PICKER).text(),
      Bun.file(SHARED_BLOCK).text(),
    ])

    // The note: in the shared block, in neither picker. The positive control is
    // the first assertion — without it the two `not.toContain` would pass on a
    // tree where the note had simply been deleted.
    expect(shared).toContain(TRANSLATED_NOTE_TESTID)
    expect(compact).not.toContain(TRANSLATED_NOTE_TESTID)
    expect(desktop).not.toContain(TRANSLATED_NOTE_TESTID)

    // The mark: per ROW, so both pickers spell it and the shared block never
    // does. This is the assertion that fails the day someone "finishes the
    // lift" by moving the mark too — it renders inside a model button and the
    // block renders once under the list.
    expect(compact).toContain(TRANSLATED_MARK_TESTID)
    expect(desktop).toContain(TRANSLATED_MARK_TESTID)
    expect(shared).not.toContain(TRANSLATED_MARK_TESTID)

    // And the gate the note must NOT bring with it: the block owns `flat`, so a
    // picker repeating it beside the call is the duplication DA2.23 removed.
    for (const picker of [compact, desktop]) {
      expect(picker).toContain('<ModelListDisclosures')
      expect(picker).not.toContain("pickerMode === 'flat' && availableModels.some(")
    }
  })
})
