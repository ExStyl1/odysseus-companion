/**
 * P10 — the legacy Nessy-extension agent import tokenizes a tool grant like
 * every other reader.
 *
 * `format-adapters.ts:normalizeLegacyAgents` held the FIFTH and last copy of the
 * bare comma split after P6b replaced three and P9 replaced the fourth. It hid
 * from the earlier sweeps because it was written as `?.split(',')` wrapped onto
 * its own line, so neither `split(','` on one line nor a grep for the
 * `frontmatter.tools ?` guard reached it.
 *
 * The path is LIVE, not dead: `createLegacyNessyExtensionAdapter()` sits in
 * `createDefaultPluginFormatAdapters()` (`format-adapters.ts:276`), which
 * `PluginAcquisitionService` uses by default (`acquisition.ts:154`), so any
 * installed bundle carrying `nessy-extension.json` plus an `agents/` directory
 * reaches this reader.
 *
 * There is no rival semantics for a comma here — the legacy format is
 * Nessy-owned — and one thing decides the split: `buildPiRuntimeAgentDescriptor`
 * re-reads the same file as `agent.tools ?? frontmatter.tools`, so the
 * CAPABILITY's list wins and whatever this adapter produces is what the runtime
 * grants. A shredded `Agent(scan-inventory` / `scan-researcher)` pair resolves to
 * no tool and is then denied by omission — the 1.25.0 defect P6b measured on the
 * Claude path, reachable from a legacy bundle by the same route.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizePluginBundle } from '../format-adapters.ts';
import type { PluginOrigin } from '../types.ts';

const ORIGIN: PluginOrigin = { source: 'local-path', resolvedAt: 0 };

const created: string[] = [];
afterEach(() => {
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
});

async function agentCapability(agentFile: string) {
  const root = mkdtempSync(join(tmpdir(), 'legacy-agent-frontmatter-'));
  created.push(root);
  writeFileSync(
    join(root, 'nessy-extension.json'),
    JSON.stringify({ name: 'agent-frontmatter', version: '1.0.0' }),
  );
  mkdirSync(join(root, 'agents'), { recursive: true });
  writeFileSync(join(root, 'agents', 'reviewer.md'), agentFile);
  const result = await normalizePluginBundle(root, ORIGIN);
  expect(result.ok).toBe(true);
  return result.value?.capabilities.find(capability => capability.kind === 'agent');
}

describe('legacy Nessy extension agent frontmatter', () => {
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
      'model: inherit',
      'tools: Read Grep',
      '---',
      '',
      'You review diffs.',
    ].join('\n'));

    expect(capability?.agent?.tools).toEqual(['Read', 'Grep']);
    expect(capability?.description).toBe('Reviews a diff.');
    expect(capability?.agent?.model).toBe('inherit');
  });
});
