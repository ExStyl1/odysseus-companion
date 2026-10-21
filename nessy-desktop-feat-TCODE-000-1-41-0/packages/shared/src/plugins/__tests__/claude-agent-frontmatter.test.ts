/**
 * C2 — a plugin agent keeps its `description`.
 *
 * `plugins-reference.md` § Agents: "Plugin agents support `name`,
 * `description`, `model`, `effort`, `maxTurns`, `tools`, `disallowedTools`,
 * `skills`, `memory`, `background`, and `isolation` frontmatter fields", and the
 * § Agent structure example annotates the field as "What this agent specializes
 * in and when Claude should invoke it".
 *
 * `description` is the only one of those eleven that the runtime does NOT re-read
 * from the agent file: `buildPiRuntimeAgentDescriptor` takes every other field as
 * `agent.X ?? frontmatter.X` and takes `description` from the capability alone
 * (`agent/pi-harness/runtime-agent-definition.ts:644`). The adapter dropped it,
 * so the listing fell back to `Imported <name> agent.`
 * (`pi-agent-server/src/orchestrator/runtime-agent-definitions.ts:155`) — a
 * string carrying no task fit, which is what the model dispatches on.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { normalizeClaudePluginBundle } from '../format-adapters/claude.ts';
import { toSafeSummary } from '../../capabilities/views.ts';
import type { ResolvedCapability } from '../../capabilities/resolver.ts';
import type { PluginOrigin } from '../types.ts';

const ORIGIN: PluginOrigin = { source: 'local-path', resolvedAt: 0 };

const created: string[] = [];
afterEach(() => {
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
});

function bundleWithAgent(agentFile: string): string {
  const root = mkdtempSync(join(tmpdir(), 'claude-agent-frontmatter-'));
  created.push(root);
  mkdirSync(join(root, '.claude-plugin'), { recursive: true });
  writeFileSync(
    join(root, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'agent-frontmatter', version: '1.0.0' }),
  );
  mkdirSync(join(root, 'agents'), { recursive: true });
  writeFileSync(join(root, 'agents', 'reviewer.md'), agentFile);
  return root;
}

async function agentCapability(agentFile: string) {
  const result = await normalizeClaudePluginBundle(bundleWithAgent(agentFile), ORIGIN);
  expect(result.ok).toBe(true);
  return result.value?.capabilities.find(capability => capability.kind === 'agent');
}

describe('Claude plugin agent frontmatter', () => {
  it('carries the description the model dispatches on', async () => {
    const capability = await agentCapability([
      '---',
      'name: reviewer',
      'description: Reviews a diff for correctness defects. Use before merging.',
      'model: sonnet',
      '---',
      '',
      'You review diffs.',
    ].join('\n'));

    expect(capability?.description).toBe('Reviews a diff for correctness defects. Use before merging.');
    // The fields already read stay read — this is an addition, not a rewrite.
    expect(capability).toMatchObject({ agent: { name: 'reviewer', model: 'sonnet' } });
  });

  /**
   * P6b-B — a comma inside a parametrized grant is not a delimiter.
   *
   * `sub-agents.md` § *Restrict which subagents can be spawned* documents the
   * parenthesized form inside a `tools` list ("any type list inside the
   * parentheses is ignored" in a subagent definition), and the official
   * `claude-security` plugin writes exactly that:
   * `Agent(scan-inventory, scan-researcher)`. A bare `.split(',')` turned the
   * one entry into `Agent(scan-inventory` and `scan-researcher)`, neither of
   * which resolves to a tool — so the Pi runtime denied both by omission and the
   * plugin never got the subagent grant it asked for. `parseSkillToolList` has
   * been paren-aware on the SKILL path since R17b; this is the same tokenizer.
   */
  it('keeps a parametrized tool grant whole instead of splitting inside its parentheses', async () => {
    const capability = await agentCapability([
      '---',
      'name: reviewer',
      'tools: Read, Agent(scan-inventory, scan-researcher), Workflow(scan), TaskOutput',
      '---',
      '',
      'You review diffs.',
    ].join('\n'));

    expect(capability?.agent?.tools).toEqual([
      'Read',
      'Agent(scan-inventory, scan-researcher)',
      'Workflow(scan)',
      'TaskOutput',
    ]);
  });

  it('keeps it whole through a YAML block list too', async () => {
    // `splitMarkdownFrontmatter` joins a sequence on `', '`, so a block list
    // reaches this reader as the same string a single-line list does — and the
    // `claude-security` agents that broke every Pi turn use the block form.
    const capability = await agentCapability([
      '---',
      'name: reviewer',
      'tools:',
      '  - Read',
      '  - Agent(scan-inventory, scan-researcher)',
      '  - Bash(git diff:*)',
      '---',
      '',
      'You review diffs.',
    ].join('\n'));

    expect(capability?.agent?.tools).toEqual([
      'Read',
      'Agent(scan-inventory, scan-researcher)',
      'Bash(git diff:*)',
    ]);
  });

  it('leaves the description unset when the agent declares none', async () => {
    // Unset, not an empty string: the runtime's `descriptor.description ||
    // "Imported <name> agent."` fallback has to stay reachable for an agent file
    // that genuinely has nothing to say. (`normalizeNessyPluginManifest` always
    // materializes the key on every capability, so the value is what matters.)
    const capability = await agentCapability([
      '---',
      'name: reviewer',
      '---',
      '',
      'You review diffs.',
    ].join('\n'));

    expect(capability).toBeDefined();
    expect(capability?.description).toBeUndefined();
  });
});


/**
 * P6.728 — a plugin subagent in a SUBFOLDER is scoped by its subfolder.
 *
 * `sub-agents.md#choose-the-subagent-scope`, verbatim: *"Plugin `agents/`
 * directories are also scanned recursively. Unlike project and user scopes, a
 * subfolder inside a plugin's `agents/` directory becomes part of the scoped
 * identifier: a file at `agents/review/security.md` in plugin `my-plugin`
 * registers as `my-plugin:review:security`."*
 *
 * The row was written as a NAMING divergence. Measured, it was worse: the
 * shared expander every component field uses reads one directory level, so the
 * nested file produced no capability at all and no diagnostic. The positive
 * control below is what makes that a finding rather than a guess — the
 * top-level agent in the same bundle was always found.
 *
 * The last arm is the boundary that keeps this cheap: an id-illegal folder
 * costs its own scope and nothing else. `plugin.capability.invalid_id` is fatal
 * to a WHOLE bundle (P6.428 measured one malformed agent costing a plugin every
 * unrelated skill, MCP server and hook it shipped), so a folder nobody can name
 * must never reach the validator.
 */
describe('P6.728 — a plugin subagent is scoped by its subfolder', () => {
  function bundleWithAgents(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), 'claude-agent-scope-'));
    created.push(root);
    mkdirSync(join(root, '.claude-plugin'), { recursive: true });
    writeFileSync(
      join(root, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'my-plugin', version: '1.0.0' }),
    );
    for (const [relativePath, content] of Object.entries(files)) {
      const absolute = join(root, relativePath);
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, content);
    }
    return root;
  }

  const AGENT_FILE = ['---', 'name: security', 'description: Reviews a diff for security defects.', '---', '', 'You review diffs.'].join('\n');

  async function agentsOf(files: Record<string, string>) {
    const result = await normalizeClaudePluginBundle(bundleWithAgents(files), ORIGIN);
    expect(result.ok).toBe(true);
    return {
      agents: (result.value?.capabilities ?? []).filter(capability => capability.kind === 'agent'),
      diagnostics: result.diagnostics ?? [],
    };
  }

  it('registers `agents/review/security.md` as `review:security`, and the typeahead reads `my-plugin:review:security`', async () => {
    const { agents } = await agentsOf({ 'agents/review/security.md': AGENT_FILE });

    expect(agents).toHaveLength(1);
    // The colon is the page's identifier; the id joins with `.` because
    // `validatePluginId`'s charset excludes `:` and an illegal id refuses the
    // whole bundle.
    expect(agents[0]).toMatchObject({
      id: 'agent.review.security',
      agent: { name: 'review:security', path: 'agents/review/security.md' },
    });

    // P6.694 consumes exactly this name: `agentMentionId` prefixes the plugin
    // id from `pluginInstanceId` and joins with `:`.
    const mention = toSafeSummary({
      key: 'inst#agent.review.security@ws-1',
      kind: 'agent',
      logicalName: agents[0]!.agent.name,
      origin: 'plugin',
      pluginInstanceId: `plugin://acme/my-plugin@1.0.0#${'a'.repeat(64)}`,
      scope: { kind: 'workspace', workspaceId: 'ws-1' },
      enabled: true,
      selectedAsUnqualifiedAlias: true,
      readOnly: false,
      trustState: 'trusted',
      credentialState: 'not-required',
      diagnostics: [],
    } as unknown as ResolvedCapability).mention;
    expect(mention?.id).toBe('my-plugin:review:security');
  });

  it('control — a top-level agent is unchanged, and it is what proves the nested one was ABSENT rather than mis-named', async () => {
    const { agents, diagnostics } = await agentsOf({
      'agents/top.md': ['---', 'name: top', '---', '', 'body'].join('\n'),
      'agents/review/security.md': AGENT_FILE,
    });

    const top = agents.find(agent => agent.agent.path === 'agents/top.md');
    expect(top).toMatchObject({ id: 'agent.top', agent: { name: 'top' } });
    // Before this row this bundle yielded ONE agent — the top-level one — with
    // no diagnostic anywhere.
    expect(agents).toHaveLength(2);
    expect(diagnostics.filter(diagnostic => diagnostic.severity === 'error')).toEqual([]);
  });

  it('boundary — a folder that cannot be part of an identifier costs its own scope, not the bundle', async () => {
    const { agents, diagnostics } = await agentsOf({ 'agents/code review/security.md': AGENT_FILE });

    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({ id: 'agent.security', agent: { name: 'security' } });
    expect(diagnostics.some(diagnostic => diagnostic.code === 'plugin.format.claude_agent_scope_unnameable')).toBe(true);
    expect(diagnostics.filter(diagnostic => diagnostic.severity === 'error')).toEqual([]);
  });
});
