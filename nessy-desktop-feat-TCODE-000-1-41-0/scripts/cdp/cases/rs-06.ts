/**
 * RS-06 (row P6.144) — flipping the MCP connect default to claude's non-blocking
 * one: does the sign-in prompt survive?
 *
 * Ledger J5/host. **Native mechanism, confirmed at HEAD:** claude's
 * `agent-sdk/mcp.md#connection-timing` table is already implemented as a table
 * rather than a switch — P3.247 moved the wait to the point of need, capped at
 * the documented 5000 — so nothing is left to build. Only the DEFAULT DIRECTION
 * is unflipped, behind `mcpConnectionNonBlockingFromEnv`
 * (`packages/shared/src/mcp/server-config-values.ts`), which reads
 * `NESSY_MCP_CONNECTION_NONBLOCKING` and accepts `1` or `true`.
 *
 * The deviation is stated at the site in capitals — claude's default is the
 * non-blocking one and ours is not — and the REASON is a measurement, not a
 * preference: the pool's connect verdict is read synchronously by
 * `authNeededSlugs` and `health().failed`, and P3.237 recorded twelve failing
 * tests saying what happens without it — *"a revoked credential's 401 arrives
 * after the pending-auth notice is computed, so the prompt that would fix it
 * silently never appears"*.
 *
 * So this case does not ask whether the flag works. It asks the one thing that
 * decides whether the default can move: **with the flag on, does a user with a
 * revoked credential still get told to sign in?**
 *
 * ## Why one run is one arm, and the matrix is the operator's
 *
 * `NESSY_MCP_CONNECTION_NONBLOCKING` is read by the SERVER at start. A case
 * cannot flip it: the app has to be relaunched, which is a sitting step and not
 * a driver step. So this case measures the arm it is in, records which arm that
 * was from the operator's own declaration, and blocks rather than guessing.
 * Four runs make the matrix — two flag states by two credential states — and the
 * two healthy runs are the control that a notice is not simply always on.
 *
 * ## The detector is the notice's own element, not a screenshot and not a toast
 *
 * `PendingAuthNotice.tsx` renders `[data-testid="pending-auth-notice"]` with one
 * row per source at `[data-testid="pending-auth-source-<slug>"]`, and the
 * sentences are `pendingAuth.sourceNeedsAuth` / `sourceCredentialExpired` /
 * `sourceCredentialMissing`. A case that read the pane's prose could not tell
 * the notice from a model talking about signing in.
 *
 * ## The latency half, and why it is an observation rather than a check
 *
 * The row's control asks for "identical first-turn latency" on the healthy arms.
 * On a live gateway a single first-turn timing is a reading of the day — this
 * plan has measured a 22x spread on the same bytes — so the number is RECORDED
 * with the arm and compared across the four runs by whoever reads them, rather
 * than asserted inside one run that cannot see the other three.
 *
 * ## No credential is named, read or written here
 *
 * The operator revokes and restores the credential in the source's own system.
 * This case names the SOURCE by slug and reads the presence of a notice.
 */

import { resolveAppUnderTest } from '../lib/bundle.ts'
import { sendPrompt } from '../lib/chat.ts'
import type { CdpSession } from '../lib/connect.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import { assertElectronApi, freshSession, selectorCount, selectorText } from '../lib/state.ts'
import type { CaseMeta, SittingRecipe } from '../lib/sitting.ts'
import { checkAbsence, positive, turnAnswered } from '../lib/turn-evidence.ts'

const ID = 'RS-06'
const TITLE = 'A revoked MCP credential still raises the sign-in prompt when the connect default is non-blocking'

export const meta = {
  id: ID,
  title: TITLE,
  row: 'P6.144',
  runtimes: ['pi', 'claude', 'codex'],
  credentials: 'owner: one MCP source whose credential the owner can revoke and restore in its own system. '
    + 'This case names the SOURCE by slug and never touches a token.',
} as const satisfies CaseMeta

const NOTICE = '[data-testid="pending-auth-notice"]'

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)

  const app = resolveAppUnderTest(session)
  run.observe('app under test', { kind: app.kind, via: app.via })
  run.check('the artefact under test is the PACKAGED app', app.kind === 'packaged',
    app.kind === 'packaged' ? undefined : `kind=${app.kind} — a dev build is not the shipped artefact`)

  const slug = process.env.NESSY_CDP_MCP_SOURCE_SLUG?.trim()
  const arm = process.env.NESSY_CDP_MCP_NONBLOCKING_ARM?.trim()
  const credential = process.env.NESSY_CDP_MCP_CREDENTIAL_STATE?.trim()
  if (!slug || (arm !== '0' && arm !== '1') || (credential !== 'revoked' && credential !== 'healthy')) {
    blocked(
      'this case measures ONE cell of a four-cell matrix and cannot create any of it. Set: '
      + 'NESSY_CDP_MCP_SOURCE_SLUG (the source under test), '
      + 'NESSY_CDP_MCP_NONBLOCKING_ARM=0|1 (how the APP was LAUNCHED — the server reads '
      + 'NESSY_MCP_CONNECTION_NONBLOCKING at start, so relaunching is the only way to change it), and '
      + 'NESSY_CDP_MCP_CREDENTIAL_STATE=revoked|healthy (what you did to the credential in the source\'s own '
      + 'system). See the manual block in this file for the four runs.',
    )
  }
  run.observe('arm', { source: slug, nonBlocking: arm === '1', credential })

  // A fresh session, because the notice is computed when a session's pool is
  // leased: reusing an open one would read a verdict taken before the credential
  // changed, which is the very race this row is about.
  const key = await freshSession(session, `CDP ${ID} ${new Date().toISOString().slice(11, 19)}`)
  run.check('the case ran in a session it created', key.fresh,
    key.fresh ? undefined : `inherited ${key.inheritedMessages} messages`)

  const started = Date.now()
  const firstTurn = await sendPrompt(session, key, 'Reply with the single word READY.', 300_000).catch(() => undefined)
  const firstTurnMs = Date.now() - started
  run.observe('first-turn latency (ms)', firstTurnMs)
  run.observe('first-turn latency is a reading of the day', 'compare it ACROSS the four runs, never inside one')

  // Give the notice the time its own computation takes rather than sampling once
  // — the README's standing rule, and the whole point of this row is a verdict
  // that arrives late.
  let noticeCount = 0
  for (let attempt = 0; attempt < 40 && noticeCount === 0; attempt += 1) {
    noticeCount = await selectorCount(session, NOTICE)
    if (noticeCount === 0) await Bun.sleep(500)
  }
  const rows = noticeCount > 0 ? await selectorText(session, `${NOTICE} li`) : []
  const sourceRow = await selectorCount(session, `[data-testid="pending-auth-source-${slug}"]`)
  run.observe('pending-auth notice', { present: noticeCount > 0, rows, sourceRowsForSlug: sourceRow })

  if (credential === 'healthy') {
    // F1.504 — the notice is computed when the session's pool is leased, which
    // the first turn does: "no row" after a turn that never answered is no control.
    checkAbsence(
      run,
      'THE CONTROL — a healthy credential raises no sign-in row for this source',
      sourceRow === 0,
      firstTurn ? turnAnswered(firstTurn.added) : positive(false, 'answer', 'the first turn did not settle'),
      'the notice named this source while its credential was healthy, so a notice in the revoked arm '
        + 'proves nothing — the rig is reporting a stale or unconditional verdict',
    )
    return
  }

  run.check(
    'a revoked credential raises the sign-in prompt for this source',
    sourceRow > 0,
    sourceRow > 0 ? undefined
      : arm === '1'
        ? 'THE FINDING: with the non-blocking connect default the 401 arrived after the pending-auth notice '
          + 'was computed, so the prompt that would fix it never appeared — P3.237\'s twelve failing tests, live. '
          + 'The default must NOT move, and the switch report owes a line naming the per-runtime first-turn difference.'
        : 'the BLOCKING arm did not raise the prompt either, which is a rig fault rather than a finding: '
          + 'confirm the credential is really revoked upstream and that this source is enabled for this workspace.',
  )
  run.observe(
    'VERDICT',
    sourceRow > 0
      ? (arm === '1'
        ? 'the prompt SURVIVES the non-blocking default — the default can move and the divergence closes'
        : 'the blocking arm behaves as documented; run the arm=1 cell to answer the row')
      : 'no prompt — see the detail on the check above',
  )
}

/** The four runs. Two flag states by two credential states, in one sitting. */
export const manual = {
  why: 'the connect default is read by the server at start, so the flag can only change across a relaunch',
  steps: [
    'Pick one MCP source you can revoke and restore, and note its slug.',
    'RUN 1 — launch the packaged app with NESSY_MCP_CONNECTION_NONBLOCKING unset, credential HEALTHY. '
      + 'Run this case with ARM=0 CREDENTIAL=healthy.',
    'RUN 2 — revoke the credential in the source\'s own system (invalidate the OAuth token server-side, or '
      + 'rewrite the bearer value). Relaunch the app, still unset. Run with ARM=0 CREDENTIAL=revoked.',
    'RUN 3 — restore the credential. Launch with NESSY_MCP_CONNECTION_NONBLOCKING=1. '
      + 'Run with ARM=1 CREDENTIAL=healthy.',
    'RUN 4 — revoke it again, relaunch with the flag still 1. Run with ARM=1 CREDENTIAL=revoked. '
      + 'THIS is the cell the row exists for.',
    'Restore the credential afterwards.',
  ],
  expected: 'runs 1 and 3 raise no row for this source; run 2 raises it; run 4 decides the row',
  detector: '[data-testid="pending-auth-source-<slug>"] inside [data-testid="pending-auth-notice"] — '
    + 'the notice\'s own element, never the chat pane\'s prose',
  positiveControl: 'run 2 — the blocking arm with the same revoked credential, which must raise the prompt, '
    + 'or run 4 measures a broken revocation rather than the flag',
  doneMeans: 'prompt survives run 4 -> the default moves and the divergence closes; it does not -> the opt-in '
    + 'stays and the switch report gains a line naming the per-runtime first-turn difference',
} as const satisfies SittingRecipe

if (import.meta.main) await main(ID, TITLE, drive)
