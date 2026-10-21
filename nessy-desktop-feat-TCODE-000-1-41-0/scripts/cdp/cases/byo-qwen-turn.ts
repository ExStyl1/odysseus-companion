/**
 * BYO-QWEN (D6 case 4) — C6's two halves on a real BYO llm-proxy connection.
 *
 * HALF 1, the `<think>` leak: a turn on a Qwen model must produce assistant
 * text with no reasoning block in it. `tool-schema-dialect.ts` splits reasoning
 * out per request BY MODEL ID, and the split is what keeps `<think>…</think>`
 * out of the answer.
 *
 * HALF 2, the header: the reasoning proxy swaps `Authorization: Bearer` for
 * `Nestor-Token` ONLY when the upstream is the verified gateway. A BYO endpoint
 * must keep its Bearer, or every request 401s. This half is measured on the
 * proxy's OWN outgoing request, not read off the source — D5/D7 discipline.
 *
 * THE INSTRUMENT, and why one had to be added: the proxy used to name nothing
 * about its auth, so the only way to "check" this was to read
 * `upstreamHeaders`, which is an argument rather than a measurement. It now
 * writes ONE line per request under `NESSY_PROXY_AUTH_DEBUG=1` naming the
 * SCHEME and never the value (`bearer` / `nestor-token` / `none`).
 *
 * AND WHERE THAT LINE IS READ FROM, which took three launch configurations to
 * establish: NOT the terminal and NOT a file. The line goes to the pi
 * SUBPROCESS's stderr, which the host captures into an always-on ~8KB ring
 * buffer and otherwise echoes only through `debug()` → electron-log, whose
 * transports the main process disables. Measured 2026-08-14 on a connection
 * verified to meet the proxy's start condition and running a real completion:
 * plain, `+NESSY_DEBUG=1` and `+NESSY_IS_PACKAGED=false` all captured zero
 * lines. The ring buffer IS the sink, and `getSessionRecentStderr` is the
 * read-only accessor over it.
 *
 * THE SUBSTRATE TRAP THIS CASE EXISTS INSIDE, recorded so nobody runs it
 * hopefully (LIVE-PHASE HANDOFF #2, 2026-08-14): the owner's `pi-api-key-2`
 * carried ONLY `claude-*` ids and no Qwen. Run on a non-Qwen model, half 1
 * passes VACUOUSLY — there is no reasoning block to leak, so "no leak" says
 * nothing. The case therefore REQUIRES a Qwen id on the connection and BLOCKS
 * otherwise, naming the fix.
 *
 * THE TWO ARMS RUN ON DIFFERENT MODELS, and that is an improvement over the
 * plan's single-model shape rather than a compromise (planner + owner's own
 * selection, 2026-08-15). Auto-detection keys off an EXACT allowlist —
 * `NESTOR_GATEWAY_QWEN_MODELS` is `tgpt/qwen35-397b-a17b-fp8` and
 * `tgpt/qwen36-35b-a3b-fp8`, verified in `tool-schema-dialect.ts:3`, nothing
 * else — so:
 *
 * - UNFORCED runs on an ALLOWLISTED id. Auto-detection must fire on its own:
 *   the split happens because the product recognised the model.
 * - FORCED runs on a qwen-family id that is NOT allowlisted (the owner picked
 *   `tgpt/qwen35-397b-a17b-fp8-vl`). That is EXACTLY the case E6's dialect hint
 *   exists for — a Qwen served under a name the allowlist cannot know — so the
 *   forced run proves the hint does for `-vl` what auto-detect does for qwen36.
 * - The BOUNDARY arm (`NESSY_QWEN_NEGATIVE=1`) is the honest no-op case, and
 *   its precondition is narrower than it first looks. `shouldProxy` is decided
 *   PER CONNECTION, not per request: one allowlisted id anywhere in
 *   `proxyConfigModelIds` starts the proxy for every model on that connection.
 *   Measured 2026-08-15 — this arm was written expecting no proxy at all on a
 *   `-vl` turn and found `upstream auth: bearer`, because the same connection
 *   also carried the plain `…-fp8`. The arm therefore REQUIRES a connection
 *   with no allowlisted sibling, and blocks rather than reporting the
 *   product's correct behaviour as a failure.
 *
 * One run per arm, `NESSY_QWEN_DIALECT=1` for the forced one.
 *
 * Usage, at the sitting — the app must be running with the instrument on:
 *   NESSY_PROXY_AUTH_DEBUG=1 NESSY_CDP_PORT=9224 bun run electron:dev
 *   NESSY_CDP_PORT=9224 NESSY_QWEN_SLUG=<slug> \
 *     bun run scripts/cdp/cases/byo-qwen-turn.ts
 */

import type { CdpSession } from '../lib/connect.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import { assertElectronApi, freshSession, sessionCommand, waitFor } from '../lib/state.ts'
import { sendPrompt, lastAssistantText } from '../lib/chat.ts'
import { checkAbsence, positive } from '../lib/turn-evidence.ts'

const ID = 'BYO-QWEN'
const TITLE = 'A Qwen turn on a BYO llm-proxy connection: no <think> leak, and the Bearer survives'

/**
 * The EXACT allowlist auto-detection uses (`tool-schema-dialect.ts:3`), not a
 * `/qwen/i` guess. The difference is the case: a `/qwen/i` gate would have run
 * the unforced arm on `…-fp8-vl`, which auto-detect does not recognise, and
 * reported the resulting no-split as a product defect.
 */
const AUTO_DETECTED_QWEN = ['tgpt/qwen35-397b-a17b-fp8', 'tgpt/qwen36-35b-a3b-fp8']
/** Anything qwen-family — the population the FORCED arm draws from. */
const QWEN_FAMILY = /qwen/i

interface StoredConnection {
  slug: string
  providerType?: string
  baseUrl?: string
  customEndpoint?: { api?: string; dialect?: string }
  models?: Array<string | { id: string }>
}

const idOf = (m: string | { id: string }): string => (typeof m === 'string' ? m : m.id)

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)

  const all = await session.call<StoredConnection[]>(`
    const res = await window.electronAPI.listLlmConnections()
    return (res?.connections ?? res ?? []).map(c => ({
      slug: c.slug, providerType: c.providerType, baseUrl: c.baseUrl ?? undefined,
      customEndpoint: c.customEndpoint ?? undefined, models: c.models ?? [],
    }))
  `)

  const wanted = process.env.NESSY_QWEN_SLUG
  const forcedDialect = process.env.NESSY_QWEN_DIALECT === '1'
  const negativeArm = process.env.NESSY_QWEN_NEGATIVE === '1'
  const byo = all.filter(c =>
    (c.baseUrl ?? '').includes('llm-proxy.t-tech.team')
    && !(c.baseUrl ?? '').includes('code-completion-nestor'))

  // The arm decides which model this run NEEDS, and they are different
  // populations — see the header.
  const wantsAllowlisted = !forcedDialect && !negativeArm
  const modelFor = (c: StoredConnection): string | undefined => {
    const ids = (c.models ?? []).map(idOf)
    if (wantsAllowlisted) return ids.find(id => AUTO_DETECTED_QWEN.includes(id))
    // The BOUNDARY arm needs the proxy NOT to start, and that is a property of
    // the whole connection: an allowlisted sibling starts it for everything.
    if (negativeArm && ids.some(id => AUTO_DETECTED_QWEN.includes(id))) return undefined
    return ids.find(id => QWEN_FAMILY.test(id) && !AUTO_DETECTED_QWEN.includes(id))
  }
  const candidates = byo.filter(c => (!wanted || c.slug === wanted) && modelFor(c))

  run.observe('BYO llm-proxy connections', byo.map(c => ({
    slug: c.slug,
    dialect: c.customEndpoint?.dialect ?? null,
    models: (c.models ?? []).map(idOf),
  })))
  run.observe('arm needs', wantsAllowlisted
    ? `an ALLOWLISTED id (${AUTO_DETECTED_QWEN.join(' | ')}) — auto-detection must fire on its own`
    : 'a qwen-family id that is NOT allowlisted — the escape-hatch population')

  if (candidates.length === 0) {
    blocked(wantsAllowlisted
      ? 'no BYO llm-proxy connection carries an ALLOWLISTED qwen id. Auto-detection keys off '
        + `${AUTO_DETECTED_QWEN.join(' / ')} exactly, so running this arm on any other id would report `
        + 'a no-split that is correct behaviour as a defect. Pick one of those in the form and save.'
      : negativeArm
        ? 'the BOUNDARY arm needs a connection with a non-allowlisted qwen id AND NO allowlisted '
          + 'sibling — `shouldProxy` is per CONNECTION, so one allowlisted id starts the proxy for '
          + 'every model on it and there is no no-proxy state left to observe.'
        : 'no BYO llm-proxy connection carries a NON-allowlisted qwen-family id (e.g. '
          + '`tgpt/qwen35-397b-a17b-fp8-vl`). That is the population the dialect hint exists for, and '
          + 'this arm has nothing to prove without one.')
  }

  const connection = candidates[0]!
  const model = modelFor(connection)!
  run.observe('connection', connection.slug)
  run.observe('qwen model', model)
  run.observe('connection dialect hint', connection.customEndpoint?.dialect ?? null)
  run.observe('run arm', negativeArm
    ? 'BOUNDARY — non-allowlisted id, no hint: the proxy must NOT front the request'
    : forcedDialect ? 'FORCED — the E6 dialect hint' : 'UNFORCED — auto-detection alone')

  if (forcedDialect && connection.customEndpoint?.dialect !== 'qwen') {
    blocked(
      'NESSY_QWEN_DIALECT=1 asks for the forced-dialect arm, but this connection carries no '
      + '`dialect: "qwen"`. Set it on the connection (config-level escape hatch — the UI control was '
      + 'removed in G2) and re-run, or drop the flag to measure the other arm.',
    )
  }
  if (!forcedDialect && connection.customEndpoint?.dialect === 'qwen') {
    blocked(
      'this connection HAS `dialect: "qwen"`, so this run would measure the forced arm while claiming '
      + 'the unforced one. Use a connection without the hint for this arm, or pass NESSY_QWEN_DIALECT=1.',
    )
  }

  // --- the turn ------------------------------------------------------------
  const key = await freshSession(session, `CDP ${ID} ${new Date().toISOString().slice(11, 19)}`)
  run.observe('session', key)
  if (!key.fresh) {
    run.check('the case ran in a session it created', false, key.reason ?? 'unknown')
    return
  }

  await sessionCommand(session, key.sessionId, { type: 'setConnection', connectionSlug: connection.slug })
  const active = await waitFor(
    () => session.call<string | undefined>(`
      const s = (await window.electronAPI.getSessions() ?? []).find(x => x.id === ${JSON.stringify(key.sessionId)})
      return s ? (s.llmConnection ?? undefined) : undefined
    `),
    value => value === connection.slug,
    { timeoutMs: 30_000, intervalMs: 1_000, label: `session to switch to ${connection.slug}` },
  ).catch(() => undefined)
  run.require(`the session runs on ${connection.slug}`, active === connection.slug, String(active))

  await session.call(`
    await window.electronAPI.setSessionModel(${JSON.stringify(key.sessionId)}, ${JSON.stringify(key.workspaceId)}, ${JSON.stringify(model)})
    return 1
  `)
  const settled = await waitFor(
    () => session.call<string | null>(`
      return (await window.electronAPI.getSessionModel(${JSON.stringify(key.sessionId)}, ${JSON.stringify(key.workspaceId)})) ?? null
    `),
    value => value === model,
    { timeoutMs: 20_000, intervalMs: 500, label: `session model becomes ${model}` },
  ).catch(() => null)
  run.require(`the session is on ${model} before the turn`, settled === model, String(settled))

  // A prompt that INVITES reasoning: a model that never thinks cannot leak, so
  // a trivial prompt would weaken half 1 the same way a non-Qwen model does.
  const turn = await sendPrompt(
    session,
    key,
    'Think step by step, then answer with one sentence: why is the sky blue?',
    240_000,
  )
  // F1.503 shape — THIS turn's rows, for the answer and the error rows alike.
  const text = lastAssistantText(turn.added)
  run.observe('assistant text (first 400)', text.slice(0, 400))

  // A RATE-LIMITED TURN IS NOT A VERDICT. llm-proxy throttles under a driver
  // that runs several turns back to back, and the result is an empty assistant
  // message — indistinguishable by content alone from a model that answered
  // with nothing. Read the session's own error rows before judging the turn.
  const endpointRefusal = turn.added
    .filter(m => m.role === 'error')
    .map(m => String(m.content ?? ''))
    .find(c => /rate limit|maximum context length/i.test(c))
  if (endpointRefusal && !text.trim()) {
    run.observe('endpoint refused the turn', endpointRefusal.slice(0, 200))
    if (negativeArm) {
      // For the BOUNDARY arm this is still evidence, not a loss: a refusal from
      // the ENDPOINT proves a request left the app, and the absent auth line
      // proves it did not go through the proxy — which is the whole claim.
      run.check(
        'a request reached the endpoint — the absence below is about the proxy, not about silence',
        true,
        endpointRefusal.slice(0, 120),
      )
    } else {
      blocked(
        'the endpoint refused this turn and it came back empty — a throttle or a context overflow is '
        + 'not a verdict on the split. Re-run in a quieter window, or on a model whose window fits '
        + 'this profile\'s tool surface.',
      )
    }
  }

  // --- HALF 1: no reasoning leak ------------------------------------------
  const leaks = [/<think>/i, /<\/think>/i, /◁think▷/i]
  const found = leaks.filter(re => re.test(text)).map(String)
  if (!negativeArm) {
    run.check('HALF 1 — the answer carries no reasoning block', found.length === 0, found.join(', ') || 'clean')
    // Belongs to the SPLITTING arms only: the boundary arm asserts an absence
    // in the proxy, and an endpoint that refused the turn is evidence for that
    // absence rather than against it.
    run.check(
      'the model actually answered — an empty turn cannot prove "no leak"',
      text.trim().length > 20,
      `${text.trim().length} chars`,
    )
  }

  // --- HALF 2: the header, read off the proxy's own line -------------------
  // The buffer belongs to THIS session's agent, so the lines below were written
  // by the turn just sent — no cross-run contamination to reason about.
  const stderr = await session.call<string>(`
    return await window.electronAPI.getSessionRecentStderr(
      ${JSON.stringify(key.sessionId)}, ${JSON.stringify(key.workspaceId)}) ?? ''
  `).catch(() => '')

  const lines = stderr.split('\n').filter(line => line.includes('[nestor-proxy] upstream auth:'))
  run.observe('proxy auth lines', lines.slice(-6))

  if (negativeArm) {
    // For the BOUNDARY arm an empty buffer is the expected result: the proxy
    // never started for an unrecognised id with no hint, so it never named an
    // auth scheme. Asserting it here is what makes the boundary a measurement
    // rather than an absence nobody looked at.
    // F1.504 — no auth line is evidence only about a request that LEFT the
    // app: an answer, or the endpoint's own refusal (the half-1 twin above).
    checkAbsence(
      run,
      'BOUNDARY — the proxy never fronted this turn',
      lines.length === 0,
      positive(text.trim().length > 0 || endpointRefusal !== undefined,
        'request that reached the endpoint (an answer, or the endpoint\'s own refusal)',
        `${text.trim().length} chars of answer; endpoint refusal ${endpointRefusal ? JSON.stringify(endpointRefusal.slice(0, 120)) : 'none'}`),
      lines.length === 0 ? 'no auth line, as expected' : `unexpected: ${lines.slice(-2).join(' | ')}`,
    )
    return
  }

  if (lines.length === 0) {
    run.observe('HALF 1 verdict', found.length === 0 ? 'no reasoning leak' : `leaked: ${found.join(', ')}`)
    run.observe('stderr buffer size', `${stderr.length} chars`)
    blocked(
      'HALF 2 found no auth line in the agent\'s stderr buffer. Either the app is not running with '
      + 'NESSY_PROXY_AUTH_DEBUG=1, or the reasoning proxy never started for this connection — it '
      + 'fronts a BYO endpoint only when the connection can run a Qwen id or carries the dialect '
      + 'hint. Half 1 ran and its checks are recorded above; this case does not report a PASS on '
      + 'one measured half.',
    )
  }

  const bearer = lines.filter(l => l.trimEnd().endsWith('bearer')).length
  const nestor = lines.filter(l => l.trimEnd().endsWith('nestor-token')).length
  const none = lines.filter(l => l.trimEnd().endsWith('none')).length
  run.observe('scheme counts', { bearer, 'nestor-token': nestor, none })

  run.check(
    'HALF 2 — the BYO upstream kept its Bearer',
    bearer > 0,
    `${bearer} bearer / ${nestor} nestor-token / ${none} none`,
  )
  run.check(
    'no Nestor-Token was sent to this BYO endpoint',
    nestor === 0,
    nestor === 0 ? 'none' : 'the gateway swap fired against a non-gateway upstream — a real defect',
  )
  // If this ever fails the INSTRUMENT is the defect, and the case must not be
  // trusted until it is fixed: a log that can carry a credential is worse than
  // no log.
  run.check(
    'the buffer names schemes only — no credential reached it',
    !/upstream auth: (?!bearer$|nestor-token$|none$)/m.test(lines.join('\n')),
  )
}

if (import.meta.main) {
  await main(ID, TITLE, drive)
}

export const meta = { id: ID, title: TITLE }
