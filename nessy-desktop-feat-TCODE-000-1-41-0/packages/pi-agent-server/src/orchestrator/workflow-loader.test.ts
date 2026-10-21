import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { WorkflowRecipeStore } from './workflow-recipes.ts';
import { loadWorkflowRecipes, saveWorkflowRecipe } from './workflow-loader.ts';
import { createWorkflowTool } from './workflow-tool.ts';

const tempRoots: string[] = [];

function temp(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(path);
  return path;
}

function writeWorkflow(directory: string, fileName: string, source: string): string {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, fileName);
  writeFileSync(path, source);
  return path;
}

async function runRecipe(cwd: string, name: string, recipes: WorkflowRecipeStore): Promise<unknown> {
  const sessionPath = temp('workflow-loader-session-');
  const tool = createWorkflowTool({
    getCwd: () => cwd,
    getSessionPath: () => sessionPath,
    recipes,
    makeRunId: () => 'workflow-loader-run',
    spawn: async args => ({
      agent: args.agentDef.name,
      status: 'done',
      text: args.task,
      tokensIn: 1,
      tokensOut: 1,
    }),
  });
  const output = await tool.execute(
    'call',
    { script: `return workflow('${name}');` },
    new AbortController().signal,
    undefined,
    {} as never,
  );
  expect(output.details?.result?.status).toBe('done');
  return output.details?.returnValue;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('workflow filesystem loader', () => {
  it('loads a project workflow by meta.name into the production workflow() registry', async () => {
    const repoRoot = temp('workflow-loader-root-');
    const cwd = join(repoRoot, 'src');
    mkdirSync(cwd);
    mkdirSync(join(repoRoot, '.git'));
    writeWorkflow(join(repoRoot, '.nessy-agent', 'workflows'), 'audit.js', `
      export const meta = {
        name: 'audit-routes',
        description: 'Audit routes',
        phases: [{ title: 'Inspect' }],
      };
      return 'root';
    `);

    const result = loadWorkflowRecipes({
      cwd,
      configDir: join(repoRoot, 'personal'),
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.loaded.map(recipe => recipe.meta.name)).toEqual(['audit-routes']);
    expect(result.loaded[0]?.meta.phases).toEqual([{ title: 'Inspect' }]);
    expect(await runRecipe(cwd, 'audit-routes', result.recipes)).toBe('root');
  });

  it('loads every project layer and lets the layer closest to cwd win', async () => {
    const repoRoot = temp('workflow-loader-nearest-');
    const cwd = join(repoRoot, 'packages', 'app', 'src');
    mkdirSync(cwd, { recursive: true });
    writeWorkflow(join(repoRoot, '.nessy-agent', 'workflows'), 'root.js', `
      export const meta = { name: 'inspect', description: 'Root inspect' };
      return 'root';
    `);
    writeWorkflow(join(repoRoot, 'packages', 'app', '.nessy-agent', 'workflows'), 'app.js', `
      export const meta = { name: 'inspect', description: 'App inspect' };
      return 'app';
    `);

    const result = loadWorkflowRecipes({ cwd, repoRoot, configDir: join(repoRoot, 'personal') });

    expect(await runRecipe(cwd, 'inspect', result.recipes)).toBe('app');
  });

  it('loads personal workflows but always lets a project workflow win', async () => {
    const root = temp('workflow-loader-personal-');
    const repoRoot = join(root, 'repo');
    const configDir = join(root, 'config');
    mkdirSync(repoRoot);
    writeWorkflow(join(configDir, 'workflows'), 'personal.js', `
      export const meta = { name: 'shared', description: 'Personal' };
      return 'personal';
    `);

    const personal = loadWorkflowRecipes({ cwd: repoRoot, repoRoot, configDir });
    expect(await runRecipe(repoRoot, 'shared', personal.recipes)).toBe('personal');

    writeWorkflow(join(repoRoot, '.nessy-agent', 'workflows'), 'project.js', `
      export const meta = { name: 'shared', description: 'Project' };
      return 'project';
    `);
    const project = loadWorkflowRecipes({ cwd: repoRoot, repoRoot, configDir });
    expect(await runRecipe(repoRoot, 'shared', project.recipes)).toBe('project');
  });

  it.each([
    ['variable', "export const meta = { name: WORKFLOW_NAME, description: 'bad' };"],
    ['call', "export const meta = { name: makeName(), description: 'bad' };"],
    ['spread', "export const meta = { ...base, name: 'bad', description: 'bad' };"],
    ['computed key', "export const meta = { ['name']: 'bad', description: 'bad' };"],
    ['interpolation', "export const meta = { name: `bad-${1}`, description: 'bad' };"],
  ])('rejects %s metadata with a clear pure-literal diagnostic', async (_kind, source) => {
    const repoRoot = temp('workflow-loader-meta-');
    const path = writeWorkflow(
      join(repoRoot, '.nessy-agent', 'workflows'),
      'computed.js',
      source,
    );

    const result = loadWorkflowRecipes({
      cwd: repoRoot,
      repoRoot,
      configDir: join(repoRoot, 'personal'),
    });

    expect(result.loaded).toEqual([]);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.path).toBe(path);
    expect(result.diagnostics[0]?.message).toContain('pure literal');
    expect(await result.recipes.get('bad')).toBeUndefined();
  });

  it.each([
    ['.nessy-agent', 'project .nessy-agent'],
    ['workflows', 'project workflows directory'],
    ['file', 'project workflow file'],
  ])('refuses a symlinked project %s', async (boundary, diagnostic) => {
    const root = temp('workflow-loader-project-link-');
    const repoRoot = join(root, 'repo');
    mkdirSync(repoRoot);
    const source = `
      export const meta = { name: 'blocked', description: 'Blocked' };
      return 'blocked';
    `;

    if (boundary === '.nessy-agent') {
      const agentDir = join(root, 'agent-dir');
      writeWorkflow(join(agentDir, 'workflows'), 'blocked.js', source);
      symlinkSync(agentDir, join(repoRoot, '.nessy-agent'), 'dir');
    } else if (boundary === 'workflows') {
      const workflowsDir = join(root, 'workflows-dir');
      writeWorkflow(workflowsDir, 'blocked.js', source);
      mkdirSync(join(repoRoot, '.nessy-agent'));
      symlinkSync(workflowsDir, join(repoRoot, '.nessy-agent', 'workflows'), 'dir');
    } else {
      const target = writeWorkflow(root, 'target.js', source);
      const workflowsDir = join(repoRoot, '.nessy-agent', 'workflows');
      mkdirSync(workflowsDir, { recursive: true });
      symlinkSync(target, join(workflowsDir, 'blocked.js'), 'file');
    }

    const result = loadWorkflowRecipes({
      cwd: repoRoot,
      repoRoot,
      configDir: join(root, 'personal'),
    });

    expect(result.loaded).toEqual([]);
    expect(result.diagnostics[0]?.message).toContain(diagnostic);
    expect(await result.recipes.get('blocked')).toBeUndefined();
  });

  it('accepts a symlinked personal config directory but refuses a symlinked target file', async () => {
    const root = temp('workflow-loader-personal-link-');
    const repoRoot = join(root, 'repo');
    const realConfig = join(root, 'real-config');
    const linkedConfig = join(root, 'linked-config');
    mkdirSync(repoRoot);
    writeWorkflow(join(realConfig, 'workflows'), 'allowed.js', `
      export const meta = { name: 'allowed', description: 'Allowed' };
      return 'allowed';
    `);
    symlinkSync(realConfig, linkedConfig, 'dir');

    const allowed = loadWorkflowRecipes({ cwd: repoRoot, repoRoot, configDir: linkedConfig });
    expect(allowed.diagnostics).toEqual([]);
    expect(await runRecipe(repoRoot, 'allowed', allowed.recipes)).toBe('allowed');

    const target = writeWorkflow(root, 'target.js', `
      export const meta = { name: 'blocked', description: 'Blocked' };
      return 'blocked';
    `);
    const secondConfig = join(root, 'second-config');
    mkdirSync(join(secondConfig, 'workflows'), { recursive: true });
    symlinkSync(target, join(secondConfig, 'workflows', 'blocked.js'), 'file');

    const refused = loadWorkflowRecipes({ cwd: repoRoot, repoRoot, configDir: secondConfig });
    expect(refused.loaded).toEqual([]);
    expect(refused.diagnostics[0]?.message).toContain('personal workflow file');
    expect(await refused.recipes.get('blocked')).toBeUndefined();
  });

  it('saves to the closest existing project workflows directory, else the repo root', () => {
    const source = `
      export const meta = { name: 'saved', description: 'Saved' };
      return 'saved';
    `;
    const repoRoot = temp('workflow-save-nearest-');
    const cwd = join(repoRoot, 'packages', 'app', 'src');
    const closest = join(repoRoot, 'packages', 'app', '.nessy-agent', 'workflows');
    mkdirSync(cwd, { recursive: true });
    mkdirSync(join(repoRoot, '.nessy-agent', 'workflows'), { recursive: true });
    mkdirSync(closest, { recursive: true });

    const nearestPath = saveWorkflowRecipe(source, { cwd, repoRoot });
    expect(nearestPath).toBe(join(closest, 'saved.js'));
    expect(readFileSync(nearestPath, 'utf8')).toBe(source);

    const fallbackRoot = temp('workflow-save-root-');
    const fallbackCwd = join(fallbackRoot, 'src');
    mkdirSync(fallbackCwd);
    const fallbackPath = saveWorkflowRecipe(source, {
      cwd: fallbackCwd,
      repoRoot: fallbackRoot,
    });
    expect(fallbackPath).toBe(join(fallbackRoot, '.nessy-agent', 'workflows', 'saved.js'));
    expect(readFileSync(fallbackPath, 'utf8')).toBe(source);
  });
});
