/**
 * H52 (UB2.6) — an OFFLINE pin of how the installed Pi SDK delivers steers at
 * model boundaries. F1.244's FIFO replay and the mid-stream steer door both
 * hand the backend one `redirect` per message, so what the SDK does with the
 * queue is load-bearing; the pin makes it explicit and is the guard for
 * UB8.2's Pi 1.1.0 lift.
 *
 * Copied+adapted from craft-agents-oss v0.13.4/v0.15.1
 * `packages/pi-agent-server/src/steering-sdk.test.ts` (Apache-2.0; the file is
 * byte-identical between those tags), with the expectations MEASURED on the Pi
 * this tree ships — 0.87.1 (UA12.211), probe run 2026-10-15:
 *
 *   CALLS after steers:        [["initial"]]
 *   CALLS after release 1:     [["initial"], ["initial","A"]]
 *   CALLS after release 2:     [["initial","A","B"]]  — one steer per boundary
 *
 * **0.87.1 delivers ONE queued steer per model call**, where the Pi the
 * upstream tags run (0.85.x there, 1.1.0 at v0.15.1, whose green test is the
 * same script) BATCHES A/B/C into the next call (`['initial','A','B','C']`).
 * A steer the boundary has not reached still holds the turn open, so every
 * pending call is released before `await turn`.
 *
 * **UB8.2: this pin is EXPECTED to fail on 1.1.0** — the batched shape returns,
 * and the assertions below must be re-derived to upstream's script (kept
 * verbatim in the citation above) with the same no-network rig.
 *
 * The provider never resolves (`baseUrl: 'https://invalid.test'`, a
 * `streamSimple` that throws) — the test fails on any network reach. The
 * settings manager is ours (`SettingsManager.inMemory`, `projectTrusted:
 * false`, the `gateway-retry-settings.test.ts` shape).
 */
import { expect, it } from 'bun:test';
import { createAgentSession, createExtensionRuntime, SessionManager, type ModelRuntime, type ResourceLoader, SettingsManager } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream, type AssistantMessage, type Model } from '@earendil-works/pi-ai';

it('the installed SDK (0.87.1) delivers one queued steer per model boundary, none lost', async () => {
  const model: Model<'openai-responses'> = {
    id: 'offline-steering-test', name: 'Offline', api: 'openai-responses', provider: 'openai',
    baseUrl: 'https://invalid.test', reasoning: false, input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096,
  };
  const resourceLoader: ResourceLoader = {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }), getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => 'Offline steering test', getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [], extendResources: () => {}, reload: async () => {},
  };
  const { session } = await createAgentSession({
    cwd: import.meta.dir, model, settingsManager: SettingsManager.inMemory({}, { projectTrusted: false }),
    sessionManager: SessionManager.inMemory(import.meta.dir), resourceLoader, tools: [],
    modelRuntime: {
      hasConfiguredAuth: () => true, getModel: () => model, getAvailableSnapshot: () => [model],
      streamSimple: () => { throw new Error('Provider/network access is forbidden'); },
    } as unknown as ModelRuntime,
  });
  const calls: string[][] = [];
  const releases: (() => void)[] = [];
  session.agent.streamFunction = (_model, context, options) => {
    calls.push(context.messages.filter(m => m.role === 'user').map(m =>
      typeof m.content === 'string' ? m.content : m.content.filter(c => c.type === 'text').map(c => c.text).join('')));
    const stream = createAssistantMessageEventStream();
    let finished = false;
    const finish = (reason: 'stop' | 'aborted' = 'stop') => {
      if (finished) return;
      finished = true;
      const message: AssistantMessage = {
        role: 'assistant', content: [{ type: 'text', text: 'done' }], api: model.api, provider: model.provider,
        model: model.id, timestamp: Date.now(), stopReason: reason,
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      stream.push({ type: 'start', partial: { ...message, content: [], stopReason: 'pending' } });
      if (reason === 'aborted') stream.push({ type: 'error', reason, error: message });
      else stream.push({ type: 'done', reason, message });
    };
    releases.push(() => finish());
    options?.signal?.addEventListener('abort', () => finish('aborted'), { once: true });
    if (options?.signal?.aborted) finish('aborted');
    return stream;
  };
  const waitForCalls = async (count: number) => {
    for (let i = 0; calls.length < count && i < 500; i++) await Bun.sleep(2);
    expect(calls).toHaveLength(count);
  };
  const turn = session.prompt('initial');
  try {
    await waitForCalls(1);
    for (const text of ['A', 'B', 'C']) await session.steer(text);
    // CONTROL — no interrupt, no dequeue: the first stream still owns its call
    // while all three steers wait.
    expect(calls).toHaveLength(1);

    releases[0]!();
    await waitForCalls(2);
    // One steer per boundary: A alone rides the second call.
    expect(calls[1]).toEqual(['initial', 'A']);

    releases[1]!();
    await waitForCalls(3);
    expect(calls[2]).toEqual(['initial', 'A', 'B']);

    // A steer sent MID-call does not join the running call.
    await session.steer('D');
    expect(calls[2]).not.toContain('D');

    // C and D each take their own boundary; release as they appear so the
    // undelivered steers cannot hold the turn open past the last release.
    releases[2]!();
    await waitForCalls(4);
    expect(calls[3]).toEqual(['initial', 'A', 'B', 'C']);
    releases[3]!();
    await waitForCalls(5);
    expect(calls[4]).toEqual(['initial', 'A', 'B', 'C', 'D']);
    releases[4]!();
    await turn;
    // Nothing was lost: every steer reached the model exactly once, in order.
    expect(calls).toHaveLength(5);
  } finally {
    session.clearQueue();
    await session.abort();
    await turn;
    session.dispose();
  }
}, 10000);
