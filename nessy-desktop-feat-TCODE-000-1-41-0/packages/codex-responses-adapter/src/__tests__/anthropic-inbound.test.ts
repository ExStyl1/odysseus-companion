/**
 * Contract tests for the vendored Anthropic Messages -> /v1/responses inbound
 * translation (`../anthropic/inbound.ts`).
 *
 * Adapted from opencodex `tests/claude-inbound.test.ts` @ 16bef04 (MIT). Slices that
 * exercised opencodex-only behaviour are NOT ported as-is: alias/modelMap resolution,
 * the `ocx-route` directive, the `prompt_cache_key` cohort hash and bundled-skill
 * elision are stripped in this fork, so the assertions below pin the STRIPPED
 * contract (model passthrough, no cache key) instead of the upstream one.
 */
import { describe, expect, test } from 'bun:test';
import {
  AnthropicRequestError,
  anthropicToResponsesBody,
  anthropicToResponsesTranslation,
  effortForThinkingBudget,
  effortFromOutputConfig,
} from '../anthropic/inbound.ts';
import { toChatRequest } from '../to-chat.ts';

/** `anthropicToResponsesBody` with loose typing — these tests assert wire shape. */
function translate(raw: unknown): Record<string, any> {
  return anthropicToResponsesBody(raw) as Record<string, any>;
}

const MINIMAL = { model: 'm', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] };

/** Full Claude Code-shaped request: system array, tool cycle, image, thinking, options. */
function claudeCodeRequest(): Record<string, unknown> {
  return {
    model: 'tgpt/qwen35-397b-a17b-fp8',
    max_tokens: 8192,
    stream: true,
    system: [
      { type: 'text', text: 'You are Claude Code.' },
      { type: 'text', text: 'Prefer terse answers.' },
    ],
    messages: [
      { role: 'user', content: 'read the README' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'I should read it', signature: 'sig123' },
          { type: 'text', text: 'Reading it now.' },
          { type: 'tool_use', id: 'toolu_01', name: 'Read', input: { file_path: '/README.md' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_01', content: [{ type: 'text', text: '# hello' }] },
          { type: 'text', text: 'now summarize' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aWc=' } },
        ],
      },
    ],
    tools: [
      { name: 'Read', description: 'Read a file', input_schema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } },
      { type: 'web_search_20250305', name: 'web_search', max_uses: 5 },
    ],
    tool_choice: { type: 'auto', disable_parallel_tool_use: true },
    thinking: { type: 'enabled', budget_tokens: 10000 },
    temperature: 0.7,
    top_p: 0.9,
    top_k: 40,
    stop_sequences: ['STOP'],
    metadata: { user_id: 'user-abc' },
  };
}

describe('anthropic inbound: full request mapping', () => {
  test('content/tool/option mapping round-trips', () => {
    const body = translate(claudeCodeRequest());
    expect(body.model).toBe('tgpt/qwen35-397b-a17b-fp8');
    expect(body.instructions).toBe('You are Claude Code.\n\nPrefer terse answers.');
    expect(body.max_output_tokens).toBe(8192);
    expect(body.temperature).toBe(0.7);
    expect(body.top_p).toBe(0.9);
    expect(body.top_k).toBeUndefined(); // documented drop: no Responses equivalent
    expect(body.stop).toEqual(['STOP']);
    expect(body.user).toBe('user-abc');
    expect(body.store).toBe(false);
    expect(body.stream).toBe(true);
    expect(body.parallel_tool_calls).toBe(false);
    expect(body.tool_choice).toBe('auto');
    expect(body.reasoning).toEqual({ summary: 'auto', effort: 'medium' });

    const tools = body.tools as Record<string, any>[];
    expect(tools).toHaveLength(2);
    expect(tools[0]).toEqual({
      type: 'function', name: 'Read', description: 'Read a file',
      parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] },
    });
    expect(tools[1]).toEqual({ type: 'web_search' });
  });

  test('block order is preserved: tool_result splits the surrounding user message', () => {
    const input = translate(claudeCodeRequest()).input as Record<string, any>[];
    // user text, assistant text (thinking dropped), function_call, function_call_output, user tail
    expect(input.map(i => i.type)).toEqual(['message', 'message', 'function_call', 'function_call_output', 'message']);
    expect(input[0]).toEqual({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'read the README' }] });
    expect(input[1]!.content).toEqual([{ type: 'output_text', text: 'Reading it now.' }]);
    expect(input[2]).toMatchObject({ call_id: 'toolu_01', name: 'Read', arguments: JSON.stringify({ file_path: '/README.md' }) });
    expect(input[3]).toMatchObject({ call_id: 'toolu_01', output: [{ type: 'input_text', text: '# hello' }] });
    const tail = input[4]!.content as Record<string, any>[];
    expect(tail[0]).toEqual({ type: 'input_text', text: 'now summarize' });
    expect(tail[1]).toEqual({ type: 'input_image', image_url: 'data:image/png;base64,aWc=' });
  });

  test('the translated body is accepted by this package own Responses->chat mapper', () => {
    const chat = toChatRequest(translate(claudeCodeRequest()));
    expect(chat.model).toBe('tgpt/qwen35-397b-a17b-fp8');
    expect(chat.messages[0]).toEqual({ role: 'system', content: 'You are Claude Code.\n\nPrefer terse answers.' });
    expect(chat.messages.some(m => m.role === 'tool')).toBe(true);
    expect(chat.tools?.[0]?.function.name).toBe('Read');
  });

  test('local change: model passes through verbatim (no alias / modelMap layer)', () => {
    expect(translate({ ...MINIMAL, model: 'claude-sonnet-4-5' }).model).toBe('claude-sonnet-4-5');
    expect(translate({ ...MINIMAL, model: 'claude-opus-4-20250514' }).model).toBe('claude-opus-4-20250514');
  });

  test('local change: no prompt_cache_key is synthesized on any path', () => {
    for (const raw of [
      MINIMAL,
      { ...MINIMAL, system: 'be nice' },
      { ...MINIMAL, metadata: { user_id: 'user-abc' } },
      { ...MINIMAL, system: 'be nice', metadata: { user_id: 'user-abc' } },
    ]) {
      expect(translate(raw).prompt_cache_key).toBeUndefined();
    }
  });

  test('anthropicToResponsesTranslation wraps the same body', () => {
    const { body } = anthropicToResponsesTranslation(claudeCodeRequest());
    expect(body.model).toBe('tgpt/qwen35-397b-a17b-fp8');
    expect(Array.isArray(body.input)).toBe(true);
  });
});

describe('anthropic inbound: system folding', () => {
  test('string system becomes instructions', () => {
    expect(translate({ ...MINIMAL, system: 'top-level' }).instructions).toBe('top-level');
  });

  test('empty / absent system leaves instructions unset', () => {
    expect(translate(MINIMAL).instructions).toBeUndefined();
    expect(translate({ ...MINIMAL, system: '' }).instructions).toBeUndefined();
    expect(translate({ ...MINIMAL, system: [] }).instructions).toBeUndefined();
  });

  test('block-array system folds text blocks with a blank line', () => {
    const body = translate({
      ...MINIMAL,
      system: [{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }],
    });
    expect(body.instructions).toBe('a\n\nb');
  });

  test('role:"system" messages fold into instructions, never into input', () => {
    const body = translate({
      model: 'm', max_tokens: 10,
      system: 'top-level',
      messages: [
        { role: 'system', content: 'be terse' },
        { role: 'system', content: [{ type: 'text', text: 'block form' }] },
        { role: 'user', content: 'hi' },
      ],
    });
    expect(body.instructions).toBe('top-level\n\nbe terse\n\nblock form');
    expect((body.input as Record<string, any>[]).every(i => i.role !== 'system')).toBe(true);
    expect(body.input).toHaveLength(1);
  });
});

describe('anthropic inbound: tool_result', () => {
  function outputFor(raw: unknown): unknown {
    const input = translate(raw).input as Record<string, any>[];
    return input.find(i => i.type === 'function_call_output')?.output;
  }

  const toolCycle = (result: Record<string, unknown>) => ({
    model: 'm', max_tokens: 10,
    messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', ...result }] },
    ],
  });

  test('string content passes through; is_error prefixes the marker', () => {
    expect(outputFor(toolCycle({ content: 'ok' }))).toBe('ok');
    expect(outputFor(toolCycle({ content: 'boom', is_error: true }))).toBe('[tool error] boom');
  });

  test('block content maps to input_text/input_image; is_error unshifts the marker', () => {
    expect(outputFor(toolCycle({ content: [{ type: 'text', text: '# hello' }] })))
      .toEqual([{ type: 'input_text', text: '# hello' }]);
    expect(outputFor(toolCycle({
      content: [{ type: 'text', text: 'bad' }],
      is_error: true,
    }))).toEqual([{ type: 'input_text', text: '[tool error]' }, { type: 'input_text', text: 'bad' }]);
    expect(outputFor(toolCycle({
      content: [{ type: 'image', source: { type: 'url', url: 'https://x/y.png' } }],
    }))).toEqual([{ type: 'input_image', image_url: 'https://x/y.png' }]);
  });

  test('missing / empty content degrades to a marker, not a throw', () => {
    expect(outputFor(toolCycle({}))).toBe('');
    expect(outputFor(toolCycle({ is_error: true }))).toBe('[tool error]');
    expect(outputFor(toolCycle({ content: [] }))).toBe('');
    // Array content keeps the array shape: the marker is unshifted, so an errored
    // empty result is a one-element list rather than the bare string above.
    expect(outputFor(toolCycle({ content: [], is_error: true }))).toEqual([{ type: 'input_text', text: '[tool error]' }]);
  });

  test('two tool_results in one user message keep their relative order', () => {
    const input = translate({
      model: 'm', max_tokens: 10,
      messages: [
        { role: 'assistant', content: [
          { type: 'tool_use', id: 't1', name: 'Bash', input: {} },
          { type: 'tool_use', id: 't2', name: 'Read', input: {} },
        ] },
        { role: 'user', content: [
          { type: 'tool_result', tool_use_id: 't1', content: 'first' },
          { type: 'text', text: 'between' },
          { type: 'tool_result', tool_use_id: 't2', content: 'second' },
          { type: 'text', text: 'after' },
        ] },
      ],
    }).input as Record<string, any>[];
    expect(input.map(i => i.type)).toEqual([
      'function_call', 'function_call', 'function_call_output', 'message', 'function_call_output', 'message',
    ]);
    expect(input[2]!.call_id).toBe('t1');
    expect(input[3]!.content).toEqual([{ type: 'input_text', text: 'between' }]);
    expect(input[4]!.call_id).toBe('t2');
    expect(input[5]!.content).toEqual([{ type: 'input_text', text: 'after' }]);
  });
});

describe('anthropic inbound: assistant blocks', () => {
  test('tool_use becomes a function_call item with JSON-stringified arguments', () => {
    const input = translate({
      model: 'm', max_tokens: 10,
      messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_7', name: 'Grep', input: { q: 'x' } }] }],
    }).input as Record<string, any>[];
    expect(input[0]).toEqual({ type: 'function_call', call_id: 'toolu_7', name: 'Grep', arguments: '{"q":"x"}' });
  });

  test('missing tool_use input serializes to {}', () => {
    const input = translate({
      model: 'm', max_tokens: 10,
      messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_7', name: 'Grep' }] }],
    }).input as Record<string, any>[];
    expect(input[0]!.arguments).toBe('{}');
  });

  test('thinking / redacted_thinking are dropped on replay; text flushes around tool_use', () => {
    const input = translate({
      model: 'm', max_tokens: 10,
      messages: [{ role: 'assistant', content: [
        { type: 'text', text: 'before' },
        { type: 'thinking', thinking: 'secret', signature: 's' },
        { type: 'redacted_thinking', data: 'blob' },
        { type: 'tool_use', id: 't1', name: 'Bash', input: {} },
        { type: 'text', text: 'after' },
      ] }],
    }).input as Record<string, any>[];
    expect(input.map(i => i.type)).toEqual(['message', 'function_call', 'message']);
    expect(input[0]!.content).toEqual([{ type: 'output_text', text: 'before' }]);
    expect(input[2]!.content).toEqual([{ type: 'output_text', text: 'after' }]);
    expect(JSON.stringify(input)).not.toContain('secret');
  });

  test('string assistant content becomes one output_text message', () => {
    const input = translate({
      model: 'm', max_tokens: 10, messages: [{ role: 'assistant', content: 'plain' }],
    }).input as Record<string, any>[];
    expect(input[0]).toEqual({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'plain' }] });
  });
});

describe('anthropic inbound: tool_choice', () => {
  const cases: Array<[unknown, unknown]> = [
    [{ type: 'auto' }, 'auto'],
    [{ type: 'none' }, 'none'],
    [{ type: 'any' }, 'required'],
    [{ type: 'tool', name: 'Read' }, { type: 'function', name: 'Read' }],
    [{ type: 'unknown_future' }, undefined],
    [undefined, undefined],
  ];

  for (const [choice, expected] of cases) {
    test(`${JSON.stringify(choice)} -> ${JSON.stringify(expected)}`, () => {
      expect(translate({ ...MINIMAL, tool_choice: choice }).tool_choice).toEqual(expected as any);
    });
  }

  test('disable_parallel_tool_use maps to parallel_tool_calls:false independently', () => {
    expect(translate({ ...MINIMAL, tool_choice: { type: 'any', disable_parallel_tool_use: true } }).parallel_tool_calls).toBe(false);
    expect(translate({ ...MINIMAL, tool_choice: { type: 'any' } }).parallel_tool_calls).toBeUndefined();
  });

  test('tool_choice.tool without a name is a 400-class error', () => {
    expect(() => translate({ ...MINIMAL, tool_choice: { type: 'tool' } })).toThrow(AnthropicRequestError);
  });
});

describe('anthropic inbound: thinking / effort', () => {
  const ladder: Array<[number, string]> = [
    [1, 'low'], [1024, 'low'], [4096, 'low'],
    [4097, 'medium'], [10000, 'medium'], [16384, 'medium'],
    [16385, 'high'], [32000, 'high'],
  ];

  for (const [budget, effort] of ladder) {
    test(`budget_tokens ${budget} -> ${effort}`, () => {
      expect(effortForThinkingBudget(budget)).toBe(effort);
      expect(translate({ ...MINIMAL, thinking: { type: 'enabled', budget_tokens: budget } }).reasoning)
        .toEqual({ summary: 'auto', effort });
    });
  }

  test('budget_tokens is never forwarded raw', () => {
    const body = translate({ ...MINIMAL, thinking: { type: 'enabled', budget_tokens: 10000 } });
    expect(JSON.stringify(body)).not.toContain('budget_tokens');
    expect((body.reasoning as Record<string, unknown>).budget_tokens).toBeUndefined();
  });

  test('thinking variants: adaptive / disabled / absent', () => {
    expect(translate({ ...MINIMAL, thinking: { type: 'adaptive' } }).reasoning).toEqual({ summary: 'auto' });
    expect(translate({ ...MINIMAL, thinking: { type: 'disabled' } }).reasoning).toBeUndefined();
    expect(translate(MINIMAL).reasoning).toBeUndefined();
  });

  test('output_config.effort passes through the known ladder and wins over budget_tokens', () => {
    for (const effort of ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']) {
      expect(effortFromOutputConfig({ effort })).toBe(effort);
      expect(translate({ ...MINIMAL, thinking: { type: 'adaptive' }, output_config: { effort } }).reasoning)
        .toEqual({ summary: 'auto', effort });
    }
    expect(translate({
      ...MINIMAL, thinking: { type: 'enabled', budget_tokens: 1024 }, output_config: { effort: 'xhigh' },
    }).reasoning).toEqual({ summary: 'auto', effort: 'xhigh' });
    // output_config alone still carries effort (adaptive-default models omit `thinking`).
    expect(translate({ ...MINIMAL, output_config: { effort: 'medium' } }).reasoning)
      .toEqual({ summary: 'auto', effort: 'medium' });
  });

  test('unknown effort strings are dropped; disabled thinking suppresses effort entirely', () => {
    expect(effortFromOutputConfig({ effort: 'turbo' })).toBeUndefined();
    expect(effortFromOutputConfig('nope')).toBeUndefined();
    expect(translate({ ...MINIMAL, thinking: { type: 'adaptive' }, output_config: { effort: 'turbo' } }).reasoning)
      .toEqual({ summary: 'auto' });
    expect(translate({ ...MINIMAL, thinking: { type: 'disabled' }, output_config: { effort: 'high' } }).reasoning)
      .toBeUndefined();
  });
});

describe('anthropic inbound: misc blocks and errors', () => {
  test('document blocks surface as a titled placeholder', () => {
    const input = translate({
      model: 'm', max_tokens: 10,
      messages: [{ role: 'user', content: [{ type: 'document', title: 'spec.pdf' }, { type: 'document' }] }],
    }).input as Record<string, any>[];
    expect(input[0]!.content).toEqual([
      { type: 'input_text', text: '[document: spec.pdf]' },
      { type: 'input_text', text: '[document]' },
    ]);
  });

  test('unparseable image sources are dropped, not thrown on', () => {
    const input = translate({
      model: 'm', max_tokens: 10,
      messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'file', file_id: 'f' } }, { type: 'text', text: 'x' }] }],
    }).input as Record<string, any>[];
    expect(input[0]!.content).toEqual([{ type: 'input_text', text: 'x' }]);
  });

  test('base64 image without media_type defaults to image/png', () => {
    const input = translate({
      model: 'm', max_tokens: 10,
      messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', data: 'aWc=' } }] }],
    }).input as Record<string, any>[];
    expect(input[0]!.content).toEqual([{ type: 'input_image', image_url: 'data:image/png;base64,aWc=' }]);
  });

  test('stop_sequences keeps only strings and is omitted when empty', () => {
    expect(translate({ ...MINIMAL, stop_sequences: ['A', 2, 'B'] }).stop).toEqual(['A', 'B']);
    expect(translate({ ...MINIMAL, stop_sequences: [] }).stop).toBeUndefined();
  });

  test('tools without an input_schema are dropped; an all-dropped list omits tools', () => {
    expect(translate({ ...MINIMAL, tools: [{ type: 'bash_20250124', name: 'bash' }] }).tools).toBeUndefined();
    expect(translate({ ...MINIMAL, tools: [] }).tools).toBeUndefined();
  });

  const errorCases: Array<[string, unknown]> = [
    ['non-object body', 'nope'],
    ['missing model', { max_tokens: 1, messages: [{ role: 'user', content: 'x' }] }],
    ['empty model', { model: '', max_tokens: 1, messages: [{ role: 'user', content: 'x' }] }],
    ['empty messages', { model: 'm', max_tokens: 1, messages: [] }],
    ['messages not an array', { model: 'm', max_tokens: 1, messages: 'x' }],
    ['non-object message', { model: 'm', max_tokens: 1, messages: ['x'] }],
    ['unknown role', { model: 'm', max_tokens: 1, messages: [{ role: 'tool', content: 'x' }] }],
    ['tool_result without tool_use_id', { model: 'm', max_tokens: 1, messages: [{ role: 'user', content: [{ type: 'tool_result' }] }] }],
    ['tool_use without id', { model: 'm', max_tokens: 1, messages: [{ role: 'assistant', content: [{ type: 'tool_use', name: 'Bash' }] }] }],
    ['tool_use without name', { model: 'm', max_tokens: 1, messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 't1' }] }] }],
  ];

  for (const [label, raw] of errorCases) {
    test(`rejects: ${label}`, () => {
      expect(() => translate(raw)).toThrow(AnthropicRequestError);
    });
  }

  test('role:"system" is accepted (real Claude Code sends it)', () => {
    expect(() => translate({ model: 'm', max_tokens: 1, messages: [{ role: 'system', content: 'x' }] })).not.toThrow();
  });
});
