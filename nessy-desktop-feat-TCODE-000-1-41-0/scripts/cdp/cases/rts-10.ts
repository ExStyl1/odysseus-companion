/**
 * RTS-10 — an "always allow" granted on one runtime does not carry to another.
 *
 * A user who grants an MCP tool "always allow" is answering a question about a
 * specific agent on a specific runtime. `clearRuntimeScopedSessionState` drops
 * pending interactions and the runtime-scoped permission state on a switch, so
 * the same tool called on the new runtime must ask again. Without that clear it
 * runs silently on a runtime the user never authorised — the grant is honoured
 * by a party it was never given to.
 *
 * ## The shape of the evidence
 *
 * The claim is that a card APPEARS. `piRuntime().pendingPermissions` is the
 * backend's own list of what it still considers unanswered, which is the read
 * that separates "a card is up" from "an answered card the renderer left on
 * screen". A DOM count cannot tell those apart.
 *
 * The control is the grant itself: the tool must run WITHOUT a card on the
 * granting runtime after the grant, or "it asked on the other runtime" says
 * nothing — a build that asks every time passes the naive version.
 *
 * ## The precondition, and where it already comes from
 *
 * This needs an MCP server whose tool can actually be called: no OAuth, no
 * credential, reachable from a packaged app. **The RTS fixture already writes
 * one.** `seedProbeServer()` bakes `echo-server.mjs` into `<root>/probe/echo.mjs`
 * and registers it in `<configDir>/mcp.json` as `rts-echo`, and
 * `PROBE_TOOL_NAME`'s own doc names it "the MCP server name RTS-10 drives, and
 * the tool it calls on it". So the block this row used to report — pointing the
 * operator at the MCP-W plugin route, a DIFFERENT server behind an install the
 * harness will not perform — was stale: only `NESSY_CDP_MCP_TOOL` lacked a
 * default, and it now defaults to `PROBE_TOOL_NAME`.
 *
 * Two caveats that survive, and are in the block text so an operator meets them
 * before spending a sitting:
 *
 * - **`seedProbeServer()` runs only when `config.json` already exists** (the
 *   fixture's `import.meta.main` guards it with `report.configExisted`). The
 *   sequence is fixture → boot once → quit → fixture again → launch.
 * - **Whether `rts-echo` surfaces as an ENABLED catalog row was never confirmed
 *   live.** What was measured on 2026-08-15 is the server reaching
 *   `state: active` with `listMcpTools` returning `whoami`; the catalog's own
 *   naming of it is an open question. The case records the answer either way and
 *   refuses rather than calling a tool the server does not advertise.
 *
 * ## Status 2026-08-15: the precondition is MET and the row is not yet green
 *
 * `scripts/cdp/fixtures/runtime-switch.ts` now writes a baked copy of
 * `echo-server.mjs` and registers it in `<configDir>/mcp.json`, the GLOBAL
 * native scope — so no project and no project-trust grant is involved. Measured
 * live: the server reaches `state: active` and `listMcpTools` returns
 * `whoami`, so the tool is genuinely callable.
 *
 * Three things this row has already established, each of which was a guess
 * before:
 *
 * 1. **The mode must gate the call.** A fresh session lands in `explore`, where
 *    the read-only `whoami` RUNS UNASKED; in `default` it ASKS. Without setting
 *    the mode the row would score a grant that never happened — the same shape
 *    as RTS-5's `echo`.
 * 2. **The grant goes through `respondToPermission(sessionId, requestId,
 *    allowed, alwaysAllow)`** — the channel the renderer's own card uses. An
 *    earlier version invented a `controlPiHarnessRuntime` action that does not
 *    exist and swallowed the failure into `false`, i.e. a harness fault wearing
 *    the shape of a product finding.
 * 3. **The card owns the screen.** After answering, the second prompt still
 *    fails at its first keystroke with `composer-not-focusable`, and draining
 *    `pendingPermissions` is not sufficient to clear it. That is where this row
 *    stops today: the remaining work is finding what the renderer is still
 *    showing, not anything about the claim.
 *
 * PARKED here deliberately rather than pursued: a fixture is worth having and
 * is not worth being the reason a twelve-row lane starts late.
 */

import type { CdpSession } from '../lib/connect.ts'
import { main, blocked, type CaseRun } from '../lib/report.ts'
import { assertElectronApi, freshSession, listSessions, piRuntime, requireReadablePiRuntime, setPermissionMode, transcript, waitFor } from '../lib/state.ts'
import { clearComposer, submitComposer, typeIntoComposer } from '../lib/composer.ts'
import { ensureDarkTheme, catalogRows, mcpTools } from '../lib/mcp-fixture.ts'
import { requireRuntimeTrio, switchRuntime, waitForConnection } from '../lib/runtime-switch.ts'
import { PROBE_SERVER_NAME, PROBE_TOOL_NAME } from '../fixtures/runtime-switch.ts'

const ID = 'RTS-10'
const TITLE = 'An MCP “always allow” granted on Pi does not silently carry to another runtime'

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)
  run.observe('theme', await ensureDarkTheme(session))
  const trio = await requireRuntimeTrio(session)

  const key = await freshSession(session, `${ID} always-allow across a switch`)
  run.require('the case got a clean session', key.fresh, key.reason ?? '')

  const rows = await catalogRows(session, key.workspaceId).catch(() => [])
  const mcp = rows.filter(r => /mcp/i.test(r.kind) && (r.state === 'enabled' || r.state === 'active'))
  run.observe('usable MCP capabilities', mcp.map(r => `${r.logicalName}(${r.state})`))

  // The RTS fixture's OWN probe is the default, because the RTS fixture already
  // writes it: `seedProbeServer()` bakes `echo-server.mjs` into
  // `<root>/probe/echo.mjs` and registers it in `<configDir>/mcp.json` as
  // `rts-echo`, and `PROBE_TOOL_NAME`'s own doc calls itself "the MCP server
  // name RTS-10 drives, and the tool it calls on it". Only this variable had no
  // default, which is the whole reason the row sat blocked behind an
  // instruction to install a DIFFERENT plugin.
  const pinnedTool = process.env.NESSY_CDP_MCP_TOOL?.trim()
  const toolName = pinnedTool || PROBE_TOOL_NAME
  const probeRow = mcp.find(r => r.logicalName === PROBE_SERVER_NAME || r.logicalName.endsWith(`/${PROBE_SERVER_NAME}`))
  run.observe('tool under test', { toolName, pinned: Boolean(pinnedTool), probeRow: probeRow?.logicalName ?? null })

  if (mcp.length === 0 || (!pinnedTool && !probeRow)) {
    blocked(
      `this row needs a callable MCP tool with no OAuth and no credential, and it defaults to the RTS fixture's own `
      + `\`${PROBE_SERVER_NAME}\`/\`${PROBE_TOOL_NAME}\`. Seed it with \`bun run scripts/cdp/fixtures/runtime-switch.ts\` `
      + 'and relaunch the app with NESSY_CONFIG_DIR pointed at the fixture config dir. '
      + '**`seedProbeServer()` runs only when `config.json` already exists**, so the sequence is: run the fixture, '
      + 'boot the app once against the fixture config dir, quit, run the fixture AGAIN, then launch and run this case. '
      + 'To drive some other server instead, set NESSY_CDP_MCP_TOOL to its tool\'s wire name — that bypasses this '
      + `check entirely. Usable MCP capabilities here: ${mcp.map(r => `${r.logicalName}(${r.state})`).join(', ') || 'none'}`,
    )
  }

  // OPEN QUESTION carried here on purpose, for the first sitting to answer:
  // whether `rts-echo` surfaces as an ENABLED catalog row at all was never
  // confirmed live — the fixture's own note records the server reaching
  // `state: active` and `listMcpTools` returning `whoami`, but not what the
  // CATALOG calls it. `probeRow` above is that answer, recorded either way; if
  // it is null while a pinned tool carried the run, say so in the narrative.
  if (probeRow) {
    const tools = await mcpTools(session, key.workspaceId, probeRow.key).catch(() => ({ status: 'read-failed' as const }))
    const names = 'tools' in tools && Array.isArray(tools.tools) ? tools.tools.map(t => t.name) : []
    run.observe('tools the probe server actually advertises', { status: tools.status, names })
    if (!pinnedTool && names.length > 0 && !names.includes(toolName)) {
      // Calling a tool the server does not have would fail as a product finding
      // about permission scoping, which is not what happened.
      blocked(
        `${PROBE_SERVER_NAME} is in the catalog but advertises ${JSON.stringify(names)}, which does not include `
        + `\`${toolName}\`. Re-seed the fixture (\`bun run scripts/cdp/fixtures/runtime-switch.ts\`) so the baked probe `
        + 'matches, or pin NESSY_CDP_MCP_TOOL to one of the names above.',
      )
    }
  }

  const callPrompt = `Call the ${toolName} tool once. Reply with exactly: MCP-CALLED`

  async function callAndWatch(label: string): Promise<{ pending: number; ran: boolean }> {
    const before = (await transcript(session, key)).length
    await clearComposer(session)
    await typeIntoComposer(session, callPrompt)
    await submitComposer(session)
    // D1.287 — the poll carries the RUNTIME, not the count, for two reasons.
    // (1) `readFailed` has to reach the predicate: an unreadable snapshot
    // reports zero pending requests forever, so without it the wait burns its
    // whole 180 s and then answers `{ pending: 0 }` — the exact value the
    // subject check below reads as the product failing to ask. (2) The block
    // must be raised OUTSIDE the wait: this call's own `.catch()` swallows
    // everything the probe throws, `BlockedError` included, so a guard placed
    // inside the probe would be caught and turned back into `{ pending: 0 }`.
    const settled = await waitFor(
      async () => {
        const runtime = await piRuntime(session, key)
        const ran = (await transcript(session, key)).slice(before).some(m => (m.toolName ?? '').includes(toolName!))
        return { runtime, ran }
      },
      value => value.runtime.pendingPermissions.length > 0 || value.ran || value.runtime.readFailed === true,
      { timeoutMs: 180_000, intervalMs: 2_000, label: `${label}: a card, or the call going through` },
    ).catch(() => undefined)
    if (settled) {
      requireReadablePiRuntime(
        settled.runtime,
        `${label}: whether the tool call raised a permission card`,
        'pending-permissions',
      )
    }
    // A wait that genuinely timed out is this case's own "neither happened",
    // and it stays a `{ pending: 0, ran: false }` the checks below score.
    const value = { pending: settled?.runtime.pendingPermissions.length ?? 0, ran: settled?.ran ?? false }
    run.observe(`${label}`, value)
    return value
  }

  // --- grant on Pi ---------------------------------------------------------
  await switchRuntime(session, key.sessionId, trio.pi)
  run.require(
    'the session starts on Pi',
    (await waitForConnection(session, key.sessionId, trio.pi)) === trio.pi,
    trio.pi,
  )

  // The mode has to be one that GATES the call, or there is nothing to grant.
  // Measured on this build with the fixture's read-only `whoami`:
  // `default` → ASKED, `explore` → RAN UNASKED. A fresh session lands in
  // `explore`, so without this the row scores a grant that never happened —
  // the same shape as RTS-5's `echo`, where the probe could not distinguish
  // the two worlds it was comparing.
  await setPermissionMode(session, key.sessionId, 'default')
  await waitFor(
    async () => (await listSessions(session)).find(x => x.id === key.sessionId)?.permissionMode,
    value => value === 'default',
    { timeoutMs: 20_000, intervalMs: 500, label: 'the session to record default' },
  ).catch(() => undefined)

  const first = await callAndWatch('first call on Pi')
  run.require(
    'the first call raises a card — otherwise there is nothing to grant',
    first.pending > 0,
    JSON.stringify(first),
  )
  // Answer it with "always allow" through the app's own control channel.
  // Answered through `respondToPermission`, the channel the renderer's own
  // card uses (`App.tsx` `handleRespondToPermission` →
  // `sessions.RESPOND_TO_PERMISSION`). Signature:
  // `(sessionId, requestId, allowed, alwaysAllow, options?)`. The earlier
  // version invented a `controlPiHarnessRuntime` action that does not exist,
  // and its `.catch(() => false)` turned that into a quiet `false` — a harness
  // fault wearing the shape of a product finding.
  const granted = await session.call<boolean>(`
    const rt = await window.electronAPI.getPiHarnessRuntime({
      workspaceId: ${JSON.stringify(key.workspaceId)}, sessionId: ${JSON.stringify(key.sessionId)},
    })
    const pending = ((rt.snapshot || {}).security || {}).pendingPermissions || []
    if (pending.length === 0) return false
    await window.electronAPI.respondToPermission(
      ${JSON.stringify(key.sessionId)}, pending[0].requestId, true, true,
    )
    return true
  `)
  run.require('the card was answered with "always allow"', granted, String(granted))

  // --- the control: it must NOT ask again on the SAME runtime -------------
  // Wait for the BACKEND to consider the request answered before typing again.
  // The card owns the screen while it is up, so a second prompt sent too early
  // fails at the first keystroke with `composer-not-focusable` — a message that
  // says nothing about a dialog, and the same trap the project-trust modal set
  // earlier in this wave.
  // D1.287 — an unreadable snapshot reports an empty list, which is precisely
  // "the card drained" here, so the raw count would let the case type into a
  // screen the card still owns and fail at `composer-not-focusable`. Waiting on
  // the RUNTIME makes a failed read time out instead (tolerated, as before) and
  // the next `callAndWatch` then blocks with the read's own reason.
  await waitFor(
    async () => piRuntime(session, key),
    runtime => runtime.readFailed !== true && runtime.pendingPermissions.length === 0,
    { timeoutMs: 60_000, intervalMs: 1_000, label: 'the answered card to drain' },
  ).catch(() => undefined)

  const second = await callAndWatch('second call on Pi, after the grant')
  run.check(
    'the grant works on the runtime it was given to — no card the second time',
    second.pending === 0 && second.ran,
    JSON.stringify(second),
  )

  // --- the subject: the other runtime must ask ----------------------------
  const outcome = await switchRuntime(session, key.sessionId, trio.claude)
  run.require('the switch was accepted', outcome.ok, outcome.error ?? '')
  await waitForConnection(session, key.sessionId, trio.claude)

  const afterSwitch = await callAndWatch('call on Claude, after the switch')
  run.check(
    'the same tool asks again on the new runtime — the grant did not follow the session across',
    afterSwitch.pending > 0,
    afterSwitch.ran
      ? 'it ran with no card: an always-allow given on Pi is being honoured on a runtime the user never authorised'
      : JSON.stringify(afterSwitch),
  )
}

if (import.meta.main) {
  await main(ID, TITLE, drive)
}

export const meta = { id: ID, title: TITLE }
