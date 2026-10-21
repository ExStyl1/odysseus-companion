/**
 * UB12.97 — the renderer's colour-class census: a colour utility the renderer's sources spell must name a colour the
 * renderer's stylesheet defines, or Tailwind generates no CSS for it and it draws nothing.
 *
 * ## The defect family
 *
 * Tailwind compiles a utility whose value names no theme variable to NOTHING, silently: the class stays in the markup,
 * every class-name assertion stays green, and the element draws untinted. UB12.84 measured it on a safety surface (the
 * permission card's impact block spelled `border-warning/30 bg-warning/10 text-warning`; tokens.css defines no warning
 * colour) and found more outside its row: `bg-sidebar` on WorkspacePicker (a shipped full-window picker) and a playground
 * mock, and `text-accent-foreground` on two playground openers. v0.15.1 ships the same spellings. This module is the
 * guard for the whole renderer that UB12.84's one-file needle list could not be.
 *
 * ## The instrument: Tailwind's own compiler, on the renderer's own stylesheet
 *
 * UB12.84's first instrument read tokens.css' `--color-*`, `--text-color-*` and namespace names with regexes and kept
 * hand lists of Tailwind's own words (alignment, widths, its default type scale and palette). This one asks the compiler:
 * `__unstable__loadDesignSystem` (tailwindcss's own export, the API its IntelliSense and Prettier plugin load) reads
 * `renderer/index.css` exactly as the build does — `@import "tailwindcss"` with its default theme, tokens.css, base.css,
 * the Electron-only `@theme`, the typography plugin — and `candidatesToCss` answers, per class, the CSS it generates or
 * `null`. Tailwind v4's utility namespaces are therefore read by construction, measured in tailwindcss 4.3.1's
 * `dist/lib.js`: `text-*` reads `--text-color` then `--color`, `bg-*` `--background-color`, `border-*` `--border-color`
 * (so `border-default` resolves through `--border-color-default`), `divide-*` `--divide-color` then `--border-color`,
 * `ring-*` and `inset-ring-*` `--ring-color`, `ring-offset-*` `--ring-offset-color`, `outline-*` `--outline-color`,
 * `fill-*`/`stroke-*` `--fill`/`--stroke`, each before `--color`. No list of Tailwind words is kept here to rot.
 *
 * A PLAIN class rule in a stylesheet (base.css' `.field-surface`) is not a utility, so the compiler answers `null` for
 * it; the class selectors of every stylesheet the loader read are collected (comments stripped) and count as defined.
 *
 * ## What a colour class is, and what is judged
 *
 * A whitespace token whose UTILITY — variants stripped bracket-aware, the important flag dropped — is one of
 * {@link COLOUR_UTILITY_ROOTS}, a dash and a value. The utility is judged, not its variants: `hover:bg-warning` is
 * flagged for `bg-warning`; a broken variant is a different defect and not this census' claim.
 *
 * ## Where the classes are read from
 *
 * Every tracked or untracked (not ignored) `.ts`/`.tsx` under {@link CENSUS_ROOTS} — a superset of index.css'
 * `@source` globs — tests excluded, because their needles spell dead classes on purpose. Each file goes through Bun's
 * transpiler first, which drops comments (a docblock naming the dead spelling it replaced is history, not a class), and
 * the output is split the way `nessy-styles/no-raw-palette-colors` splits a literal: on whitespace and quotes (and the
 * printer's escaping backslash). A template substitution (`bg-${tone}`) is dynamic and skipped. Clean tracked files are
 * read as their index blobs through `scripts/check-comment-globs.ts`' loader (one `git cat-file --batch`; opening ~950
 * files one by one is AGENTS.md's per-file-open trap), the changed and untracked ones from disk.
 *
 * ## Residue, stated
 *
 * - A colour in a `var(--name)` string (an inline style, `resolvedColor: 'var(--warning)'`) is not a utility and is
 *   not read here; UB12.97 re-spelled the one it found by hand.
 * - A dynamic class (`bg-${tone}-tint`) is not read.
 * - Gradient stops (`from-`/`via-`/`to-`), `decoration-`, `placeholder-`, `caret-`, `accent-` and `shadow-` are not
 *   roots: the row's census named the nine below, and `shadow-*` has its own guard (`nessy-styles/no-nonstandard-shadows`).
 * - A file outside index.css' `@source` globs is read here, but Tailwind never scans it, so a VALID class there is not
 *   generated either — a different defect, not this census'.
 */

import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { __unstable__loadDesignSystem } from 'tailwindcss'
import { loadSourceTexts } from '../../../../../scripts/check-comment-globs'
import { readFilesConcurrently } from '../../../../../scripts/read-changed-files'

export const REPO_ROOT = new URL('../../../../../', import.meta.url).pathname

/** The renderer's stylesheet, the entry the build compiles (it imports tailwindcss, tokens.css and base.css). */
export const RENDERER_STYLESHEET = join(REPO_ROOT, 'apps/electron/src/renderer/index.css')

/** The colour-family utility roots the census reads: the nine UB12.97's census compared (Tailwind v4 colour utilities). */
export const COLOUR_UTILITY_ROOTS = ['text', 'bg', 'border', 'ring', 'inset-ring', 'fill', 'stroke', 'outline', 'divide'] as const

/**
 * The budget of a hook that loads the vocabulary or runs the census: a named constant of its own, the escape hatch
 * `packages/shared/src/testing/module-graph-budgets.ts` documents, because the cost sits inside this module (the
 * typography plugin's `import()` in `loadModule`, the blob read) where `scripts/check-module-graph-hooks.ts` does not
 * look. Readings 2026-10-17 at load ~33 (UB12.97): `loadColourVocabulary` 2.0–2.75 s cold (1.9–2.6 s of it the plugin's
 * import) and 0.07 s warm; the census test file 1.16–2.66 s whole; the same census opening every file instead of reading
 * blobs took 6.9–25 s. 60 s is over twenty times the largest reading of the shape that ships.
 */
export const COLOUR_CENSUS_HOOK_BUDGET_MS = 60_000

/** The source trees the census walks: the renderer and the shared UI package it compiles (index.css' `@source`). */
export const CENSUS_ROOTS = ['apps/electron/src/renderer', 'packages/ui/src'] as const

/**
 * Strings the census meets that are NOT class names — CSS and SVG property names, data values, prose — each with where
 * it is spelled and why. The list checks itself (`colour-role-census.test.ts`): an entry the census no longer meets, or
 * one that starts compiling to CSS, is a red, so it cannot rot into an allowlist.
 */
export const NOT_A_CLASS: Readonly<Record<string, string>> = {
  'border-color': 'a CSS property name inside an inline `transition` value (BrowserTabBadge.tsx, BrowserControls.tsx)',
  'stroke-dasharray': 'a CSS property name inside an inline `transition` value (SendToWorkspaceDialog.tsx)',
  'stroke-linecap': 'an SVG attribute name given to setAttribute (TiptapSlashMenu.ts, AnimatedTaskItem.ts)',
  'stroke-linejoin': 'an SVG attribute name given to setAttribute (TiptapSlashMenu.ts, AnimatedTaskItem.ts)',
  'stroke-width': 'an SVG attribute name given to setAttribute (TiptapSlashMenu.ts, AnimatedTaskItem.ts)',
  'text-only': 'prose: playground descriptions of a text-only model (registry/image-support.tsx)',
  'text-position': 'a W3C Web Annotation selector type, the value of `selector.type` (annotation-core.ts and its readers)',
  'text-quote': 'a W3C Web Annotation selector type, the value of `selector.type` (annotation-core.ts and its readers)',
}

const ROOT_ALTERNATION = [...COLOUR_UTILITY_ROOTS].sort((a, b) => b.length - a.length).join('|')
/** A colour root, a dash, then a value: a name, a number, an arbitrary `[…]` or a v4 `(--var)` shorthand. */
const COLOUR_UTILITY = new RegExp(`^(?:${ROOT_ALTERNATION})-[a-z0-9[(]`)

/** The utility of a class token: its variants stripped (a `:` inside `[…]` or `(…)` is not a separator), `!` dropped. */
export function utilityOf(token: string): string {
  let depth = 0
  let start = 0
  for (let i = 0; i < token.length; i++) {
    const ch = token[i]
    if (ch === '[' || ch === '(') depth++
    else if (ch === ']' || ch === ')') depth--
    else if (ch === ':' && depth === 0) start = i + 1
  }
  return token.slice(start).replace(/^!|!$/g, '')
}

/** Whether a token is shaped as a colour-family class, not whether it resolves; code punctuation (`stroke-width=`) is not a class. */
export function isColourClassShape(token: string): boolean {
  const utility = utilityOf(token)
  return COLOUR_UTILITY.test(utility) && !/[=;,]$/.test(utility)
}

const TRANSPILERS = {
  ts: new Bun.Transpiler({ loader: 'ts' }),
  tsx: new Bun.Transpiler({ loader: 'tsx' }),
} as const

/**
 * The colour-shaped class tokens a source spells in CODE — strings, template text, JSX attributes — never in a comment:
 * Bun's transpiler drops comments, then the output splits on whitespace, quotes and backslashes. A token carrying a
 * template substitution is dynamic and skipped.
 */
export function colourClassTokens(source: string, loader: keyof typeof TRANSPILERS): string[] {
  const code = TRANSPILERS[loader].transformSync(source)
  // A backslash splits too: the printer escapes a quote inside a string (`stroke-width=\"2\"`), and no class spells one.
  return code.split(/[\s'"`\\]+/).filter(token => token !== '' && !token.includes('${') && isColourClassShape(token))
}

/** The class selectors a stylesheet defines as plain rules (comments stripped first). */
function plainClassSelectors(css: string): string[] {
  const code = css.replace(/\/\*[\s\S]*?\*\//g, '')
  return [...code.matchAll(/(?<![\w\\-])\.(-?[A-Za-z_][\w-]*)/g)].map(match => match[1]!)
}

export interface ColourVocabulary {
  /** Whether the class's utility generates CSS on the renderer's stylesheet (a Tailwind utility or a plain class rule). */
  resolves(token: string): boolean
  /** The colour-family classes in a whitespace-separated class list that generate no CSS — the classes that draw nothing. */
  unresolved(classList: string): string[]
  /** Every stylesheet the compiler read, entry first. */
  readonly stylesheets: readonly string[]
  /** The plain class rules those stylesheets define. */
  readonly plainClasses: ReadonlySet<string>
}

/** Load the renderer's stylesheet into Tailwind's design system: the vocabulary the build itself compiles against. */
export async function loadColourVocabulary(): Promise<ColourVocabulary> {
  const stylesheets: string[] = [RENDERER_STYLESHEET]
  const plainClasses = new Set<string>()
  const entry = await readFile(RENDERER_STYLESHEET, 'utf8')
  for (const name of plainClassSelectors(entry)) plainClasses.add(name)
  const designSystem = await __unstable__loadDesignSystem(entry, {
    base: dirname(RENDERER_STYLESHEET),
    async loadStylesheet(id, base) {
      // A bare `tailwindcss` is the package's `style` export, as @tailwindcss/vite resolves it.
      const path = id.startsWith('.') || id.startsWith('/')
        ? resolve(base, id)
        : Bun.resolveSync(id === 'tailwindcss' ? 'tailwindcss/index.css' : id, base)
      const content = await readFile(path, 'utf8')
      stylesheets.push(path)
      for (const name of plainClassSelectors(content)) plainClasses.add(name)
      return { path, base: dirname(path), content }
    },
    async loadModule(id, base) {
      const path = Bun.resolveSync(id, base)
      const loaded = await import(path)
      return { path, base: dirname(path), module: loaded.default ?? loaded }
    },
  })
  const verdicts = new Map<string, boolean>()
  const resolves = (token: string): boolean => {
    const utility = utilityOf(token)
    let verdict = verdicts.get(utility)
    if (verdict === undefined) {
      verdict = plainClasses.has(utility) || designSystem.candidatesToCss([utility])[0] !== null
      verdicts.set(utility, verdict)
    }
    return verdict
  }
  return {
    resolves,
    unresolved: classList => classList.split(/\s+/).filter(token => token !== '' && isColourClassShape(token) && !resolves(token)),
    stylesheets,
    plainClasses,
  }
}

export interface ColourCensus {
  /** Every source file read, repo-relative. */
  readonly files: readonly string[]
  /** Every colour-shaped class token met → the files that spell it. */
  readonly tokens: ReadonlyMap<string, readonly string[]>
  /** The tokens that generate no CSS and are not on {@link NOT_A_CLASS} → the files that spell them. Empty is the contract. */
  readonly unresolved: Readonly<Record<string, readonly string[]>>
  /** The tokens on {@link NOT_A_CLASS} the census met (for the list's own check). */
  readonly notAClassMet: ReadonlySet<string>
}

const SOURCE_FILE = /\.tsx?$/
const TEST_FILE = /(?:^|\/)__tests__\/|\.(?:test|spec)\.tsx?$/

function listFiles(extraArgs: readonly string[]): string[] {
  return execFileSync('git', ['ls-files', '-z', ...extraArgs, '--', ...CENSUS_ROOTS], { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\0')
    .filter(file => SOURCE_FILE.test(file) && !TEST_FILE.test(file))
}

/** Walk the renderer's sources and judge every colour-shaped class token they spell against `vocabulary`. */
export async function runColourCensus(vocabulary: ColourVocabulary): Promise<ColourCensus> {
  const tracked = listFiles([])
  const untracked = listFiles(['--others', '--exclude-standard'])
  const texts = new Map<string, string>()
  // A tracked file deleted in the working tree is `skipped` by the loader: it has no text to judge.
  for (const [file, text] of (await loadSourceTexts(tracked, REPO_ROOT)).texts) texts.set(file, text)
  const reads = await readFilesConcurrently(untracked.map(file => join(REPO_ROOT, file)))
  untracked.forEach((file, index) => {
    const read = reads[index]!
    if (read.ok) texts.set(file, read.bytes.toString('utf-8'))
  })

  const tokens = new Map<string, string[]>()
  for (const [file, text] of texts) {
    let found: string[]
    try {
      found = colourClassTokens(text, file.endsWith('.tsx') ? 'tsx' : 'ts')
    } catch (error) {
      throw new Error(`colour census: Bun's transpiler could not read ${file}: ${String(error)}`)
    }
    for (const token of new Set(found)) {
      const files = tokens.get(token)
      if (files) files.push(file)
      else tokens.set(token, [file])
    }
  }

  const unresolved: Record<string, readonly string[]> = {}
  const notAClassMet = new Set<string>()
  for (const [token, files] of [...tokens].sort(([a], [b]) => a.localeCompare(b))) {
    if (vocabulary.resolves(token)) continue
    if (Object.hasOwn(NOT_A_CLASS, token)) notAClassMet.add(token)
    else unresolved[token] = [...files].sort()
  }
  return { files: [...texts.keys()].sort(), tokens, unresolved, notAClassMet }
}
