import { describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { NESSY_HOME_ENV } from '@nessy-agent/shared/auth/dp'
import { NESTOR_GATEWAY_MODEL_WINDOWS } from '@nessy-agent/shared/auth/nestor'
import { makeTestJwt } from '@nessy-agent/shared/auth/dp/__tests__/test-jwt.ts'

const SERVICE_MODULE_URL = pathToFileURL(join(import.meta.dir, '..', 'index.ts')).href
const SUBPROCESS_TEST_TIMEOUT_MS = 120_000

function writeConfig(connections: unknown[]) {
  const configDir = mkdtempSync(join(tmpdir(), 'nessy-model-refresh-'))
  const configPath = join(configDir, 'config.json')
  writeFileSync(configPath, JSON.stringify({
    storageLayoutVersion: 2,
    workspaceRefs: [],
    activeWorkspaceId: null,
    activeSessionId: null,
    defaultLlmConnection: connections[0] && typeof connections[0] === 'object' && 'slug' in connections[0]
      ? (connections[0] as { slug: string }).slug
      : null,
    llmConnections: connections,
  }, null, 2), 'utf-8')
  return { configDir, configPath }
}

/**
 * DA1.3 — every subprocess below runs under a TEMP `HOME` carrying a fabricated
 * `~/.nessy/dp_auth_creds.json`, because the Nestor fetcher now authenticates
 * from the live dp credentials rather than from the connection's stored key.
 *
 * The temp home is not a convenience. Without it these cases would read the
 * developer's real creds file, so the suite would pass or fail on whether
 * whoever ran it happens to be signed in — and it would put a real token on a
 * stubbed `fetch`. `HOME` at SPAWN is honoured on every runtime this repo uses
 * (`config/home-latch.ts` measured Node, Electron and Bun); it is the
 * mid-process move that does not travel, which is what the latch is for.
 *
 * DA1.50 · three segments is NOT everything `getValidCreds` asks of the value:
 * it gates on `isUsableJwt`, so the value must also DECODE to an object carrying
 * a numeric `exp`. `makeTestJwt` builds exactly that, unsigned and fabricated,
 * so no real credential exists anywhere in this file.
 */
const SUBPROCESS_JWT = makeTestJwt({ preferred_username: 'subprocess', sub: 'subprocess' })
/** What the card stores today and what this path deliberately stops sending. */
const STORED_SNAPSHOT_KEY = 'stored-snapshot-key'

function makeDpHome(jwt: string | null = SUBPROCESS_JWT): string {
  const home = mkdtempSync(join(tmpdir(), 'nessy-model-refresh-home-'))
  if (jwt !== null) {
    mkdirSync(join(home, '.nessy'), { recursive: true })
    writeFileSync(
      join(home, '.nessy', 'dp_auth_creds.json'),
      JSON.stringify({ jwt, expiresAt: Date.now() + 60 * 60 * 1000, username: 'fixture', userId: 'fixture' }),
      'utf-8',
    )
  }
  return home
}

/**
 * The env every subprocess below is launched with — DA1.36.
 *
 * Spreading `process.env` and adding `HOME` was NOT isolation: `NESSY_HOME`
 * OUTRANKS `HOME` inside the creds resolver (`packages/shared/src/auth/dp/creds-store.ts`
 * symbol `getNessyDir` returns an absolute value verbatim and never consults the
 * latch), so the spread carried a developer's own relocation straight into the
 * child and these cases read a REAL creds directory — putting whatever token was
 * there onto a stubbed `fetch`.
 *
 * The copy is kept and the relocation names are REMOVED, rather than an
 * allowlist being written: an allowlist would have to guess what bun itself
 * needs of its environment, while the invariant that actually matters —
 * "no name that re-points the creds resolver reaches the child" — is total and
 * says itself. `NESSY_HOME` is the whole list today: `getValidCreds` reads the
 * file and nothing else, and the env-token bypass (`NESSY_DP_AUTH_TOKEN`) is on
 * `ensureNessyGatewayAuth`'s path, which no fetcher case reaches.
 */
function childEnv(configDir: string, dpHome: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined) env[name] = value
  }
  delete env[NESSY_HOME_ENV]
  env.NESSY_CONFIG_DIR = configDir
  // DA1.3 — the live dp creds this refresh now authenticates from.
  env.HOME = dpHome
  return env
}

function makeConnection(overrides: Record<string, unknown> = {}) {
  return {
    slug: 'nessy-gateway',
    name: 'Nessy Gateway',
    providerType: 'pi_compat',
    authType: 'api_key_with_endpoint',
    baseUrl: 'https://code-completion-nestor.tcsbank.ru/api/v1/cli/openai-like/v1',
    defaultModel: 'tgpt/qwen35-397b-a17b-fp8',
    models: [
      {
        id: 'tgpt/qwen35-397b-a17b-fp8',
        name: 'Qwen 3.5 397B',
        shortName: 'Qwen Coder',
        description: 'Internal gateway default coding model.',
        provider: 'pi',
        contextWindow: 131_072,
        supportsThinking: false,
        supportsImages: false,
      },
      {
        id: 'tgpt/qwen36-35b-a3b-fp8',
        name: 'Qwen 3.6 35B',
        shortName: 'Qwen Fast',
        description: 'Internal gateway fast model.',
        provider: 'pi',
        contextWindow: 131_072,
        supportsThinking: false,
        supportsImages: false,
      },
    ],
    createdAt: 1,
    ...overrides,
  }
}

function runRefresh(configDir: string, slug: string, dpHome: string = makeDpHome()) {
  return Bun.spawnSync([
    process.execPath,
    '--eval',
    `
      const seen = [];
      globalThis.fetch = async (url, init) => {
        seen.push({ url: String(url), token: new Headers(init?.headers).get('Nestor-Token') });
        return new Response(JSON.stringify([
          { id: 'tgpt/qwen36-35b-a3b-fp8', alias: 'fast', desc: 'Fast model', is_default: false },
          { id: 'tgpt/qwen35-397b-a17b-fp8', alias: 'coder', desc: 'Coder model', is_default: true }
        ]), { status: 200 });
      };
      const { initModelRefreshService } = await import(${JSON.stringify(SERVICE_MODULE_URL)});
      const service = initModelRefreshService(async () => (${JSON.stringify({ apiKey: 'stored-snapshot-key' })}));
      await service.refreshConnection(${JSON.stringify(slug)});
      console.log('__NESTOR__' + JSON.stringify(seen));
    `,
  ], {
    env: childEnv(configDir, dpHome),
    stdout: 'pipe',
    stderr: 'pipe',
  })
}

/** The requests `runRefresh`'s stub recorded, with the header each carried. */
function readNestorCalls(stdout: string): Array<{ url: string; token: string | null }> {
  const marker = stdout.lastIndexOf('__NESTOR__')
  if (marker < 0) return []
  return JSON.parse(stdout.slice(marker + '__NESTOR__'.length).split('\n')[0]!)
}

const DAY_MS = 24 * 60 * 60 * 1000

function makeByoConnection(overrides: Record<string, unknown> = {}) {
  return {
    slug: 'byo-llm-proxy',
    name: 'llm-proxy',
    providerType: 'pi_compat',
    authType: 'api_key_with_endpoint',
    baseUrl: 'https://llm-proxy.t-tech.team',
    customEndpoint: { api: 'openai-completions' },
    defaultModel: 'tgpt/qwen35-397b-a17b-fp8',
    modelSelectionMode: 'userDefined3Tier',
    models: [
      { id: 'tgpt/qwen35-397b-a17b-fp8', name: 'My Qwen', shortName: 'Qwen', description: 'stale', provider: 'pi', contextWindow: 131_072 },
      { id: 'model-the-catalog-forgot', name: 'Gone Upstream', shortName: 'Gone', description: 'kept', provider: 'pi', contextWindow: 8192 },
    ],
    ...overrides,
  }
}

/** The catalog: one row the user picked, one they did not. */
const BYO_CATALOG = {
  object: 'list',
  data: [
    { id: 'tgpt/qwen35-397b-a17b-fp8', context_length: 262_144, description: 'Qwen coder', owned_by: 'tgpt' },
    { id: 'catalog-only-row', context_length: 1_000_000, description: 'not picked', owned_by: 'tgpt' },
  ],
}

/**
 * Runs the service in a subprocess against a temp config, with the fetch calls
 * and the scheduled-timer count reported back on stdout. `entry` picks between
 * the direct refresh and the startup path, which have INDEPENDENT skip gates.
 */
function runService(
  configDir: string,
  { slug, entry = 'refresh', credentials = "{ apiKey: 'jwt-token' }", body = BYO_CATALOG }:
    { slug: string; entry?: 'refresh' | 'startAll'; credentials?: string; body?: unknown },
) {
  const invocation = entry === 'startAll'
    // startAll's own fetch is fire-and-forget; refreshConnection dedupes onto
    // the same in-flight promise, so awaiting it awaits the startup fetch.
    ? `service.startAll(); await service.refreshConnection(${JSON.stringify(slug)});`
    : `await service.refreshConnection(${JSON.stringify(slug)});`

  const result = Bun.spawnSync([
    process.execPath,
    '--eval',
    `
      const calls = [];
      globalThis.fetch = async (url, init) => {
        const headers = new Headers(init?.headers);
        calls.push({ url: String(url), auth: headers.get('Authorization') });
        return new Response(JSON.stringify(${JSON.stringify(body)}), { status: 200 });
      };
      let timers = 0;
      const realSetInterval = globalThis.setInterval;
      globalThis.setInterval = (...args) => { timers += 1; return realSetInterval(...args); };
      const { initModelRefreshService } = await import(${JSON.stringify(SERVICE_MODULE_URL)});
      const service = initModelRefreshService(async () => (${credentials}));
      ${invocation}
      service.stopAll();
      console.log('__PROBE__' + JSON.stringify({ calls, timers }));
    `,
  ], {
    env: childEnv(configDir, makeDpHome()),
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const stdout = result.stdout.toString()
  const marker = stdout.lastIndexOf('__PROBE__')
  const probe = marker >= 0
    ? JSON.parse(stdout.slice(marker + '__PROBE__'.length).split('\n')[0]!) as { calls: Array<{ url: string; auth: string | null }>; timers: number }
    : { calls: [], timers: 0 }
  return { result, probe }
}

describe('ModelRefreshService BYO metadata sync', () => {
  it('merges metadata onto the ids the user picked, without changing the id set', () => {
    const staleStamp = Date.now() - 2 * DAY_MS
    const { configDir, configPath } = writeConfig([makeByoConnection({ modelsSyncedAt: staleStamp })])

    const { result, probe } = runService(configDir, { slug: 'byo-llm-proxy' })
    expect(result.exitCode, result.stderr.toString()).toBe(0)
    expect(probe.calls.map(c => c.url)).toEqual(['https://llm-proxy.t-tech.team/models'])

    const connection = JSON.parse(readFileSync(configPath, 'utf-8')).llmConnections[0]
    // The id set is the user's: the catalog-only row never appears, and the row
    // the catalog forgot is kept rather than deleted.
    expect(connection.models.map((m: { id: string }) => m.id)).toEqual([
      'tgpt/qwen35-397b-a17b-fp8',
      'model-the-catalog-forgot',
    ])
    // Metadata is the backend's…
    expect(connection.models[0]).toMatchObject({
      contextWindow: 262_144,
      description: 'Qwen coder',
      // …but the name the user chose survives — this fetcher derives name from id.
      name: 'My Qwen',
      shortName: 'Qwen',
    })
    expect(connection.models[1]).toMatchObject({ contextWindow: 8192, description: 'kept' })
    // D1.162 — the PER-ENTRY provenance fact, which this list is the only place
    // that can answer: the id the catalog still serves and the id it dropped sit
    // side by side, and the picker could not tell them apart.
    expect(connection.models[0].catalogueListed).toBe(true)
    expect(connection.models[1].catalogueListed).toBe(false)
    // User-owned fields are never touched by the refresh.
    expect(connection.defaultModel).toBe('tgpt/qwen35-397b-a17b-fp8')
    expect(connection.modelSelectionMode).toBe('userDefined3Tier')
    expect(connection.modelsSyncedAt).toBeGreaterThan(staleStamp)
  }, SUBPROCESS_TEST_TIMEOUT_MS)

  it('leaves a hand-typed list unstamped — "never synced" is not "not listed" (D1.162)', () => {
    const original = makeByoConnection()
    const { configDir, configPath } = writeConfig([original])

    const { result } = runService(configDir, { slug: 'byo-llm-proxy' })
    expect(result.exitCode, result.stderr.toString()).toBe(0)
    const saved = JSON.parse(readFileSync(configPath, 'utf-8')).llmConnections[0]
    // No enrolment marker, so no fetch and no stamp — `undefined` on every row.
    for (const model of saved.models) {
      expect(model.catalogueListed).toBeUndefined()
    }
  }, SUBPROCESS_TEST_TIMEOUT_MS)

  it('skips a connection that was never stamped (no enrollment marker)', () => {
    const original = makeByoConnection()
    const { configDir, configPath } = writeConfig([original])

    const { result, probe } = runService(configDir, { slug: 'byo-llm-proxy' })
    expect(result.exitCode, result.stderr.toString()).toBe(0)
    expect(probe.calls).toEqual([])
    expect(JSON.parse(readFileSync(configPath, 'utf-8')).llmConnections[0]).toEqual(original)
  }, SUBPROCESS_TEST_TIMEOUT_MS)

  it('skips the fetch while the stamp is fresher than the 24h TTL', () => {
    const original = makeByoConnection({ modelsSyncedAt: Date.now() - 60_000 })
    const { configDir, configPath } = writeConfig([original])

    const { result, probe } = runService(configDir, { slug: 'byo-llm-proxy' })
    expect(result.exitCode, result.stderr.toString()).toBe(0)
    expect(probe.calls).toEqual([])
    expect(JSON.parse(readFileSync(configPath, 'utf-8')).llmConnections[0]).toEqual(original)
  }, SUBPROCESS_TEST_TIMEOUT_MS)

  it('skips an anthropic-messages custom endpoint — its /models carries no context length', () => {
    const original = makeByoConnection({
      customEndpoint: { api: 'anthropic-messages' },
      modelsSyncedAt: Date.now() - 2 * DAY_MS,
    })
    const { configDir, configPath } = writeConfig([original])

    const { result, probe } = runService(configDir, { slug: 'byo-llm-proxy' })
    expect(result.exitCode, result.stderr.toString()).toBe(0)
    expect(probe.calls).toEqual([])
    expect(JSON.parse(readFileSync(configPath, 'utf-8')).llmConnections[0]).toEqual(original)
  }, SUBPROCESS_TEST_TIMEOUT_MS)

  it('still fetches for a keyless local endpoint, and sends no Authorization header', () => {
    const { configDir } = writeConfig([makeByoConnection({
      slug: 'ollama-local',
      baseUrl: 'http://localhost:11434/v1',
      modelsSyncedAt: Date.now() - 2 * DAY_MS,
    })])

    const { result, probe } = runService(configDir, { slug: 'ollama-local', credentials: '{}' })
    expect(result.exitCode, result.stderr.toString()).toBe(0)
    expect(probe.calls.map(c => c.url)).toEqual(['http://localhost:11434/v1/models'])
    expect(probe.calls[0]!.auth).toBeNull()
  }, SUBPROCESS_TEST_TIMEOUT_MS)

  it('fetches at startup through BOTH skip gates, and schedules no timer', () => {
    const { configDir, configPath } = writeConfig([makeByoConnection({ modelsSyncedAt: Date.now() - 2 * DAY_MS })])

    const { result, probe } = runService(configDir, { slug: 'byo-llm-proxy', entry: 'startAll' })
    expect(result.exitCode, result.stderr.toString()).toBe(0)
    // startAll() reaches the fetch: both `continue` gates opened.
    expect(probe.calls.map(c => c.url)).toEqual(['https://llm-proxy.t-tech.team/models'])
    // …and it stopped before the timer block, where this.fetchers['pi_compat']
    // is undefined. A periodic timer here would also defeat the 24h TTL.
    expect(probe.timers).toBe(0)

    const connection = JSON.parse(readFileSync(configPath, 'utf-8')).llmConnections[0]
    expect(connection.models[0]).toMatchObject({ contextWindow: 262_144 })
  }, SUBPROCESS_TEST_TIMEOUT_MS)

  it('leaves a nestor-cloud-agent connection alone', () => {
    const original = makeByoConnection({
      slug: 'cloud-agent',
      providerType: 'nestor-cloud-agent',
      modelsSyncedAt: Date.now() - 2 * DAY_MS,
    })
    const { configDir, configPath } = writeConfig([original])

    const { result, probe } = runService(configDir, { slug: 'cloud-agent' })
    expect(result.exitCode, result.stderr.toString()).toBe(0)
    expect(probe.calls).toEqual([])
    expect(JSON.parse(readFileSync(configPath, 'utf-8')).llmConnections[0]).toEqual(original)
  }, SUBPROCESS_TEST_TIMEOUT_MS)
})

describe('ModelRefreshService Nestor refresh', () => {
  it('refreshes the Nessy Gateway pi_compat connection while preserving overrides and default', () => {
    const { configDir, configPath } = writeConfig([makeConnection()])

    const result = runRefresh(configDir, 'nessy-gateway')
    expect(result.exitCode, result.stderr.toString()).toBe(0)

    const config = JSON.parse(readFileSync(configPath, 'utf-8'))
    const connection = config.llmConnections[0]
    expect(connection.defaultModel).toBe('tgpt/qwen35-397b-a17b-fp8')
    expect(connection.models.map((m: { id: string }) => m.id)).toEqual([
      'tgpt/qwen36-35b-a3b-fp8',
      'tgpt/qwen35-397b-a17b-fp8',
    ])
    // Through the constant, not a literal: the stub reports no context window,
    // so these land on the shipped fallback table — which is now half harvested
    // (`scripts/refresh-nestor-model-windows.ts`) and resolves a disagreement
    // downward, so its value moves when the gateway's does.
    const coderWindow = NESTOR_GATEWAY_MODEL_WINDOWS['tgpt/qwen35-397b-a17b-fp8']
    expect(connection.models[1]).toMatchObject({
      id: 'tgpt/qwen35-397b-a17b-fp8',
      name: 'coder (tgpt/qwen35-397b-a17b-fp8)',
      contextWindow: coderWindow,
      supportsImages: false,
      supportsThinking: false,
    })
    expect(connection.models.every((m: { id: string; contextWindow?: number; supportsImages?: boolean }) =>
      m.contextWindow === NESTOR_GATEWAY_MODEL_WINDOWS[m.id] && m.supportsImages === false
    )).toBe(true)
  }, SUBPROCESS_TEST_TIMEOUT_MS)

  // DA1.3 (positive). The header is the LIVE dp JWT, and the credential
  // resolver's stored snapshot — which both production injections still supply,
  // in `apps/electron/src/main/index.ts` and in `packages/server/src/index.ts` —
  // reaches the wire nowhere. One fix in the fetcher, both resolvers covered.
  it('authenticates the Nestor catalogue with the live dp JWT, not the stored connection key', () => {
    const { configDir } = writeConfig([makeConnection()])

    const result = runRefresh(configDir, 'nessy-gateway')
    expect(result.exitCode, result.stderr.toString()).toBe(0)

    const calls = readNestorCalls(result.stdout.toString())
    expect(calls).toEqual([{
      url: 'https://code-completion-nestor.tcsbank.ru/api/v1/cli/models',
      token: SUBPROCESS_JWT,
    }])
    expect(calls.map(c => c.token)).not.toContain(STORED_SNAPSHOT_KEY)
  }, SUBPROCESS_TEST_TIMEOUT_MS)

  // DA1.36 (the isolation invariant). A developer's exported `NESSY_HOME` used
  // to ride the `{ ...process.env }` spread into the child, where it OUTRANKS
  // the temp `HOME` this suite sets. The decoy below is that developer: it
  // points at a directory holding a DIFFERENT fabricated JWT, and the child
  // must still answer with the one `makeDpHome` wrote. Remove `childEnv`'s
  // delete and this case reports the decoy's token instead.
  it('a NESSY_HOME exported in the parent cannot re-point the child at another creds directory', () => {
    const { configDir } = writeConfig([makeConnection()])
    const decoyHome = makeDpHome(makeTestJwt({ preferred_username: 'decoy', sub: 'decoy' }))
    const saved = process.env[NESSY_HOME_ENV]

    let result
    try {
      // `delete` first, then assign, on both paths — a name Bun pre-creates a
      // slot for stays invisible to the very spread `childEnv` copies from
      // (AGENTS.md §Traps), and this case exists to watch that spread.
      delete process.env[NESSY_HOME_ENV]
      process.env[NESSY_HOME_ENV] = join(decoyHome, '.nessy')
      result = runRefresh(configDir, 'nessy-gateway')
    } finally {
      delete process.env[NESSY_HOME_ENV]
      if (saved !== undefined) process.env[NESSY_HOME_ENV] = saved
    }

    expect(result.exitCode, result.stderr.toString()).toBe(0)
    expect(readNestorCalls(result.stdout.toString())).toEqual([{
      url: 'https://code-completion-nestor.tcsbank.ru/api/v1/cli/models',
      token: SUBPROCESS_JWT,
    }])
  }, SUBPROCESS_TEST_TIMEOUT_MS)

  // DA1.3 (negative). No valid creds — the refresh issues NO request and the
  // stored catalogue survives untouched. Before this row the same state sent
  // `Nestor-Token: ''` and earned the gateway's "invalid number of segments"
  // 401, which reads to a user as *the model list is broken* while chat works.
  it('issues no request and keeps the stored catalogue when there are no valid dp creds', () => {
    const original = makeConnection()
    const { configDir, configPath } = writeConfig([original])

    const result = runRefresh(configDir, 'nessy-gateway', makeDpHome(null))
    expect(result.exitCode, result.stderr.toString()).toBe(0)

    expect(readNestorCalls(result.stdout.toString())).toEqual([])
    expect(JSON.parse(readFileSync(configPath, 'utf-8')).llmConnections[0]).toEqual(original)
  }, SUBPROCESS_TEST_TIMEOUT_MS)

  // DA1.47 (the residue R7 measured, and the case that would have caught it).
  // A BYO `pi_compat` endpoint on ANOTHER path under the same `…/api/v1/cli/`
  // prefix passed the router's old prefix test, so the refresh spent the shared
  // dp JWT on the GATEWAY's own catalogue URL and then wrote the gateway's model
  // list over the user's. `…/api/v1/personal/x` above is outside the prefix and
  // was never affected, which is why it stayed green through the defect; this
  // URL is INSIDE it, and it is the arm `GatewayRuntimeModelFetcher` already
  // refused for the two adapter-runtime cards.
  it('a BYO pi_compat endpoint under the CLI prefix spends no dp JWT and keeps its own models (DA1.47)', () => {
    const original = makeConnection({
      slug: 'byo-under-prefix',
      baseUrl: 'https://code-completion-nestor.tcsbank.ru/api/v1/cli/byo-proxy/v1',
      defaultModel: 'byo/some-model',
      models: ['byo/some-model'],
    })
    const { configDir, configPath } = writeConfig([original])

    const result = runRefresh(configDir, 'byo-under-prefix')
    expect(result.exitCode, result.stderr.toString()).toBe(0)

    // No egress at all: in particular no `Nestor-Token` on the catalogue URL.
    expect(readNestorCalls(result.stdout.toString())).toEqual([])
    // And the user's own list is untouched — the half that made this a data
    // loss rather than only a credential leak.
    expect(JSON.parse(readFileSync(configPath, 'utf-8')).llmConnections[0]).toEqual(original)
  }, SUBPROCESS_TEST_TIMEOUT_MS)

  // DA1.47 (the positive control beside it). The one-click card's own base URL
  // is the gateway, and it still refreshes from the catalogue with the live dp
  // JWT — so the negative above is a narrowing and not a switch-off.
  it('the gateway card itself still refreshes from the catalogue (DA1.47 control)', () => {
    const { configDir } = writeConfig([makeConnection()])

    const result = runRefresh(configDir, 'nessy-gateway')
    expect(result.exitCode, result.stderr.toString()).toBe(0)

    expect(readNestorCalls(result.stdout.toString())).toEqual([{
      url: 'https://code-completion-nestor.tcsbank.ru/api/v1/cli/models',
      token: SUBPROCESS_JWT,
    }])
  }, SUBPROCESS_TEST_TIMEOUT_MS)

  // DA2.12 — the refresh STAMP, through a real subprocess because that is the
  // only instrument that sees BOTH halves: the fetcher writing it and
  // `updateLlmConnection`'s merge ALLOWLIST carrying it. A field missing from
  // that allowlist is dropped on the next save of any other field, silently,
  // which is the issue-#838 trap its own comment names.
  it('a gateway refresh stamps catalogueRefreshedAt, and it is not modelsSyncedAt (DA2.12)', () => {
    const original = makeConnection()
    const { configDir, configPath } = writeConfig([original])
    const before = Date.now()

    const result = runRefresh(configDir, 'nessy-gateway')
    expect(result.exitCode, result.stderr.toString()).toBe(0)

    const connection = JSON.parse(readFileSync(configPath, 'utf-8')).llmConnections[0]
    expect(typeof connection.catalogueRefreshedAt).toBe('number')
    expect(connection.catalogueRefreshedAt).toBeGreaterThanOrEqual(before)
    // The ENROLMENT marker is untouched: stamping it here would enrol the card
    // in the BYO metadata sync and give one model list two writers, which is
    // exactly the shortcut C3.346 refused.
    expect(connection.modelsSyncedAt).toBeUndefined()
  }, SUBPROCESS_TEST_TIMEOUT_MS)

  // DA2.12 (negative). A refresh that issues NO request leaves the stamp alone —
  // a time that says "read just now" beside a list nobody read is worse than no
  // time at all, which is the whole reason the picker refused to guess.
  it('a refresh with no valid creds leaves catalogueRefreshedAt absent (DA2.12)', () => {
    const { configDir, configPath } = writeConfig([makeConnection()])

    const result = runRefresh(configDir, 'nessy-gateway', makeDpHome(null))
    expect(result.exitCode, result.stderr.toString()).toBe(0)

    const connection = JSON.parse(readFileSync(configPath, 'utf-8')).llmConnections[0]
    expect(connection.catalogueRefreshedAt).toBeUndefined()
  }, SUBPROCESS_TEST_TIMEOUT_MS)

  it('still skips non-Nestor pi_compat connections', () => {
    const original = makeConnection({
      slug: 'personal-endpoint',
      baseUrl: 'https://code-completion-nestor.tcsbank.ru/api/v1/personal/x',
      defaultModel: 'personal-model',
      models: ['personal-model'],
    })
    const { configDir, configPath } = writeConfig([original])

    const result = runRefresh(configDir, 'personal-endpoint')
    expect(result.exitCode, result.stderr.toString()).toBe(0)

    const config = JSON.parse(readFileSync(configPath, 'utf-8'))
    expect(config.llmConnections[0]).toEqual(original)
  }, SUBPROCESS_TEST_TIMEOUT_MS)
})

/**
 * E2 — a BYO adapter-runtime connection (Claude Code / Codex pointed at the
 * user's own endpoint) enrolls in the same 24h metadata sync.
 *
 * These connections never carry a `customEndpoint` — emitting one would rewrite
 * them to `pi_compat` and kill the local adapter — so the protocol cannot be
 * read off the connection and the runtime pair is itself the marker. Both
 * adapters speak to an OpenAI-compatible upstream; `UpstreamTarget` is
 * `{nestor, openai-compatible}` and nothing else.
 */
function makeRuntimeConnection(overrides: Record<string, unknown> = {}) {
  return {
    slug: 'claude-custom',
    name: 'Claude Code (Custom Endpoint)',
    providerType: 'claude-runtime',
    authType: 'api_key_with_endpoint',
    baseUrl: 'https://llm-proxy.t-tech.team',
    defaultModel: 'tgpt/qwen35-397b-a17b-fp8',
    models: [
      { id: 'tgpt/qwen35-397b-a17b-fp8', name: 'My Qwen', shortName: 'Qwen', description: 'stale', provider: 'pi', contextWindow: 131_072 },
    ],
    createdAt: 1,
    ...overrides,
  }
}

describe('ModelRefreshService — BYO adapter-runtime enrollment (E2)', () => {
  it('fetches and merges for an enrolled runtime connection on the user own endpoint', () => {
    const staleStamp = Date.now() - 2 * DAY_MS
    const { configDir, configPath } = writeConfig([makeRuntimeConnection({ modelsSyncedAt: staleStamp })])

    const { result, probe } = runService(configDir, { slug: 'claude-custom' })
    expect(result.exitCode, result.stderr.toString()).toBe(0)
    expect(probe.calls.map(c => c.url)).toEqual(['https://llm-proxy.t-tech.team/models'])

    const connection = JSON.parse(readFileSync(configPath, 'utf-8')).llmConnections[0]
    // Merge, never replace — same contract as the pi_compat shape.
    expect(connection.models.map((m: { id: string }) => m.id)).toEqual(['tgpt/qwen35-397b-a17b-fp8'])
    expect(connection.models[0]).toMatchObject({ contextWindow: 262_144, description: 'Qwen coder', name: 'My Qwen' })
    expect(connection.modelsSyncedAt).toBeGreaterThan(staleStamp)
  }, SUBPROCESS_TEST_TIMEOUT_MS)

  it('leaves an unenrolled runtime connection on today behaviour', () => {
    // No stamp: this must reach the gateway fetcher exactly as before, not the
    // merge path. The proof is that the fetch does NOT go to /models on the
    // user's endpoint.
    const { configDir } = writeConfig([makeRuntimeConnection()])

    const { result, probe } = runService(configDir, { slug: 'claude-custom' })
    expect(result.exitCode, result.stderr.toString()).toBe(0)
    expect(probe.calls.map(c => c.url)).not.toContain('https://llm-proxy.t-tech.team/models')
  }, SUBPROCESS_TEST_TIMEOUT_MS)

  it('never enrolls a gateway one-click runtime connection, stamp or not', () => {
    // Belt and braces: no stamp is ever written for these, so the marker alone
    // would already refuse. The URL guard is what stops a stamp that arrived by
    // some other route from pointing this path at the gateway, which has its own
    // fetcher and its own cadence — two writers on one model list.
    const { configDir } = writeConfig([makeRuntimeConnection({
      slug: 'claude-gateway',
      baseUrl: 'https://code-completion-nestor.tcsbank.ru/api/v1/cli/openai-like/v1',
      modelsSyncedAt: Date.now() - 2 * DAY_MS,
    })])

    const { result, probe } = runService(configDir, { slug: 'claude-gateway' })
    expect(result.exitCode, result.stderr.toString()).toBe(0)
    expect(probe.calls.map(c => c.url)).not.toContain(
      'https://code-completion-nestor.tcsbank.ru/api/v1/cli/openai-like/v1/models',
    )
  }, SUBPROCESS_TEST_TIMEOUT_MS)

  it('schedules NO timer for an enrolled runtime connection at startup', () => {
    // The gateway runtime fetcher's `refreshIntervalMs` is 3 600 000, so without
    // the stop an enrolled connection would carry an hourly timer whose every
    // tick is a no-op the 24h TTL refuses — against someone else's endpoint.
    const { configDir } = writeConfig([makeRuntimeConnection({ modelsSyncedAt: Date.now() - 2 * DAY_MS })])

    const { result, probe } = runService(configDir, { slug: 'claude-custom', entry: 'startAll' })
    expect(result.exitCode, result.stderr.toString()).toBe(0)
    expect(probe.calls.map(c => c.url)).toEqual(['https://llm-proxy.t-tech.team/models'])
    expect(probe.timers).toBe(0)
  }, SUBPROCESS_TEST_TIMEOUT_MS)
})

/**
 * P6.1080 — a stored default the gateway has RETIRED, and the model that
 * answers instead.
 *
 * The row this covers is release-critical and its premise was measured, not
 * assumed. On 2026-09-11 the Nessy Gateway answered
 * `404 Модель tgpt/qwen35-397b-a17b-fp8 больше не поддерживается` for the id
 * this repo called the default coder model, and `/cli/models` listed two others.
 * Every gateway connection in the author's own config had already been migrated
 * off it by this very code path — between the 2026-09-03 and 2026-09-07 config
 * snapshots — and nothing anywhere said so.
 *
 * Three claims, one per case:
 *
 * 1. the chain prefers the catalogue's own `is_default`;
 * 2. when that flag is ABSENT it takes the `coder` ALIAS, not `models[0]` —
 *    which on this catalogue is the FAST model, i.e. a coding session silently
 *    downgraded to the cheap tier. The flag is not dependable: W12-e read this
 *    catalogue at 10:00 that day and recorded neither row carrying it, and a
 *    probe forty minutes later found it on the coder row;
 * 3. a default the catalogue still serves is untouched, and nothing is recorded
 *    — the negative arm, without which every case above could be satisfied by
 *    substituting unconditionally.
 */
function runRetiredDefaultRefresh(configDir: string, slug: string, rows: unknown[]) {
  return Bun.spawnSync([
    process.execPath,
    '--eval',
    `
      globalThis.fetch = async () => new Response(JSON.stringify(${JSON.stringify(rows)}), { status: 200 });
      const mod = await import(${JSON.stringify(SERVICE_MODULE_URL)});
      const service = mod.initModelRefreshService(async () => ({ apiKey: 'stored-snapshot-key' }));
      await service.refreshConnection(${JSON.stringify(slug)});
      console.log('SUBSTITUTION ' + JSON.stringify(mod.peekModelDefaultSubstitution(${JSON.stringify(slug)}) ?? null));
    `,
  ], {
    env: childEnv(configDir, makeDpHome()),
    stdout: 'pipe',
    stderr: 'pipe',
  })
}

/** The live catalogue, 2026-09-11 — coder SECOND, which is what makes case 2 bite. */
const LIVE_ROWS = [
  { id: 'tgpt/qwen36-35b-a3b-fp8', alias: 'fast', desc: 'fast', is_default: false, context_window_size: 262_000 },
  { id: 'tgpt/deepseek-v4-flash-0731', alias: 'coder', desc: 'coder', is_default: true, context_window_size: 524_000 },
]

function readSubstitution(stdout: string) {
  const line = stdout.split('\n').find(l => l.startsWith('SUBSTITUTION '))
  return line ? JSON.parse(line.slice('SUBSTITUTION '.length)) : undefined
}

describe('ModelRefreshService — a retired default (P6.1080)', () => {
  it('falls back to the catalogue\'s own is_default and RECORDS which model answers', () => {
    const { configDir, configPath } = writeConfig([makeConnection()])

    const result = runRetiredDefaultRefresh(configDir, 'nessy-gateway', LIVE_ROWS)
    expect(result.exitCode, result.stderr.toString()).toBe(0)

    const saved = JSON.parse(readFileSync(configPath, 'utf-8'))
    expect(saved.llmConnections[0].defaultModel).toBe('tgpt/deepseek-v4-flash-0731')

    const substitution = readSubstitution(result.stdout.toString())
    expect(substitution).toMatchObject({
      slug: 'nessy-gateway',
      from: 'tgpt/qwen35-397b-a17b-fp8',
      to: 'tgpt/deepseek-v4-flash-0731',
      via: 'catalogue-default',
    })
  }, SUBPROCESS_TEST_TIMEOUT_MS)

  it('takes the coder ALIAS when no row carries is_default — never the first row', () => {
    const { configDir, configPath } = writeConfig([makeConnection()])
    const flagless = LIVE_ROWS.map(row => ({ ...row, is_default: false }))

    const result = runRetiredDefaultRefresh(configDir, 'nessy-gateway', flagless)
    expect(result.exitCode, result.stderr.toString()).toBe(0)

    const saved = JSON.parse(readFileSync(configPath, 'utf-8'))
    // `models[0]` here is the FAST model. Landing on it would be the silent
    // downgrade this tier exists to prevent, and it is what HEAD did.
    expect(saved.llmConnections[0].defaultModel).not.toBe('tgpt/qwen36-35b-a3b-fp8')
    expect(saved.llmConnections[0].defaultModel).toBe('tgpt/deepseek-v4-flash-0731')
    expect(readSubstitution(result.stdout.toString())).toMatchObject({ via: 'coder-alias' })
  }, SUBPROCESS_TEST_TIMEOUT_MS)

  it('leaves a default the catalogue STILL SERVES untouched, and records nothing', () => {
    const { configDir, configPath } = writeConfig([
      makeConnection({ defaultModel: 'tgpt/qwen36-35b-a3b-fp8' }),
    ])

    const result = runRetiredDefaultRefresh(configDir, 'nessy-gateway', LIVE_ROWS)
    expect(result.exitCode, result.stderr.toString()).toBe(0)

    const saved = JSON.parse(readFileSync(configPath, 'utf-8'))
    // Even though the catalogue flags a DIFFERENT model as its default: a
    // default the endpoint serves is the user's, and `is_default` is a seed for
    // connections that have none, not a standing instruction.
    expect(saved.llmConnections[0].defaultModel).toBe('tgpt/qwen36-35b-a3b-fp8')
    expect(readSubstitution(result.stdout.toString())).toBeNull()
  }, SUBPROCESS_TEST_TIMEOUT_MS)
})

/**
 * D1.222 — the startup path against a FAILING catalogue.
 *
 * The rig drives the REAL `startAll` + `_doRefresh` in a subprocess, exactly as
 * every other case in this file does; only two things are stubbed, and both are
 * stated because a lever tested through a stub measures the lever's key and not
 * its posture (AGENTS.md §Traps):
 *
 *  - `fetch`, which COUNTS attempts — the whole reading is how many requests the
 *    service issues for one connection.
 *  - `setTimeout` for delays of a second or more, which RECORDS the delay and
 *    then fires immediately, so a 30-second retry is readable inside a test. A
 *    sub-second timer is passed through untouched. `accelerate: false` keeps the
 *    real delay, which is what lets the cancellation arm prove a cancel rather
 *    than a race.
 */
function runFailingGatewayStart(
  configDir: string,
  { failure, accelerate = true, stopEarly = false }:
    { failure: string; accelerate?: boolean; stopEarly?: boolean },
) {
  const result = Bun.spawnSync([
    process.execPath,
    '--eval',
    `
      let attempts = 0;
      globalThis.fetch = async () => { attempts += 1; ${failure} };
      const delays = [];
      const realSetTimeout = globalThis.setTimeout;
      globalThis.setTimeout = (cb, ms, ...rest) => {
        if (typeof ms === 'number' && ms >= 1000) {
          delays.push(ms);
          return realSetTimeout(cb, ${accelerate ? '0' : 'ms'}, ...rest);
        }
        return realSetTimeout(cb, ms, ...rest);
      };
      const mod = await import(${JSON.stringify(SERVICE_MODULE_URL)});
      const service = mod.initModelRefreshService(async () => ({ apiKey: 'stored-snapshot-key' }));
      service.startAll();
      await service.refreshConnection('nessy-gateway');
      ${stopEarly ? 'service.stopAll();' : ''}
      await new Promise(r => realSetTimeout(r, 150));
      ${stopEarly ? '' : 'service.stopAll();'}
      console.log('__RETRY__' + JSON.stringify({ attempts, delays }));
    `,
  ], {
    env: childEnv(configDir, makeDpHome()),
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const stdout = result.stdout.toString()
  const marker = stdout.lastIndexOf('__RETRY__')
  const probe = marker >= 0
    ? JSON.parse(stdout.slice(marker + '__RETRY__'.length).split('\n')[0]!) as { attempts: number; delays: number[] }
    : { attempts: -1, delays: [] }
  return { result, probe }
}

/**
 * These four cases spawn the same subprocess every case in this file spawns, and
 * they are given a LARGER budget than the file's 120 s because the file's number
 * is a reading from a quieter day.
 *
 * Measured 2026-09-17 at load 15.25 with five sibling lanes running: the four
 * cases took `real 555.49 / user 6.27 / sys 2.55` — **1.6 % cpu**, so the cost is
 * the module graph's page-cache I/O and not the test (AGENTS.md §Traps). Two of
 * the four spawns exceeded 120 000 ms and were killed mid-import, reporting
 * `exitCode: null`; the two that finished asserted normally. The budget is set
 * against that measured floor rather than against zero.
 */
const RETRY_CASE_TIMEOUT_MS = 300_000

describe('ModelRefreshService — one bounded retry after a transient catalogue failure (D1.222)', () => {
  it('retries ONCE after a transport failure — the offline start, which carries no status at all', () => {
    const { configDir } = writeConfig([makeConnection()])

    const { result, probe } = runFailingGatewayStart(configDir, {
      failure: `throw new TypeError('fetch failed');`,
    })
    expect(result.exitCode, result.stderr.toString()).toBe(0)
    // TWO attempts and never a third, although the second failed the same way:
    // the boundedness is the design, and this arm is its control — the stub
    // fails every time, so a ladder would show up here as 3, 4, …
    expect(probe.attempts).toBe(2)
    expect(probe.delays).toContain(30_000)
  }, RETRY_CASE_TIMEOUT_MS)

  it('retries ONCE after a 429 — a status the gateway classifier calls transient', () => {
    const { configDir } = writeConfig([makeConnection()])

    const { result, probe } = runFailingGatewayStart(configDir, {
      failure: `return new Response('slow down', { status: 429 });`,
    })
    expect(result.exitCode, result.stderr.toString()).toBe(0)
    expect(probe.attempts).toBe(2)
    expect(probe.delays).toContain(30_000)
  }, RETRY_CASE_TIMEOUT_MS)

  it('schedules NOTHING after a 5xx — that verdict is a credential diagnosis, and a ladder on it spins', () => {
    const { configDir } = writeConfig([makeConnection()])

    const { result, probe } = runFailingGatewayStart(configDir, {
      failure: `return new Response('boom', { status: 500 });`,
    })
    expect(result.exitCode, result.stderr.toString()).toBe(0)
    expect(probe.attempts).toBe(1)
    expect(probe.delays).not.toContain(30_000)
  }, RETRY_CASE_TIMEOUT_MS)

  it('stopAll CANCELS the pending retry — the timer is real here, so this is a cancel and not a race', () => {
    const { configDir } = writeConfig([makeConnection()])

    const { result, probe } = runFailingGatewayStart(configDir, {
      failure: `throw new TypeError('fetch failed');`,
      accelerate: false,
      stopEarly: true,
    })
    expect(result.exitCode, result.stderr.toString()).toBe(0)
    // The retry WAS scheduled — the 30 s delay is recorded — and then cancelled,
    // so the attempt count stays at the one the startup fetch made.
    expect(probe.delays).toContain(30_000)
    expect(probe.attempts).toBe(1)
  }, RETRY_CASE_TIMEOUT_MS)
})
