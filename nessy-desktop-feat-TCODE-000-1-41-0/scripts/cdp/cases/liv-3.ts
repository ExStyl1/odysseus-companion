/**
 * LIV-3 — A MODEL SWITCH MID-CONVERSATION COSTS NO RESTART.
 *
 * L4's row, live. The claim it ships with is deliberately narrower than the
 * plan's original sentence, and the narrowing is L4's own correction: *"switching
 * model mid-session stops costing the context"* is false — today's product
 * already keeps context, because every non-retry turn resumes on the persisted
 * session id. What a switch used to cost was a PROCESS: a spawn, a transcript
 * replay, a prompt-cache miss. So the honest claim, and this case's, is **"stops
 * costing a restart"**.
 *
 * ## Three readings, and why all three are needed
 *
 * 1. **The pid does not change.** `lib/claude-child.ts` explains the instrument.
 * 2. **The child's COMMAND LINE still names the OLD model.** It is fixed at
 *    spawn, so this is the positive form of the same fact: the process was not
 *    rebuilt for the new model, it was *told*.
 * 3. **The upstream answered as the NEW model.** Read from the SDK's own
 *    transcript, where every assistant entry carries `message.model` — the same
 *    source L0 used, and not our own init readout. Without it the case would
 *    pass on a switch that never took effect: "same process, no error" is
 *    exactly what a silently ignored `setModel` looks like.
 *
 * ## The precondition, which is the part that decides whether this is even a
 * live switch
 *
 * `claudeLiveSessionSignature` hashes what the running child cannot be told, and
 * `model` is NOT in it — but three things DERIVED from the model are:
 * `thinking`, `effort`, and `env` (the two `CLAUDE_CODE_*` context-window vars
 * `buildClaudeMaxContextTokensEnv` / `buildClaudeAutoCompactWindowEnv` resolve
 * from the model's stored `contextWindow`). A switch that moves any of them
 * respawns BY DESIGN, and L4 pinned both arms. So the pair of models this case
 * uses must derive the same shape, or it would report a documented respawn as a
 * defect.
 *
 * The predicates are RESTATED here rather than imported — the cdp harness has
 * its own tsconfig and does not resolve the workspace aliases. A restatement
 * that drifts from `resolveClaudeThinkingOptions` shows up as a wrong
 * expectation and therefore a visible failure, never as a silent pass.
 *
 * ## THE CONTROL
 *
 * "No restart" is an absence, and this repo's rule is that an absence needs a
 * positive control on the same rig. The case ends by forcing the respawn the
 * product owes — `/clear` breaks the resume anchor, which `ensureLiveSession`
 * answers with a new child — and requires the same instrument to report a
 * DIFFERENT pid. A detector that cannot see a restart cannot certify its
 * absence. (L4's other respawn arm, leaving the model family, is not reachable
 * on a card whose models are all one family; when it is, it is the better
 * control and this comment is where to say so.)
 */

import { randomBytes } from 'node:crypto'

import {
  assertProcessInstrument,
  childIdentity,
  clearConversation,
  echoTurn,
  etimeSeconds,
  resolveClaudeCard,
  sessionDirOf,
  waitForChildCount,
  type ClaudeChild,
} from '../lib/claude-child.ts'
import type { CdpSession } from '../lib/connect.ts'
import { ensureDarkTheme } from '../lib/mcp-fixture.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import { configDir, entryIdentity, readClaudeSessionLog } from '../lib/runtime-session-log.ts'
import { listConnections, selectModel, switchRuntime, waitForConnection } from '../lib/runtime-switch.ts'
import { assertElectronApi, freshSession, type SessionKey } from '../lib/state.ts'

const ID = 'LIV-3'
const TITLE = 'Switching the model mid-conversation on Claude keeps the same child process, and the next turn runs on the new model'

const TURN_TIMEOUT_MS = 240_000

function token(prefix: string): string {
  return `${prefix}${randomBytes(3).toString('hex').toUpperCase()}`
}

function child(entry: ClaudeChild): Record<string, unknown> {
  return { pid: entry.pid, startedAt: entry.lstart, elapsed: entry.etime, spawnedWithModel: entry.spawnModel }
}

// ---------------------------------------------------------------------------
// The derived-shape predicates, restated from `config/models.ts` and
// `claude-agent.ts` (see the header for why they are restated and not imported)
// ---------------------------------------------------------------------------

/** `isClaudeModel` — bare, provider-prefixed and Bedrock-native spellings. */
function isClaudeModel(id: string): boolean {
  const lower = id.toLowerCase()
  return lower.startsWith('claude-') || lower.includes('/claude') || lower.includes('.claude')
}

/** `resolveClaudeThinkingOptions`'s own haiku exclusion from adaptive thinking. */
function isHaiku(id: string): boolean {
  return id.toLowerCase().includes('haiku')
}

/** `isAdaptiveThinkingAlwaysOnModel` — the Mythos-class arm. */
function isAdaptiveAlwaysOn(id: string): boolean {
  return /claude-(fable|mythos)/i.test(id)
}

/**
 * `resolveSpawnModelContextWindow` — the number both `CLAUDE_CODE_*` env vars
 * are built from, and `undefined` for a `claude-`-prefixed id (where the binary
 * ignores the env anyway).
 */
function spawnContextWindow(id: string, contextWindow: number | undefined): number | undefined {
  if (id.startsWith('claude-')) return undefined
  if (typeof contextWindow !== 'number' || !Number.isFinite(contextWindow) || contextWindow <= 0) return undefined
  return Math.floor(contextWindow)
}

interface ModelShape {
  id: string
  claudeFamily: boolean
  haiku: boolean
  adaptiveAlwaysOn: boolean
  contextWindow: number | undefined
}

function shapeOf(id: string, contextWindow: number | undefined): ModelShape {
  return {
    id,
    claudeFamily: isClaudeModel(id),
    haiku: isHaiku(id),
    adaptiveAlwaysOn: isAdaptiveAlwaysOn(id),
    contextWindow: spawnContextWindow(id, contextWindow),
  }
}

function sameDerivedShape(a: ModelShape, b: ModelShape): boolean {
  return a.claudeFamily === b.claudeFamily
    && a.haiku === b.haiku
    && a.adaptiveAlwaysOn === b.adaptiveAlwaysOn
    && a.contextWindow === b.contextWindow
}


/**
 * Which models the upstream has answered as, keyed by ENTRY IDENTITY.
 *
 * The identity, not the position, and the lib's own comment says why: *"Never the
 * array index: a compaction REWRITES the conversation the file replays, so
 * positions move under a case that trusted them."* There is a second way to lose
 * it here — `readClaudeSessionLog` concatenates every `.jsonl` in the session
 * directory in MTIME order, and the SDK was measured abandoning one transcript
 * mid-run and continuing in another (2026-08-15), so a late write to the
 * abandoned file flips the order and a positional slice reads the OLD file's
 * tail as this turn's model. Which is a false FAIL, or worse a false PASS if that
 * tail happens to name the model we switched TO.
 */
function upstreamModels(key: SessionKey): { byEntry: Map<string, string>; files: number; reason?: string } {
  const log = readClaudeSessionLog(key.workspaceId, configDir(), key.sessionId)
  if (log.reason) return { byEntry: new Map(), files: 0, reason: log.reason }
  const byEntry = new Map<string, string>()
  for (const entry of log.entries) {
    const message = entry.raw.message
    if (!message || typeof message !== 'object') continue
    const model = (message as Record<string, unknown>).model
    if (typeof model === 'string' && model.length > 0) byEntry.set(entryIdentity(entry), model)
  }
  return { byEntry, files: log.files?.length ?? (log.file ? 1 : 0) }
}

/** Models on entries present in `after` and absent from `before`, by identity. */
function modelsAddedSince(before: Map<string, string>, after: Map<string, string>): string[] {
  return [...after].filter(([identity]) => !before.has(identity)).map(([, model]) => model)
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)
  run.observe('theme', await ensureDarkTheme(session))
  assertProcessInstrument(run)

  const card = await resolveClaudeCard(session, run, { caseId: ID })
  run.observe('card under test', card.slug)

  // ---- the model pair, chosen by the derived shape rather than by position --
  const connection = (await listConnections(session)).find(row => row.slug === card.slug)!
  const catalogue = await session.call<Array<{ id: string; contextWindow?: number }>>(`
    const rows = await window.electronAPI.listLlmConnections()
    const row = (rows ?? []).find(c => c.slug === ${JSON.stringify(card.slug)})
    return (row?.models ?? []).map(m => typeof m === 'string' ? { id: m } : { id: m.id, contextWindow: m.contextWindow })
  `)
  const shapes = catalogue.filter(entry => typeof entry.id === 'string').map(entry => shapeOf(entry.id, entry.contextWindow))
  run.observe('the card\'s models and their derived shapes', shapes)
  const pair = (() => {
    for (let i = 0; i < shapes.length; i += 1) {
      for (let j = 0; j < shapes.length; j += 1) {
        // The id inequality is not implied by `i !== j`: a catalogue can carry
        // one id twice (an alias, a duplicated row). With `from.id === to.id`
        // every one of this case's five readings passes while NO SWITCH HAS
        // HAPPENED — the pid is unchanged, the command line still "names the old
        // model", the upstream "answered as the new model". That is a detector
        // reporting PASS for a mechanism that never ran, which is the one
        // outcome this case must never produce.
        if (i === j || shapes[i]!.id === shapes[j]!.id) continue
        if (sameDerivedShape(shapes[i]!, shapes[j]!)) return [shapes[i]!, shapes[j]!] as const
      }
    }
    return undefined
  })()
  if (!pair) {
    blocked(
      `${card.slug} offers no two models with the same DERIVED session shape, so every switch on it respawns by `
      + 'design and this case has nothing live to measure. A pair must agree on Claude-family membership, on being '
      + 'Haiku, on adaptive-always-on, and on the stored contextWindow the two CLAUDE_CODE_* env vars are built from '
      + `— all four are hashed into claudeLiveSessionSignature. This card offers: ${JSON.stringify(shapes)}. `
      + 'Point NESSY_CDP_CLAUDE_CARD at a card with two same-shaped models, or add a second model to this one.',
    )
  }
  const [from, to] = pair
  run.observe('the switch under test', { from: from.id, to: to.id })

  const key = await freshSession(session, `CDP ${ID} ${new Date().toISOString().slice(11, 19)}`)
  run.observe('session', { workspaceId: key.workspaceId, sessionId: key.sessionId, connectionDefault: connection.defaultModel })
  run.require('the case ran in a session it created', key.fresh,
    key.fresh ? undefined : `${key.reason} (inherited ${key.inheritedMessages} messages)`)

  const outcome = await switchRuntime(session, key.sessionId, card.slug)
  run.observe('switch onto the claude card', outcome)
  const active = await waitForConnection(session, key.sessionId, card.slug)
  run.require(`the session runs on ${card.slug}`, active === card.slug, `llmConnection=${String(active)}`)

  const dir = sessionDirOf(key)
  const selectedFrom = await selectModel(session, key, from.id)
  run.require(`the session starts on ${from.id}`, selectedFrom === from.id, `getSessionModel=${String(selectedFrom)}`)

  // ---- turn 1, on the first model -----------------------------------------
  const first = token('ALPHA')
  await echoTurn(session, run, key, 'turn 1', first, TURN_TIMEOUT_MS)

  const afterTurn1 = await waitForChildCount(dir, 1)
  run.observe('child after turn 1', afterTurn1.map(child))
  run.require('exactly one child served turn 1', afterTurn1.length === 1, JSON.stringify(afterTurn1.map(child)))
  const original = afterTurn1[0]!
  run.check(`that child was SPAWNED with ${from.id}`, original.spawnModel === from.id, String(original.spawnModel))

  const modelsAfterTurn1 = upstreamModels(key)
  // Spread the Map: `JSON.stringify` renders one as `{}`, and an observation
  // that always prints empty is read as "nothing was there" by whoever finds
  // this record later.
  run.observe('upstream models after turn 1', {
    models: [...modelsAfterTurn1.byEntry.values()],
    files: modelsAfterTurn1.files,
    ...(modelsAfterTurn1.reason ? { reason: modelsAfterTurn1.reason } : {}),
  })
  run.require('the SDK transcript is readable and reports the model it answered as',
    modelsAfterTurn1.reason === undefined && modelsAfterTurn1.byEntry.size > 0,
    modelsAfterTurn1.reason === undefined && modelsAfterTurn1.byEntry.size > 0
      ? `${modelsAfterTurn1.byEntry.size} model-bearing entries in ${modelsAfterTurn1.files} file(s)`
      : modelsAfterTurn1.reason ?? 'no assistant entry carried a `model` field')
  run.check(`turn 1 was answered upstream as ${from.id}`,
    [...modelsAfterTurn1.byEntry.values()].every(model => model === from.id),
    JSON.stringify([...new Set(modelsAfterTurn1.byEntry.values())]))

  // ---- the switch ----------------------------------------------------------
  const switchStarted = Date.now()
  const selectedTo = await selectModel(session, key, to.id)
  const switchMs = Date.now() - switchStarted
  run.observe('the model switch', { to: to.id, reportedBack: selectedTo, ms: switchMs })
  run.require(`the session reports ${to.id} after the switch`, selectedTo === to.id, String(selectedTo))

  const atSwitch = await waitForChildCount(dir, 1, 5_000)
  run.observe('children immediately after the switch', atSwitch.map(child))
  run.check('the switch alone started no new process',
    atSwitch.length === 1 && childIdentity(atSwitch[0]!) === childIdentity(original),
    JSON.stringify(atSwitch.map(child)))

  // ---- turn 2, on the second model ----------------------------------------
  const second = token('BETA')
  await echoTurn(session, run, key, 'turn 2', second, TURN_TIMEOUT_MS)

  const afterTurn2 = await waitForChildCount(dir, 1, 5_000)
  run.observe('children after turn 2', afterTurn2.map(child))
  run.check(
    'THE CLAIM: the model switch cost no restart — the same process, by pid AND absolute start time, answered both turns',
    afterTurn2.length === 1 && childIdentity(afterTurn2[0]!) === childIdentity(original),
    `turn 1: ${childIdentity(original)}; after turn 2: ${JSON.stringify(afterTurn2.map(childIdentity))}`,
  )
  run.check(
    'and it has been running the whole time rather than being replaced by a same-pid coincidence',
    afterTurn2.some(entry => childIdentity(entry) === childIdentity(original)
      && etimeSeconds(entry.etime) > etimeSeconds(original.etime)),
    `etime ${original.etime} -> ${JSON.stringify(afterTurn2.map(entry => entry.etime))}`,
  )
  run.check(
    `the surviving process still carries ${from.id} on its COMMAND LINE — it was told about the new model, not rebuilt for it`,
    afterTurn2.every(entry => entry.spawnModel === from.id),
    JSON.stringify(afterTurn2.map(entry => entry.spawnModel)),
  )

  const modelsAfterTurn2 = upstreamModels(key)
  const newModels = modelsAddedSince(modelsAfterTurn1.byEntry, modelsAfterTurn2.byEntry)
  run.observe('upstream models added by turn 2', newModels)
  run.check(
    `AND THE SWITCH TOOK EFFECT: the upstream answered turn 2 as ${to.id}`,
    newModels.length > 0 && newModels.every(model => model === to.id),
    newModels.length === 0
      ? 'the SDK transcript grew no assistant entry for turn 2, so nothing says which model answered'
      : `${JSON.stringify([...new Set(newModels)])} — a switch that reported success and did not reach the upstream `
        + 'would leave the pid unchanged too, which is why this reading is not optional',
  )

  // ---- THE CONTROL: force the restart the product owes ---------------------
  const cleared = await clearConversation(session, key)
  run.observe('/clear', cleared)
  run.require('the app cleared the conversation', cleared.after === 0, `${cleared.before} -> ${cleared.after} messages`)
  const third = token('GAMMA')
  await echoTurn(session, run, key, 'turn 3 (after /clear)', third, TURN_TIMEOUT_MS)
  const afterClear = await waitForChildCount(dir, 1, 5_000)
  run.observe('children after the forced respawn', afterClear.map(child))
  run.check(
    'THE CONTROL: the same instrument reports a DIFFERENT process when the app must respawn, so "no restart" above '
    + 'was a measurement rather than a blind spot',
    afterClear.some(entry => childIdentity(entry) !== childIdentity(original)),
    `${childIdentity(original)} -> ${JSON.stringify(afterClear.map(childIdentity))}`,
  )
  run.check(
    `and the respawned child was SPAWNED with ${to.id} — the switch outlived the process it was applied to`,
    afterClear.every(entry => entry.spawnModel === to.id),
    JSON.stringify(afterClear.map(entry => entry.spawnModel)),
  )
}

if (import.meta.main) {
  await main(ID, TITLE, drive)
}

export const meta = { id: ID, title: TITLE }
