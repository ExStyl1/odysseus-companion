/**
 * F1.519 item 3, the desktop half (P-WJai-3, 2026-09-24, carried under F1.359)
 * — a client identity named in the ENVIRONMENT (`CLAUDE_CODE_CLIENT_CERT` /
 * `_KEY` / `_KEY_PASSPHRASE`, e.g. a macOS login-shell export `loadShellEnv`
 * copies in) now reaches the desktop main process's host hop, the request that
 * carries every codex and claude-runtime turn.
 *
 * It already reached every Pi turn (a Bun child inheriting the names, its
 * interceptor presenting them), the claude child's own requests (the binary
 * reads them natively), and — through that same interceptor — the HEADLESS
 * server's host hop. The desktop's dispatcher (`configureNodeProxy` →
 * `HostProxyDispatcher`) presented only the stored Settings identity. DECIDED
 * with the headless half (`packages/shared/src/config/__tests__/network-runtime-client-identity.test.ts`):
 * one rule on both hosts — the stored Settings identity when Settings name
 * one, else the environment's, always beside the composed CA set.
 *
 * The rig is F1.498's (`network-proxy-host-hop.test.ts`): the product's own
 * `applyConfiguredProxySettings` + `gatewaySessionFetch` bundled with the main
 * build's esbuild flags and run in a NODE child (under `bun test` the process is
 * Bun, whose `fetch` ignores undici dispatchers). Two upstreams REQUIRE a client
 * certificate, each accepting ONE identity, so which one answered says which
 * identity was presented.
 *
 * Failing arm, taken at `d5ec9426a`: the environment-identity arm FAILED with
 * `UND_ERR_SOCKET` (the upstream refused the handshake: no certificate was
 * presented); the CA-only control passed. (The stored arm's first draft read
 * the peer certificate in the handler, which Bun's server socket does not
 * offer — that is why the rig tells identities apart by upstream.)
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
const HOST = 'f1519-upstream.invalid'
const UPSTREAM = `https://${HOST}/v1/chat/completions`

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

/** `openssl` makes the throwaway certificates. */
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
  console.warn('[F1.519] SKIPPED: needs a Node >= 22 (or the Electron binary) and openssl to host the child')
}

type Pair = { cert: string; key: string }

function selfSigned(dir: string, name: string, subject: string, extra: string[]): Pair {
  const cert = join(dir, `${name}-cert.pem`)
  const key = join(dir, `${name}-key.pem`)
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
    '-keyout', key, '-out', cert, '-subj', subject, ...extra,
  ], { stdio: 'ignore', timeout: 30_000 })
  return { cert, key }
}

let root = ''
let bundle = ''
let server: Pair
let envClient: Pair
let storedClient: Pair
/** An upstream that accepts exactly ONE client identity, behind its own CONNECT tunnel. */
type MtlsUpstream = { upstream: https.Server; tunnel: http.Server; tunnelPort: number; requests: string[] }
let acceptsEnv: MtlsUpstream | undefined
let acceptsStored: MtlsUpstream | undefined

beforeAll(async () => {
  if (!RUNNABLE) return
  root = mkdtempSync(join(tmpdir(), 'nessy-f1519-desktop-'))
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

  server = selfSigned(root, 'server', `/CN=${HOST}`, [
    '-addext', `subjectAltName=DNS:${HOST}`,
    '-addext', 'basicConstraints=critical,CA:TRUE',
  ])
  envClient = selfSigned(root, 'env-client', '/CN=f1519-env-client', ['-addext', 'extendedKeyUsage=clientAuth'])
  storedClient = selfSigned(root, 'stored-client', '/CN=f1519-stored-client', ['-addext', 'extendedKeyUsage=clientAuth'])

  acceptsEnv = await startMtlsUpstream(envClient)
  acceptsStored = await startMtlsUpstream(storedClient)
}, 240_000)

afterAll(() => {
  for (const u of [acceptsEnv, acceptsStored]) {
    u?.tunnel.close()
    u?.upstream.close()
  }
  if (root) rmSync(root, { recursive: true, force: true })
})

/**
 * An HTTPS upstream presenting the self-signed server certificate and REQUIRING
 * a client certificate signed by `trusted` alone, plus a CONNECT tunnel to it —
 * a TLS-inspecting proxy in miniature. Which identity was presented is read off
 * WHICH upstream answered: the test process is Bun, whose server-side socket
 * does not expose `getPeerCertificate` (measured: the handler threw on it).
 */
async function startMtlsUpstream(trusted: Pair): Promise<MtlsUpstream> {
  const requests: string[] = []
  const upstream = https.createServer({
    key: readFileSync(server.key),
    cert: readFileSync(server.cert),
    requestCert: true,
    rejectUnauthorized: true,
    ca: [readFileSync(trusted.cert)],
  }, (req, res) => {
    requests.push(`${req.method} ${req.url}`)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{}')
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', () => resolve()))
  const upstreamPort = (upstream.address() as AddressInfo).port
  const tunnel = http.createServer((_req, res) => { res.writeHead(502); res.end() })
  tunnel.on('connect', (_req, socket) => {
    const next = net.connect(upstreamPort, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      next.pipe(socket)
      socket.pipe(next)
    })
    next.on('error', () => socket.destroy())
    socket.on('error', () => next.destroy())
  })
  await new Promise<void>((resolve) => tunnel.listen(0, '127.0.0.1', () => resolve()))
  return { upstream, tunnel, tunnelPort: (tunnel.address() as AddressInfo).port, requests }
}

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

/** Async spawn: a synchronous one would deadlock against the in-process servers. */
function runChild(via: MtlsUpstream, env: Record<string, string>): Promise<{ code: number | null; outcome: Record<string, unknown> | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(runtime!.command, [bundle], {
      // A CLEAN launch environment: nothing the test runner carries may decide the answer.
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: root,
        NODE_PATH: join(REPO_ROOT, 'node_modules'),
        ...runtime!.env,
        HTTPS_PROXY: `http://127.0.0.1:${via.tunnelPort}`,
        F1498_TARGET: UPSTREAM,
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

const envIdentity = () => ({ CLAUDE_CODE_CLIENT_CERT: envClient.cert, CLAUDE_CODE_CLIENT_KEY: envClient.key })

describe.if(RUNNABLE)('F1.519 — the desktop host hop presents an environment client identity, beside the Settings CA', () => {
  it('a login-shell export of the client identity, with a Settings CA: the hop completes as that identity', async () => {
    acceptsEnv!.requests.length = 0
    const run = await runChild(acceptsEnv!, {
      NESSY_CONFIG_DIR: configDir('shell-env-identity', { tlsCaPath: server.cert }),
      // `loadShellEnv`'s channel: written into process.env before the apply.
      F1498_SHELL_ENV: JSON.stringify(envIdentity()),
    })
    expect({ code: run.code, outcome: run.outcome, stderr: run.code === 0 ? '' : run.stderr })
      .toEqual({ code: 0, outcome: { status: 200 }, stderr: '' })
    expect(acceptsEnv!.requests).toEqual(['POST /v1/chat/completions'])
  }, 180_000)

  it('a stored Settings identity beats the environment one', async () => {
    acceptsStored!.requests.length = 0
    const stored = { tlsCaPath: server.cert, clientCertPath: storedClient.cert, clientKeyPath: storedClient.key }
    const run = await runChild(acceptsStored!, { NESSY_CONFIG_DIR: configDir('stored-over-env', stored), ...envIdentity() })
    expect({ code: run.code, outcome: run.outcome }).toEqual({ code: 0, outcome: { status: 200 } })
    expect(acceptsStored!.requests).toEqual(['POST /v1/chat/completions'])
  }, 180_000)

  it('… and the environment identity is not what was presented: an upstream accepting only it refuses', async () => {
    acceptsEnv!.requests.length = 0
    const stored = { tlsCaPath: server.cert, clientCertPath: storedClient.cert, clientKeyPath: storedClient.key }
    const run = await runChild(acceptsEnv!, { NESSY_CONFIG_DIR: configDir('stored-not-env', stored), ...envIdentity() })
    expect(run.code).toBe(0)
    expect(Object.keys(run.outcome ?? {})).toEqual(['error'])
    expect(acceptsEnv!.requests).toEqual([])
  }, 180_000)

  it('CONTROL: the Settings CA with no identity anywhere — the upstream refuses the handshake', async () => {
    acceptsEnv!.requests.length = 0
    const run = await runChild(acceptsEnv!, { NESSY_CONFIG_DIR: configDir('ca-only', { tlsCaPath: server.cert }) })
    expect(run.code).toBe(0)
    expect(Object.keys(run.outcome ?? {})).toEqual(['error'])
    expect(run.outcome?.error).not.toBe('DEPTH_ZERO_SELF_SIGNED_CERT')
    expect(acceptsEnv!.requests).toEqual([])
  }, 180_000)
})

/**
 * F1.563 (P-WJax-1, DECIDED by the controller 2026-09-24) — a client identity a
 * MANAGED `env` block names is the desktop host hop's top tier too: managed,
 * then the stored Settings identity, then the environment — the ladder the
 * managed proxy and CA already follow (F1.498). The child writes the block
 * AFTER `applyConfiguredProxySettings`, the order `bootstrapServer` reaches it
 * in, so the dispatcher must notice it at dispatch time, as it does for a
 * managed `NODE_EXTRA_CA_CERTS`.
 *
 * Here `acceptsEnv` accepts the identity the managed block names (the same
 * files), and `acceptsStored` the Settings one.
 */
const managedIdentity = () => JSON.stringify(envIdentity())

describe.if(RUNNABLE)('F1.563 — a managed client identity is the desktop host hop\'s top tier', () => {
  it('a managed identity beside a Settings CA and a Settings identity: the hop completes as the MANAGED identity', async () => {
    acceptsEnv!.requests.length = 0
    const stored = { tlsCaPath: server.cert, clientCertPath: storedClient.cert, clientKeyPath: storedClient.key }
    const run = await runChild(acceptsEnv!, { NESSY_CONFIG_DIR: configDir('managed-over-stored', stored), F1498_MANAGED_ENV: managedIdentity() })
    expect({ code: run.code, outcome: run.outcome, stderr: run.code === 0 ? '' : run.stderr })
      .toEqual({ code: 0, outcome: { status: 200 }, stderr: '' })
    expect(acceptsEnv!.requests).toEqual(['POST /v1/chat/completions'])
  }, 180_000)

  it('… and the Settings identity is not what was presented: an upstream accepting only it refuses', async () => {
    acceptsStored!.requests.length = 0
    const stored = { tlsCaPath: server.cert, clientCertPath: storedClient.cert, clientKeyPath: storedClient.key }
    const run = await runChild(acceptsStored!, { NESSY_CONFIG_DIR: configDir('managed-not-stored', stored), F1498_MANAGED_ENV: managedIdentity() })
    expect(run.code).toBe(0)
    expect(Object.keys(run.outcome ?? {})).toEqual(['error'])
    expect(acceptsStored!.requests).toEqual([])
  }, 180_000)

  it('a managed identity with only a Settings CA: the hop completes as the managed identity', async () => {
    acceptsEnv!.requests.length = 0
    const run = await runChild(acceptsEnv!, { NESSY_CONFIG_DIR: configDir('managed-only', { tlsCaPath: server.cert }), F1498_MANAGED_ENV: managedIdentity() })
    expect({ code: run.code, outcome: run.outcome }).toEqual({ code: 0, outcome: { status: 200 } })
    expect(acceptsEnv!.requests).toEqual(['POST /v1/chat/completions'])
  }, 180_000)
})
