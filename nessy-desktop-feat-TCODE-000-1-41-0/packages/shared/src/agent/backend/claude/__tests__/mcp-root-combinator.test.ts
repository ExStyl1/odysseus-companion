/**
 * F1.557 — the documented root-combinator rewrite, rule by rule.
 *
 * The rules are `mcp.md#tool-input-schemas-with-a-root-level-combinator`'s; the
 * end-to-end arm (a fixture source proxied through `createSourceProxyServers`,
 * read at `tools/list` and at the pool's `callTool`) is
 * `agent/__tests__/claude-mcp-root-combinator-bridge.test.ts`.
 */
import { describe, expect, it } from 'bun:test';
import { claudeProxyToolInput, flattenRootCombinatorSchema } from '../mcp-root-combinator.ts';

describe('F1.557 · flattenRootCombinatorSchema', () => {
  it('leaves a schema with no root combinator unchanged (the plain-tool control)', () => {
    expect(flattenRootCombinatorSchema({ type: 'object', properties: { q: { type: 'string' } }, required: ['q'] }))
      .toEqual({ outcome: 'unchanged' });
    // A combinator one level DOWN is the API's to accept, not ours to rewrite.
    expect(flattenRootCombinatorSchema({
      type: 'object',
      properties: { target: { anyOf: [{ type: 'string' }, { type: 'number' }] } },
    })).toEqual({ outcome: 'unchanged' });
  });

  it('anyOf: merges every branch and enforces no branch required list, describing the groups instead', () => {
    const out = flattenRootCombinatorSchema({
      type: 'object',
      properties: { limit: { type: 'number' } },
      required: ['limit'],
      anyOf: [
        { properties: { id: { type: 'string' } }, required: ['id'] },
        { properties: { email: { type: 'string' } }, required: ['email'] },
      ],
    });
    expect(out).toEqual({
      outcome: 'flattened',
      schema: {
        type: 'object',
        properties: { limit: { type: 'number' }, id: { type: 'string' }, email: { type: 'string' } },
        // The ROOT's own required list still applies; the branches' do not.
        required: ['limit'],
      },
      note: 'Argument groups (this tool\'s schema is a root-level anyOf, merged into one object): pass at least one of (id) | (email).',
      combinators: ['anyOf'],
    });
  });

  it('oneOf: says exactly one, and names a branch with no required list by its property names', () => {
    const out = flattenRootCombinatorSchema({
      oneOf: [
        { type: 'object', properties: { a: { type: 'number' } }, required: ['a'] },
        { type: 'object', properties: { b: { type: 'boolean' }, c: { type: 'string' } } },
      ],
    });
    expect(out.outcome).toBe('flattened');
    if (out.outcome !== 'flattened') return;
    expect(out.schema).toEqual({
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'boolean' }, c: { type: 'string' } },
      required: [],
    });
    expect(out.note).toContain('pass exactly one of (a) | (b, c).');
  });

  it('allOf: merges every branch and every branch required list still applies', () => {
    const out = flattenRootCombinatorSchema({
      allOf: [
        { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
        { type: 'object', properties: { y: { type: 'integer' }, z: { type: 'string' } }, required: ['y'] },
      ],
    });
    expect(out).toEqual({
      outcome: 'flattened',
      schema: {
        type: 'object',
        properties: { x: { type: 'string' }, y: { type: 'integer' }, z: { type: 'string' } },
        required: ['x', 'y'],
      },
      note: 'Argument groups (this tool\'s schema is a root-level allOf, merged into one object): every listed argument applies together.',
      combinators: ['allOf'],
    });
  });

  it('reads a branch that is a local $ref through to its definition', () => {
    const out = flattenRootCombinatorSchema({
      $defs: { ById: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
      definitions: { ByName: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
      anyOf: [{ $ref: '#/$defs/ById' }, { $ref: '#/definitions/ByName' }, { $ref: '#/$defs/Missing' }],
    });
    expect(out.outcome).toBe('flattened');
    if (out.outcome !== 'flattened') return;
    expect(Object.keys(out.schema.properties as object)).toEqual(['id', 'name']);
    expect(out.note).toContain('(id) | (name)');
  });

  it('keeps the first definition of a repeated property and leaves out a name the API would refuse', () => {
    const out = flattenRootCombinatorSchema({
      properties: { id: { type: 'string', description: 'root wins' } },
      oneOf: [
        { properties: { id: { type: 'number' }, 'bad name': { type: 'string' }, ok: { type: 'string' } } },
        { properties: { [`x${'y'.repeat(64)}`]: { type: 'string' } } },
      ],
    });
    expect(out.outcome).toBe('flattened');
    if (out.outcome !== 'flattened') return;
    expect(out.schema.properties).toEqual({ id: { type: 'string', description: 'root wins' }, ok: { type: 'string' } });
  });

  it('F1.610: merges an enum (or const) discriminator the anyOf/oneOf branches disagree on into one enum', () => {
    const out = flattenRootCombinatorSchema({
      oneOf: [
        { properties: { kind: { type: 'string', enum: ['user'] }, id: { type: 'string' } }, required: ['kind', 'id'] },
        { properties: { kind: { enum: ['team', 'user'], type: 'string' }, slug: { type: 'string' } } },
        { properties: { kind: { type: 'string', const: 'org' } } },
      ],
    });
    expect(out.outcome).toBe('flattened');
    if (out.outcome !== 'flattened') return;
    expect(out.schema.properties).toEqual({
      kind: { type: 'string', enum: ['user', 'team', 'org'] },
      id: { type: 'string' },
      slug: { type: 'string' },
    });
  });

  it('F1.610: offers definitions the anyOf/oneOf branches disagree on as alternatives', () => {
    const out = flattenRootCombinatorSchema({
      anyOf: [
        { properties: { value: { type: 'number' } } },
        { properties: { value: { type: 'string', description: 'a keyword' } } },
        { properties: { value: { type: 'number', description: 'same as the first, annotated' } } },
        // Numbers are not merged into one enum: the Zod builder's `z.enum` takes strings.
        { properties: { level: { enum: [1] } } },
        { properties: { level: { enum: [2] } } },
      ],
    });
    expect(out.outcome).toBe('flattened');
    if (out.outcome !== 'flattened') return;
    expect(out.schema.properties).toEqual({
      value: { anyOf: [{ type: 'number' }, { type: 'string', description: 'a keyword' }] },
      level: { anyOf: [{ enum: [1] }, { enum: [2] }] },
    });
  });

  it('F1.610 BOUNDARY: a definition that always applies (root or allOf) still wins, and agreeing branches keep the first', () => {
    const out = flattenRootCombinatorSchema({
      properties: { kind: { type: 'string' } },
      oneOf: [
        { properties: { kind: { enum: ['a'] }, mode: { enum: ['x'] }, note: { type: 'string', description: 'first' } } },
        { properties: { kind: { enum: ['b'] }, mode: { enum: ['y'] }, note: { type: 'string', description: 'second' } } },
      ],
      allOf: [{ properties: { mode: { type: 'string', description: 'always applies' } } }],
    });
    expect(out.outcome).toBe('flattened');
    if (out.outcome !== 'flattened') return;
    expect(out.schema.properties).toEqual({
      kind: { type: 'string' },
      mode: { type: 'string', description: 'always applies' },
      note: { type: 'string', description: 'first' },
    });
  });

  it('skips a tool whose root combinator is not an array, with the reason', () => {
    expect(flattenRootCombinatorSchema({ anyOf: { properties: { id: { type: 'string' } } } })).toEqual({
      outcome: 'skipped',
      reason: 'input schema has a root-level anyOf that is not an array',
    });
  });
});

describe('F1.557 · claudeProxyToolInput', () => {
  it('hands a plain tool its own description and schema, and the Tool-from fallback when it has none', () => {
    const schema = { type: 'object', properties: { q: { type: 'string' } } };
    const logged: string[] = [];
    expect(claudeProxyToolInput('src', { name: 't', description: 'd', inputSchema: schema }, m => logged.push(m)))
      .toEqual({ description: 'd', inputSchema: schema });
    expect(claudeProxyToolInput('src', { name: 't', inputSchema: undefined }, m => logged.push(m)))
      .toEqual({ description: 'Tool from src', inputSchema: {} });
    expect(logged).toEqual([]);
  });

  it('prepends the note to the description of a flattened tool', () => {
    const input = claudeProxyToolInput('src', {
      name: 't',
      description: 'Find a user.',
      inputSchema: { oneOf: [{ properties: { id: { type: 'string' } }, required: ['id'] }] },
    });
    expect(input?.description).toBe(
      'Argument groups (this tool\'s schema is a root-level oneOf, merged into one object): pass exactly one of (id).\n\nFind a user.',
    );
    expect(input?.inputSchema).toEqual({ type: 'object', properties: { id: { type: 'string' } }, required: [] });
  });

  it('returns null for a skipped tool and logs one line naming the tool, the source and the reason', () => {
    const logged: string[] = [];
    expect(claudeProxyToolInput('src', { name: 'broken', inputSchema: { allOf: 'nope' } }, m => logged.push(m))).toBeNull();
    expect(logged).toEqual([
      '[claude-agent] F1.557: MCP tool "broken" of source "src" is not offered on claude-runtime — input schema has a root-level allOf that is not an array',
    ]);
  });
});
