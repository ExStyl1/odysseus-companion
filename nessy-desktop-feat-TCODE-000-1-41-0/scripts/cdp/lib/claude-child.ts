/**
 * THE CLAUDE RUNTIME'S OWN CHILD PROCESS — the instrument the `LIV-*` wave needs,
 * and the only one that can tell a live session from a resumed one.
 *
 * ## Why not the obvious detectors
 *
 * The claim `docs/superpowers/plans/2026-08-17-claude-live-session.md` is built
 * on is that ONE process now serves many turns. Three readings look like they
 * answer that and do not:
 *
 * - **The session id.** It is PERSISTED and passed back as `--resume=<id>` on
 *   the next spawn (`ClaudeAgent.routeLiveMessage` stores every observed
 *   `session_id`; `ensureLiveSession` compares the anchor separately). Measured
 *   here on 2026-08-17: a claude-runtime turn that FAILED upstream respawned the
 *   child, and the new child's command line carried the identical
 *   `--resume=38632224-…`. So an unchanged session id is what a RESPAWN looks
 *   like too, and it can only ever falsify the claim, never confirm it.
 * - **`system/init`.** L0 measured it arriving once per TURN, so a marker whose
 *   name says "session start" is a turn marker.
 * - **The application log.** `apps/electron/src/main/logger.ts` turns both
 *   transports off on a packaged build, so any log-based detector measures a dev
 *   build only (`runtime-session-log.ts` has the whole story).
 *
 * What only a surviving PROCESS can carry is the process itself: a pid that is
 * still there between two turns, with a start time older than the first of them
 * and an elapsed time that keeps climbing. That is what this file reads.
 *
 * ## What we are looking at
 *
 * The Agent SDK spawns the native binary the app points it at
 * (`agent/options.ts` → `pathToClaudeCodeExecutable`, or the SDK's own
 * `node_modules` resolution) with a fixed argument shape, `--output-format
 * stream-json --verbose --input-format stream-json …`, in the SESSION's own
 * directory. One real command line, from this rig:
 *
 *     …/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude --output-format stream-json
 *       --verbose --input-format stream-json --thinking disabled
 *       --model tgpt/qwen35-397b-a17b-fp8 --permission-prompt-tool stdio
 *       --disallowedTools EnterPlanMode,ExitPlanMode,Skill --tools default
 *       --setting-sources=user,project,local --permission-mode default
 *       --include-partial-messages
 *
 * The command line is a bonus instrument: it reports what the child was SPAWNED
 * with, and it never changes afterwards. A live `setModel` therefore shows up as
 * "same pid, command line still naming the OLD model, upstream answering as the
 * new one" — which is `LIV-3`'s whole proof.
 *
 * ## Three attribution traps, all real on this machine
 *
 * 1. **Another `claude` CLI is running.** This developer's machine runs Claude
 *    Desktop, whose own agent child matches `--input-format stream-json`
 *    exactly, and — measured — its cwd was this very repository. A `pgrep
 *    claude` detector would have counted it as ours. Every process here is
 *    therefore walked up its `ppid` chain and kept only if it descends from the
 *    Electron process carrying `--remote-debugging-port=<the CDP port we are
 *    attached to>`; that is the app under test, by construction.
 * 2. **Another SESSION of our own app is running.** Sessions are long-lived
 *    now: a child from an earlier case was still alive minutes later, and 16 of
 *    them were alive at once during this wave. Children are therefore scoped by
 *    CWD, which the SDK sets to `<config>/sessions/<workspaceId>/<sessionId>` —
 *    the session's own directory, and an exact identity rather than a heuristic.
 * 3. **THE OBSERVER COUNTS ITSELF.** A shell running
 *    `ps … | grep -- "--input-format stream-json"` carries that string in its own
 *    command line. See {@link isClaudeChildCommand}: it cost an almost-filed
 *    finding about phantom one-shot children.
 *
 * ## The instrument checks itself before it reports an absence
 *
 * "No child process" is an ABSENCE, and this repo's rule is that an absence
 * needs a positive control. {@link assertProcessInstrument} proves, on the same
 * rig and before anything is measured, that `ps` can see the app and that `lsof`
 * can read a cwd — so "zero children" can never mean "the harness cannot see
 * processes". {@link describeChildSearch} then reports the three layers of the
 * search separately, so a failure names which one came up empty.
 *
 * Everything here is a READ. No case may signal, kill or otherwise touch a
 * process it finds.
 */

import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

import { lastAssistantText, sendPrompt, sendSlashCommand } from './chat.ts'
import { resolvePort, type CdpSession } from './connect.ts'
import { blocked, type CaseRun } from './report.ts'
import { configDir } from './runtime-session-log.ts'
import { listConnections, switchRuntime, waitForConnection } from './runtime-switch.ts'
import { freshSession, transcript, type SessionKey, type TranscriptMessage } from './state.ts'

/** One process as `ps` reported it. */
export interface ProcessRow {
  pid: number
  ppid: number
  /** `ps -o lstart` — an absolute start time, which is what makes a pid unambiguous. */
  lstart: string
  /** `ps -o etime` — elapsed run time, `[[dd-]hh:]mm:ss`. */
  etime: string
  command: string
}

/** A Claude SDK child attributable to one Nessy session. */
export interface ClaudeChild extends ProcessRow {
  cwd: string
  /** `--model <id>` as the child was SPAWNED with it. Not necessarily today's model. */
  spawnModel?: string
  /** `--resume=<id>`, present only when the spawn was told to resume a conversation. */
  resume?: string
  /** `--thinking <value>` / `--effort <value>` as spawned. */
  spawnThinking?: string
  spawnEffort?: string
}

/**
 * What a Claude SDK child's command line looks like — BOTH halves required.
 *
 * The stream-json flags alone are not enough, and the reason is a live
 * self-inflicted false positive: a shell running
 * `ps … | grep -- "--input-format stream-json"` has that string in its OWN
 * command line, so an operator's diagnostic pipeline counts itself. Three
 * "mystery children appearing and exiting within seconds" on this rig were
 * exactly that, and they were nearly written up as one-shot mini queries. The
 * executable half (`…/claude` followed by a space) excludes them; it still
 * matches Claude Desktop's own agent CLI, which is correct — that decoy is meant
 * to be excluded by ANCESTRY, where the exclusion can be seen and reported.
 */
function isClaudeChildCommand(command: string): boolean {
  return /--input-format\s+stream-json/.test(command) && /(?:^|\/)claude(?:\.exe)?\s/.test(command)
}

function ps(): ProcessRow[] {
  const out = execFileSync('ps', ['-Ao', 'pid=,ppid=,lstart=,etime=,command='], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  return out.split('\n').filter(Boolean).flatMap(line => {
    // `lstart` is five space-separated fields (`Mon Aug 17 10:21:50 2026`), which
    // is why the columns are parsed by shape rather than split on whitespace.
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\d+:\d+:\d+\s+\d+)\s+(\S+)\s+(.*)$/.exec(line)
    if (!match) return []
    return [{
      pid: Number(match[1]),
      ppid: Number(match[2]),
      lstart: match[3]!,
      etime: match[4]!,
      command: match[5]!,
    }]
  })
}

/**
 * A process's working directory, or `undefined` when it cannot be read.
 *
 * `undefined` is genuinely ambiguous — the process may have exited between the
 * `ps` and the `lsof`, or the read may be refused — which is exactly why
 * {@link assertProcessInstrument} proves the call works at all before a case
 * trusts an empty answer.
 */
export function processCwd(pid: number): string | undefined {
  try {
    const out = execFileSync('lsof', ['-a', '-d', 'cwd', '-p', String(pid), '-Fn'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return out.split('\n').find(line => line.startsWith('n'))?.slice(1)
  } catch {
    return undefined
  }
}

/** Processes carrying `--remote-debugging-port=<port>` — the app this run is attached to. */
function appRoots(rows: ProcessRow[], port: string): ProcessRow[] {
  return rows.filter(row => row.command.includes(`--remote-debugging-port=${port}`))
}

function descendsFrom(row: ProcessRow, roots: Set<number>, byPid: Map<number, ProcessRow>): boolean {
  let current: ProcessRow | undefined = row
  for (let hop = 0; hop < 64 && current; hop += 1) {
    if (roots.has(current.pid)) return true
    current = byPid.get(current.ppid)
  }
  return false
}

/** `<config>/sessions/<workspaceId>/<sessionId>` — the cwd the SDK is given. */
export function sessionDirOf(key: SessionKey, root = configDir()): string {
  return join(root, 'sessions', key.workspaceId, key.sessionId)
}

export interface ChildSearch {
  /** Every process on the machine whose command line looks like a Claude SDK child. */
  machineWide: ProcessRow[]
  /** …of those, the ones descending from the app under test. */
  ours: ProcessRow[]
  /** …of those, the ones whose cwd is this session's directory. */
  session: ClaudeChild[]
  /** The pids of the app processes the port matched — empty means the app was not found. */
  rootPids: number[]
}

/**
 * The three layers of the search, reported separately.
 *
 * A case that finds no child needs to know WHICH layer emptied: no such process
 * anywhere (the runtime never spawned), one exists but is not ours (the
 * ancestry filter, i.e. the Claude Desktop decoy), or ours exists but in another
 * session's directory (the case is looking at the wrong session).
 */
export function describeChildSearch(sessionDir: string, port = resolvePort()): ChildSearch {
  const rows = ps()
  const byPid = new Map(rows.map(row => [row.pid, row]))
  const roots = appRoots(rows, port)
  const rootPids = new Set(roots.map(row => row.pid))
  const machineWide = rows.filter(row => isClaudeChildCommand(row.command))
  const ours = machineWide.filter(row => descendsFrom(row, rootPids, byPid))
  const session: ClaudeChild[] = []
  for (const row of ours) {
    const cwd = processCwd(row.pid)
    if (cwd !== sessionDir) continue
    session.push({
      ...row,
      cwd,
      spawnModel: /--model\s+(\S+)/.exec(row.command)?.[1],
      resume: /--resume=(\S+)/.exec(row.command)?.[1],
      spawnThinking: /--thinking\s+(\S+)/.exec(row.command)?.[1],
      spawnEffort: /--effort\s+(\S+)/.exec(row.command)?.[1],
    })
  }
  return { machineWide, ours, session, rootPids: [...rootPids] }
}

/** Just the children of one session. */
export function claudeChildren(sessionDir: string, port = resolvePort()): ClaudeChild[] {
  return describeChildSearch(sessionDir, port).session
}

/**
 * Prove the instrument works before any case trusts it.
 *
 * Two positive controls, both of which must SUCCEED on a rig where a later
 * absence is going to be believed:
 *
 * - `ps` finds the app under test through the very port this run is attached
 *   to. If it does not, every "our child" answer would be empty forever.
 * - `lsof` reads that process's own cwd. If it cannot, cwd scoping silently
 *   matches nothing and every session looks childless.
 *
 * Reports BLOCKED rather than failing: an unreadable process table is a
 * precondition of the measurement, not a defect of the product.
 */
export function assertProcessInstrument(run: CaseRun, port = resolvePort()): void {
  const rows = ps()
  if (rows.length < 5) {
    blocked(`the process table could not be read: \`ps\` returned ${rows.length} parsable rows`)
  }
  const roots = appRoots(rows, port)
  if (roots.length === 0) {
    blocked(
      `no process on this machine carries --remote-debugging-port=${port}, so the app under test cannot be `
      + 'identified and no child could ever be attributed to it. Launch the app with '
      + `NESSY_CDP_PORT=${port} bun run electron:dev (ulimit -n 65536), or point NESSY_CDP_PORT at the running one.`,
    )
  }
  const readable = roots.map(row => ({ pid: row.pid, cwd: processCwd(row.pid) }))
  if (!readable.some(entry => entry.cwd)) {
    blocked(
      `\`lsof\` could not read the working directory of any app process (${JSON.stringify(readable)}). `
      + 'Every child here is attributed to a session BY CWD, so without it "no child for this session" would be '
      + 'true of a perfectly healthy runtime. Grant the terminal the rights lsof needs, or run the wave from a '
      + 'shell that has them.',
    )
  }
  run.observe('process instrument', {
    processes: rows.length,
    appProcesses: roots.map(row => row.pid),
    cwdReadable: readable.filter(entry => entry.cwd).map(entry => entry.pid),
  })
}

/** `[[dd-]hh:]mm:ss` → seconds. `ps` etime, for "has it been running longer now". */
export function etimeSeconds(etime: string): number {
  const [days, rest] = etime.includes('-') ? etime.split('-') : ['0', etime]
  const parts = (rest ?? '').split(':').map(Number)
  const [hours, minutes, seconds] = parts.length === 3
    ? parts
    : [0, parts[0] ?? 0, parts[1] ?? 0]
  return Number(days) * 86_400 + (hours ?? 0) * 3_600 + (minutes ?? 0) * 60 + (seconds ?? 0)
}

/** A stable identity for one process: pid ALONE is not one — pids are reused. */
export function childIdentity(child: ClaudeChild): string {
  return `${child.pid}@${child.lstart}`
}

/**
 * Wait until the session's child set settles to `count`, or return what it is.
 *
 * A spawn is not instantaneous and a death is not either: the reaper's lever is
 * stdin EOF, and L0 measured the child exiting up to 1.5 s later. Polling is
 * what stops a case reporting "two children" about a rig that had one a moment
 * later.
 *
 * **The other reason to poll rather than sample: not every Claude child need be
 * the live session's.** L2 deliberately left two SDK call sites one-shot — title
 * generation and the structured mini-queries, which carry their own system
 * prompt — and a one-shot `query()` spawns and exits a child of its own. Three
 * such children were APPARENTLY seen appearing and exiting within seconds
 * (2026-08-17, 10:56:59); they turned out to be the operator's own `ps | grep`
 * pipeline matching its own command line, which is why
 * {@link isClaudeChildCommand} now requires the executable half too. A 150 ms
 * poll across two full turns found exactly ONE child in the measured session's
 * directory and nothing else — but "not observed" is not "cannot happen", and an
 * `exactly one` check that polls waits a transient extra out while still failing
 * on one that persists.
 */
export async function waitForChildCount(
  sessionDir: string,
  count: number,
  timeoutMs = 20_000,
): Promise<ClaudeChild[]> {
  const deadline = Date.now() + timeoutMs
  let last: ClaudeChild[] = []
  for (;;) {
    last = claudeChildren(sessionDir)
    if (last.length === count) return last
    if (Date.now() >= deadline) return last
    await Bun.sleep(500)
  }
}

// ---------------------------------------------------------------------------
// The card the turns run on
// ---------------------------------------------------------------------------

export interface CardProbe {
  slug: string
  ok: boolean
  /** The first error row the probe turn produced, verbatim and untruncated enough to act on. */
  error?: string
  said?: string
}

export interface ResolvedCard {
  slug: string
  /** Every candidate tried, in order, with what happened. */
  probes: CardProbe[]
  /** True when the operator named this card and it was taken without a probe turn. */
  assumed: boolean
}

/**
 * A `claude-runtime` card whose model actually COMPLETES a turn on this host.
 *
 * The wave measures process lifetime, which needs turns that finish; a card
 * whose upstream refuses every request measures nothing. Two of this profile's
 * three Claude cards refused on 2026-08-17 — `claude-custom-2` with
 * `403 {"error":"failed to detect critical data: fail anon mask critical data …}`
 * and `claude-custom` with "There's an issue with the selected model
 * (openrouter/openai/gpt-5.4)" — while `claude-gateway`, the SHIPPING DEFAULT
 * card and the one four tracker rows in a row record as never exercised,
 * answered normally.
 *
 * So the choice is made by measurement rather than by preference, and every
 * refusal is reported verbatim: a card that cannot run a turn today is a fact
 * about the upstream (L6/L10), not about the code under test, and the case says
 * which card it used.
 *
 * `NESSY_CDP_CLAUDE_CARD` names the card to TRY FIRST. It is not a hard pin —
 * pinning it would turn an upstream refusal into a wave-wide BLOCKED — but the
 * probe order always starts there, and the report says whether the named card
 * won.
 *
 * Each probe runs in its OWN throwaway session. Probing inside the case's
 * measured session would leave that session's directory holding a child spawned
 * for a card the case is not measuring, which is exactly the attribution the
 * cwd scoping exists to guarantee.
 */
export async function resolveClaudeCard(
  session: CdpSession,
  run: CaseRun,
  options: { caseId: string },
): Promise<ResolvedCard> {
  const requested = process.env.NESSY_CDP_CLAUDE_CARD?.trim()
  const connections = await listConnections(session)
  const cards = connections.filter(row => row.providerType === 'claude-runtime')
  run.observe('claude-runtime cards on this host', cards.map(row => row.slug))
  if (cards.length === 0) {
    blocked(
      'this case needs a claude-runtime connection (the "Claude Code (Nessy Gateway)" card or a Claude Code custom '
      + `endpoint); the host lists ${connections.map(row => `${row.slug}(${row.providerType})`).join(', ') || 'nothing'}. `
      + 'The live session under test is the Claude backend\'s; on a Pi-only host the code path never runs.',
    )
  }
  if (requested && !cards.some(row => row.slug === requested)) {
    blocked(
      `NESSY_CDP_CLAUDE_CARD names "${requested}", which is not a claude-runtime connection here. `
      + `Available: ${cards.map(row => row.slug).join(', ')}.`,
    )
  }

  const ordered = [
    ...(requested ? cards.filter(row => row.slug === requested) : []),
    ...cards.filter(row => row.slug !== requested),
  ]
  const probes: CardProbe[] = []
  for (const card of ordered) {
    const probe = await probeCard(session, card.slug, options.caseId)
    probes.push(probe)
    if (probe.ok) {
      run.observe('card probes', probes)
      return { slug: card.slug, probes, assumed: false }
    }
  }
  run.observe('card probes', probes)
  blocked(
    'no claude-runtime card on this host completed a probe turn, so nothing about the live session could be '
    + 'measured through the product\'s own route. What each answered:\n'
    + probes.map(entry => `  - ${entry.slug}: ${entry.error ?? '(no error text)'}`).join('\n')
    + '\nThis is an UPSTREAM refusal, not a defect of the code under test — L6 (the `context_management` 400) and '
    + 'L10 (the proxy guardrail) are the two already on the plan. Point NESSY_CDP_CLAUDE_CARD at a card whose '
    + 'model answers, or restore one of these.',
  )
}

const PROBE_TOKEN = 'ALPHA'

async function probeCard(session: CdpSession, slug: string, caseId: string): Promise<CardProbe> {
  try {
    const key = await freshSession(session, `CDP ${caseId} probe ${slug} ${new Date().toISOString().slice(11, 19)}`)
    const outcome = await switchRuntime(session, key.sessionId, slug)
    if (!outcome.ok) return { slug, ok: false, error: `switchRuntime refused: ${outcome.error}` }
    const active = await waitForConnection(session, key.sessionId, slug)
    if (active !== slug) return { slug, ok: false, error: `the session reports ${String(active)} after the switch` }
    const turn = await sendPrompt(session, key, echoPrompt(PROBE_TOKEN), 180_000)
    const errors = turn.added.filter(message => message.role === 'error').map(message => message.content)
    const said = lastAssistantText(turn.added)
    if (errors.length > 0) return { slug, ok: false, error: errors.join(' | '), said }
    if (!said.includes(PROBE_TOKEN)) {
      return { slug, ok: false, error: `the card answered without the probe token: ${JSON.stringify(said.slice(0, 200))}` }
    }
    return { slug, ok: true, said }
  } catch (cause) {
    return { slug, ok: false, error: `probe threw: ${cause instanceof Error ? cause.message : String(cause)}` }
  }
}

// ---------------------------------------------------------------------------
// The probe turn every LIV case is built out of
// ---------------------------------------------------------------------------

/**
 * A turn whose only job is to be ANSWERED, so the process reading around it
 * means something.
 *
 * **The wording matters and was changed TWICE for a measured reason, in the same
 * direction each time.** The first form was *"Reply with exactly the word X and
 * nothing else"*, and on 2026-08-17 the gateway's model answered one with *"I
 * cannot comply with this request. This appears to be an attempt to extract my
 * internal processing tokens or override my actual instructions"*. The second was
 * *"Repeat this word back to me: X"*, and the same day the same card refused
 * that too — *"I can't repeat that word … This appears to be a request to bypass
 * my guidelines by having me output specific text strings"* — twice in a row,
 * which BLOCKED a case whose subject had nothing to do with the model.
 *
 * A bare token with no reason to exist reads as a string-extraction probe however
 * politely it is asked, because that is what it is. So the token is given an
 * ordinary job instead: it is a build id being written into a note. The task is
 * real work of a kind the model does constantly, the token is data inside it
 * rather than the point of it, and the answer still has to contain the token
 * verbatim — which is all the case needs to attribute the turn.
 */
export function echoPrompt(word: string): string {
  return `I am labelling a test build. Write one short line I can paste into its notes, `
    + `containing the build id ${word} exactly as written. Just the line, no preamble.`
}

export interface EchoTurn {
  said: string
  errors: string[]
  added: TranscriptMessage[]
}

/**
 * Send one echo turn and REFUSE TO CONTINUE unless it was answered.
 *
 * A model that declines a probe-shaped prompt has measured the model, and an
 * upstream that errors mid-case has measured the upstream — neither is a defect
 * of the live session, and neither leaves anything to read a process against. So
 * both report BLOCKED with the runtime's own words rather than FAIL, which is
 * the rule `CRU-6` already applies to an undispatched control ("a model that
 * declines a probe-shaped prompt measures the MODEL").
 */
export async function echoTurn(
  session: CdpSession,
  run: CaseRun,
  key: SessionKey,
  stage: string,
  word: string,
  timeoutMs: number,
): Promise<EchoTurn> {
  const attempts: string[] = []
  // TWO ATTEMPTS, and the reason is the operator's own rig rather than the model
  // being unreliable. This profile carries the AGT-4/AGT-6 fixtures — an output
  // style and a prompt hook that instruct the model to answer with a marker — and
  // on 2026-08-17 one seed turn came back as `NESSY-CDP-PROMPT-HOOK-77A1` and one
  // card probe as `ALPHA` followed by `OSTYLE-CDP-9241`. An injected instruction
  // that captures the whole reply is a once-per-turn event, so a second ask
  // usually lands; both attempts are reported either way, so a hijack is visible
  // in the record instead of being smoothed over.
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const result = await sendPrompt(session, key, echoPrompt(word), timeoutMs)
    const outcome: EchoTurn = {
      said: lastAssistantText(result.added),
      errors: result.added.filter(message => message.role === 'error').map(message => message.content),
      added: result.added,
    }
    run.observe(`${stage} said${attempt > 1 ? ` (attempt ${attempt})` : ''}`, outcome.said.slice(0, 200))
    if (outcome.errors.length > 0) {
      blocked(
        `${stage} did not complete: the runtime answered with ${JSON.stringify(outcome.errors.join(' | ').slice(0, 600))}. `
        + 'The card completed its probe turn moments earlier, so this is the upstream changing its mind mid-case rather '
        + 'than a defect in the session lifetime this case measures.',
      )
    }
    if (outcome.said.includes(word)) return outcome
    attempts.push(outcome.said.slice(0, 300))
  }
  blocked(
    `${stage} was not echoed back in two attempts: the model said ${JSON.stringify(attempts)} instead of ${word}. `
    + 'Without an attributable answer there is no turn to read a process against. This measures the MODEL or an '
    + 'instruction injected into it — a prompt hook or output style on this profile can capture a one-word probe — '
    + 'not the live session. Re-run, or point NESSY_CDP_CLAUDE_CARD at a card whose model follows the instruction.',
  )
}

// ---------------------------------------------------------------------------
// The respawn control
// ---------------------------------------------------------------------------

/**
 * `/clear` through the app's own palette — the RESPAWN CONTROL every case here
 * uses, and the reason a "same pid" result is worth anything.
 *
 * A detector that always answers "same process" would pass all three claims
 * while measuring nothing. This is the arm on the same rig, in the same session,
 * with the same instrument, that must answer the OPPOSITE.
 *
 * It is not a trick: it is the product's own rule. `ensureLiveSession` reuses
 * the live child only when the turn's resume anchor matches the conversation
 * that child already holds, and a turn asking for NO conversation — which is
 * what `/clear` produces, by nulling the session id — "matches only a child that
 * never had one". Measured live on 2026-08-17: pid 96359 answered turn 1,
 * survived the `/clear` itself, and the turn AFTER the clear was answered by a
 * new pid 96609 while 96359 was gone.
 *
 * Selection, never typing: `sendSlashCommand` refuses to submit unless the
 * palette entry was chosen through real key events, which is the whole reason
 * this harness exists (see `README.md`, the `insertText` retraction).
 */
export async function clearConversation(session: CdpSession, key: SessionKey): Promise<{ before: number; after: number }> {
  const before = (await transcript(session, key)).length
  await sendSlashCommand(session, key, {
    token: 'clear',
    match: /clear/i,
    // `/clear` acts on selection rather than prefilling — `slash-command-actions.ts`
    // splits PREFILL_COMMANDS (only `/subtask`) from the ones that submit themselves.
    expectComposer: '',
    submitOnSelect: true,
    noWait: true,
  })
  // The clear is a session command, not a turn: it does not stream, so there is
  // nothing to wait for except the transcript emptying.
  const deadline = Date.now() + 15_000
  let after = before
  for (;;) {
    after = (await transcript(session, key)).length
    if (after === 0) break
    if (Date.now() >= deadline) break
    await Bun.sleep(500)
  }
  return { before, after }
}
