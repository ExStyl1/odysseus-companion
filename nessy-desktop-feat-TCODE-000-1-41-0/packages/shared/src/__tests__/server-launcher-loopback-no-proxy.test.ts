/**
 * F1.518 — a headless server launched with `HTTP(S)_PROXY` sends its OWN
 * loopback requests direct, never to that proxy.
 *
 * The server is Bun, and Bun 1.3.14's `fetch` has no loopback exemption, reads
 * `HTTP(S)_PROXY` / `NO_PROXY` only at LAUNCH, and has no per-request way to go
 * direct (`proxy: ""` still proxies) — measured 2026-09-24 in the untracked
 * `work/wjao/probe/` rig, following WJ-ai's P-WJai-2. The interceptor
 * `bin/nessy-server` preloads made it worse: its inline NO_PROXY twin had no
 * loopback clause, so with only `HTTPS_PROXY` set it put that proxy on an
 * `http://127.0.0.1` request Bun itself would have sent direct. The
 * per-request resolver (`config/network-runtime.ts`, `shouldBypassProxy`) has
 * exempted loopback since P2.263; neither of the other two readers did.
 *
 * Two fixes, each pinned here:
 * - `bin/nessy-server` runs `launcherLoopbackNoProxyFragment()`
 *   (`scripts/build/interceptor-pairing.ts`) before `exec bun` — Bun's own
 *   mechanism, set where Bun reads it. The rig composes a launcher from that
 *   fragment plus the preload `exec`; the source-text arm pins that
 *   `createEntryScripts` interpolates the same function ahead of its `exec`.
 * - The interceptor's inline twin exempts loopback before any NO_PROXY rule.
 *
 * Failing arm, taken 2026-09-24 at HEAD `877d5da01` with the fragment
 * returning '' (which is what the launcher carried there) and the interceptor
 * untouched: the two launcher-with-proxy arms FAILED (the loopback hop's body
 * came back from the recording proxy, and the child saw no `NO_PROXY`), and the
 * no-launcher `HTTPS_PROXY` arm FAILED (the interceptor proxied every loopback
 * spelling). The no-proxy control passed.
 *
 * Residue, stated: a server started WITHOUT the launcher (in-repo `bun run`) and
 * with `HTTP_PROXY` still proxies loopback, because only the launch environment
 * reaches Bun's own reader. Pi and every other child get their own loopback
 * `NO_PROXY` (`config/proxy-env.ts` `applyLoopbackProxyExemption`) regardless.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LOOPBACK_NO_PROXY_HOSTS } from '../config/network-proxy-utils.ts'
import {
  LAUNCHER_LOOPBACK_NO_PROXY,
  launcherLoopbackNoProxyFragment,
} from '../../../../scripts/build/interceptor-pairing.ts'

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..')
const CHILD = join(import.meta.dir, 'fixtures', 'server-launcher-loopback-child.ts')
const INTERCEPTOR = join(import.meta.dir, '..', 'unified-network-interceptor.ts')

const EXTERNAL = 'http://f1518-external.invalid/f1518'
const OPERATOR = 'http://f1518-operator.invalid/f1518'
const OPERATOR_LOWER = 'http://f1518-lower.invalid/f1518'

type Server = { server: http.Server; port: number; seen: string[] }

async function startServer(body: string): Promise<Server> {
  const seen: string[] = []
  const server = http.createServer((req, res) => {
    seen.push(req.url ?? '')
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end(body)
    })
  })
  // A CONNECT is recorded too, and refused: the verdict is THAT it arrived.
  server.on('connect', (req, socket) => {
    seen.push(`CONNECT ${req.url ?? ''}`)
    socket.end('HTTP/1.1 403 F1.518 recorder\r\n\r\n')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  return { server, port: (server.address() as AddressInfo).port, seen }
}

let root = ''
let launcherPath = ''
let proxy: Server
let local: Server

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'nessy-f1518-'))
  proxy = await startServer('from-proxy')
  local = await startServer('from-loopback')
  // `bin/nessy-server`'s two halves that matter here, from the same functions
  // the build uses: the loopback NO_PROXY lines, then the preload `exec`.
  launcherPath = join(root, 'nessy-server')
  writeFileSync(launcherPath, [
    '#!/bin/sh',
    'set -e',
    launcherLoopbackNoProxyFragment(),
    `exec "${process.execPath}" run --preload "${INTERCEPTOR}" "${CHILD}"`,
    '',
  ].join('\n'))
})

afterAll(() => {
  proxy?.server.close()
  local?.server.close()
  if (root) rmSync(root, { recursive: true, force: true })
})

function reset(): void {
  proxy.seen.length = 0
  local.seen.length = 0
}

const proxyUrl = () => `http://127.0.0.1:${proxy.port}`
const loopbackHop = () => `http://127.0.0.1:${local.port}/v1/chat/completions`

type ChildReport = {
  outcomes: Array<{ url: string; status?: number; body?: string; error?: string }>
  noProxy: { NO_PROXY: string | null; no_proxy: string | null }
  interceptorLoopback: Record<string, string | null>
  interceptorExternal: string | null
}

/** Async spawn: a synchronous one would deadlock against the in-process servers. */
function runChild(mode: 'launcher' | 'bare', env: Record<string, string>): Promise<{ code: number | null; report: ChildReport | null; stderr: string }> {
  const configDir = join(root, `config-${Math.random().toString(36).slice(2)}`)
  mkdirSync(configDir, { recursive: true })
  const [command, args] = mode === 'launcher'
    ? ['/bin/sh', [launcherPath]]
    : [process.execPath, ['run', '--preload', INTERCEPTOR, CHILD]]
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      // No bunfig.toml here, like an assembled distribution; NESSY_CONFIG_DIR is
      // in the LAUNCH environment, the one form that isolates on every invocation.
      cwd: root,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: root, NESSY_CONFIG_DIR: configDir, ...env },
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
      let report: ChildReport | null = null
      try { report = JSON.parse(stdout.trim().split('\n').at(-1) ?? '') as ChildReport } catch { /* reported below */ }
      resolve({ code, report, stderr: stderr.slice(-2000) })
    })
  })
}

function expectRan(run: { code: number | null; report: ChildReport | null; stderr: string }): ChildReport {
  expect({ code: run.code, parsed: run.report !== null, stderr: run.code === 0 ? '' : run.stderr })
    .toEqual({ code: 0, parsed: true, stderr: '' })
  return run.report!
}

const ALL_LOOPBACK_DIRECT = Object.fromEntries(LOOPBACK_NO_PROXY_HOSTS.map(host => [host, null]))

describe('F1.518 — the headless server\'s own loopback requests never reach a launch-environment proxy', () => {
  it('the launcher\'s host list IS the host\'s loopback list', () => {
    expect(LAUNCHER_LOOPBACK_NO_PROXY).toBe(LOOPBACK_NO_PROXY_HOSTS.join(','))
  })

  it('bin/nessy-server runs the fragment before it execs bun', () => {
    const source = readFileSync(join(REPO_ROOT, 'scripts', 'build-server.ts'), 'utf-8')
    const template = source.indexOf('const nessyServer = `')
    const fragment = source.indexOf('${launcherLoopbackNoProxyFragment()}', template)
    const exec = source.indexOf('exec "$ROOT/vendor/bun/bun" run ${interceptorPreloadFragment()}', template)
    expect(template).toBeGreaterThan(-1)
    expect(fragment).toBeGreaterThan(template)
    expect(exec).toBeGreaterThan(fragment)
  })

  it('launched with HTTP(S)_PROXY: the loopback hop goes direct, an external host still goes through the proxy', async () => {
    reset()
    const report = expectRan(await runChild('launcher', {
      HTTP_PROXY: proxyUrl(),
      HTTPS_PROXY: proxyUrl(),
      F1518_TARGETS: JSON.stringify([loopbackHop(), EXTERNAL]),
    }))
    expect(report.outcomes).toEqual([
      { url: loopbackHop(), status: 200, body: 'from-loopback' },
      { url: EXTERNAL, status: 200, body: 'from-proxy' },
    ])
    expect(local.seen).toEqual(['/v1/chat/completions'])
    expect(proxy.seen).toEqual([EXTERNAL])
    expect(report.noProxy).toEqual({ NO_PROXY: LAUNCHER_LOOPBACK_NO_PROXY, no_proxy: LAUNCHER_LOOPBACK_NO_PROXY })
    expect(report.interceptorLoopback).toEqual(ALL_LOOPBACK_DIRECT)
    expect(report.interceptorExternal).toBe(proxyUrl())
  }, 180_000)

  it('an operator\'s NO_PROXY entries are kept — both spellings, unioned — and still bypass the proxy', async () => {
    reset()
    const report = expectRan(await runChild('launcher', {
      HTTP_PROXY: proxyUrl(),
      no_proxy: 'f1518-lower.invalid',
      NO_PROXY: 'f1518-operator.invalid',
      F1518_TARGETS: JSON.stringify([loopbackHop(), OPERATOR, OPERATOR_LOWER]),
    }))
    const expected = `f1518-lower.invalid,f1518-operator.invalid,${LAUNCHER_LOOPBACK_NO_PROXY}`
    expect(report.noProxy).toEqual({ NO_PROXY: expected, no_proxy: expected })
    expect(report.outcomes[0]).toEqual({ url: loopbackHop(), status: 200, body: 'from-loopback' })
    // Direct, so a `.invalid` name fails to resolve — and the proxy saw nothing.
    expect(report.outcomes.slice(1).map(outcome => ({ url: outcome.url, direct: outcome.error !== undefined })))
      .toEqual([{ url: OPERATOR, direct: true }, { url: OPERATOR_LOWER, direct: true }])
    expect(proxy.seen).toEqual([])
  }, 180_000)

  it('control: launched with no proxy, the launcher writes no NO_PROXY at all', async () => {
    reset()
    const report = expectRan(await runChild('launcher', { F1518_TARGETS: JSON.stringify([loopbackHop()]) }))
    expect(report.noProxy).toEqual({ NO_PROXY: null, no_proxy: null })
    expect(report.outcomes).toEqual([{ url: loopbackHop(), status: 200, body: 'from-loopback' }])
    expect(proxy.seen).toEqual([])
  }, 180_000)

  it('without the launcher, the interceptor itself no longer proxies loopback (HTTPS_PROXY only, which Bun alone sends direct)', async () => {
    reset()
    const report = expectRan(await runChild('bare', {
      HTTPS_PROXY: proxyUrl(),
      F1518_TARGETS: JSON.stringify([loopbackHop()]),
    }))
    expect(report.noProxy).toEqual({ NO_PROXY: null, no_proxy: null })
    expect(report.interceptorLoopback).toEqual(ALL_LOOPBACK_DIRECT)
    // The boundary: a non-loopback host still gets the proxy from the same reader.
    expect(report.interceptorExternal).toBe(proxyUrl())
    expect(report.outcomes).toEqual([{ url: loopbackHop(), status: 200, body: 'from-loopback' }])
    expect(proxy.seen).toEqual([])
  }, 180_000)
})
