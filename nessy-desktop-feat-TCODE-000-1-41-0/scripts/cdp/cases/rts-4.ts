/**
 * RTS-4 — Claude Pro/Max → Claude Code (Nessy Gateway), the same-runtime row.
 *
 * The plan calls this the highest-risk row, and it is: both sides are the
 * `anthropic` provider, so the switch is `connection-same-runtime` and history
 * is supposed to resume through the SDK anchor rather than through a text
 * handoff. A transcript recorded against `api.anthropic.com` may hold blocks the
 * gateway adapter cannot translate, and that failure has no other route to the
 * surface.
 *
 * **It cannot run on this machine, and the reason is not a harness limitation.**
 *
 * 1. **The Claude Pro/Max card is hidden.** Owner decision 2026-08-15: the
 *    subscription is switched off and hidden visually, **with the code
 *    retained** — not removed from the product. So this row is BLOCKED on a
 *    precondition that can be met again, not a case that can never apply. It
 *    was briefly deleted here on a stronger reading of that decision ("there
 *    will be no subscription"), which the owner did not make; a deleted case
 *    and a temporarily unavailable one are different states, and only the
 *    second one comes back when the card is unhidden. No connection with
 *    `providerType: 'anthropic'` and subscription auth exists while it is
 *    hidden, so the source side of the row is absent for now.
 * 2. **Creating one means a subscription sign-in**, which is a credential
 *    action the harness does not perform — not "cannot", does not. Entering
 *    account credentials is the operator's to do at their own keyboard.
 * 3. **The credential-store blocker this case used to name is repaired.** A
 *    store written under the fallback identity is now opened by
 *    `deriveFallbackIdentityKeyV2`
 *    (`packages/shared/src/credentials/backends/secure-storage.ts`), so a
 *    packaged run CAN read a subscription card's stored credential. The
 *    asymmetry that remains is the other direction — a store written under the
 *    hardware UUID on a launch where the UUID cannot be read — and it is not
 *    recoverable by trying harder. Measured 2026-09-17 (WI-e, A3.14). (The text
 *    replaced here cited the live checklist by a line range, which has since
 *    moved; it is named in words rather than re-spelled, because AGENTS.md
 *    records that a correction spelling a dead anchor re-creates the finding it
 *    repairs.)
 *
 * BLOCKED is the honest verdict: nothing failed and nothing was proven. This
 * file exists so the gap is a named row with its precondition written down,
 * rather than a case that quietly is not there — a missing row reads as "not
 * applicable", and this one is very much applicable.
 *
 * ## What to do when the precondition is met
 *
 * Sign in to Claude Pro/Max in the app, then set `NESSY_CDP_CLAUDE_SUB_SLUG` to
 * that connection's slug. The case will then drive it: a session with prior TOOL
 * USE on the subscription card (tool blocks are what the adapter has to
 * translate — a text-only transcript would pass without testing anything),
 * switched to `claude-gateway`, must classify `connection-same-runtime`, report
 * `contextCarried: 'runtime-anchor'`, and answer a question about the earlier
 * tool result.
 */

import type { CdpSession } from '../lib/connect.ts'
import { main, blocked, type CaseRun } from '../lib/report.ts'
import { assertElectronApi, freshSession } from '../lib/state.ts'
import { sendPrompt, lastAssistantText } from '../lib/chat.ts'
import { ensureDarkTheme } from '../lib/mcp-fixture.ts'
import {
  listConnections,
  requireRuntimeTrio,
  runtimeOf,
  switchRuntime,
  waitForConnection,
} from '../lib/runtime-switch.ts'

const ID = 'RTS-4'
const TITLE = 'Claude Pro/Max → Claude Code (Nessy Gateway): history resumes through the SDK anchor'

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)
  run.observe('theme', await ensureDarkTheme(session))
  const trio = await requireRuntimeTrio(session)

  const connections = await listConnections(session)
  const pinned = process.env.NESSY_CDP_CLAUDE_SUB_SLUG?.trim()
  const candidates = connections.filter(c =>
    runtimeOf(c.providerType) === 'anthropic'
    && c.slug !== trio.claude
    && (!pinned || c.slug === pinned))
  run.observe('anthropic-runtime connections other than the gateway card', candidates.map(c => `${c.slug}(${c.providerType})`))

  const source = pinned
    ? candidates.find(c => c.slug === pinned)
    : candidates.find(c => c.providerType === 'anthropic')

  if (!source) {
    blocked(
      'the Claude Pro/Max card is hidden by owner decision 2026-08-15 (switched off and hidden visually, code '
      + 'retained), so no subscription connection exists to switch FROM. This row becomes runnable when the card is '
      + 're-enabled and a subscription connection exists — it is deferred, not inapplicable. '
      + 'Creating one requires a subscription sign-in, which is a credential action the harness does not perform — '
      + 'it is the operator\'s to do at their own keyboard. '
      + `Once signed in, set NESSY_CDP_CLAUDE_SUB_SLUG to its slug. Seen here: ${
        connections.map(c => `${c.slug}(${c.providerType})`).join(', ')}`,
    )
  }

  // --- from here on the precondition is met -------------------------------
  const key = await freshSession(session, `${ID} subscription to gateway`)
  run.require('the case got a clean session', key.fresh, key.reason ?? '')
  await switchRuntime(session, key.sessionId, source.slug)
  run.require(
    `the session starts on ${source.slug}`,
    (await waitForConnection(session, key.sessionId, source.slug)) === source.slug,
    source.slug,
  )

  // Tool USE, not just text: translating tool blocks is the risk this row names.
  const toolTurn = await sendPrompt(
    session,
    key,
    'List the files in the current directory using your file-listing tool, then tell me how many there are.',
    600_000,
  )
  const toolNames = toolTurn.added.filter(m => m.role === 'tool').map(m => m.toolName ?? '?')
  run.observe('tools used on the subscription card', toolNames)
  run.require(
    'the subscription span really used a tool — a text-only transcript would not test the adapter',
    toolNames.length > 0,
    toolNames.join(', ') || 'none',
  )

  const outcome = await switchRuntime(session, key.sessionId, trio.claude)
  run.observe('switch subscription → gateway', outcome)
  run.require('the switch was accepted', outcome.ok, outcome.error ?? '')
  run.check(
    'the app classified it as SAME-runtime — both sides are the anthropic provider',
    outcome.result?.kind === 'connection-same-runtime',
    String(outcome.result?.kind),
  )
  run.check(
    'history resumes through the SDK anchor rather than a text handoff',
    outcome.result?.contextCarried === 'runtime-anchor',
    String(outcome.result?.contextCarried),
  )

  const recall = await sendPrompt(
    session,
    key,
    'From our conversation only: how many files did you list a moment ago?',
    600_000,
  )
  // F1.503 — THIS turn's rows: the listing turn's reply already carries a digit.
  const answer = lastAssistantText(recall.added)
  run.observe('answer after the switch', answer.slice(0, 300))
  run.check(
    'the gateway side can still see the tool result recorded against the subscription endpoint',
    /\d/.test(answer),
    answer.slice(0, 120),
  )
}

if (import.meta.main) {
  await main(ID, TITLE, drive)
}

export const meta = { id: ID, title: TITLE }
