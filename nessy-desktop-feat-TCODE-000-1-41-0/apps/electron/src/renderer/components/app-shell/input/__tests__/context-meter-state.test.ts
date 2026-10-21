/**
 * The merged context indicator's three states, plus the two gates that must
 * survive the merge (a provider with no compaction, and an in-flight turn).
 *
 * UB14.28 repointed the drawn half: the two donuts folded into `ContextUsageChip`
 * (v0.15.1's `UsageRing` and our `UnknownUsageRing`), and the chip and the
 * unknown-window twin now import only barrel-free subpaths, so both RENDER here.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeAll, describe, expect, it, mock } from 'bun:test'
import { createInstance, type i18n as I18nInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { TooltipProvider } from '@nessy-agent/ui/ui/tooltip'
import { ContextUsageChip, UnknownUsageRing, UsageRing, type ContextUsageDetail } from '../ContextUsageChip'
import { ContextMeterUnknownWindow } from '../ContextMeterUnknownWindow'
import {
  CONTEXT_WARNING_PERCENT,
  isContextWindowUnknown,
  resolveContextMeterState,
  type ContextMeterInput,
} from '../context-meter-state'
import en from '@nessy-agent/shared/i18n/locales/en.json'
import ru from '@nessy-agent/shared/i18n/locales/ru.json'

const WINDOW = 200_000
const THRESHOLD = 100_000

function input(overrides: Partial<ContextMeterInput> = {}): ContextMeterInput {
  return {
    inputTokens: 50_000,
    contextWindow: WINDOW,
    autoCompactionThreshold: THRESHOLD,
    isCompacting: false,
    thresholdKind: 'real',
    isProcessing: false,
    ...overrides,
  }
}

describe('composer context meter', () => {
  it('is an ordinary meter well below the threshold', () => {
    const state = resolveContextMeterState(input())

    expect(state).not.toBeNull()
    expect(state!.windowPercent).toBe(25)
    expect(state!.thresholdPercent).toBe(50)
    expect(state!.warning).toBe(false)
    expect(state!.actionable).toBe(false)
  })

  it('turns and becomes actionable at the threshold share the badge used', () => {
    const state = resolveContextMeterState(input({ inputTokens: 80_000 }))!

    expect(state.thresholdPercent).toBe(CONTEXT_WARNING_PERCENT)
    expect(state.warning).toBe(true)
    expect(state.actionable).toBe(true)
    // The two numbers the one indicator now carries are genuinely different —
    // that difference is why two separate indicators read as a contradiction.
    expect(state.windowPercent).toBe(40)
  })

  it('still warns but refuses the action while a turn is in flight', () => {
    const state = resolveContextMeterState(input({ inputTokens: 80_000, isProcessing: true }))!

    expect(state.warning).toBe(true)
    expect(state.actionable).toBe(false)
  })

  it('offers nothing to compact while a compaction is already running', () => {
    const state = resolveContextMeterState(input({ inputTokens: 190_000, isCompacting: true }))!

    expect(state.warning).toBe(false)
    expect(state.actionable).toBe(false)
    // The meter itself stays — only the offer goes.
    expect(state.windowPercent).toBe(95)
  })

  it('invents no threshold for a provider that reports usage but does not compact', () => {
    const state = resolveContextMeterState(input({
      inputTokens: 190_000,
      autoCompactionThreshold: null,
      thresholdKind: 'real',
    }))!

    expect(state.thresholdPercent).toBeNull()
    expect(state.warning).toBe(false)
    expect(state.windowPercent).toBe(95)
  })

  it('falls back to the legacy share only where nothing better exists', () => {
    const state = resolveContextMeterState(input({
      inputTokens: 150_000,
      autoCompactionThreshold: null,
      thresholdKind: 'legacy',
      catalogContextWindow: WINDOW,
    }))!

    // 77.5% of 200 000 is 155 000; 150 000 of that is 97%.
    expect(state.thresholdPercent).toBe(97)
    expect(state.warning).toBe(true)
  })

  describe('the four threshold kinds are four different answers', () => {
    // The defect this replaced: codex and a pre-reporting provider were the
    // SAME branch, both warned at 77.5% of the window, and neither backend was
    // ever going to act on it.
    const unreported = { inputTokens: 150_000, autoCompactionThreshold: null } as const;

    it('real reports its own or has none', () => {
      expect(resolveContextMeterState(input({ ...unreported, thresholdKind: 'real' }))!.thresholdPercent).toBeNull();
    });

    it('none stays silent even at 95% of the window', () => {
      const state = resolveContextMeterState(input({
        ...unreported,
        inputTokens: 190_000,
        thresholdKind: 'none',
      }))!;
      expect(state.thresholdPercent).toBeNull();
      expect(state.warning).toBe(false);
      // The occupancy is still drawn — only the unfounded warning is gone.
      expect(state.windowPercent).toBe(95);
    });

    it('formula-claude reproduces the SDK subtraction, not a fraction', () => {
      // 200 000 − 20 000 − 13 000 = 167 000; 150 000 of that is 90%.
      const state = resolveContextMeterState(input({ ...unreported, thresholdKind: 'formula-claude' }))!;
      expect(state.thresholdPercent).toBe(90);
      // And it is a LATER warning than the legacy fabrication would have given
      // at the same fill — the point of computing it rather than guessing.
      const legacy = resolveContextMeterState(input({ ...unreported, thresholdKind: 'legacy', catalogContextWindow: WINDOW }))!;
      expect(state.thresholdPercent!).toBeLessThan(legacy.thresholdPercent!);
    });

    it('formula-claude declines a window too small to subtract from', () => {
      const state = resolveContextMeterState(input({
        inputTokens: 10_000,
        contextWindow: 30_000,
        autoCompactionThreshold: null,
        thresholdKind: 'formula-claude',
      }))!;
      expect(state.thresholdPercent).toBeNull();
    });

    it('an absent kind behaves exactly as legacy, for an older backend', () => {
      const absent = resolveContextMeterState(input({ ...unreported, thresholdKind: undefined, catalogContextWindow: WINDOW }))!;
      const legacy = resolveContextMeterState(input({ ...unreported, thresholdKind: 'legacy', catalogContextWindow: WINDOW }))!;
      expect(absent.thresholdPercent).toBe(legacy.thresholdPercent);
    });

    it('a reported threshold outranks every kind', () => {
      for (const kind of ['real', 'none', 'formula-claude', 'legacy'] as const) {
        expect(resolveContextMeterState(input({ thresholdKind: kind }))!.thresholdPercent).toBe(50);
      }
    });
  });

  it('caps the threshold share at 99 rather than reading as nothing left', () => {
    const state = resolveContextMeterState(input({ inputTokens: 500_000 }))!

    expect(state.thresholdPercent).toBe(99)
  })

  it('draws nothing without both numbers, instead of dividing by an absent window', () => {
    expect(resolveContextMeterState(input({ contextWindow: null }))).toBeNull()
    expect(resolveContextMeterState(input({ contextWindow: 0 }))).toBeNull()
    expect(resolveContextMeterState(input({ inputTokens: null }))).toBeNull()
  })
})

/**
 * The second silence. `resolveContextMeterState` returns `null` for two
 * different situations and the composer drew the same empty space for both:
 * "nothing has happened yet" and "this session will never compact". These pin
 * the separation, and — because the fix is a VISUAL — that the drawn state
 * cannot be mistaken for either an empty or a full meter.
 */
describe('the blank meter that means compaction is off', () => {
  const unknown = { contextWindow: null, catalogContextWindow: null } as const

  it('is a state, not an absence, once an occupancy is being counted', () => {
    const noWindow = input(unknown)
    // Both are true of the same input, and that is the whole finding: the meter
    // draws nothing AND there is something to say.
    expect(resolveContextMeterState(noWindow)).toBeNull()
    expect(isContextWindowUnknown(noWindow)).toBe(true)
  })

  it('treats a zero or negative window as unknown rather than as a full one', () => {
    expect(isContextWindowUnknown(input({ ...unknown, contextWindow: 0 }))).toBe(true)
    expect(isContextWindowUnknown(input({ ...unknown, contextWindow: -1 }))).toBe(true)
  })

  it('stays silent before anything has been reported, so a new session opens clean', () => {
    expect(isContextWindowUnknown(input({ ...unknown, inputTokens: null }))).toBe(false)
  })

  it('stays silent when a window is merely undrawn rather than unknown', () => {
    // The catalogue knows one; that the donut does not use it is a different
    // defect, and calling it "unknown" would misreport it.
    expect(isContextWindowUnknown(input({ contextWindow: null, catalogContextWindow: WINDOW }))).toBe(false)
  })

  it('stays silent on every ordinary measured session', () => {
    for (const kind of ['real', 'none', 'formula-claude', 'legacy'] as const) {
      expect(isContextWindowUnknown(input({ thresholdKind: kind }))).toBe(false)
    }
    expect(isContextWindowUnknown(input({ inputTokens: 0 }))).toBe(false)
  })
})

const sourceOf = (file: string): string =>
  readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), 'utf8')

/**
 * The indicator itself is asserted at source level: it imports the
 * `@nessy-agent/ui` barrel, which `bun test` cannot resolve (a pdfjs worker
 * URL) — the constraint `BranchSwitcher.test.tsx` records and works around the
 * same way.
 */
describe('the indeterminate indicator reads as unknown, not as empty or full', () => {
  const indicator = sourceOf('ContextMeterUnknownWindow.tsx')
  const chip = sourceOf('ContextUsageChip.tsx')

  it('never reaches for the measured ring, at any fill', () => {
    // `UsageRing percent={0}` is the tempting one-liner and it is the
    // wrong answer: an empty ring reads as "plenty of room left".
    expect(indicator).not.toContain('<UsageRing')
    expect(indicator).toContain('<UnknownUsageRing')
  })

  it('draws no arc — there is no share to encode', () => {
    const start = chip.indexOf('export function UnknownUsageRing')
    expect(start).toBeGreaterThan(-1)
    const donut = chip.slice(start, chip.indexOf('\n}\n', start))
    expect(donut).not.toContain('percent')
    // A broken ring and a glyph, both shape rather than colour.
    expect(donut).toContain('strokeDasharray')
    expect(donut).toContain('?')
  })

  it('carries the state without colour, hover or a mouse', () => {
    expect(indicator).toContain('role="img"')
    expect(indicator).toContain('aria-label')
    // Focusable, so the explanation is not pointer-hover-only.
    expect(indicator).toContain('tabIndex={0}')
  })

  it('renders only in the state the pure decision describes', () => {
    expect(indicator).toContain('if (!isContextWindowUnknown(input)) return null')
  })
})

describe('the wording ships in every locale', () => {
  const keys = ['chat.contextUsage.unknownWindow', 'chat.contextUsage.unknownWindowDetail']
  const locales: Record<string, Record<string, string>> = { en, ru }

  it('names what is off and what to do about it, in P3.32\'s register', () => {
    for (const [name, locale] of Object.entries(locales)) {
      for (const key of keys) {
        expect(`${name}:${key}:${typeof locale[key]}`).toBe(`${name}:${key}:string`)
        expect(locale[key]!.length).toBeGreaterThan(0)
      }
    }
    // The remedy, not just the diagnosis — the half that makes the English
    // sentence actionable rather than only alarming.
    expect(en['chat.contextUsage.unknownWindowDetail']).toContain('Set a context window')
  })

  it('is used by the indicator under exactly those keys', () => {
    for (const key of keys) expect(sourceOf('ContextMeterUnknownWindow.tsx')).toContain(key)
  })
})

/**
 * The indicator existed for one commit with no importer: the component, the
 * strings and the decision all landed while the single render site was held by
 * another lane, so the user still saw empty space. These pin the wiring itself,
 * because "the component exists" and "the composer draws it" are two claims and
 * only the second one is the fix.
 *
 * Two halves, and the second is the one that must not regress:
 *  - the composer reaches for the indicator where it used to `return null`;
 *  - and it can ONLY appear there — every input that draws a donut today draws
 *    the same donut, because the state is a strict subset of the old blank.
 */
describe('the composer draws the indicator where it drew nothing', () => {
  const composer = sourceOf('FreeFormInput.tsx')

  it('imports it — the whole of the last gap was that nothing did', () => {
    expect(composer).toContain("import { ContextMeterUnknownWindow } from './ContextMeterUnknownWindow'")
  })

  it('returns it from the branch that used to return a bare null', () => {
    expect(composer).toContain('if (!meter) return <ContextMeterUnknownWindow input={meterInput} />')
    expect(composer).not.toContain('if (!meter) return null')
  })

  it('decides on the SAME input the meter refused, so the two cannot drift apart', () => {
    // One object, two readers. If the indicator were handed a freshly built
    // literal it could disagree with the meter about the very same session.
    expect(composer).toContain('const meter = resolveContextMeterState(meterInput)')
  })
})

describe('the indicator can never displace a drawn meter', () => {
  it('is a strict subset of the states that already rendered nothing', () => {
    const cases: ContextMeterInput[] = []
    for (const inputTokens of [null, 0, 50_000, 190_000]) {
      for (const contextWindow of [null, 0, -1, WINDOW]) {
        for (const catalogContextWindow of [null, 0, WINDOW]) {
          for (const thresholdKind of ['real', 'none', 'formula-claude', 'legacy'] as const) {
            cases.push(input({ inputTokens, contextWindow, catalogContextWindow, thresholdKind }))
          }
        }
      }
    }
    expect(cases.length).toBe(192)

    // Partitioned up front and asserted unconditionally (UB12.30): an `expect`
    // inside `if (isContextWindowUnknown(one))` was deleted, not failed, by a
    // predicate that stopped firing — the count below is what proves it fires.
    const unknownCases = cases.filter((one) => isContextWindowUnknown(one))
    // A positive control: the sweep really does reach the new state.
    expect(unknownCases.length).toBeGreaterThan(0)
    // The new branch fires only where the composer already drew nothing, so
    // no session that has a meter today loses it.
    expect(unknownCases.filter((one) => resolveContextMeterState(one) !== null)).toEqual([])
    // And wherever ANY window is known, the composer behaves exactly as it did:
    // it draws the donut, or the same honest blank as before.
    const windowKnown = (one: ContextMeterInput) => (one.contextWindow ?? 0) > 0 || (one.catalogContextWindow ?? 0) > 0
    expect(cases.filter(windowKnown).length).toBeGreaterThan(0)
    expect(unknownCases.filter(windowKnown)).toEqual([])
  })
})

/**
 * The drawn glyphs, rendered for real. (Before UB14.28 only the glyph could be:
 * `ContextMeterUnknownWindow` imported the `@nessy-agent/ui` barrel, which fails
 * here — `SyntaxError: Missing 'default' export in module
 * '…/pdfjs-dist/build/pdf.worker.min.mjs?url'`. It now imports the tooltip
 * subpath, and the whole indicator renders in the UB14.28 describe below.)
 */
describe('the drawn indicator, rendered', () => {
  it('emits a broken ring and a glyph, and nothing that encodes a fill', () => {
    const html = renderToStaticMarkup(createElement(UnknownUsageRing))
    expect(html).toContain('<svg')
    expect(html).toContain('>?</text>')
    // A repeating dash: the two dash lengths are equal, so no segment can be
    // read as an arc of a particular size.
    const dash = /stroke-dasharray="([\d.]+) ([\d.]+)"/.exec(html)
    expect(dash).not.toBeNull()
    expect(dash![1]).toBe(dash![2]!)
    // Nothing rotates the glyph onto its side, and no tone recolours the state.
    expect(html).not.toContain('rotate-90')
  })

  it('is not what `percent={0}` draws — the wrong answer, rendered side by side', () => {
    const unknownHtml = renderToStaticMarkup(createElement(UnknownUsageRing))
    const emptyHtml = renderToStaticMarkup(createElement(UsageRing, { percent: 0 }))
    expect(unknownHtml).not.toBe(emptyHtml)
    // The empty donut's arc is a share of the circumference and its share is
    // zero — a reading that says "plenty of room left".
    expect(emptyHtml).toContain('stroke-dasharray="0 ')
    expect(unknownHtml).not.toContain('stroke-dasharray="0 ')
    expect(emptyHtml).not.toContain('?')
  })
})

/**
 * UB14.28 — the chip on v0.15.1's material, driven by `resolveContextMeterState`.
 * Upstream draws its info-tint chip ONLY at the warning; ours keeps the always-on
 * meter (owner 2026-08-08): the quiet ring below the warning, upstream's chip AT it.
 * The press is asserted on the element tree the chip returns (captured inside a
 * probe's render, so its hooks run as the probe's) — no DOM in this repo.
 */
describe('UB14.28 — the context chip: quiet ring at rest, the info-tint chip at the warning', () => {
  const KEYS = [
    'chat.contextUsage.combined', 'chat.contextUsage.label', 'chat.contextUsage.tooltip',
    'chat.contextUsage.estimatedWindow', 'chat.contextUsage.clickToCompact', 'chat.contextUsage.waitForOperation',
    'chat.contextUsage.unknownWindow', 'chat.contextUsage.unknownWindowDetail',
  ]
  const usage: ContextUsageDetail = { inputTokens: 85_000, contextWindow: WINDOW }
  let i18n: I18nInstance

  beforeAll(async () => {
    i18n = createInstance()
    await i18n.use(initReactI18next).init({
      lng: 'en',
      fallbackLng: 'en',
      keySeparator: false,
      resources: { en: { translation: Object.fromEntries(KEYS.map(key => [key, (en as Record<string, string>)[key]])) } },
      interpolation: { escapeValue: false },
    })
  })

  const wrap = (node: ReturnType<typeof createElement>) =>
    createElement(I18nextProvider, { i18n }, createElement(TooltipProvider, null, node))
  const render = (node: ReturnType<typeof createElement>) => renderToStaticMarkup(wrap(node))

  /** The trigger element (`data-state` set) of the tree `ContextUsageChip` returns. */
  function triggerOf(props: Parameters<typeof ContextUsageChip>[0]): Record<string, unknown> {
    let tree: unknown = null
    function Probe() {
      tree = ContextUsageChip(props)
      return null
    }
    renderToStaticMarkup(wrap(createElement(Probe)))
    const found: Record<string, unknown>[] = []
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(walk)
      if (!node || typeof node !== 'object' || !('props' in node)) return
      const props = (node as { props: Record<string, unknown> }).props
      if (typeof props['data-state'] === 'string') found.push(props)
      walk(props.children)
    }
    walk(tree)
    expect(found).toHaveLength(1)
    return found[0]!
  }

  it('POSITIVE — at the warning it is upstream\'s info-tint chip: ring + percent, and a press compacts', () => {
    const meter = resolveContextMeterState(input({ inputTokens: 85_000 }))!
    expect(meter.warning).toBe(true)
    expect(meter.actionable).toBe(true)
    const markup = render(createElement(ContextUsageChip, { meter, usage, onCompact: () => {} }))
    expect(markup).toContain('<button type="button"')
    expect(markup).toContain('data-state="warning"')
    for (const cls of ['bg-info-tint', 'text-info', 'rounded-full', 'h-control', 'tabular-nums', 'state-overlay']) expect(markup).toContain(cls)
    // The printed number is the ring's: the share of the WHOLE window (85k / 200k).
    expect(markup).toContain(`${meter.windowPercent}%</button>`)
    // The threshold share, which armed the warning, is in the accessible name.
    expect(markup).toContain(`aria-label="${(en as Record<string, string>)['chat.contextUsage.combined']!
      .replace('{{percent}}', String(meter.windowPercent)).replace('{{threshold}}', String(meter.thresholdPercent))}"`)
    expect(markup).not.toContain('disabled=""')

    const onCompact = mock(() => {})
    const trigger = triggerOf({ meter, usage, onCompact })
    ;(trigger.onClick as () => void)()
    expect(onCompact).toHaveBeenCalledTimes(1)
  })

  it('boundary — at the warning while a turn runs: disabled, not hidden, and a press compacts nothing', () => {
    const meter = resolveContextMeterState(input({ inputTokens: 85_000, isProcessing: true }))!
    expect(meter.warning).toBe(true)
    const markup = render(createElement(ContextUsageChip, { meter, usage, onCompact: () => {} }))
    expect(markup).toContain('data-state="warning"')
    expect(markup).toContain('disabled=""')
    expect(markup).toContain('cursor-default')
    const onCompact = mock(() => {})
    const trigger = triggerOf({ meter, usage, onCompact })
    ;(trigger.onClick as () => void)()
    expect(onCompact).not.toHaveBeenCalled()
  })

  it('NEGATIVE (control) — below the warning it is the quiet ring alone: no chip, no button, no percent', () => {
    const meter = resolveContextMeterState(input())!
    expect(meter.warning).toBe(false)
    const markup = render(createElement(ContextUsageChip, { meter, usage: { inputTokens: 50_000, contextWindow: WINDOW }, onCompact: () => {} }))
    expect(markup).toContain('role="img"')
    expect(markup).toContain('data-state="quiet"')
    expect(markup).toContain('text-tertiary')
    expect(markup).toContain(`aria-label="${(en as Record<string, string>)['chat.contextUsage.label']!.replace('{{percent}}', '25')}"`)
    expect(markup).not.toContain('<button')
    expect(markup).not.toContain('bg-info-tint')
    expect(markup).not.toContain('25%<')
  })

  it('NEGATIVE — an unknown window draws the broken ring, never percent={0}; a known window draws no twin', () => {
    const unknown = input({ contextWindow: null, catalogContextWindow: null })
    expect(resolveContextMeterState(unknown)).toBeNull()
    const markup = render(createElement(ContextMeterUnknownWindow, { input: unknown }))
    expect(markup).toContain('data-state="unknown"')
    expect(markup).toContain('>?</text>')
    expect(markup).toContain('tabindex="0"')
    expect(markup).not.toContain('stroke-dasharray="0 ')
    expect(markup).not.toContain('rotate-90')
    expect(render(createElement(ContextMeterUnknownWindow, { input: input() }))).toBe('')
  })
})
