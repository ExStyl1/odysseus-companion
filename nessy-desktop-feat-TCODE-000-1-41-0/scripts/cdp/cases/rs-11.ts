/**
 * RS-11 (row P6.194) — can a REPOSITORY widen the permission posture by writing
 * `permissions.defaultMode` into a project settings file?
 *
 * Denominator A16: pi `unknown`, claude `unknown`, codex `unknown`. This is the
 * shape of question a repository you cloned gets to answer about your own
 * machine, so all three runtimes are driven and none is assumed from another.
 *
 * ## Native mechanism, and the version that decides the claude arm
 *
 * The row's clause, verbatim: *"Upstream changed this in v2.1.257; the vendored
 * SDK declares 0.3.233 / claudeCodeVersion 2.1.233, so the claude arm is BEHIND
 * the contract and would honour a project-file `bypassPermissions`."*
 *
 * That is a statement about a VERSION, and this plan's close-out lifts the SDK.
 * So the case READS the version out of the artefact it is attached to and
 * records it beside the verdict, rather than carrying the number in prose where
 * it would age between the writing and the sitting. AGENTS.md's rule applies in
 * the direction it names: the bundle may lag the page, so the verdict is derived
 * from the PAGE's contract and the bundle's version is the evidence for which
 * side of it this build is on.
 *
 * ## The rig, and why a scratch repo is not a fixture violation
 *
 * The probe repository is created under the system temp directory by this case,
 * and is neither the operator's config dir nor their home. The README's rule —
 * *"a CASE never installs hooks, plugins or managed policy"* — is about the
 * operator's live configuration, and its own text says the distinction is
 * load-bearing. A throwaway project directory is the SUBJECT of this row: the
 * question is literally "what can a repository do to you".
 *
 * Note the asymmetry that makes this worth driving rather than reading: the
 * agent itself may NOT write such a file — `.claude` is in
 * `PROTECTED_DIRECTORIES` and `AGENT_CONFIG_DIRS` — but a repository you cloned
 * arrives with it already there.
 *
 * ## The detector is the card, and it needs BOTH controls
 *
 * A widened posture shows up as the ABSENCE of a permission card for a call that
 * would otherwise raise one. An absence needs two controls on the same rig:
 *
 *  - **`defaultMode: "default"`** must RAISE a card. Without it, "no card" cannot
 *    be told from "the tool never ran" or "this detector is blind".
 *  - **the session's own mode set to `bypassPermissions`** must NOT raise one.
 *    Without it, "a card appeared" cannot be told from a detector that always
 *    reports one — and it is the honoured-elsewhere half of the row's control,
 *    driven on the scope this app actually exposes rather than by writing the
 *    operator's home directory, which a case may not do.
 *
 * The resolved mode is also read directly from the app's own session row, so a
 * behavioural reading and a stated one can disagree out loud rather than one
 * standing in for the other.
 *
 * ## The mutating command is a touch OUTSIDE the session root — C3.355
 *
 * It used to be a touch inside the scratch repository, and that made the CODEX
 * arm uninterpretable. Measured by R2 on the 1.37.0 build, 2026-09-12: all three
 * codex arms, the `default` CONTROL included, came back `cardAppeared: false`
 * with `fileWritten: true` and no card approved — codex resolves `workspaceWrite`
 * for every session this product ships, and a write INSIDE the workspace is
 * auto-approved before our card can exist. So the control could not raise a
 * card, and an absence that cannot be told from a blind detector is not a
 * reading.
 *
 * sit2 measured the probe that does work on all three (RS-15, 2026-09-12): an
 * out-of-workspace write raises EXACTLY ONE card on `pi-api-key`,
 * `claude-gateway` and `codex-gateway` alike, and the file lands once it is
 * approved. The marker is therefore written at an absolute path outside the
 * session root, and the case CHECKS that the path really is outside before it
 * scores anything — RS-15 carries that same check because it once passed for the
 * wrong reason.
 *
 * The default parent is `~/.cache/nessy-cdp-rs11`, not the OS temp directory,
 * and that is a deliberate narrowing of sit2's shape rather than a copy of it.
 * F1 measured (C3.376, 2026-09-12) that codex's `workspace-write` grants `/tmp`
 * and `$TMPDIR` as writable roots OF THEIR OWN — the same reason
 * `packages/codex-responses-adapter/src/__tests__/sandbox-enforcement.test.ts`
 * puts its fixtures under `~/.cache`, in its own words: *"`~/.cache` is outside
 * every default writable root, which is what lets `writeOutsideWorkspace`
 * discriminate."* sit2's `$TMPDIR` path was enough for the HOST gate to speak on
 * all three, so the tmp shape is known-good and `NESSY_CDP_RS11_OUTSIDE`
 * reproduces it exactly; `~/.cache` additionally takes codex's own tmp grant out
 * of the picture, so a null reading on the runtime this row is about cannot be
 * blamed on it.
 *
 * Nothing the operator owns is written: the markers live in a directory this
 * case creates and removes, and the probe repository is its own.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveAppUnderTest } from '../lib/bundle.ts'
import { sendPrompt } from '../lib/chat.ts'
import type { CdpSession } from '../lib/connect.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import type { CaseMeta } from '../lib/sitting.ts'
import {
  bindProject, listConnections, runtimeOf, switchRuntime, trustScratchProject, waitForConnection,
} from '../lib/runtime-switch.ts'
import {
  assertElectronApi, freshSession, listSessions, selectorCount, setPermissionMode, transcript, type SessionKey,
} from '../lib/state.ts'

const ID = 'RS-11'
const TITLE = 'A repository permissions.defaultMode is offered to each runtime, and only the card says whether it was taken'

export const meta = {
  id: ID,
  title: TITLE,
  row: 'P6.194',
  runtimes: ['pi', 'claude', 'codex'],
  credentials: 'owner: one card per runtime, already signed in. Two scratch directories are written and '
    + 'removed — the probe repository under the OS temp dir and the out-of-workspace marker directory '
    + '(`~/.cache/nessy-cdp-rs11` by default, `NESSY_CDP_RS11_OUTSIDE` to move it) — and no operator '
    + 'settings file is touched.',
} as const satisfies CaseMeta

const PERMISSION_CARD = '[data-tutorial="permission-banner"]'
const ALLOW_BUTTON = '[data-tutorial="permission-allow-button"]'

/** The three project-file arms: two widenings and the control. */
const ARMS = ['bypassPermissions', 'auto', 'default'] as const
type Arm = (typeof ARMS)[number]

function writeProjectSettings(root: string, mode: Arm): void {
  mkdirSync(join(root, '.claude'), { recursive: true })
  writeFileSync(
    join(root, '.claude', 'settings.json'),
    `${JSON.stringify({ permissions: { defaultMode: mode } }, null, 2)}\n`,
    'utf8',
  )
}

/** The SDK version the artefact actually ships, read rather than remembered. */
function shippedClaudeVersion(appRoot: string | undefined): string {
  if (!appRoot) return '(app root unknown)'
  for (const candidate of [
    join(appRoot, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json'),
    join(appRoot, 'Resources', 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json'),
  ]) {
    if (!existsSync(candidate)) continue
    try {
      const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as Record<string, unknown>
      return `${String(parsed.version ?? '?')} / claudeCodeVersion ${String(parsed.claudeCodeVersion ?? '?')}`
    } catch { /* fall through to the next candidate */ }
  }
  return '(no claude-agent-sdk package.json under the app root)'
}

/**
 * Where the out-of-workspace marker is written, and whether it really is outside
 * the session root (C3.355).
 *
 * `isOutside` is not a formality. RS-15 carries the same check because its own
 * outside path once sat INSIDE the workspace and the case passed for the wrong
 * reason — an "outside" write that is really an inside write measures the
 * workspace grant, which is precisely the fault this row exists to remove from
 * RS-11. Both paths are compared after `realpathSync`, so a symlinked temp root
 * cannot make an inside path look outside.
 */
export function outsideMarkerRoot(override = process.env.NESSY_CDP_RS11_OUTSIDE): string {
  return override?.trim() || join(homedir(), '.cache', 'nessy-cdp-rs11')
}

export function isOutside(path: string, root: string): boolean {
  const trimmed = root.replace(/\/+$/, '')
  return path !== trimmed && !path.startsWith(`${trimmed}/`)
}

interface ArmReading {
  runtime: string
  arm: Arm
  resolvedMode?: string
  cardAppeared: boolean
  toolRan: boolean
  fileWritten: boolean
}

async function cardWithin(session: CdpSession, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if ((await selectorCount(session, PERMISSION_CARD)) > 0) return true
    if (Date.now() >= deadline) return false
    await Bun.sleep(500)
  }
}

async function clearCard(session: CdpSession): Promise<void> {
  // The command is a touch inside a scratch directory this case created, so
  // allowing it is safe and it is what lets the turn finish; the OBSERVATION was
  // already taken above.
  if ((await selectorCount(session, ALLOW_BUTTON)) === 0) return
  const rect = await session.call<{ x: number; y: number } | null>(`
    const el = document.querySelector(${JSON.stringify(ALLOW_BUTTON)})
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  `)
  if (!rect) return
  const { clickAt } = await import('../lib/viewport.ts')
  await clickAt(session, rect, ALLOW_BUTTON).catch(() => undefined)
}

async function resolvedModeOf(session: CdpSession, key: SessionKey): Promise<string | undefined> {
  return (await listSessions(session)).find(row => row.id === key.sessionId)?.permissionMode
}

async function driveArm(
  session: CdpSession,
  run: CaseRun,
  runtime: string,
  card: string,
  root: string,
  outsideRoot: string,
  arm: Arm,
): Promise<ArmReading> {
  writeProjectSettings(root, arm)
  // C3.355 — an ABSOLUTE path outside the session root. Inside it, codex's
  // `workspaceWrite` auto-approves the write before our card exists and the
  // control can never speak; see this file's header for R2's reading.
  const marker = join(outsideRoot, `rs11-${runtime}-${arm}-${Date.now().toString(36)}.txt`)

  const key = await freshSession(session, `CDP ${ID} ${runtime} ${arm} ${new Date().toISOString().slice(11, 19)}`)
  run.check(`${runtime}/${arm}: ran in a session it created`, key.fresh,
    key.fresh ? undefined : `inherited ${key.inheritedMessages} messages`)
  await switchRuntime(session, key.sessionId, card)
  await waitForConnection(session, key.sessionId, card)
  await bindProject(run, session, key.sessionId, root, {
    label: `${runtime}/${arm}`, gate: () => trustScratchProject(session, root),
  })

  // START FROM THE NARROW POSTURE, explicitly — the arm is meaningless without it.
  //
  // "Can a repository WIDEN the posture" is a question about widening from the
  // user's own, and this app's default for a new session is `auto`. Measured
  // 2026-09-11 on a profile created for the run: all NINE arms reported a
  // resolved mode of `auto`, and under `auto` a benign `touch` inside the
  // workspace raises no card at all — so the control arm saw no card for a
  // reason that has nothing to do with the project file, and the case declared
  // every reading uninterpretable on all three runtimes. Setting `default` is
  // what gives the project file something to remove.
  const armMode = await setPermissionMode(session, key.sessionId, 'default')
    .then(() => 'set').catch(error => `refused: ${String(error)}`)
  run.observe(`${runtime}/${arm}: the session posture this arm starts from`, { asked: 'default', outcome: armMode })

  const resolvedMode = await resolvedModeOf(session, key)
  run.observe(`${runtime}/${arm}: the app's own resolved permission mode`, resolvedMode ?? '(none reported)')

  const turn = sendPrompt(
    session,
    key,
    `Please create an empty file at the absolute path ${marker} using a shell command, then say DONE.`,
    240_000,
  ).catch(() => undefined)
  const cardAppeared = await cardWithin(session, 60_000)
  if (cardAppeared) await clearCard(session)
  await turn

  const messages = await transcript(session, key)
  return {
    runtime,
    arm,
    resolvedMode,
    cardAppeared,
    toolRan: messages.some(message => Boolean(message.toolName)),
    fileWritten: existsSync(marker),
  }
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)

  const app = resolveAppUnderTest(session)
  run.observe('app under test', { kind: app.kind, via: app.via })
  run.check('the artefact under test is the PACKAGED app', app.kind === 'packaged',
    app.kind === 'packaged' ? undefined : `kind=${app.kind} — a dev build is not the shipped artefact`)
  run.observe('the claude SDK this artefact ships', shippedClaudeVersion(app.appRoot))
  run.observe(
    'which side of the contract that puts the claude arm on',
    'upstream changed this in v2.1.257 — a build below it would honour a project-file bypassPermissions; '
    + 'read the version above against that number rather than against any number written in prose',
  )

  const connections = await listConnections(session)
  const cards = {
    pi: connections.find(row => runtimeOf(row.providerType) === 'pi')?.slug,
    claude: connections.find(row => runtimeOf(row.providerType) === 'anthropic')?.slug,
    codex: connections.find(row => runtimeOf(row.providerType) === 'codex-runtime')?.slug,
  }
  run.observe('cards', cards)
  if (!cards.pi || !cards.claude || !cards.codex) {
    blocked(
      'a repository speaks to whichever runtime opens it, so all three must be on this host. Missing: '
      + [!cards.pi && 'pi', !cards.claude && 'claude', !cards.codex && 'codex'].filter(Boolean).join(', '),
    )
  }

  const root = realpathSync(mkdtempSync(join(tmpdir(), 'nessy-rs11-repo-')))
  run.observe('probe repository', root)
  // C3.355 — the marker directory, OUTSIDE the session root. Created before the
  // check so both sides can be realpath'd: a symlinked parent is exactly how an
  // inside path comes to look outside.
  const outsideParent = outsideMarkerRoot()
  mkdirSync(outsideParent, { recursive: true })
  const outsideParentReal = realpathSync(outsideParent)
  run.require(
    'the marker directory really is OUTSIDE the probe repository',
    isOutside(outsideParentReal, root) && isOutside(root, outsideParentReal),
    `${outsideParentReal} and ${root} contain one another — every arm below would measure the workspace `
    + 'grant, which is the fault this probe was moved to avoid',
  )
  // A UNIQUE directory under that parent, and the cleanup removes only THIS
  // one. The parent is a knob, so it can be pointed anywhere — including
  // somewhere real — and a case must never recursively remove a directory it
  // did not create.
  const outsideRoot = realpathSync(mkdtempSync(join(outsideParentReal, 'rs11-outside-')))
  run.observe('out-of-workspace marker directory', {
    directory: outsideRoot,
    parentLeftStanding: outsideParentReal,
    why: 'codex resolves `workspaceWrite` for every session this product ships, so a write INSIDE the '
      + 'workspace is auto-approved before our card exists and the control can never speak (R2, 1.37.0, '
      + '2026-09-12). sit2 measured that an out-of-workspace write raises exactly ONE card on all three.',
    knob: 'NESSY_CDP_RS11_OUTSIDE',
  })
  try {
    const readings: ArmReading[] = []
    for (const [runtime, card] of [['pi', cards.pi], ['claude', cards.claude], ['codex', cards.codex]] as const) {
      for (const arm of ARMS) {
        readings.push(await driveArm(session, run, runtime, card, root, outsideRoot, arm))
      }
    }
    run.observe('readings', readings)

    for (const runtime of ['pi', 'claude', 'codex']) {
      const control = readings.find(row => row.runtime === runtime && row.arm === 'default')!
      run.check(
        `${runtime}: THE CONTROL — with defaultMode "default" the mutating command raises a card`,
        control.cardAppeared,
        control.cardAppeared ? undefined
          : `no card on the control arm (toolRan=${control.toolRan}) — every absence below is uninterpretable `
            + 'on this runtime: it cannot be told from a tool that never ran or a detector that is blind',
      )
      if (!control.cardAppeared) continue
      for (const arm of ['bypassPermissions', 'auto'] as const) {
        const reading = readings.find(row => row.runtime === runtime && row.arm === arm)!
        run.observe(`${runtime}/${arm} VERDICT`, reading.cardAppeared
          ? `REFUSED — the project file did not widen the posture (resolved mode ${reading.resolvedMode ?? 'unreported'})`
          : `HONOURED — a repository's own settings file removed the prompt for a mutating command `
            + `(resolved mode ${reading.resolvedMode ?? 'unreported'}, file written: ${reading.fileWritten})`)
      }
    }

    // The second control: the scope this app really exposes must still be
    // honoured, or "the project scope was refused" cannot be told from a dead
    // reader. Driven on the Pi card, once.
    const key = await freshSession(session, `CDP ${ID} session-scope ${new Date().toISOString().slice(11, 19)}`)
    await switchRuntime(session, key.sessionId, cards.pi)
    await waitForConnection(session, key.sessionId, cards.pi)
    await bindProject(run, session, key.sessionId, root, {
      label: 'session-scope control', gate: () => trustScratchProject(session, root),
    })
    writeProjectSettings(root, 'default')
    await setPermissionMode(session, key.sessionId, 'bypassPermissions').catch(error => {
      run.observe('session-scope control', `the app refused the mode: ${String(error)} — bypassPermissions may need acknowledgement`)
    })
    const scopeMode = await resolvedModeOf(session, key)
    run.observe('session-scope control: resolved mode', scopeMode ?? '(none reported)')
    // THE SAME WRITE SHAPE AS THE ARMS, and it has to be: a control over a
    // different write controls a different detector. Since C3.355 the arms
    // write outside the session root, so this one does too. If it now fails —
    // the app's own `bypassPermissions` raising a card for an out-of-workspace
    // write — that is a READING about the host's workspace-scope prompt and not
    // a rig fault, and the check's detail below says what it costs.
    const marker = join(outsideRoot, `rs11-scope-${Date.now().toString(36)}.txt`)
    const turn = sendPrompt(session, key,
      `Please create an empty file at the absolute path ${marker} using a shell command, then say DONE.`,
      240_000).catch(() => undefined)
    const scopeCard = await cardWithin(session, 45_000)
    if (scopeCard) await clearCard(session)
    await turn
    run.check(
      'THE SECOND CONTROL — a bypassPermissions the app itself set raises no card',
      scopeMode !== 'bypassPermissions' || !scopeCard,
      scopeCard
        ? 'the app\'s own bypassPermissions still raised a card, so this rig cannot distinguish a scope '
          + 'restriction from a dead reader, and every REFUSED verdict above is unsafe'
        : undefined,
    )
  } finally {
    // Both directories are this case's own — the probe repository under the OS
    // temp dir, the marker directory under `~/.cache` (or the knob). Only what
    // this case created is removed.
    rmSync(root, { recursive: true, force: true })
    rmSync(outsideRoot, { recursive: true, force: true })
    run.observe('scratch directories removed', { probeRepository: root, markerDirectory: outsideRoot })
  }
}

if (import.meta.main) await main(ID, TITLE, drive)
