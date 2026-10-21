/**
 * RS-59 (D1.207) — `session.id` on codex's OTLP **trace** resource, on a packaged
 * build, with both exporters on.
 *
 * ## The residue this closes
 *
 * A3.1 asked whether codex's telemetry names the session it came from. Two thirds
 * of that is answered: by source reading, and by P2.450's live drive of the
 * `/v1/logs` stream. What has never been taken is the same reading on the TRACE
 * stream with `[otel] trace_exporter` on — a separate exporter behind a separate
 * selector (`resolveCodexOtelExport` resolves the two signals INDEPENDENTLY,
 * because `OTEL_LOGS_EXPORTER=none` must not silence spans and
 * `OTEL_TRACES_EXPORTER` unset must not silence events), written to
 * `config.toml` as a separate key. Two exporters, one resource builder — and
 * "one builder" is a source reading, which is the thing this case exists to stop
 * standing in for a measurement.
 *
 * ## The rig, and why every piece of it is a precondition rather than a step
 *
 * Codex reads `config.toml` when app-server STARTS, and the host writes that file
 * from `resolveCodexOtelExport()` at runtime-build time — which reads the MAIN
 * PROCESS's environment. So the exporters cannot be turned on from inside a case:
 * the app has to be launched with them. The case BLOCKS, naming what is missing,
 * rather than driving a turn that could never emit.
 *
 * ```
 * bun run scripts/cdp/fixtures/otlp-collector.ts --port <p> --log <rig>/otlp.log
 *
 * env -u … NESSY_ENABLE_TELEMETRY=1 OTEL_TRACES_EXPORTER=otlp \
 *     OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:<p> \
 *     NESSY_CONFIG_DIR=<rig> "…/Nessy Desktop" --remote-debugging-port=… --user-data-dir=…
 *
 * NESSY_CDP_OTLP_LOG=<rig>/otlp.log NESSY_CDP_OTLP_URL=http://127.0.0.1:<p> \
 *   bun run scripts/cdp/cases/rs-59.ts
 * ```
 *
 * `OTEL_LOGS_EXPORTER` stays UNSET, which is what leaves the logs stream on — it
 * is the positive half and the case needs it. `DISABLE_TELEMETRY`, `DO_NOT_TRACK`
 * and `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` must be unset, and
 * `OTEL_EXPORTER_OTLP_HEADERS` must NOT be set: `resolveCodexOtelExport` refuses
 * the whole plan when it is, out loud, and the refusal would present here as an
 * absent stream.
 *
 * ## The detector, and the three controls
 *
 * The detector is the collector's own JSONL log — a source neither the app nor
 * the model can touch, sliced to this run's own window. It records resource
 * ATTRIBUTES and never a span, a log record or a prompt; see the fixture.
 *
 * 1. **THE SUBJECT.** A `traces` request arrives in the turn's window and its
 *    resource carries `session.id`.
 * 2. **The POSITIVE half, on the same rig.** A `logs` request arrives too — the
 *    stream P2.450 already proved. Without it, an absent trace is equally true of
 *    a collector nobody reached, an opt-in that did not take and a `config.toml`
 *    written before the turn.
 * 3. **The two streams AGREE.** The `session.id` on the trace resource is the
 *    same string as the one on the log resource. A resource builder that put a
 *    different id on each would satisfy both checks above and answer A3.1's
 *    question wrongly.
 * 4. **The id is per SESSION, not a constant.** A second session in the same app
 *    produces a DIFFERENT `session.id`. Without it, `session.id: "codex"` would
 *    pass every check above.
 *
 * ## The session is MOVED onto the card, and that is a `require`
 *
 * A fresh session binds to the profile's DEFAULT card. On this case's first drive
 * that was the Pi card: the turn answered `ready`, and the collector received
 * nothing but the HOST's own exporter (`service.name: nessy-desktop`, ten
 * requests across `logs` and `metrics`) — an absence of codex telemetry that was
 * entirely the rig's, and that would have read as D1.207 answered negatively.
 * So the switch happens through `sessions:command switchRuntime`, the shipped
 * path, and the binding is read BACK off the app before any window opens.
 *
 * ## Why the codex card, and which one
 *
 * `codex-gateway` — the product's own one-click card, pressed by the case when
 * the profile has none, by `RS-50`'s recipe (Escape first, re-find `Add
 * Connection` from the settings route each time, because a card's own dialog
 * staying up is what makes the NEXT label look missing). No credential is typed:
 * the one-click sign-in is the app's own `dp` module reading its own file.
 *
 * ## Safety
 *
 * The collector is on `127.0.0.1` and forwards nothing. No credential is read,
 * printed or written. The turn the case drives is a plain sentence.
 */

import { readFileSync } from 'node:fs'

import { sendPrompt } from '../lib/chat.ts'
import type { CdpSession } from '../lib/connect.ts'
import type { OtlpCollectorLine } from '../fixtures/otlp-collector.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import { switchRuntime, waitForConnection } from '../lib/runtime-switch.ts'
import { assertElectronApi, freshSession, textOfRole } from '../lib/state.ts'
import { clickAt } from '../lib/viewport.ts'
import type { CaseMeta } from '../lib/sitting.ts'

const ID = 'RS-59'
const TITLE = 'session.id on codex’s OTLP TRACE resource, with the logs stream beside it as the positive half'

export const meta = {
  id: ID,
  title: TITLE,
  row: 'D1.207',
  runtimes: ['codex'],
  credentials:
    'owner: the machine holds the shared dp sign-in the one-click cards use (`~/.nessy/dp_auth_creds.json`, outside '
    + 'the config dir) — the case never reads, prints or writes it. Launch the PACKAGED build on a NESSY_CONFIG_DIR '
    + 'created for the run, with NESSY_ENABLE_TELEMETRY=1, OTEL_TRACES_EXPORTER=otlp and OTEL_EXPORTER_OTLP_ENDPOINT '
    + 'pointing at `fixtures/otlp-collector.ts`; export NESSY_CDP_OTLP_LOG and NESSY_CDP_OTLP_URL to the case.',
} as const satisfies CaseMeta

const CODEX_SLUG = 'codex-gateway'
const CODEX_LABEL = /Codex agent/i

function collectorLog(path: string): OtlpCollectorLine[] {
  try {
    return readFileSync(path, 'utf8').split('\n').filter(Boolean)
      .map(line => { try { return JSON.parse(line) as OtlpCollectorLine } catch { return undefined } })
      .filter((line): line is OtlpCollectorLine => line !== undefined)
  } catch {
    return []
  }
}

/** The lines inside one window, which is how a turn's own telemetry is isolated. */
function between(lines: readonly OtlpCollectorLine[], fromIso: string, toIso: string): OtlpCollectorLine[] {
  return lines.filter(line => line.t >= fromIso && line.t <= toIso)
}

/**
 * Codex's own requests, and nothing else.
 *
 * Load-bearing, and the first drive is why: the HOST has exporters of its own
 * pointed at the same endpoint (`service.name: nessy-desktop`, 8 logs and 3
 * metrics requests in this rig's log), so an unfiltered window answers "telemetry
 * arrived" about a run in which codex emitted nothing at all.
 */
const CODEX_SERVICE = 'codex-app-server'

function codexLines(lines: readonly OtlpCollectorLine[], signal: string): OtlpCollectorLine[] {
  return lines.filter(line => line.signal === signal && line.identity['service.name'] === CODEX_SERVICE)
}

/** The first `session.id` codex's own resources carry for a signal inside a window. */
function sessionIdOf(lines: readonly OtlpCollectorLine[], signal: string): string | undefined {
  for (const line of codexLines(lines, signal)) {
    const id = line.identity['session.id']
    if (id) return id
  }
  return undefined
}

/** Every resource key codex put on a signal in this window — what an absence is read against. */
function codexResourceKeys(lines: readonly OtlpCollectorLine[], signal: string): string[] {
  return [...new Set(codexLines(lines, signal).flatMap(line => line.resourceKeys))].sort()
}

/**
 * Post a synthetic OTLP payload carrying `session.id` to the collector.
 *
 * THE INSTRUMENT'S OWN POSITIVE CONTROL, and it is not optional: every reading
 * below is an ABSENCE, and an absence needs a positive control on the same
 * instrument (AGENTS.md). Without it, "codex's resource has no `session.id`" is
 * equally true of a collector that drops the attribute, a walker that reads the
 * wrong envelope, and a value shape this fixture does not decode.
 */
async function probeCollector(url: string): Promise<{ ok: boolean; detail: string }> {
  const body = JSON.stringify({
    resourceSpans: [{ resource: { attributes: [
      { key: 'session.id', value: { stringValue: 'rs-59-instrument-control' } },
      { key: 'service.name', value: { stringValue: 'rs-59-probe' } },
    ] } }],
  })
  try {
    const response = await fetch(`${url.replace(/\/$/, '')}/v1/traces`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body,
    })
    return { ok: response.ok, detail: `HTTP ${response.status}` }
  } catch (error) {
    return { ok: false, detail: String(error) }
  }
}

interface Rect { x: number; y: number; text: string }

async function buttonByText(session: CdpSession, pattern: RegExp): Promise<Rect | undefined> {
  return session.call<Rect | undefined>(`
    const wanted = ${pattern.toString()}
    const button = Array.from(document.querySelectorAll('button')).find(el => wanted.test((el.innerText || '').replace(/\\s+/g, ' ')))
    if (!button) return undefined
    button.scrollIntoView({ block: 'center' })
    await new Promise(resolve => setTimeout(resolve, 400))
    const r = button.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) return undefined
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), text: (button.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 120) }
  `)
}

/** RS-50's recipe, and the Escape at the top is the load-bearing half of it. */
async function pressOneClick(session: CdpSession, label: RegExp): Promise<string | undefined> {
  await session.call<null>(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return null`)
  await Bun.sleep(800)
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const done = await buttonByText(session, /get started/i)
    if (!done) break
    await clickAt(session, { x: done.x, y: done.y }, 'the onboarding’s Get Started button')
    await Bun.sleep(2_000)
  }
  await session.call<null>(`
    window.dispatchEvent(new CustomEvent('nessy-agent-navigate', { detail: { route: 'settings/ai' }, bubbles: true }))
    return null
  `)
  await Bun.sleep(2_500)
  let add = await buttonByText(session, /Add Connection/i)
  if (!add) {
    const section = await buttonByText(session, /^AI Model, thinking/i)
    if (section) {
      await clickAt(session, { x: section.x, y: section.y }, 'the AI settings section')
      await Bun.sleep(2_000)
    }
    add = await buttonByText(session, /Add Connection/i)
  }
  if (!add) return undefined
  await clickAt(session, { x: add.x, y: add.y }, 'Add Connection')
  await Bun.sleep(2_500)
  const card = await buttonByText(session, label)
  if (!card) return undefined
  await clickAt(session, { x: card.x, y: card.y }, card.text)
  await Bun.sleep(4_000)
  return card.text
}

/** One turn on a session bound to the codex card, with its own window. */
async function turnInNewSession(
  run: CaseRun,
  session: CdpSession,
  label: string,
): Promise<{ sessionId: string; from: string; to: string }> {
  const key = await freshSession(session, `CDP ${ID} ${label} ${new Date().toISOString().slice(11, 19)}`)
  run.check(`${label}: the case ran in a session it created`, key.fresh, key.reason ?? '')
  // The session has to be MOVED onto the codex card, and the first drive of this
  // case is why it is a `require` and not an observation: a fresh session binds
  // to the profile's default card, the turn answered `ready` off the Pi card, and
  // the collector received nothing but the HOST's own exporter
  // (`service.name: nessy-desktop`) — an absence of codex telemetry that was
  // entirely the rig's and would have read as D1.207 answered negatively.
  const outcome = await switchRuntime(session, key.sessionId, CODEX_SLUG)
  const bound = await waitForConnection(session, key.sessionId, CODEX_SLUG, outcome.ok ? 30_000 : 60_000)
  run.observe(`${label}: the card that answered`, { bound: bound ?? '(unknown)', switchOk: outcome.ok })
  run.require(
    `${label}: the session is bound to \`${CODEX_SLUG}\``,
    bound === CODEX_SLUG,
    `the session reports \`${String(bound)}\`, so no codex runtime ran and nothing below measures codex telemetry: `
    + String(outcome.errorDetail?.message ?? outcome.error ?? 'the app reported no error'),
  )
  const from = new Date().toISOString()
  const turn = await sendPrompt(session, key, 'Reply with the single word ready and nothing else.', 240_000)
  // Codex's exporter batches, so the window is closed AFTER a settle rather than
  // at the turn's last message: a zero taken at the turn's own end would be a
  // reading about the batch interval.
  await Bun.sleep(12_000)
  const to = new Date().toISOString()
  run.observe(`${label}: the turn`, {
    answered: textOfRole(turn.added, 'assistant').join(' ').slice(0, 120) || '(none)',
    window: [from, to],
  })
  return { sessionId: key.sessionId, from, to }
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)

  const logPath = process.env.NESSY_CDP_OTLP_LOG?.trim()
  if (!logPath) {
    blocked(
      'NESSY_CDP_OTLP_LOG is not set, and the collector\'s log IS this case\'s detector. Start '
      + '`scripts/cdp/fixtures/otlp-collector.ts` and launch the app with NESSY_ENABLE_TELEMETRY=1, '
      + 'OTEL_TRACES_EXPORTER=otlp and OTEL_EXPORTER_OTLP_ENDPOINT pointing at it — the exporters are resolved from '
      + 'the MAIN PROCESS\'s environment when the runtime is built, so no case can turn them on.',
    )
  }

  // The collector must already be receiving SOMETHING, or every absence below is
  // equally true of a rig that was never wired up. This is the same rule
  // `rs-43.ts` states for its proxy.
  const collectorUrl = process.env.NESSY_CDP_OTLP_URL?.trim()
  if (!collectorUrl) {
    blocked(
      'NESSY_CDP_OTLP_URL is not set. Every reading this case takes is an ABSENCE, and an absence needs a positive '
      + 'control on the same instrument: the case posts one synthetic resource carrying `session.id` to the collector '
      + 'and requires it back out of the log. Pass the same URL the app was launched with.',
    )
  }
  const probe = await probeCollector(collectorUrl)
  await Bun.sleep(1_000)
  const before = collectorLog(logPath)
  const probed = before.some(line => line.identity['session.id'] === 'rs-59-instrument-control')
  run.observe('the collector log before the drive', {
    lines: before.length,
    signals: [...new Set(before.map(line => line.signal))],
    emitters: [...new Set(before.map(line => line.identity['service.name'] ?? '(none)'))],
    probe,
  })
  run.require(
    'THE INSTRUMENT CONTROL — this collector records `session.id` when a resource carries one',
    probed,
    `a synthetic OTLP payload carrying \`session.id\` was posted to ${collectorUrl} (${probe.detail}) and the log `
    + 'does not carry it back. Every absence below would be unreadable, so the case stops here rather than reporting '
    + 'codex silent about an attribute this rig cannot see in the first place',
  )

  let cards = await session.call<Array<{ slug: string; providerType: string }>>(`
    const rows = await window.electronAPI.listLlmConnections()
    return (rows ?? []).map(c => ({ slug: c.slug, providerType: c.providerType }))
  `)
  if (!cards.some(card => card.slug === CODEX_SLUG)) {
    run.observe('pressing the product’s own one-click codex card', await pressOneClick(session, CODEX_LABEL) ?? '(no card button)')
    cards = await session.call<Array<{ slug: string; providerType: string }>>(`
      const rows = await window.electronAPI.listLlmConnections()
      return (rows ?? []).map(c => ({ slug: c.slug, providerType: c.providerType }))
    `)
  }
  run.observe('the cards this profile has', cards)
  if (!cards.some(card => card.slug === CODEX_SLUG)) {
    blocked(
      `this profile lists no \`${CODEX_SLUG}\` connection and the one-click button did not create one, so there is no `
      + 'codex runtime to emit anything. RS-50 records the rig fact: the first press can fail on a fresh profile and '
      + 'the immediate re-run creates it.',
    )
  }

  const first = await turnInNewSession(run, session, 'session 1')
  const lines = collectorLog(logPath)
  const window1 = between(lines, first.from, first.to)
  run.observe('what the collector received in session 1’s window', window1.map(line => ({
    signal: line.signal, bytes: line.bytes, parsed: line.parsed, identity: line.identity, resources: line.resources,
  })))

  // The POSITIVE HALF first, because it is what makes a trace absence readable.
  const codexLogs = codexLines(window1, 'logs')
  run.check(
    `THE POSITIVE HALF — codex's OWN \`logs\` requests reach the collector (${CODEX_SERVICE})`,
    codexLogs.length > 0,
    'no `/v1/logs` request from codex reached the collector in this turn\'s window, so the rig is not delivering '
    + 'codex telemetry at all and an absent TRACE below says nothing about the trace exporter. Check that the app was '
    + 'launched with NESSY_ENABLE_TELEMETRY=1, that OTEL_EXPORTER_OTLP_HEADERS is unset — `resolveCodexOtelExport` '
    + 'refuses the whole plan when it is set, and says so on the session\'s own notice channel — and that the session '
    + 'is really on the codex card (it is checked above)',
  )

  const traceLines = codexLines(window1, 'traces')
  run.observe('codex’s own requests in that window', {
    logs: codexLogs.length, traces: traceLines.length,
    traceBytes: traceLines.reduce((total, line) => total + line.bytes, 0),
  })
  run.check(
    'THE SUBJECT (1) — codex emits on the TRACE stream at all, with `[otel] trace_exporter` on',
    traceLines.length > 0,
    'codex sent logs and NO traces in this window, so `trace_exporter` is not emitting — which is D1.207 answered on '
    + 'its first half, and it is a product reading rather than a rig fault, because the logs stream arrived beside it',
  )

  const tracesId = sessionIdOf(window1, 'traces')
  const logsId = sessionIdOf(window1, 'logs')
  run.observe('what codex put on its RESOURCE', {
    traces: { sessionId: tracesId, keys: codexResourceKeys(window1, 'traces') },
    logs: { sessionId: logsId, keys: codexResourceKeys(window1, 'logs') },
  })
  run.check(
    'THE SUBJECT (2) — the TRACE resource carries `session.id`',
    tracesId !== undefined,
    `codex's trace resource carries no \`session.id\`. Every key it does carry: `
    + `${JSON.stringify(codexResourceKeys(window1, 'traces'))} — and the instrument control above shows this `
    + 'collector records the attribute when it is present, so the absence is codex\'s',
  )
  run.check(
    'and the LOGS resource carries it too — P2.450\'s reading, re-taken on this artefact',
    logsId !== undefined,
    `codex's LOG resource carries no \`session.id\` either: ${JSON.stringify(codexResourceKeys(window1, 'logs'))}. `
    + 'This is the half D1.207 records as already proven, so a failure here is a premise correction rather than a new '
    + 'gap — read it against WHERE the id was proven, because a RECORD attribute is not a RESOURCE attribute and this '
    + 'fixture deliberately reads only the resource',
  )
  run.check(
    'THE CONTROL — the two streams name the SAME session',
    tracesId !== undefined && tracesId === logsId,
    tracesId === undefined && logsId === undefined
      ? 'neither stream carries `session.id` on its resource, so there is nothing to join and this control is '
        + 'vacuous rather than failing — the two checks above are the reading'
      : 'the trace resource and the log resource carry DIFFERENT `session.id` values, so "both streams name the '
        + 'session" would be true while A3.1\'s question — can a reader join them — is answered no',
  )

  // The per-session control only has a subject when an id exists at all. Run it
  // regardless — a second session is cheap and its resource KEYS are worth
  // recording — but score it only then, because a FAIL here would read as "the id
  // is a constant" when the finding is that there is no id.
  const second = await turnInNewSession(run, session, 'session 2')
  const window2 = between(collectorLog(logPath), second.from, second.to)
  const tracesId2 = sessionIdOf(window2, 'traces')
  const logsId2 = sessionIdOf(window2, 'logs')
  run.observe('session 2’s reading', {
    traces: { sessionId: tracesId2, requests: codexLines(window2, 'traces').length },
    logs: { sessionId: logsId2, requests: codexLines(window2, 'logs').length },
  })
  if (tracesId !== undefined || logsId !== undefined) {
    run.check(
      'THE CONTROL — a SECOND session gets a DIFFERENT `session.id`, so the attribute identifies a session',
      (tracesId2 ?? logsId2) !== undefined && (tracesId2 ?? logsId2) !== (tracesId ?? logsId),
      (tracesId2 ?? logsId2) === undefined
        ? 'the second session emitted no id this case could read, so "the id is per session" is unavailable rather '
          + 'than false — and the subject above is a reading about one session only'
        : 'the second session reports the SAME `session.id` as the first, so the attribute names the runtime or the '
          + 'process rather than the session, and every check above is satisfied by a constant',
    )
  } else {
    run.observe(
      'the per-session control',
      'NOT SCORED — neither session carries `session.id` on either resource, so "is the id per session" has no '
      + 'subject. Scoring it would file the absence twice and read as a claim that the id is a constant.',
    )
  }
}

if (import.meta.main) await main(ID, TITLE, drive)
