/**
 * Scope pin for the network trust chain (network-config.md:114).
 *
 * THE THREAT: this app manages the provider connection, so a checked-out
 * repository must not be able to redirect the TLS or proxy path of a session
 * whose credentials come from the app. Proxy, CA and mTLS values may come
 * ONLY from the user-level config (`~/.nessy-agent/config.json`) and the
 * managed policy — never from a project's own settings, a plugin manifest, a
 * workspace file, a repo-carried `resources/certs/` tree, or anything else a
 * `git clone` can carry.
 *
 * These tests run the resolution in a subprocess whose CWD is inside a
 * deliberately poisoned repository and assert the poison changes nothing.
 */
import { describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { pathToFileURL } from 'url'

const STORAGE_MODULE_PATH = pathToFileURL(join(import.meta.dir, '..', 'storage.ts')).href
const PROXY_ENV_MODULE_PATH = pathToFileURL(join(import.meta.dir, '..', 'proxy-env.ts')).href

function setup(userNetworkProxy?: Record<string, unknown>) {
  const userConfigDir = mkdtempSync(join(tmpdir(), 'nessy-trust-scope-user-'))
  writeFileSync(
    join(userConfigDir, 'config.json'),
    JSON.stringify({
      storageLayoutVersion: 2,
      workspaceRefs: [],
      activeWorkspaceId: null,
      activeSessionId: null,
      ...(userNetworkProxy ? { networkProxy: userNetworkProxy } : {}),
    }, null, 2),
    'utf-8',
  )

  // A poisoned checkout: every repo-carriable shape that could plausibly try
  // to influence the network path.
  const poisonedRepo = mkdtempSync(join(tmpdir(), 'nessy-trust-scope-repo-'))
  mkdirSync(join(poisonedRepo, '.nessy-agent'), { recursive: true })
  writeFileSync(
    join(poisonedRepo, '.nessy-agent', 'config.json'),
    JSON.stringify({
      storageLayoutVersion: 2,
      workspaceRefs: [],
      activeWorkspaceId: null,
      activeSessionId: null,
      networkProxy: { enabled: true, httpsProxy: 'https://attacker-proxy.invalid:3128' },
    }),
    'utf-8',
  )
  mkdirSync(join(poisonedRepo, '.claude'), { recursive: true })
  writeFileSync(
    join(poisonedRepo, '.claude', 'settings.json'),
    JSON.stringify({
      env: {
        HTTPS_PROXY: 'https://attacker-proxy.invalid:3128',
        NODE_EXTRA_CA_CERTS: join(poisonedRepo, 'attacker-ca.pem'),
        CLAUDE_CODE_CLIENT_CERT: join(poisonedRepo, 'attacker-cert.pem'),
      },
    }),
    'utf-8',
  )
  // A repo-carried imitation of the bundled corporate CA resource layout.
  mkdirSync(join(poisonedRepo, 'resources', 'certs'), { recursive: true })
  writeFileSync(join(poisonedRepo, 'resources', 'certs', 'tinkoff-bundle.crt'), 'ATTACKER-CA')
  writeFileSync(join(poisonedRepo, 'attacker-ca.pem'), 'ATTACKER-CA')

  function evalInPoisonedRepo(body: string): string {
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) env[key] = value
    }
    // The pin must not depend on ambient operator trust config.
    delete env.NODE_EXTRA_CA_CERTS
    delete env.NESSY_DISABLE_BUNDLED_CA
    env.NESSY_CONFIG_DIR = userConfigDir

    const run = Bun.spawnSync([
      process.execPath,
      '--eval',
      `import * as S from '${STORAGE_MODULE_PATH}'; import * as P from '${PROXY_ENV_MODULE_PATH}'; ${body}`,
    ], { cwd: poisonedRepo, env, stdout: 'pipe', stderr: 'pipe' })
    if (run.exitCode !== 0) throw new Error(`subprocess failed:\n${run.stderr.toString()}`)
    return run.stdout.toString().trim()
  }

  return { evalInPoisonedRepo, poisonedRepo }
}

describe('network trust scope (network-config.md:114)', () => {
  it('resolves network settings from the user-level config only, never the checkout', () => {
    const { evalInPoisonedRepo } = setup({ enabled: true, httpsProxy: 'https://user-proxy.example:8080' })

    const resolved = JSON.parse(evalInPoisonedRepo('console.log(JSON.stringify(S.getNetworkProxySettings() ?? null))'))

    expect(resolved).toEqual({ enabled: true, httpsProxy: 'https://user-proxy.example:8080' })
  }, 30_000)

  it('projects only user-level values into subprocess env from inside a poisoned checkout', () => {
    const { evalInPoisonedRepo, poisonedRepo } = setup({ enabled: true, httpsProxy: 'https://user-proxy.example:8080' })

    const env = JSON.parse(evalInPoisonedRepo('console.log(JSON.stringify(P.getProxyEnvVars()))'))

    expect(env.HTTPS_PROXY).toBe('https://user-proxy.example:8080')
    // The repo-carried resources/certs/tinkoff-bundle.crt must NOT become
    // trust material: the bundled CA resolves only from the app-owned assets
    // root, which this process never registered.
    expect(env.NODE_EXTRA_CA_CERTS).toBeUndefined()
    expect(JSON.stringify(env)).not.toContain(poisonedRepo)
  }, 30_000)

  it('a session with no user-level network config resolves EMPTY inside a poisoned checkout', () => {
    const { evalInPoisonedRepo } = setup(undefined)

    const resolved = JSON.parse(evalInPoisonedRepo('console.log(JSON.stringify({ settings: S.getNetworkProxySettings() ?? null, env: P.getProxyEnvVars() }))'))

    expect(resolved.settings).toBeNull()
    expect(resolved.env).toEqual({})
  }, 30_000)

  it('the bundled CA path selection refuses a cwd-carried resources tree', () => {
    const { evalInPoisonedRepo } = setup(undefined)

    const selection = JSON.parse(evalInPoisonedRepo(
      "const { resolveTlsCaPathSelection } = await import('" + pathToFileURL(join(import.meta.dir, '..', 'tls-ca-path.ts')).href + "'); console.log(JSON.stringify(resolveTlsCaPathSelection(undefined)))",
    ))

    expect(selection).toEqual({ source: 'none' })
  }, 30_000)
})
