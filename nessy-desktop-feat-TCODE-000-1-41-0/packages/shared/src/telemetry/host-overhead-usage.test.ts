/**
 * P3.98 + P3.122 — recognising a host-overhead call, and shaping it for the
 * separate line `usage-metrics.ts` exports.
 *
 * The detector's whole job is to be right about ONE thing: the SDK's auto-mode
 * classifier reaches our gateway through the same loopback adapter as every
 * conversation request, and asking for its own default model
 * (`claude-sonnet-5`) it FALLS BACK to the session's model — measured by P3.121,
 * and the reason a model-id detector would either miss every hop or misattribute
 * every turn. The system prompt is the thing that differs, so that is what is
 * read.
 *
 * These tests do not claim the counting happens: nothing calls this module yet,
 * and `host-overhead-usage.ts` says so in its own docblock along with the exact
 * one-line wiring and whose file it lives in.
 */
import { describe, expect, it } from 'bun:test';
import {
  CLAUDE_AUTO_MODE_CLASSIFIER_SYSTEM_MARKER,
  HOST_OVERHEAD_SOURCES,
  classifyHostOverheadSource,
  hostOverheadTurn,
} from './host-overhead-usage.ts';
import { collectSeries } from './usage-metrics.ts';

const CLASSIFIER_PROMPT = `${CLAUDE_AUTO_MODE_CLASSIFIER_SYSTEM_MARKER}. You review each tool call…`;

describe('classifyHostOverheadSource', () => {
  it('recognises the classifier from a string system prompt', () => {
    expect(classifyHostOverheadSource(CLASSIFIER_PROMPT))
      .toBe(HOST_OVERHEAD_SOURCES.autoModeClassifier);
  });

  it('recognises it from an array of content blocks, which the wire also allows', () => {
    expect(classifyHostOverheadSource([
      { type: 'text', text: CLASSIFIER_PROMPT },
      { type: 'text', text: 'and here are the deployment rules we spliced in' },
    ])).toBe(HOST_OVERHEAD_SOURCES.autoModeClassifier);
  });

  it('matches on the PREFIX, so our own policy edits cannot silence it', () => {
    // `claude-auto-mode-policy.ts` splices deployment rules into the tail of the
    // ~110 KB prompt. A hash or a length check would stop detecting the day that
    // policy changed — which is a detector that fails silently.
    expect(classifyHostOverheadSource(`${CLASSIFIER_PROMPT}\n\n<rules>…</rules>`))
      .toBe(HOST_OVERHEAD_SOURCES.autoModeClassifier);
  });

  it('NEGATIVE CONTROL: an ordinary conversation prompt is not overhead', () => {
    expect(classifyHostOverheadSource('You are Nessy, a helpful coding assistant.')).toBeNull();
    expect(classifyHostOverheadSource([{ type: 'text', text: 'You are a helpful assistant' }])).toBeNull();
  });

  it('answers null rather than throwing on anything the wire should not carry', () => {
    // It runs on a request path. A detector that can throw is a detector that
    // can fail a turn.
    for (const junk of [undefined, null, 42, {}, [{ type: 'image' }], [null], ['']]) {
      expect(classifyHostOverheadSource(junk)).toBeNull();
    }
  });
});

describe('hostOverheadTurn', () => {
  it('marks the turn as overhead and names its source', () => {
    const turn = hostOverheadTurn(HOST_OVERHEAD_SOURCES.autoModeClassifier, {
      backend: 'anthropic',
      model: 'tgpt/qwen35-397b-a17b-fp8',
      inputTokens: 24_200,
      outputTokens: 12,
    });
    expect(turn.scope).toBe('host-overhead');
    expect(turn.overheadSource).toBe('auto-mode-classifier');
    expect(turn.inputTokens).toBe(24_200);
  });

  it('never claims a cost, because nothing on this path establishes one', () => {
    // The gateway's reply carries token counts and no money field; a price table
    // invented here would put fiction on an operator's cost line. Same rule
    // `base-agent.ts` states for the budget ceiling.
    const turn = hostOverheadTurn(HOST_OVERHEAD_SOURCES.autoModeClassifier, {
      backend: 'anthropic', model: 'm', inputTokens: 1,
    });
    expect(turn.costReporting).toBe('unsupported');
    expect(turn.costUsd).toBeUndefined();
    expect(collectSeries(turn)[0]![1].costReported).toBe(false);
  });

  it('folds into a host-overhead series, not into the conversation one for that model', () => {
    const overhead = collectSeries(hostOverheadTurn(HOST_OVERHEAD_SOURCES.autoModeClassifier, {
      backend: 'anthropic', model: 'm', inputTokens: 24_200,
    }));
    const conversation = collectSeries({ backend: 'anthropic', model: 'm', inputTokens: 24_200 });
    expect(overhead[0]![0]).not.toBe(conversation[0]![0]);
  });
});
