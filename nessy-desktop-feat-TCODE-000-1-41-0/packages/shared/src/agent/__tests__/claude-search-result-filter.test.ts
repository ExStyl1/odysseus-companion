/**
 * P6.63 — the RESULTS half of the sensitive-files contract, on claude.
 *
 * `settings-reference.md#exclude-sensitive-files` promises a denied file is
 * excluded "from file discovery and search results"; P3.147/P3.174 measured
 * that the shipped binary does not do it — the `Read` is refused in the same
 * run while `Grep` returns the secret's own line. This suite covers the host
 * filter that does it instead, on the runtime's own `PostToolUse`
 * `updatedToolOutput` seam (P3.340: "EXISTS and is deliberately unused … the
 * honest verdict for both is 'never wired', not 'cannot'").
 *
 * The payload shapes here are MEASURED, not invented: they were read off the
 * vendored binary on 2026-09-05 through a `PostToolUse` probe driving the
 * P3.147 rig, and they are reproduced verbatim as fixtures. The rewrite must
 * preserve them exactly, because a mismatch is ignored SILENTLY and the
 * original output is used — it fails OPEN, which is why an unrecognised shape
 * is reported rather than guessed at.
 */
import { describe, expect, it } from 'bun:test';
import { rewriteClaudeSearchOutput } from '../claude-search-result-filter.ts';

const DENIED = '/fixture/nested/.env';
const PLAIN = '/fixture/nested/plain.txt';
const MARKER = 'NESSY_P6063_MARKER';

/** The floor's answer: the DENIED subset, which is the contract's safe direction. */
const floor = (paths: readonly string[]) => paths.filter(path => path.endsWith('/.env'));

/** Measured 2026-09-05: `Grep`, `output_mode: content`. */
const grepContent = () => ({
  mode: 'content',
  numFiles: 0,
  filenames: [] as string[],
  content: `${PLAIN}:1:harmless=${MARKER}\n${DENIED}:1:SECRET_TOKEN=${MARKER}`,
  numLines: 2,
  totalLines: 2,
});

/** Measured 2026-09-05: `Grep`, `output_mode: files_with_matches`. */
const grepFiles = () => ({
  mode: 'files_with_matches',
  filenames: [PLAIN, DENIED],
  numFiles: 2,
  totalFiles: 2,
});

/** Measured 2026-09-05: `Glob`. */
const glob = () => ({
  filenames: [DENIED, PLAIN],
  durationMs: 11,
  numFiles: 2,
  truncated: false,
  totalMatches: 2,
  countIsComplete: true,
});

describe('rewriteClaudeSearchOutput — the three measured shapes', () => {
  it('withholds the denied file\'s LINE from Grep content, and keeps the other', async () => {
    const result = await rewriteClaudeSearchOutput({
      toolName: 'Grep', toolResponse: grepContent(), searchRoot: '/fixture', filter: floor,
    });
    expect(result.kind).toBe('rewritten');
    if (result.kind !== 'rewritten') return;
    // The refutation, inverted: the secret's own value no longer comes back.
    expect(result.output.content).not.toContain('.env');
    expect(result.output.content).not.toContain('SECRET_TOKEN');
    // Positive control in the same assertion: the search genuinely ran and the
    // undenied file is still there, so an empty result cannot be mistaken for
    // enforcement.
    expect(result.output.content).toContain('plain.txt');
    expect(result.output.content).toContain(MARKER);
    // The counts move with the content, or the payload contradicts itself.
    expect(result.output.numLines).toBe(1);
    expect(result.output.totalLines).toBe(1);
    // Every field we did not measure survives, because a dropped field is a
    // shape mismatch and a shape mismatch fails open.
    expect(result.output.mode).toBe('content');
    expect(result.output.numFiles).toBe(0);
    expect(result.output.filenames).toEqual([]);
    expect(result.withheldFiles).toBe(1);
  });

  it('withholds the denied file from Grep files_with_matches', async () => {
    const result = await rewriteClaudeSearchOutput({
      toolName: 'Grep', toolResponse: grepFiles(), searchRoot: '/fixture', filter: floor,
    });
    expect(result.kind).toBe('rewritten');
    if (result.kind !== 'rewritten') return;
    expect(result.output.filenames).toEqual([PLAIN]);
    expect(result.output.numFiles).toBe(1);
    expect(result.output.totalFiles).toBe(1);
    expect(result.output.mode).toBe('files_with_matches');
  });

  it('withholds the denied file from Glob and keeps its other fields', async () => {
    const result = await rewriteClaudeSearchOutput({
      toolName: 'Glob', toolResponse: glob(), searchRoot: '/fixture', filter: floor,
    });
    expect(result.kind).toBe('rewritten');
    if (result.kind !== 'rewritten') return;
    expect(result.output.filenames).toEqual([PLAIN]);
    expect(result.output.numFiles).toBe(1);
    expect(result.output.totalMatches).toBe(1);
    // Untouched, because we did not measure what they mean.
    expect(result.output.durationMs).toBe(11);
    expect(result.output.truncated).toBe(false);
    expect(result.output.countIsComplete).toBe(true);
  });
});

describe('rewriteClaudeSearchOutput — the cases that must NOT rewrite', () => {
  it('is unchanged when nothing in the result is denied', async () => {
    // Not merely "no files withheld": the payload must be left ALONE, so a
    // session with no denied hit is byte-identical to one before this row.
    const nothingDenied = () => [] as string[];
    for (const [tool, response] of [['Grep', grepContent()], ['Grep', grepFiles()], ['Glob', glob()]] as const) {
      const result = await rewriteClaudeSearchOutput({
        toolName: tool, toolResponse: response, searchRoot: '/fixture', filter: nothingDenied,
      });
      expect(result.kind).toBe('unchanged');
    }
  });

  it('is unchanged with no floor configured, and for a tool this is not about', async () => {
    expect((await rewriteClaudeSearchOutput({
      toolName: 'Grep', toolResponse: grepContent(), searchRoot: '/fixture', filter: undefined,
    })).kind).toBe('unchanged');
    expect((await rewriteClaudeSearchOutput({
      toolName: 'Read', toolResponse: grepContent(), searchRoot: '/fixture', filter: floor,
    })).kind).toBe('unchanged');
  });

  it('reports an UNSUPPORTED shape instead of guessing, and says which', async () => {
    // The row's own extra requirement, and the reason it exists: the rewrite
    // fails OPEN, so a shape we do not know must be announced rather than
    // half-rewritten into a value the validator silently discards.
    const count = await rewriteClaudeSearchOutput({
      toolName: 'Grep',
      toolResponse: { mode: 'count', filenames: [DENIED], numFiles: 1 },
      searchRoot: '/fixture',
      filter: floor,
    });
    expect(count.kind).toBe('unsupported');
    if (count.kind === 'unsupported') expect(count.reason).toContain('count');

    const notAnObject = await rewriteClaudeSearchOutput({
      toolName: 'Glob', toolResponse: 'a plain string', searchRoot: '/fixture', filter: floor,
    });
    expect(notAnObject.kind).toBe('unsupported');

    const noFilenames = await rewriteClaudeSearchOutput({
      toolName: 'Glob', toolResponse: { filenames: [1, 2], numFiles: 2 }, searchRoot: '/fixture', filter: floor,
    });
    expect(noFilenames.kind).toBe('unsupported');

    const noContent = await rewriteClaudeSearchOutput({
      toolName: 'Grep', toolResponse: { mode: 'content', content: 42 }, searchRoot: '/fixture', filter: floor,
    });
    expect(noContent.kind).toBe('unsupported');
  });
});

describe('the notice — filtering is said, never silent, and never names the file', () => {
  it('states a file COUNT and no path', async () => {
    const result = await rewriteClaudeSearchOutput({
      toolName: 'Glob', toolResponse: glob(), searchRoot: '/fixture', filter: floor,
    });
    expect(result.kind).toBe('rewritten');
    if (result.kind !== 'rewritten') return;
    expect(result.notice).toContain('1 file');
    expect(result.notice).toContain('deniedPaths');
    // Naming the path would undo the exclusion; a LINE count would leak how
    // many lines of a credential file matched the query.
    expect(result.notice).not.toContain('.env');
    expect(result.notice).not.toContain(DENIED);
  });
});

describe('the wiring — the hook is registered and the answer comes from the ONE matcher', () => {
  it('registers an internal PostToolUse hook that calls the filter', async () => {
    const src = await Bun.file(new URL('../claude-agent.ts', import.meta.url)).text();
    expect(src).toContain('PostToolUse: [{');
    expect(src).toContain('rewriteClaudeSearchOutput({');
    expect(src).toContain('updatedToolOutput: rewrite.output as unknown as string');
    // The unsupported branch reaches the USER, not only a log: the floor
    // silently not covering a result set is a degradation.
    expect(src).toContain('this.queueDegradationNotice(');
    // The ONE matcher, not a second one: `shouldAllowToolInMode` reading
    // `denyPathBlocked`, the same route `NestorCloudAgent.deniedResultPaths`
    // takes. A re-derived matcher inherits the four defects P3.105 recorded.
    expect(src).toContain('verdict.denyPathBlocked === true');
    // Negative control on the same read, so a probe that matches anything fails.
    expect(src).not.toContain('ZZQQ_NOT_A_REAL_SYMBOL');
  });
});
