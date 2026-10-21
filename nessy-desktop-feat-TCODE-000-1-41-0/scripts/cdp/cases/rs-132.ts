/**
 * RS-132 (UB14.27) — the composer as ONE raised card with the decision ring, live and DARK.
 *
 * ## The row
 *
 * UB14.27 replaced the Codex-parity glass composer (a squircle surface class, `bg-background/95
 * backdrop-blur-lg`) with upstream v0.15.1's card: `rounded-xl bg-raised`, `shadow-elev-1` (the
 * `shadow-elev-0` hairline in an unfocused panel), an instant `focus-within` tint ring, and on a
 * structured prompt the decision ring (`--info-border`, or `--destructive-border` for a call the
 * decision model labelled). The height swap uses the motion tokens and lands at once under reduced
 * motion. With it: the attachment strip on sunken tiles with a one-line name that keeps its
 * extension, and the background-finished chip ABOVE the card. The redesign rows owe "an arm in that
 * area's CDP screenshot case in DARK theme"; this id is lane-picked (next free after RS-131; the
 * dispatch allocated none), NOT in `run.ts`'s `SITTING` (the checklist is controller-owned — the
 * rs-121 rule), and the controller confirms it at the pin. The DRIVE is the END-sitting wave's;
 * this file is the recipe. The offline arms are `input-container-look.test.ts`,
 * `AttachmentPreview.test.tsx`, `BackgroundFinishedChip.test.tsx` and the playground sweep's UB14.27
 * arm in `registry-render.test.ts` (dark).
 *
 * ## What the case proves
 *
 * The packaged app paints the new card and swaps the ring by prompt kind, while OUR behaviour is
 * unchanged: a structured prompt is still clamped to the viewport (`structured-height`), an
 * answered permission card leaves at once (no exit animation), and a long paste keeps its restore
 * link.
 */

import type { CaseMeta, SittingRecipe } from '../lib/sitting.ts';

const ID = 'RS-132'
const TITLE =
  'the composer as one raised card (DARK): rounded-xl on the raised material with elev-1 (elev-0 unfocused), the focus tint ring in freeform, the info decision ring on a permission prompt (destructive on a risky call), the height landing at once under reduced motion, one-line attachment names keeping their extension, and the background-finished chip above the card'

export const meta = {
  id: ID,
  title: TITLE,
  row: 'UB14.27',
  runtimes: ['pi'], // the card is a runtime-neutral renderer file; one Pi session carries every arm
  credentials:
    'none for steps 1–2 and 6 (no turn is sent). Steps 3–5 and 7 send a turn: the Nessy gateway card, or the mock card when every gateway model is rate-limited.',
} as const satisfies CaseMeta

export const manual = {
  steps: [
    '0. Land-check: the packaged build carries the UB14.27 commit or later. Launch by scripts/cdp/README.md\'s env -u launcher — fresh NESSY_CONFIG_DIR, DARK theme (owner rule), a Pi session open with a working directory, the permission mode MANUAL (the card is the subject of steps 3–5, so not bypass).',
    '1. THE CARD AT REST (freeform): read getComputedStyle on the visible `.input-container` (in freeform there is exactly one): border-radius = the computed --radius-xl, background-color = --surface-raised, box-shadow = the --shadow-elev-1 value, backdrop-filter = none (the glass is gone), and its parent carries the class peer/composer. Click into the composer — EXPECT a 1px ring in the --focus colour at 55% to appear in the same frame (no colour transition). Screenshot dark.',
    '2. UNFOCUSED PANEL: open a second session in a split panel and focus it. EXPECT the first panel\'s card box-shadow = the --shadow-elev-0 hairline (not elev-1). Close the split.',
    '3. THE INFO RING: send "Run the shell command `ls -la` in the working directory." — EXPECT the permission card in the composer slot. Read the visible `.input-container` (NOT the aria-hidden measuring copy above it — two elements match the card selector, scripts/cdp/lib/ask-user.ts): its box-shadow carries a 1px ring in the computed --info-border colour and NO --focus ring; border-radius and background as in step 1. Screenshot dark. Deny the card — EXPECT the card gone in the same frame the answer lands (no exit fade) and the freeform card back with its focus ring.',
    '4. THE DESTRUCTIVE RING (runOnlyIf a decision model is configured so calls carry risk badges, UB6.10): send "Delete the folder ./tmp-rs-132 in the working directory." (create it first) — EXPECT the risk badge on the card and the visible `.input-container` ring in the computed --destructive-border colour, not --info-border. Screenshot dark. Deny it.',
    '5. REDUCED MOTION: Settings → Appearance → Motion = Reduced. Repeat step 3\'s prompt and sample the visible `.input-container` style height on each animation frame from the card\'s mount for 300 ms — EXPECT at most one distinct value after the first frame (the size lands at once; the content crossfade may still play). Then Motion = Full and repeat — EXPECT intermediate heights across ≥ 3 frames (the positive control). Restore Motion = System. Also with a short window (resize to ~600px tall) EXPECT the card height ≤ 70% of the viewport (our structured-height clamp, kept).',
    '6. ATTACHMENTS: create q3-planning-notes-for-the-gateway-migration.md and Makefile-for-the-release-rehearsal-pipeline in the working directory and stage both. EXPECT each name on ONE line: the first ellipsized in its stem with ".md" fully visible after it, the second ellipsized whole; the tiles on --surface-sunken; hovering a tile shows the remove dot, whose aria-label reads "Remove: <file name>". Paste a long text (over the paste-to-file threshold) — EXPECT a "Pasted text" chip whose "Show in text field" link puts the text back into the composer. Screenshot dark.',
    '7. THE CHIP ABOVE THE CARD (runOnlyIf Settings → Appearance → background session alerts is ON — it is OFF by default): start a turn in a second session, switch back to the first before it ends. When it finishes EXPECT the chip right-aligned with the card and ABOVE it (chip.bottom ≤ card.top − 8 px by getBoundingClientRect), on the --surface-floating material with the accent check; the draft text is not covered. Click it — EXPECT the finished session opened. Screenshot dark.',
    '8. Verdict, for the checklist row the controller writes: PASS when the card reads raised + rounded-xl + elev-1 (elev-0 unfocused) with no backdrop filter, the focus ring shows in freeform only, the permission card swaps in the info ring (destructive on a risky call, if run) and leaves at once, the height lands at once under reduced motion while Full animates, the structured card stays within 70% of a short window, the attachment names keep their extension on one line with a named remove dot and the paste restore works, and the chip (if run) sits above the card.',
  ],
  expected:
    'In the packaged app, dark theme: the composer is one raised card with a 16px radius and a quiet elev-1 lift (a hairline in an unfocused panel), no glass blur; focusing it shows an instant tint ring; a permission prompt replaces that ring with the info-border ring (the destructive-border ring for a call the decision model labelled) and leaves without a fade; under reduced motion the card\'s height jumps rather than animates; attachment tiles are sunken with one-line names that keep a short extension visible; the background-finished chip floats above the card and never over the draft.',
  detector:
    'getComputedStyle readings on the live DOM (the visible .input-container\'s border-radius, background-color, box-shadow and backdrop-filter; the ring colour inside its box-shadow; the tiles\' background; the name spans\' text-overflow; the remove dot\'s aria-label) compared with the computed custom properties (--radius-xl, --surface-raised, --shadow-elev-1, --shadow-elev-0, --focus, --info-border, --destructive-border, --surface-sunken, --surface-floating) on the same page; per-frame style.height samples for the motion arm; getBoundingClientRect for the chip; screenshots only as the dark record.',
  positiveControl:
    'Step 1\'s focus ring MUST appear on click and step 3\'s card MUST show a different ring colour from it — if both read the same, the reading is of the wrong element (the measuring copy). Step 5\'s Motion = Full run MUST show intermediate heights — if it does not, the sampler is too slow to see an animation at all and the reduced arm proves nothing.',
  runOnlyIf:
    'The packaged build carries the UB14.27 commit or later. Steps 3–5 need a model turn (the gateway, or the mock card on quota exhaustion) in MANUAL mode. Step 4 needs a configured decision model whose risk labels reach the card. Step 7 needs the Appearance preference switched on and a second session with a turn.',
  doneMeans:
    'UB14.27\'s checklist row (the controller\'s) carries the verdict: the card\'s computed material at rest, unfocused and focused; the info ring (and destructive ring, if run) with the no-fade exit; the reduced-versus-full height samples and the 70% clamp; the attachment name, tile and remove-dot readings with the paste restore; the chip position if run — each PASS/FAIL with its reading.',
  doNotConflate:
    'The card\'s CONTENT (the decision-card anatomy inside the permission prompt: tile, title, well, actions) is UB14.23–UB14.26\'s; the toolbar row, send button, model and mode chips are UB14.28–UB14.32\'s; the hint line under the card that reacts through peer/composer is UB14.33\'s. Whether a call carries risk badges is UB6.10\'s decision model, not this row.',
  safety:
    'No credentials read or printed. Steps 1–2 and 6 make no model call; steps 3–5 and 7 send ordinary turns through the configured card, and every permission card is DENIED (step 4\'s delete never runs). Files are created only in the session\'s working directory under the fresh NESSY_CONFIG_DIR.',
} as const satisfies SittingRecipe

if (import.meta.main) console.log(JSON.stringify({ meta, manual }, null, 2))
