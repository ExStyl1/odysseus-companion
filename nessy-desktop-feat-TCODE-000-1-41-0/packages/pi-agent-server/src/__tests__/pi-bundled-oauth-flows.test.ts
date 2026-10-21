/**
 * F1.318 — the packaged Pi subprocess is ONE bundled file, and pi-ai loads its
 * OAuth flows through a variable-specifier dynamic import of a SIBLING module
 * (`@earendil-works/pi-ai/dist/auth/oauth/load.js`, `importOAuthModule`), so
 * that bundlers cannot follow it into Node-only flow code. In a bundle the
 * sibling does not exist, and every stored `oauth` credential fails there with
 * `OAuth auth derivation failed for <provider>: … Cannot find module
 * './<provider>.js'` — F1.242's rewrapped ChatGPT bearer (`openai-codex`) and
 * the host's GitHub Copilot credential alike. From source both work, which is
 * why no source-level suite could see it.
 *
 * Native-first: pi-ai publishes the fix for exactly this case,
 * `registerBunOAuthFlows()` (`@earendil-works/pi-ai/bun-oauth`, "Register
 * OAuth flows statically embedded in the standalone Bun binary"), and
 * pi-coding-agent's own standalone Bun entry calls it at startup
 * (`dist/bun/cli.js`, beside the same `setBedrockProviderModule` registration
 * our entry already makes). craft-agents-oss v0.13.4 does the same in its
 * `packages/pi-agent-server/src/index.ts` (Apache-2.0).
 *
 * Two halves, because a bundle of the whole server entry cannot be asked for
 * an auth resolution without a network provider behind it:
 *
 * - the WIRING pin: `index.ts` calls `registerBunOAuthFlows()` at module scope,
 *   before `main()` can run;
 * - the BUNDLE arm: two probe entries built in ONE `Bun.build` with
 *   `buildPiAgentServerBundle`'s own flags (`--target bun --format esm
 *   --external koffi`, `scripts/build/common.ts`), written OUTSIDE the checkout
 *   so no sibling of the bundle can satisfy the dynamic import, each resolving
 *   the three credentials through the PRODUCTION modules the server uses on
 *   this path (`adaptCredentialForPiSdk`, `createPiRuntimeAdapter().createRegistry`).
 *   The `bare` probe is the control that reproduces the defect; the
 *   `registered` probe differs from it only by the call `index.ts` makes.
 *
 * Pinned by the SDK's own behaviour, so it survives F1.255's lift to Pi 0.85.x:
 * if a future pi-ai stops needing the registration, the control arm's
 * `Cannot find module` expectation goes red and says so, rather than this
 * suite silently proving nothing.
 */
import { spawn } from 'node:child_process'
import { copyFileSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'

const here = dirname(fileURLToPath(import.meta.url))
const packageDir = realpathSync(join(here, '..', '..'))
const repoRoot = realpathSync(join(packageDir, '..', '..'))
const entrypointSource = readFileSync(join(packageDir, 'src', 'index.ts'), 'utf8')

// Every module the probes import is named by ABSOLUTE path and resolved from
// INSIDE the checkout: a bare specifier resolved from the temp dir would walk
// out of the repo (AGENTS.md, the rig-outside-the-repo trap).
const adaptCredentialModule = join(packageDir, 'src', 'adapt-credential.ts')
const runtimeAdapterModule = join(packageDir, 'src', 'compat', 'pi-runtime-adapter.ts')
const bunOAuthModule = realpathSync(Bun.resolveSync('@earendil-works/pi-ai/bun-oauth', packageDir))
const piCodingAgentPackageJson = join(
  dirname(dirname(realpathSync(Bun.resolveSync('@earendil-works/pi-coding-agent', packageDir)))),
  'package.json',
)

/**
 * The bundle cost is the module graph, not the probe: the WJ-ee verifier's
 * identical probe bundled 2 552 modules in 164.9 s real at 0.79 s user
 * (2026-09-23, I/O-bound on this rig), so the budget sits on the build hook,
 * sized against that reading with the lineage suite's 600 s headroom.
 */
const BUNDLE_BUDGET_MS = 600_000
const PROBE_RUN_BUDGET_MS = 60_000

type ArmResult =
  | { ok: true; stored: string | null; apiKey: string | null }
  | { ok: false; stored: string | null; err: string }
type ProbeResult = Record<'openai-codex' | 'github-copilot' | 'openai', ArmResult>

function probeSource(registered: boolean): string {
  const registration = registered
    ? `import { registerBunOAuthFlows } from ${JSON.stringify(bunOAuthModule)}\nregisterBunOAuthFlows()\n`
    : ''
  return `${registration}import { adaptCredentialForPiSdk } from ${JSON.stringify(adaptCredentialModule)}
import { createPiRuntimeAdapter } from ${JSON.stringify(runtimeAdapterModule)}
async function arm(provider, credential) {
  const { credentials, modelRuntime } = await createPiRuntimeAdapter().createRegistry()
  const adapted = adaptCredentialForPiSdk(provider, credential)
  if (adapted) await credentials.modify(provider, async () => adapted)
  try {
    const resolved = await modelRuntime.getAuth(provider)
    return { ok: true, stored: adapted?.type ?? null, apiKey: resolved?.auth?.apiKey ?? null }
  } catch (error) {
    return { ok: false, stored: adapted?.type ?? null, err: String(error?.message ?? error).slice(0, 400) }
  }
}
const out = {}
// F1.242's ChatGPT bearer: the host sends it as api_key, the adapter rewraps it as oauth.
out['openai-codex'] = await arm('openai-codex', { type: 'api_key', key: 'probe-bearer' })
// The host's Copilot credential: sent as oauth verbatim (pi-agent.ts getPiAuth).
out['github-copilot'] = await arm('github-copilot', { type: 'oauth', access: 'probe-access', refresh: 'probe-refresh', expires: Date.now() + 3_600_000 })
// CONTROL: an api_key for a provider with an apiKey handler never touches the OAuth loader.
out['openai'] = await arm('openai', { type: 'api_key', key: 'probe-api-key' })
console.log('PROBE-RESULT ' + JSON.stringify(out))
process.exit(0)
`
}

function isWithin(root: string, candidate: string): boolean {
  const delta = relative(root, candidate)
  return delta === '' || (!delta.startsWith(`..${sep}`) && delta !== '..' && !isAbsolute(delta))
}

async function runBundle(bundlePath: string, outDir: string): Promise<ProbeResult> {
  // `--no-install`: a bare import the bundle left external must fail, never be
  // auto-installed from outside the checkout.
  const child = spawn(process.execPath, ['--no-install', bundlePath], {
    cwd: outDir,
    env: { ...process.env, PI_PACKAGE_DIR: outDir, NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += String(chunk) })
  child.stderr.on('data', chunk => { stderr += String(chunk) })
  const code = await new Promise<number | null>((resolveExit, rejectExit) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      rejectExit(new Error(`probe ${bundlePath} did not exit in ${PROBE_RUN_BUDGET_MS} ms\n${stderr}`))
    }, PROBE_RUN_BUDGET_MS)
    child.on('error', rejectExit)
    child.on('exit', exitCode => { clearTimeout(timer); resolveExit(exitCode) })
  })
  const line = stdout.split('\n').find(candidate => candidate.startsWith('PROBE-RESULT '))
  if (code !== 0 || !line) throw new Error(`probe ${bundlePath} exited ${code}\n${stdout}\n${stderr}`)
  return JSON.parse(line.slice('PROBE-RESULT '.length)) as ProbeResult
}

describe('F1.318 — the server entry registers pi-ai\'s bundled OAuth flows', () => {
  it('index.ts imports registerBunOAuthFlows from pi-ai\'s bun-oauth entry', () => {
    expect(entrypointSource).toMatch(
      /^import \{ registerBunOAuthFlows \} from '@earendil-works\/pi-ai\/bun-oauth';$/m,
    )
  })

  it('and calls it at MODULE scope, before the import.meta.main guard can start main()', () => {
    const call = entrypointSource.search(/^registerBunOAuthFlows\(\);$/m)
    const guard = entrypointSource.indexOf('if (import.meta.main) {')
    expect(call).toBeGreaterThan(-1)
    expect(guard).toBeGreaterThan(-1)
    expect(call).toBeLessThan(guard)
  })
})

describe('F1.318 — BUNDLE arm, built with buildPiAgentServerBundle\'s flags', () => {
  let buildRoot: string | null = null
  let bare: ProbeResult
  let registered: ProbeResult

  beforeAll(async () => {
    buildRoot = realpathSync(mkdtempSync(join(tmpdir(), 'nessy-f1318-bundle-')))
    if (isWithin(repoRoot, buildRoot)) throw new Error(`bundle root must be outside the checkout: ${buildRoot}`)
    for (const path of [adaptCredentialModule, runtimeAdapterModule, bunOAuthModule]) {
      if (!isWithin(repoRoot, path)) throw new Error(`probe import resolves outside the checkout: ${path}`)
    }
    const barePath = join(buildRoot, 'bare.ts')
    const registeredPath = join(buildRoot, 'registered.ts')
    writeFileSync(barePath, probeSource(false))
    writeFileSync(registeredPath, probeSource(true))
    const outDir = join(buildRoot, 'out')
    const build = await Bun.build({
      entrypoints: [barePath, registeredPath],
      outdir: outDir,
      target: 'bun',
      format: 'esm',
      external: ['koffi'],
    })
    if (!build.success || build.outputs.length !== 2) {
      throw new Error(`probe bundle failed (${build.outputs.length} outputs)\n${build.logs.map(String).join('\n')}`)
    }
    // The packaged layout: the Pi package identity sits beside the bundle and
    // the host points PI_PACKAGE_DIR at it (pi-agent.ts, the spawn env).
    copyFileSync(piCodingAgentPackageJson, join(outDir, 'package.json'))
    const byName = (name: string) => {
      const output = build.outputs.find(candidate => candidate.path.endsWith(`${sep}${name}.js`))
      if (!output) throw new Error(`no ${name}.js among ${build.outputs.map(o => o.path).join(', ')}`)
      return output.path
    }
    bare = await runBundle(byName('bare'), outDir)
    registered = await runBundle(byName('registered'), outDir)
  }, BUNDLE_BUDGET_MS)

  afterAll(() => {
    if (buildRoot) rmSync(buildRoot, { recursive: true, force: true })
  })

  it('CONTROL — without the registration, both bundled oauth credentials fail on the missing sibling module', () => {
    for (const provider of ['openai-codex', 'github-copilot'] as const) {
      const result = bare[provider]
      expect(result.ok).toBe(false)
      expect(result.stored).toBe('oauth')
      if (!result.ok) {
        expect(result.err).toContain(`OAuth auth derivation failed for ${provider}`)
        expect(result.err).toContain('Cannot find module')
      }
    }
  })

  it('with the registration index.ts makes, openai-codex and github-copilot resolve inside the bundle', () => {
    expect(registered['openai-codex']).toEqual({ ok: true, stored: 'oauth', apiKey: 'probe-bearer' })
    expect(registered['github-copilot']).toEqual({ ok: true, stored: 'oauth', apiKey: 'probe-access' })
  })

  it('CONTROL — an api_key credential resolves on both probes (the loader is the only difference)', () => {
    expect(bare.openai).toEqual({ ok: true, stored: 'api_key', apiKey: 'probe-api-key' })
    expect(registered.openai).toEqual({ ok: true, stored: 'api_key', apiKey: 'probe-api-key' })
  })
})
