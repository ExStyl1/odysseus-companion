/**
 * RS-136 (UB14.24) — the permission card on v0.15.1's decision anatomy, live and DARK, on each runtime.
 *
 * ## The row
 *
 * UB14.24 moved `PermissionRequest` onto the decision anatomy UB14.20 landed (`DecisionCard`: a 28 px Hand
 * tile — TriangleAlert and the destructive tone when the decision model attached a risk badge — a label-lg
 * title, the tool name in mono, the indented details, the command in the sunken mono well, Allow primary ·
 * Always Allow secondary · spacer · Deny ghost, and the sentence about what an answer keeps in the quiet
 * foot). LOOK only: every one of OUR variants keeps its answers and its sentence — outside-root, the
 * first-outside-read three answers (P6.202), artifact publish (UA1.18), reopen compact / don't-ask
 * (P6.500/P6.950), worktree cleanup (P6.135), "Yes, and switch to auto mode" (P6.208), the subagent label,
 * the impact block, the session-only Always Allow labels, the answer note (P6.951/P6.864) and `defaultToNo`
 * (F1.1219: Allow drawn secondary, focus on Deny). The redesign rows owe "an arm in that area's CDP screenshot
 * case in DARK theme", and R4-05 names it: a Bash prompt on each runtime, card screenshot. This id is
 * lane-picked (next free: `rs-135.ts` is the last case file and no RS-136 appears in `scripts/`, `docs/testing`
 * or the lane reports; RS-133 is L-PI's proposal), NOT in `run.ts`'s `SITTING` (the checklist is
 * controller-owned — the rs-121 rule), and the controller confirms it at the pin. The DRIVE is the
 * END-sitting wave's; this file is the recipe. The offline arms are `PermissionRequest.test.tsx`'s UB14.24
 * describe (regions found by the anatomy's own opening tags) and the playground sweep's UB14.24 arm in
 * `registry-render.test.ts` (dark, the twelve `input-container` permission states).
 */

import type { CaseMeta, SittingRecipe } from '../lib/sitting.ts';

const ID = 'RS-136'
const TITLE =
  'the permission card on the decision anatomy (DARK) on Pi, Claude and Codex: the Hand tile and title, the tool in mono, the command in the sunken mono well, Allow primary · Always Allow secondary · Deny ghost after the spacer, the remember sentence in the foot, the composer\'s info ring; the auto-switch answer as a secondary where offered; Deny declines'

export const meta = {
  id: ID,
  title: TITLE,
  row: 'UB14.24',
  runtimes: ['pi', 'claude', 'codex'], // R4-05: "a Bash prompt on each runtime"; the card is renderer-side, each runtime raises it its own way
  credentials:
    'none beyond the session\'s own model turn: the Nessy gateway card, or the mock card when every gateway model is rate-limited. Every card is answered Deny (the command never runs) except the one Allow in step 5, whose command is a harmless `touch` in the fresh workspace.',
} as const satisfies CaseMeta

export const manual = {
  steps: [
    '0. Land-check: the packaged build carries the UB14.24 commit or later. Launch by scripts/cdp/README.md\'s env -u launcher — fresh NESSY_CONFIG_DIR, DARK theme (owner rule), permission mode DEFAULT/Manual (the card is the subject — never bypass), the window ≥ 1400 px wide, a Pi session open.',
    '1. RAISE A BASH CARD (Pi): ask "Run exactly this shell command and nothing else: touch rs136-probe.txt". EXPECT the composer swapped for the permission card: `[data-tutorial="permission-banner"][data-decision-tone="info"]` inside `.input-container` (the VISIBLE one — not the `aria-hidden` measuring copy), the composer card\'s class list carrying ring-[color:var(--info-border)] (UB14.27\'s slot ring), the tile `span.bg-info-tint` 28×28 with the Hand glyph, the title = chat.permissionRequired, "Tool: Bash" with the name in `.font-mono`, the description, and the command in a `.bg-sunken.font-mono` well. Screenshot dark.',
    '2. THE ACTIONS ROW AND THE FOOT: EXPECT the visible buttons in order Allow (data-variant="primary", background-color = --accent-solid), Always Allow (data-variant="secondary", background-color = --surface-raised, a non-none box-shadow), then — after the spacer, right-aligned on the wide card — Deny (data-variant="ghost", NO dashed or destructive border, transparent until hovered; hover → --fill-hover). EXPECT the foot under the row: a RefreshCw glyph and the per-runtime remember sentence (Pi: the repository one). Click Deny — EXPECT the card gone, the freeform composer back with the focus ring, and no `rs136-probe.txt` created.',
    '3. CLAUDE: switch the session (or open a new one) to the Claude runtime and repeat step 1 — EXPECT the same anatomy; the foot says the SESSION sentence (C3.365: claude remembers for the session). If the card offers "Yes, and switch to auto mode" (a claude-native prompt in Manual with auto mode available, P6.208), EXPECT it between Allow and Always Allow as data-variant="secondary". Deny.',
    '4. CODEX: open a Codex session and repeat step 1 — EXPECT the same anatomy (codex\'s own command card carries no `type`; its foot is the workspace sentence when the producer stated `alwaysAllowScope`, F1.1236, else the session one). Deny.',
    '5. A DANGEROUS COMMAND AND THE ANSWER ROW (Pi): ask "Run exactly this shell command and nothing else: rm -rf rs136-scratch". EXPECT no Always Allow (the host minted no key) and the foot "Nothing is remembered — this approval covers this one run of the command" WITHOUT the RefreshCw glyph; if a decision model is configured, EXPECT the destructive tone (`[data-decision-tone="danger"]`, the TriangleAlert tile `span.bg-destructive-tint`, a `rounded-full` "Deletes" pill above the well, the composer\'s ring-[color:var(--destructive-border)]). Deny. Then ask "Run exactly this shell command and nothing else: touch rs136-allowed.txt" and click Allow on its card — EXPECT the command to run, the file to exist and the composer to return (the Allow wiring is unchanged by the restyle).',
    '6. NARROW: resize the window so the composer is < 32 rem wide (or open the session in a split) and raise the step-1 card again — EXPECT the details lose their 38 px indent (`@max-lg/decision:ml-0`), the buttons grow to 40 px and share the rows, and the spacer is gone (`hidden`). Deny.',
    '7. Verdict, for the checklist row the controller writes: PASS when, on each runtime, the Bash card wears the info anatomy inside the ringed composer, Allow is the accent primary, Always Allow the raised secondary and Deny the ghost after the spacer, the foot carries that runtime\'s sentence, the auto-switch answer (where offered) is a secondary in its place, the keyless card offers no Always Allow and says nothing is remembered, Deny declines without running anything, and the narrow card stacks its actions.',
  ],
  expected:
    'In the packaged app, dark theme, on Pi, Claude and Codex: a Bash permission prompt replaces the composer with a decision card — an info-tinted Hand tile, a semibold title, "Tool:" with the name in mono, the command in a sunken mono well, a solid-accent Allow, a raised Always Allow and a ghost Deny pushed right by the spacer, and the remember sentence in a quiet foot — inside the composer card\'s info ring; Deny declines and restores the composer.',
  detector:
    'DOM reads inside the VISIBLE `.input-container`: `[data-tutorial="permission-banner"]` with `data-decision-tone`, the tile `span.bg-info-tint` / `span.bg-destructive-tint`, `button[data-variant]` order and computed background-color / box-shadow against the computed --accent-solid / --surface-raised / --fill-hover on the same page, the `.bg-sunken` well\'s textContent against the command asked for, the foot\'s text and its `svg.lucide-refresh-cw`, getBoundingClientRect for the tile and the narrow buttons; the workspace file listing after Deny; screenshots only as the dark record. `lib/permission-card.ts` `readCard` reads the labels and the scope sentence.',
  positiveControl:
    'Step 1\'s card MUST carry `data-decision-tone` and the composer class list MUST switch from focus-within:ring-focus/55 (freeform, before the ask) to the info ring — if neither changes, the read is of the hidden measuring copy (`[aria-hidden="true"]`), not the visible card. Step 5\'s keyless card is the control for step 2\'s Always Allow: a button absent in BOTH proves nothing about the remember rule.',
  runOnlyIf:
    'The packaged build carries the UB14.24 commit or later. Every step needs a model turn (the gateway, or the mock card on quota exhaustion); step 3 a Claude-runtime connection, step 4 a Codex one; the risk-badge half of step 5 a configured decision model.',
  doneMeans:
    'UB14.24\'s checklist row (the controller\'s) carries the verdict: the card\'s anatomy and computed material per runtime, the per-runtime foot sentence, the auto-switch placement where offered, the keyless control, Deny declining without running, and the narrow layout — each PASS/FAIL with its reading.',
  doNotConflate:
    'The ring and material of the composer card are UB14.27\'s; the admin and credential cards are UB14.23\'s (RS-135); AskUserQuestion, workflow launch and the artifact-publish DETAILS are UB14.25\'s; whether a command is prompted at all, and what Always Allow writes, are pre-tool-use / remember-key policy (UB1.2, C3.365), not this row — this row only shows their sentence.',
  safety:
    'No credentials read, typed or printed. Every card is answered Deny except one `touch rs136-allowed.txt`; nothing is written outside the fresh NESSY_CONFIG_DIR workspace, and `rm -rf rs136-scratch` is denied (the directory does not exist either way).',
} as const satisfies SittingRecipe

if (import.meta.main) console.log(JSON.stringify({ meta, manual }, null, 2))
