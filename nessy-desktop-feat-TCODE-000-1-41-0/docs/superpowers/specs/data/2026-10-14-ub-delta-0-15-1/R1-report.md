# R1 — Design foundations of the v0.15.0 redesign (v0.14.0 → v0.15.1)

Reader R1, read-only, 2026-10-14. Ours: `feat/TCODE-000-1-41-0` at `f495cf311` (working tree untouched). Upstream: `.references/craft-agents-oss` read by tag only.

These rows are the FIRST rows of Phase 13 (the redesign). R6 (primitives), R2 (shell/panels), R4 (composer), R5 (settings) and B3's slices all name "R1-tokens" as their prerequisite. B3 and R6 are built on, not redone.

**Instruments.** All of them live in the session scratchpad (`…/scratchpad/r1/`). Move them under `docs/superpowers/specs/data/` with the plan (UB1.1 rule).

1. `git diff v0.14.0 v0.15.1` for every assigned path. I also diffed ours against v0.14.1, brand-normalised.
2. **Guardrail counter** (`scripts/count.cjs`, `perfile.cjs`). It runs the two v0.15.1 rule files through our installed ESLint 9.39.4 `Linter` and `@typescript-eslint/parser` over three trees: ours at HEAD, upstream v0.14.1 and upstream v0.15.1. Upstream trees were extracted with `git archive`.
   - Positive control: the string `'bg-red-500 transition-all'` gives exactly two reports.
   - First run returned 0 everywhere, because an absolute `filename` matched no flat config. That reading was discarded.
3. **Solver run** (`scripts/solve.mts`). It runs the v0.15.1 `theme-roles.ts` and `theme.ts` (pure modules, node 24 type stripping) over our six preset files. The AA and hue-drift checks are the same as upstream's `theme-roles.test.ts`.
4. **Removed-token scan.** It lists class and custom-property names defined in v0.14.1's `renderer/index.css` + `ui/styles/index.css` that are absent from v0.15.1's `tokens.css` + `base.css` + `renderer/index.css`. Each name is then searched in our TSX, with the same count on upstream v0.15.1 as control.
5. **Token-class usage.** `git grep -P` (not `-E`: `-E` ignores `\b` and returned 0 on both sides — instrument failure, discarded). Ours = 0 hits; positive control upstream v0.15.1 = 1059 hits in 207 files.

## 1. Summary

1. **Upstream's design system** is one file, `packages/ui/src/styles/tokens.css`. It has five layers:
   - **Theme input:** the 6-colour contract.
   - **Derived roles:** surfaces navigator/paper/raised/sunken/floating, the text tiers, status/accent text + solids, focus ring and control border. These are solved per theme by `packages/shared/src/config/theme-roles.ts`; the default theme's values are static.
   - **Alpha roles:** `color-mix` fills, borders and tints.
   - **Static scales:** the type roles `caption…display`; radii 4/6/8/12/16/20; sizes `h-control*`/rows/`gutter`; elevation `elev-0…3`; motion durations, easings and springs as CSS `linear()`; the z-scale.
   - **Legacy aliases:** the shadcn and pre-redesign names, kept "until the class codemod lands".

   `base.css` holds the materials (`field-surface`, `popover-styled`, `keycap`, `switch-track`, `skeleton`), the `motion-*` classes, the focus ring and the reduced-motion rules. `packages/ui/src/motion` is the TypeScript mirror (SPRING/TWEEN/FLIP/MotionPreference). There are no design docs in the repo: the "design spec §x" and "implementation plan A0" that upstream comments cite are not shipped (`git ls-tree` v0.15.1 has no design/guardrail document; root and package CLAUDE.md add nothing on design).
2. **"Solved for contrast"** means every text-bearing role is solved against the worst surface it can sit on, hover/selected fills included. Targets: text 4.5, secondary 7, tertiary 4.6, control/focus 3, on-solid 4.5. Status hues may drift at most 12°. The test asserts AA for every bundled preset × mode.
   - For ours I ran the v0.15.1 solver over our six presets: **11/11 preset×mode pass AA, 0 hue drift**.
   - **Visible effects on ours:**
     - Codex accent `#339cff` (white on it is 2.86:1) becomes `#0078d3` on primary buttons, in both modes.
     - GitHub dark, haze, nord light, one-dark-pro and vitesse dark solids darken.
     - codex.json's `paper`/`navigator`/`popover` keys finally take effect. Today they are emitted but nothing consumes them (`var(--paper)`, `bg-paper`: 0 uses at HEAD).
3. **Theme sets.**
   - Upstream v0.14.1 has 15 presets; v0.15.1 has 17 (adds `craft`, `paper`; `default` gets new values and the name "Craft Agents"; `solarized` gets an AA foreground).
   - Ours has 6: `codex` (ours), `github`, `nord`, `one-dark-pro` and `vitesse` (byte-identical to upstream), and `haze` (author line only).
   - We retired 10 upstream files, `default` and `solarized` among them (`storage.ts:3921-3932`).
   - The upstream changes to `default.json` and `solarized.json` therefore reach us only through `DEFAULT_THEME` and the static `tokens.css`.
4. **Guardrail lint: adopt 1:1 at `warn`.**
   - At HEAD the two rules raise **≈221 warnings**:
     - apps/electron: palette 119 + motion 63;
     - packages/ui: motion 24 + palette 15.
   - For comparison: upstream v0.14.1 had 227 and v0.15.1 has 60. About 31 of ours sit in our own files.
   - Our `lint-package.ts` does not fail on warnings, so lint stays green.
   - The shadow allow-list must also gain `shadow-elev-0…3`. That rule is at `error`, so the allow-list change must come before any row that brings upstream classes.
5. **Hidden global changes the foundation brings:**
   - root font-size 15→16px: every rem size grows 6.7%;
   - radii go up one step (`rounded-lg` 8→12px);
   - `shadow-sm…2xl` are remapped onto the elevation scale;
   - **the `--*-rgb` triplets are removed**, and `.shadow-tinted` now takes a colour. That breaks 45 references in 18 of our files unless they are swept in the same commit.
6. **Nine rows**, dependency-ordered. The heavy one is R1-03 (L). The others are XS–M.

## 2. Proposed rows (dependency order; Phase 13, ids to be renumbered UB13.n)

Common to every row:
- **Runtimes:** runtime-neutral (renderer, shared config and lint; no runtime reads these files).
- **i18n:** none of these rows adds a user-facing string. ThemeGrid takes its labels as props; R5-08 owns the Motion and Appearance keys (en+ru).
- **Barrel trap (R6):** every new consumer imports `@nessy-agent/ui/motion` or `@nessy-agent/ui/utils` (subpaths), never the barrel.
- **Visual verification:** playground sweep in DARK first, then light. Themes: default, codex, nord (dark), haze (dark-only). Plus one CDP screenshot case per visual row; RS ids are allocated by the controller at dispatch.

**R1-01 `[lint]` `[design]` Design guardrail rules 1:1 at warn + elevation allow-list (S).**
- **Needs:** none. It must land BEFORE:
  - any row that brings upstream `shadow-elev-*` classes (our `no-nonstandard-shadows` is `error`);
  - any row that brings `PageFrame.tsx`, whose `// eslint-disable-next-line craft-styles/no-raw-palette-colors` would otherwise name an undefined rule.
- **Upstream:** v0.15.1 ADDED `packages/ui/eslint-rules/{no-motion-antipatterns,no-raw-palette-colors}.cjs` and `__tests__/design-guardrails.test.ts`; `packages/ui/eslint.config.mjs` and `apps/electron/eslint.config.mjs` (+13 / +22 lines). Mechanism:
  - both rules register under the style plugin at `warn`;
  - the palette rule is `off` for `src/renderer/playground/**`;
  - the shadow allow-list gains `shadow-elev-0…3` and `shadow-dragging`.
- **Files (ours):** the three added files; `packages/ui/eslint.config.mjs` (div 14); `apps/electron/eslint.config.mjs` (B3's path, taken here).
- **Method:** add the three files 1:1 with the rule prefix renamed `craft-styles`→`nessy-styles` (test, configs, the `@craft-agent/ui/motion` hint in a rule message → `@nessy-agent/ui/motion`). Re-apply our config hunks.
- **Keep:**
  - plugin name `nessy-styles`;
  - `linterOptions.reportUnusedDisableDirectives: 'error'` in `packages/ui` (P2.229);
  - our `shadow-dragging` entry with its UA2.3 comment (`apps/electron/eslint.config.mjs:164`);
  - the "temporary exceptions" block (`:183-194`).
- **Tests:** `packages/ui/eslint-rules/__tests__/design-guardrails.test.ts` (copy + source header).
  - Positive: `"flex transition-all"`, `{transition:'all 200ms'}`, `bg-indigo-500`, `dark:bg-foreground/10` and `visualDuration` without `bounce` are each flagged once.
  - Negative: `transition-colors`, `text-secondary`, `dark:text-sm` and `visualDuration`+`bounce` are not flagged.
  - Gate: `check-typecheck-coverage --tests` lists the new test in a TS program.
- **Done means:** `bun run lint` exits 0 with 0 errors. The tracker note records the warning count the row's own `lint-package` run prints. Expected ≈182 (apps/electron) + ≈39 (packages/ui), read 2026-10-14 by the scratch counter.
  - Top shared files: `kanban/TaskEditor.tsx` 15, `AiSettingsPage.tsx` 11, `LeftSidebar.tsx` 9, `TurnCard.tsx` 8.
  - Ours-only: `TaskActionMenu.tsx` 8, `import/ClaudeImportPanel.tsx` 7, `pages/PageRefreshBar.tsx` 4, `input/QueuedMessageList.tsx` 3, `lib/source-card.ts` 3.
  - Level stays `warn` 1:1. No ratchet is invented; R1-09's close-out re-reads the count.

**R1-02 `[ui]` `[design]` `[motion]` Inert foundations: token files, contrast solver, motion package, token-aware `cn` (M).**
- **Needs:** R1-01 (so the new files are linted under the guardrails).
- **Upstream:** v0.15.1 ADDED:
  - `packages/ui/src/styles/tokens.css` (491 lines) and `base.css` (530);
  - `packages/shared/src/config/theme-roles.ts` (558; pure, no imports);
  - `packages/ui/src/motion/{index,presets,flip,FlipOnChange,MotionPreference}` and `__tests__/{presets,flip}.test.ts`;
  - `packages/ui/src/lib/utils.ts` (`extendTailwindMerge` with `TOKEN_SCALES`) and `lib/__tests__/utils.test.ts`;
  - `packages/ui/package.json` exports `./motion`, `./utils`;
  - `apps/electron/src/renderer/lib/utils.ts`, which becomes `export { cn } from "@craft-agent/ui/utils"` (R7's path, taken here because the two `cn`s must agree).
- **Why inert:**
  - nothing in the app imports `tokens.css`/`base.css` until R1-03 (only the tests read them);
  - nothing imports `theme-roles.ts` or `motion` yet;
  - the `cn` extension only changes merging of token class names, and HEAD uses none of them (`git grep -P` count 0; positive control upstream 1059/207 files).
- **Files (ours):** the added paths above; `packages/ui/src/lib/utils.ts` (div 0); `packages/ui/package.json` (div 12); `apps/electron/src/renderer/lib/utils.ts`.
- **Method:** take/add 1:1 with the rebrand (`@nessy-agent/ui/motion` in docblocks; the `tokens.css` header and the default-theme comment say Nessy/"Default", not "Craft Agents"). `package.json`: add the two exports only.
- **Keep:** in `packages/ui/package.json`, our `version` 1.0.2, `description`, and our eight extra subpath exports (`./chat/PublishedArtifactChip`, `./chat/task-checklist`, `./chat/tool-elapsed`, `./overlay/DocumentFormattedMarkdownOverlay`, `./icons`, `./ui/LoadingIndicator`, `./ui/StyledDropdown`, `./ui/tooltip`). These are the barrel-trap subpaths.
- **Tests:**
  - `motion/__tests__/presets.test.ts`, positive: durations, easings and springs equal the `tokens.css` `--dur-*`/`--ease-*`/`--spring-*` values. Boundary: every `visualDuration` preset carries `bounce`.
  - `flip.test.ts`, positive: a 232px move gives the inverse translate. Negative: an unmoved rect gives `null`.
  - `lib/__tests__/utils.test.ts`, positive: `cn('text-label','text-secondary')` keeps both. Boundary: `cn('h-7','h-control')` gives `h-control`, and every `TOKEN_SCALES` entry is declared in `tokens.css`.
  - Gates: `lint:exports-map` green for the two new subpaths; `typecheck:ui` and the electron typecheck green.
- **Done means:**
  - the added files equal v0.15.1 modulo brand;
  - both `cn`s resolve to one implementation;
  - `tokens.css`/`base.css` are imported only by tests (`git grep -F 'styles/tokens.css'` lists test files only).

**R1-03 `[design]` `[theme]` Switch to the token layer: solved themes, new `renderer/index.css`, rgb-triplet sweep (L).**
- **Needs:** R1-02.
- **Ships in the same release as R1-04.** From this row on, `base.css` paints `html` with the opaque navigator surface. Translucency (macOS vibrancy) only returns once R1-04 and R7's vibrancy row set `data-vibrancy`, so no release may be cut between the two.
- **Upstream:**
  - **`packages/shared/src/config/theme.ts`** (v0.15.1):
    - `themeToCSS` emits the 6 inputs plus every solved role. It no longer emits `--foreground-rgb`/`--accent-rgb`/`--paper`/`--navigator`/`--popover-solid`/`--theme-mode`. The theme's `input` key becomes `--surface-input`, never shadcn's `--input` border.
    - `resolveTheme(...layers)` is variadic.
    - new `resolveThemeRoleInput`.
    - new `DEFAULT_THEME`, and `BACKGROUND_HEX` = the default navigator `#f2f3f4`/`#0d0e10`.
  - **`packages/shared/src/config/__tests__/theme-roles.test.ts`** (added).
  - **`validators.ts`:** only the `collectThemeColorWarnings` hunk. Its label `valueType` hunk is B4's.
  - **`apps/electron/src/renderer/index.css`** (+170/−998):
    - imports `tokens.css` + `base.css`;
    - adds `@source "../../../../packages/ui/src/lib/**"`;
    - drops the `:root`/`.dark` palettes, the `@theme` block, `html[data-theme-override]`/`[data-theme-mismatch]` canvases, the dead `.session-/source-/import-separator` rules and `animate-shake`;
    - restyles sonner, scenic, onboarding and container queries.
  - **`packages/ui/src/styles/index.css`:** a 16-line entry for viewer/marketing.
  - **`annotation-style-tokens.ts`:** `--shadow-color: var(--info)`.
  - **Playground:** `registry/custom-shadows.tsx` (`var(--accent)`), and the pre-paint dark-class script in `playground.html` (`index.html` is R7's path; whichever row lands first takes both).
- **rgb-triplet sweep (same commit; otherwise the properties are invalid and dropped).** 45 `var(--{accent,destructive,foreground,info,success}-rgb` references in 18 files. Upstream has 0 and none of these vars is defined any more.
  - `ActiveOptionBadges` 7, `input/CompactPermissionModeSelector` 6, `ui TurnCard` 5, `Info_Badge` 4;
  - 2 each: `OverlayErrorBanner`, `SystemMessage`, `annotation-style-tokens`, `registry/entity-lists`, `entity-list-label-badge`, `AuthRequestCard`, `CompactSessionListFilter`, `ChatDisplay`, `AppShell`;
  - 1 each: `MultiDiffPreviewOverlay`, `registry/custom-shadows`, `input/ToolbarStatusSlot`, `input/CompactModelSelector`, and ours-only `registry/runtime-switch.tsx`.

  Rules: `rgba(var(--X-rgb), a)` → `color-mix(in srgb, var(--X) a%, transparent)` (foreground uses `--fg-base`); `--shadow-color`/`shadowVar`/`shadowColor: 'var(--X-rgb)'` → `'var(--X)'`. These are exactly upstream's own replacements; for example `entity-lists.tsx` becomes `color-mix(in srgb, var(--fg-base) 5%, transparent)`.
- **Files (ours):**
  - `packages/shared/src/config/{theme.ts (div 0), validators.ts, __tests__/theme-roles.test.ts}`;
  - `apps/electron/src/renderer/index.css` (1535 lines, div 52);
  - `packages/ui/src/styles/index.css` (div 4);
  - the 18 sweep files;
  - `playground.html`;
  - `components/ui/__tests__/system-card-sticky-band.test.ts`.
- **Method.**
  - `theme.ts`, `ui/styles/index.css`, `annotation-style-tokens.ts`, `custom-shadows.tsx`: take 1:1.
  - `renderer/index.css`: take v0.15.1, then re-apply exactly four hunks (see Keep).
  - `validators.ts`: hunk-only (ours is 638 diff lines away from v0.14.1).
  - The sweep: line edits only. Each file's own surface row later takes the full upstream file.
- **Keep (renderer/index.css):**
  1. `@source "../renderer/lib/**/*.{ts,tsx,jsx}"` with its 2026-08-01 docblock (`index.css:10-18`). The measured drop of `text-violet-600` from `lib/source-card.ts`; upstream still does not scan `renderer/lib`.
  2. The Codex-parity composer tokens (`:129-136`). Move them to a renderer `:root` block after the imports and rewrite `--elevation-stroke` as `0 0 0 0.5px color-mix(in srgb, var(--fg-base) 14%, transparent)`.
  3. `.mask-fade-right` (`:598-605`), next to `base.css`'s `.mask-fade-y`/`-bottom`.
  4. `.composer-surface` + `corner-shape` and `.composer-footer` container (`:1514-1535`).

  Consumers of 2–4: `FreeFormInput`, `InputContainer`, `composer-parts`, `AttachmentPreview`, `mention-menu`, `slash-command-menu`, `ByoRuntimeStep`, `registry/background-finished-chip` (`git grep -P` count).

  Dropped as upstream, not kept: `html[data-theme-override]::before` and `[data-theme-mismatch]` (`:331`, `:342`, `:389`). `base.css` `html[data-vibrancy]` replaces them, and nothing else reads them (`git grep`: index.css only).
- **Keep (theme set):** no `default.json`/`solarized.json`/`craft.json` file. `RETIRED_BUNDLED_THEME_FILES` (`storage.ts:3921-3932`) is unchanged.
- **Tests.**
  - **`theme-roles.test.ts`** (copy + adapt, source header). Positive:
    - every OUR bundled preset × supported mode meets AA on all 15 checks with hue drift ≤ 12° (measured with the v0.15.1 solver: 11/11 pass, 0 drift);
    - the `tokens.css` static `:root`/`.dark` blocks equal `deriveThemeRoles(DEFAULT_THEME)`;
    - `BACKGROUND_HEX` equals the default navigator;
    - `themeToCSS` emits no `-rgb` triplet;
    - the `input` key is emitted as `--surface-input`.

    Negative/boundary:
    - the "ships the new built-ins" case, adapted to ours: contains `codex`, does NOT contain `default` or `craft`;
    - a light-only theme in dark mode is solved as light;
    - an unparseable colour falls back to the default, and `validators` warns (one warning, `path: 'dark.accent'`).
  - **New `packages/ui/src/styles/__tests__/no-rgb-triplets.test.ts`:** a source scan of `apps/electron/src` + `packages/ui/src`. Zero `var(--(accent|destructive|foreground|info|success)-rgb` (the five names `tokens.css` no longer defines). Positive control: the same regex matches the literal `rgba(var(--accent-rgb), .5)`.
  - **Retarget `system-card-sticky-band.test.ts` (C3.248).** It reads `--muted`/`--foreground-5` from `renderer/index.css`'s `:root`/`.dark` blocks (`:30`, `:66-80`), and those now live in `tokens.css`'s legacy alias block (`:root, .dark { … }`). Keep both assertions. `--muted` = `var(--fill-hover)`, a `color-mix` with transparent, so still translucent; `--foreground-5` is an opaque mix against `--background`. Re-point the file read and the block selector.
  - **Visual.** Playground sweep in dark, then light, over default/codex/nord/haze: every entry that renders our composer, tinted chips (`ActiveOptionBadges`, permission-mode selector, `Info_Badge`), Custom Shadows and Toasts.
  - **CDP case** (packaged build, dark, bypass): screenshot of a session with our composer visible, a tinted mode chip and an open dropdown. Read back computed `--surface-navigator`, `--accent-solid`, `--elevation-stroke` and `html` `font-size` (expected `16px`).
- **Done means:**
  - `renderer/index.css` = v0.15.1 + the four named hunks;
  - the sweep guard is green;
  - `theme-roles.test.ts` is green over our set;
  - full typecheck of shared/ui/electron is green (shared-config risk trigger);
  - the CDP case's computed values are recorded. Expected for codex: `--accent-solid` `#0078d3`; dark `--surface-navigator` `#101010`.

**R1-04 `[theme]` `[motion]` `[a11y]` ThemeContext + useTheme 1:1: theme.json overrides, Motion preference, data-vibrancy (M).**
- **Needs:** R1-03, plus R7's vibrancy row (B3-17 → UB4.11):
  - `getWindowVibrancy()` in `preload/bootstrap.ts`;
  - `--nessy-window-vibrancy=` argv from `window-manager.ts`, Mica only at build ≥ 22621;
  - the `ElectronAPI` type.

  Without it, `getWindowVibrancy?.()` is `undefined`. The canvas then stays opaque on every OS: correct, but no translucency.
- **Upstream:** v0.15.1 `apps/electron/src/renderer/context/ThemeContext.tsx` (+115) and `hooks/useTheme.ts` (−42). Mechanisms:
  - `theme.json` overrides are loaded in the provider (`getAppTheme`/`onAppThemeChange` → `resolveTheme(preset, overrides)`) and injected even on the default theme;
  - `motion: 'system'|'reduced'|'full'` is persisted in the theme record, broadcast cross-window, and applied through `MotionPreferenceProvider` (`MotionConfig reducedMotion` + `html[data-motion]`);
  - `data-vibrancy` replaces `data-theme-override`/`data-theme-mismatch`. The canvas is translucent only over a native material whose appearance matches.

  Type-only wire hunks:
  - `apps/electron/src/shared/types.ts` `broadcastThemePreferences`/`onThemePreferencesChange` `motion?: string` (ours `:1230-1231`);
  - `packages/shared/src/protocol/events.ts` `PREFERENCES_CHANGED` (`:34`);
  - `packages/server-core/src/handlers/rpc/workspace.ts` `BROADCAST_PREFERENCES` param (`:331`).

  The `App.tsx` hunk drops `useTheme({ appTheme })` and the dead `appTheme` state/effect (`App.tsx:339`, `:414`, `:831-837`; B3-21, App.tsx is R7's path, take this hunk only).
- **Files (ours):** `ThemeContext.tsx` (535 lines, div 0); `useTheme.ts` (div 0); the three wire files; `App.tsx` hunk.
- **Method:** take 1:1 + rebrand (`@nessy-agent/ui/motion`; comments `~/.nessy-agent/theme.json`).
- **Keep:**
  - the theme record key stays `nessy-theme` (`lib/local-storage.ts:6` `PREFIX = 'nessy-'`, `:33`); the pre-paint script from R1-03 reads the same key;
  - our bundled-theme fallback (`ThemeContext.tsx:77-82`, identical upstream).
- **Tests.** `bun test` has no DOM here (`input/__tests__/double-escape.test.ts:17`), so the provider is covered at its pure seams and live.
  - New `packages/ui/src/motion/__tests__/motion-preference.test.ts`. Positive: `isMotionPreference('reduced')`. Negative: `'fast'`, `undefined`.
  - `theme-roles.test.ts` `resolveTheme`, from R1-03. Positive: a later layer's `accent` wins and `dark` deep-merges. Boundary: `null` layers are skipped.
  - **CDP case** (packaged, dark), three checks:
    - (a) write `~/.nessy-agent/theme.json` `{ "accent": "#e5484d" }` → computed `--accent` changes live, without a restart, on the default theme and on codex;
    - (b) Motion `Reduced` (via R5-08's control, or `broadcastThemePreferences` in devtools) → `html[data-motion="reduced"]`, and the value survives a restart;
    - (c) macOS: `html[data-vibrancy]` is present in system mode and absent with a forced mode that differs from the OS.
- **Done means:**
  - both files equal v0.15.1 modulo brand;
  - `App.tsx` no longer merges `appTheme`;
  - `resources/docs/themes.md`'s promise that overrides apply live is true (`themes.md:15/70/229`, B3-21);
  - the three CDP readings are recorded.

**R1-05 `[theme]` Theme set: add `paper.json`; `craft.json` not shipped (XS; OQ-R1-1 default).**
- **Needs:** R1-03.
- **Upstream:** v0.15.1 ADDED `apps/electron/resources/themes/{paper,craft}.json`; the playground theme list adds both.
- **Files (ours):** `apps/electron/resources/themes/paper.json` (new); `playground/PlaygroundApp.tsx` theme list (+`{ value: 'paper', label: 'Paper' }`); the `theme-roles.test.ts` built-ins case.
- **Method:** add `paper.json` 1:1, with `author` set to "Nessy" as the existing `haze.json` precedent does (the only diff of haze vs upstream); license MIT kept. Do not add `craft.json`: "The Craft Docs palette with Craft blue" is upstream's brand palette (our specific 3, rebrand).
- **Keep:** the playground's default label stays "Default", not "Craft Agents". Codex stays in the list.
- **Tests:** `theme-roles.test.ts`.
  - Positive: `paper` light and dark meet AA.
  - Negative: `craft` absent.
  - Boundary (`ensurePresetThemes`, `storage.ts:3989-4030`, copy-if-absent): an existing install without `paper.json` gains it on next launch. A user-edited valid `paper.json` is kept.
- **Done means:** seven bundled presets; R5-08's tile count derives from the bundled set (R5 rule), so it shows 7 + Default.

**R1-06 `[settings]` `[design]` ThemeGrid component (S).**
- **Needs:** R1-03.
- **Consumer:** R5-08 (Appearance page).
- **Upstream:** v0.15.1 ADDED `apps/electron/src/renderer/components/settings/ThemeGrid.tsx` (157 lines). Tiles carry live swatches: navigator strip, paper, text and tertiary ink lines, accent solid. They are solved by `deriveThemeRoles` in the active mode; dark-only and scenic themes preview dark; tiles render as placeholders while presets load.
- **Files (ours):** the new file.
- **Method:** add 1:1 (rebrand comment `~/.nessy-agent/theme.json`).
- **Keep:** nothing ours inside. The placeholder count is passed by R5-08 from OUR bundled count, never upstream's 16.
- **Tests:** new `components/settings/__tests__/theme-grid.test.tsx` (`renderToStaticMarkup`, as `source-status-indicator.test.tsx` does).
  - Positive: the codex option in `mode='dark'` paints navigator `#101010` and paper `#212121` (codex.json overrides honoured; solver-measured).
  - Positive: the haze option in `mode='light'` shows the dark-only caption.
  - Boundary: an option whose colours do not parse renders a tile with the neutral placeholder swatch and does not throw.
  - Boundary: `placeholderCount={3}` renders three inert tiles.
- **Visual:** playground entry (R5-08's) in dark and light.

**R1-07 `[chat]` `[design]` Chat column grid (`packages/ui/src/lib/layout.ts`) (XS).**
- **Needs:** R1-03, which provides `px-gutter`, `bg-scrim` and the `@source packages/ui/src/lib` line. Sequence it before the transcript rows.
- **Upstream:** v0.15.1 `layout.ts` (+32). Changes:
  - `CHAT_LAYOUT.maxWidth` 840→768px; `containerPaddingX` `px-5`→`px-6`; `pt-6 pb-8`;
  - new `compactContainerPadding` `px-gutter pt-4 pb-6`;
  - `messageSpacing` `space-y-2.5`→`flex flex-col gap-5`; `userMessagePadding` `''`;
  - `OVERLAY_LAYOUT.modalBackdropClass` `bg-black/50`→`bg-scrim`.
- **Files (ours):** `packages/ui/src/lib/layout.ts` (div 12).
- **Consumers:** `ChatDisplay` 6, `ChatInputZone` 2, `SessionViewer` 2, `Info_Page`, `system-card`, `registry/chat`, plus 2 `modalBackdropClass` users.
- **Method:** take v0.15.1 and re-apply our hunk.
- **Keep:** `controlGutter: 'px-3 @xs/panel:px-4'` and `controlGutterCompact: 'px-2'` (`layout.ts:42-53`), the control-column gutter that lines up our composer (specific 5).
- **Tests:** new `packages/ui/src/lib/__tests__/layout.test.ts`.
  - Positive: `controlGutter` is present and every `CHAT_LAYOUT`/`OVERLAY_LAYOUT` token class (`px-gutter`, `bg-scrim`) is declared in `tokens.css`.
  - Boundary: `messageSpacing` contains `gap-5` (the flex rhythm the transcript rows rely on).
  - Playground: chat entries in dark.
  - CDP: the R1-03 case's screenshot shows a 768px column.

**R1-08 `[playground]` Playground infrastructure: crash boundary, sidebar, Primitives category (S).**
- **Needs:** R1-03 (classes).
- **Upstream:** v0.15.1:
  - `playground/ComponentPreview.tsx`: `PreviewErrorBoundary` keeps a crashing entry inside its box and retries when its props change; plus `onCrash`;
  - `PlaygroundApp.tsx`: `handlePreviewCrash` drops the crashing id from the persisted selection;
  - `Sidebar.tsx`: token restyle;
  - `registry/types.ts`: `'Primitives'` category;
  - `registry/index.ts`: category order.
  - ADDED `PlaygroundPreviewProviders.tsx`, NOT taken.
- **Files (ours):** `ComponentPreview.tsx` (div 62), `PlaygroundApp.tsx` (div 14), `Sidebar.tsx` (div 0), `registry/types.ts` (div 3), `registry/index.ts` (div 117).
- **Method:**
  - merge the boundary and `onCrash` into OUR `PlaygroundEntryFrame` path;
  - `Sidebar.tsx`: take 1:1;
  - `types.ts`/`index.ts`: add `'Primitives'` to our Category union and order;
  - `PlaygroundPreviewProviders`: **HAVE.** Our `registry/playground-chat-providers.tsx` (F1.281) mounts Modal + Navigation as upstream does, plus `ActionRegistryProvider` and `DismissibleLayerProvider`, with live navigation measured harmless. It is a superset, so we do not add a second provider.
- **Keep:**
  - `playgroundEntryProps` + `PlaygroundEntryFrame` (F1.216 render test);
  - `NessySymbol`;
  - our theme list;
  - our Category set (`Marketplace`, `Capability Detail`, `Pages`; no `Messaging`, specific 6).
- **Tests:** the existing `playground/__tests__/registry-render.test.ts` (F1.216) stays green through the new frame (positive: every entry renders). `PreviewErrorBoundary` is exported for the test (a one-word deviation, recorded):
  - `getDerivedStateFromError(e)` gives `{ error: e }`;
  - with an error in state, `render()` gives the `role="alert"` panel;
  - boundary: changed `previewProps` clears the error.
- **Visual:** the playground sidebar in dark.

**R1-09 `[playground]` `[design]` Primitives and Toasts registries + guardrail re-read (S).**
- **Needs:** R6-01 and R6-02 (Button/IconButton, Input, Switch, Tabs, Kbd, Select, Dialog/Popover/Command, Skeleton, sonner), R7 `useDelayedLoading`, R1-02, R1-08.
- **Upstream:** v0.15.1 ADDED `registry/primitives.tsx` (476 lines):
  - entries: `primitives-tokens` (Design Tokens), `-buttons`, `-fields`, `-menu`, `-dialog`, `-tooltip-popover`, …;
  - motion demos on `SPRING`/`TWEEN`.

  `registry/toasts.tsx` (div 0): palette colours → solids, plus an `undo` toast. `registry/index.ts` registers `primitivesComponents`.
- **Files (ours):** those three.
- **Method:** add/take 1:1. Imports go through `@nessy-agent/ui/ui/tooltip` and `@nessy-agent/ui/motion`, not the barrel (R6 barrel trap).
- **Keep:** nothing ours.
- **Tests:** `registry-render.test.ts`.
  - Positive: every Primitives entry renders.
  - Negative/boundary: the Design Tokens entry names every `DERIVED_ROLE_VARS` role. A role added to the solver without a swatch fails.
- **CDP (the slice's visual acceptance):** dark screenshot of Primitives → Buttons, Fields, Menu, Dialog.
- **Done means:** the guardrail warning count is re-read with R1-01's instrument and recorded beside the HEAD reading (≈221).

## 3. Functional changes hidden in these files

| Change | Where (upstream v0.15.1) | Ours today (evidence) | Disposition | Row |
| --- | --- | --- | --- | --- |
| `theme.json` colour overrides finally apply (preset → overrides; also on the default theme) | `ThemeContext.tsx`, `useTheme.ts`, `theme.ts` `resolveTheme(...layers)` | **Bug.** `ThemeContext` resolves the preset only; `App.tsx:414` merges `appTheme` for `shikiTheme`/`isDark` only (B3-21) | TAKE | R1-04 |
| Motion preference (system/reduced/full) + CSS reduced motion (distances collapse, loops stop, drawers fade, the spinner stays) | `ThemeContext`, `motion/MotionPreference.tsx`, `tokens.css` `--motion-scale`, `base.css` | absent | TAKE (UI in R5-08) | R1-02/R1-04 |
| Opaque canvas = navigator surface; translucent only via `data-vibrancy` over a matching native material | `base.css` `html`, `ThemeContext` | always translucent (`index.css:331-337`, B3-17 Windows bug) | TAKE (+R7) | R1-03/R1-04 |
| Pre-paint dark class (no light flash on an opaque canvas) | `playground.html`/`index.html` script | absent; key must be `nessy-theme` | TAKE | R1-03 |
| `--*-rgb` triplets removed; `.shadow-tinted` `--shadow-color` is a colour | `theme.ts`, `tokens.css`, `base.css:146-157` | 45 refs / 18 files would silently lose their shadows and tints | TAKE + sweep | R1-03 |
| Theme `input` key no longer overwrites shadcn's `--input` border var | `theme.ts` (`--surface-input`) | latent bug: ours emits `--input: <bg>` (`theme.ts:213`); 0 `border-input`/`bg-input`/`var(--input)` users (`git grep -P`; control `border-border\|bg-background` = 487) | TAKE | R1-03 |
| codex.json `paper`/`navigator`/`popover`/`input` start to matter | `theme-roles.ts` surface overrides, `bg-paper`/`bg-navigator` | emitted but unconsumed (`var(--paper)`/`bg-paper` 0 uses) | TAKE | R1-03 |
| Accent solids and status texts solved for AA per theme | `theme-roles.ts` | codex `#339cff`→`#0078d3`; github dark `#58a6ff`→`#2777cd`; haze `#a78bfa`→`#8163ce`; one-dark-pro dark `#61afef`→`#2a7bb8`; vitesse dark `#4d9375`→`#3c8366`; nord light `#5e81ac`→`#5678a3` | TAKE (stated residue: Codex-desktop blue darkens on primary buttons) | R1-03 |
| New default palette (cool neutrals, `oklch(0.52 0.19 292)`); main-window `BACKGROUND_HEX` `#f2f3f4`/`#0d0e10` | `theme.ts`, `tokens.css` | old purple-tinted default | TAKE (owner 1:1; label stays "Default") | R1-03 |
| Root font-size 15→16px (all rem sizes +6.7%) | `base.css:16` | `index.css:220` `--font-size-base: 15px`, `:507-508` | TAKE (sweep-visible) | R1-03 |
| Radii one step larger (`rounded-sm/md/lg/xl/2xl` 6/8/12/16/20px) | `tokens.css` `@theme static` | Tailwind defaults (4/6/8/12/16) | TAKE | R1-03 |
| Tailwind `shadow-sm…2xl` and legacy `shadow-*` mapped onto `elev-0…3` | `tokens.css`, `base.css` | own shadow stacks | TAKE | R1-03 |
| Unparseable theme colours warn in validation | `validators.ts` | silent | TAKE (hunk) | R1-03 |
| Token-aware `cn` (`text-label` no longer dropped next to `text-secondary`) | `ui/lib/utils.ts`, renderer `lib/utils.ts` | plain `twMerge` | TAKE | R1-02 |
| Tailwind scans `packages/ui/src/lib` | `renderer/index.css` `@source` | not scanned (ours adds `renderer/lib`) | TAKE + KEEP ours | R1-03 |
| Transcript column 768px, 24px gutters, 20px turn gap; scrim role for the modal backdrop | `layout.ts` | 840px, `space-y-2.5`, `bg-black/50` | TAKE | R1-07 |
| A crashing playground preview stays in its box and is not re-opened on reload | `ComponentPreview`, `PlaygroundApp` | one throw unmounts the playground | TAKE | R1-08 |
| Stream text reveal needs a start time (TurnCard buffers by age) | `registry/turn-card.tsx` | registry passes none | with transcript row (D2) | — |
| Status/labels leave the composer zone for the chat header | `ChatDisplayMobilePreview`, `registry/chat-header.tsx`, `label-badges` text | — | chat-header row (B3-07/R2) | — |

## 4. Our specifics to keep (file → what to re-apply)

| File | Keep |
| --- | --- |
| `apps/electron/src/renderer/index.css` | `@source renderer/lib` + docblock (`:10-18`); composer tokens (`:129-136`), with `--elevation-stroke` rewritten onto `--fg-base`; `.mask-fade-right` (`:598-605`); `.composer-surface`/`corner-shape`/`.composer-footer` (`:1514-1535`). |
| `packages/ui/src/lib/layout.ts` | `controlGutter`, `controlGutterCompact` (`:42-53`). |
| `packages/ui/package.json` | version 1.0.2, Nessy description, 8 extra subpath exports (barrel trap). |
| `packages/ui/eslint.config.mjs` | `nessy-styles` plugin name; `reportUnusedDisableDirectives: 'error'` (P2.229). |
| `apps/electron/eslint.config.mjs` | `nessy-*` plugin names; `shadow-dragging` + UA2.3 comment; the shadow-exception block. |
| `apps/electron/resources/themes/` | our six (`codex.json` ours; `haze.json` author Nessy) + `paper`; no `default`/`solarized`/`craft` files. `storage.ts:3921-3932` retired list unchanged. |
| `ThemeContext.tsx`, `index.html`/`playground.html` | storage key `nessy-theme` (local-storage PREFIX); `@nessy-agent/ui/motion` subpath; `<title>Design System Playground - Nessy Desktop</title>`. |
| `playground/ComponentPreview.tsx` | `playgroundEntryProps`, `PlaygroundEntryFrame`, `PlaygroundChatProviders` (F1.216/F1.281). |
| `playground/PlaygroundApp.tsx` | `NessySymbol`; our theme list ("Default", Codex, …, + Paper). |
| `playground/PlaygroundAppShellProvider.tsx` | `WorkspaceInfo`, `getDraftPromptOrigin`, `defaultPermissionMode: 'auto'` (F1.1052), `pendingPermissions` override (P6.270). Only the `playgroundAppShellValue` export is taken, by the chat-header row. |
| `playground/registry/types.ts`, `index.ts` | our Category union and entries (Marketplace, Capability Detail, Pages, settings-* registries; no Messaging). |
| `playground/demos/mobile-webui/ChatDisplayMobilePreview.tsx` | `permissionMode = 'default'`. |
| `packages/shared/src/config/theme.ts` | `~/.nessy-agent` comments; example id `codex`. |

## 5. Per-path disposition (all 50 assigned paths)

div = changed lines between ours (brand-normalised) and upstream v0.14.1.

| Path | Ours | div | Method | Row |
| --- | --- | --- | --- | --- |
| apps/electron/resources/themes/craft.json | — | ADDED | not shipped (rebrand; OQ-R1-1) | R1-05 |
| apps/electron/resources/themes/default.json | — (retired) | — | N/A as a file; values reach us via `DEFAULT_THEME` + `tokens.css` | R1-03 |
| apps/electron/resources/themes/paper.json | — | ADDED | add 1:1 (author per haze precedent) | R1-05 |
| apps/electron/resources/themes/solarized.json | — (retired) | — | N/A (retired, `storage.ts:3929`) | — |
| apps/electron/src/renderer/components/settings/ThemeGrid.tsx | — | ADDED | add 1:1 | R1-06 |
| apps/electron/src/renderer/context/ThemeContext.tsx | yes | 0 | take 1:1 | R1-04 |
| apps/electron/src/renderer/hooks/useTheme.ts | yes | 0 | take 1:1 | R1-04 |
| apps/electron/src/renderer/index.css | yes | 52 | take + re-apply 4 hunks | R1-03 |
| apps/electron/src/renderer/playground.html | yes | 2 | take (pre-paint, key `nessy-theme`) + our title | R1-03 |
| apps/electron/src/renderer/playground/ComponentPreview.tsx | yes | 62 | merge boundary into our frame | R1-08 |
| apps/electron/src/renderer/playground/PlaygroundApp.tsx | yes | 14 | re-apply hunks (crash handler; +Paper) | R1-08, R1-05 |
| apps/electron/src/renderer/playground/PlaygroundAppShellProvider.tsx | yes | 35 | export `playgroundAppShellValue` only | chat-header row (B3-07/R2) |
| apps/electron/src/renderer/playground/PlaygroundPreviewProviders.tsx | — | ADDED | HAVE (ours `playground-chat-providers.tsx` is a superset); not added | R1-08 |
| apps/electron/src/renderer/playground/Sidebar.tsx | yes | 0 | take 1:1 | R1-08 |
| apps/electron/src/renderer/playground/demos/mobile-webui/ChatDisplayMobilePreview.tsx | yes | 2 | apply hunk (status props removed) | chat-header row |
| apps/electron/src/renderer/playground/mock-utils.ts | yes | 822 | per-hunk to feature owners: `getBackgroundTaskOutput`/`stopBackgroundTask` → background-tasks row; `sessionCommand` → chat header; `onReconnected`, `onLabelsChanged` → their rows | feature rows |
| apps/electron/src/renderer/playground/registry/chat-header.tsx | — | ADDED | add with ChatHeader | chat-header row |
| apps/electron/src/renderer/playground/registry/chat.tsx | yes | 493 | per-hunk: background-task chips, `NewChatEmptyState`/suggestions | background-tasks row, B3-13 |
| apps/electron/src/renderer/playground/registry/custom-shadows.tsx | yes | 0 | take 1:1 (`--shadow-color: var(--accent)`) | R1-03 |
| apps/electron/src/renderer/playground/registry/edit-popover.tsx | yes | 65 | apply hunk (`emptyStateLabel`) | R6 EditPopover row |
| apps/electron/src/renderer/playground/registry/entity-lists.tsx | yes | 156 | rgb lines → R1-03; collapsible groups → R6-04 | R1-03, R6-04 |
| apps/electron/src/renderer/playground/registry/index.ts | yes | 117 | `primitivesComponents` → R1-09; Category order → R1-08; `chatHeaderComponents` → chat-header row | R1-08/09 |
| apps/electron/src/renderer/playground/registry/label-badges.tsx | yes | 0 | take 1:1 (description text) | chat-header row |
| apps/electron/src/renderer/playground/registry/markdown.tsx | yes | 64 | apply hunk (Run-in-background entry) | B3-12 row |
| apps/electron/src/renderer/playground/registry/primitives.tsx | — | ADDED | add 1:1 | R1-09 |
| apps/electron/src/renderer/playground/registry/toasts.tsx | yes | 0 | take 1:1 | R1-09 |
| apps/electron/src/renderer/playground/registry/turn-card.tsx | yes | 333 | apply hunk (`streamStartTime`) | transcript row (D2) |
| apps/electron/src/renderer/playground/registry/types.ts | yes | 3 | add `'Primitives'` to our union | R1-08 |
| apps/viewer/src/index.css | yes | 2 | N/A (dormant, specific 8) | — |
| apps/webui/src/index.css | yes | 34 | N/A (dormant) | — |
| apps/webui/src/login.css | — | ADDED | N/A (dormant) | — |
| packages/ui/eslint-rules/__tests__/design-guardrails.test.ts | — | ADDED | add (prefix `nessy-styles`) | R1-01 |
| packages/ui/eslint-rules/no-motion-antipatterns.cjs | — | ADDED | add 1:1 (message hint rebranded) | R1-01 |
| packages/ui/eslint-rules/no-raw-palette-colors.cjs | — | ADDED | add 1:1 | R1-01 |
| packages/ui/eslint.config.mjs | yes | 14 | take + re-apply ours | R1-01 |
| packages/ui/package.json | yes | 12 | add 2 exports, keep ours | R1-02 |
| packages/ui/src/components/annotations/annotation-style-tokens.ts | yes | 0 | take 1:1 | R1-03 |
| packages/ui/src/lib/__tests__/utils.test.ts | — | ADDED | add 1:1 | R1-02 |
| packages/ui/src/lib/layout.ts | yes | 12 | take + re-apply `controlGutter*` | R1-07 |
| packages/ui/src/lib/utils.ts | yes | 0 | take 1:1 | R1-02 |
| packages/ui/src/motion/FlipOnChange.tsx | — | ADDED | add 1:1 | R1-02 |
| packages/ui/src/motion/MotionPreference.tsx | — | ADDED | add 1:1 | R1-02 |
| packages/ui/src/motion/__tests__/flip.test.ts | — | ADDED | add 1:1 | R1-02 |
| packages/ui/src/motion/__tests__/presets.test.ts | — | ADDED | add 1:1 | R1-02 |
| packages/ui/src/motion/flip.ts | — | ADDED | add 1:1 | R1-02 |
| packages/ui/src/motion/index.ts | — | ADDED | add 1:1 | R1-02 |
| packages/ui/src/motion/presets.ts | — | ADDED | add 1:1 (docblock import path rebranded) | R1-02 |
| packages/ui/src/styles/base.css | — | ADDED | add 1:1 | R1-02 (wired R1-03) |
| packages/ui/src/styles/index.css | yes | 4 | take 1:1 | R1-03 |
| packages/ui/src/styles/tokens.css | — | ADDED | add 1:1 (header comment rebranded) | R1-02 (wired R1-03) |

**Taken in R1 rows although assigned elsewhere** (each row's owner should drop them from its list or point here):
- `packages/shared/src/config/{theme-roles.ts, theme.ts, __tests__/theme-roles.test.ts}` and the `validators.ts` theme hunk (B2 classified them "A new look" without a row);
- `apps/electron/eslint.config.mjs` (B3);
- `apps/electron/src/renderer/lib/utils.ts` (R7);
- the `App.tsx` `useTheme` hunk (R7);
- `shared/types.ts`, `protocol/events.ts` and `rpc/workspace.ts`: the theme-preference `motion?` type hunks;
- the pre-paint script in `index.html` (R7).

## 6. Owner question (only one; non-blocking default)

**OQ-R1-1 (theme set, product posture).** Upstream v0.15.1 adds two built-in themes, "Paper" (warm paper, ink-blue accent) and "Craft" (the Craft Docs palette with Craft blue), and renames its default to "Craft Agents". Which do we ship?
- **Default (taken unless you say otherwise): ship "Paper", do not ship "Craft".**
  - "Paper" is a neutral upstream palette.
  - "Craft" is upstream's brand palette (rebrand rule).
  - Our default theme takes upstream's new default values 1:1 but keeps the name "Default".
  - Our six presets stay, so the set becomes 7 + Default.
- **Stated residue, not a question:** the contrast solver darkens the Codex theme's accent on primary buttons from Codex-desktop's `#339cff` to `#0078d3`, because white on `#339cff` is 2.86:1. That follows upstream 1:1. A Codex-exact blue would need a per-theme opt-out that upstream does not have.

## 7. Coverage

- **Assigned: 50. Diff read: 50/50** (`git diff v0.14.0 v0.15.1`; d1 v0.14.0→v0.14.1 touches none).
- **Read in full:** `tokens.css`, the `base.css` structure and its material/motion/reduced-motion sections, the new `renderer/index.css` outline and its sonner/container sections, both rule files, the guardrail test head, `motion/{index,presets,MotionPreference}` + the `flip`/`FlipOnChange` headers, `ThemeContext`/`useTheme`, `ThemeGrid`, `utils`, `layout`, every playground infra diff.
- **Skimmed by +/- grep (bodies owned by feature rows):** the playground registry bodies `chat`, `markdown`, `entity-lists`, `toasts`, `turn-card`, `mock-utils`, `primitives`, `chat-header`.
- **Ours vs v0.14.1 diffed** for every existing path with div > 0 except the feature-owned registry bodies: `index.css`, `playground.html`, `ComponentPreview`, `PlaygroundApp`, `PlaygroundAppShellProvider`, `types.ts`, `ChatDisplayMobilePreview`, `ui/package.json`, `layout.ts`, `ui/eslint.config.mjs`, `ui/styles/index.css`.
- **Outside the list, read for mechanism:**
  - `theme.ts` diff and `theme-roles.ts` (header, tables, `deriveThemeRoles` start), `theme-roles.test.ts` (outline + preset AA test), `validators.ts` hunk;
  - `apps/electron/eslint.config.mjs` diff;
  - the `index.html` pre-paint script, the `preload/bootstrap.ts` vibrancy hunk, `protocol/events.ts` and `rpc/workspace.ts` motion hunks;
  - our `storage.ts` theme section, `local-storage.ts`, `lint-package.ts` warning policy, `system-card-sticky-band.test.ts`.
- **Skipped / not done:**
  - no build, typecheck or test of our tree (read-only brief);
  - the Tailwind 4.3.1 (ours) vs 4.1.18 (upstream) resolution of `--text-color-*` is assumed, not measured. R1-03's CDP computed-style read is its check;
  - renderer `index.css` scenic/onboarding/pdf sections are carried unchanged and were not read line by line.
