/**
 * P6.894 — `validateAll` runs the workspace-scoped validators on the one
 * argument every caller has always passed.
 *
 * The defect it pins: the signature used to be
 * `validateAll(workspaceId?, workspaceRoot?)`, gating `validateAllSources` on
 * the first argument and skills/statuses/labels/automations/permissions on the
 * second — while the two were the same value. `validateAllSources`'s parameter
 * was misnamed `workspaceId` and is resolved through
 * `getWorkspaceSourcesPath(rootPath)`, i.e. a workspace ROOT PATH; the port both
 * session contexts implement (`ValidatorInterface.validateAll(workspaceRootPath)`
 * in `session-tools-core/src/context.ts`) has always declared exactly one path
 * argument. So `config_validate --target all` silently skipped five validators
 * on claude AND on codex, and nothing could see it: the answer was a shorter
 * list of issues, which reads exactly like a healthy workspace.
 *
 * Two planted defects rather than one, deliberately: a single skill error would
 * leave four of the five unproven, and "the five never ran" is the row.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateAll } from '../validators.ts';

/**
 * A workspace root carrying one broken skill and one broken statuses config.
 *
 * - `skills/broken/` with no `SKILL.md` → `validateSkill` reports
 *   'SKILL.md not found' against `skills/broken/SKILL.md`.
 * - `statuses/config.json` that is not JSON → `validateStatusesContent` reports
 *   a parse failure against `statuses/config.json`.
 */
function plantWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'p6894-ws-'));
  mkdirSync(join(root, 'skills', 'broken'), { recursive: true });
  mkdirSync(join(root, 'statuses'), { recursive: true });
  writeFileSync(join(root, 'statuses', 'config.json'), 'this is not json', 'utf-8');
  return root;
}

describe('validateAll covers the workspace-scoped validators (P6.894)', () => {
  test('POSITIVE — a planted invalid skill and statuses config are both reported', () => {
    const root = plantWorkspace();
    try {
      const result = validateAll(root);

      // `skills` — the group the one-argument call used to skip entirely.
      const skillIssue = result.errors.find((e) => e.file === 'skills/broken/SKILL.md');
      expect(skillIssue, `errors were: ${JSON.stringify(result.errors)}`).toBeDefined();
      expect(skillIssue?.message).toContain('SKILL.md not found');

      // `statuses` — a second member of the same skipped group, so the positive
      // above cannot pass on one hand-wired validator having been re-added.
      const statusIssue = result.errors.find((e) => e.file === 'statuses/config.json');
      expect(statusIssue, `errors were: ${JSON.stringify(result.errors)}`).toBeDefined();

      // And the sources check, which the OLD first argument already ran, still
      // does — this collapse must not have traded one group for another.
      const sourcesNote = result.warnings.some((w) => w.file === 'sources/');
      expect(sourcesNote).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('NEGATIVE — with no workspace root, neither is reported', () => {
    const root = plantWorkspace();
    try {
      // The gate on the optional parameter is still a gate: the fix runs the
      // workspace-scoped validators on the argument, it does not run them
      // unconditionally against some ambient path. A caller that names no
      // workspace gets the three app-level files and nothing else.
      const result = validateAll();

      const files = [...result.errors, ...result.warnings].map((i) => i.file);
      expect(files).not.toContain('skills/broken/SKILL.md');
      expect(files).not.toContain('statuses/config.json');
      expect(files).not.toContain('sources/');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
