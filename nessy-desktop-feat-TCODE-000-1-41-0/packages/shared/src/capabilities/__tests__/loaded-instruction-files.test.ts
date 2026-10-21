/**
 * P6.397 — the loaded-files group, composed host-side so claude and codex answer
 * `/context` the way Pi already does.
 *
 * Measured at HEAD: `ContextUsageSnapshot` had exactly one producer
 * (`pi-agent-server/src/context-categories.ts`), so `git grep -an
 * 'contextUsage:'` over the claude and codex event adapters scored **0** — the
 * loaded-files group was empty on both, for a fact that is not per-runtime at
 * all.
 *
 * These cases drive the composer against the same two rules the Pi producer
 * inherits from `composeMemoryLayerBodies`, because the whole point of calling
 * it rather than restating it is that the two surfaces cannot disagree.
 */

import { describe, expect, test } from 'bun:test';
import { estimateTokens } from '../../utils/large-response.ts';
import { composeLoadedInstructionFiles } from '../loaded-instruction-files.ts';

type Layer = {
  key: string;
  importParentPath?: string;
  resource: { absolutePath?: string; contentHash?: string };
};

function layer(key: string, absolutePath: string, importParentPath?: string): Layer {
  return {
    key,
    resource: { absolutePath, contentHash: `hash-${key}` },
    ...(importParentPath ? { importParentPath } : {}),
  };
}

describe('composeLoadedInstructionFiles (P6.397)', () => {
  test('names every layer by its key, tags the two kinds, and sizes the DELIVERED body', async () => {
    // POSITIVE. `name` is the layer key because that is exactly what Pi reports:
    // it stamps `${key}@${generation}` as the descriptor provenance and slices
    // the generation back off to get the file's name.
    const project = layer('project:AGENTS.md', '/repo/AGENTS.md');
    const memory = layer('user:CLAUDE.md', '/home/u/.claude/CLAUDE.md');
    const bodies = new Map<string, string>([
      ['/repo/AGENTS.md', 'project instructions'.repeat(4)],
      ['/home/u/.claude/CLAUDE.md', 'user memory'],
    ]);

    const files = await composeLoadedInstructionFiles({
      promptLayers: [project],
      memory: [memory],
      readText: async l => bodies.get(l.resource.absolutePath ?? '') ?? '',
    });

    expect(files).toEqual([
      { name: 'project:AGENTS.md', kind: 'instruction', tokens: estimateTokens(bodies.get('/repo/AGENTS.md') ?? '') },
      { name: 'user:CLAUDE.md', kind: 'memory', tokens: estimateTokens('user memory') },
    ]);
  });

  test('a layer spliced into its importer is DROPPED, and a block HTML comment is not counted', async () => {
    // The two rules that make this a composer and not a second derivation. An
    // `@path` import's body ships inside the importer, so a row for it would
    // double-count the same bytes; and `memory.md:161` strips block HTML
    // comments before the body is injected, so counting them would report a cost
    // the model never pays.
    const importer = layer('project:AGENTS.md', '/repo/AGENTS.md');
    const imported = layer('project:docs/style.md', '/repo/docs/style.md', '/repo/AGENTS.md');
    const bodies = new Map<string, string>([
      ['/repo/AGENTS.md', '<!-- an editorial note -->\nSee @docs/style.md for the rules.'],
      ['/repo/docs/style.md', 'the style rules'],
    ]);

    const files = await composeLoadedInstructionFiles({
      promptLayers: [importer, imported],
      memory: [],
      readText: async l => bodies.get(l.resource.absolutePath ?? '') ?? '',
    });

    expect(files.map(file => file.name)).toEqual(['project:AGENTS.md']);
    const composedTokens = files[0]?.tokens ?? 0;
    // The importer's row carries the imported body — that is what "spliced in"
    // means — so it is LARGER than the importer's own file…
    expect(composedTokens).toBeGreaterThan(0);
    // …and smaller than the raw bytes, because the comment was stripped.
    const raw = (bodies.get('/repo/AGENTS.md') ?? '') + (bodies.get('/repo/docs/style.md') ?? '');
    expect(composedTokens).toBeLessThan(estimateTokens(raw));
  });

  test('no layers at all is an empty list, never a row for a file that did not load', async () => {
    // NEGATIVE, and the reason the caller treats an empty result as "nothing to
    // say": a session with no instruction files must show no group rather than a
    // group with a zero row in it.
    let reads = 0;
    const files = await composeLoadedInstructionFiles({
      promptLayers: [],
      memory: [],
      readText: async () => { reads += 1; return ''; },
    });
    expect(files).toEqual([]);
    expect(reads).toBe(0);
  });
});
