/**
 * AGT-5 — a subagent may think harder than its parent.
 *
 * Before `aebf72db` a subagent's effort was clamped down to the parent's, so a
 * deliberately deep-thinking subagent silently ran shallow. The second half
 * matters as much: the defect was that inheritance was captured too early, so a
 * MID-SESSION level change must apply to the next spawn. Spawning once proves
 * nothing.
 *
 * ## The effort a spawn RAN AT is readable from the renderer
 *
 * This case used to end in an unconditional `blocked()` saying "no field of the
 * Pi runtime snapshot carries it". That was false when it was written and is
 * false now. `childState.children[]` carries `effort` and `model`
 * (`packages/shared/src/protocol/pi-harness-runtime.ts` — the child record's
 * `exact()` key list ends `…, 'error', 'effort', 'model'`), populated by
 * `SessionManager` from `child.restrictions?.thinkingLevel`, whose per-subagent
 * meaning `packages/core/src/types/pi-harness-runtime.ts` states verbatim: "the
 * reasoning effort set for that subagent, in its definition frontmatter or on
 * the individual invocation". `lib/state.ts` `piRuntime()` simply dropped the
 * field on its way through; it no longer does.
 *
 * ## Two subagents, because the precedence makes one of them useless for half 2
 *
 * `resolveEffortLevel` (`packages/shared/src/agent/thinking-levels.ts`) is
 * `invocation ?? declared ?? session`. A DECLARED level therefore OUTRANKS the
 * session's, which has a consequence the obvious one-agent version of this case
 * gets wrong: spawn a `effort: high` subagent at session `low`, change the
 * session to `high`, spawn it again — both spawns report `high`, and "the
 * second reflects the mid-session change" is true without the change having
 * done anything. That is a vacuous pass, and it is the exact shape of the
 * defect this row exists to catch.
 *
 * So the two halves need two different agents:
 *
 *   half 1  `NESSY_CDP_HIGH_EFFORT_SUBAGENT` declares a high effort. Its child
 *           must report an effort STRICTLY ABOVE the session's `low`. That is
 *           the `aebf72db` claim, and the declaring agent is the only one that
 *           can make it.
 *   half 2  `NESSY_CDP_SESSION_EFFORT_SUBAGENT` declares NO effort, so the
 *           SESSION level is what reaches it. Spawned once at `low` and once
 *           after the level is moved to `high`, its two child records must
 *           differ — which is precisely "inheritance is not captured too early".
 *
 * ## Why the assertion is an ORDERING and never an equality
 *
 * The reported effort is APPLIED, not configured: `effectiveThinkingLevel` ends
 * in `clampThinkingLevelToModel`, and `core/types/pi-harness-runtime.ts` says so
 * in the field's own doc — "A row whose purpose is telling the user what RAN
 * must not report a level that did not run, so the clamped value is what
 * ships." An assertion that the child reports exactly `high` would fail on a
 * model whose family cannot run `high`, reporting a product defect about
 * correct clamping. `low` → `high` avoids the one narrowing this build knows
 * (`xhigh` on Opus/Sonnet 4.6), and the checks below compare ranks.
 *
 * Levels are six: off, low, medium, high, xhigh, max
 * (`packages/shared/src/agent/thinking-levels.ts`).
 */

import { sendPrompt } from '../lib/chat.ts'
import type { CdpSession } from '../lib/connect.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import {
  assertElectronApi,
  effortRank,
  freshSession,
  listSessions,
  piChildren,
  piRuntime,
  setThinkingLevel,
  type PiChild,
  type SessionKey,
} from '../lib/state.ts'

const ID = 'AGT-5'
const TITLE = 'A subagent runs at a higher effort than its parent; a mid-session level change applies to the next spawn'

/** A named subagent whose definition asks for a HIGH effort level. */
const SUBAGENT = process.env.NESSY_CDP_HIGH_EFFORT_SUBAGENT?.trim()
/**
 * A named subagent whose definition declares NO effort at all.
 *
 * Half 2's instrument. With `invocation ?? declared ?? session` precedence, a
 * declaring agent masks the session level entirely, so only an agent that
 * declares nothing can show a mid-session change reaching the next spawn.
 */
const SESSION_SUBAGENT = process.env.NESSY_CDP_SESSION_EFFORT_SUBAGENT?.trim()

const PARENT_LEVEL = 'low'
const RAISED_LEVEL = 'high'

async function thinkingLevel(session: CdpSession, key: SessionKey): Promise<string | undefined> {
  return session.call<string | undefined>(`
    const all = await window.electronAPI.getSessions()
    const s = (all ?? []).find(x => x.id === ${JSON.stringify(key.sessionId)})
    return s ? s.thinkingLevel : undefined
  `)
}

/**
 * Spawn `agent` and return the child record THIS prompt created.
 *
 * "New" is load-bearing for the same reason `lib/fork.ts` `startFork` records:
 * `childState.children` accumulates every child the session has ever had, so
 * reading the first match returns the OLDEST one and half 2 would compare a
 * spawn against itself.
 */
async function spawnAndRead(
  run: CaseRun,
  session: CdpSession,
  key: SessionKey,
  label: string,
  agent: string,
  question: string,
): Promise<PiChild | undefined> {
  const before = new Set((await piChildren(session, key, `${label} baseline`)).map(c => c.agentId))
  const turn = await sendPrompt(
    session,
    key,
    `Use the ${agent} subagent to answer: "${question}" Report its answer verbatim.`,
    240_000,
  )
  const tools = turn.added.filter(m => m.role === 'tool').map(m => m.toolName)
  run.observe(`${label}-tools`, tools)
  // D1.265 — `piChildren` BLOCKS when the snapshot read threw, instead of
  // handing back an empty list this case would report as "no new child
  // registered for <agent>" over a turn whose transcript carries the child's
  // answer. That sentence is what the fourth measure sitting met.
  const fresh = (await piChildren(session, key, `a new ${agent} child`)).filter(c => !before.has(c.agentId))
  run.observe(`${label}-new-children`, fresh)
  // Prefer a child whose `agent` names the one we asked for: a model that also
  // spawned something else in the same turn must not have its OTHER child's
  // effort scored as this agent's.
  const short = agent.split('/').pop() ?? agent
  return fresh.find(c => c.agent === agent || c.agent === short || c.agent.endsWith(`/${short}`)) ?? fresh[0]
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)
  const key = await freshSession(session, `CDP ${ID} ${new Date().toISOString().slice(11, 19)}`)
  run.observe('session', { workspaceId: key.workspaceId, sessionId: key.sessionId })
  run.observe('session-origin', key.fresh ? 'created by this run' : `CONTAMINATED: ${key.reason}`)
  run.check('the case ran in a session it created', key.fresh, key.fresh ? undefined : `inherited ${key.inheritedMessages} messages`)

  if (!SUBAGENT || !SESSION_SUBAGENT) {
    blocked(
      'this case needs TWO installed subagents and will not write either — an agent definition is configuration. '
      + 'NESSY_CDP_HIGH_EFFORT_SUBAGENT = a subagent whose frontmatter carries `effort: high` (half 1: without one '
      + 'there is nothing that could out-think the parent, and the case would pass vacuously). '
      + 'NESSY_CDP_SESSION_EFFORT_SUBAGENT = a subagent whose frontmatter declares NO effort (half 2: '
      + '`resolveEffortLevel` is `invocation ?? declared ?? session`, so a DECLARING agent masks the session level '
      + 'and both spawns would report the declared value — a pass that measures nothing). '
      + `Currently: high=${SUBAGENT ?? 'unset'}, session=${SESSION_SUBAGENT ?? 'unset'}. `
      + 'Both are two markdown files under <configDir>/agents/; '
      + '`bun run scripts/cdp/fixtures/agent-surfaces.ts` writes a pair and prints the invocation.',
    )
  }

  // ---- 1. the session is set low -------------------------------------------
  await setThinkingLevel(session, key.sessionId, PARENT_LEVEL)
  const low = await thinkingLevel(session, key)
  run.observe('session-thinking-level', low)
  run.require('the session sits at low', low === PARENT_LEVEL, `thinkingLevel=${low}`)

  // ---- 2. the declaring subagent must out-think the parent -----------------
  const declaring = await spawnAndRead(run, session, key, 'declared-spawn', SUBAGENT, 'Name three prime numbers above 100.')
  run.require('the declaring subagent was spawned', declaring !== undefined, `no new child registered for ${SUBAGENT}`)
  if (declaring!.effort === undefined) {
    // Not "the field does not exist" — it is optional on the wire precisely so
    // a host predating it keeps parsing, and this build would then be one.
    blocked(
      `the child record for ${SUBAGENT} carries no \`effort\`, so this host predates the field being put on the wire `
      + '(`protocol/pi-harness-runtime.ts` appends `effort`/`model` LAST and both optional, so an older summary parses '
      + 'with them absent). Rebuild (`bun run electron:build:servers`) and relaunch before measuring — a run against '
      + 'this bundle cannot see the effort at all, and reporting that as a product defect would be wrong. '
      + `Child as read: ${JSON.stringify(declaring)}`,
    )
  }
  run.observe('declared-spawn-effort', { effort: declaring!.effort, model: declaring!.model })
  run.check(
    'the declaring subagent ran ABOVE the parent\'s low',
    effortRank(declaring!.effort) > effortRank(PARENT_LEVEL),
    `child effort=${declaring!.effort} (rank ${effortRank(declaring!.effort)}) vs parent ${PARENT_LEVEL} `
    + `(rank ${effortRank(PARENT_LEVEL)}), model=${declaring!.model ?? 'unreported'}`,
  )

  // ---- 3. the session level reaches a subagent that declares nothing -------
  const beforeChange = await spawnAndRead(run, session, key, 'session-spawn-low', SESSION_SUBAGENT, 'Name three prime numbers above 200.')
  run.require('the non-declaring subagent was spawned at the parent level', beforeChange !== undefined, `no new child registered for ${SESSION_SUBAGENT}`)
  run.observe('session-spawn-low-effort', { effort: beforeChange!.effort, model: beforeChange!.model })
  if (beforeChange!.effort !== undefined && effortRank(beforeChange!.effort) !== effortRank(PARENT_LEVEL)) {
    // The control for half 2. If this agent does NOT take the session level,
    // it declares one after all (or the invocation carried one), and the
    // comparison below would score the wrong thing.
    blocked(
      `${SESSION_SUBAGENT} ran at ${beforeChange!.effort} while the session was at ${PARENT_LEVEL}, so it is not a `
      + 'non-declaring agent: something outranked the session (`invocation ?? declared ?? session`), and a change to '
      + 'the session level would therefore be invisible to it. Point NESSY_CDP_SESSION_EFFORT_SUBAGENT at an agent '
      + 'whose frontmatter has no `effort:` line, or check whether the model passed one on the Agent call itself.',
    )
  }

  // ---- 4. change the level mid-session and spawn it again ------------------
  await setThinkingLevel(session, key.sessionId, RAISED_LEVEL)
  const high = await thinkingLevel(session, key)
  run.observe('session-thinking-level-after-change', high)
  run.require('the mid-session level change took', high === RAISED_LEVEL, `thinkingLevel=${high}`)

  const afterChange = await spawnAndRead(run, session, key, 'session-spawn-high', SESSION_SUBAGENT, 'Name three prime numbers above 300.')
  run.require('the non-declaring subagent was spawned a second time', afterChange !== undefined, `no new child registered for ${SESSION_SUBAGENT}`)
  run.observe('session-spawn-high-effort', { effort: afterChange!.effort, model: afterChange!.model })
  run.check(
    'the mid-session level change reached the NEXT spawn',
    effortRank(afterChange!.effort) > effortRank(beforeChange!.effort),
    `before=${beforeChange!.effort} after=${afterChange!.effort} — equal means inheritance was captured before the `
    + 'change, which is the aebf72db defect',
  )
  // Deliberately NOT a check that the second spawn equals `high`. The reported
  // level is the CLAMPED one, so a model whose family cannot run `high` reports
  // lower and an equality here would file a product defect about correct
  // clamping. The ordering check above is the claim; this pair is the evidence.
  run.observe('the raised level as asked for, and as it ran', {
    sessionAskedFor: RAISED_LEVEL,
    childRanAt: afterChange!.effort,
    childModel: afterChange!.model ?? 'unreported',
  })

  run.observe('sessions-snapshot', (await listSessions(session)).find(s => s.id === key.sessionId))
  run.observe('all-children', (await piRuntime(session, key)).children)
}

if (import.meta.main) {
  await main(ID, TITLE, drive)
}

export const meta = { id: ID, title: TITLE }
