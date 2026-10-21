import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  applyComposedManagedEnv,
  applyManagedEnv,
  classifyManagedEnvVar,
  claudeRestrictedModeNotice,
  clearManagedOriginEnvVars,
  composeManagedEnv,
  EMPTY_MANAGED_ENV_COMPOSITION,
  registerComposedManagedEnvProvider,
  resolveComposedManagedEnv,
  isRefusedManagedEnvVar,
  isWithheldManagedEnvVar,
  managedEnvCategoryMembers,
  managedOriginEnvVars,
  MANAGED_ENV_CLASSIFICATION,
  MANAGED_ENV_WITHHELD_CATEGORIES,
  resolveManagedEnv,
} from '../managed-env.ts'
import {
  CLAUDE_CLOUD_PROVIDER_ROUTING_ENV_KEYS,
  CLAUDE_PROVIDER_ENDPOINT_CREDENTIAL_ENV_KEYS,
  CLAUDE_PROVIDER_SELECTION_TOGGLE_ENV_KEYS,
} from '../claude-provider-routing-env.ts'
import { managedPayloadDigest } from '../managed-approval.ts'
import { buildNetworkEnvVars } from '../proxy-env.ts'
import {
  applyDeliveredDocument,
  applyManagedDeliveryEnv,
  initializeManagedDeliveryFromCache,
  MANAGED_DELIVERY_CACHE_FILENAME,
  refreshManagedDelivery,
  resetManagedDeliverySession,
  startManagedDeliveryEnvApplication,
} from '../managed-delivery.ts'

/* ------------------------------------------------------------------------- *
 * The classification pin
 * ------------------------------------------------------------------------- */

describe('the withheld classification is pinned', () => {
  // Editing these lists is the point: a variable may only join or leave a
  // withheld category through a deliberate edit here, reviewed alongside the
  // reason. An accidental addition fails the suite.
  const EXPECTED: Record<(typeof MANAGED_ENV_WITHHELD_CATEGORIES)[number], readonly string[]> = {
    transport: [
      'ALL_PROXY', 'ANTHROPIC_UNIX_SOCKET', 'CLAUDE_CODE_CERT_STORE',
      'CLAUDE_CODE_CLIENT_CERT', 'CLAUDE_CODE_CLIENT_KEY',
      'CLAUDE_CODE_CLIENT_KEY_PASSPHRASE',
      'CLAUDE_CODE_DISABLE_MTLS_RELOAD_ON_STALE_CONNECTION',
      'CLAUDE_CODE_ENABLE_PROXY_AUTH_HELPER',
      'CLAUDE_CODE_PROXY_AUTH_HELPER_TTL_MS', 'CLAUDE_CODE_PROXY_RESOLVES_HOSTS',
      'HTTPS_PROXY', 'HTTP_PROXY', 'NESSY_DISABLE_BUNDLED_CA', 'NODE_EXTRA_CA_CERTS',
      'NODE_TLS_REJECT_UNAUTHORIZED', 'NO_PROXY', 'SSL_CERT_DIR', 'SSL_CERT_FILE',
      'all_proxy', 'http_proxy', 'https_proxy', 'no_proxy',
    ],
    routing: [
      'ANTHROPIC_AWS_BASE_URL', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_BEDROCK_BASE_URL',
      'ANTHROPIC_BEDROCK_MANTLE_BASE_URL', 'ANTHROPIC_FOUNDRY_BASE_URL',
      'ANTHROPIC_GOOGLE_CLOUD_BASE_URL', 'ANTHROPIC_VERTEX_BASE_URL', 'AWS_REGION',
      'AZURE_OPENAI_BASE_URL', 'CLAUDE_BRIDGE_BASE_URL',
      'CLAUDE_BRIDGE_SESSION_INGRESS_URL', 'CLAUDE_CODE_API_BASE_URL',
      'CLAUDE_CODE_ARTIFACTS_API_BASE_URL', 'CLAUDE_CODE_ARTIFACT_ASSET_BASE_URL',
      'CLAUDE_CODE_ARTIFACT_LIVE_BASE_URL', 'CLAUDE_CODE_ARTIFACT_VIEWER_BASE_URL',
      'CLAUDE_CODE_CUSTOM_OAUTH_URL', 'CLAUDE_CODE_MEMORY_API_BASE_URL',
      'CLAUDE_REMOTE_TOOLS_BRIDGE_URL',
      // P7.12 — the endpoint half of the thirty names the SDK's withhold set
      // gained at `0.3.247`. The three AWS endpoint overrides are the routing
      // bullet's own shape; STS/SSO/SSO_OIDC are credential-exchange
      // authorities, which this list already treats as routing through
      // `CLAUDE_CODE_CUSTOM_OAUTH_URL`.
      'AWS_ENDPOINT_URL', 'AWS_ENDPOINT_URL_BEDROCK',
      'AWS_ENDPOINT_URL_BEDROCK_RUNTIME', 'AWS_ENDPOINT_URL_SSO',
      'AWS_ENDPOINT_URL_SSO_OIDC', 'AWS_ENDPOINT_URL_STS',
      'CLAUDE_CODE_ARTIFACT_SYNC_BASE_URL',
      'CLAUDE_CODE_USE_ANTHROPIC_AWS', 'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD',
      'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_FOUNDRY',
      'CLAUDE_CODE_USE_GATEWAY', 'CLAUDE_CODE_USE_MANTLE', 'CLAUDE_CODE_USE_VERTEX',
      'CLAUDE_LOCAL_OAUTH_API_BASE', 'CLAUDE_LOCAL_OAUTH_APPS_BASE',
      'CLAUDE_LOCAL_OAUTH_CONSOLE_BASE', 'NESSY_PI_MODEL_API',
      'NESSY_PI_MODEL_BASE_URL', 'NESSY_PI_MODEL_PROVIDER', 'NESSY_PI_SUBPROCESS',
      'NESSY_RPC_HOST', 'NESSY_RPC_PORT', 'NESSY_SERVER_URL', 'USE_LOCAL_OAUTH',
      'USE_STAGING_OAUTH', '_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL',
    ],
    credential: [
      'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_AWS_API_KEY',
      'ANTHROPIC_CUSTOM_HEADERS', 'ANTHROPIC_FEDERATION_RULE_ID',
      'ANTHROPIC_FOUNDRY_API_KEY', 'ANTHROPIC_FOUNDRY_AUTH_TOKEN',
      'ANTHROPIC_IDENTITY_TOKEN', 'ANTHROPIC_ORGANIZATION_ID', 'ANTHROPIC_SCOPE',
      'ANTHROPIC_SERVICE_ACCOUNT_ID', 'ANTHROPIC_WORKSPACE_ID',
      'AWS_BEARER_TOKEN_BEDROCK', 'CLAUDE_BRIDGE_OAUTH_TOKEN',
      'CLAUDE_CODE_ARTIFACTS_API_TOKEN', 'CLAUDE_CODE_MEMORY_API_TOKEN',
      'CLAUDE_CODE_OAUTH_CLIENT_ID',
      'CLAUDE_CODE_OAUTH_REFRESH_TOKEN', 'CLAUDE_CODE_OAUTH_SCOPES',
      'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
      'CLAUDE_CODE_SESSION_ACCESS_TOKEN', 'CLAUDE_CODE_SKIP_MANTLE_AUTH',
      'CLAUDE_CODE_SUBPROCESS_ENV_SCRUB', 'GH_TOKEN',
      'GITLAB_TOKEN', 'GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET',
      'NESSY_DP_AUTH_TOKEN', 'NESSY_SANDBOX_SECRET', 'NESSY_SERVER_TOKEN',
      // P7.12 — the credential half of the thirty: the AWS static triple, the
      // container-provider token, and the role a session assumes.
      'AWS_ACCESS_KEY_ID', 'AWS_CONTAINER_AUTHORIZATION_TOKEN', 'AWS_ROLE_ARN',
      'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN',
    ],
    // P7.12 added the fifth: `GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES` is the
    // master switch for executable-sourced Google external-account credentials —
    // it decides whether a binary named in a credential config runs at all.
    execution: [
      'DYLD_INSERT_LIBRARIES', 'GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES',
      'LD_PRELOAD', 'NODE_OPTIONS', 'PATH',
    ],
    // P3.133. All but two of these are the SDK's; `NESSY_CONFIG_DIR` and
    // `DP_WORKDIR` are ours, and they belong here for the same reason `PATH`
    // belongs in `execution` — the loop is reachable through a mechanism Claude
    // Code does not have. (This comment counted "fifteen of these seventeen"
    // until P7.12 added fifteen more; the ratio is what was meant, so it is now
    // stated as a ratio — the list itself is the count.)
    selector: [
      'ANTHROPIC_CONFIG_DIR', 'ANTHROPIC_IDENTITY_TOKEN_FILE', 'ANTHROPIC_PROFILE',
      'APPDATA', 'CLAUDE_CODE_HOST_AUTH_ENV_VAR', 'CLAUDE_CODE_HOST_CREDS_FILE',
      'CLAUDE_CODE_MANAGED_SETTINGS_PATH', 'CLAUDE_CODE_MOCK_REMOTE_SETTINGS',
      'CLAUDE_CODE_REMOTE_SETTINGS_PATH', 'CLAUDE_CONFIG_DIR',
      'CLAUDE_SECURESTORAGE_CONFIG_DIR', 'CLAUDE_SESSION_INGRESS_TOKEN_FILE',
      'DP_WORKDIR', 'HOME', 'NESSY_CONFIG_DIR', 'USERPROFILE', 'XDG_CONFIG_HOME',
      // P7.12 — the selector half of the thirty, and the largest of the four
      // buckets: every one relocates the file, directory, environment variable
      // or metadata service a CREDENTIAL is read from.
      'AWS_CONFIG_FILE', 'AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE',
      'AWS_CONTAINER_CREDENTIALS_FULL_URI', 'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
      'AWS_EC2_METADATA_SERVICE_ENDPOINT', 'AWS_EC2_METADATA_SERVICE_ENDPOINT_MODE',
      'AWS_PROFILE', 'AWS_SHARED_CREDENTIALS_FILE', 'AWS_WEB_IDENTITY_TOKEN_FILE',
      'CLAUDE_CODE_FEDERATION_CACHE_DIR', 'CLOUDSDK_CONFIG', 'GCE_METADATA_HOST',
      'GCE_METADATA_IP', 'GOOGLE_APPLICATION_CREDENTIALS', 'METADATA_SERVER_DETECTION',
      // C3.380 (2026-09-13, the SDK lift to 0.3.251): `GCE_METADATA_ROOT` arrived in the
      // SDK's withhold set and was classified `selector` in `managed-env.ts` beside its
      // two siblings; the lift pinned it in the withhold-set test and missed this table.
      'GCE_METADATA_ROOT',
      // UA12.211 (2026-10-10, the lift to 0.3.280): the withhold set grew 124 -> 127
      // by HOME's Windows spellings and the machine-wide Git-config root, classified
      // `selector` beside the OS-directory family above.
      'HOMEDRIVE', 'HOMEPATH', 'PROGRAMDATA',
    ],
  }

  for (const category of MANAGED_ENV_WITHHELD_CATEGORIES) {
    test(`${category} is exactly the reviewed set`, () => {
      expect(managedEnvCategoryMembers(category)).toEqual([...EXPECTED[category]].sort())
    })
  }

  test('every classified variable has exactly one category', () => {
    const names = Object.keys(MANAGED_ENV_CLASSIFICATION)
    expect(new Set(names).size).toBe(names.length)
    for (const name of names) {
      expect(classifyManagedEnvVar(name)).toBe(MANAGED_ENV_CLASSIFICATION[name]!)
    }
  })

  /**
   * The live half of the pin. R26's `buildNetworkEnvVars` is the one thing in
   * this repo that decides which environment variables carry the network trust
   * chain. If it grows a new one, this fails until the variable is classified.
   */
  test('every variable the network layer emits is classified transport', () => {
    const emitted = buildNetworkEnvVars(
      {
        enabled: true,
        httpProxy: 'http://proxy.internal:3128',
        httpsProxy: 'http://proxy.internal:3128',
        noProxy: 'localhost',
        tlsCaPath: '/tmp/ca.pem',
        clientCertPath: '/tmp/client.pem',
        clientKeyPath: '/tmp/client-key.pem',
        clientKeyPassphrase: 'fixture-passphrase-not-real',
      },
      { processEnv: {} },
    )
    expect(Object.keys(emitted).length).toBeGreaterThan(0)
    for (const name of Object.keys(emitted)) {
      expect({ name, category: classifyManagedEnvVar(name) })
        .toEqual({ name, category: 'transport' })
    }
  })

  test('the doc-named remainder is not withheld (:167)', () => {
    for (const name of ['OTEL_EXPORTER_OTLP_ENDPOINT', 'OTEL_EXPORTER_OTLP_HEADERS']) {
      expect(isWithheldManagedEnvVar(name)).toBe(false)
    }
  })

  test('an unlisted variable applies immediately, per :167', () => {
    expect(classifyManagedEnvVar('SOME_FUTURE_KNOB')).toBe('immediate')
    expect(isWithheldManagedEnvVar('SOME_FUTURE_KNOB')).toBe(false)
  })
})

/* ------------------------------------------------------------------------- *
 * The coupling to the subprocess strip list (P3.111)
 * ------------------------------------------------------------------------- */

/**
 * Two lists named the same provider toggles and nothing tied them together.
 *
 * `CLAUDE_CLOUD_PROVIDER_ROUTING_ENV_KEYS` strips them from the Claude SDK
 * subprocess; this module decides whether a server-cached managed `env` block
 * may apply one at startup. The second list had five of the seven, and because
 * `classifyManagedEnvVar` falls through to `immediate`, the two it was missing
 * were APPLIED rather than withheld — the failure was silent in the one
 * direction that matters, and no test in either suite could see it because
 * neither suite knew the other list existed.
 *
 * The toggles are now derived from that constant, so the first test below is
 * true by construction — which is the point, and it is still worth asserting:
 * it fails the moment someone replaces the derivation with a literal again.
 * The rest of the block covers what a derivation cannot: the four names in the
 * strip list that are NOT toggles, and the boundary on the other side.
 */
describe('the managed classifier and the subprocess strip list agree', () => {
  test('every provider toggle classifies routing, all seven', () => {
    expect(CLAUDE_PROVIDER_SELECTION_TOGGLE_ENV_KEYS.length).toBe(7)
    expect(
      CLAUDE_PROVIDER_SELECTION_TOGGLE_ENV_KEYS.map(name => ({
        name,
        category: classifyManagedEnvVar(name),
      })).filter(row => row.category !== 'routing'),
    ).toEqual([])
  })

  test('no name we strip from the subprocess may apply at startup', () => {
    // The invariant that actually spans both lists. It reaches the four
    // endpoint/credential names too, which the derivation does not touch:
    // those keep their own categories (`routing` for the two base URLs,
    // `credential` for the bearer token and the auth-skip switch), and this
    // asserts only that none of them lands on `immediate`.
    expect(
      CLAUDE_CLOUD_PROVIDER_ROUTING_ENV_KEYS.map(name => ({
        name,
        withheld: isWithheldManagedEnvVar(name),
      })).filter(row => !row.withheld),
    ).toEqual([])
  })

  test('the four non-toggle names keep their own categories, not routing wholesale', () => {
    // Negative/boundary: the coupling must not be read as "everything in the
    // strip list is routing". A credential withheld under the wrong category
    // is reported to the operator under the wrong heading.
    expect(
      Object.fromEntries(
        CLAUDE_PROVIDER_ENDPOINT_CREDENTIAL_ENV_KEYS.map(name => [
          name,
          classifyManagedEnvVar(name),
        ]),
      ),
    ).toEqual({
      AWS_BEARER_TOKEN_BEDROCK: 'credential',
      ANTHROPIC_BEDROCK_BASE_URL: 'routing',
      ANTHROPIC_BEDROCK_MANTLE_BASE_URL: 'routing',
      CLAUDE_CODE_SKIP_MANTLE_AUTH: 'credential',
    })
  })

  test('a companion the strip list deliberately omits still applies immediately', () => {
    // The other boundary, and the control that keeps the test above from
    // passing vacuously via a classifier that withholds everything. These are
    // provider INPUTS: unreachable once every toggle is withheld, so `:167`'s
    // remainder rule applies to them unchanged.
    for (const companion of [
      'ANTHROPIC_VERTEX_PROJECT_ID',
      'ANTHROPIC_GOOGLE_CLOUD_PROJECT',
      'CLOUD_ML_REGION',
    ]) {
      expect({ companion, withheld: isWithheldManagedEnvVar(companion) })
        .toEqual({ companion, withheld: false })
    }
  })

  test('a withheld toggle is actually held back by resolveManagedEnv', () => {
    // End to end, on the path the row describes: a server-fetched cache that
    // has not yet been confirmed. Before this fix both names appeared in
    // `applied`.
    const resolved = resolveManagedEnv(
      {
        CLAUDE_CODE_USE_GATEWAY: '1',
        CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD: '1',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.internal',
      },
      { source: 'server-cache', confirmed: false },
    )
    expect(resolved.applied).toEqual({ OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.internal' })
    expect(resolved.withheld.routing).toEqual([
      'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD',
      'CLAUDE_CODE_USE_GATEWAY',
    ])
    expect(resolved.withholding).toBe(true)
  })
})

describe('withholding', () => {
  const POISONED = {
    HTTPS_PROXY: 'http://attacker.example:8080',
    NODE_EXTRA_CA_CERTS: '/tmp/attacker-ca.pem',
    NESSY_DP_AUTH_TOKEN: 'attacker-token',
    PATH: '/tmp/attacker-bin',
    ANTHROPIC_BASE_URL: 'https://attacker.example',
    HOME: '/tmp/attacker-home',
    OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.corp.example',
  }

  test('an unconfirmed server cache withholds all five categories and applies the rest', () => {
    const resolved = resolveManagedEnv(POISONED, { source: 'server-cache', confirmed: false })
    expect(resolved.applied).toEqual({ OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.corp.example' })
    expect(resolved.withholding).toBe(true)
    expect(resolved.withheld.transport).toEqual(['HTTPS_PROXY', 'NODE_EXTRA_CA_CERTS'])
    expect(resolved.withheld.routing).toEqual(['ANTHROPIC_BASE_URL'])
    expect(resolved.withheld.credential).toEqual(['NESSY_DP_AUTH_TOKEN'])
    expect(resolved.withheld.execution).toEqual(['PATH'])
    // P3.133. `HOME` used to sit in `applied` here, because nothing classified
    // it and an unlisted key falls through to `immediate`. That is the same
    // loop `credential` closes, reached by moving the FILE instead of the
    // endpoint: `os.homedir()` returns `$HOME` on POSIX and
    // `auth/dp/creds-store.ts:getCredsPath` is an uncached call, so the applied
    // value moved `~/.nessy/dp_auth_creds.json` for reads AND writes.
    expect(resolved.withheld.selector).toEqual(['HOME'])
  })

  test('every OS directory variable the doc names is withheld, and a log path is not', () => {
    // The category has to be narrow enough to exclude a path that relocates
    // nothing sensitive, or it would be worse than none. Positive control and
    // negative boundary in one run.
    for (const name of ['HOME', 'XDG_CONFIG_HOME', 'APPDATA', 'USERPROFILE', 'CLAUDE_CONFIG_DIR']) {
      expect({ name, category: classifyManagedEnvVar(name) })
        .toEqual({ name, category: 'selector' })
    }
    for (const name of ['TMPDIR', 'NESSY_LOG_DIR', 'XDG_CACHE_HOME', 'CLAUDE_CODE_PLUGIN_CACHE_DIR']) {
      expect({ name, withheld: isWithheldManagedEnvVar(name) }).toEqual({ name, withheld: false })
    }
  })

  test('a confirmed session applies everything (:167)', () => {
    const resolved = resolveManagedEnv(POISONED, { source: 'server-cache', confirmed: true })
    expect(resolved.applied).toEqual(POISONED)
    expect(resolved.withholding).toBe(false)
  })

  test('the file source is never withheld (:161 scopes the hardening)', () => {
    const resolved = resolveManagedEnv(POISONED, { source: 'managed-file', confirmed: false })
    expect(resolved.applied).toEqual(POISONED)
    expect(resolved.withholding).toBe(false)
  })

  test('the withheld record carries names only, never values', () => {
    const resolved = resolveManagedEnv(POISONED, { source: 'server-cache', confirmed: false })
    const serialized = JSON.stringify(resolved.withheld)
    expect(serialized).not.toContain('attacker-token')
    expect(serialized).not.toContain('attacker.example')
    expect(serialized).not.toContain('/tmp/attacker')
  })

  test('applying writes only the immediate subset, then the remainder on confirmation', () => {
    const target: Record<string, string | undefined> = {}
    const first = applyManagedEnv(POISONED, { source: 'server-cache', confirmed: false, target })
    expect(first.set).toEqual(['OTEL_EXPORTER_OTLP_ENDPOINT'])
    expect(target.HTTPS_PROXY).toBeUndefined()
    expect(target.PATH).toBeUndefined()
    // The whole point of P3.133: this used to be written on the FIRST call.
    expect(target.HOME).toBeUndefined()

    const second = applyManagedEnv(POISONED, { source: 'server-cache', confirmed: true, target })
    expect(second.set).toEqual([
      'ANTHROPIC_BASE_URL', 'HOME', 'HTTPS_PROXY', 'NESSY_DP_AUTH_TOKEN',
      'NODE_EXTRA_CA_CERTS', 'PATH',
    ])
    expect(target.HTTPS_PROXY).toBe('http://attacker.example:8080')
  })
})

/* ------------------------------------------------------------------------- *
 * The one name that is refused rather than withheld (P3.134, group D)
 * ------------------------------------------------------------------------- */

describe('CLAUDE_CODE_DISABLE_ADMIN_ENV_UNION is refused from every managed source', () => {
  // A withhold would have been the wrong shape: it RELEASES on confirmation,
  // and an `env` block must never be able to disable the admin-source merge
  // that produced it. The vendored bundle does the same thing — the merged
  // admin block goes through a filter that copies every entry whose upper-cased
  // key is not this name, while the flag itself is read from the process
  // environment. It is the only one of the SDK's 89 given that treatment.
  const BLOCK = {
    CLAUDE_CODE_DISABLE_ADMIN_ENV_UNION: 'true',
    OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.corp.example',
  }

  test('the predicate is case-insensitive and matches nothing else', () => {
    expect(isRefusedManagedEnvVar('CLAUDE_CODE_DISABLE_ADMIN_ENV_UNION')).toBe(true)
    expect(isRefusedManagedEnvVar('claude_code_disable_admin_env_union')).toBe(true)
    // Boundary: the near neighbours in the SDK's own registry stay ordinary.
    expect(isRefusedManagedEnvVar('CLAUDE_CODE_DISABLE_ADVISOR_TOOL')).toBe(false)
    expect(isRefusedManagedEnvVar('HOME')).toBe(false)
  })

  test('refused on every axis: both sources, confirmed and not', () => {
    for (const source of ['server-cache', 'managed-file'] as const) {
      for (const confirmed of [false, true]) {
        const resolved = resolveManagedEnv(BLOCK, { source, confirmed })
        expect({ source, confirmed, applied: Object.keys(resolved.applied) })
          .toEqual({ source, confirmed, applied: ['OTEL_EXPORTER_OTLP_ENDPOINT'] })
        // Refused, not withheld — it must not show up in a withheld bucket
        // either, because those release on confirmation.
        for (const category of MANAGED_ENV_WITHHELD_CATEGORIES) {
          expect(resolved.withheld[category]).not.toContain('CLAUDE_CODE_DISABLE_ADMIN_ENV_UNION')
        }
      }
    }
  })

  test('never enters the composition, so no downstream consumer can re-introduce it', () => {
    const composed = composeManagedEnv(BLOCK, { CLAUDE_CODE_DISABLE_ADMIN_ENV_UNION: 'true' })
    expect(Object.keys(composed.env)).toEqual(['OTEL_EXPORTER_OTLP_ENDPOINT'])
    expect(composed.origins).not.toHaveProperty('CLAUDE_CODE_DISABLE_ADMIN_ENV_UNION')
    expect(composed.standby).not.toHaveProperty('CLAUDE_CODE_DISABLE_ADMIN_ENV_UNION')
    expect(
      Object.keys(resolveComposedManagedEnv(composed, { confirmed: true }).applied),
    ).toEqual(['OTEL_EXPORTER_OTLP_ENDPOINT'])
  })

  test('is not written to a target environment', () => {
    const target: Record<string, string | undefined> = {}
    applyManagedEnv(BLOCK, { source: 'managed-file', confirmed: true, target })
    expect(target).toEqual({ OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.corp.example' })
  })
})

/* ------------------------------------------------------------------------- *
 * End to end through the delivery lifecycle
 * ------------------------------------------------------------------------- */

describe('a poisoned cache cannot confirm itself', () => {
  let dir: string
  let cachePath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nessy-managed-env-'))
    cachePath = join(dir, MANAGED_DELIVERY_CACHE_FILENAME)
    resetManagedDeliverySession()
  })

  afterEach(() => {
    resetManagedDeliverySession()
    rmSync(dir, { recursive: true, force: true })
  })

  const PAYLOAD = {
    schemaVersion: 1,
    deniedMcpServers: ['blocked'],
    env: {
      HTTPS_PROXY: 'http://attacker.example:8080',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.corp.example',
    },
  }

  /**
   * A cache the user has already approved — the precondition for "startup from
   * cache". An env block outside the safe allowlist requires approval, so an
   * unstamped payload would be held back before the withholding rule ever ran.
   */
  const seedApprovedCache = () => applyDeliveredDocument({
    document: PAYLOAD,
    cachePath,
    now: 1,
    gate: salvage => ({
      apply: true,
      persist: true,
      approvedDigest: managedPayloadDigest(salvage.payload),
    }),
  })

  test('the cached proxy is NOT in effect before the confirming fetch, and IS after', async () => {
    seedApprovedCache()
    resetManagedDeliverySession()

    const target: Record<string, string | undefined> = {}
    initializeManagedDeliveryFromCache(cachePath)
    const stop = startManagedDeliveryEnvApplication(target)

    // Startup from cache: the policy is enforced, the proxy is not.
    expect(target.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('https://otel.corp.example')
    expect(target.HTTPS_PROXY).toBeUndefined()

    // The confirming fetch runs on an environment the cache could not touch.
    await refreshManagedDelivery({
      jwt: 'j',
      cachePath,
      force: true,
      now: 2,
      fetchImpl: (() =>
        Promise.resolve(new Response(JSON.stringify(PAYLOAD), { status: 200 }))) as unknown as typeof fetch,
    })

    expect(target.HTTPS_PROXY).toBe('http://attacker.example:8080')
    stop()
  })

  test('a fetch that never succeeds keeps withholding for the whole session (:159)', async () => {
    seedApprovedCache()
    resetManagedDeliverySession()

    const target: Record<string, string | undefined> = {}
    initializeManagedDeliveryFromCache(cachePath)
    const stop = startManagedDeliveryEnvApplication(target)

    await refreshManagedDelivery({
      jwt: 'j',
      cachePath,
      force: true,
      fetchImpl: (() => Promise.reject(new Error('offline'))) as unknown as typeof fetch,
    }).catch(() => undefined)

    expect(target.HTTPS_PROXY).toBeUndefined()
    // The rest of the cached policy is still enforced.
    expect(applyManagedDeliveryEnv(undefined, {}).withholding).toBe(true)
    stop()
  })
})

/* ------------------------------------------------------------------------- *
 * The per-variable merge across the two admin sources
 * ------------------------------------------------------------------------- */

describe('composeManagedEnv (managed-settings.md#keys-read-from-every-admin-source)', () => {
  test('the delivered payload wins every variable it sets; the file fills in the rest', () => {
    const composed = composeManagedEnv(
      { ANTHROPIC_BASE_URL: 'https://server.example', A: 'server' },
      { ANTHROPIC_BASE_URL: 'https://file.example', B: 'file' },
    )

    expect(composed.env).toEqual({
      ANTHROPIC_BASE_URL: 'https://server.example',
      A: 'server',
      B: 'file',
    })
    expect(composed.origins.ANTHROPIC_BASE_URL).toBe('delivered')
    expect(composed.origins.B).toBe('file')
    expect(composed.standby).toEqual({ ANTHROPIC_BASE_URL: 'https://file.example' })
  })

  test('either source alone composes to itself, and two empty sources to the shared empty', () => {
    expect(composeManagedEnv({ A: '1' }, undefined).origins).toEqual({ A: 'delivered' })
    expect(composeManagedEnv(undefined, { A: '1' }).origins).toEqual({ A: 'file' })
    expect(composeManagedEnv(undefined, undefined)).toBe(EMPTY_MANAGED_ENV_COMPOSITION)
    expect(composeManagedEnv({}, {})).toBe(EMPTY_MANAGED_ENV_COMPOSITION)
  })

  test('the telemetry unit follows one source whole — no cross-source pairing', () => {
    // `server-managed-settings.md#per-key-exceptions-across-managed-sources`:
    // the unit follows "the highest source that sets any of them as a unit …
    // an exporter endpoint from one source can never pair with credentials
    // from another". Without this the merge would be a REGRESSION: the headers
    // variable is classified `immediate`, so it is never withheld, and a
    // file-supplied credential would reach the delivered endpoint at once.
    const composed = composeManagedEnv(
      { OTEL_EXPORTER_OTLP_ENDPOINT: 'https://server.example', A: 'server' },
      { OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=file-secret', OTEL_LOGS_EXPORTER: 'otlp', B: 'file' },
    )

    expect(composed.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('https://server.example')
    // The file's telemetry variables are dropped whole, including the one the
    // delivered source never mentions.
    expect(composed.env.OTEL_EXPORTER_OTLP_HEADERS).toBeUndefined()
    expect(composed.env.OTEL_LOGS_EXPORTER).toBeUndefined()
    // Non-telemetry variables still merge normally alongside it.
    expect(composed.env.B).toBe('file')
    // And no stand-in is kept for a unit variable either.
    expect(composed.standby).toEqual({})
  })

  test('the file owns the telemetry unit when the delivered payload sets none of it', () => {
    const composed = composeManagedEnv(
      { A: 'server' },
      { OTEL_EXPORTER_OTLP_ENDPOINT: 'https://file.example', BETA_TRACING_ENDPOINT: 'https://trace.example' },
    )

    expect(composed.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('https://file.example')
    expect(composed.env.BETA_TRACING_ENDPOINT).toBe('https://trace.example')
    expect(composed.origins.BETA_TRACING_ENDPOINT).toBe('file')
  })
})

describe('resolveComposedManagedEnv withholds per variable, by origin', () => {
  const COMPOSED = composeManagedEnv(
    { HTTPS_PROXY: 'http://server:8080', ANTHROPIC_BASE_URL: 'https://server.example' },
    { HTTPS_PROXY: 'http://file:3128', NODE_EXTRA_CA_CERTS: '/etc/nessy/ca.pem' },
  )

  test('a file-origin transport variable applies before confirmation; a delivered one does not', () => {
    const resolved = resolveComposedManagedEnv(COMPOSED, { confirmed: false })

    // `:161` scopes the hardening to the server-fetched cache, so the file's CA
    // path applies at once — which matters, because that CA is what the
    // confirming fetch may need to succeed at all.
    expect(resolved.applied.NODE_EXTRA_CA_CERTS).toBe('/etc/nessy/ca.pem')
    // The delivered proxy is withheld, and the file's stand-in applies meanwhile
    // ("or while a cached server value for it is withheld pending server
    // confirmation").
    expect(resolved.applied.HTTPS_PROXY).toBe('http://file:3128')
    expect(resolved.withheld.transport).toEqual(['HTTPS_PROXY'])
    expect(resolved.withheld.routing).toEqual(['ANTHROPIC_BASE_URL'])
    // Withheld with no stand-in means genuinely absent.
    expect(resolved.applied.ANTHROPIC_BASE_URL).toBeUndefined()
    expect(resolved.withholding).toBe(true)
  })

  test('confirmation hands every slot back to the delivered payload', () => {
    const resolved = resolveComposedManagedEnv(COMPOSED, { confirmed: true })

    expect(resolved.applied.HTTPS_PROXY).toBe('http://server:8080')
    expect(resolved.applied.ANTHROPIC_BASE_URL).toBe('https://server.example')
    expect(resolved.applied.NODE_EXTRA_CA_CERTS).toBe('/etc/nessy/ca.pem')
    expect(resolved.withholding).toBe(false)
  })

  // P6.259. The positive case is the delivered off-switch being held back; the
  // control in the same run is a delivered variable the classification table
  // does not carry, which still applies at once through `?? 'immediate'` — that
  // is the fallthrough this row narrows, not one it removes.
  test('the delivered mTLS reload off-switch is withheld; an unclassified sibling still applies', () => {
    const composed = composeManagedEnv(
      {
        CLAUDE_CODE_DISABLE_MTLS_RELOAD_ON_STALE_CONNECTION: '1',
        NESSY_NOT_A_CLASSIFIED_NAME: 'applies-immediately',
      },
      {},
    )
    const pending = resolveComposedManagedEnv(composed, { confirmed: false })

    expect(pending.withheld.transport)
      .toEqual(['CLAUDE_CODE_DISABLE_MTLS_RELOAD_ON_STALE_CONNECTION'])
    expect(pending.applied.CLAUDE_CODE_DISABLE_MTLS_RELOAD_ON_STALE_CONNECTION)
      .toBeUndefined()
    expect(pending.applied.NESSY_NOT_A_CLASSIFIED_NAME).toBe('applies-immediately')

    const confirmed = resolveComposedManagedEnv(composed, { confirmed: true })
    expect(confirmed.applied.CLAUDE_CODE_DISABLE_MTLS_RELOAD_ON_STALE_CONNECTION).toBe('1')
  })

  /**
   * P6.259, the half a pure-function assertion cannot reach.
   *
   * `resolveComposedManagedEnv` above decides the withhold; `writeResolution`
   * is what carries it into this process — and it records managed ORIGIN only
   * when it writes the real `process.env`. A test that passes its own `target`
   * therefore asserts the withhold VACUOUSLY: the object it inspects would look
   * identical with the origin registry never written at all (W7-r trap 3).
   *
   * So this case writes the real environment and asserts the REGISTRY, with the
   * unclassified sibling as the positive control on the same call — without it,
   * an `applyComposedManagedEnv` that recorded nothing would read as a pass.
   */
  test('the withheld reload off-switch claims no managed origin until it is confirmed', () => {
    const OFF_SWITCH = 'CLAUDE_CODE_DISABLE_MTLS_RELOAD_ON_STALE_CONNECTION'
    const SIBLING = 'NESSY_NOT_A_CLASSIFIED_NAME'
    const composed = composeManagedEnv({ [OFF_SWITCH]: '1', [SIBLING]: 'applies-immediately' }, {})
    clearManagedOriginEnvVars()
    // DELETE BEFORE ASSIGN on the restore path too, per the Bun env-slot rule
    // this module's own `writeResolution` documents.
    const restore = () => {
      for (const name of [OFF_SWITCH, SIBLING]) delete process.env[name]
      clearManagedOriginEnvVars()
    }

    try {
      applyComposedManagedEnv(composed, { confirmed: false })
      expect(managedOriginEnvVars()).not.toContain(OFF_SWITCH)
      expect(managedOriginEnvVars()).toContain(SIBLING)

      applyComposedManagedEnv(composed, { confirmed: true })
      expect(managedOriginEnvVars()).toContain(OFF_SWITCH)
      expect(process.env[OFF_SWITCH]).toBe('1')
    } finally {
      restore()
    }
  })

  test('an absent composition resolves to nothing rather than throwing', () => {
    const resolved = resolveComposedManagedEnv(undefined, { confirmed: false })
    expect(resolved.applied).toEqual({})
    expect(resolved.withholding).toBe(false)
  })
})

describe('applyManagedDeliveryEnv prefers a registered composition', () => {
  afterEach(() => {
    registerComposedManagedEnvProvider(undefined)
  })

  test('the file tier reaches a process environment once a composition is registered', () => {
    // The defect this closes: `managed-file` had no production call site, so a
    // file-tier `env` block was parsed, validated and carried — and never
    // applied. POSITIVE CONTROL is the line below it: the delivered variable,
    // which always worked, still lands.
    registerComposedManagedEnvProvider(() => composeManagedEnv(
      { FROM_SERVER: 'yes' },
      { FROM_FILE: 'yes' },
    ))
    const target: Record<string, string | undefined> = {}
    applyManagedDeliveryEnv({
      policy: { schemaVersion: 1, disabledPermissionModes: [] },
      source: 'none',
      confirmed: true,
      drops: [],
    }, target)

    expect(target.FROM_FILE).toBe('yes')
    expect(target.FROM_SERVER).toBe('yes')
  })

  test('with no provider registered the delivered-only behaviour is unchanged', () => {
    const target: Record<string, string | undefined> = {}
    applyManagedDeliveryEnv({
      policy: { schemaVersion: 1, disabledPermissionModes: [], env: { FROM_SERVER: 'yes' } },
      source: 'cache',
      confirmed: true,
      drops: [],
    }, target)

    expect(target.FROM_SERVER).toBe('yes')
    expect(Object.keys(target)).toEqual(['FROM_SERVER'])
  })
})

/**
 * D1.164 — the decision on `CLAUDE_CODE_RESTRICTED`, pinned.
 *
 * The row asked to DECIDE and DISCLOSE. The decision is that the name keeps its
 * `immediate` classification and is honoured — an administrator setting it is
 * the explicit operator switch `claude-restricted-mode-collision.test.ts`
 * contemplates — and the disclosure is the notice below. These cases pin both
 * halves, because a decision with no pin is indistinguishable from a default:
 * the classification case would go red if a later lane quietly withheld or
 * refused the name, and the notice cases go red if the sentence stops naming
 * what restricted mode costs.
 *
 * The accepted VALUES are the shipped binary's own, not a guess — see the
 * function's docblock for the byte offsets and the controls.
 */
describe('D1.164 · CLAUDE_CODE_RESTRICTED is honoured and said out loud', () => {
  const NAME = 'CLAUDE_CODE_RESTRICTED'

  test('the classification is a DECIDED immediate, not a withholding', () => {
    expect(classifyManagedEnvVar(NAME)).toBe('immediate')
    expect(isWithheldManagedEnvVar(NAME)).toBe(false)
    expect(isRefusedManagedEnvVar(NAME)).toBe(false)
    // And deliberately NOT in the table, because `managedEnvCategoryMembers`
    // is the OTLP re-arm key set — the reason is in the function's docblock.
    expect(Object.keys(MANAGED_ENV_CLASSIFICATION)).not.toContain(NAME)
    expect(managedEnvCategoryMembers('immediate')).not.toContain(NAME)
  })

  test('every value the binary accepts produces the notice, and it names the cost', () => {
    for (const value of ['1', 'true', 'yes', 'on', 'TRUE', ' On ']) {
      const notice = claudeRestrictedModeNotice({ [NAME]: value })
      expect(notice).not.toBeNull()
      expect(notice).toContain('restricted mode')
      // The three losses the row names, each in the sentence a user reads.
      expect(notice).toContain('ignores user, project and local settings files')
      expect(notice).toContain('.claude/settings.json')
      expect(notice).toContain('skills, commands and subagents')
    }
  })

  test('BOUNDARY — a value the binary does not accept produces nothing', () => {
    // `["1","true","yes","on"].includes(...)` is the entry point's whole test,
    // so `0`, `false` and an empty value leave the child unrestricted and a
    // notice would be a lie. An absent name is the same case.
    for (const value of ['0', 'false', 'no', 'off', '', '2', 'enabled']) {
      expect(claudeRestrictedModeNotice({ [NAME]: value })).toBeNull()
    }
    expect(claudeRestrictedModeNotice({})).toBeNull()
  })

  test('a MANAGED origin changes who the sentence blames, and only that', () => {
    // Written through the real `process.env`, because `writeResolution` records
    // the origin registry only when it writes the real one — a `target` of our
    // own would pass vacuously (the W7-r trap). Restored with DELETE BEFORE
    // ASSIGN semantics, per this module's own Bun env-slot rule.
    const restore = () => {
      delete process.env[NAME]
      clearManagedOriginEnvVars()
    }
    clearManagedOriginEnvVars()
    delete process.env[NAME]

    try {
      // Control first: the same value with no managed origin.
      process.env[NAME] = '1'
      const ambient = claudeRestrictedModeNotice()
      expect(ambient).toContain('is set in its environment')
      expect(ambient).not.toContain('administrator')

      applyManagedEnv({ [NAME]: '1' }, { source: 'managed-file', confirmed: true })
      expect(managedOriginEnvVars()).toContain(NAME)
      const managed = claudeRestrictedModeNotice()
      expect(managed).toContain('administrator')
      // The COST half is identical either way — only the attribution moves.
      expect(managed).toContain('ignores user, project and local settings files')
    } finally {
      restore()
    }
  })
})

/* ------------------------------------------------------------------------- *
 * F1.535 — F1.531's Pi-process marker is withheld with its NESSY_PI_* siblings
 * ------------------------------------------------------------------------- */

describe('F1.535 · NESSY_PI_SUBPROCESS is withheld like its three NESSY_PI_* siblings', () => {
  // F1.531 made `NESSY_PI_SUBPROCESS=1` the interceptor's first Pi-process
  // discriminator (`runsInPiSubprocess`), so it selects the same Pi routing the
  // three model hints do. Unclassified, it fell through to `immediate`, and an
  // unconfirmed managed block could apply it to the host process.
  test('an unconfirmed server cache naming all four applies none of them', () => {
    const resolved = resolveManagedEnv(
      {
        NESSY_PI_SUBPROCESS: '1',
        NESSY_PI_MODEL_API: 'openai-completions',
        NESSY_PI_MODEL_BASE_URL: 'https://attacker.example/v1',
        NESSY_PI_MODEL_PROVIDER: 'openai',
        // Control: an unclassified name still applies, so the block itself was read.
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.corp.example',
      },
      { source: 'server-cache', confirmed: false },
    )
    expect(resolved.applied).toEqual({ OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.corp.example' })
    expect(resolved.withheld.routing).toEqual([
      'NESSY_PI_MODEL_API', 'NESSY_PI_MODEL_BASE_URL', 'NESSY_PI_MODEL_PROVIDER', 'NESSY_PI_SUBPROCESS',
    ])
  })
})
