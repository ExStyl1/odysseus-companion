/**
 * R84 — the stop-hook block cap is a lever, not a constant.
 *
 * env-vars.md, the `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` row: "Maximum number of
 * consecutive times a Stop or SubagentStop hook may block the turn from ending
 * before Claude Code overrides it and ends the turn anyway (default: 8). Set to
 * `0` to disable the cap. Raise this if your hook legitimately needs more
 * iterations to resolve".
 *
 * These tests assert the CONSEQUENCE at the one read site
 * (`BaseAgent.recordHookBlockFeedback`) rather than the resolver's return value
 * — the resolver's own parsing contract is pinned separately in
 * `config/__tests__/stop-hook-block-cap.test.ts`. A resolver with no consumer is
 * the dead-code shape this unit exists to avoid, so every case here drives a
 * real `PiAgent` and reads what the next turn's user-message tail would carry.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { PiAgent } from '../pi-agent.ts';
import type { BackendConfig } from '../backend/types.ts';
import {
  STOP_HOOK_BLOCK_CAP_COMPAT_ENV_VAR,
  STOP_HOOK_BLOCK_CAP_ENV_VAR,
} from '../../config/stop-hook-block-cap.ts';

function createConfig(): BackendConfig {
  return {
    provider: 'pi',
    workspace: {
      id: 'ws-test',
      name: 'Test Workspace',
      rootPath: '/tmp/nessy-general-agent-test',
      workspaceRootPath: '/tmp/nessy-general-agent-test',
      sessionRootPath: '/tmp/nessy-general-agent-test-sessions/ws-test',
    } as never,
    session: {
      id: 'session-test',
      workspaceRootPath: '/tmp/nessy-general-agent-test',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    } as never,
    isHeadless: true,
  };
}

type BlockRecorder = {
  recordHookBlockFeedback: (event: string, result: unknown) => void;
  consumeHookBlockFeedback: () => string | undefined;
};

/**
 * Block `attempts` times in a row on one event and return everything the next
 * turn would actually receive. Each reason is uniquely numbered so the count of
 * delivered reasons is readable off the string.
 */
function blockConsecutively(event: string, attempts: number): string {
  const agent = new PiAgent(createConfig());
  const internals = agent as unknown as BlockRecorder;
  try {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      internals.recordHookBlockFeedback(event, {
        matchedCount: 1,
        decision: { decision: 'block', reason: `blocked ${attempt}` },
      });
    }
    return internals.consumeHookBlockFeedback() ?? '';
  } finally {
    agent.destroy();
  }
}

/** How many of the numbered reasons survived to the model. */
function deliveredCount(feedback: string, attempts: number): number {
  let count = 0;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (feedback.includes(`blocked ${attempt}\n`)) count++;
  }
  return count;
}

afterEach(() => {
  delete process.env[STOP_HOOK_BLOCK_CAP_ENV_VAR];
  delete process.env[STOP_HOOK_BLOCK_CAP_COMPAT_ENV_VAR];
});

describe('the stop-hook block cap responds to its documented env knob', () => {
  it('caps at the documented 8 when the knob is unset', () => {
    // The control the other cases are measured against: without the env var,
    // exactly 8 consecutive blocks are honoured and the 9th is suppressed.
    const feedback = blockConsecutively('Stop', 12);
    expect(deliveredCount(feedback, 12)).toBe(8);
    expect(feedback).toContain('blocked 8');
    expect(feedback).not.toContain('blocked 9');
  });

  it('a raised cap allows MORE consecutive blocks than the default', () => {
    process.env[STOP_HOOK_BLOCK_CAP_ENV_VAR] = '12';
    const feedback = blockConsecutively('Stop', 15);
    // The 9th block — dead on the default — now reaches the model, and the
    // suppression moves to the 13th.
    expect(feedback).toContain('blocked 9');
    expect(feedback).toContain('blocked 12');
    expect(feedback).not.toContain('blocked 13');
    expect(deliveredCount(feedback, 15)).toBe(12);
  });

  it('a lowered cap allows FEWER consecutive blocks than the default', () => {
    process.env[STOP_HOOK_BLOCK_CAP_ENV_VAR] = '2';
    const feedback = blockConsecutively('Stop', 8);
    expect(deliveredCount(feedback, 8)).toBe(2);
    expect(feedback).not.toContain('blocked 3');
  });

  it('`0` disables the cap — the blocks are delivered without limit', () => {
    process.env[STOP_HOOK_BLOCK_CAP_ENV_VAR] = '0';
    const feedback = blockConsecutively('Stop', 40);
    expect(deliveredCount(feedback, 40)).toBe(40);
    expect(feedback).toContain('blocked 40');
  });

  it('applies the knob to SubagentStop, the second event the row names', () => {
    process.env[STOP_HOOK_BLOCK_CAP_ENV_VAR] = '10';
    const feedback = blockConsecutively('SubagentStop', 12);
    expect(deliveredCount(feedback, 12)).toBe(10);
    expect(feedback).toContain('blocked 10');
    expect(feedback).not.toContain('blocked 11');
  });

  it('honours the CLAUDE_CODE_ compat spelling', () => {
    process.env[STOP_HOOK_BLOCK_CAP_COMPAT_ENV_VAR] = '12';
    const feedback = blockConsecutively('Stop', 15);
    expect(deliveredCount(feedback, 15)).toBe(12);
    expect(feedback).toContain('blocked 9');
  });

  it('lets the Nessy name win when both spellings are set', () => {
    process.env[STOP_HOOK_BLOCK_CAP_ENV_VAR] = '3';
    process.env[STOP_HOOK_BLOCK_CAP_COMPAT_ENV_VAR] = '12';
    const feedback = blockConsecutively('Stop', 15);
    expect(deliveredCount(feedback, 15)).toBe(3);
    expect(feedback).not.toContain('blocked 4');
  });

  // A typo must never silently buy an uncapped loop: every malformed value
  // lands back on 8, not on 0 and not on "no cap".
  //
  // `1e3` LEFT this list in `1fcaa499f`: this key's `env-vars.md` row notes no
  // plain-digits restriction, so it takes the page's general numeric rule —
  // *"Claude Code reads `2e3` as 2000 and `64_000` as 64000"* — and the parser
  // was corrected to match while this lever test kept the old expectation. The
  // successor is asserted below rather than merely deleted here, so the pair
  // cannot be satisfied by dropping both.
  it.each(['abc', '-1', '1.5', '', ' ', '0x8'])(
    'falls back to the documented 8 for the malformed value %j',
    (raw) => {
      process.env[STOP_HOOK_BLOCK_CAP_ENV_VAR] = raw;
      const feedback = blockConsecutively('Stop', 12);
      expect(deliveredCount(feedback, 12)).toBe(8);
      expect(feedback).not.toContain('blocked 9');
    },
  );

  it.each(['1e1', '1_0'])(
    'carries the page general numeric spelling %j all the way to the delivered blocks',
    (raw) => {
      // Both spell TEN. Read end to end rather than off the resolver, because
      // that is this file's job: the parse is pinned in
      // `config/__tests__/stop-hook-block-cap.test.ts`, the LEVER is pinned here.
      process.env[STOP_HOOK_BLOCK_CAP_ENV_VAR] = raw;
      const feedback = blockConsecutively('Stop', 12);
      expect(deliveredCount(feedback, 12)).toBe(10);
      expect(feedback).toContain('blocked 10');
      expect(feedback).not.toContain('blocked 11');
    },
  );

  it('leaves ConfigChange on the fixed 8 — the row names two events, not three', () => {
    // Our ConfigChange block shares the same streak counter but is not one of
    // the documented events, so the knob must not reach it.
    process.env[STOP_HOOK_BLOCK_CAP_ENV_VAR] = '20';
    const feedback = blockConsecutively('ConfigChange', 12);
    expect(deliveredCount(feedback, 12)).toBe(8);
    expect(feedback).not.toContain('blocked 9');
  });

  it('still resets the streak on a non-blocking result under a raised cap', () => {
    process.env[STOP_HOOK_BLOCK_CAP_ENV_VAR] = '2';
    const agent = new PiAgent(createConfig());
    const internals = agent as unknown as BlockRecorder;
    try {
      for (let attempt = 1; attempt <= 3; attempt++) {
        internals.recordHookBlockFeedback('Stop', {
          matchedCount: 1,
          decision: { decision: 'block', reason: `blocked ${attempt}` },
        });
      }
      internals.recordHookBlockFeedback('Stop', { matchedCount: 1 });
      internals.recordHookBlockFeedback('Stop', {
        matchedCount: 1,
        decision: { decision: 'block', reason: 'heard again' },
      });
      const feedback = internals.consumeHookBlockFeedback() ?? '';
      expect(feedback).not.toContain('blocked 3');
      expect(feedback).toContain('heard again');
    } finally {
      agent.destroy();
    }
  });
});
