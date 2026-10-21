/**
 * RS-124 (UB3.13) — the Phase 3 delta live cases: three drives this lane can
 * land offline but not run (a packaged sitting owns every drive).
 *
 * ## The row
 *
 * UB3.13 names three live cases; this file is their recipe sheet, one arm per
 * drive. The id is lane-picked (next free after RS-123; the dispatch allocated
 * none), NOT in `run.ts`'s `SITTING` (the checklist is controller-owned — the
 * rs-121 rule), and the controller confirms it at the pin.
 *
 * ## Arm A — one sign-in for two sessions (UB3.10)
 *
 * Premise at the recipe's landing: UB3.10 is PARTIALLY landed — the
 * single-flight store graft and the `oauth:status` channel sit uncommitted in
 * the working tree (the `waiters` field makes the consumer commit atomic),
 * and the consumer half (SessionManager.completeAuthRequestsForSource, the
 * oauth:start join/restart starter, the client join/poll) is not landed at
 * all. THE ARM IS NOT DRIVABLE until UB3.10 lands whole; on any earlier
 * build it measures the defect (N sessions open N browsers) and must be
 * recorded as the BEFORE, never as the row.
 *
 * ## Arm B — `_intent` on a mid-turn source (UB3.9)
 *
 * Landed `c2db41317`: the gate keeps `_intent` for an ACTIVE source
 * (keepSourceToolIntent) and strips it otherwise, the proxy's `_intent` is
 * schema-optional, and the intent reaches the pool/summariser. The live arm
 * drives the #1086 shape end to end: a source activated MID-TURN, then the
 * same call dispatching.
 *
 * ## Arm C — an Azure endpoint edit applies live (UB3.12)
 *
 * Landed `6c283e6b5`. The row itself conditions this arm on a test Azure
 * tenant: WITHOUT one, the offline pin is the stated answer —
 * `provider-endpoint-env.test.ts` (3 pass / 0 fail, landed with 6c283e6b5)
 * pins the env contract, and the subprocess's own `[runtime_config]
 * Re-applied AZURE_OPENAI_BASE_URL=…` debug line is the wiring's record.
 */

import type { CaseMeta, SittingRecipe } from '../lib/sitting.ts'

const ID = 'RS-124'
const TITLE =
  'the Phase 3 delta drives: one sign-in resuming two sessions, a mid-turn source call dispatching with its intent, an Azure endpoint edit applying live'

export const meta = {
  id: ID,
  title: TITLE,
  row: 'UB3.13',
  runtimes: ['pi', 'claude'],
  credentials:
    'owner: arm A needs ONE OAuth source the operator can really sign into (their own; the rig stores only what the operator types through the product) and a second workspace carrying the same source config for the not-joined control; arm B needs no credential (the credential-free MCP fixture `scripts/cdp/fixtures/echo-server.mjs` plays the source); arm C needs a test Azure tenant, else it is skipped for the offline pin. No key or token is ever read or printed.',
} as const satisfies CaseMeta

export const manual = {
  steps: [
    '0. Land-checks per arm (scripts/cdp/README.md\'s stale-bundle rule — rebuild, relaunch, then measure): A requires UB3.10 WHOLE (its store+channels commit AND the consumer half in git log); B requires UB3.9 (c2db41317 or later); C requires UB3.12 (6c283e6b5 or later).',
    '1. Launch the PACKAGED build by scripts/cdp/README.md\'s env -u launcher — fresh NESSY_CONFIG_DIR, dark theme.',
    '2. ARM B (UB3.9, claude session): point a source at the credential-free fixture `bun run scripts/cdp/fixtures/echo-server.mjs` (a stdio MCP source whose tool returns a large payload — big enough to trip the summariser), DISABLED so it is not active at session start. In ONE turn, ask the agent to call the source\'s tool; the gate raises the source-activation card MID-TURN; activate it; the SAME call re-runs and must DISPATCH — a tool result arrives and the stub\'s own log records the call. THE DETECTOR: no failure naming _intent (the #1086 class), the stub log\'s call record carries NO `_intent` argument (the proxy took it out), and the model-facing summary of the large result names the agent\'s stated goal (the summariser prompt carries it; read the summary row the turn received). POSITIVE CONTROL: repeat the identical call on the now-active source — it dispatches as baseline.',
    '3. ARM A (UB3.10, two sessions + the not-joined control): one workspace with an OAuth source (operator-owned, signable) and TWO chat sessions; a SECOND workspace with the same source config. Click sign-in on session A\'s card — ONE browser window opens. Click sign-in on session B\'s card — EXPECT: no second browser; B\'s start JOINED A\'s live flow (the host log reads `Joined live flow for <source>` and B\'s card stays pending). In the OTHER workspace, start the same source\'s sign-in — EXPECT: its own browser window (the not-joined control; a foreign workspace never joins). Complete A\'s sign-in in the browser. EXPECT: BOTH session A\'s and session B\'s cards complete and both turns resume; the other workspace\'s session is untouched.',
    '4. ARM A RESTART arm (the row\'s second negative control): while a flow is live, press Restart on one card — EXPECT: the replaced flow\'s cards (owner + joiners) carry over to the new flow and complete with IT; no card is stranded by the replacement.',
    '5. ARM C (UB3.12, pi session — ONLY with a test Azure tenant): a session on an Azure BYO connection; edit the connection\'s base URL to the tenant\'s OTHER endpoint in Settings; send one turn. THE DETECTOR: the subprocess\'s own line `[runtime_config] Re-applied AZURE_OPENAI_BASE_URL=<new>` (debug log), and the turn\'s traffic hitting the NEW host (the answer or the provider error names it). NO TENANT: skip the live drive and record the offline pin as the arm\'s verdict — provider-endpoint-env.test.ts (3 pass / 0 fail, landed with 6c283e6b5) pins the env contract the wiring applies at both doors.',
    '6. Verdict per arm, recorded in the checklist rows the controller writes: A passes when the second click opened no browser and both cards resumed (the other-workspace control and the restart carry-over holding); B passes when the mid-turn call dispatched with the goal-labelled summary and no _intent-named failure; C passes on the live re-apply reading, or is recorded as offline-pinned.',
  ],
  expected:
    'Arm A: the second sign-in click opens no browser and both waiting sessions resume off ONE flow, with the foreign-workspace and restart-carry-over controls holding. Arm B: the mid-turn-activated source call dispatches, its summary names the goal, and no failure names _intent. Arm C: the edited Azure endpoint is re-applied to the running subprocess live — or the arm is recorded offline-pinned.',
  detector:
    'Server- and runtime-written records only: the host\'s own OAuth join/re-apply log lines, the OAuth store\'s behaviour as observed through the cards, the stub MCP source\'s request log (arm B), and the subprocess\'s debug line for arm C. No model prose and no screen reading is evidence.',
  positiveControl:
    'Per arm: A — the not-joined second workspace (its own browser proves the rig can open one, so B\'s missing one is the product) and session A\'s own browser (the flow exists); B — the same call on the now-active source (the baseline dispatch); C — the offline pin (provider-endpoint-env.test.ts, 3 pass / 0 fail at 6c283e6b5) plus the subprocess debug line naming the NEW URL, which cannot come from init.',
  runOnlyIf:
    'Arm A: UB3.10 landed WHOLE (both commits in git log, bundles rebuilt) — on an earlier build the N-browsers defect is the recorded BEFORE. Arm B: UB3.9 in the build (c2db41317+). Arm C: UB3.12 in the build (6c283e6b5+) AND a test Azure tenant; without a tenant the arm is recorded offline-pinned, which the row itself allows.',
  doneMeans:
    'UB3.13\'s three checklist rows (the controller\'s) carry verdicts: one sign-in resumed two sessions with both controls holding; the mid-turn source call dispatched with its goal-labelled summary; the Azure edit applied live or the arm is recorded offline-pinned.',
  doNotConflate:
    'Arm A\'s "both resume" is TWO cards completing and TWO turns continuing — one card completing twice, or one turn resuming, is not the row. Arm B\'s dispatch is a tool RESULT, not the model saying it tried; and the intent reaching the summariser is read from the goal-labelled summary, not inferred from a successful call. Arm C\'s re-apply line names the subprocess env — a UI field holding the new URL is the disclosure, not the use.',
  safety:
    'Arm A\'s sign-in is the operator\'s own OAuth source typed through the product into the rig\'s fresh NESSY_CONFIG_DIR; the rig never reads a token. Arm B\'s fixture is credential-free and localhost-only. Arm C without a tenant records the offline pin instead of improvising an endpoint.',
} as const satisfies SittingRecipe

if (import.meta.main) console.log(JSON.stringify({ meta, manual }, null, 2))
