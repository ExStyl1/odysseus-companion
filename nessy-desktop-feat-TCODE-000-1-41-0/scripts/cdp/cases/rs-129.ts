/**
 * RS-129 (UB13.16) — the Phase 13 foundations sitting: seven presets × both modes with the
 * redesign's foundations measured live.
 *
 * ## The row
 *
 * UB13.16 is the foundations SITTING. Its id is lane-picked (next free after RS-128; the dispatch
 * allocated none), NOT in `run.ts`'s `SITTING` (the checklist is controller-owned — the rs-121
 * rule), and the controller confirms it at the pin. The DRIVE is the END-sitting wave's (the
 * owner's sitting policy); this file is the recipe. Everything it measures landed in this lane:
 * the theme switch f4dad307a + ThemeContext 15fbb68c5 (one release, no cut), Paper 237e6f3e0, the
 * 768px grid 65f730c32, typography ec1891295, the primitives 52b48eac3/5582cbd0c/bd748611a/
 * e3bd81cfb/6e04f2e19+abbbf7b26, the playground ff8a65944/222e5cf8d.
 *
 * ## What the case proves
 *
 * The solved theme set is AA-live in the shipped app (not only in the solver tests): every text
 * role computes ≥ 4.5:1 on its surface in all seven presets × both modes; the switch's global
 * values are really painted (16px root, codex accent #0078d3, dark navigator #101010, the
 * composer stroke); the theme context's three promises hold (live theme.json overrides, the
 * Motion setting across a restart, data-vibrancy only over a matching native material); the chat
 * column is 768px; the primitives screen renders dark for screenshots; the tooltip timing is
 * 500/300 because the app mounts the provider bare; reduced motion is honoured; and a page not
 * yet ported still renders through the legacy aliases.
 */

import type { CaseMeta, SittingRecipe } from '../lib/sitting.ts';

const ID = 'RS-129'
const TITLE =
  'the foundations sitting: 7 presets × 2 modes AA-computed, the switch values painted (16px root, codex #0078d3, dark navigator #101010), theme.json overrides live, Motion Reduced across a restart, data-vibrancy per OS match, the 768px column, dark Primitives screenshots, 500/300 tooltips, reduced motion honoured, legacy aliases still render'

export const meta = {
  id: ID,
  title: TITLE,
  row: 'UB13.16',
  runtimes: ['pi'], // runtime-neutral renderer case; the shell drives on any runtime
  credentials:
    'none: theme and appearance only. No model call is made by any arm; a fixture-free fresh NESSY_CONFIG_DIR.',
} as const satisfies CaseMeta

export const manual = {
  steps: [
    "0. Land-check: the packaged build carries f4dad307a + 15fbb68c5 (the switch and the context, one release) or later. Launch by scripts/cdp/README.md's env -u launcher — fresh NESSY_CONFIG_DIR, dark theme.",
    '1. COLD-START FLASH (the pre-paint arm): with the stored theme dark, launch and screenshot the first frame after reload. EXPECT: no light flash — index.html\'s pre-paint script replaces light with dark before first paint (UB13.3). Control: delete the nessy-theme key, relaunch — EXPECT the light first frame, proving the script reads the key rather than always painting dark.',
    "2. THE SEVEN PRESETS × BOTH MODES, AA-COMPUTED: for each of default, paper, codex, github, haze, nord, one-dark-pro, vitesse — eight themes (our six + Paper + Default) — set theme and mode from Settings > Appearance and read computed styles on a chat page: every text role (--text, --text-secondary, --text-tertiary) over --surface-paper and --surface-navigator computes ≥ 4.5:1 (walk the pairs in DevTools; the solver test pins the same 15 checks offline). EXPECT 16 preset×mode arms, all ≥ 4.5:1.",
    "3. THE SWITCH VALUES PAINTED (UB13.3's sitting record): on codex/dark read computed --accent-solid (EXPECTED #0078d3 — the AA-solved primary; the raw #339cff is gone), --surface-navigator (EXPECTED #101010), --elevation-stroke (the color-mix stroke, not the old rgba triplet), and html font-size (EXPECTED 16px — the 15px pre-redesign root is gone). Repeat --surface-navigator on default/light (EXPECTED #f2f3f4 = BACKGROUND_HEX.light).",
    "4. THEME.JSON LIVE (UB13.4 arm a): write {\"accent\": \"#e5484d\"} to <config dir>/theme.json while the app runs on Default and then on codex. EXPECT the computed --accent and --accent-solid change live in both, without a restart (the provider injects overrides even on the default theme). Remove the file; EXPECT the solved values return.",
    "5. MOTION REDUCED ACROSS A RESTART (UB13.4 arm b): Settings > Appearance > Motion → Reduced. EXPECT html[data-motion=\"reduced\"] present. Restart the app. EXPECT the attribute survives (the theme record persisted it; a stored prefersReducedMotion=true migrates to the same state one-way — check the old nessy-prefersReducedMotion key is GONE after a migrated launch).",
    "6. DATA-VIBRANCY (UB13.4 arm c, macOS): with the OS in dark and the app in system mode EXPECT html[data-vibrancy] present (translucent canvas over the native material). Force the mode to the OPPOSITE of the OS (light app on dark OS). EXPECT data-vibrancy ABSENT — the canvas paints solid because the material no longer matches what we paint.",
    "7. THE 768PX COLUMN (UB13.18): on a chat with a long turn, measure the transcript column width. EXPECT 768px max (the 840px pre-redesign column is gone), turn spacing 20px (gap-5).",
    "8. PRIMITIVES SCREENSHOTS (UB13.19's visual arm, DARK): open the design playground (design-system entry), navigate Primitives → Buttons, Fields, Menu, Dialog. Screenshot each in dark — the design surface's record for the redesign review. The Design Tokens entry shows a swatch for every solver role.",
    "9. TOOLTIP TIMING 500/300 (UB13.9's live arm): hover a header icon button. EXPECT the tooltip after ~500ms; move to a neighbouring icon button — EXPECT instant (the 300ms skip window). The app mounts TooltipProvider BARE (the delayDuration={0} override was dropped in UB13.9); a near-instant tooltip here is a REGRESSION.",
    "10. REDUCED MOTION HONOURED: with Motion Reduced (step 5), open the command palette and a dropdown. EXPECT enter animations reduced to fades (no springs/slides); toasts fade only.",
    "11. LEGACY ALIASES (the not-yet-ported page): open a page still on pre-redesign classes (Settings > Connections is unported at this wave). EXPECT it renders correctly — tokens.css's legacy alias block answers the old class names; no invisible text, no unstyled controls. Screenshot for the record.",
    "12. Verdict, for the checklist row the controller writes: PASS when all 16 preset×mode text pairs compute ≥ 4.5:1, the switch values read #0078d3/#101010/16px/color-mix-stroke, theme.json changes --accent live on two presets, Motion Reduced survives a restart (with the one-way migration noted if it fired), data-vibrancy tracks the OS match, the column is 768px, the four Primitives screenshots are taken dark, tooltips wait ~500ms and skip within 300ms, reduced motion holds, and the unported page renders through the aliases.",
  ],
  expected:
    'All seven bundled presets plus Default, in both modes, compute AA text roles live in the packaged app; the redesign switch values are really painted (16px root, codex #0078d3 accent-solid, #101010 dark navigator, the color-mix elevation stroke); theme.json overrides apply live on the default and preset themes; the Motion setting persists across restart with the one-way P6.473 migration; data-vibrancy appears only when the native material matches the painted mode; the transcript column is 768px; the Primitives screen screenshots dark; tooltips run 500/300; reduced motion is honoured; and a page not yet ported renders through the legacy aliases.',
  detector:
    'Computed styles read from the live DOM (getComputedStyle on the roles, surfaces, accent, stroke and root font-size — numbers, not screenshots) plus contrast arithmetic on those readings; the persisted theme record and the absence of the migrated key read from localStorage/config dir; element attributes (data-motion, data-vibrancy) read directly; screenshots only for the Primitives record and the flash arm. The offline arms of the same invariants: theme-roles.test.ts (28→30 pass), materials.test.ts, typography.test.ts.',
  positiveControl:
    'Step 1\'s light-first-frame control proves the pre-paint script reads the key; step 3\'s #0078d3 fails loudly if the solver stopped running (the raw #339cff reappearing means the switch regressed); step 4\'s override-removal returning the solved values proves the override path, not a stale style tag; step 9\'s near-instant tooltip would prove the dropped override came back.',
  runOnlyIf:
    'The packaged build carries the switch + context release (f4dad307a/15fbb68c5+). The data-vibrancy arm is macOS-only (Windows Mica is UB14.47\'s; without a native material the attribute is correctly absent everywhere). The playground arms need the packaged app\'s design-system entry point.',
  doneMeans:
    'UB13.16\'s checklist row (the controller\'s) carries the verdict: the 16 AA arms, the four switch readings, the live-override arm on two presets, the restart-surviving Motion setting, the vibrancy match, the 768px column, the four dark Primitives screenshots, 500/300 tooltips, reduced motion, and the legacy-alias page — each PASS/FAIL with its computed number.',
  doNotConflate:
    'The contrast numbers are COMPUTED from getComputedStyle pairs, not eyeballed from screenshots — a screenshot-only arm cannot fail at 4.49:1. The Motion setting governs OUR UI motion (OQ-R5.1 (a)); Claude Code CLI motion is out of scope for this case. A missing data-vibrancy on Windows is the row\'s stated correct interim (UB14.47 implements the material), not a failure.',
  safety:
    'No credentials, no network beyond the app\'s own startup, no config touched beyond the fresh NESSY_CONFIG_DIR and the step-4 theme.json (fixture hex only, deleted in the same arm).',
} as const satisfies SittingRecipe

if (import.meta.main) console.log(JSON.stringify({ meta, manual }, null, 2))
