/**
 * P4: session filesystem scope authority — project primary root, approved
 * additional roots, managed exclusions, symlink canonicalization and the
 * structured outside-root signal.
 */

import { describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  AgentConfigDeniedError,
  GitMetadataDeniedError,
  ManagedRootDeniedError,
  OutsideRootError,
  buildSessionFilesystemScope,
  isOwnSessionRecordName,
  resolveScopedPath,
  type SessionFilesystemScope,
} from '../session-filesystem-scope.ts';
import { CHECKOUT_MOVE_PATCH_BASENAME } from '../../../../server-core/src/sessions/checkout-move-plan.ts';
import { LONG_RESPONSES_DIR } from '../../utils/large-response.ts';
import { PI_CARRY_DIRNAME } from '../pi-session-rebuild.ts';

function tempDir(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

function makeScope(over: Partial<SessionFilesystemScope> & Pick<SessionFilesystemScope, 'primaryRoot'>): SessionFilesystemScope {
  return {
    session: { workspaceId: 'ws-a', sessionId: 's-1' },
    cwd: over.primaryRoot,
    additionalRoots: [],
    managedExclusions: [],
    generation: 'g1',
    ...over,
  };
}

describe('session filesystem scope path authority', () => {
  it('allows reads and writes inside the project primary root and rejects outside paths', () => {
    const project = tempDir('scope-project-');
    const scope = makeScope({ primaryRoot: project });
    writeFileSync(join(project, 'file.txt'), 'x');

    expect(resolveScopedPath('file.txt', scope)).toBe(join(project, 'file.txt'));
    expect(resolveScopedPath('new/nested.txt', scope, { access: 'write' })).toBe(join(project, 'new', 'nested.txt'));

    let outside: OutsideRootError | undefined;
    try {
      resolveScopedPath('../elsewhere.txt', scope, { access: 'write' });
    } catch (error) {
      outside = error as OutsideRootError;
    }
    expect(outside).toBeInstanceOf(OutsideRootError);
    expect(outside?.requestedAccess).toBe('write');
    expect(outside?.canonicalTarget).toBe(join(project, '..', 'elsewhere.txt'));
    rmSync(project, { recursive: true, force: true });
  });

  it('honors approved additional roots: write includes read, read never implies write', () => {
    const project = tempDir('scope-project-');
    const readRoot = tempDir('scope-read-');
    const writeRoot = tempDir('scope-write-');
    const scope = makeScope({
      primaryRoot: project,
      additionalRoots: [
        { canonicalRoot: readRoot, access: 'read', receiptId: 'r1', expires: 'session' },
        { canonicalRoot: writeRoot, access: 'write', receiptId: 'r2', expires: 'session' },
      ],
    });

    expect(resolveScopedPath(join(readRoot, 'a.txt'), scope)).toBe(join(readRoot, 'a.txt'));
    expect(() => resolveScopedPath(join(readRoot, 'a.txt'), scope, { access: 'write' })).toThrow(OutsideRootError);
    expect(resolveScopedPath(join(writeRoot, 'b.txt'), scope)).toBe(join(writeRoot, 'b.txt'));
    expect(resolveScopedPath(join(writeRoot, 'b.txt'), scope, { access: 'write' })).toBe(join(writeRoot, 'b.txt'));
    for (const dir of [project, readRoot, writeRoot]) rmSync(dir, { recursive: true, force: true });
  });

  it('denies managed Nessy storage even under a broad approved parent', () => {
    const home = tempDir('scope-home-');
    const managed = join(home, '.nessy-agent');
    mkdirSync(join(managed, 'credentials'), { recursive: true });
    const project = join(home, 'project');
    mkdirSync(project);
    const scope = makeScope({
      primaryRoot: project,
      managedExclusions: [managed],
      additionalRoots: [{ canonicalRoot: home, access: 'write', receiptId: 'r3', expires: 'session' }],
    });

    expect(resolveScopedPath(join(home, 'notes.txt'), scope, { access: 'write' })).toBe(join(home, 'notes.txt'));
    expect(() => resolveScopedPath(join(managed, 'credentials', 'secret.json'), scope))
      .toThrow(ManagedRootDeniedError);
    rmSync(home, { recursive: true, force: true });
  });

  it('closes symlink escapes by canonicalizing immediately before the decision', () => {
    const project = tempDir('scope-project-');
    const outside = tempDir('scope-outside-');
    writeFileSync(join(outside, 'target.txt'), 'secret');
    symlinkSync(join(outside, 'target.txt'), join(project, 'link.txt'), 'file');
    const scope = makeScope({ primaryRoot: project });

    let error: OutsideRootError | undefined;
    try {
      resolveScopedPath('link.txt', scope);
    } catch (thrown) {
      error = thrown as OutsideRootError;
    }
    expect(error).toBeInstanceOf(OutsideRootError);
    expect(error?.canonicalTarget).toBe(join(outside, 'target.txt'));
    for (const dir of [project, outside]) rmSync(dir, { recursive: true, force: true });
  });

  it('keeps git metadata read-only under primary and approved roots while normal reads pass', () => {
    const project = tempDir('scope-project-');
    const writeRoot = tempDir('scope-write-');
    mkdirSync(join(project, '.git', 'hooks'), { recursive: true });
    writeFileSync(join(project, '.git', 'config'), '[core]');
    const scope = makeScope({
      primaryRoot: project,
      additionalRoots: [{ canonicalRoot: writeRoot, access: 'write', receiptId: 'r4', expires: 'session' }],
    });

    expect(resolveScopedPath(join('.git', 'config'), scope)).toBe(join(project, '.git', 'config'));
    expect(() => resolveScopedPath(join('.git', 'hooks', 'pre-commit'), scope, { access: 'write' }))
      .toThrow(GitMetadataDeniedError);
    expect(() => resolveScopedPath(join(writeRoot, '.git', 'config'), scope, { access: 'write' }))
      .toThrow(GitMetadataDeniedError);
    for (const dir of [project, writeRoot]) rmSync(dir, { recursive: true, force: true });
  });

  it('protects the resolved gitdir behind a .git pointer file', () => {
    const project = tempDir('scope-project-');
    mkdirSync(join(project, '.git-meta', 'hooks'), { recursive: true });
    writeFileSync(join(project, '.git'), 'gitdir: .git-meta\n');
    const scope = makeScope({ primaryRoot: project });

    expect(() => resolveScopedPath('.git', scope, { access: 'write' })).toThrow(GitMetadataDeniedError);
    expect(() => resolveScopedPath(join('.git-meta', 'hooks', 'pre-commit'), scope, { access: 'write' }))
      .toThrow(GitMetadataDeniedError);
    expect(resolveScopedPath(join('.git-meta', 'hooks', 'pre-commit'), scope)).toBe(join(project, '.git-meta', 'hooks', 'pre-commit'));
    rmSync(project, { recursive: true, force: true });
  });

  it('keeps project agent configuration read-only for file tools', () => {
    const project = tempDir('scope-project-');
    mkdirSync(join(project, '.nessy-agent'), { recursive: true });
    writeFileSync(join(project, '.nessy-agent', 'config.toml'), '');
    const scope = makeScope({ primaryRoot: project });

    expect(resolveScopedPath(join('.nessy-agent', 'config.toml'), scope)).toBe(join(project, '.nessy-agent', 'config.toml'));
    expect(() => resolveScopedPath(join('.nessy-agent', 'hooks.json'), scope, { access: 'write' }))
      .toThrow(AgentConfigDeniedError);
    expect(() => resolveScopedPath(join('.agents', 'skills', 's', 'SKILL.md'), scope, { access: 'write' }))
      .toThrow(AgentConfigDeniedError);
    expect(() => resolveScopedPath(join('.codex', 'rules', 'x.rules'), scope, { access: 'write' }))
      .toThrow(AgentConfigDeniedError);
    rmSync(project, { recursive: true, force: true });
  });

  it('allows system temp roots without approval only when the builder opts in', () => {
    const elsewhereUnderTmp = tempDir('scope-tmp-target-');
    const project = tempDir('scope-project-');
    const base = {
      workspaceId: 'ws-a',
      sessionId: 's-1',
      projectCanonicalPath: project,
      workspaceRootPath: '/managed/ws',
      managedConfigDir: '/managed',
    };

    const optIn = buildSessionFilesystemScope({ ...base, includeSystemTempRoots: true });
    expect(resolveScopedPath(join(elsewhereUnderTmp, 'scratch.txt'), optIn, { access: 'write' }))
      .toBe(join(elsewhereUnderTmp, 'scratch.txt'));

    const defaultScope = buildSessionFilesystemScope(base);
    expect(() => resolveScopedPath(join(elsewhereUnderTmp, 'scratch.txt'), defaultScope, { access: 'write' }))
      .toThrow(OutsideRootError);
    for (const dir of [project, elsewhereUnderTmp]) rmSync(dir, { recursive: true, force: true });
  });

  it('builds a project scope with the project canonical path as primary root', () => {
    const scope = buildSessionFilesystemScope({
      workspaceId: 'ws-a',
      sessionId: 's-1',
      projectKey: 'p_' + 'a'.repeat(32),
      projectCanonicalPath: '/ext/project',
      workspaceRootPath: '/managed/ws',
      managedConfigDir: '/managed',
      generation: 'g9',
    });
    expect(scope.primaryRoot).toBe('/ext/project');
    expect(scope.cwd).toBe('/ext/project');
    expect(scope.managedExclusions).toEqual(['/managed']);
    expect(Object.isFrozen(scope)).toBe(true);

    const noProject = buildSessionFilesystemScope({
      workspaceId: 'ws-a',
      sessionId: 's-2',
      workspaceRootPath: '/managed/ws',
      managedConfigDir: '/managed',
    });
    expect(noProject.primaryRoot).toBe('/managed/ws');
  });
});

describe('managed-storage allowances for the documented agent-authoring flows', () => {
  /**
   * Realistic project session: primaryRoot is a real project dir (so managed
   * paths are NOT shadowed by the primary root), managed storage and the
   * session workspace live under a temp home. Built via
   * `buildSessionFilesystemScope` so the test pins the real allowance wiring.
   */
  function buildLayout() {
    const home = tempDir('scope-managed-');
    const managed = join(home, '.nessy-agent');
    const wsA = join(managed, 'workspaces', 'ws-a');
    const wsB = join(managed, 'workspaces', 'ws-b');
    mkdirSync(join(managed, 'docs'), { recursive: true });
    mkdirSync(join(wsA, 'sources', 'my-source'), { recursive: true });
    mkdirSync(join(wsB, 'sources', 'other'), { recursive: true });
    mkdirSync(join(managed, 'credentials'), { recursive: true });
    mkdirSync(join(managed, 'plugins'), { recursive: true });
    const project = join(home, 'project');
    mkdirSync(project, { recursive: true });
    const scope = buildSessionFilesystemScope({
      workspaceId: 'ws-a',
      sessionId: 's-1',
      projectCanonicalPath: project,
      workspaceRootPath: wsA,
      managedConfigDir: managed,
    });
    return { home, managed, wsA, wsB, project, scope };
  }

  it('allows agent docs (read-only) and own-workspace source authoring, denies secrets/other workspaces/arbitrary managed paths', () => {
    const { home, managed, wsA, wsB, scope } = buildLayout();

    // ALLOWED — agent-facing docs the system prompt points at, read-only.
    expect(resolveScopedPath(join(managed, 'docs', 'sources.md'), scope)).toBe(join(managed, 'docs', 'sources.md'));
    // ALLOWED — the session workspace's own source authoring (read + write).
    expect(resolveScopedPath(join(wsA, 'sources', 'my-source', 'config.json'), scope, { access: 'write' }))
      .toBe(join(wsA, 'sources', 'my-source', 'config.json'));
    expect(resolveScopedPath(join(wsA, 'sources', 'my-source', 'guide.md'), scope))
      .toBe(join(wsA, 'sources', 'my-source', 'guide.md'));
    expect(resolveScopedPath(join(wsA, 'sources', 'my-source', 'permissions.json'), scope, { access: 'write' }))
      .toBe(join(wsA, 'sources', 'my-source', 'permissions.json'));

    // ALLOWED — /create-skill authors the global skills root (read + write).
    expect(resolveScopedPath(join(managed, 'skills', 'my-skill', 'SKILL.md'), scope, { access: 'write' }))
      .toBe(join(managed, 'skills', 'my-skill', 'SKILL.md'));

    // DENIED — docs are read-only; a write falls through to the managed denial.
    expect(() => resolveScopedPath(join(managed, 'docs', 'sources.md'), scope, { access: 'write' }))
      .toThrow(ManagedRootDeniedError);
    // DENIED — the per-source credential cache (decrypted secret) for read AND write.
    expect(() => resolveScopedPath(join(wsA, 'sources', 'my-source', '.credential-cache.json'), scope))
      .toThrow(ManagedRootDeniedError);
    expect(() => resolveScopedPath(join(wsA, 'sources', 'my-source', '.credential-cache.json'), scope, { access: 'write' }))
      .toThrow(ManagedRootDeniedError);
    // DENIED — another workspace's sources.
    expect(() => resolveScopedPath(join(wsB, 'sources', 'other', 'config.json'), scope, { access: 'write' }))
      .toThrow(ManagedRootDeniedError);
    // DENIED — credentials store.
    expect(() => resolveScopedPath(join(managed, 'credentials', 'secret.json'), scope))
      .toThrow(ManagedRootDeniedError);
    // DENIED — plugins cache.
    expect(() => resolveScopedPath(join(managed, 'plugins', 'foo', 'x.json'), scope, { access: 'write' }))
      .toThrow(ManagedRootDeniedError);
    // DENIED — arbitrary managed path.
    expect(() => resolveScopedPath(join(managed, 'preferences.json'), scope, { access: 'write' }))
      .toThrow(ManagedRootDeniedError);

    rmSync(home, { recursive: true, force: true });
  });

  // F1.917 (DN-235, 2026-09-28) — the session's own scratch folder `<session>/job/tmp`
  // (P6.535, `$CLAUDE_JOB_DIR/tmp`): the gate lets a file-tool write there through with no
  // card, so Pi's scope must not then refuse it as managed storage. Red before the fix:
  // the first write below threw ManagedRootDeniedError.
  it("F1.917: Pi's file tools write the session's own job/tmp scratch folder", () => {
    const { home, managed, scope } = buildLayout();
    const scratch = join(managed, 'sessions', 'ws-a', 's-1', 'job', 'tmp');
    mkdirSync(scratch, { recursive: true });

    expect(resolveScopedPath(join(scratch, 'x.txt'), scope, { access: 'write' })).toBe(join(scratch, 'x.txt'));
    expect(resolveScopedPath(join(scratch, 'nested', 'y.json'), scope, { access: 'write' })).toBe(join(scratch, 'nested', 'y.json'));
    expect(resolveScopedPath(join(scratch, 'x.txt'), scope)).toBe(join(scratch, 'x.txt'));

    rmSync(home, { recursive: true, force: true });
  });

  // The rest of the own `job/` (`job/x`, `job/tmp-x`) left this control with F1.1046, which
  // opened the whole own folder on purpose (DECISIONS-2 Q13); it is pinned OPEN below.
  it('F1.917 CONTROL: another session\'s scratch and a symlink out of job/tmp stay refused', () => {
    const { home, managed, scope } = buildLayout();
    const own = join(managed, 'sessions', 'ws-a', 's-1');
    const other = join(managed, 'sessions', 'ws-a', 's-2', 'job', 'tmp');
    mkdirSync(join(own, 'job', 'tmp'), { recursive: true });
    mkdirSync(other, { recursive: true });
    symlinkSync(other, join(own, 'job', 'tmp', 'link'));

    expect(() => resolveScopedPath(join(other, 'x.txt'), scope, { access: 'write' })).toThrow(ManagedRootDeniedError);
    expect(() => resolveScopedPath(join(own, 'job', 'tmp', 'link', 'x.txt'), scope, { access: 'write' })).toThrow(ManagedRootDeniedError);
    expect(() => resolveScopedPath(join(own, 'session.jsonl'), scope, { access: 'write' })).toThrow(ManagedRootDeniedError);

    rmSync(home, { recursive: true, force: true });
  });

  // F1.1046 (DN-245, 2026-09-28) — Pi's file tools reach the session's own folder the way the
  // gate's F1.703 carve-out already lets claude's reach it: everything below it but its records.
  // Red before the fix: the first write below (data/) threw ManagedRootDeniedError.
  it("F1.1046: Pi's file tools read and write the session's own folder — data, downloads, all of job/, a file at its root", () => {
    const { home, managed, scope } = buildLayout();
    const own = join(managed, 'sessions', 'ws-a', 's-1');
    for (const dir of ['data', 'downloads', 'plans', join('job', 'tmp'), 'attachments']) mkdirSync(join(own, dir), { recursive: true });
    writeFileSync(join(own, 'attachments', 'a1.txt'), 'attached');

    for (const rel of [join('data', 'findings.md'), join('downloads', 'report.pdf'), join('job', 'x.txt'), join('job', 'tmp-x', 'y.txt'), join('job', 'tmp', 'z.txt'), join('plans', 'p.md'), 'notes.md']) {
      expect(resolveScopedPath(join(own, rel), scope, { access: 'write' })).toBe(join(own, rel));
      expect(resolveScopedPath(join(own, rel), scope)).toBe(join(own, rel));
    }
    // The user's attachments keep F1.725's read-only allowance.
    expect(resolveScopedPath(join(own, 'attachments', 'a1.txt'), scope)).toBe(join(own, 'attachments', 'a1.txt'));

    rmSync(home, { recursive: true, force: true });
  });

  it('F1.1046 CONTROL: the records, the folder itself, another session and a symlink onto a record stay refused', () => {
    const { home, managed, scope } = buildLayout();
    const own = join(managed, 'sessions', 'ws-a', 's-1');
    const otherData = join(managed, 'sessions', 'ws-a', 's-2', 'data');
    for (const dir of [join(own, 'data'), join(own, 'attachments'), join(own, 'long_responses'), otherData]) mkdirSync(dir, { recursive: true });
    writeFileSync(join(own, 'session.jsonl'), '{}\n');
    symlinkSync(join(own, 'session.jsonl'), join(own, 'data', 'transcript'));
    symlinkSync(otherData, join(own, 'data', 'elsewhere'));

    const refusedWrites = [
      'session.jsonl', 'session.jsonl.tmp', 'Session.JSONL', join('attachments', 'a2.txt'), join('ATTACHMENTS', 'a2.txt'),
      join('long_responses', 'r.txt'), join('Long_Responses', 'r.txt'), join('data', 'transcript'), join('data', 'elsewhere', 'x.md'),
    ];
    for (const rel of refusedWrites) {
      expect(() => resolveScopedPath(join(own, rel), scope, { access: 'write' })).toThrow(ManagedRootDeniedError);
    }
    // A read of `long_responses` left this list with F1.1062, which opened it READ-ONLY on purpose (below).
    for (const rel of ['session.jsonl', join('data', 'transcript'), '.']) {
      expect(() => resolveScopedPath(join(own, rel), scope)).toThrow(ManagedRootDeniedError);
    }
    expect(() => resolveScopedPath(join(otherData, 'x.md'), scope, { access: 'write' })).toThrow(ManagedRootDeniedError);
    expect(() => resolveScopedPath(join(otherData, 'x.md'), scope)).toThrow(ManagedRootDeniedError);
    expect(() => resolveScopedPath(join(managed, 'sessions', 'ws-a', 'loose.md'), scope, { access: 'write' })).toThrow(ManagedRootDeniedError);

    rmSync(home, { recursive: true, force: true });
  });

  // F1.1062 (DN-247, 2026-09-28) — the host's large-result preview (`formatLargeResponseMessage`,
  // `utils/large-response.ts`) hands the model an absolute path under `<session>/long_responses/`
  // and says "Use Read/Grep to access specific content"; claude's Read opens it (the gate allows,
  // pinned in `session-working-folder-floor.test.ts`). Red before the fix: Pi's first read below
  // threw ManagedRootDeniedError, so the preview pointed Pi at a file its own tools refused.
  it("F1.1062: Pi's file tools READ the session's own long_responses/, where the large-result preview points", () => {
    const { home, managed, scope } = buildLayout();
    const responses = join(managed, 'sessions', 'ws-a', 's-1', 'long_responses');
    const saved = join(responses, '2026-09-28_linear_list_issues.txt');
    mkdirSync(responses, { recursive: true });
    writeFileSync(saved, 'the full result');

    expect(resolveScopedPath(saved, scope)).toBe(saved); // Read
    expect(resolveScopedPath(responses, scope)).toBe(responses); // Grep, Glob and ls resolve the folder as their root

    rmSync(home, { recursive: true, force: true });
  });

  it("F1.1062 CONTROL: long_responses/ stays unwritable, another session's stays unreadable, a link inside it is judged where it lands", () => {
    const { home, managed, scope } = buildLayout();
    const own = join(managed, 'sessions', 'ws-a', 's-1');
    const otherResponses = join(managed, 'sessions', 'ws-a', 's-2', 'long_responses');
    for (const dir of [join(own, 'long_responses'), otherResponses]) mkdirSync(dir, { recursive: true });
    writeFileSync(join(own, 'long_responses', 'r.txt'), 'the full result');
    writeFileSync(join(otherResponses, 'r.txt'), 'another session');
    writeFileSync(join(own, 'session.jsonl'), '{}\n');
    symlinkSync(join(own, 'session.jsonl'), join(own, 'long_responses', 'transcript'));
    symlinkSync(otherResponses, join(own, 'long_responses', 'elsewhere'));

    for (const rel of [join('long_responses', 'r.txt'), join('long_responses', 'new.txt'), 'long_responses', join('Long_Responses', 'r.txt')]) {
      expect(() => resolveScopedPath(join(own, rel), scope, { access: 'write' })).toThrow(ManagedRootDeniedError);
    }
    expect(() => resolveScopedPath(join(otherResponses, 'r.txt'), scope)).toThrow(ManagedRootDeniedError);
    expect(() => resolveScopedPath(join(own, 'long_responses', 'transcript'), scope)).toThrow(ManagedRootDeniedError);
    expect(() => resolveScopedPath(join(own, 'long_responses', 'elsewhere', 'r.txt'), scope)).toThrow(ManagedRootDeniedError);

    rmSync(home, { recursive: true, force: true });
  });

  // F1.1062 — the two other host files at the session folder's top level join its records: `.pi-carry/`
  // (Pi's carried history, `PI_CARRY_DIRNAME`) and `checkout-move.patch` (the patch a checkout move
  // travels through, `CHECKOUT_MOVE_PATCH_BASENAME`). Red before the fix: every write below resolved.
  it("F1.1062: .pi-carry/ and checkout-move.patch are the session's records — Pi's file tools neither write nor read them, as session.jsonl", () => {
    const { home, managed, scope } = buildLayout();
    const own = join(managed, 'sessions', 'ws-a', 's-1');
    mkdirSync(join(own, '.pi-carry'), { recursive: true });
    writeFileSync(join(own, '.pi-carry', 'handoff.jsonl'), '{}\n');
    writeFileSync(join(own, 'checkout-move.patch'), 'diff --git a/x b/x\n');

    for (const rel of [join('.pi-carry', 'handoff.jsonl'), join('.pi-carry', 'new.jsonl'), '.pi-carry', join('.PI-CARRY', 'handoff.jsonl'), 'checkout-move.patch', 'Checkout-Move.PATCH']) {
      expect(() => resolveScopedPath(join(own, rel), scope, { access: 'write' })).toThrow(ManagedRootDeniedError);
    }
    for (const rel of [join('.pi-carry', 'handoff.jsonl'), 'checkout-move.patch']) {
      expect(() => resolveScopedPath(join(own, rel), scope)).toThrow(ManagedRootDeniedError);
    }

    rmSync(home, { recursive: true, force: true });
  });

  // The record list spells the two producers' names (shared does not import server-core); this reads
  // the producers' own constants, so a rename on either side goes red here rather than opening the file.
  it('F1.1062: the record list names what the producers actually write', () => {
    expect(isOwnSessionRecordName(PI_CARRY_DIRNAME)).toBe(true);
    expect(isOwnSessionRecordName(CHECKOUT_MOVE_PATCH_BASENAME)).toBe(true);
    expect(isOwnSessionRecordName(LONG_RESPONSES_DIR)).toBe(true);
  });

  // F1.1174 (DN-291, 2026-09-29) — the folder holds more host and runtime records than F1.1062's five: Pi's
  // resumable transcript `.pi-sessions/` (continueRecent resumes the newest file there) and its `.pi-agent/`, the
  // workflow journal `.orchestrator/` (replayed on resume), the host's fork and resume anchors under `meta/`, the
  // hook env file `hook-env/` (sourced before every later Bash command), the rewind snapshots `file_checkpoints/`,
  // and the interceptor's `tool-metadata.json` and `api-error.json`. Red before the fix: every write below resolved.
  const MORE_RECORDS = [
    join('.pi-sessions', 'zzz.jsonl'), join('.pi-agent', 'settings.json'), join('.orchestrator', 'run.jsonl'),
    join('meta', 'claude-turn-anchors.json'), join('META', 'pi-turn-anchors.json'), join('hook-env', 'env.sh'),
    join('file_checkpoints', 'manifest.json'), 'tool-metadata.json', 'tool-metadata.json.tmp', 'api-error.json', 'Tool-Metadata.JSON',
  ];
  it("F1.1174: the other host and runtime records in the folder are records too — Pi's file tools neither write nor read them", () => {
    const { home, managed, scope } = buildLayout();
    const own = join(managed, 'sessions', 'ws-a', 's-1');
    for (const rel of MORE_RECORDS) {
      expect(() => resolveScopedPath(join(own, rel), scope, { access: 'write' })).toThrow(ManagedRootDeniedError);
      expect(() => resolveScopedPath(join(own, rel), scope)).toThrow(ManagedRootDeniedError);
    }
    rmSync(home, { recursive: true, force: true });
  });

  // The producers spell these as literals (no exported constant), so this reads each producer's own line: a rename
  // there goes red here instead of silently opening the renamed folder.
  it('F1.1174: the record list names what those producers actually write', () => {
    const packages = join(import.meta.dir, '..', '..', '..', '..');
    const producers: Array<[string, string, string]> = [
      ['.pi-sessions', 'pi-agent-server/src/index.ts', "join(config.sessionPath, '.pi-sessions')"],
      ['.pi-agent', 'pi-agent-server/src/index.ts', "join(config.sessionPath, '.pi-agent')"],
      ['.orchestrator', 'pi-agent-server/src/orchestrator/journal.ts', "join(sessionPath || process.cwd(), '.orchestrator')"],
      ['meta', 'server-core/src/sessions/SessionManager.ts', "join(sessionPath, 'meta', file)"],
      ['meta', 'shared/src/agent/backend/nestor-cloud/context-store.ts', "join(bindings.sessionPath, 'meta', 'nestor-cloud-context.json')"],
      ['hook-env', 'shared/src/automations/hook-env-file.ts', "const HOOK_ENV_DIR_NAME = 'hook-env';"],
      ['file_checkpoints', 'shared/src/sessions/file-checkpoints.ts', "const CHECKPOINT_DIR = 'file_checkpoints'"],
      ['tool-metadata.json', 'shared/src/interceptor-common.ts', "join(_sessionDir, 'tool-metadata.json')"],
      ['api-error.json', 'shared/src/interceptor-common.ts', "join(_sessionDir, 'api-error.json')"],
    ];
    for (const [name, file, line] of producers) {
      expect({ name, file, producerWritesIt: readFileSync(join(packages, file), 'utf8').includes(line) }).toEqual({ name, file, producerWritesIt: true });
      expect({ name, record: isOwnSessionRecordName(name) }).toEqual({ name, record: true });
    }
  });

  it('F1.1062 BOUNDARY: a record is a name at the top of the folder only — the same names deeper, and near-names, stay open', () => {
    const { home, managed, scope } = buildLayout();
    const own = join(managed, 'sessions', 'ws-a', 's-1');
    mkdirSync(join(own, 'data'), { recursive: true });

    // F1.1174's names too: `meta.md`, `data/meta/`, a `hook-env.sh` of the agent's own stay the agent's to write.
    for (const rel of [join('data', 'checkout-move.patch'), join('data', '.pi-carry', 'notes.md'), 'checkout-move.patch.md', '.pi-carry-notes', 'meta.md', join('data', 'meta', 'x.json'), 'hook-env.sh', join('data', '.pi-sessions', 'a.jsonl'), 'api-error.json.md']) {
      expect(resolveScopedPath(join(own, rel), scope, { access: 'write' })).toBe(join(own, rel));
      expect(resolveScopedPath(join(own, rel), scope)).toBe(join(own, rel));
    }

    rmSync(home, { recursive: true, force: true });
  });

  it('lets the agent-facing Write path create sources/<slug>/config.json in the session workspace', () => {
    const { home, wsA, scope } = buildLayout();
    // The slug dir does not exist yet — the file tool resolves before mkdir.
    const target = join(wsA, 'sources', 'created-source', 'config.json');
    const resolved = resolveScopedPath(target, scope, { access: 'write' });
    expect(resolved).toBe(target);

    mkdirSync(dirname(resolved), { recursive: true });
    writeFileSync(resolved, JSON.stringify({ type: 'local' }));
    expect(existsSync(resolved)).toBe(true);

    rmSync(home, { recursive: true, force: true });
  });
});

/**
 * F1.702 (origin WJ-crit-m P-WJcritm-1) — a project folder that CONTAINS the data folder no longer lets a file-tool
 * Write reach it. The primary root used to win before the managed exclusion, and `isAgentConfigPath` knows only the
 * literal `.nessy-agent`, so a data folder relocated under another name inside the project (NESSY_CONFIG_DIR) was
 * writable in full after an approved card or in bypass. A write there now meets the same allowances and the same
 * managed-storage refusal as from any other project. Reads are unchanged (the residue), and the default-named
 * folder keeps its project-agent-config refusal.
 */
describe('F1.702: a data folder inside the project folder stays managed storage for writes', () => {
  function relocatedLayout() {
    const home = tempDir('scope-f702-');
    const project = join(home, 'project');
    const managed = join(project, 'nessy-data');
    const wsA = join(managed, 'workspaces', 'ws-a');
    mkdirSync(join(wsA, 'sources'), { recursive: true });
    mkdirSync(join(managed, 'sessions', 'ws-a', 's-1', 'plans'), { recursive: true });
    writeFileSync(join(managed, 'config.json'), '{}');
    const scope = buildSessionFilesystemScope({
      workspaceId: 'ws-a', sessionId: 's-1', projectCanonicalPath: project, workspaceRootPath: wsA, managedConfigDir: managed,
    });
    return { home, project, managed, wsA, scope };
  }

  function refusal(path: string, scope: SessionFilesystemScope, access: 'read' | 'write'): string {
    try {
      resolveScopedPath(path, scope, { access });
      return 'allowed';
    } catch (error) {
      return (error as Error).name;
    }
  }

  it('a write to the global records, another workspace or the folder itself is refused as managed storage', () => {
    const { home, managed, scope } = relocatedLayout();
    expect({
      config: refusal(join(managed, 'config.json'), scope, 'write'),
      relative: refusal('nessy-data/permissions.json', scope, 'write'),
      otherWorkspace: refusal(join(managed, 'workspaces', 'ws-b', 'notes.md'), scope, 'write'),
      folder: refusal(managed, scope, 'write'),
    }).toEqual({
      config: 'ManagedRootDeniedError',
      relative: 'ManagedRootDeniedError',
      otherWorkspace: 'ManagedRootDeniedError',
      folder: 'ManagedRootDeniedError',
    });
    rmSync(home, { recursive: true, force: true });
  });

  it('CONTROL: the allowances still open (own session folder, own sources), the project stays writable and reads are unchanged', () => {
    const { home, project, managed, wsA, scope } = relocatedLayout();
    expect({
      ownPlan: refusal(join(managed, 'sessions', 'ws-a', 's-1', 'plans', 'p.md'), scope, 'write'),
      ownSource: refusal(join(wsA, 'sources', 'x', 'config.json'), scope, 'write'),
      projectFile: refusal(join(project, 'src', 'a.ts'), scope, 'write'),
      readRecord: refusal(join(managed, 'config.json'), scope, 'read'),
    }).toEqual({ ownPlan: 'allowed', ownSource: 'allowed', projectFile: 'allowed', readRecord: 'allowed' });
    rmSync(home, { recursive: true, force: true });
  });

  it('CONTROL: a no-project session writes its own managed workspace, and a default-named folder keeps its refusal', () => {
    const { home, managed, wsA } = relocatedLayout();
    const noProject = buildSessionFilesystemScope({ workspaceId: 'ws-a', sessionId: 's-1', workspaceRootPath: wsA, managedConfigDir: managed });
    const defaultHome = tempDir('scope-f702-default-');
    const defaultManaged = join(defaultHome, '.nessy-agent');
    mkdirSync(defaultManaged, { recursive: true });
    const homeProject = buildSessionFilesystemScope({
      workspaceId: 'ws-a', sessionId: 's-1', projectCanonicalPath: defaultHome,
      workspaceRootPath: join(defaultManaged, 'workspaces', 'ws-a'), managedConfigDir: defaultManaged,
    });
    expect({
      noProjectOwnWorkspace: refusal(join(wsA, 'notes.md'), noProject, 'write'),
      defaultNamed: refusal(join(defaultManaged, 'config.json'), homeProject, 'write'),
    }).toEqual({ noProjectOwnWorkspace: 'allowed', defaultNamed: 'AgentConfigDeniedError' });
    rmSync(home, { recursive: true, force: true });
    rmSync(defaultHome, { recursive: true, force: true });
  });
});
