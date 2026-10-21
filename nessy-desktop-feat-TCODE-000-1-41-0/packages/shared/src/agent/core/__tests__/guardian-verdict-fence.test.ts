/**
 * F1.256 (release sitting SIT-i, 2026-09-25) — a verdict the judge wrapped in
 * ONE Markdown code fence is still the verdict.
 *
 * Measured in the sitting: in a Pi `bypassPermissions` session the deny-net
 * judge (`scout`, qwen36-35b) answered `no_objection` for a read-only compound
 * git command, but wrapped the JSON in a json-tagged fence although its prompt
 * says "no Markdown fences". `JSON.parse` refused it, the core called it
 * `malformed`, the result was `unsure`, and a bypass turn got a card. The judge
 * output quoted here is the one the sitting captured, shape for shape (a leading
 * space, the fence tag, one line).
 *
 * The tolerance is deliberately narrow: ONE fence around the WHOLE output, with
 * surrounding whitespace. Prose around a fence, two fences, or a fence that does
 * not close are still malformed, because a lenient extractor would let text the
 * judge wrote around its answer decide which object is "the" verdict.
 */
import { describe, expect, it } from 'bun:test';

import { runGuardianJudgeCore, type GuardianSpawn } from '../guardian-judge-core.ts';
import type { GuardianJudgeInput } from '../../../prompts/guardian.ts';

const INPUT: GuardianJudgeInput = {
  action: { command: 'cd /repo && git status && git rev-parse --abbrev-ref @{upstream} 2>&1', cwd: '/repo' },
  trustedIntent: '/code-review',
  facts: { mode: 'bypassPermissions', workspaceRoot: '/repo' },
};

const FENCE = '```';

function spawnReturning(texts: string[]): { spawn: GuardianSpawn; calls: () => number } {
  let calls = 0;
  const spawn: GuardianSpawn = async () => {
    const text = texts[Math.min(calls, texts.length - 1)] ?? '';
    calls += 1;
    return { status: 'done', text };
  };
  return { spawn, calls: () => calls };
}

async function judge(texts: string[]) {
  const { spawn, calls } = spawnReturning(texts);
  const result = await runGuardianJudgeCore({ input: INPUT, cwd: '/repo', spawn, timeoutMs: 5_000 });
  return { result, calls: calls() };
}

const SITTING_OUTPUT = ` ${FENCE}json { "verdict": "no_objection", "category": "low_risk", "reason": "The command is a read-only git query." } ${FENCE}`;

describe('F1.256 — a fenced guardian verdict', () => {
  it('the sitting\'s own output (json-tagged fence, leading space, one line) is a no_objection, on the FIRST attempt', async () => {
    const { result, calls } = await judge([SITTING_OUTPUT]);
    expect(result.verdict).toBe('no_objection');
    expect(result.failure).toBeUndefined();
    expect(result.reason).toBe('The command is a read-only git query.');
    // `low_risk` is in GUARDIAN_CATEGORIES, so the sanitizer keeps it.
    expect(result.category).toBe('low_risk');
    expect(calls).toBe(1);
  });

  it('a multi-line fence with no language tag is accepted too', async () => {
    const text = `\n${FENCE}\n{"verdict":"no_objection","reason":"read-only"}\n${FENCE}\n`;
    const { result, calls } = await judge([text]);
    expect(result.verdict).toBe('no_objection');
    expect(calls).toBe(1);
  });

  it('CONTROL — a fenced OBJECTING verdict still objects (the fence cannot turn a deny into a run)', async () => {
    const text = `${FENCE}json\n{"verdict":"deny","category":"data_exfiltration","reason":"sends credentials out"}\n${FENCE}`;
    const { result } = await judge([text]);
    expect(result.verdict).toBe('deny');
    expect(result.category).toBe('data_exfiltration');
  });

  it('CONTROL — an unfenced no_objection is unchanged', async () => {
    const { result, calls } = await judge(['{"verdict":"no_objection","reason":"routine"}']);
    expect(result.verdict).toBe('no_objection');
    expect(result.failure).toBeUndefined();
    expect(calls).toBe(1);
  });

  it('NEGATIVE — prose around the fence stays malformed (fail-closed to unsure after the retry)', async () => {
    const text = `Here is my verdict:\n${FENCE}json\n{"verdict":"no_objection","reason":"fine"}\n${FENCE}`;
    const { result, calls } = await judge([text]);
    expect(result.verdict).toBe('unsure');
    expect(result.failure).toBe('malformed');
    expect(calls).toBe(2);
  });

  it('NEGATIVE — two fenced objects, or an unclosed fence, stay malformed', async () => {
    const two = `${FENCE}json\n{"verdict":"deny","reason":"a"}\n${FENCE}\n${FENCE}json\n{"verdict":"no_objection","reason":"b"}\n${FENCE}`;
    const unclosed = `${FENCE}json\n{"verdict":"no_objection","reason":"fine"}`;
    expect((await judge([two])).result.failure).toBe('malformed');
    expect((await judge([unclosed])).result.failure).toBe('malformed');
  });

  it('NEGATIVE — a fenced out-of-vocabulary verdict is still refused', async () => {
    const text = `${FENCE}json\n{"verdict":"allow","reason":"looks fine"}\n${FENCE}`;
    const { result } = await judge([text]);
    expect(result.verdict).toBe('unsure');
    expect(result.failure).toBe('malformed');
  });
});
