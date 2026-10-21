/**
 * R55 · f099 f100 f101 — `@path` import recognition, and the two LIVE memory
 * deliveries that must agree on what one file means.
 *
 * `memory.md:95`: "CLAUDE.md files can import additional files using
 * `@path/to/import` syntax. Imported files are expanded and loaded into context
 * at launch alongside the CLAUDE.md that references them."
 * `memory.md:99`: "Import parsing skips Markdown code spans and fenced code
 * blocks. To mention a path in your CLAUDE.md without importing it, wrap it in
 * backticks: writing `` `@README` `` keeps the text literal, while `@README`
 * outside backticks imports the file."
 * `memory.md:101`: "To pull in a README, package.json, and a workflow guide,
 * reference them with `@` syntax anywhere in your CLAUDE.md:" — the example at
 * `:104` carries two imports mid-sentence on one line.
 * `memory.md:161`: "Block-level HTML comments (`<!-- maintainer notes -->`) in
 * CLAUDE.md files are stripped before the content is injected into Claude's
 * context. ... Comments inside code blocks are preserved."
 *
 * Asserted through the seams a real turn uses. `readMemoryFileWithImports` — the
 * function the specs proposed editing — is reachable only through
 * `loadMemoryPromptBlock`, which `prompts/system.ts` skips whenever a capability
 * runtime exists (every normal turn, both backends). What ships is
 * `BaseAgent.composePinnedCapabilityContext` and `materializePiContextResources`,
 * and before this unit they DISAGREED: the pinned block deleted every line an
 * import was recognised on, and Pi's curated resource kept the literal `@path`
 * as prose. Neither expanded anything.
 */

import { CapabilityMaterializationError } from '../../capabilities/materializer.ts';
import { expect, test } from 'bun:test';
import type { CapabilityTurnRuntime } from '../backend/types.ts';
import type { NativeResourceRef, RuntimeMemoryHandle, RuntimePromptLayer } from '../../capabilities/resolver.ts';
import { materializePiContextResources } from '../pi-harness/context-resource.ts';
import { TestAgent, collectEvents, createMockBackendConfig } from './test-utils.ts';

/**
 * The importer these recognition cases hang off is a CLAUDE.md, not a
 * MEMORY.md, and that is load-bearing since P6.387.
 *
 * Every rule this file pins is stated for the CLAUDE.md family — `memory.md:95`
 * ("CLAUDE.md files can import additional files using `@path/to/import` syntax.
 * Imported files are expanded and loaded into context at launch alongside the
 * CLAUDE.md that references them") and the recognition sentences at `:99`/`:101`
 * beside it. A MEMORY.md was the carrier here only by accident, and the page
 * says the OPPOSITE thing about that family: an `@path` in an auto-memory index
 * names a TOPIC file, and "Claude Code doesn't load topic files such as
 * `user_role.md` or `feedback_testing.md` at startup". Leaving the carrier as
 * `MEMORY.md` would have made this file assert eager loading for exactly the
 * files the page says are not loaded.
 */
const INDEX_PATH = '/p/CLAUDE.md';
const README_PATH = '/p/README.md';
const PACKAGE_PATH = '/p/package.json';
/** The page's `@README` names a file with no extension — that is the point. */
const BARE_README_PATH = '/p/README';

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

/** A layer the discovery walker registered because `importer` referenced it. */
function importedLayer(absolutePath: string, importer: string): RuntimeMemoryHandle {
  return {
    key: `memory::project::ws::-::import::${absolutePath}`,
    resource: memoryResource(absolutePath),
    readOnly: false,
    importParentPath: importer,
  };
}

function promptLayer(absolutePath: string): RuntimePromptLayer {
  return { key: `instruction::project::ws::${absolutePath}`, resource: memoryResource(absolutePath), order: 0 };
}

/** An instruction layer the walker registered because `importer` referenced it. */
function importedPromptLayer(absolutePath: string, importer: string): RuntimePromptLayer {
  return {
    key: `instruction::project::ws::import::${absolutePath}`,
    resource: memoryResource(absolutePath),
    order: 0,
    importParentPath: importer,
  };
}

function runtimeWith(
  files: Record<string, string>,
  layers: { memory?: RuntimeMemoryHandle[]; promptLayers?: RuntimePromptLayer[] },
): CapabilityTurnRuntime {
  return {
    provider: 'pi',
    view: {
      generation: 'generation-memory-imports-1',
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

test('an import mid-sentence resolves, and its line keeps its prose', async () => {
  // The page's own example, verbatim from `memory.md:104`. Two imports on one
  // line, neither at the start of it. Before this unit the pinned block DELETED
  // this whole line — sentence included — and imported neither file.
  const sentence = 'See @README for project overview and @package.json for available npm commands for this project.';
  const layers = [
    indexLayer(INDEX_PATH),
    importedLayer(BARE_README_PATH, INDEX_PATH),
    importedLayer(PACKAGE_PATH, INDEX_PATH),
  ];
  const message = await pinnedMessage(
    {
      [INDEX_PATH]: `# Memory\n${sentence}`,
      [BARE_README_PATH]: 'README BODY',
      [PACKAGE_PATH]: 'PACKAGE BODY',
    },
    { memory: layers },
  );

  const body = layerBody(message, layers[0]!.key);
  expect(body).toContain(sentence);
  expect(body).toContain('README BODY');
  expect(body).toContain('PACKAGE BODY');
  // Document order, and each body exactly once in the whole prompt: an inlined
  // layer must not ALSO ship as its own block.
  expect(body.indexOf('README BODY')).toBeLessThan(body.indexOf('PACKAGE BODY'));
  expect(message.match(/README BODY/g)).toHaveLength(1);
  expect(message.match(/PACKAGE BODY/g)).toHaveLength(1);
  expect(message).not.toContain(`<capability-layer key="${layers[1]!.key}">`);
});

test('an extension is not required: a bare `@README` on its own line imports', async () => {
  // The old predicate demanded a `/`, a `\`, a leading `.` or a `.md` suffix, so
  // `@README` — the page's own spelling — was silently not an import.
  const layers = [indexLayer(INDEX_PATH), importedLayer(BARE_README_PATH, INDEX_PATH)];
  const body = layerBody(
    await pinnedMessage(
      { [INDEX_PATH]: '# Memory\n@README\nkeep me', [BARE_README_PATH]: 'README BODY' },
      { memory: layers },
    ),
    layers[0]!.key,
  );

  // A whole-line token is a directive: the line is replaced by what it names.
  expect(body).toBe('# Memory\nREADME BODY\nkeep me');
});

test('a backticked `@README` is text, not an import', async () => {
  // `memory.md:99` — "writing `` `@README` `` keeps the text literal".
  const layers = [indexLayer(INDEX_PATH), importedLayer(README_PATH, INDEX_PATH)];
  const message = await pinnedMessage(
    { [INDEX_PATH]: 'To mention it without importing, write `@README.md` in backticks.', [README_PATH]: 'README BODY' },
    { memory: layers },
  );

  const body = layerBody(message, layers[0]!.key);
  expect(body).toContain('`@README.md`');
  expect(body).not.toContain('README BODY');
  // Never imported, so the layer is still delivered on its own — the record
  // exists because discovery is a separate pass, and a layer nobody inlined must
  // not silently vanish.
  expect(layerBody(message, layers[1]!.key)).toBe('README BODY');
});

test('an `@target.md` inside a fenced code block is not an import', async () => {
  // `memory.md:99` — "Import parsing skips Markdown code spans and fenced code
  // blocks." Before this unit the fenced line was FOLLOWED and the body spliced
  // in, corrupting the fence, or deleted outright on the pinned route.
  const layers = [indexLayer(INDEX_PATH), importedLayer(README_PATH, INDEX_PATH)];
  const document = ['How to write an import:', '```text', '@README.md', '```', 'done'].join('\n');
  const message = await pinnedMessage(
    { [INDEX_PATH]: document, [README_PATH]: 'README BODY' },
    { memory: layers },
  );

  expect(layerBody(message, layers[0]!.key)).toBe(document);
  expect(layerBody(message, layers[1]!.key)).toBe('README BODY');
});

test('an unresolved token is left exactly as written inside prose', async () => {
  // Expansion reads the VIEW, never the disk. A user who disabled the imported
  // capability leaves no layer behind, and the token must not reach around that
  // decision to read the file anyway.
  const body = layerBody(
    await pinnedMessage(
      { [INDEX_PATH]: 'See @README for the overview.', [BARE_README_PATH]: 'README BODY' },
      { memory: [indexLayer(INDEX_PATH)] },
    ),
    indexLayer(INDEX_PATH).key,
  );

  expect(body).toBe('See @README for the overview.');
});

test('block-level HTML comments are stripped, and comments inside a fence survive', async () => {
  // `memory.md:161`. The strip covers BOTH file families the pinned block
  // carries: the instruction layer (CLAUDE.md, the family the sentence names)
  // and the memory index.
  const instruction = promptLayer('/p/CLAUDE.md');
  // Its own MEMORY.md path: this case needs BOTH families at once, and
  // `INDEX_PATH` is now the CLAUDE.md the instruction layer already occupies.
  // It carries no `@path`, so the topic-file rule never applies to it.
  const memoryPath = '/p/MEMORY.md';
  const layers = [indexLayer(memoryPath)];
  const message = await pinnedMessage(
    {
      '/p/CLAUDE.md': ['# Project', '<!-- maintainer note: do not ship -->', 'visible instruction'].join('\n'),
      [memoryPath]: [
        '# Memory',
        '<!-- multi',
        'line note -->',
        '- entry one <!-- nessy:auto:2026-07-18 -->',
        '```md',
        '<!-- documented comment -->',
        '```',
      ].join('\n'),
    },
    { memory: layers, promptLayers: [instruction] },
  );

  expect(layerBody(message, instruction.key)).toBe('# Project\nvisible instruction');
  const body = layerBody(message, layers[0]!.key);
  expect(body).not.toContain('line note');
  expect(body).toContain('<!-- documented comment -->');
  // An INLINE comment is prose, not a block-level one — and the auto-memory
  // marker is exactly that shape, so this strip must not take over its job.
  expect(body).toContain('- entry one <!-- nessy:auto:2026-07-18 -->');
});

test('the host pinned block and Pi curated resource carry the SAME body for a file with an import', async () => {
  // R33 put the load caps on both deliveries because capping one "would ship two
  // different bodies for one file". Expansion is the same invariant, and it is
  // the one the two used to disagree on outright.
  const layers = [indexLayer(INDEX_PATH), importedLayer(README_PATH, INDEX_PATH)];
  const files = {
    [INDEX_PATH]: ['# Memory', '<!-- private note -->', 'See @README.md for the overview.', '@README.md'].join('\n'),
    [README_PATH]: 'README BODY',
  };
  const runtime = runtimeWith(files, { memory: layers });

  const descriptors = await materializePiContextResources({
    view: runtime.view,
    materializer: runtime.materializer,
    mcpResources: [],
  });

  const host = layerBody(await pinnedMessage(files, { memory: layers }), layers[0]!.key);
  const index = descriptors.filter(descriptor => descriptor.id.includes('index'));
  expect(index).toHaveLength(1);
  expect(index[0]!.content).toBe(host);
  // Both routes suppress the inlined child, so `/context`'s `memory_files`
  // count and the model's block describe the same set of bodies.
  expect(descriptors.some(descriptor => descriptor.id.includes('import'))).toBe(false);
  expect(host).toContain('README BODY');
  expect(host).not.toContain('private note');
});

// ---------------------------------------------------------------------------
// R77 · f099 part B — the file family `memory.md:95` literally names.
// ---------------------------------------------------------------------------

test('an `@README` inside a CLAUDE.md imports it (R77)', async () => {
  // After R55 this still shipped the literal `@README` as prose: instruction
  // files went through `fileRecord` and never entered the import walker, and the
  // pinned block read them verbatim. The doc sentence is about exactly this file.
  const claude = promptLayer('/p/CLAUDE.md');
  const readme = importedPromptLayer(BARE_README_PATH, '/p/CLAUDE.md');
  const message = await pinnedMessage(
    {
      '/p/CLAUDE.md': '# Project\nSee @README for project overview.',
      [BARE_README_PATH]: 'README BODY',
    },
    { promptLayers: [claude, readme] },
  );

  const body = layerBody(message, claude.key);
  expect(body).toBe('# Project\nSee @README for project overview.\nREADME BODY');
  // Exactly once in the whole prompt: the imported layer must not ALSO ship.
  expect(message.match(/README BODY/g)).toHaveLength(1);
  expect(message).not.toContain(`<capability-layer key="${readme.key}">`);
});

test('THE FLAGSHIP: a CLAUDE.md whose body is `@AGENTS.md` delivers AGENTS.md, once (R77)', async () => {
  // `memory.md:129-137` shows a CLAUDE.md whose entire body is `@AGENTS.md`, and
  // this repo's own `packages/shared/CLAUDE.md` is that file. AGENTS.md is
  // registered as its OWN root instruction record BEFORE CLAUDE.md is walked, so
  // it carries no `importParentPath` and is nobody's declared child. Resolving
  // only against declared children leaves the token unresolved and ships the
  // literal `@AGENTS.md` — a green unit that changes nothing for the page's own
  // example. The composer therefore ADOPTS the sibling already in the view.
  const agents = promptLayer('/p/AGENTS.md');
  const claude = promptLayer('/p/CLAUDE.md');
  const files = { '/p/AGENTS.md': 'AGENTS BODY', '/p/CLAUDE.md': '@AGENTS.md' };
  // Discovery order, which is what makes this the hard case.
  const message = await pinnedMessage(files, { promptLayers: [agents, claude] });

  // The CONTENT arrives, inside the importer, and the token is gone.
  expect(layerBody(message, claude.key)).toBe('AGENTS BODY');
  expect(message).not.toContain('@AGENTS.md');
  // And exactly once — the adopted sibling does not also ship on its own.
  expect(message.match(/AGENTS BODY/g)).toHaveLength(1);
  expect(message).not.toContain(`<capability-layer key="${agents.key}">`);

  // Both live deliveries agree, which is R33's invariant and R55's.
  const runtime = runtimeWith(files, { promptLayers: [agents, claude] });
  const descriptors = await materializePiContextResources({
    view: runtime.view,
    materializer: runtime.materializer,
    mcpResources: [],
  });
  expect(descriptors).toHaveLength(1);
  expect(descriptors[0]!.content).toBe('AGENTS BODY');
});

test('an adopted sibling is not shipped twice when two files import it (R77)', async () => {
  // Two importers, one target. The bytes belong in the prompt once; the second
  // token must not fall back to the literal `@AGENTS.md` either.
  const agents = promptLayer('/p/AGENTS.md');
  const claude = promptLayer('/p/CLAUDE.md');
  const local = promptLayer('/p/CLAUDE.local.md');
  const message = await pinnedMessage(
    {
      '/p/AGENTS.md': 'AGENTS BODY',
      '/p/CLAUDE.md': '@AGENTS.md',
      '/p/CLAUDE.local.md': 'local notes\n@AGENTS.md',
    },
    { promptLayers: [agents, claude, local] },
  );

  expect(message.match(/AGENTS BODY/g)).toHaveLength(1);
  expect(message).not.toContain('@AGENTS.md');
  expect(layerBody(message, local.key)).toBe('local notes');
});

test('a `format: rule` layer is never adopted by an instruction import (R77)', async () => {
  // A rule's `paths:` frontmatter decides whether it loads at all, and the
  // pinned block strips it through `unscopedRuleBody`. Splicing one into a
  // CLAUDE.md would promote a path-scoped rule to an unconditional one, so the
  // token is left as written rather than resolved.
  const claude = promptLayer('/p/CLAUDE.md');
  const rule: RuntimeMemoryHandle = {
    key: 'memory::project::ws::rule::/p/.agents/rules/api.md',
    resource: memoryResource('/p/.agents/rules/api.md'),
    readOnly: false,
    format: 'rule',
  };
  const message = await pinnedMessage(
    {
      '/p/CLAUDE.md': 'See @.agents/rules/api.md for the API rules.',
      '/p/.agents/rules/api.md': '---\npaths:\n  - "src/**"\n---\nSCOPED RULE BODY',
    },
    { promptLayers: [claude], memory: [rule] },
  );

  expect(layerBody(message, claude.key)).toBe('See @.agents/rules/api.md for the API rules.');
  expect(message).not.toContain('SCOPED RULE BODY');
});

// ---------------------------------------------------------------------------
// P6.387(2) · the OTHER family — an auto-memory index's `@path` names a TOPIC
// file, and `memory.md` says a topic file is not loaded at startup.
// ---------------------------------------------------------------------------

const MEMORY_INDEX_PATH = '/p/MEMORY.md';
const TOPIC_PATH = '/p/user_role.md';

test('a topic file an auto-memory index imports is NOT in the startup context, and its line stays readable', async () => {
  // `memory.md`, verbatim: "Claude Code doesn't load topic files such as
  // `user_role.md` or `feedback_testing.md` at startup. Claude reads them on
  // demand using its standard file tools when it needs the information."
  const layers = [indexLayer(MEMORY_INDEX_PATH), importedLayer(TOPIC_PATH, MEMORY_INDEX_PATH)];
  const files = {
    [MEMORY_INDEX_PATH]: ['# Memory', '@user_role.md'].join('\n'),
    [TOPIC_PATH]: 'TOPIC BODY',
  };

  const message = await pinnedMessage(files, { memory: layers });
  const index = layerBody(message, layers[0]!.key);
  // Withheld — and the reference SURVIVES, so the model can read it on demand.
  expect(index).not.toContain('TOPIC BODY');
  expect(index).toContain('@user_role.md');
  // Not shipped as its own block either. That second route was the one nobody
  // had noticed: an imported layer the composer did not inline used to ship on
  // its own rather than vanish.
  expect(message).not.toContain('TOPIC BODY');

  // Pi's curated resources agree: the topic file carries no body there either.
  const runtime = runtimeWith(files, { memory: layers });
  const descriptors = await materializePiContextResources({
    view: runtime.view,
    materializer: runtime.materializer,
    mcpResources: [],
  });
  expect(descriptors.some(descriptor => descriptor.content.includes('TOPIC BODY'))).toBe(false);
});

test('control — the index itself is still eager, and a CLAUDE.md import still loads', async () => {
  const memoryLayers = [indexLayer(MEMORY_INDEX_PATH)];
  const instruction = promptLayer('/p/CLAUDE.md');
  const imported = importedPromptLayer('/p/notes.md', '/p/CLAUDE.md');
  const message = await pinnedMessage(
    {
      [MEMORY_INDEX_PATH]: ['# Memory', '- an index entry'].join('\n'),
      '/p/CLAUDE.md': ['# Project', '@notes.md'].join('\n'),
      '/p/notes.md': 'NOTES BODY',
    },
    { memory: memoryLayers, promptLayers: [instruction, imported] },
  );

  expect(layerBody(message, memoryLayers[0]!.key)).toContain('an index entry');
  expect(layerBody(message, instruction.key)).toContain('NOTES BODY');
});

