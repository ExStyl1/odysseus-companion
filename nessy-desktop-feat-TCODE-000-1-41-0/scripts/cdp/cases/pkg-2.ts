/**
 * PKG-2 — P3.259: does a claude session deliver the project instruction file to
 * the model ONCE or TWICE?
 *
 * The row is an UNMEASURED SUSPICION, recorded as one on purpose: a claude
 * session may hand the model the project instruction file twice — once through
 * our own pinned block and once through the SDK child's own memory loader — and
 * nothing in the tree records it either way. The cost, if it is real, is
 * invisible and paid on every request; and the two obvious remedies point in
 * opposite directions, so the wrong one silently REMOVES instructions rather
 * than duplicating them. Hence: measure first, design nothing.
 *
 * ## The instrument, and why it is not the model
 *
 * Asking the model how many copies it can see is a question about its
 * introspection, not about the wire. The SDK child writes its own transcript
 * (`<config>/workspaces/<ws>/claude-config/projects/<…>/<sessionId>.jsonl`) —
 * the same file `readClaudeSessionLog` reads — and every block that reaches the
 * model as context is in it: user message content, `attachment` entries, the
 * `<system-reminder>` wrappers. Counting a NONCE across that file counts
 * deliveries, not impressions.
 *
 * ## Why a fixture project rather than the repository, and why TWO of them
 *
 * The nonce has to exist in exactly one file on disk, so that every occurrence
 * in the transcript is a DELIVERY rather than a second file that happens to
 * contain it. The repository's own instruction files are quoted in dozens of
 * places.
 *
 * The two arms exist because the first run of this case showed the row's
 * premise needs sharpening before it can be answered. `prompts/system.ts`
 * attaches ONE project context file — first match of `AGENTS.override.md` >
 * `AGENTS.md` > `CLAUDE.md` — to the user-message tail, and the SDK's own
 * memory loader reads `CLAUDE.md`, which `excludeDynamicSections: true` puts on
 * that same tail. So the two paths collide only when they resolve to the SAME
 * file, i.e. when the project has no `AGENTS*.md`. `both-files` is the control
 * that proves the instrument can see each path separately; `claude-md-only` is
 * the question.
 *
 * ## The positive control this case cannot do without
 *
 * `count === 0` is not "delivered once"; it is "the instrument saw nothing",
 * and it is indistinguishable from a transcript this case failed to find. So a
 * zero is a BLOCKED, never a finding — and the count is reported beside the
 * transcript's own entry total so a reader can see the file was read at all.
 */

import { lastAssistantText, sendPrompt } from '../lib/chat.ts'
import { resolveAppUnderTest } from '../lib/bundle.ts'
import type { CdpSession } from '../lib/connect.ts'
import { ensureDarkTheme } from '../lib/mcp-fixture.ts'
import { blocked, exitCodeFor, runCase, type CaseRun } from '../lib/report.ts'
import { configDir, type RuntimeSessionEntry } from '../lib/runtime-session-log.ts'
import {
  listConnections,
  runtimeOf,
  bindProject,
  switchRuntime,
  trustFixtureProject,
  waitForConnection,
} from '../lib/runtime-switch.ts'
import { assertElectronApi, freshSession, isProcessing, waitFor } from '../lib/state.ts'
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function claudeProjectsDir(workspaceId: string): string {
  return join(configDir(), 'workspaces', workspaceId, 'claude-config', 'projects')
}

/**
 * Every SDK transcript line written or touched at/after `sinceMs`.
 *
 * Deliberately not `readClaudeSessionLog`: that helper either narrows by the
 * HOST session id (which is not what the SDK names its directory after) or
 * takes the newest file per directory, and this case needs whatever the turn
 * just wrote, wherever it landed.
 */
function readClaudeTranscriptsSince(
  workspaceId: string,
  sinceMs: number,
): { files: string[]; entries: RuntimeSessionEntry[] } {
  const root = claudeProjectsDir(workspaceId)
  if (!existsSync(root)) return { files: [], entries: [] }
  const files: string[] = []
  for (const dir of readdirSync(root)) {
    const child = join(root, dir)
    if (!statSync(child).isDirectory()) continue
    for (const name of readdirSync(child)) {
      if (!name.endsWith('.jsonl')) continue
      const file = join(child, name)
      // A one-second slack: the file is created when the child starts, which
      // can be marginally before the harness reads the clock.
      if (statSync(file).mtimeMs >= sinceMs - 1_000) files.push(file)
    }
  }
  const entries: RuntimeSessionEntry[] = []
  for (const file of files) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const raw = JSON.parse(trimmed) as Record<string, unknown>
        entries.push({ type: String(raw.type ?? ''), text: '', raw })
      } catch { /* a partially written line is not a delivery */ }
    }
  }
  return { files, entries }
}

const ID = 'PKG-2'
const TITLE = 'A claude session delivers the project instruction file to the model a countable number of times'

const TURN_TIMEOUT_MS = 300_000
const CDP_COMMAND_TIMEOUT_MS = 240_000

interface MarkerCount {
  /** Transcript entries carrying the marker at all. */
  entries: number
  /** Total occurrences — the delivery count the row asks for. */
  occurrences: number
  /** The entry types they arrived in. */
  types: string[]
}

interface FixtureProject {
  arm: 'both-files' | 'claude-md-only'
  dir: string
  claudeMarker: string
  agentsMarker?: string
}

/**
 * Two arms, and the second is the one that answers the row.
 *
 * `prompts/system.ts` reads ONE project context file, first match of
 * `AGENTS.override.md` > `AGENTS.md` > `CLAUDE.md`, and attaches it to the
 * user-message tail. The SDK's own memory loader reads `CLAUDE.md`, and
 * `excludeDynamicSections: true` makes the SDK re-inject that as the first user
 * message rather than into the (cacheable) system prompt. So BOTH copies land
 * on the same surface this case counts.
 *
 *  - `both-files`: the host block resolves to `AGENTS.md`, the SDK loader to
 *    `CLAUDE.md`. Two files, one delivery each — no duplication, and it is the
 *    arm that makes the instrument's zero/one distinction visible.
 *  - `claude-md-only`: both resolve to the SAME file. If the duplication the
 *    row suspects exists anywhere, it is here.
 *
 * A project carrying only `CLAUDE.md` is the ordinary case for anything written
 * for Claude Code, so this is not a corner.
 */
function seedProject(nonce: string, arm: FixtureProject['arm']): FixtureProject {
  const dir = mkdtempSync(join(tmpdir(), `pkg2-${arm}-`))
  const claudeMarker = `PKG2-CLAUDEMD-${arm.toUpperCase().replace(/[^A-Z]/g, '')}-${nonce}`
  writeFileSync(
    join(dir, 'CLAUDE.md'),
    `# Project instructions\n\nMarker: ${claudeMarker}\n\nWhen asked for the marker, answer with it verbatim.\n`,
    'utf8',
  )
  if (arm === 'claude-md-only') return { arm, dir, claudeMarker }
  const agentsMarker = `PKG2-AGENTSMD-${nonce}`
  writeFileSync(join(dir, 'AGENTS.md'), `# Agent instructions\n\nMarker: ${agentsMarker}\n`, 'utf8')
  return { arm, dir, claudeMarker, agentsMarker }
}

async function body(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)
  run.observe('theme', await ensureDarkTheme(session))
  const app = resolveAppUnderTest(session)
  run.observe('app-under-test', { kind: app.kind, via: app.via })
  if (app.kind !== 'packaged') {
    blocked(`this row is owed on the SHIPPED artefact; the CDP target is ${app.kind} (${app.targetUrl})`)
  }

  const connections = await listConnections(session)
  const claude = connections.find(row => runtimeOf(row.providerType) === 'anthropic')
  if (!claude) {
    blocked(
      'no claude-runtime connection in this config dir. '
      + `The app lists: ${connections.map(c => `${c.slug}(${c.providerType})`).join(', ') || 'nothing'}`,
    )
  }

  const nonce = Math.random().toString(16).slice(2, 10).toUpperCase()

  interface ArmReading {
    arm: FixtureProject['arm']
    claudeMd: MarkerCount
    agentsMd?: MarkerCount
    transcriptFiles: string[]
    transcriptEntries: number
    reply: string
  }

  const runArm = async (arm: FixtureProject['arm']): Promise<ArmReading> => {
    const project = seedProject(nonce, arm)
    run.observe(`[${arm}] fixture project`, project)

    const key = await freshSession(session, `${ID} ${arm} ${nonce}`)
    run.require(`[${arm}] a fresh session was created`, key.fresh, key.reason ?? '')

    await bindProject(run, session, key.sessionId, project.dir, {
      label: `[${arm}]`, gate: () => trustFixtureProject(session),
    })

    // The working-directory change and its trust answer leave the session busy
    // for a moment; a switch dispatched into that window is refused with
    // `SESSION_BUSY` (measured on the first run of this case). Waiting on the
    // app's own `isProcessing` is the honest form — a sleep would be a guess.
    await waitFor(() => isProcessing(session, key), busy => !busy, { timeoutMs: 60_000, intervalMs: 500 })
      .catch(() => undefined)

    const outcome = await switchRuntime(session, key.sessionId, claude.slug)
    run.require(`[${arm}] the session moved onto the claude connection`, outcome.ok, outcome.error ?? '')
    await waitForConnection(session, key.sessionId, claude.slug).catch(() => undefined)

    const turnStartedMs = Date.now()
    const turn = await sendPrompt(session, key, 'Reply with the single word: ready', TURN_TIMEOUT_MS)
    const reply = lastAssistantText(turn.added)
    run.observe(`[${arm}] claude reply excerpt`, reply.slice(0, 120))
    run.require(
      `[${arm}] the claude turn produced an assistant reply`,
      reply.trim().length > 0,
      'without a real turn the SDK writes nothing to count',
    )

    // The SDK names its transcript directory and file after ITS OWN session
    // uuid, not the host's — measured on the first run of this case, which
    // narrowed by the host session id and found nothing under a directory that
    // had just been written. So the files are found by TIME and identified by
    // the run's own nonce, which exists nowhere else on disk.
    const log = readClaudeTranscriptsSince(key.workspaceId, turnStartedMs)
    run.observe(`[${arm}] claude sdk transcript`, { files: log.files.length, entries: log.entries.length })
    if (log.entries.length === 0) {
      blocked(
        `[${arm}] no SDK transcript was written during this turn, so this run measured nothing. `
        + `Looked under ${claudeProjectsDir(key.workspaceId)}.`,
      )
    }

    // Counted over the RAW entry, not the flattened text: an instruction block
    // can arrive as an attachment payload rather than as message content, and
    // the flattened form drops it.
    const countIn = (marker: string): MarkerCount => {
      let entries = 0
      let occurrences = 0
      const types = new Set<string>()
      for (const entry of log.entries) {
        const hits = JSON.stringify(entry.raw).split(marker).length - 1
        if (hits > 0) {
          entries += 1
          occurrences += hits
          types.add(entry.type)
        }
      }
      return { entries, occurrences, types: [...types] }
    }

    const claudeMd = countIn(project.claudeMarker)
    const agentsMd = project.agentsMarker ? countIn(project.agentsMarker) : undefined
    run.observe(`[${arm}] CLAUDE.md marker deliveries`, claudeMd)
    if (agentsMd) run.observe(`[${arm}] AGENTS.md marker deliveries`, agentsMd)

    return { arm, claudeMd, agentsMd, transcriptFiles: log.files, transcriptEntries: log.entries.length, reply }
  }

  // Arm 1 — the positive control for the instrument: two different files, so a
  // count of one each is the shape "delivered, not duplicated" must have.
  const both = await runArm('both-files')
  if (both.claudeMd.occurrences === 0 && (both.agentsMd?.occurrences ?? 0) === 0) {
    blocked(
      'neither instruction marker reached the SDK transcript, so this run measured nothing. '
      + 'Either the working directory did not take, or the instruction files are not delivered at all — '
      + 'both are preconditions, not answers. '
      + `Transcripts read: ${both.transcriptFiles.join(', ') || '(none)'} — ${both.transcriptEntries} entries.`,
    )
  }
  run.check(
    'with AGENTS.md and CLAUDE.md both present, each reaches the model exactly once',
    both.claudeMd.occurrences === 1 && both.agentsMd?.occurrences === 1,
    `CLAUDE.md x${both.claudeMd.occurrences}, AGENTS.md x${both.agentsMd?.occurrences}`,
  )

  // Arm 2 — the row's actual question: one file, two loaders that both resolve
  // to it.
  const onlyClaude = await runArm('claude-md-only')
  run.require(
    'the CLAUDE.md-only arm delivered the file at all',
    onlyClaude.claudeMd.occurrences > 0,
    'a zero here is the instrument failing, not an answer',
  )
  const duplicated = onlyClaude.claudeMd.occurrences > 1
  run.check(
    'a project carrying ONLY CLAUDE.md does not deliver it twice',
    !duplicated,
    `CLAUDE.md x${onlyClaude.claudeMd.occurrences} in ${onlyClaude.claudeMd.entries} entr(y|ies) of type `
    + `${onlyClaude.claudeMd.types.join('/')}`,
  )

  run.observe('VERDICT', {
    bothFiles: { claudeMd: both.claudeMd.occurrences, agentsMd: both.agentsMd?.occurrences },
    claudeMdOnly: { claudeMd: onlyClaude.claudeMd.occurrences, entryTypes: onlyClaude.claudeMd.types },
    duplicatedWhenOnlyClaudeMdExists: duplicated,
  })
}

if (import.meta.main) {
  const result = await runCase(ID, TITLE, body, { timeoutMs: CDP_COMMAND_TIMEOUT_MS })
  process.exit(exitCodeFor(result.status))
}

export { ID, TITLE, body }
