/**
 * P6.455 — the reader for codex's own `experimentalFeature/list`, and the two
 * drift ties that keep it honest.
 *
 * The unit arms pin the reading RULE (stage, never `enabled`; a short page is
 * not an absence). The two ties are the part that survives a binary bump:
 *
 *  1. `CODEX_FEATURE_STAGES` against the generated
 *     `ExperimentalFeatureStage.ts` source TEXT — the protocol package states
 *     that nothing imports `generated/*.ts` as a module and `generated/` is in
 *     no typecheck program, so a type import would be checked by nobody.
 *  2. `CODEX_DEPENDED_FEATURES` against the `[features]` block
 *     `config-writer.ts` actually emits. A key added there and not here would
 *     be a feature we depend on with no stage watch, which is the exact silence
 *     this row exists to end.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CODEX_DEPENDED_FEATURES,
  CODEX_REFUSED_FEATURES,
  CODEX_EXPERIMENTAL_FEATURE_LIST_METHOD,
  CODEX_FEATURE_STAGES,
  codexDependedFeatureStageNotice,
  codexFeatureStageSessionFact,
  readCodexFeatureStages,
} from '../experimental-features.ts';

/** Four levels up from `src/__tests__` is the repo root. */
const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');

function listResult(
  rows: Array<Record<string, unknown>>,
  nextCursor: string | null = null,
): unknown {
  return { data: rows, nextCursor };
}

/** The shape the pinned binary answered with on 2026-09-05, trimmed to three rows. */
const PINNED_SAMPLE = listResult([
  { name: 'multi_agent', stage: 'stable', enabled: true, defaultEnabled: true },
  { name: 'view_image', stage: 'stable', enabled: true, defaultEnabled: true },
  { name: 'executed_tool_call_metadata', stage: 'underDevelopment', enabled: false, defaultEnabled: false },
]);

describe('readCodexFeatureStages', () => {
  test('reads name -> stage and reports a complete page', () => {
    const reading = readCodexFeatureStages(PINNED_SAMPLE);
    expect(reading.count).toBe(3);
    expect(reading.partial).toBe(false);
    expect(reading.stages.get('multi_agent')).toBe('stable');
    expect(reading.stages.get('executed_tool_call_metadata')).toBe('underDevelopment');
  });

  test('a `nextCursor` marks the reading PARTIAL', () => {
    // Measured: with `limit: 5` the pinned binary answers 20 pages of 5 and the
    // cursor is a numeric-offset string.
    const reading = readCodexFeatureStages(listResult([{ name: 'multi_agent', stage: 'stable' }], '5'));
    expect(reading.partial).toBe(true);
    expect(reading.count).toBe(1);
  });

  test('keeps an UNKNOWN stage string rather than dropping the entry', () => {
    // A sixth stage in a future release must not make the reader blind.
    const reading = readCodexFeatureStages(listResult([{ name: 'multi_agent', stage: 'sunsetting' }]));
    expect(reading.stages.get('multi_agent')).toBe('sunsetting');
  });

  test('never throws, and degrades to an empty reading on every broken shape', () => {
    for (const bad of [
      null,
      undefined,
      42,
      'nope',
      {},
      { data: null },
      { data: 'not an array' },
      { data: [null, 7, {}, { name: '' }, { name: 'x' }, { stage: 'stable' }, { name: 'y', stage: 5 }] },
    ]) {
      const reading = readCodexFeatureStages(bad);
      expect(reading.count).toBe(0);
      expect(reading.partial).toBe(false);
    }
  });
});

describe('codexFeatureStageSessionFact', () => {
  test('states the count and every depended key with its stage', () => {
    const fact = codexFeatureStageSessionFact(readCodexFeatureStages(PINNED_SAMPLE));
    expect(fact).toContain('3 features reported');
    expect(fact).toContain('multi_agent=stable');
    expect(fact).toContain('view_image=stable');
    // The reading rule, visible in the output: no `enabled` anywhere.
    expect(fact).not.toContain('enabled');
  });

  test('a partial page says so, so the sentence cannot be over-read', () => {
    const fact = codexFeatureStageSessionFact(
      readCodexFeatureStages(listResult([{ name: 'multi_agent', stage: 'stable' }], '5')),
    );
    expect(fact).toContain('one page of several');
  });

  test('no answer leaves NO sentence behind', () => {
    expect(codexFeatureStageSessionFact(readCodexFeatureStages(null))).toBeNull();
  });
});

/**
 * P6.533 · every depended feature at `stable`, with named overrides.
 *
 * Derived from `CODEX_DEPENDED_FEATURES` rather than typed out: the list grew
 * from two to eight the day the writer's `[features]` block was decided, and a
 * hand-written fixture would then have reported six features "no longer listed"
 * in a test whose whole point is the SILENT case.
 */
function stableRowsForDepended(overrides: Record<string, string> = {}): unknown {
  return listResult(CODEX_DEPENDED_FEATURES.map(name => ({
    name,
    stage: overrides[name] ?? 'stable',
    enabled: true,
    defaultEnabled: true,
  })));
}

describe('codexDependedFeatureStageNotice', () => {
  test('silent when every depended feature is stable — the pinned-binary case', () => {
    // Measured: all eight read `stable` on the binary `manifest.json` pins.
    expect(codexDependedFeatureStageNotice(readCodexFeatureStages(stableRowsForDepended()))).toBeNull();
    // And the trimmed three-row sample is still silent when asked about the two
    // features it actually carries.
    expect(
      codexDependedFeatureStageNotice(readCodexFeatureStages(PINNED_SAMPLE), ['multi_agent', 'view_image']),
    ).toBeNull();
  });

  test('fires on `deprecated` and on `removed`, naming the feature and its stage', () => {
    for (const stage of ['deprecated', 'removed']) {
      const notice = codexDependedFeatureStageNotice(
        readCodexFeatureStages(stableRowsForDepended({ view_image: stage })),
      );
      expect(notice).toContain('view_image');
      expect(notice).toContain(stage);
      expect(notice).toContain('nothing here will fail');
    }
  });

  test('does NOT fire on `beta` or `underDevelopment` — codex announces those itself', () => {
    for (const stage of ['beta', 'underDevelopment']) {
      const notice = codexDependedFeatureStageNotice(
        readCodexFeatureStages(stableRowsForDepended({ view_image: stage })),
      );
      expect(notice).toBeNull();
    }
  });

  test('an UNLISTED depended feature fires only on a COMPLETE page', () => {
    const rows = [{ name: 'multi_agent', stage: 'stable' }];
    const complete = codexDependedFeatureStageNotice(readCodexFeatureStages(listResult(rows)));
    expect(complete).toContain('no longer lists');
    expect(complete).toContain('view_image');
    // The boundary this reader exists for: the same absence on one page of
    // several is codex having grown, not the feature having gone.
    const partial = codexDependedFeatureStageNotice(readCodexFeatureStages(listResult(rows, '5')));
    expect(partial).toBeNull();
  });

  test('no answer raises no notice', () => {
    expect(codexDependedFeatureStageNotice(readCodexFeatureStages(null))).toBeNull();
  });
});

describe('drift ties', () => {
  test('the method name is the one in the shipped ClientRequest enumeration', () => {
    const source = readFileSync(
      join(REPO_ROOT, 'packages', 'codex-protocol', 'generated', 'ClientRequest.ts'),
      'utf8',
    );
    expect(source).toContain(`"method": "${CODEX_EXPERIMENTAL_FEATURE_LIST_METHOD}"`);
  });

  test('CODEX_FEATURE_STAGES is exactly the generated ExperimentalFeatureStage union', () => {
    const source = readFileSync(
      join(REPO_ROOT, 'packages', 'codex-protocol', 'generated', 'v2', 'ExperimentalFeatureStage.ts'),
      'utf8',
    );
    const declared = [...source.matchAll(/"([A-Za-z]+)"/g)].map(m => m[1]!);
    expect(declared.length).toBeGreaterThan(0);
    const known: string[] = [...CODEX_FEATURE_STAGES];
    expect(known.sort()).toEqual([...declared].sort());
  });

  test('P6.266 — a REFUSED feature is absent from the writer\'s [features] block, and is not depended on', () => {
    const source = readFileSync(
      join(REPO_ROOT, 'packages', 'codex-responses-adapter', 'src', 'config-writer.ts'),
      'utf8',
    );
    const at = source.indexOf("'[features]',");
    expect(at).toBeGreaterThan(-1);
    const block = source.slice(at, source.indexOf("\n    '',", at));
    expect(CODEX_REFUSED_FEATURES.length).toBeGreaterThan(0);
    for (const name of CODEX_REFUSED_FEATURES) {
      // Measured on the pinned binary: the page's documented table form is a
      // config-LOAD failure and the flat form is inert, so emitting the name
      // could only ever cost us a session.
      expect(block).not.toContain(name);
      expect(CODEX_DEPENDED_FEATURES).not.toContain(name);
    }
  });

  test('P6.507 — the token-budget refusal is recorded at BOTH sites, not just in a list', () => {
    // A name in `CODEX_REFUSED_FEATURES` with no reason beside it is the silence
    // the list exists to end. Both keys are `underDevelopment` on the pinned
    // binary; `rollout_budget` is additionally boot-fatal without its required
    // sub-keys, and the third mechanism belongs to a goal engine we turn off.
    for (const name of ['token_budget', 'rollout_budget']) {
      expect(CODEX_REFUSED_FEATURES).toContain(name);
    }
    const here = readFileSync(
      join(REPO_ROOT, 'packages', 'codex-agent-server', 'src', 'experimental-features.ts'),
      'utf8',
    );
    expect(here).toContain('P6.507');
    expect(here).toContain('max_goal_token_budget');
    expect(here).toContain('EXIT CONDITION');
    const writer = readFileSync(
      join(REPO_ROOT, 'packages', 'codex-responses-adapter', 'src', 'config-writer.ts'),
      'utf8',
    );
    // The writer is where a lane looking for a token ceiling actually goes.
    expect(writer).toContain('THE TOKEN CEILING IS NOT WRITTEN HERE EITHER');
  });

  test('CODEX_DEPENDED_FEATURES is exactly what the writer sets true in [features]', () => {
    const source = readFileSync(
      join(REPO_ROOT, 'packages', 'codex-responses-adapter', 'src', 'config-writer.ts'),
      'utf8',
    );
    // The writer emits the block as an array of literal lines: `'[features]'`
    // followed by backtick-quoted `key = true` entries, then a `''` spacer.
    const at = source.indexOf("'[features]',");
    expect(at).toBeGreaterThan(-1);
    const block = source.slice(at, source.indexOf("\n    '',", at));
    const written = [...block.matchAll(/^\s*`([a-z0-9_]+) = true`,/gm)].map(m => m[1]!);
    expect(written.length).toBeGreaterThan(0);
    expect([...written].sort()).toEqual([...CODEX_DEPENDED_FEATURES].sort());
  });
});
