/**
 * R28 Task 3 — unscoped rules load at launch, at instruction priority.
 *
 * `memory.md`: "Rules without `paths` frontmatter are loaded at launch with the
 * same priority as `.claude/CLAUDE.md`" and "Rules without a `paths` field are
 * loaded unconditionally and apply to all files."
 *
 * Today `parseRuleFile` returns `null` for a file whose first line is not
 * `---`, so an unscoped rule loads NOTHING. Asserted through the production
 * seam: the pinned capability context that `BaseAgent` composes and prepends to
 * every turn (`composePinnedCapabilityContext` → `buildPinnedCapabilityContext`
 * → the chat message).
 */

import { CapabilityMaterializationError } from '../../capabilities/materializer.ts';
import { expect, test } from 'bun:test';
import type { CapabilityTurnRuntime } from '../backend/types.ts';
import type { NativeResourceRef, RuntimeMemoryHandle } from '../../capabilities/resolver.ts';
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

function ruleLayer(absolutePath: string): RuntimeMemoryHandle {
  return {
    key: `memory::project::ws::-::rules::${absolutePath}`,
    resource: memoryResource(absolutePath),
    readOnly: false,
    format: 'rule',
  };
}

/** One capability turn whose memory layers are the given rule files. */
function runtimeWithRules(files: Record<string, string>): CapabilityTurnRuntime {
  return {
    provider: 'pi',
    view: {
      generation: 'generation-rules-1',
      sources: [], skills: [], mcpServers: [], hooks: [], automations: [], agents: [],
      promptLayers: [],
      memory: Object.keys(files).map(ruleLayer),
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

const NO_FRONTMATTER = '# Style\n\nAlways use tabs in this repository.';
const FRONTMATTER_WITHOUT_PATHS = '---\ndescription: team conventions\n---\n\nAlways run the linter before committing.';
const PATH_SCOPED = '---\npaths:\n  - "src/api/**/*.ts"\n---\n\nEvery API endpoint validates its input.';

test('a rule file with no frontmatter at all loads into the pinned context', async () => {
  const agent = new TestAgent(createMockBackendConfig());
  agent.setCapabilityTurnRuntime(runtimeWithRules({ '/p/.claude/rules/style.md': NO_FRONTMATTER }));

  await collectEvents(agent.chat('go'));

  expect(agent.chatCalls[0]!.message).toContain('Always use tabs in this repository.');
});

test('a rule file with frontmatter but no `paths` also loads', async () => {
  const agent = new TestAgent(createMockBackendConfig());
  agent.setCapabilityTurnRuntime(runtimeWithRules({
    '/p/.claude/rules/conventions.md': FRONTMATTER_WITHOUT_PATHS,
  }));

  await collectEvents(agent.chat('go'));

  const message = agent.chatCalls[0]!.message;
  expect(message).toContain('Always run the linter before committing.');
  // The frontmatter itself is never injected.
  expect(message).not.toContain('description: team conventions');
});

test('a `paths:`-bearing rule does NOT load at launch', async () => {
  const agent = new TestAgent(createMockBackendConfig());
  agent.setCapabilityTurnRuntime(runtimeWithRules({
    '/p/.claude/rules/style.md': NO_FRONTMATTER,
    '/p/.claude/rules/api.md': PATH_SCOPED,
  }));

  await collectEvents(agent.chat('go'));

  const message = agent.chatCalls[0]!.message;
  expect(message).toContain('Always use tabs in this repository.');
  expect(message).not.toContain('Every API endpoint validates its input.');
});

test('unscoped rules survive a compaction-shaped re-composition; `paths:` rules stay absent', async () => {
  const agent = new TestAgent(createMockBackendConfig());
  agent.setCapabilityTurnRuntime(runtimeWithRules({
    '/p/.claude/rules/style.md': NO_FRONTMATTER,
    '/p/.claude/rules/conventions.md': FRONTMATTER_WITHOUT_PATHS,
    '/p/.claude/rules/api.md': PATH_SCOPED,
  }));

  await collectEvents(agent.chat('first'));
  // Compaction drops the conversation but never the pinned capability block:
  // it is re-composed from disk and re-prepended on the next turn. That is the
  // documented asymmetry — unscoped rules are re-injected, `paths:` rules are
  // "Lost until a matching file is read again".
  await collectEvents(agent.chat('after compaction'));

  const second = agent.chatCalls[1]!.message;
  expect(second).toContain('Always use tabs in this repository.');
  expect(second).toContain('Always run the linter before committing.');
  expect(second).not.toContain('Every API endpoint validates its input.');
});
