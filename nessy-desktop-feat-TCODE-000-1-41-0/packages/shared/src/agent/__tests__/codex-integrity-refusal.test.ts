/**
 * Q5-D2: a refused Codex runtime must SAY so.
 *
 * Measured on the 1.25.1 acceptance gate against a deliberately tampered nested
 * binary: the turn left the user's message in the transcript and produced no
 * assistant reply, no error row and no toast (`MESSAGES: 1`, `TOASTS: []`). The
 * refusal itself is correct — the integrity seatbelt doing its job — but a
 * packaged build writes no application log, so the logged reason was invisible
 * too and the runtime simply did not answer.
 *
 * The established surface for "this runtime cannot start" is the one every other
 * fatal backend failure already uses: an `error` AgentEvent out of `chatImpl`,
 * which `SessionManager.processEvent` turns into a `role: 'error'` transcript row
 * (`case 'error'`), exactly like `pi-agent.ts`'s unknown-error branch and
 * `base-agent.ts`'s "Skill(s) not found". No new channel is invented here.
 *
 * The first case drives the REAL `verifyCodexBinary` against real tampered bytes
 * rather than a hand-made error, so it fails the same way the live case did.
 */
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent } from '@nessy-agent/core/types';
import { verifyCodexBinary } from '@nessy-agent/codex-agent-server';
import type { BackendConfig } from '../backend/types.ts';
import { CodexAgent } from '../codex-agent.ts';

function createConfig(): BackendConfig {
  return {
    provider: 'codex-runtime',
    workspace: {
      id: 'ws-integrity',
      name: 'Test Workspace',
      rootPath: '/tmp/ws-root',
      workspaceRootPath: '/tmp/ws-root',
      sessionRootPath: '/tmp/nessy-general-agent-test-sessions/ws-integrity',
    } as any,
    session: {
      id: 'session-integrity',
      workspaceRootPath: '/tmp/ws-root',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: '/tmp/project-root',
    } as any,
    model: 'codex/test-model',
    isHeadless: true,
  } as unknown as BackendConfig;
}

/** Collect a turn's events. A THROW here is the defect: it reaches no user. */
async function collect(agent: CodexAgent, prompt: string): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of (agent as any).chatImpl(prompt)) events.push(event);
  return events;
}

/** A temp file whose bytes match no pin — the tampered binary, minus 207 MB. */
function tamperedBinary(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'codex-integrity-'));
  const path = join(dir, 'codex-app-server');
  writeFileSync(path, Buffer.from('tampered-bytes'));
  return { dir, path };
}

describe('CodexAgent — a refused runtime is visible to the user', () => {
  it('turns the verifier refusal into an error event and a completed turn', async () => {
    const { dir, path } = tamperedBinary();
    const agent = new CodexAgent(createConfig());
    (agent as any).ensureRuntime = async () => {
      // The real gate, on real mismatching bytes. The signature arm is stubbed so
      // the case is platform-independent (`codesign` is macOS-only) and does not
      // hash a file for 1.7 s; the arm it exercises is the same one either way.
      verifyCodexBinary(path, 'darwin-arm64', {
        checkSignature: () => ({ trusted: false, reason: 'requirement-unsatisfied' }),
      });
    };

    const events = await collect(agent, 'hello');
    rmSync(dir, { recursive: true, force: true });

    const errors = events.filter((event): event is AgentEvent & { type: 'error' } => event.type === 'error');
    expect(errors).toHaveLength(1);
    const message = errors[0]!.message;
    // Honest and actionable: it names what happened and what to do about it.
    expect(message).toMatch(/integrity check/i);
    expect(message).toMatch(/reinstall/i);
    // The diagnostic half stays out of it: no digests, no filesystem layout.
    expect(message).not.toMatch(/[0-9a-f]{64}/);
    expect(message).not.toContain(path);
    expect(message).not.toContain(tmpdir());
    // The turn ends rather than hanging — `sendMessage`'s loop stops at `complete`.
    expect(events.at(-1)?.type).toBe('complete');
  });

  it('leaves every other startup failure propagating exactly as before', async () => {
    const agent = new CodexAgent(createConfig());
    (agent as any).ensureRuntime = async () => {
      throw new Error('codex thread/start returned no thread id');
    };

    await expect(collect(agent, 'hello')).rejects.toThrow(/thread\/start returned no thread id/);
  });
});
