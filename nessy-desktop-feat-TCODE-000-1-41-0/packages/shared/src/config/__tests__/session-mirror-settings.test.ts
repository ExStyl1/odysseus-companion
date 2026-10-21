/**
 * `sessionMirror` settings — strict parser beside sandbox/worktree/workflow,
 * plus the R4 startup-brick regression class (`8188c067`): a key the
 * StoredConfig TYPE declares but the strict top-level envelope
 * (`StoredConfigTopLevelSchema`) never learned bricks app startup with
 * UnsupportedStorageLayoutError the moment a real config.json sets it. Only a
 * disk round-trip through the production loader proves the envelope accepts it.
 */
import { describe, expect, it, setDefaultTimeout } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { pathToFileURL } from 'url'

import { parseSessionMirrorSettingsV1 } from '../session-mirror-settings.ts'

/**
 * D1.110 — a FILE budget, sized against the MEASURED floor rather than bun's
 * 5 s default, because two of this file's five cases spawn a real `bun --eval`
 * child that imports `storage.ts` and that spawn is their whole cost.
 *
 * MEASURED 2026-09-17, this file ALONE under the test lock, twice, and the two
 * readings are 19x apart on the same bytes at the same load — which is the
 * argument for the budget rather than a detail of it:
 *
 *   * **815 ms** at load 10.70, `user 1.02 / sys 0.26` against `real 0.82` —
 *     over 100 % cpu, so a WARM reading and NOT a floor;
 *   * **15.19 s** at load 9.33, `user 1.22 / sys 0.35` against `real 15.20` —
 *     8 % cpu, the I/O regime, on a file whose warm total is under a second.
 *
 * The ZERO-CASE CONTROL (`-t` matching nothing) prices the static graph at
 * **0.29 s with 0 cases executed**, which says the same thing from the other
 * side: nothing here is expensive except the two children.
 *
 * The floor is the SPAWN's, and it is already measured on this box: one such
 * child cost **34.87 s wall for 0.53 s of user CPU** under five concurrent lanes
 * (`load-stored-config-fail-closed.test.ts`'s `SPAWN_BUDGET_MS`). 60 s is that
 * number with head, and it is the same head `user-settings-strict-report.test.ts`
 * and `cron-scheduler.test.ts` carry for the same spawn on the same box — the
 * point of not inventing a fourth number. Re-measure before lowering it; a warm
 * reading is not a floor.
 */
setDefaultTimeout(60_000)

describe('parseSessionMirrorSettingsV1', () => {
  it('parses the directory adapter with an absolute path', () => {
    expect(parseSessionMirrorSettingsV1({ adapter: 'directory', path: '/tmp/mirror-root' }))
      .toEqual({ adapter: 'directory', path: '/tmp/mirror-root' })
  })

  it('fails closed on unknown adapter names with a clear diagnostic', () => {
    expect(() => parseSessionMirrorSettingsV1({ adapter: 'webdav', path: '/tmp/x' }))
      .toThrow(/unknown session mirror adapter: webdav/)
  })

  it('rejects unknown keys, missing/relative paths, and non-object layers', () => {
    expect(() => parseSessionMirrorSettingsV1({ adapter: 'directory', path: '/tmp/x', extra: 1 }))
      .toThrow(/invalid session mirror setting: extra/)
    expect(() => parseSessionMirrorSettingsV1({ adapter: 'directory' })).toThrow()
    expect(() => parseSessionMirrorSettingsV1({ adapter: 'directory', path: 'relative/path' }))
      .toThrow(/absolute/)
    expect(() => parseSessionMirrorSettingsV1(null)).toThrow()
    expect(() => parseSessionMirrorSettingsV1([])).toThrow()
  })
})

describe('sessionMirror key survives the strict stored-config envelope', () => {
  it('loads a config.json that sets sessionMirror through loadStoredConfig in a subprocess', () => {
    const configDir = mkdtempSync(join(tmpdir(), 'nessy-session-mirror-envelope-'))
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({
      storageLayoutVersion: 2,
      workspaceRefs: [{ id: 'ws-1', lastAccessedAt: Date.now() }],
      activeWorkspaceId: 'ws-1',
      activeSessionId: null,
      sessionMirror: { adapter: 'directory', path: '/tmp/mirror-root' },
    }), 'utf-8')
    const storageModule = pathToFileURL(join(import.meta.dir, '..', 'storage.ts')).href
    const run = Bun.spawnSync([
      process.execPath,
      '--eval',
      `import * as S from '${storageModule}'; S.loadStoredConfig(); console.log(JSON.stringify(S.getUserSessionMirrorSettings()))`,
    ], { env: { ...process.env, NESSY_CONFIG_DIR: configDir }, stdout: 'pipe', stderr: 'pipe' })
    expect(run.exitCode, run.stderr.toString()).toBe(0)
    expect(JSON.parse(run.stdout.toString().trim())).toEqual({ adapter: 'directory', path: '/tmp/mirror-root' })
  })

  it('an unknown adapter on disk yields no mirror (null) without breaking config load', () => {
    const configDir = mkdtempSync(join(tmpdir(), 'nessy-session-mirror-badadapter-'))
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({
      storageLayoutVersion: 2,
      workspaceRefs: [],
      activeWorkspaceId: null,
      activeSessionId: null,
      sessionMirror: { adapter: 'webdav', path: '/tmp/mirror-root' },
    }), 'utf-8')
    const storageModule = pathToFileURL(join(import.meta.dir, '..', 'storage.ts')).href
    const run = Bun.spawnSync([
      process.execPath,
      '--eval',
      `import * as S from '${storageModule}'; S.loadStoredConfig(); console.log(JSON.stringify(S.getUserSessionMirrorSettings()))`,
    ], { env: { ...process.env, NESSY_CONFIG_DIR: configDir }, stdout: 'pipe', stderr: 'pipe' })
    expect(run.exitCode, run.stderr.toString()).toBe(0)
    expect(JSON.parse(run.stdout.toString().trim())).toBeNull()
  })
})
