/**
 * UA12.108 — spawn_session's `projectId` on Pi (origin UA wave 6 UA-as / UA5.4, 2026-10-02). The host rule is
 * uniform: `SpawnSessionRequest` and the Claude in-process schema have carried `projectId` since UA5.4 (the
 * `preExecuteSpawnSession` pass-through, `SessionManager`'s folder rule), but THIS schema — the one the Pi
 * model is shown — had no such field, so a Pi spawn could not name a project and every `projectId` a model
 * sent was silently stripped here. Upstream v0.13.4's own schema has neither; this port is the host-uniformity
 * rule (the owner's native-first order: the host already applies the folder rule, so the Pi declaration is
 * what was missing).
 *
 * Positive: `{ prompt, projectId }` parses and the value is CARRIED (a stripped field would parse to
 * `undefined` — the assertion reads the value, not just `success`); the Pi model-facing projection
 * (`getToolDefsAsJsonSchema`) exposes `projectId` as a string property.
 * Negative: a number is refused at the schema.
 * Boundary: omitting `projectId` still parses — the field is optional and the inherit rule (the child takes
 * the caller's project, UA5.4) stays the no-field behaviour.
 */
import { describe, expect, it } from 'bun:test'
import { getToolDefsAsJsonSchema, SpawnSessionSchema } from './tool-defs.ts'

describe('UA12.108 — SpawnSessionSchema carries projectId (the Pi model surface)', () => {
  it('positive: { prompt, projectId } parses and the value is carried, not stripped', () => {
    const parsed = SpawnSessionSchema.safeParse({ prompt: 'ship it', projectId: 'proj_ua12_108' })
    expect(parsed.success).toBe(true)
    expect(parsed.success && parsed.data.projectId).toBe('proj_ua12_108')
  })

  it('negative: a number is refused at the schema', () => {
    expect(SpawnSessionSchema.safeParse({ prompt: 'ship it', projectId: 42 }).success).toBe(false)
  })

  it('boundary: omitting projectId still parses — the inherit rule stays the no-field behaviour', () => {
    const parsed = SpawnSessionSchema.safeParse({ prompt: 'ship it' })
    expect(parsed.success).toBe(true)
    expect(parsed.success && parsed.data.projectId).toBeUndefined()
  })

  it('positive: the Pi model-facing projection exposes projectId as a string property', () => {
    const schema = getToolDefsAsJsonSchema({ prefix: 'mcp__session__' })
      .find(def => def.name === 'mcp__session__spawn_session')?.inputSchema as {
      properties?: Record<string, { type?: string }>
      type?: string
    }
    expect(schema?.type).toBe('object')
    expect(schema?.properties?.projectId).toMatchObject({ type: 'string' })
  })
})
