/**
 * useCapabilityPrimaryContent
 *
 * U1 eager-content hook. On detail mount (and whenever the detail changes) it
 * auto-invokes the EXISTING `capabilities.preview` RPC for the PRIMARY
 * instructions/guide resource and maps the roundtrip to the four
 * CapabilityContentPanel states:
 *
 *   - loading → no previewable body resolved YET (skeleton)
 *   - loaded  → markdown body resolved
 *   - error   → the RPC threw (fail-soft placeholder + retry)
 *   - empty   → no previewable primary resource for this kind
 *
 * The resource-resolution logic is anchored on CapabilityResources: the
 * "primary" resource is the single previewable body resource a kind exposes —
 * `file: 'instructions'` for skills, `file: 'guide'` for sources (the source
 * `config` resource is `canPreview: false`, so it is never the primary body).
 *
 * FIRST-PAINT CONTRACT (reviewer U1 finding 1): the returned status is DERIVED
 * per render from the current primary ref, never seeded once from a possibly
 * stale first render. The hook is mounted at page level while `detail` is still
 * null (primaryRef null → 'empty'), but the content panel is gated behind the
 * page's own loading state and only mounts once `detail` resolves. At that
 * point primaryRef is non-null and the settled load state has not yet been
 * recorded for it, so the derived status is 'loading' — a capability WITH a
 * body shows the skeleton first and NEVER flashes 'empty'. The settled result
 * is KEYED to the ref it resolved for, so navigating to another capability (a
 * new primaryRef identity) resets to 'loading' with no stale content/status.
 *
 * No protocol change: this reuses the server-mediated preview channel and the
 * path-free managed-resource refs. It is the U1 step-(a) mechanism.
 */

import * as React from 'react'
import type {
  CapabilityManagedResourceRef,
  ManagedResourcePreview,
  MutableCapabilityManagedResourceRef,
  PreviewableManagedResourceRef,
  SafeCapabilityContextRef,
  SafeCapabilityDetail,
} from '@nessy-agent/shared/protocol/capabilities'
import type {
  CapabilityContentFileRef,
  CapabilityContentPanelStatus,
} from './CapabilityContentPanel'

export interface UseCapabilityPrimaryContentResult {
  status: CapabilityContentPanelStatus
  markdown?: string
  errorMessage?: string
  fileRefs: CapabilityContentFileRef[]
  /** Chip click — opens the referenced managed resource in the OS editor. */
  onOpenFileRef: (ref: CapabilityContentFileRef) => void
  retry: () => void
}

type DetailResource = SafeCapabilityDetail['resources'][number]

/**
 * The previewable body resource for a kind. Anchored on
 * CapabilityResources.isPreviewableResource: the source `config` resource is
 * the only ref explicitly excluded from preview.
 */
function isPreviewableRef(
  ref: CapabilityManagedResourceRef,
): ref is Exclude<PreviewableManagedResourceRef, { scope: 'global' } | { scope: 'workspace' }> {
  return ref.scope !== 'source' || ref.file !== 'config'
}

/** Pick the primary instructions/guide body resource, mirroring the server refs. */
function primaryBodyResource(detail: SafeCapabilityDetail): DetailResource | null {
  return (
    detail.resources.find(
      (resource) =>
        resource.canPreview &&
        isPreviewableRef(resource.ref) &&
        (resource.ref.scope === 'skill'
          ? resource.ref.file === 'instructions'
          : resource.ref.file === 'guide'),
    ) ?? null
  )
}

/** Short, path-free label for a resource ref (basename analog). */
export function resourceLabel(ref: CapabilityManagedResourceRef): string {
  return ref.file
}

/** Stable, path-free relative label for a resource ref tooltip. */
export function resourceRelativePath(ref: CapabilityManagedResourceRef): string {
  return `${ref.scope}/${ref.file}`
}

/** Stable chip key + tooltip payload derived from a safe ref (never absolute). */
function toFileRef(ref: CapabilityManagedResourceRef): CapabilityContentFileRef {
  return { id: JSON.stringify(ref), label: resourceLabel(ref), relativePath: resourceRelativePath(ref) }
}

/**
 * Only resources CapabilityResources treats as openable-in-editor: plugin-tier
 * skill resources are read-only (`canOpen: false`) and are excluded, mirroring
 * CapabilityResources.mutableResource.
 */
function openableRef(ref: CapabilityManagedResourceRef): MutableCapabilityManagedResourceRef | null {
  if (ref.scope === 'skill' && ref.tier === 'plugin') return null
  return ref
}

/**
 * Pure resolution of the eager-content inputs from a detail — extracted so the
 * load contract (which ref the preview call targets, which chips render, and
 * where a chip click routes) is testable without a DOM renderer.
 */
export interface ResolvedCapabilityContent {
  /** The ref the eager preview call MUST target (null → empty state). */
  primaryRef: PreviewableManagedResourceRef | null
  /** Openable managed-resource chips, in resource order. */
  fileRefs: CapabilityContentFileRef[]
  /** chip-id → the ref a click opens in the editor. */
  openById: Map<string, MutableCapabilityManagedResourceRef>
}

export function resolveCapabilityContent(detail: SafeCapabilityDetail | null): ResolvedCapabilityContent {
  if (!detail) return { primaryRef: null, fileRefs: [], openById: new Map() }
  const primary = primaryBodyResource(detail)
  const openById = new Map<string, MutableCapabilityManagedResourceRef>()
  const fileRefs: CapabilityContentFileRef[] = []
  for (const resource of detail.resources) {
    const ref = openableRef(resource.ref)
    if (!resource.canOpen || !ref) continue
    const chip = toFileRef(resource.ref)
    fileRefs.push(chip)
    openById.set(chip.id, ref)
  }
  return {
    // isPreviewableRef already narrowed the primary body ref to the previewable union.
    primaryRef: primary ? (primary.ref as PreviewableManagedResourceRef) : null,
    fileRefs,
    openById,
  }
}

/** The settled outcome of one eager preview roundtrip. */
export type PrimaryContentOutcome =
  | { kind: 'loaded'; markdown: string }
  | { kind: 'error' }

/**
 * Perform the single eager preview roundtrip for a primary body ref, extracted
 * from the effect so the resolve/reject mapping is unit-testable without a DOM.
 * A rejection maps to the fail-soft error outcome — the caller decides whether
 * a stale/cancelled result is applied.
 */
export async function loadPrimaryContent(deps: {
  context: SafeCapabilityContextRef
  primaryRef: PreviewableManagedResourceRef
  preview: (
    context: SafeCapabilityContextRef,
    resource: PreviewableManagedResourceRef,
  ) => Promise<ManagedResourcePreview>
}): Promise<PrimaryContentOutcome> {
  try {
    const preview = await deps.preview(deps.context, deps.primaryRef)
    return { kind: 'loaded', markdown: preview.content }
  } catch {
    return { kind: 'error' }
  }
}

/** Settled load outcome tagged with the ref key it resolved for. */
export interface SettledLoad {
  /** Identity of the primary ref this outcome belongs to (JSON of the ref). */
  key: string
  outcome: PrimaryContentOutcome
}

/**
 * Map the current primary-ref identity + the latest settled load to a panel
 * status/body. Pure and identity-keyed so both first-paint and navigation
 * behaviour (finding 1) are testable without a DOM:
 *   - no primary ref              → 'empty' directly
 *   - primary ref, nothing settled FOR it yet → 'loading' (never a body-flash)
 *   - settled load for THIS ref   → 'loaded' / 'error'
 * A settled load whose key does not match the current ref is treated as stale
 * (navigation / reload) and ignored — the fresh ref is 'loading'.
 */
export function derivePrimaryContentStatus(
  primaryKey: string | null,
  settled: SettledLoad | null,
): { status: CapabilityContentPanelStatus; markdown?: string } {
  if (!primaryKey) return { status: 'empty' }
  const current = settled && settled.key === primaryKey ? settled.outcome : null
  if (!current) return { status: 'loading' }
  if (current.kind === 'loaded') return { status: 'loaded', markdown: current.markdown }
  return { status: 'error' }
}

export function useCapabilityPrimaryContent(
  context: SafeCapabilityContextRef,
  detail: SafeCapabilityDetail | null,
): UseCapabilityPrimaryContentResult {
  const { primaryRef, fileRefs, openById } = React.useMemo(() => resolveCapabilityContent(detail), [detail])
  const primaryKey = primaryRef ? JSON.stringify(primaryRef) : null

  const onOpenFileRef = React.useCallback(
    (fileRef: CapabilityContentFileRef) => {
      const ref = openById.get(fileRef.id)
      if (ref) void window.electronAPI.capabilities.open(context, ref)
    },
    [context, openById],
  )

  // The ONLY dynamic state is the settled outcome of the latest completed load,
  // tagged with the ref it belongs to. The returned status is derived from the
  // current primaryRef vs. this settled key — so there is no stale first-paint
  // seed and no cross-capability carry-over (finding 1).
  const [settled, setSettled] = React.useState<SettledLoad | null>(null)
  const [attempt, setAttempt] = React.useState(0)

  React.useEffect(() => {
    if (!primaryRef || !primaryKey) return
    let cancelled = false
    void (async () => {
      const outcome = await loadPrimaryContent({
        context,
        primaryRef,
        preview: window.electronAPI.capabilities.preview,
      })
      // Drop a cancelled (stale detail / navigated-away) result.
      if (cancelled) return
      setSettled({ key: primaryKey, outcome })
    })()
    return () => {
      cancelled = true
    }
  }, [context, primaryRef, primaryKey, attempt])

  const retry = React.useCallback(() => setAttempt((n) => n + 1), [])

  const { status, markdown } = derivePrimaryContentStatus(primaryKey, settled)

  return { status, markdown, fileRefs, onOpenFileRef, retry }
}
