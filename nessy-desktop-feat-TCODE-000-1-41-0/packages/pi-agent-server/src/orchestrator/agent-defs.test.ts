import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'bun:test';

import { loadAgentDefinitions, resolveAgentDefinition } from '../../../shared/src/agents/index.ts';

describe('agent definitions', () => {
  it('loads the built-in agents', () => {
    const defs = loadAgentDefinitions();

    expect(defs.map(def => def.name).sort()).toEqual(['planner', 'reviewer', 'scout', 'worker']);
    expect(resolveAgentDefinition('scout').toolset).toBe('read-only');
    expect(resolveAgentDefinition('worker').toolset).toBe('full');
  });

  it('throws a clear error for unknown agents', () => {
    expect(() => resolveAgentDefinition('architect')).toThrow(
      'Unknown agent "architect". Available agents: scout, planner, worker, reviewer',
    );
  });

  it('merges workspace orchestratorAgents when config is reachable', () => {
    const workspaceRootPath = mkdtempSync(join(tmpdir(), 'agent-defs-'));
    writeFileSync(join(workspaceRootPath, 'config.json'), JSON.stringify({
      orchestratorAgents: [{
        name: 'auditor',
        description: 'Audit a narrow concern.',
        systemPrompt: 'Audit only the requested concern.',
        toolset: 'read-only',
        tier: 'small',
        model: 'agent-specific-model',
        disallowedTools: ['grep', 'mcp__github__*'],
      }],
    }));

    const auditor = resolveAgentDefinition('auditor', { workspaceRootPath });
    expect(auditor.description).toBe('Audit a narrow concern.');
    expect(auditor.tools).toEqual(['read', 'grep', 'find', 'ls']);
    expect(auditor.model).toBe('agent-specific-model');
    expect(auditor.disallowedTools).toEqual(['grep', 'mcp__github__*']);
  });

  it('loads workspace agent definitions from frontmatter markdown files', () => {
    const workspaceRootPath = mkdtempSync(join(tmpdir(), 'agent-defs-md-'));
    writeFileSync(join(workspaceRootPath, 'config.json'), JSON.stringify({}));
    writeFileSync(join(workspaceRootPath, 'critic.md'), `---
description: Review a narrow change.
toolset: full
tier: big
model: critic-model
disallowedTools:
  - write
  - mcp__slack__*
tools:
  - read
  - grep
---
Review only the requested change.
`);

    const critic = resolveAgentDefinition('critic', { workspaceRootPath });
    expect(critic.description).toBe('Review a narrow change.');
    expect(critic.systemPrompt).toBe('Review only the requested change.');
    expect(critic.toolset).toBe('full');
    expect(critic.tools).toEqual(['read', 'grep']);
    expect(critic.tier).toBe('big');
    expect(critic.model).toBe('critic-model');
    expect(critic.disallowedTools).toEqual(['write', 'mcp__slack__*']);
  });
});
