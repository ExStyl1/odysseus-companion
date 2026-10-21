import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { createLabel, deleteLabel, ensureLabelsExist, ensureTaskLabel, ensureTaskItemLabel, generateLabelSlug } from '../crud.ts';
import { createSession, loadSession } from '../../sessions/storage.ts';
import { getWorkspaceSessionRootPath } from '../../workspaces/paths.ts';
import { loadLabelConfig, saveLabelConfig, isValidLabelIdFormat } from '../storage.ts';
import { flattenLabels } from '../tree.ts';

let workspaceRoot: string;

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'labels-crud-test-'));
  // Seed with a minimal config (no defaults — we control the tree)
  saveLabelConfig(workspaceRoot, { version: 1, labels: [] });
});

afterEach(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
});

describe('ensureLabelsExist', () => {
  it('passes through labels that already exist', () => {
    createLabel(workspaceRoot, { name: 'Bug', color: 'foreground/50' });

    const result = ensureLabelsExist(workspaceRoot, ['bug']);
    expect(result).toEqual(['bug']);

    // No new labels created
    const all = flattenLabels(loadLabelConfig(workspaceRoot).labels);
    expect(all).toHaveLength(1);
  });

  it('auto-creates missing labels with titlecased name', () => {
    const result = ensureLabelsExist(workspaceRoot, ['morning-briefing']);
    expect(result).toEqual(['morning-briefing']);

    const config = loadLabelConfig(workspaceRoot);
    const created = flattenLabels(config.labels).find(l => l.id === 'morning-briefing');
    expect(created).toBeDefined();
    expect(created!.name).toBe('Morning Briefing');
    expect(created!.color).toBe('foreground/50');
  });

  it('preserves value on valued labels that need creation', () => {
    const result = ensureLabelsExist(workspaceRoot, ['priority::3']);
    expect(result).toEqual(['priority::3']);

    const config = loadLabelConfig(workspaceRoot);
    const created = flattenLabels(config.labels).find(l => l.id === 'priority');
    expect(created).toBeDefined();
    expect(created!.name).toBe('Priority');
  });

  it('passes through valued labels when the label already exists', () => {
    createLabel(workspaceRoot, { name: 'Priority', color: 'foreground/50' });

    const result = ensureLabelsExist(workspaceRoot, ['priority::high']);
    expect(result).toEqual(['priority::high']);

    // No new labels created
    const all = flattenLabels(loadLabelConfig(workspaceRoot).labels);
    expect(all).toHaveLength(1);
  });

  it('passes through entries with invalid ID format unchanged', () => {
    const result = ensureLabelsExist(workspaceRoot, ['INVALID_FORMAT', '--bad']);
    expect(result).toEqual(['INVALID_FORMAT', '--bad']);

    // No labels created
    const all = flattenLabels(loadLabelConfig(workspaceRoot).labels);
    expect(all).toHaveLength(0);
  });

  it('handles mixed labels (existing, new, invalid)', () => {
    createLabel(workspaceRoot, { name: 'Bug', color: 'foreground/50' });

    const result = ensureLabelsExist(workspaceRoot, ['bug', 'new-label', 'INVALID']);
    expect(result).toEqual(['bug', 'new-label', 'INVALID']);

    const all = flattenLabels(loadLabelConfig(workspaceRoot).labels);
    expect(all).toHaveLength(2); // bug + new-label
    expect(all.find(l => l.id === 'new-label')!.name).toBe('New Label');
  });

  it('uses created ID when slug differs from input', () => {
    // Pre-create 'test' so createLabel generates 'test-2' for a new "Test" label
    createLabel(workspaceRoot, { name: 'Test', color: 'foreground/50' });

    // 'test' already exists, so ensureLabelsExist passes it through
    const result1 = ensureLabelsExist(workspaceRoot, ['test']);
    expect(result1).toEqual(['test']);

    // Now create a scenario where the slug would collide:
    // Input 'test' exists, but if we force a new label with name "Test",
    // createLabel would give it 'test-2'. We test this indirectly by creating
    // a label whose slug matches an existing one.
    const manualLabel = createLabel(workspaceRoot, { name: 'Test', color: 'foreground/50' });
    expect(manualLabel.id).toBe('test-2');
  });

  it('returns empty array for empty input', () => {
    const result = ensureLabelsExist(workspaceRoot, []);
    expect(result).toEqual([]);
  });
});

describe('ensureTaskLabel / ensureTaskItemLabel', () => {
  it('creates a plain Task root once and converges a legacy numbered root', () => {
    const first = ensureTaskLabel(workspaceRoot);
    expect(first).toBe('task');
    const root = loadLabelConfig(workspaceRoot).labels.find(l => l.id === 'task')!;
    expect(root.valueType).toBeUndefined();

    // Legacy shape: the earlier scheme created the root with valueType 'number'.
    root.valueType = 'number';
    saveLabelConfig(workspaceRoot, { version: 1, labels: [root] });
    expect(ensureTaskLabel(workspaceRoot)).toBe('task');
    const converged = loadLabelConfig(workspaceRoot).labels.find(l => l.id === 'task')!;
    expect(converged.valueType).toBeUndefined();
  });

  it('mints TASK-<slug>-<N> children under the root with a never-recycled counter', () => {
    const a = ensureTaskItemLabel(workspaceRoot, 'Fix Login Crash On Startup Today');
    // Short name: slug capped to the first few words, counter appended last.
    expect(a.name).toBe('TASK-fix-login-crash-on-1');
    const b = ensureTaskItemLabel(workspaceRoot, 'Fix Login Crash On Startup Today');
    expect(b.name).toBe('TASK-fix-login-crash-on-2');
    expect(b.itemId).not.toBe(a.itemId);

    // Both live under the Task root.
    const root = loadLabelConfig(workspaceRoot).labels.find(l => l.id === a.rootId)!;
    expect(root.children?.map(c => c.id)).toEqual([a.itemId, b.itemId]);

    // Deleting the newest child never recycles its number (max + 1, not count + 1).
    root.children = root.children!.filter(c => c.id !== b.itemId);
    saveLabelConfig(workspaceRoot, { version: 1, labels: [root] });
    const c = ensureTaskItemLabel(workspaceRoot, 'Another');
    expect(c.name).toBe('TASK-another-2');
  });

  it('falls back to a stable slug for unusable titles', () => {
    const item = ensureTaskItemLabel(workspaceRoot, '   ');
    expect(item.name).toBe('TASK-task-1');
  });

  it("adopts a user's own root Task label without disturbing its shape or children", () => {
    // A user-authored organizational label that happens to be named "Task":
    // string-valued, with an existing child whose name ends in a number.
    saveLabelConfig(workspaceRoot, {
      version: 1,
      labels: [
        {
          id: 'task',
          name: 'Task',
          valueType: 'string',
          children: [{ id: 'sprint-2026', name: 'Sprint-2026' }],
        },
      ],
    });

    const item = ensureTaskItemLabel(workspaceRoot, 'Fix login');
    const root = loadLabelConfig(workspaceRoot).labels.find(l => l.id === 'task')!;
    // Adopted, not duplicated; the user's valueType survives (only the legacy
    // 'number' shape is converged) and their child is untouched.
    expect(loadLabelConfig(workspaceRoot).labels.filter(l => l.name === 'Task')).toHaveLength(1);
    expect(root.valueType).toBe('string');
    expect(root.children?.map(c => c.id)).toEqual(['sprint-2026', item.itemId]);
    // The counter only reads our TASK-…-<N> format — "Sprint-2026" must not
    // inflate it to TASK-fix-login-2027.
    expect(item.name).toBe('TASK-fix-login-1');
  });
});

// UA12.36 — ported from craft-agents-oss v0.14.0 (Apache-2.0) packages/shared/src/labels/__tests__/crud.test.ts
// (the third sample rebranded). The NESSY arms below it pin the callers: ASCII ids that never hit the cut are
// unchanged, and a title with no Latin letters still falls back to `task` in ensureTaskItemLabel.
describe('generateLabelSlug', () => {
  it('never ends in a hyphen after the 30-char cut and folds accents', () => {
    const long = generateLabelSlug('TASK-powershell-fejlesztési-képzés-1')
    expect(long.length).toBeLessThanOrEqual(30)
    expect(long).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
    expect(long.startsWith('task-powershell-fejlesztesi')).toBe(true)
    expect(generateLabelSlug('  Café & Crème  ')).toBe('cafe-creme')
    expect(generateLabelSlug('TASK-nessy-agents-pages-feature-1')).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
  })

  it('keeps ASCII ids that never reach the cut, and a long task item label stays a valid id', () => {
    expect(generateLabelSlug('Bug')).toBe('bug')
    expect(generateLabelSlug('  In Review!  ')).toBe('in-review')
    expect(generateLabelSlug('TASK-fix-login-1')).toBe('task-fix-login-1')
    const item = ensureTaskItemLabel(workspaceRoot, 'PowerShell fejlesztési képzés')
    expect(item.name).toBe('TASK-powershell-fejlesztesi-kepzes-1')
    expect(item.itemId).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
    expect(item.itemId.length).toBeLessThanOrEqual(30)
    expect(ensureTaskItemLabel(workspaceRoot, 'Задача без латиницы').name).toBe('TASK-task-2')
  })
})

// UA12.40 — NESSY divergence (reason c, a Russian-first product): a label whose name has no Latin letters
// used to get the id "" and the next one "-2", which isValidLabelIdFormat refuses. createLabel now falls back
// to `label` (then `label-2`, …), as ensureTaskItemLabel falls back to `task`.
describe('createLabel ids for names with no Latin letters', () => {
  const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/

  it('gives two Cyrillic-only labels valid, distinct ids', () => {
    const first = createLabel(workspaceRoot, { name: 'Срочно', color: 'accent' })
    const second = createLabel(workspaceRoot, { name: 'Важно', color: 'accent' })
    expect(first.id).toMatch(SLUG)
    expect(second.id).toMatch(SLUG)
    expect([first.id, second.id]).toEqual(['label', 'label-2'])
    expect(isValidLabelIdFormat(first.id) && isValidLabelIdFormat(second.id)).toBe(true)
    expect(first.name).toBe('Срочно')
  })

  it('keeps ASCII and mixed names on their own slug, and shifts past a user label already called "label"', () => {
    expect(createLabel(workspaceRoot, { name: 'Bug', color: 'accent' }).id).toBe('bug')
    expect(createLabel(workspaceRoot, { name: 'Bug', color: 'accent' }).id).toBe('bug-2')
    expect(createLabel(workspaceRoot, { name: 'Срочно 2', color: 'accent' }).id).toBe('2')
    expect(createLabel(workspaceRoot, { name: 'Label', color: 'accent' }).id).toBe('label')
    expect(createLabel(workspaceRoot, { name: 'Срочно', color: 'accent' }).id).toBe('label-2')
  })

  it('leaves a stored config that already holds "" and "-2" loadable and its ids untouched', () => {
    saveLabelConfig(workspaceRoot, {
      version: 1,
      labels: [{ id: '', name: 'Срочно' }, { id: '-2', name: 'Важно' }],
    })
    expect(loadLabelConfig(workspaceRoot).labels.map(l => l.id)).toEqual(['', '-2'])
    expect(createLabel(workspaceRoot, { name: 'Идея', color: 'accent' }).id).toBe('label')
    expect(loadLabelConfig(workspaceRoot).labels.map(l => l.id)).toEqual(['', '-2', 'label'])
  })
})

// UA12.41 — the session strip of deleteLabel addresses sessions by the immutable WORKSPACE ID (storage v2).
// Before the fix it passed the workspace ROOT PATH to listSessions, which threw "Invalid workspace storage ID"
// after the config had already been saved, so every session kept the deleted id.
describe('deleteLabel strips the removed ids from the sessions stored under the workspace id', () => {
  const workspaceIds: string[] = []
  afterEach(() => {
    for (const id of workspaceIds.splice(0)) rmSync(getWorkspaceSessionRootPath(id), { recursive: true, force: true })
  })
  const newWorkspaceId = () => {
    const id = `ua12-41-${randomUUID()}`
    workspaceIds.push(id)
    return id
  }

  it('removes the label and its descendants from the config and from every tagged session, valued entries included', async () => {
    const workspaceId = newWorkspaceId()
    createLabel(workspaceRoot, { name: 'Bug', color: 'accent' })
    createLabel(workspaceRoot, { name: 'Crash', color: 'accent', parentId: 'bug' })
    createLabel(workspaceRoot, { name: 'Keep', color: 'accent' })
    const tagged = await createSession(workspaceId, { labels: ['bug', 'keep'] })
    const child = await createSession(workspaceId, { labels: ['crash::3'] })
    const untouched = await createSession(workspaceId, { labels: ['keep'] })

    const result = await deleteLabel(workspaceRoot, 'bug', workspaceId)

    expect(result.stripped).toBe(2)
    expect([...result.removedIds].sort()).toEqual(['bug', 'crash'])
    expect(flattenLabels(loadLabelConfig(workspaceRoot).labels).map(l => l.id)).toEqual(['keep'])
    expect(loadSession(workspaceId, tagged.id)?.labels).toEqual(['keep'])
    expect(loadSession(workspaceId, child.id)?.labels).toEqual([])
    expect(loadSession(workspaceId, untouched.id)?.labels).toEqual(['keep'])
  })

  it('refuses an unknown label without touching the config or any session', async () => {
    const workspaceId = newWorkspaceId()
    createLabel(workspaceRoot, { name: 'Bug', color: 'accent' })
    const tagged = await createSession(workspaceId, { labels: ['bug'] })

    await expect(deleteLabel(workspaceRoot, 'missing', workspaceId)).rejects.toThrow("Label 'missing' not found")

    expect(loadLabelConfig(workspaceRoot).labels.map(l => l.id)).toEqual(['bug'])
    expect(loadSession(workspaceId, tagged.id)?.labels).toEqual(['bug'])
  })
})
