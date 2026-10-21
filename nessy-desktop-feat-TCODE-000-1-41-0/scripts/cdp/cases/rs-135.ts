/**
 * RS-135 (UB14.23) — the admin-approval and credential cards on v0.15.1's decision anatomy, live and DARK.
 *
 * ## The row
 *
 * UB14.23 moved the two structured cards onto the decision anatomy UB14.20 landed (`DecisionCard`: a 28 px
 * info tile, label-lg title, indented details, the sunken mono well, Approve/Save primary · Cancel ghost, a
 * quiet foot). `AdminApprovalRequest` is a merge: upstream's anatomy with OUR `adminApprovalCardData`
 * (F1.885), the `canRemember` gate (no switch without a named lifetime or under `noAlwaysAllow`,
 * F1.869/F1.885), the ask-rule sentence and the `Trans`/`t()` copy (F1.554). `CredentialRequest` is taken
 * with OUR i18n re-applied (title, placeholders, Save/Cancel, the encrypted-at-rest foot) and upstream's
 * named reveal toggle (`chat.credentials.showValue`/`hideValue`). The redesign rows owe "an arm in that
 * area's CDP screenshot case in DARK theme"; this id is lane-picked (next free: `rs-134.ts` is the last
 * case file and no RS-135 appears in `scripts/` or the lane reports), NOT in `run.ts`'s `SITTING` (the
 * checklist is controller-owned — the rs-121 rule), and the controller confirms it at the pin. The DRIVE
 * is the END-sitting wave's; this file is the recipe. The offline arms are `CredentialRequest.test.tsx`,
 * `AdminApprovalRequest.test.tsx`'s UB14.23 describe, and the playground sweep's UB14.23 arm in
 * `registry-render.test.ts` (dark).
 *
 * ## A measured residue: the composer credential card has no live trigger
 *
 * Nothing in this tree EMITS a `credential_request` session event: `git grep credential_request` over
 * `packages/` and `apps/electron/src/main` finds only the DTO's declaration (`protocol/dto.ts`) and the
 * renderer's consumer (positive control: the same instrument finds the renderer handler in
 * `event-processor/handlers/session.ts`). Upstream v0.15.1 is the same (its only reader is
 * `messaging-gateway`). A live `source_credential_prompt` renders as the transcript's `AuthRequestCard`
 * (UB14.26's row), so the composer card's look is recorded OFFLINE — the playground "Credential UI" states,
 * swept dark — and step 5 only confirms the residue still holds on the packaged build.
 */

import type { CaseMeta, SittingRecipe } from '../lib/sitting.ts';

const ID = 'RS-135'
const TITLE =
  'the admin-approval card on the decision anatomy (DARK): the info tile and title, the translated install / why / impact copy, the command in the sunken mono well, Approve primary · Cancel ghost, the remember switch only where the request named a lifetime and is not under an ask rule, and the composer ring; the credential card recorded offline (no live trigger)'

export const meta = {
  id: ID,
  title: TITLE,
  row: 'UB14.23',
  runtimes: ['pi', 'claude'], // admin cards come from Pi and Claude (`classifyAdminApproval`); the card itself is runtime-neutral
  credentials:
    'none for the card arms beyond the session\'s own model turn: the Nessy gateway card, or the mock card when every gateway model is rate-limited. Nothing is installed — every card is answered Cancel.',
} as const satisfies CaseMeta

export const manual = {
  steps: [
    '0. Land-check: the packaged build carries the UB14.23 commits or later. Launch by scripts/cdp/README.md\'s env -u launcher — fresh NESSY_CONFIG_DIR, DARK theme (owner rule), permission mode DEFAULT/Ask (the card is the subject — never bypass), a Pi session open, the window ≥ 1400 px wide.',
    '1. RAISE AN ADMIN CARD (Pi): ask "Run exactly this shell command and nothing else: brew install --cask docker". EXPECT the composer swapped for the admin card: `[data-decision-tone="info"]` inside `.input-container`, the composer card\'s class list carrying ring-[color:var(--info-border)] (UB14.27\'s slot ring), the tile `span.bg-info-tint` 28×28 with the ShieldAlert glyph, the title = chat.adminApprovalRequired, the install sentence with the app name emphasised, the Why line, the Impact line if any, and the command in a `.bg-sunken.font-mono` well. Screenshot dark.',
    '2. THE ACTIONS ROW: inside the card\'s actions row EXPECT, in order, Approve (data-variant="primary", background-color = --accent-solid), Cancel (data-variant="ghost", no dashed destructive border), and — ONLY if the card named a lifetime — a `[role="switch"]` with the label "Remember for N min" (en) / its ru value. Hover Cancel — EXPECT the ghost fill (--fill-hover). Click Cancel — EXPECT the card gone, the freeform composer back, the agent told the command was declined, and NOTHING installed.',
    '3. UNDER AN ASK RULE (runOnlyIf the workspace carries a readable ask rule matching `brew` — e.g. a permissions rule `ask` for `Bash(brew install --cask *)`): repeat step 1 — EXPECT the rule sentence named on the card under the Why line and NO `[role="switch"]` anywhere in the card (F1.885). Cancel.',
    '4. CLAUDE: switch the session (or open a new one) to the Claude runtime and repeat step 1 — EXPECT the same anatomy and the same switch rule. Cancel.',
    '5. NARROW: resize the window so the composer is < 32 rem wide (or open the session in a split) and raise the card again — EXPECT the details lose their 38 px indent (`@max-lg/decision:ml-0`) and Approve / Cancel grow to 40 px and share the row. Cancel. Then confirm the residue: `git grep -n credential_request -- packages apps/electron/src/main` on the build\'s commit still finds the DTO only; if it finds an emitter, raise the credential card through it and read the same anatomy (Key tile, the field\'s reveal toggle `aria-label` = chat.credentials.showValue, Save `type="submit"` disabled until a value is typed, Cancel `type="button"`, the encrypted-at-rest foot) — otherwise record "credential card: offline only (playground Credential UI, dark sweep)".',
    '6. Verdict, for the checklist row the controller writes: PASS when the admin card wears the info anatomy inside the ringed composer, the copy is in the UI language, the command sits in the sunken well, Approve is the accent primary and Cancel the ghost, the remember switch appears only with a named lifetime and never under an ask rule, Cancel declines without installing, and the narrow card stacks its actions; the credential arm is recorded as offline (or PASS through an emitter if one exists).',
  ],
  expected:
    'In the packaged app, dark theme: an admin-elevation request replaces the composer with a decision card — an info-tinted ShieldAlert tile, a semibold title, the translated install/why/impact copy, the command in a sunken mono well, a solid-accent Approve and a ghost Cancel, and a remember switch only where the request offered a lifetime — inside the composer card\'s info ring; Cancel declines and restores the composer.',
  detector:
    'DOM reads inside `.input-container`: `[data-decision-tone]`, the tile `span.bg-info-tint`, `button[data-variant]` order and computed background-color against the computed --accent-solid / --fill-hover on the same page, `[role="switch"]` presence, the `.bg-sunken` well\'s textContent against the command asked for, getBoundingClientRect for the tile and the narrow buttons; the transcript\'s tool result after Cancel; screenshots only as the dark record.',
  positiveControl:
    'Step 1\'s card MUST carry `data-decision-tone` and the composer class list MUST switch from focus-within:ring-focus/55 (freeform, before the ask) to the info ring — if neither changes, the read is of the hidden measuring copy (`[aria-hidden="true"]`), not the visible card. Step 3 runs only beside step 2\'s switch reading: a switch absent in BOTH proves nothing about the ask-rule gate.',
  runOnlyIf:
    'The packaged build carries the UB14.23 commits or later. Steps 1–5 need a model turn (the gateway, or the mock card on quota exhaustion) and a runtime whose pre-tool-use classifier raises the admin card for the command (Pi, Claude). Step 3 needs a readable ask rule.',
  doneMeans:
    'UB14.23\'s checklist row (the controller\'s) carries the verdict: the admin card\'s anatomy and computed material per runtime, the switch rule with and without an ask rule, the narrow layout, Cancel declining without an install, and the credential card recorded offline (or PASS through an emitter) — each PASS/FAIL with its reading.',
  doNotConflate:
    'The ring and material of the composer card are UB14.27\'s; the permission card (Allow / Always Allow / Deny, risk pills) is UB14.24\'s; the transcript\'s AuthRequestCard — where a live source credential prompt actually renders — is UB14.26\'s; whether a command is classified as admin elevation is pre-tool-use policy, not this row.',
  safety:
    'No credentials read, typed or printed. Every admin card is answered Cancel — nothing is installed and no admin prompt (password / Touch ID) is ever reached. The ask rule of step 3 lives in the fresh NESSY_CONFIG_DIR workspace only.',
} as const satisfies SittingRecipe

if (import.meta.main) console.log(JSON.stringify({ meta, manual }, null, 2))
