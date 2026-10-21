/**
 * F1.519 item 3 (P-WJai-3, 2026-09-24, carried under F1.359) — on the HEADLESS
 * server's host hop (the request that carries every codex and claude-runtime
 * turn) a client identity from the environment (`CLAUDE_CODE_CLIENT_CERT` /
 * `_KEY` / `_KEY_PASSPHRASE`) no longer REPLACES the TLS options the trust chain
 * composed.
 *
 * The hop is two layers: `config/network-runtime.ts` wraps `fetch` and hands
 * each request `tls` = the composed CA set (a Settings, managed or bundled CA)
 * plus the stored Settings identity; the interceptor `bin/nessy-server`
 * preloads sits inside it and read the environment's identity at preload. It
 * spread `{ tls: <env identity> }` AFTER the caller's options, so an operator
 * with a Settings CA and an environment client certificate got the certificate
 * and lost the CA — the hop through a TLS-inspecting proxy then failed its
 * handshake. DECIDED (stored mTLS is the product channel, and the row's
 * control asks for both to apply): the caller's `tls` is kept, the
 * environment's identity fills in only an identity it lacks, and a stored
 * identity wins whole — the precedence `explicitProxy` gave the proxy (F1.498).
 *
 * The rig is the F1.498 one (`network-runtime-host-hop.test.ts`, whose child
 * this file reuses): `bun run --preload <interceptor> <child>` from a directory
 * with no `bunfig.toml`, a CONNECT tunnel standing in for the proxy, and an
 * HTTPS upstream that REQUIRES a client certificate and presents a self-signed
 * one, so a request completes only if this process both trusts the server AND
 * presents an identity the server accepts. Two such upstreams, each accepting
 * ONE identity, say which one was presented.
 *
 * Failing arm, taken at `d5ec9426a`: the Settings-CA-plus-environment-identity
 * arm and the stored-beats-environment arm FAILED with
 * `DEPTH_ZERO_SELF_SIGNED_CERT` — the CA was gone, so this process refused the
 * server; the two controls passed.
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
const HOST = 'f1519-upstream.invalid'
const UPSTREAM = `https://${HOST}/v1/chat/completions`

/** `openssl` makes the throwaway certificates; without it no arm can run. */
const OPENSSL = (() => {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore', timeout: 10_000 })
    return true
  } catch {
    return false
  }
})()

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
let server: Pair
let envClient: Pair
let storedClient: Pair
/** An upstream that accepts exactly ONE client identity, behind its own CONNECT tunnel. */
type MtlsUpstream = { upstream: https.Server; tunnel: http.Server; tunnelPort: number; requests: string[] }
let acceptsEnv: MtlsUpstream
let acceptsStored: MtlsUpstream

beforeAll(async () => {
  if (!OPENSSL) return
  root = mkdtempSync(join(tmpdir(), 'nessy-f1519-mtls-'))
  server = selfSigned(root, 'server', `/CN=${HOST}`, [
    '-addext', `subjectAltName=DNS:${HOST}`,
    '-addext', 'basicConstraints=critical,CA:TRUE',
  ])
  envClient = selfSigned(root, 'env-client', '/CN=f1519-env-client', ['-addext', 'extendedKeyUsage=clientAuth'])
  storedClient = selfSigned(root, 'stored-client', '/CN=f1519-stored-client', ['-addext', 'extendedKeyUsage=clientAuth'])

  acceptsEnv = await startMtlsUpstream(envClient)
  acceptsStored = await startMtlsUpstream(storedClient)
})

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
    const child = spawn(process.execPath, ['run', '--preload', INTERCEPTOR, CHILD], {
      cwd: root,
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: root,
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

describe.if(OPENSSL)('F1.519 — the headless host hop keeps its composed TLS when the environment names a client identity', () => {
  it('a Settings CA and an environment client certificate both apply', async () => {
    acceptsEnv.requests.length = 0
    const run = await runChild(acceptsEnv, { NESSY_CONFIG_DIR: configDir('ca-plus-env', { tlsCaPath: server.cert }), ...envIdentity() })
    expect({ code: run.code, outcome: run.outcome }).toEqual({ code: 0, outcome: { status: 200 } })
    expect(acceptsEnv.requests).toEqual(['POST /v1/chat/completions'])
  }, 180_000)

  it('a stored Settings identity beats the environment one, and the CA still applies', async () => {
    acceptsStored.requests.length = 0
    const stored = { tlsCaPath: server.cert, clientCertPath: storedClient.cert, clientKeyPath: storedClient.key }
    const run = await runChild(acceptsStored, { NESSY_CONFIG_DIR: configDir('stored-over-env', stored), ...envIdentity() })
    expect({ code: run.code, outcome: run.outcome }).toEqual({ code: 0, outcome: { status: 200 } })
    expect(acceptsStored.requests).toEqual(['POST /v1/chat/completions'])
  }, 180_000)

  it('… and the environment identity is not what was presented: an upstream accepting only it refuses', async () => {
    acceptsEnv.requests.length = 0
    const stored = { tlsCaPath: server.cert, clientCertPath: storedClient.cert, clientKeyPath: storedClient.key }
    const run = await runChild(acceptsEnv, { NESSY_CONFIG_DIR: configDir('stored-not-env', stored), ...envIdentity() })
    expect(run.code).toBe(0)
    expect(Object.keys(run.outcome ?? {})).toEqual(['error'])
    expect(run.outcome?.error).not.toBe('DEPTH_ZERO_SELF_SIGNED_CERT')
    expect(acceptsEnv.requests).toEqual([])
  }, 180_000)

  it('CONTROL: the Settings CA with no client identity anywhere — the upstream refuses the handshake', async () => {
    acceptsEnv.requests.length = 0
    const run = await runChild(acceptsEnv, { NESSY_CONFIG_DIR: configDir('ca-only', { tlsCaPath: server.cert }) })
    expect(run.code).toBe(0)
    expect(Object.keys(run.outcome ?? {})).toEqual(['error'])
    // The SERVER refused (no certificate), not this process: the CA did its part.
    expect(run.outcome?.error).not.toBe('DEPTH_ZERO_SELF_SIGNED_CERT')
    expect(acceptsEnv.requests).toEqual([])
  }, 180_000)

  it('CONTROL: the environment identity with no CA for the server — this process refuses the server', async () => {
    acceptsEnv.requests.length = 0
    const run = await runChild(acceptsEnv, { NESSY_CONFIG_DIR: configDir('env-only', {}), ...envIdentity() })
    expect(run.code).toBe(0)
    expect(run.outcome).toEqual({ error: 'DEPTH_ZERO_SELF_SIGNED_CERT' })
    expect(acceptsEnv.requests).toEqual([])
  }, 180_000)
})

/**
 * F1.563 (P-WJax-1, DECIDED by the controller 2026-09-24) — a client identity a
 * MANAGED `env` block names (`CLAUDE_CODE_CLIENT_CERT` / `_KEY`) is the host
 * hop's top tier, as the managed proxy and CA are (F1.498): managed, then the
 * stored Settings identity, then the environment. The block is written by
 * `bootstrapServer` AFTER the trust chain is composed (the child applies it
 * after `applyProcessNetworkTrustChain`, in that order), and the interceptor's
 * environment copy was read at preload, so before this row the managed
 * identity reached no request on this hop at all.
 *
 * Here `acceptsEnv` accepts the identity the managed block names (the same
 * files), and `acceptsStored` the Settings one.
 */
const managedIdentity = () => JSON.stringify({ CLAUDE_CODE_CLIENT_CERT: envClient.cert, CLAUDE_CODE_CLIENT_KEY: envClient.key })

describe.if(OPENSSL)('F1.563 — a managed client identity is the headless host hop\'s top tier', () => {
  it('a managed identity beside a Settings CA and a Settings identity: the hop completes as the MANAGED identity', async () => {
    acceptsEnv.requests.length = 0
    const stored = { tlsCaPath: server.cert, clientCertPath: storedClient.cert, clientKeyPath: storedClient.key }
    const run = await runChild(acceptsEnv, { NESSY_CONFIG_DIR: configDir('managed-over-stored', stored), F1498_MANAGED_ENV: managedIdentity() })
    expect({ code: run.code, outcome: run.outcome }).toEqual({ code: 0, outcome: { status: 200 } })
    expect(acceptsEnv.requests).toEqual(['POST /v1/chat/completions'])
  }, 180_000)

  it('… and the Settings identity is not what was presented: an upstream accepting only it refuses', async () => {
    acceptsStored.requests.length = 0
    const stored = { tlsCaPath: server.cert, clientCertPath: storedClient.cert, clientKeyPath: storedClient.key }
    const run = await runChild(acceptsStored, { NESSY_CONFIG_DIR: configDir('managed-not-stored', stored), F1498_MANAGED_ENV: managedIdentity() })
    expect(run.code).toBe(0)
    expect(Object.keys(run.outcome ?? {})).toEqual(['error'])
    expect(run.outcome?.error).not.toBe('DEPTH_ZERO_SELF_SIGNED_CERT')
    expect(acceptsStored.requests).toEqual([])
  }, 180_000)

  it('a managed identity with only a Settings CA: the hop completes as the managed identity', async () => {
    acceptsEnv.requests.length = 0
    const run = await runChild(acceptsEnv, { NESSY_CONFIG_DIR: configDir('managed-only', { tlsCaPath: server.cert }), F1498_MANAGED_ENV: managedIdentity() })
    expect({ code: run.code, outcome: run.outcome }).toEqual({ code: 0, outcome: { status: 200 } })
    expect(acceptsEnv.requests).toEqual(['POST /v1/chat/completions'])
  }, 180_000)
})
