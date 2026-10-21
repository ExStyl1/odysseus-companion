/**
 * CRU-5 — a Claude subagent receives the skills its definition declares.
 *
 * WHAT WOULD HAVE BEEN MISSED WITHOUT IT. A session-level tool ban removes
 * `Skill` from EVERY context on this runtime, a subagent's included
 * (`CLAUDE_SESSION_DISALLOWED_TOOLS` is `['EnterPlanMode','ExitPlanMode','Skill']`),
 * and until `1e89d224f` we also passed nothing in place of it — the agent
 * definition's `skills:` was dropped on the way to the SDK. So the SAME agent,
 * from the SAME markdown file, was simply weaker on Claude than on Pi, and
 * nothing anywhere said so: no error, no diagnostic, no missing tool the user
 * could point at. The only symptom is an answer that does not follow
 * instructions the author wrote down. That is invisible to every test that does
 * not read what the child actually said.
 *
 * R10 inlines the bodies instead. The SDK's own `AgentDefinition.skills` was
 * REFUSED and the refusal is load-bearing: it resolves names against its own
 * directories — the only one a live session has is `.claude/skills` inside the
 * user's open repository — so a name match would substitute an unvetted repo
 * file for our vetted skill, silently, and its preload carries none of our
 * per-skill `disallowed-tools`, no model/agent ceiling and no invocation budget.
 * `materializeClaudeRuntimeAgentSkills` composes the blocks and
 * `buildClaudeRuntimeAgents` appends one per declared skill to the agent's own
 * prompt.
 *
 * ## What makes this a measurement rather than a vibe
 *
 * - **The claim is scored on what the CHILD returned, never on the parent's
 *   narration.** AGT-1's retraction was exactly this mistake in its Pi form:
 *   `lastAssistantText` returned the parent's own last reply and it read like a
 *   plausible child answer. Here the answer is read off the `Agent` tool's
 *   `toolResult` — the child's own return value, as the parent received it —
 *   and the parent's prose is recorded as evidence with nothing asserted on it.
 * - **The parent must not have fed the marker to the child.** The parent
 *   composes the delegate's prompt, so the `Agent` tool's INPUT is checked for
 *   the marker before the result is scored. Present there means the harness
 *   leaked it and the run is BLOCKED, not passed — AGT-1 pays for this lesson
 *   in its own comments.
 * - **The right agent must actually have been used.** `subagent_type` is read
 *   off the tool input and compared with the agent this case named. A model
 *   that quietly delegated to `general-purpose` instead would otherwise produce
 *   a clean-looking FAIL about skills that were never in play.
 * - **The memory files are scanned.** A marker sitting in a `MEMORY.md` reaches
 *   any child through the prompt, which voids the control; `lib/codeword.ts`'s
 *   scan reads the three files the memory layer actually loads.
 * - **The bundle is checked before anything is measured.** README: a source
 *   change is invisible to a CDP run until the bundles are rebuilt and the app
 *   relaunched, and that cost a real AGT-1 measurement once.
 *
 * ## THE CONTROL — something on the same rig that must produce the OPPOSITE
 *
 * A second subagent that declares NO skill, asked the same question in a
 * session of its own, must NOT produce the marker. Without it this case cannot
 * separate "the skill body arrived in the child's prompt" from three other ways
 * the token could appear: the model guessed it, the parent supplied it, or the
 * child read the skill file off disk with `Read`/`Grep` (it has those tools, and
 * the skill is a file on the very machine it is running on). The control shares
 * the rig, the runtime, the parent prompt and the toolset with the measured arm
 * and differs in ONE thing — the declaration — so a difference in the answers is
 * the declaration. A control that DOES produce the marker makes the run BLOCKED,
 * never PASS and never FAIL: the marker was reachable without the declaration,
 * which is a fact about the marker, not about the product.
 *
 * `NESSY_CDP_PLAIN_AGENT` names it. Absent, the case falls back to the SDK's own
 * built-in `general-purpose` subagent, which by construction carries none of our
 * capability layer's skills; the arm reports which it used.
 *
 * **The Pi runtime is deliberately NOT the control**, and the reason is worth
 * recording because it is the obvious first idea. Pi already inlines an agent's
 * declared skills — that is the baseline this row was catching up to — so a Pi
 * arm produces the SAME result, not the opposite. It would be a parity
 * observation, and a parity observation cannot tell an arriving skill from a
 * guessed token.
 *
 * ## Why not `/subtask` and `lib/fork.ts`
 *
 * They answer a different question. A fork is not a named agent: it carries no
 * agent definition at all (`FORK_AGENT_DEFINITION` has "no prompt, toolset or
 * model of its own"), so it cannot carry a definition's skills, and
 * `forkEntries()` reads `subtask-<agentId>` tool pairs that a named-agent
 * dispatch never writes. What is reused from AGT-1 is its DISCIPLINE — read the
 * tool pair rather than the newest assistant message, and guard the delegate's
 * input against the parent leaking the answer into it — which is the half that
 * made its first run wrong.
 *
 * ## Preconditions the harness will not create for itself
 *
 * Installing an agent or a skill is the operator's live configuration; a case
 * that writes them can break the machine it is measuring (README). Hence three
 * env vars, and BLOCKED naming all three when any is missing.
 */

import { lastAssistantText, sendPrompt } from '../lib/chat.ts'
import type { CdpSession } from '../lib/connect.ts'
import { memoryLeaks } from '../lib/codeword.ts'
import { bundleFiles, resolveAppUnderTest, symbolsIn } from '../lib/bundle.ts'
import { ensureDarkTheme } from '../lib/mcp-fixture.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import { configDir, readClaudeSessionLog } from '../lib/runtime-session-log.ts'
import { listConnections, switchRuntime, waitForConnection } from '../lib/runtime-switch.ts'
import {
  assertElectronApi,
  freshSession,
  listSessions,
  transcript,
  waitFor,
  type FreshSession,
  type TranscriptMessage,
} from '../lib/state.ts'

const ID = 'CRU-5'
const TITLE = 'A Claude subagent carries the skills its definition declares; one that declares none cannot'

/** An INSTALLED agent whose definition frontmatter carries `skills: [...]`. */
const SKILLED_AGENT = process.env.NESSY_CDP_SKILLED_AGENT?.trim()
/** A literal that exists ONLY inside that skill's body. */
const SKILL_MARKER = process.env.NESSY_CDP_SKILL_MARKER?.trim()
/** The question whose only correct answer is the marker. */
const SKILL_QUESTION = process.env.NESSY_CDP_SKILL_QUESTION?.trim()
/** The control: an installed agent that declares NO skills. */
const PLAIN_AGENT = process.env.NESSY_CDP_PLAIN_AGENT?.trim()

/**
 * The SDK's own built-in subagent, used as the control when the operator names
 * no plain agent of their own. It exists in the pinned native binary
 * (`@anthropic-ai/claude-agent-sdk-binary@0.3.218`) and carries none of our
 * capability layer's skills by construction — our `agents` record is additive
 * (`agent-sdk/subagents.md`: programmatic agents override a filesystem agent of
 * the same name), so the built-ins remain exactly as the runtime ships them.
 */
const BUILTIN_CONTROL_AGENT = 'general-purpose'

/**
 * Symbols that must be in the host bundle for this claim to be measurable.
 *
 * One identifier and one string literal, deliberately: an identifier can be
 * renamed by a bundler pass, a string literal cannot, and both come from
 * `1e89d224f` — the commit that wired the materialization into `chatImpl`. A
 * bundle without them is one that predates the fix, and measuring it reports
 * yesterday's code as today's.
 */
const R10_SYMBOLS = ['materializeClaudeRuntimeAgentSkills', 'runtime-agent-skill-unavailable']

interface SubagentCall {
  /** `AgentInput.subagent_type` — which agent the model actually dispatched. */
  subagentType?: string
  /** `AgentInput.prompt` — what the PARENT composed for the child. */
  prompt: string
  /** `AgentInput.run_in_background`; a background call may settle after the turn. */
  background?: boolean
  /** Whole input, so a leak check cannot be defeated by an unexpected field. */
  inputJson: string
  /** `toolResult` — what the child returned. The only surface this case scores. */
  result: string
  status?: string
}

/**
 * Every `Agent`-tool row in a transcript, flattened.
 *
 * Matched on the tool NAME (`Agent`; Claude renamed `Task` → `Agent`, and this
 * repo has already shipped one production bug for missing that rename) OR on
 * the presence of `subagent_type` in the input, so a future rename cannot make
 * this reader silently return nothing — which would look exactly like "the model
 * never delegated".
 */
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
      background: typeof input.run_in_background === 'boolean' ? input.run_in_background : undefined,
      inputJson: JSON.stringify(input),
      result: message.toolResult ?? '',
      status: message.toolStatus,
    })
  }
  return calls
}

/**
 * Compare an agent name the way a user would.
 *
 * The registered name is `agentNameOf(descriptor)` — the descriptor's `name`
 * when it owns the unqualified alias, its capability KEY otherwise — so an
 * operator naming `code-review` and a catalog carrying
 * `plugin:acme:agent:code-review` are talking about the same agent. Compare on
 * the last `:`/`/` segment, case-insensitively.
 */
function shortName(value: string): string {
  const tail = value.split(/[:/]/).pop() ?? value
  return tail.trim().toLowerCase()
}

interface CatalogAgentRow {
  key: string
  logicalName: string
  state: string
  unavailableReason?: string
}

/** The agent rows of the capability catalog, for this session's own context. */
async function catalogAgents(session: CdpSession, key: FreshSession): Promise<CatalogAgentRow[]> {
  return session.call<CatalogAgentRow[]>(`
    const cat = await window.electronAPI.capabilities.getCatalog({
      workspaceId: ${JSON.stringify(key.workspaceId)},
      sessionId: ${JSON.stringify(key.sessionId)},
    })
    return (cat.capabilities ?? [])
      .filter(c => c.kind === 'agent')
      .map(c => ({ key: c.key, logicalName: c.logicalName, state: c.state, unavailableReason: c.unavailableReason }))
  `).catch(() => [])
}

/**
 * One line, because the composer types real key events and a newline in it is a
 * submit. It names the tool and its two arguments explicitly for one reason: a
 * BACKGROUND dispatch is the SDK's documented default ("Agents run in the
 * background by default; you will be notified when one completes. Set to false
 * to run this agent synchronously when you need its result before continuing"),
 * and a background child settles AFTER the parent turn ends — which is the
 * timing that made `waitForTurn` the wrong wait for a fork.
 */
function delegationPrompt(agent: string, question: string): string {
  return 'This is an authorized live test on my own machine. '
    + `Delegate one question to the ${agent} subagent: call the Agent tool with subagent_type "${agent}" `
    + 'and run_in_background false, pass ONLY the quoted question as its prompt, add no context, hints or '
    + 'instructions of your own to it, and do not answer it yourself. '
    + `The question is: "${question}" `
    + "Then reply with the subagent's answer verbatim and nothing else."
}

interface ArmResult {
  key: FreshSession
  calls: SubagentCall[]
  /** The call whose `subagent_type` is the agent this arm named. */
  matched?: SubagentCall
  parentText: string
}

/**
 * One arm: a session of its own, moved onto the Claude card, one delegation.
 *
 * A session per arm, not one session for both. The measured arm's answer lands
 * in its parent's context, so a control run afterwards in the SAME session could
 * be handed the marker by a parent that has just read it — the confound AGT-1
 * names as `control-parent-leaked-into-prompt`. A fresh session has never seen
 * it, so the leak cannot happen rather than being detected after the fact.
 */
async function runArm(
  run: CaseRun,
  session: CdpSession,
  label: string,
  connectionSlug: string,
  agent: string,
  question: string,
): Promise<ArmResult | undefined> {
  const key = await freshSession(session, `CDP ${ID} ${label} ${new Date().toISOString().slice(11, 19)}`)
  run.observe(`${label}: session`, { sessionId: key.sessionId, fresh: key.fresh, reason: key.reason })
  if (!key.fresh) {
    run.check(`${label}: the arm ran in a session it created`, false,
      `${key.reason ?? 'unknown'} — inherited ${key.inheritedMessages} messages, so every read below is of history this case did not plant`)
    return undefined
  }

  const outcome = await switchRuntime(session, key.sessionId, connectionSlug)
  run.observe(`${label}: switch`, outcome)
  const active = await waitForConnection(session, key.sessionId, connectionSlug)
  run.check(`${label}: the session runs on ${connectionSlug}`, active === connectionSlug, `llmConnection=${String(active)}`)
  if (active !== connectionSlug) return undefined

  const turn = await sendPrompt(session, key, delegationPrompt(agent, question), 300_000).catch(() => undefined)
  const parentText = turn ? lastAssistantText(turn.added) : ''
  run.observe(`${label}: parent reply`, parentText.slice(0, 300) || '(the turn did not complete inside its timeout)')

  // Poll rather than read once. A synchronous dispatch has its result by the
  // time the turn ends; a model that ignored `run_in_background false` does not,
  // and reading once would report "the subagent returned nothing" about a child
  // still running.
  const matched = await waitFor(
    async () => subagentCalls(await transcript(session, key))
      .filter(call => call.subagentType && shortName(call.subagentType) === shortName(agent))
      .find(call => call.result.trim().length > 0),
    value => value !== undefined,
    { timeoutMs: 240_000, intervalMs: 5_000, label: `the ${agent} subagent to return a result` },
  ).catch(() => undefined)

  const calls = subagentCalls(await transcript(session, key))
  run.observe(`${label}: subagent calls`, calls.map(call => ({
    subagentType: call.subagentType,
    background: call.background,
    status: call.status,
    resultChars: call.result.length,
  })))
  return { key, calls, ...(matched ? { matched } : {}), parentText }
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)
  run.observe('theme', await ensureDarkTheme(session))

  // ---- 0. is this build the one that carries R10 ---------------------------
  const app = resolveAppUnderTest(session)
  const bundles = bundleFiles(app)
  const symbols = symbolsIn(bundles.main, R10_SYMBOLS)
  run.observe('app-under-test', { kind: app.kind, appRoot: app.appRoot, via: app.via })
  run.observe('host-bundle', { path: symbols.path, modified: bundles.main.modifiedMs, counts: symbols.counts })
  if (symbols.missing.length > 0) {
    blocked(
      `the host bundle at ${symbols.path} does not carry ${symbols.missing.join(', ')}, so it predates 1e89d224f — `
      + 'a run against it measures the code the row replaced and reports it as today\'s. '
      + 'Rebuild (`bun run electron:build:servers`) and relaunch the app before measuring.',
    )
  }

  // ---- 1. the preconditions the harness will not invent ---------------------
  if (!SKILLED_AGENT || !SKILL_MARKER || !SKILL_QUESTION) {
    blocked(
      'this case needs an INSTALLED agent whose definition declares a skill, and it will not install one — an agent, '
      + 'a skill and a plugin are the operator\'s live configuration. Set all three: '
      + 'NESSY_CDP_SKILLED_AGENT = the name the model invokes for an agent whose frontmatter carries `skills: [<skill>]` '
      + '(a markdown definition in <configDir>/agents/, <project>/.nessy-agent/agents/, or a plugin-provided agent); '
      + 'NESSY_CDP_SKILL_MARKER = a literal that appears ONLY inside that skill\'s body — not in the agent\'s own prompt, '
      + 'not in the repository the session can read, and nothing a model could guess; '
      + 'NESSY_CDP_SKILL_QUESTION = the question whose only correct answer is that marker. '
      + `Currently: agent=${SKILLED_AGENT ?? 'unset'}, marker=${SKILL_MARKER ? 'set' : 'unset'}, question=${SKILL_QUESTION ? 'set' : 'unset'}. `
      + 'Optionally set NESSY_CDP_PLAIN_AGENT to an installed agent that declares NO skills; without it the control '
      + `falls back to the SDK's built-in ${BUILTIN_CONTROL_AGENT}. `
      + 'Both artifacts are two markdown files under the config dir, and '
      + '`bun run scripts/cdp/fixtures/agent-surfaces.ts` writes them with a fresh marker and prints this whole '
      + 'invocation. The CASE still installs nothing: it reads what is there and refuses when it is not.',
    )
  }

  // ---- 2. the runtime under test -------------------------------------------
  const connections = await listConnections(session)
  run.observe('connections', connections.map(c => `${c.slug}(${c.providerType})`))
  const claude = connections.find(c => c.providerType === 'claude-runtime')
  if (!claude) {
    blocked(
      'this case needs a claude-runtime connection (the "Claude Code (Nessy Gateway)" card); this host lists '
      + `${connections.map(c => `${c.slug}(${c.providerType})`).join(', ') || 'nothing'}. `
      + 'On a Pi-only host the claim is not merely unmeasured — the code path under test never runs.',
    )
  }
  run.observe('claude connection', { slug: claude.slug, providerType: claude.providerType })

  const controlAgent = PLAIN_AGENT ?? BUILTIN_CONTROL_AGENT
  run.observe('control agent', PLAIN_AGENT
    ? `${PLAIN_AGENT} (operator-named; must declare no skills)`
    : `${BUILTIN_CONTROL_AGENT} (the SDK's own built-in — it carries none of our capability layer's skills)`)

  // ---- 3. THE CONTROL, first and in its own session -------------------------
  // First on purpose: it runs before anything in this app has seen the marker,
  // so "the control could not produce it" cannot be explained by a parent that
  // had just read it out of a previous arm.
  const control = await runArm(run, session, 'control', claude.slug, controlAgent, SKILL_QUESTION)
  if (!control?.matched) {
    // BLOCKED, not FAIL. A model that declines a probe-shaped prompt, or that
    // answers it itself instead of delegating, measures the MODEL — the same
    // route fact AGENT-INSTALL records. Without a control dispatch, "the skill
    // did not arrive here" is untested, and banking the other half is precisely
    // what the retraction in the checklist was about.
    blocked(
      `the control never ran: ${controlAgent} was never dispatched, so nothing establishes that an agent WITHOUT the `
      + 'declaration cannot produce the marker. '
      + `Dispatches seen: ${JSON.stringify(control?.calls.map(c => c.subagentType) ?? [])}. `
      + `The parent said: ${JSON.stringify((control?.parentText ?? '').slice(0, 200))}.`,
    )
  }
  const controlAnswer = control.matched.result
  run.observe('control: subagent answer', controlAnswer.slice(0, 300))
  run.observe('control: parent reply', control.parentText.slice(0, 200))

  if (controlAnswer.includes(SKILL_MARKER)) {
    blocked(
      `the control is VOID: ${controlAgent}, which declares no skill, produced the marker anyway. `
      + 'That makes the marker reachable without the declaration — most likely the child read the skill file off disk '
      + '(it has Read/Grep and the skill is a file on this machine), or the token is guessable. '
      + 'Pick a marker that exists only inside the skill body and that no tool on the box can reach, then re-run. '
      + `The control answered: ${JSON.stringify(controlAnswer.slice(0, 200))}`,
    )
  }

  // ---- 4. is the agent this case names even installed ----------------------
  // Read BEFORE the measured arm and from the control's own session: agents are
  // workspace-scoped, both arms sit in the same workspace, and "the model had
  // nothing to delegate to" is a precondition failure that should cost zero
  // further turns and name what IS installed.
  const rows = await catalogAgents(session, control.key)
  run.observe('catalog agents', rows.map(r => `${r.logicalName}[${r.state}]`))
  const row = rows.find(r => shortName(r.logicalName) === shortName(SKILLED_AGENT) || shortName(r.key) === shortName(SKILLED_AGENT))
  run.observe('catalog row for the named agent', row ?? null)
  if (!row) {
    blocked(
      `no agent named ${SKILLED_AGENT} is in this workspace's capability catalog, so the model would have nothing to `
      + `delegate to. The catalog carries: ${rows.map(r => r.logicalName).join(', ') || 'no agents at all'}. `
      + 'Install the agent (or correct NESSY_CDP_SKILLED_AGENT) and re-run.',
    )
  }
  // The usable state is `active`, not `available` — measured 2026-08-17, when
  // this guard blocked on `state: "active"` and reported it as the session
  // REFUSING the agent. Every agent in the operator's catalog reads `active`,
  // including the ones a control turn then delegated to successfully, so the
  // string this was written against does not exist on this field.
  if (row.state !== 'active') {
    blocked(
      `the agent ${SKILLED_AGENT} is in the catalog but its state is ${row.state}`
      + `${row.unavailableReason ? ` (${row.unavailableReason})` : ''}, so this run would measure an agent the session `
      + 'refuses rather than one whose skills did or did not arrive.',
    )
  }

  // ---- 5. the measured arm --------------------------------------------------
  const measured = await runArm(run, session, 'skilled', claude.slug, SKILLED_AGENT, SKILL_QUESTION)
  if (!measured?.matched) {
    // Two causes with the same symptom, and the message names both because they
    // have different fixes. The model may simply have declined or answered the
    // question itself — that measures the model. Or the agent may not be
    // REGISTERED at all: the CLI parses the whole `agents` record through one
    // `z.record(...)` inside a try whose catch returns `[]`, so ONE malformed
    // entry deletes EVERY agent we sent and the only trace is a CLI-internal
    // line the host never sees (`claude-runtime-agents.ts`, file header).
    blocked(
      `the ${SKILLED_AGENT} subagent was never dispatched, so its skills are untested. `
      + `Dispatches seen: ${JSON.stringify(measured?.calls.map(c => c.subagentType) ?? [])}. `
      + `The parent said: ${JSON.stringify((measured?.parentText ?? '').slice(0, 200))}. `
      + 'Separate the two causes before reading anything into it: the model declining or answering it itself, versus '
      + "the whole `agents` record being dropped by the CLI's all-or-nothing parse because some OTHER agent in this "
      + 'workspace is malformed. The catalog row above shows the agent is installed; it cannot show it was registered '
      + 'with the SDK.',
    )
  }
  const call = measured.matched
  run.observe('skilled: subagent answer', call.result.slice(0, 400))
  run.observe('skilled: parent reply', measured.parentText.slice(0, 200))

  // ---- 6. the guards that decide whether the answer means anything ----------
  // The parent composes the delegate's prompt and could simply have written the
  // answer into it. AGT-1 records this as the confound that voids a control;
  // here it would void the claim, so it is checked on the whole input, not just
  // on the `prompt` field.
  run.observe('skilled: delegated input', call.inputJson.slice(0, 500))
  if (call.inputJson.includes(SKILL_MARKER)) {
    blocked(
      'this run cannot score the claim: the PARENT put the marker into the subagent\'s own task input, so the child was '
      + 'TOLD the answer rather than having to carry it. That is a limit of delegating through the model — the parent '
      + 'composes the delegate\'s prompt. Re-run; if it recurs, use a question whose wording cannot pull the marker into '
      + 'the parent\'s context first.',
    )
  }

  const leaks = await memoryLeaks(SKILL_MARKER, {
    workspaceId: measured.key.workspaceId,
    sessionId: measured.key.sessionId,
    configDir: configDir(),
    ...(await workingDirectoryOf(session, measured.key.sessionId)),
  })
  run.observe('memory files holding the marker', leaks)
  if (leaks.length > 0) {
    blocked(
      `the marker is sitting in ${leaks.map(l => `${l.scope} memory (${l.path})`).join(', ')}. Every child reads those `
      + 'files through its own prompt, so neither arm proves anything about the agent definition. Remove the line and '
      + 're-run.',
    )
  }

  // ---- 7. THE claim ---------------------------------------------------------
  run.check(
    `the ${SKILLED_AGENT} subagent answered from its declared skill's content`,
    call.result.includes(SKILL_MARKER),
    call.result.trim().length > 0
      ? `the child returned ${JSON.stringify(call.result.slice(0, 220))} without the marker — the skill body did not reach its prompt`
      : '(the child returned nothing at all)',
  )
  run.check(
    'the control, which declares no skill, could NOT produce it',
    !controlAnswer.includes(SKILL_MARKER),
    controlAnswer.slice(0, 200) || '(the control subagent returned nothing)',
  )

  // ---- 8. evidence from the runtime's own transcript ------------------------
  // Observed, never asserted. The SDK files a transcript per session working
  // directory, so a session bound to a project lands under a differently-named
  // directory and an absence here would say nothing about the claim.
  const log = readClaudeSessionLog(measured.key.workspaceId, configDir(), measured.key.sessionId)
  run.observe('sdk transcript', { file: log.file, files: log.files?.length, entries: log.entries.length, reason: log.reason })
  run.observe(
    'sdk transcript entries carrying the marker',
    log.entries.filter(entry => entry.text.includes(SKILL_MARKER)).map(entry => ({
      type: entry.type,
      role: entry.role,
      sidechain: entry.raw.isSidechain === true,
      excerpt: entry.text.slice(0, 160),
    })).slice(0, 6),
  )
}

/** The session's cwd, so the project-scope `MEMORY.md` is scanned too. */
async function workingDirectoryOf(session: CdpSession, sessionId: string): Promise<{ workingDirectory?: string }> {
  const found = (await listSessions(session)).find(s => s.id === sessionId)?.workingDirectory
  return found ? { workingDirectory: found } : {}
}

if (import.meta.main) {
  await main(ID, TITLE, drive)
}

export const meta = { id: ID, title: TITLE }
