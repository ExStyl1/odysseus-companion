/**
 * C3.313 — the runtime-switch rebuild asks the RUNTIME whether it can read what
 * the host just wrote, and only an unreadable answer costs the native carry.
 *
 * `confirmClaudeTranscriptThroughSdk`
 * (`packages/shared/src/agent/claude-session-persistence.ts`) shipped with no
 * consumer in W18-c's commit: the call site is in `SessionManager.ts`, which
 * that lane did not hold. This is that consumer.
 *
 * ## What is asserted here, and what is asserted elsewhere
 *
 * The function's own verdicts are pinned by
 * `packages/shared/src/agent/__tests__/claude-transcript-sdk-confirmation.test.ts`.
 * What only this side can see is WHERE the call sits and WHICH verdict vetoes —
 * both of which are properties of an ordering and a branch rather than of a
 * value:
 *
 *  - between `writeClaudeTranscript` and `writeRuntimeAnchor`, so a veto leaves
 *    no anchor pointing at a file the runtime cannot read;
 *  - `unreadable` alone returns `false`. `partial` and `no-verdict` are
 *    reported, never vetoes — a verifier that vetoed on "I could not tell" would
 *    take the native carry away from every session whose SDK import failed.
 *
 * ## The live positive control, measured 2026-09-12 rather than asserted
 *
 * `bun test ./packages/server-core/src/sessions/__tests__/runtime-switch-session.test.ts`
 * → 112 pass / 0 fail, 373 expect(), 1 file, 92.26 s. That suite drives the real
 * `rebuildClaudeTranscriptForSwitch` 22 times against a real per-Workspace
 * config dir, and its log carries 22 `[claude-rebuild]` lines and ZERO
 * `[claude-transcript-confirm]` lines. `agreed` is the ONE verdict that logs
 * nothing, and the early no-verdict arm is unreachable there (`configDir` and
 * `sdkSessionId` are both set — the rebuild's own log line prints the path — and
 * `expectedUuids` is non-empty). So the runtime's own reader really opened each
 * rebuilt transcript and returned exactly the uuids written, in order. The
 * consumer is live and it agrees; nothing was vetoed.
 */
import { describe, expect, test } from 'bun:test'

const SESSION_MANAGER = new URL('../SessionManager.ts', import.meta.url).pathname

/**
 * The whole method, bounded by its own closing `catch` rather than by a
 * character count — the first draft of this file used 6000 characters and cut
 * off eight lines before the branch it was asserting, which reads exactly like
 * the branch being absent.
 */
async function rebuildBody(): Promise<string> {
  const src = await Bun.file(SESSION_MANAGER).text()
  const start = src.indexOf('  private async rebuildClaudeTranscriptForSwitch(')
  expect(start).toBeGreaterThan(0)
  const end = src.indexOf('the text handoff stays armed', start)
  expect(end).toBeGreaterThan(start)
  return src.slice(start, end)
}

describe('C3.313 — the confirmation is between the write and the anchor', () => {
  test('written, confirmed, THEN anchored', async () => {
    const body = await rebuildBody()
    const write = body.indexOf('const written = writeClaudeTranscript(filePath, records)')
    const confirm = body.indexOf('const confirmation = await confirmClaudeTranscriptThroughSdk({')
    const anchor = body.indexOf("managed.sdkSessionAnchors = writeRuntimeAnchor(managed.sdkSessionAnchors, 'anthropic', sdkSessionId)")
    // All three present — each is the other two's positive control, and the
    // ORDER is the whole property: an anchor written before the confirmation
    // would point at a file the runtime may not be able to read.
    expect(write).toBeGreaterThan(-1)
    expect(confirm).toBeGreaterThan(write)
    expect(anchor).toBeGreaterThan(confirm)
    // It asks about the records that were actually written, in the order they
    // were written — the function compares them positionally.
    expect(body).toContain('expectedUuids: records.map(record => record.uuid)')
  })

  test('only `unreadable` vetoes; `partial` and `no-verdict` are reported', async () => {
    const body = await rebuildBody()
    expect(body).toContain("if (confirmation.verdict === 'unreadable') {")
    // NEGATIVE: no other verdict appears in a condition here. A verifier that
    // vetoed on "I could not tell" would take the native carry away from every
    // session whose SDK import failed, which is the opposite of what this
    // confirmation is for.
    expect(body).not.toContain("confirmation.verdict === 'partial'")
    expect(body).not.toContain("confirmation.verdict === 'no-verdict'")
    // The veto falls back to the text handoff rather than throwing: the switch
    // is past its point of no return by then, and the text tier is a complete
    // answer.
    const veto = body.indexOf("if (confirmation.verdict === 'unreadable') {")
    const after = body.slice(veto, veto + 500)
    expect(after).toContain('falling back to the text handoff')
    expect(after).toContain('return false')
  })
})
