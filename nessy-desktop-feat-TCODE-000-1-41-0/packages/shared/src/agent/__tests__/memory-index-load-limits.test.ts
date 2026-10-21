/**
 * R33 · f092 f098 f104 f172 — the auto-memory index loads under TWO caps.
 *
 * `how-claude-code-works.md:74`: "The first 200 lines or 25KB of MEMORY.md,
 * whichever comes first, load at the start of each session."
 * `memory.md:384`: "The first 200 lines of `MEMORY.md`, or the first 25KB,
 * whichever comes first, are loaded at the start of every conversation. Content
 * beyond that threshold is not loaded at session start."
 * `memory.md:390`: "This limit applies only to `MEMORY.md`. CLAUDE.md files are
 * loaded in full regardless of length, though shorter files produce better
 * adherence."
 *
 * Asserted through the LIVE seam, which is the half the subsystem's existing
 * tests miss entirely: `MEMORY_LOAD_LINE_LIMIT` was wired only into
 * `readMemoryFile`, and the composer that reads it (`loadMemoryPromptBlock` via
 * `prompts/system.ts`) is skipped on every normal turn — both backends pass
 * `capabilityTurnRuntime !== null` for `capabilityContextPinned`. What a real
 * turn carries is the pinned capability block that `BaseAgent` composes and
 * prepends to the chat message, so that is what these tests read.
 */

import { CapabilityMaterializationError } from '../../capabilities/materializer.ts';
import { expect, test } from 'bun:test';
import type { CapabilityTurnRuntime } from '../backend/types.ts';
import type {
  NativeResourceRef,
  RuntimeMemoryHandle,
  RuntimePromptLayer,
} from '../../capabilities/resolver.ts';
import { MEMORY_LOAD_BYTE_LIMIT, MEMORY_LOAD_LINE_LIMIT } from '../memory/memory-store.ts';
import { materializePiContextResources } from '../pi-harness/context-resource.ts';
import { TestAgent, collectEvents, createMockBackendConfig } from './test-utils.ts';

function memoryResource(absolutePath: string): NativeResourceRef {
  return {
    source: 'project',
    scope: { kind: 'project', workspaceId: 'ws' },
    resourceId: absolutePath,
    absolutePath,
    revision: '1',
    contentHash: 'c'.repeat(64),
  };
}

function indexLayer(absolutePath: string): RuntimeMemoryHandle {
  return {
    key: `memory::project::ws::-::index::${absolutePath}`,
    resource: memoryResource(absolutePath),
    readOnly: false,
  };
}

function ruleLayer(absolutePath: string): RuntimeMemoryHandle {
  return { ...indexLayer(absolutePath), format: 'rule' };
}

function promptLayer(absolutePath: string): RuntimePromptLayer {
  return { key: `instruction::project::ws::${absolutePath}`, resource: memoryResource(absolutePath), order: 0 };
}

/** One capability turn over the given files, with the given layer split. */
function runtimeWith(
  files: Record<string, string>,
  layers: { memory?: RuntimeMemoryHandle[]; promptLayers?: RuntimePromptLayer[] },
): CapabilityTurnRuntime {
  return {
    provider: 'pi',
    view: {
      generation: 'generation-memory-caps-1',
      sources: [], skills: [], mcpServers: [], hooks: [], automations: [], agents: [],
      promptLayers: layers.promptLayers ?? [],
      memory: layers.memory ?? [],
      permissionLayers: [], commands: [], promptCommands: [], apps: [], lspServers: [], monitors: [],
    },
    materializer: {
      assertActive() {},
      async verifyPlugin() {},
      async resolvePath(resource: unknown) { return (resource as NativeResourceRef).absolutePath; },
      async readText(resource: unknown) { return files[(resource as NativeResourceRef).absolutePath] ?? ''; },
      resolveCredential() { throw new CapabilityMaterializationError('credential-not-ready'); },
    },
  } as CapabilityTurnRuntime;
}

async function pinnedMessage(
  files: Record<string, string>,
  layers: { memory?: RuntimeMemoryHandle[]; promptLayers?: RuntimePromptLayer[] },
): Promise<string> {
  const agent = new TestAgent(createMockBackendConfig());
  agent.setCapabilityTurnRuntime(runtimeWith(files, layers));
  await collectEvents(agent.chat('go'));
  return agent.chatCalls[0]!.message;
}

/** The `<capability-layer …>` body for one key, exactly as the model receives it. */
function layerBody(message: string, key: string): string {
  const match = message.match(
    new RegExp(`<capability-layer key="${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}">\\n([\\s\\S]*?)\\n</capability-layer>`),
  );
  if (!match) throw new Error(`no capability layer for ${key}`);
  return match[1]!;
}

const INDEX_PATH = '/p/MEMORY.md';

test('the line cap wins when it comes first: 400 short lines load as 200', async () => {
  const body = layerBody(
    await pinnedMessage(
      { [INDEX_PATH]: Array.from({ length: 400 }, (_, index) => `- entry ${index + 1}`).join('\n') },
      { memory: [indexLayer(INDEX_PATH)] },
    ),
    indexLayer(INDEX_PATH).key,
  );

  const lines = body.split('\n');
  expect(lines).toHaveLength(MEMORY_LOAD_LINE_LIMIT);
  expect(lines.at(-1)).toBe('- entry 200');
  expect(body).not.toContain('- entry 201');
  // The other half of "whichever comes first" is under budget here.
  expect(Buffer.byteLength(body, 'utf-8')).toBeLessThanOrEqual(MEMORY_LOAD_BYTE_LIMIT);
});

test('the byte cap wins when it comes first: 150 long lines stop under 25 KB on a whole line', async () => {
  // Under the line cap (150 < 200) and far over the byte cap (~45 KB), so only
  // the byte half can cut it. This is the case no cap in the repo could ever hit.
  const long = Array.from({ length: 150 }, (_, index) => `- entry ${index + 1} ${'x'.repeat(300)}`);
  const body = layerBody(
    await pinnedMessage({ [INDEX_PATH]: long.join('\n') }, { memory: [indexLayer(INDEX_PATH)] }),
    indexLayer(INDEX_PATH).key,
  );

  expect(Buffer.byteLength(long.join('\n'), 'utf-8')).toBeGreaterThan(MEMORY_LOAD_BYTE_LIMIT);
  expect(Buffer.byteLength(body, 'utf-8')).toBeLessThanOrEqual(MEMORY_LOAD_BYTE_LIMIT);
  const lines = body.split('\n');
  expect(lines.length).toBeLessThan(150);
  // Cut on a line boundary: the last surviving entry is whole, and the next one
  // is absent rather than severed.
  expect(lines.at(-1)).toBe(long[lines.length - 1]);
  expect(body).not.toContain(`- entry ${lines.length + 1} `);
});

test('non-ASCII prose is cut on a character boundary, never mid-sequence', async () => {
  // Two-byte Cyrillic entries, sized so the byte cap lands inside the file. Each
  // line is a whole number of characters, so a naive byte slice would land in the
  // middle of one.
  const line = `- ${'я'.repeat(400)}`;
  const lines = Array.from({ length: 60 }, () => line);
  const body = layerBody(
    await pinnedMessage({ [INDEX_PATH]: lines.join('\n') }, { memory: [indexLayer(INDEX_PATH)] }),
    indexLayer(INDEX_PATH).key,
  );

  expect(Buffer.byteLength(lines.join('\n'), 'utf-8')).toBeGreaterThan(MEMORY_LOAD_BYTE_LIMIT);
  expect(Buffer.byteLength(body, 'utf-8')).toBeLessThanOrEqual(MEMORY_LOAD_BYTE_LIMIT);
  // No replacement character anywhere, and every surviving line is intact.
  expect(body).not.toContain('�');
  for (const kept of body.split('\n')) expect(kept).toBe(line);
  // Round-trip through UTF-8 is lossless, which a split sequence would break.
  expect(Buffer.from(body, 'utf-8').toString('utf-8')).toBe(body);
});

test('the Pi context-resource projection carries the same capped body, not the raw file', async () => {
  // Second live delivery of a memory body: the descriptor's content is bundled
  // into the Pi subprocess as a curated resource and is what `/context` counts
  // under `memory_files`. Capping only the host's block would ship two different
  // bodies for one file.
  const long = Array.from({ length: 150 }, (_, index) => `- entry ${index + 1} ${'x'.repeat(300)}`).join('\n');
  const rulePath = '/p/.agents/rules/style.md';
  const ruleText = Array.from({ length: 150 }, (_, index) => `rule ${index + 1} ${'y'.repeat(300)}`).join('\n');
  const files = { [INDEX_PATH]: long, [rulePath]: ruleText };
  const runtime = runtimeWith(files, { memory: [indexLayer(INDEX_PATH), ruleLayer(rulePath)] });

  const descriptors = await materializePiContextResources({
    view: runtime.view,
    materializer: runtime.materializer,
    mcpResources: [],
  });

  const index = descriptors.find(descriptor => descriptor.id.includes('index'))!;
  expect(Buffer.byteLength(index.content, 'utf-8')).toBeLessThanOrEqual(MEMORY_LOAD_BYTE_LIMIT);
  // Byte-identical to the host's pinned block for the same file (the fixture
  // carries no `@import` line, the one transform the block applies and this
  // projection does not), so the descriptor's `sha256` describes what the model
  // actually sees.
  expect(index.content).toBe(layerBody(
    await pinnedMessage({ [INDEX_PATH]: long }, { memory: [indexLayer(INDEX_PATH)] }),
    indexLayer(INDEX_PATH).key,
  ));
  // A rule layer keeps its uncapped body on this route too.
  const rule = descriptors.find(descriptor => descriptor.id.includes('rules'))!;
  expect(rule.content).toBe(ruleText);
});

/**
 * R56 — the frontmatter strip, and the reason it had to land WITH the
 * `modified` write stamp rather than after it.
 *
 * `memory.md:388` / `errors.md:1549`: "YAML frontmatter and block-level HTML
 * comments are stripped before the index is loaded, so they don't count toward
 * the limits." `memory.md:398` makes `modified:` change on every single write,
 * so without this strip that line would be a CHANGING line inside the pinned
 * `<memory>` block — invalidating the cached prefix and everything after it on
 * every memory write. This test is the evidence that it does not reach the
 * block at all.
 */
test('an index\'s frontmatter — and its per-write `modified` stamp — never reaches the pinned block', async () => {
  const raw = [
    '---',
    'title: Notes',
    'modified: 2026-08-07T12:34:56.789Z',
    '---',
    '',
    '# Memory',
    '- a fact',
  ].join('\n');

  const body = layerBody(
    await pinnedMessage({ [INDEX_PATH]: raw }, { memory: [indexLayer(INDEX_PATH)] }),
    indexLayer(INDEX_PATH).key,
  );

  expect(body).toBe('# Memory\n- a fact');
  expect(body).not.toContain('modified:');
  expect(body).not.toContain('title: Notes');
  expect(body).not.toContain('---');
});

test('the frontmatter strip is the INDEX\'s: a `paths:` rule keeps its block and stays out of the pinned context', async () => {
  // The positive control for the `isMemoryIndexLayer` gate. A rule declares its
  // globs in frontmatter; strip that and `parseRuleFile` reads it as an UNSCOPED
  // rule, which loads unconditionally at launch — a silent widening of what a
  // path-scoped rule applies to.
  const rulePath = '/p/.agents/rules/scoped.md';
  const scoped = '---\npaths:\n  - "src/**"\n---\nOnly for src files.\n';
  const unscopedPath = '/p/.agents/rules/always.md';
  const unscoped = '---\ntitle: House style\n---\nAlways applies.\n';

  const message = await pinnedMessage(
    { [rulePath]: scoped, [unscopedPath]: unscoped },
    { memory: [ruleLayer(rulePath), ruleLayer(unscopedPath)] },
  );

  // The scoped rule is recognised as scoped, so it has no pinned body at all.
  expect(() => layerBody(message, ruleLayer(rulePath).key)).toThrow();
  expect(message).not.toContain('Only for src files.');
  // The unscoped one still ships, with `parseRuleFile` — not the index strip —
  // deciding where its body starts.
  expect(layerBody(message, ruleLayer(unscopedPath).key)).toBe('Always applies.');
});

test('the cap is the INDEX\'s: an unscoped rule and a CLAUDE.md layer of the same size load in full', async () => {
  // `memory.md:390` — the limit applies only to MEMORY.md.
  const oversized = Array.from({ length: 400 }, (_, index) => `line ${index + 1}`).join('\n');
  const rule = ruleLayer('/p/.agents/rules/style.md');
  const instruction = promptLayer('/p/CLAUDE.md');

  const message = await pinnedMessage(
    { '/p/.agents/rules/style.md': oversized, '/p/CLAUDE.md': oversized },
    { memory: [rule], promptLayers: [instruction] },
  );

  for (const key of [rule.key, instruction.key]) {
    const body = layerBody(message, key);
    expect(body.split('\n')).toHaveLength(400);
    expect(body).toContain('line 400');
  }
});
