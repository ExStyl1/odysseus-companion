/**
 * RS-71 (D1.78) — is there a per-session, domain-tagged plaintext diagnostic on
 * each runtime, and where does it land on a PACKAGED build?
 *
 * ## The row, and the premise it carries
 *
 * D1.78 is *"there is no per-session, domain-filtered debug log on any runtime,
 * and the one absence claim in the record is already false"*, with
 * `done_means`: *"a named, per-session plaintext path on each runtime that an
 * operator can pin, or a recorded measurement that no such path exists with the
 * control that proves the probe reads."* Its source row (P6.448) carried
 * verdicts pi `unknown`, claude `unknown`, codex `partial` and an explicit
 * MEASURE-FIRST instruction, because the reader's own absence probe had already
 * been refuted once.
 *
 * Since that row was written the host grew `session-debug-log.ts` (C3.215 for
 * the claude arm, C3.274 for the Pi arm), whose own type says which runtimes are
 * served — `SessionDebugLogRuntime = 'claude' | 'pi'` — and whose naming rule is
 * `<config dir>/logs/runtime/<host session id>-<runtime>.txt`. **That module is
 * a claim in the source tree; this case is the reading on the artefact.** The
 * two are not the same thing, and the row is a `measure:` row precisely because
 * a shipped build is what has to answer.
 *
 * ## The three arms, and what makes each one interpretable
 *
 * One profile, three sessions, one plain turn each — pi, claude, codex — and
 * then ONE directory read. The arms share their instrument, which is the whole
 * design: the codex absence is scored in the same directory, in the same run and
 * by the same reader that finds the Pi file. **That is the positive control the
 * row asks for**, and it is why the three arms cannot be split into three cases:
 * a control measured in a different run is not a control.
 *
 * Per arm the case also records the turn's own outcome. A session whose turn
 * never reached the runtime would produce no diagnostic either, and the absence
 * would then be about the turn — so each arm reports `answered` beside its file
 * reading, and the codex arm's verdict is only readable while its own turn
 * answered.
 *
 * ## The DOMAIN half, which is the half the row's title is about
 *
 * M17's ask (quoted in P6.448) is *"per session, filterable by domain
 * (`claude --debug=mcp`)"*. A file that exists is not yet a file you can filter,
 * so the case counts the distinct bracketed domain tags in each file it finds —
 * `[pi-server]`, `[nestor-reasoning-proxy]`, `[interceptor-hint]` — and records
 * them. It scores no verdict on the argv FILTER itself: `session-debug-log.ts`
 * states in its own words that the filter is an argv flag with no environment
 * twin and is deliberately not passed, so a case asserting its absence would be
 * asserting a decision rather than measuring a behaviour.
 *
 * ## What this case deliberately does NOT claim
 *
 * **The posture.** Both arms of that module are written only while the HOST is
 * in debug mode, and every sitting rig launches with `NESSY_DEBUG=1`. So a file
 * found here is found UNDER THAT SWITCH, which the observation says out loud.
 * The negative arm — the same three turns on an app launched without it — is a
 * second launch and is left to the sitting that has one; recording the switch
 * beside the reading is the honest half a single-launch case can do.
 *
 * **Which of the two claude paths.** The binary's own default is
 * `<CLAUDE_CONFIG_DIR>/debug/<sdk session id>.txt` and the host override is
 * `<config>/logs/runtime/<host session id>-claude.txt`; the two are keyed by
 * DIFFERENT ids (`session-debug-log.ts` `claudeSessionDebugLogCandidates` says
 * so). The case therefore looks in BOTH places and reports which answered,
 * rather than asserting the host path and reporting a vendor-written file as an
 * absence.
 *
 * ## What it creates
 *
 * Three sessions it names itself, inside `NESSY_CONFIG_DIR`. It writes no
 * configuration, installs nothing, reads no credential and edits no connection.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { appEnvBlockReason, readAppEnvContamination } from '../lib/app-env.ts'
import { lastAssistantText, sendPrompt } from '../lib/chat.ts'
import type { CdpSession } from '../lib/connect.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import { writableConfigDir } from '../lib/runtime-session-log.ts'
import { listConnections, runtimeOf, switchRuntime } from '../lib/runtime-switch.ts'
import { assertElectronApi, freshSession } from '../lib/state.ts'
import type { CaseMeta, SittingRecipe, SittingRuntime } from '../lib/sitting.ts'

const ID = 'RS-71'
const TITLE = 'the per-session runtime diagnostic file, on all three runtimes in one profile'

export const meta = {
  id: ID,
  title: TITLE,
  row: 'D1.78',
  runtimes: ['pi', 'claude', 'codex'],
  credentials:
    'owner: the three one-click gateway cards (pi, claude-runtime, codex-runtime). No key is read and the dp file '
    + 'is never touched; the case blocks by name when a family has no card.',
} as const satisfies CaseMeta

export const manual = {
  steps: [
    '1. PACKAGED build, a config dir created for the run, launched with the `env -u` launcher in scripts/cdp/README.md and NESSY_DEBUG=1.',
    '2. One session per runtime family the profile has a card for, each running ONE plain turn that uses no tool.',
    '3. Read `<config dir>/logs/runtime/` and report every file in it, with its size and its distinct bracketed domain tags.',
    '4. For claude, ALSO read the vendor default `<workspace claude-config>/debug/<id>.txt`, because the host path and the vendor path are keyed by different ids.',
    '5. Score the absence on a runtime only against a file found for another runtime in the SAME directory in the SAME run.',
  ],
  expected:
    'A named per-session plaintext path per runtime, or a measured absence whose control is a sibling runtime\'s '
    + 'file in the same directory. `session-debug-log.ts` serves `claude` and `pi` by its own type and says codex '
    + 'has none; this run says whether the shipped artefact behaves that way.',
  detector:
    '`<config dir>/logs/runtime/<host session id>-<runtime>.txt` — the file the host itself opens '
    + '(`openSessionRuntimeDebugLog` for Pi, the `CLAUDE_CODE_DEBUG_LOGS_DIR` the child is pointed at for claude) — '
    + 'read off disk by name, plus the vendor-default candidate for claude. Never the app\'s captured stdout, which '
    + 'a packaged build does not write, and never the model\'s prose.',
  positiveControl:
    'a file found for ANOTHER runtime in the same directory in the same run: it proves the directory exists, the '
    + 'naming rule is the one the reader used, and the read works — so a runtime with no file there is an absence '
    + 'and not a mis-addressed probe. Each arm additionally records whether its own turn answered, because a turn '
    + 'that never reached the runtime would produce no diagnostic for a reason that is not the subject.',
  doneMeans:
    'D1.78 carries a per-runtime verdict — a named path an operator can pin, or a measured absence with its '
    + 'control — taken on a packaged build rather than from the module\'s own type.',
  doNotRead:
    'Do NOT answer this from `session-debug-log.ts`\'s `SessionDebugLogRuntime` union. That the host CAN write two '
    + 'of the three files is already known from the source; whether the shipped build does is the question.',
} as const satisfies SittingRecipe

/** The host's own per-session diagnostic directory. */
function runtimeLogDir(root: string): string {
  return join(root, 'logs', 'runtime')
}

interface LogFile {
  readonly name: string
  readonly bytes: number
  readonly lines: number
  readonly domains: string[]
}

/**
 * Every file in the host's diagnostic directory, with the distinct bracketed
 * tags each one carries.
 *
 * The tags are what M17 means by "filterable by domain", and they are counted
 * rather than quoted: a diagnostic carries prompt-adjacent text and this report
 * is committed.
 */
function logFiles(dir: string): LogFile[] {
  if (!existsSync(dir)) return []
  const out: LogFile[] = []
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name)
    try {
      if (!statSync(path).isFile()) continue
      const text = readFileSync(path, 'utf8')
      const domains = new Set<string>()
      for (const match of text.matchAll(/\[([a-z][a-z0-9-]{2,40})\]/g)) domains.add(match[1] ?? '')
      out.push({
        name,
        bytes: text.length,
        lines: text.split('\n').filter(Boolean).length,
        domains: [...domains].sort(),
      })
    } catch { /* a file that cannot be read is reported by its absence from this list */ }
  }
  return out
}

/**
 * The vendor's OWN default location for a claude session's debug file, under
 * whatever per-workspace `CLAUDE_CONFIG_DIR` the child was given.
 *
 * Walked rather than addressed: the file there is named with the SDK's session
 * id, which this case never learns. Finding ANY file under a `debug/` directory
 * in the workspace's claude config is the reading; naming which session it
 * belongs to is not, and would need the child's own environment.
 */
function vendorDebugFiles(root: string): string[] {
  const workspaces = join(root, 'workspaces')
  const found: string[] = []
  const walk = (dir: string, depth: number): void => {
    if (depth > 6) return
    let entries: string[]
    try { entries = readdirSync(dir) } catch { return }
    for (const name of entries) {
      const child = join(dir, name)
      let isDir = false
      try { isDir = statSync(child).isDirectory() } catch { continue }
      if (isDir) {
        if (name === 'debug') {
          try { for (const file of readdirSync(child)) found.push(join('debug', file)) } catch { /* unreadable */ }
          continue
        }
        walk(child, depth + 1)
      }
    }
  }
  walk(workspaces, 0)
  // The claude config can also sit directly under the config dir on a profile
  // with no per-workspace split; both are tried so an absence is not a guess.
  walk(join(root, 'claude-config'), 0)
  return found
}

interface Arm {
  readonly runtime: SittingRuntime
  readonly slug: string
  readonly sessionId: string
  readonly answered: boolean
  readonly answer: string
  readonly file?: LogFile
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)
  const root = writableConfigDir('reading the per-session diagnostic files this case measures')

  const appEnv = readAppEnvContamination()
  run.observe('app-env', { pids: appEnv.pids.length, present: appEnv.present, controlSeen: appEnv.controlSeen })
  const contaminated = appEnvBlockReason(appEnv, 'the per-session diagnostic this case reads')
  if (contaminated !== undefined) blocked(contaminated)

  const cards = await listConnections(session)
  const wanted: ReadonlyArray<{ runtime: SittingRuntime; provider: string }> = [
    { runtime: 'pi', provider: 'pi' },
    { runtime: 'claude', provider: 'anthropic' },
    { runtime: 'codex', provider: 'codex-runtime' },
  ]
  const picked = wanted
    .map(entry => ({ ...entry, card: cards.find(row => runtimeOf(row.providerType) === entry.provider) }))
    .filter((entry): entry is typeof entry & { card: NonNullable<typeof entry.card> } => entry.card !== undefined)
  run.observe('cards', { listed: cards.map(row => `${row.slug}:${row.providerType}`), driving: picked.map(entry => entry.runtime) })
  if (picked.length < 2) {
    blocked(
      `this profile lists cards for ${picked.map(entry => entry.runtime).join(', ') || 'no runtime family'}. The `
      + 'absence of a diagnostic file is only readable beside a runtime that HAS one in the same directory, so at '
      + 'least two families are needed for any arm to be interpretable',
    )
  }

  const before = logFiles(runtimeLogDir(root))
  run.observe('the diagnostic directory before this case ran', before.map(file => file.name))

  const arms: Arm[] = []
  for (const entry of picked) {
    const key = await freshSession(session, `CDP ${ID} ${entry.runtime} ${new Date().toISOString().slice(11, 19)}`)
    run.check(
      `the ${entry.runtime} arm ran in a session it created`,
      key.fresh,
      key.fresh ? undefined : `inherited ${key.inheritedMessages} messages: ${key.reason}`,
    )
    const bind = await switchRuntime(session, key.sessionId, entry.card.slug)
    run.check(
      `the ${entry.runtime} arm is bound to ${entry.card.slug}`,
      bind.ok,
      bind.ok ? undefined : `switchRuntime refused: ${bind.error}`,
    )
    const ready = await sendPrompt(session, key, 'Reply with the single word ready. Do not use any tool.', 300_000)
    const answer = lastAssistantText(ready.added).trim().slice(0, 120) // F1.521: THIS turn's reply
    arms.push({
      runtime: entry.runtime,
      slug: entry.card.slug,
      sessionId: key.sessionId,
      answered: answer.length > 0,
      answer,
      file: undefined,
    })
  }

  const after = logFiles(runtimeLogDir(root))
  run.observe('every file in the diagnostic directory after the three turns', after)

  const resolved: Arm[] = arms.map(arm => ({
    ...arm,
    file: after.find(file => file.name === `${arm.sessionId}-${arm.runtime}.txt`),
  }))
  for (const arm of resolved) {
    run.observe(`arm ${arm.runtime}`, {
      slug: arm.slug,
      sessionId: arm.sessionId,
      turnAnswered: arm.answered,
      answer: arm.answer,
      expectedFile: `logs/runtime/${arm.sessionId}-${arm.runtime}.txt`,
      found: arm.file ?? null,
    })
  }

  // THE CONTROL, and it comes first: without at least one file the reader found
  // by its own naming rule, every absence below is equally explained by a probe
  // pointed at the wrong directory.
  const withFile = resolved.filter(arm => arm.file !== undefined)
  run.require(
    'THE CONTROL — at least one runtime wrote a per-session file the reader found BY NAME in this directory',
    withFile.length > 0,
    `no file matching \`<session id>-<runtime>.txt\` for any of ${resolved.map(arm => arm.runtime).join(', ')}; the `
    + `directory holds ${JSON.stringify(after.map(file => file.name))}. With nothing found, "codex writes none" and `
    + '"this case read the wrong path" are the same reading',
  )

  for (const arm of resolved) {
    run.check(
      `the ${arm.runtime} arm's turn answered, so its file reading is about the diagnostic and not about the turn`,
      arm.answered,
      `the ${arm.runtime} session produced no assistant text, so a missing diagnostic below could be a turn that `
      + 'never reached the runtime rather than a runtime that writes none',
    )
  }

  const pi = resolved.find(arm => arm.runtime === 'pi')
  if (pi) {
    run.check(
      'PI — the host writes a per-session plaintext diagnostic an operator can pin',
      pi.file !== undefined && pi.file.bytes > 0,
      `no readable \`${pi.sessionId}-pi.txt\` in ${runtimeLogDir(root)}. D1.78's premise is that no such path exists `
      + 'on any runtime; this check is the arm that can refute it',
    )
    run.check(
      'PI — that file is DOMAIN-TAGGED, which is the half M17 asks for beyond mere existence',
      (pi.file?.domains.length ?? 0) >= 2,
      `the file carries ${JSON.stringify(pi.file?.domains ?? [])} — fewer than two distinct bracketed tags, so `
      + '"filterable by domain" is not readable off its content',
    )
  }

  const claude = resolved.find(arm => arm.runtime === 'claude')
  if (claude) {
    const vendor = vendorDebugFiles(root)
    run.observe('the VENDOR default candidate for the claude arm', { files: vendor.slice(0, 20), count: vendor.length })
    run.check(
      'CLAUDE — a per-session diagnostic exists at one of the two paths the host and the binary can write',
      claude.file !== undefined || vendor.length > 0,
      `neither \`logs/runtime/${claude.sessionId}-claude.txt\` nor any \`debug/<id>.txt\` under a claude config `
      + 'directory in this profile. The two are keyed by different session ids, which is why both were tried',
    )
  }

  const codex = resolved.find(arm => arm.runtime === 'codex')
  if (codex) {
    // Scored as an OBSERVATION and a check together: the absence is the expected
    // reading (`session-debug-log.ts` serves two runtimes by its own type), so
    // the value here is the control beside it, not a surprise.
    run.check(
      'CODEX — the measured absence, taken beside a sibling runtime\'s file in the same directory',
      codex.file === undefined,
      `a \`${codex.sessionId}-codex.txt\` exists, which the host has no writer for — read it before believing this `
      + 'case, because it would mean something else is writing into the host\'s own diagnostic directory',
    )
    run.observe('codex-verdict', {
      file: codex.file ?? null,
      control: withFile.map(arm => `${arm.runtime}: ${arm.file?.name}`),
      reading:
        'no per-session diagnostic file for codex in the host\'s own directory, measured beside '
        + `${withFile.length} sibling file(s) found by the same reader in the same run`,
    })
  }

  run.observe('verdict', {
    directory: runtimeLogDir(root),
    posture: 'the app was launched with NESSY_DEBUG=1; both host arms are written only while the host is in debug mode',
    perRuntime: resolved.map(arm => ({
      runtime: arm.runtime,
      path: arm.file ? `logs/runtime/${arm.file.name}` : null,
      bytes: arm.file?.bytes ?? 0,
      domains: arm.file?.domains ?? [],
    })),
  })
}

if (import.meta.main) {
  await main(ID, TITLE, drive)
}
