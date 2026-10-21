import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PiAgent } from '../pi-agent.ts';
import type { BackendConfig } from '../backend/types.ts';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createConfig(workingDirectory: string): BackendConfig {
  return {
    provider: 'pi',
    projectTrusted: true,
    workspace: {
      id: 'ws-test',
      name: 'Test Workspace',
      rootPath: workingDirectory,
      workspaceRootPath: workingDirectory,
      sessionRootPath: join(workingDirectory, 'sessions'),
    } as any,
    session: {
      id: 'session-test',
      workspaceRootPath: workingDirectory,
      workingDirectory,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    } as any,
    isHeadless: true,
  } as BackendConfig;
}

describe('PiAgent workflow launch gate context', () => {
  // Pass-8 live defect (b): the slash-invoked consent said "declares no phases
  // up front" for a saved workflow that declares one. The loader's recipe store
  // returns the executable source with `export const meta` stripped, so the
  // gate's pure-literal re-parse could never see the declared phases.
  it('resolves declared meta phases for a saved workflow invoked by name', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'nessy-workflow-gate-'));
    roots.push(cwd);
    mkdirSync(join(cwd, '.nessy-agent', 'workflows'), { recursive: true });
    writeFileSync(join(cwd, '.nessy-agent', 'workflows', 'pass8-demo.js'), [
      "export const meta = { name: 'pass8-demo', description: 'Pass 8 demo', phases: [{ title: 'Audit the release' }] }",
      'return { done: true };',
    ].join('\n'));

    const agent = new PiAgent(createConfig(cwd));
    try {
      const context = (agent as any).workflowLaunchGateContext('workflow', { name: 'pass8-demo' });
      expect(context?.workflowLaunch?.plan).toEqual({
        name: 'pass8-demo',
        phases: ['Audit the release'],
      });
      expect(context?.workflowLaunch?.consented).toBe(false);
    } finally {
      agent.destroy();
    }
  });
});
