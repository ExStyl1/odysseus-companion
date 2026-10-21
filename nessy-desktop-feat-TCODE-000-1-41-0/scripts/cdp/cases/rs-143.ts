/**
 * RS-143 (UB14.32) — the composer assembled in v0.15.0's order, live and DARK, at 1400 px and 700 px.
 *
 * ## The row
 *
 * UB14.32 replaced our Codex-parity grid footer with upstream's ONE toolbar row for both layouts: attach (a named
 * icon button) · sources · folder (and our capability-gated branch chip) on the left, a spacer, mode · model in a
 * squeezable right group, then our always-on context ring and Send outside the squeeze. The composer owns its
 * `@container/panel`, a dragged file draws an inset focus ring on the accent tint (the "Drop to attach" pill is
 * gone), the draft takes the copy type (15/24; compact 16/26) with the rotating tip on the same line box, and a
 * compact composer's default tips leave the keyboard ones out. The redesign rows owe "an arm in that area's CDP
 * screenshot case in DARK theme"; this id is lane-picked (next free: RS-142 is UB14.31's recipe-only id), NOT in
 * `run.ts`'s `SITTING` (the checklist is controller-owned — the rs-121 rule), and the controller confirms it at
 * the pin. UB12.78 adds step 2's read of the left group's four-icon floor (our branch chip is a fourth icon). The DRIVE
 * is the END-sitting wave's; this file is the recipe. The offline arms are
 * `freeform-assembly.test.ts`, `compact-placeholder.test.ts`, `rich-text-input-render.test.tsx`'s line-box arm and
 * the playground sweep's UB14.32 describe in `registry-render.test.ts` (dark).
 */

import type { CaseMeta, SittingRecipe } from '../lib/sitting.ts';

const ID = 'RS-143'
const TITLE =
  'the composer toolbar in v0.15.0\'s order (DARK): attach · sources · folder · branch on the left, mode · model on the right, then the context ring and Send inside the card at 1400 px and 700 px; compact folds the left chips to icons with mode · model on the right; the drop target is an inset ring on the accent tint with no label; the draft on the copy type with the tip on the caret\'s line box'

export const meta = {
  id: ID,
  title: TITLE,
  row: 'UB14.32',
  runtimes: ['pi', 'claude', 'codex'], // the order is renderer-only; each runtime's chips (mode list, model menu, branch gate) differ
  credentials:
    'none for steps 1–6 (no turn is sent). Step 7 sends one turn: the Nessy gateway card, or the mock card when every gateway model is rate-limited.',
} as const satisfies CaseMeta

export const manual = {
  steps: [
    '0. Land-check: the packaged build carries the UB14.32 commit or later. Launch by scripts/cdp/README.md\'s env -u launcher — fresh NESSY_CONFIG_DIR, DARK theme (owner rule), bypassPermissions (no card is the subject), ONE content panel, a Pi session in a workspace with two API sources and a project folder inside a git repo; the window 1400 px wide.',
    '1. ORDER (1400 px): in `[data-composer-actions]` read the buttons left to right by getBoundingClientRect().left — EXPECT attach (`[data-slot="icon-button"]`, aria-label = chat.attachFiles, 28×28, no visible text) < the sources chip < the folder chip < the branch chip < (gap) < the mode chip `[data-tutorial="permission-mode-dropdown"]` < the model chip < the context ring (after a turn) < `[data-tutorial="send-button"]`; Send\'s right edge ≤ the card\'s (`.input-container`) right edge − 8 px. The card\'s first child carries `@container/panel` (getComputedStyle containerType = "inline-size"). No `.composer-footer` anywhere (querySelectorAll → 0). Screenshot dark.',
    '2. SQUEEZE (700 px, desktop layout): resize the window to 700 px. EXPECT Send and the model chip still fully inside the card; the left chips\' labels (`[data-badge-label]`) display:none once the composer is under 32rem (512 px) wide, else truncated with an ellipsis; nothing of the toolbar wraps to a second line (all buttons share one top within 2 px). UB12.78 (the branch chip is a 4th left icon): with the branch chip present, the left group (the `[data-composer-actions]` row\'s first `div`) has computed min-width `clamp(0px, 100% - 176px, 128px)` (96px where no branch chip mounts); at a 34rem (544 px) composer and again at the narrowest panel (drag the sash to the 440 px PANEL_MIN_WIDTH: composer ≈ 392 px) with the longest model name offered, each left chip\'s first icon (svg/img) keeps ≥ 95% of its width inside every overflow-clipping ancestor up to the left group (attach, sources, folder AND branch); at 1400 px every icon is 100% visible. Screenshot dark.',
    '3. COMPACT (the session\'s compact layout, or the /btw panel / Edit-popover composer): EXPECT the left group = attach · sources · folder as icons only (no `[data-badge-label]` visible), then the mode drawer trigger (`[data-mode]`, aria-haspopup="dialog") and the compact model chip (if offered) on the RIGHT, then Send; no branch chip. Screenshot dark.',
    '4. DRAFT TYPE: read the empty desktop textbox `[role="textbox"][data-tutorial="chat-input"]` — EXPECT font-size 15px, line-height 24px, padding 14px on all sides; the rotating tip overlay (`.pointer-events-none.select-none` next to it) line-height 24px (the caret and the tip share one line box — compare the tip\'s getBoundingClientRect().top with a typed character\'s caret rect within 1 px). Compact: 16px / 26px. Over 5 s the desktop tips rotate through the keyboard ones (Shift+Tab, Shift+Return, the sidebar and focus-mode chords); a compact composer that names no placeholder of its own never shows them.',
    '5. DROP TARGET: drag a small text file from Finder over the composer (or dispatch dragenter with a DataTransfer carrying a File) — EXPECT the composer root gains an inset 2px ring in --color-focus (getComputedStyle boxShadow contains "inset") on the --accent-tint background, and NO label text appears (no element whose text is "Drop to attach" / «Отпустите, чтобы прикрепить»); drop — the file lands in the attachment strip. Screenshot dark (while dragging).',
    '6. COLLAPSED COMPACT (compact layout while a turn runs, before expanding): EXPECT no textbox and the spacer button aria-label = chat.tapToType, 28 px high, border-radius = the computed --radius-md, color = --text-tertiary; hover — the textbox returns.',
    '7. RUNTIMES: repeat steps 1 and 3 once on a claude-gateway session and once on a codex session (send one short turn first so the context ring is drawn) — EXPECT the same order; the mode chip lists that runtime\'s modes; the branch chip present on all three when the folder is a git repo (the gate is externalFooter.gitBranch).',
    '8. Verdict, for the checklist row the controller writes: PASS when the order of step 1 holds on all three runtimes with Send inside the card at 1400 and 700 px, compact folds the left chips and puts mode · model on the right, the draft reads 15/24 (16/26 compact) with the tip on the caret\'s line box, the drop target is the inset ring on the tint with no label, and the collapsed spacer is the tertiary 28 px target.',
  ],
  expected:
    'In the packaged app, dark theme: one toolbar row under the draft — attach icon, sources, folder and branch chips on the left, the mode and model chips on the right, then the context ring and the round Send — that keeps Send inside the card at 700 px by folding the left labels; compact shows icon-only chips with mode · model on the right; a dragged file tints the card with an inset focus ring and no label; the draft and its rotating tip sit on one 24 px line box.',
  detector:
    'DOM reads under `[data-composer-actions]` (button order by getBoundingClientRect().left, aria-labels, data-slot/data-mode/data-tutorial), getComputedStyle on the composer root (containerType, boxShadow, background-color vs the computed --accent-tint / --color-focus), on the textbox and its overlay (font-size, line-height, padding), and on `[data-badge-label]` (display); querySelectorAll counts for `.composer-footer` and the drop label text; screenshots only as the dark record.',
  positiveControl:
    'Step 2 MUST show at least one `[data-badge-label]` at display:none after the resize when the composer is under 512 px — if none ever hides, the read is not of the composer\'s own container (the panel query). Step 2\'s UB12.78 icon read MUST report < 95% for at least one icon once the left group\'s min-width is overridden in DevTools to v0.15.1\'s `clamp(0px, 100% - 176px, 96px)` at 392 px with the long model name (offline Chrome read the folder icon at 63% there) — if every icon stays whole, the clip read is not following the overflow ancestors. Step 5\'s boxShadow MUST differ between drag-over and rest — if not, the drag never reached the composer.',
  runOnlyIf:
    'The packaged build carries the UB14.32 commit or later. Step 7 needs one model turn per runtime (the gateway, or the mock card on quota exhaustion).',
  doneMeans:
    'UB14.32\'s checklist row (the controller\'s) carries the verdict: the toolbar order and Send containment at 1400 and 700 px on Pi, claude-gateway and codex; the compact order; the draft type and the shared line box; the drop target; the collapsed spacer; UB12.78\'s four-icon floor and icon reads at 544 px and 392 px — each PASS/FAIL with its reading.',
  doNotConflate:
    'The card itself and its decision ring are UB14.27\'s; the Send/context/follow-up components are UB14.28\'s; the mode and model chips\' own look and menus are UB14.29/UB14.30\'s; the sources/folder/branch chips are UB14.31\'s; the hint line under the card is UB14.33\'s; the oversized-attachment refusal is UB4.14\'s.',
  safety:
    'No credentials read or printed. The dragged file is a small text file created under the fresh NESSY_CONFIG_DIR; the turns of step 7 are short ordinary prompts through the configured card.',
} as const satisfies SittingRecipe

if (import.meta.main) console.log(JSON.stringify({ meta, manual }, null, 2))
