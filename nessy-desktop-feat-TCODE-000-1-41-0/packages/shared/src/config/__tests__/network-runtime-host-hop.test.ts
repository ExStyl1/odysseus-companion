/**
 * F1.498 — the HEADLESS server's host hop (the request that carries every codex
 * and claude-runtime turn) follows the same proxy ladder as the desktop:
 * a managed `env` block's proxy, then Settings, then the environment.
 *
 * The desktop twin, with the measured table and the reason the hop is the
 * host's, is `apps/electron/src/main/__tests__/network-proxy-host-hop.test.ts`.
 * Here the child is BUN, launched the way `bin/nessy-server` launches the server
 * — `bun run --preload <interceptor> <entry>` from a directory with no
 * `bunfig.toml` — then `applyProcessNetworkTrustChain()`, then (optionally) a
 * managed `env` block, then the hop's own `gatewaySessionFetch`. A fresh child
 * per arm, because every input here is process state: the interceptor's
 * `PROXY_URL` is frozen at preload and the managed-origin registry never
 * forgets a name.
 *
 * Failing arm, taken 2026-09-24 against a scratch `git archive HEAD` export of
 * `packages/shared` (the working tree untouched): the launch-env arm and both
 * controls passed; the managed arm, managed-beats-Settings and
 * Settings-beat-the-launch-env all FAILED — the first two because Bun 1.3.14's
 * `fetch` does not re-read a proxy name assigned at runtime and nothing else
 * resolved one, the third because the interceptor overwrote the wrapper's
 * Settings proxy with its launch-time copy. (A launch-environment proxy with a
 * loopback target failed at HEAD too, and still would — see the boundary arm.)
 *
 * The two CA arms: a managed `NODE_EXTRA_CA_CERTS` written after startup is
 * trusted by the hop through a TLS-terminating tunnel, and the same tunnel
 * without it fails the handshake. With only the proxy half fixed, the rig
 * measured exactly that failure here (`self signed certificate in certificate
 * chain`): the managed CA tier of `resolveTlsCaPathSelection` never answered,
 * because the chain was composed before the managed block existed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { STORAGE_LAYOUT_VERSION } from '../paths.ts'

const CHILD = join(import.meta.dir, 'fixtures', 'network-runtime-host-hop-child.ts')
const INTERCEPTOR = join(import.meta.dir, '..', '..', 'unified-network-interceptor.ts')
const UPSTREAM = 'https://f1498-upstream.invalid/v1/chat/completions'
const UPSTREAM_CONNECT = 'f1498-upstream.invalid:443'

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
let proxyA: Recorder
let proxyB: Recorder
let tlsUpstream: TlsUpstream | null = null
let tunnel: Recorder | null = null

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'nessy-f1498-headless-'))
  proxyA = await startRecorder()
  proxyB = await startRecorder()
  tlsUpstream = await startTlsUpstream(root)
  if (tlsUpstream) tunnel = await startTunnel(tlsUpstream.port)
})

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
    const child = spawn(process.execPath, ['run', '--preload', INTERCEPTOR, CHILD], {
      // No bunfig.toml here, like an assembled distribution; NESSY_CONFIG_DIR is
      // in the LAUNCH environment, the one form that isolates on every invocation.
      cwd: root,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: root, ...env },
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

function expectChildOk(run: { code: number | null; stderr: string }): void {
  expect({ code: run.code, stderr: run.code === 0 ? '' : run.stderr.slice(-2000) }).toEqual({ code: 0, stderr: '' })
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

describe('F1.498 — the headless host hop follows managed > Settings > environment', () => {
  it('control: nothing configured anywhere — no proxy sees the hop', async () => {
    resetRecorders()
    const run = await runChild({ NESSY_CONFIG_DIR: configDir('none'), F1498_TARGET: UPSTREAM })
    expectChildOk(run)
    expect(proxyA.connects).toEqual([])
    expect(proxyB.connects).toEqual([])
  }, 180_000)

  it('control: a proxy in the LAUNCH environment carries the hop (it always did here)', async () => {
    resetRecorders()
    const run = await runChild({ NESSY_CONFIG_DIR: configDir('launch'), HTTPS_PROXY: url(proxyA), F1498_TARGET: UPSTREAM })
    expectChildOk(run)
    expect(proxyA.connects).toEqual([UPSTREAM_CONNECT])
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

  it('Settings beat a launch-environment proxy', async () => {
    resetRecorders()
    const run = await runChild({
      NESSY_CONFIG_DIR: configDir('settings-over-launch', { enabled: true, httpsProxy: url(proxyA) }),
      HTTPS_PROXY: url(proxyB),
      F1498_TARGET: UPSTREAM,
    })
    expectChildOk(run)
    expect(proxyA.connects).toEqual([UPSTREAM_CONNECT])
    expect(proxyB.connects).toEqual([])
  }, 180_000)

  it('a MANAGED proxy beats Settings', async () => {
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

  // The MANAGED tier is the one this row adds here, so it is the one whose
  // loopback exemption is pinned. A LAUNCH-environment proxy is a different
  // story on this host and is not claimed: Bun 1.3.14 proxies loopback itself
  // when `HTTP_PROXY` is in its launch environment (no built-in exemption,
  // measured 2026-09-24), and the interceptor's inline NO_PROXY twin has none
  // either — a residue recorded on the row, not fixed here.
  it('boundary: loopback stays direct under a managed proxy', async () => {
    resetRecorders()
    const run = await runChild({
      NESSY_CONFIG_DIR: configDir('loopback'),
      F1498_MANAGED_ENV: JSON.stringify({ HTTPS_PROXY: url(proxyB), HTTP_PROXY: url(proxyB) }),
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
})
