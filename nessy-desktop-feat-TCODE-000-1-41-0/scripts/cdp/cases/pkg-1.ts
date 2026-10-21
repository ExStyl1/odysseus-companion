/**
 * PKG-1 — the packaged artefact ships the SDK the lockfile pins, and its Pi
 * subprocess still boots now that `main()` sits behind an entrypoint guard.
 *
 * Two rows meet here because they can only be answered on the same object: the
 * `.app` a user installs. A dev tree proves neither.
 *
 * ## P3.313 — the SDK the model actually runs under
 *
 * `apps/electron/node_modules/@anthropic-ai/` is created by the three platform
 * build scripts and is declared in NO package.json, so `bun install` never
 * refreshes it. Measured on this tree: it held `0.3.223` /
 * `claudeCodeVersion 2.1.223` while `bun.lock` pinned `0.3.233` / `2.1.233` —
 * a different tool surface and settings schema for the model in the artefact
 * than in every measurement taken against the repo. `electron-builder.yml` now
 * copies the CORE from the repository root, and the `afterPack` hook asserts
 * the shipped version before signing.
 *
 * **This case is the independent read of the same fact**, because the hook and
 * the build script are the things under test: it opens the packaged app's own
 * `package.json` files and compares them to the lockfile-governed install, with
 * no reference to what the build printed.
 *
 * ## P3.291 — the `import.meta.main` guard
 *
 * `pi-agent-server/src/index.ts` called `main()` at module scope, so no test
 * could import it and a mutant that deleted the subprocess option wiring
 * survived. The guard is the fix, and AGENTS.md records the shape of getting it
 * wrong in the other direction: a module whose body starts a server (or exits)
 * kills whatever imports it. So the guard has to be proven on BOTH sides, and
 * the side that cannot be proven in a unit test is this one — the packaged
 * subprocess is spawned by the host as `<bun> [--require interceptor] index.js`,
 * and `import.meta.main` is exactly the thing that could read false there.
 *
 * The check is therefore an EFFECT, not a symbol: a Pi turn that answers. The
 * symbol count is recorded beside it as the freshness reading the README asks
 * for (a bundle without the guard would answer the turn too — it is the count
 * that says which bundle answered).
 *
 * ## Why the artefact reads come from the app root the CDP target names
 *
 * `resolveAppUnderTest` derives the app root from the renderer's own `file://`
 * URL, so the paths read here belong to the app that is actually running. A
 * case that read `release/mac-arm64/...` by construction would keep passing
 * while the operator drove a differently-built app — the exact class of error
 * the packaged-vs-dev rule exists to prevent.
 */

import { lastAssistantText, sendPrompt } from '../lib/chat.ts'
import { bundleFiles, countInFile, resolveAppUnderTest } from '../lib/bundle.ts'
import type { CdpSession } from '../lib/connect.ts'
import { ensureDarkTheme } from '../lib/mcp-fixture.ts'
import { blocked, exitCodeFor, runCase, type CaseRun } from '../lib/report.ts'
import { listConnections, runtimeOf, switchRuntime, waitForConnection } from '../lib/runtime-switch.ts'
import { readPiSessionLog } from '../lib/runtime-session-log.ts'
import { assertElectronApi, freshSession, piReadNote, piRuntime } from '../lib/state.ts'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ID = 'PKG-1'
const TITLE = 'The packaged app ships the lockfile-pinned Claude SDK and boots its Pi subprocess behind the entrypoint guard'

const TURN_TIMEOUT_MS = 300_000

/** The scope directory extraResources writes into, relative to the app root. */
const SDK_SCOPE = ['node_modules', '@anthropic-ai']

function readPackageJson(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  } catch {
    return undefined
  }
}

/**
 * The pin, read the way the build reads it: the installed package at the
 * repository root, which is the only copy `bun.lock` governs.
 */
function lockfileGovernedSdk(repo: string): { version?: string; claudeCodeVersion?: string } {
  const pkg = readPackageJson(join(repo, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json'))
  return {
    version: pkg?.version as string | undefined,
    claudeCodeVersion: pkg?.claudeCodeVersion as string | undefined,
  }
}

async function body(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)
  run.observe('theme', await ensureDarkTheme(session))

  const app = resolveAppUnderTest(session)
  run.observe('app-under-test', { kind: app.kind, appRoot: app.appRoot, via: app.via })
  if (app.kind !== 'packaged' || !app.appRoot) {
    blocked(
      'this case measures the SHIPPED artefact and the CDP target is not one. Build it '
      + '(`NESSY_DESKTOP_UPDATE_URL=https://updates.invalid/dev CSC_IDENTITY_AUTO_DISCOVERY=false '
      + 'bash apps/electron/scripts/build-dmg.sh arm64`) and launch it with '
      + '`"release/mac-arm64/Nessy Desktop.app/Contents/MacOS/Nessy Desktop" --remote-debugging-port=$NESSY_CDP_PORT`. '
      + `The target url was ${app.targetUrl}`,
    )
  }

  // ---- P3.313: what the artefact carries -------------------------------
  const repo = join(import.meta.dir, '..', '..', '..')
  const pinned = lockfileGovernedSdk(repo)
  run.observe('lockfile-governed root install', pinned)
  run.require(
    'the repository root has the SDK installed',
    Boolean(pinned.version && pinned.claudeCodeVersion),
    'without it there is nothing to compare the artefact against',
  )

  const scope = join(app.appRoot, ...SDK_SCOPE)
  const shippedCore = readPackageJson(join(scope, 'claude-agent-sdk', 'package.json'))
  run.require('the packaged app carries @anthropic-ai/claude-agent-sdk', Boolean(shippedCore), scope)
  run.observe('shipped claude-agent-sdk', {
    version: shippedCore?.version,
    claudeCodeVersion: shippedCore?.claudeCodeVersion,
  })
  run.check(
    'the shipped SDK version equals the lockfile pin',
    shippedCore?.version === pinned.version,
    `shipped ${String(shippedCore?.version)} vs pinned ${String(pinned.version)}`,
  )
  run.check(
    'the shipped claudeCodeVersion equals the lockfile pin',
    shippedCore?.claudeCodeVersion === pinned.claudeCodeVersion,
    `shipped ${String(shippedCore?.claudeCodeVersion)} vs pinned ${String(pinned.claudeCodeVersion)}`,
  )

  // The native binary is the process the model actually runs in, and it is
  // staged from a DIFFERENT source (per-arch, by the platform build script), so
  // it can drift on its own.
  const shippedAlias = readPackageJson(join(scope, 'claude-agent-sdk-binary', 'package.json'))
  run.observe('shipped native binary package', {
    name: shippedAlias?.name,
    version: shippedAlias?.version,
    present: existsSync(join(scope, 'claude-agent-sdk-binary', 'claude')),
  })
  run.check(
    'the shipped native binary comes from the same SDK version',
    shippedAlias?.version === pinned.version,
    `shipped ${String(shippedAlias?.version)} vs pinned ${String(pinned.version)}`,
  )

  // ---- P3.291: the guard is in the shipped Pi bundle --------------------
  const bundles = bundleFiles(app)
  run.observe('pi bundle', {
    path: bundles.pi.path,
    exists: bundles.pi.exists,
    bytes: bundles.pi.bytes,
    modified: bundles.pi.modifiedMs ? new Date(bundles.pi.modifiedMs).toISOString() : undefined,
  })
  const guards = countInFile(bundles.pi.path, 'import.meta.main')
  run.observe('import.meta.main occurrences in the shipped Pi bundle', guards)
  run.check(
    'the shipped Pi bundle carries the entrypoint guard',
    guards === 1,
    `counted ${guards} (-1 means the bundle is absent, 0 means it predates the guard)`,
  )

  // ---- P3.291: and the guarded subprocess still boots -------------------
  const connections = await listConnections(session)
  const pi = connections.find(row => runtimeOf(row.providerType) === 'pi')
  if (!pi) {
    blocked(
      'no Pi connection in this config dir, so the guard cannot be proven by effect. '
      + `The app lists: ${connections.map(c => `${c.slug}(${c.providerType})`).join(', ') || 'nothing'}`,
    )
  }

  const key = await freshSession(session, `${ID} pi-boot`)
  run.require('a fresh session was created', key.fresh, key.reason ?? '')
  const outcome = await switchRuntime(session, key.sessionId, pi.slug)
  run.require('the session moved onto the Pi connection', outcome.ok, outcome.error ?? '')
  await waitForConnection(session, key.sessionId, pi.slug).catch(() => undefined)

  // A codeword the model can only produce by having run: the prompt asks for a
  // transformation, not an echo, so a canned or empty reply cannot pass.
  const nonce = Math.random().toString(16).slice(2, 10)
  const turn = await sendPrompt(
    session,
    key,
    `Reply with exactly this and nothing else: PKG1-${nonce}-OK`,
    TURN_TIMEOUT_MS,
  )
  const reply = lastAssistantText(turn.added)
  run.observe('pi reply excerpt', reply.slice(0, 200))
  run.check(
    'the guarded Pi subprocess answered a real turn',
    reply.includes(`PKG1-${nonce}-OK`),
    `expected PKG1-${nonce}-OK in the reply`,
  )

  // The harness snapshot is recorded but NOT asserted on, and the first run of
  // this case is why. After a settled turn it reads
  // `available: false, reason: 'pi-runtime-not-started'` — the subprocess is
  // torn down with the turn — so a check on it reports "Pi never ran" about a
  // Pi that just answered. That is the detector fault AGENTS.md warns about,
  // caught by having an independent positive result beside it.
  const runtime = await piRuntime(session, key)
  // D1.310 — `readFailed` beside `available`: the two are different facts, and
  // only the note tells the reader which one this reading is.
  run.observe('pi harness runtime (post-turn, not asserted)', {
    ...piReadNote(runtime),
    provider: runtime.provider,
  })

  // The durable half: a file the Pi runtime itself wrote. `getSessionMessages`
  // is the host's record and would be satisfied by a host that fabricated the
  // turn; the session log is the subprocess's own.
  const log = readPiSessionLog(key)
  const nonceInLog = log.entries.filter(entry => entry.text.includes(`PKG1-${nonce}`)).length
  run.observe('pi session log', { file: log.file, entries: log.entries.length, reason: log.reason, nonceEntries: nonceInLog })
  run.check(
    'the Pi runtime wrote this turn into its own session file',
    nonceInLog > 0,
    log.file ? `${log.entries.length} entries, ${nonceInLog} carrying the nonce` : (log.reason ?? 'no session file'),
  )
}

/**
 * 30 s — the harness default — is not enough for `switchRuntime` on a COLD
 * packaged app: measured here, the first cross-runtime bind after launch took
 * longer than that and the run died with `cdp-timeout` while the app was
 * working normally. The per-command budget is raised for this case rather than
 * for the harness, because a longer default would hide a genuinely hung call
 * everywhere else.
 */
const CDP_COMMAND_TIMEOUT_MS = 240_000

if (import.meta.main) {
  const result = await runCase(ID, TITLE, body, { timeoutMs: CDP_COMMAND_TIMEOUT_MS })
  process.exit(exitCodeFor(result.status))
}

export { ID, TITLE, body }
