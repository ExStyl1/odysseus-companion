/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  coerceToolArgsBySchema,
  structuredCloneWithToolArgCoercion,
} from './toolArgCoercion.js';

describe('toolArgCoercion', () => {
  it('coerces simple string scalars by schema', () => {
    const schema = {
      type: 'object',
      properties: {
        count: { type: 'integer' },
        ratio: { type: 'number' },
        enabled: { type: 'boolean' },
      },
    };
    const params: Record<string, unknown> = {
      count: '123',
      ratio: '0.7',
      enabled: 'true',
    };

    coerceToolArgsBySchema(schema, params);

    expect(params).toEqual({
      count: 123,
      ratio: 0.7,
      enabled: true,
    });
  });

  it('coerces nested object and array values', () => {
    const schema = {
      type: 'object',
      properties: {
        options: {
          type: 'object',
          properties: {
            retries: { type: 'integer' },
          },
        },
        weights: {
          type: 'array',
          items: { type: 'number' },
        },
      },
    };
    const params: Record<string, unknown> = {
      options: { retries: '3' },
      weights: ['0.1', '0.2'],
    };

    coerceToolArgsBySchema(schema, params);

    expect(params).toEqual({
      options: { retries: 3 },
      weights: [0.1, 0.2],
    });
  });

  it('does not coerce when string is an accepted schema type', () => {
    const schema = {
      type: 'object',
      properties: {
        value: { type: ['string', 'number'] },
        union: {
          anyOf: [{ type: 'string' }, { type: 'boolean' }],
        },
      },
    };
    const params: Record<string, unknown> = {
      value: '123',
      union: 'true',
    };

    coerceToolArgsBySchema(schema, params);

    expect(params).toEqual({
      value: '123',
      union: 'true',
    });
  });

  it('leaves invalid scalar strings unchanged', () => {
    const schema = {
      type: 'object',
      properties: {
        count: { type: 'integer' },
        ratio: { type: 'number' },
        enabled: { type: 'boolean' },
      },
    };
    const params: Record<string, unknown> = {
      count: '0.7',
      ratio: '',
      enabled: 'yes',
    };

    coerceToolArgsBySchema(schema, params);

    expect(params).toEqual({
      count: '0.7',
      ratio: '',
      enabled: 'yes',
    });
  });

  it('clones before coercion for tool invocation inputs', () => {
    const schema = {
      type: 'object',
      properties: {
        count: { type: 'integer' },
      },
    };
    const params = { count: '123' };

    const cloned = structuredCloneWithToolArgCoercion(params, schema);

    expect(cloned).toEqual({ count: 123 });
    expect(params).toEqual({ count: '123' });
  });
});
