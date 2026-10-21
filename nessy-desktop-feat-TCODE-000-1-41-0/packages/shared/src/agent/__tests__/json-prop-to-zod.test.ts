/**
 * Tests for jsonPropToZod — JSON Schema → Zod conversion for MCP tool proxy schemas.
 *
 * Regression test for MCP parameter serialization bug: union-type parameters
 * (oneOf/anyOf) and nested objects were converted to z.unknown(), causing the
 * LLM to receive no type information for structured parameters.
 */
import { describe, it, expect } from 'bun:test'
import { z } from 'zod'
import { jsonPropToZod } from '../claude-agent.ts'

describe('jsonPropToZod', () => {
  describe('primitives', () => {
    it('converts string type', () => {
      const schema = jsonPropToZod({ type: 'string' })
      expect(schema.safeParse('hello').success).toBe(true)
      expect(schema.safeParse(42).success).toBe(false)
    })

    it('converts number type', () => {
      const schema = jsonPropToZod({ type: 'number' })
      expect(schema.safeParse(42).success).toBe(true)
      expect(schema.safeParse('nope').success).toBe(false)
    })

    it('converts integer type as number', () => {
      const schema = jsonPropToZod({ type: 'integer' })
      expect(schema.safeParse(42).success).toBe(true)
    })

    it('converts boolean type', () => {
      const schema = jsonPropToZod({ type: 'boolean' })
      expect(schema.safeParse(true).success).toBe(true)
      expect(schema.safeParse('yes').success).toBe(false)
    })
  })

  describe('enum', () => {
    it('converts string enum', () => {
      const schema = jsonPropToZod({ enum: ['a', 'b', 'c'] })
      expect(schema.safeParse('a').success).toBe(true)
      expect(schema.safeParse('d').success).toBe(false)
    })

    // F1.998 — zod 4's z.enum keeps only string values (it drops a numeric
    // key as a TS reverse mapping), so a numeric enum refused EVERY value and was
    // offered to the model as `{"type":"string","enum":[]}`.
    it('converts a numeric enum: accepts a member, refuses a non-member and its string twin', () => {
      const schema = jsonPropToZod({ type: 'integer', enum: [1, 2, 3] })
      expect(schema.safeParse(2).success).toBe(true)
      expect(schema.safeParse(4).success).toBe(false)
      expect(schema.safeParse('2').success).toBe(false)
      expect(z.toJSONSchema(schema)).toMatchObject({ type: 'number', enum: [1, 2, 3] })
    })

    it('converts a mixed string/number enum: accepts both kinds, refuses a non-member', () => {
      const schema = jsonPropToZod({ enum: ['auto', 0, 1] })
      expect(schema.safeParse('auto').success).toBe(true)
      expect(schema.safeParse(0).success).toBe(true)
      expect(schema.safeParse('manual').success).toBe(false)
      expect(schema.safeParse(2).success).toBe(false)
      expect(schema.safeParse('0').success).toBe(false)
      expect(z.toJSONSchema(schema)).toMatchObject({ enum: ['auto', 0, 1] })
    })

    it('CONTROL — an all-string enum is still offered exactly as z.enum offers it', () => {
      const offered: unknown = z.toJSONSchema(jsonPropToZod({ type: 'string', enum: ['a', 'b'] }))
      expect(offered).toEqual({ $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'string', enum: ['a', 'b'] })
    })

    // F1.1095 — z.literal compares by identity, so an object or array member
    // refused every value, even a deep-equal copy of the member itself. Such an
    // enum is now offered as written and left for the MCP server to check.
    it('leaves an enum with an object or array member to the server, and still offers the members', () => {
      const members = [{ unit: 'ms' }, [1, 2], 'auto']
      const schema = jsonPropToZod({ enum: members, description: 'Pick one' })
      expect(schema.safeParse({ unit: 'ms' }).success).toBe(true)
      expect(schema.safeParse([1, 2]).success).toBe(true)
      expect(schema.safeParse('auto').success).toBe(true)
      expect(z.toJSONSchema(schema)).toMatchObject({ enum: members, description: 'Pick one' })
      // CONTROL — a primitive-only enum is still checked here.
      expect(jsonPropToZod({ enum: ['auto', 0] }).safeParse('manual').success).toBe(false)
    })
  })

  describe('oneOf / anyOf (union types)', () => {
    it('converts oneOf with object variants (the Nessy destination case)', () => {
      const schema = jsonPropToZod({
        oneOf: [
          {
            type: 'object',
            properties: { destination: { type: 'string', enum: ['unsorted', 'templates'] } },
            required: ['destination'],
          },
          {
            type: 'object',
            properties: { folderId: { type: 'string' } },
            required: ['folderId'],
          },
        ],
      })
      // Both variants should be accepted
      expect(schema.safeParse({ destination: 'unsorted' }).success).toBe(true)
      expect(schema.safeParse({ folderId: 'abc-123' }).success).toBe(true)
      // Invalid variant should fail
      expect(schema.safeParse({ invalid: true }).success).toBe(false)
    })

    it('converts anyOf with mixed types', () => {
      const schema = jsonPropToZod({
        anyOf: [
          { type: 'string' },
          { type: 'number' },
        ],
      })
      expect(schema.safeParse('hello').success).toBe(true)
      expect(schema.safeParse(42).success).toBe(true)
      expect(schema.safeParse(true).success).toBe(false)
    })

    it('unwraps single-variant oneOf', () => {
      const schema = jsonPropToZod({
        oneOf: [{ type: 'string' }],
      })
      expect(schema.safeParse('hello').success).toBe(true)
      expect(schema.safeParse(42).success).toBe(false)
    })
  })

  describe('allOf (merged objects)', () => {
    it('merges allOf into a single object', () => {
      const schema = jsonPropToZod({
        allOf: [
          { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
          { type: 'object', properties: { age: { type: 'number' } } },
        ],
      })
      expect(schema.safeParse({ name: 'Alice', age: 30 }).success).toBe(true)
      expect(schema.safeParse({ age: 30 }).success).toBe(false) // name is required
    })
  })

  describe('nested objects', () => {
    it('converts object with properties into z.object', () => {
      const schema = jsonPropToZod({
        type: 'object',
        properties: {
          name: { type: 'string' },
          count: { type: 'number' },
        },
        required: ['name'],
      })
      expect(schema.safeParse({ name: 'test' }).success).toBe(true)
      expect(schema.safeParse({ name: 'test', count: 5 }).success).toBe(true)
      expect(schema.safeParse({}).success).toBe(false) // name is required
    })

    it('falls back to z.record for object without properties', () => {
      const schema = jsonPropToZod({ type: 'object' })
      expect(schema.safeParse({ anything: 'goes' }).success).toBe(true)
    })
  })

  describe('typed arrays', () => {
    it('converts array with typed items', () => {
      const schema = jsonPropToZod({
        type: 'array',
        items: { type: 'string' },
      })
      expect(schema.safeParse(['a', 'b']).success).toBe(true)
      expect(schema.safeParse([1, 2]).success).toBe(false)
    })

    it('falls back to z.unknown items when no items schema', () => {
      const schema = jsonPropToZod({ type: 'array' })
      expect(schema.safeParse([1, 'mixed', true]).success).toBe(true)
    })
  })

  describe('descriptions', () => {
    it('preserves description on primitives', () => {
      const schema = jsonPropToZod({ type: 'string', description: 'A file path' })
      expect(schema.description).toBe('A file path')
    })

    it('preserves description on union types', () => {
      const schema = jsonPropToZod({
        description: 'Target location',
        oneOf: [
          { type: 'string' },
          { type: 'number' },
        ],
      })
      expect(schema.description).toBe('Target location')
    })

    it('preserves description on nested objects', () => {
      const schema = jsonPropToZod({
        type: 'object',
        description: 'Destination config',
        properties: { id: { type: 'string' } },
      })
      expect(schema.description).toBe('Destination config')
    })
  })

  describe('depth guard', () => {
    it('returns z.unknown at max depth', () => {
      // Build a deeply nested schema (6 levels of oneOf wrapping)
      let schema: any = { type: 'string' }
      for (let i = 0; i < 6; i++) {
        schema = { oneOf: [schema] }
      }
      // Should not throw — just returns z.unknown at depth limit
      const zod = jsonPropToZod(schema)
      expect(zod.safeParse('anything').success).toBe(true)
    })
  })

  describe('edge cases', () => {
    it('handles null/undefined prop gracefully', () => {
      expect(jsonPropToZod(null).safeParse('anything').success).toBe(true)
      expect(jsonPropToZod(undefined).safeParse('anything').success).toBe(true)
    })

    it('handles unknown type string', () => {
      const schema = jsonPropToZod({ type: 'foobar' })
      expect(schema.safeParse('anything').success).toBe(true) // z.unknown
    })

    it('handles empty oneOf array', () => {
      const schema = jsonPropToZod({ oneOf: [] })
      // Falls through to default since empty array is falsy for length check
      expect(schema.safeParse('anything').success).toBe(true)
    })
  })
})
