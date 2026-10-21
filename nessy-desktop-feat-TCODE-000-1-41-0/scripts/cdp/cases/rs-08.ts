/**
 * RS-08 (row P6.181) — do the gateway correlation header and the operator's own
 * headers reach the REAL upstream, on a packaged build?
 *
 * Ledger M2 (claude, codex). This is proof, not code: the mechanism landed.
 * `gatewaySessionFetch(session.id)` is the adapter's `fetchImpl` on both paths,
 * and `gatewayRequestHeaders` merges the operator's `NESSY_CUSTOM_HEADERS` with
 * the correlation id, SCOPED to `NESTOR_CLI_BASE_PREFIX`. The ledger's stated
 * residue — "the main process never installs the interceptor" — is stale and
 * moot: the `fetchImpl` seam bypasses the interceptor and works in Electron main
 * and in the headless server alike.
 *
 * What has never happened is a capture. P2.422's own note says it plainly:
 * *"Still no live or packaged evidence that the header reaches the gateway; a
 * packaged run remains the only thing that would prove it."*
 *
 * ## Two runtimes, and a positive on one does not prove the other
 *
 * claude and codex share the loopback adapter, which is exactly why a reader is
 * tempted to drive one. They are separate spawn paths into that adapter, so both
 * are driven here — control (c) of the row, and the reason the row is one lane
 * rather than two.
 *
 * ## The three controls, and what each one is for
 *
 * (a) **A BYO endpoint carries NEITHER header.** The scope is a URL prefix, so a
 *     build that dropped the prefix check would start stamping a customer's own
 *     endpoint with an internal correlation id. P6.43's second mutant showed
 *     exactly that.
 * (b) **The loopback hop carries neither.** Same mutant, other half: with the
 *     prefix scope dropped, `http://127.0.0.1:<port>` also starts receiving the
 *     id. A proxy cannot see loopback, so this control is the operator's — it is
 *     in `manual` below with the capture that reaches it.
 * (c) **codex, not only claude.** Above.
 *
 * ## Names, never values
 *
 * `customHeaderNames` exists in the product for this reason and the case follows
 * it: the operator declares the header NAMES in `NESSY_CDP_CUSTOM_HEADER_NAMES`,
 * and this file asserts a name is PRESENT in the captured request. No value of
 * any operator header, and no token of any kind, is read, compared or recorded
 * here. `x-nessy-session-id` is the exception on purpose: its value is the
 * session id, which the case itself created, and comparing it is the whole
 * assertion.
 *
 * ## The capture is the operator's rig
 *
 * A logging proxy that records REQUEST HEADERS, in front of a PACKAGED build.
 * `NESSY_CDP_HEADER_LOG` names the file it appends to. Without it the case
 * blocks: the model's reply says nothing about what left the machine, and a dev
 * build is not the shipped artefact.
 */

import { readFileSync } from 'node:fs'

import { resolveAppUnderTest } from '../lib/bundle.ts'
import { sendPrompt } from '../lib/chat.ts'
import type { CdpSession } from '../lib/connect.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import { listConnections, switchRuntime, waitForConnection } from '../lib/runtime-switch.ts'
import { assertElectronApi, freshSession, type SessionKey } from '../lib/state.ts'
import type { CaseMeta, SittingRecipe } from '../lib/sitting.ts'

const ID = 'RS-08'
const TITLE = 'The correlation and operator headers reach the real gateway upstream on a packaged build, and no other host'

export const meta = {
  id: ID,
  title: TITLE,
  row: 'P6.181',
  runtimes: ['claude', 'codex'],
  credentials: 'owner: the gateway claude and codex cards plus one BYO endpoint card for the control. '
    + 'Header NAMES only — no value of any operator header or token is read here.',
} as const satisfies CaseMeta

/** `packages/shared/src/telemetry/gateway-headers.ts` — the correlation header. */
const SESSION_ID_HEADER = 'x-nessy-session-id'

function readHeaderLog(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    blocked(`NESSY_CDP_HEADER_LOG points at ${path}, which could not be read: ${String(error)}`)
  }
}

interface ArmReading {
  label: string
  card: string
  sessionId: string
  addedBytes: number
  sawSessionHeader: boolean
  sawThisSessionId: boolean
  headerNamesSeen: string[]
}

async function driveArm(
  session: CdpSession,
  run: CaseRun,
  label: string,
  card: string,
  logPath: string,
  headerNames: string[],
): Promise<ArmReading> {
  const key: SessionKey & { fresh: boolean; inheritedMessages: number; reason?: string } =
    await freshSession(session, `CDP ${ID} ${label} ${new Date().toISOString().slice(11, 19)}`)
  run.check(`${label}: the arm ran in a session it created`, key.fresh,
    key.fresh ? undefined : `inherited ${key.inheritedMessages} messages`)
  const moved = await switchRuntime(session, key.sessionId, card)
  run.observe(`${label} — switch onto ${card}`, moved)
  run.require(`${label}: the session reports ${card}`,
    (await waitForConnection(session, key.sessionId, card)) === card, card)

  const before = readHeaderLog(logPath)
  await sendPrompt(session, key, 'Reply with the single word READY.', 300_000).catch(() => undefined)
  const added = readHeaderLog(logPath).slice(before.length)

  const lowered = added.toLowerCase()
  return {
    label,
    card,
    sessionId: key.sessionId,
    addedBytes: added.length,
    sawSessionHeader: lowered.includes(SESSION_ID_HEADER),
    // The id is this case's own session id, which is why comparing this ONE
    // value is the assertion rather than a leak.
    sawThisSessionId: added.includes(key.sessionId),
    headerNamesSeen: headerNames.filter(name => lowered.includes(name.toLowerCase())),
  }
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)

  const app = resolveAppUnderTest(session)
  run.observe('app under test', { kind: app.kind, via: app.via })
  run.check('the artefact under test is the PACKAGED app', app.kind === 'packaged',
    app.kind === 'packaged' ? undefined : `kind=${app.kind} — a dev build is not the shipped artefact, and this row is about the artefact`)

  const logPath = process.env.NESSY_CDP_HEADER_LOG?.trim()
  const claudeCard = process.env.NESSY_CDP_GATEWAY_CLAUDE_CARD?.trim()
  const codexCard = process.env.NESSY_CDP_GATEWAY_CODEX_CARD?.trim()
  const byoCard = process.env.NESSY_CDP_BYO_CARD?.trim()
  const headerNames = (process.env.NESSY_CDP_CUSTOM_HEADER_NAMES ?? '')
    .split(',').map(name => name.trim()).filter(Boolean)

  if (!logPath || !claudeCard || !codexCard || !byoCard) {
    blocked(
      'this case needs a PACKAGED build behind a proxy that logs REQUEST HEADERS. Set NESSY_CDP_HEADER_LOG '
      + 'to the file it appends to, and name three cards by slug: NESSY_CDP_GATEWAY_CLAUDE_CARD, '
      + 'NESSY_CDP_GATEWAY_CODEX_CARD and NESSY_CDP_BYO_CARD (a non-gateway endpoint, which is control (a)). '
      + 'Optionally NESSY_CDP_CUSTOM_HEADER_NAMES — a comma-separated list of the header NAMES the app was '
      + 'launched with in NESSY_CUSTOM_HEADERS. Names only; this case never reads a value.',
    )
  }
  run.observe('operator header names under test', headerNames.length > 0 ? headerNames : '(none declared)')

  const connections = await listConnections(session)
  const bySlug = new Map(connections.map(row => [row.slug, row.providerType]))
  for (const slug of [claudeCard, codexCard, byoCard]) {
    if (!bySlug.has(slug)) {
      blocked(`"${slug}" is not a connection on this host; available: ${[...bySlug.keys()].join(', ') || 'none'}`)
    }
  }
  run.observe('cards', { claude: claudeCard, codex: codexCard, byo: byoCard, providerTypes: Object.fromEntries(bySlug) })

  const claude = await driveArm(session, run, 'gateway-claude', claudeCard, logPath, headerNames)
  const codex = await driveArm(session, run, 'gateway-codex', codexCard, logPath, headerNames)
  const byo = await driveArm(session, run, 'byo-control', byoCard, logPath, headerNames)
  run.observe('readings', { claude, codex, byo })

  for (const arm of [claude, codex]) {
    // The positive control for every absence below: the proxy has to have SEEN
    // this turn at all. Without it, "no header" and "no request" are one reading.
    run.check(
      `${arm.label}: THE CONTROL — the proxy recorded traffic for this turn`,
      arm.addedBytes > 0,
      arm.addedBytes > 0 ? undefined
        : 'the header log did not grow during this turn, so nothing about headers can be read from this arm',
    )
    if (arm.addedBytes === 0) continue
    run.check(
      `${arm.label}: the correlation header reached the upstream`,
      arm.sawSessionHeader,
      arm.sawSessionHeader ? undefined : `no ${SESSION_ID_HEADER} in the captured window`,
    )
    run.check(
      `${arm.label}: and it carries THIS session's real id`,
      arm.sawThisSessionId,
      arm.sawThisSessionId ? undefined
        : `the header is present but does not carry ${arm.sessionId} — a constant or a stale id is not correlation`,
    )
    if (headerNames.length > 0) {
      run.check(
        `${arm.label}: every declared operator header name is present`,
        arm.headerNamesSeen.length === headerNames.length,
        `saw ${JSON.stringify(arm.headerNamesSeen)} of ${JSON.stringify(headerNames)}`,
      )
    }
  }

  // Control (a). Asserted only when the proxy saw the BYO turn: an absence with
  // no traffic behind it is not a control, it is a silence.
  run.check(
    'CONTROL (a): the proxy recorded the BYO turn as well',
    byo.addedBytes > 0,
    byo.addedBytes > 0 ? undefined
      : 'the BYO endpoint is not behind this proxy, so "neither header" cannot be distinguished from "no request"',
  )
  if (byo.addedBytes > 0) {
    run.check(
      'CONTROL (a): a BYO endpoint carries NEITHER header',
      !byo.sawSessionHeader && byo.headerNamesSeen.length === 0,
      `sessionHeader=${byo.sawSessionHeader} operatorNames=${JSON.stringify(byo.headerNamesSeen)} — `
      + 'the prefix scope is what keeps an internal correlation id off a customer endpoint',
    )
  }
}

/**
 * Control (b): the loopback hop. A proxy cannot see it, so it needs its own
 * capture — and it is the half of P6.43's mutant that the gateway arms cannot
 * reach.
 */
export const manual = {
  why: 'control (b) of P6.181 — the per-session loopback adapter hop, which no egress proxy observes',
  steps: [
    'With the packaged app running and a gateway session open, find the adapter port '
      + '(the SDK talks to http://127.0.0.1:<port>).',
    'Capture loopback traffic on that port for the duration of ONE turn, with a tool that shows request '
      + 'headers, and send one short prompt.',
    'Read the captured request headers for x-nessy-session-id and for each declared operator header NAME.',
    'Record the names present. Do NOT record any header value.',
  ],
  expected: 'the loopback hop carries NEITHER the correlation header nor any operator header — the scope is '
    + 'the gateway URL prefix, and only requests at that prefix are stamped',
  detector: 'the captured request headers of the loopback hop',
  positiveControl: 'the same capture must show the request itself, or "no header" is only "no traffic"',
  doneMeans: 'the ledger M2 cells move off partial / dash onto a measured verdict for BOTH runtimes, and the '
    + 'run is written to docs/testing/cdp-runs/',
} as const satisfies SittingRecipe

if (import.meta.main) await main(ID, TITLE, drive)
