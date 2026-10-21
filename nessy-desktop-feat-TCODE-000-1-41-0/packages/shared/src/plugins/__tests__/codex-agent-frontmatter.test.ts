/**
 * P9 — the Codex agent import tokenizes a tool grant like every other reader.
 *
 * `codex.ts` held the LAST bare `.split(',')` on a tool list after P6b replaced
 * the other three copies with `splitToolGrantList`. The Codex contract does not
 * specify agent frontmatter at all — `developers.openai.com/plugins/build/plugins.md`
 * § *Plugin structure* names `skills/`, `hooks/` and bundled MCP servers, and the
 * root `agents/` scan is recorded as a Nessy EXTENSION grounded in practice
 * (`docs/superpowers/plans/2026-07-29-codex-adapter-spec.md` § 8.3), not as a
 * documented Codex surface. So there is no rival Codex semantics to preserve
 * here, and one thing decides the split: the same `agents/*.md` file is re-read
 * at dispatch by `buildPiRuntimeAgentDescriptor`, which takes `agent.tools ??
 * frontmatter.tools` — the capability's list WINS, so whatever this adapter
 * produces is what the runtime grants. A shredded `Agent(a` / `b)` pair resolves
 * to no tool and is then denied by omission, exactly the 1.25.0 defect P6b
 * measured on the Claude path.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// `format-adapters.ts` FIRST, and it is load-bearing: entering the adapter graph
// through `format-adapters/codex.ts` before it throws `ReferenceError: Cannot
// access 'CODEX_MANIFEST_RELATIVE_PATH' before initialization` on a pre-existing
// import cycle between the two files (recorded in `codex-contract-fields.test.ts`).
import { normalizePluginBundle } from '../format-adapters.ts';
import type { PluginOrigin } from '../types.ts';

const ORIGIN: PluginOrigin = { source: 'local-path', resolvedAt: 0 };

const created: string[] = [];
afterEach(() => {
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
});

async function agentCapability(agentFile: string) {
  const root = mkdtempSync(join(tmpdir(), 'codex-agent-frontmatter-'));
  created.push(root);
  mkdirSync(join(root, '.codex-plugin'), { recursive: true });
  writeFileSync(
    join(root, '.codex-plugin', 'plugin.json'),
    JSON.stringify({ name: 'agent-frontmatter', version: '1.0.0', description: 'Fixture.' }),
  );
  mkdirSync(join(root, 'agents'), { recursive: true });
  writeFileSync(join(root, 'agents', 'reviewer.md'), agentFile);
  const result = await normalizePluginBundle(root, ORIGIN);
  expect(result.ok).toBe(true);
  return result.value?.capabilities.find(capability => capability.kind === 'agent');
}

describe('Codex plugin agent frontmatter', () => {
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
    // A sequence reaches the reader as the `', '`-joined string
    // `splitMarkdownFrontmatter` produces, so the block form has to survive the
    // same tokenizer — and the block form is what real bundles ship.
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

  it('still reads a whitespace-separated list and drops nothing else', async () => {
    // Whitespace is a delimiter on every other tool-grant path
    // (`skills.md:259`), which the bare comma split did not honour: it produced
    // the single name `Read Grep`.
    const capability = await agentCapability([
      '---',
      'name: reviewer',
      'description: Reviews a diff.',
      'model: gpt-5',
      'tools: Read Grep',
      '---',
      '',
      'You review diffs.',
    ].join('\n'));

    expect(capability?.agent?.tools).toEqual(['Read', 'Grep']);
    expect(capability?.description).toBe('Reviews a diff.');
    expect(capability?.agent?.model).toBe('gpt-5');
  });
});
