/**
 * C3.74 — the claude arm of past-session browsing, filled from a RUN.
 *
 * Ledger row F4 ("Browse, search, archive and re-open past sessions from the
 * runtime's own thread store") carried `—` for claude. The codex cell is a
 * measured refusal and the temptation is to propagate it; the row exists because
 * claude's answer is different and nobody had taken it.
 *
 * ## What the vendored SDK actually publishes, and it is not a directory listing
 *
 * `sdk.d.ts` at `0.3.247` exports a whole session-store API beside `query`:
 * `listSessions`, `getSessionInfo`, `getSessionMessages`, `deleteSession`,
 * `renameSession`, `tagSession` and `forkSession`. This repo imports NONE of
 * them (measured: zero import sites across `packages` and `apps` — our own
 * same-named symbols, such as `sessions/storage.ts`'s `listSessions`, are the
 * false positives a bare name grep returns).
 *
 * ## The measurement, 2026-09-11, vendored `0.3.247` / `2.1.247`
 *
 * A session created by THIS BUILD — the row's own control — driven against a
 * loopback Anthropic stub, then read back through the runtime's own readers:
 *
 *  - CREATE: `projects/<projectKey>/<sessionId>.jsonl` appears under the config dir.
 *  - LIST: `listSessions({ dir })` returns exactly that session id; with no
 *    `dir` at all it returns it too, i.e. the store is enumerable across projects.
 *  - READ: `getSessionInfo` answers with the same id and a `summary` the RUNTIME
 *    derived from the first prompt; `getSessionMessages` returns the turn's two
 *    messages and the prompt's marker is recoverable from them.
 *  - RE-OPEN: resuming by that id comes back under the SAME session id, and the
 *    resumed turn puts the earlier prompt back on the wire — so it is a real
 *    re-open rather than a new session with an old name.
 *  - CONTROL: `getSessionInfo` for an id that was never created answers
 *    `undefined`, so the four readings above are not "this API says yes to
 *    everything".
 *
 * ## What is therefore still NOT covered, and it is the half the row's word
 * ## "partial" rests on
 *
 * Of F4's four verbs, browse/read/re-open are native and measured. There is no
 * ARCHIVE verb in the SDK's export surface (codex publishes `thread/archive`;
 * claude publishes `deleteSession`, which is not the same promise) and no SEARCH
 * verb at all. And nothing in this product surfaces any of it: our own session
 * store remains the single browsing surface a user meets, which is the standing
 * posture F4's codex cell already records.
 *
 * **Gated on `NESSY_CLAUDE_SDK_E2E=1`** — the native binary is a ~290 MB
 * optional dependency, so a committed test that spawns it is a recorded local
 * run rather than a CI gate:
 *
 *   NESSY_CLAUDE_SDK_E2E=1 bun test ./packages/shared/src/agent/__tests__/claude-session-store-browse-e2e.test.ts
 *
 * The work happens in a CHILD (see the fixture's header): the SDK's readers
 * resolve their projects root from `process.env.CLAUDE_CONFIG_DIR` at call time,
 * and setting that in the shared runner would mutate a global every other suite
 * in the process shares.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ClaudeSessionStoreBrowseProbeResult } from './fixtures/claude-session-store-browse-probe.ts';

const ENABLED = process.env.NESSY_CLAUDE_SDK_E2E === '1';

const PROBE = new URL('./fixtures/claude-session-store-browse-probe.ts', import.meta.url).pathname;

async function runProbe(): Promise<ClaudeSessionStoreBrowseProbeResult> {
  // `NESSY_CONFIG_DIR` is exported BEFORE bun starts in the child — the only
  // form that isolates on every invocation shape (AGENTS.md: the root bunfig's
  // own top-level preload runs ahead of any CLI `--preload`).
  const isolated = mkdtempSync(join(tmpdir(), 'nessy-c374-host-cfg-'));
  const child = Bun.spawn(['bun', PROBE], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, NESSY_CONFIG_DIR: isolated },
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`probe exited ${code}: ${err}`);
  const line = out.trim().split('\n').filter(Boolean).pop();
  if (!line) throw new Error(`probe produced no result line. stderr: ${err}`);
  return JSON.parse(line) as ClaudeSessionStoreBrowseProbeResult;
}

describe.if(ENABLED)("C3.74 · the claude runtime's own session store, after a real turn", () => {
  test('a session this build created is listed, read and re-opened by the runtime\'s own API', async () => {
    const result = await runProbe();

    // CREATE — the row's own control: a session made by this build is there.
    expect(result.createdSessionId).toBeTruthy();
    const transcripts = result.storeFiles.filter(name => name.endsWith('.jsonl'));
    expect({ transcripts: transcripts.length }).toEqual({ transcripts: 1 });
    expect(transcripts[0]!.startsWith('projects/')).toBe(true);
    expect(transcripts[0]!.endsWith(`/${result.createdSessionId}.jsonl`)).toBe(true);

    // LIST — by project directory, and across every project.
    expect(result.listedSessionIds).toEqual([result.createdSessionId!]);
    expect(result.listedWithoutDir).toBeGreaterThanOrEqual(1);

    // READ — metadata and messages, with the summary the RUNTIME derived.
    expect(result.infoSessionId).toBe(result.createdSessionId);
    expect(result.infoSummary).toBeTruthy();
    expect(result.messageCount).toBeGreaterThanOrEqual(2);
    expect(result.messagesCarryThePrompt).toBe(true);

    // RE-OPEN — the same session, and its history really goes back on the wire.
    // The second half is what separates a re-open from a new session that
    // merely answers with a familiar id.
    expect({
      reopenedTheSameSession: result.reopenedSessionId === result.createdSessionId,
      historyOnTheWire: result.reopenedRequestCarriesHistory,
    }).toEqual({ reopenedTheSameSession: true, historyOnTheWire: true });

    // CONTROL — the readers can answer NO. Without this, every reading above is
    // "the API says yes to everything".
    expect(result.unknownIdInfo).toBeNull();
  }, 600_000);

  test('the store verbs are the SDK\'s own, and archive is not among them', () => {
    // Read from the vendored types rather than from this file's prose, so the
    // "partial" verdict's second half cannot rot: the day an archive verb
    // arrives, F4's claude cell has to be re-argued.
    const sdk = require('@anthropic-ai/claude-agent-sdk') as Record<string, unknown>;

    for (const verb of ['listSessions', 'getSessionInfo', 'getSessionMessages', 'deleteSession', 'renameSession', 'tagSession', 'forkSession']) {
      expect({ verb, declared: typeof sdk[verb] === 'function' }).toEqual({ verb, declared: true });
    }
    // The absences the verdict rests on, with the positive controls above as the
    // proof this probe can find a verb when there is one.
    for (const verb of ['archiveSession', 'unarchiveSession', 'searchSessions']) {
      expect({ verb, declared: typeof sdk[verb] === 'function' }).toEqual({ verb, declared: false });
    }
  });
});
