/**
 * P6.704 — every place an agent names the plans folder honours `plansDirectory`.
 *
 * The RULE itself (containment against the project root, the fallback on a path
 * that escapes) is exercised in `config/__tests__/memory-and-plans-directories.test.ts`.
 * What has no other guard is the SITE set: `resolvePlansDirectory` scored 0 in
 * all four agent files before this row, and the failure mode is not a wrong
 * value but a MISSED site — one caller left on `getSessionPlansDir` alone puts
 * the gate, the sandbox, the prompt and the writer in disagreement about where
 * a plan lives.
 *
 * ROW CORRECTION, measured here. The row names five sites, found by grepping
 * `plansFolderPath:`. There are TEN:
 *  - Pi builds the value into a local first (`const plansFolderPath = …`), so
 *    its three sites carry no colon and the row's grep could not see them;
 *  - `claude-agent.ts`'s seatbelt `writablePaths` entry and `codex-agent.ts`'s
 *    `--plans-folder` argument to the session MCP server are not named
 *    `plansFolderPath` at all — and the second of those is the one that
 *    actually WRITES the file on codex.
 * So the scan is by CALL, not by property name: every `getSessionPlansDir(`
 * call in the four agent files must sit behind `resolvePlansDirectory(…) ??`.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const AGENT_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const AGENT_FILES = ['base-agent.ts', 'claude-agent.ts', 'codex-agent.ts', 'pi-agent.ts'] as const;

const CALL = 'getSessionPlansDir(';
/**
 * The window is generous on purpose: the fallback is written across two to four
 * lines at most sites (a ternary, an object entry, an array element), and a
 * window tight enough to be "exact" would fail on formatting rather than on
 * behaviour. It is still far shorter than the distance to the previous site.
 */
const WINDOW = 320;

interface Site {
  readonly file: string;
  readonly line: number;
  readonly guarded: boolean;
}

/** Exported shape of the scan so the negative arm can drive it on synthetic text. */
function scan(file: string, source: string): Site[] {
  const sites: Site[] = [];
  let at = source.indexOf(CALL);
  while (at !== -1) {
    const before = source.slice(Math.max(0, at - WINDOW), at);
    sites.push({
      file,
      line: source.slice(0, at).split('\n').length,
      guarded: before.includes('resolvePlansDirectory('),
    });
    at = source.indexOf(CALL, at + CALL.length);
  }
  return sites;
}

const sites = AGENT_FILES.flatMap(file => scan(file, readFileSync(join(AGENT_DIR, file), 'utf8')));

describe('P6.704 — the plans directory is resolved at every agent site', () => {
  it('finds the sites at all (the scan cannot pass vacuously)', () => {
    // A floor, not an equality: a new site is a reason for the next lane to
    // read this file, and the per-site assertion below is what fails then.
    // Ten at the time of writing — base-agent 1, claude 4, codex 2, pi 3.
    expect(sites.length).toBeGreaterThanOrEqual(10);
    for (const file of AGENT_FILES) {
      expect(sites.filter(site => site.file === file).length).toBeGreaterThan(0);
    }
  });

  it('routes every one of them through resolvePlansDirectory', () => {
    const unguarded = sites.filter(site => !site.guarded).map(site => `${site.file}:${site.line}`);
    expect(unguarded).toEqual([]);
  });

  it('imports the resolver in each of the four files', () => {
    for (const file of AGENT_FILES) {
      const source = readFileSync(join(AGENT_DIR, file), 'utf8');
      expect({ file, imported: /resolvePlansDirectory,?\n?[^;]*from '\.\.\/config\/storage\.ts'/s.test(source) })
        .toEqual({ file, imported: true });
    }
  });

  it('NEGATIVE — an unguarded site is reported, and a guarded one is not', () => {
    const bad = scan('synthetic.ts', 'const p = getSessionPlansDir(id, sessionId);\n');
    expect(bad.map(site => site.guarded)).toEqual([false]);

    const good = scan(
      'synthetic.ts',
      'const p = resolvePlansDirectory(this.workingDirectory)\n  ?? getSessionPlansDir(id, sessionId);\n',
    );
    expect(good.map(site => site.guarded)).toEqual([true]);
  });

  it('NEGATIVE — a resolver call too far away does NOT count as a guard', () => {
    // The window is the whole reason this scan means anything: without it, one
    // `resolvePlansDirectory` anywhere earlier in a 10 000-line file would make
    // every later site read as guarded.
    const far = scan(
      'synthetic.ts',
      `const other = resolvePlansDirectory(root);\n${'// filler\n'.repeat(60)}const p = getSessionPlansDir(id, sessionId);\n`,
    );
    expect(far.map(site => site.guarded)).toEqual([false]);
  });
});
