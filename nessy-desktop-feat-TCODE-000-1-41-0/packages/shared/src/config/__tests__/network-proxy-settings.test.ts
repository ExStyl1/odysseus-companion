import { describe, expect, it, setDefaultTimeout } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import { pathToFileURL } from 'url'

const STORAGE_MODULE_PATH = pathToFileURL(join(import.meta.dir, '..', 'storage.ts')).href

/**
 * The budget belongs to the FILE, not to a case — and the five per-case
 * thirty-second budgets this file used to carry were BOTH too small and in the
 * wrong place. Each `evalInModule` spawns one bun process importing `storage.ts`'s
 * whole module graph, a cost that is a PAGE-CACHE LOTTERY rather than work:
 * measured 2026-09-11 on the same child, `real 48.74` at load 8.26, `real 38.28`
 * at load 8.49, then **0.29 / 0.34 / 0.35** at load 7.62 once the graph was warm,
 * CPU flat at ~0.5 s user + 0.2 s sys throughout — 1.7 % of the slow wall, a 140x
 * spread. One slow child already exceeds thirty seconds and the widest case here
 * spends THREE of them, so all five cases timed out with zero assertion failures
 * and surfaced as `subprocess failed:` with an EMPTY stderr — the child killed by
 * the case's own timer, which reads like a broken setter and is not one. 300 s is
 * ~2x the widest case's slow-path floor; on the warm path it costs nothing.
 */
setDefaultTimeout(300_000)

function setup(extraConfig: Record<string, unknown> = {}) {
  const configDir = mkdtempSync(join(tmpdir(), 'nessy-network-proxy-config-'))
  const configPath = join(configDir, 'config.json')
  writeFileSync(
    configPath,
    JSON.stringify({
      storageLayoutVersion: 2,
      workspaceRefs: [],
      activeWorkspaceId: null,
      activeSessionId: null,
      ...extraConfig,
    }, null, 2),
    'utf-8',
  )

  function evalInModule(body: string): string {
    const run = Bun.spawnSync([
      process.execPath,
      '--eval',
      `import * as S from '${STORAGE_MODULE_PATH}'; ${body}`,
    ], { env: { ...process.env, NESSY_CONFIG_DIR: configDir }, stdout: 'pipe', stderr: 'pipe' })
    if (run.exitCode !== 0) throw new Error(`subprocess failed:\n${run.stderr.toString()}`)
    return run.stdout.toString().trim()
  }

  const readConfig = () => JSON.parse(readFileSync(configPath, 'utf-8'))
  return { readConfig, evalInModule }
}

describe('network proxy settings storage', () => {
  it('persists custom CA path and bundled CA opt-out while proxy is disabled', () => {
    const { evalInModule, readConfig } = setup()

    evalInModule("S.setNetworkProxySettings({ enabled: false, tlsCaPath: '~/corp.pem', useBundledCa: false })")

    expect(readConfig().networkProxy).toEqual({
      enabled: false,
      tlsCaPath: join(homedir(), 'corp.pem'),
      useBundledCa: false,
    })
  })

  it('deletes network proxy settings when only default CA behavior remains', () => {
    const { evalInModule, readConfig } = setup()

    evalInModule("S.setNetworkProxySettings({ enabled: false, tlsCaPath: '~/corp.pem', useBundledCa: false })")
    // The clears are explicit: '' for the path, `true` for the CA default.
    // An uncarried field would be merge-preserved, not deleted.
    evalInModule("S.setNetworkProxySettings({ enabled: false, tlsCaPath: '', useBundledCa: true })")

    expect(readConfig().networkProxy).toBeUndefined()
  })

  it('persists the cert-store list and mTLS client identity paths while proxy is disabled', () => {
    const { evalInModule, readConfig } = setup()

    // Fixture-only placeholder passphrase — never real key material.
    evalInModule("S.setNetworkProxySettings({ enabled: false, certStore: 'bundled', clientCertPath: '~/client.pem', clientKeyPath: '~/client-key.pem', clientKeyPassphrase: 'fixture-passphrase-not-real' })")

    expect(readConfig().networkProxy).toEqual({
      enabled: false,
      certStore: 'bundled',
      clientCertPath: join(homedir(), 'client.pem'),
      clientKeyPath: join(homedir(), 'client-key.pem'),
      clientKeyPassphrase: 'fixture-passphrase-not-real',
    })

    // A save that does not carry the TLS-identity fields preserves them: the
    // delete branch must not fire off fields the caller never touched.
    evalInModule('S.setNetworkProxySettings({ enabled: false })')
    expect(readConfig().networkProxy).toEqual({
      enabled: false,
      certStore: 'bundled',
      clientCertPath: join(homedir(), 'client.pem'),
      clientKeyPath: join(homedir(), 'client-key.pem'),
      clientKeyPassphrase: 'fixture-passphrase-not-real',
    })

    // Clearing every field back to defaults — explicitly — removes the key
    // entirely: the delete branch fires only when every field including the
    // four TLS-identity ones is blank after the merge.
    evalInModule("S.setNetworkProxySettings({ enabled: false, certStore: '', clientCertPath: '', clientKeyPath: '', clientKeyPassphrase: '' })")
    expect(readConfig().networkProxy).toBeUndefined()
  })

  it('preserves the TLS client identity a proxy save does not carry, byte-for-byte (R26)', () => {
    // Administrator-configured out-of-band, straight into config.json. The
    // unexpanded `~/` paths are deliberate: a preserved field must keep its
    // stored bytes exactly, so a re-normalization on save would fail this.
    // Fixture-only placeholder passphrase — never real key material.
    const { evalInModule, readConfig } = setup({
      networkProxy: {
        enabled: false,
        certStore: 'system',
        clientCertPath: '~/corp/client.pem',
        clientKeyPath: '~/corp/client-key.pem',
        clientKeyPassphrase: 'fixture-passphrase-not-real',
      },
    })

    // The exact six-field save the settings form sends: its own blank fields as
    // explicit empty strings, the four TLS-identity fields not carried at all.
    evalInModule("S.setNetworkProxySettings({ enabled: true, httpProxy: '', httpsProxy: 'http://proxy.corp.example:3128', noProxy: '', tlsCaPath: '', useBundledCa: true })")

    expect(readConfig().networkProxy).toEqual({
      enabled: true,
      httpsProxy: 'http://proxy.corp.example:3128',
      certStore: 'system',
      clientCertPath: '~/corp/client.pem',
      clientKeyPath: '~/corp/client-key.pem',
      clientKeyPassphrase: 'fixture-passphrase-not-real',
    })
  })

  it('refuses to persist a SOCKS proxy URL with a clear message', () => {
    const { evalInModule, readConfig } = setup()

    const output = evalInModule(
      "try { S.setNetworkProxySettings({ enabled: true, httpsProxy: 'socks5://proxy.example:1080' }); console.log('PERSISTED'); } catch (e) { console.log('REFUSED: ' + e.message); }",
    )

    expect(output).toContain('REFUSED:')
    expect(output).toContain('SOCKS proxies are not supported')
    expect(readConfig().networkProxy).toBeUndefined()
  })
})
