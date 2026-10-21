/**
 * UA12.185 — the MCP OAuth pinned request (`fetchOAuthUrlPinned`, `node:https` to an already-validated address)
 * verifies the server against the SAME composed CA trust set this process's own `fetch` uses, so the Custom CA
 * setting (`tlsCaPath`) and the bundled corporate CA reach MCP sign-in behind a TLS-inspecting proxy.
 *
 * Before the row, the request used Node's default trust alone; its only corporate-CA path was a startup
 * `NODE_EXTRA_CA_CERTS`, which the desktop binary's `nodeOptions` fuse stops since UA12.22. This file is the
 * HEADLESS half: the trust chain is the server's (`applyProcessNetworkTrustChain`, `config/network-runtime.ts`),
 * the process is Bun. The desktop half (the Electron main's undici dispatcher, a Node child) is
 * `apps/electron/src/main/__tests__/network-proxy-oauth-pinned-ca.test.ts`.
 *
 * The rig: a local HTTPS server presenting a throwaway self-signed certificate (`openssl`, CA:TRUE) for a
 * `.invalid` host name; the pinned request connects to 127.0.0.1 and sends that name as SNI and Host — what the
 * product does after its SSRF checks resolved the name. Never a real host.
 *
 * Positive: with the throwaway certificate as the Custom CA setting, the request completes (200).
 * Negative (control): with no Custom CA (and the bundled CA opted out), the same request is refused by TLS
 * verification — so the setting, not a lax TLS stack, is what completes the positive arm.
 * Failing arm, taken over `a3323779a`'s request code with only the function exported: the positive arm was refused
 * (a self-signed certificate error); the control passed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import https from 'node:https'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fetchOAuthUrlPinned } from '../oauth.ts'
import {
  __resetProcessNetworkTrustChainForTest,
  applyProcessNetworkTrustChain,
} from '../../config/network-runtime.ts'
import { setProcessCaTrustProvider } from '../../config/network-tls-ca.ts'
import type { NetworkProxySettings } from '../../config/types.ts'
import { MODULE_GRAPH_HOOK_BUDGET_MS } from '../../testing/module-graph-budgets.ts'

const HOST = 'ua12185-oauth.invalid'

/** `openssl` makes the throwaway certificate; without it no arm can run. */
const OPENSSL = (() => {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore', timeout: 10_000 })
    return true
  } catch {
    return false
  }
})()
if (!OPENSSL) console.warn('[UA12.185] SKIPPED: needs openssl for the throwaway certificate')

const silent = { info: () => {}, warn: () => {}, error: () => {} }

let root = ''
let certPath = ''
let server: https.Server | undefined
let port = 0
let originalFetch: typeof fetch

beforeAll(async () => {
  originalFetch = globalThis.fetch
  if (!OPENSSL) return
  root = mkdtempSync(join(tmpdir(), 'nessy-ua12185-'))
  certPath = join(root, 'server-cert.pem')
  const keyPath = join(root, 'server-key.pem')
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
    '-keyout', keyPath, '-out', certPath, '-subj', `/CN=${HOST}`,
    '-addext', `subjectAltName=DNS:${HOST}`,
    '-addext', 'basicConstraints=critical,CA:TRUE',
  ], { stdio: 'ignore', timeout: 30_000 })
  server = https.createServer({ key: readFileSync(keyPath), cert: readFileSync(certPath) }, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ path: req.url, host: req.headers.host }))
  })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', () => resolve()))
  port = (server.address() as AddressInfo).port
}, 60_000)

afterAll(() => {
  server?.close()
  __resetProcessNetworkTrustChainForTest()
  setProcessCaTrustProvider(undefined)
  // The wrapper `applyProcessNetworkTrustChain` installed must not outlive this file.
  globalThis.fetch = originalFetch
  if (root) rmSync(root, { recursive: true, force: true })
})

function applySettings(settings: NetworkProxySettings): void {
  __resetProcessNetworkTrustChainForTest()
  applyProcessNetworkTrustChain({ settings, log: silent })
}

async function pinnedMetadataRequest(): Promise<{ status: number; body: unknown } | { error: string }> {
  try {
    const response = await fetchOAuthUrlPinned(
      `https://${HOST}:${port}/.well-known/oauth-authorization-server`,
      { method: 'GET' },
      [{ address: '127.0.0.1', family: 4 }],
    )
    return { status: response.status, body: await response.json() }
  } catch (error) {
    const code = (error as { code?: string }).code
    return { error: String(code ?? (error as Error).message) }
  }
}

describe.if(OPENSSL)('UA12.185 · the MCP OAuth pinned request uses the composed CA trust (headless host)', () => {
  it('positive: with the Custom CA setting naming the server\'s CA, the pinned request completes', async () => {
    applySettings({ tlsCaPath: certPath, useBundledCa: false } as NetworkProxySettings)
    expect(await pinnedMetadataRequest()).toEqual({
      status: 200,
      body: { path: '/.well-known/oauth-authorization-server', host: `${HOST}:${port}` },
    })
  }, 30_000)

  it('CONTROL: with no Custom CA (bundled CA opted out), the same request is refused by TLS verification', async () => {
    applySettings({ useBundledCa: false } as NetworkProxySettings)
    const outcome = await pinnedMetadataRequest()
    expect('error' in outcome).toBe(true)
    expect((outcome as { error: string }).error).toMatch(/SELF_SIGNED|UNABLE_TO_VERIFY|CERT|certificate/i)
  }, 30_000)
})

/**
 * UA12.200 — the same pinned request presents the process's composed mTLS client identity (the Settings
 * `clientCertPath` / `clientKeyPath`, or a managed `CLAUDE_CODE_CLIENT_CERT` / `_KEY`), the one the headless fetch
 * wrapper hands every `https:` request (`currentTrust.tls`). Before the row it carried the CA alone, so an
 * authorization server (or a TLS-inspecting proxy) that requires a client certificate refused MCP sign-in while
 * every other request of the process authenticated.
 *
 * The rig: a second local HTTPS server that REQUIRES a client certificate signed by a throwaway client CA
 * (`requestCert` + `rejectUnauthorized`); its own certificate is trusted through the Custom CA setting in every arm,
 * so only the identity differs between them.
 *
 * Positive: with the Settings identity, the request completes (200) — the server refuses any unauthorized peer.
 * Negative (control): the same settings without the identity — the server refuses the handshake.
 * Failing arm, taken over `22733fe5d` (UA12.185: `ca` only): the positive arm was refused like the control.
 */
describe.if(OPENSSL)('UA12.200 · the MCP OAuth pinned request presents the composed mTLS client identity (headless host)', () => {
  const MTLS_HOST = 'ua12200-oauth.invalid'
  let mtlsRoot = ''
  let mtlsServerCert = ''
  let clientCert = ''
  let clientKey = ''
  let mtlsServer: https.Server | undefined
  let mtlsPort = 0

  beforeAll(async () => {
    mtlsRoot = mkdtempSync(join(tmpdir(), 'nessy-ua12200-'))
    mtlsServerCert = join(mtlsRoot, 'server-cert.pem')
    const serverKey = join(mtlsRoot, 'server-key.pem')
    clientCert = join(mtlsRoot, 'client-cert.pem')
    clientKey = join(mtlsRoot, 'client-key.pem')
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
      '-keyout', serverKey, '-out', mtlsServerCert, '-subj', `/CN=${MTLS_HOST}`,
      '-addext', `subjectAltName=DNS:${MTLS_HOST}`,
      '-addext', 'basicConstraints=critical,CA:TRUE',
    ], { stdio: 'ignore', timeout: 30_000 })
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
      '-keyout', clientKey, '-out', clientCert, '-subj', '/CN=ua12200-client',
    ], { stdio: 'ignore', timeout: 30_000 })
    mtlsServer = https.createServer({
      key: readFileSync(serverKey),
      cert: readFileSync(mtlsServerCert),
      ca: readFileSync(clientCert),
      requestCert: true,
      rejectUnauthorized: true,
    }, (_req, res) => {
      // `rejectUnauthorized` refuses an unauthenticated peer before any request is read, so a 200 IS the proof (Bun's
      // server socket does not expose `authorized`).
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    })
    await new Promise<void>(resolve => mtlsServer!.listen(0, '127.0.0.1', () => resolve()))
    mtlsPort = (mtlsServer.address() as AddressInfo).port
  }, 60_000)

  afterAll(() => {
    mtlsServer?.close()
    if (mtlsRoot) rmSync(mtlsRoot, { recursive: true, force: true })
  })

  async function pinnedMtlsRequest(): Promise<{ status: number; body: unknown } | { error: string }> {
    try {
      const response = await fetchOAuthUrlPinned(
        `https://${MTLS_HOST}:${mtlsPort}/.well-known/oauth-authorization-server`,
        { method: 'GET' },
        [{ address: '127.0.0.1', family: 4 }],
      )
      return { status: response.status, body: await response.json() }
    } catch (error) {
      const code = (error as { code?: string }).code
      return { error: String(code ?? (error as Error).message) }
    }
  }

  it('positive: with the Settings client identity, the pinned request completes', async () => {
    applySettings({
      tlsCaPath: mtlsServerCert,
      useBundledCa: false,
      clientCertPath: clientCert,
      clientKeyPath: clientKey,
    } as NetworkProxySettings)
    expect(await pinnedMtlsRequest()).toEqual({ status: 200, body: { ok: true } })
  }, 30_000)

  it('CONTROL: the same settings without the identity — the server refuses the handshake', async () => {
    applySettings({ tlsCaPath: mtlsServerCert, useBundledCa: false } as NetworkProxySettings)
    const outcome = await pinnedMtlsRequest()
    expect('error' in outcome).toBe(true)
    expect((outcome as { error: string }).error).not.toMatch(/SELF_SIGNED|UNABLE_TO_VERIFY/i)
  }, 30_000)
})

/**
 * UA12.201 — the MCP OAuth request honours the proxy this process's own `fetch` uses (the headless wrapper's
 * `proxyForUrl`: a managed `env` block's proxy, then Settings, then the environment, minus `NO_PROXY`), as Claude
 * Code's own MCP OAuth does: it goes through the proxy by HOST NAME (CONNECT), and with no proxy for the URL the
 * pinned path is unchanged. Before the row it always connected to the validated address directly, so on a
 * proxy-only network MCP sign-in could not reach an external authorization server.
 *
 * The rig: a local CONNECT recorder standing in for the proxy — it records each CONNECT target and tunnels only
 * the UA12.185 server's name to 127.0.0.1 (a `.invalid` name no resolver answers, so only the proxy can reach it
 * by name). The UA12.185 server's certificate is trusted through the Custom CA setting in every arm.
 *
 * Positive: with a Settings proxy, the request completes (200) and the recorder saw `CONNECT <name>:<port>`.
 * Negative (control): no proxy — the request completes over the pinned path and the recorder saw nothing.
 * Boundary: the proxy set and the name in its `noProxy` — pinned, nothing recorded.
 * Failing arm, taken over the UA12.200 request code: the positive arm completed directly, the recorder empty.
 */
describe.if(OPENSSL)('UA12.201 · the MCP OAuth request goes through the configured proxy (headless host)', () => {
  const PROXY_NAMES = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy'] as const
  const savedEnv = new Map<string, string | undefined>()
  const connects: string[] = []
  let recorder: import('node:http').Server | undefined
  let proxyUrl = ''

  beforeAll(async () => {
    // The ambient tier must not decide the CONTROL arm: no proxy name from the runner's environment.
    for (const name of PROXY_NAMES) {
      savedEnv.set(name, process.env[name])
      delete process.env[name]
    }
    const { createServer } = await import('node:http')
    const { connect } = await import('node:net')
    recorder = createServer((_req, res) => { res.writeHead(405); res.end() })
    recorder.on('connect', (req, clientSocket: import('node:net').Socket, head: Buffer) => {
      const target = String(req.url)
      connects.push(target)
      if (target !== `${HOST}:${port}`) {
        clientSocket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
        return
      }
      const upstream = connect(port, '127.0.0.1', () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head.length) upstream.write(head)
        upstream.pipe(clientSocket)
        clientSocket.pipe(upstream)
      })
      upstream.on('error', () => clientSocket.destroy())
      clientSocket.on('error', () => upstream.destroy())
    })
    await new Promise<void>(resolve => recorder!.listen(0, '127.0.0.1', () => resolve()))
    proxyUrl = `http://127.0.0.1:${(recorder.address() as AddressInfo).port}`
  }, MODULE_GRAPH_HOOK_BUDGET_MS)

  afterAll(() => {
    recorder?.close()
    for (const [name, value] of savedEnv) {
      delete process.env[name]
      if (value !== undefined) process.env[name] = value
    }
  })

  it('positive: with a Settings proxy, the request goes through it by host name and completes', async () => {
    connects.length = 0
    applySettings({
      enabled: true, httpsProxy: proxyUrl, tlsCaPath: certPath, useBundledCa: false,
    } as NetworkProxySettings)
    const outcome = await pinnedMetadataRequest()
    expect({ outcome, connects: [...connects] }).toEqual({
      outcome: { status: 200, body: { path: '/.well-known/oauth-authorization-server', host: `${HOST}:${port}` } },
      connects: [`${HOST}:${port}`],
    })
  }, 30_000)

  it('CONTROL: with no proxy, the pinned path is unchanged and nothing reaches the recorder', async () => {
    connects.length = 0
    applySettings({ tlsCaPath: certPath, useBundledCa: false } as NetworkProxySettings)
    const outcome = await pinnedMetadataRequest()
    expect({ status: (outcome as { status?: number }).status, connects: [...connects] }).toEqual({ status: 200, connects: [] })
  }, 30_000)

  it('boundary: the host in the proxy\'s noProxy goes over the pinned path', async () => {
    connects.length = 0
    applySettings({
      enabled: true, httpsProxy: proxyUrl, noProxy: HOST, tlsCaPath: certPath, useBundledCa: false,
    } as NetworkProxySettings)
    const outcome = await pinnedMetadataRequest()
    expect({ status: (outcome as { status?: number }).status, connects: [...connects] }).toEqual({ status: 200, connects: [] })
  }, 30_000)
})
