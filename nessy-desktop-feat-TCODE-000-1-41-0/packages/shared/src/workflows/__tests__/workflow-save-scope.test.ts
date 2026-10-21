/**
 * P6.318 — the personal half of `saveWorkflowRecipe`.
 *
 * LOADING has been two-scope since this module was written: `loadWorkflowRecipes`
 * reads `CONFIG_DIR/workflows` and then every project ancestor. SAVING was
 * project-only, so a recipe a person wanted to carry between repositories was
 * already dispatchable and simply unwritable — and `saveWorkflowRecipe` itself
 * had zero production callers, so a workflow could be run and never kept.
 *
 * These arms cover the new branch only; the project walk keeps its own tests in
 * `orchestrator/workflow-loader.test.ts` and is untouched.
 */
import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadWorkflowRecipes, saveWorkflowRecipe } from '../workflow-loader.ts';

const SOURCE = `
  export const meta = { name: 'carried', description: 'Carried between repositories' };
  return 'carried';
`;

function temp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe('saveWorkflowRecipe personal scope', () => {
  it('writes into the config directory the loader already reads, and the recipe comes back', () => {
    const configDir = temp('workflow-personal-');
    const cwd = temp('workflow-personal-cwd-');

    const path = saveWorkflowRecipe(SOURCE, { cwd, configDir, scope: 'personal' });
    expect(path).toBe(join(configDir, 'workflows', 'carried.js'));
    expect(readFileSync(path, 'utf8')).toBe(SOURCE);

    // The half that makes the save worth anything: the same loader that always
    // read this directory now finds the recipe, so `/carried` dispatches later.
    const loaded = loadWorkflowRecipes({ cwd, configDir, includeProject: false });
    expect(loaded.loaded.map(recipe => recipe.meta.name)).toEqual(['carried']);
  });

  it('refuses a symlinked personal workflows directory', () => {
    const configDir = temp('workflow-personal-linkdir-');
    const elsewhere = temp('workflow-personal-elsewhere-');
    symlinkSync(elsewhere, join(configDir, 'workflows'));

    expect(() => saveWorkflowRecipe(SOURCE, { cwd: configDir, configDir, scope: 'personal' }))
      .toThrow(/Refused symlinked personal workflows directory/);
  });

  it('refuses a symlinked personal workflow file', () => {
    const configDir = temp('workflow-personal-linkfile-');
    const elsewhere = temp('workflow-personal-target-');
    const victim = join(elsewhere, 'victim.js');
    writeFileSync(victim, 'untouched');
    mkdirSync(join(configDir, 'workflows'), { recursive: true });
    symlinkSync(victim, join(configDir, 'workflows', 'carried.js'));

    expect(() => saveWorkflowRecipe(SOURCE, { cwd: configDir, configDir, scope: 'personal' }))
      .toThrow(/Refused symlinked personal workflow file/);
    expect(readFileSync(victim, 'utf8')).toBe('untouched');
  });

  it('an absent scope is the project branch, byte-for-byte today', () => {
    const repoRoot = temp('workflow-default-scope-');
    const path = saveWorkflowRecipe(SOURCE, { cwd: repoRoot, repoRoot });
    expect(path).toBe(join(repoRoot, '.nessy-agent', 'workflows', 'carried.js'));
  });
});
