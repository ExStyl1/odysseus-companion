/**
 * The collapsed turn header names what the turn did, in both locales.
 *
 * Three things this file exists to prove, none of which any existing check can:
 *
 * 1. **The category table is right for all three runtimes.** The interesting row
 *    is not a lookup — it is `categorizeCall`'s shell re-categorisation. Codex
 *    has no read tool and no listing tool, so its file reads arrive as `Bash`
 *    with `cat …` and its listings as `Bash` with `ls …`. Without that rule a
 *    Codex turn reads "Ran 5 shell commands" where the identical Claude turn
 *    reads correctly. Both spellings are exercised, including the login-shell
 *    wrapper that 30 of the 177 stored `Bash` commands in the local corpus carry.
 *
 * 2. **Every new `turnCard.run*` key resolves to a REAL RUSSIAN plural form.**
 *    Both i18n lints are blind here — `check-i18n-parity.ts:64-69` accepts a ru
 *    `X_few` as an allowed extra but never *requires* one, and
 *    `sort-locales.ts --check` only checks ordering. So a missing ru `_few` or
 *    `_many` passes both.
 *
 *    **Measured 2026-08-21, and it corrects the plan's own description of the
 *    defect.** T6's text says a missing plural form "falls back to the key name
 *    at runtime". It does not. `setupI18n` sets `fallbackLng: 'en'`, so i18next
 *    falls through to the ENGLISH resource: with ru `_few`/`_many` removed, a ru
 *    lookup at count 2 returns `"2 files"` and at count 5 returns `"5 files"` —
 *    English prose inside a Russian UI, while counts 1 / 21 / 101 keep working,
 *    so it survives a spot check. A detector that only asserts "the result is
 *    not the key name" therefore passes the very defect it was written for. The
 *    table below asserts the resolution is Cyrillic AND differs from the English
 *    resolution, which is what actually catches it. (Probe used: add a key pair
 *    carrying ru `_one`/`_other` only, resolve at counts 1, 2, 5, 21, 101.)
 *
 * 3. **The label is bounded, so the header's clip never eats it.** The work
 *    log renders the preview in a `truncate` span — the label cannot wrap, and
 *    it is cut at the END. Until UB14.11 the error count was concatenated
 *    there, which is what A11's "the errorSuffix is not truncated" was about;
 *    since v0.15.1's work log the count is a separate "N failed" chip
 *    (`turn-preview-label.test.ts` checks it sits outside the span), so the
 *    bound now protects the label itself. The span also holds the lead
 *    "N steps · " (`WorkLogHeader`), so the sweep below measures the span's
 *    WHOLE text — lead, separator and label — at the worst case over every
 *    category combination in both locales (UB12.42), and a control one phrase
 *    over the cap shows the cap is what keeps it inside.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { i18n, setupI18n } from '@nessy-agent/shared/i18n'
import {
  categorizeCall,
  formatToolRunLabel,
  summarizeTurnRun,
  runPhrase,
  RUN_CATEGORIES,
  RUN_CATEGORY_ORDER,
  TURN_PREVIEW_BUDGET_CHARS,
  TURN_PREVIEW_MAX_PHRASES,
  type RunCategory,
  type ToolRunCall,
} from '../run-summary'

setupI18n()

/**
 * The English-expecting sections below must not trust the AMBIENT language:
 * another file's un-awaited restore can land after our tests start (measured
 * on CI 2026-08-21 — eight reds receiving Russian). Pin 'en' before anything
 * runs; the language sweep below still switches per-locale and the afterAll
 * hands 'en' back so no later file inherits `ru`.
 */
beforeAll(async () => {
  await i18n.changeLanguage('en')
})
afterAll(async () => {
  await i18n.changeLanguage('en')
})

const LOCALES_DIR = join(import.meta.dir, '../../../../../shared/src/i18n/locales')
const en = JSON.parse(readFileSync(join(LOCALES_DIR, 'en.json'), 'utf-8')) as Record<string, string>
const ru = JSON.parse(readFileSync(join(LOCALES_DIR, 'ru.json'), 'utf-8')) as Record<string, string>

/** Every `turnCard.run*` base key, derived from en.json so a new one is covered. */
const RUN_KEY_BASES = Object.keys(en)
  .filter(k => /^turnCard\.run[A-Za-z]+_one$/.test(k))
  .map(k => k.replace(/_one$/, ''))
  .sort()

const call = (name: string, args?: Record<string, unknown>): ToolRunCall => ({ name, args })
const bash = (command: string): ToolRunCall => call('Bash', { command })

/** A representative call for each category, for the combinatorial sweeps. */
function callFor(category: RunCategory): ToolRunCall {
  switch (category) {
    case 'shell': return bash('echo hi')
    case 'list': return call('Ls')
    case 'read': return call('Read')
    case 'edit': return call('Edit')
    case 'search': return call('Grep')
  }
}

/** Every non-empty combination of categories, with and without unknown tools. */
function eachCombination(
  perCategory: number,
  otherCounts: readonly number[],
  visit: (calls: ToolRunCall[]) => void,
): void {
  for (let mask = 1; mask < 1 << RUN_CATEGORY_ORDER.length; mask++) {
    for (const otherCount of otherCounts) {
      const calls: ToolRunCall[] = []
      RUN_CATEGORY_ORDER.forEach((category, i) => {
        if (mask & (1 << i)) {
          for (let n = 0; n < perCategory; n++) calls.push(callFor(category))
        }
      })
      for (let n = 0; n < otherCount; n++) calls.push(call('WebFetch'))
      visit(calls)
    }
  }
}

// ---------------------------------------------------------------------------
// 1 — categorisation
// ---------------------------------------------------------------------------

describe('categorizeCall', () => {
  const rows: Array<[string, ToolRunCall, RunCategory | 'other']> = [
    // Claude / Pi / Codex all reach the renderer speaking Claude's vocabulary.
    ['Bash is a shell command', bash('echo hi'), 'shell'],
    ['Read is a file read', call('Read', { file_path: '/a' }), 'read'],
    ['Edit is a file edit', call('Edit', { file_path: '/a' }), 'edit'],
    ['Write is a file edit', call('Write', { file_path: '/a' }), 'edit'],
    ['NotebookEdit is a file edit', call('NotebookEdit'), 'edit'],
    ['Grep is a search', call('Grep', { pattern: 'x' }), 'search'],
    ['WebSearch is a search', call('WebSearch', { query: 'x' }), 'search'],
    // The runtime-specific surface: FOUR rows, not the three the plan named.
    // `Glob` and `MultiEdit` are Claude-only names, `Find` and `Ls` Pi-only —
    // `core/pre-tool-use.ts:148` records the same split for the path gate.
    ['Glob (Claude) is a search', call('Glob', { pattern: '*' }), 'search'],
    ['Find (Pi) is the same operation as Glob', call('Find', { pattern: '*' }), 'search'],
    ['MultiEdit (Claude) is a file edit', call('MultiEdit'), 'edit'],
    ['Ls (Pi) is a listing', call('Ls', { path: '/a' }), 'list'],
    // WebFetch is deliberately uncategorised — no category is true of it.
    ['WebFetch stays uncategorised', call('WebFetch', { url: 'https://x' }), 'other'],
    ['an unknown tool is other', call('SomethingNew'), 'other'],
  ]

  for (const [name, input, expected] of rows) {
    it(name, () => {
      expect(categorizeCall(input)).toBe(expected)
    })
  }

  it('has exactly the rows the three runtimes need', () => {
    // Every declared row resolves to its declared category, so a row added
    // without a test above still has to be a real category.
    for (const [name, category] of Object.entries(RUN_CATEGORIES)) {
      expect(categorizeCall(call(name))).toBe(category)
    }
    expect(Object.keys(RUN_CATEGORIES)).toHaveLength(11)
  })
})

describe('categorizeCall re-categorises shell calls — the Codex path', () => {
  it('reads a file through cat', () => {
    // Codex has no read tool at all; this is what a Codex file read looks like.
    expect(categorizeCall(bash('cat notes.txt'))).toBe('read')
  })

  it('lists a directory through ls', () => {
    expect(categorizeCall(bash('ls -la /tmp'))).toBe('list')
  })

  it('peels the login-shell wrapper first', () => {
    // 30 of the 177 stored Bash commands in the local corpus carry this shape.
    expect(categorizeCall(bash("/bin/zsh -lc 'cat notes.txt'"))).toBe('read')
    expect(categorizeCall(bash('/bin/bash -lc ls'))).toBe('list')
    expect(categorizeCall(bash('sh -c "ls -la"'))).toBe('list')
  })

  it('leaves a compound command a shell command', () => {
    // `cd x && ls` is not only a listing, and the corpus has real instances.
    expect(categorizeCall(bash('cd /tmp && ls -la'))).toBe('shell')
    expect(categorizeCall(bash('cattle --help'))).toBe('shell')
    expect(categorizeCall(bash('lsof -i'))).toBe('shell')
  })

  it('survives a Bash row with no usable command', () => {
    expect(categorizeCall(call('Bash'))).toBe('shell')
    expect(categorizeCall(call('Bash', { command: 42 }))).toBe('shell')
  })

  it('a Codex turn and the identical Claude turn read the same', () => {
    const codex = [bash('cat a.ts'), bash('cat b.ts'), bash('ls src')]
    const claude = [
      call('Read', { file_path: 'a.ts' }),
      call('Read', { file_path: 'b.ts' }),
      call('Ls', { path: 'src' }),
    ]
    expect(formatToolRunLabel(codex)).toBe(formatToolRunLabel(claude))
    expect(formatToolRunLabel(codex)).toBe('Listed 1 directory, read 2 files')
  })
})

describe('MCP rows are never categorised', () => {
  // `mcp__sources__<wire>__<tool>` (Codex) vs `mcp__<wire>__<tool>` (Pi/Claude)
  // is a deliberate, documented divergence — see `mcp-tool-name.ts`.
  const names = [
    'mcp__sources__plugin_cdp-echo-probe_echo__Read',
    'mcp__dpGitlab__dp_gitlab_repos',
    'mcp__session__TodoWrite',
    'mcp__anything__Bash',
  ]
  for (const name of names) {
    it(`${name} is other`, () => {
      expect(categorizeCall(call(name))).toBe('other')
    })
  }
})

// ---------------------------------------------------------------------------
// 2 — the label
// ---------------------------------------------------------------------------

describe('formatToolRunLabel', () => {
  it('names a single category', () => {
    expect(formatToolRunLabel([call('Read'), call('Read')])).toBe('Read 2 files')
    expect(formatToolRunLabel([call('Read')])).toBe('Read 1 file')
  })

  it('joins categories in the declared order, not call order', () => {
    const label = formatToolRunLabel([call('Grep'), call('Read'), bash('echo hi')])
    expect(label).toBe('Ran 1 shell command, read 1 file, ran 1 search')
  })

  it('appends unrecognised tools as the other phrase', () => {
    expect(formatToolRunLabel([call('Read'), call('WebFetch')]))
      .toBe('Read 1 file, called 1 other tool')
  })

  it('falls back when nothing at all is recognised', () => {
    expect(formatToolRunLabel([call('WebFetch'), call('mcp__x__y')])).toBe('Called 2 tools')
  })

  it('bounds the join and folds the surplus into other', () => {
    const calls = [bash('echo'), call('Ls'), call('Read'), call('Edit'), call('Grep')]
    const label = formatToolRunLabel(calls)
    expect(label.split(', ')).toHaveLength(TURN_PREVIEW_MAX_PHRASES)
    // The categories past the cap are counted, not dropped.
    expect(label).toBe('Ran 1 shell command, listed 1 directory, called 3 other tools')
  })

  it('accounts for every call, at every combination', () => {
    eachCombination(3, [0, 2], calls => {
      const label = formatToolRunLabel(calls)
      const summed = [...label.matchAll(/\d+/g)].reduce((n, m) => n + Number(m[0]), 0)
      expect(summed).toBe(calls.length)
      expect(label.split(', ').length).toBeLessThanOrEqual(TURN_PREVIEW_MAX_PHRASES)
    })
  })
})

describe('summarizeTurnRun', () => {
  it('summarises the tool activities of a turn', () => {
    expect(summarizeTurnRun([
      { toolName: 'Bash', toolInput: { command: 'cat a' } },
      { toolName: 'Edit', toolInput: { file_path: 'a' } },
      { toolName: undefined },
    ])).toBe('Read 1 file, edited 1 file')
  })

  it('does not claim tool calls a commentary-only turn never made', () => {
    // The old branch said "Steps Completed" here; "Called 0 tools" would be a lie.
    expect(summarizeTurnRun([{ toolName: undefined }, { toolName: undefined }]))
      .toBe('Completed 2 steps')
  })
})

// ---------------------------------------------------------------------------
// 3 — Russian plural forms (the i18n lints' blind spot)
// ---------------------------------------------------------------------------

describe('every turnCard.run* key resolves to a real Russian plural form', () => {
  const COUNTS = [1, 2, 5, 21, 101]
  const CYRILLIC = /[А-Яа-яЁё]/

  it('found the keys to check', () => {
    expect(RUN_KEY_BASES).toEqual([
      'turnCard.runEdit',
      'turnCard.runFallback',
      'turnCard.runList',
      'turnCard.runOther',
      'turnCard.runRead',
      'turnCard.runSearch',
      'turnCard.runShell',
      'turnCard.runSteps',
    ])
  })

  for (const base of RUN_KEY_BASES) {
    it(`${base} carries all four ru forms`, () => {
      // Stated positively, because the parity lint only treats _few/_many as
      // ALLOWED extras — it never requires them.
      for (const form of ['one', 'few', 'many', 'other']) {
        expect(typeof ru[`${base}_${form}`]).toBe('string')
      }
    })

    for (const count of COUNTS) {
      it(`${base} at ${count} resolves in ru`, () => {
        const value = i18n.t(base, { count, lng: 'ru' })
        // (a) not the key name
        expect(value).not.toBe(base)
        expect(value).not.toContain('turnCard.')
        // (b) actually Russian — the assertion that catches a missing _few or
        // _many, which falls through to the ENGLISH resource, not to the key.
        expect(value).toMatch(CYRILLIC)
        expect(value).not.toBe(i18n.t(base, { count, lng: 'en' }))
        // (c) the count reached the string
        expect(value).toContain(String(count))
      })
    }
  }
})

// ---------------------------------------------------------------------------
// 4 — A11: the label is not clipped away (the failed count is a chip since UB14.11)
// ---------------------------------------------------------------------------

describe('the label fits the header', () => {
  /**
   * The text of `WorkLogHeader`'s `truncate` span for a settled turn: the lead
   * `turnCard.stepCount`, the `" · "` separator span, then the label. A turn's
   * activity count is at least its tool-call count, so `steps` is the call count.
   */
  const headerText = (steps: number, label: string): string =>
    `${i18n.t('turnCard.stepCount', { count: steps })} · ${label}`

  for (const lng of ['en', 'ru']) {
    it(`${lng}: the worst case stays inside the budget`, async () => {
      await i18n.changeLanguage(lng)
      let worst = ''
      // 999 per category and 999 unknown tools: the widest counts a real turn
      // could plausibly reach, so the digits are worst-case too (the lead's four).
      eachCombination(999, [0, 999], calls => {
        const text = headerText(calls.length, formatToolRunLabel(calls))
        if (text.length > worst.length) worst = text
      })
      expect(worst.length).toBeLessThanOrEqual(TURN_PREVIEW_BUDGET_CHARS)
      // The measured text carries the lead, four digits wide, before the label.
      expect(worst).toMatch(/^\d{4} \S+ · \S/)
    })

    it(`${lng}: CONTROL — one phrase over the cap does not fit`, async () => {
      await i18n.changeLanguage(lng)
      // Every category and 999 unknown tools, joined as formatToolRunLabel would
      // join them with the cap one higher: one more category phrase, the rest
      // folded into "other". If this fit, the budget would not need the cap.
      const kept = RUN_CATEGORY_ORDER.slice(0, TURN_PREVIEW_MAX_PHRASES)
      const folded = 999 * (RUN_CATEGORY_ORDER.length - kept.length + 1)
      const label = [
        ...kept.map(category => runPhrase(category, 999)),
        i18n.t('turnCard.runOther', { count: folded }),
      ].join(', ')
      const steps = 999 * (RUN_CATEGORY_ORDER.length + 1)
      expect(headerText(steps, label).length).toBeGreaterThan(TURN_PREVIEW_BUDGET_CHARS)
    })

    it(`${lng}: the label carries no failure count (that is the work log's chip)`, async () => {
      await i18n.changeLanguage(lng)
      const label = summarizeTurnRun([{ toolName: 'Read' }, { toolName: 'Edit' }])
      expect(label).not.toContain('·')
      expect(label).not.toContain(i18n.t('turnCard.failedCount', { count: 1 }))
    })
  }
})

// ---------------------------------------------------------------------------
// 5 — the key this branch replaced is gone from both locales
// ---------------------------------------------------------------------------

describe('turnCard.stepsCompleted', () => {
  it('is absent from every locale', () => {
    // A dead key passes both i18n lints while sitting in two locale files.
    expect(en['turnCard.stepsCompleted']).toBeUndefined()
    expect(ru['turnCard.stepsCompleted']).toBeUndefined()
  })
})
