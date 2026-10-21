/**
 * P6.352 (the Pi `/diff` arm) — `producesPerTurnFileSnapshots()` is READ FROM
 * THE TABLE, and the hardcoded `false` it replaces was wrong for two runtimes.
 *
 * The hand-off asked for `producesPerTurnFileSnapshots(): true` on `PiAgent`.
 * That would have been half a fix: `RUNTIME_FILE_CHECKPOINT_PRODUCERS` — this
 * product's single answer to "does a session on this runtime get its file edits
 * checkpointed", already read twice by `SessionManager` — records `pi` AND
 * `nestor-cloud-agent` as producers, so a `PiAgent`-only override would have
 * left the fourth backend still telling a user nothing was recorded.
 *
 * So the subject here is the DERIVATION. Every case reads the same table the
 * rewind path reads, which is what stops `/diff`'s sentence and the rewind's
 * `fileCheckpointsTracked` from ever disagreeing.
 */
import { describe, expect, it } from 'bun:test';
import {
  PER_TURN_AVAILABLE_LINE,
  PER_TURN_UNAVAILABLE_LINE,
  formatWorkingTreeDiffReport,
} from '../../slash-commands/diff-command.ts';
import { RUNTIME_FILE_CHECKPOINT_PRODUCERS } from '../../sessions/file-checkpoints.ts';
import type { BackendConfig } from '../backend/types.ts';
import { ClaudeAgent } from '../claude-agent.ts';

const WORKSPACE_ROOT = '/tmp/nessy-p6352-per-turn';

function agentConfig(): BackendConfig {
  return {
    provider: 'anthropic',
    providerType: 'anthropic',
    model: 'claude-sonnet-4-6',
    isHeadless: true,
    skipConfigWatcher: true,
    workspace: {
      id: 'ws-p6352-per-turn',
      name: 'P6.352 per-turn snapshots',
      rootPath: WORKSPACE_ROOT,
      workspaceRootPath: WORKSPACE_ROOT,
      sessionRootPath: `${WORKSPACE_ROOT}/sessions`,
    } as never,
    session: {
      id: 'session-p6352',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: WORKSPACE_ROOT,
    } as never,
  } as BackendConfig;
}

/** The protected reader, and its input — the one field it consults. */
function answersFor(provider: string): boolean {
  const agent = new ClaudeAgent(agentConfig()) as unknown as {
    config: { provider: string };
    producesPerTurnFileSnapshots(): boolean;
  };
  agent.config.provider = provider;
  return agent.producesPerTurnFileSnapshots();
}

describe('P6.352 · the per-turn snapshot answer comes from the checkpoint table', () => {
  it('answers every declared runtime exactly as the table declares it', () => {
    for (const [provider, declared] of Object.entries(RUNTIME_FILE_CHECKPOINT_PRODUCERS)) {
      const answered = answersFor(provider);
      expect({ provider, answered }).toEqual({ provider, answered: declared });
    }
    // Both directions are actually present in that loop, so it cannot pass on a
    // constant: the table declares two producers and two non-producers.
    const values = Object.values(RUNTIME_FILE_CHECKPOINT_PRODUCERS);
    expect(values).toContain(true);
    expect(values).toContain(false);
  });

  it('an unbuilt runtime claims nothing — the fail-safe the old default was chosen for', () => {
    expect(answersFor('some-runtime-nobody-has-written')).toBe(false);
  });

  it('a real claude session still says no per-turn snapshot, unchanged', () => {
    const agent = new ClaudeAgent(agentConfig()) as unknown as { producesPerTurnFileSnapshots(): boolean };
    expect(agent.producesPerTurnFileSnapshots()).toBe(false);
  });

  it('the sentence `/diff` prints follows it, and the two sentences never both appear', () => {
    const pi = formatWorkingTreeDiffReport(null, { perTurnSnapshots: answersFor('pi') });
    expect(pi).toContain(PER_TURN_AVAILABLE_LINE);
    expect(pi).not.toContain(PER_TURN_UNAVAILABLE_LINE);

    // C3.67 · the non-producer arm was `codex-runtime` until codex grew a real
    // producer (`CodexAgent.checkpointCodexFileChange`). `anthropic` is the
    // surviving one — the SDK checkpoints into its own store and
    // `Query.rewindFiles` still has no call site here — and the arm is kept
    // because a pair test with two identical arms is a deleted test that still
    // runs.
    const claude = formatWorkingTreeDiffReport(null, { perTurnSnapshots: answersFor('anthropic') });
    expect(claude).toContain(PER_TURN_UNAVAILABLE_LINE);
    expect(claude).not.toContain(PER_TURN_AVAILABLE_LINE);

    // And codex now takes the OTHER sentence, which is the user-visible half of
    // C3.67: `/diff` offers the turn's edits on a codex session.
    const codex = formatWorkingTreeDiffReport(null, { perTurnSnapshots: answersFor('codex-runtime') });
    expect(codex).toContain(PER_TURN_AVAILABLE_LINE);
    expect(codex).not.toContain(PER_TURN_UNAVAILABLE_LINE);
  });
});
