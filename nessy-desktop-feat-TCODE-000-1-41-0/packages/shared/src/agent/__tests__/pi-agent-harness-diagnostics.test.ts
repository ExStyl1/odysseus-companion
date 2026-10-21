import { describe, expect, test } from 'bun:test'
import { PiAgent } from '../pi-agent'

describe('Pi harness diagnostics', () => {
  test('returns detached bounded active-manifest identity', () => {
    const agent = Object.create(PiAgent.prototype) as any
    agent.activeExecutionManifest = { surfaceVersion: 2, snapshotGeneration: 'generation', manifestHash: 'hash', provenance: [{ capabilityKey: 'source:one', generation: 'g1' }], tools: [] }
    agent.subprocessResponseEpoch = 4
    agent.config = { contextProfile: 'normal' }
    const first = agent.getHarnessDiagnostics?.()
    expect(first).toEqual({ surfaceVersion: 2, generation: 'generation', manifestHash: 'hash', provenance: ['source:one@g1'], contextProfile: 'normal', responseEpoch: 4 })
    expect(Object.isFrozen(first)).toBeTrue()
    expect(agent.getHarnessDiagnostics?.()).not.toBe(first)
  })

  test('does not fabricate an inactive manifest', () => {
    const agent = Object.create(PiAgent.prototype) as PiAgent
    expect(agent.getHarnessDiagnostics?.()).toBeUndefined()
  })

  test('uses the exact runtime DTO bounds', () => {
    const agent = Object.create(PiAgent.prototype) as any
    agent.activeExecutionManifest = { surfaceVersion: 2, snapshotGeneration: 'g'.repeat(300), manifestHash: 'h'.repeat(300), provenance: Array.from({ length: 60 }, (_, index) => ({ capabilityKey: `source:${index}:${'x'.repeat(300)}`, generation: 'g' })), tools: [] }
    agent.subprocessResponseEpoch = 1
    agent.config = { contextProfile: 'normal' }
    const diagnostics = agent.getHarnessDiagnostics()
    expect(diagnostics.provenance).toHaveLength(50)
    expect(Math.max(...diagnostics.provenance.map((value: string) => value.length))).toBe(256)
    expect(diagnostics.generation).toHaveLength(256)
    expect(diagnostics.manifestHash).toHaveLength(256)
  })
})
