/**
 * RS-130 (UB14.21) — the composer caret menus on the floating menu material, live and DARK.
 *
 * ## The row
 *
 * UB14.21 moved the `/` and `@` menus (and the deprecated skill menu, and the RichTextInput's
 * mention badges) onto upstream v0.15.1's `inline-menu-styles.ts` material in f386c80aa. The
 * redesign rows owe "an arm in that area's CDP screenshot case in DARK theme"; no composer case
 * exists yet, so this one is lane-picked (next free after RS-129; the dispatch allocated none),
 * NOT in `run.ts`'s `SITTING` (the checklist is controller-owned — the rs-121 rule), and the
 * controller confirms the id at the pin. The DRIVE is the END-sitting wave's; this file is the
 * recipe. The offline arms are `slash-command-menu.test.tsx`, `mention-menu.test.ts`,
 * `rich-text-input.test.ts` and the playground's `composer-caret-menus` entry (dark sweep).
 *
 * ## What the case proves
 *
 * The menus a user actually opens by typing wear the new surface in the packaged app (radius 12
 * from `popover-styled`, not the composer-derived radius; elevation 2; 30px rows; fill-hover
 * selection; tertiary section labels) while OUR behaviour is unchanged: the per-runtime command
 * set (`/approve` on codex only), argument hints, the description tooltip, the 40dvh cap, and
 * the mention badges' selection tint now following `--selection`.
 */

import type { CaseMeta, SittingRecipe } from '../lib/sitting.ts';

const ID = 'RS-130'
const TITLE =
  'the composer caret menus on the floating menu material (DARK): / and @ menus radius 12 + elev-2 with 30px rows and tertiary section labels, /approve still codex-only, argument hint and description tooltip kept, the 40dvh cap, mention badges on the raised surface taking the --selection tint'

export const meta = {
  id: ID,
  title: TITLE,
  row: 'UB14.21',
  runtimes: ['pi', 'codex'], // the look is runtime-neutral; codex and pi differ only in the /approve row (the control)
  credentials:
    'none for the look arms (no turn is sent: the menus open from typing). Step 4 needs a codex-runtime connection only to OPEN a codex session — still no model call.',
} as const satisfies CaseMeta

export const manual = {
  steps: [
    '0. Land-check: the packaged build carries f386c80aa or later. Launch by scripts/cdp/README.md\'s env -u launcher — fresh NESSY_CONFIG_DIR, DARK theme (owner rule), a Pi session open with a working directory.',
    '1. THE / MENU: type "/" into the empty composer. EXPECT the menu above the composer. Read getComputedStyle on the [data-inline-menu] element: border-radius 12px (popover-styled; NOT the composer-derived radius the menu wore before), a non-none box-shadow (elev-2), background = the computed --surface-floating. EXPECT a row ([data-inline-menu] [data-selected]) min-height 30px, the selected row\'s background = --fill-hover, and section headers ("Modes", "Commands") at 12px in the --text-tertiary colour, not upper-case. Screenshot dark for the record.',
    '2. KEPT BEHAVIOUR ON THE / MENU: type "/fix" against a workspace with a custom command carrying an argument-hint (any .nessy-agent/commands/*.md with argument-hint frontmatter). EXPECT the hint drawn between the label and the description; hover a long description — EXPECT the title tooltip with the full text (R15). With a short window (≤ 700px tall) EXPECT the list to scroll inside ~40% of the viewport height (our cap), not at 260px.',
    '3. THE @ MENU: type "@" then "src". EXPECT the same surface (radius 12, elev-2), sections (Skills, Agents, Sources, Files) with tertiary labels, file icons in the --text-secondary colour, and the selected row on --fill-hover. Screenshot dark.',
    '4. THE PER-RUNTIME CONTROL (/approve): in the Pi session type "/appr". EXPECT no Approve row (the menu closes or shows no match). Open a codex-runtime session and type "/appr". EXPECT the Approve row. The look merge must not have touched the per-runtime data (resolveExcludedCommandIds).',
    '5. MENTION BADGES: pick a skill from the @ menu so a badge lands in the composer. EXPECT the badge on the raised surface (computed background = --surface-raised) with the elev-0 shadow and 12px medium text. Select all the composer text (Cmd+A). EXPECT the badge background to become the computed --selection colour, matching the selected text around it; collapse the selection — EXPECT --surface-raised back. Screenshot both dark.',
    '6. PASTE (onTextPaste is inert until UB14.34): paste a one-line plain text — EXPECT it inserted as before; paste 150 lines — EXPECT the long-text attachment chip as before. Nothing new should appear (the console-snippet offer is UB14.34\'s).',
    '7. Verdict, for the checklist row the controller writes: PASS when both menus read radius 12px + a non-none shadow + 30px rows + tertiary 12px section labels in dark, the argument hint and the description tooltip and the 40dvh cap hold, /approve is offered on codex only, the badge takes --selection inside a selection and --surface-raised outside it, and both pastes behave as before.',
  ],
  expected:
    'In the packaged app, dark theme: the / and @ menus open on the floating menu material (radius 12, elevation 2, 30px rows, fill-hover selection, tertiary 12px section labels) instead of the composer-derived radius; our behaviour is unchanged (argument hints, description tooltips, the 40dvh cap, /approve offered on codex only); mention badges sit on the raised surface and take the --selection tint inside a selection; plain and long pastes behave exactly as before.',
  detector:
    'getComputedStyle readings on the live DOM ([data-inline-menu] border-radius and box-shadow, row min-height and background, section-header font-size, colour and text-transform, the .mention-badge background in and out of a selection) compared with the computed custom properties (--surface-floating, --fill-hover, --text-tertiary, --surface-raised, --selection) on the same page; the /approve row read from the menu DOM per session; screenshots only as the dark record.',
  positiveControl:
    'Step 4\'s codex session MUST show the Approve row — if neither session shows it, the instrument (typing, filter, menu DOM read) is broken rather than the exclusion working. Step 5\'s collapse back to --surface-raised proves the tint is driven by the selection, not painted permanently.',
  runOnlyIf:
    'The packaged build carries f386c80aa or later. Step 4 needs a codex-runtime connection configured to open the session (no turn is sent). Step 2\'s argument-hint arm needs a custom command with argument-hint frontmatter in the workspace.',
  doneMeans:
    'UB14.21\'s checklist row (the controller\'s) carries the verdict: the two menus\' computed radius/shadow/row/section readings in dark, the kept-behaviour arms (hint, tooltip, cap), the /approve partition across pi and codex, the badge tint in and out of a selection, and the two pastes — each PASS/FAIL with its reading.',
  doNotConflate:
    'The menus\' radius change is the logged R6-05 decision (the look follows upstream), not a regression of the composer\'s own radius — the composer box keeps its radius until UB14.27. The mode-chip menu (ComposerModeChip, bare + footer) is UB14.29\'s and is not opened here; onTextPaste has no reader until UB14.34, so step 6 checks only that nothing changed.',
  safety:
    'No credentials read or printed, no model call, no config touched beyond the fresh NESSY_CONFIG_DIR and an optional workspace command file the operator creates for step 2.',
} as const satisfies SittingRecipe

if (import.meta.main) console.log(JSON.stringify({ meta, manual }, null, 2))
