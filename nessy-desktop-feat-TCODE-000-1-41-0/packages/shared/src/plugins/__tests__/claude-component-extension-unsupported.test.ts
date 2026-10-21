/**
 * C3.352 — a component whose FILES are there and whose EXTENSION is not.
 *
 * C5.28 drove it on the packaged build (R3, 2026-09-12): a Claude-format bundle
 * whose workflow was written as `.ts` installed `ok: true, state: "supported"`,
 * `deferred: []`, and the SDK's own runtime then answered
 * `Workflow "r3-secret-audit" not found. Available: deep-research`. The only
 * signal was one install-time `plugin.format.claude_path_missing` diagnostic
 * whose message said "contains no .js files or cannot be read" — true, and
 * indistinguishable from an empty directory or a typo'd path.
 *
 * Two halves are pinned here, because either alone still loses the case:
 *
 *  - the diagnostic NAMES what it found and what it wanted, so the author can
 *    act on it without reading our source;
 *  - one `compatibility.deferred` row, which is the durable channel with a live
 *    reader and the thing that flips `state` off `supported`.
 *
 * The THIRD case is the one that keeps this from being a widening: a declared
 * path that resolves to nothing at all is still an authoring error and still a
 * diagnostic, and it must NOT gain a deferred row — "this plugin ships no
 * commands" is not a partial install.
 */
import { afterAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { normalizePluginBundle } from '../format-adapters.ts';
import type { PluginOrigin } from '../types.ts';
import { MODULE_GRAPH_CASE_BUDGET_MS } from '../../testing/module-graph-budgets.ts';

// This file's resting cost is the `format-adapters.ts` import graph, not its
// cases; see the constant's own docblock for the sizing rule.
setDefaultTimeout(MODULE_GRAPH_CASE_BUDGET_MS);

const root = mkdtempSync(join(tmpdir(), 'nessy-c3352-'));
afterAll(() => { rmSync(root, { recursive: true, force: true }); });

const WORKFLOW_SOURCE = [
  "export const meta = { name: 'secret-audit', description: 'Audit secrets' }",
  "return agent({ agent: 'scout', task: args.input });",
].join('\n');

function bundleWithWorkflowFile(id: string, fileName: string | null): string {
  const bundle = join(root, id);
  mkdirSync(join(bundle, '.claude-plugin'), { recursive: true });
  writeFileSync(
    join(bundle, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: id, version: '1.0.0', workflows: ['./workflows/'] }, null, 2),
  );
  mkdirSync(join(bundle, 'workflows'), { recursive: true });
  if (fileName !== null) writeFileSync(join(bundle, 'workflows', fileName), WORKFLOW_SOURCE);
  return bundle;
}

const origin = (): PluginOrigin => ({ source: 'local-path', localPath: root, resolvedAt: 1 });

describe('C3.352 — a declared component directory holding the wrong extension', () => {
  it('names the extension it found and the one it wanted, and records a durable deferral', async () => {
    const normalized = await normalizePluginBundle(bundleWithWorkflowFile('c3352-ts', 'audit.ts'), origin());

    const pathMissing = normalized.diagnostics.filter(
      diagnostic => diagnostic.code === 'plugin.format.claude_path_missing',
    );
    expect(pathMissing).toHaveLength(1);
    expect(pathMissing[0]?.message).toContain('.ts');
    expect(pathMissing[0]?.message).toContain('.js');

    expect(normalized.compatibility?.deferred).toEqual([{
      externalKind: 'workflow',
      reasonCode: 'plugin.deferred.claude_component_extension_unsupported',
      sourcePath: 'workflows',
    }]);
    // The half a diagnostic alone could never carry: the install stops claiming
    // the bundle arrived whole.
    expect(normalized.compatibility?.state).toBe('partial');
    expect((normalized.value?.capabilities ?? []).filter(capability => capability.kind === 'workflow'))
      .toEqual([]);
  });

  it('the SAME bundle written as .js installs clean — the control for the case above', async () => {
    const normalized = await normalizePluginBundle(bundleWithWorkflowFile('c3352-js', 'audit.js'), origin());

    expect(normalized.diagnostics.some(
      diagnostic => diagnostic.code === 'plugin.format.claude_path_missing',
    )).toBe(false);
    expect(normalized.compatibility?.deferred).toEqual([]);
    expect(normalized.compatibility?.state).toBe('supported');
    expect((normalized.value?.capabilities ?? []).filter(capability => capability.kind === 'workflow'))
      .toHaveLength(1);
  });

  it('an EMPTY declared directory keeps the old sentence and gains no deferral', async () => {
    // The boundary that makes this a narrowing and not a widening: nothing was
    // dropped, so nothing is partial.
    const normalized = await normalizePluginBundle(bundleWithWorkflowFile('c3352-empty', null), origin());

    const pathMissing = normalized.diagnostics.filter(
      diagnostic => diagnostic.code === 'plugin.format.claude_path_missing',
    );
    expect(pathMissing).toHaveLength(1);
    expect(pathMissing[0]?.message).not.toContain('It holds');
    expect(normalized.compatibility?.deferred).toEqual([]);
    expect(normalized.compatibility?.state).toBe('supported');
  });
});
