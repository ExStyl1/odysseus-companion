/**
 * P2.150 — how a rule's `paths` frontmatter separates into patterns, measured
 * end to end (`parseRuleFile` -> `expandRulePatterns` -> `matchingRulePatterns`),
 * because the pattern list is only interesting for the files it selects.
 *
 * The row named this a sibling of the tool-grant tokenizer `53007d740` fixed and
 * asked for the DIRECTION before the fix. Both halves are pinned here:
 *
 * - The stated premise, whitespace, is REFUTED and stays refuted: a `paths` glob
 *   containing a space was never split, and `src/my docs/**` has a case so
 *   nobody "fixes" it into one.
 * - The real defect was the comma, and it went BOTH ways. Mostly narrower and
 *   silent — `src/**` + `/*.{ts,tsx}` matched no real file, so the rule never
 *   fired and `expandRulePatterns`' brace budget was unreachable. But for an
 *   unterminated group it WIDENED, which is why it is a defect and not a
 *   cosmetic loss: `paths: docs/{a,**` left `**` standing alone, and a rule
 *   scoped to `docs/` fired on every file read.
 */
import { describe, expect, it } from 'bun:test';
import { parseRuleFile, unscopedRuleBody } from '../memory-store.ts';
import {
  clearRuleMatchingCaches,
  expandRulePatterns,
  matchingRulePatterns,
} from '../rule-matching.ts';

/** The patterns one inline `paths:` value produces. */
function patternsFor(value: string): string[] {
  const parsed = parseRuleFile(`---\npaths: ${value}\n---\nrule body\n`);
  expect(parsed).not.toBeNull();
  return [...parsed!.patterns];
}

/** Which of `files` the value's patterns select, through the real matcher. */
function selects(value: string, files: readonly string[]): string[] {
  clearRuleMatchingCaches();
  const expanded = expandRulePatterns(patternsFor(value));
  return files.filter(file => matchingRulePatterns(expanded, file).length > 0);
}

describe('a `paths` value separates on the commas that separate patterns', () => {
  it('keeps a brace group whole, and the rule finally fires', () => {
    expect(patternsFor('src/**/*.{ts,tsx}')).toEqual(['src/**/*.{ts,tsx}']);
    expect(selects('src/**/*.{ts,tsx}', ['src/a.ts', 'src/deep/b.tsx', 'src/a.py']))
      .toEqual(['src/a.ts', 'src/deep/b.tsx']);
  });

  it('keeps a NESTED brace group whole, which is what the expander already assumed', () => {
    expect(patternsFor('src/{a,{b,c}}/*.ts')).toEqual(['src/{a,{b,c}}/*.ts']);
    expect(selects('src/{a,{b,c}}/*.ts', ['src/a/x.ts', 'src/c/x.ts', 'src/d/x.ts']))
      .toEqual(['src/a/x.ts', 'src/c/x.ts']);
  });

  it('still separates on a TOP-LEVEL comma, brace group in the same value or not', () => {
    expect(patternsFor('src/**/*.{ts,tsx}, docs/**/*.md'))
      .toEqual(['src/**/*.{ts,tsx}', 'docs/**/*.md']);
    expect(patternsFor('src/**/*.ts, docs/**')).toEqual(['src/**/*.ts', 'docs/**']);
  });

  it('does not separate on whitespace — the row\'s premise, refuted and pinned', () => {
    expect(patternsFor('src/my docs/**')).toEqual(['src/my docs/**']);
    expect(selects('src/my docs/**', ['src/my docs/notes.md', 'src/other/notes.md']))
      .toEqual(['src/my docs/notes.md']);
  });

  it('holds the commas inside a bracket expression, negated included', () => {
    expect(patternsFor('src/[a,b]*.ts')).toEqual(['src/[a,b]*.ts']);
    // `[!…]` is the ONLY negation this compiler has, and it is the direction a
    // split would get most wrong, so it is measured rather than assumed.
    expect(patternsFor('src/[!a,b]*.ts')).toEqual(['src/[!a,b]*.ts']);
    expect(selects('src/[!a,b]*.ts', ['src/z.ts', 'src/a.ts', 'src/b.ts'])).toEqual(['src/z.ts']);
  });

  it('holds the commas inside quotes, and inside an escape', () => {
    expect(patternsFor('"src/a,b/**"')).toEqual(['src/a,b/**']);
    expect(patternsFor("'src/a,b/**', docs/**")).toEqual(['src/a,b/**', 'docs/**']);
    expect(patternsFor('src/a\\,b/**')).toEqual(['src/a\\,b/**']);
    expect(selects('src/a\\,b/**', ['src/a,b/x.ts', 'b/x.ts'])).toEqual(['src/a,b/x.ts']);
  });

  it('goes through the same splitter in the `- ` block form', () => {
    const parsed = parseRuleFile('---\npaths:\n  - "src/**/*.{ts,tsx}"\n  - docs/{v1,v2}/**\n---\nrule body\n');
    expect(parsed?.patterns).toEqual(['src/**/*.{ts,tsx}', 'docs/{v1,v2}/**']);
  });

  it('strips a YAML flow list\'s brackets as a PAIR, never a lone leading one', () => {
    expect(patternsFor('[src/**/*.{ts,tsx}, docs/**]')).toEqual(['src/**/*.{ts,tsx}', 'docs/**']);
    // A value that legitimately BEGINS with a bracket expression: the unpaired
    // strip turned this into `ab]/x.ts`, a close with no open, which
    // `compileSegment` refuses — so the rule matched nothing.
    expect(patternsFor('[ab]/x.ts')).toEqual(['[ab]/x.ts']);
    expect(selects('[ab]/x.ts', ['a/x.ts', 'b/x.ts', 'c/x.ts'])).toEqual(['a/x.ts', 'b/x.ts']);
  });
});

describe('truncation never widens (53007d740\'s rule, applied to `paths`)', () => {
  it('leaves an unterminated brace group attached, so it matches nothing', () => {
    // MEASURED before the fix: this produced `['docs/{a', '**']`, and the bare
    // `**` matched every one of the 30 files in the differential corpus — a rule
    // its author scoped to `docs/` fired on every read.
    expect(patternsFor('docs/{a,**')).toEqual(['docs/{a,**']);
    expect(selects('docs/{a,**', ['docs/a.md', 'src/a.ts', 'a.ts', 'photos/2024/a.jpg'])).toEqual([]);
  });

  it('does the same for a `*` tail and for a root-file tail', () => {
    // `['docs/{a', '*']` matched every root file; `['config/{dev', 'prod']`
    // matched a root file named `prod` that the rule never named.
    expect(patternsFor('docs/{a,*')).toEqual(['docs/{a,*']);
    expect(selects('docs/{a,*', ['a.ts', 'prod', 'docs/a.md'])).toEqual([]);
    expect(patternsFor('config/{dev,prod')).toEqual(['config/{dev,prod']);
    expect(selects('config/{dev,prod', ['prod', 'config/prod/x.yml'])).toEqual([]);
  });

  it('does the same for an unterminated flow list', () => {
    expect(patternsFor('[src/a, src/b')).toEqual(['[src/a, src/b']);
    expect(selects('[src/a, src/b', ['src/a', 'src/b'])).toEqual([]);
  });

  it('never turns a declared `paths` into ZERO patterns, which would UNSCOPE the rule', () => {
    // `parseRuleFile` reports "unscoped" as `patterns.length === 0`, and
    // `unscopedRuleBody` then loads the rule unconditionally at launch — the
    // widest state there is. No structured value may reach it by accident.
    for (const value of [
      'src/**/*.{ts,tsx}',
      'docs/{a,**',
      '[src/a, src/b',
      'src/[a,b]*.ts',
      '"src/a,b/**"',
      'src/a\\,b/**',
    ]) {
      expect(patternsFor(value).length).toBeGreaterThan(0);
    }
  });
});

/**
 * P2.185 — the case the invariant above could not cover, because it is not a
 * structured value at all: a `paths` key the author WROTE and gave nothing.
 *
 * `patterns.length === 0` was the readers' one test for "unscoped", so an
 * authored-but-empty list arrived at the widest state there is. Measured over
 * the repo's 5321 tracked files before the fix: `paths: ,` selected all 5321,
 * byte-identical to omitting the key. `memory.md` grants that only to the
 * absent field — "Rules WITHOUT a `paths` field are loaded unconditionally and
 * apply to all files" (fetched 2026-08-26) — and its own remedy for a `paths`
 * value it cannot honour is the opposite direction twice on the same page: a
 * budget-busting brace group's "literal braces match no files", and a bracket
 * expression that cannot be read "matches nothing, and the rule's other
 * patterns keep working".
 */
describe('a `paths` key the author wrote and left empty is not an absent one', () => {
  /** How one whole rule file resolves: unconditional, path-scoped, or nothing. */
  function loadStateOf(raw: string): 'unconditional' | 'path-scoped' | 'nothing' {
    const parsed = parseRuleFile(raw);
    if (unscopedRuleBody(raw) !== undefined) return 'unconditional';
    return parsed && parsed.patterns.length > 0 ? 'path-scoped' : 'nothing';
  }

  const EMPTY_VALUES = [',', ',,,', ', ,', '""', "''", '[]', '[ ]', '[,]', ' '];

  it('keys as declared, yields no pattern, and is withheld from the launch block', () => {
    for (const value of EMPTY_VALUES) {
      const raw = `---\npaths: ${value}\n---\nrule body\n`;
      const parsed = parseRuleFile(raw);
      expect(parsed).not.toBeNull();
      expect(parsed!.pathsDeclared).toBe(true);
      expect(parsed!.patterns).toEqual([]);
      expect(unscopedRuleBody(raw)).toBeUndefined();
      expect(loadStateOf(raw)).toBe('nothing');
      // The direction that matters: it now selects nothing, where it used to be
      // in context for every file read in the workspace.
      expect(selects(value, ['a.ts', 'docs/a.md', 'src/deep/b.tsx'])).toEqual([]);
    }
  });

  it('covers the block form and the three key aliases', () => {
    // A bare `paths:` with no items beneath it is the same fumble in YAML's
    // other spelling, and `path` / `glob` / `globs` reach the same branch.
    expect(loadStateOf('---\npaths:\n---\nrule body\n')).toBe('nothing');
    expect(loadStateOf('---\npaths:\ndescription: x\n---\nrule body\n')).toBe('nothing');
    expect(loadStateOf('---\npath:\n---\nrule body\n')).toBe('nothing');
    expect(loadStateOf('---\nglob: ,\n---\nrule body\n')).toBe('nothing');
    expect(loadStateOf('---\nglobs: ""\n---\nrule body\n')).toBe('nothing');
  });

  it('leaves the ABSENT field unconditional, which is the sentence memory.md does grant', () => {
    // The control in the other direction. Without it, everything above passes
    // just as well against a parser that stopped loading unscoped rules at all
    // — which is the regression `parseRuleFile` already shipped once.
    for (const raw of [
      '---\ndescription: x\n---\nrule body\n',
      'rule body with no frontmatter at all\n',
    ]) {
      expect(parseRuleFile(raw)!.pathsDeclared).toBe(false);
      expect(unscopedRuleBody(raw)).toContain('rule body');
      expect(loadStateOf(raw)).toBe('unconditional');
    }
  });

  it('leaves a DECLARED, non-empty `paths` exactly where it was', () => {
    const raw = '---\npaths: src/**/*.{ts,tsx}\n---\nrule body\n';
    expect(parseRuleFile(raw)!.pathsDeclared).toBe(true);
    expect(loadStateOf(raw)).toBe('path-scoped');
    expect(selects('src/**/*.{ts,tsx}', ['src/a.ts', 'src/deep/b.tsx', 'src/a.py']))
      .toEqual(['src/a.ts', 'src/deep/b.tsx']);
  });
});
