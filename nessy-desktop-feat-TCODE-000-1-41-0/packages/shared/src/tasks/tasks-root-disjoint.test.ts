/**
 * UA3.2 — two `tasks/` roots, one name (spec §10 "What a task is"; waves.md UA-q "two `tasks/` roots"):
 *
 * - the workspace task root this library writes, {@link tasksRoot}`(CONFIG_DIR/workspaces/<id>)` →
 *   `CONFIG_DIR/workspaces/<id>/tasks/<slug>/task.yaml`;
 * - the Pi task-list root `CONFIG_DIR/tasks/<listId>`, whose CONTENTS `sessions/retention-sweep.ts` deletes once
 *   they age past the cutoff.
 *
 * They must be disjoint, or the sweep would delete a user's saved tasks. Positive: the paths are disjoint in both
 * directions, and a dry-run sweep over a config dir holding an aged task folder never names it. Control on the same
 * instrument: the same sweep DOES name an aged task list under `CONFIG_DIR/tasks`, and `isPathWithin` does see a
 * task folder inside its own root.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CONFIG_DIR } from '../config/paths.ts';
import { runRetentionSweep } from '../sessions/retention-sweep.ts';
import { getWorkspaceRootPath, isPathWithin } from '../workspaces/paths.ts';
import { parseTaskSpec } from './schema.ts';
import { saveTaskSpec, taskDir, taskYamlPath, tasksRoot } from './storage.ts';

describe('the workspace tasks root is disjoint from the Pi task-list root', () => {
  it('as paths, in both directions', () => {
    const workspaceTasks = tasksRoot(getWorkspaceRootPath('ws-1'));
    const piTaskLists = join(CONFIG_DIR, 'tasks');
    expect(workspaceTasks).toBe(join(CONFIG_DIR, 'workspaces', 'ws-1', 'tasks'));
    expect(isPathWithin(piTaskLists, workspaceTasks)).toBe(false);
    expect(isPathWithin(workspaceTasks, piTaskLists)).toBe(false);
    // Control: the same predicate sees a task folder inside its own root.
    expect(isPathWithin(workspaceTasks, taskDir(getWorkspaceRootPath('ws-1'), 'demo'))).toBe(true);
  });

  describe('under the retention sweep', () => {
    let configDir: string;
    beforeEach(() => {
      configDir = mkdtempSync(join(tmpdir(), 'tasks-root-disjoint-'));
    });
    afterEach(() => {
      rmSync(configDir, { recursive: true, force: true });
    });

    it('an aged saved task is never swept; an aged Pi task list is (control)', () => {
      const old = new Date('2020-01-01T00:00:00Z');
      const workspaceRoot = join(configDir, 'workspaces', 'ws-1');
      const parsed = parseTaskSpec({ id: 'demo', title: 'Demo', goal: 'g', nodes: [{ id: 'a', prompt: 'p' }] });
      if (!parsed.success) throw new Error('fixture should parse');
      saveTaskSpec(workspaceRoot, parsed.data);
      for (const path of [taskYamlPath(workspaceRoot, 'demo'), taskDir(workspaceRoot, 'demo'), tasksRoot(workspaceRoot)]) {
        utimesSync(path, old, old);
      }
      const piList = join(configDir, 'tasks', 'list-1');
      mkdirSync(piList, { recursive: true });
      writeFileSync(join(piList, 'tasks.json'), '[]');
      utimesSync(piList, old, old);

      const report = runRetentionSweep({
        configDir,
        sessionsDir: join(configDir, 'sessions'),
        cutoffMs: Date.now(),
        dryRun: true,
      });
      const removed = report.removed.map((r) => r.path);
      expect(removed).toContain(piList);
      expect(removed.filter((path) => isPathWithin(tasksRoot(workspaceRoot), path) || isPathWithin(path, tasksRoot(workspaceRoot)))).toEqual([]);
    });
  });
});
