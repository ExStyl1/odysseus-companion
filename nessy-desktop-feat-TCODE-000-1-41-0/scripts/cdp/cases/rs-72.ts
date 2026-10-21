/**
 * RS-72 (D1.60) — the six ambient prompt-caching OFF switches, on the SHIPPED
 * claude child rather than on `buildClaudeSubprocessEnv()`.
 *
 * ## What is already settled, and what this case is for
 *
 * D1.60 is *"six prompt-caching off switches are ambient on the claude arm and
 * declared nowhere"*. Its HERMETIC half is shipped and pinned:
 * `CLAUDE_PROMPT_CACHING_OFF_ENV_KEYS` is a declared constant and
 * `agent/__tests__/claude-child-prompt-caching-switches.test.ts` (C3.160) holds
 * that the six are forwarded verbatim and enumerably, that the host invents none
 * of them, and that none is in the strip union. Every one of those assertions is
 * against `buildClaudeSubprocessEnv()` — a function called in the test process.
 *
 * The row's own rig asks for something else: *"export each of the six names
 * before a claude turn on a PACKAGED build"*. That is this case. Between the
 * function and the child there is a packaged main process, an Electron spawn and
 * whatever the shipped bundle does that the source tree's call does not, and
 * nothing in this repo had ever read the child's own environment on the artefact.
 *
 * ## The detector is the child process's own environment
 *
 * `ps eww` on the claude binary the app spawned, filtered to THIS app instance
 * by the `NESSY_CONFIG_DIR` in that same environment — never by `pgrep` alone,
 * which on a machine running three sittings matches three lanes' children (this
 * lane measured twelve `MacOS/Nessy Desktop` processes where it owns four).
 *
 * Names and value LENGTHS only, never values: the same child environment carries
 * `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN`, and a case that prints an
 * environment prints those too.
 *
 * ## Three readings, and two of them are the controls
 *
 * - **the positive control**: an arbitrary planted name with no reader anywhere
 *   (`NESSY_CDP_D160_CONTROL`) must arrive. Without it, *"the six arrived"* and
 *   *"this case read a child that inherits everything"* are the same reading —
 *   but so is its opposite, so it is the arm that proves the probe reads at all.
 * - **the negative control**: `CLAUDE_CODE_USE_BEDROCK`, planted at the same
 *   moment in the same launch, must NOT arrive. It is in
 *   `CLAUDE_SDK_STRIPPED_ENV_KEYS`, so its absence is what makes "forwarded" a
 *   discrimination rather than "the child gets the whole shell". Without it, a
 *   child that inherited everything unfiltered would score exactly as a child
 *   whose strip list ran.
 * - **the subject**: each of the six `DISABLE_PROMPT_CACHING*` names.
 *
 * ## The BITE half, and the second runtime that decides whether it HAS a subject
 *
 * `done_means` asks for a bite/no-bite verdict per name, read as cache
 * read/write token counts. The app already keeps them per session —
 * `tokenUsage.cacheReadTokens`, `.cacheCreationTokens` and a `cache.warmth`,
 * the same read `getSessions()` renders — so this case reads them rather than
 * standing up a loopback capture.
 *
 * A zero there is two different findings and they must not be scored as one:
 * *the upstream publishes no cache accounting* and *the claude path does not
 * surface what the upstream publishes*. The separator is a PI session on the
 * SAME gateway model in the same profile in the same run, which is why this
 * claude case drives a Pi arm at the end. A non-zero Pi reading beside a zero
 * claude reading says the accounting exists and does not arrive here; two zeros
 * say the card has nothing to switch off. Either way the clause is a NULL with
 * its reason attached rather than a no-bite verdict, because a switch whose
 * effect cannot be observed has not been shown to have none.
 *
 * ## The plant is the OPERATOR's step, and the case refuses without it
 *
 * The app must be launched with the six names, the control and the negative
 * control in its environment. A case may not relaunch the app, so this one reads
 * the app's own environment first and BLOCKS by name when the plant is not
 * there — which is also what stops it from silently measuring a clean rig and
 * reporting six absences as a finding.
 *
 * ## What it creates
 *
 * One session it names itself, inside `NESSY_CONFIG_DIR`. It writes no
 * configuration, edits no connection and reads no credential.
 */

import { appEnvBlockReason, readAppEnvContamination } from '../lib/app-env.ts'
import { lastAssistantText, sendPrompt } from '../lib/chat.ts'
import type { CdpSession } from '../lib/connect.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import { configDir } from '../lib/runtime-session-log.ts'
import { listConnections, runtimeOf, switchRuntime } from '../lib/runtime-switch.ts'
import { assertElectronApi, freshSession } from '../lib/state.ts'
import type { CaseMeta, SittingRecipe } from '../lib/sitting.ts'

const ID = 'RS-72'
const TITLE = 'the six prompt-caching off switches, read off the packaged claude child\'s own environment'

/**
 * The six, spelled here rather than imported.
 *
 * A case is a `bun run` script against a PACKAGED artefact: importing the
 * repo's own constant would measure the source tree this artefact may not match,
 * which is the whole reason a `measure:` row exists. The list is checked against
 * `CLAUDE_PROMPT_CACHING_OFF_ENV_KEYS` by eye when the case is written, and a
 * drift shows up here as a name the child does not carry — a loud failure rather
 * than a quiet agreement.
 */
const SWITCHES = [
  'DISABLE_PROMPT_CACHING',
  'DISABLE_PROMPT_CACHING_HAIKU',
  'DISABLE_PROMPT_CACHING_SONNET',
  'DISABLE_PROMPT_CACHING_OPUS',
  'DISABLE_PROMPT_CACHING_FABLE',
  'DISABLE_PROMPT_CACHING_MYTHOS',
] as const

/** A name with no reader in this product, planted to prove the probe reads. */
const ARBITRARY_CONTROL = 'NESSY_CDP_D160_CONTROL'

/** A name in `CLAUDE_SDK_STRIPPED_ENV_KEYS` — planted, and required to be gone. */
const STRIPPED_CONTROL = 'CLAUDE_CODE_USE_BEDROCK'

/** The claude binary the packaged app spawns, by the path only the artefact has. */
const CHILD_MARKER = 'claude-agent-sdk-binary/claude'

export const meta = {
  id: ID,
  title: TITLE,
  row: 'D1.60',
  runtimes: ['claude', 'pi'],
  credentials:
    'owner: a claude-runtime card, plus a pi card for the cache-accounting control. No key is read; the case '
    + 'prints environment NAMES and value LENGTHS only, never values, because the same child environment carries '
    + 'the session credential.',
} as const satisfies CaseMeta

export const manual = {
  steps: [
    '1. PACKAGED build, a config dir created for the run, launched with the `env -u` launcher in scripts/cdp/README.md.',
    '2. ADD to that launch, as the plant: the six DISABLE_PROMPT_CACHING* names, NESSY_CDP_D160_CONTROL, and CLAUDE_CODE_USE_BEDROCK.',
    '3. Run ONE turn on a claude-runtime card so the app spawns its claude child.',
    '4. Find that child by its binary path AND by the NESSY_CONFIG_DIR in its own environment — never by pgrep alone on a machine running more than one app.',
    '5. Read its environment: the six must be there, the arbitrary control must be there, and the stripped control must not.',
  ],
  expected:
    'The six arrive, the arbitrary control arrives, and the stripped control does not — which is the ambient '
    + 'reachability D1.60 names, measured on the artefact instead of on a function call in a test process.',
  detector:
    '`ps eww` on the claude child the packaged app spawned, matched by its binary path and by the config dir in '
    + 'its own environment. Names and value lengths only. Never `buildClaudeSubprocessEnv()`, which is the source '
    + 'tree, and never the app\'s captured stdout, which a packaged build does not write.',
  positiveControl:
    'the arbitrary planted name arriving in the same read — it proves the probe reads a real environment and that '
    + 'the launch\'s plant reached the app at all. Its partner is the NEGATIVE control: a name in the strip union '
    + 'planted at the same moment, whose ABSENCE is what makes "forwarded" a discrimination rather than "this '
    + 'child inherits everything".',
  doneMeans:
    'D1.60\'s reachability clause carries a packaged-build verdict with both controls; the BITE clause carries '
    + 'either a token reading or the recorded reason it has no subject on this card.',
  runOnlyIf:
    'the app was launched with the plant. The case blocks by name otherwise, rather than measuring a clean rig and '
    + 'reporting six absences as a finding.',
  doNotRead:
    'Do NOT answer this from the unit suite. That `buildClaudeSubprocessEnv()` forwards the six is already pinned '
    + 'by C3.160; whether the SHIPPED app\'s child carries them is the question the row asks.',
} as const satisfies SittingRecipe

interface ProcessEnvRead {
  readonly pid: number
  readonly names: Record<string, number>
}

/** One process's environment as name -> value LENGTH. Never a value. */
function envOfPid(pid: number): Record<string, number> {
  const out: Record<string, number> = {}
  try {
    const text = Bun.spawnSync(['ps', 'eww', '-p', String(pid)]).stdout.toString()
    for (const token of text.split(/\s+/)) {
      const eq = token.indexOf('=')
      if (eq <= 0) continue
      const name = token.slice(0, eq)
      if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) continue
      out[name] = token.length - eq - 1
    }
  } catch { /* an unreadable process is reported by its absence from the list */ }
  return out
}

/**
 * Every claude child of THIS app instance, told apart from a sibling lane's by
 * the config dir in its own environment.
 *
 * `pgrep` on the binary path is the candidate set; the config dir is the filter,
 * and it is not optional on this machine — three sittings ran at once and the
 * unfiltered set held four other lanes' children.
 */
function claudeChildren(root: string): ProcessEnvRead[] {
  let pids: number[] = []
  try {
    pids = Bun.spawnSync(['pgrep', '-f', CHILD_MARKER]).stdout.toString()
      .split('\n').map(line => Number(line.trim())).filter(pid => Number.isFinite(pid) && pid > 0)
  } catch { return [] }
  const out: ProcessEnvRead[] = []
  for (const pid of pids) {
    const names = envOfPid(pid)
    if (names.NESSY_CONFIG_DIR === undefined) continue
    // The LENGTH is what `ps eww` gives without printing the value, and the
    // config dir's length is a usable discriminator only because every sitting
    // creates its own path. Confirmed below against the case's own `configDir()`
    // through a second, cheap read: the child also carries NESSY_SESSION_DIR,
    // which starts with the same root.
    const text = Bun.spawnSync(['ps', 'eww', '-p', String(pid)]).stdout.toString()
    if (!text.includes(`NESSY_CONFIG_DIR=${root}`)) continue
    out.push({ pid, names })
  }
  return out
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)
  const root = configDir()

  const appEnv = readAppEnvContamination()
  run.observe('app-env', { pids: appEnv.pids.length, present: appEnv.present, controlSeen: appEnv.controlSeen })
  const contaminated = appEnvBlockReason(appEnv, 'the child environment this case reads')
  if (contaminated !== undefined) blocked(contaminated)

  // ---- the plant, read off the APP before anything else ---------------------
  const appPids = appEnv.pids.filter(pid => Bun.spawnSync(['ps', 'eww', '-p', String(pid)]).stdout.toString()
    .includes(`NESSY_CONFIG_DIR=${root}`))
  run.observe('this app instance', { pids: appPids, configDir: root })
  if (appPids.length === 0) {
    blocked(
      `no running app carries NESSY_CONFIG_DIR=${root}. On a machine running more than one sitting, an unfiltered `
      + 'process read measures another lane\'s app, so this case refuses rather than reporting about one',
    )
  }
  const appNames = envOfPid(appPids[0] ?? 0)
  const planted = [...SWITCHES, ARBITRARY_CONTROL, STRIPPED_CONTROL].filter(name => appNames[name] !== undefined)
  run.observe('the plant, as the APP itself carries it', { planted, missing: [...SWITCHES, ARBITRARY_CONTROL, STRIPPED_CONTROL].filter(name => appNames[name] === undefined) })
  if (planted.length < SWITCHES.length + 2) {
    blocked(
      'the app was not launched with the plant this case measures. Relaunch it with the six DISABLE_PROMPT_CACHING* '
      + `names, ${ARBITRARY_CONTROL} and ${STRIPPED_CONTROL} in its environment (see this file's \`manual.steps\`). `
      + `Present now: ${JSON.stringify(planted)}. Without the plant the six would read as absent from the child and `
      + 'that absence would be the launch, not the product',
    )
  }

  // ---- one claude turn, so there is a child to read -------------------------
  const cards = await listConnections(session)
  const card = cards.find(row => runtimeOf(row.providerType) === 'anthropic')
  if (!card) blocked('this profile lists no claude-runtime card, and the subject is the claude child\'s environment')

  const key = await freshSession(session, `CDP ${ID} ${new Date().toISOString().slice(11, 19)}`)
  run.check('the case ran in a session it created', key.fresh, key.fresh ? undefined : `inherited ${key.inheritedMessages} messages`)
  const bind = await switchRuntime(session, key.sessionId, card.slug)
  run.check(`the session is bound to ${card.slug}`, bind.ok, bind.ok ? undefined : `switchRuntime refused: ${bind.error}`)
  const ready = await sendPrompt(session, key, 'Reply with the single word ready. Do not use any tool.', 300_000)
  const answer = lastAssistantText(ready.added).trim().slice(0, 80) // F1.521: THIS turn's reply
  run.observe('the turn that spawned the child', { answer })

  const children = claudeChildren(root)
  run.observe('claude children of THIS app instance', children.map(child => ({ pid: child.pid, envNames: Object.keys(child.names).length })))
  run.require(
    'THE PRECONDITION — a claude child of this app instance is running and readable',
    children.length > 0,
    'no process matching the packaged claude binary carries this rig\'s NESSY_CONFIG_DIR. The child may have '
    + 'exited between the turn and the read, in which case nothing below is about the product',
  )
  const child = children[0]
  if (!child) return

  run.require(
    `THE POSITIVE CONTROL — the arbitrary planted name ${ARBITRARY_CONTROL} reached the child`,
    child.names[ARBITRARY_CONTROL] !== undefined,
    `a name with no reader anywhere in this product did not arrive, so this read cannot say anything about the six: `
    + `the child carries ${Object.keys(child.names).length} names and none of them is the control`,
  )
  run.check(
    `THE NEGATIVE CONTROL — the stripped name ${STRIPPED_CONTROL} did NOT reach the child`,
    child.names[STRIPPED_CONTROL] === undefined,
    `${STRIPPED_CONTROL} is in CLAUDE_SDK_STRIPPED_ENV_KEYS and arrived anyway. With it present, "the six are `
    + 'forwarded" would be indistinguishable from "this child inherits the whole shell unfiltered", and a shipped '
    + 'provider-routing strip would be the thing that is broken',
  )

  const arrived = SWITCHES.filter(name => child.names[name] !== undefined)
  run.observe('the six, as the CHILD carries them', {
    arrived,
    missing: SWITCHES.filter(name => child.names[name] === undefined),
    lengths: Object.fromEntries(arrived.map(name => [name, child.names[name]])),
  })
  for (const name of SWITCHES) {
    run.check(
      `${name} reaches the packaged claude child`,
      child.names[name] !== undefined,
      `planted in the app's own environment and absent from the child's. Either the shipped build strips it — which `
      + 'would delete a documented vendor control — or this name is not the one the bundle reads',
    )
  }

  // ---- the BITE half, and the control that decides whether it HAS a subject --
  //
  // The row wants cache read/write tokens. The app already records them per
  // session (`tokenUsage.cacheReadTokens` / `.cacheCreationTokens`, with a
  // `cache.warmth`), so the first question is not what the switch did but
  // whether this card's accounting moves at all — and the answer to THAT needs a
  // second runtime on the SAME gateway model in the same profile, which is the
  // Pi arm below. Without it, a zero on claude would be read as "the upstream
  // publishes no cache accounting", which is a claim about the gateway that this
  // rig would not have measured.
  const claudeUsage = await cacheUsage(session, key.sessionId)
  run.observe('cache accounting, the CLAUDE arm', claudeUsage)

  const piCard = cards.find(row => runtimeOf(row.providerType) === 'pi')
  let piUsage: CacheUsage | undefined
  if (piCard) {
    const piKey = await freshSession(session, `CDP ${ID} pi-control ${new Date().toISOString().slice(11, 19)}`)
    const piBind = await switchRuntime(session, piKey.sessionId, piCard.slug)
    run.check(`the cache-accounting control is bound to ${piCard.slug}`, piBind.ok, piBind.ok ? undefined : `switchRuntime refused: ${piBind.error}`)
    await sendPrompt(session, piKey, 'Reply with the single word ready. Do not use any tool.', 300_000)
    piUsage = await cacheUsage(session, piKey.sessionId)
    run.observe('cache accounting, the PI control on the same gateway model', piUsage)
  }

  const subjectExists = (piUsage?.cacheReadTokens ?? 0) > 0 || (piUsage?.cacheCreationTokens ?? 0) > 0
  run.observe('the BITE clause — verdict', {
    claude: claudeUsage,
    piControl: piUsage ?? null,
    reading: subjectExists
      ? 'the gateway DOES publish cache accounting — a Pi session on the same model in the same profile reports it — '
        + 'and the claude session reports zero with `warmth: unknown`. So a bite/no-bite verdict per switch cannot be '
        + 'taken off the app\'s own usage on this card: the claude path reports the same zero whether the switches '
        + 'are set or not, which is a reading about the claude usage mapping rather than about the switches. D1.60\'s '
        + 'bite clause stays a NULL, with this control naming why.'
      : 'neither runtime reports cache accounting on this card in this run, so the switch has no subject here and the '
        + 'bite clause is a NULL for want of an upstream that publishes cached tokens — not a no-bite verdict.',
  })
}

interface CacheUsage {
  readonly cacheReadTokens: number
  readonly cacheCreationTokens: number
  readonly warmth: string
  readonly costReporting: string
  readonly inputTokens: number
}

/**
 * One session's cache accounting, off the record the app itself keeps.
 *
 * `getSessions()` is the same read `useSessionList` renders, so this is the
 * number a user could see — not a derived one, and not the model's prose.
 */
async function cacheUsage(session: CdpSession, sessionId: string): Promise<CacheUsage> {
  return session.call<CacheUsage>(`
    const rows = await window.electronAPI.getSessions()
    const list = rows.sessions ?? rows ?? []
    const usage = (list.find(s => s.id === ${JSON.stringify(sessionId)}) ?? {}).tokenUsage ?? {}
    return {
      cacheReadTokens: usage.cacheReadTokens ?? -1,
      cacheCreationTokens: usage.cacheCreationTokens ?? -1,
      warmth: (usage.cache && usage.cache.warmth) || 'absent',
      costReporting: usage.costReporting || 'absent',
      inputTokens: usage.inputTokens ?? -1,
    }
  `)
}

if (import.meta.main) {
  await main(ID, TITLE, drive)
}
