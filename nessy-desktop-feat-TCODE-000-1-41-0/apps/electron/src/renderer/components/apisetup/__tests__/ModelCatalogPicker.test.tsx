/**
 * The BYO model-catalog flow (C3).
 *
 * The picker's grouping is a pure function, so it is tested directly. The wiring
 * around it is asserted structurally: this runner has no DOM, and the form
 * transitively pulls the chain that takes bun's module loader down (the same
 * reason `PendingAuthNotice.test.tsx` reads source). Each case carries a
 * positive control so a moved or emptied file cannot pass as a fix.
 */

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { modelGroupKey } from '../model-catalog'

const sourceOf = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')

const form = sourceOf('../ApiKeyInput.tsx')
const picker = sourceOf('../ModelCatalogPicker.tsx')

describe('modelGroupKey', () => {
  it('groups llm-proxy ids by their family prefix', () => {
    expect(modelGroupKey('tgpt/qwen35-397b-a17b-fp8')).toBe('tgpt')
    expect(modelGroupKey('anthropic/claude-opus-5')).toBe('anthropic')
    // Nested vendor ids keep the OUTER family — that is what `owned_by` reports.
    expect(modelGroupKey('openrouter/google/gemini-3-pro')).toBe('openrouter')
  })

  it('leaves a flat id (a local model) ungrouped rather than inventing a family', () => {
    expect(modelGroupKey('llama3.2')).toBe('')
    // A leading slash is not a family either.
    expect(modelGroupKey('/weird')).toBe('')
  })
})

describe('the fetch action', () => {
  it('asks the existing setup channel for a catalog — no new RPC channel', () => {
    expect(form).toContain('fetchModels: true')
    expect(form).toContain('window.electronAPI.testLlmConnectionSetup')
    // Positive control: the probe rides the SAME channel.
    expect(form).toContain('validateModels: selectedModelIds')
  })

  it('is offered only for an OpenAI-compatible endpoint with a base URL', () => {
    const gate = form.slice(form.indexOf('const canFetchModelCatalog'), form.indexOf('const selectedModelIds'))
    expect(gate).toContain("customApi === 'openai-completions'")
    expect(gate).toContain('!!baseUrl.trim()')
    expect(gate).toContain('!isBedrock')
  })

  it('submits the sync flag only once the toggle has been touched', () => {
    // An untouched edit must leave `modelsSyncedAt` as persisted — sending an
    // unprefilled `false` would silently withdraw an enrolled connection.
    expect(form).toContain('canFetchModelCatalog && syncToggleTouched ? { syncModelsFromEndpoint } : {}')
    expect(form).toContain('setSyncToggleTouched(true)')
  })
})

describe('the picker presents a catalog, not an entitlement list', () => {
  /**
   * REWRITTEN IN G2, and the change of answer is the point.
   *
   * Before: no user-facing catalog string could contain "available" at all,
   * because nothing had checked and the catalog cannot know. That still holds
   * for the RAW catalog — but v2 probes, and a probed model genuinely is or is
   * not available. So the rule narrows rather than disappears: the word may
   * only appear in strings that describe a PROBE RESULT.
   */
  it('says "available" only about a probe result, never about the raw catalog', () => {
    const strings = Object.entries(
      JSON.parse(sourceOf('../../../../../../../packages/shared/src/i18n/locales/en.json')) as Record<string, string>,
    ).filter(([key]) => key.startsWith('apiSetup.modelCatalog.'))

    const PROBE_KEYS = ['unavailableGroup', 'verdict.', 'verdictPending', 'probeProgress']
    const offenders = strings
      .filter(([, value]) => value.toLowerCase().includes('available'))
      .filter(([key]) => !PROBE_KEYS.some(probe => key.includes(probe)))

    expect(strings.length).toBeGreaterThan(0)
    expect(offenders).toEqual([])
    // Positive controls, both halves: the raw-catalog strings still say
    // "published", and the probe-result strings are the ones carrying the word.
    expect(strings.some(([, value]) => value.toLowerCase().includes('published'))).toBe(true)
    expect(strings.some(([key]) => key.endsWith('unavailableGroup'))).toBe(true)
  })

  /**
   * REWRITTEN IN G2. The old rule was "never probe the catalog" — hundreds of
   * requests for a list the user had not pruned. v2 probes the whole catalog
   * BECAUSE it is chunked and streamed, which is what made it affordable; the
   * rule that survives is that the picker itself never issues them.
   */
  it('issues no probe of its own — the form owns the chunking', () => {
    // The picker takes verdicts and progress as data. It has no RPC call, so it
    // cannot be the thing that floods an endpoint.
    expect(picker).not.toContain('testLlmConnectionSetup')
    expect(picker).toContain('probeProgress')
    // Positive control: the LEGACY surface's selection-only button is still
    // offered when a caller passes the callback.
    expect(picker).toContain('onProbeSelected')
    expect(picker).toContain('selectedIds.length === 0')
  })

  it('takes selection through props, so it can be lifted out of this form', () => {
    expect(picker).toContain('onSelectionChange')
    // An IMPORT, not the word: the file's header now names ApiKeyInput as the
    // legacy surface it shares behaviour with, which is documentation rather
    // than a dependency.
    expect(picker).not.toMatch(/^import[^\n]*ApiKeyInput/m)
  })
})

/**
 * G1(b) — the catalog's height cap belongs on the Radix VIEWPORT.
 *
 * Measured live before the fix (300-row loopback catalog, 18 305px of content):
 * with `max-h-64` on the ScrollArea ROOT the viewport's scroll range was 0 —
 * clientHeight and scrollHeight were both 18 305 — while the Root clipped at
 * 240px with `overflow-y: hidden`. 18 065px of catalog with no way to reach it.
 * After the move: viewport range 18 066px at `overflow-y: scroll`, root range 0.
 *
 * A cap on the Root LOOKS right in review, which is why this is a test and not
 * a comment: the Root is `overflow-hidden` with `height: auto`, so the
 * Viewport's `h-full` has no definite parent height to resolve against.
 */
describe('the catalog scroller', () => {
  const scrollArea = sourceOf('../../ui/scroll-area.tsx')
  const entityList = sourceOf('../../ui/entity-list.tsx')
  const byoStep = sourceOf('../../onboarding/ByoRuntimeStep.tsx')

  it('caps the viewport, not the ScrollArea root', () => {
    // The cap moved into a named constant when the placeholder started riding
    // through the same viewport; the load-bearing fact is unchanged — it is on
    // the VIEWPORT, never the Root.
    expect(picker).toContain('viewportClassName={LIST_VIEWPORT}')
    expect(picker).toContain("const LIST_VIEWPORT = 'min-h-64 max-h-64'")
    expect(picker).not.toContain('scrollAreaClassName="max-h-64"')
    // Positive control: the prop exists and reaches the viewport, not the Root.
    expect(entityList).toContain('viewportClassName={viewportClassName}')
    expect(scrollArea).toContain('cn("h-full w-full rounded-[inherit]", viewportClassName)')
  })

  it('keeps the Root overflow-hidden — the reason a cap there only clips', () => {
    expect(scrollArea).toContain('"relative overflow-hidden"')
  })

  it('does not wrap the picker in a second scroller', () => {
    // The outer `max-h-72 overflow-y-auto` was the only travel a user got, and
    // it was the wrapper's ~60px, never the list's.
    expect(byoStep).not.toContain('overflow-y-auto')
    // Positive control: the picker is still rendered by this step.
    expect(byoStep).toContain('<ModelCatalogPicker')
  })
})

/**
 * G2 — availability presentation. Asserted on source because this runner has no
 * DOM (see the file header); each case carries a positive control so a moved or
 * emptied file cannot pass as a fix.
 */
describe('availability grouping', () => {
  it('engages only when verdicts exist, so the legacy surface is untouched', () => {
    expect(picker).toContain('if (!hasVerdicts) return byFamily(matched')
    // Positive control: the family grouping is the SAME function in both
    // presentations, so it cannot drift between them.
    expect(picker).toContain("byFamily(reachable, AVAILABLE_PREFIX)")
  })

  it('treats a not-yet-probed row as pending, never as unavailable', () => {
    // The list must not reshuffle under the cursor while chunks land, and a
    // model nobody has checked has not been refused.
    expect(picker).toContain("probes![m.id] && probes![m.id] !== 'ok'")
    expect(picker).toContain("!probes![m.id] || probes![m.id] === 'ok'")
  })

  it('namespaces the section keys so a family cannot collide with a section', () => {
    expect(picker).toContain("const AVAILABLE_PREFIX = 'avail:'")
    expect(picker).toContain("const UNAVAILABLE_KEY = 'section:unavailable'")
    // Unavailable starts collapsed — it is the part the user did not ask for.
    expect(picker).toContain('useState<Set<string>>(new Set([UNAVAILABLE_KEY]))')
  })

  it('bars an unavailable row from selection while keeping it visible', () => {
    expect(picker).toContain("const unavailable = !!verdict && verdict !== 'ok'")
    expect(picker).toContain('disabled={unavailable}')
    // Positive control: EntityRow honours it rather than silently ignoring the
    // prop — the row stops taking clicks, not just its styling.
    const row = sourceOf('../../ui/entity-row.tsx')
    expect(row).toContain('disabled={disabled}')
    expect(row).toContain('onClick={!onMouseDown && !disabled ? wrappedOnClick : undefined}')
  })

  it('marks all three no-verdicts in red, and distinguishes them by reason', () => {
    // One shared colour, three icons and three separate strings: the user needs
    // "barred" at a glance and WHY on hover. `unsupported-endpoint` is not the
    // same claim as `no-quota` — G3 makes that model reachable on another wire.
    // UB14.40: on v0.15.1's status tints (`*-tint`), no longer a ten-per-cent alpha of the ink.
    for (const verdict of ["'no-quota'", "'unsupported-endpoint'", "'wrong-runtime'", 'error']) {
      expect(picker).toContain(`${verdict}: { colorClass: 'bg-destructive-tint text-destructive'`)
    }
    // Positive control: `ok` is the one that is NOT red.
    expect(picker).toContain("ok: { colorClass: 'bg-success-tint text-success'")
    const en = JSON.parse(sourceOf('../../../../../../../packages/shared/src/i18n/locales/en.json')) as Record<string, string>
    expect(new Set([
      en['apiSetup.modelCatalog.verdict.no-quota'],
      en['apiSetup.modelCatalog.verdict.unsupported-endpoint'],
      en['apiSetup.modelCatalog.verdict.error'],
    ]).size).toBe(3)
  })
})


/**
 * G2 — what the merged form v2 does around the picker. Source-pinned for the
 * same reason as everything above: no DOM in this runner.
 */
describe('the merged form v2', () => {
  const step = sourceOf('../../onboarding/ByoRuntimeStep.tsx')

  it('always stamps the sync on create and never withdraws it on edit', () => {
    // The toggle is gone. `isEditing ? {} : stamp` is the whole rule, and the
    // omission on edit is what the tristate reads as "leave what is persisted".
    expect(step).toContain('...(isEditing ? {} : { modelsSyncedAt: Date.now() }),')
    expect(step).not.toContain('setSyncTouched')
  })

  it('keeps preset, protocol and dialect as state after removing their controls', () => {
    // The controls are gone from the UI; the values still decide the submit.
    // Losing them would silently convert an edited connection.
    expect(step).toContain("const preset: PiEndpointPreset = initialValues?.preset ?? 'custom'")
    expect(step).toContain("const customApi: CustomEndpointApi = initialValues?.customApi ?? 'openai-completions'")
    expect(step).toContain("const dialect: 'auto' | 'qwen' = initialValues?.dialect ?? 'auto'")
    // Positive control: the submit still reads them — E6's forced dialect
    // survives a re-save, which is the only reason the field still exists.
    expect(step).toContain("...(preset === 'custom' && dialect === 'qwen' ? { dialect: 'qwen' as const } : {}),")
    // ...and no control writes any of them any more.
    expect(step).not.toContain('setPreset')
    expect(step).not.toContain('setCustomApi')
    expect(step).not.toContain('setDialect')
  })

  it('sends the slug instead of the mask when editing', () => {
    // `GET_API_KEY` masks for every caller, so the edit path has no key to send
    // — and sending the mask crashes header encoding. The slug lets the server
    // resolve the stored credential itself.
    expect(step).toContain('...(editingSlug ? { slug: editingSlug } : {}),')
    expect(step).toContain('const catalogKeyMissing = !catalogKey && !editingSlug && !isLoopbackBaseUrl(baseUrl)')
    // Positive control: the mask is still never used as a key.
    expect(step).toContain("const catalogKey = isMaskedCredential(apiKey) ? '' : apiKey.trim()")
  })

  it('probes the catalog in bounded chunks, cancellable, without blocking', () => {
    // The handler's Promise.all is unbounded: one full-list call would open a
    // socket per id and throttle itself into 429s the probe would then report
    // as "unavailable".
    expect(step).toContain('const CHUNK = 8')
    expect(step).toContain('for (let offset = 0; offset < ids.length; offset += CHUNK)')
    // Generation guard — a stale chunk drops its results rather than writing
    // them into a list they no longer describe.
    expect(step).toContain('if (probeRun.current !== generation) return')
    expect(step).toContain('useEffect(() => () => { probeRun.current += 1 }, [])')
    // The catalog is on screen before the first probe request goes out, and
    // verdicts merge in as they land.
    expect(step).toContain('setCatalog(fetched)')
    expect(step).toContain('void probeCatalog(fetched.map(model => model.id))')
    expect(step).toContain('setProbes(current => ({ ...current, ...landed }))')
  })

  it('never lets a foreign URL be edited, and submits what was stored', () => {
    expect(step).toContain('const endpoint = resolveEndpointField({ arm, preset, isEditing, storedBaseUrl: initialValues?.baseUrl })')
    expect(step).toContain('const baseUrl = endpoint.value')
    expect(step).toContain('{endpoint.visible && (')
    expect(step).toContain('readOnly')
    // Positive control: there is no setter for it anywhere in the form.
    expect(step).not.toContain('setBaseUrl')
  })
})

/**
 * G2 — a lane-E defect, found by verification rather than by a user.
 *
 * `buildByoRuntimeSetup` has accepted `miniModel` and `modelsSyncedAt` since
 * E1/E2 and the runtime-arm call site passed neither, so a claude/codex BYO
 * connection never enrolled in the 24h metadata sync and its utility-model slot
 * was a no-op. The Pi arm carried both through its delegation the whole time,
 * which is exactly why nobody noticed.
 */
describe('the runtime-arm submit carries every field the builder accepts', () => {
  const hook = sourceOf('../../../hooks/useOnboarding.ts')

  it('passes miniModel and modelsSyncedAt to buildByoRuntimeSetup', () => {
    const call = hook.slice(hook.indexOf('const setup = buildByoRuntimeSetup({'))
    // Closing brace at the call's own indentation — an inner `: {})` would end
    // the slice three lines early and the assertions below would pass on a
    // truncated body.
    const body = call.slice(0, call.indexOf('\n      })'))
    expect(body).toContain("...(data.miniModel !== undefined ? { miniModel: data.miniModel } : {}),")
    expect(body).toContain("...(data.modelsSyncedAt !== undefined ? { modelsSyncedAt: data.modelsSyncedAt } : {}),")
    // Positive control: the fields it already passed are still there.
    expect(body).toContain('editingSlug,')
    expect(body).toContain('existingSlugs,')
  })

  it('keeps both TRISTATE — an undefined field is omitted, not sent as a default', () => {
    // Sending a value for an untouched field is how an edit silently withdraws
    // an enrollment that nobody asked to change.
    expect(hook).not.toContain('miniModel: data.miniModel ?? ')
    expect(hook).not.toContain('modelsSyncedAt: data.modelsSyncedAt ?? ')
  })
})

/**
 * G2 — the editing slug is a CREDENTIAL SELECTOR, so its lifetime matters.
 *
 * Found in the pre-commit pass over this diff, not by a test failing: the slug
 * is what makes the server resolve a stored key, so one left behind from an
 * abandoned edit would have a CREATE-path fetch authenticate as a different
 * connection. Every path that opens the form has to state its own answer.
 */
describe('the editing slug never outlives its edit', () => {
  const hook = sourceOf('../../../hooks/useOnboarding.ts')

  it('is passed in explicitly rather than read from the tick-old hook option', () => {
    // `openApiSetup(slug)` only SCHEDULES the hook's own editingSlug, so it is
    // still the previous value inside the same tick. Measured live 2026-08-14:
    // the Fetch button came up disabled on every first edit.
    expect(hook).toContain('byoRuntimeEditingSlug: args.editingSlug ?? editingSlug,')
    const page = sourceOf('../../../pages/settings/AiSettingsPage.tsx')
    expect(page).toContain('editingSlug: connection.slug,')
  })

  it('is cleared on the create path and on reset', () => {
    const creates = hook.split('byoRuntimeIsEditing: false')
    // Both false-branches (entering create, and reset) clear it.
    expect(creates.length).toBeGreaterThan(2)
    for (const after of creates.slice(1)) {
      expect(after.slice(0, 400)).toContain('byoRuntimeEditingSlug: null')
    }
  })
})

/**
 * The two defects the owner hit on the first live walk of form v2.
 *
 * Both are pinned here rather than in the components' own tests because both
 * are about the FORM the components sit in — neither is visible from either
 * file alone, which is exactly why both shipped.
 */
/**
 * D1.111 — where a `<button` element really BEGINS, prose excluded.
 *
 * Two kinds of mention are not elements and both are in this tree: a `<button>`
 * inside a `/** … *\/` docblock (already excluded before this row) and a
 * `<button>` inside a `//` line comment — `entity-row.tsx` has one INSIDE the
 * element's own attribute list, explaining why the type is required. That second
 * kind is what made the derived bound below necessary to get right rather than
 * merely tighter: the mention sat between the real element and its
 * `type="button"`, so bounding on the next RAW match cut the attribute off and
 * reported a correct button as typeless. The 700-character window this replaced
 * hid that by reading past it.
 */
const buttonElementStarts = (source: string): number[] =>
  [...source.matchAll(/<button\b/g)]
    .map(m => m.index!)
    .filter(i => !source.slice(Math.max(0, i - 120), i).includes('/**'))
    .filter(i => !source.slice(source.lastIndexOf('\n', i) + 1, i).includes('//'))

describe('the live-walk defects', () => {
  const row = sourceOf('../../ui/entity-row.tsx')
  const step = sourceOf('../../onboarding/ByoRuntimeStep.tsx')

  it('gives the row button an explicit type, so a click cannot submit the form', () => {
    // A <button> with no type inside a <form> is type="submit" per HTML. The
    // picker lives inside `<form onSubmit={handleSubmit}>`, so every row click
    // SAVED THE CONNECTION — multi-select was impossible. Nothing had put an
    // EntityRow inside a form until the merged form did.
    const button = row.slice(row.indexOf('<button'), row.indexOf('onMouseDown={disabled'))
    expect(button).toContain('type="button"')
    // Positive control: the file's other buttons already had it, which is what
    // made the omission invisible in review.
    expect(row.match(/type="button"/g)?.length ?? 0).toBeGreaterThanOrEqual(3)
  })

  /**
   * THE FORM-SUBTREE RULE, because file-scoped was not enough.
   *
   * This defect has now landed three times in one day: the model rows, the
   * utility-model Select trigger, and — found by writing this test rather than
   * by a user — the collapsible group header and the empty-state docs link.
   * Every one is a `<button>` with no `type` rendered inside
   * `<form onSubmit={…}>`, which HTML makes a SUBMIT.
   *
   * The runner has no DOM, so "render the tree and check every button" is not
   * available; this is its honest equivalent — the list below is what the form
   * renders, and every button in those files must declare its type. When a new
   * component is dropped into the form, ADD IT HERE.
   */
  const FORM_SUBTREE = [
    '../../onboarding/ByoRuntimeStep.tsx',
    '../../onboarding/primitives.tsx',
    '../ModelCatalogPicker.tsx',
    '../../ui/entity-list.tsx',
    '../../ui/entity-list-empty.tsx',
    '../../ui/entity-row.tsx',
    '../../ui/select.tsx',
    '../../ui/button.tsx',
    '../../ui/input.tsx',
  ]

  it('has no typeless button anywhere in the form subtree', () => {
    const offenders: string[] = []
    for (const relative of FORM_SUBTREE) {
      const source = sourceOf(relative)
      // Scanned by OFFSET: a `<button[\s\S]*?>` regex stops at the `>` inside
      // `React.ButtonHTMLAttributes<HTMLButtonElement>` and reported a FIXED
      // button as typeless. `<button>` inside a doc comment is prose.
      const starts = buttonElementStarts(source)
      // D1.111 — each button is bounded by the NEXT button rather than by 700
      // characters. `bracedRegion` cannot be used on a JSX opening tag (its first
      // `{` is an attribute expression, so the scan would stop inside
      // `className={…}` and report a fixed button as typeless), and the `>` that
      // closes the tag is not findable textually — which is what the comment
      // above already records. The next ELEMENT start IS findable, is derived
      // from the file, and cannot rot.
      for (const [index, i] of starts.entries()) {
        const next = starts[index + 1]
        const tag = source.slice(i, next ?? undefined)
        if (!tag.includes('type="button"')) offenders.push(`${relative}@${i}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('gives the Radix Select trigger an explicit type', () => {
    // Radix renders a real button and whether it stamps `type` is
    // version-dependent; live, it acted as a submit and opening the utility
    // model select saved the connection.
    const select = sourceOf('../../ui/select.tsx')
    const trigger = select.slice(select.indexOf('<SelectPrimitive.Trigger'), select.indexOf('{children}'))
    expect(trigger).toContain('type="button"')
  })

  it('leaves no typeless button anywhere in this file', () => {
    // The broader rule, because this class recurs: every <button> in a
    // component that might be rendered inside a form needs an explicit type.
    //
    // Scanned by OFFSET rather than by matching the whole tag: the row button
    // spreads `buttonProps as React.ButtonHTMLAttributes<HTMLButtonElement>`,
    // and a `<button[\s\S]*?>` regex stops at the `>` inside that type
    // argument — which reported the FIXED button as typeless. The detector was
    // wrong, not the code, and that is worth a comment rather than a rewrite.
    // `<button>` inside a doc comment is prose, not an element.
    const starts = buttonElementStarts(row)
    expect(starts.length).toBeGreaterThan(0)
    // D1.111 — the same derived bound as the subtree sweep above, and the same
    // reason it is not `bracedRegion`.
    const typeless = starts.filter((i, index) => !row.slice(i, starts[index + 1] ?? undefined).includes('type="button"'))
    expect(typeless).toEqual([])
  })

  it('keeps the ORIGINAL form width at all times — no growth, no override', () => {
    // E4 grew the dialog 28rem → 3xl when models arrived and measured that
    // growth as a feature. The owner REVERSED it: the original width is the
    // constant and the form never expands. So the step passes NO width class
    // at all and inherits StepFormLayout's own max width (`max-w-[440px]`
    // since UB14.37 took v0.15.1's paper card; 28rem before — the constant
    // moved with upstream, the no-growth rule did not).
    // Asserted on the JSX, not the file: the comment above the prop names the
    // reverted class, and a bare `not.toContain` fails on its own explanation.
    const layout = step
      .slice(step.indexOf('<StepFormLayout'), step.indexOf('actions={'))
      .split('\n')
      .filter(line => !line.trim().startsWith('//'))
      .join('\n')
    expect(layout).not.toContain('className')
    expect(step).not.toContain('catalog ? "max-w-')
    // Positive control: the layout it inherits from still declares that width,
    // so this test fails loudly if the default ever moves.
    expect(sourceOf('../../onboarding/primitives.tsx')).toContain('"flex w-full max-w-[440px] flex-col items-center"')
  })
})

/**
 * G2 late refinement — CREATE picks, it does not type.
 */
describe('the typed models field', () => {
  const step = sourceOf('../../onboarding/ByoRuntimeStep.tsx')

  it('is the FALLBACK only — chips wherever a catalog is possible, on create AND edit', () => {
    // REFINED (owner, 2026-08-15): "input on every edit" overshot. An edit whose
    // connection can fetch a catalog — which slug-fetch made true — now shows
    // the same chips-and-picker UX as create. The input survives exactly where
    // no catalog can ever exist (anthropic-messages), because typing is the
    // only way to change the list there.
    expect(step).toContain('{!official && !catalogAvailable && (')
    expect(step).toContain('{!official && catalogAvailable && (')
    expect(step).not.toContain('{!official && isEditing && (')
    // Positive control: the input still exists for the fallback path.
    expect(step).toContain('id="byo-models"')
  })

  it('lets a stored selection be edited before any fetch', () => {
    // On the edit path the chips render from mount, and the remove affordance
    // is what makes them editable without fetching a catalog first.
    expect(step).toContain('modelsChipRemoveAria')
    expect(step).toContain('setModels(selectedModelIds.filter(entry => entry !== id).join')
    // A chip is a PAIR of buttons: nesting one inside the other is invalid
    // HTML and the inner one stops being reachable.
    const chip = step.slice(step.indexOf('inline-flex shrink-0 items-center rounded-md'), step.indexOf('modelsChipRemoveAria'))
    expect(chip.match(/<button/g)?.length).toBe(2)
  })

  it('marks the default IN PLACE — nothing reorders on screen', () => {
    // CHANGED (owner, 2026-08-15): the clicked chip used to jump to the front,
    // because the front is what the wire reads — «выбраная дефолтная модель
    // визуально скачет на первое место что сбивает с толку». The chips keep
    // their selection order now and the badge moves instead.
    expect(step).toContain('onClick={() => { setDefaultModelId(id); setFieldError(null) }}')
    expect(step).toContain('id === effectiveDefaultModel')
    // The click must NOT rewrite the list — that was the reordering.
    expect(step).not.toContain('setModels([id, ...selectedModelIds.filter')

    // The WIRE contract is unchanged: the lift happens once, at submit.
    expect(step).toContain('const orderedModels = effectiveDefaultModel')
    expect(step).toContain('[effectiveDefaultModel, ...result.models.filter(id => id !== effectiveDefaultModel)]')
    expect(step).toContain('models: orderedModels,')

    // A removed chip must not leave the marker pointing at nothing.
    expect(step).toContain('defaultModelId && selectedModelIds.includes(defaultModelId)')

    // Selection order is preserved by the picker's toggle — appended, not
    // sorted — which is what makes the on-screen order meaningful at all.
    expect(picker).toContain('[...selectedIds, id]')
  })
})

/**
 * The utility-model select — the owner could not open it in the app.
 *
 * It opened fine in the playground with 17 options, which ruled out the stale
 * option-source theory: the list already comes from the chips selection. What
 * differs in the app is the fullscreen overlay, and Radix portals
 * `SelectContent` to `document.body` by default — the exact shape
 * `AddWorkspaceStep_ConnectRemote` already solved with a container ref. Fixed
 * by rendering the list INSIDE the form rather than reasoning about z-index and
 * focus scopes.
 */
describe('the utility-model select', () => {
  const step = sourceOf('../../onboarding/ByoRuntimeStep.tsx')

  it('renders its list inside the form, not into document.body', () => {
    expect(step).toContain('const selectPortalRef = useRef<HTMLDivElement>(null)')
    expect(step).toContain('<SelectContent container={selectPortalRef.current}>')
    expect(step).toContain('<div ref={selectPortalRef} />')
    // Positive control: the project already does this for a select in an
    // overlay, so the pattern is borrowed rather than invented.
    const workspace = sourceOf('../../workspace/AddWorkspaceStep_ConnectRemote.tsx')
    expect(workspace).toContain('container={selectPortalRef.current}')
  })

  it('offers Automatic first, then the selection in its own order', () => {
    // Verified live in the playground at 17 picked models: 18 options, the
    // first "Automatic (last model in the list)", the rest equal to the chips
    // in order.
    const block = step.slice(step.indexOf('<SelectContent'), step.indexOf('</SelectContent>'))
    expect(block.indexOf('MINI_MODEL_AUTO')).toBeLessThan(block.indexOf('selectedModelIds.map'))
    expect(block).toContain('{selectedModelIds.map(id => <SelectItem key={id} value={id}>{id}</SelectItem>)}')
  })

  it('maps Automatic to NO miniModel, and a pick to that model', () => {
    // Radix has no empty-string value, so Automatic needs a sentinel — and the
    // sentinel must never reach the payload as a model id.
    expect(step).toContain("setMiniModel(next === MINI_MODEL_AUTO ? '' : next)")
    expect(step).toContain("const MINI_MODEL_AUTO = '__auto__'")
    // E1's contract: a blank miniModel is sent so clearing it actually clears,
    // and the server maps '' back to undefined — the heuristic then applies.
    const byo = sourceOf('../byo-runtime.ts')
    expect(byo).toContain("...(args.miniModel !== undefined ? { miniModel: miniModel ?? '' } : {}),")
  })

  it('says what Automatic DOES, in both locales', () => {
    for (const locale of ['en', 'ru']) {
      const strings = JSON.parse(
        sourceOf(`../../../../../../../packages/shared/src/i18n/locales/${locale}.json`),
      ) as Record<string, string>
      const label = strings['onboarding.byoRuntime.miniModelAuto']
      expect(label).toBeTruthy()
      // Not a bare "Automatic": the label has to name the behaviour, because
      // the alternative is a user guessing what the app will pick for them.
      expect(label.length).toBeGreaterThan('Automatic'.length + 4)
    }
  })
})
