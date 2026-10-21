/**
 * F1.358 — seven user-visible strings in three renderer files outside
 * packages/ui were still hardcoded English (F1.250 was scoped to packages/ui):
 * CompactPermissionModeSelector's "Permission mode: …" aria-label and its
 * "Permission Mode" drawer title, entity-list's four group-header menu items
 * (Expand, Collapse, Collapse All, Expand All), and SessionItem's
 * "Matches found (next, prev)" tooltip. The two mode strings reuse the existing
 * `chat.permissionMode`; the other five get keys in both locales. Upstream
 * craft-agents-oss v0.13.4 translates the first two and still spells the other
 * five literally, so its UA5.9 port would not have fixed them.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'bun:test'
import ts from 'typescript'
import enMessages from '../../../../../../packages/shared/src/i18n/locales/en.json'
import ruMessages from '../../../../../../packages/shared/src/i18n/locales/ru.json'

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf-8')

const WIRED: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['../app-shell/input/CompactPermissionModeSelector.tsx', ['chat.permissionMode']],
  ['../ui/entity-list.tsx', ['entityList.collapse', 'entityList.collapseAll', 'entityList.expand', 'entityList.expandAll']],
  ['../app-shell/SessionItem.tsx', ['session.matchesFound']],
]

describe('F1.358 — the seven renderer literals go through t()', () => {
  it('positive — each file calls t() with each of its keys, from a useTranslation() hook', () => {
    for (const [file, keys] of WIRED) {
      const source = read(file)
      expect({ file, usesHook: /\buseTranslation\(\)/.test(source) }).toEqual({ file, usesHook: true })
      for (const key of keys) {
        expect({ file, key, called: new RegExp(`\\bt\\((['"])${key.replace(/\./g, '\\.')}\\1`).test(source) })
          .toEqual({ file, key, called: true })
      }
    }
  })

  it('every key exists in both locales, and the Russian value is not the English one', () => {
    const en = enMessages as Record<string, string>
    const ru = ruMessages as Record<string, string>
    for (const [, keys] of WIRED) {
      for (const key of keys) {
        expect({ key, en: typeof en[key], ru: typeof ru[key] }).toEqual({ key, en: 'string', ru: 'string' })
        expect({ key, same: en[key] === ru[key] }).toEqual({ key, same: false })
      }
    }
  })

  it('negative — none of the seven literals remains', () => {
    const selector = read('../app-shell/input/CompactPermissionModeSelector.tsx')
    expect(selector).not.toContain('`Permission mode: ${')
    expect(selector).not.toContain('<DrawerTitle>Permission Mode</DrawerTitle>')
    const entityList = read('../ui/entity-list.tsx')
    expect(entityList).not.toContain("'Expand' : 'Collapse'")
    expect(entityList).not.toMatch(/>\s*Collapse All\s*</)
    expect(entityList).not.toMatch(/>\s*Expand All\s*</)
    expect(read('../app-shell/SessionItem.tsx')).not.toContain('Matches found (')
  })
})

/**
 * F1.477 (P6) — F1.441 widened the literal-label census for packages/ui; run
 * over this renderer it answered 19 `aria-label`/`placeholder` hits on
 * 2026-09-24. Fifteen are UI strings and go through t() now (the keys below,
 * `multiSelect.changeStatus` and `common.close` reused). What stays is named, one
 * line each, with its reason — an allow-list is only honest while it is short
 * and says why:
 *   - `placeholder="AKIA..."` (ApiKeyInput) — an AWS access-key FORMAT example, not prose;
 *   - `aria-label="Nessy Desktop"` (NessyLogo) — the product's name;
 *   - `placeholder="Enter your name..."` / `"Select timezone..."` (SettingsInput,
 *     SettingsSelect) — usage examples inside their docblocks, not rendered.
 * The pattern is F1.441's own; the control below reads it out of the ui test so
 * the two censuses cannot drift apart.
 */
const LITERAL_LABEL_PATTERN = `(aria-label|placeholder)=(\\{[^}]*)?["'\`][A-Z]`
const ALLOWED_LITERALS: ReadonlyArray<readonly [string, string]> = [
  ['components/apisetup/ApiKeyInput.tsx', 'placeholder="AKIA..."'],
  ['components/icons/NessyLogo.tsx', 'aria-label="Nessy Desktop"'],
  ['components/settings/SettingsInput.tsx', 'placeholder="Enter your name..."'],
  ['components/settings/SettingsSelect.tsx', 'placeholder="Select timezone..."'],
]
const P6_KEYS = [
  'auth.enterField', 'chat.adminApproval.rememberExactCommand_one', 'chat.adminApproval.rememberExactCommand_other',
  'chat.shareSession', 'chat.sharedSessionOptions', 'common.clearSearch', 'labels.value.enterNumber',
  'labels.value.enterUrl', 'labels.value.enterValue', 'labels.value.selectDate', 'sidebar.filter.switchToExclude',
  'sidebar.filter.switchToInclude', 'sidebar.mainNavigation', 'sidebar.subNavigation',
]

describe('F1.477 (P6) — no literal aria-label or placeholder in the renderer outside a named allow-list', () => {
  it('CONTROL — the pattern is packages/ui\'s F1.441 pattern, spelled the same', () => {
    const uiTest = read('../../../../../../packages/ui/src/components/overlay/__tests__/hardcoded-ui-strings.test.ts')
    const own = read('./renderer-hardcoded-strings.test.ts').split('\n').find(line => line.startsWith('const LITERAL_LABEL_PATTERN = '))
    expect(own).toBeDefined()
    expect(uiTest.split('\n')).toContain(own!)
  })

  it('the census over apps/electron/src/renderer answers only the allow-list', () => {
    let hits = ''
    try {
      hits = execFileSync('git', [
        'grep', '-nE', LITERAL_LABEL_PATTERN, '--', '.',
        ':(exclude)**/__tests__/**', ':(exclude)*.test.ts', ':(exclude)*.test.tsx', ':(exclude)playground/**',
      ], { cwd: fileURLToPath(new URL('../..', import.meta.url)), encoding: 'utf-8' })
    } catch (error) {
      if ((error as { status?: number }).status !== 1) throw error
    }
    const lines = hits.split('\n').filter(Boolean)
    const unexpected = lines.filter(line => !ALLOWED_LITERALS.some(([file, literal]) => line.startsWith(`${file}:`) && line.includes(literal)))
    expect(unexpected).toEqual([])
    // The allow-list is live, not decoration: every entry still matches (so a fixed one must leave the list).
    for (const [file, literal] of ALLOWED_LITERALS) {
      expect({ file, present: lines.some(line => line.startsWith(`${file}:`) && line.includes(literal)) }).toEqual({ file, present: true })
    }
  })

  it('every new key exists in both locales, and the Russian value is not the English one', () => {
    const en = enMessages as Record<string, string>
    const ru = ruMessages as Record<string, string>
    for (const key of P6_KEYS) {
      expect({ key, en: typeof en[key], ru: typeof ru[key] }).toEqual({ key, en: 'string', ru: 'string' })
      expect({ key, same: en[key] === ru[key] }).toEqual({ key, same: false })
    }
  })
})

/**
 * UA12.137 — the element-TEXT arm. F1.477's census read only the `aria-label`
 * and `placeholder` ATTRIBUTES, so a literal written as an element's text child
 * — `<DrawerTitle>Session info</DrawerTitle>` — was invisible to it, which is
 * how UA12.136's hardcoded drawer title survived every census we had. This arm
 * greps the text-child position: a `>` that is not `=>`, optional spaces, an
 * optional `{`-and-quote opening an expression string (`>{'Text'}` — F1.441's
 * lesson that the expression form is where literals hide), then a CAPITAL
 * letter — the same "literals start with a capital, i18n keys start lower-case"
 * convention as the attribute pattern — and at least one further letter, so
 * SCREAMING_SNAKE identifiers and single-letter symbols stay out of prose.
 * Whitespace is spelled `[ \t]` (the template literal turns `\t` into a real
 * tab), so the ONE string is valid both as ERE for `git grep -E` and as a JS
 * RegExp for the control below — a POSIX `[[:space:]]` class would have
 * truncated differently in each engine, and did (measured: the control caught
 * `>API Key<` failing before this spelling landed).
 *
 * NAMED RESIDUE, measured not hidden (census of 2026-10-03): `git grep` is
 * line-based, so a text child on its own line, with the tag's `>` on the line
 * above, is invisible (ApiKeyInput's AWS-credentials sentence is the live
 * example); a literal starting lower-case or with a numeral is out by the
 * capital convention; and `a > Identifier`-style comparisons inside JSX
 * expressions can false-positive (zero such hits at HEAD). Comment lines
 * (`*`, `//`, `/*`, `{/*`) are filtered out below — usage examples inside
 * docblocks are not rendered. The corpus is `*.ts`/`*.tsx` only: the svg and
 * html `<title>` elements under this directory are static brand and document
 * names (`index.html`'s "Nessy Desktop" — the same product-name reason the
 * attribute allow-list carries), outside the i18n-rendered React surface.
 *
 * Every allow-list survivor names its kind. `keycap` — keyboard key names,
 * never translated. `REAL` — genuine user-visible hardcoded English, kept
 * COUNTED by this census until a row wires each through `t()`; handed to the
 * plan at this row's landing as a deferred finding, one line per string.
 * UA12.142 wired all fifteen (see its describe below), so only the keycaps stay.
 */
const LITERAL_TEXT_PATTERN = `([^=]|^)>[ \t]*(\\{[ \t]*)?["'\`]?[A-Z][A-Za-z \t]*[a-z]`
const ALLOWED_TEXT_LITERALS: ReadonlyArray<readonly [string, string, 'keycap' | 'REAL']> = [
  // UB14.28 — the keycaps moved with the send control's tooltip into `SendButton`.
  ['components/app-shell/input/SendButton.tsx', '>Enter<', 'keycap'],
  ['components/app-shell/input/SendButton.tsx', '>Esc Esc<', 'keycap'],
]

describe('UA12.137 — no literal element TEXT in the renderer outside a named allow-list', () => {
  it('CONTROL — the pattern sees every literal text-child form, and no wired one', () => {
    // The ONE pattern string serves both engines (see the doc comment above for
    // why whitespace is spelled `[ \t]`), so this control runs the very RegExp
    // the census greps with. The planted forms include UA12.136's own literal.
    const pattern = new RegExp(LITERAL_TEXT_PATTERN)
    for (const form of [
      '<DrawerTitle>Session info</DrawerTitle>',
      '<p>Something went wrong</p>',
      '<Label>API Key</Label>',
      "<span>{'Send to Workspace'}</span>",
      '<div className="mt-1">Raw: {message.errorOriginal.slice(0, 200)}</div>',
    ]) {
      expect({ form, matched: pattern.test(form) }).toEqual({ form, matched: true })
    }
    for (const wired of [
      "<DrawerTitle>{t('chat.sessionInfo')}</DrawerTitle>",
      '<div>{count} items</div>',
      '<code>MAX_RETRIES</code>',
      '<span>X</span>',
    ]) {
      expect({ wired, matched: pattern.test(wired) }).toEqual({ wired, matched: false })
    }
  })

  it('the census over apps/electron/src/renderer answers only the allow-list', () => {
    let hits = ''
    try {
      hits = execFileSync('git', [
        'grep', '-nE', LITERAL_TEXT_PATTERN, '--', '*.tsx', '*.ts',
        ':(exclude)**/__tests__/**', ':(exclude)*.test.ts', ':(exclude)*.test.tsx', ':(exclude)playground/**',
      ], { cwd: fileURLToPath(new URL('../..', import.meta.url)), encoding: 'utf-8' })
    } catch (error) {
      if ((error as { status?: number }).status !== 1) throw error
    }
    // Comment lines are not rendered — JSDoc and `//` usage examples never
    // reach a user, and the pattern cannot tell prose in a comment from prose
    // on the screen.
    const lines = hits.split('\n')
      .filter(Boolean)
      .filter(line => !/^\s*(\*|\/\/|\/\*|\{\/\*)/.test(line.replace(/^[^:]+:[0-9]+:/, '')))
    const unexpected = lines.filter(line => !ALLOWED_TEXT_LITERALS.some(([file, literal]) => line.startsWith(`${file}:`) && line.includes(literal)))
    expect(unexpected).toEqual([])
    // The allow-list is live, not decoration: every entry still matches (so a
    // fixed one must leave the list), and each REAL line stays owed a row.
    for (const [file, literal] of ALLOWED_TEXT_LITERALS) {
      expect({ file, present: lines.some(line => line.startsWith(`${file}:`) && line.includes(literal)) }).toEqual({ file, present: true })
    }
  })
})

/**
 * UA12.181 — the crash screen (main.tsx CrashFallback) goes through i18n as upstream v0.13.4 does
 * (`v0.13.4:apps/electron/src/renderer/main.tsx`, hunk @@ -98,13 +92,13: `i18n.t('crash.somethingWentWrong')`,
 * `i18n.t('crash.restartPrompt')`, `i18n.t('crash.reload')`). The reconcile audit of 2026-10-08 found it the
 * one hunk no manifest row owned: two of its strings sat in the census above as REAL, and "Reload" (alone on
 * its line) was invisible to it. CrashFallback renders OUTSIDE every provider (it replaces the whole tree), so
 * it calls the module-level `i18n.t`, never a hook. The English restart prompt keeps OUR wording: upstream adds
 * "The error has been reported." — true of Craft's Sentry, false here (no crash reporter, reason (a)).
 */
describe('UA12.181 — the crash screen is localized through i18n.t(\'crash.*\')', () => {
  const KEYS = ['crash.somethingWentWrong', 'crash.restartPrompt', 'crash.reload'] as const
  const crashFallback = () => {
    const main = read('../../main.tsx')
    const start = main.indexOf('function CrashFallback()')
    expect(start).toBeGreaterThan(-1)
    return main.slice(start, main.indexOf('class RootErrorBoundary', start))
  }

  it('positive — CrashFallback calls i18n.t with each of the three upstream keys', () => {
    const body = crashFallback()
    for (const key of KEYS) expect({ key, called: body.includes(`i18n.t('${key}')`) }).toEqual({ key, called: true })
  })

  it('every key exists in both locales, the Russian value is not the English one, and no reporting claim is made', () => {
    const en = enMessages as Record<string, string>
    const ru = ruMessages as Record<string, string>
    for (const key of KEYS) {
      expect({ key, en: typeof en[key], ru: typeof ru[key] }).toEqual({ key, en: 'string', ru: 'string' })
      expect({ key, same: en[key] === ru[key] }).toEqual({ key, same: false })
    }
    expect(en['crash.restartPrompt']).not.toContain('reported')
  })

  it('negative — none of the three English literals remains in CrashFallback', () => {
    const body = crashFallback()
    expect(body).not.toContain('>Something went wrong<')
    expect(body).not.toContain('>Please restart the app.<')
    expect(body).not.toMatch(/^\s*Reload\s*$/m)
  })
})

/**
 * UA12.142 — the fifteen `REAL` survivors of UA12.137's element-text census go through `t()`, so the
 * allow-list above is the two keycaps alone (deliberately English: key names on the keyboard). Four reuse
 * an existing key whose English value is the literal: `common.close` and `sendToWorkspace.title` (both as
 * upstream v0.13.4's dialog.tsx and AutomationMenu.tsx spell them), `automations.labelNextRuns` (with the
 * colon outside, the file's own `labelTimezone` convention) and `workspace.nameLabel`. Eleven are new.
 * Upstream v0.13.4 still spells the other eleven literally (ApiKeyInput, ChatDisplay, PermissionRequest,
 * CronBuilder, AddWorkspaceStep_ConnectRemote), so a port would not have fixed them — F1.358's precedent.
 */
const UA12_142_WIRED: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['../apisetup/ApiKeyInput.tsx', ['apiSetup.apiKey', 'apiSetup.authentication', 'apiSetup.endpoint', 'apiSetup.protocol']],
  // UB14.14 — v0.15.1 extracted the error marker and the transcript states out of ChatDisplay.tsx.
  ['../app-shell/chat-display/ErrorMessage.tsx', ['chat.errorRaw']],
  ['../app-shell/chat-display/TranscriptStates.tsx', ['chat.noRenderableMessages', 'chat.noRenderableMessagesHint']],
  ['../app-shell/input/structured/PermissionRequest.tsx', ['chat.permissionTool']],
  ['../automations/AutomationMenu.tsx', ['sendToWorkspace.title']],
  ['../automations/CronBuilder.tsx', ['automations.labelNextRuns']],
  ['../ui/dialog.tsx', ['common.close']],
  ['../workspace/AddWorkspaceStep_ConnectRemote.tsx', ['workspace.nameLabel', 'workspace.serverUrl', 'workspace.token', 'workspace.workspaceLabel']],
]

describe('UA12.142 — the census\'s REAL survivors go through t(); only the keycaps stay English', () => {
  it('the allow-list is the recorded-deliberate set: keycaps only, no REAL entry left', () => {
    expect(ALLOWED_TEXT_LITERALS.filter(([, , kind]) => kind !== 'keycap')).toEqual([])
    expect(ALLOWED_TEXT_LITERALS.map(([, literal]) => literal)).toEqual(['>Enter<', '>Esc Esc<'])
  })

  it('positive — each file calls t() with each of its keys, from a useTranslation() hook', () => {
    for (const [file, keys] of UA12_142_WIRED) {
      const source = read(file)
      expect({ file, usesHook: /\buseTranslation\(\)/.test(source) }).toEqual({ file, usesHook: true })
      for (const key of keys) {
        expect({ file, key, called: new RegExp(`\\bt\\((['"])${key.replace(/\./g, '\\.')}\\1`).test(source) })
          .toEqual({ file, key, called: true })
      }
    }
  })

  it('every key exists in both locales, and the Russian value is not the English one', () => {
    const en = enMessages as Record<string, string>
    const ru = ruMessages as Record<string, string>
    for (const [, keys] of UA12_142_WIRED) {
      for (const key of keys) {
        expect({ key, en: typeof en[key], ru: typeof ru[key] }).toEqual({ key, en: 'string', ru: 'string' })
        expect({ key, same: en[key] === ru[key] }).toEqual({ key, same: false })
      }
    }
  })

  it('negative — none of the fifteen literals remains as element text (including the line-split forms the census cannot see)', () => {
    const gone: ReadonlyArray<readonly [string, RegExp]> = [
      ['../apisetup/ApiKeyInput.tsx', />\s*(API Key|Endpoint|Protocol|Authentication)\s*</],
      ['../app-shell/ChatDisplay.tsx', />\s*(Conversation loaded, but no renderable|Try reloading the session\.|Raw: \{)/],
      // UB14.14 — upstream's ErrorMessage still spells `Raw: {` literally; ours reads chat.errorRaw.
      ['../app-shell/chat-display/ErrorMessage.tsx', />\s*Raw: \{/],
      ['../app-shell/chat-display/TranscriptStates.tsx', />\s*(Conversation loaded, but no renderable|Try reloading the session\.)/],
      ['../app-shell/input/structured/PermissionRequest.tsx', />\s*Tool:\s*</],
      ['../automations/AutomationMenu.tsx', />\s*Send to Workspace\s*</],
      ['../automations/CronBuilder.tsx', />\s*Next runs:\s*</],
      ['../ui/dialog.tsx', />\s*Close\s*</],
      ['../workspace/AddWorkspaceStep_ConnectRemote.tsx', />\s*(Server URL|Token|Workspace|Workspace name)\s*</],
    ]
    for (const [file, literal] of gone) expect({ file, found: literal.test(read(file)) }).toEqual({ file, found: false })
  })
})

/**
 * F1.804 (release sitting SIT-p, F1.477 P6) — the attribute census reads `aria-label="…"` and `aria-label={…}`, so an
 * aria-label written as an OBJECT-LITERAL key (`'aria-label': 'Sessions'`, the session list's `containerProps`) slipped
 * past it and stayed English in the Russian UI. This census reads that form. The bypass dialog's sr-only "Close" went
 * through `common.close` with UA12.142 (`dialog.tsx`); the chat panel's "Close" is PanelSlot's stale memo (file end).
 */
const OBJECT_LITERAL_ARIA_PATTERN = `['"]aria-label['"][[:space:]]*:[[:space:]]*['"\`][A-Z]`

describe('F1.804 — no literal object-literal aria-label in the renderer', () => {
  it('CONTROL — the pattern sees the form it is for, and not a t() value', () => {
    const matches = (text: string): boolean => {
      try {
        execFileSync('grep', ['-qE', OBJECT_LITERAL_ARIA_PATTERN], { input: text })
        return true
      } catch {
        return false
      }
    }
    expect(matches(`          'aria-label': 'Sessions',`)).toBe(true)
    expect(matches(`  "aria-label" : "Close",`)).toBe(true)
    expect(matches(`          'aria-label': t('session.listAriaLabel'),`)).toBe(false)
  })

  it('the census over apps/electron/src/renderer answers nothing', () => {
    let hits = ''
    try {
      hits = execFileSync('git', [
        'grep', '-nE', OBJECT_LITERAL_ARIA_PATTERN, '--', '.',
        ':(exclude)**/__tests__/**', ':(exclude)*.test.ts', ':(exclude)*.test.tsx', ':(exclude)playground/**',
      ], { cwd: fileURLToPath(new URL('../..', import.meta.url)), encoding: 'utf-8' })
    } catch (error) {
      if ((error as { status?: number }).status !== 1) throw error
    }
    expect(hits.split('\n').filter(Boolean)).toEqual([])
  })

  it('the session list names itself through session.listAriaLabel, translated in ru', () => {
    expect(read('../app-shell/SessionList.tsx').includes(`'aria-label': t('session.listAriaLabel'),`)).toBe(true)
    const en = enMessages as Record<string, string>
    const ru = ruMessages as Record<string, string>
    expect({ en: en['session.listAriaLabel'], ru: ru['session.listAriaLabel'] }).toEqual({ en: 'Sessions', ru: 'Сессии' })
  })
})

/**
 * UA12.194 (LG-6, 2026-10-09) — the element-TEXT census reads JSX TEXT NODES, not lines. UA12.137's arm greps a
 * `>` and the text on ONE line, so a text child on its own line (the tag's `>` on the line above) was invisible:
 * LF-8's two-line heuristic counted 31 such lines on 2026-10-09, and this pass, run first at `1e7fee778`, found 52
 * (49 beside UA12.137's two keycaps and NessyLogo's product name, all wired by this row). The pass parses every tracked renderer `*.tsx` with the TypeScript parser (the
 * files read through ONE `git grep` over the working tree, as the line census reads them — a per-file open costs
 * seconds here, AGENTS.md) and takes each JSX text node, line by line, plus each `{'…'}` string child, that starts
 * with the census's capital-letter convention (`LITERAL_TEXT_PATTERN` after its `>`). JSX only: comments,
 * attributes and plain strings are not text nodes, so the line census's comment filter is not needed here.
 *
 * Every survivor goes through `t()` (UA12.194's keys; `<Trans>` where the sentence holds `<code>` names) or sits in
 * the allow-list below with its kind: `keycap` (key names, never translated — UA12.137's two) or `brand` (the
 * product's name — the same reason F1.477's attribute allow-list gives NessyLogo's aria-label).
 */
const JSX_TEXT_START = /^["'`]?[A-Z][A-Za-z \t]*[a-z]/
const ALLOWED_JSX_TEXT: ReadonlyArray<readonly [string, string, 'keycap' | 'brand']> = [
  ['components/app-shell/input/SendButton.tsx', 'Enter', 'keycap'],
  ['components/app-shell/input/SendButton.tsx', 'Esc Esc', 'keycap'],
  ['components/icons/NessyLogo.tsx', 'Nessy Desktop', 'brand'],
]

/** `file:line: text` for each literal JSX text child of `source` that starts like prose (see the doc comment above). */
function literalJsxText(file: string, source: string): string[] {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TSX)
  const found: string[] = []
  const at = (position: number, text: string) => found.push(`${file}:${parsed.getLineAndCharacterOfPosition(position).line + 1}: ${text}`)
  const visit = (node: ts.Node) => {
    if (node.kind === ts.SyntaxKind.JsxText) {
      let offset = node.pos
      for (const segment of source.slice(node.pos, node.end).split('\n')) {
        const text = segment.trim()
        if (JSX_TEXT_START.test(text)) at(offset + segment.indexOf(text), text)
        offset += segment.length + 1
      }
    } else if (ts.isJsxElement(node) || ts.isJsxFragment(node)) {
      for (const child of node.children) {
        const expression = ts.isJsxExpression(child) ? child.expression : undefined
        if (expression && (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) && JSX_TEXT_START.test(expression.text)) at(expression.getStart(parsed), expression.text)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  return found
}

/** Every tracked renderer `*.tsx` outside tests and the playground, from the working tree, through one `git grep`. */
function rendererTsxSources(): Map<string, string> {
  const out = execFileSync('git', [
    'grep', '--null', '-e', '', '--', '*.tsx',
    ':(exclude)**/__tests__/**', ':(exclude)*.test.tsx', ':(exclude)playground/**',
  ], { cwd: fileURLToPath(new URL('../..', import.meta.url)), encoding: 'utf-8', maxBuffer: 256 * 1024 * 1024 })
  const files = new Map<string, string[]>()
  for (const line of out.split('\n')) {
    const split = line.indexOf('\0')
    if (split < 0) continue
    const file = line.slice(0, split)
    files.set(file, [...(files.get(file) ?? []), line.slice(split + 1)])
  }
  return new Map([...files].map(([file, lines]) => [file, lines.join('\n')]))
}

describe('UA12.194 — no literal JSX text node in the renderer outside a named allow-list (line-split forms included)', () => {
  it('CONTROL — the pass sees a line-split text child the line census cannot, and no wired, attribute, comment or code string', () => {
    const planted = '<Label>\n  Some Text\n</Label>'
    expect(planted.split('\n').some(line => new RegExp(LITERAL_TEXT_PATTERN).test(line))).toBe(false) // UA12.137's line census: blind to it
    expect(literalJsxText('planted.tsx', `const a = ${planted}`)).toEqual(['planted.tsx:2: Some Text'])
    expect(literalJsxText('planted.tsx', 'const a = <p>\n  {count}\n  Showing more\n</p>')).toEqual(['planted.tsx:3: Showing more'])
    expect(literalJsxText('planted.tsx', "const a = <span>{'Send to Workspace'}</span>")).toEqual(['planted.tsx:1: Send to Workspace'])
    expect(literalJsxText('planted.tsx', 'const a = <p>Something went wrong</p>')).toEqual(['planted.tsx:1: Something went wrong'])
    for (const quiet of [
      "const a = <Label>\n  {t('x.y')}\n</Label>",
      'const a = <code>\n  MAX_RETRIES\n</code>',
      'const a = <div>\n  {count} items\n</div>',
      'const a = <span>X</span>',
      'const a = <Tip title="Hello there" />',
      "// <Label>Some Text</Label>\nconst a = 'Hello there'",
    ]) expect({ quiet, found: literalJsxText('planted.tsx', quiet) }).toEqual({ quiet, found: [] })
  })

  it('the census over apps/electron/src/renderer answers only the allow-list', () => {
    const sources = rendererTsxSources()
    expect(sources.size).toBeGreaterThan(300) // the corpus was read (364 files on 2026-10-09), not an empty scan
    const hits = [...sources].flatMap(([file, source]) => literalJsxText(file, source))
    const unexpected = hits.filter(hit => !ALLOWED_JSX_TEXT.some(([file, text]) => hit.startsWith(`${file}:`) && hit.endsWith(`: ${text}`)))
    expect(unexpected).toEqual([])
    for (const [file, text] of ALLOWED_JSX_TEXT) {
      expect({ file, text, present: hits.some(hit => hit.startsWith(`${file}:`) && hit.endsWith(`: ${text}`)) }).toEqual({ file, text, present: true })
    }
  })
})

/** UA12.194 — where each survivor's key is read (t() or a <Trans> i18nKey), so a reverted line fails here as well as in the census. */
const UA12_194_WIRED: ReadonlyArray<readonly [string, readonly string[]]> = [
  // UB12.116: the three keys after Go, ManualPrompt and Truncated are the literals this census cannot read (the
  // one-word `symlink` badge, the two strings handed to setError); their absence is pinned in the UB12.116 describe.
  ['../ServerDirectoryBrowser.tsx', ['common.loading', 'projects.serverBrowserEmpty', 'projects.serverBrowserGo', 'projects.serverBrowserListFailed', 'projects.serverBrowserManualPrompt', 'projects.serverBrowserSymlink', 'projects.serverBrowserTruncated', 'projects.serverBrowserWrongPlatform']],
  ['../apisetup/ApiKeyInput.tsx', ['apiSetup.awsAccessKeyId', 'apiSetup.awsCredentialChain', 'apiSetup.awsRegion', 'apiSetup.awsSecretAccessKey', 'apiSetup.awsSessionToken', 'apiSetup.customModelHint', 'apiSetup.defaultModel', 'apiSetup.modelListHint', 'apiSetup.optional', 'apiSetup.protocolHint', 'apiSetup.required']],
  ['../app-shell/AppShell.tsx', ['automations.schedulingRequiresMachine']],
  ['../app-shell/chat-display/MessageBubble.tsx', ['chat.conversationCompacted']], // UB14.14: moved out of ChatDisplay.tsx
  ['../app-shell/CompactSessionListFilter.tsx', ['sidebar.filter.noMatches']],
  ['../app-shell/SendToWorkspaceDialog.tsx', ['common.cancel']],
  // UB14.5: the filter dropdown's three survivors moved with it into v0.15.1's SessionFilterMenu, which also takes
  // upstream's sidebar.noMatchingFilters for our retired sidebar.filter.noStatusOrLabelMatches.
  ['../app-shell/SessionFilterMenu.tsx', ['common.clear', 'sidebar.labels', 'sidebar.noMatchingFilters', 'sidebar.statuses']],
  ['../app-shell/input/structured/CredentialRequest.tsx', ['auth.authenticationRequired', 'auth.credentialsEncryptedAtRest', 'common.cancel', 'common.save']],
  ['../automations/CronBuilder.tsx', ['automations.cronAdvanced', 'automations.cronCommonSchedules', 'automations.cronCustomSchedule']],
  ['../settings/SearchableModelInput.tsx', ['settings.noModelsFound']],
  ['../settings/SettingsMenuSelect.tsx', ['settings.noResultsFound']],
  ['../ui/SkillSelectorPopover.tsx', ['skillsList.addInSettings', 'skillsList.noSkillsConfigured']],
  ['../ui/SourceSelectorPopover.tsx', ['sourcesList.addInSettings', 'sourcesList.noSourcesConfigured']],
  ['../ui/data-table.tsx', ['datatable.next', 'datatable.pageOf', 'datatable.previous']],
  ['../ui/label-menu.tsx', ['sidebar.labels', 'sidebarMenu.states']],
  ['../ui/session-status-menu.tsx', ['sessionMenu.noStatusFound']],
  ['../ui/slash-command-menu.tsx', ['commands.noCommandsFound']],
  ['../workspace/AddWorkspaceStep_ConnectRemote.tsx', ['common.back', 'workspace.createNewOnServer', 'workspace.createOnServerHint', 'workspace.remoteConnected', 'workspace.remoteNoWorkspacesYet', 'workspace.useExistingWorkspace']],
  ['../../pages/settings/ServerSettingsPage.tsx', ['common.reset', 'common.save']],
]

describe('UA12.194 — the line-split survivors go through t(); only the keycaps and the brand stay literal', () => {
  it('the allow-list is the recorded-deliberate set: two keycaps and the product name', () => {
    expect(ALLOWED_JSX_TEXT.map(([, text, kind]) => `${kind}:${text}`)).toEqual(['keycap:Enter', 'keycap:Esc Esc', 'brand:Nessy Desktop'])
  })

  it('positive — each file reads each of its keys (t() or a <Trans> i18nKey) from a useTranslation() hook', () => {
    for (const [file, keys] of UA12_194_WIRED) {
      const source = read(file)
      expect({ file, usesHook: /\buseTranslation\(\)/.test(source) }).toEqual({ file, usesHook: true })
      for (const key of keys) {
        const escaped = key.replace(/\./g, '\\.')
        expect({ file, key, read: new RegExp(`\\bt\\((['"])${escaped}\\1|i18nKey="${escaped}"`).test(source) }).toEqual({ file, key, read: true })
      }
    }
  })

  it('every key exists in both locales, the Russian value is not the English one, and the placeholders agree', () => {
    const en = enMessages as Record<string, string>
    const ru = ruMessages as Record<string, string>
    for (const key of [...new Set(UA12_194_WIRED.flatMap(([, keys]) => keys))]) {
      expect({ key, en: typeof en[key], ru: typeof ru[key] }).toEqual({ key, en: 'string', ru: 'string' })
      expect({ key, same: en[key] === ru[key] }).toEqual({ key, same: false })
      const slots = (text: string) => [...text.matchAll(/\{\{(\w+)\}\}|<(\w+)>/g)].map(match => match[0]).sort()
      expect({ key, slots: slots(ru[key] ?? '') }).toEqual({ key, slots: slots(en[key] ?? '') })
    }
  })
})

/**
 * F1.804 follow-up — the chat panel's close button (SIT-p's `aria-label="Close"` in the MAIN view, no dialog open) is
 * PanelSlot's `closeButton`: `PanelHeaderCenterButton` takes its aria-label from `tooltip={t('common.close')}`, but the
 * `useMemo` that builds it listed only `[handleClose]`. The language switch in Settings › Appearance is in place
 * (`i18n.changeLanguage`, no reload), so `useTranslation` hands the panel a new `t` while the memo keeps the element it
 * built in the first language: "Close" in the Russian UI until the panel remounts. `backButton` had the same deps gap.
 * This repo has no DOM under `bun test`, so the pin reads the hooks with the TypeScript parser: every `useMemo` /
 * `useCallback` in the file whose callback CALLS `t(…)` lists `t` in its dependency array.
 */
function memosReadingTWithoutT(file: string, source: string): { readers: string[]; stale: string[] } {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const readers: string[] = []
  const stale: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && /^use(Memo|Callback)$/.test(node.expression.text)) {
      const [callback, deps] = node.arguments
      let callsT = false
      const scan = (inner: ts.Node): void => {
        if (ts.isCallExpression(inner) && ts.isIdentifier(inner.expression) && inner.expression.text === 't') callsT = true
        ts.forEachChild(inner, scan)
      }
      if (callback) scan(callback)
      if (callsT) {
        const name = ts.isVariableDeclaration(node.parent) ? node.parent.name.getText(sourceFile) : `line ${sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1}`
        readers.push(name)
        const listsT = deps !== undefined && ts.isArrayLiteralExpression(deps) && deps.elements.some(element => ts.isIdentifier(element) && element.text === 't')
        if (!listsT) stale.push(name)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return { readers, stale }
}

describe('F1.804 follow-up — PanelSlot rebuilds its header buttons when the language changes', () => {
  it('CONTROL — the reader sees a memo that calls t() without listing it, and passes one that lists it', () => {
    expect(memosReadingTWithoutT('a.tsx', `const a = useMemo(() => <B tooltip={t('common.close')} />, [h])`))
      .toEqual({ readers: ['a'], stale: ['a'] })
    expect(memosReadingTWithoutT('b.tsx', `const b = useCallback(() => t('x'), [h, t])`)).toEqual({ readers: ['b'], stale: [] })
    expect(memosReadingTWithoutT('c.tsx', `const c = useMemo(() => h, [h])`)).toEqual({ readers: [], stale: [] })
  })

  it('closeButton and backButton call t() and list t in their deps', () => {
    expect(memosReadingTWithoutT('PanelSlot.tsx', read('../app-shell/PanelSlot.tsx')))
      .toEqual({ readers: ['closeButton', 'backButton'], stale: [] })
  })
})

/**
 * UA12.206 (LG-10, 2026-10-09) — the PROP-STRING arm. F1.477's census reads two attribute NAMES (`aria-label`,
 * `placeholder`) and UA12.137 / UA12.194 read element TEXT, so a literal handed to a component through any other prop
 * reached the Russian UI in English with every census green (LG-6's finding): SkillSelectorPopover's and
 * SourceSelectorPopover's `filterPlaceholder="Search skills..."` / `noResultsState="No matching skills."`, a `hint=`,
 * a `loadingText=`, a `title={cond ? t(…) : 'Connect to remote server'}` branch. This pass walks the same corpus
 * (`rendererTsxSources`, one `git grep`) with the TypeScript parser and takes every JSX ATTRIBUTE, whatever its name,
 * whose value is a string (`x="…"`, `x={'…'}`) or whose expression yields one through `?:`, `??`, `||` or the right of
 * `&&`, when it starts like prose (`JSX_TEXT_START`). Every name rather than a named prop set: run first at
 * `0237e9e1e` it answered twelve hits, ten wired by this row and two allow-listed below with their kind.
 * A TEMPLATE with a substitution (`title={`${name} Connected`}`) is read too, when one of its literal parts holds a
 * capitalised word (`TEMPLATE_PROSE_WORD`): the first arm read only plain strings, so AuthRequestCard's six status
 * props (`${authSourceName} Connected` / `Cancelled` / `Failed` / `Authentication`, `Signed in as ${authEmail}`,
 * `Workspace: ${authWorkspace}`) stayed English with this census green (the UA12.206 verifier's finding, wired by its
 * follow-up with the card's compact-state twins of the same four strings). Code-valued templates (`key`, `id`,
 * `data-testid`, `className`) hold no capitalised word: 82 template props over the corpus on 2026-10-09, six read.
 * A string YIELDED inside a template's substitution or either side of `+` is read like any other yield: the template
 * arm tests only the literal parts, so SessionFilesSection's row tooltip
 * (`title={`${file.displayPath}\n${isDirectory ? 'Directory' : …}`}`) stayed English with both arms green (the
 * UA12.206 follow-up verifier's finding, attempt 2); at HEAD on 2026-10-09 the span descent answered that one hit and
 * `+` none, over 364 files.
 *
 * NAMED RESIDUE, measured not hidden (2026-10-09): a string an expression CHILD yields the same way
 * (`{busy ? 'Sending...' : 'Send'}`) and a template whose only words are lowercase in a TEXT prop (BrowserTabBadge's
 * `aria-label={`${displayLabel} actions`}`) were not read here; UA12.209 reads both (its describes below). Still not
 * read by any census: an object-literal property (`label: 'Cancel'` — AuthRequestCard's are wired and pinned by
 * UA12.209), a function's returned label (AuthRequestCard's `getSignInProvider` since UB14.26, whose reachable values
 * are the brand names 'OAuth' and 'Google', upstream's untranslated provider) and a string an arrow function returns inside a child
 * (`{items.map(i => 'X')}`). data-table's `{emptyContent ?? 'No results.'}` is the one child this row wires,
 * because the row names it, with the lowercase `{n} total` beside it (no census reads a lowercase start); both are
 * pinned below by key and by the literal's absence.
 */
const ALLOWED_PROP_STRINGS: ReadonlyArray<readonly [string, string, 'brand' | 'css']> = [
  ['components/icons/NessyLogo.tsx', 'aria-label=Nessy Desktop', 'brand'],
  ['components/icons/NessyLogo.tsx', 'fontFamily=Inter, ui-sans-serif, system-ui, sans-serif', 'css'],
]

/** A capitalised word in a template's literal part (` Connected`, `Signed in as `, `Workspace: `); not `sep-`, `sha256 `. */
const TEMPLATE_PROSE_WORD = /(?:^|[\s(])[A-Z][a-z]+(?=[\s.,:;!?…]|$)/

/**
 * UA12.209 — a lowercase word (` actions`) in a template's literal part, read only in a TEXT prop: an attribute whose
 * whole value is words a person reads or hears. Elsewhere a lowercase template is code (`flex ${cls}`, `row-${id}`).
 */
const TEMPLATE_LOWER_WORD = /(?:^|\s)[a-z]{3,}(?=[\s.,:;!?…]|$)/
const TEXT_PROPS = /^(aria-label|aria-description|aria-roledescription|aria-valuetext|title|placeholder|alt|label|tooltip|description)$/

/** What an expression can evaluate to: through `?:`, `??`, `||`, the right of `&&`, either side of `+`, and a template's spans (the template too). */
function yieldedBy(expression: ts.Expression): ts.Expression[] {
  if (ts.isParenthesizedExpression(expression)) return yieldedBy(expression.expression)
  if (ts.isConditionalExpression(expression)) return [...yieldedBy(expression.whenTrue), ...yieldedBy(expression.whenFalse)]
  if (ts.isTemplateExpression(expression)) return [expression, ...expression.templateSpans.flatMap(span => yieldedBy(span.expression))]
  if (ts.isBinaryExpression(expression)) {
    const operator = expression.operatorToken.kind
    if (operator === ts.SyntaxKind.QuestionQuestionToken || operator === ts.SyntaxKind.BarBarToken) return [...yieldedBy(expression.left), ...yieldedBy(expression.right)]
    if (operator === ts.SyntaxKind.AmpersandAmpersandToken) return yieldedBy(expression.right)
    if (operator === ts.SyntaxKind.PlusToken) return [...yieldedBy(expression.left), ...yieldedBy(expression.right)]
  }
  return [expression]
}

/** The prose a yielded string or template carries (a template's text as written), or undefined. */
function proseOf(candidate: ts.Expression, parsed: ts.SourceFile, lowercaseWords = false): string | undefined {
  if (ts.isStringLiteral(candidate) || ts.isNoSubstitutionTemplateLiteral(candidate)) return JSX_TEXT_START.test(candidate.text) ? candidate.text : undefined
  if (!ts.isTemplateExpression(candidate)) return undefined
  const parts = [candidate.head.text, ...candidate.templateSpans.map(span => span.literal.text)]
  return parts.some(part => TEMPLATE_PROSE_WORD.test(part) || (lowercaseWords && TEMPLATE_LOWER_WORD.test(part))) ? candidate.getText(parsed) : undefined
}

/** `file:line: name=text` for each prose-like string a JSX attribute of `source` is given or yields (see above). */
function literalPropStrings(file: string, source: string): string[] {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TSX)
  const found: string[] = []
  const visit = (node: ts.Node) => {
    if (ts.isJsxAttribute(node) && node.initializer) {
      const value = ts.isJsxExpression(node.initializer) ? node.initializer.expression : node.initializer
      for (const candidate of value ? yieldedBy(value) : []) {
        const text = proseOf(candidate, parsed, TEXT_PROPS.test(node.name.getText(parsed)))
        if (text === undefined) continue
        const line = parsed.getLineAndCharacterOfPosition(candidate.getStart(parsed)).line + 1
        found.push(`${file}:${line}: ${node.name.getText(parsed)}=${text}`)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  return found
}

describe('UA12.206 — no literal prose string in a JSX prop in the renderer outside a named allow-list', () => {
  it('CONTROL — the pass sees a literal prop in every form, and no wired, code-like or child string', () => {
    expect(literalPropStrings('p.tsx', '<X noResultsState="No matching things." />')).toEqual(['p.tsx:1: noResultsState=No matching things.'])
    expect(literalPropStrings('p.tsx', "<X filterPlaceholder={'Search things...'} />")).toEqual(['p.tsx:1: filterPlaceholder=Search things...'])
    expect(literalPropStrings('p.tsx', "<X title={a\n  ? t('k')\n  : 'Connect to remote server'} />")).toEqual(['p.tsx:3: title=Connect to remote server'])
    expect(literalPropStrings('p.tsx', "<X label={name ?? 'Work in Folder'} hint={busy && 'Please wait'} />"))
      .toEqual(['p.tsx:1: label=Work in Folder', 'p.tsx:1: hint=Please wait'])
    expect(literalPropStrings('p.tsx', '<X title={`${a} Connected`} subtitle={b ? `Signed in as ${b}` : undefined} />'))
      .toEqual(['p.tsx:1: title=`${a} Connected`', 'p.tsx:1: subtitle=`Signed in as ${b}`'])
    expect(literalPropStrings('p.tsx', "<X title={`${a}\\n${b ? 'Directory' : c}`} label={'Open ' + name} />"))
      .toEqual(['p.tsx:1: title=Directory', 'p.tsx:1: label=Open '])
    for (const quiet of [
      "<X noResultsState={t('k')} />",
      '<X className="flex items-center" side="top" />',
      '<X data-key="X" />',
      "<X>{busy ? 'Sending...' : 'Send'}</X>",
      "const a = { label: 'Cancel' }",
      '<X key={`sep-${i}`} data-testid={`row-${id}-Done`} className={`flex ${cls}`} title={`sha256 ${h}`} />',
      "<X title={t('auth.sourceConnected', { source: a })} />",
    ]) expect({ quiet, found: literalPropStrings('p.tsx', quiet) }).toEqual({ quiet, found: [] })
  })

  it('the census over apps/electron/src/renderer answers only the allow-list', () => {
    const sources = rendererTsxSources()
    expect(sources.size).toBeGreaterThan(300) // the corpus was read, not an empty scan
    const hits = [...sources].flatMap(([file, source]) => literalPropStrings(file, source))
    const unexpected = hits.filter(hit => !ALLOWED_PROP_STRINGS.some(([file, prop]) => hit.startsWith(`${file}:`) && hit.endsWith(`: ${prop}`)))
    expect(unexpected).toEqual([])
    for (const [file, prop] of ALLOWED_PROP_STRINGS) {
      expect({ file, prop, present: hits.some(hit => hit.startsWith(`${file}:`) && hit.endsWith(`: ${prop}`)) }).toEqual({ file, prop, present: true })
    }
  })
})

/** UA12.206 — where each wired prop string's key is read, so a reverted line fails here as well as in the census. */
const UA12_206_WIRED: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['../app-shell/input/FreeFormInput.tsx', ['chat.workInFolder']],
  // UB14.26 — upstream v0.15.1's `chat.authCard.*` names replaced the card's `auth.*` keys, plus ours `titleDp`.
  ['../chat/AuthRequestCard.tsx', ['chat.authCard.cancelled', 'chat.authCard.connected', 'chat.authCard.encryptedAtRest', 'chat.authCard.failed', 'chat.authCard.signedInAs', 'chat.authCard.titleCredential', 'chat.authCard.titleDp', 'chat.authCard.titleGoogle', 'chat.authCard.titleOAuth', 'chat.authCard.workspace']],
  ['../onboarding/LocalModelStep.tsx', ['common.connecting']],
  ['../right-sidebar/SessionFilesSection.tsx', ['chat.sessionFilesDirectory']],
  ['../ui/SkillSelectorPopover.tsx', ['skillsList.noMatchingSkills', 'skillsList.searchPlaceholder']],
  ['../ui/SourceSelectorPopover.tsx', ['sourcesList.noMatchingSources', 'sourcesList.searchPlaceholder']],
  ['../ui/data-table.tsx', ['datatable.noResults', 'datatable.total']],
  ['../workspace/AddWorkspaceStep_ConnectRemote.tsx', ['workspace.connectRemote', 'workspace.connectRemoteDescription', 'workspace.reconnectDescription']],
]

describe('UA12.206 — the prop-string survivors go through t(); only the brand and a font stack stay literal', () => {
  it('the allow-list is the recorded-deliberate set: the product name and a CSS font stack', () => {
    expect(ALLOWED_PROP_STRINGS.map(([, prop, kind]) => `${kind}:${prop.slice(0, prop.indexOf('='))}`)).toEqual(['brand:aria-label', 'css:fontFamily'])
  })

  it('positive — each file reads each of its keys from a useTranslation() hook', () => {
    for (const [file, keys] of UA12_206_WIRED) {
      const source = read(file)
      expect({ file, usesHook: /\buseTranslation\(\)/.test(source) }).toEqual({ file, usesHook: true })
      for (const key of keys) {
        const escaped = key.replace(/\./g, '\\.')
        expect({ file, key, read: new RegExp(`\\bt\\((['"])${escaped}\\1`).test(source) }).toEqual({ file, key, read: true })
      }
    }
  })

  it('every key exists in both locales, the Russian value is not the English one, and the placeholders agree', () => {
    const en = enMessages as Record<string, string>
    const ru = ruMessages as Record<string, string>
    for (const key of [...new Set(UA12_206_WIRED.flatMap(([, keys]) => keys))]) {
      expect({ key, en: typeof en[key], ru: typeof ru[key] }).toEqual({ key, en: 'string', ru: 'string' })
      expect({ key, same: en[key] === ru[key] }).toEqual({ key, same: false })
      const slots = (text: string) => [...text.matchAll(/\{\{(\w+)\}\}/g)].map(match => match[0]).sort()
      expect({ key, slots: slots(ru[key] ?? '') }).toEqual({ key, slots: slots(en[key] ?? '') })
    }
  })

  it('negative — data-table\'s two child literals are gone (the census above cannot see a child)', () => {
    const table = read('../ui/data-table.tsx')
    expect(table.includes("'No results.'")).toBe(false)
    expect(/\}\s*total\b/.test(table)).toBe(false)
  })
})

/**
 * UA12.209 (LG-12, 2026-10-09) — the expression-CHILD arm. UA12.194 reads a JSX text node and a child that IS a
 * string (`{'Send'}`); a string a child YIELDS — `{busy ? 'Sending...' : 'Send'}`, `{name || 'Workspace'}`,
 * `{`${source} Authenticating...`}` — reached the Russian UI in English with every census green (P-LG-10-2: 17
 * children over 9 files at `bff498851`, plus the template child UA12.206's follow-up named). This pass walks the same
 * corpus and takes each JSX expression child that is not itself a string, follows it with the prop arm's `yieldedBy`,
 * and reads each yield with the prop arm's `proseOf` (a string starting like prose, or a template with a capitalised
 * word). Run first at `a1a54d7c5` it answered eighteen hits; seventeen go through `t()` (keys below) and MultiSelectPanel's
 * `Ctrl` keycap stays, with its kind. The TEXT-prop rule (`TEXT_PROPS`, above) is this row's other half: a template in
 * an `aria-label` / `title` / … whose literal part holds only lowercase words (BrowserTabBadge's
 * `${displayLabel} actions`) is read too — one hit over the corpus, wired.
 */
const ALLOWED_CHILD_STRINGS: ReadonlyArray<readonly [string, string, 'keycap']> = [
  ['components/app-shell/MultiSelectPanel.tsx', 'Ctrl', 'keycap'],
]

/** `file:line: text` for each prose-like string a JSX expression child of `source` yields (see above). */
function literalChildStrings(file: string, source: string): string[] {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TSX)
  const found: string[] = []
  const visit = (node: ts.Node) => {
    if (ts.isJsxElement(node) || ts.isJsxFragment(node)) {
      for (const child of node.children) {
        const expression = ts.isJsxExpression(child) ? child.expression : undefined
        if (!expression || ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) continue // UA12.194's
        for (const candidate of yieldedBy(expression)) {
          const text = proseOf(candidate, parsed)
          if (text !== undefined) found.push(`${file}:${parsed.getLineAndCharacterOfPosition(candidate.getStart(parsed)).line + 1}: ${text}`)
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  return found
}

describe('UA12.209 — no literal prose string yielded by a JSX expression child, nor a lowercase template in a text prop', () => {
  it('CONTROL — the child pass sees a yielded literal in every form, and no wired, plain-string, code-like or prop string', () => {
    expect(literalChildStrings('c.tsx', "<X>{busy ? 'Sending...' : t('k')}</X>")).toEqual(['c.tsx:1: Sending...'])
    expect(literalChildStrings('c.tsx', "<X>\n  {name || 'Workspace'}\n</X>")).toEqual(['c.tsx:2: Workspace'])
    expect(literalChildStrings('c.tsx', '<X>{`${a} Authenticating...`}</X>')).toEqual(['c.tsx:1: `${a} Authenticating...`'])
    expect(literalChildStrings('c.tsx', "<>{model?.name ?? 'Select model...'}{on && 'Please wait'}</>"))
      .toEqual(['c.tsx:1: Select model...', 'c.tsx:1: Please wait'])
    expect(literalChildStrings('c.tsx', "<X>{`${n}: ${ok ? 'Done' : t('k')}`}</X>")).toEqual(['c.tsx:1: Done'])
    for (const quiet of [
      "<X>{a ? t('k') : t('j')}</X>",
      "<X>{'Send to Workspace'}</X>",
      '<X>{count}</X>',
      '<X>{`${n} items`}</X>',
      "<X>{isMac ? '⌘' : 'K'}</X>",
      '<X>{open && <Y />}</X>',
      "<X title={busy ? 'Sending...' : 'Send'} />",
      "const a = busy ? 'Sending...' : 'Send'",
    ]) expect({ quiet, found: literalChildStrings('c.tsx', quiet) }).toEqual({ quiet, found: [] })
  })

  it('CONTROL — the prop pass reads a lowercase-only template in a text prop, and not in any other prop', () => {
    expect(literalPropStrings('p.tsx', '<X aria-label={`${label} actions`} />')).toEqual(['p.tsx:1: aria-label=`${label} actions`'])
    expect(literalPropStrings('p.tsx', '<X title={a ? `${n} selected` : undefined} />')).toEqual(['p.tsx:1: title=`${n} selected`'])
    for (const quiet of [
      '<X data-label={`${label} actions`} />',
      '<X className={`flex ${cls}`} key={`row-${i}`} />',
      '<X aria-label={`${a} ${b}`} title={`${n}px`} />',
      "<X aria-label={t('browser.tabActions', { label })} />",
    ]) expect({ quiet, found: literalPropStrings('p.tsx', quiet) }).toEqual({ quiet, found: [] })
  })

  it('the child census over apps/electron/src/renderer answers only the allow-list', () => {
    const sources = rendererTsxSources()
    expect(sources.size).toBeGreaterThan(300) // the corpus was read, not an empty scan
    const hits = [...sources].flatMap(([file, source]) => literalChildStrings(file, source))
    const unexpected = hits.filter(hit => !ALLOWED_CHILD_STRINGS.some(([file, text]) => hit.startsWith(`${file}:`) && hit.endsWith(`: ${text}`)))
    expect(unexpected).toEqual([])
    for (const [file, text] of ALLOWED_CHILD_STRINGS) {
      expect({ file, text, present: hits.some(hit => hit.startsWith(`${file}:`) && hit.endsWith(`: ${text}`)) }).toEqual({ file, text, present: true })
    }
  })
})

/**
 * UA12.209 — AuthRequestCard's COMPACT card (the terminal state after the next message) builds its title and subtitle
 * in plain variables (`const title = … ? t('chat.authCard.connected', …) : …` since UB14.26) and hands them over as `title={title}`,
 * so no census reads them: UA12.206's follow-up wired them, and a revert to `${authSourceName} Connected` would have
 * stayed green (its re-check's LOW). This pin parses the card, finds the compact branch by its condition, and reads
 * every string and template in it with `proseOf`; the keys it must call are named.
 */
// UB14.26 — upstream v0.15.1's condition (a status with no outcome tone draws no compact card) and key names.
const COMPACT_CARD_CONDITION = "!isInteractive && authStatus !== 'pending' && outcomeTone"
const COMPACT_CARD_KEYS = ['chat.authCard.cancelled', 'chat.authCard.connected', 'chat.authCard.failed', 'chat.authCard.signedInAs'] as const

/** The compact branch's text and every prose-like string or template inside it. */
function compactCardProse(source: string): { block: string; prose: string[] } {
  const parsed = ts.createSourceFile('AuthRequestCard.tsx', source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TSX)
  let branch: ts.IfStatement | undefined
  const find = (node: ts.Node) => {
    if (!branch && ts.isIfStatement(node) && node.expression.getText(parsed) === COMPACT_CARD_CONDITION) branch = node
    ts.forEachChild(node, find)
  }
  find(parsed)
  if (!branch) return { block: '', prose: [] }
  const prose: string[] = []
  const scan = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
      const text = proseOf(node, parsed)
      if (text !== undefined) prose.push(text)
    }
    ts.forEachChild(node, scan)
  }
  scan(branch.thenStatement)
  return { block: branch.thenStatement.getText(parsed), prose }
}

describe('UA12.209 — AuthRequestCard\'s compact card keeps its status strings in t()', () => {
  const card = () => read('../chat/AuthRequestCard.tsx')

  it('CONTROL — a revert of the compact card to the English templates is found, on the real file', () => {
    const reverted = card()
      .replace("t('chat.authCard.connected', { name: authSourceName ?? '' }) :", '`${authSourceName} Connected` :')
      .replace("authEmail ? t('chat.authCard.signedInAs', { email: authEmail }) :", 'authEmail ? `Signed in as ${authEmail}` :')
    expect(compactCardProse(reverted).prose).toEqual(['`${authSourceName} Connected`', '`Signed in as ${authEmail}`'])
  })

  it('the compact branch is found, calls each status key, and holds no prose literal', () => {
    const { block, prose } = compactCardProse(card())
    expect(block.length).toBeGreaterThan(0)
    for (const key of COMPACT_CARD_KEYS) expect({ key, called: block.includes(`t('${key}'`) }).toEqual({ key, called: true })
    expect(prose).toEqual([])
  })
})

/** UA12.209 — where each wired string's key is read, so a reverted line fails here as well as in the census. */
const UA12_209_WIRED: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['../apisetup/ApiKeyInput.tsx', ['apiSetup.selectModel']],
  ['../app-shell/CompactWorkspaceSwitcher.tsx', ['workspace.workspaceLabel']],
  ['../app-shell/SendToWorkspaceDialog.tsx', ['sendToWorkspace.resourceSend', 'sendToWorkspace.resourceSendingButton']],
  ['../app-shell/WorkspaceSwitcher.tsx', ['workspace.selectWorkspace', 'workspace.workspaceLabel']],
  ['../app-shell/input/structured/PermissionRequest.tsx', ['chat.permissionAllow', 'chat.permissionAlwaysAllow', 'chat.permissionDeny']],
  ['../browser/BrowserTabBadge.tsx', ['browser.localFile', 'browser.tabActions']],
  ['../chat/AuthRequestCard.tsx', ['chat.authCard.authenticating', 'chat.authCard.completeInBrowser', 'chat.authCard.restartSignIn', 'chat.authCard.signInWith', 'common.cancel', 'common.save', 'common.saving']],
  ['../ui/session-status-menu.tsx', ['common.clear', 'sessionMenu.archive', 'sessionMenu.unarchive']],
  ['../workspace/AddWorkspaceStep_ConnectRemote.tsx', ['common.failed', 'workspace.testConnection', 'workspace.testingConnection']],
]

describe('UA12.209 — the child and object-literal survivors go through t(); only the Ctrl keycap stays literal', () => {
  it('the allow-list is the recorded-deliberate set: one keycap', () => {
    expect(ALLOWED_CHILD_STRINGS.map(([, text, kind]) => `${kind}:${text}`)).toEqual(['keycap:Ctrl'])
  })

  it('positive — each file reads each of its keys from a useTranslation() hook', () => {
    for (const [file, keys] of UA12_209_WIRED) {
      const source = read(file)
      expect({ file, usesHook: /\buseTranslation\(\)/.test(source) }).toEqual({ file, usesHook: true })
      for (const key of keys) {
        const escaped = key.replace(/\./g, '\\.')
        expect({ file, key, read: new RegExp(`\\bt\\((['"])${escaped}\\1`).test(source) }).toEqual({ file, key, read: true })
      }
    }
  })

  it('every key exists in both locales, the Russian value is not the English one, and the placeholders agree', () => {
    const en = enMessages as Record<string, string>
    const ru = ruMessages as Record<string, string>
    for (const key of [...new Set(UA12_209_WIRED.flatMap(([, keys]) => keys))]) {
      expect({ key, en: typeof en[key], ru: typeof ru[key] }).toEqual({ key, en: 'string', ru: 'string' })
      expect({ key, same: en[key] === ru[key] }).toEqual({ key, same: false })
      const slots = (text: string) => [...text.matchAll(/\{\{(\w+)\}\}/g)].map(match => match[0]).sort()
      expect({ key, slots: slots(ru[key] ?? '') }).toEqual({ key, slots: slots(en[key] ?? '') })
    }
  })

  it('negative — none of the literals remains (the object-literal labels no census reads included)', () => {
    const gone: ReadonlyArray<readonly [string, RegExp]> = [
      ['../apisetup/ApiKeyInput.tsx', /'Select model\.\.\.'/],
      ['../app-shell/CompactWorkspaceSwitcher.tsx', /\|\| 'Workspace'/],
      ['../app-shell/SendToWorkspaceDialog.tsx', /'Sending\.\.\.'|: 'Send'/],
      ['../app-shell/WorkspaceSwitcher.tsx', /\|\| '(Workspace|Select workspace)'/],
      ['../app-shell/input/structured/PermissionRequest.tsx', /'(Allow|Always Allow|Deny)'/],
      ['../browser/BrowserTabBadge.tsx', /\} actions`|'Local File'/],
      ['../chat/AuthRequestCard.tsx', /Authenticating\.\.\.|'Complete authentication in your browser'|label: 'Cancel'|'Saving\.\.\.'|: 'Save'|`Sign in with /],
      ['../ui/session-status-menu.tsx', /\?\? 'Clear'|'(Unarchive|Archive)'/],
      ['../workspace/AddWorkspaceStep_ConnectRemote.tsx', /'Testing\.\.\.'|'Test Connection'|\|\| 'Failed'/],
    ]
    for (const [file, literal] of gone) expect({ file, found: literal.test(read(file)) }).toEqual({ file, found: false })
  })
})

/**
 * UA12.214 (ua-r214, 2026-10-09) — the OBJECT-LITERAL arm, keyed on UI property
 * names. The child arm (UA12.209) and the prop arm (UA12.206) read JSX
 * positions; the prose-starting VALUES of object-literal properties reached no
 * census — 418 over this corpus at `a1a54d7c5` (LG-12's `probe.ts obj`), 413 at
 * HEAD `9c8276997` (UA12.209's readers had taken five). The arm takes a
 * PropertyAssignment whose name is a UI property (`UI_OBJECT_PROPS`), follows
 * the value through the prop arm's `yieldedBy`, and reads each yield with the
 * prop arm's `proseOf` — so a t() call never matches, and `defaultValue` is not
 * watched at all: every `defaultValue` hit in this corpus is the i18next
 * fallback option INSIDE a t() call, i.e. already wired. The triage of the 413:
 *
 *  - WIRED through t() (38 keys en+ru, `UA12_214_WIRED` below): the slash
 *    menu's last eight untranslated command ids (cd, compact, config, diff,
 *    goal, hooks, mcp, status — the other eighteen re-resolve through
 *    `commands.<id>.{label,description}` and `mode.*` at render, so their
 *    literals are already the t() defaultValue), CronBuilder's preset and field
 *    labels (`labelKey`, EditPopover's carrier pattern), PhaseBadge's five
 *    badge labels (`labelKey`), ApiKeyInput's reachable prose placeholder (the
 *    render site — DA1.53's visible-key filter leaves only the `custom` row and
 *    the no-preset fallback reachable; the gateway row is unreachable), App's
 *    Install toast action, browser-toolbar's New Tab title, mention-menu's
 *    Results header.
 *  - ALLOW-LISTED per file, one reason each (`ALLOWED_OBJECT_LITERALS`).
 *  - Not UI prose and not watched: actions/registry.tsx and context-menu.tsx
 *    (keyboard identifiers), ShikiCodeEditor (a font stack), APISetupStep
 *    ('ChatGPT Plus', a plan name), AdminApprovalRequest's appName (not watched
 *    by this arm and still unwired after the follow-up row below — no census
 *    reads it), the provider-id keys of AiSettingsPage's label map.
 */
const UI_OBJECT_PROPS = /^(label|description|placeholder|overridePlaceholder|title|tooltip|example)$/
const ALLOWED_OBJECT_LITERALS: ReadonlyArray<readonly [string, string]> = [
  ['components/ui/EditPopover.tsx',
    'the label literal reaches the agent as the managed target and unsentNotes reaches nobody (F1.460); every entry resolves its UI text from displayLabelKey/exampleKey/overridePlaceholderKey at :608-610, so the literals are the English fallbacks'],
  ['components/ui/slash-command-menu.tsx',
    'the render path re-resolves label and description through commands.<id>.{label,description} and mode.* (getTranslatedCommandLabel/Description); the literals are the t() defaultValue and the filter-matching text'],
  ['components/apisetup/ApiKeyInput.tsx',
    'provider names are brand text; the placeholder literals are API-key format examples (F1.477\'s AKIA precedent) or the fallbacks of the render-site resolution; the gateway row is unreachable (DA1.53)'],
  ['pages/settings/AiSettingsPage.tsx',
    'provider display names (PI_AUTH_PROVIDER_LABELS) and the backend/protocol names in the connection descriptions are brand text'],
  ['components/app-shell/rewind-menu.tsx',
    'REWIND_MENU_DOCUMENTED_ITEMS is the documented-surface ledger consumed by rewind-menu.test.tsx: label is the upstream page\'s own item name, note is the measurement record — neither renders'],
  ['components/automations/CronBuilder.tsx',
    'the preset description and the month/weekday option labels have no reader: the preset buttons render preset.labelKey only and the field renders a text input'],
]

/** `prop=value` for each prose-like string a UI-named object-literal property of `source` carries (see above). */
function literalObjectProse(file: string, source: string): { prop: string; text: string }[] {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TSX)
  const found: { prop: string; text: string }[] = []
  const visit = (node: ts.Node) => {
    if (ts.isPropertyAssignment(node) && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) && UI_OBJECT_PROPS.test(node.name.text)) {
      for (const candidate of yieldedBy(node.initializer)) {
        const text = proseOf(candidate, parsed)
        if (text !== undefined) found.push({ prop: node.name.text, text: `${node.name.text}=${text}` })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  return found
}

describe('UA12.214 — no literal prose in an object-literal UI property in the renderer outside a named allow-list', () => {
  it('CONTROL (planted) — prose in an unlisted file trips; a t() call, a template without a capitalised word and a non-UI property do not', () => {
    expect(literalObjectProse('planted.tsx', "const rows = [{ label: 'Archive', description: 'Restore point' }]"))
      .toEqual([{ prop: 'label', text: 'label=Archive' }, { prop: 'description', text: 'description=Restore point' }])
    expect(literalObjectProse('planted.tsx', "const rows = [{ label: t('common.archive') }]")).toEqual([])
    expect(literalObjectProse('planted.tsx', 'const rows = [{ label: `page ${n} of ${total}` }]')).toEqual([])
    expect(literalObjectProse('planted.tsx', 'const rows = [{ key: \'Escape\', fontFamily: \'"JetBrains Mono", monospace\' }]')).toEqual([])
    expect(literalObjectProse('planted.tsx', 'const rows = [{ label: `Select ${n}` }]')).toEqual([{ prop: 'label', text: 'label=`Select ${n}`' }])
  })

  it('the census over apps/electron/src/renderer answers only the allow-list', () => {
    const hits: string[] = []
    for (const [file, source] of rendererTsxSources()) {
      for (const { text } of literalObjectProse(file, source)) hits.push(`${file}: ${text}`)
    }
    const unexpected = hits.filter(hit => !ALLOWED_OBJECT_LITERALS.some(([file]) => hit.startsWith(`${file}:`)))
    expect(unexpected).toEqual([])
    // The allow-list is live, not decoration: every entry still matches (so a wired or emptied file must leave the list).
    for (const [file] of ALLOWED_OBJECT_LITERALS) {
      expect({ file, present: hits.some(hit => hit.startsWith(`${file}:`)) }).toEqual({ file, present: true })
    }
  })
})

/** UA12.214 — the three files whose wired key is read by a literal t('<key>') call. */
const UA12_214_DIRECT: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['../../App.tsx', ['common.install']],
  ['../../browser-toolbar.tsx', ['browser.newTab']],
  ['../ui/mention-menu.tsx', ['chat.mentionSection.results']],
]

/**
 * UA12.214 — the key-carrier files (EditPopover's pattern): the key string is
 * DATA on the object and the render site resolves the carrier through t(). The
 * regex is the resolution site; each key is asserted as a quoted literal in the
 * file. slash-command-menu is NOT here: its keys are never spelled — the
 * resolver builds `commands.${id}.{label,description}` — so its eight new ids
 * are pinned as TRANSLATED_COMMAND_IDS members below, and their keys live in
 * UA12_214_SLASH_KEYS for the locales check.
 */
const UA12_214_KEY_CARRIERS: ReadonlyArray<readonly [string, readonly string[], RegExp]> = [
  ['../automations/CronBuilder.tsx', [
    'automations.cronFieldDay', 'automations.cronFieldHour', 'automations.cronFieldMinute', 'automations.cronFieldMonth', 'automations.cronFieldWeekday',
    'automations.cronPresetDaily9am', 'automations.cronPresetDailyMidnight', 'automations.cronPresetEvery15Min', 'automations.cronPresetEveryHour',
    'automations.cronPresetEveryMinute', 'automations.cronPresetMonthly1st', 'automations.cronPresetWeekdays9am',
  ], /\bt\((preset|field)\.labelKey\)/],
  ['../automations/PhaseBadge.tsx', [
    'automations.phaseBadgeAfter', 'automations.phaseBadgeBefore', 'automations.phaseBadgeEvent', 'automations.phaseBadgeOnError', 'automations.phaseBadgeScheduled',
  ], /\bt\(badge\.labelKey\)/],
  ['../apisetup/ApiKeyInput.tsx', ['apiSetup.placeholderPasteKey'], /\bt\('apiSetup\.placeholderPasteKey'\)/],
]

/** The eight ids this row adds to TRANSLATED_COMMAND_IDS, and the keys they read. */
const UA12_214_SLASH_IDS = ['cd', 'compact', 'config', 'diff', 'goal', 'hooks', 'mcp', 'status'] as const
const UA12_214_SLASH_KEYS = UA12_214_SLASH_IDS.flatMap(id => [`commands.${id}.description`, `commands.${id}.label`])

const UA12_214_KEYS = [...new Set([...UA12_214_DIRECT, ...UA12_214_KEY_CARRIERS].flatMap(([, keys]) => keys).concat(UA12_214_SLASH_KEYS))]

describe('UA12.214 — the wired UI strings go through t(); only the allow-list stays literal', () => {
  it('positive — direct files call t() with each key; carrier files carry each key and resolve the carrier through t()', () => {
    for (const [file, keys] of UA12_214_DIRECT) {
      const source = read(file)
      for (const key of keys) {
        const escaped = key.replace(/\./g, '\\.')
        expect({ file, key, read: new RegExp(`\\bt\\((['"])${escaped}\\1`).test(source) }).toEqual({ file, key, read: true })
      }
    }
    for (const [file, keys, resolver] of UA12_214_KEY_CARRIERS) {
      const source = read(file)
      expect({ file, resolves: resolver.test(source) }).toEqual({ file, resolves: true })
      for (const key of keys) {
        const escaped = key.replace(/\./g, '\\.')
        expect({ file, key, carried: new RegExp(`['"\`]${escaped}['"\`]`).test(source) }).toEqual({ file, key, carried: true })
      }
    }
  })

  it('slash-command-menu resolves the eight ids — each sits in TRANSLATED_COMMAND_IDS', () => {
    const source = read('../ui/slash-command-menu.tsx')
    const setLine = source.split('\n').find(line => line.startsWith('const TRANSLATED_COMMAND_IDS'))
    expect(setLine).toBeDefined()
    for (const id of UA12_214_SLASH_IDS) {
      expect({ id, member: setLine!.includes(`'${id}'`) }).toEqual({ id, member: true })
    }
  })

  it('every key exists in both locales, and the Russian value differs except the two names that are their own spelling', () => {
    const en = enMessages as Record<string, string>
    const ru = ruMessages as Record<string, string>
    const SAME_IN_BOTH: ReadonlyArray<readonly [string, string]> = [
      ['commands.cd.label', "the shell command's own name"],
      ['commands.mcp.label', 'the protocol acronym'],
    ]
    for (const key of UA12_214_KEYS) {
      expect({ key, en: typeof en[key], ru: typeof ru[key] }).toEqual({ key, en: 'string', ru: 'string' })
      expect({ key, same: en[key] === ru[key] }).toEqual({ key, same: SAME_IN_BOTH.some(([same]) => same === key) })
    }
  })

  it('negative — the wired render positions carry no literal (the allow-list keeps the fallbacks)', () => {
    const gone: ReadonlyArray<readonly [string, RegExp]> = [
      ['../automations/CronBuilder.tsx', /label: 'Every minute'|label: 'Daily at midnight'/],
      ['../automations/PhaseBadge.tsx', /label: '(Scheduled|On Error)'/],
      ['../../App.tsx', /label: 'Install'/],
      ['../../browser-toolbar.tsx', /title: 'New Tab'/],
      ['../ui/mention-menu.tsx', /label: 'Results'/],
    ]
    for (const [file, literal] of gone) expect({ file, found: literal.test(read(file)) }).toEqual({ file, found: false })
  })
})

/**
 * UA12.214 follow-up (ua-r214f, 2026-10-10) — the two OWED allow-list entries left the list above.
 * App.tsx: the /compact command badge in the user's message bubble and the send-failed template the
 * catch block stores as an error bubble's content (its 'Unknown error' fallback reads
 * toast.unknownError). ChatDisplay.tsx: the seven watched strings — the two markdown-overlay preview
 * titles and Turn Details (the overlay.* family beside overlay.preview), the send-disabled toast
 * description under the already-translated toast.cannotSendRightNow, and the three annotation toasts'
 * 'Unknown error' fallbacks (toast.unknownError reused) — plus the two unwatched `name=` hits at the
 * branch creation, whose title is UI prose in the session list ('Untitled' falls back to
 * chat.titlePlaceholder). Every touched useCallback that now calls t() lists t in its deps, which
 * also shrinks the send callback's and handleSaveAndSendFollowUp's pre-existing exhaustive-deps
 * warnings by the same edit. Two stated residues, neither hidden: the four `const message =
 * … : 'Unknown error'` locals in App.tsx and AdminApprovalRequest's appName are function-returned or
 * unwatched positions no census reads (P-LG-12-2's class), and a stored error bubble or session name
 * keeps the language of the moment it was composed — the render-site redesign is P-LG-12-2's.
 */
const UA12_214F_WIRED: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['../../App.tsx', ['chat.compactCommandBadge', 'chat.sendFailed', 'toast.unknownError']],
  ['../app-shell/ChatDisplay.tsx', [
    'chat.branchOfSession', 'chat.titlePlaceholder', 'overlay.messagePreview', 'overlay.responsePreview',
    'overlay.turnDetails', 'toast.sendingDisabledForSession', 'toast.unknownError',
  ]],
]

/** The seven keys the follow-up row adds to both locales (the readers reuse two existing keys beside them). */
const UA12_214F_KEYS = [
  'chat.branchOfSession', 'chat.compactCommandBadge', 'chat.sendFailed', 'overlay.messagePreview',
  'overlay.responsePreview', 'overlay.turnDetails', 'toast.sendingDisabledForSession',
] as const

/** The eight wired literals; the App regex spares the console.error log and the four unwired locals. */
const UA12_214F_GONE: ReadonlyArray<readonly [string, RegExp]> = [
  ['../../App.tsx', /label: 'Compact'|Failed to send message: \$\{/],
  ['../app-shell/ChatDisplay.tsx', /title: '(Message|Response) Preview'|title: 'Turn Details'|Sending is currently disabled|Branch of \$\{|: 'Unknown error'/],
]

describe('UA12.214 follow-up — the two OWED files go through t(); the allow-list no longer carries them', () => {
  it('positive — each file calls t() with each of its keys, from a useTranslation() hook', () => {
    for (const [file, keys] of UA12_214F_WIRED) {
      const source = read(file)
      expect({ file, usesHook: /\buseTranslation\(\)/.test(source) }).toEqual({ file, usesHook: true })
      for (const key of keys) {
        const escaped = key.replace(/\./g, '\\.')
        expect({ file, key, read: new RegExp(`\\bt\\((['"])${escaped}\\1`).test(source) }).toEqual({ file, key, read: true })
      }
    }
  })

  it('every new key exists in both locales, the Russian value is not the English one, and the placeholders agree', () => {
    const en = enMessages as Record<string, string>
    const ru = ruMessages as Record<string, string>
    for (const key of UA12_214F_KEYS) {
      expect({ key, en: typeof en[key], ru: typeof ru[key] }).toEqual({ key, en: 'string', ru: 'string' })
      expect({ key, same: en[key] === ru[key] }).toEqual({ key, same: false })
      const slots = (text: string) => [...text.matchAll(/\{\{(\w+)\}\}/g)].map(match => match[0]).sort()
      expect({ key, slots: slots(ru[key] ?? '') }).toEqual({ key, slots: slots(en[key] ?? '') })
    }
  })

  it('negative — none of the eight literals remains (the console log and the four App locals keep their English)', () => {
    for (const [file, literal] of UA12_214F_GONE) expect({ file, found: literal.test(read(file)) }).toEqual({ file, found: false })
  })
})

/**
 * UB12.57 (born 2026-10-16 by L-DIALOGS at UB14.37) — the DEFAULT-PARAMETER arm. Every arm above reads a position the
 * string is RENDERED from (a JSX attribute, a text node, a yielded child, an object-literal UI property); a literal that
 * is a parameter's or a destructured prop's DEFAULT (`function BackButton({ children = 'Back' })`) reached none, so
 * the onboarding Back/Continue buttons showed English under ru on every step that passes no label (APISetupStep,
 * CredentialsStep, LocalModelStep, GitBashWarning, ByoRuntimeStep) with every census green. v0.15.1 ships the same
 * literals (`onboarding/primitives.tsx`), so this is not a regression. This pass walks the same corpus
 * (`rendererTsxSources`) and takes every parameter and every binding element (a destructured prop, in a parameter or a
 * `const { … } = props`) whose initializer is, or yields through the prop arm's `yieldedBy`, a string `proseOf` reads.
 * Run first over the renderer at `a36ace61b` (2026-10-16, 398 files) it answered SIXTEEN hits in eleven files, every
 * one a parameter default: the three in `onboarding/primitives.tsx` (`children=Back`, `children=Continue`,
 * `loadingText=Loading...`) wired by this row to `common.back` / `common.continue` / `common.loading`, and the thirteen
 * the allow-list below names (eleven entries; SettingsSelect and SettingsMenuSelect carry `Select...` twice each).
 *
 * NAMED RESIDUE, OWED (not deliberate): those thirteen are user-visible defaults this row did not widen into (its
 * scope is the onboarding buttons and the reauth fallback); the Phase 12 row born from UB12.57 wires them, and because
 * the allow-list is live (every entry must still match) each default it wires must leave the list in the same commit. ReauthScreen's `'Login failed'` was a `?:` fallback handed to `setError`, a position no
 * census reads (P-LG-12-2's class): it is pinned below by key and by the literal's absence.
 *
 * UB12.86 (2026-10-17) wired all thirteen: each component now leaves the prop unset and renders `prop ?? t(key)`
 * (SessionSearchHeader `session.searchPlaceholder`; the three data tables' overlay titles `settings.labels.autoApplyRules`
 * / `settings.labels.title` / `settings.permissions.title`; the skill preview's kind `plugins.kind.skill`; the secret
 * input `labels.value.enterValue`; both selects' four placeholders `common.selectPlaceholder`; the colour picker
 * `common.pickColor` / `common.resetToDefault`; the workspace primary button `common.continue`), so the list is EMPTY.
 * It stays live: a new prose default fails the census until it is wired or named here with its kind. The rendered ru
 * arms and the per-file key pins are in `default-param-labels-i18n.test.tsx`.
 */
const ALLOWED_DEFAULT_PARAMS: ReadonlyArray<readonly [string, string, 'owed']> = []

/** `file:line: name=text` for each prose-like string a parameter or destructured-prop DEFAULT of `source` carries. */
function literalDefaultParams(file: string, source: string): string[] {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TSX)
  const found: string[] = []
  const visit = (node: ts.Node) => {
    if ((ts.isParameter(node) || ts.isBindingElement(node)) && node.initializer) {
      const name = (ts.isBindingElement(node) && node.propertyName ? node.propertyName : node.name).getText(parsed)
      for (const candidate of yieldedBy(node.initializer)) {
        const text = proseOf(candidate, parsed)
        if (text === undefined) continue
        const line = parsed.getLineAndCharacterOfPosition(candidate.getStart(parsed)).line + 1
        found.push(`${file}:${line}: ${name}=${text}`)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  return found
}

describe('UB12.57 — no literal prose default parameter in the renderer outside a named allow-list', () => {
  it('CONTROL — the pass sees a prose default in every parameter form, and no wired, code-like or non-default string', () => {
    expect(literalDefaultParams('d.tsx', "export function B({ children = 'Back', ...props }: P) { return null }"))
      .toEqual(['d.tsx:1: children=Back'])
    expect(literalDefaultParams('d.tsx', "const C = ({\n  loading,\n  loadingText = 'Loading...',\n}: P) => null")).toEqual(['d.tsx:3: loadingText=Loading...'])
    expect(literalDefaultParams('d.tsx', "function f(label = 'Pick color') {}")).toEqual(['d.tsx:1: label=Pick color'])
    expect(literalDefaultParams('d.tsx', "function f({ label: shown = 'Reset to default' }: P) {}")).toEqual(['d.tsx:1: label=Reset to default'])
    expect(literalDefaultParams('d.tsx', 'function f({ title = `Signed in as ${who}` }: P) {}')).toEqual(['d.tsx:1: title=`Signed in as ${who}`'])
    expect(literalDefaultParams('d.tsx', "function C(props: P) { const { placeholder = 'Select...' } = props }")).toEqual(['d.tsx:1: placeholder=Select...'])
    for (const quiet of [
      "function B({ children }: P) { const { t } = useTranslation(); return children ?? t('common.back') }",
      "function f({ align = 'start', side = 'top', fallbackColor = '#6366f1', variant = 'primary' }: P) {}",
      "function f({ size = 16, open = false, items = [] }: P) {}",
      "function f({ label }: P) { const shown = label || 'Back'; return shown }",
      "const a = <X label='Back' />",
    ]) expect({ quiet, found: literalDefaultParams('d.tsx', quiet) }).toEqual({ quiet, found: [] })
  })

  it('the census over apps/electron/src/renderer answers only the allow-list', () => {
    const sources = rendererTsxSources()
    expect(sources.size).toBeGreaterThan(300) // the corpus was read (398 files on 2026-10-16), not an empty scan
    const hits = [...sources].flatMap(([file, source]) => literalDefaultParams(file, source))
    const unexpected = hits.filter(hit => !ALLOWED_DEFAULT_PARAMS.some(([file, text]) => hit.startsWith(`${file}:`) && hit.endsWith(`: ${text}`)))
    expect(unexpected).toEqual([])
    // The allow-list is live, not decoration: every entry still matches (so a wired default must leave the list).
    for (const [file, text] of ALLOWED_DEFAULT_PARAMS) {
      expect({ file, text, present: hits.some(hit => hit.startsWith(`${file}:`) && hit.endsWith(`: ${text}`)) }).toEqual({ file, text, present: true })
    }
  })
})

/** UB12.57 — where each wired default's key is read, so a reverted line fails here as well as in the census. */
const UB12_57_WIRED: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['../onboarding/primitives.tsx', ['common.back', 'common.continue', 'common.loading']],
  ['../onboarding/ReauthScreen.tsx', ['onboarding.reauth.loginFailed']],
]

describe('UB12.57 — the onboarding button defaults and the reauth login-failure fallback go through t()', () => {
  it('positive — each file calls t() with each of its keys, from a useTranslation() hook', () => {
    for (const [file, keys] of UB12_57_WIRED) {
      const source = read(file)
      expect({ file, usesHook: /\buseTranslation\(\)/.test(source) }).toEqual({ file, usesHook: true })
      for (const key of keys) {
        const escaped = key.replace(/\./g, '\\.')
        expect({ file, key, read: new RegExp(`\\bt\\((['"])${escaped}\\1`).test(source) }).toEqual({ file, key, read: true })
      }
    }
  })

  it('every key exists in both locales, and the Russian value is not the English one', () => {
    const en = enMessages as Record<string, string>
    const ru = ruMessages as Record<string, string>
    for (const key of UB12_57_WIRED.flatMap(([, keys]) => keys)) {
      expect({ key, en: typeof en[key], ru: typeof ru[key] }).toEqual({ key, en: 'string', ru: 'string' })
      expect({ key, same: en[key] === ru[key] }).toEqual({ key, same: false })
    }
  })

  it('negative — none of the four literals remains (the reauth fallback included, a position no census reads)', () => {
    const gone: ReadonlyArray<readonly [string, RegExp]> = [
      ['../onboarding/primitives.tsx', /children = ['"](Back|Continue)['"]|loadingText = ['"]Loading/],
      ['../onboarding/ReauthScreen.tsx', /['"]Login failed['"]/],
    ]
    for (const [file, literal] of gone) expect({ file, found: literal.test(read(file)) }).toEqual({ file, found: false })
  })
})

/**
 * UB12.116 — ServerDirectoryBrowser's last three English literals (v0.15.1 ships all three: its lines 69/123, 143 and
 * 263) read keys now: the wrong-platform sentence and the 'Failed to list directory' fallback were string literals
 * handed to `setError`, and the `symlink` badge is a one-word JSX text node, three positions no census above reads
 * (UA12.194's JSX-text arm reads only a capitalised start, `JSX_TEXT_START`). The positive arm is the file's
 * UA12_194_WIRED line (each key read through t(), present in en and ru, the Russian value not the English one); this
 * describe pins the absence.
 */
describe('UB12.116 — ServerDirectoryBrowser\'s wrong-platform sentence, list-failure fallback and symlink badge go through t()', () => {
  const en = enMessages as Record<string, string>
  const LITERALS = [
    ['projects.serverBrowserListFailed', 'Failed to list directory'],
    ['projects.serverBrowserSymlink', 'symlink'],
    ['projects.serverBrowserWrongPlatform', 'This looks like a path from a different OS. Enter a path that exists on the server.'],
  ] as const

  it('control — each needle is the English value its key carries, so a reverted line spells it exactly', () => {
    for (const [key, literal] of LITERALS) expect({ key, en: en[key] }).toEqual({ key, en: literal })
  })

  it('negative — none of the three literals remains in the source, quoted or as element text', () => {
    const source = read('../ServerDirectoryBrowser.tsx')
    for (const [key, literal] of LITERALS) {
      const quoted = [`'${literal}'`, `"${literal}"`, `>${literal}<`].filter(form => source.includes(form))
      expect({ key, quoted }).toEqual({ key, quoted: [] })
    }
    // Boundary: the badge still draws, now from its key, inside the span v0.15.1 styles (UB14.46's pin reads the class).
    expect(source).toContain(`<span className="text-label-sm text-tertiary shrink-0">{t('projects.serverBrowserSymlink')}</span>`)
  })
})
