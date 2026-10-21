import { describe, expect, test } from 'bun:test'

import {
  parseAndFreezePiPermissionReceipt,
  type PiPermissionReceiptV1,
} from './permission-receipt.ts'

function receipt(): PiPermissionReceiptV1 {
  return {
    version: 1,
    sessionKey: { workspaceId: 'workspace-1', sessionId: 'session-1' },
    binding: {
      provider: 'pi',
      surfaceVersion: 1,
      piName: 'read',
      bindingName: 'read',
      semanticId: 'read',
      descriptorId: 'read',
    },
    manifest: {
      generation: 'generation-1',
      hash: 'hash-1',
      provenance: ['capability.read@generation-1'],
      responseEpoch: 7,
    },
    decisionId: 'decision-1',
    outcome: 'allow',
    canonicalInput: { path: 'README.md' },
    contextProfile: 'normal',
    sandboxRequirement: 'workspace',
  }
}

describe('Pi permission receipt', () => {
  test('strictly clones, validates, binds and deeply freezes the serialized receipt', () => {
    const input = structuredClone(receipt())
    const parsed = parseAndFreezePiPermissionReceipt(input, {
      sessionKey: input.sessionKey,
      provider: 'pi',
      surfaceVersion: 1,
      piName: 'read',
      bindingName: 'read',
      semanticId: 'read',
      descriptorId: 'read',
      manifestGeneration: 'generation-1',
      manifestHash: 'hash-1',
      manifestProvenance: ['capability.read@generation-1'],
      responseEpoch: 7,
      contextProfile: 'normal',
      sandboxRequirement: 'workspace',
    })

    expect(parsed).toEqual(input)
    expect(parsed).not.toBe(input)
    expect(parsed.canonicalInput).not.toBe(input.canonicalInput)
    expect(Object.isFrozen(parsed)).toBe(true)
    expect(Object.isFrozen(parsed.binding)).toBe(true)
    expect(Object.isFrozen(parsed.manifest.provenance)).toBe(true)
    expect(Object.isFrozen(parsed.canonicalInput)).toBe(true)
    expect(() => { (parsed.canonicalInput as Record<string, unknown>).path = 'changed' }).toThrow()
    expect(input.canonicalInput).toEqual({ path: 'README.md' })
  })

  test('rejects unknown versions, transient fields and stale or mismatched identity', () => {
    expect(() => parseAndFreezePiPermissionReceipt({ ...receipt(), version: 2 })).toThrow(/version/i)
    expect(() => parseAndFreezePiPermissionReceipt({ ...receipt(), transientRequest: true })).toThrow(/field/i)
    expect(() => parseAndFreezePiPermissionReceipt(receipt(), {
      sessionKey: { workspaceId: 'workspace-1', sessionId: 'session-1' },
      provider: 'pi',
      surfaceVersion: 1,
      piName: 'read',
      bindingName: 'read',
      semanticId: 'write',
      descriptorId: 'read',
      manifestGeneration: 'generation-1',
      manifestHash: 'hash-1',
      manifestProvenance: ['capability.read@generation-1'],
      responseEpoch: 7,
      contextProfile: 'normal',
      sandboxRequirement: 'workspace',
    })).toThrow(/semanticId/i)
    expect(() => parseAndFreezePiPermissionReceipt(receipt(), {
      sessionKey: { workspaceId: 'workspace-1', sessionId: 'session-1' },
      provider: 'pi',
      surfaceVersion: 1,
      piName: 'read',
      bindingName: 'read',
      semanticId: 'read',
      descriptorId: 'read',
      manifestGeneration: 'generation-1',
      manifestHash: 'hash-1',
      manifestProvenance: ['capability.read@generation-1'],
      responseEpoch: 8,
      contextProfile: 'normal',
      sandboxRequirement: 'workspace',
    })).toThrow(/responseEpoch/i)
    expect(() => parseAndFreezePiPermissionReceipt(receipt(), {
      sessionKey: { workspaceId: 'workspace-1', sessionId: 'session-1' },
      provider: 'pi',
      surfaceVersion: 1,
      piName: 'read',
      bindingName: 'read',
      semanticId: 'read',
      descriptorId: 'read',
      manifestGeneration: 'generation-1',
      manifestHash: 'hash-1',
      manifestProvenance: ['capability.read@generation-1'],
      responseEpoch: 7,
      contextProfile: 'bare',
      sandboxRequirement: 'workspace',
    })).toThrow(/contextProfile/i)
  })
})
