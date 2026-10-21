/**
 * U1 eager-content resolution contract.
 *
 * Proves the load-bearing pure logic behind useCapabilityPrimaryContent without
 * a DOM (the repo has no renderHook/DOM lib — hook tests drive the extracted
 * pure logic instead): which resource the eager `capabilities.preview` call
 * targets (the primary instructions/guide body), that the source `config`
 * resource is never the primary, that a kind with no previewable body maps to
 * the empty state, that the openable file-ref chips + chip→ref map mirror
 * CapabilityResources' Open affordance (plugin-tier read-only excluded), and —
 * for finding 1 — the preview roundtrip → outcome mapping (loadPrimaryContent)
 * plus the identity-keyed status derivation (derivePrimaryContentStatus) that
 * guarantees a WITH-body capability never flashes 'empty' before 'loading' and
 * that a stale/cancelled result is not applied across a capability change.
 */

import { describe, expect, it } from 'bun:test'
import {
  derivePrimaryContentStatus,
  loadPrimaryContent,
  resolveCapabilityContent,
  resourceLabel,
  resourceRelativePath,
} from '../useCapabilityPrimaryContent'
import type {
  CapabilityManagedResourceRef,
  ManagedResourcePreview,
  PreviewableManagedResourceRef,
  SafeCapabilityContextRef,
  SafeCapabilityDetail,
} from '@nessy-agent/shared/protocol/capabilities'

const WS = 'ws-1'

function detailWithResources(resources: SafeCapabilityDetail['resources']): SafeCapabilityDetail {
  return {
    summary: {
      key: 'k', kind: 'source', logicalName: 'n', origin: 'native',
      scope: { kind: 'workspace', workspaceId: WS }, state: 'active', readOnly: false,
      trustState: 'not-required', credentialState: 'not-required',
      selectedAsUnqualifiedAlias: true, diagnosticCodes: [],
    },
    safeFields: [],
    resources,
  }
}

const sourceConfig: CapabilityManagedResourceRef = { scope: 'source', workspaceId: WS, sourceId: 'n', file: 'config' }
const sourceGuide: CapabilityManagedResourceRef = { scope: 'source', workspaceId: WS, sourceId: 'n', file: 'guide' }
const skillInstructions: CapabilityManagedResourceRef = { scope: 'skill', tier: 'workspace', workspaceId: WS, skillId: 'n', file: 'instructions' }
const pluginInstructions: CapabilityManagedResourceRef = { scope: 'skill', tier: 'plugin', pluginInstanceId: 'p', capabilityId: 'c', file: 'instructions' }

describe('resolveCapabilityContent — primary ref selection', () => {
  it('picks the source guide (not the non-previewable config) as the primary body', () => {
    const { primaryRef } = resolveCapabilityContent(
      detailWithResources([
        { ref: sourceConfig, canPreview: false, canEdit: true, canOpen: true },
        { ref: sourceGuide, canPreview: true, canEdit: true, canOpen: true },
      ]),
    )
    expect(primaryRef).toMatchObject({ scope: 'source', file: 'guide' })
  })

  it('picks skill instructions as the primary body', () => {
    const { primaryRef } = resolveCapabilityContent(
      detailWithResources([{ ref: skillInstructions, canPreview: true, canEdit: true, canOpen: true }]),
    )
    expect(primaryRef).toMatchObject({ scope: 'skill', file: 'instructions' })
  })

  it('maps a kind with only a non-previewable resource to the empty state (no primary)', () => {
    const { primaryRef } = resolveCapabilityContent(
      detailWithResources([{ ref: sourceConfig, canPreview: false, canEdit: true, canOpen: true }]),
    )
    expect(primaryRef).toBeNull()
  })

  it('returns the empty resolution for a null detail', () => {
    expect(resolveCapabilityContent(null)).toEqual({ primaryRef: null, fileRefs: [], openById: new Map() })
  })
})

describe('resolveCapabilityContent — openable file-ref chips', () => {
  it('emits path-free chips for openable resources and maps each chip id to its ref', () => {
    const { fileRefs, openById } = resolveCapabilityContent(
      detailWithResources([
        { ref: sourceConfig, canPreview: false, canEdit: true, canOpen: true },
        { ref: sourceGuide, canPreview: true, canEdit: true, canOpen: true },
      ]),
    )
    expect(fileRefs.map((r) => r.label)).toEqual(['config', 'guide'])
    expect(fileRefs.map((r) => r.relativePath)).toEqual(['source/config', 'source/guide'])
    // chip → ref round-trips through the openById map (drives the editor Open).
    expect(openById.get(fileRefs[0].id)).toMatchObject({ scope: 'source', file: 'config' })
    expect(openById.get(fileRefs[1].id)).toMatchObject({ scope: 'source', file: 'guide' })
    // Never leaks an absolute path.
    expect(JSON.stringify(fileRefs)).not.toContain('/Users')
  })

  it('excludes read-only plugin-tier skill resources (no Open affordance)', () => {
    const { fileRefs, openById } = resolveCapabilityContent(
      detailWithResources([{ ref: pluginInstructions, canPreview: true, canEdit: false, canOpen: false }]),
    )
    expect(fileRefs).toHaveLength(0)
    expect(openById.size).toBe(0)
  })
})

describe('resource label helpers', () => {
  it('derive path-free labels from a safe ref', () => {
    expect(resourceLabel(skillInstructions)).toBe('instructions')
    expect(resourceRelativePath(skillInstructions)).toBe('skill/instructions')
  })
})

describe('loadPrimaryContent — eager preview roundtrip', () => {
  const context: SafeCapabilityContextRef = { workspaceId: WS }
  const primaryRef = skillInstructions as PreviewableManagedResourceRef

  it('maps a resolved preview to the loaded outcome with its body', async () => {
    const preview = async (): Promise<ManagedResourcePreview> =>
      ({ content: '# Body' }) as ManagedResourcePreview
    expect(await loadPrimaryContent({ context, primaryRef, preview })).toEqual({
      kind: 'loaded',
      markdown: '# Body',
    })
  })

  it('maps a rejected preview to the fail-soft error outcome', async () => {
    const preview = async (): Promise<ManagedResourcePreview> => {
      throw new Error('boom')
    }
    expect(await loadPrimaryContent({ context, primaryRef, preview })).toEqual({ kind: 'error' })
  })

  it('targets the ref it is handed', async () => {
    let seen: PreviewableManagedResourceRef | null = null
    const preview = async (
      _ctx: SafeCapabilityContextRef,
      ref: PreviewableManagedResourceRef,
    ): Promise<ManagedResourcePreview> => {
      seen = ref
      return { content: 'ok' } as ManagedResourcePreview
    }
    await loadPrimaryContent({ context, primaryRef, preview })
    expect(seen).toMatchObject({ scope: 'skill', file: 'instructions' })
  })
})

describe('derivePrimaryContentStatus — first-paint + navigation (finding 1)', () => {
  const keyA = JSON.stringify(skillInstructions)
  const keyB = JSON.stringify(sourceGuide)

  it('a kind with no previewable body maps to empty directly', () => {
    expect(derivePrimaryContentStatus(null, null)).toEqual({ status: 'empty' })
  })

  it('a WITH-body capability shows loading before any settled load — never an empty flash', () => {
    // This is the exact first-paint case: detail just resolved, primaryKey is
    // known, nothing has settled yet. Must be loading, not empty.
    expect(derivePrimaryContentStatus(keyA, null)).toEqual({ status: 'loading' })
  })

  it('applies a settled loaded/error outcome only for the matching ref', () => {
    expect(derivePrimaryContentStatus(keyA, { key: keyA, outcome: { kind: 'loaded', markdown: 'X' } })).toEqual({
      status: 'loaded',
      markdown: 'X',
    })
    expect(derivePrimaryContentStatus(keyA, { key: keyA, outcome: { kind: 'error' } })).toEqual({ status: 'error' })
  })

  it('ignores a settled outcome from a different ref — navigation/stale result resets to loading', () => {
    // Settled for capability A, but we navigated to B (or an in-flight A result
    // arrives after B mounted): B must be loading with no A body carried over.
    const carried = derivePrimaryContentStatus(keyB, {
      key: keyA,
      outcome: { kind: 'loaded', markdown: 'A body' },
    })
    expect(carried).toEqual({ status: 'loading' })
    expect(carried.markdown).toBeUndefined()
  })
})
