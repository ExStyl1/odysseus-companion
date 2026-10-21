/**
 * UA12.22 — the packaged binary ignores `NODE_OPTIONS` and the `--inspect` family: the Electron fuses
 * `EnableNodeOptionsEnvironmentVariable` and `EnableNodeCliInspectArguments` are flipped OFF in packaging, on all
 * three platforms, by electron-builder's own `electronFuses` step (it flips them right before signing; `build-dmg.sh`,
 * `build-win.ps1` and `build-linux.sh` all package from `electron-builder.yml`). `RunAsNode` stays ON: the plugin
 * runtime's last rung runs the app binary with `ELECTRON_RUN_AS_NODE=1` when the bundled Bun is missing
 * (`runtime-resolver.ts` `pluginNodeRuntimeBinding`).
 *
 * Positive: the two fuses are `false` and `runAsNode` is `true` in the one config every platform reads, and
 * `resetAdHocDarwinSignature` is `true`: the flipped wire invalidates Electron Framework's signature, so the same step
 * re-signs the `.app` ad-hoc right after the flip. That covers EVERY mac packaging path (build-dmg.sh with
 * auto-discovery on and no certificate, `CSC_IDENTITY_AUTO_DISCOVERY=false`, the root `electron:dist:mac` /
 * `electron:dist:dev:mac` scripts); a signed build re-signs over it with its identity.
 * Negative: no per-path ad-hoc identity (`mac.identity: "-"`) in build-dmg.sh's generated config any more — the reset
 * is the single mechanism; `signIgnore` still keeps the codex binaries; no platform block overrides the fuses.
 *
 * Measured 2026-10-09 (LF-7-fix) on a scratch copy of an unsigned arm64 `Nessy Desktop.app` with @electron/fuses
 * 1.8.0: flipped WITHOUT the reset, a standalone copy of `Electron Framework` fails `codesign --verify` ("invalid
 * signature (code or signature have been modified)"); flipped WITH it, the framework and `codesign --verify --deep
 * --strict` of the `.app` pass, and both codex binaries under `Contents/Resources` keep their SHA-256 and OpenAI's
 * signature (TeamIdentifier 2DC432GLL2) — `codesign --deep` seals them as resources, it does not re-sign them.
 *
 * The fuse wire of a BUILT binary is the controller's RC4 reading (this lane never builds the DMG).
 */
import { describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { load } from 'js-yaml'

const electronRoot = join(import.meta.dir, '..', '..', '..')
const builderYml = readFileSync(join(electronRoot, 'electron-builder.yml'), 'utf-8')
const builder = load(builderYml) as Record<string, unknown> & {
  electronFuses?: Record<string, unknown>
  mac?: Record<string, unknown>
  win?: Record<string, unknown>
  linux?: Record<string, unknown>
}
const buildDmg = readFileSync(join(electronRoot, 'scripts', 'build-dmg.sh'), 'utf-8')
const hasRuby = spawnSync('ruby', ['-v'], { stdio: 'ignore' }).status === 0

/** build-dmg.sh's own config generator, run as written (the `ruby -ryaml -e '…'` program of step 8). */
function generateMacConfig(): Record<string, unknown> & { mac?: Record<string, unknown>; electronFuses?: Record<string, unknown> } {
  const program = /ruby -ryaml -e '([^']+)'/.exec(buildDmg)?.[1]
  if (!program) throw new Error('build-dmg.sh no longer carries its ruby config generator')
  const dir = mkdtempSync(join(tmpdir(), 'ua12-22-'))
  try {
    const out = join(dir, 'generated.yml')
    // The trailing '1' is the argument eff187f5b's narrow ad-hoc switch read; the generator must ignore it now.
    const run = spawnSync('ruby', ['-ryaml', '-e', program, join(electronRoot, 'electron-builder.yml'), out, 'arm64', '1', '1'], { encoding: 'utf-8' })
    if (run.status !== 0) throw new Error(`ruby failed: ${run.stderr}`)
    return load(readFileSync(out, 'utf-8')) as ReturnType<typeof generateMacConfig>
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const rootPackage = JSON.parse(readFileSync(join(electronRoot, '..', '..', 'package.json'), 'utf-8')) as { scripts: Record<string, string> }

describe('UA12.22 · Electron fuses in packaging', () => {
  it('positive: NODE_OPTIONS and --inspect fuses are OFF, RunAsNode stays ON, in the config all three platforms package from', () => {
    expect(builder.electronFuses).toBeDefined()
    expect(builder.electronFuses?.enableNodeOptionsEnvironmentVariable).toBe(false)
    expect(builder.electronFuses?.enableNodeCliInspectArguments).toBe(false)
    expect(builder.electronFuses?.runAsNode).toBe(true)
    // Each platform script packages from this file (the mac one through its generated copy of it).
    expect(buildDmg).toContain('"$ELECTRON_DIR/electron-builder.yml" "$BUILDER_CONFIG"')
    expect(readFileSync(join(electronRoot, 'scripts', 'build-linux.sh'), 'utf-8')).toContain('npx electron-builder --linux --${ARCH}')
    expect(readFileSync(join(electronRoot, 'scripts', 'build-win.ps1'), 'utf-8')).toContain('npx electron-builder --win --x64')
  })

  it('positive: the flip re-signs the .app ad-hoc in the same step, for every mac packaging path', () => {
    expect(builder.electronFuses?.resetAdHocDarwinSignature).toBe(true)
    // The root mac scripts bypass build-dmg.sh (one of them with auto-discovery off) — they read this same file.
    for (const name of ['electron:dist:mac', 'electron:dist:dev:mac']) {
      expect(rootPackage.scripts[name]).toContain('electron-builder --config electron-builder.yml --mac')
    }
  })

  it('negative: no per-path ad-hoc identity; signIgnore keeps codex; no platform override', () => {
    expect(buildDmg).not.toContain('MAC_ADHOC_IDENTITY')
    expect((builder.mac?.signIgnore as string[] | undefined) ?? []).toContain('resources/bin/codex/')
    for (const platform of [builder.mac, builder.win, builder.linux]) {
      expect(platform && 'electronFuses' in platform).toBe(false)
    }
    // The signed path is untouched: the checked-in config names no identity.
    expect(builder.mac?.identity).toBeUndefined()
  })

  it.if(hasRuby)('build-dmg.sh generated config carries the shared fuses and reset, and no identity', () => {
    const generated = generateMacConfig()
    expect(generated.mac?.identity).toBeUndefined()
    expect(generated.electronFuses).toEqual(builder.electronFuses)
  })
})
