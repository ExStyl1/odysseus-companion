/**
 * CDX-150 — the Codex runtime, re-measured on the binary it now ships.
 *
 * Re-pointed 2026-09-13 by C3.380 lift 2 to `rust-v0.154.0`, **and the FILE was
 * deliberately not renamed this time.** cdx-147 → cdx-148 → cdx-150 each became a
 * new file, on this docblock's own argument that a case id surviving a foreign
 * runtime's version bump lets a stale result sit under a fresh headline. That
 * argument still holds; what changed is its price, and it was measured rather
 * than guessed.
 *
 * Renaming to `cdx-154.ts` was done first and then REVERTED, because
 * `lint:ledger-citations` went red on it: this file is cited by NAME in four
 * documents — `docs/superpowers/plans/2026-08-20-cross-runtime-history-carry.md`
 * (twice), `2026-08-22-runtime-parity-closure.md`,
 * `2026-09-11-coverage-95-parity.md` and
 * `docs/superpowers/specs/2026-08-22-codex-coverage-map.md` — and THREE of the four
 * are plans, which no lane may edit. The rename therefore raises the plan's dead-
 * citation pin and leaves `lint:chain` red for every other lane, repairable only by
 * the controller. A lift lane cannot finish it, so it must not start it.
 *
 * **The convention's PURPOSE is unharmed, because the id was never what enforced
 * it.** {@link EXPECTED_CODEX_TAG} is, and it is a literal: a run against any other
 * tag reports BLOCKED before a turn is driven, so a result measured against the
 * previous binary still cannot sit under a fresh headline. The id is a label; the
 * constant is the gate. The next lift should move the constant and the TITLE and
 * leave the filename alone — or, if the id really must track the tag, land the
 * rename together with the controller's own repair of those four citations.
 *
 * History: the previous re-measurements of this same shape lived in cdx-148.ts and
 * cdx-147.ts, at the tags they were named for.
 *
 * The packaged run of 2026-08-12 measured `rust-v0.142.5` and produced the whole
 * Codex column of `docs/testing/cdp-live-checklist.md`: a turn in 4 s, a real
 * MCP call under `mcp__sources__<wire>__<tool>`, the sev-1 signing RED/GREEN.
 * The pin has moved three times since, and now to `rust-v0.154.0`. **A foreign runtime's version bump
 * invalidates every row measured against the previous one** — it is a different
 * program speaking the same protocol, and the app-server protocol is exactly
 * where our adapter lives. Nothing in that column can be carried forward by
 * argument, only by re-measurement, and this case is that re-measurement.
 *
 * ## What it asserts, and why each detector is the one it is
 *
 * 1. **The app under test really is on 0.154.0.** Asked of the BINARY, before any
 *    turn: the manifest's `upstream.tag` and the shipped file's sha256 against
 *    the manifest pin. A version claim taken from anywhere else is a claim about
 *    the repo, not about the process answering the socket — and the 1.25.0 sev-1
 *    is the proof that those two can differ, byte for byte, in the artifact a
 *    user installs (`scripts/build/codex-integrity.ts`). A disagreement here is
 *    BLOCKED, never PASS: a green result carrying the wrong version number is
 *    worse than no result.
 * 2. **A turn completes**, carrying a per-run codeword. Not a canned string:
 *    `CDXBASE4412` in a checklist is a value a model could have read; a token
 *    minted at run time and named nowhere else cannot be produced by anything
 *    but this turn.
 * 3. **A real MCP tool call, under the CODEX-shaped wire name.** Pi and the
 *    Claude runtime consume the pool per-server and see `mcp__<wire>__<tool>`;
 *    Codex consumes the whole pool through the `[mcp_servers.sources]` bridge,
 *    so its model-facing — and therefore transcript-facing — name is
 *    `mcp__sources__<wire>__<tool>` (`agent/backend/codex/event-adapter.ts`
 *    `mcpRowToolName` explains why the row is built verbatim from the item's own
 *    `server` + `tool` rather than through `buildMcpToolName()`). Forcing the Pi
 *    shape on Codex once made the runtime answer "Unknown tool" to a name it
 *    never had — a broken detector reading as a product defect.
 * 4. **The result is unfakeable.** The default probe is the elicitation
 *    fixture's `whoami`, which mints a nonce inside its own process at call time
 *    that exists in no file; the same nonce in the transcript's `toolResult` and
 *    in the model's reply ties "a server answered" to "the answer reached the
 *    turn". `context7/resolve-library-id` — the 2026-08-12 run's probe — is
 *    still available through the four env overrides below, for a run in the
 *    operator's own config dir.
 *
 * ## What it refuses to do
 *
 * Report PASS on a dev build. The checklist is explicit that `electron:dev` is
 * not the shipped artifact and that a dev run cannot see a signing-time
 * rewrite — which is the only way the shipped binary and the pin can disagree in
 * the first place. A dev run still performs every check and then ends BLOCKED
 * with what it could not answer.
 */

import { lastAssistantText, sendPrompt } from '../lib/chat.ts'
import type { CdpSession } from '../lib/connect.ts'
import { approvePermissionsWhile } from '../lib/ask-user.ts'
import {
  codexBinaries,
  hostPlatformDir,
  readCodexManifest,
  resolveAppUnderTest,
  type AppUnderTest,
} from '../lib/bundle.ts'
import { newCodeword } from '../lib/codeword.ts'
import { catalogRows } from '../lib/mcp-fixture.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import {
  ELC_EXPECTED,
  ELC_FIXTURE,
  elicitLogSince,
  elicitProxyToolName,
  elicitationPaths,
  readElicitationTokens,
} from '../fixtures/elicitation.ts'
import {
  assertElectronApi,
  freshSession,
  listSessions,
  sessionCommand,
  transcript,
  waitFor,
  type TranscriptMessage,
} from '../lib/state.ts'
import { turnRowsSince } from '../lib/turn-evidence.ts'

const ID = 'CDX-150'
const TITLE = 'The Codex runtime on rust-v0.162.0: a turn completes and a real MCP tool is called under the Codex-shaped wire name'

/**
 * The upstream tag this case is written for, spelled out.
 *
 * Deliberately a literal rather than "whatever the manifest says": the case's
 * whole purpose is to answer "is the app on the tag we think it is on", and a
 * case that reads its expectation out of the file under test answers "is the app
 * on whatever it is on". When the pin moves again, this line is the thing that
 * has to move with it, and a run against a different tag reports BLOCKED rather
 * than a green result under a stale headline.
 */
const EXPECTED_CODEX_TAG = 'rust-v0.162.0'

/** The probe the model is told to call. Defaults to the elicitation fixture. */
const PROBE = {
  wire: process.env.NESSY_CDP_CODEX_MCP_WIRE ?? ELC_EXPECTED.wireName,
  tool: process.env.NESSY_CDP_CODEX_MCP_TOOL ?? ELC_FIXTURE.whoamiTool,
  /** Arguments as prose, e.g. `libraryName "react"`. Empty = no arguments. */
  args: process.env.NESSY_CDP_CODEX_MCP_ARGS ?? '',
  /**
   * The marker in the tool RESULT that the model could not have invented.
   * The fixture's per-call nonce by default; `/reactjs/react\.dev` for a
   * context7 run.
   */
  expect: new RegExp(process.env.NESSY_CDP_CODEX_MCP_EXPECT ?? 'nonce=[0-9a-f]{12}'),
  overridden: Boolean(process.env.NESSY_CDP_CODEX_MCP_WIRE || process.env.NESSY_CDP_CODEX_MCP_TOOL),
}

interface Connection {
  slug: string
  providerType: string
}

/**
 * A turn that ran, or a turn that threw — ONE shape, discriminated by `error`.
 *
 * `sendPrompt` rejects on timeout, so every call site needs both arms. Giving
 * them different shapes buys guards that are always true (both carry
 * `messages`) and therefore assert nothing; `error` is the only field that
 * distinguishes them. Same idiom as `mcp-w2.ts`, for the same reason.
 */
interface TurnAttempt {
  added: TranscriptMessage[]
  error?: string
}

const turnAttempt = (turn: { added: TranscriptMessage[] }): TurnAttempt => ({ added: turn.added })

const turnFailure = (cause: unknown): TurnAttempt => ({
  added: [],
  error: cause instanceof Error ? cause.message : String(cause),
})

/**
 * The binary identity gate. Runs before anything is driven, and BLOCKS rather
 * than fails: a wrong or missing binary is an environment shortfall, and the
 * case's headline claim ("on 0.154.0") would be a lie either way.
 */
function assertCodexBinary(run: CaseRun, app: AppUnderTest): void {
  const { path: manifestPath, manifest } = readCodexManifest()
  run.observe('codex-manifest', { path: manifestPath, tag: manifest.upstream?.tag })
  if (manifest.upstream?.tag !== EXPECTED_CODEX_TAG) {
    blocked(
      `codex-pin-moved: this case is written for ${EXPECTED_CODEX_TAG} but `
      + `packages/codex-protocol/manifest.json pins ${String(manifest.upstream?.tag)}. `
      + 'Re-measure against the new tag and update EXPECTED_CODEX_TAG in this file — a run under a stale '
      + 'headline is how a checklist column outlives the binary it describes.',
    )
  }

  const found = codexBinaries(app, manifest)
  run.observe('codex-binaries', found.map(entry => ({
    path: entry.path,
    platform: entry.platformDir,
    sha256: entry.sha256,
    pinned: entry.pinned,
    matchesPin: entry.matchesPin,
  })))
  const wanted = found.find(entry => entry.platformDir === hostPlatformDir())
  if (!wanted) {
    blocked(
      `no codex-app-server for ${hostPlatformDir()} under ${app.scanRoots.join(', ')} `
      + `(searched for **/bin/codex/<platform>/codex-app-server, the shape resolveCodexBinaryPath probes). `
      + 'Either this build set NESSY_FEATURE_CODEX_RUNTIME=0, or the app root could not be derived — '
      + 'set NESSY_CDP_APP_ROOT to the directory holding dist/main.cjs.',
    )
  }
  if (!wanted.matchesPin) {
    blocked(
      `codex-sha-mismatch: the shipped ${wanted.platformDir}/${wanted.basename} hashes ${wanted.sha256}, `
      + `the manifest pins ${String(wanted.pinned)}. The app REFUSES to spawn a binary that fails this check `
      + '(manifest-verifier.ts), so nothing below could be measured — and a re-signed nested binary is exactly '
      + 'the sev-1 signed 1.25.0 shipped. Fix the artifact, do not read past this.',
    )
  }
  run.check(
    `the shipped codex-app-server is the pinned ${EXPECTED_CODEX_TAG} binary`,
    wanted.matchesPin,
    `${wanted.platformDir} sha256=${wanted.sha256}`,
  )
  run.observe('codex-binary-measured', wanted.path)
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)

  // ---- 0. which build is answering ----------------------------------------
  const app = resolveAppUnderTest(session)
  run.observe('app-under-test', { kind: app.kind, appRoot: app.appRoot, via: app.via, url: app.targetUrl })
  if (app.kind === 'unknown') {
    blocked(
      `could not tell which build is on the other end of the socket (${app.via}; url=${app.targetUrl}). `
      + 'Set NESSY_CDP_APP_ROOT to the directory holding dist/main.cjs.',
    )
  }

  // ---- 1. the binary identity ---------------------------------------------
  assertCodexBinary(run, app)

  // ---- 2. the probe's fixture ---------------------------------------------
  if (!PROBE.overridden && !readElicitationTokens()) {
    blocked(
      `no fixture tree at ${elicitationPaths().root} — run \`bun run scripts/cdp/fixtures/elicitation.ts\`, `
      + 'then start the app with NESSY_CONFIG_DIR=<root>/config. Alternatively point this case at an MCP server '
      + 'you already have with NESSY_CDP_CODEX_MCP_WIRE / _TOOL / _ARGS / _EXPECT (the 2026-08-12 run used '
      + 'context7 resolve-library-id, expecting /reactjs/react\\.dev).',
    )
  }
  run.observe('probe', { wire: PROBE.wire, tool: PROBE.tool, args: PROBE.args || '(none)', expect: String(PROBE.expect) })

  // ---- 3. a Codex session --------------------------------------------------
  const connections = await session.call<Connection[]>(`
    return (await window.electronAPI.listLlmConnectionsWithStatus() ?? []).map(c => ({ slug: c.slug, providerType: c.providerType }))
  `)
  run.observe('connections', connections)
  const codex = connections.find(c => c.providerType === 'codex-runtime')
  if (!codex) {
    blocked(
      'no connection with providerType codex-runtime on this host. Create the Codex card through the app\'s own '
      + 'one-click gateway sign-in first; the harness never writes ~/.nessy/dp_auth_creds.json.',
    )
  }

  const key = await freshSession(session, `CDP ${ID} ${new Date().toISOString().slice(11, 19)}`)
  run.observe('session', { workspaceId: key.workspaceId, sessionId: key.sessionId })
  run.observe('session-origin', key.fresh ? 'created by this run' : `CONTAMINATED: ${key.reason}`)
  run.require('the case ran in a session it created', key.fresh, key.fresh ? undefined : `inherited ${key.inheritedMessages} messages`)

  await sessionCommand(session, key.sessionId, { type: 'setConnection', connectionSlug: codex.slug })
  // Wait for the switch to be IN EFFECT rather than merely requested (AGT-10's
  // detector 3): a prompt sent before the change lands measures the old runtime,
  // which here would measure Pi and call it Codex.
  const active = await waitFor(
    () => session.call<string | undefined>(`
      const s = (await window.electronAPI.getSessions() ?? []).find(x => x.id === ${JSON.stringify(key.sessionId)})
      return s ? (s.llmConnection ?? undefined) : undefined
    `),
    value => value === codex.slug,
    { timeoutMs: 30_000, intervalMs: 1_000, label: `the session to switch to ${codex.slug}` },
  ).catch(() => undefined)
  run.require(`the session runs on ${codex.slug}`, active === codex.slug, `llmConnection=${String(active)}`)

  await sessionCommand(session, key.sessionId, { type: 'setPermissionMode', mode: 'bypassPermissions' }).catch(() => undefined)
  const mode = await waitFor(
    async () => (await listSessions(session)).find(s => s.id === key.sessionId)?.permissionMode,
    value => value === 'bypassPermissions',
    { timeoutMs: 20_000, intervalMs: 1_000, label: 'bypassPermissions to take effect' },
  ).catch(() => undefined)
  run.observe('permission-mode', mode ?? '(not applied)')

  // ---- 4. a turn completes -------------------------------------------------
  // `newCodeword()` for the value, not `plantPrompt()`: that helper is the fork
  // ISOLATION control and its wording exists to keep a secret out of the memory
  // layer. Nothing here is a secret — the token's only job is to be a string
  // this run minted, so that a reply carrying it is evidence of a round trip
  // rather than of a plausible-looking model.
  const codeword = newCodeword()
  const baseline = await sendPrompt(
    session,
    key,
    `Reply with exactly this and nothing else: ${codeword}`,
    240_000,
  ).then(turnAttempt).catch(turnFailure)
  if (baseline.error) run.observe('baseline-turn-error', baseline.error)
  const baselineText = lastAssistantText(baseline.added)
  run.observe('baseline-reply', baselineText.slice(0, 200) || '(no assistant message)')
  run.check(
    'a Codex turn completes and carries this run\'s codeword back',
    baselineText.includes(codeword),
    baselineText.includes(codeword) ? `codeword=${codeword}` : `reply did not carry ${codeword}`,
  )

  // ---- 4b. the SOURCE, not the fixture tree (C5.23, R4 2026-09-12) ---------
  // Step 2 reads `tokens.json` on DISK, which says a fixture tree was built —
  // not that THIS profile loaded it. A rig-day lane runs a config dir created
  // for the run, so the tree can be present while the app carries no
  // `elicit-probe` source at all; the case then drove the turn below, the model
  // answered that no such tool exists, and FOUR checks failed for a missing
  // precondition. That is the one thing BLOCKED is for. Read the app's OWN
  // catalog, and read it AFTER the turn half above so its verdict is kept:
  // `runCase` scores a BlockedError as BLOCKED only while no check has failed,
  // and the turn half is the half a fresh profile can answer.
  if (!PROBE.overridden) {
    const sources = await catalogRows(session, key.workspaceId)
      .catch(error => { run.observe('catalog-read-failed', String(error)); return [] })
    const probeSource = sources.find(row => row.kind === 'mcp' && row.logicalName === ELC_FIXTURE.serverName)
    run.observe('probe-source', probeSource
      ? { key: probeSource.key, state: probeSource.state, unavailableReason: probeSource.unavailableReason }
      : `absent — this profile lists no mcp source named ${ELC_FIXTURE.serverName}`)
    if (!probeSource || probeSource.state !== 'active') {
      blocked(
        `no ACTIVE \`${ELC_FIXTURE.serverName}\` mcp source in this profile `
        + `(${probeSource ? `state=${probeSource.state}${probeSource.unavailableReason ? ` (${probeSource.unavailableReason})` : ''}` : 'not listed'}). `
        + 'The fixture tree on disk is not the same thing as a source this app loaded: run '
        + '`NESSY_CDP_ELC_ROOT=<root> bun run scripts/cdp/fixtures/elicitation.ts` so `<root>/config/mcp.json` '
        + 'carries it, then RELAUNCH the app against that same config dir. Everything above this line was '
        + 'measured; the MCP half below needs the source and is not scored.',
      )
    }
  }

  // ---- 5. the MCP call, under the Codex-shaped name ------------------------
  const expectedTool = PROBE.overridden
    ? `mcp__sources__${PROBE.wire}__${PROBE.tool}`
    : elicitProxyToolName(PROBE.tool, 'codex')
  // The Pi/Claude shape, kept so the failure detail can say WHICH name showed up.
  const poolShapedTool = `mcp__${PROBE.wire}__${PROBE.tool}`
  run.observe('expected-tool-name', expectedTool)

  const since = Date.now()
  const approver = approvePermissionsWhile(session, key.sessionId)
  const rowsBefore = (await transcript(session, key)).length // F1.521: the fallback's baseline, read before the send
  const turn = await sendPrompt(
    session,
    key,
    `Call the tool ${expectedTool}${PROBE.args ? ` with ${PROBE.args}` : ' with no arguments'}, `
    + 'then reply with exactly what it returned and nothing else. '
    + 'Do not read any file and do not guess: if the tool call fails, reply TOOL-FAILED plus the error.',
    240_000,
  ).then(turnAttempt).catch(turnFailure)
  run.observe('permissions-approved-mid-turn', await approver.stop())
  if (turn.error) run.observe('mcp-turn-error', turn.error)

  // THIS turn's messages, not the session's. A turn that threw carries none, so
  // fall back to the rows since the send and SAY SO (F1.521 — the whole
  // transcript let the baseline turn satisfy a check about this one).
  const scanned = await turnRowsSince(() => transcript(session, key), turn.added, rowsBefore)
  if (turn.added.length === 0) run.observe('scan-scope', 'the rows since the send (it threw, so it handed back none)')

  const mcpRows = scanned.filter(m => typeof m.toolName === 'string' && m.toolName.startsWith('mcp__'))
  run.observe('mcp-tool-rows', mcpRows.map(m => ({ tool: m.toolName, status: m.toolStatus })))
  const minted = mcpRows.filter(m => m.toolName === expectedTool)
  run.check(
    `the transcript row carries the Codex wire name ${expectedTool}`,
    minted.length > 0,
    minted.length > 0
      ? undefined
      : mcpRows.some(m => m.toolName === poolShapedTool)
        ? `the row carries the Pi/Claude shape ${poolShapedTool} instead — the bridge segment was dropped, so the row `
          + 'shows a name this runtime\'s model never used (event-adapter.ts mcpRowToolName)'
        : `no row matched; names seen: ${JSON.stringify(mcpRows.map(m => m.toolName))}`,
  )

  const result = minted.find(m => m.toolResult)?.toolResult ?? ''
  const answer = lastAssistantText(scanned)
  run.observe('tool-result', result.slice(0, 300) || '(no tool result)')
  run.observe('reply', answer.slice(0, 300) || '(no assistant message)')
  const marker = PROBE.expect.exec(result)?.[0]
  run.check(
    'the tool RESULT carries the unfakeable marker — a server really answered',
    Boolean(marker),
    marker ? `marker=${marker}` : `no tool result matched ${String(PROBE.expect)}; nothing proves a server answered`,
  )
  run.check(
    'the model\'s reply carries what the tool returned',
    Boolean(marker) && answer.includes(marker!),
    marker && answer.includes(marker) ? undefined : `reply did not carry the marker: ${answer.slice(0, 200)}`,
  )

  // Ground truth from the server itself, watermarked to this turn. Available
  // only for the fixture probe — a context7 run has no such log, and an absence
  // there would mean nothing.
  if (!PROBE.overridden) {
    const serverSaw = elicitLogSince(since).filter(entry => entry.method === 'tools/call')
    run.observe('fixture-server-log-calls', serverSaw.map(entry => ({ tool: entry.tool, nonce: entry.nonce })))
    run.check(
      'the fixture server\'s OWN log records the call',
      serverSaw.some(entry => entry.tool === PROBE.tool),
      serverSaw.length > 0
        ? `log holds ${JSON.stringify(serverSaw.map(e => e.tool))}`
        : 'the server logged no tools/call in this window — the call never reached a server process',
    )
  }

  // ---- 6. what this run could not answer -----------------------------------
  if (app.kind !== 'packaged') {
    blocked(
      `every check above ran against a DEV build (${app.via}). A dev tree is not the shipped artifact: it cannot `
      + 'show a signing-time rewrite of the nested binary, which is the only way the shipped codex-app-server and '
      + 'the manifest pin can disagree (the signed-1.25.0 sev-1). Re-run against a packaged build before recording '
      + 'the Codex column.',
    )
  }
}

if (import.meta.main) {
  await main(ID, TITLE, drive)
}

export const meta = { id: ID, title: TITLE }
