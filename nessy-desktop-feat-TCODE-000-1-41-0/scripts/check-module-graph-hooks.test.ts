import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it, setDefaultTimeout } from 'bun:test'

import {
  BUDGETS_MODULE,
  BUN_DEFAULT_TIMEOUT_MS,
  COSTS_FILE,
  REPO_ROOT,
  SHARED_BUDGETS,
  assertHookBudgetUsesMatched,
  baselinePreamble,
  budgetMs,
  candidateFiles,
  classifyBudget,
  costBudgetNote,
  costRows,
  findModuleGraphHooks,
  hookBudgetImporters,
  outgrownRows,
  parseCostReadings,
  readBaseline,
  regexLiteralEnd,
  sharedBudgetValues,
  splitCallArguments,
  staleBaselineEntries,
  strayHookBudgetUses,
  testFiles,
} from './check-module-graph-hooks'
import type { BudgetKind, HookCall } from './check-module-graph-hooks'
import { GateSafetyRefusal } from './gate-safety'

/**
 * This file's own budget, and it is this guard's subject arriving one layer up.
 *
 * Three of these cases do the guard's I/O for real — two greps over ~1 996 test
 * files plus a `readFileSync` of each of the ~48 registered members — and that
 * is not a module GRAPH, so none of the three names in
 * `packages/shared/src/testing/module-graph-budgets.ts` describes it. That
 * module's own escape hatch is the one taken here, in its words: *"A caller
 * whose measured floor does not fit one of the three numbers below should
 * declare its own constant beside its `setDefaultTimeout` WITH its reading
 * written down"*.
 *
 * The readings, 2026-09-10 at load 9.5-10.3 on a tree of 1 996 test files, on
 * bytes identical to `8d1df0f19` for the case that failed:
 *
 * - the completeness control's own body: **5 247 ms** and **5 759 ms** — over
 *   bun's 5 000 ms default by 5 %, so it fails as a coin toss rather than as a
 *   defect;
 * - the whole file: **43.15 s**, **42.40 s** and **34.24 s** wall at
 *   `user 1.64 sys 1.01` — about **4 % cpu**, so this is I/O and not
 *   contention; the same bytes came back at **17.19 s** once warm, which is why
 *   no number here is taken from the last run;
 * - the ZERO-CASE control the budgets module prescribes,
 *   `bun test <this file> -t '<a name nothing matches>'`: **19.67 s with 0 of
 *   20 cases executed**, `user 0.49 sys 0.14` — **3 % cpu**. Half the file's
 *   wall time is paid before any case runs, and no per-case budget can see it;
 * - `bun scripts/check-module-graph-hooks.ts` doing strictly more of the same
 *   work: **15.45 s** at `user 0.96`;
 * - and the first draft of that same case, which read all ~105 candidates
 *   rather than the registered files, timed out at **23 330 ms** (P6.862).
 *
 * 300 000 ms is ~7x the largest observed FILE total, which is the sizing rule
 * ("against the largest observed run TOTAL, never a warm reading, never a
 * per-case floor") — a per-case budget cut from the 5.8 s failure would leave
 * the other two I/O cases exposed to the identical mechanism. It is
 * deliberately not larger: the same objection the budgets module raises to a
 * repo-wide `[test] timeout` applies here, a genuinely hung case still has to
 * be heard about.
 */
const GATE_IO_BUDGET_MS = 300_000
setDefaultTimeout(GATE_IO_BUDGET_MS)

/**
 * One read per registered file for the whole file, shared by every case that
 * needs the real texts. Since F1.651 `hookBudgetImporters` reads each grep hit
 * to keep only the ones that name the budget in CODE, and one file open costs
 * ~130 ms here (2026-09-26: 67 importers, 8.9 s cold and warm alike), so two
 * cases each reading them afresh would double this file's I/O for nothing.
 */
const texts = new Map<string, string>()
function readCached(file: string): string {
  const known = texts.get(file)
  if (known !== undefined) return known
  const text = readFileSync(join(REPO_ROOT, file), 'utf-8')
  texts.set(file, text)
  return text
}

describe('findModuleGraphHooks', () => {
  it('reports a hand-written number — the positive control, and the exact defect the guard was born from', () => {
    // `capability-detail-registry.test.ts` carried this shape, with this number,
    // from the day it was created until a lane met the red in wave 9.
    const found = findModuleGraphHooks('f.test.ts', [
      'beforeAll(async () => {',
      "  registry = (await import('../registry/capability-detail')).registry",
      '}, 60_000)',
    ].join('\n'))

    expect(found).toHaveLength(1)
    expect(found[0]?.kind).toBe('literal')
    expect(found[0]?.budget).toBe('60_000')
    expect(found[0]?.hook).toBe('beforeAll')
    expect(found[0]?.line).toBe(1)
  })

  it('reports a hook with no budget argument at all — it runs on bun\'s 5 000 ms default', () => {
    const found = findModuleGraphHooks('f.test.ts', [
      'beforeEach(async () => {',
      "  mod = await import('./heavy')",
      '})',
    ].join('\n'))

    expect(found).toHaveLength(1)
    expect(found[0]?.kind).toBe('absent')
    expect(found[0]?.hook).toBe('beforeEach')
  })

  it('says nothing about a hook on a shared budget — the negative control for the two above', () => {
    const found = findModuleGraphHooks('f.test.ts', [
      'beforeAll(async () => {',
      "  mod = await import('./heavy')",
      '}, MODULE_GRAPH_HOOK_BUDGET_MS)',
    ].join('\n'))

    expect(found).toHaveLength(1)
    expect(found[0]?.kind).toBe('shared')
  })

  it('says nothing about a hook that pays no import — the shape is the import, not the hook', () => {
    const found = findModuleGraphHooks('f.test.ts', [
      'beforeAll(() => {',
      '  seed()',
      '})',
      "beforeEach(() => { calls.length = 0 })",
    ].join('\n'))

    expect(found).toEqual([])
  })

  it('F1.650 — does NOT see a hook whose graph cost is a BUILD, the limit the box states; the same hook with an import is seen', () => {
    // The two build shapes the tree carries: an in-process `Bun.build(` (the
    // oauth-flows prebuild) and a child `bun build` spawn (the lineage prebuild
    // since `1db74079f`). If this starts failing, the scanner has learned a
    // build shape — rewrite the F1.650 paragraph of the box, do not relax this.
    const inProcess = [
      'beforeAll(async () => {',
      "  const build = await Bun.build({ entrypoints: [probe], target: 'bun' })",
      '}, BUNDLE_BUDGET_MS)',
    ].join('\n')
    const child = [
      'beforeAll(async () => {',
      "  const child = spawn(process.execPath, ['build', entry, '--outdir', out])",
      '}, LINEAGE_PREBUILD_BUDGET_MS)',
    ].join('\n')
    expect(findModuleGraphHooks('f.test.ts', inProcess)).toEqual([])
    expect(findModuleGraphHooks('f.test.ts', child)).toEqual([])

    // POSITIVE CONTROL on the same instrument: the same hook paying an import
    // is a member, on its named constant.
    const withImport = findModuleGraphHooks('f.test.ts', [
      'beforeAll(async () => {',
      "  await import('./probe')",
      "  const build = await Bun.build({ entrypoints: [probe], target: 'bun' })",
      '}, BUNDLE_BUDGET_MS)',
    ].join('\n'))
    expect(withImport).toHaveLength(1)
    expect(withImport[0]?.kind).toBe('named')

    // The ledger inherits it, as the box says: a reading for a build-hook file
    // that IS in the scan prints as a STALE line although nothing is stale.
    const reading = { file: 'f.test.ts', ms: 204_000, date: '2026-09-26', load: undefined, cpu: undefined, instrument: undefined }
    const [row] = costRows(findModuleGraphHooks('f.test.ts', inProcess), [reading], new Map())
    expect(row).toBeDefined()
    expect(costBudgetNote(row as NonNullable<typeof row>, true)).toContain('STALE line')
  })

  it('sees an import wrapped in a helper — the blind spot the first draft shipped with', () => {
    // `slash-command-menu.test.tsx` is a REGISTERED member that contains the
    // string `await import(` nowhere: every one of its imports is
    // `loadStep('<name>', () => import('<name>'))`. Matching only `await import(`
    // missed a member the guard was written from, which is why the pattern is a
    // bare dynamic `import(`.
    const found = findModuleGraphHooks('f.test.tsx', [
      'beforeAll(async () => {',
      "  const m = await loadStep('@/x', () => import('@/x'))",
      '}, MODULE_GRAPH_HOOK_BUDGET_MS)',
    ].join('\n'))

    expect(found).toHaveLength(1)
    expect(found[0]?.kind).toBe('shared')
  })

  it('does not take a method call named import, nor an identifier ending in one', () => {
    const found = findModuleGraphHooks('f.test.ts', [
      'beforeAll(async () => {',
      '  await loader.import("./x")',
      '  await reimport("./y")',
      '})',
    ].join('\n'))

    expect(found).toEqual([])
  })

  it('does not take `beforeAll` when it is the tail of a longer identifier', () => {
    const found = findModuleGraphHooks('f.test.ts', "myBeforeAll(async () => { await import('./x') })")
    expect(found).toEqual([])
  })

  it('does not count a COMMENTED-OUT hook, in either comment shape — P6.984', () => {
    // The scanner enters through `codeTokenOffsets` now, so a hook that has been
    // commented out is not a hook. The same miss cost its sibling guard 7
    // phantom sites when that one searched the raw text; here the population is
    // measured at ZERO today, so this closes a latent exposure rather than a
    // live defect — and the LIVE hook below is in the same source, which is what
    // makes the case a discrimination rather than an absence.
    const text = [
      "// beforeAll(async () => { await import('./commented-out.ts') })",
      '/*',
      " beforeAll(async () => { await import('./also-commented.ts') }, 60_000)",
      '*/',
      "const doc = 'beforeAll(async () => { await import(\\'./quoted.ts\\') })'",
      "beforeAll(async () => { await import('./real.ts') }, MODULE_GRAPH_HOOK_BUDGET_MS)",
    ].join('\n')

    const found = findModuleGraphHooks('f.test.ts', text)

    expect(found).toHaveLength(1)
    expect(found[0]?.line).toBe(6)
    expect(found[0]?.kind).toBe('shared')
  })

  it('POSITIVE CONTROL — the same hook UNCOMMENTED is counted, and its line is its own', () => {
    // Without this pair the case above is satisfied by a matcher that finds
    // nothing at all. Line numbers are computed against the text AS GIVEN, so a
    // comment above the hook must not shift it.
    const text = [
      '// a comment that mentions beforeAll in prose',
      "beforeAll(async () => { await import('./real.ts') })",
    ].join('\n')

    const found = findModuleGraphHooks('f.test.ts', text)

    expect(found).toHaveLength(1)
    expect(found[0]?.line).toBe(2)
    expect(found[0]?.kind).toBe('absent')
  })
})

describe('UB12.26 — a hook whose graph is paid in a CHILD bun', () => {
  // `panel-stack-materials.test.tsx` (UB14.2) and `session-item-run-state.test.tsx`
  // (UB14.3) carry this exact hook, with no `import(` anywhere in the file, and
  // made `--check` refuse (exit 2) as unseen importers. `registry-render.test.ts`
  // has the same hook and passed only because a COMMENT in it read "at import (".
  const CHILD_HOOK = [
    'beforeAll(async () => {',
    "  // Isolated BEFORE bun starts (AGENTS.md §Traps: the root preload freezes the config dir at import).",
    "  const child = Bun.spawn([process.execPath, CHILD], { cwd: REPO_ROOT, stdout: 'pipe', stderr: 'pipe' })",
    '  const killer = setTimeout(() => child.kill(), MODULE_GRAPH_HOOK_BUDGET_MS - 30_000)',
    '  await child.exited',
    '  clearTimeout(killer)',
    '}, MODULE_GRAPH_HOOK_BUDGET_MS)',
  ].join('\n')

  it('POSITIVE — the three child-bun forms the tree uses are members, and the kill timer inside the hook is not a stray use', () => {
    const found = findModuleGraphHooks('f.test.tsx', CHILD_HOOK)
    expect(found).toHaveLength(1)
    expect(found[0]?.kind).toBe('shared')
    expect(found[0]?.line).toBe(1)

    // The `node:child_process` form `structured-output-real-server.test.ts` uses.
    const nodeForm = findModuleGraphHooks('f.test.ts', [
      'beforeAll(async () => {',
      "  child = spawn(process.execPath, [entrypoint], { stdio: ['pipe', 'pipe', 'pipe'] })",
      '}, realServerTestBudget(0))',
    ].join('\n'))
    expect(nodeForm).toHaveLength(1)
    expect(nodeForm[0]?.kind).toBe('named')

    // The object form the four claude-child probes use (`claude-child-env-projection.test.ts`).
    const objectForm = findModuleGraphHooks('f.test.ts', [
      'beforeAll(() => {',
      '  const child = Bun.spawnSync({',
      '    cmd: [process.execPath, PROBE],',
      '    env: launchEnv,',
      '  })',
      '}, PROBE_BUDGET_MS)',
    ].join('\n'))
    expect(objectForm).toHaveLength(1)
    expect(objectForm[0]?.kind).toBe('named')

    const text = `import { MODULE_GRAPH_HOOK_BUDGET_MS } from '@nessy-agent/shared/testing/module-graph-budgets'\n${CHILD_HOOK}`
    expect(strayHookBudgetUses(text)).toEqual([])
    expect(() => assertHookBudgetUsesMatched(['f.test.tsx'], findModuleGraphHooks('f.test.tsx', text), () => text))
      .not.toThrow()
  })

  it('NEGATIVE — a comment is not code: the old match through "at import (" is gone, and so is a commented spawn', () => {
    // The hook registry-render.test.ts carried, minus its spawn: on the raw body
    // this comment alone made it a member.
    const commentOnly = [
      'beforeAll(async () => {',
      '  // the root `bunfig.toml` preload freezes the config dir at import (AGENTS.md §Traps)',
      '  /* Bun.spawn([process.execPath, CHILD]) once lived here */',
      "  configDir = mkdtempSync(join(tmpdir(), 'x-'))",
      '}, MODULE_GRAPH_HOOK_BUDGET_MS)',
    ].join('\n')
    expect(findModuleGraphHooks('f.test.ts', commentOnly)).toEqual([])
    const text = `import { MODULE_GRAPH_HOOK_BUDGET_MS } from '@nessy-agent/shared/testing/module-graph-budgets'\n${commentOnly}`
    expect(() => assertHookBudgetUsesMatched(['f.test.ts'], findModuleGraphHooks('f.test.ts', text), () => text))
      .toThrow(/no hook of theirs was matched \(f\.test\.ts\)/)
  })

  it('BOUNDARY — a child `bun build`, a non-bun child and a method named spawn stay unseen', () => {
    for (const body of [
      // F1.650's child build, in both argv forms and with the spacing that
      // would let a backtracking lookahead slip past.
      "  spawn(process.execPath, ['build', entry, '--outdir', out])",
      '  spawn(process.execPath,   [ "build", entry ])',
      "  Bun.spawn([process.execPath, 'build', entry])",
      "  Bun.spawnSync({ cmd: [process.execPath, `build`, entry] })",
      "  Bun.spawn(['git', 'status'], { cwd })",
      // Named as an MCP server's command, not spawned here (`codex-advisor-advertisement-e2e.test.ts`).
      '  sessionMcp = { command: process.execPath, args: [stubMcp] }',
      "  spawn('openssl', ['req', '-x509'])",
      '  manager.spawn({ argv: [process.execPath, script] })',
    ]) {
      expect(findModuleGraphHooks('f.test.ts', `beforeAll(async () => {\n${body}\n}, NAMED_BUDGET_MS)`)).toEqual([])
    }
  })
})

describe('UB12.72 — a quote inside a REGEX literal opens no string', () => {
  // `automations-restyle.test.tsx` (UB14.44) carries this assertion above its
  // child-bun hook: five `"` in one regex literal, so the scanner read lines
  // 99–150 of that file as a single string, the hook at line 121 was not code,
  // and `--check` refused the file as an importer with no matched hook (rc 2).
  const IMPORT = "import { MODULE_GRAPH_HOOK_BUDGET_MS } from '@nessy-agent/shared/testing/module-graph-budgets'"
  const REGEX = '    expect(html).toMatch(/<svg[^>]*class="[^"]*lucide-circle-slash text-tertiary"[^>]*aria-hidden="true"/)'
  const tail = (body: string) => [
    IMPORT,
    "it('a case', () => {",
    REGEX,
    '})',
    'beforeAll(async () => {',
    body,
    '  const killer = setTimeout(() => child.kill(), MODULE_GRAPH_HOOK_BUDGET_MS - 30_000)',
    '  clearTimeout(killer)',
    '}, MODULE_GRAPH_HOOK_BUDGET_MS)',
  ].join('\n')

  it('POSITIVE — the child-bun hook below an odd-quote regex is a member on the shared budget, and the file is not refused', () => {
    const text = tail('  const child = Bun.spawn([process.execPath, CHILD], { stdout: \'pipe\' })')
    const found = findModuleGraphHooks('f.test.tsx', text)

    expect(found).toHaveLength(1)
    expect(found[0]?.line).toBe(5)
    expect(found[0]?.kind).toBe('shared')
    expect(strayHookBudgetUses(text)).toEqual([])
    expect(() => assertHookBudgetUsesMatched(['f.test.tsx'], found, () => text)).not.toThrow()
    // The same with a single quote in the regex (`/it's/`), the other opener.
    const single = text.replace(REGEX, "    expect(html).toMatch(/it's (on|off)/)")
    expect(findModuleGraphHooks('f.test.tsx', single).map(hook => hook.kind)).toEqual(['shared'])
  })

  it('NEGATIVE — the same file with no graph in its hook still REFUSES, so the skip did not make the scanner lenient', () => {
    const text = tail("  configDir = mkdtempSync(join(tmpdir(), 'x-'))")

    expect(findModuleGraphHooks('f.test.tsx', text)).toEqual([])
    expect(() => assertHookBudgetUsesMatched(['f.test.tsx'], [], () => text))
      .toThrow(/no hook of theirs was matched \(f\.test\.tsx\)/)
  })

  it('BOUNDARY — a division, a JSX closing tag and a self-closing tag open no regex, so a quote after them still balances', () => {
    // An over-eager skip would swallow `/ b + "/` or `/i>; const q = "</`, leave
    // an odd quote behind, and hide the hook — the mirror image of the miss.
    for (const line of [
      'const s = a / b + "/" + c',
      'const r = (a + b) / 2 + "/"',
      'const t = rows[0] / 2 + "/"',
      'let n = i++ / 2 + "/"',
      'const el = <i>x</i>; const q = "</"',
      'const el = <X a={1} />; const q = "/>"',
    ]) {
      const text = `${line}\nbeforeAll(async () => { await import('./x') }, MODULE_GRAPH_HOOK_BUDGET_MS)`
      expect({ line, found: findModuleGraphHooks('f.test.tsx', text).map(hook => hook.line) }).toEqual({ line, found: [2] })
    }
    const at = (text: string, from: number) => regexLiteralEnd(text, text.indexOf('/', from))
    expect(at('x = /a"b/g', 0)).toBe(8)
    expect(at('return /[/"]+/.test(s)', 0)).toBe(13) // a class may hold a `/`
    expect(at('const f = () => /a\\/b/', 0)).toBe(21) // `=>`, and an escaped `/`
    expect(at('a / b / c', 0)).toBe(-1)
    expect(at('x.return / 2 / 3', 0)).toBe(-1) // a property named like a keyword
    expect(at('x = /no close on this line\n/', 0)).toBe(-1) // a regex literal cannot span a line
  })
})

describe('splitCallArguments', () => {
  it('splits on top-level commas only, so a comma inside the body is not a budget', () => {
    const text = "beforeAll(async () => { f(a, b); const o = { x: 1, y: 2 } }, 60_000)"
    const args = splitCallArguments(text, text.indexOf('('))

    expect(args).toHaveLength(2)
    expect(args?.[1]?.trim()).toBe('60_000')
  })

  it('does not count a delimiter inside a string, a template or a comment', () => {
    const text = [
      'beforeAll(async () => {',
      '  const s = ")"',
      '  const t = `${x})`',
      '  // )',
      '  /* ) */',
      "  await import('./x')",
      '}, MODULE_GRAPH_HOOK_BUDGET_MS)',
    ].join('\n')
    const args = splitCallArguments(text, text.indexOf('('))

    expect(args).toHaveLength(2)
    expect(args?.[1]?.trim()).toBe('MODULE_GRAPH_HOOK_BUDGET_MS')
  })
})

describe('classifyBudget', () => {
  it('separates the four kinds, including the escape hatch the budgets module documents', () => {
    expect(classifyBudget(undefined)).toBe('absent')
    expect(classifyBudget('   ')).toBe('absent')
    expect(classifyBudget(' 120_000 ')).toBe('literal')
    expect(classifyBudget('600000')).toBe('literal')
    expect(classifyBudget('MODULE_GRAPH_HOOK_BUDGET_MS')).toBe('shared')
    // A named constant of the caller's own is NOT a finding: the budgets module
    // says in its own words that a caller whose floor fits none of the three
    // should declare one with its reading written down.
    expect(classifyBudget('PAGE_IMPORT_BUDGET_MS')).toBe('named')
  })
})

describe('the subject exists', () => {
  it('the three budget names are really exported by the module the guard names', () => {
    const source = readFileSync(join(REPO_ROOT, BUDGETS_MODULE), 'utf-8')
    for (const name of SHARED_BUDGETS) expect(source).toContain(`export const ${name}`)
  })

  it('the matcher sees every file that registered a hook budget by hand — the completeness control', () => {
    // This comparison found the first draft's blind spot and is the reason the
    // script refuses on it: a file importing MODULE_GRAPH_HOOK_BUDGET_MS whose
    // hook the scanner cannot match is a silent under-count of the family.
    //
    // It reads only the REGISTERED files, not all ~105 candidates. The verdict is
    // identical — `main` asks whether every registered file appears among the
    // shared members, and members from unregistered files cannot change that —
    // and the first draft of this test, which scanned every candidate, TIMED OUT
    // at 23 330 ms against bun's 5 000 ms default. A test that pays a whole
    // guard's I/O to assert something derivable from seven files is the same
    // mistake this guard indexes, one layer up.
    const registered = hookBudgetImporters(readCached)
    expect(registered.length).toBeGreaterThan(0)
    for (const file of registered) {
      const shared = findModuleGraphHooks(file, readCached(file))
        .filter(hook => hook.kind === 'shared')
      expect(shared.length > 0 ? file : `${file} imports the budget and no hook of it was matched`).toBe(file)
      // F1.668 — and per USE: every use of the hook budget in it sits in a
      // matched hook, the second half of `main`'s refusal.
      expect(strayHookBudgetUses(readCached(file)).map(line => `${file}:${line}`)).toEqual([])
    }
  })

  it('the candidate narrowing never drops a registered member — the control for the two-grep read set', () => {
    // `candidateFiles()` intersects two greps to cut the read set from 1 959 to
    // ~105. Narrowing a search set is how a guard silently under-reports, so the
    // narrowing is checked against a list derived a different way. Greps, plus
    // the texts the case above already read (`readCached`, F1.651): about 0.4 s
    // when it runs after that case, one open per importer when run alone.
    const candidates = new Set(candidateFiles())
    for (const file of hookBudgetImporters(readCached)) {
      expect(candidates.has(file) ? file : `${file} was narrowed out of the read set`).toBe(file)
    }
  })

  it('every baselined file is still a test file in scope — a stale entry silences a path nobody reads', () => {
    const inScope = new Set(testFiles())
    for (const file of readBaseline()) {
      expect(inScope.has(file) ? file : `${file} is baselined and is no longer in scope`).toBe(file)
    }
  })
})

describe('hookBudgetImporters counts CODE, not raw text — F1.651', () => {
  // The completeness refusal in `main` treats every importer as a file that MUST
  // show a `shared` hook. It used to take `git grep`'s raw-text hits as the
  // importers, so a test file that only NAMED the budget in a comment or a
  // string made `--check` refuse rc 2 on a file with no hook to match. The grep
  // still narrows; each hit is kept only when the name is in code. The reader
  // is injected, so both arms run on the REAL grep hits with a planted text.
  const IMPORT = "import { MODULE_GRAPH_HOOK_BUDGET_MS } from '@nessy-agent/shared/testing/module-graph-budgets'\n"

  it('a file that names the budget only in a comment or a string is not an importer', () => {
    const mentionOnly = [
      '// this hook runs on MODULE_GRAPH_HOOK_BUDGET_MS',
      '/* MODULE_GRAPH_HOOK_BUDGET_MS is the hook-shaped budget */',
      "const planted = '}, MODULE_GRAPH_HOOK_BUDGET_MS)'",
    ].join('\n')

    expect(hookBudgetImporters(() => mentionOnly)).toEqual([])
  })

  it('a real import still is — the positive control on the same grep hits', () => {
    const importing = hookBudgetImporters(() => IMPORT)

    expect(importing.length).toBeGreaterThan(0)
    // Nothing in the tree names the budget outside code today (measured
    // 2026-09-26), so the real texts keep exactly the files an import keeps.
    expect(hookBudgetImporters(readCached)).toEqual(importing)
  })
})

describe('the completeness refusal checks each USE, not each file — F1.668', () => {
  // `main` refused only a FILE with no matched hook, so one real hook vouched for
  // every other use in the same file, and the F1.639 shape (the hook budget on a
  // case, or on a hook the scanner cannot match) passed in any file that also
  // had one. It was live: four `it(...)` cases and two `setDefaultTimeout` calls
  // in three files.
  const IMPORT = "import { MODULE_GRAPH_HOOK_BUDGET_MS } from '@nessy-agent/shared/testing/module-graph-budgets'"
  const members = (file: string, text: string): HookCall[] => findModuleGraphHooks(file, text)

  it('a file with one correct hook and three misused budgets is refused, naming each misuse', () => {
    const text = [
      IMPORT,
      'setDefaultTimeout(MODULE_GRAPH_HOOK_BUDGET_MS)',
      "beforeAll(async () => { mod = await import('./heavy') }, MODULE_GRAPH_HOOK_BUDGET_MS)",
      "it('a case', async () => { await work() }, MODULE_GRAPH_HOOK_BUDGET_MS)",
      "beforeAll(async () => { await Bun.build({ entrypoints: [probe] }) }, MODULE_GRAPH_HOOK_BUDGET_MS)",
    ].join('\n')
    // The one correct hook makes the file `seen` — the whole of the old check.
    expect(members('f.test.ts', text).filter(hook => hook.kind === 'shared')).toHaveLength(1)

    expect(strayHookBudgetUses(text)).toEqual([2, 4, 5])
    expect(() => assertHookBudgetUsesMatched(['f.test.ts'], members('f.test.ts', text), () => text))
      .toThrow(/3 use\(s\) of MODULE_GRAPH_HOOK_BUDGET_MS sit in no matched hook \(f\.test\.ts:2, f\.test\.ts:4, f\.test\.ts:5\)/)
    // The file half still refuses an importer with no hook at all.
    expect(() => assertHookBudgetUsesMatched(['g.test.ts'], [], () => IMPORT)).toThrow(/no hook of theirs was matched/)
  })

  it('NEGATIVE — an import, a hook budget, a use inside the hook body, and a mention are not misuses', () => {
    const text = [
      'import {',
      '  MODULE_GRAPH_BUDGET_MS,',
      '  MODULE_GRAPH_HOOK_BUDGET_MS, // the hook budget',
      "} from '@nessy-agent/shared/testing/module-graph-budgets'",
      '// a comment naming MODULE_GRAPH_HOOK_BUDGET_MS',
      "const note = 'MODULE_GRAPH_HOOK_BUDGET_MS'",
      'setDefaultTimeout(MODULE_GRAPH_BUDGET_MS)',
      'const MY_MODULE_GRAPH_HOOK_BUDGET_MS_COPY = 1',
      'beforeAll(async () => {',
      // The shape `registry-render.test.ts` carries: a kill timer derived from
      // the budget of the hook it sits in.
      '  const killer = setTimeout(() => child.kill(), MODULE_GRAPH_HOOK_BUDGET_MS - 30_000)',
      "  mod = await import('./heavy')",
      '}, MODULE_GRAPH_HOOK_BUDGET_MS)',
    ].join('\n')

    expect(strayHookBudgetUses(text)).toEqual([])
    expect(() => assertHookBudgetUsesMatched(['f.test.ts'], members('f.test.ts', text), () => text)).not.toThrow()
  })
})

describe('staleBaselineEntries', () => {
  // P6.978. The case above asks whether a baselined file is still a test file in
  // SCOPE, which is the wrong direction: a converted file is still in scope, so
  // it stays silenced and nothing can see it. These are the other direction.
  //
  // Deliberately NOT asserted here: that the real baseline is currently free of
  // stale entries. That assertion IS the failing gate the controller declined —
  // it would redden `lint:chain` for any lane that converts a file and forgets
  // its line, punishing the fix with the gate that asked for it. The script
  // warns on stdout instead; a failure comes after one wave without noise.
  it('reports a baselined file that is no longer among the findings — the positive control', () => {
    const stale = staleBaselineEntries(
      ['apps/converted.test.ts', 'apps/still-a-finding.test.ts'],
      ['apps/still-a-finding.test.ts', 'apps/brand-new.test.ts'],
    )

    expect(stale).toEqual(['apps/converted.test.ts'])
  })

  it('NEGATIVE — says nothing when every baselined file is still a finding, and a NEW finding is not stale', () => {
    expect(staleBaselineEntries(['apps/a.test.ts'], ['apps/a.test.ts', 'apps/fresh.test.ts'])).toEqual([])
    expect(staleBaselineEntries([], ['apps/fresh.test.ts'])).toEqual([])
  })

  it('BOUNDARY — an empty finding set makes every entry stale, and the output is sorted and deduped', () => {
    expect(staleBaselineEntries(['b.test.ts', 'a.test.ts', 'b.test.ts'], [])).toEqual(['a.test.ts', 'b.test.ts'])
  })
})

describe('baselinePreamble', () => {
  // P6.870. `--update-baseline` wrote the entry list alone, so the documented
  // way to regenerate the baseline DELETED its documentation — including the
  // three zero-case controls the sweep measured. These two cases are the
  // positive and the negative of the one thing that matters: what a regenerated
  // file keeps.
  it('keeps every comment line above the first entry, and drops the blank line before it', () => {
    const text = '# one\n# two\n#\n\napps/a.test.ts  # recorded 2026-09-08\napps/b.test.ts\n'
    expect(baselinePreamble(text)).toBe('# one\n# two\n#\n\n')
  })

  it('NEGATIVE — a file with no comments at all yields no preamble, so nothing is invented', () => {
    expect(baselinePreamble('apps/a.test.ts\napps/b.test.ts\n')).toBe('')
  })

  it('the real baseline round-trips: its own preamble is a prefix of it', () => {
    const text = readFileSync(join(REPO_ROOT, 'scripts/module-graph-hook-baseline.txt'), 'utf-8')
    const preamble = baselinePreamble(text)
    expect(preamble.length).toBeGreaterThan(0)
    expect(text.startsWith(preamble)).toBe(true)
  })
})

describe('the cost ledger (P6.1000)', () => {
  // The other half of the box at the top of the guard: it could say a budget was
  // DECLARED and never that it was big enough. These pin the parse, the two
  // joins and the warn boundary.
  //
  // Deliberately NOT asserted here: which files are currently over the warn
  // ratio. That number moves whenever a lane appends a reading, and a test
  // pinning it would redden the gate for the lane that measured something.
  const member = (file: string, kind: BudgetKind, budget?: string): HookCall =>
    ({ file, line: 1, hook: 'beforeAll', budget, kind })
  const SHARED = new Map([['MODULE_GRAPH_HOOK_BUDGET_MS', 600_000]])

  it('parses one reading per non-comment line and reads `-` as a load nobody recorded', () => {
    const readings = parseCostReadings([
      '# a comment, and the blank line under it',
      '',
      'packages/a.test.ts 252200 2026-09-10 11.40',
      '  packages/a.test.ts 222800 2026-09-10 7.67  ',
      'apps/b.test.ts 15160 2026-09-10 -',
    ].join('\n'))

    expect(readings).toEqual([
      { file: 'packages/a.test.ts', ms: 252200, date: '2026-09-10', load: 11.4, cpu: undefined, instrument: undefined },
      { file: 'packages/a.test.ts', ms: 222800, date: '2026-09-10', load: 7.67, cpu: undefined, instrument: undefined },
      // `-` is an honest null. An invented load is worse than a missing one.
      { file: 'apps/b.test.ts', ms: 15160, date: '2026-09-10', load: undefined, cpu: undefined, instrument: undefined },
    ])
  })

  it('REFUSES a line it cannot parse, naming the line — a skipped reading is a reading nobody took', () => {
    // Four fields, and each one checked: the file is appended by hand, so every
    // one of these is a plausible slip.
    expect(() => parseCostReadings('packages/a.test.ts 252200 2026-09-10')).toThrow(GateSafetyRefusal)
    expect(() => parseCostReadings('packages/a.test.ts 252.2s 2026-09-10 7.6')).toThrow(GateSafetyRefusal)
    expect(() => parseCostReadings('packages/a.test.ts 252200 10-09-2026 7.6')).toThrow(GateSafetyRefusal)
    expect(() => parseCostReadings('packages/a.test.ts 252200 2026-09-10 quiet')).toThrow(GateSafetyRefusal)
    // And the line number is in the message, because the file is edited by hand.
    expect(() => parseCostReadings('# head\n\nbad line here')).toThrow(/module-graph-hook-costs\.txt:3/)
  })

  it('reads the three budget VALUES out of the module rather than carrying a copy', () => {
    const live = sharedBudgetValues(readFileSync(join(REPO_ROOT, BUDGETS_MODULE), 'utf-8'))

    for (const name of SHARED_BUDGETS) expect(live.get(name)).toBeGreaterThan(0)
    // The underscored literal the module actually writes, and a name it does not
    // export — which must be absent rather than zero.
    const synthetic = sharedBudgetValues('export const MODULE_GRAPH_HOOK_BUDGET_MS = 600_000')
    expect(synthetic.get('MODULE_GRAPH_HOOK_BUDGET_MS')).toBe(600_000)
    expect(synthetic.has('MODULE_GRAPH_BUDGET_MS')).toBe(false)
  })

  it('says what timer each hook kind is really running on, and declines to guess for a named one', () => {
    expect(budgetMs(member('a.test.ts', 'shared', 'MODULE_GRAPH_HOOK_BUDGET_MS'), SHARED)).toBe(600_000)
    expect(budgetMs(member('a.test.ts', 'literal', '120_000'), SHARED)).toBe(120_000)
    // The finding kind the guard was born for: no argument at all is bun's own.
    expect(budgetMs(member('a.test.ts', 'absent'), SHARED)).toBe(BUN_DEFAULT_TIMEOUT_MS)
    // A constant of its own is the documented escape hatch; its value is not here.
    expect(budgetMs(member('a.test.ts', 'named', 'PAGE_IMPORT_BUDGET_MS'), SHARED)).toBeUndefined()
  })

  it('takes the LARGEST reading per file and the TIGHTEST budget in it, worst ratio first', () => {
    const rows = costRows(
      [
        member('slow.test.ts', 'shared', 'MODULE_GRAPH_HOOK_BUDGET_MS'),
        // Two hooks, two budgets: the tight one is what a growing graph hits.
        member('slow.test.ts', 'literal', '400_000'),
        member('quick.test.ts', 'shared', 'MODULE_GRAPH_HOOK_BUDGET_MS'),
      ],
      [
        { file: 'slow.test.ts', ms: 100_000, date: '2026-09-01', load: 7, cpu: undefined, instrument: undefined },
        // Largest wins, not latest — the budgets module's sizing rule.
        { file: 'slow.test.ts', ms: 300_000, date: '2026-08-01', load: undefined, cpu: undefined, instrument: undefined },
        { file: 'quick.test.ts', ms: 15_000, date: '2026-09-10', load: 8, cpu: undefined, instrument: undefined },
        // A reading whose file has no hook at all: a STALE line, kept visible.
        { file: 'gone.test.ts', ms: 9_000, date: '2026-09-10', load: undefined, cpu: undefined, instrument: undefined },
      ],
      SHARED,
    )

    expect(rows.map(row => row.file)).toEqual(['slow.test.ts', 'quick.test.ts', 'gone.test.ts'])
    expect(rows[0]?.reading.ms).toBe(300_000)
    expect(rows[0]?.budget).toBe(400_000)
    expect(rows[0]?.ratio).toBeCloseTo(0.75, 5)
    expect(rows[2]?.budget).toBeUndefined()
    expect(rows[2]?.ratio).toBeUndefined()
  })

  it('BOUNDARY — exactly half the budget is not outgrown, a hair over is, and no budget never is', () => {
    const at = (ms: number, file = 'a.test.ts') =>
      costRows([member(file, 'shared', 'MODULE_GRAPH_HOOK_BUDGET_MS')],
        [{ file, ms, date: '2026-09-10', load: undefined, cpu: undefined, instrument: undefined }], SHARED)

    expect(outgrownRows(at(300_000))).toEqual([])
    expect(outgrownRows(at(300_001))).toHaveLength(1)
    // A row the guard cannot price is not a row it may accuse.
    expect(outgrownRows(costRows([], [{ file: 'x.test.ts', ms: 9e9, date: '2026-09-10', load: undefined, cpu: undefined, instrument: undefined }],
      SHARED))).toEqual([])
  })

  it('names an out-of-scan reading for what it is, and keeps the other two branches apart — P6.1025', () => {
    const row = (file: string, budget?: number) =>
      ({ file, reading: { file, ms: 1, date: '2026-09-10', load: undefined, cpu: undefined, instrument: undefined }, budget, ratio: undefined })

    // A priced row says its number, scanned or not.
    expect(costBudgetNote(row('a.test.ts', 600_000), true)).toBe('budget 600000 ms')
    // IN the scan and unpriced: the file lost its hook, or carries a constant of
    // its own — the STALE reading this guard has always printed.
    expect(costBudgetNote(row('a.test.ts'), true)).toContain('STALE line')
    // OUT of the scan and unpriced: the walk never reached it, so there is
    // nothing stale about it. The branch P6.1025 was born for.
    const outside = costBudgetNote(row('scripts/cdp/harness.test.ts'), false)
    expect(outside).toContain('OUTSIDE the scan')
    expect(outside).not.toContain('STALE')
    // The roots are DERIVED from the pathspecs, so the message cannot age beside
    // the list it describes.
    expect(outside).toContain('apps/**')
    expect(outside).toContain('packages/**')
  })

  it('D1.100 — a six-field reading carries its cpu share and its instrument, and four fields still parse', () => {
    // The two shapes side by side in one ledger: the legacy four-field line that
    // cannot be re-derived, and the six-field one a lane takes today.
    const readings = parseCostReadings([
      '# a comment',
      'a.test.ts 100 2026-09-10 7.5',
      'b.test.ts 200 2026-09-17 8.1 0.02 cold-total',
      'c.test.ts 300 2026-09-17 - - zero-case',
    ].join('\n'))

    expect(readings).toHaveLength(3)
    // The legacy line is unchanged in every field it had, and absent in the two
    // it never had — not zero, which would be a measurement nobody took.
    expect(readings[0]).toEqual({
      file: 'a.test.ts', ms: 100, date: '2026-09-10', load: 7.5, cpu: undefined, instrument: undefined,
    })
    expect(readings[1]?.cpu).toBe(0.02)
    expect(readings[1]?.instrument).toBe('cold-total')
    // `-` in either position is the ledger's own "not recorded", and it must not
    // become 0: a cpu share of 0 is the STARVED reading, the opposite claim.
    expect(readings[2]?.cpu).toBeUndefined()
    expect(readings[2]?.instrument).toBe('zero-case')
  })

  it('D1.100 — present-and-malformed REFUSES, in both new fields and at five fields', () => {
    const refuses = (line: string, why: string): void => {
      expect(() => parseCostReadings(line)).toThrow(GateSafetyRefusal)
      expect(() => parseCostReadings(line)).toThrow(new RegExp(why))
    }
    // A cpu share that is not a number. The positive control is the same line
    // with a number, which the case above already parses.
    refuses('a.test.ts 100 2026-09-10 7.5 fast cold-total', 'cpu share')
    // An instrument outside the list — the P6.920 defect in its own shape: a word
    // that reads as a claim and names no run this file admits.
    refuses('a.test.ts 100 2026-09-10 7.5 0.02 warm-total', 'cold-total')
    // FIVE fields: a half-written line is the shape a hand-edited file produces,
    // and it must not be read as four fields plus noise.
    refuses('a.test.ts 100 2026-09-10 7.5 0.02', 'not 4 or 6')
  })

  it('the real ledger parses, every file in it exists, and P6.997 is in it as the adjacent case', () => {
    const readings = parseCostReadings(readFileSync(join(REPO_ROOT, COSTS_FILE), 'utf-8'))
    expect(readings.length).toBeGreaterThan(0)
    // EXISTS, not "is in the scan denominator" — the assertion this case carried
    // until P6.1025, which failed the day a legitimate `scripts/` reading was
    // appended (P6.1008). A reading naming a path nobody has is the real defect:
    // it can never be joined to a budget and never falls off the report.
    const vanished = readings
      .map(reading => reading.file)
      .filter(file => !existsSync(join(REPO_ROOT, file)))
    expect(vanished).toEqual([])

    // And the third branch on the REAL ledger rather than on a synthetic row: a
    // file the walk does not reach is named as such. Written over whatever the
    // ledger holds, so appending a `scripts/` reading costs no edit here, and as
    // a filter rather than an `if` because a conditional expect is a lint:chain
    // failure of its own.
    const scanned = new Set(testFiles())
    const accused = [...new Set(readings.map(reading => reading.file))]
      .filter(file => !scanned.has(file))
      .filter(file => costBudgetNote(
        { file, reading: { file, ms: 1, date: '2026-09-10', load: undefined, cpu: undefined, instrument: undefined }, budget: undefined, ratio: undefined },
        false,
      ).includes('STALE'))
    expect(accused).toEqual([])
    // The reading the row was born from: 252.2 s against 600 000 ms. Asserted as
    // the reading rather than as a ratio, so re-sizing the budget cannot make
    // this case fail for a reason that has nothing to do with it.
    const p6997 = readings.filter(
      reading => reading.file === 'packages/pi-agent-server/src/__tests__/index-import-guard.test.ts',
    )
    expect(Math.max(...p6997.map(reading => reading.ms))).toBe(252_200)
  })
})
