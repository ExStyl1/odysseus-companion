/**
 * F1.517 — on the HEADLESS server, an operator's `NESSY_CUSTOM_HEADERS` ride a
 * codex or claude-runtime session's upstream hop ONLY to the verified gateway,
 * the way they do on the desktop. Pi keeps its adapter-list path.
 *
 * Why the two hosts differed. A codex or claude-runtime turn reaches its model
 * through the per-session loopback adapter, which runs INSIDE the host and makes
 * the upstream request itself through `gatewaySessionFetch` — whose own rule
 * (`gatewayRequestHeaders`) adds operator headers on the verified gateway prefix
 * and nowhere else. On the desktop that is the whole story: the Electron main
 * preloads no interceptor. The headless server DOES preload it
 * (`bin/nessy-server`, `scripts/build/interceptor-pairing.ts` symbol
 * `interceptorPreloadFragment`), so the same request then met the interceptor's
 * `prepareOutboundHeaders`, whose operator layer applies to any URL the adapter
 * list recognises — a BYO `/chat/completions` included. So the headless server
 * sent the operator's headers (where an operator puts a token) to an endpoint
 * nothing verified, while the per-session notice (`customHeadersOffGatewayNotice`)
 * told the same operator "none of them is sent". Measured by WJ-ai on 2026-09-24
 * (F1.498's rig, proposed as P-WJai-1): codex BYO `operatorHdr=True` on the
 * headless shape, `False` on the desktop shape.
 *
 * DECIDED from P6.180 (`2026-08-22-runtime-parity-closure.md`): the narrowing is
 * the safety posture — relaxing it was recorded as an owner question, never a
 * lane's — so the headless hop is narrowed, not the desktop widened.
 *
 * The rig: a child launched the way `bin/nessy-server` launches the server
 * (`bun run --preload <interceptor> <entry>` from a directory with no
 * `bunfig.toml`), the trust chain applied, then the hop through the adapter's
 * own `fetchImpl`. Every hop goes through a TLS-terminating tunnel to ONE local
 * HTTPS upstream whose throwaway certificate names both hosts, so the upstream
 * sees each request's headers — the gateway host included, which the child can
 * only reach through the tunnel (an explicit per-request route, see the child).
 *
 * Failing arm, taken 2026-09-24 at HEAD `20ed0a0b2` (the working tree carrying
 * only these two new files): the headless arm FAILED on both BYO hops (the
 * operator header arrived on `/chat/completions` and on `/v1/messages`); the
 * gateway control and the Pi control passed. After the fix both pass, and a
 * mutant that drops the Pi arm of `operatorHeadersMayRide` fails the Pi control
 * alone — so each arm here can fail on its own.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { customHeadersOffGatewayNotice } from '../telemetry/gateway-headers.ts'

const CHILD = join(import.meta.dir, 'fixtures', 'headless-operator-headers-child.ts')
const INTERCEPTOR = join(import.meta.dir, '..', 'unified-network-interceptor.ts')

const GATEWAY_HOST = 'code-completion-nestor.tcsbank.ru'
const BYO_HOST = 'f1517-byo.invalid'
/** The verified gateway prefix (AGENTS.md gateway facts). */
const GATEWAY_CHAT = `https://${GATEWAY_HOST}/api/v1/cli/openai-like/v1/chat/completions`
/** Codex's hop, and claude's translated one: an OpenAI-wire BYO upstream. */
const BYO_CHAT = `https://${BYO_HOST}/v1/chat/completions`
/** Claude's `anthropic-messages` passthrough, on a BYO base the adapter list recognises. */
const BYO_MESSAGES = `https://${BYO_HOST}/v1/messages`

const OPERATOR_HEADERS = 'X-F1517-Tenant: acme-operator'
const OPERATOR_HEADER = 'x-f1517-tenant'

type Seen = { host: string; path: string; operator: string | null }

let root = ''
let certPath = ''
let upstream: https.Server | undefined
let tunnel: http.Server | undefined
let tunnelPort = 0
const seen: Seen[] = []
const connects: string[] = []

/** `openssl` makes the throwaway certificate; without it the rig cannot see inside TLS. */
const OPENSSL = (() => {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore', timeout: 10_000 })
    return true
  } catch {
    return false
  }
})()

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'nessy-f1517-'))
  if (!OPENSSL) return
  certPath = join(root, 'upstream-cert.pem')
  const keyPath = join(root, 'upstream-key.pem')
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
    '-keyout', keyPath, '-out', certPath,
    '-subj', `/CN=${BYO_HOST}`,
    '-addext', `subjectAltName=DNS:${BYO_HOST},DNS:${GATEWAY_HOST}`,
    '-addext', 'basicConstraints=critical,CA:TRUE',
  ], { stdio: 'ignore', timeout: 30_000 })

  upstream = https.createServer({ key: readFileSync(keyPath), cert: readFileSync(certPath) }, (req, res) => {
    const operator = req.headers[OPERATOR_HEADER]
    seen.push({
      host: String(req.headers.host ?? ''),
      path: req.url ?? '',
      operator: typeof operator === 'string' ? operator : null,
    })
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
    })
  })
  await new Promise<void>((resolve) => upstream!.listen(0, '127.0.0.1', () => resolve()))
  const upstreamPort = (upstream.address() as AddressInfo).port

  // A TLS-inspecting proxy in miniature: every CONNECT, whatever host it names,
  // is tunnelled to the one local upstream — so nothing reaches a real host.
  tunnel = http.createServer((_req, res) => {
    res.writeHead(502)
    res.end()
  })
  tunnel.on('connect', (req, socket) => {
    connects.push(req.url ?? '')
    const toUpstream = net.connect(upstreamPort, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      toUpstream.pipe(socket)
      socket.pipe(toUpstream)
    })
    toUpstream.on('error', () => socket.destroy())
    socket.on('error', () => toUpstream.destroy())
  })
  await new Promise<void>((resolve) => tunnel!.listen(0, '127.0.0.1', () => resolve()))
  tunnelPort = (tunnel.address() as AddressInfo).port
})

afterAll(() => {
  tunnel?.close()
  upstream?.close()
  if (root) rmSync(root, { recursive: true, force: true })
})

function reset(): void {
  seen.length = 0
  connects.length = 0
}

/** Async spawn: a synchronous one would deadlock against the in-process servers. */
function runChild(env: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const configDir = join(root, `config-${Math.random().toString(36).slice(2)}`)
  mkdirSync(configDir, { recursive: true })
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['run', '--preload', INTERCEPTOR, CHILD], {
      // No bunfig.toml here, like an assembled distribution; NESSY_CONFIG_DIR is
      // in the LAUNCH environment, the one form that isolates on every invocation.
      cwd: root,
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: root,
        NESSY_CONFIG_DIR: configDir,
        // Bun reads it at launch; the upstream's certificate is its own root.
        NODE_EXTRA_CA_CERTS: certPath,
        NESSY_CUSTOM_HEADERS: OPERATOR_HEADERS,
        // Makes the Anthropic adapter recognise the BYO base, as a claude
        // passthrough to an Anthropic-wire endpoint would be recognised.
        ANTHROPIC_BASE_URL: `https://${BYO_HOST}`,
        F1517_PROXY: `http://127.0.0.1:${tunnelPort}`,
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
      resolve({ code, stdout, stderr })
    })
  })
}

function expectChildOk(run: { code: number | null; stderr: string }): void {
  expect({ code: run.code, stderr: run.code === 0 ? '' : run.stderr.slice(-2000) }).toEqual({ code: 0, stderr: '' })
}

function operatorHeaderAt(host: string, path: string): string | null | undefined {
  return seen.find(entry => entry.host === host && entry.path === path)?.operator
}

describe('F1.517 — operator custom headers on the headless host hop', () => {
  it.if(OPENSSL)('headless: a BYO hop carries NO operator header, the gateway hop does, and the notice says exactly that', async () => {
    reset()
    const run = await runChild({ F1517_HOPS: JSON.stringify([BYO_CHAT, BYO_MESSAGES, GATEWAY_CHAT]) })
    expectChildOk(run)
    // Every hop reached the rig's upstream through the tunnel — nothing else.
    // (Two hops to one host share a kept-alive tunnel, so CONNECTs are a set.)
    expect(JSON.parse(run.stdout.trim())).toEqual([
      { url: BYO_CHAT, status: 200 },
      { url: BYO_MESSAGES, status: 200 },
      { url: GATEWAY_CHAT, status: 200 },
    ])
    expect(new Set(connects)).toEqual(new Set([`${BYO_HOST}:443`, `${GATEWAY_HOST}:443`]))

    // The positive control first: the header DOES ride where it should.
    expect(operatorHeaderAt(GATEWAY_HOST, '/api/v1/cli/openai-like/v1/chat/completions')).toBe('acme-operator')
    // The row: a BYO endpoint gets none of it, on either wire (one assertion, so
    // a red names both).
    expect({
      chat: operatorHeaderAt(BYO_HOST, '/v1/chat/completions'),
      messages: operatorHeaderAt(BYO_HOST, '/v1/messages'),
    }).toEqual({ chat: null, messages: null })

    // And the per-session notice agrees with what the wire just showed, on both
    // hosts (the desktop sends through the same `gatewaySessionFetch` with no
    // interceptor behind it — `gateway-session-correlation-wiring.test.ts`).
    const env = { NESSY_CUSTOM_HEADERS: OPERATOR_HEADERS }
    expect(customHeadersOffGatewayNotice('Codex', { kind: 'openai-compatible', baseUrl: `https://${BYO_HOST}/v1` }, env))
      .toContain('none of them is sent')
    expect(customHeadersOffGatewayNotice('Codex', { kind: 'nestor' }, env)).toBeUndefined()
  }, 180_000)

  it.if(OPENSSL)('control: the Pi subprocess keeps its adapter-list path — a BYO provider URL still carries the header', async () => {
    reset()
    const run = await runChild({
      // What pi-agent-server's `setInterceptorApiHints` writes once it has a model.
      NESSY_PI_MODEL_API: 'openai-completions',
      // Pi's SDK calls the global fetch; it has no `gatewaySessionFetch`.
      F1517_VIA: 'global',
      F1517_HOPS: JSON.stringify([BYO_CHAT, GATEWAY_CHAT]),
    })
    expectChildOk(run)
    expect(JSON.parse(run.stdout.trim())).toEqual([
      { url: BYO_CHAT, status: 200 },
      { url: GATEWAY_CHAT, status: 200 },
    ])
    expect(operatorHeaderAt(BYO_HOST, '/v1/chat/completions')).toBe('acme-operator')
    expect(operatorHeaderAt(GATEWAY_HOST, '/api/v1/cli/openai-like/v1/chat/completions')).toBe('acme-operator')
  }, 180_000)
})
