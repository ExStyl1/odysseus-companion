/**
 * RS-108 - the Always-Allow FLOOR on the shipped build: what one click on
 * "Always Allow" grants, and everything it must NOT grant (D1.401, D1.402,
 * D1.403, D1.404, D1.413).
 *
 * ## Why this case exists at all
 *
 * SIT-9 drove every reading below on 2026-09-20 and drove it from a scratch rig
 * that lives only in that lane's scratchpad (its P-SIT9-5). It is the release's
 * newest safety surface - four rows in one hotfix - and with no case file the
 * next sitting re-derives it, which is how a floor stops being measured.
 *
 * ## The arms, and what each one is the ABSENCE of
 *
 * A1. **The durable key is NARROW.** Approving `npm test` must write
 *     `Bash(npm test *)` into `<root>/.claude/settings.local.json` and never
 *     `Bash(npm *)`. D1.404 is named for the second: keyed on the bare base
 *     command, one approval of `npm test` granted `npm publish` for ever in that
 *     repository.
 * A2. **THE POSITIVE CONTROL, and it is not optional.** A NEW session in the
 *     same repository runs the granted command with NO card. Without it, every
 *     "a card appeared" arm below is equally true of a build whose persist is
 *     simply broken - a floor that grants nothing passes B, C, D, E and F for
 *     the wrong reason.
 * B.  **A COMPOUND CHAIN still asks** (D1.401). `npm test && git push origin
 *     main` carries a second command the grant never covered; the hole this row
 *     closed was the chain inheriting the head's grant.
 * C.  **A DIFFERENT SUBCOMMAND still asks.** `npm publish --dry-run` under a
 *     `Bash(npm test *)` grant is the direct consequence of A1 being narrow, and
 *     it is the reading that makes A1 mean something on the model's side rather
 *     than only in the file.
 * D.  **An INTERPRETER HEAD offers no durable grant at all** (D1.402/D1.403).
 *     `bash -c "echo hi"` is dangerous-session-only: the card offers "Allow for
 *     this session" and no "Always Allow", and `settings.local.json` is
 *     unchanged. A durable rule on `bash` would grant every command there is.
 * E.  **An ABSOLUTE path is normalised to its head, both spellings the same.**
 *     `/bin/rm -rf ./build` and `rm -rf ./build` must read identically - the
 *     control is the pair, because either one alone cannot show normalisation.
 * F.  **`fish -c` reads like `bash -c`** (D1.413). A shell this host may not
 *     even have installed is still an interpreter head to the classifier, and
 *     the reading is about the CARD, not about the command running.
 *
 * ## The rig facts this case encodes, each paid for by a drive
 *
 * - **`attempted` beside `asked`** (SIT-9 rig finding 5). `asked: false` alone
 *   conflates *the floor let it through* with *the model never issued the
 *   command*, and three of SIT-9's arms were the second. Every arm here reports
 *   both, and a verdict that names `unavailable` rather than banking a zero.
 * - **The command is asked for VERBATIM** (SIT-9 rig finding 4). Without that
 *   wording the model runs `cd "<dir>" && npm test`, the durable key then
 *   carries the whole chain, and arm A1 answers a different question than the
 *   one asked - which is also arm B's question, so the two would collide.
 * - **A card has TWO button shapes** (SIT-9 rig finding 1). A dangerous head
 *   offers "Allow for this session" where an ordinary one offers "Always
 *   Allow"; a press that names only one leaves the card standing and the NEXT
 *   arm reads it as its own. Arms D, E and F are exactly the shape that bit
 *   that lane, so every arm asserts the card is GONE before the next one starts.
 * - **The bound root is POLLED, never assumed** (SIT-9 rig finding 2, now
 *   `bindWorkingDirectory`). Every settings read here is taken under the root
 *   the session REPORTS; a session still bound to a previous repository makes
 *   every "unchanged" reading pass vacuously.
 * - **The mode is `default`, set explicitly and READ BACK.** The shipped default
 *   is `auto`, which asks for nothing on an ordinary in-workspace command
 *   (measured 2026-09-12, R6a, on `rs-36`'s first run, where the granting turn
 *   raised no card and the whole arm was void). This case is therefore NOT one
 *   of the `bypassPermissions` opt-outs in `lib/permission-mode.ts`: an opt-out
 *   applies nothing and would leave the session in `auto` - the one mode in
 *   which this floor cannot be seen at all. `freshSession` applies the harness
 *   default at creation, this case's own `setPermissionMode` wins, and the
 *   read-back is a `run.require`, because the setter returning is not the
 *   posture applying (R1's RS-13 correction).
 *
 * `readCard`, `pressCard`, `ensureNoCard` and `shellArm` were the THIRD copy of
 * those helpers in this directory when this case landed (`rs-103.ts` and
 * `rs-104.ts` carried the other two); F1.183 lifted all three copies into
 * `lib/permission-card.ts`, one definition each.
 */

import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ensureNoCard, shellArm, type ShellArm } from '../lib/permission-card.ts'
import { focusWindow, type CdpSession } from '../lib/connect.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import { bindWorkingDirectory, listConnections, runtimeOf, switchRuntime, trustScratchProject, waitForConnection } from '../lib/runtime-switch.ts'
import { assertElectronApi, freshSession, listSessions, setPermissionMode, type SessionKey } from '../lib/state.ts'
import { ensureDarkTheme } from '../lib/mcp-fixture.ts'
import { appEnvBlockReason, readAppEnvContamination } from '../lib/app-env.ts'
import type { CaseMeta } from '../lib/sitting.ts'

const ID = 'RS-108'
const TITLE = 'the Always-Allow floor: one click writes a NARROW durable rule, and the interpreter heads write nothing'

export const meta = {
  id: ID,
  title: TITLE,
  row: 'D1.404',
  runtimes: ['pi', 'claude'],
  credentials:
    'owner: ONE card that answers a turn and can run a Bash command - `pi` is the primary arm because D1.413\'s fish '
    + 'spelling is pi\'s, and a `claude-runtime` card is driven beside it when the host has one. No key, token or '
    + 'credential file is read; the scratch repository is created under the OS temp dir and removed in a `finally`, '
    + 'and every command the model is asked to run is a read-only probe inside that repository.',
} as const satisfies CaseMeta

/** The rule file the card's own footnote promises: *saves this command for the repository*. */
const LOCAL_SETTINGS = join('.claude', 'settings.local.json')

/** The labels a DURABLE grant is offered under, and the session-only one beside it. */
const ANSWER_DURABLE = ['always allow', 'allow for this session']
/** The dangerous-head card offers only this one - naming both is the point. */
const SESSION_ONLY = 'allow for this session'

/**
 * A floor arm's verdict in ONE word, so a zero is never banked as a finding.
 *
 * `unavailable` is the state SIT-9 had to add by hand: the model never issued
 * the command, so nothing was asked of the floor at all.
 */
function floorVerdict(arm: ShellArm, expectCard: boolean): 'ok' | 'unavailable' | 'floor-let-it-through' | 'asked-unexpectedly' {
  if (!arm.attempted && !arm.asked) return 'unavailable'
  if (expectCard) return arm.asked ? 'ok' : 'floor-let-it-through'
  return arm.asked ? 'asked-unexpectedly' : 'ok'
}

function readRules(root: string): string[] {
  try {
    const raw = readFileSync(join(root, LOCAL_SETTINGS), 'utf8')
    return ((JSON.parse(raw) as { permissions?: { allow?: string[] } }).permissions?.allow ?? []).map(String)
  } catch {
    return []
  }
}

/** A git repository with a `test` script, so `npm test` is a real command here. */
function seedRepository(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'nessy-rs108-')))
  writeFileSync(join(root, 'README.md'), '# rs-108\n', 'utf8')
  writeFileSync(
    join(root, 'package.json'),
    `${JSON.stringify({ name: 'rs108-probe', version: '1.0.0', private: true, scripts: { test: 'echo "rs-108 tests passed"' } }, null, 2)}\n`,
    'utf8',
  )
  const identity = ['-c', 'user.email=rs108@example.invalid', '-c', 'user.name=RS-108']
  for (const args of [['init', '--initial-branch=main'], [...identity, 'add', '-A'], [...identity, 'commit', '-m', 'seed']]) {
    Bun.spawnSync(['git', ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
  }
  return root
}

/**
 * A session on `slug`, bound to `root`, in the mode this case MEASURES.
 *
 * The mode is `default` and it is read back, for the reason in the header: the
 * shipped default is `auto` and asks for nothing, so an arm run in it is void.
 */
async function boundSession(
  run: CaseRun,
  session: CdpSession,
  label: string,
  slug: string,
  root: string,
): Promise<SessionKey> {
  const key = await freshSession(session, `CDP ${ID} ${label} ${new Date().toISOString().slice(11, 19)}`)
  if (!key.fresh) blocked(`a fresh session could not be created: ${key.reason ?? 'unknown'}`)
  await switchRuntime(session, key.sessionId, slug)
  run.require(`${label}: the session runs on ${slug}`,
    (await waitForConnection(session, key.sessionId, slug)) === slug, slug)
  // Started, not awaited: the trust gate is answered beside it, and the verdict
  // is the session's own `workingDirectory` polled (F1.121).
  const binding = bindWorkingDirectory(session, key.sessionId, root)
  run.observe(`${label}: trust gate`, await trustScratchProject(session, root).catch(error => String(error)))
  const bound = await binding
  run.require(`${label}: the session is bound to the scratch repository`, bound.bound, bound.reason ?? '')
  await setPermissionMode(session, key.sessionId, 'default')
  const resolved = (await listSessions(session)).find(row => row.id === key.sessionId)?.permissionMode
  run.require(`${label}: the session really is in \`default\`, so the floor can ask`,
    resolved === 'default',
    `resolved ${String(resolved)} - the shipped default is \`auto\`, which asks for nothing on an ordinary command`)
  await focusWindow(session)
  return key
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)
  const contamination = await readAppEnvContamination()
  const contaminated = appEnvBlockReason(contamination, 'the permission floor this case measures')
  if (contaminated) blocked(contaminated)
  run.observe('the app environment', { present: Object.keys(contamination.present), controlSeen: contamination.controlSeen })
  await ensureDarkTheme(session)
  run.observe('window', await focusWindow(session))

  const connections = await listConnections(session)
  const pi = connections.find(row => runtimeOf(row.providerType) === 'pi')
  const claude = connections.find(row => runtimeOf(row.providerType) === 'anthropic')
  const primary = pi ?? claude
  if (!primary) {
    blocked(
      'this case needs ONE card that can run a Bash command; the host lists '
      + `${connections.map(row => `${row.slug}(${row.providerType})`).join(', ') || 'nothing'}`,
    )
  }
  const runtime = runtimeOf(primary.providerType) === 'pi' ? 'pi' : 'claude'
  run.observe('the card under test', { slug: primary.slug, runtime, alsoPresent: { pi: pi?.slug ?? null, claude: claude?.slug ?? null } })

  const repository = seedRepository()
  try {
    const key = await boundSession(run, session, 'floor', primary.slug, repository)

    // ================= A1 - the durable key is NARROW =======================
    const rulesBefore = readRules(repository)
    const a1 = await shellArm(session, key, 'A1 npm test', 'npm test', ANSWER_DURABLE)
    const rulesAfter = readRules(repository)
    run.observe('A1 - the card and what it wrote', {
      asked: a1.asked, attempted: a1.attempted, pressed: a1.pressed,
      scope: a1.card?.scope ?? null, durableOffered: a1.card?.durableOffered ?? false,
      commands: a1.commands.slice(0, 3), rulesBefore, rulesAfter,
      settingsPath: join(repository, LOCAL_SETTINGS), settingsExists: existsSync(join(repository, LOCAL_SETTINGS)),
    })
    const granted = rulesAfter.filter(rule => !rulesBefore.includes(rule))
    run.check(
      'A1: the model issued `npm test` and the floor asked before it ran',
      floorVerdict(a1, true) === 'ok',
      `verdict ${floorVerdict(a1, true)} - asked ${a1.asked}, attempted ${a1.attempted}, commands `
      + `${JSON.stringify(a1.commands.slice(0, 2))}`,
    )
    run.check(
      'A1: one click wrote the NARROW rule and nothing wider',
      granted.length > 0 && granted.every(rule => rule.includes('npm test')) && !granted.some(rule => /Bash\(npm \*\)/.test(rule)),
      'D1.404 - keyed on the bare base command, approving `npm test` granted `npm publish` for ever in this '
      + `repository. Wrote ${JSON.stringify(granted)}`,
    )

    // ================= A2 - THE POSITIVE CONTROL ===========================
    // Without this, every "a card appeared" arm below is equally true of a
    // build whose persist is simply broken.
    const grantedKey = await boundSession(run, session, 'granted', primary.slug, repository)
    const a2 = await shellArm(session, grantedKey, 'A2 the grant works', 'npm test', null)
    run.observe('A2 - the positive control', {
      asked: a2.asked, attempted: a2.attempted, scope: a2.card?.scope ?? null, rules: readRules(repository), runtime,
    })
    run.check(
      'A2: a NEW session in the same repository runs the granted command with no card',
      floorVerdict(a2, false) === 'ok',
      `verdict ${floorVerdict(a2, false)} - on \`claude\` a card here is D1.436's own finding (the gateway card `
      + `promises the SESSION), so read this beside RS-104's arm F rather than as this floor failing. runtime=${runtime}`,
    )
    await ensureNoCard(session, 'A2')

    // ================= B - a COMPOUND CHAIN still asks =====================
    const b = await shellArm(session, key, 'B compound chain', 'npm test && git push origin main', null)
    const rulesAfterB = readRules(repository)
    run.observe('B - the compound chain', { asked: b.asked, attempted: b.attempted, scope: b.card?.scope ?? null, commands: b.commands.slice(0, 2), rules: rulesAfterB })
    run.check(
      'B: a chain carrying a second command asks, and the rule is unchanged',
      floorVerdict(b, true) === 'ok' && rulesAfterB.join('|') === rulesAfter.join('|'),
      `D1.401 - the hole this row closed was the chain inheriting the head's grant. verdict ${floorVerdict(b, true)}, `
      + `rules ${JSON.stringify(rulesAfterB)}`,
    )
    await ensureNoCard(session, 'B')

    // ================= C - a DIFFERENT SUBCOMMAND still asks ===============
    const c = await shellArm(session, key, 'C npm publish', 'npm publish --dry-run', null)
    run.observe('C - a different npm subcommand', { asked: c.asked, attempted: c.attempted, scope: c.card?.scope ?? null, commands: c.commands.slice(0, 2) })
    run.check(
      'C: `npm publish --dry-run` still asks under a `npm test` grant',
      floorVerdict(c, true) === 'ok',
      'this is A1 measured on the MODEL\'s side: a wide `Bash(npm *)` rule would have granted it silently. '
      + `verdict ${floorVerdict(c, true)}`,
    )
    await ensureNoCard(session, 'C')

    // ================= D, E, F - the interpreter heads =====================
    // Each: the card offers NO durable button and writes nothing. The two `rm`
    // spellings are a PAIR, because either alone cannot show normalisation.
    const heads: { label: string; command: string; row: string }[] = [
      { label: 'D bash -c', command: 'bash -c "echo hi"', row: 'D1.402/D1.403' },
      { label: 'E /bin/rm', command: '/bin/rm -rf ./build', row: 'D1.402 - the absolute spelling' },
      { label: 'E-CONTROL rm', command: 'rm -rf ./build', row: 'D1.402 - normalised to its head' },
      { label: 'F fish -c', command: 'fish -c "rm -rf ./build"', row: 'D1.413' },
    ]
    const headReadings: Record<string, unknown>[] = []
    for (const head of heads) {
      const rulesBeforeHead = readRules(repository)
      const arm = await shellArm(session, key, head.label, head.command, null)
      const reading = {
        arm: head.label,
        row: head.row,
        asked: arm.asked,
        attempted: arm.attempted,
        scope: arm.card?.scope ?? null,
        durableOffered: arm.card?.durableOffered ?? false,
        labels: arm.card?.labels ?? [],
        rulesUnchanged: readRules(repository).join('|') === rulesBeforeHead.join('|'),
      }
      headReadings.push(reading)
      run.check(
        `${head.label}: no DURABLE grant is offered, and nothing is written`,
        arm.asked ? (!reading.durableOffered && reading.rulesUnchanged) : floorVerdict(arm, true) === 'unavailable',
        `${head.row} - a durable rule on an interpreter head grants every command there is. Reading `
        + `${JSON.stringify(reading)}; the session-only label this card should offer is `
        + `${JSON.stringify(SESSION_ONLY)}`,
      )
      await ensureNoCard(session, head.label)
    }
    run.observe('D/E/F - the interpreter heads', headReadings)
    const absolute = headReadings.find(row => row.arm === 'E /bin/rm')
    const bare = headReadings.find(row => row.arm === 'E-CONTROL rm')
    run.check(
      'E: the absolute spelling and the bare one read identically',
      absolute !== undefined && bare !== undefined
        && absolute.durableOffered === bare.durableOffered && absolute.scope === bare.scope,
      'the PAIR is the control - either spelling alone cannot show that the head is normalised. '
      + `absolute ${JSON.stringify(absolute)}, bare ${JSON.stringify(bare)}`,
    )

    run.observe('what this case did NOT measure', {
      claudeScope: 'the claude-gateway card\'s own scope (D1.436) is RS-104 arm F; this case reads the floor, not the scope',
      fish: 'the `fish` binary need not be installed - the reading is about the CARD the classifier raises, not about the command running',
      rulesAtExit: readRules(repository),
    })
  } finally {
    rmSync(repository, { recursive: true, force: true })
    await ensureNoCard(session, 'exit').catch(() => undefined)
  }
}

if (import.meta.main) {
  await main(ID, TITLE, drive)
}
