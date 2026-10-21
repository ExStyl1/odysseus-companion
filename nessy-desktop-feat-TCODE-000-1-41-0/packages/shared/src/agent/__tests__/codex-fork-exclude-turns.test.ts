/**
 * F1.1237 (final sitting SIT2-d, 2026-10-01, RC 831fde57f) — since the `rust-v0.159.3` lift
 * (F1.1215) every branch and every turn-head re-fork put codex's own
 * "Codex DEPRECATION NOTICE — Full-history hydration is deprecated for paginated threads; use
 * `excludeTurns: true`, then page with `thread/turns/list` and `thread/items/list`." in the chat.
 *
 * What codex does, read at `github.com/openai/codex` tag `rust-v0.159.3`:
 *
 * - The SERVER sends that `deprecationNotice` from `thread/fork` and `thread/resume` exactly when
 *   the source thread is paginated AND the request did not set `excludeTurns`
 *   (`codex-rs/app-server/src/request_processors/thread_processor.rs`, `paginated_source &&
 *   include_turns`, with `include_turns = !exclude_turns`). The flag changes only what the
 *   RESPONSE carries (`thread.turns`); the forked thread's history comes from the rollout either way.
 * - codex's own TUI does not trip it: `codex-rs/tui/src/app_server_session.rs` forks with
 *   `exclude_turns` set for a paginated parent and pages the history it shows afterwards. It still
 *   RENDERS a deprecation notice that does arrive (`history_cell/notices.rs`, `DeprecationNoticeCell`).
 *
 * So the native fix is the request, not the renderer: this host never reads `thread.turns` from a
 * fork or resume response (it reads `thread.id`; the transcript is the host's own), so every
 * fork and resume sends `excludeTurns: true`, and a genuine deprecation notice still reaches the chat.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { BackendConfig } from '../backend/types.ts';
import type { SessionKey } from '../../sessions/session-key.ts';
import { cleanupModeState } from '../mode-manager.ts';
import { CodexAgent } from '../codex-agent.ts';

const SESSION_KEY: SessionKey = { workspaceId: 'ws-f1237', sessionId: 'session-f1237' };
/** The server's constant, verbatim (`PAGINATED_FULL_HISTORY_DEPRECATION_SUMMARY` at `rust-v0.159.3`). */
const HYDRATION_SUMMARY = 'Full-history hydration is deprecated for paginated threads; use `excludeTurns: true`, '
  + 'then page with `thread/turns/list` and `thread/items/list`.';

/**
 * An app-server double that answers `thread/fork` the way `thread_processor.rs` does for a
 * PAGINATED source: the `deprecationNotice` frame first when `excludeTurns` is not `true`.
 */
function harness() {
  cleanupModeState(SESSION_KEY);
  const config: BackendConfig = {
    provider: 'codex-runtime',
    workspace: {
      id: SESSION_KEY.workspaceId, name: 'F1.1237', rootPath: '/tmp/ws-f1237-root', workspaceRootPath: '/tmp/ws-f1237-root',
      sessionRootPath: '/tmp/nessy-general-agent-test-sessions/ws-f1237',
    } as never,
    session: {
      id: SESSION_KEY.sessionId, workspaceRootPath: '/tmp/ws-f1237-root', createdAt: Date.now(), lastUsedAt: Date.now(),
      workingDirectory: '/tmp/project-root',
    } as never,
    model: 'codex/test-model',
    isHeadless: true,
  };
  const agent = new CodexAgent(config);
  const internals = agent as never as {
    client: unknown; threadId: string; runtimeConfigSignature: string;
    pendingServerWarningNotices: string[];
    handleNotification(method: string, params: unknown): void;
    applySelectedPluginSkillRuntimePolicy(policy: unknown): Promise<void>;
  };
  const forks: Array<Record<string, unknown>> = [];
  internals.client = {
    request(method: string, params: Record<string, unknown>) {
      if (method === 'thread/fork') {
        forks.push(params);
        if (params.excludeTurns !== true) {
          internals.handleNotification('deprecationNotice', { summary: HYDRATION_SUMMARY, details: null });
        }
        return Promise.resolve({ thread: { id: 'thread-forked' } });
      }
      return Promise.resolve({ thread: { id: 'thread-fresh' } });
    },
    notify() {},
    close() {},
  };
  internals.threadId = 'thread-original';
  // The drift that makes the turn-head re-fork fire at all.
  internals.runtimeConfigSignature = 'stale-signature';
  return { agent, internals, forks };
}

describe('F1.1237 · a fork or resume asks codex for no turns, so no hydration notice reaches the chat', () => {
  afterEach(() => cleanupModeState(SESSION_KEY));

  it('the turn-head re-fork sends excludeTurns: true and leaves no DEPRECATION NOTICE for the chat', async () => {
    const { agent, internals, forks } = harness();
    try {
      await internals.applySelectedPluginSkillRuntimePolicy({ environment: {}, writablePaths: [] });
      expect(forks).toHaveLength(1);
      expect(forks[0]!.excludeTurns).toBe(true);
      expect(internals.pendingServerWarningNotices.filter(notice => notice.includes('DEPRECATION NOTICE'))).toEqual([]);
    } finally { agent.destroy(); }
  });

  it('BOUNDARY: a deprecation notice codex does send still reaches the chat, as in codex\'s own TUI', () => {
    const { agent, internals } = harness();
    try {
      internals.handleNotification('deprecationNotice', { summary: 'Some other API is going away', details: null });
      expect(internals.pendingServerWarningNotices).toEqual(['Codex DEPRECATION NOTICE — Some other API is going away']);
    } finally { agent.destroy(); }
  });

  it('the session-open legs carry it too: the branch fork and both thread/resume calls', () => {
    // Source-matched, for `codex-fork-thread-start-params.test.ts`'s reason: these three call sites
    // need a spawned app-server and a codex home to drive.
    const source = readFileSync(new URL('../codex-agent.ts', import.meta.url), 'utf8');
    for (const opener of [
      "client.request('thread/resume', {\n          threadId: resumeThreadId,",
      "client.request('thread/fork', {\n            threadId: forkFromThreadId,",
      "client.request('thread/resume', {\n            threadId: persistedThreadId,",
    ]) {
      const at = source.indexOf(opener);
      expect(at).toBeGreaterThan(-1);
      const line = source.slice(at + opener.length, source.indexOf('\n', at + opener.length));
      expect(line).toContain('excludeTurns: true');
    }
  });
});
