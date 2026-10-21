/**
 * C3.43 (owner answer QB8 = A, 2026-09-11) — B35's measurement, driven and
 * pinned: how the three model keys of
 * `admin-setup.md#decide-how-settings-reach-devices` compose here, with
 * `permissions.allow` as the control that must MERGE.
 *
 * The ledger row asked for disjoint `availableModels` at MANAGED and PROJECT
 * scope with the resolved picker read per runtime. That measurement cannot be
 * taken in the form it was written, and the reason IS the verdict: two of the
 * three keys are not settings keys here at all, and the third has only one
 * scope. Re-measured 2026-09-11 (the 2026-09-06 reading in
 * `packages/shared/src/agent/pi-harness/managed-policy.ts`'s `availableModels`
 * docblock is unchanged):
 *
 *  - `availableModels` — MANAGED-scope only. Every settings-key occurrence
 *    under `packages/**` and `apps/**` is the managed key or a test of it; the
 *    two renderer hits (`CompactModelSelector`, `FreeFormInput`) and the
 *    `automations/validation.ts` hit are local variables of the same name
 *    holding a connection's own model list.
 *  - `fallbackModel` — not a key of `ManagedPiPolicyV1` (the parser strips it,
 *    pinned in `managed-policy-page-contracts.test.ts`). It exists as a bundled
 *    `workspaceDefaults` default plus an env var and a CLI flag, resolved
 *    through one chain (`config/fallback-model-chain.ts`), so there are no two
 *    scopes to combine.
 *  - `modelPicker` — no key anywhere: every hit is an i18n key
 *    (`chat.modelPicker.*`), the `enableCompactModelPicker` prop, or a docblock
 *    recording this same null.
 *
 * So the page's merge-vs-replace question is answerable for the CONTROL and
 * vacuous for the three keys, which is what the cases below pin — the verdict
 * is the measurement, not a wish.
 */
import { describe, expect, test } from 'bun:test'
import { parseManagedPiPolicyTolerantV1 } from '@nessy-agent/shared/agent/pi-harness/managed-policy'
import { composeManagedPolicySources } from '@nessy-agent/shared/config/managed-composition'
import { compilePermissionDslV1 } from '@nessy-agent/shared/agent/pi-harness/permission-dsl'
import { mergeManagedPolicySources } from './managed-policy-loader.ts'

const BASE = '/etc/nessy/managed-policy.json'
const FRAGMENT = '/etc/nessy/managed-policy.d/20-models.json'

const policy = (extra: Record<string, unknown>) => parseManagedPiPolicyTolerantV1(
  { schemaVersion: 1, disabledPermissionModes: [], ...extra },
  { source: BASE },
).policy

describe('C3.43 · availableModels composes inside the managed tier, and only there', () => {
  test('two FRAGMENTS of one file policy UNION their lists', () => {
    // `managed-settings.md#split-a-file-based-policy-across-teams`: "**Lists**,
    // such as `permissions.deny` or `sandbox.network.allowedDomains`: the two
    // lists combine, with duplicates removed". `availableModels` is a list, and
    // the drop-in directory exists so two teams can deploy independently.
    const { merged } = mergeManagedPolicySources([
      { path: BASE, value: { schemaVersion: 1, disabledPermissionModes: [], availableModels: ['team-a-model'] } },
      { path: FRAGMENT, value: { schemaVersion: 1, disabledPermissionModes: [], availableModels: ['team-b-model'] } },
    ])
    expect((merged as { availableModels?: string[] }).availableModels).toEqual(['team-a-model', 'team-b-model'])
  })

  test('the two ADMIN SOURCES do not union — the delivered payload wins wholesale', () => {
    // `server-managed-settings.md#settings-precedence`: the first source that
    // delivers at least one policy key wins. So across delivered-vs-file the
    // list REPLACES, and the operator's file list is gone — the opposite rule
    // from the fragment case above, one layer up.
    const composed = composeManagedPolicySources({
      delivered: policy({ availableModels: ['remote-only'] }),
      file: policy({ availableModels: ['file-only'] }),
    })
    expect(composed.winner).toBe('delivered')
    expect(composed.policy.availableModels).toEqual(['remote-only'])
  })

  test('and there is no second SCOPE for it to compose with', () => {
    // The vacuity, stated as an assertion rather than as prose: a managed
    // document is the only document that can carry the key, so a project-scope
    // list cannot exist to merge or replace. Written as a parse: a `project`
    // spelling of the same key in a managed document is an unknown key.
    const parsed = parseManagedPiPolicyTolerantV1(
      { schemaVersion: 1, disabledPermissionModes: [], projectAvailableModels: ['p'] },
      { source: BASE },
    )
    expect(Object.keys(parsed.policy)).not.toContain('projectAvailableModels')
    expect(parsed.drops.map(drop => drop.field)).toContain('projectAvailableModels')
  })
})

describe('C3.43 · the CONTROL: a key with two scopes really does merge', () => {
  test('permissions.allow from managed and project scope both survive compilation', () => {
    // Without this the vacuity above would be unfalsifiable — "nothing merges"
    // would be indistinguishable from "this rig cannot see a merge". Two layers,
    // two rules, both present and each carrying its own scope.
    const layer = (scope: 'managed' | 'project', id: string, semanticId: string) => ({
      scope,
      sourceDigest: `${scope}-digest`,
      document: { version: 1, rules: [{ id, action: 'allow', match: { kind: 'tool', semanticId } }] },
    })
    const program = compilePermissionDslV1({
      generation: 'generation-1',
      projectTrusted: true,
      layers: [layer('managed', 'managed-allow-bash', 'bash'), layer('project', 'project-allow-read', 'read')],
    })
    expect(program.rules.map(rule => `${rule.scope}:${rule.id}`))
      .toEqual(['managed:managed-allow-bash', 'project:project-allow-read'])
  })
})
