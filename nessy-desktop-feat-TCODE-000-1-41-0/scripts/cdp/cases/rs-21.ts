/**
 * RS-21 (P6.287) — which CONNECTION and which MODEL actually answers the
 * session-title request, on each runtime.
 *
 * The titling itself is shared: `generateTitle` / `regenerateTitle` on
 * `BaseAgent` both call the abstract `runMiniCompletion`, fired off-turn by
 * `SessionManager`. What is per-backend, and unmeasured, is which model that
 * abstract call lands on. The row states the stake plainly: *"we may be paying
 * for a title on the main model on some arms."*
 *
 * ## Why the app cannot answer this and a proxy can
 *
 * The title request is OFF-TURN. It appears in no transcript, it adds no
 * message, and it is not a tool call — so every surface a case normally reads is
 * blind to it. Two consequences:
 *
 * - the detector has to be the WIRE. A logging egress proxy in front of the
 *   packaged build records the request's destination and the model id in its
 *   body, which is exactly what the row asks to be recorded;
 * - and a packaged build writes no application log, so a `[session] …` line is
 *   not an alternative and its absence is not evidence of anything.
 *
 * The code facts that are already known and are NOT re-derived by the sitting:
 * claude routes titling by setting `ANTHROPIC_DEFAULT_HAIKU_MODEL` to
 * `config.miniModel`; codex has `thread/name/set` and its own titling; and the
 * generic fallback driver's own comment says it *"spends a turn on the user's
 * endpoint"*. The run exists to say which of those actually happens per card.
 *
 * ## The control the row names
 *
 * *"an ordinary user turn in the same session, whose model id is known, so the
 * two can be told apart."* Without it the proxy log is a list of requests with
 * no way to attribute one to titling: the main-model request and a
 * main-model-titled request are the same line. Send the ordinary turn FIRST,
 * note its model id, and then let the title generate — the second distinct model
 * id in the window is the title, and a window with only ONE model id is itself
 * the finding the row is hunting.
 *
 * ## The second clause, which needs no proxy
 *
 * *"whether accepting a plan REPLACES the generated title."* That is readable
 * from the app alone: the session's `name` before and after a plan is accepted.
 * Drive it in the same sitting; it costs one extra turn.
 *
 * ## THE PROXY PREMISE IS REFUTED, and that is why this file now DRIVES
 *
 * Measured 2026-09-12 (R6a) on the packaged 1.36.0, HEAD `70d269e46`. The
 * paragraph above is right that the title request is off-turn and invisible to
 * `getSessionMessages`. It is wrong that the WIRE is the only place it shows up,
 * and it is wrong per runtime in two different directions:
 *
 * - **claude — the SDK writes the mini request down itself.**
 *   `ClaudeAgent.runMiniCompletion` does not post to the gateway; it runs the
 *   SDK's own `query({ prompt, options })` with `model: this.config.miniModel`,
 *   `maxTurns: 1` and `thinking: { type: 'disabled' }`. A `query()` is a
 *   conversation, so the SDK files it under
 *   `<workspace>/claude-config/projects/<slug of the SUBPROCESS cwd>/<uuid>.jsonl`
 *   — a DIFFERENT directory from the session's own, because the one-shot does not
 *   inherit the session's working directory — and the assistant entry there
 *   carries `message.model`. Read off this rig before the drive existed:
 *   `"model":"tgpt/qwen36-35b-a3b-fp8"`, the gateway's `fast` alias target, on a
 *   session whose main model is `tgpt/deepseek-v4-flash-0731`.
 * - **codex — there is nothing on the wire to intercept in the first place.**
 *   `CodexAgent.queryLlm`'s own comment says it *"Deliberately bypasses the local
 *   adapter (a one-shot needs no Responses translation)"*, and it picks
 *   `request.model || this._model` while `runMiniCompletion` passes no model. So
 *   the title is a direct chat completion on the SESSION'S MAIN MODEL, and the
 *   app-server never sees it. The measurement is therefore a NEGATIVE one: the
 *   codex rollout gains nothing across the title request, which is the row's
 *   *"any arm found spending a main-model turn on a title is named"* arm.
 *
 * An egress proxy would still answer both, and it would answer them for Pi too —
 * the manual block is kept verbatim for that reason. What the drive buys is that
 * two of the three arms need no proxy, no TLS interception, and no lane holding
 * the operator's real credential in a log.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { sendPrompt } from '../lib/chat.ts'
import type { CdpSession } from '../lib/connect.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import {
  listConnections, resolveConfigDir, runtimeOf, switchRuntime, waitForConnection,
} from '../lib/runtime-switch.ts'
import { readCodexSessionLog } from '../lib/codex-session-log.ts'
import { assertElectronApi, freshSession, listSessions, sessionCommandResult, type TranscriptMessage } from '../lib/state.ts'

import type { CaseMeta, SittingRecipe } from '../lib/sitting.ts'
import { turnAnswered } from '../lib/turn-evidence.ts'

const ID = 'RS-21'
const TITLE = 'which connection and which model answers the session-title request, per runtime — and whether accepting a plan replaces the generated title'

export const meta = {
  id: ID,
  title: TITLE,
  row: 'P6.287',
  runtimes: ['pi', 'claude', 'codex'],
  credentials: 'owner: one card per runtime, plus a logging egress proxy in front of the packaged build. No key is entered; the proxy sees the request, the sitting reads its log.',
} as const satisfies CaseMeta

export const manual = {
  steps: [
    '1. Start a logging egress proxy that records, per request, the destination host and path and the `model` field of the body. Launch the PACKAGED build behind it. A dev build runs the host and the Pi subprocess from built bundles and is not the artefact whose titling is under test.',
    '2. Note the proxy log offset. Everything below is scored against what THIS window added.',
    '3. Create a NEW session on the card under test and leave it UNNAMED. Record the card slug and the connection\'s `defaultModel` and `miniModel` as the app reports them — those are the two ids the log is about to be read against.',
    '4. THE CONTROL, first: send one ordinary user turn ("Reply with the single word ready."). Read the proxy log and record the model id that answered it. That id is now known and can be subtracted from everything after it.',
    '5. Let the title generate (it fires off-turn once the session has content; if it does not, drive it with `sessionCommand(id, { type: "refreshTitle" })` and say in the notes that it was driven rather than spontaneous).',
    '6. Read the proxy log again. Record: the destination host and path of the title request, and its model id. Compare it against the control\'s id and against the connection\'s `miniModel`.',
    '7. Write the cell for this runtime as: connection <slug>, model <id>, and whether that id is the mini model or the main model. An arm where the title id EQUALS the control id is the finding — that arm is spending a main-model turn on a title, and the row asks for it to be NAMED, not merely noticed.',
    '8. SECOND CLAUSE, same session, no proxy needed: record the session `name` after step 5. Then ask for a plan, accept it, and read the `name` again. Record whether accepting the plan REPLACED the generated title or left it.',
    '9. Repeat 3–8 per runtime. Three cards, three cells, plus three answers to the plan clause.',
  ],
  expected: 'per runtime, the connection slug and the model id behind the title request, classified as mini or main; plus a yes/no on a plan replacing the generated title.',
  detector: 'the egress proxy log — destination and the request body\'s `model` — because the title request is off-turn and appears in no transcript. For the plan clause, the session\'s own `name` before and after. Never the application log: a packaged build writes none.',
  positiveControl: 'an ordinary user turn in the SAME session, sent first, whose model id is then known and can be told apart from the title request. A window carrying only one model id is itself the answer, not a failed reading.',
  doneMeans: 'per runtime, the connection and model id behind `generateTitle`/`regenerateTitle` are recorded, and any arm found spending a main-model turn on a title is named — plus the second clause, whether accepting a plan REPLACES the generated title.',
} as const satisfies SittingRecipe

/**
 * The two title prompts' own opening lines, written out rather than imported.
 *
 * `buildTitlePrompt` opens *"What topic or area is the user exploring?"* and
 * `buildRegenerateTitlePrompt` opens *"Based on these messages, what is this
 * conversation about?"* (`packages/shared/src/utils/title-generator.ts`).
 * `refreshTitle` takes the regenerate path, and a spontaneous first-turn title
 * takes the other, so both are needles.
 *
 * Hand-written on purpose: a detector that imports its expectation from the code
 * under test matches whatever that code does, a regression included.
 */
const TITLE_NEEDLES = [
  'What topic or area is the user exploring?',
  'Based on these messages, what is this conversation about?',
] as const

interface MiniRequestReading {
  file: string
  /** The model the SDK recorded for the assistant turn that answered the title prompt. */
  model?: string
  needle: string
}

/**
 * Every claude SDK transcript under this workspace that carries a TITLE prompt,
 * with the model that answered it.
 *
 * The whole `projects/` tree is walked, not the session's own directory: the
 * one-shot `query()` does not inherit the session's working directory, so its
 * transcript is filed under the SUBPROCESS cwd's slug and a session-keyed read
 * cannot see it. `mtimeMs` gates the window so a previous arm's title is not read
 * as this one's.
 */
function claudeTitleRequests(workspaceId: string, sinceMs: number): MiniRequestReading[] {
  const projects = join(resolveConfigDir(), 'workspaces', workspaceId, 'claude-config', 'projects')
  if (!existsSync(projects)) return []
  const out: MiniRequestReading[] = []
  for (const dir of readdirSync(projects)) {
    const child = join(projects, dir)
    let files: string[]
    try {
      if (!statSync(child).isDirectory()) continue
      files = readdirSync(child).filter(name => name.endsWith('.jsonl')).map(name => join(child, name))
    } catch { continue }
    for (const file of files) {
      if (statSync(file).mtimeMs < sinceMs) continue
      let lines: string[]
      try { lines = readFileSync(file, 'utf8').split('\n').filter(Boolean) } catch { continue }
      const needle = TITLE_NEEDLES.find(text => lines.some(line => line.includes(text)))
      if (!needle) continue
      // The model of the first assistant entry in the same file — a one-shot
      // `query()` is a whole conversation of its own, so there is exactly one.
      let model: string | undefined
      for (const line of lines) {
        let parsed: { type?: string; message?: { model?: string } }
        try { parsed = JSON.parse(line) } catch { continue }
        if (parsed.type === 'assistant' && typeof parsed.message?.model === 'string') {
          model = parsed.message.model
          break
        }
      }
      out.push({ file, needle, ...(model ? { model } : {}) })
    }
  }
  return out
}

/** The mini model the app itself resolved for a connection, read through its own state. */
async function connectionFacts(session: CdpSession, slug: string): Promise<Record<string, unknown>> {
  return session.call<Record<string, unknown>>(`
    const listed = await window.electronAPI.listLlmConnections()
    const rows = listed && listed.connections ? listed.connections : listed
    const row = (rows ?? []).find(x => x.slug === ${JSON.stringify(slug)})
    if (!row) return { missing: true }
    return {
      defaultModel: row.defaultModel,
      miniModel: row.miniModel ?? null,
      modelIds: (row.models ?? []).map(m => m.id),
      aliases: (row.models ?? []).map(m => (m.alias ? m.alias + '=' + m.id : m.id)),
    }
  `)
}

const RUNTIME_WANTED = (process.env.NESSY_CDP_TITLE_RUNTIMES ?? 'claude,codex')
  .split(',').map(name => name.trim()).filter(Boolean)

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)
  const connections = await listConnections(session)
  const cards: Array<[string, string | undefined]> = [
    ['pi', connections.find(row => runtimeOf(row.providerType) === 'pi')?.slug],
    ['claude', connections.find(row => runtimeOf(row.providerType) === 'anthropic')?.slug],
    ['codex', connections.find(row => runtimeOf(row.providerType) === 'codex-runtime')?.slug],
  ]
  run.observe('cards', Object.fromEntries(cards))
  const selected = cards.filter(([name]) => RUNTIME_WANTED.includes(name))
  if (selected.length === 0) blocked(`NESSY_CDP_TITLE_RUNTIMES=${RUNTIME_WANTED.join(',')} names no runtime family`)

  for (const [runtime, card] of selected) {
    if (!card) {
      run.observe(`${runtime}: no card on this host`, 'arm recorded as UNMEASURED, never as a pass')
      continue
    }
    const facts = await connectionFacts(session, card)
    run.observe(`${runtime}: the connection's own model facts`, facts)

    const key = await freshSession(session, `CDP RS-21 ${runtime} ${new Date().toISOString().slice(11, 19)}`)
    run.check(`${runtime}: ran in a session it created`, key.fresh,
      key.fresh ? undefined : `inherited ${key.inheritedMessages} messages`)
    await switchRuntime(session, key.sessionId, card)
    run.require(`${runtime}: the session runs on ${card}`,
      (await waitForConnection(session, key.sessionId, card)) === card, card)

    // ---- THE CONTROL, first: an ordinary turn whose model id is then known ---
    const controlSent = await sendPrompt(session, key,
      'Please explain in two sentences why a database index speeds up a lookup.', 240_000)
      .then(turn => ({ line: `${turn.messages.length} messages`, added: turn.added }))
      .catch(error => ({ line: `failed: ${String(error)}`, added: [] as TranscriptMessage[] }))
    run.observe(`${runtime}: the control turn`, controlSent.line)
    // F1.504 — a send that did not throw is not a turn that ANSWERED: an
    // erroring or silent turn leaves no model id to subtract.
    const controlAnswer = turnAnswered(controlSent.added)
    run.check(`${runtime}: the CONTROL turn completed, so a known model id exists to subtract`,
      controlAnswer.ok,
      'without an ordinary turn in this session there is nothing to tell a title request apart from, and '
      + `the row names that control explicitly — ${controlAnswer.saw}`)

    // Everything scored below is what THIS window added.
    const windowStart = Date.now()
    // Keyed by the SESSION, not by "the newest rollout on this machine" (C3.367).
    // Three packaged instances run on this rig at once and the app-server's cwd
    // is the WORKSPACE root every session in it shares, so the only key that
    // separates this delta from a sibling lane's turn is the session id.
    const codexBeforeLog = runtime === 'codex'
      ? readCodexSessionLog(key)
      : undefined
    const codexBefore = codexBeforeLog?.entries.length ?? 0
    await Bun.sleep(1_500)

    type TitleAnswer = { success?: boolean; title?: string; error?: string }
    const refreshed: TitleAnswer = await sessionCommandResult<TitleAnswer>(
      session, key.sessionId, { type: 'refreshTitle' },
    ).catch((error: unknown): TitleAnswer => ({ error: String(error) }))
    run.observe(`${runtime}: refreshTitle answered`, refreshed)
    run.check(`${runtime}: the title request RAN, so there is something to attribute`,
      refreshed?.success === true && typeof refreshed?.title === 'string',
      `refreshTitle did not produce a title (${JSON.stringify(refreshed)}), so no model id can be read`)

    // Give the off-turn request time to land in whatever writes it down.
    await Bun.sleep(8_000)

    if (runtime === 'claude') {
      const found = claudeTitleRequests(key.workspaceId, windowStart)
      run.observe(`${runtime}: the SDK's own transcripts carrying a TITLE prompt in this window`, found)
      const models = [...new Set(found.map(entry => entry.model).filter(Boolean))] as string[]
      run.check(`${runtime}: the title request was found in the SDK's own transcript`, found.length > 0,
        'no .jsonl written in this window carries either title prompt — either the request went out on a '
        + 'path the SDK does not file (which would make the proxy the only detector after all) or it never '
        + 'went out; the refreshTitle answer above says which')
      const main = String((facts as { defaultModel?: string }).defaultModel ?? '')
      run.observe(`${runtime}: THE READING — the model behind the title`, {
        connection: card,
        titleModels: models,
        sessionMainModel: main,
        verdict: models.length === 0
          ? 'not established from the transcript'
          : models.every(id => id !== main)
            ? `a model OTHER than the session's main one answered the title (${models.join(', ')}) — the mini tier`
            : `THE TITLE RAN ON THE SESSION'S MAIN MODEL (${main}) — the arm the row asks to be NAMED`,
      })
    }

    if (runtime === 'codex') {
      const after = readCodexSessionLog(key)
      run.observe(`${runtime}: the codex rollout across the title request`, {
        before: codexBefore, after: after.entries.length, file: after.file, reason: after.reason,
        beforeReason: codexBeforeLog?.reason,
      })
      // Without a BEFORE read that found this session's own rollout, "it did not
      // grow" and "it was never read" are the same number, and the verdict below
      // would be confirmed by its own instrument failing — a control whose two
      // arms agree is a deleted test that still runs.
      run.check(`${runtime}: the rollout was READ before the title request, so the delta means something`,
        codexBefore > 0,
        `the before read returned no entries (${codexBeforeLog?.reason ?? 'no reason given'}), so a zero `
        + 'delta below is uninterpretable rather than evidence that titling bypassed the app-server')
      // The rollout is the app-server's own record. A title request that reached
      // codex would add to it; one that bypassed it adds nothing, which is what
      // `queryLlm`'s own comment says happens.
      run.observe(`${runtime}: THE READING — the model behind the title`, {
        connection: card,
        rolloutGrew: after.entries.length > codexBefore,
        sessionMainModel: (facts as { defaultModel?: string }).defaultModel,
        verdict: 'codex titling never reaches the app-server: `CodexAgent.queryLlm` bypasses the local '
          + 'adapter and posts a chat completion on `request.model || this._model`, and `runMiniCompletion` '
          + 'passes no model — so the title runs on the SESSION\'S MAIN MODEL. The rollout delta above is '
          + 'the live half of that reading; a GROWN rollout would refute it.',
      })
    }

    // ---- SECOND CLAUSE: does accepting a plan replace the generated title? --
    const before = (await listSessions(session)).find(row => row.id === key.sessionId)?.name
    run.observe(`${runtime}: the session name BEFORE the plan`, before)
    await session.call(`
      try { await window.electronAPI.sessionCommand(${JSON.stringify(key.sessionId)}, { type: 'setPermissionMode', mode: 'plan' }) } catch (e) { return String(e) }
      return 'plan'
    `).then(value => run.observe(`${runtime}: plan mode`, value)).catch(() => undefined)
    const planTurn = await sendPrompt(session, key,
      'Please write a two-step plan for renaming one variable in a small script, then stop.', 240_000)
      .then(turn => `${turn.messages.length} messages`).catch(error => `failed: ${String(error)}`)
    run.observe(`${runtime}: the plan turn`, planTurn)
    await Bun.sleep(5_000)
    const after = (await listSessions(session)).find(row => row.id === key.sessionId)?.name
    run.observe(`${runtime}: SECOND CLAUSE — the session name AFTER the plan turn`, {
      before, after,
      reading: before === after
        ? 'the generated title SURVIVED the plan turn'
        : `the name CHANGED from ${JSON.stringify(before)} to ${JSON.stringify(after)}`,
      caveat: 'the plan ACCEPTANCE card is an operator action; what is driven here is the plan turn itself, '
        + 'so a name unchanged is evidence about the turn and not yet about the acceptance',
    })
  }
}

if (import.meta.main) await main(ID, TITLE, drive)
