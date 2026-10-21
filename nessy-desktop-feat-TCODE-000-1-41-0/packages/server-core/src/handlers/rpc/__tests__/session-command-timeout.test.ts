/**
 * D1.124 — the client's ceiling and the server's handler budget, for the one
 * channel that carries a runtime switch.
 *
 * The defect was not that either number was wrong on its own. It was that
 * `sessions:command` had no entry in `RPC_REQUEST_TIMEOUT_BY_CHANNEL`, and a
 * channel with no entry gets the server's `DEFAULT_HANDLER_TIMEOUT_MS` (60 s)
 * while the caller gives up at `REQUEST_TIMEOUT_MS` (30 s) — so a handler that
 * takes between the two COMPLETES and is reported to the user as a failure.
 * That is the measured shape of the five timeouts at the 1.36.0 sitting.
 *
 * These cases pin the PAIR rather than either number, because a future lane
 * raising or lowering one of them alone re-creates the same inversion. They
 * live here rather than beside `rpcHandlerTimeoutForChannel`'s own suite so the
 * transport file stays one lane's; the function is imported, never edited.
 */
import { describe, expect, it } from 'bun:test'
import { REQUEST_TIMEOUT_MS, RPC_CHANNELS, RPC_REQUEST_TIMEOUT_BY_CHANNEL } from '@nessy-agent/shared/protocol'

import {
  CLIENT_BROWSER_INVOKE,
  CLIENT_CONFIRM_DIALOG,
  CLIENT_OPEN_FILE_DIALOG,
  CLIENT_PROPOSE_MCPB,
  USER_PACED_CLIENT_CHANNELS,
  USER_PACED_CLIENT_INVOKE_TIMEOUT_MS,
} from '../../../transport/capabilities'
import { clientInvokeTimeoutForChannel, rpcHandlerTimeoutForChannel } from '../../../transport/server'
import { PUBLISH_ARTIFACT_CARD_TIMEOUT_MS } from '../../../sessions/artifact-publishing'

describe('D1.124 · sessions:command is not allowed to outlive its caller', () => {
  it('lets the caller wait longer than the handler may run', () => {
    const clientCeiling = RPC_REQUEST_TIMEOUT_BY_CHANNEL[RPC_CHANNELS.sessions.COMMAND]
    expect(clientCeiling).toBeDefined()
    expect(rpcHandlerTimeoutForChannel(RPC_CHANNELS.sessions.COMMAND))
      .toBeLessThan(clientCeiling as number)
    // The server's own budget is UNCHANGED — the entry restores the pair, it
    // does not buy the handler more time.
    expect(rpcHandlerTimeoutForChannel(RPC_CHANNELS.sessions.COMMAND)).toBe(60_000)
  })

  /**
   * The NEGATIVE, and it is what makes the case above mean something: an
   * ordinary channel still shows the inversion, so the assertion is reading a
   * property of the ENTRY rather than a property every channel happens to have.
   *
   * It read as the standing description of the residue until D1.224 censused
   * that residue, and the census changed what this case means: the inversion is
   * DELIBERATE for an ordinary channel, because the server's timeout is a
   * `Promise.race` that does not cancel the handler — a slow operation is
   * misreported, never lost — while a default low enough to satisfy the pair
   * would newly fail everything in the 25-30 s band that succeeds today. See
   * `RPC_REQUEST_TIMEOUT_BY_CHANNEL`'s header for the three candidates that
   * turned out to be bounded and for the six that were not.
   */
  it('shows the inversion this row is about on a channel with no entry', () => {
    expect(RPC_REQUEST_TIMEOUT_BY_CHANNEL['test:ordinary']).toBeUndefined()
    expect(rpcHandlerTimeoutForChannel('test:ordinary')).toBeGreaterThan(REQUEST_TIMEOUT_MS)
  })
})

/**
 * D1.224 — the six channels whose duration is a PERSON's.
 *
 * The census that produced them is in `RPC_REQUEST_TIMEOUT_BY_CHANNEL`'s header.
 * Each of these handlers does nothing but `await` a native dialog on the client,
 * so its duration is however long somebody takes to read and click — and all
 * THREE timeouts on that path had to agree before the answer could arrive: the
 * caller's ceiling (this table), the handler budget derived from it, and
 * `invokeClient`'s own, which named one channel and not its siblings.
 */
const USER_PACED_RPC_CHANNELS = [
  RPC_CHANNELS.file.OPEN_DIALOG,
  RPC_CHANNELS.dialog.OPEN_FOLDER,
  RPC_CHANNELS.projects.PICK_LOCAL_DIRECTORY,
  RPC_CHANNELS.gitbash.BROWSE,
  RPC_CHANNELS.auth.SHOW_LOGOUT_CONFIRMATION,
  RPC_CHANNELS.auth.SHOW_DELETE_SESSION_CONFIRMATION,
]

describe('D1.224 · a dialog the user is still reading is not a failure', () => {
  it.each(USER_PACED_RPC_CHANNELS)('%s outlives the 30 s ceiling, with the pair in the right order', (channel: string) => {
    const clientCeiling = RPC_REQUEST_TIMEOUT_BY_CHANNEL[channel]
    expect(clientCeiling).toBeDefined()
    // The number is DERIVED: it is what `marketplace:proposeMcpb` — the one
    // user-paced channel somebody had already measured — carries today.
    expect(clientCeiling).toBe(RPC_REQUEST_TIMEOUT_BY_CHANNEL[RPC_CHANNELS.marketplace.PROPOSE_MCPB])
    expect(clientCeiling as number).toBeGreaterThan(REQUEST_TIMEOUT_MS)
    expect(rpcHandlerTimeoutForChannel(channel)).toBeLessThan(clientCeiling as number)
  })

  it('gives the client invoke behind those channels a person-sized budget', () => {
    for (const capability of [CLIENT_OPEN_FILE_DIALOG, CLIENT_CONFIRM_DIALOG, CLIENT_PROPOSE_MCPB]) {
      expect(USER_PACED_CLIENT_CHANNELS.has(capability)).toBe(true)
      expect(clientInvokeTimeoutForChannel(capability)).toBe(USER_PACED_CLIENT_INVOKE_TIMEOUT_MS)
    }
    // The budget is the one `CLIENT_PROPOSE_MCPB` already had — ten minutes —
    // and not a new number chosen for this row.
    expect(USER_PACED_CLIENT_INVOKE_TIMEOUT_MS).toBe(10 * 60 * 1000)
  })

  /**
   * The NEGATIVE: a capability the client answers from CODE keeps the ordinary
   * 30 s, so the set above discriminates rather than covering everything. A
   * browser-pane invoke is the sharpest control — it is on the same transport,
   * from the same helper file, and no human is in it.
   */
  it('leaves a code-answered client capability on the ordinary 30 s', () => {
    expect(USER_PACED_CLIENT_CHANNELS.has(CLIENT_BROWSER_INVOKE)).toBe(false)
    expect(clientInvokeTimeoutForChannel(CLIENT_BROWSER_INVOKE)).toBe(30_000)
    expect(clientInvokeTimeoutForChannel('client:somethingNobodyHasWrittenYet')).toBe(30_000)
  })
})

/**
 * UA1.23 follow-up — `artifacts:publishFile` (the Publish button on an inline preview) waits for a person, and
 * `runArtifactPublish` can raise a SECOND card: when the file changes under the first, the re-hash re-runs the
 * guard and asks again (`sessions/artifact-publishing.ts`, `for (let round = 0; round < 2; round++)`). Each card
 * waits up to `PUBLISH_ARTIFACT_CARD_TIMEOUT_MS`; then dp's token (`t-artifacts-client.ts` symbol
 * `PRINT_TOKEN_TIMEOUT_MS`, 30 s) and one request (same file, `REQUEST_TIMEOUT_MS`, 30 s). The server's
 * `Promise.race` does not cancel the handler, so a budget below that sum toasts "Could not publish" for a page the
 * host then publishes anyway.
 */
describe('UA1.23 · a two-card publish from a preview is not reported as a failure', () => {
  const DP_PRINT_TOKEN_MS = 30_000 // t-artifacts-client.ts PRINT_TOKEN_TIMEOUT_MS (module-private)
  const ARTIFACT_REQUEST_MS = 30_000 // t-artifacts-client.ts REQUEST_TIMEOUT_MS (module-private)

  it('gives the handler two cards, the token and one request', () => {
    expect(rpcHandlerTimeoutForChannel(RPC_CHANNELS.artifacts.PUBLISH_FILE))
      .toBeGreaterThanOrEqual(2 * PUBLISH_ARTIFACT_CARD_TIMEOUT_MS + DP_PRINT_TOKEN_MS + ARTIFACT_REQUEST_MS)
  })

  // The boundary arm, made discriminating (UA12.55): the first version asserted constants against each other
  // (one card + 5 s < two cards — always true at PUBLISH_ARTIFACT_CARD_TIMEOUT_MS = 110 s) plus the handler/ceiling
  // order (true at the pre-fix 240 s too), so reverting 81e6d93eb left it green while the case above went red. It
  // now reads the CONFIGURED ceiling: it must clear one card's worth AND reach the two-card floor — the pre-fix
  // 240 s cleared one card with 70 s to spare and still toasted a live page as a failure, so the revert
  // (300_000 -> 240_000) turns THIS arm red (240_000 < 280_000).
  it('would not be met by a budget sized for one card', () => {
    const oneCardWorth = PUBLISH_ARTIFACT_CARD_TIMEOUT_MS + DP_PRINT_TOKEN_MS + ARTIFACT_REQUEST_MS
    const twoCardFloor = 2 * PUBLISH_ARTIFACT_CARD_TIMEOUT_MS + DP_PRINT_TOKEN_MS + ARTIFACT_REQUEST_MS
    const clientCeiling = RPC_REQUEST_TIMEOUT_BY_CHANNEL[RPC_CHANNELS.artifacts.PUBLISH_FILE] as number
    expect(clientCeiling).toBeGreaterThan(oneCardWorth)
    expect(clientCeiling).toBeGreaterThanOrEqual(twoCardFloor)
    expect(rpcHandlerTimeoutForChannel(RPC_CHANNELS.artifacts.PUBLISH_FILE)).toBeLessThan(clientCeiling)
  })
})
