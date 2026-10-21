/**
 * CRU-6 — an agent that declares worktree isolation gets one on Claude.
 *
 * ⚠️  THIS CASE WRITES FILES IN A REAL PROJECT, and it is built around that.
 * The isolation claim is a claim about WHERE FILES GET WRITTEN, so it cannot be
 * measured in a fixture the SDK would refuse anyway (it will not create a
 * worktree outside a git repository). The safeguards are:
 *
 *   - both arms write ONE file each, at a repo-root-relative path named
 *     `nessy-cdp-cru-6-<arm>-<stamp>.txt` — unique per run, unmistakable in a
 *     `git status`, and impossible to confuse with a project file;
 *   - the project's TRACKED files are recorded before the run and asserted
 *     unchanged after it, so a run that touched real source is a FAIL rather
 *     than a surprise;
 *   - the control file — the one deliberately written into the operator's own
 *     checkout — is removed at the end, and only after three guards agree it is
 *     the file this run created and that git considers it untracked. Its content
 *     is read into the report first, so deleting it destroys no evidence;
 *   - the copy inside the worktree is left alone. That directory belongs to the
 *     runtime, not to this case, and pruning someone's worktrees is the
 *     operator's call.
 *
 * WHAT WOULD HAVE BEEN MISSED WITHOUT IT. Translating one of our agent
 * definitions for the SDK passed ten fields and dropped five, and `isolation`
 * was one of the two whose drop had a reason recorded nowhere. So an agent whose
 * author wrote `isolation: worktree` — "give me my own copy of the repository" —
 * ran directly in the user's working directory on this runtime, wrote into their
 * live checkout, and nothing said so. That is not a quality-of-answer gap like
 * R10's skills; it decides where files land. `0b937acb2` forwards the field,
 * which the pinned SDK accepts even though its published typings do not declare
 * it (`sub-agents.md` lists `isolation` among the fields the agents JSON takes,
 * and the pinned native binary's own schema carries
 * `isolation: enum(["worktree","remote"])` and forwards it).
 *
 * ## The premise this case had to correct before it could assert anything
 *
 * "The write landed OUTSIDE the project's own checkout" is the right claim and
 * the wrong PATH TEST on this runtime. Our Pi lease service puts a worktree at
 * `<dirname(repo)>/.nessy-worktrees/<slug>/<leaseId>` — genuinely outside the
 * project directory — but the Claude SDK creates its own at
 * `<repo>/.claude/worktrees/<name>`, which is INSIDE it. Read out of the pinned
 * binary's own strings: *"Switching from this session is limited to worktrees
 * managed by Claude Code (created under .claude/worktrees/ of this repository)"*,
 * plus a symlink guard naming `.claude`, `.claude/worktrees` and
 * `.claude/worktrees/<name>`. A case asserting "not under the project directory"
 * would therefore FAIL a correctly isolated Claude agent.
 *
 * So the test is on the CHECKOUT, not on the directory: the file must not be at
 * `<project>/<name>` — the path the agent was asked to write, resolved against
 * the main working tree — and it must be inside a DIFFERENT git worktree of the
 * same repository. `git worktree list` is the enumerator because it is
 * authoritative for both layouts and needs no knowledge of either.
 *
 * ## THE CONTROL — something on the same rig that must produce the OPPOSITE
 *
 * An absence proves nothing on its own: "no file in the project" is equally true
 * of an agent that was isolated, an agent whose write was denied, and an agent
 * that never called a tool. So the control arm runs FIRST and writes the same
 * kind of file through an agent that declares NO isolation
 * (`NESSY_CDP_PLAIN_AGENT`), or through the session's own main agent when the
 * operator names none. Its file MUST appear at `<project>/<name>` — that is the
 * proof that this rig, this project binding, this permission mode and this
 * prompt all permit a write to land in the checkout. Only then does the isolated
 * arm's absence there mean isolation.
 *
 * ## The confound that would have made a broken build look fixed
 *
 * `isolation` has a SECOND channel and it OUTRANKS the definition: the Agent
 * tool's own input carries it (`sdk-tools.d.ts`, `AgentInput.isolation`), and
 * the binary resolves the pair call-site-first (`j = s ?? U.isolation`). A model
 * that passed `isolation: "worktree"` itself would produce a perfect result on a
 * build that still dropped the author's declaration. So the tool input is read
 * and the run is BLOCKED — not passed — if either arm carries it.
 *
 * ## Preconditions the harness will not create for itself
 *
 * Installing an agent, and TRUSTING a real repository, are both the operator's
 * decisions. `trustFixtureProject` exists for a three-file fixture with nothing
 * to grant; this case binds a real checkout, so it only DETECTS the gate and
 * reports BLOCKED with the path the dialog is asking about.
 */

import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

import { bundleFiles, resolveAppUnderTest, symbolsIn } from '../lib/bundle.ts'
import { lastAssistantText, sendPrompt } from '../lib/chat.ts'
import type { CdpSession } from '../lib/connect.ts'
import { ensureDarkTheme } from '../lib/mcp-fixture.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import { bindWorkingDirectory, listConnections, switchRuntime, TRUST_GATE_HEADING_IN_PAGE, waitForConnection } from '../lib/runtime-switch.ts'
import {
  assertElectronApi,
  freshSession,
  listSessions,
  setPermissionMode,
  transcript,
  waitFor,
  type FreshSession,
  type TranscriptMessage,
} from '../lib/state.ts'

const ID = 'CRU-6'
const TITLE = 'An agent that declares worktree isolation writes outside the checkout on Claude; one that does not writes inside it'

/** An INSTALLED agent whose definition frontmatter carries `isolation: worktree`. */
const ISOLATED_AGENT = process.env.NESSY_CDP_ISOLATED_AGENT?.trim()
/** The control: an installed agent that declares NO isolation. Optional. */
const PLAIN_AGENT = process.env.NESSY_CDP_PLAIN_AGENT?.trim()
/** The real project the session is bound to. The operator's rig by default. */
const PROJECT_DIR = resolve(process.env.NESSY_CDP_PROJECT_DIR?.trim() || '/Users/i.i.gavrikov/Desktop/react-ui-kit')

/**
 * A string literal from `0b937acb2`, the commit that forwards `isolation`.
 *
 * Honest about what it proves: the forwarding itself is
 * `...(descriptor.isolation ? { isolation: descriptor.isolation } : {})`, which
 * leaves no searchable literal in a bundle. This sentence is the R12 hooks
 * banner shipped in the SAME commit, so its presence dates the bundle at or
 * after the fix — it is a date stamp, not a proof of the line.
 */
const R12_SYMBOLS = ['declares hooks in its definition']

/** Unique per run: the file names are also the guard on the cleanup. */
const STAMP = `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`
const ISOLATED_FILE = `nessy-cdp-cru-6-isolated-${STAMP}.txt`
const CONTROL_FILE = `nessy-cdp-cru-6-control-${STAMP}.txt`
const CONTENT_TOKEN = `CRU6-${STAMP.toUpperCase()}`
/** Every artifact this case may delete is named with this prefix, and only these. */
const ARTIFACT_PREFIX = 'nessy-cdp-cru-6-'

// ---------------------------------------------------------------------------
// git, read through the repository itself rather than through path guesses
// ---------------------------------------------------------------------------

interface GitResult {
  ok: boolean
  out: string
  error?: string
}

function git(cwd: string, args: readonly string[]): GitResult {
  try {
    const out = execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { ok: true, out: out.trim() }
  } catch (error) {
    return { ok: false, out: '', error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Every worktree of this repository, main one included, in git's own words.
 *
 * `git worktree list --porcelain` rather than a directory scan: it answers for
 * BOTH layouts (`.claude/worktrees/<name>` for the SDK,
 * `.nessy-worktrees/<slug>/<lease>` for Pi) without this case having to know
 * either, and it is the same registry the SDK writes into when it creates one.
 */
function worktreePaths(project: string): string[] {
  const result = git(project, ['worktree', 'list', '--porcelain'])
  if (!result.ok) return []
  return result.out
    .split('\n')
    .filter(line => line.startsWith('worktree '))
    .map(line => resolve(line.slice('worktree '.length).trim()))
}

/** Porcelain lines for TRACKED changes — untracked (`??`) entries excluded. */
function trackedChanges(project: string): string[] {
  const result = git(project, ['status', '--porcelain'])
  if (!result.ok) return [`git-status-failed: ${result.error ?? 'unknown'}`]
  return result.out.split('\n').filter(line => line.trim() && !line.startsWith('??')).sort()
}

/** Porcelain `??` lines — what this run ADDED, for the report. */
function untrackedEntries(project: string): string[] {
  const result = git(project, ['status', '--porcelain'])
  if (!result.ok) return []
  return result.out.split('\n').filter(line => line.startsWith('??')).map(line => line.slice(3).trim()).sort()
}

/**
 * Find one exact file name under a set of roots.
 *
 * Bounded and skip-listed: a worktree is a full checkout, and a naive walk of
 * several of them is minutes of I/O. Depth 3 covers a file written at the
 * worktree root (what the prompt asks for) and a couple of levels of a model
 * choosing its own subdirectory.
 */
function findFile(roots: readonly string[], name: string, maxDepth = 3): string[] {
  const skip = new Set(['.git', 'node_modules', '.cache', 'dist', 'build', '.next', 'vendor'])
  const hits: string[] = []
  const walk = (dir: string, depth: number): void => {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      const child = join(dir, entry)
      let isDirectory = false
      try {
        isDirectory = statSync(child).isDirectory()
      } catch {
        continue
      }
      if (isDirectory) {
        if (depth < maxDepth && !skip.has(entry)) walk(child, depth + 1)
        continue
      }
      if (entry === name) hits.push(child)
    }
  }
  for (const root of roots) {
    if (existsSync(root)) walk(root, 0)
  }
  return [...new Set(hits)]
}

/** File content, or `undefined` when there is no readable file there. */
function safeRead(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8').slice(0, 200)
  } catch {
    return undefined
  }
}

/**
 * Delete one artifact THIS RUN created in the operator's checkout.
 *
 * Three guards, because the directory is a real repository: the name must carry
 * this case's prefix and be exactly the one generated above; the path must be a
 * plain file directly in the project root; and git must NOT track it. Any
 * disagreement leaves the file in place and says so — a case that guesses while
 * deleting in someone's repo is worse than a case that litters.
 *
 * The tracked test is `ls-files --error-unmatch`, not `status --porcelain`'s
 * `??` line. They differ on exactly the case that matters: a repository whose
 * `.gitignore` covers `*.txt` reports NO status line for this file, and a guard
 * reading emptiness as "not untracked" would then refuse to clean up forever.
 * "Is it a file this project tracks" is the property the guard is actually
 * about, and it is one command that answers it directly (exit 0 tracked, 1 not —
 * verified on this rig).
 */
function removeArtifact(project: string, name: string): { status: 'removed' | 'left' | 'absent'; reason?: string } {
  if (!name.startsWith(ARTIFACT_PREFIX)) return { status: 'left', reason: `refusing to delete ${name}: not this case's artifact prefix` }
  const path = join(project, name)
  if (!existsSync(path)) return { status: 'absent' }
  try {
    if (!statSync(path).isFile()) return { status: 'left', reason: `${path} is not a plain file` }
  } catch (error) {
    return { status: 'left', reason: `could not stat ${path}: ${String(error)}` }
  }
  const tracked = git(project, ['ls-files', '--error-unmatch', '--', name])
  if (tracked.ok) {
    return { status: 'left', reason: `${name} is a TRACKED file in this repository — refusing to delete it` }
  }
  try {
    unlinkSync(path)
    return { status: 'removed' }
  } catch (error) {
    return { status: 'left', reason: `unlink failed: ${String(error)}` }
  }
}

// ---------------------------------------------------------------------------
// the Agent tool, read the way AGT-1 learned to read a delegation
// ---------------------------------------------------------------------------

interface SubagentCall {
  subagentType?: string
  prompt: string
  /** `AgentInput.isolation` — the CALL-SITE channel, which outranks the definition. */
  isolation?: string
  inputJson: string
  result: string
  status?: string
}

function subagentCalls(messages: readonly TranscriptMessage[]): SubagentCall[] {
  const calls: SubagentCall[] = []
  for (const message of messages) {
    if (message.role !== 'tool') continue
    const input = message.toolInput ?? {}
    const named = /^(agent|task|subagent)$/i.test(message.toolName ?? '')
    if (!named && typeof input.subagent_type !== 'string') continue
    calls.push({
      subagentType: typeof input.subagent_type === 'string' ? input.subagent_type : undefined,
      prompt: typeof input.prompt === 'string' ? input.prompt : '',
      isolation: typeof input.isolation === 'string' ? input.isolation : undefined,
      inputJson: JSON.stringify(input),
      result: message.toolResult ?? '',
      status: message.toolStatus,
    })
  }
  return calls
}

/** `plugin:acme:agent:writer` and `writer` are the same agent to a user. */
function shortName(value: string): string {
  const tail = value.split(/[:/]/).pop() ?? value
  return tail.trim().toLowerCase()
}

/** The write task, worded so nothing in it can decide the outcome. */
function writeTask(fileName: string): string {
  return `Create a new file named ${fileName} in your current working directory, containing exactly one line: `
    + `${CONTENT_TOKEN}. Use a relative path, never an absolute one. Then reply with the absolute path you wrote.`
}

/**
 * Delegate the write. One line — the composer types real key events and a
 * newline is a submit.
 *
 * "pass no other arguments" is not politeness: `AgentInput.isolation` outranks
 * the agent definition, so a prompt that invites extra arguments invites the
 * exact confound this case checks for. The instruction reduces it; the assertion
 * on the recorded input is what actually rules it out.
 */
function delegationPrompt(agent: string, fileName: string): string {
  return 'This is an authorized live test on my own machine. '
    + `Delegate one task to the ${agent} subagent: call the Agent tool with subagent_type "${agent}" and `
    + 'run_in_background false, pass ONLY the quoted task as its prompt, and pass no other arguments. '
    + `The task is: '${writeTask(fileName)}' `
    + "Then reply with the subagent's answer verbatim."
}

interface ArmOutcome {
  /** The delegation, when the arm went through a subagent. */
  call?: SubagentCall
  calls: SubagentCall[]
  parentText: string
}

async function runArm(
  run: CaseRun,
  session: CdpSession,
  label: string,
  key: FreshSession,
  agent: string | undefined,
  fileName: string,
): Promise<ArmOutcome> {
  const prompt = agent ? delegationPrompt(agent, fileName) : `This is an authorized live test on my own machine. ${writeTask(fileName)}`
  const turn = await sendPrompt(session, key, prompt, 300_000).catch(() => undefined)
  const parentText = turn ? lastAssistantText(turn.added) : ''
  run.observe(`${label}: reply`, parentText.slice(0, 300) || '(the turn did not complete inside its timeout)')

  if (!agent) return { calls: [], parentText }

  const call = await waitFor(
    async () => subagentCalls(await transcript(session, key))
      .filter(entry => entry.subagentType && shortName(entry.subagentType) === shortName(agent))
      .find(entry => entry.result.trim().length > 0),
    value => value !== undefined,
    { timeoutMs: 240_000, intervalMs: 5_000, label: `the ${agent} subagent to return a result` },
  ).catch(() => undefined)

  const calls = subagentCalls(await transcript(session, key))
  run.observe(`${label}: subagent calls`, calls.map(entry => ({
    subagentType: entry.subagentType,
    isolation: entry.isolation,
    status: entry.status,
    resultChars: entry.result.length,
  })))
  if (call) run.observe(`${label}: subagent answer`, call.result.slice(0, 300))
  return { ...(call ? { call } : {}), calls, parentText }
}

/**
 * Refuse to continue while the app's "Trust this folder?" gate is up.
 *
 * `waitMs > 0` waits for it to APPEAR (the modal is raised asynchronously after
 * a bind); `0` is a single read for the second look. Detecting only — the
 * harness answers the gate for the three-file RTS fixture and for nothing else,
 * and this case binds a real repository, where trust grants project
 * instructions, skills, agents, MCP servers, hooks and memory the right to run.
 */
async function requireNoTrustGate(session: CdpSession, waitMs: number): Promise<void> {
  const gate = waitMs > 0
    ? await waitFor(
      () => trustGate(session),
      value => value.up,
      { timeoutMs: waitMs, intervalMs: 500, label: 'the trust gate to appear' },
    ).catch(() => ({ up: false } as { up: boolean; path?: string }))
    : await trustGate(session)
  if (!gate.up) return
  blocked(
    `the app is asking whether to trust ${gate.path ?? PROJECT_DIR}, and this case will not answer it. Trust grants `
    + 'project instructions, skills, agents, MCP servers, hooks and memory the right to run from that folder — for a '
    + 'REAL repository that is the operator\'s decision, made in the app by hand. Grant it once, then re-run. '
    + '(While the modal is up the composer cannot be focused, so continuing would fail at the first keystroke with a '
    + 'message that never mentions a dialog.)',
  )
}

/** Is the app's "Trust this folder?" gate up — READ ONLY, never answered here. */
async function trustGate(session: CdpSession): Promise<{ up: boolean; path?: string }> {
  return session.call<{ up: boolean; path?: string }>(`
    const heading = Array.from(document.querySelectorAll('h1,h2,h3,[role="heading"]'))
      .find(${TRUST_GATE_HEADING_IN_PAGE})
    if (!heading) return { up: false }
    const root = heading.closest('[role="dialog"]') ?? heading.parentElement?.parentElement ?? document.body
    const field = root.querySelector('input,code,pre,[class*="path"]')
    const text = field ? (field.value ?? field.textContent ?? '') : ''
    return { up: true, path: String(text).trim() }
  `).catch(() => ({ up: false }))
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)
  run.observe('theme', await ensureDarkTheme(session))

  // ---- 0. is this build the one that carries R12 ---------------------------
  const app = resolveAppUnderTest(session)
  const bundles = bundleFiles(app)
  const symbols = symbolsIn(bundles.main, R12_SYMBOLS)
  run.observe('app-under-test', { kind: app.kind, appRoot: app.appRoot, via: app.via })
  run.observe('host-bundle', { path: symbols.path, modified: bundles.main.modifiedMs, counts: symbols.counts })
  if (symbols.missing.length > 0) {
    blocked(
      `the host bundle at ${symbols.path} does not carry ${symbols.missing.join(', ')}, so it predates 0b937acb2 — `
      + 'a run against it measures the build that dropped the declaration and reports the drop as today\'s behaviour. '
      + 'Rebuild (`bun run electron:build:servers`) and relaunch the app before measuring.',
    )
  }

  // ---- 1. the preconditions the harness will not invent ---------------------
  if (!ISOLATED_AGENT) {
    blocked(
      'this case needs an INSTALLED agent whose definition declares worktree isolation, and it will not install one — '
      + 'agents are the operator\'s live configuration. Set NESSY_CDP_ISOLATED_AGENT to the name the model invokes for '
      + 'an agent whose frontmatter carries `isolation: worktree` (a markdown definition in <configDir>/agents/, '
      + '<project>/.nessy-agent/agents/, or a plugin-provided agent), and give it a tool grant that can write a file. '
      + 'Optionally set NESSY_CDP_PLAIN_AGENT to an installed agent that declares NO isolation; without it the control '
      + 'is the session\'s own main agent, which is a weaker but still real contrast (recorded in the result).',
    )
  }

  if (!existsSync(PROJECT_DIR)) {
    blocked(`no directory at ${PROJECT_DIR} — set NESSY_CDP_PROJECT_DIR to a real git checkout this case may write one file into`)
  }
  const insideWorkTree = git(PROJECT_DIR, ['rev-parse', '--is-inside-work-tree'])
  if (!insideWorkTree.ok || insideWorkTree.out !== 'true') {
    blocked(
      `${PROJECT_DIR} is not a git working tree (${insideWorkTree.error ?? (insideWorkTree.out || 'no output')}). `
      + 'The SDK refuses to create a worktree outside git, so an agent declaring isolation would fail to launch and '
      + 'this run would score the refusal rather than the isolation.',
    )
  }

  // ---- 2. the project's pre-state, recorded before anything is driven -------
  const trackedBefore = trackedChanges(PROJECT_DIR)
  const untrackedBefore = untrackedEntries(PROJECT_DIR)
  const worktreesBefore = worktreePaths(PROJECT_DIR)
  run.observe('project', PROJECT_DIR)
  run.observe('tracked changes before', trackedBefore)
  run.observe('worktrees before', worktreesBefore)
  run.observe('artifact names', { isolated: ISOLATED_FILE, control: CONTROL_FILE, token: CONTENT_TOKEN })
  if (existsSync(join(PROJECT_DIR, ISOLATED_FILE)) || existsSync(join(PROJECT_DIR, CONTROL_FILE))) {
    blocked(`an artifact of this run's own name already exists in ${PROJECT_DIR} — refusing to measure over it`)
  }

  // ---- 3. the runtime under test -------------------------------------------
  const connections = await listConnections(session)
  run.observe('connections', connections.map(c => `${c.slug}(${c.providerType})`))
  // The operator may name the card, and on this host they should. The first
  // claude-runtime connection is the gateway one, whose model does not reliably
  // finish a DELEGATED turn: measured twice on 2026-08-17, the subagent is
  // recorded as `executing` with an empty result and never returns inside the
  // 300 s arm timeout, so the case blocked without a verdict both times. That is
  // the model, not the runtime — the same card answers ordinary turns fine — and
  // the field under test is carried identically by every claude-runtime card.
  // Point this at one whose model completes a delegation (`NESSY_CDP_CLAUDE_CARD`).
  const requestedCard = process.env.NESSY_CDP_CLAUDE_CARD?.trim()
  const claudeCards = connections.filter(c => c.providerType === 'claude-runtime')
  const claude = requestedCard
    ? claudeCards.find(c => c.slug === requestedCard)
    : claudeCards[0]
  if (!claude) {
    blocked(
      requestedCard
        ? `NESSY_CDP_CLAUDE_CARD names "${requestedCard}", which is not a claude-runtime connection on this host. `
          + `Available: ${claudeCards.map(c => c.slug).join(', ') || 'none'}.`
        : 'this case needs a claude-runtime connection (the "Claude Code (Nessy Gateway)" card); this host lists '
          + `${connections.map(c => `${c.slug}(${c.providerType})`).join(', ') || 'nothing'}. `
          + 'The dropped field was Claude-only, so on a Pi-only host the code path under test never runs.',
    )
  }
  run.observe('claude card under test', `${claude.slug}${requestedCard ? ' (operator-named)' : ' (first claude-runtime card)'}`)

  const key = await freshSession(session, `CDP ${ID} ${new Date().toISOString().slice(11, 19)}`)
  run.observe('session', { sessionId: key.sessionId, fresh: key.fresh, reason: key.reason })
  run.require('the case ran in a session it created', key.fresh,
    key.fresh ? undefined : `inherited ${key.inheritedMessages} messages — a case that writes files must not inherit someone else's cwd`)

  const outcome = await switchRuntime(session, key.sessionId, claude.slug)
  run.observe('switch onto claude', outcome)
  const active = await waitForConnection(session, key.sessionId, claude.slug)
  run.require(`the session runs on ${claude.slug}`, active === claude.slug, `llmConnection=${String(active)}`)

  // ---- 4. bind the real project, and refuse to answer its trust gate --------
  // F1.182 — STARTED, not awaited: this case refuses to answer the gate (it
  // requires the project to be trusted ALREADY), so awaiting the mutation would
  // wait on a modal nothing here will click. The gate is checked while it is in
  // flight and the verdict is the session's own field, polled.
  //
  // The modal is raised ASYNCHRONOUSLY after the bind, so one immediate read
  // races it — the same trap `trustFixtureProject` records. And while it is up
  // the composer is not focusable, so a case that proceeds fails at its first
  // keystroke with `composer-not-focusable`, a message that says nothing about a
  // dialog. Wait for it, then check once more after the mode is set.
  const binding = bindWorkingDirectory(session, key.sessionId, PROJECT_DIR, { timeoutMs: 20_000, attempts: 1 })
  await requireNoTrustGate(session, 12_000)
  const bound = await binding
  run.require('the session is bound to the project', bound.bound, bound.reason ?? bound.reported)

  // Writes have to be permitted for either arm to say anything. `acceptEdits`
  // translates to the SDK's own `acceptEdits` — "File edits and filesystem
  // operations are automatically approved" — so no permission card can silently
  // turn this case into a 300-second wait.
  await setPermissionMode(session, key.sessionId, 'acceptEdits')
  const mode = await waitFor(
    async () => (await listSessions(session)).find(s => s.id === key.sessionId)?.permissionMode,
    value => value === 'acceptEdits',
    { timeoutMs: 20_000, intervalMs: 1_000, label: 'acceptEdits to take effect' },
  ).catch(() => undefined)
  run.require('the session can write before either arm runs', mode === 'acceptEdits', `permissionMode=${String(mode)}`)
  await requireNoTrustGate(session, 0)

  try {
    // ---- 5. THE CONTROL, first ---------------------------------------------
    // First because it establishes that a write CAN land in the checkout. Run
    // second, a rig that silently refuses every write would let the isolated
    // arm's absence read as isolation.
    run.observe('control arm', PLAIN_AGENT
      ? `${PLAIN_AGENT} — an installed agent that declares no isolation`
      : "the session's own main agent — no NESSY_CDP_PLAIN_AGENT was set, so the contrast is agent-vs-subagent as well as isolated-vs-not")
    const controlArm = await runArm(run, session, 'control', key, PLAIN_AGENT, CONTROL_FILE)
    if (PLAIN_AGENT) {
      if (!controlArm.call) {
        // BLOCKED, not FAIL: a model that declines a probe-shaped prompt or does
        // the work itself measures the MODEL (AGENT-INSTALL's route fact 4), and
        // an unestablished control is a run that could not measure, not a defect.
        blocked(
          `the control never ran: ${PLAIN_AGENT} was never dispatched, so nothing establishes that a write CAN land in `
          + `the checkout. Dispatches seen: ${JSON.stringify(controlArm.calls.map(c => c.subagentType))}. `
          + `The parent said: ${JSON.stringify(controlArm.parentText.slice(0, 200))}.`,
        )
      }
      if (controlArm.call.isolation) {
        blocked(
          `the control is VOID: the model passed isolation "${controlArm.call.isolation}" on the Agent call itself, so the `
          + 'control agent got a worktree too and cannot show that the checkout is writable.',
        )
      }
    }
    const controlPath = join(PROJECT_DIR, CONTROL_FILE)
    const controlLanded = existsSync(controlPath)
    run.observe('control file', { path: controlPath, exists: controlLanded, content: safeRead(controlPath) })
    if (!controlLanded) {
      blocked(
        `the control never wrote ${CONTROL_FILE} into ${PROJECT_DIR}, so this rig has not been shown to permit a write `
        + 'into the checkout at all — and without that, "the isolated agent wrote nothing there" proves nothing. '
        + `The control replied: ${JSON.stringify(controlArm.parentText.slice(0, 200))}`,
      )
    }
    run.check('the control arm wrote into the project checkout — the rig permits it', true, controlPath)

    // ---- 6. the measured arm ------------------------------------------------
    const isolatedArm = await runArm(run, session, 'isolated', key, ISOLATED_AGENT, ISOLATED_FILE)
    if (!isolatedArm.call) {
      // Same two causes as CRU-5's, and they have different fixes: the model may
      // have declined or done the write itself, or the agent may never have been
      // REGISTERED — the CLI parses the whole `agents` record through one
      // `z.record(...)` whose catch returns `[]`, so one malformed entry deletes
      // every agent we sent and leaves no trace the host can see.
      blocked(
        `the ${ISOLATED_AGENT} subagent was never dispatched, so its declared isolation is untested. `
        + `Dispatches seen: ${JSON.stringify(isolatedArm.calls.map(c => c.subagentType))}. `
        + `The parent said: ${JSON.stringify(isolatedArm.parentText.slice(0, 200))}. `
        + 'A delegation to a DIFFERENT agent would have measured that agent\'s isolation, which is why this refuses '
        + 'rather than scoring whatever ran.',
      )
    }
    const call = isolatedArm.call
    run.observe('isolated: delegated input', call.inputJson.slice(0, 400))
    if (call.isolation) {
      blocked(
        `this run cannot score the claim: the model passed isolation "${call.isolation}" on the Agent call itself. `
        + 'The call site OUTRANKS the definition in the SDK (`j = s ?? U.isolation`), so the worktree below would prove '
        + 'the model asked for one, not that the author\'s declaration was forwarded. Re-run; the prompt already asks '
        + 'for no extra arguments.',
      )
    }

    // ---- 7. where the write landed ------------------------------------------
    const worktreesAfter = worktreePaths(PROJECT_DIR)
    const otherWorktrees = worktreesAfter.filter(path => path !== resolve(PROJECT_DIR))
    run.observe('worktrees after', worktreesAfter)
    run.observe('worktrees this run added', worktreesAfter.filter(path => !worktreesBefore.includes(path)))

    // git's registry is the enumerator; the two known roots are a belt for a
    // copy that was never registered as a worktree at all.
    const extraRoots = [
      join(PROJECT_DIR, '.claude', 'worktrees'),
      join(dirname(PROJECT_DIR), '.nessy-worktrees', basename(PROJECT_DIR)),
    ]
    const inProject = existsSync(join(PROJECT_DIR, ISOLATED_FILE))
    const elsewhere = findFile([...otherWorktrees, ...extraRoots], ISOLATED_FILE)
      .filter(path => path !== join(PROJECT_DIR, ISOLATED_FILE))
    run.observe('isolated file in the main checkout', inProject ? join(PROJECT_DIR, ISOLATED_FILE) : false)
    run.observe('isolated file elsewhere', elsewhere)

    if (!inProject && elsewhere.length === 0) {
      blocked(
        `${ISOLATED_FILE} is nowhere: not in ${PROJECT_DIR} and not in any other worktree of it. A write that never `
        + 'happened is indistinguishable from an isolated one, so this run cannot score the claim. What the subagent '
        + `returned: ${JSON.stringify(call.result.slice(0, 300))}. What the parent said: `
        + `${JSON.stringify(isolatedArm.parentText.slice(0, 200))}. Two causes to separate before reading anything into `
        + "it: the agent's own tool grant may not include a write tool at all, and our PreToolUse gate may have refused "
        + 'the path it tried.',
      )
    }

    run.check(
      `the ${ISOLATED_AGENT} subagent did NOT write into the project's own checkout`,
      !inProject,
      inProject
        ? `${join(PROJECT_DIR, ISOLATED_FILE)} exists — the author's \`isolation: worktree\` was dropped, and the agent `
          + 'wrote into the user\'s working directory'
        : undefined,
    )
    run.check(
      'it wrote into a separate git worktree of the same repository instead',
      elsewhere.length > 0,
      elsewhere.length > 0
        ? elsewhere.join(', ')
        : 'no copy in any other worktree — the declaration produced no isolated copy of the repository',
    )
    // The token, not merely the name: a file with the right name and someone
    // else's content would be a leftover, and this check is what separates the
    // two. Cheap, and it is the reason the name carries a per-run stamp at all.
    const worktreeCopy = elsewhere[0] ? safeRead(elsewhere[0]) : undefined
    if (elsewhere[0]) {
      run.observe('isolated file content', worktreeCopy)
      run.check(
        'the file in the worktree is the one this run asked for',
        (worktreeCopy ?? '').includes(CONTENT_TOKEN),
        `expected ${CONTENT_TOKEN} in ${elsewhere[0]}`,
      )
    }
  } finally {
    // ---- 8. the project is left as it was found ----------------------------
    // In `finally` so a failed assertion above still returns the checkout. The
    // content is read into the report BEFORE anything is deleted: on the failing
    // branch the stray file IS the evidence, and cleanup must not destroy it.
    run.observe('control artifact content', safeRead(join(PROJECT_DIR, CONTROL_FILE)))
    const stray = safeRead(join(PROJECT_DIR, ISOLATED_FILE))
    if (stray !== undefined) run.observe('isolated artifact found IN THE CHECKOUT, content', stray)
    const removal = removeArtifact(PROJECT_DIR, CONTROL_FILE)
    run.observe('control artifact cleanup', removal)
    const strayIsolated = removeArtifact(PROJECT_DIR, ISOLATED_FILE)
    run.observe('isolated artifact in the checkout, cleanup', strayIsolated)
    const trackedAfter = trackedChanges(PROJECT_DIR)
    const untrackedAfter = untrackedEntries(PROJECT_DIR)
    run.observe('tracked changes after', trackedAfter)
    run.observe('untracked entries this run added', untrackedAfter.filter(entry => !untrackedBefore.includes(entry)))
    run.check(
      "the project's own tracked files are untouched",
      JSON.stringify(trackedAfter) === JSON.stringify(trackedBefore),
      `before=${JSON.stringify(trackedBefore)} after=${JSON.stringify(trackedAfter)}`,
    )
  }
}

if (import.meta.main) {
  await main(ID, TITLE, drive)
}

export const meta = { id: ID, title: TITLE }
