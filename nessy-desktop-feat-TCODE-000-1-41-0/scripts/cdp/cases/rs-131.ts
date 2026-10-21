/**
 * RS-131 (UB14.22) — the composer leaf files on v0.15.1's materials, live and DARK.
 *
 * ## The row
 *
 * UB14.22 moved the composer's leaf files onto upstream v0.15.1's materials: the context chip
 * (`FreeFormInputContextBadge`, on `COMPOSER_CHIP`, an ellipsis instead of the fade), the toolbar
 * status slot (`ToolbarStatusSlot`, the escape and browser overlays opaque on the raised fill under
 * an info / accent tint), the composer crash fallback (`InputErrorBoundary`) and the image-support
 * banner (`ImageSupportWarningBanner`, on the info tint). The redesign rows owe "an arm in that
 * area's CDP screenshot case in DARK theme"; this id is lane-picked (next free after RS-130; the
 * dispatch allocated none), NOT in `run.ts`'s `SITTING` (the checklist is controller-owned — the
 * rs-121 rule), and the controller confirms it at the pin. The DRIVE is the END-sitting wave's;
 * this file is the recipe. The offline arms are `composer-leaf-files.test.tsx`,
 * `learn-image-refusal-wiring.test.ts` and the playground's `composer-leaf-states` and
 * `image-support-banner` entries (dark sweep).
 *
 * ## What the case proves
 *
 * The leaves a user meets in the packaged app wear the new materials while OUR behaviour is
 * unchanged: the image banner offers its one-click enable only where the connection catalogue
 * decides the send (no action otherwise), it quotes the endpoint's own sentence when the
 * text-only flag was learned (P6.584), and the double-Escape interrupt still needs the second
 * press. The crash fallback has no live trigger (a render error) and stays offline.
 */

import type { CaseMeta, SittingRecipe } from '../lib/sitting.ts';

const ID = 'RS-131'
const TITLE =
  'the composer leaf files on v0.15.1 materials (DARK): context chips 28px round ghost pills with an ellipsis, the image banner on the info tint with its enable action only where it decides the send, the escape overlay opaque raised + info tint and still double-Escape, the browser banner raised + accent tint or the site color'

export const meta = {
  id: ID,
  title: TITLE,
  row: 'UB14.22',
  runtimes: ['pi'], // the leaves are runtime-neutral renderer files; one Pi session carries every arm
  credentials:
    'none for steps 1–2 (no turn is sent; step 2 needs a custom-endpoint connection whose model is marked text-only — a loopback endpoint is enough, nothing is called). Steps 3–4 send a turn: the Nessy gateway card, or the mock card when every gateway model is rate-limited.',
} as const satisfies CaseMeta

export const manual = {
  steps: [
    '0. Land-check: the packaged build carries the UB14.22 commit or later. Launch by scripts/cdp/README.md\'s env -u launcher — fresh NESSY_CONFIG_DIR, DARK theme (owner rule), a Pi session open with a working directory.',
    '1. CONTEXT CHIPS AT REST: read getComputedStyle on the attach chip (the paperclip button in the composer toolbar, no files staged): width 28px, border-radius ≥ 14px (a round target), transparent background, the icon in the --text-tertiary colour. Hover it — EXPECT background = the computed --fill-hover. Read the working-directory chip (a selection): its label span has text-overflow: ellipsis and NO mask-image (the old fade is gone). Open the Sources chip — EXPECT aria-expanded="true" on it and background = --fill-hover while the popover is open; close it — EXPECT the attribute gone. Screenshot dark.',
    '2. THE IMAGE BANNER: on a custom-endpoint connection whose current model is marked text-only, stage one image. EXPECT the banner above the attachment strip: background = the computed --info-tint, the triangle icon in --info, 12px text in --text-secondary, and the "Enable image support" action with min-height = --control-sm. Screenshot dark. Click the action — EXPECT the banner gone and the model\'s image toggle on in the picker (the same write as the picker row). Optional (runOnlyIf a learned refusal exists): on a model whose text-only flag was LEARNED from a refused turn, EXPECT a second italic line "The endpoint said: …" in --text-tertiary quoting the endpoint\'s sentence.',
    '3. THE ESCAPE OVERLAY: send a prompt that runs for a while ("Count slowly from one to forty, one number per line."). While it streams press Esc ONCE. EXPECT the overlay over the toolbar row: an opaque element (its computed background = --surface-raised, alpha 1) carrying an inner tint layer = --info-tint, the text "Press Esc again to interrupt" in --info with the Esc key cap. Screenshot dark. Wait without a second press — EXPECT the overlay to fade out and the turn to keep streaming. Press Esc twice quickly — EXPECT the turn interrupted.',
    '4. THE BROWSER BANNER (runOnlyIf the browser tool is available on this build): ask the agent to open https://example.com in its browser. While it controls the window EXPECT the toolbar banner "Using example.com": with no site theme color, an opaque --surface-raised element under an --accent-tint layer and --text text; on a site that declares a theme-color, that color as the background with white or black text by its luminance. Click it — EXPECT the browser window focused. Screenshot dark.',
    '5. THE CRASH FALLBACK has no live trigger (it needs a composer render error) — its arm is offline: composer-leaf-files.test.tsx (the raised card, the destructive ring, three actions, no crash reporter) and the playground composer-leaf-states "Crash fallback" variant in dark. Record it as OFFLINE, not as SKIPPED.',
    '6. Verdict, for the checklist row the controller writes: PASS when the chips read 28px round with an ellipsis and fill-hover on hover/open with aria-expanded, the banner reads the info tint with its enable action and the action clears it, the escape overlay is opaque raised + info tint and the turn survives one Escape but not two, and (if run) the browser banner reads raised + accent tint or the site color.',
  ],
  expected:
    'In the packaged app, dark theme: the composer\'s context chips are 28px ghost pills (round when icon-only) that ellipsize their label and show the fill-hover background on hover and while open (aria-expanded); the image banner sits on the info tint with an info icon and offers "Enable image support" on a custom-endpoint text-only model, the click clearing it; one Escape during a turn shows an opaque raised overlay with the info tint and the "Press Esc again" hint, and only the second press interrupts; the browser banner (if run) is raised under the accent tint, or the site\'s own color.',
  detector:
    'getComputedStyle readings on the live DOM (the chips\' width, border-radius, background on hover and while open, the aria-expanded attribute, the label\'s text-overflow and mask-image; the banner\'s background, icon colour and action min-height; the overlay\'s background and its tint layer; the browser banner\'s background) compared with the computed custom properties (--fill-hover, --text-tertiary, --info-tint, --info, --control-sm, --surface-raised, --accent-tint) on the same page; the turn state read from the transcript; screenshots only as the dark record.',
  positiveControl:
    'Step 2\'s click MUST clear the banner — if it stays, the instrument (staging, the connection, the banner read) is broken rather than the banner. Step 3\'s single Escape MUST leave the turn streaming and the double Escape MUST stop it — if neither stops it, the overlay is being read from a turn that already ended.',
  runOnlyIf:
    'The packaged build carries the UB14.22 commit or later. Step 2 needs a custom-endpoint connection with a text-only model (a loopback endpoint; no call is made). Steps 3–4 need a model turn (the gateway, or the mock card on quota exhaustion). Step 4 needs the browser tool on the build. The learned-refusal arm of step 2 needs a model whose text-only flag was learned from a refused turn.',
  doneMeans:
    'UB14.22\'s checklist row (the controller\'s) carries the verdict: the chips\' computed size/radius/background/aria readings, the banner\'s tint and action and the click clearing it, the escape overlay\'s material and the one-versus-two Escape control, the browser banner if run, and the crash fallback recorded OFFLINE with its two offline arms — each PASS/FAIL with its reading.',
  doNotConflate:
    'The chips\' label hiding on a narrow panel ([data-badge-label]) is UB14.32\'s toolbar and is not checked here; the sources chip\'s avatar stack and the working-directory popover are UB14.30\'s. The composer box\'s own radius and card material are UB14.27/UB14.32\'s. The banner\'s WHEN (which runtimes and models raise it) is resolveStagedImagePolicy\'s and unchanged by this row.',
  safety:
    'No credentials read or printed. Steps 1–2 make no model call; steps 3–4 send one ordinary turn each through the configured card. No config touched beyond the fresh NESSY_CONFIG_DIR and the operator-created custom connection.',
} as const satisfies SittingRecipe

if (import.meta.main) console.log(JSON.stringify({ meta, manual }, null, 2))
