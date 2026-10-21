import { describe, expect, test } from 'bun:test';

import {
  NESTOR_GATEWAY_QWEN_DIALECT_V1,
  adaptToolRequestForDialect,
  isNestorGatewayQwenModel,
} from './tool-schema-dialect.ts';

const request = (model: string) => ({
  model,
  tool_choice: 'auto',
  tools: [{
    type: 'function',
    function: {
      name: 'read',
      metadata: { required: ['keep'], additionalProperties: false },
      parameters: {
        type: 'object',
        required: ['path'],
        additionalProperties: false,
        properties: { path: { type: 'string' } },
      },
    },
  }],
});

describe('Nestor gateway Qwen tool schema dialect', () => {
  test('adapts the recognized model set, wherever it runs', () => {
    for (const model of ['tgpt/qwen35-397b-a17b-fp8', 'tgpt/qwen36-35b-a3b-fp8']) {
      const output = adaptToolRequestForDialect(request(model), {
        dialect: NESTOR_GATEWAY_QWEN_DIALECT_V1,
      }) as any;
      expect(output.tool_choice).toBeUndefined();
      expect(output.tools[0].function.parameters.required).toBeUndefined();
      expect(output.tools[0].function.parameters.additionalProperties).toBeUndefined();
      expect(output.tools[0].function.metadata).toEqual({ required: ['keep'], additionalProperties: false });
    }

    // C6: the URL clause is GONE — the same ids reached through a BYO
    // llm-proxy connection get the same weakening, because the mitigation
    // belongs to the model, not to the gateway.
    expect(isNestorGatewayQwenModel('tgpt/qwen35-397b-a17b-fp8')).toBe(true);
    expect(isNestorGatewayQwenModel('other/model')).toBe(false);

    // Still NOT widened to every model.
    const original = request('other/model');
    expect(adaptToolRequestForDialect(original, {
      dialect: NESTOR_GATEWAY_QWEN_DIALECT_V1,
    })).toEqual(original);
    expect(adaptToolRequestForDialect(request('tgpt/qwen35-397b-a17b-fp8'), {
      dialect: { id: 'unknown', version: 2 } as never,
    })).toEqual(request('tgpt/qwen35-397b-a17b-fp8'));
  });
});

/**
 * E6 — the per-connection dialect hint.
 *
 * The id allowlist is the default and stays the default. It cannot see a Qwen
 * model an endpoint serves under its own house name, and that model leaks its
 * reasoning into the answer exactly like the recognised ones — so the form lets
 * the user say so, and that statement outranks the allowlist.
 */
describe('adaptToolRequestForDialect — forced dialect', () => {
  const body = {
    model: 'house-name-nobody-can-recognise',
    tool_choice: 'required',
    tools: [{ type: 'function', function: { name: 'f', parameters: { type: 'object', additionalProperties: false, required: ['a'], properties: { a: { type: 'string' } } } } }],
  }

  test('leaves an unrecognised model alone by default', () => {
    expect(adaptToolRequestForDialect(body, { dialect: NESTOR_GATEWAY_QWEN_DIALECT_V1 })).toBe(body)
  })

  test('weakens an unrecognised model when the connection forces the dialect', () => {
    const out = adaptToolRequestForDialect(body, {
      dialect: NESTOR_GATEWAY_QWEN_DIALECT_V1,
      force: true,
    }) as Record<string, unknown>

    expect(out).not.toBe(body)
    expect(out).not.toHaveProperty('tool_choice')
    // The original is untouched — this is a clone, not an in-place edit.
    expect(body).toHaveProperty('tool_choice')
  })

  test('still refuses a dialect it does not know, forced or not', () => {
    const foreign = { id: 'not-qwen', version: 1 } as unknown as typeof NESTOR_GATEWAY_QWEN_DIALECT_V1
    expect(adaptToolRequestForDialect(body, { dialect: foreign, force: true })).toBe(body)
  })
})
