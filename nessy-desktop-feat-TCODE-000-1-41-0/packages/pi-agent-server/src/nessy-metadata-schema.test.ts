import { describe, expect, it } from 'bun:test';
import { createEditToolDefinition } from '@earendil-works/pi-coding-agent';
import { allowNessyMetadataProperties, stripNessyMetadata } from './nessy-metadata-schema.ts';

describe('Nessy metadata schema compatibility for Pi tools', () => {
  it('widens a strict Edit-like schema with optional Nessy metadata properties', () => {
    const schema = {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string' },
        edits: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              oldText: { type: 'string' },
              newText: { type: 'string' },
            },
            required: ['oldText', 'newText'],
          },
        },
      },
      required: ['path', 'edits'],
    };

    const widened = allowNessyMetadataProperties(schema);

    expect(widened).not.toBe(schema);
    expect(widened.additionalProperties).toBe(false);
    expect(widened.required).toEqual(schema.required);
    expect(widened.required).not.toContain('_displayName');
    expect(widened.required).not.toContain('_intent');
    expect(widened.properties._displayName).toBeDefined();
    expect(widened.properties._intent).toBeDefined();
    expect(widened.properties.path).toBe(schema.properties.path);
    expect(widened.properties.edits).toBe(schema.properties.edits);
  });

  it('widens the actual Pi Edit tool schema without making metadata required', () => {
    const editTool = createEditToolDefinition('/tmp');
    const widened = allowNessyMetadataProperties(editTool.parameters);
    const widenedSchema = widened as {
      additionalProperties?: unknown;
      properties: Record<string, unknown>;
      required?: string[];
    };

    // Pi 0.84 stopped declaring `additionalProperties` on its builtin tool
    // schemas; 0.80.3 pinned it to `false`. The widener's contract is to
    // preserve whatever the upstream schema declared rather than to impose a
    // value, so this asserts pass-through. The strict case — which is what our
    // OWN runtime-backed Edit tool ships — stays covered by the synthetic
    // schema in the test above.
    expect(widenedSchema.additionalProperties).toBe(
      (editTool.parameters as { additionalProperties?: unknown }).additionalProperties,
    );
    expect(widenedSchema.properties._displayName).toBeDefined();
    expect(widenedSchema.properties._intent).toBeDefined();
    expect(widenedSchema.required ?? []).not.toContain('_displayName');
    expect(widenedSchema.required ?? []).not.toContain('_intent');
  });

  it('preserves upstream metadata properties if Pi defines them later', () => {
    const upstreamDisplayName = { type: 'string', description: 'upstream display name' };
    const upstreamIntent = { type: 'string', description: 'upstream intent' };
    const schema = {
      type: 'object',
      additionalProperties: false,
      properties: {
        _displayName: upstreamDisplayName,
        _intent: upstreamIntent,
        path: { type: 'string' },
      },
      required: ['path'],
    };

    const widened = allowNessyMetadataProperties(schema);

    expect(widened.properties._displayName).toBe(upstreamDisplayName);
    expect(widened.properties._intent).toBe(upstreamIntent);
  });

  it('returns unknown schema shapes unchanged', () => {
    expect(allowNessyMetadataProperties(undefined)).toBeUndefined();
    expect(allowNessyMetadataProperties('schema')).toBe('schema');

    const noProperties = { type: 'string' };
    expect(allowNessyMetadataProperties(noProperties)).toBe(noProperties);
  });

  it('strips Nessy metadata before upstream Pi tool execution', () => {
    const input = {
      _displayName: 'Edit Lines',
      _intent: 'Add punctuation',
      path: 'random',
      edits: [{ oldText: 'a', newText: 'b' }],
    };

    const clean = stripNessyMetadata(input);

    expect(clean).toEqual({
      path: 'random',
      edits: [{ oldText: 'a', newText: 'b' }],
    });
    expect(clean).not.toHaveProperty('_displayName');
    expect(clean).not.toHaveProperty('_intent');
    expect(input).toHaveProperty('_displayName', 'Edit Lines');
    expect(input).toHaveProperty('_intent', 'Add punctuation');
  });

  it('returns the same input object when no metadata is present', () => {
    const input = { path: 'random' };
    expect(stripNessyMetadata(input)).toBe(input);
  });
});
