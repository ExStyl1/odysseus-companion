/**
 * RS-138 (UB14.26) — the transcript's AuthRequestCard on v0.15.1's decision material, live and DARK: a source
 * OAuth card (pending, the browser wait with Restart sign-in beside our Cancel, the outcome), a credential card
 * (the form inside the standalone card, Save the one submit, Cancel never submits), and the dp (Developer
 * Platform / Nestor) sign-in card (pending, waiting-browser with the copy-link hint, Connected or the retryable
 * failure).
 *
 * ## The row
 *
 * UB14.26 merged v0.15.1's `AuthRequestCard.tsx` per hunk: a finished request is upstream's `AuthOutcome` (a
 * success / error / muted tinted block, no actions, compact `w-fit` after the next message), every pending card a
 * standalone `DecisionCard` (raised, info ring, the 28 px tile, the label-lg title, the details column, the actions
 * row, the encrypted-at-rest foot), the titles and statuses translated (`chat.authCard.*`) and the provider on the
 * sign-in button. Ours re-applied: the dp card's state machine and its `auth-url:` hint, a dp failure that keeps
 * Retry and Cancel on a DANGER-toned decision card, plugin-server OAuth, OAuth cancel beside the v0.15.1 restart,
 * the transient codes as keys, and UB1.15's one submit path. The redesign rows owe "an arm in that area's CDP
 * screenshot case in DARK theme". This id is lane-picked (next free: `rs-137.ts` is the last case file and no
 * RS-138 appears in `scripts/`, `docs/testing` or `work/lane-reports`; the same search finds RS-137, the control),
 * NOT in `run.ts`'s `SITTING` (the checklist is controller-owned — the rs-121 rule), and the controller confirms it
 * at the pin. The DRIVE is the END-sitting wave's; this file is the recipe. The offline arms are
 * `AuthRequestCard.oauth.test.tsx`'s and `AuthRequestCard.dp-auth.test.tsx`'s UB14.26 describes,
 * `AuthRequestCard.credential-submit.test.tsx` (UB1.15's pin), the census pins in
 * `renderer-hardcoded-strings.test.ts`, and the dark playground sweep in `registry-render.test.ts` (every
 * `auth-request-card` variant, the dp and the browser-wait states included).
 */

import type { CaseMeta, SittingRecipe } from '../lib/sitting.ts';

const ID = 'RS-138'
const TITLE =
  'the transcript auth card on the decision material (DARK): a source OAuth card (Sign in with OAuth primary, Cancel ghost; while the browser runs, Restart sign-in and Cancel; the success outcome after), a credential card (form inside the standalone card, Save the one submit, Cancel answers cancelled), and the dp sign-in card (titleDp, waiting-browser copy-link hint, Connected outcome or the danger-toned Retry)'

export const meta = {
  id: ID,
  title: TITLE,
  row: 'UB14.26',
  runtimes: ['pi', 'claude', 'codex'], // the card is host UI, runtime-neutral; any runtime that raises a source sign-in reaches it
  credentials:
    'none of the user\'s: the OAuth arm signs into a LOOPBACK OAuth fixture source the sitting starts (never a real provider); the credential arm types the fixture value "rs138-fixture" into a fixture source and then CANCELS; the dp arm uses the machine\'s own dp CLI session through the product (the card never shows or logs the token).',
} as const satisfies CaseMeta

export const manual = {
  steps: [
    '0. Land-check: the packaged build carries the UB14.26 commit or later. Launch by scripts/cdp/README.md\'s env -u launcher — fresh NESSY_CONFIG_DIR, DARK theme (owner rule), bypassPermissions (the auth card is not a permission card), the window ≥ 1400 px wide.',
    '1. OAUTH PENDING: add a source pointing at the sitting\'s loopback OAuth fixture and ask the agent to use it so it raises the in-chat sign-in. EXPECT the transcript card `[data-decision-tone="info"]` with the standalone material (class list carries `rounded-xl bg-raised shadow-elev-2` and ring-[color:var(--info-border)]), the KeyRound tile `span.bg-info-tint`, the title "<source> OAuth" (chat.authCard.titleOAuth), then Sign in with OAuth (button[data-variant="primary"][data-tutorial="oauth-sign-in-button"]) and Cancel (data-variant="ghost"). Screenshot dark.',
    '2. BROWSER WAIT AND RESTART: click Sign in with OAuth and do NOT finish in the browser. EXPECT the header swapped to the spinner tile and "<source> Authenticating..." with "Complete authentication in your browser" in the details, and the row Restart sign-in (ghost) · Cancel (ghost), both enabled, no sign-in button. Click Restart sign-in — EXPECT a fresh browser tab, the card still waiting (only the latest attempt ends the spinner). Finish in the browser — EXPECT the card replaced by the SUCCESS outcome: a `.bg-success-tint` block with the CheckCircle2 glyph and "<source> Connected" (plus "Signed in as …" when the fixture returns an email), no button. Send one more message — EXPECT the compact twin (`w-fit`).',
    '3. CREDENTIAL CARD: ask the agent to connect a fixture API-key source so it raises a credential prompt. EXPECT the form INSIDE the decision card (`[data-decision-tone="info"] form[method="post"]`), the Key tile, "<source> Authentication", the field with the inset Key glyph and the reveal toggle named chat.credentials.showValue, Save (type="submit", data-variant="primary", disabled until typed) · Cancel (type="button", ghost), and the ShieldCheck foot "Credentials are encrypted at rest". Type rs138-fixture, click Cancel — EXPECT the muted outcome "<source> Cancelled" and the session\'s credential response cancelled with NO value (UB1.15; read the server log line for the response, never the value).',
    '4. DP PENDING: in a gateway session whose dp CLI session has expired (or by the corporate-credential sign-in path that raises the dp card), EXPECT the card titled "Developer Platform Sign-In" (chat.authCard.titleDp) with the KeyRound tile, Sign in to Developer Platform (primary) · Cancel (ghost). If the card was raised by a failed forced re-mint, EXPECT the reason line (chat.dpAuth.errors.<code>) in the details. Screenshot dark.',
    '5. DP WAITING BROWSER: click Sign in to Developer Platform. EXPECT the spinner tile and "Checking Developer Platform session"; when dp opens its browser, "Complete sign-in in your browser" and the copy-link hint `[data-testid="gateway-auth-url-hint"]` showing the HOST only (never the query), the primary DISABLED (`disabled=""`) and Cancel ENABLED. Finish — EXPECT the success outcome "Developer Platform Connected" with no button. (Alternative arm, when no expired session is at hand: click Cancel during the wait — EXPECT the muted "Developer Platform Cancelled" outcome, never the danger card.)',
    '6. DP FAILURE: with `dp` off PATH for the app (a launcher env without it), raise the dp card and click its sign-in — EXPECT the DANGER-toned decision card (`[data-decision-tone="danger"]`, ring-[color:var(--destructive-border)], the XCircle tile `span.bg-destructive-tint`), "Developer Platform Sign-In Failed" with chat.dpAuth.errors.DpNotFound in the details, and Retry (primary) · Cancel (ghost, enabled). Skip with the reason when the launcher cannot hide dp.',
    '7. Verdict, for the checklist row the controller writes: PASS when every pending card wears the standalone info anatomy (the dp failure the danger one), every finished card is the tinted outcome without actions, the browser wait offers Restart sign-in and Cancel, Save is the only submit and Cancel answers cancelled without the value, and the dp hint shows the host and never the query.',
  ],
  expected:
    'In the packaged app, dark theme: the in-chat auth card is a raised decision card with an info ring for every pending sign-in (OAuth, credential, dp), a red-ringed decision card only for a retryable dp failure, and a quiet tinted outcome block (green Connected, grey Cancelled, red Failed) once the request is finished; the browser wait shows Restart sign-in beside Cancel.',
  detector:
    'DOM reads on the transcript card: `[data-decision-tone]` and its class list, the tile span class, `button[data-variant]` order and the `disabled` ATTRIBUTE (every button class carries `disabled:` variants, so never a substring of the class), `form[method="post"]` and each button\'s `type`, `[data-testid="gateway-auth-url-hint"]` text; the outcome block\'s `bg-*-tint` class; the server log line for the credential response shape (cancelled, no value field); screenshots only as the dark record.',
  positiveControl:
    'Step 1\'s card MUST carry `data-decision-tone="info"` and step 2\'s outcome MUST carry `bg-success-tint` and NO `data-decision-tone` — the same instrument reads the two materials apart; if both read the same, the probe is reading a stale node. Step 5\'s primary flips from enabled (step 4) to `disabled=""` while Cancel stays enabled.',
  runOnlyIf:
    'The packaged build carries the UB14.26 commit or later. Step 1–2 need the sitting\'s loopback OAuth fixture source; step 3 a fixture credential source; steps 4–5 a gateway session whose dp CLI session can be made to need a sign-in; step 6 a launcher env without dp on PATH.',
  doneMeans:
    'UB14.26\'s checklist row (the controller\'s) carries the verdict: each card\'s material and tone, the action rows (Restart sign-in beside Cancel in the wait, Save the one submit), the outcome blocks, the dp hint host-only and the dp failure danger-toned — each PASS/FAIL with its reading.',
  doNotConflate:
    'The composer\'s credential and admin cards are UB14.23\'s (RS-135), the permission card UB14.24\'s (RS-136); one sign-in serving several waiting sessions (the join, the fan-out) is UB3.10\'s host behaviour, not this row\'s look; the copy-link hint\'s own look is F1.2\'s.',
  safety:
    'No credential of the user\'s is read, typed or printed: the OAuth source is a loopback fixture, the credential arm types a fixture value and CANCELS, and the dp arm goes through the product\'s own dp CLI call (the token never reaches the page or the report). Nothing is written outside the fresh NESSY_CONFIG_DIR workspace.',
} as const satisfies SittingRecipe

if (import.meta.main) console.log(JSON.stringify({ meta, manual }, null, 2))
