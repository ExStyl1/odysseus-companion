/**
 * UA12.185 — the desktop half: the MCP OAuth pinned request (`fetchOAuthUrlPinned`, `node:https` to an
 * already-validated address) verifies the server against the CA set the Electron main's global undici dispatcher
 * was composed with (`configureNodeProxy`): the Custom CA setting (`tlsCaPath`), the bundled corporate CA, a
 * managed `NODE_EXTRA_CA_CERTS`, beside the bundled Mozilla set and the OS store.
 *
 * Why it regressed: the pinned request never went through the dispatcher, so its only corporate-CA path was a
 * startup `NODE_EXTRA_CA_CERTS` — and UA12.22 turned the packaged binary's `nodeOptions` fuse OFF, which stops
 * that variable at the binary's own start (Electron v39.2.7 `fuses.md`). Behind a TLS-inspecting proxy, MCP
 * sign-in then failed its handshake whatever the Settings said. The headless half (Bun, the server's fetch
 * wrapper) is `packages/shared/src/auth/__tests__/oauth-pinned-ca.test.ts`.
 *
 * The rig is F1.498's (`network-proxy-host-hop.test.ts`): the product's own `applyConfiguredProxySettings` and
 * `fetchOAuthUrlPinned`, bundled with the main build's esbuild flags (`fixtures/network-proxy-oauth-pinned-child.ts`)
 * and run in a NODE child — the runtime the main process is — from a CLEAN launch environment (no
 * `NODE_EXTRA_CA_CERTS`, as under the fuse). A local HTTPS server presents a throwaway self-signed certificate
 * (`openssl`, CA:TRUE) for a `.invalid` name; the child connects to 127.0.0.1 with that name as SNI. Never a real host.
 *
 * Positive: the Custom CA setting naming the certificate → 200; a managed `env` block's `NODE_EXTRA_CA_CERTS`
 * written AFTER the apply → 200 (the provider re-composes through `configureNodeProxy`, as a dispatch does).
 * Negative (control): neither → the handshake is refused, so the CA, not a lax TLS stack, completes the others.
 * Failing arm, taken over `a3323779a`'s request code with only the function exported: both positive arms were refused with a
 * self-signed certificate error; the control passed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import https from 'node:https'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { build } from 'esbuild'
import { STORAGE_LAYOUT_VERSION } from '@nessy-agent/shared/config/paths'
import { MODULE_GRAPH_HOOK_BUDGET_MS } from '@nessy-agent/shared/testing/module-graph-budgets'

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..', '..')
const FIXTURES = join(import.meta.dir, 'fixtures')
const HOST = 'ua12185-oauth.invalid'

/** The Node the desktop main process is — the same resolution F1.498's rig uses. */
function resolveNodeRuntime(): { command: string; env: Record<string, string> } | null {
  try {
    const electronDir = dirname(require.resolve('electron/package.json', { paths: [REPO_ROOT] }))
    const relative = readFileSync(join(electronDir, 'path.txt'), 'utf8').trim()
    const binary = join(electronDir, 'dist', relative)
    if (existsSync(binary)) return { command: binary, env: { ELECTRON_RUN_AS_NODE: '1' } }
  } catch {
    // No electron package or binary on this runner — fall through to `node`.
  }
  try {
    const version = execFileSync('node', ['-p', 'process.versions.node'], { encoding: 'utf8', timeout: 10_000 }).trim()
    const [major = 0] = version.split('.').map(Number)
    if (major >= 22) return { command: 'node', env: {} }
  } catch {
    // No node either.
  }
  return null
}

/** `openssl` makes the throwaway certificate. */
const OPENSSL = (() => {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore', timeout: 10_000 })
    return true
  } catch {
    return false
  }
})()

const runtime = resolveNodeRuntime()
const RUNNABLE = runtime !== null && OPENSSL
if (!RUNNABLE) {
  console.warn('[UA12.185] SKIPPED: needs a Node >= 22 (or the Electron binary) and openssl to host the child')
}

let root = ''
let bundle = ''
let certPath = ''
let server: https.Server | undefined
let target = ''

beforeAll(async () => {
  if (!RUNNABLE) return
  root = mkdtempSync(join(tmpdir(), 'nessy-ua12185-desktop-'))
  bundle = join(root, 'child.cjs')
  const stubs = join(FIXTURES, 'network-proxy-host-hop-stubs.cjs')
  // The Electron main's own flags (`apps/electron/package.json` build:main).
  await build({
    entryPoints: [join(FIXTURES, 'network-proxy-oauth-pinned-child.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundle,
    external: ['@anthropic-ai/claude-agent-sdk'],
    alias: {
      electron: stubs,
      'electron-log/main': stubs,
      'electron-updater/out/electronHttpExecutor': stubs,
    },
    logLevel: 'silent',
  })

  certPath = join(root, 'server-cert.pem')
  const keyPath = join(root, 'server-key.pem')
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
    '-keyout', keyPath, '-out', certPath, '-subj', `/CN=${HOST}`,
    '-addext', `subjectAltName=DNS:${HOST}`,
    '-addext', 'basicConstraints=critical,CA:TRUE',
  ], { stdio: 'ignore', timeout: 30_000 })
  server = https.createServer({ key: readFileSync(keyPath), cert: readFileSync(certPath) }, (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{}')
  })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', () => resolve()))
  target = `https://${HOST}:${(server.address() as AddressInfo).port}/.well-known/oauth-authorization-server`
}, 240_000)

afterAll(() => {
  server?.close()
  if (root) rmSync(root, { recursive: true, force: true })
})

function configDir(name: string, networkProxy: Record<string, unknown>): string {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'config.json'), JSON.stringify({
    storageLayoutVersion: STORAGE_LAYOUT_VERSION,
    workspaceRefs: [],
    activeWorkspaceId: null,
    networkProxy,
  }))
  return dir
}

/** Async spawn: a synchronous one would deadlock against the in-process server. */
function runChild(env: Record<string, string>): Promise<{ code: number | null; outcome: Record<string, unknown> | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(runtime!.command, [bundle], {
      // A CLEAN launch environment: no NODE_EXTRA_CA_CERTS, as under the nodeOptions fuse.
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: root,
        NODE_PATH: join(REPO_ROOT, 'node_modules'),
        ...runtime!.env,
        UA12185_TARGET: target,
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    const timer = setTimeout(() => child.kill('SIGKILL'), 150_000)
    child.on('error', reject)
    child.on('close', (code) => {
      clearTimeout(timer)
      let outcome: Record<string, unknown> | null = null
      try { outcome = JSON.parse(stdout.trim().split('\n').at(-1) ?? '') as Record<string, unknown> } catch { /* reported below */ }
      resolve({ code, outcome, stderr: stderr.slice(-2000) })
    })
  })
}

describe.if(RUNNABLE)('UA12.185 · the desktop MCP OAuth pinned request uses the dispatcher\'s composed CA trust', () => {
  it('positive: the Custom CA setting naming the server\'s CA completes the pinned request', async () => {
    const run = await runChild({ NESSY_CONFIG_DIR: configDir('custom-ca', { tlsCaPath: certPath, useBundledCa: false }) })
    expect({ code: run.code, outcome: run.outcome, stderr: run.code === 0 ? '' : run.stderr })
      .toEqual({ code: 0, outcome: { status: 200 }, stderr: '' })
  }, 180_000)

  it('positive: a managed NODE_EXTRA_CA_CERTS written after the apply reaches the pinned request', async () => {
    const run = await runChild({
      NESSY_CONFIG_DIR: configDir('managed-ca', { useBundledCa: false }),
      UA12185_MANAGED_ENV: JSON.stringify({ NODE_EXTRA_CA_CERTS: certPath }),
    })
    expect({ code: run.code, outcome: run.outcome, stderr: run.code === 0 ? '' : run.stderr })
      .toEqual({ code: 0, outcome: { status: 200 }, stderr: '' })
  }, 180_000)

  it('CONTROL: no Custom CA and no managed CA — the handshake is refused', async () => {
    const run = await runChild({ NESSY_CONFIG_DIR: configDir('no-ca', { useBundledCa: false }) })
    expect(run.code).toBe(0)
    expect(Object.keys(run.outcome ?? {})).toEqual(['error'])
    expect(String(run.outcome?.error)).toMatch(/SELF_SIGNED|UNABLE_TO_VERIFY|CERT/i)
  }, 180_000)
})

/**
 * UA12.200 — the desktop pinned request presents the client identity the dispatcher was composed with
 * (`configureNodeProxy` → `resolveHostClientIdentity`: a managed `CLAUDE_CODE_CLIENT_CERT` / `_KEY`, then the
 * Settings `clientCertPath` / `clientKeyPath`, then the environment's), as every dispatched request does. Before
 * the row it carried the CA alone, so an authorization server or proxy that requires a client certificate
 * refused MCP sign-in.
 *
 * The rig: a second local HTTPS server that REQUIRES a client certificate signed by a throwaway client CA; its own
 * certificate is trusted through the Custom CA setting in every arm, so only the identity differs.
 *
 * Positive: the Settings identity → 200; the environment's `CLAUDE_CODE_CLIENT_CERT` / `_KEY` → 200.
 * Negative (control): no identity → the server refuses the handshake.
 * Failing arm, taken over `22733fe5d` (UA12.185: `ca` only): both positive arms were refused like the control.
 */
describe.if(RUNNABLE)('UA12.200 · the desktop MCP OAuth pinned request presents the dispatcher\'s client identity', () => {
  const MTLS_HOST = 'ua12200-oauth.invalid'
  let mtlsServerCert = ''
  let clientCert = ''
  let clientKey = ''
  let mtlsServer: https.Server | undefined
  let mtlsTarget = ''

  beforeAll(async () => {
    mtlsServerCert = join(root, 'mtls-server-cert.pem')
    const serverKey = join(root, 'mtls-server-key.pem')
    clientCert = join(root, 'client-cert.pem')
    clientKey = join(root, 'client-key.pem')
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
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
    })
    await new Promise<void>(resolve => mtlsServer!.listen(0, '127.0.0.1', () => resolve()))
    mtlsTarget = `https://${MTLS_HOST}:${(mtlsServer.address() as AddressInfo).port}/.well-known/oauth-authorization-server`
  }, 60_000)

  afterAll(() => {
    mtlsServer?.close()
  })

  it('positive: the Settings client identity completes the pinned request', async () => {
    const run = await runChild({
      UA12185_TARGET: mtlsTarget,
      NESSY_CONFIG_DIR: configDir('mtls-settings', {
        tlsCaPath: mtlsServerCert, useBundledCa: false, clientCertPath: clientCert, clientKeyPath: clientKey,
      }),
    })
    expect({ code: run.code, outcome: run.outcome, stderr: run.code === 0 ? '' : run.stderr })
      .toEqual({ code: 0, outcome: { status: 200 }, stderr: '' })
  }, 180_000)

  it('positive: the environment\'s CLAUDE_CODE_CLIENT_CERT / _KEY complete the pinned request', async () => {
    const run = await runChild({
      UA12185_TARGET: mtlsTarget,
      NESSY_CONFIG_DIR: configDir('mtls-env', { tlsCaPath: mtlsServerCert, useBundledCa: false }),
      CLAUDE_CODE_CLIENT_CERT: clientCert,
      CLAUDE_CODE_CLIENT_KEY: clientKey,
    })
    expect({ code: run.code, outcome: run.outcome, stderr: run.code === 0 ? '' : run.stderr })
      .toEqual({ code: 0, outcome: { status: 200 }, stderr: '' })
  }, 180_000)

  it('CONTROL: no client identity — the server refuses the handshake', async () => {
    const run = await runChild({
      UA12185_TARGET: mtlsTarget,
      NESSY_CONFIG_DIR: configDir('mtls-none', { tlsCaPath: mtlsServerCert, useBundledCa: false }),
    })
    expect(run.code).toBe(0)
    expect(Object.keys(run.outcome ?? {})).toEqual(['error'])
    expect(String(run.outcome?.error)).not.toMatch(/SELF_SIGNED|UNABLE_TO_VERIFY/i)
  }, 180_000)
})

/**
 * UA12.201 — the desktop MCP OAuth request honours the proxy the dispatcher selects for its URL (a managed `env`
 * block's proxy, then Settings, then the environment, minus `NO_PROXY`), as Claude Code's own MCP OAuth does: it
 * goes through the proxy by HOST NAME (CONNECT) with the dispatcher's composed trust, and with no proxy for the URL
 * the pinned path is unchanged. Before the row it always connected to the validated address directly.
 *
 * The rig: a local CONNECT recorder in this process stands in for the proxy; it records each CONNECT target and
 * tunnels only the UA12.185 server's `.invalid` name to 127.0.0.1. The certificate is trusted through the Custom CA
 * setting in every arm.
 *
 * Positive: a Settings proxy → 200 and `CONNECT <name>:<port>` recorded; the environment's `HTTPS_PROXY` (the
 * ambient tier) → the same. Negative (control): no proxy → 200 over the pinned path, nothing recorded.
 * Failing arm, taken over the UA12.200 request code: both positive arms completed directly, the recorder empty.
 */
describe.if(RUNNABLE)('UA12.201 · the desktop MCP OAuth request goes through the dispatcher\'s proxy', () => {
  const connects: string[] = []
  let recorder: import('node:http').Server | undefined
  let proxyUrl = ''
  let targetAuthority = ''

  beforeAll(async () => {
    const { createServer } = await import('node:http')
    const { connect } = await import('node:net')
    targetAuthority = new URL(target).host
    const targetPort = Number(new URL(target).port)
    recorder = createServer((_req, res) => { res.writeHead(405); res.end() })
    recorder.on('connect', (req, clientSocket: import('node:net').Socket, head: Buffer) => {
      const requested = String(req.url)
      connects.push(requested)
      if (requested !== targetAuthority) {
        clientSocket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
        return
      }
      const upstream = connect(targetPort, '127.0.0.1', () => {
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
  })

  it('positive: a Settings proxy carries the request by host name', async () => {
    connects.length = 0
    const run = await runChild({
      NESSY_CONFIG_DIR: configDir('proxy-settings', {
        enabled: true, httpsProxy: proxyUrl, tlsCaPath: certPath, useBundledCa: false,
      }),
    })
    expect({ code: run.code, outcome: run.outcome, connects: [...connects], stderr: run.code === 0 ? '' : run.stderr })
      .toEqual({ code: 0, outcome: { status: 200 }, connects: [targetAuthority], stderr: '' })
  }, 180_000)

  it('positive: the environment\'s HTTPS_PROXY carries the request by host name', async () => {
    connects.length = 0
    const run = await runChild({
      NESSY_CONFIG_DIR: configDir('proxy-env', { tlsCaPath: certPath, useBundledCa: false }),
      HTTPS_PROXY: proxyUrl,
    })
    expect({ code: run.code, outcome: run.outcome, connects: [...connects], stderr: run.code === 0 ? '' : run.stderr })
      .toEqual({ code: 0, outcome: { status: 200 }, connects: [targetAuthority], stderr: '' })
  }, 180_000)

  it('CONTROL: no proxy — the pinned path is unchanged and nothing reaches the recorder', async () => {
    connects.length = 0
    const run = await runChild({ NESSY_CONFIG_DIR: configDir('proxy-none', { tlsCaPath: certPath, useBundledCa: false }) })
    expect({ code: run.code, outcome: run.outcome, connects: [...connects] })
      .toEqual({ code: 0, outcome: { status: 200 }, connects: [] })
  }, 180_000)
})
