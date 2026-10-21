# B3 — craft-agents-oss v0.15.0 UI delta (redesign + UI features) vs Nessy

Analyst B3, read-only, 2026-10-14. Our tree: `feat/TCODE-000-1-41-0` at `f495cf311` (working tree untouched). Upstream: `.references/craft-agents-oss`, read by tag only (`v0.14.1`, `v0.15.0`, `v0.15.1`).

## Intro

**Scope.** 339 paths, mostly renderer and `packages/ui`.
- 335 of them change between v0.14.1 and v0.15.0: +17,022/−12,502 lines.
- 4 change only in v0.15.1: `main/security-challenge.ts` + test, `event-processor/handlers/tool.ts` + `tool-result-input.test.ts`.
- For the redesign verdict I also measured the whole redesign surface, including files in other analysts' lists: renderer, `packages/ui`, webui/viewer, themes, `theme.ts`/`theme-roles.ts`, `window-manager.ts`, `preload/bootstrap.ts` and the eslint configs. That is 391 files, +20,796/−14,800.

**Instruments.** All derived files are in `scratchpad/delta/`.
1. **Divergence.** For every path: our file vs upstream v0.14.1, after normalising the rebrand (`@craft-agent`→`@nessy-agent`, `Craft`→`Nessy`). Output: `B3-divergence.tsv`, `B3-divergence2.tsv`.
   - The same diff against v0.13.4 shows the divergence is ours, not lag. Upstream changed these renderer files only a little between v0.13.4 and v0.14.1 (for example AppShell 40 lines, ChatDisplay 4).
2. **3-way merge simulation.** `git merge-file` with base = v0.14.1, ours = HEAD, theirs = v0.15.0, all rebrand-normalised, in temp files. It counts the real conflict hunks and conflicted lines per file (`B3-merge.tsv`).
3. **Logic-only diff.** Upstream v0.14.1→v0.15.0 with string literals and comments stripped, to separate behaviour from className churn (`B3-func.tsv`, `b3_fdiff.py`).
4. **Comment scan.** A scan of the added comments in the 41,940-line diff, to find "used to / no longer / never" fixes.

**Context.** Our renderer's palette is upstream's pre-redesign default. `index.css` `:root` is identical to v0.14.1 apart from our Codex-parity composer tokens and `mask-fade-right`. The 'default' theme is Craft's purple accent.

So what we would protect by refusing the redesign is mainly:
- the composer (deliberately ours, Codex parity);
- our six presets (incl. `codex.json`);
- the features layered into the transcript.

Today's look is not a distinct T-Bank look.

## Redesign assessment

### Size

| Measure | Value |
| --- | --- |
| Redesign surface | 391 files, +20,796/−14,800 lines |
| My list (v0.15.0 part) | 335 files, +17,022/−12,502 |
| New upstream files | 99 |
| Files we deleted that upstream modified | 14: messaging ×6, `KeyboardShortcutsDialog`, `pages/ShortcutsPage`, `RtkUpdateDialog`, `WorkingDirectorySelector`, `SettingsEditRow`, `workspace-avatar.tsx` and 2 more |
| Modified files present in ours | 276. **160 merge clean** and 116 conflict: **362 conflict hunks, ≈15.7k conflicted lines** (both sides of the markers) |
| Raw Tailwind palette classes (positive-controlled PCRE count) | ours 185; upstream v0.14.1 had 160 and v0.15.0 has 33. The new guardrail lint (`no-raw-palette-colors`, `no-motion-antipatterns`, both at `warn`) would flag ≈185 sites in ours |

Upstream itself shipped the redesign half-migrated:
- `tokens.css` §5 keeps "Legacy aliases — pre-redesign names mapped onto roles until the class codemod lands".
- Both lint rules are `warn` "until the class codemod (A3–B9) lands".

So a sliced adoption is a state upstream supports.

### Collision surface (hot files; ours = lines we changed vs v0.14.1)

| File | Upstream Δ | Ours vs v0.14.1 | Simulated merge |
| --- | --- | --- | --- |
| `app-shell/AppShell.tsx` | +360/−1412 (split into `SidebarPane`, `ShellResizeHandle`, `SessionFilterMenu` 1112 new, `DetailEmptyState`) | 1203 of 4282 | 6 hunks / 1697 lines |
| `app-shell/ChatDisplay.tsx` | +146/−588 (split into `chat-display/*`, 11 new) | 1939 of 3900 | 16 / 1147 |
| `input/FreeFormInput.tsx` (composer) | +190/−766 (split into `ComposerModelMenu`, `ComposerModeChip`, `ContextUsageChip`, `SendButton`, …) | 1935 of 3275 | 17 / 790 |
| `packages/ui/.../chat/TurnCard.tsx` | +196/−1595 (split into `turn/*`, 12 new) | 422 of 3222 — ours carries transcript verbosity (P6.469), `displayContent` (R32 MessageDisplay hook), `orchestrationProgress`, `PublishedArtifactChip` (UA1.19), `renderActivity` | 8 / 1104 |
| `ActiveOptionBadges.tsx` | +41/−507 (labels/status move to the chat header) | 250 | 3 / 698 |
| `pages/ChatPage.tsx` | +112/−444 (header → `chat-header/ChatHeader.tsx`) | 399 | 5 / 543 |
| `structured/PermissionRequest.tsx` | +55/−57 (→ `DecisionCard`) | 801 of 897 | 8 / 447 |
| `chat/AuthRequestCard.tsx` | +190/−255 | 483 | 12 / 563 |
| `settings/AiSettingsPage.tsx`, `AppSettingsPage.tsx` | ±525, ±150 | 1223, 730 | 9 / 531, 2 / 584 |
| `renderer/index.css` | +170/−998 (→ `packages/ui/styles/tokens.css` + `base.css`) | 49 | 2 / 531 (our composer tokens sit in a deleted block; keep ours) |

Clean for us (divergence 0 or ≤5), so cheap: `PanelStackContainer`, `PanelSlot`, `SessionBadges`, `button.tsx`, `dialog.tsx`, `sonner.tsx`, `drawer.tsx`, every `Settings*` primitive, every `Info_*`, nearly all `markdown/*` blocks, `theme.ts`, `ThemeContext.tsx`, `useTheme.ts`, `useContainerWidth.ts`, `SessionProjectColorWrapper`, `turn-utils.ts` (clean 3-way merge despite 139 own lines).

### Slices (independent unless noted)

| Slice | Files | Upstream Δ | Merge (clean / conflict hunks / lines) | Cost | Notes |
| --- | --- | --- | --- | --- | --- |
| **A. Foundation:** `tokens.css`, `base.css`, `theme-roles.ts` solver (+558) + test, `theme.ts`, `ThemeContext` (+motion pref, +`theme.json` overrides), `ThemeGrid`/Appearance, `packages/ui/motion/*`, token-aware `cn`, pre-paint dark script, guardrail lint (warn), Windows `data-vibrancy` | 37 | +3631/−2026, 20 new | 10 of 15 / 9 / 907 | **M** | Prerequisite for every other slice: the new classes (`text-label`, `bg-paper`, `shadow-elev-*`, `h-control`) live here. The visible effect alone is contrast-solved colours (AA on every preset × mode). The storage key in the pre-paint script must be `nessy-theme` (our `local-storage.ts` PREFIX `nessy-`). |
| **B. Primitives + floating material:** Button variants + `IconButton`, dialog/drawer/sheet/toast (`sonner`) material, dropdown/select/tabs/switch/command, `Info_*`, `Settings*`, onboarding primitives, `ProviderMark`, skeleton | 54 | +854/−530, 7 new | 33 of 40 / 15 / 271 | **S–M** | The `default` Button variant changes from neutral foreground to accent-solid (purple on our default theme). This is the most visible identity change. |
| **D1. Markdown wells:** sunken code/diff wells, `diff-summary.ts`, `PreviewBlockChrome`, PDF/image/table/json/mermaid/html blocks, overlays | ≈22 | ≈+500/−480 | almost all clean / 4 / ≈145 | **S** | `CodeBlock` also hosts the Run button (B3-12). |
| **C. Settings single column:** `SettingsPage` wrapper + per-page lede keys | 28 | +1870/−1834 | 11 of 23 / 30 / 2341 | **M** | Mechanical (wrapper + re-indent), but our pages are heavily ours, so the hunks are large. |
| **F1. Kanban / pages / automations / detail pages restyle:** neutral column wells, header "+" composer, drop-indicator bar, tile/chip restyle, `Info_*` hero | ≈45 | ≈+1.3k/−1.2k | majority clean / ≈76 / ≈1.8k (kanban alone ≈33 / 557) | **M** | Kanban was ported from v0.13.4 in 1.42.0, so divergence is low except `TaskEditor` (our folder picker, 10 hunks/125). |
| **F2. Navigator canvas + joined paper card + row grid + "+N" expand:** `PanelStackContainer` FLIP, `PanelSlot` material layer, `SessionBadges` "+N", `entity-row`, `LeftSidebar`, `TopBar`, toast anchor | ≈15 | ≈+800/−600 | mostly clean / ≈8 / ≈145 | **M** | Its wiring props come from `AppShell` (F3); without F3 it needs a thin adapter. |
| **E. Chat header:** status · title · labels (+N) · info · share · ⋯; label row removed above composer | 17 + `ActiveOptionBadges` | +1164/−607, 10 new | 4 of 7 / 8 / 566 (+3/698 in `ActiveOptionBadges`) | **M–L** | Coupled to our composer zone (status/labels currently sit above our composer). `ChatShareMenu` hard-codes `thecraftagents.com/docs/...` (D(a)). |
| **F3. Shell:** `AppShell` split, `SessionFilterMenu` rewrite, `SessionItem`, `App.tsx`, list panels, send-to-workspace dialogs | ≈30 | ≈+2.5k/−2.3k, 5 new | ≈47 / ≈2.7k | **L** | `AppShell` alone has 1697 conflicted lines. |
| **D2. Transcript core:** `TurnCard` → `turn/*` work log + `ResponseFooter` plain answers; `ChatDisplay` → `MessageBubble`/`ErrorMessage`/`ProcessingIndicator`/`TranscriptStates`; `DecisionCard` for permission/credential/admin prompts | ≈45 | ≈+3.5k/−2.6k, ≈30 new | ≈55 / ≈3.4k | **XL** | Carries our own transcript features (verbosity modes, MessageDisplay display text, orchestration progress, published-artifact chip, remember-key permission card). It aligns with the Codex-desktop "plain answers" look anticipated in July (memory `codex-desktop-design-reference`), but no plan exists for that. |
| **G. Composer** as one raised card with toolbar chips | 25 | +1682/−1587, 9 new | 4 of 15 / 58 / 2388 | (L) | DROP-c: deliberately ours. Take only the console-paste offer (B3-12). |
| **J. WebUI compact/touch + viewer** | 12 | +253/−232 | — | — | N/A: dormant. |
| **K. Playground** | 20 | +1016/−81 | 9 of 17 / 14 / 263 | follows each slice | Owner rule: sweep every touched state in dark theme. |

### Recommendation

**Adopt in slices; do not adopt whole.**

1. **Now, independent of the owner's answer:** take the functional items B3-14 (CRITICAL), B3-17, B3-21, B3-22, B3-25, B3-26. B3-23 folds into UB7.2. They need no tokens.
2. **First redesign release:** A + B + D1 together, plus the renderer half of B3-17. This is the foundation, ≈28 conflict hunks.
   - It turns every later upstream renderer port from "rewrite classes" into "merge".
   - That is the parity rule's own reason (memory `prefer-upstream-parity`).
3. **Second:** C, F1, F2, E, in that order. E only together with a decision on what stays in our composer's top row.
4. **Deferred, own decision each:** F3 shell, then D2 transcript core. Stated reason: they carry Nessy features and ≈6k conflicted lines.
   - D2 should be re-raised when the owner wants the Codex-like plain-answer transcript.
5. **G stays ours** (owner decision, composer).

### Owner question (OQ-B3-1, product posture: visual identity)

> Upstream v0.15.0 replaced Craft's look with a new design language: contrast-solved themes, accent-solid primary buttons, floating dialogs and toasts, a paper card on a navigator canvas, serif empty states, a single-column settings layout, a status/labels chat header, and a "quiet work log" transcript. Nessy is a T-Bank internal product whose composer deliberately follows Codex desktop. How far do we follow?

The options:
- **(a) Whole redesign except the composer.** XL; a release of its own (≈15.7k conflicted lines, 99 new files).
- **(b) Slices.** A+B+D1 first; then C, F1, F2, E; F3 and D2 only on a later explicit go; composer stays ours.
- **(c) Functional fixes only.** Keep today's look and record the redesign as DROP-c ("T-Bank identity / Codex-parity look").

Sub-question **OQ-B3-1b**: the redesign makes the primary button accent-solid. Our 'default' theme's accent is Craft's purple. Do we keep upstream's default theme, or ship a Nessy default theme (palette chosen by the owner)?

**Recommended default: (b)**, with 1b = keep upstream's default until the owner names a palette (parity rule; no invented palette). Reasons:
- A+B+D1 merge almost cleanly.
- Upstream itself supports the mixed state through legacy aliases.
- The deferred slices are exactly where our features live.

## Items

Mapping note: the 1.43.0 draft covers ≤ v0.14.0, so most rows are NEW. Proposed homes:
- renderer and Windows fixes → Phase 4 (UB4.11+);
- features → Phase 7 (UB7.10+);
- redesign slices → a new gated phase or a 1.44.0 plan, on OQ-B3-1.

A CRITICAL finding goes into the active 1.42.0 tracker as a UA12.n row, as AGENTS.md (Editing Rules) requires.

| id | upstream item | kind | upstream files | our state + evidence | 1.43.0 mapping | disposition | severity | size | proposed row text |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| B3-01 | New look — foundation (tokens, theme-role solver, motion, guardrails, motion preference) | redesign | `packages/ui/src/styles/{tokens,base,index}.css`, `shared/config/theme-roles.ts`+test, `theme.ts`, `ThemeContext.tsx`, `useTheme.ts`, `ThemeGrid.tsx`, `AppearanceSettingsPage.tsx`, `packages/ui/src/motion/*`, `ui/lib/utils.ts`, eslint rules + configs, `index.html`/`playground.html` pre-paint | `index.css` ≈ v0.14.1 + composer tokens (49 lines); `theme.ts` and `ThemeContext` identical. Merge: 10 of 15 clean, 9 hunks (`index.css` 2/531, Appearance 3/323) | NEW (redesign phase, ⏸ OQ-B3-1) | ADAPT | — | M | "Adopt the v0.15.0 token layer: `tokens.css`/`base.css` + legacy aliases, the `theme-roles` solver over our six presets (AA test per preset × mode), token-aware `cn`, the motion package + Motion preference (system/reduce/full), guardrail rules at warn. Keep our composer tokens. Pre-paint key `nessy-theme`. Playground sweep, dark first." |
| B3-02 | New look — primitives, floating dialogs/toasts/sheets | redesign | `components/ui/{button,dialog,dropdown-menu,select,tabs,switch,command,sonner,…}.tsx`, `packages/ui/.../{drawer,StyledDropdown,SimpleDropdown,tooltip}`, `info/Info_*`, `settings/Settings*`, `onboarding/{primitives,ProviderMark}` | 25 clean (div 0), 33 of 40 merge clean, 15 hunks/271 | NEW (⏸ OQ-B3-1, OQ-B3-1b) | ADAPT | — | S–M | "Take v0.15.0 primitives (Button primary/secondary/ghost/danger(-solid) + deprecated aliases, `IconButton` with required aria-label, floating material for dialog/drawer/toast/menus). Primary-button colour per OQ-B3-1b." |
| B3-03 | New look — sunken code/diff wells | redesign | `packages/ui/src/components/markdown/*`, `PreviewBlockChrome.tsx`, `diff-summary.ts`+test, overlays | Nearly all div 0; 4 hunks/≈145 | NEW (⏸ OQ-B3-1) | ADAPT | — | S | "Take the markdown block chrome and wells as a unit with B3-01/02." |
| B3-04 | New look — settings on a single column | redesign | `settings/SettingsPage.tsx`, every `pages/settings/*` | Our pages heavily diverged (AiSettings 1223, App 730, Permissions 376 lines); 30 hunks/2341, mechanical | NEW (⏸ OQ-B3-1) | ADAPT | — | M | "Wrap each settings page in `SettingsPage` (680px column, lede line); ledes en+ru, keys first." |
| B3-05 | New look — navigator canvas + joined paper card, shared row grid, "+N" label expand on session rows | redesign | `PanelStackContainer`, `PanelSlot`, `SessionBadges`, `fit-labels.ts`, `entity-row/list`, `SessionProjectColorWrapper`, `LeftSidebar`, `TopBar`, `panel-constants` | Mostly div 0; ≈8 hunks/≈145; wiring from `AppShell` | NEW (⏸ OQ-B3-1) | ADAPT | — | M | "Take the paper-card material + FLIP panel motion + "+N" expand; thin adapter in `AppShell` until B3-08." |
| B3-06 | New look — kanban/pages/automations/detail pages | redesign | `kanban/*`, `components/pages/*`, `automations/*`, `info/*`, `ProjectInfoPage`, `SkillInfoPage`, `SourceInfoPage` | Kanban low (Column 45, Board 66; `TaskEditor` 703 = our folder picker); ≈76 hunks/≈1.8k | NEW (⏸ OQ-B3-1); touches 1.42.0 UA kanban rows | ADAPT | — | M | "Restyle board (neutral wells, header "+", drop-indicator bar at the recency slot), page tiles and detail heroes; keep our folder picker." |
| B3-07 | Chat header carries status, labels, actions | redesign | `chat-header/{ChatHeader,ChatHeaderStatusButton,ChatShareMenu,ChatHeaderLabels,label-strip-layout}`, `ChatPage.tsx`, `ActiveOptionBadges.tsx`, `SessionInfoPopover`, `PanelHeader` | `ChatPage` 399 lines ours, 5/543; `ActiveOptionBadges` 3/698 (labels/status sit above our composer today) | NEW (⏸ OQ-B3-1) | ADAPT | — | M–L | "Move session status/labels/info/share into a ChatHeader; drop the label row from our composer zone; no Craft docs URL in the share menu (`ChatShareMenu` SHARING_DOCS_URL, D(a))." |
| B3-08 | New look — shell (sidebar pane, resize handle, filter menu) | redesign | `AppShell.tsx`, `SidebarPane`, `ShellResizeHandle`, `SessionFilterMenu` (1112 new), `DetailEmptyState`, `SessionItem`, `App.tsx`, list panels | `AppShell` 1203 ours, 6/1697; ≈47 hunks/≈2.7k total | NEW, deferred (OQ-B3-1 (a) only) | ADAPT (deferred) | — | L | "Split `AppShell` as upstream; port `SessionFilterMenu` over our filter set." |
| B3-09 | Calmer transcript (work log, plain answers, inline errors, decision cards) | redesign | `packages/ui/.../chat/TurnCard.tsx`, `chat/turn/*` (12 new), `ChatDisplay.tsx`, `chat-display/*` (11 new), `structured/{DecisionCard,PermissionRequest,CredentialRequest,AdminApprovalRequest}` | `TurnCard` carries P6.469 verbosity, R32 `displayContent`, `orchestrationProgress`, UA1.19 chip; `ChatDisplay` 1939, `PermissionRequest` 801 ours; ≈55 hunks/≈3.4k | NEW, deferred | DROP-c (for now; revisit on owner go) | — | XL | "Re-raise as its own plan when the owner wants the plain-answer (Codex-like) transcript; port turn/* around our verbosity modes, MessageDisplay text and permission-card features." |
| B3-10 | Composer as one raised card with quiet toolbar chips | redesign | `FreeFormInput`, `ChatInputZone`, `InputContainer`, `Composer*`, `ContextUsageChip`, `SendButton`, `FollowUpChips`, `action-hotkey`, `composer-styles` | Ours (Codex-parity composer; `FreeFormInput` 1935 lines ours; 17/790) | — (manifest J) | DROP-c | — | — | "Not taken: the composer is deliberately ours (owner decision; Codex parity)." |
| B3-11 | WebUI compact touch layout without zoom | redesign | `apps/webui/src/{index.css,index.html,login.*}`, `apps/viewer/*` | `apps/webui`, `apps/viewer` dormant (AGENTS.md map) | — (manifest J) | N/A | — | — | — |
| B3-12 | Run shell snippets in the background (Run button + paste offer) | feature | `markdown/{shell-command.ts,RunCommandContext.tsx,CodeBlock.tsx}`, `lib/run-command-message.ts`, `ChatDisplay.tsx` (`handleRunCommand` → `onSendMessage`), `TurnCard.tsx` (no runner while streaming), `ChatInputZone`/`FreeFormInput` (paste offer) | Absent (no `RunCommandProvider`). It is a user message, not a host exec, so it adds no authority. Each runtime's own gate decides: Pi's host bash gate (`local-tools/runtime-backed-tools.ts` `run_in_background`); Claude's native Bash `run_in_background` under canUseTool/hooks; Codex's exec approvals + execpolicy, with background terminals in `codex-agent.ts`. Explore refuses; Ask cards; bypass runs without a card. Residues: (1) upstream's text names "Bash with run_in_background: true", which is Claude-specific, so Codex and Pi need neutral wording; (2) the button shows "started" even if the agent refuses; (3) in `auto` the user-authored "run this" can raise a judge's approval of a model-authored command (the user's click is the authority, as with copy-paste) | NEW (Phase 7, UB7.10) | ADAPT | — | S (button) + S (paste offer in our composer) | "Run in background on shell/console code blocks after streaming ends; send a runtime-neutral request ("start this as a background shell task, do not wait") through `onSendMessage`; permission mode unchanged on Pi/Claude/Codex; paste offer added to our composer. Tests: `shell-command.test.ts` (copy) positive/negative; a codex case shows the request reaches the approval path." |
| B3-13 | Suggestions in a new chat (3 starter prompts) | feature | `chat-display/{new-chat-suggestions.ts,NewChatSuggestions.tsx}`+test, `TranscriptStates.tsx` (`NewChatEmptyState`), `ChatDisplay.tsx` (`handleRunSuggestion` enables the source first), 12 `chat.suggestions.*` keys | Our non-compact empty chat renders nothing (`ChatDisplay.tsx` L2447–2451, compact only). Our renderer holds `SafeCapabilitySummary[]` (`ChatDisplay.tsx` L402), which has no `provider` field, so upstream's provider→kind map does not port as-is. Top-ups: `connectEmail` assumes Google/Microsoft OAuth (Microsoft removed in ours); `news` needs web search | NEW (Phase 7, UB7.11); distinct from UB6.14 (decision-layer source hints) | ADAPT | — | S–M | "Empty-chat starter chips from working sources over `SafeCapabilitySummary` (dp Jira/GitLab → issues/code), top-ups `files` (+ `news` only where web search exists); drop `connectEmail`; keys en+ru." |
| B3-14 | Cancelling a credential prompt no longer submits the typed credential | security fix | upstream fix in `components/chat/AuthRequestCard.tsx` (v0.15.0 Cancel `type="button"`, comment "The credential form's Cancel must not also submit the typed credential"); `structured/CredentialRequest.tsx` is style-only | **Bug present in ours.** `AuthRequestCard.tsx` L318–352 `AuthCardActions` renders Save and Cancel `<Button>` with no `type`. Our `ui/button.tsx` L42–54 sets none, so in a form a `<button>` is "submit". The credential form wraps the actions: `<form onSubmit={handleFormSubmit}>` (L1071–1076, for pending non-OAuth non-dp). Cancel (L1031–1035 → `handleCancel` L477) sends `{cancelled:true}`, then the native submit runs `handleFormSubmit` → `handleSubmit` (L445), which sends the typed secret with `cancelled:false` when it is valid. **Mitigation:** server side the cancel claims and clears `pendingAuthRequest` synchronously (`SessionManager.ts` `claimAuthRequest` L16925–16970, reached without an await from `respondToCredential` L35998), so the second response finds no pending request. The secret is therefore sent (to a remote server in remote mode) but not stored when the cancel RPC lands first. Side effects: a "Saving…" flicker; `App.tsx` L1749 slices the pending queue once per response. Save also double-submits (benign). The composer `CredentialRequest.tsx` is correct (L285 `type="submit"`, L295 `type="button"`). | NEW UA12.n in the active 1.42.0 tracker now (CRITICAL rule) + pointer row in 1.43.0 | TAKE | **CRITICAL** (security, by code reading; persistence mitigated) | XS | "AuthRequestCard: Cancel is `type="button"`, Save `type="submit"` with no onClick (one submit path). Test: render the credential form, type a value, click Cancel → exactly one `onRespondToCredential` call, `cancelled:true`; control: Save → exactly one call with the value." |
| B3-15 | Phones no longer rotate keyboard-shortcut tips | fix | `FreeFormInput.tsx` (`defaultPlaceholders` drop key tips when `compactMode`) | Ours deliberately differs: F1.93/D1.400 rule "a compact composer names its own placeholder" (`FreeFormInput.tsx` L549–564). Phones N/A (webui dormant, iOS native). Upstream's version keys on the default list, not English substrings, so it answers both reasons F1.93 refuted | — | DROP-c (optional XS take if narrow Electron windows should drop key tips) | — | XS | — |
| B3-16 | WebUI deep links (session link, `?ws=`, styled login) | fix | `apps/webui/src/App.tsx`, `vite.config.ts`, `login.*`, `NavigationContext.tsx`, server `webui/http-server.ts` | WebUI dormant. The renderer half is HAVE: `NavigationContext.tsx` L1157–1169 keys the switch on workspace ID and L1430–1431 auto-selects only on the store's current focused route (UA12.179) | — | N/A (HAVE for the NavigationContext half) | — | — | — |
| B3-17 | Windows 10/11<22H2 get an opaque window | fix | `main/window-manager.ts` (Mica only at build ≥22621, no Acrylic), `preload/bootstrap.ts` (`getWindowVibrancy`), `ThemeContext.tsx` (`data-vibrancy` only over a material), `channel-map-parity.test.ts` | **Bug present in ours.** `window-manager.ts` L34–45 returns Mica at ≥22000 and Acrylic at ≥17763. Our canvas is always 50% translucent (`index.css` L331–337 `html[data-theme-override]::before`), and `ThemeContext` always sets `themeOverride`, so on Win10/Win11 21H2 the web contents go transparent over nothing (upstream's reading). We ship Windows (`build-win.ps1`) | NEW (Phase 4, UB4.11) | TAKE | MED (wrong behaviour on Windows) | S | "Gate `backgroundMaterial` to Mica on build ≥ 22621; pass the material to the renderer (`--nessy-window-vibrancy`); translucent canvas only over a material, solid otherwise. Unit test for the build gate (22000/22621); Windows sitting case." |
| B3-18 | Live task output works with a space in the user folder | fix | `server-core/sessions/background-task-output.ts` (new, `launchOutputFile`) + test | No parser in ours: we take `outputFile` from the SDK event (`SessionManager.ts` L37625) and do not read launch acknowledgements (`git grep "Output is being written to"` finds only our own producer, `local-tools/runtime.ts` L825) | Background-task chip item (other analyst), UB9.2 family | COVERED-BY | — | — | — |
| B3-19 | Publish a page as a Claude artifact | feature | `PageView.tsx` button, `shared/pages/claude-artifact.ts`, RPC `pages:publishClaudeArtifact` | Needs a claude.ai-account connection. Our Pro/Max card is off by default (`feature-flags.ts` L188 `claude: false`). It needs SDK ≥ 0.3.296 + `CLAUDE_CODE_ARTIFACT=1`; ours is 0.3.280 (package.json self-report). It sends page content and data to claude.ai, new egress outside posture. Our pages already publish to the internal t-artifacts service (`SharePageDialog.tsx` L2) | — (manifest J) | DROP-b (+a) | — | — | — |
| B3-20 | A failed source test shows in the sources list | fix | `ui/source-connection-status.ts` (new: `normalizeStoredStatus` maps `error`/`disconnected` → `failed`), `source-status-indicator.tsx`, test | **Worse in ours: invisible everywhere.** Our `source_test` persists `error`/`disconnected` (`session-tools-core/.../source-test.ts` L131–139), but the renderer reads only `SafeCapabilitySummary` (`protocol/capabilities.ts` L150–176: no test field), and `capabilitySummaryConnectionStatus` (`source-status-indicator.tsx` L311–322) never sees it. A source whose test failed shows green in the list and on the detail page. Nothing in the renderer reads `connectionStatus` (`git grep` over renderer/capabilities/server-core: 0 hits) | NEW (Phase 3 or 7, UB7.12) | ADAPT | LOW–MED | S (+wire field) | "Carry a normalised last-test verdict (`failed`/`connected`) into `SafeCapabilitySummary` via views.ts; map `failed` in `capabilitySummaryConnectionStatus`; list and detail agree. Shared-wire risk trigger." |
| B3-21 | (silent) `theme.json` colour overrides now apply | fix | `ThemeContext.tsx` (`getAppTheme`/`onAppThemeChange` → `resolveTheme(preset, overrides)`), `theme.ts`, `useTheme.ts`, `App.tsx` | **Bug present in ours.** `App.tsx` L339/L414/L831–837 loads `appTheme` into `useTheme({appTheme})` but uses only `shikiTheme`/`isDark`. `ThemeContext.tsx` L250 is `resolveTheme(presetTheme)` and never sees `theme.json`. Yet `resources/docs/themes.md` L15/L70/L229 promise app-level overrides that apply live | NEW (Phase 4, UB4.12) | TAKE | LOW | S | "Apply `CONFIG_DIR/theme.json` in ThemeProvider (preset → overrides) as v0.15.0; drop the dead App-level merge. Test: an override colour reaches the injected CSS; control: no file → preset unchanged." |
| B3-22 | (silent) Kanban drag in the compact stacked layout targets the column under the pointer | fix | `kanban/board-collision.ts`+test, `KanbanBoard.tsx` | Ours uses `closestCorners` only (pre-v0.15.0). Compact (narrow) stacks columns, so short columns win drops | NEW (Phase 4, UB4.13) | TAKE | LOW | XS | "Copy `boardCollisionDetection` (pointerWithin when stacked, closestCorners otherwise) + test." |
| B3-23 | (silent) Workspace-avatar initial keeps contrast | fix | `ui/workspace-avatar-color.ts`+test | We have no `workspace-avatar.tsx` yet (UB7.2 owes it from v0.13.4) | UB7.2 | COVERED-BY | — | XS | "UB7.2 takes the v0.15.0 `workspace-avatar-color.ts` (lightness solved for the white initial)." |
| B3-24 | (silent) AI settings page loads as one snapshot (no sections jumping in) | fix | `pages/settings/ai-settings-loader.ts`+test | Our `AiSettingsPage` diverged 1223 lines; sequential loads (pattern as v0.14.1) | NEW (Phase 7, UB7.13) | ADAPT | LOW | S | "Load the AI settings page's initial RPCs in one `Promise.all` snapshot." |
| B3-25 | (silent) Narrow window never paints the wide layout first | fix | `hooks/useContainerWidth.ts` (layout-effect first measure) | div 0 | NEW (Phase 4, UB4.14) | TAKE | LOW | XS | copy |
| B3-26 | (silent) Project colour stripe no longer paints over sticky group headers | fix | `SessionProjectColorWrapper.tsx` | div 2, clean merge | NEW (Phase 4, UB4.15) or with B3-05 | TAKE | LOW | XS | copy |
| B3-27 | (silent) Reduced motion honoured; Motion setting | a11y | `ThemeContext` motion pref, `packages/ui/motion/*`, `InputContainer` | — | with B3-01 | COVERED-BY (B3-01) | — | — | — |
| B3-28 | Subagent steps grouped under their subagent (release-note item outside my eight; file in my list) | fix | `packages/ui/.../chat/turn-utils.ts` + grouping test | Our `turn-utils.ts` (139 own lines) **merges clean** | owner of that release-note item | COVERED-BY (recommend TAKE) | — | S | — |
| B3-29 | Background-task chip live activity/stop wiring inside my files | feature | `App.tsx` (`task_activity`), `event-processor/{types,processor}.ts`, `ipc-channels.test.ts` (`sessions:getBackgroundTaskOutput`, `sessions:stopBackgroundTask`) | Part of "Background tasks you can follow and stop" | other analyst; UB9.2 family | COVERED-BY | — | — | — |
| B3-30 | Decision-layer bits inside my files | feature | `ipc-channels.test.ts` (`decisions:getUsage`), `structured/DecisionCard.tsx` name | Decision layer = Phase 6 | UB6.4/UB6.5 | COVERED-BY | — | — | — |
| B3-31 | Files absent in ours that upstream restyled | — | `messaging/*` ×5 + `MessagingSettingsPage`, `KeyboardShortcutsDialog`, `pages/ShortcutsPage`, `RtkUpdateDialog`, `WorkingDirectorySelector`, `SettingsEditRow`, `workspace-avatar.tsx` | Deleted or never ported | messaging D(b) OQ-43.10; RtkUpdateDialog → UB7.4; avatar → UB7.2 | N/A | — | — | — |
| B3-32 | v0.15.1-only paths in my list | — | `main/security-challenge.ts`+test (fewer false browser "security verification"), `event-processor/handlers/tool.ts` (+`toolInput` on `tool_result`)+test, `turn/tool-display.ts` names for MCP resources/prompts | — | 0.15.1 analysts | COVERED-BY | — | — | — |

**Style-only churn (one line).** 39 changed .ts/.tsx files have zero non-string, non-comment change. About 100 more are className-dominated restyles: menus, badges, onboarding steps, kbd/avatar/popover/tabs, playground registries. They are folded into the slices above and need no own row.

**Counts by disposition (32 items).**

| Disposition | Count | Items |
| --- | --- | --- |
| TAKE | 6 | B3-14, B3-17, B3-21, B3-22, B3-25, B3-26 |
| ADAPT | 12 | B3-01…08, B3-12, B3-13, B3-20, B3-24 |
| COVERED-BY | 7 | B3-18, B3-23, B3-27, B3-28, B3-29, B3-30, B3-32 |
| DROP-b | 1 | B3-19 |
| DROP-c | 3 | B3-09, B3-10, B3-15 |
| N/A | 3 | B3-11, B3-16, B3-31 |
| HAVE | 0 standalone | B3-16's NavigationContext half |

CRITICAL: 1 (B3-14).

## Silent changes

Upstream changes not explained by a release-note item.

**Functional, worth rows**
- B3-21 `theme.json` overrides never applied in ours.
- B3-22 compact kanban drag targeting.
- B3-24 AI settings single-snapshot load.
- B3-25 `useContainerWidth` first measure before paint.
- B3-26 colour stripe over sticky headers.
- B3-23 avatar contrast (UB7.2).
- B3-27 reduced-motion support.

**Inside the redesign, behaviour-relevant**
- Kanban `StatusBadge` loses its `live` ping (the board's live-pulse pref no longer has a visual).
- Tiles skip a status chip equal to their column (`homeStatusId`).
- A drop-indicator bar shows the card's real (recency) slot.
- `InputContainer` moves the background-completion chip above the box ("never covers the draft").
- `CompactSessionMenu` reopens on its initial view.
- `SessionInfoPopover` hugs its content.
- Errors render inline with the title stripped from the body (`strip-repeated-title.ts`).
- The transcript shows a skeleton only after 200 ms (`useDelayedLoading`).
- `cn` becomes token-aware (`extendTailwindMerge`): without it, `text-label` and `text-secondary` silently drop each other. Any slice must take this first.

**Hidden in my files but owned elsewhere**
- Background-task chip activity/stop (B3-29).
- Decision usage channel (B3-30).
- Label chips and value editing: `label-menu`, `label-value-popover`, `AutoRulesDataTable` → "Labels stay clean" / "Editable label values".
- Cloudflare preset in `ApiKeyInput`/`provider-icons` → "Cloudflare AI Gateway".
- Subagent grouping (B3-28).

**Already HAVE**
- Deep-link auto-select race: `NavigationContext` (UA12.179).
- Hard-coded settings strings → i18n: `ServerSettingsPage` already `t("settings.server.browse")`, UA12.209.

## Coverage

- **339 / 339 paths measured mechanically.** Every path got divergence vs v0.14.1 and v0.13.4 and (where ours exists) a simulated 3-way merge. Every .ts/.tsx path got a logic-only change count. The 391-file redesign surface was measured the same way.
- **≈75 paths read in substance**, i.e. diff or source read by me: every file behind items B3-12…B3-26; the eslint rules and configs; `tokens.css` (roles and scales); `button.tsx`; `SettingsPage` + 5 settings pages; kanban ×8; `PanelStackContainer`/`PanelSlot`/`SessionBadges`; pages ×5; `ChatHeader`/`ChatShareMenu`/`ActiveOptionBadges` headers; `InputContainer`; `turn-utils`; webui ×4; `window-manager`/`bootstrap`; `ThemeContext`/`useTheme`/`App.tsx`/`NavigationContext`/event-processor ×2; the 0.15.1 files. On our side: `AuthRequestCard`, `CredentialRequest`, `SessionManager` credential path, `source-status-indicator`, `capabilities.ts`, `FreeFormInput` placeholder, `window-manager`, `index.css`, `ThemeContext`, `App.tsx`, `NavigationContext`.
- **≈160 skimmed** through the logic-only diff and the added-comment scan.
- **≈100 skipped for detail.** These are className-only churn and playground registry bodies; their slice cost comes from the merge simulation.
- **Not done:** no runtime measurement (read-only brief). B3-14's server-side ordering claim and B3-17's Windows behaviour are code readings and should be the first step of their rows.
