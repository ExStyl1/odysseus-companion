/**
 * Shared reads and the one action the RTS wave performs: moving a live session
 * onto a different connection, and therefore usually a different runtime.
 *
 * The action goes through the app's OWN command channel —
 * `sessionCommand(id, { type: 'switchRuntime', connectionSlug })`, the same call
 * `ChatPage.tsx:314` makes when the user confirms in the picker — so a case
 * drives the shipped path rather than a test seam. `switchRuntime` is the route
 * that RETURNS the `RuntimeSwitchResult`; `setConnection` reaches the same
 * operation and returns nothing, which is why the picker uses the former and so
 * does this.
 *
 * Everything else here is a read.
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'

import type { CdpSession } from './connect.ts'
import { blocked, type CaseRun } from './report.ts'
import { RTS_CONNECTION_SLUGS, fixturePaths } from '../fixtures/runtime-switch.ts'

/**
 * `packages/shared/src/protocol/runtime-switch.ts`, restated.
 *
 * Restated rather than imported: the cdp harness is its own tsconfig and does
 * not resolve the workspace package aliases. A shape that drifts from the real
 * one shows up as a failed check here, not as a silent pass, because every
 * field a case asserts on is asserted against a value the APP produced.
 */
export type RuntimeSwitchKind = 'model' | 'connection-same-runtime' | 'connection-cross-runtime'

export interface CapabilityDelta {
  stoppedKinds?: string[]
  [key: string]: unknown
}

export interface RuntimeSwitchResult {
  kind: RuntimeSwitchKind
  /** `anchor-and-handoff` since T18 — the normal shape of a RETURN leg. */
  contextCarried: 'none' | 'handoff' | 'runtime-anchor' | 'anchor-and-handoff'
  model: string
  from?: string
  to?: string
  droppedAttachments?: string[]
  stoppedChildren?: string[]
  capabilityDelta?: CapabilityDelta
}

export interface ConnectionRow {
  slug: string
  name?: string
  providerType: string
  defaultModel?: string
  models?: Array<{ id: string; name?: string }>
}

/** The runtime a providerType actually runs on — `providerTypeToAgentProvider`. */
export function runtimeOf(providerType: string): 'pi' | 'anthropic' | 'codex-runtime' | 'remote' {
  switch (providerType) {
    case 'pi':
    case 'pi_compat':
      return 'pi'
    case 'anthropic':
    case 'claude-runtime':
      return 'anthropic'
    case 'codex-runtime':
      return 'codex-runtime'
    default:
      return 'remote'
  }
}

export async function listConnections(session: CdpSession): Promise<ConnectionRow[]> {
  return session.call<ConnectionRow[]>(`
    const rows = await window.electronAPI.listLlmConnections()
    return (rows ?? []).map(c => ({
      slug: c.slug, name: c.name, providerType: c.providerType,
      defaultModel: c.defaultModel,
      models: Array.isArray(c.models) ? c.models.map(m => ({ id: m.id, name: m.name })) : undefined,
    }))
  `)
}

export interface RuntimeTrio {
  pi: string
  claude: string
  codex: string
}

/**
 * The three gateway cards, or BLOCKED naming what is missing.
 *
 * Resolved by PROVIDER TYPE against whatever the app actually lists, then
 * cross-checked against the fixture's expected slugs. Resolving by slug alone
 * would pass on a card someone renamed to `claude-gateway` while pointing it at
 * a different runtime; resolving by type alone would silently pick a BYO card
 * whose credential the packaged build cannot read.
 */
export async function requireRuntimeTrio(session: CdpSession): Promise<RuntimeTrio> {
  const rows = await listConnections(session)
  const bySlug = new Map(rows.map(r => [r.slug, r]))
  const missing: string[] = []
  const wrongRuntime: string[] = []

  const pick = (slug: string, expected: ReturnType<typeof runtimeOf>): string => {
    const row = bySlug.get(slug)
    if (!row) {
      missing.push(slug)
      return slug
    }
    if (runtimeOf(row.providerType) !== expected) {
      wrongRuntime.push(`${slug} is ${row.providerType} (${runtimeOf(row.providerType)}), expected ${expected}`)
    }
    return slug
  }

  const trio: RuntimeTrio = {
    pi: pick(RTS_CONNECTION_SLUGS[0], 'pi'),
    claude: pick(RTS_CONNECTION_SLUGS[1], 'anthropic'),
    codex: pick(RTS_CONNECTION_SLUGS[2], 'codex-runtime'),
  }

  if (missing.length > 0 || wrongRuntime.length > 0) {
    blocked(
      `the RTS wave needs the three gateway cards in this config dir`
      + (missing.length > 0 ? `; missing: ${missing.join(', ')}` : '')
      + (wrongRuntime.length > 0 ? `; wrong runtime: ${wrongRuntime.join('; ')}` : '')
      + `. Seed them with \`bun run scripts/cdp/fixtures/runtime-switch.ts\` and relaunch the packaged app`
      + ` with NESSY_CONFIG_DIR pointed at the fixture config dir.`
      + ` The app currently lists: ${rows.map(r => `${r.slug}(${r.providerType})`).join(', ') || 'nothing'}`,
    )
  }
  return trio
}

/**
 * The card a sitting case is being run FOR — `NESSY_CDP_CARD`, or whatever the
 * session already carries.
 *
 * ## Why {@link activeConnection} alone cannot answer this
 *
 * Measured on the packaged 1.36.0, 2026-09-11: a session created through the
 * app's own New Chat path — which is exactly what `freshSession()` drives —
 * carries `llmConnection: undefined`, `model: undefined` and
 * `workingDirectory: undefined`, and still does eight seconds later. The
 * resolution order is `session.llmConnection > workspace defaultLlmConnection >
 * global default` (`agent/backend/factory.ts`), so the session is not
 * *unbound* — it is bound by the workspace, and the field a case reads is simply
 * not stamped until someone picks a card or a turn runs.
 *
 * Seven sitting cases open with `const slug = await activeConnection(...)` and
 * BLOCK on `this session is on no connection`. That reads as a host missing its
 * cards, which is the one thing it is not: the same run's own inventory lists
 * eleven. RS-15, RS-20, RS-22, RS-27, RS-28, RS-29 and RS-30 all blocked this
 * way in one batch.
 *
 * ## Why an env var rather than a default
 *
 * Because the sitting's own rule is *one card at a time* — `scripts/cdp/README.md`
 * §"A sitting case is not a wave case": *"each case records WHICH card answered
 * rather than switching runtimes for you"*. Picking a card for the operator
 * would break that; picking NONE makes the case unrunnable by a driver. Naming
 * the card in the environment keeps the choice the operator's, keeps it visible
 * in the run notes, and leaves every case's own "record which card answered"
 * reading untouched — it still reads the session back through
 * {@link waitForConnection} rather than trusting the variable.
 *
 * With the variable unset the behaviour is exactly what it was, so a case run
 * the old way is unchanged.
 */
export async function boundCard(session: CdpSession, sessionId: string): Promise<string | undefined> {
  const wanted = process.env.NESSY_CDP_CARD?.trim()
  if (!wanted) return activeConnection(session, sessionId)
  const rows = await listConnections(session)
  if (!rows.some(row => row.slug === wanted)) {
    blocked(
      `NESSY_CDP_CARD=${wanted} names no connection this app lists: `
      + `${rows.map(row => `${row.slug}(${row.providerType})`).join(', ') || 'nothing'}`,
    )
  }
  // A failed switch is not proof the switch did not happen. The app answers
  // `sessions:command` on its own 30 s IPC ceiling, and under the load this
  // sitting ran at (11 to 52) that reply can time out while the switch itself
  // lands — RS-28 and RS-29 both blocked on
  // `Request timeout: sessions:command (30000ms)` minutes after RS-27 had made
  // the same switch onto the same card successfully. So the binding is read
  // back from the app either way, and only a card that never arrives blocks.
  const outcome = await switchRuntime(session, sessionId, wanted)
  const bound = await waitForConnection(session, sessionId, wanted, outcome.ok ? 30_000 : 60_000)
  if (bound !== wanted) {
    blocked(
      `NESSY_CDP_CARD=${wanted} could not be put on this session: `
      + `${outcome.ok ? `the app reported no error but the session still reports ${String(bound)}`
        : String(outcome.errorDetail?.message ?? outcome.error ?? 'no reason given')}`,
    )
  }
  return bound
}

/** The connection a session is currently bound to. */
export async function activeConnection(session: CdpSession, sessionId: string): Promise<string | undefined> {
  return session.call<string | undefined>(`
    const all = await window.electronAPI.getSessions()
    const s = (all ?? []).find(x => x.id === ${JSON.stringify(sessionId)})
    return s ? (s.llmConnection ?? undefined) : undefined
  `)
}

export interface SwitchOutcome {
  ok: boolean
  result?: RuntimeSwitchResult
  /** The app's own error — a `CodedError` code when it threw one. */
  error?: string
  /**
   * Everything else the thrown object carried, when it carried anything.
   *
   * `error` collapses to a CODE, and a bare `HANDLER_ERROR` is exactly the
   * shape that tells the reader nothing: the packaged wave recorded one on
   * RTS-14's anchored codex → pi leg and could say only that it happened
   * (`docs/testing/cdp-runs/2026-08-21-w-pkg-packaged-wave.md`). The wrapper
   * message, `data`, and the `cause` chain are where the reason lives, so they
   * are captured beside the code rather than thrown away — bounded, and only on
   * the failure path, so nothing about a successful switch changes.
   */
  errorDetail?: {
    name?: string
    code?: string
    message?: string
    data?: unknown
    causeChain?: string[]
    keys?: string[]
  }
}

/**
 * Move the session onto `connectionSlug` and return what the app reported.
 *
 * Never throws: a REFUSAL is a result this wave asserts on (`SESSION_BUSY` in
 * RTS-8), so a thrown error would be indistinguishable from a harness fault.
 * The caller decides whether `ok: false` is the expected answer.
 */
export async function switchRuntime(
  session: CdpSession,
  sessionId: string,
  connectionSlug: string,
): Promise<SwitchOutcome> {
  return session.call<SwitchOutcome>(`
    try {
      const result = await window.electronAPI.sessionCommand(
        ${JSON.stringify(sessionId)},
        { type: 'switchRuntime', connectionSlug: ${JSON.stringify(connectionSlug)} },
      )
      return { ok: true, result: result ?? undefined }
    } catch (e) {
      const code = e && (e.code || (e.message && String(e.message)))
      const chain = []
      for (let cur = e && e.cause, depth = 0; cur && depth < 5; cur = cur.cause, depth += 1) {
        chain.push(String((cur.code && (cur.code + ': ')) || '') + String(cur.message ?? cur))
      }
      let data
      try { data = e && e.data !== undefined ? JSON.parse(JSON.stringify(e.data)) : undefined } catch (_) { data = '(unserializable)' }
      return {
        ok: false,
        error: String(code ?? e),
        errorDetail: {
          name: e && e.name ? String(e.name) : undefined,
          code: e && e.code ? String(e.code) : undefined,
          message: e && e.message ? String(e.message).slice(0, 1000) : undefined,
          data,
          causeChain: chain.length ? chain : undefined,
          keys: e && typeof e === 'object' ? Object.getOwnPropertyNames(e).slice(0, 20) : undefined,
        },
      }
    }
  `)
}

/**
 * The config dir the RUNNING app is using, verified rather than assumed.
 *
 * Nothing on the preload surface reports it — `getServerHomeDir()` answers the
 * home directory, not `NESSY_CONFIG_DIR` — so it is resolved from the case
 * process's own environment (the runner passes `env: process.env` to every
 * case) and falls back to the fixture's dir.
 *
 * **Then it is checked against a path only the live app can have created.** A
 * wrong config dir is the worst kind of detector fault in this wave:
 * `memoryLeaks` silently reads three files that do not exist and returns `[]`,
 * which reads as "the label did not leak" — a false all-clear that would let a
 * case score a recall it should have refused to score. Its default is
 * `~/.nessy-agent`, so a fixture run that forgets to pass this scans the
 * OPERATOR's config dir and comes back clean every time.
 */
export function resolveConfigDir(): string {
  return process.env.NESSY_CONFIG_DIR ?? fixturePaths().configDir
}

/**
 * Proof the config dir is the one this session lives in.
 *
 * Returns the session's own directory when it is there, and throws otherwise —
 * loudly, because every filesystem detector in this wave is scoped by this path
 * and a silent miss turns each of them into a constant.
 */
export function requireSessionDir(workspaceId: string, sessionId: string): string {
  const dir = join(resolveConfigDir(), 'sessions', workspaceId, sessionId)
  if (!existsSync(dir)) {
    throw new Error(
      `config-dir-mismatch: no session directory at ${dir}. `
      + 'Every file detector in this wave is scoped by NESSY_CONFIG_DIR, and a wrong one reports absence for '
      + 'everything. Export NESSY_CONFIG_DIR to the dir the app was launched with '
      + `(currently ${resolveConfigDir()}).`,
    )
  }
  return dir
}

/**
 * Point the session at a model and wait until the app agrees.
 *
 * Lifted from `g3-anthropic-wire.ts` because two RTS cases need it and the
 * argument order is a known trap: `setSessionModel(sessionId, workspaceId,
 * model)`. Feeding the model into the `workspaceId` slot silently no-ops, and
 * that cost two false FAILs in the sitting that found it.
 */
export async function selectModel(
  session: CdpSession,
  key: { sessionId: string; workspaceId: string },
  model: string,
  timeoutMs = 20_000,
): Promise<string | null> {
  await session.call(`
    await window.electronAPI.setSessionModel(
      ${JSON.stringify(key.sessionId)}, ${JSON.stringify(key.workspaceId)}, ${JSON.stringify(model)},
    )
    return 1
  `)
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const current = await session.call<string | null>(`
      return (await window.electronAPI.getSessionModel(
        ${JSON.stringify(key.sessionId)}, ${JSON.stringify(key.workspaceId)},
      )) ?? null
    `).catch(() => null)
    if (current === model) return current
    if (Date.now() >= deadline) return current
    await Bun.sleep(500)
  }
}

/** Bind the session (`updateWorkingDirectory`) — PRIVATE since F1.182; see `bindProject`. */
async function setWorkingDirectory(session: CdpSession, sessionId: string, dir: string): Promise<void> {
  await session.call<null>(`
    await window.electronAPI.sessionCommand(
      ${JSON.stringify(sessionId)},
      { type: 'updateWorkingDirectory', dir: ${JSON.stringify(dir)} },
    )
    return null
  `)
}

/**
 * Answer the app's "Trust this folder?" gate for the FIXTURE directory only.
 *
 * Binding a session to a directory the app has no trust decision for raises a
 * modal, and the modal owns the screen: the composer is not focusable while it
 * is up, so every case that binds a project fails at its first keystroke with
 * `composer-not-focusable` and nothing about the failure says "a dialog".
 *
 * **Why the harness may answer this one.** The rule in `README.md` is that a
 * case never installs a plugin or rewrites config, because a case that arranges
 * its own environment can break the machine it measures. Trust here grants
 * "project instructions, skills, agents, MCP servers, hooks, and memory can run
 * from this folder" — and this folder is three files the fixture itself wrote,
 * with no `.claude/`, no `.codex-plugin/`, no hooks and no MCP config. There is
 * nothing to grant it to.
 *
 * **The guard is the point.** The path is compared against the fixture's own
 * `projectDir` and the call is refused for anything else, so this cannot become
 * a general-purpose "make the dialog go away" helper pointed at one of the
 * owner's real repositories.
 */
/**
 * What the gate did — and, when it did nothing, WHY.
 *
 * `'not-shown'` on its own was the whole negative answer until D1.374, and that
 * word cannot distinguish *the gate was silenced* from *the gate was correctly
 * silent because this folder contributes nothing*. Four readings in sitting 5e
 * were recorded under it and at least three of them were the second kind. The
 * template-literal form keeps `outcome === 'answered'` narrowing exactly as it
 * did — the two call sites that compare (`rs-87.ts`, `rs-99.ts`) both test that
 * side — while the negative carries its reason to every `run.observe` that
 * already records it.
 *
 * The reason is READ FROM THE PRODUCT'S OWN GATE rather than guessed: the
 * renderer's `resolveProjectTrustPrompt`
 * (`apps/electron/src/renderer/lib/project-trust-gate.ts`) validates the
 * directory, drops out when `trustState !== 'unknown'`, then asks
 * `capabilities.detectProjectContributions` and shows the modal only when
 * `projectWouldContribute(report)`. {@link explainSilentTrustGate} walks the
 * same three steps through the same two RPCs, so a reason here is the app's
 * reason and not this harness's theory of it.
 */
export type TrustGateOutcome = 'answered' | `not-shown (${string})`

export async function trustFixtureProject(session: CdpSession, timeoutMs = 15_000): Promise<TrustGateOutcome> {
  return answerTrustGate(session, fixturePaths().projectDir, 'trust', timeoutMs)
}

/**
 * The same gate, for a directory the CASE minted under the OS temp dir.
 *
 * ## Why this had to exist
 *
 * Measured 2026-09-11 on a config dir created for the run: the trust modal owns
 * the screen, so the next case to type dies with `composer-not-focusable` and
 * nothing in the message says "a dialog". `RS-15` failed that way three times in
 * a row, and the stale modal from the first run blocked the two after it.
 *
 * ## The modal is raised for a project that DECLARES something, not for any
 * ## directory — this paragraph said the opposite until 2026-09-18 (SIT-6a)
 *
 * It read *"the trust modal is raised for ANY directory the profile has no
 * decision for — a scratch dir holding one `README.md` and nothing else raises
 * it"*, and that is REFUTED on the packaged 1.40.0. Both arms on ONE fresh
 * profile in one run: a project holding only a `README.md` raised no modal in
 * 20 s; the identical rig plus one `.agents/skills/<name>/SKILL.md` raised it in
 * under 2 s, and the dialog names what it found — *"THIS PROJECT PROVIDES · 1
 * skill — cdp-probe5 · .agents/skills"*. A third arm proves the gate is not a
 * sticky profile state: a contributing project raises the modal again after an
 * earlier one was dismissed with `Keep restricted`.
 *
 * Two consequences, both of which cost a measurement before this was known:
 *
 *  - **a case whose rig needs the gate ANSWERED must give its scratch project
 *    something to declare.** `cases/rs-87.ts` plants one skill for exactly this
 *    reason, and says so where it plants it.
 *
 *    **Which cases do, measured 2026-09-20 at `e22bff6c5` — and D1.374's own
 *    sentence is half wrong.** The row says *"RS-87 and RS-80 already do"*, and
 *    both readings confirm it: `rs-87.ts` writes
 *    `.agents/skills/cdp-rs-87/SKILL.md` and `rs-80.ts` has a `writeSkill`
 *    helper. The WAVE BRIEF carried it as *"RS-84 and RS-87"*, and **`rs-84.ts`
 *    plants no entry point at all** — its two `writeFileSync` calls write a
 *    `README.md` into the checkout and a `README.md` into the unrelated control
 *    repository, which is exactly the bare shape SIT-6a measured raising no
 *    modal in 20 s. Its trust gate is therefore CORRECTLY silent, and with this
 *    row's change it now says so in its own result line.
 *
 *    A list of the rest would be stale within a wave, so re-derive it instead —
 *    the candidates, then what each writes:
 *
 *        git grep -ln 'trustScratchProject(session' -- scripts/cdp/cases
 *        grep -n 'writeFileSync\|mkdirSync' scripts/cdp/cases/<id>.ts
 *
 *    and the four things that count as an entry point are the four the row
 *    names: an `AGENTS.md`, a `.mcp.json`, a `.claude` settings file, or an
 *    `.agents/skills/<name>`. **The enumeration matters less than it did**, and
 *    that is the point of the change above: a `not-shown` now carries its own
 *    reason, so a case that plants nothing reports `contributes nothing` rather
 *    than leaving the next reader to work out which of three worlds it met.
 *  - **`not-shown` for a bare directory is correct behaviour, not a profile
 *    fault.** SIT-5e read a run of `not-shown`s as *"once the modal has been
 *    cancelled the gate answers `not-shown` for every later project in that
 *    profile"* (→ D1.363, and it became a premise in D1.75 and D1.67). Every
 *    project in that run was a scratch dir or a bare git checkout with nothing
 *    to declare, so the simpler explanation covers the same readings and is the
 *    one measured here. Whoever closes D1.363 should re-take that half rather
 *    than inherit it.
 *
 * On the operator's own long-lived profile the gate is usually silent because a
 * decision already exists, which is why this went unseen until a fresh profile
 * was used — the same reason `RS-32` exists at all.
 *
 * ## The guard, which is the whole point
 *
 * TWO conditions, both refused loudly:
 *
 * 1. the directory must be under the OS temp dir, realpathed — so this can never
 *    become a "make the dialog go away" helper pointed at one of the owner's
 *    repositories, whatever a caller passes;
 * 2. the DIALOG's own path must equal it — the read is of what the app is
 *    offering to trust, never of what the case meant to bind, because a
 *    mis-bound session would otherwise have this trusting a directory nobody
 *    named.
 *
 * Trust grants "project instructions, skills, agents, MCP servers, hooks, and
 * memory can run from this folder" — and a case-minted scratch dir has none of
 * those, which is the same argument `trustFixtureProject` above is written under.
 */
export async function trustScratchProject(session: CdpSession, dir: string, timeoutMs = 15_000): Promise<TrustGateOutcome> {
  const real = resolvePath(dir)
  const tmpReal = resolvePath(realpathSync(tmpdir()))
  if (!real.startsWith(`${tmpReal}/`)) {
    // F1.797 — SIT-m met this refusal for its own `work/sitting/SIT-m/ws` and answered the dialog by hand. That folder
    // has a tracked answer since F1.976, `answerTrustGate`, which trusts only a folder the harness made. So the refusal
    // names it for such a folder, rather than widening this guard by a switch.
    const tracked = harnessMadeIt(dir)
      ? ` For a folder the harness made, such as a sitting lane's own under work/sitting/, answer through answerTrustGate(session, ${JSON.stringify(dir)}, 'trust' or 'keep-restricted').`
      : ''
    throw new Error(
      `refusing-to-trust: ${dir} is not under the OS temp dir (${tmpReal}). This helper answers the trust gate only for a `
      + 'directory the case itself minted; trusting anything else is the operator\'s decision, made in the app by hand.'
      + tracked,
    )
  }
  return answerTrustGate(session, real, 'trust', timeoutMs)
}

/** What the product's own gate answers about a directory, read in one page call. */
export interface TrustGateExplanation {
  /** False when a read failed — `why` then says which one, and nothing is concluded. */
  ok: boolean
  why?: string
  /** `unknown` is the only state that can raise the modal at all. */
  trustState?: string
  /** `null` when the detection was never reached; `[]` is a real "nothing here". */
  items?: { itemType: string; count: number; sourceLabel: string }[] | null
}

/**
 * Why no modal appeared — asked of the app, in the app's own order.
 *
 * D1.374: *"Before concluding `not-shown`, read
 * `capabilities.detectProjectContributions` for the directory the case bound and
 * report `not-shown (contributes nothing)` vs `not-shown (contributes N and was
 * not asked)` — one RPC, and the difference between a rig fault and a product
 * defect."*
 *
 * **It is three answers rather than the row's two, and the third is the one that
 * silently poisoned four readings.** `resolveProjectTrustPrompt` drops out
 * BEFORE the detection whenever `trustState !== 'unknown'`, so a directory the
 * profile has already decided about never raises a modal however much it
 * contributes — and that is neither "contributes nothing" nor "contributes and
 * was not asked". SIT-5e read a run of `not-shown`s as a profile-wide stickiness
 * (→ D1.363); the refutation is recorded in {@link trustScratchProject}'s own
 * header, and this function is what makes the question answerable per directory
 * instead of by inference.
 *
 * A fourth outcome is a READ FAILURE, and it is kept apart from all three: the
 * row's split assumes the reads succeed, and a thrown RPC reported as
 * "contributes nothing" would be the exact laundering this change exists to
 * stop. `projectWouldContribute`'s own header makes the same asymmetry the
 * product's law — *"Only a positive 'this folder contributes nothing' suppresses
 * the question"* — so an unreadable report concludes nothing here either.
 *
 * Never throws: an instrument must not become the reason a case has no verdict.
 */
async function explainSilentTrustGate(session: CdpSession, projectDir: string): Promise<TrustGateExplanation> {
  return session.call<TrustGateExplanation>(`
    const dir = ${JSON.stringify(projectDir)}
    // macOS hands the harness /var/... and the app /private/var/..., or the
    // other way about; the two name one directory and a string compare says
    // otherwise. Same trap RS-80 paid for, one surface over.
    const strip = p => String(p || '').replace(/^\\/private\\//, '/')
    let sessions = []
    try { sessions = (await window.electronAPI.getSessions()) || [] } catch (e) { return { ok: false, why: 'getSessions-threw: ' + String((e && e.message) || e) } }
    const bound = sessions.find(s => strip(s.workingDirectory) === strip(dir))
    const workspaceId = (bound || sessions[0] || {}).workspaceId
    if (!workspaceId) return { ok: false, why: 'no session to take a workspaceId from' }
    let handle
    try {
      handle = await window.electronAPI.validateProjectDirectory({ workspaceId, candidatePath: dir })
    } catch (e) {
      return { ok: false, why: 'validateProjectDirectory threw: ' + String((e && e.message) || e) }
    }
    if (!handle) return { ok: false, why: 'validateProjectDirectory returned nothing' }
    if (handle.trustState !== 'unknown') return { ok: true, trustState: handle.trustState, items: null }
    let report
    try {
      report = await window.electronAPI.capabilities.detectProjectContributions({ workspaceId, projectHandleId: handle.id })
    } catch (e) {
      return { ok: false, why: 'detectProjectContributions threw: ' + String((e && e.message) || e), trustState: handle.trustState }
    }
    if (!report) return { ok: false, why: 'detectProjectContributions returned nothing', trustState: handle.trustState }
    return {
      ok: true,
      trustState: handle.trustState,
      items: (report.items || []).map(i => ({ itemType: i.itemType, count: i.count, sourceLabel: i.sourceLabel })),
    }
  `).catch((error: unknown) => ({ ok: false, why: `the explanation probe itself threw: ${String(error).slice(0, 160)}` }))
}

/** {@link TrustGateOutcome}'s negative, with the reason spelled the same way every time. */
export function silentGateVerdict(explanation: TrustGateExplanation): TrustGateOutcome {
  if (!explanation.ok) return `not-shown (unexplained: ${explanation.why ?? 'unknown'})`
  if (explanation.trustState !== undefined && explanation.trustState !== 'unknown') {
    return `not-shown (already decided: ${explanation.trustState})`
  }
  const items = explanation.items ?? []
  if (items.length === 0) return 'not-shown (contributes nothing)'
  const total = items.reduce((sum, item) => sum + (item.count || 0), 0)
  const what = items.map(item => `${item.itemType}:${item.count}@${item.sourceLabel}`).join(', ')
  return `not-shown (contributes ${total} and was not asked — ${what})`
}

/**
 * The trust dialog's two decisions, each named by the button it presses.
 * `Cancel` is not one: it persists nothing and answers nothing.
 */
export type TrustGateAnswer = 'trust' | 'keep-restricted'

/** The one spelling a match uses: the dialog's own whitespace and case are its to choose. */
function normCopy(text: string | null | undefined): string {
  return String(text ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
}

/**
 * UA12.123 — one string in every shipped locale's own file, with the current English literal (UA12.94's folder copy)
 * kept as a fallback for a tree where the locale file is unreadable. The LOCALE FILE is the source, never a copy here: a copy would keep
 * matching a string the product no longer renders (the QUOTED_COPY pin in harness.test.ts reads the same files).
 */
function localeTexts(key: string, fallback: string): string[] {
  const texts = new Set<string>([normCopy(fallback)])
  for (const locale of ['en', 'ru'] as const) {
    try {
      const file = readFileSync(join(import.meta.dir, '..', '..', '..', 'packages', 'shared', 'src', 'i18n', 'locales', `${locale}.json`), 'utf8')
      const value = (JSON.parse(file) as Record<string, unknown>)[key]
      if (typeof value === 'string' && value.trim() !== '') texts.add(normCopy(value))
    } catch { /* the literal fallback still matches */ }
  }
  return [...texts]
}

/**
 * UA12.123 — the trust dialog's title (`projectTrust.title`) and the two decision buttons' texts
 * (`projectTrust.trust`, `projectTrust.keepRestricted`) in BOTH shipped locales, read from the product's own locale
 * files. The harness used to match the English text alone, so in a Russian UI the gate was never found and every trust
 * arm read `not-shown` (P-UAay-1).
 */
export const TRUST_GATE_TITLES: readonly string[] = localeTexts('projectTrust.title', 'Trust this folder?')

export const TRUST_GATE_BUTTON: Record<TrustGateAnswer, readonly string[]> = {
  trust: localeTexts('projectTrust.trust', 'trust folder'),
  'keep-restricted': localeTexts('projectTrust.keepRestricted', 'keep restricted'),
}

/** Whether a heading element's text is the trust gate's title in ANY shipped locale. */
export function isTrustGateHeading(text: string | null | undefined): boolean {
  const norm = normCopy(text)
  return norm !== '' && TRUST_GATE_TITLES.includes(norm)
}

/**
 * UA12.94 — `isTrustGateHeading` in the form a PAGE read takes: the source of an arrow `el => boolean`, true when the
 * element's text IS the trust gate's title in any shipped locale (whitespace collapsed and case folded, as `normCopy`
 * spells it). The case-local finders that look for the gate inside their own `session.call` bodies interpolate it —
 * `.find(${TRUST_GATE_HEADING_IN_PAGE})` — instead of spelling an English regex of their own, so a rewording of
 * `projectTrust.title` reaches them through the locale files the way it reaches `answerTrustGate`. Before UA12.94
 * seven cases carried `/trust this project/i`, which pinned the English copy and never saw a ru dialog.
 */
export const TRUST_GATE_HEADING_IN_PAGE =
  `(el => ${JSON.stringify(TRUST_GATE_TITLES)}.includes(String((el && el.textContent) || '').replace(/\\s+/g, ' ').trim().toLowerCase()))`

/** Whether a button element's text is THIS answer's decision in ANY shipped locale. */
export function isTrustGateButton(text: string | null | undefined, answer: TrustGateAnswer): boolean {
  const norm = normCopy(text)
  return norm !== '' && TRUST_GATE_BUTTON[answer].includes(norm)
}

/**
 * UA12.195 — the shipped Cancel and Close buttons' texts (`common.cancel`, `common.close` — the trust dialog's Cancel
 * in `ProjectTrustDialog.tsx`, the rewind menu's in `rewind-menu.tsx`) in BOTH shipped locales, read from the locale
 * files as UA12.123's TRUST_GATE_* are. Before this, seven cases (rs-05, rs-51, rs-53, rs-80, rs-84, rs-87, rs-99)
 * found these buttons by an English regex of their own, so in a ru UI a dismissal pressed nothing and a dialog naming a
 * deleted directory stayed up, blocking every later case in the profile (RS-80's measurement).
 */
export const CANCEL_BUTTON_TEXTS: readonly string[] = localeTexts('common.cancel', 'cancel')
export const CLOSE_BUTTON_TEXTS: readonly string[] = localeTexts('common.close', 'close')

/** UA12.195 — what a case presses to DISMISS a dialog it left up before deleting its directory: Cancel, Close or Keep restricted (rs-80, rs-84). */
export const DIALOG_DISMISS_BUTTON_TEXTS: readonly string[] = [...CANCEL_BUTTON_TEXTS, ...CLOSE_BUTTON_TEXTS, ...TRUST_GATE_BUTTON['keep-restricted']]

/**
 * UA12.195 — a button finder in the form a PAGE read takes (as UA12.94's TRUST_GATE_HEADING_IN_PAGE): the source of
 * an arrow `el => boolean`, true when the element's text (`innerText`, else `textContent`; whitespace collapsed and case
 * folded, as `normCopy` spells it) is one of `texts`. A case interpolates it — `.find(${buttonTextInPage(CANCEL_BUTTON_TEXTS)})`.
 */
export function buttonTextInPage(texts: readonly string[]): string {
  return `(el => ${JSON.stringify(texts.map(normCopy))}.includes(String((el && (el.innerText || el.textContent)) || '').replace(/\\s+/g, ' ').trim().toLowerCase()))`
}

/**
 * UA12.195 follow-up — {@link buttonTextInPage} that ALSO accepts the element's `aria-label` (normalised the same way),
 * for an icon button whose only name is its label: the rewind menu's close button is `aria-label={t('common.close')}`
 * with no text (`rewind-menu.tsx`). rs-34's closeDialog reads it; before, it matched `/cancel|close/i`, English only.
 */
export function buttonLabelInPage(texts: readonly string[]): string {
  return `(el => ${buttonTextInPage(texts)}(el) || ${JSON.stringify(texts.map(normCopy))}.includes(String((el && el.getAttribute && el.getAttribute('aria-label')) || '').replace(/\\s+/g, ' ').trim().toLowerCase()))`
}

/**
 * Where the shipped dialog renders the folder it asks about:
 * `ProjectTrustDialog.tsx` puts `project.displayPath` in a box of its own test id,
 * which nothing else in the dialog carries. `harness.test.ts` pins that premise
 * against the renderer's source.
 *
 * F1.976: the read used to be `input,code,pre,[class*="path"]`, which matches no
 * element of that dialog. The read came back empty, the empty read skipped the
 * compare, and the click went ahead. So the folder check this helper was trusted
 * for was never made. F1.991: it then read `.font-mono`, a styling class the
 * contributions list's source labels share, so a restyle could move the read. A
 * restyle does not touch the id.
 */
export const TRUST_DIALOG_PATH_SELECTOR = '[data-testid="project-trust-path"]'

/** One directory, one spelling: realpathed when it exists, and macOS's `/private/` prefix dropped (the RS-80 trap). */
function samePlace(path: string): string {
  let real = resolvePath(path)
  try { real = realpathSync(real) } catch { /* a folder that is gone keeps its resolved spelling */ }
  return real.replace(/^\/private\//, '/')
}

/**
 * Where the harness itself makes folders, and so the only places it may TRUST
 * one: the OS temp dir, the RTS fixture root, and this checkout's
 * `work/sitting/`. Every sitting lane makes its `ws` folders there, each with its
 * own `git init` (`work/wi15/sit-common.md`, RIG CONFOUND). Anywhere else, trust
 * is the operator's decision, made in the app by hand.
 */
function harnessMadeIt(dir: string): boolean {
  const roots = [tmpdir(), fixturePaths().root, join(import.meta.dir, '..', '..', '..', 'work', 'sitting')]
  const target = samePlace(dir)
  return roots.some(root => target.startsWith(`${samePlace(root)}/`))
}

/**
 * Answer the "Trust this folder?" dialog with the decision the caller
 * NAMES, and only when the dialog names `projectDir`. This is the one entry
 * point a sitting lane uses (F1.976, `work/wi15/sit-common.md`).
 *
 * ## Why it takes the answer
 *
 * It could only press "Trust project". A lane that wanted "Keep restricted"
 * therefore wrote its own click, and SIT-an1's click read the heading alone. The
 * dialog on screen was chat A's: A's prompt had come up late and stayed up after
 * the driver moved to chat B. So the "Keep restricted" meant for B's folder
 * restricted A's folder instead. The host then did what that answer does: it
 * strict-drained every chat bound to A's folder, and tore A down. That was
 * WJ-crit-ttt's verdict.
 *
 * ## The two guards
 *
 * 1. **The dialog's own folder must be `projectDir`, for both answers.** The
 *    folder is read off the dialog, never off the chat the caller meant to bind.
 *    A dialog whose folder cannot be read is refused, never answered unchecked
 *    (see {@link TRUST_DIALOG_PATH_SELECTOR} for why that is not hypothetical).
 * 2. **"trust" only for a folder the harness made** ({@link harnessMadeIt}). It
 *    is checked before the page is asked anything. "keep-restricted" grants
 *    nothing, so guard 1 alone covers it. But it is not free: it drains every
 *    live chat bound to that folder, so the folder check matters most there.
 *
 * {@link trustScratchProject} keeps its own stricter guard, the temp dir only.
 */
export async function answerTrustGate(
  session: CdpSession,
  projectDir: string,
  answer: TrustGateAnswer,
  timeoutMs = 15_000,
): Promise<TrustGateOutcome> {
  const refusal = answer === 'trust' ? 'refusing-to-trust' : 'refusing-to-keep-restricted'
  if (answer === 'trust' && !harnessMadeIt(projectDir)) {
    throw new Error(
      `refusing-to-trust: ${projectDir} is not a folder the harness made (the OS temp dir, the RTS fixture root, or this `
      + 'checkout\'s work/sitting/). Trusting anything else is the operator\'s decision, made in the app by hand.',
    )
  }
  const deadline = Date.now() + timeoutMs
  // F1.1250 (SIT2-a): set once THIS call has pressed the button. The dialog can
  // still be up on the read right after the click and gone on the next one; that
  // next read must report the answer this call delivered, not fall through to the
  // silent-gate probe, which then sees the decision just made and calls it
  // `not-shown (already decided: …)` after the whole timeout.
  let pressed = false

  for (;;) {
    // Read the path the DIALOG is asking about, never the one the case meant to
    // bind. The guard has to sit on what the app is actually offering to trust,
    // or a mis-bound session would have this helper trusting a directory nobody
    // named.
    const dialog = await session.call<{ present: boolean; path?: string }>(`
      const wanted = ${JSON.stringify(TRUST_GATE_TITLES.map(normCopy))}
      const norm = s => String(s || '').replace(/\\s+/g, ' ').trim().toLowerCase()
      const heading = Array.from(document.querySelectorAll('h1,h2,h3,[role="heading"]'))
        .find(el => wanted.includes(norm(el.textContent)))
      if (!heading) return { present: false }
      const root = heading.closest('[role="dialog"]') ?? heading.parentElement?.parentElement ?? document.body
      const field = root.querySelector(${JSON.stringify(TRUST_DIALOG_PATH_SELECTOR)})
      const text = field ? (field.value ?? field.textContent ?? '') : ''
      return { present: true, path: String(text).trim() }
    `)
    if (!dialog.present) {
      if (pressed) return 'answered'
      // Not "no gate" — "no gate YET". The modal is raised asynchronously after
      // the bind, so returning on the first empty read races it and the case
      // fails one keystroke later with `composer-not-focusable`.
      //
      // D1.374 — and when the deadline really is reached, ASK THE APP WHY
      // before answering. The probe is two RPCs and runs once, on the way out,
      // so an ordinary `answered` pays nothing for it.
      if (Date.now() >= deadline) return silentGateVerdict(await explainSilentTrustGate(session, projectDir))
      await Bun.sleep(500)
      continue
    }
    if (!dialog.path) {
      throw new Error(
        `trust-dialog-folder-unreadable: the dialog is up but ${TRUST_DIALOG_PATH_SELECTOR} holds no folder, so which folder `
        + `it asks about is unknown. Nothing was pressed; answering it anyway is how SIT-an1 restricted the wrong folder.`,
      )
    }
    if (samePlace(dialog.path) !== samePlace(projectDir)) {
      throw new Error(
        `${refusal}: the dialog is asking about ${dialog.path}, not the folder this caller named (${projectDir}). `
        + 'It belongs to the chat that bound that folder: answer it there, naming that folder, or leave it to the operator.',
      )
    }

    // Click the app's own button rather than calling `setProjectTrust` behind
    // it. The RPC does update the store — but the modal is renderer state and
    // stays up, so the composer stays unfocusable and the case fails with a
    // message that says nothing about a dialog. Driving the button is also the
    // shipped path, which is what this harness measures everywhere else.
    const clicked = await session.call<boolean>(`
      const wanted = ${JSON.stringify(TRUST_GATE_BUTTON[answer].map(normCopy))}
      const norm = s => String(s || '').replace(/\\s+/g, ' ').trim().toLowerCase()
      const button = Array.from(document.querySelectorAll('button'))
        .find(b => wanted.includes(norm(b.innerText || b.textContent)))
      if (!button) return false
      button.click()
      return true
    `)
    if (!clicked) throw new Error(`trust-dialog-has-no-${answer}-button: the gate is up but no button of ${JSON.stringify(TRUST_GATE_BUTTON[answer])} is in the DOM`)
    pressed = true

    const gone = await session.call<boolean>(`
      const wanted = ${JSON.stringify(TRUST_GATE_TITLES.map(normCopy))}
      const norm = s => String(s || '').replace(/\\s+/g, ' ').trim().toLowerCase()
      return !Array.from(document.querySelectorAll('h1,h2,h3,[role="heading"]'))
        .some(el => wanted.includes(norm(el.textContent)))
    `)
    if (gone) return 'answered'
    if (Date.now() >= deadline) throw new Error('trust-dialog-did-not-close: still up after the confirm click')
    await Bun.sleep(500)
  }
}

/**
 * Wait until the session reports the target connection.
 *
 * `switchRuntime` resolves when the operation is done, but the renderer's
 * session list is fed by an event; a case that asserts immediately reads the
 * pre-switch value often enough to matter.
 */
export async function waitForConnection(
  session: CdpSession,
  sessionId: string,
  expected: string,
  timeoutMs = 30_000,
): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs
  let last: string | undefined
  for (;;) {
    last = await activeConnection(session, sessionId)
    if (last === expected) return last
    if (Date.now() >= deadline) return last
    await Bun.sleep(500)
  }
}

/** What the session says about the directory it is bound to, after the ask. */
export interface WorkingDirectoryBind {
  /** The session's own `workingDirectory` resolves to the directory asked for. */
  bound: boolean
  /** The path asked for, as a real path — `/private/var/…`, never `/var/…`. */
  target: string
  /**
   * The session's LAST reading, verbatim and unresolved — `''` when the field is
   * still empty. It is the whole point of the helper: a failed bind that does
   * not say what the session IS bound to sends the next read to a directory
   * nobody wrote, which is what SIT-9 measured.
   */
  reported: string
  /** How long the poll ran before it settled or gave up. */
  waitedMs: number
  /** How many times `updateWorkingDirectory` was issued (1 in the ordinary case). */
  issues: number
  /** First line of everything the command threw — kept, never trusted as failure. */
  errors: string[]
  /** Absent when bound; a sentence naming the last reading when not. */
  reason?: string
}

export interface BindWorkingDirectoryOptions {
  /** Poll budget per issue. Default 150 s — see the header on the resting state. */
  timeoutMs?: number
  /** Poll interval. Default 2 s. */
  intervalMs?: number
  /** How many times to issue the command. Default 2, and never more on `busy`. */
  attempts?: number
}

/** The session's own `workingDirectory`, or `''` — never a thrown read. */
async function readWorkingDirectory(session: CdpSession, sessionId: string): Promise<string> {
  return session.call<string>(`
    const row = (await window.electronAPI.getSessions() ?? []).find(s => s.id === ${JSON.stringify(sessionId)})
    return row && row.workingDirectory ? row.workingDirectory : ''
  `).catch(() => '')
}

/**
 * Bind the working directory and PROVE it took — F1.121, origin SIT-9's
 * P-SIT9-4.
 *
 * `setWorkingDirectory` fires and returns while the session's own
 * `workingDirectory` fills in later, and measured 2026-09-20 (SIT-9, rig
 * finding 2) the session stayed bound to a PREVIOUS repository in **2 of 3**
 * drives: every settings read then pointed at a directory the session never
 * used, every `settingsUnchanged` control passed vacuously, and the rule the
 * product really wrote landed in the previous repository. The failure is silent
 * and flattering, which is why this helper exists rather than a comment.
 *
 * Four measured properties, each paid for by a different case:
 *
 *  1. **The command is STARTED and not awaited.** `updateWorkingDirectory` on a
 *     directory the app has no trust decision for raises a modal and does not
 *     resolve until it is answered, so `await setWorkingDirectory(...)` followed
 *     by `await trustScratchProject(...)` is a deadlock (`pkg-4.ts`). A caller
 *     that needs to answer the gate starts this call, answers beside it, and
 *     awaits the result:
 *     ```ts
 *     const bind = bindWorkingDirectory(session, key.sessionId, root)
 *     const gate = await trustScratchProject(session, root)
 *     const bound = await bind
 *     ```
 *  2. **A throw is not a failure.** `sessionCommand` answers
 *     `Request timeout: sessions:command (30000ms)` on a mutation that LANDED
 *     when a previous runtime is tearing down on the same queue (`pkg-5.ts`), so
 *     every error is KEPT and the verdict is the read-back.
 *  3. **`session-project-mutation-busy` must not be retried.**
 *     `acquireSessionMutationBoundary` refuses a second mutation for the same
 *     session, and `pkg-6.ts` measured a retry colliding with its own first call
 *     — still running server-side after the RPC gave up. On `busy` this waits
 *     out the poll and stops rather than re-issuing.
 *  4. **Paths are compared as REAL paths.** `mkdtempSync(join(tmpdir(), …))`
 *     answers `/var/folders/…` where the app reports `/private/var/folders/…`
 *     (`rs-80.ts`), and a string comparison there reports a correct bind as a
 *     failure.
 *
 * The budget is generous on purpose: the sitting box sat at load 17–18, and a
 * knob set near the resting state manufactures its own failure. It never
 * throws — the caller decides whether a missed bind is a BLOCKED precondition or
 * a finding — and `reason` always names the last reading, so "bound to the
 * previous repository" and "bound to nothing yet" are different sentences.
 */
export async function bindWorkingDirectory(
  session: CdpSession,
  sessionId: string,
  dir: string,
  options: BindWorkingDirectoryOptions = {},
): Promise<WorkingDirectoryBind> {
  const timeoutMs = options.timeoutMs ?? 150_000
  const intervalMs = options.intervalMs ?? 2_000
  const attempts = options.attempts ?? 2
  const target = realPathOf(dir)
  const started = Date.now()
  const errors: string[] = []
  let reported = ''
  let issues = 0

  for (let issue = 1; issue <= attempts; issue += 1) {
    issues = issue
    // Deliberately NOT awaited — property 1 in the header.
    void setWorkingDirectory(session, sessionId, dir).catch((cause: unknown) => {
      errors.push(cause instanceof Error ? (cause.message.split('\n')[0] ?? cause.message) : String(cause))
    })
    const deadline = Date.now() + timeoutMs
    for (;;) {
      reported = await readWorkingDirectory(session, sessionId)
      if (reported !== '' && realPathOf(reported) === target) {
        return { bound: true, target, reported, waitedMs: Date.now() - started, issues, errors }
      }
      if (Date.now() >= deadline) break
      await Bun.sleep(intervalMs)
    }
    // Property 3: a retry is the wrong response to `busy` — the work is already
    // happening and the only useful action was the wait that just expired.
    if (errors.some(message => message.includes('session-project-mutation-busy'))) break
  }

  return {
    bound: false,
    target,
    reported,
    waitedMs: Date.now() - started,
    issues,
    errors,
    reason: `working-directory-not-bound: asked for ${JSON.stringify(target)}, the session reports `
      + `${JSON.stringify(reported)} after ${issues} issue(s) and ${Date.now() - started}ms`
      + (errors.length > 0 ? ` — the command also reported ${JSON.stringify(errors)}` : ''),
  }
}

export interface BindProjectOptions extends BindWorkingDirectoryOptions {
  /** Prefix for the check and the observation — an arm name, usually. */
  label?: string
  /**
   * Answers the project's trust gate WHILE the mutation is in flight, and its
   * outcome (or its error text) is observed under `<label>trust gate`.
   *
   * Write it as a thunk rather than a promise, so the ordering cannot be got
   * wrong at the call site: a promise argument is evaluated BEFORE this function
   * runs, which is the `pkg-4.ts` deadlock with extra steps.
   */
  gate?: () => Promise<unknown>
  /** `false` records the bind as a check instead of stopping the case. */
  require?: boolean
}

/**
 * The whole bind, as a case writes it — F1.182, origin WJ-j's `P-WJ-j-1`.
 *
 * `bindWorkingDirectory` is the measurement; this is the three lines that went
 * around it at every converted call site, and the reason they are one call now
 * is that 41 sites over 34 files wrote a bare `setWorkingDirectory` instead and
 * four cases wrote a LOCAL helper of the same name, each re-deriving a different
 * subset of the four properties that header records. A property re-derived
 * per case is a property three cases do not have.
 *
 * Three things it fixes at once, in the order they bite:
 *
 *  1. **The gate is answered BESIDE the mutation.** Every converted site had
 *     `await setWorkingDirectory(...)` on one line and `trustScratchProject(...)`
 *     on the next — the deadlock `pkg-4.ts` documents, survived only because the
 *     fixture project was already trusted from an earlier sitting.
 *  2. **The bind is a CHECK.** SIT-9 measured a session staying bound to a
 *     PREVIOUS repository in 2 of 3 drives with nothing reported, and every read
 *     under the root then passed vacuously. `require` (the default) turns that
 *     into the case's own failure sentence naming both directories.
 *  3. **The label travels.** A case with three arms gets three bind readings it
 *     can tell apart, which is what a sitting reads when an arm disagrees with
 *     its siblings.
 *
 * `require: false` is for a case whose SUBJECT is the bind failing — it records
 * the same sentence as a check and lets the case go on.
 *
 * **And `setWorkingDirectory` is no longer exported, which is the real gate.** A
 * source-text pin saying "no case calls the raw command" is a grep a future case
 * can pass by spelling it differently; an un-exported function cannot be reached
 * at all, and `tsc` says so at the call site rather than in a test whose failure
 * text a lane has to interpret. The few cases that must read something BETWEEN
 * the mutation and the gate — `rs-87.ts` takes its UNTRUSTED table while the
 * modal is up, `cru-1.ts` and `cru-6.ts` REFUSE to answer the gate at all — call
 * `bindWorkingDirectory` directly and await it after their own step.
 */
export async function bindProject(
  run: CaseRun,
  session: CdpSession,
  sessionId: string,
  dir: string,
  options: BindProjectOptions = {},
): Promise<WorkingDirectoryBind> {
  const prefix = options.label ? `${options.label}: ` : ''
  // Property 1 of `bindWorkingDirectory`'s header, applied rather than
  // remembered: STARTED here, awaited below, gate answered in between.
  const binding = bindWorkingDirectory(session, sessionId, dir, options)
  if (options.gate) {
    run.observe(`${prefix}trust gate`, await options.gate().catch((cause: unknown) => String(cause)))
  }
  const bind = await binding
  const label = `${prefix}the session is bound to ${dir}`
  if (options.require === false) run.check(label, bind.bound, bind.reason ?? '')
  else run.require(label, bind.bound, bind.reason ?? '')
  return bind
}

/**
 * A path as the APP spells it — `realpathSync` where the path exists.
 *
 * `/var/folders/…` and `/private/var/folders/…` are the same directory and
 * different strings, and `rs-80.ts` paid a run for comparing them raw.
 */
function realPathOf(path: string): string {
  try {
    return realpathSync(resolvePath(path))
  } catch {
    return resolvePath(path)
  }
}
