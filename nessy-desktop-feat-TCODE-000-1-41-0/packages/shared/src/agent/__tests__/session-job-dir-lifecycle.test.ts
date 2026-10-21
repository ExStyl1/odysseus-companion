/**
 * C3.26 (owner decision D3 = B, 2026-09-05; row raised 2026-09-11) — the two
 * clauses of the per-session scratch directory that nothing pinned.
 *
 * VERIFIED AT HEAD FIRST, and the row is mostly a refutation: P6.535 already
 * built it on all three runtimes. `CLAUDE_JOB_DIR` is written for the claude
 * child (`claude-session-job-dir.test.ts`), `NESSY_SESSION_JOB_DIR` for Pi and
 * codex (`session-job-dir-all-runtimes.test.ts`), a write inside it raises no
 * approval card and the card's own diagnostic names the directory
 * (`session-scratch-no-prompt.test.ts`). What the row's "done means" still asks
 * for is the two properties NO test covered: that the directory is torn down
 * with the session, and that nothing ever reads it back into the model's
 * context.
 *
 * `agent-view.md#where-state-is-stored` is the contract for both halves —
 * verbatim: *"Each background session has the `CLAUDE_JOB_DIR` environment
 * variable set to its `~/.claude/jobs/<id>` directory, so shell commands the
 * session runs can write temporary files to `$CLAUDE_JOB_DIR/tmp` without
 * colliding with parallel sessions."*, and the directory is *"Removed when the
 * session is deleted"*.
 *
 * THE SECOND HALF IS A CENSUS, and that is the honest instrument rather than a
 * convenience: "nothing re-reads it into context" is a claim about every reader
 * in the tree, so it is proven by enumerating the readers — not by driving one
 * turn and observing that a file did not appear in it.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bracedRegion } from '../../testing/source-regions.ts';
import { ensureSessionJobDir, getSessionDirPath, getSessionJobDir } from '../../sessions/storage.ts';

const REPO_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));
const WORKSPACE = 'ws-job-lifecycle';
const SESSION = 'session-job-lifecycle';

afterAll(() => {
  rmSync(getSessionDirPath(WORKSPACE, SESSION), { recursive: true, force: true });
});

/** Tracked `.ts`/`.tsx` files under `packages/` and `apps/` naming `needle`. */
const trackedFilesNaming = (needle: string): string[] => {
  const found = Bun.spawnSync(
    ['git', 'grep', '-l', '-a', '-F', '-e', needle, '--', 'packages', 'apps'],
    { cwd: REPO_ROOT },
  );
  return new TextDecoder().decode(found.stdout)
    .split('\n')
    .filter(line => /\.tsx?$/.test(line))
    .filter(line => !line.includes('__tests__') && !line.includes('.test.'));
};

describe('C3.26 · the scratch directory dies with the session and the transcript does not', () => {
  it('removes `job/` and leaves the session directory standing', () => {
    // The exact expression `SessionManager.removeSessionJobDir` runs, against
    // the exact path the three env builders hand the child. Both halves matter:
    // the scratch has to go, and the session directory must survive it because
    // it holds the transcript.
    const jobDir = ensureSessionJobDir(WORKSPACE, SESSION);
    expect(jobDir).toBe(getSessionJobDir(WORKSPACE, SESSION));
    const sessionDir = getSessionDirPath(WORKSPACE, SESSION);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, 'session.jsonl'), '{}\n');
    writeFileSync(join(jobDir!, 'tmp', 'scratch.txt'), 'working file\n');

    rmSync(getSessionJobDir(WORKSPACE, SESSION), { recursive: true, force: true });

    expect(existsSync(jobDir!)).toBe(false);
    expect(existsSync(join(sessionDir, 'session.jsonl'))).toBe(true);
  });

  it('is called at the end of a session life and NOT on a runtime dispose', () => {
    // The distinction the method's own docblock draws, and the one that would
    // destroy a user's files if it were lost: `disposeManagedAgentRuntime` also
    // fires on a model switch and a runtime-config refresh, where deleting a
    // running session's scratch would take files out from under a live
    // conversation. Read from the source because the method is private and the
    // property is about WHERE it is called, not about what it does.
    const source = readFileSync(
      join(REPO_ROOT, 'packages/server-core/src/sessions/SessionManager.ts'),
      'utf8',
    );

    expect(source).toContain('private removeSessionJobDir(managed: ManagedSession): void {');
    expect(source).toContain('rmSync(getSessionJobDir(managed.workspace.id, managed.id), { recursive: true, force: true })');

    // Exactly two mentions: the definition and the one call.
    const mentions = source.split('removeSessionJobDir').length - 1;
    expect(mentions).toBe(2);

    // And that call sits inside the method both session endings funnel through.
    // D1.111 — the method's own braces, not 4 000 characters of it.
    const lifecycleStart = source.indexOf('private async endManagedAgentLifecycle(');
    expect(lifecycleStart).toBeGreaterThan(0);
    const lifecycleBody = bracedRegion(source, lifecycleStart);
    expect(lifecycleBody).toContain('this.removeSessionJobDir(managed)');
    // BOUNDARY CONTROL: the region is that method and not the rest of the file.
    // The anchor has to be a declaration BELOW this one — `disposeManagedAgentRuntime`
    // sits above it and would make this line pass on a runaway scan.
    expect(lifecycleBody).not.toContain('private async tryRefreshAgentRuntime(');

    // The control: the dispose path does not touch it.
    //
    // D1.111 — this anchor used to be the bare call text, and the FIRST
    // occurrence of that substring in `SessionManager.ts` is a CALL SITE
    // thousands of lines above the definition, so the control read 4 000
    // characters of an unrelated method and could not have failed. The
    // declaration is the anchor, and the method's braces are the bound.
    const disposeStart = source.indexOf('private async disposeManagedAgentRuntime(');
    expect(disposeStart).toBeGreaterThan(0);
    const disposeBody = bracedRegion(source, disposeStart);
    // The control's own boundary control: the region really is one method body
    // and not the whole tail of the file — which would make the negative below
    // fire on the lifecycle method's correct call.
    expect(disposeBody).not.toContain('private async endManagedAgentLifecycle(');
    expect(disposeBody).not.toContain('removeSessionJobDir');
  });
});

describe('C3.26 · the scratch is write-only from the model side — nothing reads it back into context', () => {
  it('has exactly the readers the design names, and no context or prompt builder among them', () => {
    const readers = new Set([
      ...trackedFilesNaming('getSessionJobDir'),
      ...trackedFilesNaming('ensureSessionJobDir'),
      ...trackedFilesNaming('SESSION_JOB_DIR_ENV_VAR'),
      ...trackedFilesNaming('CLAUDE_JOB_DIR'),
    ]);

    // THE PIN, one line per role. A new entry here is a new reader of the
    // scratch directory, and the question this test exists to ask is whether
    // that reader puts its contents in front of the model.
    expect([...readers].sort()).toEqual([
      // The teardown.
      'packages/server-core/src/sessions/SessionManager.ts',
      // The codex spawn env.
      'packages/shared/src/agent/codex-agent.ts',
      // The approval-card exemption, which resolves the path and never opens it.
      'packages/shared/src/agent/core/pre-tool-use.ts',
      // The claude spawn env.
      'packages/shared/src/agent/options.ts',
      // The Pi spawn env.
      'packages/shared/src/agent/pi-agent.ts',
      // A docblock cross-reference only — the runtime debug log cites the
      // create-then-name rule this directory established.
      'packages/shared/src/agent/session-debug-log.ts',
      // Pi's file-tool scope — a docblock naming `$CLAUDE_JOB_DIR/tmp` on the
      // own-session allowance (F1.917, widened by F1.1046) that lets the
      // model's OWN Read/Write tool calls reach its scratch, as Claude's file
      // tools already could. A verdict on a path the model asked for: it opens
      // no file and puts nothing in front of the model unasked.
      'packages/shared/src/agent/session-filesystem-scope.ts',
      // The re-export barrel.
      'packages/shared/src/sessions/index.ts',
      // The path and the mkdir themselves.
      'packages/shared/src/sessions/storage.ts',
    ]);

    // POSITIVE CONTROL on the same rig: the census really does find readers.
    // `CLAUDE_CONFIG_DIR` is the sibling env var this repo reads everywhere, so
    // an empty or one-file answer here would mean the instrument, not the tree.
    expect(trackedFilesNaming('CLAUDE_CONFIG_DIR').length).toBeGreaterThan(5);
  });

  it('is named by no prompt, context or memory builder', () => {
    // The same census read the other way round, so the pin above cannot be
    // "fixed" by adding a context builder to its list without someone reading
    // this sentence: the directory exists so a shell command has somewhere to
    // write, and its contents are never pulled back into a turn.
    const readers = [
      ...trackedFilesNaming('getSessionJobDir'),
      ...trackedFilesNaming('ensureSessionJobDir'),
      ...trackedFilesNaming('SESSION_JOB_DIR_ENV_VAR'),
      ...trackedFilesNaming('CLAUDE_JOB_DIR'),
    ];
    const contextish = readers.filter(path => /\/(prompts|memory|context)\//.test(path)
      || /prompt-builder|context-builder|capability-context/.test(path));
    expect(contextish).toEqual([]);
  });
});
