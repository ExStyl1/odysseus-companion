/**
 * RS-52 (D1.27) — is the `small` tier really covered on Pi, or covered on one
 * tier of one connection family?
 *
 * ## The claim under test
 *
 * `SessionManager` defaults the Pi orchestrator's `small` tier to the gateway's
 * cheap model, in its own words: *"default the orchestrator `small` tier to the
 * active provider's cheap model when its catalog exposes the Nessy Gateway
 * `fast` alias, so read-only small-tier subagents (e.g. `scout`) don't burn the
 * flagship."* It resolves through `resolveGatewayFastModelId`, which matches a
 * model whose `shortName` is `fast`; `medium` and `big` stay unset and inherit
 * the session model. So the capability is REAL on a catalogue that publishes the
 * alias and ABSENT on one that does not — which is the whole of the row's
 * question, and why the ledger cell is expected to demote from `covered`.
 *
 * ## The two arms, and why they are the SAME card
 *
 * The row's own recipe says two connections: a gateway card with a completed
 * refresh, and a BYO connection with no `fast` alias. Two different cards differ
 * in the endpoint, the credential, the catalogue AND the alias, so a difference
 * between them is attributable to four things.
 *
 * This case varies ONE: it drives the gateway card, then drives the SAME card
 * with the `fast` `shortName` stripped from its stored catalogue through the
 * app's own `saveLlmConnection`, and restores the original models array in a
 * `finally`. Endpoint, credential and model ids are byte-identical across the
 * two arms; the alias is the only thing that moved. The same pattern the `STR-*`
 * cases already use for `midStreamBehavior`.
 *
 * ## The control, in both arms
 *
 * `planner` — a builtin whose tier is `medium`, which the host deliberately
 * leaves unset. It must resolve to the SESSION model in BOTH arms. Without it,
 * arm B's *"the child ran on the session model"* is indistinguishable from *"the
 * tier map never did anything on this build"*, which is the finding the case is
 * trying to establish rather than assume.
 *
 * ## The detector, and the two values that can disagree
 *
 * `piChildRestrictions.model` in the CHILD session's own record — the value
 * `resolveAgentModelId` produced and the host wrote. It is read from
 * `<config>/sessions/<workspaceId>/<childSessionId>/session.jsonl`, a file the
 * feature itself writes.
 *
 * NOT the child record's `model` field, which is the model the runtime ended up
 * calling: the two can disagree, and on the contaminated first drive of this row
 * they did — restrictions said `opus` while the stored model said the session's
 * deepseek, because `resolveModelForProvider` clears a model the catalogue does
 * not list. Both travel in the observation, because a reader given only one of
 * them has half the seam.
 *
 * ## THE RIG PRECONDITION THIS CASE EXISTS BECAUSE OF
 *
 * A sitting lane is a Claude Code agent, and that agent's shell exports
 * `CLAUDE_CODE_SUBAGENT_MODEL` — which the Pi spawner reads. Measured
 * 2026-09-17: with it inherited by the packaged app, EVERY `scout` spawn on this
 * gateway card resolved to `opus`, a model the gateway does not serve, and the
 * tier map never entered the resolution at all. `lib/app-env.ts` reads the
 * running app's own environment and this case BLOCKS on it, because the reading
 * that contamination produces looks exactly like a product finding.
 *
 * ## What this case creates and removes
 *
 * Sessions it names itself, and one edit to the rig profile's own stored
 * catalogue, restored in a `finally` by writing the original models array back
 * and reading it to confirm. Nothing outside `NESSY_CONFIG_DIR` is touched; no
 * credential is read, printed or written.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { sendPrompt } from '../lib/chat.ts'
import { appEnvBlockReason, readAppEnvContamination } from '../lib/app-env.ts'
import type { CdpSession } from '../lib/connect.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import { writableConfigDir } from '../lib/runtime-session-log.ts'
import { listConnections, runtimeOf, switchRuntime } from '../lib/runtime-switch.ts'
import { assertElectronApi, freshSession, type SessionKey } from '../lib/state.ts'
import type { CaseMeta, SittingRecipe } from '../lib/sitting.ts'

const ID = 'RS-52'
const TITLE = 'the Pi `small` tier: does a `scout` child really run on the gateway\'s `fast` model, and what happens when the alias is gone'

export const meta = {
  id: ID,
  title: TITLE,
  row: 'D1.27',
  runtimes: ['pi'],
  credentials: 'owner: the one-click Nessy Gateway Pi card. No key is read; the case never touches the dp file.',
} as const satisfies CaseMeta

export const manual = {
  steps: [
    '1. PACKAGED build, dark theme, one content panel, a config dir created for the run, and the app launched with CLAUDE_CODE_SUBAGENT_MODEL and CLAUDE_CODE_SUBAGENT_MODEL_FORCE DELETED from its environment — `ps eww -p <pid>` afterwards, because the app is what must be clean.',
    '2. Assert the gateway card\'s catalogue carries a model whose `shortName` is `fast`. Before the refresh it is "Qwen Fast" and the arm measures a false negative (P6.163\'s rig hazard).',
    '3. ARM A — a new session on that card: ask it to dispatch the `scout` builtin (tier `small`) and nothing else.',
    '4. ARM A CONTROL — a new session on the same card: dispatch `planner` (tier `medium`, deliberately unmapped).',
    '5. Strip the `fast` `shortName` from the stored catalogue through the app\'s own saveLlmConnection. Endpoint, credential and ids unchanged.',
    '6. ARM B and ARM B CONTROL — repeat 3 and 4 on fresh sessions. The tier map is pinned at the TURN boundary, so a new session is required, not a new turn in the old one.',
    '7. Read `piChildRestrictions.model` out of each CHILD session record on disk, and restore the catalogue.',
  ],
  expected: 'Arm A `scout` resolves to the `fast` id; arm B `scout` resolves to the session model; `planner` resolves to the session model in BOTH. Any other shape demotes the K7-pi cell and the case says which.',
  detector: '`piChildRestrictions.model` in the CHILD session\'s own `session.jsonl` — the value `resolveAgentModelId` produced. Never the child\'s prose and never its `model` field alone, which is what the runtime ended up calling after `resolveModelForProvider` may have substituted it.',
  positiveControl: 'the `planner` (tier `medium`) dispatch in each arm, which must resolve to the session model — without it, arm B\'s reading is indistinguishable from a tier map that never worked. And the running app\'s own environment, read through `ps eww`: `CLAUDE_CODE_SUBAGENT_MODEL` inherited from the lane\'s shell resolves every child to it and the case BLOCKS rather than measuring the shell.',
  doneMeans: 'the `K7-pi` cell carries the two-arm result with a driven marker, or demotes to `partial` with the measurement quoted.',
  doNotRead: 'Do NOT read this off `SessionManager`. That the tier default is WRITTEN is already known; whether a child dispatched by a real model on a real catalogue runs on it is what the row asks.',
} as const satisfies SittingRecipe

/** A builtin agent under test, with the tier its definition declares. */
interface TierProbe { readonly agent: string; readonly tier: 'small' | 'medium' }

const SMALL: TierProbe = { agent: 'scout', tier: 'small' }
const MEDIUM: TierProbe = { agent: 'planner', tier: 'medium' }

/** The alias `resolveGatewayFastModelId` matches. */
const FAST_ALIAS = 'fast'

interface ChildReading {
  readonly childSessionId: string
  readonly name: string
  /** `resolveAgentModelId`'s output — THE detector. */
  readonly restrictionsModel?: string
  /** What the runtime ended up calling; can differ, and the difference is a finding. */
  readonly storedModel?: string
}

/**
 * The child session this dispatch created, read off disk.
 *
 * By EXCLUSION rather than by name: the set of session directories is taken
 * before the turn and the new ones are read after it, so a session left by an
 * earlier arm can never be scored as this one's. A record carrying
 * `piChildRestrictions` is a child; a record without it is an ordinary session.
 */
function childrenCreatedBy(root: string, workspaceId: string, before: ReadonlySet<string>, after: readonly string[]): ChildReading[] {
  const out: ChildReading[] = []
  for (const id of after) {
    if (before.has(id)) continue
    const file = join(root, 'sessions', workspaceId, id, 'session.jsonl')
    let record: Record<string, unknown> | undefined
    try {
      for (const line of readFileSync(file, 'utf8').trim().split('\n')) {
        const parsed = JSON.parse(line) as Record<string, unknown>
        if (parsed.piChildRestrictions !== undefined) record = parsed
      }
    } catch { continue }
    if (record === undefined) continue
    const restrictions = record.piChildRestrictions as { model?: unknown } | undefined
    out.push({
      childSessionId: id,
      name: String(record.name ?? ''),
      restrictionsModel: typeof restrictions?.model === 'string' ? restrictions.model : undefined,
      storedModel: typeof record.model === 'string' ? record.model : undefined,
    })
  }
  return out
}

function sessionDirs(root: string, workspaceId: string): string[] {
  try {
    return require('node:fs').readdirSync(join(root, 'sessions', workspaceId)) as string[]
  } catch {
    return []
  }
}

/**
 * Dispatch one builtin on a NEW session bound to `slug`, and read the child.
 *
 * A new session per dispatch, not a new turn: the tier map is computed at the
 * TURN boundary from the connection as it stands, and a session that has already
 * run a turn on the old catalogue is the wrong instrument for the new one.
 */
async function dispatch(
  run: CaseRun,
  session: CdpSession,
  root: string,
  slug: string,
  probe: TierProbe,
  label: string,
): Promise<{ key: SessionKey; children: ChildReading[]; tools: string[] }> {
  const key = await freshSession(session, `CDP ${ID} ${label} ${new Date().toISOString().slice(11, 19)}`)
  run.check(`${label}: the arm ran in a session it created`, key.fresh, key.fresh ? undefined : `inherited ${key.inheritedMessages} messages`)
  const bind = await switchRuntime(session, key.sessionId, slug)
  run.check(`${label}: the session is bound to ${slug}`, bind.ok, bind.ok ? undefined : `switchRuntime refused: ${bind.error}`)
  const before = new Set(sessionDirs(root, key.workspaceId))
  // Phrased so the turn ENDS at the dispatch. The first drive of this row asked
  // for the child's answer back, and the parent then spent eight `bash` calls
  // hunting for a background task's output — minutes of wall time that measure
  // the parent's resourcefulness and nothing about the tier.
  const turn = await sendPrompt(
    session,
    key,
    `Dispatch the ${probe.agent} subagent with the task "Name one file in this directory." `
    + 'Do not wait for it, do not look for its output, and do not run any other tool. '
    + 'Once you have started it, reply with the single word started.',
    300_000,
  )
  const tools = 'added' in turn ? turn.added.filter(m => m.role === 'tool').map(m => m.toolName ?? '') : []
  const children = childrenCreatedBy(root, key.workspaceId, before, sessionDirs(root, key.workspaceId))
  run.observe(`${label}: reading`, { agent: probe.agent, tier: probe.tier, tools, children })
  return { key, children, tools }
}

/** The child this dispatch was ASKED for, never merely the first one it made. */
function childOf(children: readonly ChildReading[], probe: TierProbe): ChildReading | undefined {
  return children.find(child => child.name.startsWith(`${probe.agent}:`)) ?? children[0]
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)
  const root = writableConfigDir('reading the child session records this case dispatches')

  // THE RIG PRECONDITION. See the header: with the lane's own environment
  // inherited, every child resolves to `CLAUDE_CODE_SUBAGENT_MODEL` and the
  // reading looks exactly like a product finding.
  const appEnv = readAppEnvContamination()
  run.observe('app-env', { pids: appEnv.pids.length, present: appEnv.present, controlSeen: appEnv.controlSeen })
  const contaminated = appEnvBlockReason(appEnv, 'the tier-model resolution this case measures')
  if (contaminated !== undefined) blocked(contaminated)

  const cards = await listConnections(session)
  const card = cards.find(row => runtimeOf(row.providerType) === 'pi')
  if (!card) blocked('no pi card on this host — the tier map is a Pi orchestrator surface and cannot be measured without one')

  const catalogue = await session.call<{ models: Array<{ id: string; shortName?: string }>; defaultModel?: string } | null>(`
    const c = await window.electronAPI.getLlmConnection(${JSON.stringify(card.slug)})
    if (!c) return null
    return { models: (c.models ?? []).map(m => ({ id: m.id, shortName: m.shortName })), defaultModel: c.defaultModel }
  `)
  if (!catalogue) blocked(`the app lists ${card.slug} but getLlmConnection returned nothing for it`)
  const fastModel = catalogue.models.find(model => model.shortName === FAST_ALIAS)
  run.observe('catalogue', { slug: card.slug, defaultModel: catalogue.defaultModel, models: catalogue.models })
  // P6.163's RIG HAZARD, as a block and not a failure: before the catalogue
  // refresh the seeded card's short names are "Qwen Coder" / "Qwen Fast", so an
  // arm run now would measure a false negative and score the capability absent.
  if (!fastModel) {
    blocked(
      `${card.slug}'s catalogue publishes no model whose shortName is "${FAST_ALIAS}" `
      + `(it carries ${JSON.stringify(catalogue.models.map(m => m.shortName ?? m.id))}). `
      + 'On a freshly seeded profile the short names are the display names until the startup refresh maps the API '
      + '`alias` field onto them, and an arm run before that refresh measures a false negative. Relaunch, let the '
      + 'refresh land, and run again.',
    )
  }
  const sessionModel = catalogue.defaultModel ?? ''
  run.require(
    'the fast alias and the session model are DIFFERENT ids',
    fastModel.id !== sessionModel && sessionModel.length > 0,
    `fast=${fastModel.id} and default=${sessionModel}: with one id the two arms cannot be told apart`,
  )

  let restored = false
  const originalModels = await session.call<unknown>(`
    const c = await window.electronAPI.getLlmConnection(${JSON.stringify(card.slug)})
    return JSON.parse(JSON.stringify(c?.models ?? []))
  `)
  try {
    // ---- ARM A: the alias is present -------------------------------------
    const armASmall = await dispatch(run, session, root, card.slug, SMALL, 'A/small')
    const aSmall = childOf(armASmall.children, SMALL)
    run.check(
      'A/small: the dispatch produced a child at all',
      aSmall !== undefined,
      `no child session carrying piChildRestrictions was created; tools=${JSON.stringify(armASmall.tools)} — the arm measures nothing`,
    )
    const armAMedium = await dispatch(run, session, root, card.slug, MEDIUM, 'A/medium')
    const aMedium = childOf(armAMedium.children, MEDIUM)
    run.check(
      'A/medium THE CONTROL — an unmapped tier inherits the session model',
      aMedium?.restrictionsModel === sessionModel,
      `planner resolved to ${JSON.stringify(aMedium?.restrictionsModel)} against a session model of ${sessionModel} — `
      + 'the control does not hold, so the small-tier reading beside it means nothing',
    )
    run.check(
      'A/small THE SUBJECT — the `small` tier resolves to the gateway `fast` model',
      aSmall?.restrictionsModel === fastModel.id,
      `scout resolved to ${JSON.stringify(aSmall?.restrictionsModel)}, not ${fastModel.id}`,
    )

    // ---- ARM B: the SAME card with the alias stripped ---------------------
    const stripped = await session.call<{ ok: boolean; error?: string; shortNames: unknown }>(`
      const c = await window.electronAPI.getLlmConnection(${JSON.stringify(card.slug)})
      const models = (c.models ?? []).map(m => m.shortName === ${JSON.stringify(FAST_ALIAS)} ? { ...m, shortName: undefined } : m)
      try {
        await window.electronAPI.saveLlmConnection({ ...c, models })
      } catch (e) { return { ok: false, error: String(e && e.message || e), shortNames: null } }
      const after = await window.electronAPI.getLlmConnection(${JSON.stringify(card.slug)})
      return { ok: true, shortNames: (after.models ?? []).map(m => m.shortName ?? null) }
    `)
    run.observe('arm-b-catalogue', stripped)
    run.require(
      'the `fast` alias really is gone from the stored catalogue',
      stripped.ok && !JSON.stringify(stripped.shortNames).includes(`"${FAST_ALIAS}"`),
      `saveLlmConnection left ${JSON.stringify(stripped.shortNames)} (${stripped.error ?? 'no error'}); arm B would repeat arm A`,
    )

    const armBSmall = await dispatch(run, session, root, card.slug, SMALL, 'B/small')
    const bSmall = childOf(armBSmall.children, SMALL)
    const armBMedium = await dispatch(run, session, root, card.slug, MEDIUM, 'B/medium')
    const bMedium = childOf(armBMedium.children, MEDIUM)
    run.check(
      'B/medium THE CONTROL — still the session model with no alias in the catalogue',
      bMedium?.restrictionsModel === sessionModel,
      `planner resolved to ${JSON.stringify(bMedium?.restrictionsModel)} against ${sessionModel}`,
    )
    run.check(
      'B/small THE SUBJECT — with no `fast` alias the `small` tier inherits the session model',
      bSmall?.restrictionsModel === sessionModel,
      `scout resolved to ${JSON.stringify(bSmall?.restrictionsModel)} on a catalogue with no ${FAST_ALIAS} alias; `
      + `expected the session model ${sessionModel}`,
    )
    // THE DISCRIMINATOR, and it is the sentence the ledger cell needs: the same
    // card, the same credential, the same ids — only the alias moved. Two arms
    // that agree mean the tier map does nothing on this build.
    run.check(
      'THE DISCRIMINATOR — the two `small` arms DIFFER, so the alias is what decides',
      aSmall?.restrictionsModel !== bSmall?.restrictionsModel,
      `both arms resolved scout to ${JSON.stringify(aSmall?.restrictionsModel)}; the alias changed nothing, so the `
      + '`small` tier is not covered on this connection family however the cell reads today',
    )
    run.observe('verdict', {
      sessionModel,
      fastModel: fastModel.id,
      armA: { small: aSmall?.restrictionsModel, smallStored: aSmall?.storedModel, medium: aMedium?.restrictionsModel },
      armB: { small: bSmall?.restrictionsModel, smallStored: bSmall?.storedModel, medium: bMedium?.restrictionsModel },
    })
    restored = true
  } finally {
    // The restore is unconditional and VERIFIED, not fired and hoped for: an
    // unrestored profile makes every later case on this rig measure a catalogue
    // this case invented (AGENTS.md — a harness that fails to restore
    // invalidates every verdict after it).
    const back = await session.call<{ shortNames: unknown }>(`
      const c = await window.electronAPI.getLlmConnection(${JSON.stringify(card.slug)})
      await window.electronAPI.saveLlmConnection({ ...c, models: ${JSON.stringify(originalModels)} })
      const after = await window.electronAPI.getLlmConnection(${JSON.stringify(card.slug)})
      return { shortNames: (after.models ?? []).map(m => m.shortName ?? null) }
    `).catch((error: unknown) => ({ shortNames: `restore threw: ${String(error)}` }))
    run.check(
      'the catalogue this case edited is RESTORED',
      JSON.stringify(back.shortNames).includes(`"${FAST_ALIAS}"`),
      `after the restore the stored short names are ${JSON.stringify(back.shortNames)} — the rig is left altered, and `
      + `every later case on this profile measures it (reached the restore with the arms ${restored ? 'complete' : 'INCOMPLETE'})`,
    )
  }
}

if (import.meta.main) {
  await main(ID, TITLE, drive)
}
