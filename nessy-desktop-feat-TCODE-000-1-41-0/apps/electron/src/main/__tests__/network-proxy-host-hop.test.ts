/**
 * F1.498 — a proxy named in the ENVIRONMENT reaches the desktop main process's
 * own host hop, the request that carries every codex and claude-runtime turn.
 *
 * ## The hop, and why it is the host's
 *
 * A codex or claude-runtime child never talks to the model provider: it talks to
 * the per-session loopback adapter (`@nessy-agent/codex-responses-adapter`
 * `startAdapter`), which runs INSIDE the host and makes the upstream request
 * itself through `gatewaySessionFetch(<session id>)` — whose inner `fetch` is the
 * host's global. So a proxy the CHILD honours governs nothing but the child's own
 * tool traffic; the model traffic follows whatever the HOST's fetch does.
 *
 * ## What was measured (WJ-ai, 2026-09-24, rig under the untracked `work/wjai/`)
 *
 * The same hop, both deployments, three mandate channels, a TLS-terminating
 * recording proxy and a throwaway CA:
 *
 * | channel | desktop (Electron 39.8.10 / Node 22.22.1, the product's dispatcher) | headless (Bun 1.3.14, interceptor preloaded + `applyProcessNetworkTrustChain`) |
 * | --- | --- | --- |
 * | Settings (`networkProxy`) | proxied | proxied |
 * | launch env `HTTPS_PROXY` | **DIRECT** — even with `NODE_USE_ENV_PROXY=1` | proxied |
 * | managed `env` block, written after startup | **DIRECT** | **DIRECT** |
 * | managed `NODE_EXTRA_CA_CERTS`, same block | not trusted | not trusted |
 *
 * The desktop's launch-env miss is not hypothetical on macOS: `loadShellEnv`
 * copies the user's login-shell exports into the packaged main process's
 * `process.env` before anything else runs, so an `export HTTPS_PROXY=…` in
 * `.zprofile` reached every Pi turn (a Bun child inheriting it) and every claude
 * / codex CHILD, and was ignored by the one request that carries their model
 * traffic. `configureNodeProxy` installed a plain direct `Agent` whenever
 * Settings named no proxy, which also defeats Node's own `NODE_USE_ENV_PROXY`.
 * The managed channel is the one `network-config.md#environment-variables`
 * documents for mandating a proxy — *"Claude Code reads them only from managed
 * settings and `~/.claude/settings.json`"* — and it is written by
 * `bootstrapServer`, after the dispatcher was built.
 *
 * ## What this pins
 *
 * The dispatcher now resolves the proxy PER REQUEST through
 * `resolveHostProxySelection` (`@nessy-agent/shared/config/network-proxy-utils`):
 * a managed-origin environment proxy, then Settings, then the ambient
 * environment — the same ladder `tls-ca-path.ts` gives the extra CA. Each arm
 * runs the product's own `applyConfiguredProxySettings` and the hop's own
 * `gatewaySessionFetch` in a NODE child (under `bun test` the process is Bun,
 * whose `fetch` ignores undici dispatchers entirely, so an in-process assertion
 * would be vacuous), and reads the verdict from a recording proxy: a CONNECT for
 * the upstream host arrived, or it did not.
 *
 * The CA half is the same arrival-order problem: `resolveTlsCaPathSelection`
 * already ranks a managed `NODE_EXTRA_CA_CERTS` first, but the set was composed
 * before the managed block was written, so once the proxy fix routed the hop
 * through a managed proxy the rig measured `self signed certificate` on both
 * hosts. The dispatcher now re-resolves the chain when the managed value moves;
 * the two CA arms drive a TLS-terminating tunnel with a throwaway certificate.
 *
 * Controls: nothing configured → no CONNECT; Settings beat an ambient proxy;
 * loopback stays direct under an environment proxy; the managed proxy WITHOUT
 * the managed CA fails its handshake (so the CA, not a lax TLS stack, is what
 * completes the other arm).
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { build } from 'esbuild'
import { STORAGE_LAYOUT_VERSION } from '@nessy-agent/shared/config/paths'

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..', '..')
const FIXTURES = join(import.meta.dir, 'fixtures')
const UPSTREAM = 'https://f1498-upstream.invalid/v1/chat/completions'
const UPSTREAM_CONNECT = 'f1498-upstream.invalid:443'

/**
 * The Node the desktop main process is: Electron's own binary as Node when it
 * was downloaded, else a `node` on PATH that is new enough. Never
 * `process.execPath` — under `bun test` that is Bun.
 */
function resolveNodeRuntime(): { command: string; env: Record<string, string>; label: string } | null {
  try {
    const electronDir = dirname(require.resolve('electron/package.json', { paths: [REPO_ROOT] }))
    const relative = readFileSync(join(electronDir, 'path.txt'), 'utf8').trim()
    const binary = join(electronDir, 'dist', relative)
    if (existsSync(binary)) return { command: binary, env: { ELECTRON_RUN_AS_NODE: '1' }, label: 'electron-as-node' }
  } catch {
    // No electron package or binary on this runner — fall through to `node`.
  }
  try {
    const version = execFileSync('node', ['-p', 'process.versions.node'], { encoding: 'utf8', timeout: 10_000 }).trim()
    const [major = 0] = version.split('.').map(Number)
    if (major >= 22) return { command: 'node', env: {}, label: `node ${version}` }
  } catch {
    // No node either.
  }
  return null
}

const runtime = resolveNodeRuntime()
if (!runtime) {
  console.warn('[F1.498] SKIPPED: neither the Electron binary nor a Node >= 22 is available to host the child')
}

type Recorder = { port: number; connects: string[]; plain: string[]; server: http.Server }

async function startRecorder(): Promise<Recorder> {
  const connects: string[] = []
  const plain: string[] = []
  const server = http.createServer((req, res) => {
    plain.push(req.url ?? '')
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{}')
  })
  // Records the tunnel request and refuses it: the verdict is THAT it arrived.
  server.on('connect', (req, socket) => {
    connects.push(req.url ?? '')
    socket.end('HTTP/1.1 403 F1.498 recorder\r\n\r\n')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  return { port: (server.address() as AddressInfo).port, connects, plain, server }
}

/**
 * The TLS half: a throwaway self-signed certificate for the upstream host (made
 * with `openssl`, which the headless server already needs for its own
 * certificate), an HTTPS server presenting it, and a recorder that TUNNELS a
 * CONNECT to that server instead of refusing it — a TLS-inspecting proxy in
 * miniature. A hop completes through it only if this process trusts the cert.
 */
type TlsUpstream = { certPath: string; requests: string[]; server: https.Server; port: number }

async function startTlsUpstream(dir: string): Promise<TlsUpstream | null> {
  const certPath = join(dir, 'upstream-cert.pem')
  const keyPath = join(dir, 'upstream-key.pem')
  try {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
      '-keyout', keyPath, '-out', certPath,
      '-subj', '/CN=f1498-upstream.invalid',
      '-addext', 'subjectAltName=DNS:f1498-upstream.invalid',
      '-addext', 'basicConstraints=critical,CA:TRUE',
    ], { stdio: 'ignore', timeout: 30_000 })
  } catch {
    return null
  }
  const requests: string[] = []
  const server = https.createServer({ key: readFileSync(keyPath), cert: readFileSync(certPath) }, (req, res) => {
    requests.push(`${req.method} ${req.url}`)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  return { certPath, requests, server, port: (server.address() as AddressInfo).port }
}

async function startTunnel(toPort: number): Promise<Recorder> {
  const connects: string[] = []
  const plain: string[] = []
  const server = http.createServer((req, res) => {
    plain.push(req.url ?? '')
    res.writeHead(502)
    res.end()
  })
  server.on('connect', (req, socket) => {
    connects.push(req.url ?? '')
    const upstream = net.connect(toPort, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      upstream.pipe(socket)
      socket.pipe(upstream)
    })
    upstream.on('error', () => socket.destroy())
    socket.on('error', () => upstream.destroy())
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  return { port: (server.address() as AddressInfo).port, connects, plain, server }
}

let root = ''
let bundle = ''
let proxyA: Recorder
let proxyB: Recorder
let tlsUpstream: TlsUpstream | null = null
let tunnel: Recorder | null = null

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'nessy-f1498-'))
  bundle = join(root, 'child.cjs')
  const stubs = join(FIXTURES, 'network-proxy-host-hop-stubs.cjs')
  // The Electron main's own flags (`apps/electron/package.json` build:main).
  await build({
    entryPoints: [join(FIXTURES, 'network-proxy-host-hop-child.ts')],
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
  proxyA = await startRecorder()
  proxyB = await startRecorder()
  tlsUpstream = await startTlsUpstream(root)
  if (tlsUpstream) tunnel = await startTunnel(tlsUpstream.port)
}, 240_000)

afterAll(() => {
  proxyA?.server.close()
  proxyB?.server.close()
  tunnel?.server.close()
  tlsUpstream?.server.close()
  if (root) rmSync(root, { recursive: true, force: true })
})

function resetRecorders(): void {
  for (const r of [proxyA, proxyB, ...(tunnel ? [tunnel] : [])]) {
    r.connects.length = 0
    r.plain.length = 0
  }
  if (tlsUpstream) tlsUpstream.requests.length = 0
}

/** A config dir holding a v-current config.json, with `networkProxy` when given. */
function configDir(name: string, networkProxy?: Record<string, unknown>): string {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  if (networkProxy) {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({
      storageLayoutVersion: STORAGE_LAYOUT_VERSION,
      workspaceRefs: [],
      activeWorkspaceId: null,
      networkProxy,
    }))
  }
  return dir
}

/** Async spawn: a synchronous one would deadlock against the in-process recorders. */
function runChild(env: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(runtime!.command, [bundle], {
      // A CLEAN launch environment: nothing the test runner carries may decide the answer.
      // NODE_PATH: the bundle lives in a temp dir and keeps the main build's one
      // external (`@anthropic-ai/claude-agent-sdk`), which must still resolve.
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: root, NODE_PATH: join(REPO_ROOT, 'node_modules'), ...runtime!.env, ...env },
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
      resolve({ code, stdout, stderr })
    })
  })
}

const url = (r: Recorder) => `http://127.0.0.1:${r.port}`

/** `openssl` makes the throwaway certificate; without it the two CA arms cannot run. */
const OPENSSL = (() => {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore', timeout: 10_000 })
    return true
  } catch {
    return false
  }
})()

/** Exit 0, and when not, the child's own stderr in the failure — a bare exit code explains nothing. */
function expectChildOk(run: { code: number | null; stderr: string }): void {
  expect({ code: run.code, stderr: run.code === 0 ? '' : run.stderr.slice(-2000) }).toEqual({ code: 0, stderr: '' })
}

describe.if(runtime !== null)('F1.498 — the desktop host hop honours an environment proxy', () => {
  it('control: nothing configured anywhere — the hop goes direct and no proxy sees it', async () => {
    resetRecorders()
    const run = await runChild({ NESSY_CONFIG_DIR: configDir('none'), F1498_TARGET: UPSTREAM })
    expectChildOk(run)
    expect(proxyA.connects).toEqual([])
    expect(proxyB.connects).toEqual([])
  }, 180_000)

  it('a proxy in the LAUNCH environment (a login-shell export on macOS) carries the hop', async () => {
    resetRecorders()
    const run = await runChild({ NESSY_CONFIG_DIR: configDir('launch'), HTTPS_PROXY: url(proxyA), F1498_TARGET: UPSTREAM })
    expectChildOk(run)
    expect(proxyA.connects).toEqual([UPSTREAM_CONNECT])
  }, 180_000)

  it('the documented order holds: lowercase https_proxy beats HTTPS_PROXY', async () => {
    resetRecorders()
    const run = await runChild({
      NESSY_CONFIG_DIR: configDir('order'),
      https_proxy: url(proxyA),
      HTTPS_PROXY: url(proxyB),
      F1498_TARGET: UPSTREAM,
    })
    expectChildOk(run)
    expect(proxyA.connects).toEqual([UPSTREAM_CONNECT])
    expect(proxyB.connects).toEqual([])
  }, 180_000)

  it('a proxy a MANAGED env block writes after startup carries the hop', async () => {
    resetRecorders()
    const run = await runChild({
      NESSY_CONFIG_DIR: configDir('managed'),
      F1498_MANAGED_ENV: JSON.stringify({ HTTPS_PROXY: url(proxyA) }),
      F1498_TARGET: UPSTREAM,
    })
    expectChildOk(run)
    expect(proxyA.connects).toEqual([UPSTREAM_CONNECT])
  }, 180_000)

  it('Settings beat an ambient proxy (the precedence buildPiSubprocessEnv already gives)', async () => {
    resetRecorders()
    const run = await runChild({
      NESSY_CONFIG_DIR: configDir('settings-over-ambient', { enabled: true, httpsProxy: url(proxyA) }),
      HTTPS_PROXY: url(proxyB),
      F1498_TARGET: UPSTREAM,
    })
    expectChildOk(run)
    expect(proxyA.connects).toEqual([UPSTREAM_CONNECT])
    expect(proxyB.connects).toEqual([])
  }, 180_000)

  it('a MANAGED proxy beats Settings (the managed tier tls-ca-path.ts gives the CA)', async () => {
    resetRecorders()
    const run = await runChild({
      NESSY_CONFIG_DIR: configDir('managed-over-settings', { enabled: true, httpsProxy: url(proxyA) }),
      F1498_MANAGED_ENV: JSON.stringify({ HTTPS_PROXY: url(proxyB) }),
      F1498_TARGET: UPSTREAM,
    })
    expectChildOk(run)
    expect(proxyB.connects).toEqual([UPSTREAM_CONNECT])
    expect(proxyA.connects).toEqual([])
  }, 180_000)

  it('boundary: loopback stays direct under an environment proxy', async () => {
    resetRecorders()
    const run = await runChild({
      NESSY_CONFIG_DIR: configDir('loopback'),
      HTTPS_PROXY: url(proxyB),
      HTTP_PROXY: url(proxyB),
      F1498_TARGET: `${url(proxyA)}/f1498-direct-probe`,
    })
    expectChildOk(run)
    expect(JSON.parse(run.stdout.trim())).toEqual({ status: 200 })
    expect(proxyA.plain).toEqual(['/f1498-direct-probe'])
    expect(proxyB.connects).toEqual([])
    expect(proxyB.plain).toEqual([])
  }, 180_000)

  it.if(OPENSSL)('a managed proxy AND a managed CA: the hop through a TLS-inspecting proxy completes', async () => {
    resetRecorders()
    expect(tlsUpstream).not.toBeNull()
    const run = await runChild({
      NESSY_CONFIG_DIR: configDir('managed-ca'),
      F1498_MANAGED_ENV: JSON.stringify({ HTTPS_PROXY: url(tunnel!), NODE_EXTRA_CA_CERTS: tlsUpstream!.certPath }),
      F1498_TARGET: UPSTREAM,
    })
    expectChildOk(run)
    expect(tunnel!.connects).toEqual([UPSTREAM_CONNECT])
    expect(tlsUpstream!.requests).toEqual(['POST /v1/chat/completions'])
    expect(JSON.parse(run.stdout.trim())).toEqual({ status: 200 })
  }, 180_000)

  it.if(OPENSSL)('control: the same managed proxy WITHOUT the managed CA fails its handshake', async () => {
    resetRecorders()
    const run = await runChild({
      NESSY_CONFIG_DIR: configDir('managed-no-ca'),
      F1498_MANAGED_ENV: JSON.stringify({ HTTPS_PROXY: url(tunnel!) }),
      F1498_TARGET: UPSTREAM,
    })
    expectChildOk(run)
    expect(tunnel!.connects).toEqual([UPSTREAM_CONNECT])
    expect(tlsUpstream!.requests).toEqual([])
    expect(Object.keys(JSON.parse(run.stdout.trim()))).toEqual(['error'])
  }, 180_000)

  it.if(OPENSSL)('a login-shell export of HTTPS_PROXY AND NODE_EXTRA_CA_CERTS completes through a TLS-inspecting proxy', async () => {
    // `loadShellEnv` writes both after Node read NODE_EXTRA_CA_CERTS at startup,
    // so the CA reaches the chain only if the host reads it itself; with the
    // proxy honoured and the CA not, this hop failed its handshake.
    resetRecorders()
    expect(tlsUpstream).not.toBeNull()
    const run = await runChild({
      NESSY_CONFIG_DIR: configDir('login-shell-ca'),
      F1498_SHELL_ENV: JSON.stringify({ HTTPS_PROXY: url(tunnel!), NODE_EXTRA_CA_CERTS: tlsUpstream!.certPath }),
      F1498_TARGET: UPSTREAM,
    })
    expectChildOk(run)
    expect(tunnel!.connects).toEqual([UPSTREAM_CONNECT])
    expect(tlsUpstream!.requests).toEqual(['POST /v1/chat/completions'])
    expect(JSON.parse(run.stdout.trim())).toEqual({ status: 200 })
  }, 180_000)
})
