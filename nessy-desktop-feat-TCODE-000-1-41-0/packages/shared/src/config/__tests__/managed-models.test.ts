import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  applyManagedModelAllowlist,
  clearManagedModelPolicy,
  isManagedModelSelectable,
  resolveManagedModelCatalog,
  setManagedModelPolicy,
} from '../managed-models'
import { managedModelAllowlist } from '../managed-model-allowlist'
import { gatewayModelFixture } from './fixtures/gateway-connection-fixture.ts'
import {
  isManagedModelAllowed,
  parseManagedPiPolicyTolerantV1,
  resolveManagedDefaultModel,
  type ManagedPiPolicyV1,
} from '../../agent/pi-harness/managed-policy'
import { resolveModelForProvider } from '../../agent/backend/factory'
import { getMiniModel, getSummarizationModel, resolveGatewayFastModelId } from '../llm-connections'
import type { ModelDefinition } from '../models'

const policyOf = (value: Record<string, unknown>): ManagedPiPolicyV1 =>
  parseManagedPiPolicyTolerantV1(
    { schemaVersion: 1, disabledPermissionModes: [], ...value },
    { source: '/etc/nessy/managed-policy.json' },
  ).policy

const model = (id: string): ModelDefinition => ({
  id,
  name: id,
  shortName: id,
  description: '',
  provider: 'anthropic',
  contextWindow: 200_000,
})

const CATALOG = [
  model('claude-opus-4-5-20260101'),
  model('claude-sonnet-4-5-20250929'),
  model('claude-haiku-4-5-20251001'),
]
const ids = (models: readonly (ModelDefinition | string)[]) =>
  models.map(entry => typeof entry === 'string' ? entry : entry.id)

afterEach(() => {
  clearManagedModelPolicy()
})

describe('what one allowlist entry names (model-config.md:147)', () => {
  it('matches a full model id and a version prefix, at a hyphen boundary', () => {
    const policy = policyOf({ availableModels: ['claude-sonnet-4-5', 'claude-haiku-4-5-20251001'] })
    // The full id.
    expect(isManagedModelAllowed(policy, 'claude-haiku-4-5-20251001')).toBe(true)
    // The version prefix — :147's own example shape.
    expect(isManagedModelAllowed(policy, 'claude-sonnet-4-5-20250929')).toBe(true)
    // Not a prefix of a longer VERSION token: the boundary has to be a `-`.
    expect(isManagedModelAllowed(policy, 'claude-sonnet-4-56-20250929')).toBe(false)
    expect(isManagedModelAllowed(policy, 'claude-opus-4-5-20260101')).toBe(false)
  })

  it('normalizes our own pi/ routing prefix on both sides', () => {
    expect(isManagedModelAllowed(policyOf({ availableModels: ['gpt-5.2'] }), 'pi/gpt-5.2')).toBe(true)
    expect(isManagedModelAllowed(policyOf({ availableModels: ['pi/gpt-5.2'] }), 'gpt-5.2')).toBe(true)
  })

  it('a family alias alongside a specific version leaves only that version (model-config.md:256)', () => {
    // ":256 — `[\"sonnet\", \"claude-sonnet-4-5\"]` allows only Sonnet 4.5
    // versions, not every Sonnet model." Family aliases are unimplemented, so
    // the family entry matches nothing and the version entry decides — the same
    // set the sentence describes.
    const policy = policyOf({ availableModels: ['sonnet', 'claude-sonnet-4-5'] })
    expect(isManagedModelAllowed(policy, 'claude-sonnet-4-5-20250929')).toBe(true)
    expect(isManagedModelAllowed(policy, 'claude-sonnet-4-1-20240101')).toBe(false)
  })
})

describe('the catalog a session may select from', () => {
  it('an ABSENT allowlist narrows nothing', () => {
    const resolved = resolveManagedModelCatalog(CATALOG, 'claude-opus-4-5-20260101', policyOf({}))
    expect(resolved.models).toBe(CATALOG)
    expect(resolved.defaultModel).toBe('claude-opus-4-5-20260101')
  })

  it('an EMPTY allowlist blocks every named model and keeps the Default', () => {
    // `managed-settings.md#keys-that-fail-closed`, the `availableModels` row —
    // "Enforced as an empty allowlist until fixed, so only the Default model is
    // available; a non-string entry is stripped and the valid subset enforced."
    // model-config.md:207 — "with `availableModels: []`, named model selections
    // are blocked but the Default model for the account type remains usable
    // regardless of `enforceAvailableModels`."
    const policy = policyOf({ availableModels: 'not-an-array', enforceAvailableModels: true })
    expect(policy.availableModels).toEqual([])
    const resolved = resolveManagedModelCatalog(CATALOG, 'claude-opus-4-5-20260101', policy)
    expect(ids(resolved.models)).toEqual(['claude-opus-4-5-20260101'])
    expect(resolved.defaultModel).toBe('claude-opus-4-5-20260101')
  })

  it('keeps the Default reachable when the allowlist excludes it (model-config.md:205)', () => {
    // "On its own, `availableModels` leaves Default available." Without this the
    // session would resolve to a model it is not allowed to run.
    const policy = policyOf({ availableModels: ['claude-haiku-4-5'] })
    const resolved = resolveManagedModelCatalog(CATALOG, 'claude-opus-4-5-20260101', policy)
    expect(ids(resolved.models)).toEqual(['claude-opus-4-5-20260101', 'claude-haiku-4-5-20251001'])
    expect(resolved.defaultModel).toBe('claude-opus-4-5-20260101')
  })

  it('enforceAvailableModels moves the Default onto the list (model-config.md:220)', () => {
    const policy = policyOf({
      availableModels: ['claude-sonnet-4-5', 'claude-haiku-4-5'],
      enforceAvailableModels: true,
    })
    const resolved = resolveManagedModelCatalog(CATALOG, 'claude-opus-4-5-20260101', policy)
    expect(resolved.defaultModel).toBe('claude-sonnet-4-5-20250929')
    // The excluded Opus is gone now that the Default no longer needs it.
    expect(ids(resolved.models)).toEqual([
      'claude-sonnet-4-5-20250929',
      'claude-haiku-4-5-20251001',
    ])
  })

  it('skips enforcement when no allowlisted model is available (model-config.md:222)', () => {
    // ":222 — enforcement is skipped and Default resolves to the account-type
    // default." `resolveManagedDefaultModel` reports that as `undefined`; a
    // caller that read it as "no model" would lock the user out entirely.
    const policy = policyOf({ availableModels: ['gpt-5.2'], enforceAvailableModels: true })
    expect(resolveManagedDefaultModel(policy, 'claude-opus-4-5-20260101', ids(CATALOG)))
      .toBeUndefined()
    const resolved = resolveManagedModelCatalog(CATALOG, 'claude-opus-4-5-20260101', policy)
    expect(resolved.defaultModel).toBe('claude-opus-4-5-20260101')
    expect(ids(resolved.models)).toEqual(['claude-opus-4-5-20260101'])
  })
})

describe('the projection never writes', () => {
  it('returns a copy and leaves the input record untouched', () => {
    const stored = {
      models: [...CATALOG],
      defaultModel: 'claude-opus-4-5-20260101',
    }
    const before = ids(stored.models)
    const narrowed = applyManagedModelAllowlist(
      stored,
      policyOf({ availableModels: ['claude-haiku-4-5'], enforceAvailableModels: true }),
    )
    expect(narrowed).not.toBe(stored)
    expect(narrowed.models).not.toBe(stored.models)
    expect(ids(narrowed.models!)).toEqual(['claude-haiku-4-5-20251001'])
    expect(ids(stored.models)).toEqual(before)
    expect(stored.defaultModel).toBe('claude-opus-4-5-20260101')
  })
})

describe('the process registry', () => {
  it('is unset by default and reports the deployed list once set', () => {
    expect(managedModelAllowlist()).toBeUndefined()
    expect(isManagedModelSelectable('anything-at-all')).toBe(true)

    setManagedModelPolicy(policyOf({ availableModels: ['claude-haiku-4-5'] }))
    expect(managedModelAllowlist()).toEqual(['claude-haiku-4-5'])
    expect(isManagedModelSelectable('claude-opus-4-5-20260101')).toBe(false)
  })
})

describe('the session model authority (model-config.md:166)', () => {
  const connection = {
    slug: 'anthropic-api',
    name: 'Anthropic',
    providerType: 'anthropic' as const,
    authType: 'api_key' as const,
    createdAt: 0,
    models: [...CATALOG],
    defaultModel: 'claude-haiku-4-5-20251001',
  }

  it('substitutes a forbidden session model for the connection default', () => {
    // ":166 — the value is replaced at startup ... and the session starts on the
    // default model." Anthropic, deliberately: the pre-existing catalog guard in
    // `resolveModelForProvider` only ran for `provider === 'pi'`, so this exact
    // case used to run the forbidden model.
    setManagedModelPolicy(policyOf({ availableModels: ['claude-haiku-4-5'] }))
    expect(resolveModelForProvider('anthropic', 'claude-opus-4-5-20260101', connection))
      .toBe('claude-haiku-4-5-20251001')
  })

  it('leaves an allowlisted session model alone', () => {
    setManagedModelPolicy(policyOf({ availableModels: ['claude-opus-4-5', 'claude-haiku-4-5'] }))
    expect(resolveModelForProvider('anthropic', 'claude-opus-4-5-20260101', connection))
      .toBe('claude-opus-4-5-20260101')
  })

  it('changes nothing when no policy is deployed', () => {
    expect(resolveModelForProvider('anthropic', 'claude-opus-4-5-20260101', connection))
      .toBe('claude-opus-4-5-20260101')
  })
})

describe('the delegated tiers (settings-reference.md#availablemodels)', () => {
  // P6.784 — the gateway rows come from the card's own builder rather than from
  // the anthropic-shaped `model()` above with the provider swapped: that shape
  // omitted `supportsThinking`, which `ModelDefinition` documents as *"Defaults
  // to true when undefined"* while both shipped gateway rows declare `false`.
  // The `shortName`s stay local — the delegated tiers resolve on them, and they
  // are this block's whole subject.
  const gatewayModel = (id: string) => gatewayModelFixture({ id, contextWindow: 200_000 }) as unknown as ModelDefinition
  const gatewayCatalog = [
    { ...gatewayModel('tgpt/qwen35-397b-a17b-fp8'), shortName: 'smart' },
    { ...gatewayModel('tgpt/qwen36-35b-a3b-fp8'), shortName: 'fast' },
    { ...gatewayModel('tgpt/mini-1'), shortName: 'mini', name: 'Mini 1' },
  ]
  const connection = {
    models: gatewayCatalog,
    providerType: 'pi' as const,
    piAuthProvider: 'nestor',
  }

  it('mini and summarization never return a model the allowlist excludes', () => {
    // These feed title generation, mini completions and summarization — the
    // "skills" end of `settings-reference.md#availablemodels` in our shape:
    // "Restrict which models people can select for the main session, subagents,
    // skills, and the advisor."
    //
    // The unrestricted answer used to be `tgpt/mini-1`, the keyword search's
    // pick. It is the `fast`-ALIASED row since P6.1080, because this catalogue
    // declares its cheap tier and `findSmallModel` now asks before guessing.
    // The measurement that forced it: on the live 2026-09-11 gateway catalogue
    // the keyword list matched "flash" inside the new FLAGSHIP coder id
    // (`tgpt/deepseek-v4-flash-0731`), so every background task on all three
    // gateway cards was being billed at the flagship. This block's subject is
    // the ALLOWLIST, and the allowlist arm below is unchanged.
    expect(getMiniModel(connection)).toBe('tgpt/qwen36-35b-a3b-fp8')
    expect(getSummarizationModel(connection)).toBe('tgpt/qwen36-35b-a3b-fp8')
    setManagedModelPolicy(policyOf({ availableModels: ['tgpt/qwen35-397b-a17b-fp8'] }))
    expect(getMiniModel(connection)).toBe('tgpt/qwen35-397b-a17b-fp8')
    expect(getSummarizationModel(connection)).toBe('tgpt/qwen35-397b-a17b-fp8')
  })

  it('hands the tier back to the Default when nothing survives the allowlist', () => {
    // `undefined` here is not a failure: every caller reads it as
    // `getMiniModel(conn) ?? conn.defaultModel`, so the tier falls back to the
    // Default — `model-config.md:167`'s "falls back to the inherited or default
    // model rather than failing the request". Returning a forbidden model
    // instead would be the `isDeniedMiniModelId` fallback escaping the policy.
    setManagedModelPolicy(policyOf({ availableModels: 'not-an-array' }))
    expect(managedModelAllowlist()).toEqual([])
    expect(getMiniModel(connection)).toBeUndefined()
    expect(getSummarizationModel(connection)).toBeUndefined()
  })

  it('the gateway fast alias stops resolving when the fast model is excluded', () => {
    // This is the orchestrator `small` tier default and the guardian judge's
    // default model. `model-config.md:178` — when the classifier's default is
    // excluded "the classifier runs on the session's model, which the allowlist
    // already governs", which is exactly what an unset alias produces here.
    expect(resolveGatewayFastModelId(connection)).toBe('tgpt/qwen36-35b-a3b-fp8')
    setManagedModelPolicy(policyOf({ availableModels: ['tgpt/qwen35-397b-a17b-fp8'] }))
    expect(resolveGatewayFastModelId(connection)).toBeUndefined()
  })
})

/*
 * The named hazard, end to end.
 *
 * `2026-07-29-deviation-unit-4.md` item 5: filtering the catalog at the
 * persistence boundary "would round-trip through `updateLlmConnection` ... and
 * permanently destroy a user's model list". This runs the real storage module
 * against a real `config.json`, so it can assert the file itself — not a mock —
 * still carries every model after a policy has been applied, and that
 * withdrawing the policy brings the whole list back.
 */
const STORAGE_MODULE = pathToFileURL(join(import.meta.dir, '..', 'storage.ts')).href
const MODELS_MODULE = pathToFileURL(join(import.meta.dir, '..', 'managed-models.ts')).href
const FACTORY_MODULE = pathToFileURL(
  join(import.meta.dir, '..', '..', 'agent', 'backend', 'factory.ts'),
).href
const SUBPROCESS_TEST_TIMEOUT_MS = 120_000

const USER_MODELS = [
  'claude-opus-4-5-20260101',
  'claude-sonnet-4-5-20250929',
  'claude-haiku-4-5-20251001',
]

function storageFixture() {
  const configDir = mkdtempSync(join(tmpdir(), 'nessy-managed-models-'))
  const configPath = join(configDir, 'config.json')
  writeFileSync(configPath, JSON.stringify({
    storageLayoutVersion: 2,
    workspaceRefs: [{ id: 'ws-1', lastAccessedAt: 0 }],
    activeWorkspaceId: 'ws-1',
    activeSessionId: null,
    defaultLlmConnection: 'anthropic-api',
    llmConnections: [{
      slug: 'anthropic-api',
      name: 'Anthropic',
      providerType: 'anthropic',
      authType: 'api_key',
      createdAt: 0,
      models: USER_MODELS,
      defaultModel: 'claude-opus-4-5-20260101',
    }],
  }, null, 2), 'utf-8')

  const run = (body: string): unknown => {
    const result = Bun.spawnSync([
      process.execPath,
      '--eval',
      `import * as S from '${STORAGE_MODULE}';`
      + `import * as M from '${MODELS_MODULE}';`
      + `import * as F from '${FACTORY_MODULE}';`
      + body,
    ], { env: { ...process.env, NESSY_CONFIG_DIR: configDir }, stdout: 'pipe', stderr: 'pipe' })
    if (result.exitCode !== 0) throw new Error(`subprocess failed:\n${result.stderr.toString()}`)
    return JSON.parse(result.stdout.toString().trim())
  }

  const readConfig = () => JSON.parse(readFileSync(configPath, 'utf-8'))
  return { run, readConfig }
}

const APPLY_POLICY = `M.setManagedModelPolicy({`
  + ` schemaVersion: 1, disabledPermissionModes: [],`
  + ` availableModels: ['claude-haiku-4-5'], enforceAvailableModels: true });`

describe('withdrawing the policy restores the user model list', () => {
  it('narrows the session view without touching stored config, and restores on withdrawal', () => {
    const { run, readConfig } = storageFixture()

    const report = run(APPLY_POLICY
      + `const narrowed = F.resolveSessionConnection('anthropic-api');`
      + `const stored = S.getLlmConnections()[0];`
      + `M.clearManagedModelPolicy();`
      + `const restored = F.resolveSessionConnection('anthropic-api');`
      + `process.stdout.write(JSON.stringify({`
      + ` narrowed: narrowed.models, narrowedDefault: narrowed.defaultModel,`
      + ` stored: stored.models, storedDefault: stored.defaultModel,`
      + ` restored: restored.models, restoredDefault: restored.defaultModel }));`) as {
        narrowed: string[]
        narrowedDefault: string
        stored: string[]
        storedDefault: string
        restored: string[]
        restoredDefault: string
      }

    // The session view is narrowed, and the Default moved onto the list.
    expect(report.narrowed).toEqual(['claude-haiku-4-5-20251001'])
    expect(report.narrowedDefault).toBe('claude-haiku-4-5-20251001')

    // The PERSISTENCE-facing read — the one `llmConnections.LIST_WITH_STATUS`
    // uses and the renderer hands back to `llmConnections.SAVE` — is untouched.
    // This is what makes the round trip harmless.
    expect(report.stored).toEqual(USER_MODELS)
    expect(report.storedDefault).toBe('claude-opus-4-5-20260101')

    // Withdrawal restores everything, because nothing was ever removed.
    expect(report.restored).toEqual(USER_MODELS)
    expect(report.restoredDefault).toBe('claude-opus-4-5-20260101')

    // And the file on disk still has the user's whole list.
    const connection = readConfig().llmConnections[0]
    expect(connection.models).toEqual(USER_MODELS)
    expect(connection.defaultModel).toBe('claude-opus-4-5-20260101')
  }, SUBPROCESS_TEST_TIMEOUT_MS)

  it('survives a save round trip taken while the policy is active', () => {
    // The concrete destruction path: the renderer holds a connection record from
    // `llmConnections.LIST_WITH_STATUS` and sends it back through
    // `llmConnections.SAVE` (`useModelVisionToggle`, the Settings rename). If the
    // list handed to the renderer were narrowed, this write would delete the
    // excluded models for good.
    const { run, readConfig } = storageFixture()

    const after = run(APPLY_POLICY
      + `const listed = S.getLlmConnections()[0];`
      + `const { slug, ...updates } = listed;`
      + `S.updateLlmConnection('anthropic-api', updates);`
      + `M.clearManagedModelPolicy();`
      + `process.stdout.write(JSON.stringify(S.getLlmConnections()[0].models));`) as string[]

    expect(after).toEqual(USER_MODELS)
    expect(readConfig().llmConnections[0].models).toEqual(USER_MODELS)
  }, SUBPROCESS_TEST_TIMEOUT_MS)
})

/**
 * P6.238 — the organization's chosen default model.
 *
 * `availableModels` and `enforceAvailableModels` already landed; the value an
 * administrator wants every new session to START on did not, so an org could
 * restrict the menu and not set the dish.
 *
 * The key is `model`, the page's own spelling (`settings-reference.md#model`,
 * scope `Any file`) — not the `defaultModel` the opening row proposed, which is
 * a key no Claude Code has.
 */
describe('a managed default model (P6.238)', () => {
  it('supplies the default when the connection has none', () => {
    const connection: { models: Array<ModelDefinition | string>; defaultModel?: string } =
      { models: [...CATALOG] }
    const resolved = applyManagedModelAllowlist(connection, policyOf({ model: 'claude-sonnet-4-5-20250929' }))
    expect(resolved.defaultModel).toBe('claude-sonnet-4-5-20250929')
  })

  it('OUTRANKS the connection\'s stored default, because a managed default that loses is a suggestion', () => {
    // `model-config.md#organization-default-model` ranks "a `model` value in
    // managed settings" above "a `model` value in your user, project, or local
    // settings, including a model you save with `/model`".
    const connection = { models: CATALOG, defaultModel: 'claude-opus-4-5-20260101' }
    const resolved = applyManagedModelAllowlist(connection, policyOf({ model: 'claude-haiku-4-5-20251001' }))
    expect(resolved.defaultModel).toBe('claude-haiku-4-5-20251001')
  })

  it('applies with NO allowlist set, which is a complete policy on its own', () => {
    // The pre-fix early return read `availableModels === undefined` alone, so a
    // managed `model` without an allowlist would have been dropped silently.
    const resolved = applyManagedModelAllowlist(
      { models: CATALOG, defaultModel: 'claude-opus-4-5-20260101' },
      policyOf({ model: 'claude-haiku-4-5-20251001' }),
    )
    expect(resolved.defaultModel).toBe('claude-haiku-4-5-20251001')
    // …and it narrows nothing: every catalogue entry survives.
    expect(ids(resolved.models!)).toEqual(ids(CATALOG))
  })

  it('goes through the SAME allowlist resolution the user\'s default gets', () => {
    // An administrator who names a model their own allowlist excludes gets the
    // documented fallback rather than a contradiction.
    const connection: { models: Array<ModelDefinition | string>; defaultModel?: string } =
      { models: [...CATALOG] }
    const resolved = applyManagedModelAllowlist(
      connection,
      policyOf({
        model: 'claude-opus-4-5-20260101',
        availableModels: ['claude-haiku-4-5-20251001'],
        enforceAvailableModels: true,
      }),
    )
    expect(resolved.defaultModel).toBe('claude-haiku-4-5-20251001')
  })

  it('an unset key changes nothing, and a malformed one is stripped rather than repaired', () => {
    const connection = { models: CATALOG, defaultModel: 'claude-opus-4-5-20260101' }
    expect(applyManagedModelAllowlist(connection, policyOf({})).defaultModel)
      .toBe('claude-opus-4-5-20260101')
    const { policy, drops } = parseManagedPiPolicyTolerantV1(
      { schemaVersion: 1, disabledPermissionModes: [], model: 17 },
      { source: '/etc/nessy/managed-policy.json' },
    )
    expect(policy.model).toBeUndefined()
    expect(drops.map(drop => [drop.field, drop.disposition])).toContainEqual(['model', 'stripped'])
  })
})
