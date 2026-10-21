/**
 * P6.580 — codex's "Model metadata for `X` not found" warning is a CONSTANT on
 * this product, and surfaced alone it reads as a verdict about the user's model.
 *
 * W6-l measured it (P6.164, `437a9b7f4`) by driving the shipped binary: an id no
 * catalogue serves is forwarded verbatim and the turn completes, and the CONTROL
 * arm pinned to the gateway's own default emits the identical sentence with its
 * own id. So the warning fires on every Nessy codex session.
 *
 * WHAT EACH TEST KILLS:
 *  - "adds the caveat" dies if the mount is removed — the row.
 *  - "fires for the SHIPPED DEFAULT model too" is the row's required control: it
 *    is the whole reason the caveat exists, and it dies the moment someone
 *    narrows the caveat to ids that "look unresolvable", which would restore the
 *    false signal.
 *  - "leaves other warnings alone" dies if the marker match is widened; the
 *    under-development warning is a real signal and must not collect a caveat
 *    saying it means nothing.
 *  - "says it once" dies if the latch is dropped (the notice queue is 8 deep).
 */
import { describe, expect, it } from 'bun:test';
import type { BackendConfig } from '../backend/types.ts';
import { CodexAgent } from '../codex-agent.ts';

interface Event { type: string; message?: string; level?: string }

const GATEWAY_DEFAULT = 'tgpt/qwen35-397b-a17b-fp8';

function createConfig(model: string): BackendConfig {
  return {
    provider: 'codex-runtime',
    workspace: {
      id: 'ws-codex-model-metadata',
      name: 'Codex Model Metadata Workspace',
      rootPath: '/tmp/ws-codex-model-metadata-root',
      workspaceRootPath: '/tmp/ws-codex-model-metadata-root',
      sessionRootPath: '/tmp/nessy-general-agent-test-sessions/ws-codex-model-metadata',
    } as any,
    session: {
      id: 'session-codex-model-metadata',
      workspaceRootPath: '/tmp/ws-codex-model-metadata-root',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: '/tmp/project-root',
    } as any,
    model,
    isHeadless: true,
  };
}

function harness(model: string) {
  const agent = new CodexAgent(createConfig(model));
  const events: Event[] = [];
  const internals = agent as unknown as {
    turnSink: { push: (e: Event) => void } | null;
    noteCodexServerWarning: (params: unknown) => void;
  };
  internals.turnSink = { push: (e: Event) => events.push(e) };
  return {
    events,
    warn: (message: string) => internals.noteCodexServerWarning({ message }),
    caveats: () => events.filter(e => (e.message ?? '').includes('constant')),
  };
}

/** codex's own sentence, verbatim from the P6.164 run. */
function metadataWarning(id: string): string {
  return `Model metadata for \`${id}\` not found. Defaulting to fallback metadata; `
    + 'this can degrade performance and cause issues.';
}

describe('P6.580 · the model-metadata warning is a constant, and the host says so', () => {
  it('adds a caveat naming the id this session asked for', () => {
    const h = harness('opus');
    h.warn(metadataWarning('opus'));
    // codex's own sentence is still surfaced — nothing is hidden.
    expect(h.events.some(e => (e.message ?? '').includes('Model metadata'))).toBe(true);
    const caveat = h.caveats();
    expect(caveat).toHaveLength(1);
    expect(caveat[0]!.message).toContain('opus');
    expect(caveat[0]!.level).toBe('warning');
  });

  it('fires for the gateway default model too — the control the row asked for', () => {
    const h = harness(GATEWAY_DEFAULT);
    h.warn(metadataWarning(GATEWAY_DEFAULT));
    const caveat = h.caveats();
    expect(caveat).toHaveLength(1);
    expect(caveat[0]!.message).toContain(GATEWAY_DEFAULT);
  });

  it('leaves a warning of another class alone', () => {
    const h = harness('opus');
    h.warn('The following under-development features are enabled: request_permissions_tool.');
    expect(h.caveats()).toHaveLength(0);
    // Positive control on the same rig.
    h.warn(metadataWarning('opus'));
    expect(h.caveats()).toHaveLength(1);
  });

  it('says it once, however many threads warn', () => {
    const h = harness('opus');
    for (let i = 0; i < 5; i += 1) h.warn(metadataWarning('opus'));
    expect(h.caveats()).toHaveLength(1);
  });
});

/**
 * F1.734 — codex repeats the constant on EVERY turn (the 1.41.0 sitting, SIT-d:
 * one "Model metadata … not found" row per codex turn). The first sighting keeps
 * codex's own sentence beside the caveat; every later one goes to the debug log.
 */
describe('F1.734 · a repeated model-metadata warning goes to the debug log', () => {
  it('surfaces codex\'s sentence once, then logs each repeat instead of adding a row', () => {
    const agent = new CodexAgent(createConfig('opus'));
    const events: Event[] = [];
    const debug: string[] = [];
    const internals = agent as unknown as {
      turnSink: { push: (e: Event) => void } | null;
      onDebug: ((m: string) => void) | null;
      noteCodexServerWarning: (params: unknown) => void;
    };
    internals.turnSink = { push: e => events.push(e) };
    internals.onDebug = m => debug.push(m);
    for (let i = 0; i < 4; i += 1) internals.noteCodexServerWarning({ message: metadataWarning('opus') });
    expect(events.filter(e => (e.message ?? '').startsWith('Codex: Model metadata'))).toHaveLength(1);
    expect(events.filter(e => (e.message ?? '').includes('constant'))).toHaveLength(1);
    expect(debug.filter(line => line.includes('Model metadata for `opus` not found'))).toHaveLength(3);
  });

  it('BOUNDARY: a repeated warning of another class still reaches the transcript each time', () => {
    const h = harness('opus');
    h.warn(metadataWarning('opus'));
    const other = 'The following under-development features are enabled: request_permissions_tool.';
    h.warn(other);
    h.warn(other);
    expect(h.events.filter(e => e.message === `Codex: ${other}`)).toHaveLength(2);
  });
});
