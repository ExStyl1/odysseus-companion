/**
 * RS-139 (UB14.29) — the composer's permission-mode chip, live and DARK, on Pi, Claude and Codex.
 *
 * ## The row
 *
 * UB14.29 put v0.15.1's `ComposerModeChip` in the composer toolbar in place of our flat mode dropdown: a tinted
 * 28 px pill keyed by `MODE_CHIP_TONE` (Manual and Auto info, Accept edits success, Plan and Bypass accent, Don't ask
 * neutral), `data-mode`, the "Permission mode: <mode>" name, icon-only under a 32rem panel, the cycle shortcut with
 * its keycaps in the menu's footer, and the focus handed back to the composer on close. The menu CONTENT stays ours:
 * the runtime's rows narrowed by the workspace cycle (P2.56), F1.1052's Recommended/Default badges, check and digits
 * (`1`…`9` select), R15's 440 px descriptions and the runtime note drawn once, `locked` from the capability set. The
 * compact drawer trigger took upstream's pill and rows the same way. The redesign rows owe "an arm in that area's
 * CDP screenshot case in DARK theme". This id is lane-picked (next free: `rs-138.ts` is the last case file and no
 * RS-139 appears in `scripts/`, `docs/testing` or `work/lane-reports`; the same search finds RS-138, the control),
 * NOT in `run.ts`'s `SITTING` (the checklist is controller-owned — the rs-121 rule), and the controller confirms it
 * at the pin. The DRIVE is the END-sitting wave's; this file is the recipe. The offline arms are
 * `composer-mode-chip.test.tsx`, the retargeted source pins in `composer-permission-modes.test.ts` and
 * `workspace-cyclable-modes.test.ts`, and the dark playground sweep's UB14.29 arm in `registry-render.test.ts`
 * (`parity-permission-mode-selector` in every mode, locked, narrow, menu open; `input-container`'s toolbar).
 *
 * ## What the case proves
 *
 * The packaged app paints the pill in each mode's tone and keeps our behaviour: the menu opens upward with our rows,
 * badges, digits and one runtime note (codex's caveat plus the resume sentence; the resume sentence alone on Pi and
 * Claude), a digit selects, ⇧Tab still cycles (and the chip follows), the footer names the binding the user has, the
 * caret returns to the composer after a pick, a narrow panel folds the chip to its icon, and a locked capability set
 * disables it.
 */

import type { CaseMeta, SittingRecipe } from '../lib/sitting.ts';

const ID = 'RS-139'
const TITLE =
  'the composer mode chip (DARK): the tinted pill per mode with data-mode, the upward menu with our rows, badges, digits and ONE runtime note, the cycle-shortcut footer, a digit pick and a ⇧Tab cycle the chip follows, focus back in the composer, the icon-only fold in a narrow panel, and the compact drawer trigger'

export const meta = {
  id: ID,
  title: TITLE,
  row: 'UB14.29',
  runtimes: ['pi', 'claude', 'codex'], // R4-09: "pi/claude/codex (codex's runtime note is shown once)"; the chip is renderer-side, the rows and the note come from each runtime's capability set
  credentials:
    'none for steps 1–6 (no turn is sent: the chip reads the composer capability set). Step 7 opens a session on each card (the Nessy gateway Pi card, claude-gateway, a codex card); the mock card stands in for a card whose quota is exhausted.',
} as const satisfies CaseMeta

export const manual = {
  steps: [
    '0. Land-check: the packaged build carries the UB14.29 commit or later. Launch by scripts/cdp/README.md\'s env -u launcher — fresh NESSY_CONFIG_DIR, DARK theme (owner rule), a Pi session open, the window ≥ 1400 px wide, the workspace default mode left at its default.',
    '1. THE PILL: read `button[data-tutorial="permission-mode-dropdown"]` in the composer toolbar `[data-composer-actions]` — EXPECT exactly one, `aria-haspopup="menu"`, data-mode = the session\'s mode, aria-label "Permission mode: <mode>" (ru "Режим прав: …"), getBoundingClientRect height 28, border-radius ≥ 14 px, and NO second mode control above the card (`ActiveOptionBadges` shows none on desktop). For each of Manual, Auto, Accept edits, Plan, Bypass permissions (write the mode through the picker), EXPECT getComputedStyle background-color = the computed --info-tint / --info-tint / --success-tint / --accent-tint / --accent-tint and color = --info / --info / --success / --accent / --accent. Screenshot dark (Accept edits).',
    '2. THE MENU (Pi): click the chip — EXPECT `[role="menu"][data-state="open"]` ABOVE the chip (its bottom ≤ the chip\'s top), five `[role="menuitem"]` rows in the order Auto, Manual, Accept edits, Plan, Bypass permissions with digits 1–5 at their right, "Recommended" on Auto, "Default" on the workspace default, the check on the current mode, each description on ONE line at ≥ 1400 px (row height < 56 px), then ONE `[data-permission-mode-runtime-note]` (the resume sentence), then the footer `[data-permission-mode-cycle-hint]` reading "Cycle Permission Mode" with keycaps ⇧ Tab (Shift Tab off macOS). Screenshot dark.',
    '3. DIGIT AND FOCUS: with the menu open press 4 — EXPECT the menu closed, data-mode="plan", the session reporting plan (sessionCommand read-back), and document.activeElement inside the composer\'s editor (the caret is back; not the chip). Press ⇧Tab in the editor — EXPECT the next mode of the workspace cycle (Bypass permissions) and the chip following it within one frame.',
    '4. CODEX (switch the session to a codex card or open a codex session): open the menu — EXPECT exactly ONE `[data-permission-mode-runtime-note]` band whose text = chat.permissionModeRuntimeNote.codex + the resume sentence, and the plan row carrying its codex clause on one line. Screenshot dark. CLAUDE (claude-gateway): EXPECT the resume sentence alone, once.',
    '5. NARROW: split the view (or shrink the window) until the chat panel is < 512 px wide — EXPECT the chip\'s label `display: none` (icon only, still tinted, aria-label unchanged). Screenshot dark.',
    '6. REBOUND SHORTCUT (runOnlyIf Settings → Shortcuts can rebind "Cycle Permission Mode"): rebind it to another chord — EXPECT the footer keycaps to show the new chord (P6.49), and unbinding it removes the footer. Restore the default.',
    '7. COMPACT (the mobile web UI or a window < 768 px that renders compact): read the drawer trigger `button[aria-label^="Permission mode"]` — EXPECT data-mode, the same tone as step 1, height 28, rounded-full; open it — EXPECT the drawer rows (44 px touch rows, the current one on --fill-selected with a check, the badges) and the runtime note once. A LOCKED capability set (runOnlyIf a connection reports `permissions.locked`, e.g. a side-question composer): EXPECT the chip `disabled`, tinted, and a click opening nothing.',
    '8. Verdict, for the checklist row the controller writes: PASS when the pill wears its mode\'s tint and data-mode on every runtime, the menu opens upward with our rows, digits, badges, check and ONE note (codex\'s caveat on codex), the footer names the live binding, a digit and ⇧Tab both change the mode with the chip following and the caret back in the editor, a narrow panel folds it to the icon, and the compact drawer trigger and a locked set behave as above.',
  ],
  expected:
    'In the packaged app, dark theme: the composer toolbar carries one tinted 28 px mode pill (info for Manual/Auto, success for Accept edits, accent for Plan/Bypass) named "Permission mode: <mode>"; it opens an upward menu of our five rows with their digits, badges and check, one runtime note and a "Cycle Permission Mode ⇧ Tab" footer; a digit or ⇧Tab changes the mode and the pill follows, with the caret back in the editor; narrow panels show the tinted icon alone; the compact drawer trigger is the same pill; a locked set disables it.',
  detector:
    'DOM reads of `button[data-tutorial="permission-mode-dropdown"]` (data-mode, aria-label, disabled, rect, computed background-color / color against the computed --info-tint, --success-tint, --accent-tint, --info, --success, --accent on the same page), `[role="menu"][data-state="open"]` and its `[role="menuitem"]` rows (text, `data-permission-mode-shortcut`, rects), `[data-permission-mode-runtime-note]` (count and text), `[data-permission-mode-cycle-hint]` (text, `kbd` texts), document.activeElement after a pick, the session\'s permissionMode through the app\'s own read; screenshots only as the dark record.',
  positiveControl:
    'Step 1\'s Manual and Accept edits reads MUST differ in background-color — if they do not, the read is of a wrapper, not the pill. Step 4\'s codex note MUST be longer than step 2\'s Pi note (codex adds its caveat before the shared sentence) — if they are equal, the menu did not follow the runtime and the "once" reading proves nothing.',
  runOnlyIf:
    'The packaged build carries the UB14.29 commit or later. Step 4 needs a codex card and claude-gateway configured; step 6 a shortcut editor that can rebind the cycle action; step 7\'s locked arm a connection whose capability set reports permissions.locked.',
  doneMeans:
    'UB14.29\'s checklist row (the controller\'s) carries the verdict: the pill\'s computed tint and attributes per mode, the menu\'s rows/digits/badges/note/footer on Pi, Claude and Codex, the digit and ⇧Tab picks with the chip following and focus back in the editor, the narrow fold, the compact trigger, and the locked arm (if run) — each PASS/FAIL with its reading.',
  doNotConflate:
    'The toolbar ORDER (mode · model in the right-hand group, upstream\'s align="end" menu) is UB14.32\'s — until it lands the chip still leads the left group and its menu aligns to its start; the badge row above the card is UB14.55\'s; the model menu is UB14.30\'s; which modes a runtime offers and what its note says are the capability set\'s (R15, P2.56, D1.369), not this row.',
  safety:
    'No credentials read or printed. No turn is sent for steps 1–6; mode writes go through the app\'s own picker and sessionCommand read-back under the fresh NESSY_CONFIG_DIR. Bypass permissions is selected only on an idle session and left before any turn.',
} as const satisfies SittingRecipe

if (import.meta.main) console.log(JSON.stringify({ meta, manual }, null, 2))
