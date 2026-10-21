/**
 * RS-140 (UB14.30) — the composer's model chip and menu, live and DARK, on Pi, Claude and Codex.
 *
 * ## The row
 *
 * UB14.30 renamed our `DesktopModelPickerMenu` (D1.214) to v0.15.1's `ComposerModelMenu` and moved the trigger into
 * it: the 28 px composer chip (`COMPOSER_CHIP`) naming the model, truncating first when the toolbar runs out of room,
 * the open fill, the destructive "Unavailable" state, upstream's menu rows (`text-label font-medium`, tertiary
 * descriptions, `size-4 text-secondary` checks). Ours re-applied on that look: the integration row above the list
 * (`ConnectionRow` — the three-runtime switch with its preview and `RuntimeSwitchDialog`, every target badged with its
 * runtime), `ModelListDisclosures`, the per-row translated and catalogue marks, the effort pill on the chip (the
 * level's own name, F1.1266), and — new in this row — only the effort levels the session's runtime honours
 * (`ComposerCapabilities.reasoning.levels`: six on Pi and api.anthropic.com, `off`–`high` on codex and the
 * claude-runtime gateway, none on nestor-cloud), in both pickers. The compact selector took v0.15.1's chip (a `Cpu`
 * glyph instead of the name under a 26rem panel) and 44 px sheet rows. The redesign rows owe "an arm in that area's
 * CDP screenshot case in DARK theme". This id is lane-picked (next free: `rs-139.ts` is the last case file and no
 * RS-140 appears in `scripts/`, `docs/testing` or `work/lane-reports`; the same search finds RS-139, the control),
 * NOT in `run.ts`'s `SITTING` (the checklist is controller-owned — the rs-121 rule), and the controller confirms it
 * at the pin. The DRIVE is the END-sitting wave's; this file is the recipe. The offline arms are
 * `composer-model-menu.test.tsx`, the `offeredThinkingLevels` arms in `model-picker-helpers.test.ts`, the retargeted
 * `model-list-disclosures.test.tsx` / `composer-effort-pill-i18n.test.ts` / `ultracode-toggle.test.ts` /
 * `parity-ui-registry.test.ts`, and the dark playground sweep's UB14.30 arm in `registry-render.test.ts`
 * (`parity-desktop-model-picker` in every state, now rendered for real; `parity-compact-model-selector`'s trigger).
 *
 * ## What the case proves
 *
 * The packaged app paints the chip on the composer's chip material with the effort pill naming the level, opens the
 * menu upward on v0.15.1's rows with our integration row first, badges each integration with its runtime, still
 * switches a session between runtimes (silently on an empty session, through the confirm dialog on one with history),
 * offers only the runtime's own effort levels (and no pill or effort menu where it has none), and folds the compact
 * chip to the Cpu glyph in a narrow panel.
 */

import type { CaseMeta, SittingRecipe } from '../lib/sitting.ts';

const ID = 'RS-140'
const TITLE =
  'the composer model chip and menu (DARK): the 28 px chip with the effort pill naming the level, the upward menu on v0.15.1 rows with our integration row first and every target badged with its runtime, a silent switch on an empty session and the confirm dialog with history, only the runtime\'s effort levels (none on nestor-cloud), and the compact chip\'s Cpu fold and sheet rows'

export const meta = {
  id: ID,
  title: TITLE,
  row: 'UB14.30',
  runtimes: ['pi', 'claude', 'codex'], // R4-10: three-runtime switching kept; the effort levels come from each runtime's capability set
  credentials:
    'none for steps 1–2 and 5 (no turn is sent: the chip and menu read the composer capability set and the configured connections). Step 3\'s history arm sends one short turn on the Nessy gateway Pi card; step 4 opens a session on claude-gateway and a codex card; the mock card stands in for a card whose quota is exhausted.',
} as const satisfies CaseMeta

export const manual = {
  steps: [
    '0. Land-check: the packaged build carries the UB14.30 commit or later. Launch by scripts/cdp/README.md\'s env -u launcher — fresh NESSY_CONFIG_DIR, DARK theme (owner rule), at least three connections configured (the Nessy gateway Pi card, claude-gateway, a codex card), an EMPTY Pi session open, the window ≥ 1400 px wide.',
    '1. THE CHIP: the model chip is the `[data-composer-actions] button[aria-haspopup="menu"]` that is NOT `[data-tutorial="permission-mode-dropdown"]` — EXPECT exactly one, getBoundingClientRect height 28, border-radius ≥ 14 px, the model\'s full name in a span with text-overflow: ellipsis, the connection icon before it (more than one connection), a ChevronDown after it, and `[data-effort-pill]` inside it reading the session\'s level by NAME (en "Medium", ru «Средняя»; never the id), its background = the computed --fill-hover. Hover the chip — EXPECT background = --fill-hover. Screenshot dark.',
    '2. THE MENU (Pi, empty session): click the chip — EXPECT `[role="menu"][data-state="open"]` ABOVE the chip (its bottom ≤ the chip\'s top), first the "Integration" group label (computed colour = --text-tertiary, no uppercase), then the integration toggle `button[aria-expanded]:not([role="menuitem"])` NOT disabled, naming the gateway with `[data-runtime-badge="pi"]`; click it — EXPECT one target row per configured connection, each with its `[data-runtime-badge]` (pi, anthropic, codex-runtime), the current one\'s background = --fill-selected with a check. Then the model rows `[role="menuitem"]` (height ≥ the computed --row-menu, the current model checked), the provenance line in --text-tertiary under them, the effort sub-trigger naming the level; hover it — EXPECT the sub-menu listing SIX levels (Off … Max) with the current one checked. Screenshot dark (integration open) and dark (effort sub-menu open).',
    '3. SWITCHING (unchanged semantics): on the EMPTY session pick the codex target — EXPECT no dialog, the menu closed, and the session on codex (the chip\'s icon and model follow; the session\'s connection read back through the app). Open a Pi session, send one short turn, then pick another runtime\'s target — EXPECT `RuntimeSwitchDialog` (its costs listed) — Cancel, EXPECT the session still on Pi.',
    '4. THE RUNTIME\'S OWN LEVELS: on the codex session and on a claude-gateway session open the menu — EXPECT the effort sub-menu listing exactly Off, Low, Medium, High (no Extra high, no Max) and the pill still naming the level. If a nestor-cloud card is configured (runOnlyIf): EXPECT NO `[data-effort-pill]` on its chip and NO effort sub-trigger in its menu. Screenshot dark (codex sub-menu).',
    '5. COMPACT (the mobile web UI or a window that renders the compact composer): the model trigger `button[aria-label^="Model:"]` — EXPECT height 28, rounded-full, the same tone as the desktop chip; shrink the panel under 416 px — EXPECT the Cpu glyph visible and the name span and chevron display: none, the aria-label still naming the full model. Open it — EXPECT the sheet\'s rows at ≥ the computed --row-touch (44 px), the section labels in --text-tertiary, the current model on --fill-selected with a check, the effort section listing the runtime\'s levels (four on codex), and the ultracode row where the runtime answers for it. Screenshot dark.',
    '6. Verdict, for the checklist row the controller writes: PASS when the chip reads 28 px round with an ellipsizing name and the pill naming the level, the menu opens upward with the integration row first and every target badged with its runtime, an empty-session pick switches silently and a with-history pick asks through the dialog, the effort sub-menu lists six levels on Pi and four on codex/claude-gateway (none on nestor-cloud, if run), and the compact chip folds to the Cpu glyph with 44 px sheet rows.',
  ],
  expected:
    'In the packaged app, dark theme: the composer toolbar carries a 28 px model chip naming the model with a quiet pill naming the effort level; it opens an upward menu whose first block is the integration row (each target badged Pi / Claude / Codex) and whose model rows wear v0.15.1\'s menu vocabulary; a pick on an empty session switches runtime silently and one with history asks through the confirm dialog; the effort sub-menu lists only the levels the runtime honours (six on Pi, four on codex and claude-gateway); the compact chip shows the Cpu glyph in a narrow panel and opens a sheet of 44 px rows.',
  detector:
    'DOM reads of the model chip (rect, computed border-radius, background-color on hover against the computed --fill-hover, the name span\'s text-overflow, `[data-effort-pill]` text and background), `[role="menu"][data-state="open"]` (rect against the chip\'s), the integration toggle (`disabled`, `aria-expanded`), every `[data-runtime-badge]` (attribute value and text), the target rows\' background against --fill-selected, the `[role="menuitem"]` rows (text, rect height against --row-menu), the effort sub-menu\'s rows (text), the session\'s connection and model through the app\'s own read, the presence of RuntimeSwitchDialog; the compact trigger\'s aria-label, rect and the Cpu glyph / name span display; screenshots only as the dark record.',
  positiveControl:
    'Step 2\'s Pi effort sub-menu MUST list more rows than step 4\'s codex one (six vs four) — if the counts are equal, the menu did not follow the runtime\'s capability answer and the "four" reading proves nothing. Step 2\'s expanded integration list MUST carry one `[data-runtime-badge]` per configured connection plus the head\'s — fewer means the read is of the collapsed head only.',
  runOnlyIf:
    'The packaged build carries the UB14.30 commit or later. Step 3 needs a codex card and one turn\'s quota on the Pi card (on a 429: switch coder/fast, then the mock card); step 4\'s nestor-cloud arm a nestor-cloud card; step 5 a compact composer surface.',
  doneMeans:
    'UB14.30\'s checklist row (the controller\'s) carries the verdict: the chip\'s computed material and pill, the menu\'s order, rows and badges, the silent and the confirmed switch, the effort levels per runtime, and the compact fold and sheet rows — each PASS/FAIL with its reading.',
  doNotConflate:
    'The toolbar ORDER (mode · model in the right-hand group) and the composer\'s own `@container/panel` are UB14.32\'s — until it lands the model chip sits in the grid footer\'s right group; `RuntimeSwitchDialog`\'s look is UB14.39\'s; which levels a runtime offers is the capability set\'s (`PROVIDER_DEFAULTS`), not this row; the context chip beside the model chip is UB14.28\'s.',
  safety:
    'No credentials read or printed. No turn is sent for steps 1–2, 4 and 5; step 3 sends one short turn on the Pi card. Connection switches go through the app\'s own picker under the fresh NESSY_CONFIG_DIR.',
} as const satisfies SittingRecipe

if (import.meta.main) console.log(JSON.stringify({ meta, manual }, null, 2))
