/**
 * F1.242 — the wire credential is adapted before Pi stores it.
 *
 * pi-ai 0.84.4 `dist/auth/resolve.js` `resolveProviderAuthWithSignal`: a STORED
 * credential owns its provider — ambient env is read only "when nothing is
 * stored" — an `oauth` credential resolves only through `provider.auth.oauth`,
 * an `api_key` only through `provider.auth.apiKey`, and every other case is
 * `return undefined`. The host's two non-native wire shapes both hit that:
 *  - ChatGPT Plus (`openai-codex`, which declares only `auth.oauth`) arrives as
 *    `api_key` — the host ran the OAuth exchange and ships the bearer token —
 *    so it resolved to nothing;
 *  - Bedrock `iam` matches no handler (`amazon-bedrock` declares only
 *    `auth.apiKey`) and, stored, shadowed the AWS env the host injects at spawn.
 *
 * Every arm reads pi-ai's OWN declarations, never a hand list: the oauth-only
 * set is derived from `builtinProviders()`, and the end-to-end arms resolve
 * through the production registry seam (`createPiRuntimeAdapter().createRegistry`,
 * the one `index.ts` uses). So F1.255's lift to Pi 0.85.x is checked by these
 * arms rather than assumed: a provider that changes its auth handlers moves the
 * derived set, and a resolver that changes its stored-credential rule turns the
 * control arms red.
 *
 * F1.321 (WJ-au, 2026-09-24): `getAuth` resolving is not a request being made.
 * The `prepareRequest` arms drive the method `ModelRuntime.stream` /
 * `complete` call before any provider sees a request (TS-private, runtime
 * public), so the production request path is what a revert of the adapter
 * breaks: verbatim, it throws `Provider is not configured: <provider>` —
 * measured by the F1.242 verifier's `e2e-probe.out`, and pinned here.
 */

import { describe, expect, it } from 'bun:test'
import type { Model, Api } from '@earendil-works/pi-ai'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { bracedRegion } from '../../shared/src/testing/source-regions.ts'
import { InMemoryCredentialStore, type Credential as PiStoredCredential } from '@earendil-works/pi-ai'
import { builtinProviders } from '@earendil-works/pi-ai/providers/all'
import { adaptCredentialForPiSdk, type PiWireCredential } from './adapt-credential.ts'
import { createPiRuntimeAdapter } from './compat/pi-runtime-adapter.ts'

const AWS_ENV = { AWS_ACCESS_KEY_ID: 'AKIA_F1242_TEST', AWS_SECRET_ACCESS_KEY: 'f1242-test-secret' }
const IAM: PiWireCredential = {
  type: 'iam',
  accessKeyId: AWS_ENV.AWS_ACCESS_KEY_ID,
  secretAccessKey: AWS_ENV.AWS_SECRET_ACCESS_KEY,
  region: 'eu-west-1',
}

/** A registry built by the production seam, its store holding `stored` (or nothing). */
async function registryHolding(provider: string, stored: PiStoredCredential | null) {
  const credentials = new InMemoryCredentialStore()
  if (stored) await credentials.modify(provider, async () => stored)
  return createPiRuntimeAdapter().createRegistry(credentials)
}

type PiModelRuntime = Awaited<ReturnType<typeof registryHolding>>['modelRuntime']
interface PreparedRequest { provider: { id: string }; options: { apiKey?: string } }

/**
 * `ModelRuntime.prepareRequest` — the step `stream()` / `complete()` take before a
 * provider sees the request (resolve auth, or throw `Provider is not configured`).
 * TS-private, so it is reached through a cast; `env` is the per-request overlay
 * `getAuth` reads first, so no case here writes `process.env`.
 */
function prepareRequest(runtime: PiModelRuntime, provider: string, env?: Record<string, string>): Promise<PreparedRequest> {
  const model = runtime.getModels(provider)[0] as Model<Api> | undefined
  if (!model) throw new Error(`no ${provider} model in the catalogue`)
  const prepare = (runtime as unknown as {
    prepareRequest(model: Model<Api>, options?: { env?: Record<string, string> }): Promise<PreparedRequest>
  }).prepareRequest.bind(runtime)
  return prepare(model, env ? { env } : undefined)
}

/**
 * The ambient names vendored pi-ai's Bedrock `resolve` reads when nothing is
 * stored (`providers/amazon-bedrock.js`, 0.84.4 — env names only: no file, no
 * metadata service). A machine carrying any of them resolves Bedrock by
 * itself, so the no-env control below is skipped there rather than measuring
 * the machine.
 */
const BEDROCK_AMBIENT_NAMES = [
  'AWS_BEARER_TOKEN_BEDROCK', 'AWS_PROFILE', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY',
  'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI', 'AWS_CONTAINER_CREDENTIALS_FULL_URI', 'AWS_WEB_IDENTITY_TOKEN_FILE',
]
const AMBIENT_BEDROCK = BEDROCK_AMBIENT_NAMES.some(name => Boolean(process.env[name]))

describe('adaptCredentialForPiSdk (F1.242) — shapes', () => {
  it('rewraps a ChatGPT bearer token shipped as api_key into oauth for openai-codex', () => {
    expect(adaptCredentialForPiSdk('openai-codex', { type: 'api_key', key: 'chatgpt-jwt' })).toEqual({
      type: 'oauth',
      access: 'chatgpt-jwt',
      refresh: '',
      expires: Number.MAX_SAFE_INTEGER,
    })
  })

  it('stores nothing for a Bedrock iam credential', () => {
    expect(adaptCredentialForPiSdk('amazon-bedrock', IAM)).toBeNull()
  })

  it('negative control: an api_key for a provider WITH an apiKey handler passes through unchanged', () => {
    const credential: PiWireCredential = { type: 'api_key', key: 'sk-plain' }
    expect(adaptCredentialForPiSdk('openai', credential)).toBe(credential)
    expect(adaptCredentialForPiSdk('anthropic', credential)).toBe(credential)
    // A custom endpoint is not in the builtin catalogue at all.
    expect(adaptCredentialForPiSdk('custom-endpoint', credential)).toBe(credential)
  })

  it('an oauth credential passes through unchanged (github-copilot ships the real shape)', () => {
    const credential: PiWireCredential = { type: 'oauth', access: 'a', refresh: 'r', expires: 1_234_567_890 }
    expect(adaptCredentialForPiSdk('github-copilot', credential)).toBe(credential)
  })

  it('the oauth-only set is pi-ai\'s own: every builtin provider is classified by its declared handlers', () => {
    const providers = builtinProviders()
    expect(providers.length).toBeGreaterThan(0)
    for (const p of providers) {
      const adapted = adaptCredentialForPiSdk(p.id, { type: 'api_key', key: 'k' })
      const oauthOnly = Boolean(p.auth.oauth) && !p.auth.apiKey
      expect({ id: p.id, type: adapted?.type }).toEqual({ id: p.id, type: oauthOnly ? 'oauth' : 'api_key' })
    }
    // The measured reading on pi-ai 0.84.4 (2026-09-23), so a lift that moves it is visible here.
    expect(providers.filter(p => p.auth.oauth && !p.auth.apiKey).map(p => p.id)).toContain('openai-codex')
  })
})

describe('adaptCredentialForPiSdk (F1.242) — resolution through the production registry', () => {
  it('Bedrock: with the iam credential adapted (nothing stored), getAuth resolves through the AWS env', async () => {
    const adapted = adaptCredentialForPiSdk('amazon-bedrock', IAM)
    const { modelRuntime } = await registryHolding('amazon-bedrock', adapted)
    const resolution = await modelRuntime.getAuth('amazon-bedrock', { env: AWS_ENV })
    // F1.321 — the access-key branch, not merely "something resolved".
    expect(resolution?.source).toBe('AWS access keys')
  })

  it.skipIf(AMBIENT_BEDROCK)('control (F1.321): nothing stored and no AWS env — Bedrock resolves NOTHING', async () => {
    const { modelRuntime } = await registryHolding('amazon-bedrock', null)
    expect(await modelRuntime.getAuth('amazon-bedrock')).toBeUndefined()
  })

  it('control: the SAME iam stored verbatim resolves NOTHING, even with the AWS env present', async () => {
    const { modelRuntime } = await registryHolding('amazon-bedrock', IAM as unknown as PiStoredCredential)
    expect(await modelRuntime.getAuth('amazon-bedrock', { env: AWS_ENV })).toBeUndefined()
  })

  it('ChatGPT: the rewrapped bearer authenticates openai-codex', async () => {
    const adapted = adaptCredentialForPiSdk('openai-codex', { type: 'api_key', key: 'chatgpt-jwt' })
    const { modelRuntime } = await registryHolding('openai-codex', adapted)
    const resolution = await modelRuntime.getAuth('openai-codex')
    expect(resolution?.auth.apiKey).toBe('chatgpt-jwt')
  })

  it('control: the same bearer stored verbatim as api_key resolves NOTHING for openai-codex', async () => {
    const { modelRuntime } = await registryHolding('openai-codex', { type: 'api_key', key: 'chatgpt-jwt' })
    expect(await modelRuntime.getAuth('openai-codex')).toBeUndefined()
  })

  it('negative control: an api_key for openai (apiKey handler) still resolves as stored', async () => {
    const adapted = adaptCredentialForPiSdk('openai', { type: 'api_key', key: 'sk-plain' })
    const { modelRuntime } = await registryHolding('openai', adapted)
    expect((await modelRuntime.getAuth('openai'))?.auth.apiKey).toBe('sk-plain')
  })
})

describe('adaptCredentialForPiSdk (F1.242 · F1.321) — the production request path (prepareRequest)', () => {
  it('Bedrock: verbatim iam refuses the request; adapted, the request is prepared through the AWS env', async () => {
    const verbatim = await registryHolding('amazon-bedrock', IAM as unknown as PiStoredCredential)
    await expect(prepareRequest(verbatim.modelRuntime, 'amazon-bedrock', AWS_ENV))
      .rejects.toThrow('Provider is not configured: amazon-bedrock')
    const adapted = await registryHolding('amazon-bedrock', adaptCredentialForPiSdk('amazon-bedrock', IAM))
    const prepared = await prepareRequest(adapted.modelRuntime, 'amazon-bedrock', AWS_ENV)
    expect(prepared.provider.id).toBe('amazon-bedrock')
  })

  it('ChatGPT: the bearer stored verbatim refuses the request; rewrapped, the request carries it', async () => {
    const verbatim = await registryHolding('openai-codex', { type: 'api_key', key: 'chatgpt-jwt' })
    await expect(prepareRequest(verbatim.modelRuntime, 'openai-codex'))
      .rejects.toThrow('Provider is not configured: openai-codex')
    const adapted = await registryHolding('openai-codex', adaptCredentialForPiSdk('openai-codex', { type: 'api_key', key: 'chatgpt-jwt' }))
    expect((await prepareRequest(adapted.modelRuntime, 'openai-codex')).options.apiKey).toBe('chatgpt-jwt')
  })
})

/**
 * The production WRITE path. `storePiCredential` (`index.ts`) is the only
 * `CredentialStore.modify` call in the server, and every store (init,
 * ephemeral registries, `token_update` rotation) goes through it. Its wiring is
 * pinned by SOURCE because `storePiCredential` is not exported, and
 * `__tests__/index-import-guard.test.ts` is deliberately the one importer of
 * `index.ts` (F1.322: this note used to say the module "cannot be imported by a
 * test", which that file's own guard refutes). Without this arm the suite above
 * would be equally green with the adapter never called — a stub of exactly the
 * seam that was broken.
 */
describe('F1.242 — storePiCredential stores what the adapter returns', () => {
  it('adapts before it stores, and stores nothing when the adapter says null', () => {
    const src = readFileSync(join(import.meta.dir, 'index.ts'), 'utf8')
    const body = bracedRegion(src, src.indexOf('async function storePiCredential('))
    expect(body).toContain('adaptCredentialForPiSdk(provider, credential)')
    expect(body).toContain('if (adapted) await credentials.modify(provider, async () => adapted)')
    // Boundary control: the next declaration BELOW the anchor is not inside the region.
    expect(body).not.toContain('async function createAuthenticatedRegistry(')
    // And it is the only writer: every `.modify(provider` in the whole server entry
    // stores `adapted`, so no raw write of the wire credential survives anywhere.
    // F1.321: counted against the ADAPTED form, because a count of `.modify(provider`
    // alone is 1 on a revert too (the reverted line is still one `.modify(provider`).
    const writes = src.split('.modify(provider').length - 1
    expect(writes).toBeGreaterThan(0)
    expect(src.split('.modify(provider, async () => adapted)').length - 1).toBe(writes)
  })
})
