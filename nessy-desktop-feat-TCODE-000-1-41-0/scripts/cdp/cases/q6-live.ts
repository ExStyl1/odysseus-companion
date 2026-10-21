/**
 * Q6-LIVE — the four claims `2026-08-12-audit-defect-closure.md` closed with
 * OFFLINE evidence only.
 *
 * That plan's Q6 row is unusually honest and this case exists because of it:
 * *one of five proofs is live-verified after the fixes; four are offline-verified
 * only … Each has a seam test that fails without its fix, and Q8's own failures
 * are what produced those tests — but none has been observed in the running app
 * since. This is the wave's one remaining verification debt and it belongs in
 * the next wave's gate, not in a tick here.* The four are:
 *
 *   1. a dead child reports its REASON to the parent (`b97c774c0`) — Q8-D1
 *      measured `1. <agent> - done … (no output)` while the child's own session
 *      held one `[error]` row;
 *   2. the model fallback survives the ceiling check (`c086abed6` + the ceiling's
 *      second arm) — Q8 measured the documented warning printing and the child
 *      then dying on `runtime-agent-model-ceiling-mismatch`, because the check
 *      compared the SUBSTITUTED model against the DECLARED one, which are equal
 *      only when no substitution happened;
 *   3. our agents reach the Claude Agent SDK's registry (`6428d9d71`) — Q8
 *      measured `Agent type '<ours>' not found. Available agents: claude,
 *      claude-code-guide, Explore, general-purpose, Plan, statusline-setup` on a
 *      build proven to contain the previous fix, because `ClaudeAgent`'s
 *      constructor rebuilt its `BackendConfig` field by field and dropped the
 *      one carrying the definitions;
 *   4. the capability catalog reports what the ACTIVE runtime supports
 *      (`12f7e79b3`) — Q8 measured a Codex session's 15 agents byte-identical to
 *      Pi's, because `resolveCapabilityContext` set `provider` on no branch and
 *      the gate collapsed onto its provider-neutral arm.
 *
 * ## Claim 4's expected value moved, and the principle did not
 *
 * The 2026-08-13 run measured 13/13 Codex agent rows reading
 * `unavailableReason=unsupported-runtime`, and that WAS the honest answer: our
 * codex config writer emitted no `[agents]` section, so nothing our side called
 * an agent could ever be dispatched there. `7bf2c84d6` built that section and
 * the wiring commit handed it the session's definitions, so a Codex session now
 * really does register them and `active` is the honest answer.
 *
 * The claim was never "Codex must not support agents" — it is "the catalog does
 * not lie about what the active runtime supports". So the Codex row flips to
 * `active` here, and the arm that keeps the assertion from being vacuous moves
 * with it: with codex admitted, `nestor-cloud-agent` is the ONLY provider
 * `AGENT_DEFINITION_RUNTIMES` still refuses, and it is therefore the row that
 * can tell a live gate apart from a dead one. That is exactly the failure Q8-D4
 * found — a gate that answered `active` for everything — so a run with no
 * cloud-agent connection reports the arm as a GAP rather than quietly passing
 * three rows that all say the same word.
 *
 * That control's ARRANGEMENT then broke, and only the arrangement (2026-08-21).
 * It opened its session by switching onto the cloud connection, and switching
 * onto a remote one has been refused with `CONNECTION_NOT_SWITCHABLE` since the
 * 1.27 runtime-switching plan — after this case's last green run — which is the
 * deterministic FAIL the 1.31.0 close-out measured. A session may still be
 * CREATED on that connection (`CreateSessionOptions.llmConnection`), so the
 * control now does that; see {@link sessionCreatedOn}. Nothing about the claim
 * moved: the catalog must still refuse a runtime that dispatches no local
 * definitions.
 *
 * ## What this case will not do
 *
 * Assert anything it did not measure. Two of the four need a condition the
 * harness deliberately will not create for itself — an agent that dies, and an
 * agent declaring a model this gateway cannot serve — because both are
 * properties of installed content, and `scripts/cdp/README.md` forbids a case
 * from installing plugins or rewriting config on the machine it is measuring.
 * Those arms take an env var naming the agent and are reported as GAPS when it
 * is absent, with the operator recipe in the message. A `BLOCKED` naming what
 * was not driven is the honest result; a PASS covering three of four is not.
 *
 * Claim 1 turned out to span TWO turns, and the 2026-08-13 run paid for it. A
 * top-level dispatch goes to the background by default, so the parent's turn
 * returns a launch receipt and ends before the child can die — and that receipt
 * sailed through the check that was meant to read the reason. The first fix
 * (`c42ec7af5`) stopped the case passing on the receipt; it also stopped the
 * case one turn short of the answer. The product DOES report the death: the
 * child settles through `ChildRuntime.monitor`, the `task_completed` event
 * reaches `deliverMonitorEvent`, and the host STARTS A NEW TURN carrying
 * `Background subagent task <id> finished (failed).` plus the child's own error.
 * The receipt is now the case's handle on that second turn rather than its
 * stopping point — see {@link claimOneDeadChildSaysWhy}.
 *
 * **Claims 2 and 3 were left on the old shape until 2026-08-21, and they paid
 * the same price in mirror image.** T24's sitting B armed both arms and scored
 * two reds on children that were still running: each arm's last check read the
 * launch receipt as the child's answer and reported that the answer was missing.
 * Both now follow claim 1's discipline through {@link backgroundDispatch} and
 * {@link backgroundChildReport} — the receipt is the handle, and the child's
 * report is read off the settlement that handle names. Three deliveries were
 * measured on the operator rig before this was written, and none of them is the
 * shape the old checks assumed:
 *
 *   - Pi backgrounds the top-level `subagent` call and the host later starts a
 *     turn carrying `Background subagent task <id> finished (completed).` with
 *     the child's own report under it;
 *   - the model sometimes re-dispatches the same agent `background: false`, and
 *     that result IS the report, in the launch turn;
 *   - the Claude SDK returns `Async agent launched successfully … agentId: <id>`
 *     (a DIFFERENT receipt, matched by {@link SDK_ASYNC_RECEIPT}) and settles
 *     either through a blocking `TaskOutput` on that same id or through its own
 *     `<task-notification>` block addressed by `<task-id>` — both inside the
 *     launch turn, which is why the previous guard's "wait for a LATER message"
 *     timed out for five minutes and then reported the answer missing.
 *
 * Binding on the handle is necessary and NOT sufficient, which sitting C
 * measured the hard way: the parent composes the child's prompt, so its own
 * launch prose named the dispatch and pasted the token while the child was
 * still running — a green check on an answer still in flight, which is
 * `c42ec7af5`'s false positive returning through a different door. Only a
 * SETTLEMENT REPORT counts, therefore — see {@link settlementReport} — and the
 * model's prose about its own launch counts for nothing.
 *
 * Claim 2's `[model] …` announcement moved onto that same report, and had to:
 * `subagent-tool.ts` writes it into the CHILD's report, never into the receipt,
 * so a backgrounded dispatch cannot carry it in the tool result and an absence
 * there measures the receipt rather than the product. That is also why the
 * follow is not skipped when the token turns up early — sitting D pulled the
 * answer out of the child with `resume` calls, which carry its text without the
 * spawn's announcement.
 *
 * ## Operator preconditions that are not obvious
 *
 * **Bind and trust a project in the workspace first.** The 2026-08-13 re-gate
 * paid for this: with no project bound, every `Read`/`Grep` on an absolute path
 * raised an unanswerable `outside_root` approval and returned
 * `Tool execution timed out` — in the parent AND in both children — which reads
 * exactly like a broken tool layer. `Bash` is not path-gated and worked, which
 * is what gave it away. The prompts below ask agents for text and nothing else,
 * but an agent's own declared tools are its author's business.
 *
 * **Do not run two CDP turn drivers at once.** The second fails
 * `composer-mismatch`, because the composer belongs to whichever session the
 * pane shows.
 */

import { lastAssistantText, sendPrompt } from '../lib/chat.ts'
import type { CdpSession } from '../lib/connect.ts'
import { bundleFiles, resolveAppUnderTest, symbolsIn } from '../lib/bundle.ts'
import { newCodeword } from '../lib/codeword.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import {
  assertElectronApi,
  createSessionDirectly,
  freshSession,
  listSessions,
  piReadNote,
  piRuntime,
  sessionCommand,
  transcript,
  waitFor,
  type FreshSession,
  type TranscriptMessage,
} from '../lib/state.ts'
import { turnRowsSince } from '../lib/turn-evidence.ts'

const ID = 'Q6-LIVE'
const TITLE = 'The four Q6 claims closed on offline evidence, measured in the running app'

/** An agent the operator has arranged to DIE on its first turn (claim 1). */
const DEAD_AGENT = process.env.NESSY_CDP_DEAD_CHILD_AGENT
/** An agent whose frontmatter declares a model this gateway cannot serve (claim 2). */
const FOREIGN_MODEL_AGENT = process.env.NESSY_CDP_FOREIGN_MODEL_AGENT
/** What that agent asks for. Only used in messages; the assertion reads the app's own text. */
const FOREIGN_MODEL = process.env.NESSY_CDP_FOREIGN_MODEL ?? 'sonnet'
/** Any agent from an installed Nessy plugin or the local agent dir (claim 3). */
const PLUGIN_AGENT = process.env.NESSY_CDP_PLUGIN_AGENT

/**
 * The SDK's own agents, verbatim from the refusal Q8 measured twice.
 *
 * Used as the positive control for claim 3: `general-purpose` is the SDK's, so a
 * turn that cannot dispatch even that one has a broken detector rather than a
 * missing registration, and the case says so instead of filing a defect.
 */
const SDK_OWN_AGENT = 'general-purpose'
const NOT_FOUND_PATTERN = /Agent type '[^']*' not found\. Available agents:/

/** `subagent` (Pi), `Agent`/`Task` (Claude SDK). Matched loosely, then observed. */
const AGENT_TOOL = /^(agent|task|subagent)$/i

/**
 * A launch RECEIPT, not a result.
 *
 * `subagent-tool.ts:708` returns `Started background subagent task\ntask_id: …\n
 * agent_ids: …` the instant a dispatch goes to the background, and
 * `workflow-tool.ts:876` returns the same shape with a `run_id:` ahead of it.
 * Separators are matched as `\s+` rather than `\n` because the transcript's copy
 * of the 2026-08-13 receipt carried `task_id:` and `agent_ids:` on one line.
 */
const BACKGROUND_RECEIPT = /Started background (?:subagent task|workflow run)\s+(?:run_id:\s*\S+\s+)?task_id:\s*\S+/

/**
 * The receipt's two handles, read back out of it.
 *
 * Deliberately NOT folded into {@link BACKGROUND_RECEIPT} as capture groups:
 * that expression is the guard `c42ec7af5` proved against five shapes, and its
 * matched language is the evidence. Extraction is a separate, additive read.
 *
 * `agent_ids:` sits on the line AFTER the receipt's own match ends, so it is
 * matched against the text from the receipt onwards rather than against
 * `receipt[0]`.
 */
const RECEIPT_TASK_ID = /task_id:\s*(\S+)/
const RECEIPT_AGENT_IDS = /agent_ids:[ \t]*([^\n]*)/

/**
 * The Claude SDK's launch receipt, which is a DIFFERENT shape — and that is why
 * claim 3 read one as an answer while claim 1's guard sat forty lines above it.
 *
 * Verbatim from the shipped binary
 * (`@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`, the `async_launched`
 * arm of the agent tool's result mapper), and confirmed on the rig:
 * `Async agent launched successfully. (This tool result is internal metadata …)
 * agentId: <id> (internal ID …) The agent is working in the background. You
 * will be notified automatically when it completes …`. Nothing in it matches
 * {@link BACKGROUND_RECEIPT}: no `task_id:`, no "Started background".
 *
 * The id is the handle. `TaskOutput`'s `task_id`, the SDK's `SendMessage`
 * target and the host's `task_backgrounded`/`task_completed` pair all key on
 * this same string, so a result bound to it is bound to THIS dispatch.
 */
const SDK_ASYNC_RECEIPT = /Async agent launched successfully/
const SDK_RECEIPT_AGENT_ID = /agentId:\s*([A-Za-z0-9_-]+)/

/**
 * How long the case waits for the host to deliver the dead child's obituary.
 *
 * Sized against the system's resting state, not against zero. A child arranged
 * to die on its first turn settles in seconds — but the recipe that kills it
 * through the gateway rides the retry ladder first (15 s a step), so a window
 * under about a minute and a half would report "the product never tells the
 * parent" about a run that was still retrying. Five minutes is the same order as
 * the turn timeouts this case already spends.
 */
const COMPLETION_NOTICE_TIMEOUT_MS = 300_000

/** `buildBackgroundTaskCompletionNotice`'s stand-in for a summary it did not get. */
const NO_SUMMARY_NOTICE = 'It reported no summary.'

interface Connection {
  slug: string
  providerType: string
}

interface TurnAttempt {
  added: TranscriptMessage[]
  error?: string
}

const turnAttempt = (turn: { added: TranscriptMessage[] }): TurnAttempt => ({ added: turn.added })
const turnFailure = (cause: unknown): TurnAttempt => ({
  added: [],
  error: cause instanceof Error ? cause.message : String(cause),
})

/** Tool rows that look like an agent dispatch, with what they returned. */
function agentRows(messages: TranscriptMessage[]): TranscriptMessage[] {
  return messages.filter(m => typeof m.toolName === 'string' && AGENT_TOOL.test(m.toolName))
}

function toolResults(rows: TranscriptMessage[]): string {
  return rows.map(m => m.toolResult ?? '').join('\n---\n')
}

/** A dispatch that went to the background, with the handles it can be followed by. */
interface BackgroundDispatch {
  /** `pi` — `Started background subagent task`; `sdk` — `Async agent launched successfully`. */
  kind: 'pi' | 'sdk'
  /** The id a settled result is bound to: Pi's `task_id`, the SDK's `agentId`. */
  handleId: string
  /** Every id the receipt named — Pi's `agent_ids` ride along with its `task_id`. */
  ids: string[]
  /** The receipt itself, whitespace-collapsed, for the observation. */
  receipt: string
}

/**
 * Read a launch receipt out of an agent tool result, in either runtime's shape.
 *
 * Returns `undefined` when the result is not a receipt at all — which is the
 * FOREGROUND shape, and the one the two arms below still score directly.
 */
function backgroundDispatch(results: string): BackgroundDispatch | undefined {
  const pi = BACKGROUND_RECEIPT.exec(results)
  if (pi) {
    const taskId = RECEIPT_TASK_ID.exec(pi[0])?.[1]
    if (!taskId) return undefined
    // `agent_ids:` sits after the receipt's own match ends, so it is read from
    // the receipt onwards rather than out of `pi[0]` — the same split
    // {@link claimOneDeadChildSaysWhy} relies on.
    const agentIds = (RECEIPT_AGENT_IDS.exec(results.slice(pi.index))?.[1] ?? '')
      .split(',').map(id => id.trim()).filter(Boolean)
    return { kind: 'pi', handleId: taskId, ids: [taskId, ...agentIds], receipt: pi[0].replace(/\s+/g, ' ') }
  }
  const sdk = SDK_ASYNC_RECEIPT.exec(results)
  if (!sdk) return undefined
  const agentId = SDK_RECEIPT_AGENT_ID.exec(results.slice(sdk.index))?.[1]
  if (!agentId) return undefined
  return { kind: 'sdk', handleId: agentId, ids: [agentId], receipt: `${sdk[0]} agentId: ${agentId}` }
}

/**
 * The child's instruction — the CODEWORD's carrier.
 *
 * It used to be `reply with exactly <token> and nothing else`, and sittings L
 * and M measured why that is not enough. The carrier has to survive the child's
 * OWN system prompt, and a plugin agent's system prompt is an agenda: the
 * `scan-inventory` agent spent its whole turn explaining that it could not do an
 * inventory scan — verbatim, out of the delivered report, *"I apologize, but I'm
 * unable to complete the full inventory scan. … `find` - Requires ripgrep
 * (`rg`), which is not installed … `bash` - Not available in this session"* —
 * and never emitted the token. The report ARRIVED and the delivery path was
 * working; the codeword simply rode on prose the agent had decided not to write.
 *
 * So the instruction now states the two things that make it followable by ANY
 * agent in ANY tool environment: that it needs no tools at all, and that an
 * agent which cannot do its usual work must still answer the line. A carrier
 * that depends on the child's tools measures the child's tools; this one
 * measures what the arm is actually about — that the child ran and its text
 * reached the parent.
 *
 * Still liveness only, and NOT an isolation control: the parent composes this
 * prompt, so it knows the token before the child has run. What keeps the
 * parent's own copy out of the answer is {@link settlementReport}, not this.
 */
function codewordTask(agent: string, token: string): string {
  return `Use the ${agent} agent for this one task, and give it exactly this instruction: `
    + `"Reply with the single line ${token} and nothing else. This needs no tools, no files and no commands — `
    + 'if the work you usually do is impossible here, skip it and reply with that line anyway." '
    + "Then report the agent's answer verbatim."
}

/** Does this message NAME the dispatch — anywhere, arguments included? */
function mentionsDispatch(message: TranscriptMessage, dispatch: BackgroundDispatch): boolean {
  const haystack = `${message.content ?? ''}\n${message.toolResult ?? ''}\n${JSON.stringify(message.toolInput ?? {})}`
  return dispatch.ids.some(id => haystack.includes(id))
}

/**
 * The SETTLEMENT REPORT for this dispatch — the text the child's own run
 * produced, addressed by the dispatch's id and carrying a terminal status.
 *
 * Three shapes, all measured on the operator rig:
 *
 *   - Pi: the host starts a turn carrying `buildBackgroundTaskCompletionNotice`'s
 *     `Background subagent task <id> finished (completed).` with the child's
 *     `contentForResults` block under it, inside the `<task-notification>`
 *     framing — the same text {@link findCompletionNotice} reads for claim 1;
 *   - the Claude SDK's own `<task-notification>` block, addressed by
 *     `<task-id>`, with `<status>`, `<summary>`, `<result>` and a `<usage>` tail;
 *   - a blocking read on the id — `TaskOutput` — whose envelope carries the
 *     same `<status>`. `<retrieval_status>` cannot match it: the `<` is required.
 *
 * **The parent's PROSE is not one of them, and that exclusion is the point.**
 * The parent composes the child's prompt, so it knows the token before the
 * child has run: sitting C scored `ACDC7-… / The scan-inventory agent has been
 * started as a background task (task ID: …)` — the launch announcement, with
 * the token pasted above it — as the child's answer, on a child that was still
 * running. The same run caught the model hand-writing its own
 * `<task-notification>` block. Either would be `c42ec7af5`'s false positive
 * returning through a different door.
 */
function settlementReport(
  message: TranscriptMessage,
  dispatch: BackgroundDispatch,
): { text: string; via: string } | undefined {
  const content = message.content ?? ''
  if (content.includes(`task ${dispatch.handleId} finished (`)) {
    return { text: content, via: `host-notice:${message.role}` }
  }
  if (content.includes(`<task-id>${dispatch.handleId}</task-id>`) && /<status>[^<]*<\/status>/.test(content)) {
    return { text: content, via: `sdk-notification:${message.role}` }
  }
  const toolResult = message.toolResult ?? ''
  if (mentionsDispatch(message, dispatch) && /<status>\s*(?:completed|failed|stopped)\s*<\/status>/.test(toolResult)) {
    return { text: toolResult, via: `tool-result:${message.toolName ?? message.role}` }
  }
  return undefined
}

/**
 * Wait for that report, keyed on the dispatch rather than on a phrase.
 *
 * **It waits for the SETTLEMENT, not for the token**, and the difference is a
 * measurement: sitting D's model got the token out of the child through four
 * `resume` calls, which carry the child's text and NOT the `[model]` line the
 * spawn's own report carries — so a waiter that stops at the first sight of the
 * token would have banked an answer and missed the announcement that was
 * already on its way. The notice arrived, with both.
 *
 * A notification left by an earlier run cannot be mistaken for this one: the id
 * binds the wait to THIS dispatch. That mistake is on this repo's record — a
 * compaction case read a previous run's marker out of a reused session.
 */
async function backgroundChildReport(
  session: CdpSession,
  key: FreshSession,
  from: number,
  dispatch: BackgroundDispatch,
): Promise<{ text: string; via: string } | undefined> {
  return waitFor(
    async () => {
      const later = (await transcript(session, key)).slice(from)
      for (const message of later) {
        const report = settlementReport(message, dispatch)
        if (report) return report
      }
      return undefined
    },
    value => value !== undefined,
    {
      timeoutMs: COMPLETION_NOTICE_TIMEOUT_MS,
      intervalMs: 5_000,
      label: `the ${dispatch.kind} child of ${dispatch.handleId} to settle`,
    },
  ).catch(() => undefined)
}

/**
 * Switch a session's connection, retrying the ONE refusal that is a race.
 *
 * `switchSessionRuntime` takes the per-session mutation boundary and, when it
 * cannot, refuses with `SESSION_BUSY` rather than queueing
 * (`SessionManager.ts:15704`). A session this case has just created can still be
 * inside its own creation mutation when the switch arrives, and sitting D lost
 * claim 3 to exactly that — on a session three seconds old, after four green
 * switches in the same run.
 *
 * Bounded, and narrow on purpose: any other error escapes on the first attempt,
 * and a boundary still held after this window is not a race any more. In
 * particular `CONNECTION_NOT_SWITCHABLE` — the deliberate refusal that
 * {@link sessionCreatedOn} exists for — is not retried.
 */
async function setConnectionWhenIdle(session: CdpSession, sessionId: string, slug: string): Promise<void> {
  const deadline = Date.now() + 30_000
  for (;;) {
    try {
      await sessionCommand(session, sessionId, { type: 'setConnection', connectionSlug: slug })
      return
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      if (Date.now() >= deadline || !/SESSION_BUSY|another session mutation is in flight/.test(message)) throw cause
      await new Promise(resolve => { setTimeout(resolve, 2_000) })
    }
  }
}

/** A session on one connection, opened and confirmed in effect. */
async function sessionOn(
  run: CaseRun,
  session: CdpSession,
  label: string,
  connection: Connection,
): Promise<FreshSession | undefined> {
  const key = await freshSession(session, `CDP ${ID} ${label} ${new Date().toISOString().slice(11, 19)}`)
  run.observe(`${label}-session`, { sessionId: key.sessionId, fresh: key.fresh, reason: key.reason })
  if (!key.fresh) {
    run.check(`${label}: the case ran in a session it created`, false, key.reason ?? 'unknown')
    return undefined
  }
  await setConnectionWhenIdle(session, key.sessionId, connection.slug)
  // In EFFECT, not merely requested (AGT-10's detector 3): a prompt sent before
  // the switch lands measures the previous runtime and files it under this one.
  const active = await waitFor(
    () => session.call<string | undefined>(`
      const s = (await window.electronAPI.getSessions() ?? []).find(x => x.id === ${JSON.stringify(key.sessionId)})
      return s ? (s.llmConnection ?? undefined) : undefined
    `),
    value => value === connection.slug,
    { timeoutMs: 30_000, intervalMs: 1_000, label: `the session to switch to ${connection.slug}` },
  ).catch(() => undefined)
  run.check(`${label}: the session runs on ${connection.slug}`, active === connection.slug, `llmConnection=${String(active)}`)
  if (active !== connection.slug) return undefined
  // Subagent dispatch is permission-bearing on several tools; this case is about
  // dispatch, not about the prompt (AGT-3 owns that).
  await sessionCommand(session, key.sessionId, { type: 'setPermissionMode', mode: 'bypassPermissions' }).catch(() => undefined)
  await waitFor(
    async () => (await listSessions(session)).find(s => s.id === key.sessionId)?.permissionMode,
    value => value === 'bypassPermissions',
    { timeoutMs: 20_000, intervalMs: 1_000, label: 'bypassPermissions to take effect' },
  ).catch(() => undefined)
  return key
}

/**
 * A session that EXISTS on one connection, created there instead of switched
 * onto it.
 *
 * `sessionOn` above cannot serve a REMOTE connection and has not been able to
 * since the 1.27 runtime-switching plan: `switchSessionRuntime` refuses a
 * `nestor-cloud-agent` target with `CONNECTION_NOT_SWITCHABLE`
 * ("Remote connections cannot be switched into an existing session"), and the
 * picker filters it out of the target list for the same reason. That refusal
 * guards SWITCHING; creation is a separate, unguarded door and it is a shipped
 * one — `CreateSessionOptions.llmConnection` rides the `sessions:create` RPC the
 * renderer's own New Chat uses, `SessionManager.createSession` puts it straight
 * on the managed session (`createManagedSession(..., { llmConnection })`), and
 * the `spawn_session` session tool offers the same field to the model.
 *
 * The provider therefore resolves exactly as it did before: `resolveManagedProvider`
 * reads `managed.llmConnection` through `resolveConfiguredProvider` for every
 * non-Pi session, so no turn is required here either — which is what keeps this
 * control off a live remote backend.
 *
 * `fresh: true` is asserted rather than assumed: the read-back below is the
 * "in EFFECT, not merely requested" discipline `sessionOn` applies to its own
 * switch, against the app's own `getSessions()`.
 */
async function sessionCreatedOn(
  run: CaseRun,
  session: CdpSession,
  label: string,
  workspaceId: string,
  connection: Connection,
): Promise<FreshSession | undefined> {
  const name = `CDP ${ID} ${label} ${new Date().toISOString().slice(11, 19)}`
  // D1.385 / F1.173 — `createSessionDirectly` is the harness's ONE spelling of
  // `electronAPI.createSession`, and it applies the per-case permission mode
  // itself (`case-default`), so this case cannot be the one left in the app's
  // default while every other runs in `bypassPermissions`. The mode argument is
  // required, so a future harness-wide default reaches this path by the
  // compiler asking rather than by anyone remembering.
  const created = await createSessionDirectly(
    session,
    workspaceId,
    { name, llmConnection: connection.slug },
    'case-default',
  )
  run.observe(`${label}-session`, created)
  if (!created.sessionId) {
    run.check(`${label}: the case created a session on ${connection.slug}`, false, created.error ?? 'createSession returned no id')
    return undefined
  }
  const active = await waitFor(
    () => session.call<string | undefined>(`
      const s = (await window.electronAPI.getSessions() ?? []).find(x => x.id === ${JSON.stringify(created.sessionId)})
      return s ? (s.llmConnection ?? undefined) : undefined
    `),
    value => value === connection.slug,
    { timeoutMs: 30_000, intervalMs: 1_000, label: `the created session to report ${connection.slug}` },
  ).catch(() => undefined)
  run.check(`${label}: the session runs on ${connection.slug}`, active === connection.slug, `llmConnection=${String(active)}`)
  if (active !== connection.slug) return undefined
  return {
    workspaceId: created.workspaceId ?? workspaceId,
    sessionId: created.sessionId,
    fresh: true,
    inheritedMessages: 0,
    permissionMode: created.permissionMode ?? 'unknown',
  }
}

interface CatalogAgentRow {
  key: string
  logicalName: string
  state: string
  unavailableReason?: string
}

/**
 * Agent rows of the catalog, for an arbitrary context ref.
 *
 * `{ workspaceId }` and `{ workspaceId, sessionId }` are different questions and
 * this case asks both: the first resolves before any session exists and is
 * provider-blind BY DESIGN (`runtime-agent-support.ts` — refusing a row there
 * would report a definite unavailability from an indefinite input), the second
 * is the one Q8-D4 found collapsing onto that same blind arm on every surface a
 * user can see.
 */
async function catalogAgents(
  session: CdpSession,
  context: Record<string, string>,
): Promise<CatalogAgentRow[]> {
  return session.call<CatalogAgentRow[]>(`
    const cat = await window.electronAPI.capabilities.getCatalog(${JSON.stringify(context)})
    return (cat.capabilities ?? [])
      .filter(c => c.kind === 'agent')
      .map(c => ({ key: c.key, logicalName: c.logicalName, state: c.state, unavailableReason: c.unavailableReason }))
  `)
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)

  // ---- which build, and does it carry the four fixes -----------------------
  // Symbol-per-claim, so a stale bundle names WHICH claim it invalidates rather
  // than blocking the whole case for one missing arm. The two Pi-side fixes land
  // in the subprocess bundle; the two host-side ones in main.cjs. The
  // 2026-08-13 re-gate grepped exactly these before it measured anything.
  const app = resolveAppUnderTest(session)
  const bundles = bundleFiles(app)
  const hostSymbols = symbolsIn(bundles.main, [
    'buildClaudeRuntimeAgentOptions',      // claim 3
    'runtimeDispatchesAgentDefinitions',   // claim 4
    'resolveSessionProvider',              // claim 4 — the ingress that was unwired
    // claim 4 — `CODEX_AGENT_ROLE_DIR`'s VALUE, because a const name does not
    // survive esbuild and a string literal does. It proves the codex role writer
    // is in the bundle; it cannot prove `AGENT_DEFINITION_RUNTIMES` admits
    // `codex-runtime`, which has no searchable literal of its own — a bundle
    // carrying the writer but not the membership fails the Codex row below
    // rather than reporting itself stale, and the message says so.
    'agent-roles',
  ])
  const piSymbols = symbolsIn(bundles.pi, [
    'modelSubstitution',                   // claim 2
    'PI_TOOL_PRESENTATION_REWRITES',       // claim 1's first half
  ])
  run.observe('app-under-test', { kind: app.kind, appRoot: app.appRoot, via: app.via })
  run.observe('host-bundle', { path: hostSymbols.path, modified: bundles.main.modifiedMs, counts: hostSymbols.counts })
  run.observe('pi-bundle', { path: piSymbols.path, modified: bundles.pi.modifiedMs, counts: piSymbols.counts })

  const connections = await session.call<Connection[]>(`
    return (await window.electronAPI.listLlmConnectionsWithStatus() ?? []).map(c => ({ slug: c.slug, providerType: c.providerType }))
  `)
  run.observe('connections', connections)
  const pi = connections.find(c => c.providerType === 'pi' || c.providerType === 'pi_compat')
  const claude = connections.find(c => c.providerType === 'claude-runtime')
  const codex = connections.find(c => c.providerType === 'codex-runtime')
  // The one provider `AGENT_DEFINITION_RUNTIMES` still refuses — claim 4's
  // liveness control now that Pi, Claude and Codex all dispatch.
  const cloud = connections.find(c => c.providerType === 'nestor-cloud-agent')

  const gaps: string[] = []
  const add = (gap: string | undefined): void => { if (gap) gaps.push(gap) }

  // Ordered cheapest and most deterministic first: claim 4 needs one trivial
  // turn and reads state, claim 1 needs an agent to die and is the most fragile.
  add(await claimFourCatalogHonesty(run, session, pi, codex, cloud, hostSymbols.missing))
  add(await claimTwoModelFallback(run, session, pi, piSymbols.missing))
  add(await claimThreeClaudeRegistry(run, session, claude, hostSymbols.missing))
  add(await claimOneDeadChildSaysWhy(run, session, pi, piSymbols.missing))

  if (gaps.length > 0) {
    blocked(`claims not measured in the running app: ${gaps.join(' | ')}`)
  }
}

// ---------------------------------------------------------------------------
// Claim 4 — the catalog is honest about the active runtime
// ---------------------------------------------------------------------------

async function claimFourCatalogHonesty(
  run: CaseRun,
  session: CdpSession,
  pi: Connection | undefined,
  codex: Connection | undefined,
  cloud: Connection | undefined,
  staleHostSymbols: string[],
): Promise<string | undefined> {
  const stale = staleHostSymbols.filter(symbol => symbol.startsWith('runtimeDispatchesAgentDefinitions')
    || symbol.startsWith('resolveSessionProvider')
    || symbol.startsWith('agent-roles'))
  if (stale.length > 0) {
    return `claim 4 (catalog honesty): the host bundle is missing ${stale.join(', ')} — it predates 12f7e79b3 or 7bf2c84d6`
  }
  if (!codex) return 'claim 4 (catalog honesty): no codex-runtime connection on this host'
  if (!pi) return 'claim 4 (catalog honesty): no Pi connection to serve as the positive control'

  const codexKey = await sessionOn(run, session, 'catalog-codex', codex)
  if (!codexKey) return 'claim 4 (catalog honesty): could not open a Codex session'

  // BEFORE a turn: recorded, never asserted. `resolveSessionProvider` reads the
  // session manager's own `resolveManagedProvider`, and whether a session that
  // has never run resolves one is not a claim this case is making — asserting it
  // either way would manufacture a finding out of an unexamined boundary.
  const beforeTurn = await catalogAgents(session, { workspaceId: codexKey.workspaceId, sessionId: codexKey.sessionId })
  run.observe('codex-catalog-before-any-turn', summarize(beforeTurn))

  const warmup = await sendPrompt(session, codexKey, 'Reply with exactly OK and nothing else.', 240_000)
    .then(turnAttempt).catch(turnFailure)
  if (warmup.error) run.observe('codex-warmup-turn-error', warmup.error)
  run.check(
    'the Codex session really ran a turn before its catalog was read',
    lastAssistantText(warmup.added).length > 0,
    lastAssistantText(warmup.added).slice(0, 120) || 'no assistant message — the provider may not be resolved yet',
  )

  const codexRows = await catalogAgents(session, { workspaceId: codexKey.workspaceId, sessionId: codexKey.sessionId })
  run.observe('codex-catalog-agents', summarize(codexRows))
  if (codexRows.length === 0) {
    run.check('claim 4: there are agent rows to be honest about', false,
      'the catalog carries no agent capabilities at all — install a plugin with agents, or add a local agent, '
      + 'or this claim has nothing to measure')
    return 'claim 4 (catalog honesty): no agent rows in the catalog'
  }
  // The 2026-08-13 run measured 13/13 REFUSED here and that was correct then.
  // The writer now emits `[agents.<role>]` and the session hands it the
  // definitions, so the honest row is `active` — see the header note on why the
  // expectation moved while the claim did not.
  const unsupported = codexRows.filter(row => row.unavailableReason === 'unsupported-runtime')
  run.check(
    'claim 4: a Codex session\'s agent rows are active — the runtime registers them now',
    unsupported.length === 0 && codexRows.every(row => row.state === 'active'),
    `${unsupported.length}/${codexRows.length} rows still refused; states=${JSON.stringify([...new Set(codexRows.map(r => r.state))])}`,
  )

  // The first control, unchanged: a gate that refuses EVERY row is not honesty,
  // it is a broken catalog. Pi dispatches definitions, so its rows must stay
  // active. It guarded the old expectation from the refuse-everything failure;
  // it still guards the shape of the read.
  const piKey = await sessionOn(run, session, 'catalog-pi', pi)
  if (!piKey) return 'claim 4 (catalog honesty): could not open the Pi control session'
  const piWarmup = await sendPrompt(session, piKey, 'Reply with exactly OK and nothing else.', 240_000)
    .then(turnAttempt).catch(turnFailure)
  if (piWarmup.error) run.observe('pi-warmup-turn-error', piWarmup.error)
  const piRows = await catalogAgents(session, { workspaceId: piKey.workspaceId, sessionId: piKey.sessionId })
  run.observe('pi-catalog-agents', summarize(piRows))
  run.check(
    'claim 4 control: the SAME agents read active on a Pi session',
    piRows.length > 0 && piRows.every(row => row.unavailableReason !== 'unsupported-runtime'),
    `${piRows.filter(r => r.unavailableReason === 'unsupported-runtime').length}/${piRows.length} rows refused on Pi`,
  )

  // The session-less read stays provider-blind ON PURPOSE (`runtime-agent-support.ts`:
  // which runtime a future session picks is unknown before one exists).
  const workspaceRows = await catalogAgents(session, { workspaceId: codexKey.workspaceId })
  run.observe('workspace-catalog-agents', summarize(workspaceRows))
  run.check(
    'claim 4 control: the workspace-scoped catalog stays provider-blind',
    workspaceRows.every(row => row.unavailableReason !== 'unsupported-runtime'),
    `${workspaceRows.filter(r => r.unavailableReason === 'unsupported-runtime').length}/${workspaceRows.length} rows refused with no session`,
  )

  // The LIVENESS control, and the one the Codex flip made load-bearing. Three
  // rows that all read `active` cannot tell a wired runtime apart from a gate
  // that stopped firing — which is precisely the Q8-D4 defect this claim exists
  // to catch, and it looked exactly like a pass. `nestor-cloud-agent` is a
  // remote A2A backend that runs no local definition, and since codex joined
  // `AGENT_DEFINITION_RUNTIMES` it is the only provider still refused.
  //
  // Not driven with a turn, unlike the Codex arm, and the reason is mechanical:
  // `SessionManager.getSessionProvider` answers from `resolveManagedProvider`,
  // which reads the session's CONNECTION (`resolveConfiguredProvider`) for every
  // non-Pi session — so the provider is resolved as soon as the session carries
  // the connection, with no turn required. A cloud turn would need a live remote
  // and would let an unrelated backend's availability decide this claim. If this
  // control ever fails, read its message before believing the gate is dead: an
  // unresolved provider produces the same `active` rows.
  //
  // CREATED on the connection, not SWITCHED onto it (2026-08-21). The control
  // used to call `sessionOn`, whose `setConnection` reaches
  // `switchSessionRuntime` — which has refused a `nestor-cloud-agent` target
  // with `CONNECTION_NOT_SWITCHABLE` since the 1.27 runtime-switching plan,
  // i.e. after this case's last green run. The 1.31.0 close-out measured the
  // resulting deterministic FAIL. The refusal is deliberate product behaviour
  // and the CLAIM is untouched by it — only the arrangement was, so the
  // arrangement moved to the create-time door (`sessionCreatedOn`) rather than
  // the control being weakened or dropped.
  if (!cloud) {
    return 'claim 4 (catalog honesty): no nestor-cloud-agent connection to serve as the refusal control — '
      + 'the Codex rows read active, but with every present runtime admitted nothing on this host '
      + 'distinguishes a live gate from a dead one. Add a Nessy Cloud Agent connection and re-run.'
  }
  const cloudKey = await sessionCreatedOn(run, session, 'catalog-cloud', codexKey.workspaceId, cloud)
  if (!cloudKey) return 'claim 4 (catalog honesty): could not create the cloud-agent refusal-control session'
  const cloudRows = await catalogAgents(session, { workspaceId: cloudKey.workspaceId, sessionId: cloudKey.sessionId })
  run.observe('cloud-catalog-agents', summarize(cloudRows))
  const cloudRefused = cloudRows.filter(row => row.unavailableReason === 'unsupported-runtime').length
  run.check(
    'claim 4 control: the gate still REFUSES a runtime that dispatches no definitions',
    cloudRows.length > 0 && cloudRefused === cloudRows.length,
    `${cloudRefused}/${cloudRows.length} rows refused on nestor-cloud-agent`
    + (cloudRefused === cloudRows.length ? '' : ' — either the gate stopped firing (Q8-D4 again) '
      + 'or this session never resolved a provider; check cloud-catalog-agents against codex-catalog-agents'),
  )
  return undefined
}

function summarize(rows: CatalogAgentRow[]): unknown {
  return {
    count: rows.length,
    states: [...new Set(rows.map(row => `${row.state}/${row.unavailableReason ?? 'null'}`))],
    sample: rows.slice(0, 6).map(row => row.logicalName),
  }
}

// ---------------------------------------------------------------------------
// Claim 2 — the model fallback survives the ceiling
// ---------------------------------------------------------------------------

async function claimTwoModelFallback(
  run: CaseRun,
  session: CdpSession,
  pi: Connection | undefined,
  stalePiSymbols: string[],
): Promise<string | undefined> {
  if (stalePiSymbols.some(symbol => symbol.startsWith('modelSubstitution'))) {
    return 'claim 2 (model fallback): the Pi subprocess bundle is missing modelSubstitution — it predates c086abed6'
  }
  if (!pi) return 'claim 2 (model fallback): no Pi connection on this host'
  if (!FOREIGN_MODEL_AGENT) {
    return 'claim 2 (model fallback): set NESSY_CDP_FOREIGN_MODEL_AGENT to an agent whose frontmatter declares a model '
      + `this gateway cannot serve (\`model: ${FOREIGN_MODEL}\`; claude-security's scan-inventory is the known-good one, `
      + 'and a large share of the public catalogue declares a Claude model the same way). Without one there is no '
      + 'substitution to survive the ceiling and the claim would pass vacuously'
  }

  const key = await sessionOn(run, session, 'fallback', pi)
  if (!key) return 'claim 2 (model fallback): could not open a Pi session'

  // A token the CHILD must carry back — see {@link codewordTask} for why the
  // instruction it rides on is shaped the way it is.
  const token = newCodeword()
  // Where the launch turn starts, read before it does. Everything from here on
  // is this dispatch's own conversation, and it is the window the background
  // follow-up below scans — including the turns the HOST starts, which no
  // `TurnResult` can carry because the case did not send them.
  const before = (await transcript(session, key)).length
  const turn = await sendPrompt(
    session,
    key,
    codewordTask(FOREIGN_MODEL_AGENT, token),
    300_000,
  ).then(turnAttempt).catch(turnFailure)
  if (turn.error) run.observe('fallback-turn-error', turn.error)

  const scanned = await turnRowsSince(() => transcript(session, key), turn.added, before)
  const rows = agentRows(scanned)
  const results = toolResults(rows)
  run.observe('fallback-agent-rows', rows.map(m => ({ tool: m.toolName, status: m.toolStatus })))
  run.observe('fallback-tool-result', results.slice(0, 800) || '(no agent tool result)')
  run.check(
    'claim 2: the parent dispatched the agent at all',
    rows.length > 0,
    rows.length > 0 ? undefined : `no agent tool row; tools seen: ${JSON.stringify(scanned.filter(m => m.toolName).map(m => m.toolName))}`,
  )

  // ---- the dispatch may have gone to the BACKGROUND. Follow it. ------------
  //
  // `spawner.ts` resolves `args.background ?? (depth === 1)`, so a top-level
  // `subagent` call returns a RECEIPT and the parent's turn ends. This arm read
  // that receipt as the child's answer until 2026-08-21 and scored a red on a
  // child that was still running — the trap this case's header documents for
  // claim 1, which claim 1 alone was rebuilt around. The receipt is the HANDLE
  // now, and the child's report is read off the settlement the host delivers
  // for it.
  //
  // **All THREE of this arm's remaining checks read that report, not the
  // receipt, and the announcement is why.** `[model] …` is written by
  // `subagent-tool.ts` into the CHILD's report — `contentForResults`, which the
  // completion notice carries — so a backgrounded dispatch has no announcement
  // in its tool result and never could. Sitting C measured exactly that: with
  // the fix on only the last check, `the substitution announces itself` failed
  // for the same reason the answer check used to. The receipt is not evidence
  // of an absence any more than it was evidence of an answer.
  //
  // **And the follow is not skipped just because the token turned up early.**
  // Sitting D's model pulled the answer out of the child with `resume` calls,
  // whose results carry the child's text without the spawn's `[model]` line;
  // short-circuiting on the token there left the announcement unread while the
  // host's notice — which carried it, verbatim — arrived moments later.
  let childReport = results
  const dispatch = backgroundDispatch(results)
  /**
   * Hoisted out of the block below so the FAILURE MESSAGE can tell this arm's
   * two reds apart. They are different findings and they send a reader to
   * different places: a report that never arrived is T30's miss (the delivery
   * path), a report that arrived without the token is the CHILD's own answer
   * (the carrier, or the child). Sitting L conflated them — the message said
   * "never reached the parent" about a report that was sitting in the
   * observations — and a reader who trusted it would reopen a closed row.
   */
  let settlement: { text: string; via: string } | undefined
  if (dispatch) {
    run.observe('fallback-background-receipt', dispatch)
    settlement = await backgroundChildReport(session, key, before, dispatch)
    if (settlement) {
      run.observe('fallback-child-report', { via: settlement.via, text: settlement.text.slice(0, 600) })
      childReport = `${results}\n---\n${settlement.text}`
    } else if (results.includes(token)) {
      // Nothing settled, but the child already answered inline. Score what was
      // measured rather than laundering a measured answer into "could not run".
      run.observe('fallback-settlement-missing', `no settlement report for ${dispatch.handleId} within `
        + `${COMPLETION_NOTICE_TIMEOUT_MS}ms; the agent results already carried the child's answer`)
    } else {
      // An ABSENCE needs a positive control, and Pi's own child snapshot is it —
      // the same source claim 1 reads, off the runtime rather than off the text
      // under test. A child that reached a terminal status and still put nothing
      // in front of the parent is this claim failing, measured. A child that
      // never settled is a GAP: "the child never settled" and "the child
      // returned nothing" are different claims, and only the second is a finding.
      // D1.310 — the read's verdict rides with the list, because this arm reads
      // an EMPTY list as "the child never settled" and an unreadable snapshot
      // answers exactly that.
      const fallbackRuntime = await piRuntime(session, key)
      const settled = fallbackRuntime.children.filter(child => dispatch.ids.includes(child.agentId))
      run.observe('fallback-settled-children', { ...piReadNote(fallbackRuntime), children: settled })
      const terminal = settled.filter(child => child.status !== 'starting' && child.status !== 'running')
      if (settled.length === 0 || terminal.length < settled.length) {
        return `claim 2 (model fallback): the substituted child went to the background as ${dispatch.handleId} and `
          + `never settled within ${COMPLETION_NOTICE_TIMEOUT_MS}ms — child(ren) `
          + `${settled.map(child => `${child.agentId}=${child.status}`).join(', ') || 'not visible in the runtime snapshot at all'}`
          + '. Its report is where the substitution announces itself and where its answer travels, so neither was '
          + 'measured and this arm reports a gap rather than a defect it did not observe'
      }
    }
  }

  // The documented warning, verbatim from `subagent-tool.ts`:
  // `[model] <agent> asked for "<requested>", which this session cannot serve; it ran on "<resolved>".`
  // `sub-agents.md` § Choose a model requires it: "Claude Code shows a warning
  // naming the requested model and the model the subagent runs on."
  const announcement = /\[model\] .*? asked for "([^"]+)", which this session cannot serve; it ran on "([^"]+)"\./.exec(childReport)
  run.observe('fallback-announcement', announcement?.[0] ?? '(absent)')
  run.check(
    'claim 2: the substitution announces itself, naming both models',
    Boolean(announcement),
    announcement
      ? `requested=${announcement[1]} resolved=${announcement[2]}`
      : `no [model] line in the child's report: ${childReport.slice(0, 300)}`,
  )
  // THE regression. Q8: the announcement printed and the child then died here,
  // because the ceiling compared the arriving (substituted) model against the
  // declared string — equal only when nothing was substituted, which made the
  // documented fallback and the ceiling mutually exclusive by construction.
  run.check(
    'claim 2: the substituted child is NOT refused by the ceiling',
    !/runtime-agent-model-ceiling-mismatch/.test(childReport),
    /runtime-agent-model-ceiling-mismatch/.test(childReport)
      ? 'the child was refused `runtime-agent-model-ceiling-mismatch` after the warning printed — this is Q8\'s '
        + '"PASS announcement / FAIL spawn" exactly'
      : undefined,
  )
  run.check(
    'claim 2: the child actually RAN and returned its answer',
    childReport.includes(token),
    childReport.includes(token)
      ? `token=${token}`
      : settlement
        ? `the child's report ARRIVED (via ${settlement.via}) and did not carry ${token}. The delivery path WORKED — `
          + 'this is the child\'s own answer, not a lost report, and it is not T30 returning. What the child said, '
          + `verbatim: ${settlement.text.slice(-300)}`
        : dispatch
          ? `every child of ${dispatch.handleId} reached a terminal status and NO report naming that dispatch reached `
            + `the parent at all within ${COMPLETION_NOTICE_TIMEOUT_MS}ms — nothing was delivered, so the child's `
            + 'answer was never in front of the parent to carry a token'
          : `the agent result did not carry ${token}: ${results.slice(0, 300)}`,
  )
  return undefined
}

// ---------------------------------------------------------------------------
// Claim 3 — our agents reach the Claude SDK's registry
// ---------------------------------------------------------------------------

async function claimThreeClaudeRegistry(
  run: CaseRun,
  session: CdpSession,
  claude: Connection | undefined,
  staleHostSymbols: string[],
): Promise<string | undefined> {
  if (staleHostSymbols.some(symbol => symbol.startsWith('buildClaudeRuntimeAgentOptions'))) {
    return 'claim 3 (Claude registry): the host bundle is missing buildClaudeRuntimeAgentOptions — it predates the Q7 work'
  }
  if (!claude) return 'claim 3 (Claude registry): no claude-runtime connection on this host'
  if (!PLUGIN_AGENT) {
    return 'claim 3 (Claude registry): set NESSY_CDP_PLUGIN_AGENT to the name of an agent from an installed Nessy '
      + 'plugin (or a local agent definition). The SDK\'s own agents are always there, so a run without one of OURS '
      + 'measures the SDK rather than our registration'
  }

  const key = await sessionOn(run, session, 'claude-agents', claude)
  if (!key) return 'claim 3 (Claude registry): could not open a Claude session'

  // The CONTROL first. A Claude turn that cannot dispatch even the SDK's own
  // `general-purpose` has a broken detector, not a missing registration — and
  // the 2026-08-13 re-gate is explicit that a model SELF-REPORT is worthless
  // here: the Claude runtime denied having an Agent tool it demonstrably has.
  // Only transcript tool rows are counted, never prose.
  const controlToken = newCodeword()
  const rowsBefore = (await transcript(session, key)).length // F1.521: the fallback's baseline, read before the send
  const control = await sendPrompt(
    session,
    key,
    `Use the ${SDK_OWN_AGENT} agent for this one task: reply with exactly ${controlToken} and nothing else. `
    + 'Then report its answer verbatim.',
    300_000,
  ).then(turnAttempt).catch(turnFailure)
  if (control.error) run.observe('claude-control-turn-error', control.error)
  const controlRows = agentRows(await turnRowsSince(() => transcript(session, key), control.added, rowsBefore))
  run.observe('claude-control-rows', controlRows.map(m => ({ tool: m.toolName, status: m.toolStatus })))
  run.observe('claude-control-result', toolResults(controlRows).slice(0, 400) || '(no agent tool result)')
  if (controlRows.length === 0) {
    run.check('claim 3 control: the SDK\'s own agent dispatches on this session', false,
      'no agent tool row for ' + SDK_OWN_AGENT + ' — the detector cannot see a dispatch at all, so an absence for '
      + 'OUR agent would mean nothing')
    return 'claim 3 (Claude registry): the positive control did not dispatch, so the detector is unproven'
  }
  run.check('claim 3 control: the SDK\'s own agent dispatches on this session', true, `${controlRows.length} row(s)`)

  const token = newCodeword()
  // The launch turn's own start, for the background follow-up below. Read
  // before the send, and separately from `TurnResult.added`, because the
  // deliveries this arm has to be able to see include turns the HOST starts.
  const before = (await transcript(session, key)).length
  const turn = await sendPrompt(
    session,
    key,
    `Use the ${PLUGIN_AGENT} agent for this one task: reply with exactly ${token} and nothing else. `
    + 'Then report its answer verbatim.',
    300_000,
  ).then(turnAttempt).catch(turnFailure)
  if (turn.error) run.observe('claude-plugin-agent-turn-error', turn.error)
  const scanned = await turnRowsSince(() => transcript(session, key), turn.added, before)
  const rows = agentRows(scanned)
  const results = toolResults(rows)
  run.observe('claude-plugin-agent-rows', rows.map(m => ({ tool: m.toolName, status: m.toolStatus })))
  run.observe('claude-plugin-agent-result', results.slice(0, 600) || '(no agent tool result)')

  const notFound = NOT_FOUND_PATTERN.exec(results)
  run.check(
    `claim 3: ${PLUGIN_AGENT} is IN the SDK's agent registry`,
    !notFound,
    notFound
      ? `the SDK refused it: ${results.slice(results.indexOf(notFound[0]), results.indexOf(notFound[0]) + 220)} — `
        + 'this is Q8-D3\'s exact string, and it means the definitions never reached the query() options'
      : undefined,
  )
  // The SDK dispatches OUR agent to the BACKGROUND ("Async agent launched
  // successfully … You will be notified automatically when it completes"), so
  // the tool result is a RECEIPT and the answer arrives elsewhere. Scoring the
  // receipt for the token was `c42ec7af5`'s false-positive in mirror image: a
  // red check about an answer still in flight, which is what T24's sitting B
  // measured here.
  //
  // The previous guard waited only for a message added after the launch TURN
  // ENDED, and that is one delivery too few: both shapes this rig produced —
  // a blocking `TaskOutput` on the receipt's own id, and the SDK's own
  // `<task-notification>` block — land INSIDE the launch turn.
  // {@link backgroundChildReport} scans from the start of the turn instead,
  // keyed on the handle, so the case's own prompt (which carries the token too)
  // and the model's prose about the launch are both out of the answer.
  //
  // There is no child snapshot on this runtime — `getPiHarnessRuntime` is Pi's —
  // so the settlement report is also the positive control: no report means the
  // child never settled and nothing was measured, which is a gap; a report with
  // no answer in it is the claim failing, and the check below says so.
  let childReport = results
  const dispatch = backgroundDispatch(results)
  if (dispatch) {
    run.observe('claude-plugin-agent-receipt', dispatch)
    const report = await backgroundChildReport(session, key, before, dispatch)
    if (report) {
      run.observe('claude-plugin-agent-report', { via: report.via, text: report.text.slice(0, 600) })
      childReport = `${results}\n---\n${report.text}`
    } else if (results.includes(token)) {
      run.observe('claude-plugin-agent-settlement-missing', `no settlement report for ${dispatch.handleId} within `
        + `${COMPLETION_NOTICE_TIMEOUT_MS}ms; the agent results already carried the child's answer`)
    } else {
      return `claim 3 (Claude registry): ${PLUGIN_AGENT} reached the registry and the dispatch went to the background `
        + `as ${dispatch.handleId}, and the child never settled within ${COMPLETION_NOTICE_TIMEOUT_MS}ms — no `
        + 'completion report addressed to it ever reached the parent, so its answer was not measured. The '
        + 'registration itself WAS measured above; this arm reports a gap rather than a defect it did not observe'
    }
  }
  run.check(
    'claim 3: the agent ran and returned its answer',
    childReport.includes(token),
    childReport.includes(token)
      ? `token=${token}`
      // Same split as claim 2, and here it is structural: the no-report case
      // returned above as a GAP, so reaching this branch means a report DID
      // arrive. The message must not say otherwise.
      : dispatch
        ? `the dispatch ${dispatch.handleId} settled and its report ARRIVED without ${token} — the delivery path `
          + `worked and this is the child's own answer: ${childReport.slice(-300)}`
        : `the agent result carried neither ${token} nor a launch receipt: ${results.slice(0, 300)}`,
  )
  return undefined
}

// ---------------------------------------------------------------------------
// Claim 1 — a dead child says why
// ---------------------------------------------------------------------------

async function claimOneDeadChildSaysWhy(
  run: CaseRun,
  session: CdpSession,
  pi: Connection | undefined,
  stalePiSymbols: string[],
): Promise<string | undefined> {
  if (!pi) return 'claim 1 (dead child says why): no Pi connection on this host'
  if (stalePiSymbols.length > 0) run.observe('claim-1-pi-bundle-note', `pi bundle missing ${stalePiSymbols.join(', ')}`)
  if (!DEAD_AGENT) {
    return 'claim 1 (dead child says why): set NESSY_CDP_DEAD_CHILD_AGENT to an agent whose FIRST turn dies. '
      + 'The harness will not manufacture one — it never rewrites the config of the machine it measures. Two recipes '
      + 'that worked: (a) the Q8 one — invalidate the gateway credential through the app\'s own setupLlmConnection '
      + 'and dispatch, so the child\'s session holds one [error] invalid_api_key row; (b) an agent whose system '
      + 'prompt is large enough that the child\'s first request is refused by the gateway while the parent\'s small '
      + 'context still succeeds. Either way the child must DIE, not fail to spawn: a spawn refusal is a different '
      + 'code path and does not exercise b97c774c0'
  }

  const key = await sessionOn(run, session, 'dead-child', pi)
  if (!key) return 'claim 1 (dead child says why): could not open a Pi session'

  const rowsBefore = (await transcript(session, key)).length // F1.521: the fallback's baseline, read before the send
  const turn = await sendPrompt(
    session,
    key,
    `Use the ${DEAD_AGENT} agent for this one task: reply with the single word ALIVE. `
    + 'Then report exactly what the agent tool returned, verbatim, including any error.',
    300_000,
  ).then(turnAttempt).catch(turnFailure)
  if (turn.error) run.observe('dead-child-turn-error', turn.error)

  const scanned = await turnRowsSince(() => transcript(session, key), turn.added, rowsBefore)
  const rows = agentRows(scanned)
  const results = toolResults(rows)
  run.observe('dead-child-agent-rows', rows.map(m => ({ tool: m.toolName, status: m.toolStatus })))
  run.observe('dead-child-tool-result', results.slice(0, 800) || '(no agent tool result)')
  // The child list, from the same snapshot `useAgentPanel` maps into rows. A
  // refused SPAWN also registers a child with `status: 'failed'`, which is why
  // the assertion below is on what the PARENT was told, not on this — but the
  // two together separate "died mid-turn" from "never started".
  const deadChildRuntime = await piRuntime(session, key)
  // D1.310 — with the read's own verdict beside it, so an unreadable snapshot is
  // not read as "never started".
  run.observe('dead-child-children', { ...piReadNote(deadChildRuntime), children: deadChildRuntime.children })

  run.check(
    'claim 1: the parent dispatched the agent at all',
    rows.length > 0,
    rows.length > 0 ? undefined : `no agent tool row; tools seen: ${JSON.stringify(scanned.filter(m => m.toolName).map(m => m.toolName))}`,
  )
  if (rows.length === 0) return 'claim 1 (dead child says why): nothing was dispatched, so there was no death to report'

  // ---- the dispatch went to the BACKGROUND. Follow it. ---------------------
  //
  // Measured 2026-08-13, and it is the DEFAULT, not an accident: `spawner.ts`
  // resolves `args.background ?? (depth === 1)`, so a top-level `subagent` call
  // returned
  //
  //     Started background subagent task
  //     task_id: task-subagent-msrvii86-uut425 agent_ids: agent-subagent-msrvii86-uut425-1
  //
  // and the parent's turn ENDED there. That run had no guard, so the check
  // "claim 1: the reason travels with it, not just the status" reported **ok**
  // with `reason: Started background subagent task task_id: …` — a green check
  // reading a launch announcement. `c42ec7af5` stopped that. It also left the
  // case stopping one turn short of the answer, because the death IS reported,
  // on the NEXT turn: the child settles through `ChildRuntime.monitor`, whose
  // `task_completed` event reaches `deliverMonitorEvent`, which starts a turn
  // carrying `buildBackgroundTaskCompletionNotice`'s
  // `Background subagent task <id> finished (failed).` followed by the child's
  // own `contentForResults` block, inside the `<task-notification>` framing.
  // The receipt is therefore this case's HANDLE on the second turn, not its
  // stopping point.
  //
  // ## Why waiting, and not forcing the dispatch inline
  //
  // Three levers would keep the assertion in one turn, and each measures a path
  // fewer spawns take:
  //
  //   - `NESSY_DISABLE_BACKGROUND_TASKS=1` (`background-task-settings.ts`)
  //     outranks every other input, but it is a RELAUNCH — the flag is read in
  //     the Pi subprocess, which inherits the host env at spawn — so it makes
  //     the case's result depend on how the operator started the app.
  //   - `background: false` on the call (the model-visible guidance literally
  //     says "Pass background:false to wait inline") asks the MODEL to comply,
  //     and the parameter is absent from the schema entirely under fork mode.
  //   - `get_subagent_result(agent_id, wait: true)` blocks in-turn — again the
  //     model's choice, not the case's.
  //
  // Waiting needs none of them, works in every mode including fork mode where
  // two of the three do not exist, and measures what a user actually gets. Its
  // one cost is a second turn to wait for, and the receipt pays for it: `task_id`
  // binds the wait to THIS dispatch, so a notification left by an earlier run
  // cannot be mistaken for this one. That mistake is on this repo's record — a
  // compaction case read a previous run's marker out of a reused session — and
  // it is why the wait keys on the id rather than on the phrase.
  const receipt = BACKGROUND_RECEIPT.exec(results)
  if (receipt) {
    run.observe('dead-child-background-receipt', receipt[0].replace(/\s+/g, ' '))
    const taskId = RECEIPT_TASK_ID.exec(receipt[0])?.[1]
    // Unreachable while BACKGROUND_RECEIPT itself requires `task_id:`; kept
    // because the two expressions are separate on purpose and may drift.
    if (!taskId) {
      return 'claim 1 (dead child says why): the dispatch was backgrounded but no task_id could be read back out of '
        + `the receipt (${receipt[0].replace(/\s+/g, ' ')}), so the completion notification cannot be bound to this run`
    }
    const agentIds = (RECEIPT_AGENT_IDS.exec(results.slice(receipt.index))?.[1] ?? '')
      .split(',').map(id => id.trim()).filter(Boolean)
    run.observe('dead-child-task', { taskId, agentIds })

    const notice = await waitFor(
      async () => findCompletionNotice(await transcript(session, key), taskId),
      value => value !== undefined,
      {
        timeoutMs: COMPLETION_NOTICE_TIMEOUT_MS,
        intervalMs: 5_000,
        label: `the host to deliver the completion notification for ${taskId}`,
      },
    ).catch(() => undefined)

    const settledRuntime = await piRuntime(session, key)
    const settled = settledRuntime.children.filter(child => agentIds.includes(child.agentId))
    // D1.310 — the same list decides GAP vs FAILING below, so the read's own
    // verdict is recorded with it.
    run.observe('dead-child-settled-children', { ...piReadNote(settledRuntime), children: settled })

    if (!notice) {
      // An ABSENCE needs a positive control, and the child's own settled row is
      // it. A child still `starting`/`running` after the window means the window
      // was short or the recipe did not kill it — nothing was measured, so this
      // is a gap. A child that reached a terminal status with no notification is
      // the claim FAILING, measured, and must not be laundered into "could not
      // run": the delivery it did not get is the whole product promise here.
      const terminal = settled.filter(child => child.status !== 'starting' && child.status !== 'running')
      if (settled.length > 0 && terminal.length === settled.length) {
        run.check(
          'claim 1: a settled background child produces a completion notification',
          false,
          `every child of ${taskId} reached a terminal status (${terminal.map(c => `${c.agentId}=${c.status}`).join(', ')}) `
          + `and no "task ${taskId} finished" notification reached the parent within ${COMPLETION_NOTICE_TIMEOUT_MS}ms — `
          + 'the delivery lives at `task_completed` → `deliverMonitorEvent` in SessionManager',
        )
        return undefined
      }
      return `claim 1 (dead child says why): the dispatch went to the background as ${taskId} and no completion `
        + `notification arrived within ${COMPLETION_NOTICE_TIMEOUT_MS}ms, with its child(ren) `
        + `${settled.length > 0 ? settled.map(c => `${c.agentId}=${c.status}`).join(', ') : 'not visible in the runtime snapshot at all'}`
        + ' — so the child had not died yet and there was nothing to report. Give it longer, or make the recipe kill '
        + 'the child sooner, or force the dispatch inline by launching the app with '
        + '`NESSY_DISABLE_BACKGROUND_TASKS=1` (the Pi subprocess inherits the host env, and that flag outranks fork '
        + 'mode, a call-site `background` argument and the depth-0 default). Under fork mode it is the ONLY lever, '
        + 'because `background` is not in the tool schema there'
    }

    run.observe('dead-child-completion-notice', {
      role: notice.role,
      status: notice.status,
      text: notice.text.slice(0, 800),
    })

    // The death PRECONDITION, from the runtime's own snapshot — not from the
    // notice under test. Measured 2026-08-13: the oversized-prompt recipe
    // stopped killing on this rig — the gateway absorbs the 261 946-char
    // system prompt (it fits the model context) and the child simply answers —
    // and this arm then asserted "the parent is told the child FAILED" against
    // a child that LIVED: a red check measuring nothing, the inverse of the
    // green launch-receipt check `c42ec7af5` removed. A live child with a
    // delivered notice still measures the DELIVERY half, so bank that and name
    // the unmeasured half as a gap instead of a finding.
    const childDied = settled.length > 0 && settled.some(child => child.status === 'failed')
    if (!childDied) {
      run.check(
        'claim 1 (delivery half): a background child\'s completion notice reaches the parent with the child\'s own output',
        notice.status === 'completed',
        `the notice for ${taskId} arrived on a follow-up turn; child(ren) settled ${settled.map(c => `${c.agentId}=${c.status}`).join(', ')}`,
      )
      return `claim 1 (dead child says why): the recipe did not kill — child(ren) of ${taskId} settled `
        + `${settled.map(c => `${c.agentId}=${c.status}`).join(', ') || '(none visible)'} and answered the task, so there `
        + 'was no death to report. The delivery path was measured live (the completion notice arrived carrying the '
        + 'child\'s output); the FAILED-shaped notice stays covered by the settling-path seam tests. To re-arm the live '
        + 'half, NESSY_CDP_DEAD_CHILD_AGENT needs a recipe that still kills on this gateway — the oversized-prompt '
        + 'fixture now fits the model context and completes'
    }

    const body = assertParentWasTold(
      run,
      notice.text,
      notice.status === 'failed',
      notice.status === 'failed'
        ? `the host delivered "…task ${taskId} finished (failed)." on a follow-up turn`
        : `the notification for ${taskId} says the run finished (${notice.status}) — the child died and the parent was `
          + 'told otherwise, which is Q8-D1 moved onto the background path',
    )

    // The cross-check that turns "a reason came back" into "the CHILD's own
    // reason came back". `PiHarnessChildSummaryV1.error` is the same
    // `terminalError` that `piChildTranscriptOutcome` handed the monitor, read
    // off the runtime snapshot rather than off the text under test — so the two
    // agreeing is two sources, not one string read twice.
    //
    // A typed field is not a filled field. An empty `error` here downgrades this
    // to an observation instead of reddening the case, because an unpopulated
    // snapshot field would otherwise be filing a product defect it never
    // measured — the exact shape of the `lastCompaction` misreport.
    const childError = normalizeForMatch(settled.map(child => child.error ?? '').join(' '))
    const fragment = childError.slice(0, 80)
    if (fragment.length >= 12) {
      run.check(
        'claim 1: what reached the parent is the CHILD\'s own error text',
        normalizeForMatch(notice.text).includes(fragment),
        `child's own error, from the runtime snapshot: ${fragment}`,
      )
    } else {
      run.observe(
        'dead-child-reason-crosscheck',
        'the runtime snapshot carries no error text for this child, so the notification is the only witness to the '
        + `reason; its body was ${JSON.stringify(body.slice(0, 200))}`,
      )
    }
    return undefined
  }

  // The FOREGROUND shape — the operator forced it, or the dispatch was nested.
  // `contentForResults` renders a failed child as `[ERROR] N. <agent> - error`
  // with the reason as the body. Q8-D1's exact shape was `1. <agent> - done`
  // over a body of `(no output)`, while the child's own session held one
  // `[error]` row.
  const named = /\[ERROR\]/.test(results) || /- error/.test(results)
  assertParentWasTold(run, results, named, named ? undefined : `no error marker in the result: ${results.slice(0, 300)}`)
  return undefined
}

interface CompletionNotice {
  /** `completed` | `failed` | `stopped`, verbatim from the headline. */
  status: string
  /** The delivered message's role, observed rather than assumed. */
  role: string
  /** From the headline to the end of the `<task-notification>` block. */
  text: string
}

/**
 * The completion notification for ONE task id, found in the parent's transcript.
 *
 * `flushPendingTaskNotifications` delivers through `SessionManager.sendMessage`,
 * so the notice arrives as an ordinary transcript message and needs no DOM read.
 * The first occurrence is the delivery itself; anything later is the model
 * quoting it back, which is why this returns the earliest match rather than the
 * newest.
 *
 * The id is matched, not the phrase. `Background <kind> task <id> finished (…)`
 * is unique to this dispatch; `finished` alone is not, and a case that keys on
 * the phrase reports a sibling's obituary as its own.
 */
function findCompletionNotice(messages: TranscriptMessage[], taskId: string): CompletionNotice | undefined {
  const marker = `task ${taskId} finished (`
  for (const message of messages) {
    const at = message.content.indexOf(marker)
    if (at < 0) continue
    const from = at + marker.length
    const close = message.content.indexOf(')', from)
    if (close < 0) continue
    // From the start of the headline LINE, not from the id. `reasonBody` strips
    // the headline by matching it whole (`Background <kind> task … finished (`),
    // so a slice beginning mid-line leaves the tail of the headline behind to be
    // read as the child's reason — which would pass "the reason travels" on a
    // notice carrying no reason at all. The offline probe caught exactly that.
    const lineStart = message.content.lastIndexOf('\n', at) + 1
    const end = message.content.indexOf('</task-notification>', at)
    return {
      status: message.content.slice(from, close),
      role: message.role,
      text: message.content.slice(lineStart, end < 0 ? undefined : end).trim(),
    }
  }
  return undefined
}

/**
 * What is left of a failure report once every STATUS line is removed: the
 * delivery's headline, the `<task-notification>` framing, the per-child header
 * and its `agent_id:`. A report that says `error` and nothing else is the same
 * silence with a new label, and this is what makes that visible.
 */
function reasonBody(report: string): string {
  return report
    .split('\n')
    .map(line => line.trim())
    .filter(line => line
      && !/^Background (?:subagent|workflow) task \S+ finished \(/.test(line)
      && !line.startsWith('<system-reminder>')
      && !line.startsWith('<task-notification>')
      && !line.startsWith('</task-notification>')
      && !/^\[?ERROR?\]?\s*\d+\./.test(line)
      && !/^agent_id:/.test(line)
      && !/^\d+\./.test(line))
    .join(' ')
    .trim()
}

/**
 * Whitespace-insensitive, and blind to the zero-width spaces defanging inserts.
 *
 * The zero-width space is written as `\u200b` and never as the character
 * itself, for the same reason `untrusted-text.ts` gives: a literal one is
 * invisible in source and cannot be grepped for.
 */
function normalizeForMatch(text: string): string {
  return text.replace(/\u200b/g, '').replace(/\s+/g, ' ').trim()
}

/**
 * The three assertions, against whichever text the parent was actually handed.
 *
 * ONE reader for both paths on purpose: the background notification wraps the
 * very same `contentForResults` block the foreground result returns, so a second
 * reader would be a second chance to disagree about what counts as a reason. The
 * labels are unchanged from the runs already on record.
 */
function assertParentWasTold(run: CaseRun, report: string, failed: boolean, failedDetail?: string): string {
  const silent = /\(no output\)/.test(report)
  run.check(
    'claim 1: the parent is not told a dead child completed silently',
    !silent,
    silent
      ? 'the report still carries `(no output)` — Q8-D1 unchanged: the child died and the parent was told it was done'
      : undefined,
  )
  run.check('claim 1: the parent is told the child FAILED', failed, failedDetail)
  const body = reasonBody(report)
  run.observe('dead-child-reason', body.slice(0, 400) || '(the report carried no body at all)')
  // `failed` is load-bearing here and is NOT redundant with the check above it.
  // Without it the assertion reads "some non-empty text came back", which is
  // equally true of a launch receipt, of a header with `(no output)` under it,
  // and of a child that succeeded — that is exactly how it passed on the receipt
  // of 2026-08-13. The status is what turns "a reason" into "a FAILURE reason".
  // `NO_SUMMARY_NOTICE` is the third silence: the notice builder's own stand-in
  // for a summary it never received, which is prose about the absence of a
  // reason rather than a reason.
  const reasonCarried = failed
    && body.length > 0
    && !/^\(no output\)$/.test(body)
    && !body.startsWith(NO_SUMMARY_NOTICE)
  run.check(
    'claim 1: the reason travels with it, not just the status',
    reasonCarried,
    reasonCarried
      ? `reason: ${body.slice(0, 200)}`
      : failed
        ? `the report carries a failure status and nothing beyond it: ${body.slice(0, 200) || '(empty)'}`
        : `no child failed here, so there is no reason to travel: ${report.slice(0, 200)}`,
  )
  return body
}

if (import.meta.main) {
  await main(ID, TITLE, drive)
}

export const meta = { id: ID, title: TITLE }
