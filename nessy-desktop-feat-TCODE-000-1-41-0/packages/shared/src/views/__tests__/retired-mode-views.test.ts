/**
 * F1.1172 — a workspace's views.json is seeded ONCE and then read as stored, so the seeded
 * Explore view (`permissionMode == "safe"`) kept matching nothing after F1.1050 retired
 * explore: a session's mode is normalized on load (`sessions/jsonl.ts`), so no session holds
 * safe or explore. The seed is now a Plan-mode view, and a stored comparison with either
 * retired spelling is rewritten to `plan` on load and saved back.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDefaultViews } from '../defaults.ts';
import { buildViewContext, compileAllViews, evaluateViews } from '../evaluator.ts';
import { listViews } from '../storage.ts';
import type { ViewConfig } from '../types.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function workspaceWith(views: ViewConfig[]): { root: string; file: string; raw: string } {
  const root = mkdtempSync(join(tmpdir(), 'nessy-views-f1-1172-'));
  roots.push(root);
  const file = join(root, 'views.json');
  // Unindented on purpose: any save rewrites it with 2-space indentation, so the bytes tell.
  const raw = JSON.stringify({ version: 1, views });
  writeFileSync(file, raw, 'utf-8');
  return { root, file, raw };
}

const matchingIds = (views: ViewConfig[], permissionMode: string): string[] =>
  evaluateViews(buildViewContext({ permissionMode, hasUnread: true }), compileAllViews(views)).map(view => view.id);

describe('F1.1172 — the retired explore mode in views', () => {
  it('rewrites a stored explore or safe comparison to plan, gives the seeded view the Plan-mode seed texts, and saves the file', () => {
    const seededPlanMode = getDefaultViews().find(view => view.id === 'view-explore');
    expect(seededPlanMode).toEqual({
      id: 'view-explore',
      name: 'Plan mode',
      description: 'Sessions in Plan (read-only) mode',
      color: 'foreground/50',
      expression: 'permissionMode == "plan"',
    });

    const { root, file } = workspaceWith([
      // The pre-F1.1172 seed, exactly as a workspace stored it.
      { id: 'view-explore', name: 'Explore', description: 'Sessions in Explore (read-only) mode', color: 'foreground/50', expression: 'permissionMode == "safe"' },
      { id: 'user-busy', name: 'Busy writers', expression: 'permissionMode != "explore" and hasUnread == true' },
    ]);

    const views = listViews(root);
    expect(views[0]).toEqual(seededPlanMode!);
    // A user's own view keeps its name; only the retired literal moves.
    expect(views[1]).toEqual({ id: 'user-busy', name: 'Busy writers', expression: 'permissionMode != "plan" and hasUnread == true' });
    expect(matchingIds(views, 'plan')).toEqual(['view-explore']);
    expect(matchingIds(views, 'default')).toEqual(['user-busy']);

    const saved = JSON.parse(readFileSync(file, 'utf-8')) as { version: number; views: ViewConfig[] };
    expect(saved).toEqual({ version: 1, views });
  });

  it('leaves a views.json with no retired mode comparison untouched, and keeps a renamed seed view\'s name', () => {
    const untouched = workspaceWith([
      { id: 'view-explore', name: 'Plan mode', description: 'Sessions in Plan (read-only) mode', expression: 'permissionMode == "plan"' },
      // "safe" and "explore" as values of OTHER fields are not a mode.
      { id: 'user-named', name: 'Named', expression: 'name == "safe" or preview == "explore"' },
    ]);
    expect(listViews(untouched.root).map(view => view.expression)).toEqual([
      'permissionMode == "plan"',
      'name == "safe" or preview == "explore"',
    ]);
    expect(readFileSync(untouched.file, 'utf-8')).toBe(untouched.raw);

    const renamed = workspaceWith([
      { id: 'view-explore', name: 'Read-only', description: 'Mine', expression: 'permissionMode == "explore"' },
    ]);
    expect(listViews(renamed.root)).toEqual([
      { id: 'view-explore', name: 'Read-only', description: 'Mine', expression: 'permissionMode == "plan"' },
    ]);
  });
});
