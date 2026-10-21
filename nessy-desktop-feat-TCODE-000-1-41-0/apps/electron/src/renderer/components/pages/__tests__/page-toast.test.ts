/**
 * UB12.88 — a pages-surface toast takes the app's global placement, as upstream v0.15.1's pages do (they call
 * sonner's `toast.*` bare: `v0.15.1:apps/electron/src/renderer/components/pages/PageFrame.tsx` L254/L261 and the
 * rest of that directory).
 *
 * History. UA12.145 (SITC-F2, the SIT-C sitting of 2026-10-04, RS-115 R) measured the Toaster's then-default
 * top-right corner (upstream v0.13.4) exactly over the page view header's More/Share buttons —
 * `elementFromPoint` at More returned the 'Page access approved' toast — and moved every pages toast to
 * `bottom-right` through a `pageToast` wrapper. Since UB13.11 the global Toaster carries v0.15.1's placement
 * (design spec D10: bottom-left inside the content card's first pane, top-center under 767px; the window's
 * minWidth is 800), which cannot reach the header either, so the override's reason was gone (UB12.82's
 * re-read). The override was not free: it rendered in a second sonner container at the WINDOW's bottom-right,
 * outside the first pane D10 keeps toasts in. UB12.88 reverted the call sites to `toast.*` and deleted the
 * wrapper.
 *
 * What stays pinned is the hazard UA12.145 measured — a pages toast in a TOP band, where the header's actions
 * live:
 * - POSITIVE: every toast call a pages module makes carries no `position` option, so it takes the Toaster's.
 * - NEGATIVE: no pages module names a top-* position anywhere (a call option, a constant, a wrapper).
 * - PARITY: the Toaster every other surface uses is mounted bare and defaults to bottom-left / top-center.
 *
 * This repo's `bun test` has no DOM, so the call-site arms read the pages sources through the TypeScript parser
 * (the instrument `renderer-hardcoded-strings.test.ts` uses), and the detector is first run over planted
 * sources so a parser that sees nothing cannot pass the arms vacuously.
 */
import { describe, expect, it } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

const PAGES_DIR = join(import.meta.dir, '..')
const RENDERER_DIR = join(PAGES_DIR, '..', '..')

/** sonner's `toast` methods that render a toast (`dismiss` renders none and takes no options). */
const TOAST_METHODS = new Set(['success', 'error', 'warning', 'info', 'loading', 'message', 'custom', 'promise'])
const TOP_POSITION = /^top-(left|right|center)$/

interface ToastCall {
  line: number
  /** `success`, `error`, … or `toast` for a bare `toast(…)` call. */
  method: string
  /** An options object literal names `position` (assignment or shorthand). */
  namesPosition: boolean
  /** An argument the parser cannot see into (a variable, a spread, a call): its placement is unknowable here. */
  opaqueOptions: boolean
}

function propertyName(prop: ts.ObjectLiteralElementLike): string | null {
  if (!prop.name) return null
  if (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) return prop.name.text
  return null
}

/** Every sonner toast call in one source: `toast.<method>(…)` and a bare `toast(…)`. */
function toastCalls(file: string, source: string): ToastCall[] {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const calls: ToastCall[] = []
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      let method: string | null = null
      if (ts.isIdentifier(callee) && callee.text === 'toast') method = 'toast'
      else if (
        ts.isPropertyAccessExpression(callee)
        && ts.isIdentifier(callee.expression)
        && callee.expression.text === 'toast'
        && TOAST_METHODS.has(callee.name.text)
      ) method = callee.name.text
      if (method) {
        // The message is argument 0 (`promise`: the promise, then its messages); options follow.
        const options = node.arguments.slice(1)
        let namesPosition = false
        let opaqueOptions = false
        for (const arg of options) {
          if (!ts.isObjectLiteralExpression(arg)) {
            opaqueOptions = true
            continue
          }
          for (const prop of arg.properties) {
            if (ts.isSpreadAssignment(prop)) opaqueOptions = true
            else if (propertyName(prop) === 'position') namesPosition = true
          }
        }
        const { line } = parsed.getLineAndCharacterOfPosition(node.getStart(parsed))
        calls.push({ line: line + 1, method, namesPosition, opaqueOptions })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  return calls
}

/** Every string literal in one source that spells a top-* sonner position. */
function topPositionLiterals(file: string, source: string): string[] {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const found: string[] = []
  const visit = (node: ts.Node) => {
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && TOP_POSITION.test(node.text)) {
      const { line } = parsed.getLineAndCharacterOfPosition(node.getStart(parsed))
      found.push(`${file}:${line + 1} ${node.text}`)
    }
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  return found
}

/** The pages modules: every .ts/.tsx directly in components/pages (tests excluded). */
function pagesSources(): Array<{ file: string; source: string }> {
  return readdirSync(PAGES_DIR)
    .filter(name => /\.(ts|tsx)$/.test(name))
    .sort()
    .map(file => ({ file, source: readFileSync(join(PAGES_DIR, file), 'utf-8') }))
}

describe('the detector reads planted sources (control for the arms below)', () => {
  it('flags a position option, a bare toast() call and an opaque options argument', () => {
    const planted = [
      "toast.success('a', { position: 'top-right' })",
      "toast.error('b', { description: 'd' })",
      "toast('c', { position })",
      'toast.warning(\'d\', opts)',
      "toast.info('e', { ...opts, duration: 1 })",
      "notToast.success('f', { position: 'top-left' })",
    ].join('\n')
    expect(toastCalls('planted.ts', planted)).toEqual([
      { line: 1, method: 'success', namesPosition: true, opaqueOptions: false },
      { line: 2, method: 'error', namesPosition: false, opaqueOptions: false },
      { line: 3, method: 'toast', namesPosition: true, opaqueOptions: false },
      { line: 4, method: 'warning', namesPosition: false, opaqueOptions: true },
      { line: 5, method: 'info', namesPosition: false, opaqueOptions: true },
    ])
  })

  it('finds a top-* position spelled as a constant, a template literal or a call option — and nothing else', () => {
    const planted = [
      "const PLACEMENT = 'top-right' as const",
      'const other = `top-center`',
      "toast.success('a', { position: \"top-left\" })",
      "const fine = 'bottom-left'",
      "const label = 't(\"toast.topRight\")'",
    ].join('\n')
    expect(topPositionLiterals('planted.ts', planted)).toEqual([
      'planted.ts:1 top-right',
      'planted.ts:2 top-center',
      'planted.ts:3 top-left',
    ])
  })
})

describe('every pages toast takes the global placement (UB12.88)', () => {
  const sources = pagesSources()
  const calls = sources.flatMap(({ file, source }) => toastCalls(file, source).map(call => ({ file, ...call })))

  it('CONTROL: the scan reads the modules that really fire toasts, the measured grant toast among them', () => {
    // An empty directory, a renamed import or a parser that sees nothing would satisfy the arms below vacuously.
    expect(sources.length).toBeGreaterThan(5)
    expect(calls.length).toBeGreaterThan(20)
    const pageFrame = calls.filter(call => call.file === 'PageFrame.tsx')
    expect(pageFrame.map(call => call.method).sort()).toEqual(['error', 'success'])
    expect(sources.find(s => s.file === 'PageFrame.tsx')?.source)
      .toContain("toast.success(t('toast.pageGrantsIssued'))")
  })

  it('POSITIVE: no pages toast passes a position option, and none hides its options from the reader', () => {
    expect(calls.filter(call => call.namesPosition).map(call => `${call.file}:${call.line}`)).toEqual([])
    expect(calls.filter(call => call.opaqueOptions).map(call => `${call.file}:${call.line}`)).toEqual([])
  })

  it('every pages module that names `toast` takes it from sonner — no wrapper stands between them', () => {
    expect(existsSync(join(PAGES_DIR, 'page-toast.ts'))).toBe(false)
    const offenders: string[] = []
    for (const { file, source } of sources) {
      if (toastCalls(file, source).length === 0) continue
      if (!/^import \{ toast \} from 'sonner'$/m.test(source)) offenders.push(file)
    }
    expect(offenders).toEqual([])
  })

  it('NEGATIVE: no pages module names a top-* position — the band the page header’s More/Share live in', () => {
    expect(sources.flatMap(({ file, source }) => topPositionLiterals(file, source))).toEqual([])
  })
})

describe('parity arm — the placement every toast takes is upstream v0.15.1’s', () => {
  // UB12.82 re-pointed this arm at the UB13.11 Toaster (design spec D10). With the pages override gone it is the
  // pages surfaces' placement too, so a silent move of the app's default (or a return of the header-covering
  // top-right) fails here.
  const sonner = readFileSync(join(RENDERER_DIR, 'components', 'ui', 'sonner.tsx'), 'utf-8')
  const main = readFileSync(join(RENDERER_DIR, 'main.tsx'), 'utf-8')

  it('POSITIVE: the global Toaster defaults to bottom-left, and to top-center under 767px', () => {
    expect(sonner).toContain('const COMPACT_QUERY = "(max-width: 767px)"')
    expect(sonner).toContain('position={compact ? "top-center" : "bottom-left"}')
  })

  it('the app mounts the Toaster bare, so no prop overrides that default', () => {
    expect(main).toContain('<Toaster />')
    expect(main).not.toMatch(/<Toaster\s+[^/]/)
  })

  it('NEGATIVE: top-right is absent from the global Toaster', () => {
    expect(sonner).not.toContain('top-right')
    expect(sonner).not.toContain('bottom-right')
  })
})
