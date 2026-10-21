# UA11.8 — Upstream completeness reconciliation, 1.42.0 vs craft-agents v0.13.4

Date: 2026-10-03/04. Controller: ZCode session (orchestrated lanes). READ-ONLY sweep; the only file this instrument wrote is this report.

**HEAD read:** `42ff60a04`–`290775f28` (finders recorded their own short sha; no feature code moved in that window — only the UA12.132 gate fix and pins).
**Upstream:** `.references/craft-agents-oss` at tag `v0.13.4` (seed `v0.10.5`); newer tags `v0.13.5`, `v0.13.6`, `v0.14.0` checked (ls-remote 2026-10-03: nothing newer than v0.14.0 exists).

## Instrument

19 finders + 2 two-lens verifiers + 2 completeness-critic rounds, all read-only:

| Finder | Coverage |
| --- | --- |
| scout | manifest sections A–I (line ranges, item counts), inventory groups, 185 non-manifest diff paths, planted target |
| manifest-A/B/C/D+F+G/E/I | all 9 Port-manifest sections item by item (211 items): disposition honoured, staged copies' withheld ranges closed, every upstream symbol/export/key accounted |
| inventory-board/tasks/planning/projects/pages | all 59 Feature-inventory behaviours (B1–15, T1–11, L1–12, J1–8, G1–13) plus unnamed behaviours (context menus, empty/error states, keyboard affordances, rate limits) |
| diff-1..4 | every one of the 185 non-manifest upstream paths of `git diff --name-only v0.10.5 v0.13.4`, judged by content |
| surfaces-irt / -sd / -thn | i18n (56 absent keys triaged — of the 314 upstream en keys new since the seed; the first count said 41, corrected 2026-10-08 — en↔ru parity), rpc (channel families), tools (37-entry registry × 3 runtimes), settings (defaults/schemas/config parity), docs (resources/docs, DOC_REFS, docs-site, package notes), tests (~60 upstream feature test files), history (v0.10.5..v0.13.4 — release-squashed mirror; the v0.13.4 file state carries every fix), newer-upstream (v0.13.4..v0.14.0: all 311 paths mapped by work/wi16/plan-1.43.0/d14-map.json, 0 unmapped (the first count said 24, corrected 2026-10-08); UA12.35/UA12.70–86 cross-checked) |
| ours-ios-wire-consumer | the iOS client against the 1.42.0 wire (critic round 1's one uncovered area): decode safety of every new Session/event/channel delta, the session-list behavioural question, approval routing, payload shapes, the apps/cli flat client |
| planted control | `kanban/PlantedControl → apps/electron/src/renderer/components/app-shell/kanban/KanbanDragOverlay.tsx \| CA \| UA2.4` — reported and examined (absent on BOTH sides: no such upstream file at v0.13.4, no such manifest row); the finder did not silently clear it. Discrimination confirmed. |

**Verdict: NOTHING SILENTLY MISSED.** The complete MISSED/PARTIAL set is seven gaps (below), all small; everything else is ADAPTED-OK or EXCLUDED-OK with a named covering row/decision. **Corrected 2026-10-08:** an independent audit found one counter-example every finder had passed — upstream `apps/electron/src/renderer/main.tsx` hunk 3, the crash screen's `crash.*` i18n, counted by no manifest row — so the set is eight gaps; gap 8 below is row UA12.181 (see Corrections).

## REAL GAPS (each becomes a row, done in the final wave before UA11.1)

| # | Key | Area | Evidence | Verdict | Size | Row |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `ChatDisplay.tsx#onKillTask` | tasks | upstream v0.13.4 ~L1923 `?.type === 'shell' ? 'shell' : 'agent'`; ours L2899 `?.type ?? 'shell'` — an id missing from the list (or a future non-shell kind) misroutes to killShell | PARTIAL (defence-in-depth: both consumers render from the same list, no reachable divergence today) | XS | UA12.135 |
| 2 | `SessionInfoPopover.tsx#DrawerTitle` | shell/i18n | upstream renders `t('chat.sessionInfo')`; ours hardcodes `Session info` (key already shipped en+ru; fb3a52d06's "premise per hunk" note conflated the key existing with the title reading it) | PARTIAL (user-visible: ru drawer titles are English) | XS | UA12.136 |
| 3 | census instrument hole | tests | the renderer-hardcoded-strings census greps only aria-label/placeholder attributes — element text children are structurally invisible (that is why #2 survived) | instrument finding | XS | UA12.137 |
| 4 | `packages/shared/AGENTS.md` Key folders | docs | upstream CLAUDE.md gained src/projects/, src/pages/ entries; ours lists neither them nor src/tasks/ | PARTIAL | XS | UA12.141 |
| 5 | `transform-data.test.ts` dev-mode pin | tests | upstream pins NESSY(CRAFT)_IS_PACKAGED='0'; ours has no pin — measured 6 pass / 2 fail under NESSY_IS_PACKAGED=true (8/0 dev); UA12.29 ports the same pin into script-sandbox.test.ts only | PARTIAL (row under-scopes its file set) | XS | note on UA12.29 |
| 6 | `ios#session-list-flood` | ios | server sessions:get returns Conductor children (parentSessionId, not hidden) and taskDraft orchestrators (deliberately not hidden); the desktop board filters CLIENT-side; iOS has no fields to filter by and no filter — the phone's flat list floods with child rows | MISSED (user-visible) | S | UA12.138 |
| 7 | `ios#text-discard-event` + `ios#permission-prompt-parent-routing` | ios | text_discard decodes to .unknown so a voided partial stays on screen (cosmetic, self-heals); a hidden child's permission prompt never surfaces on the viewed ancestor (pre-existing on master, named by the model's own docblock) | PARTIAL ×2 (user-visible) | XS ×2 | UA12.139, UA12.140 |
| 8 | `main.tsx#CrashFallback` | shell/i18n | upstream v0.13.4 `apps/electron/src/renderer/main.tsx` hunk 3 (`@@ -98,13 +92,13`) routes "Something went wrong", "Please restart the app…" and "Reload" through `i18n.t('crash.*')`; ours hardcodes all three and en.json has no `crash.*` key. The manifest counted the file +8/−14 (the Sentry hunks) of upstream's +11/−17 | MISSED (user-visible: the ru crash screen is English; found 2026-10-08 by the audit, not by this sweep) | XS | UA12.181 |

Tidy (no rows; folded into the final wave): KanbanBoard.tsx's header says "Rebrand only" but onAddSubtask gained a 4th `connectionSlug` param (recorded only in other files' headers); `session-tools-core/src/context.ts` still promises PageToolDetails.grants are "empty until UA9.2" though UA9.2 landed and populates them.

## COVERED (representative dispositions; every candidate carried a named row/decision)

- **Owned by open rows of this plan:** chip lifecycle incl. workflow kind + 8 i18n keys → UA12.18 (`list_background_tasks` is not part of it: its one disposition is the (c) drop under UA4.11, below); codex verdict-in-earlier-message → UA12.76; emitSessionComplete snapshot iteration → UA12.37; keyboard drag → UA12.21 (OQ-14).
- **Owned by the 1.43.0 draft (EXCLUDED-OK "owned by UBx.y"):** the v0.14.0 decisions subsystem (UB6.6), automations loop guard + semanticCondition (UB4.8/UB6.9), input-viewport/composer-height family (UB5.4, manifest H), PendingSteers/keep-alive sink (UB2.1/2.3/6.13), Moonshot/Kimi presets (UB7.7), Pi session-settings retries as provider pre-stream retries (H7 → UB5.3), the steering pin (UB2.6), ChatGPT search following the active model (UB4.3), web_fetch's numeric-string argument (UB4.4), Opus 5.5/GPT-6 in the Pi catalogs with the Pi SDK lift (R14-28 → UB8.2; the models.ts Opus 5.5 rows are KEEP, ours, R14-29), model refresh after re-auth, the retired-id default guard and the DeepSeek alias (UB3.5–3.7), Windows CLAUDE_CODE_GIT_BASH_PATH + ChatPage isAbsolutePath (UB4.5), permission-remember/bash-validator v0.14 file shapes (UB1.2–1.9 — the behaviour itself already landed here as UA12.70–86).
- **Craft services dropped (a):** share service/viewer passwords + getShareCapabilities + setPublicationPassword (spec §6, channels.ts states the drop beside the constants; sharing-cut.test.ts guards); Craft oauth relays (Google/Slack/Copilot), docs MCP proxy, version manifest, installer domains; upstream release notes; the six non-en/ru locales.
- **Security (b):** webhook error/response bodies never cross the Safe wire (test-pinned); page credential dialog replaced by OAuth + agent hand-off; grants in the MACed ledger, never page.json.
- **Ours-better (c):** send_agent_message's real delivery verdict; list_background_tasks vs the CLI native feed (UA4.11 measured); CompactWorkingDirectorySelector vs free-text paths (typed paths cannot mint trusted handles); background-task notification rendered as a labelled system line (F1.351 controller decision) instead of hidden; createSession never broadcasts session_created by default (UA4.1 announceSessionCreated design — refutes the emitCreatedEvent:false "gap"); task JSON defaults/schemas byte-equal except our 6-mode permission set (stated).
- **Parity confirmations:** kanban colours/atoms/drag anatomy byte-equal; statuses defaults/icons byte-identical; task yaml defaults identical; ~57 of ~60 upstream feature test files present as supersets or title-identical; en↔ru parity clean across all feature namespaces (0 en-only, ru-only keys are legitimate CLDR plurals); DOC_REFS a superset; docs-site covers every upstream topic (upstream has no docs-site — pages written from hand-backs); RPC (re-measured 2026-10-08 over the quoted channel strings of `packages/shared/src/protocol/channels.ts`, upstream v0.13.4 / seed v0.10.5 / ours): tasks 12/12 upstream channels present (11 new since the seed), projects 9/9 (all new), automations 9/9 (none new since the seed), pages 21/23 (all new; `pages:getShareCapabilities` and `pages:setPublicationPassword` dropped with stated reason), and ours adds 17 in these four families that upstream lacks (the first reading said 10/10, 8/8, 22/24 and 12); tools: 9/9 in-scope session tools wired on all three runtimes.
- **Disposition lines recorded here for previously-silent exclusions:** upstream's Messaging/Telegram gateway (list_messaging_channels, unbind_messaging_channel, telegramTopic field + 3 keys, settings.messaging) is not shipped in the fork at all — field, UI, tools and keys all absent by scope; `chat.workInFolder`'s composer reader is owned by open 1.41.0-followup row F1.1266 (the TaskEditor half is a recorded UA3.6 non-port); automations.json raw-edit affordance replaced by the managed edit path ((c), consistent with the guarded record).

## Residues / notes for the owner and the next planner

1. **UNSURE items:** none — the live-case rows (UA1.12, UA2.7, UA3.9, UA4.12, UA5.11, UA7.6, UA8.5, UA9.5 ⬜; UA6.7 🟨; UA1.22/UA1.27/RS-117 owner sittings) are the plan's own proof obligations, held under UA11.1/UA11.5, not feature gaps: every entry, handler and tool resolves at HEAD.
2. **1.43.0 draft correction (do not forget):** `work/wi16/plan-1.43.0/covered.txt:37` lists SessionInfoPopover.tsx as covered — a false entry propagated from fb3a52d06's false premise; UA12.136's landing commit should also correct that line (or the next planner does).
3. **Manifest section I row 4's "+1"** (chat.workInFolder) should be struck or annotated when F1.1266 lands (doc tidy).
4. **Pre-existing, disclosed, not minted:** the per-workspace AutomationSystem map is disposed only at shutdown on workspace delete (no upstream counterpart — fails the absent lens); ios permission parent-routing is pre-existing on master.

## Gaps → rows

UA12.135–UA12.141 born ⬜ (final-wave rows per UA11.8's contract); UA12.29's file set extended by note. All are to land BEFORE UA11.1 (release-cut audit reads this report). UA12.181 (gap 8) born 2026-10-08 from the audit below and done in the VF wave.

## Corrections (2026-10-08)

An independent audit of this report (verification workflow `wf_fa262170-d99`, read-only, at `c3a777c5d`; its file
`nessy-wf-checkpoints/work/verify-2026-10-08/au-reconcile/reconcile-audit.md`) confirmed the verdict on 17 of 18
surfaces and found one miss plus some wrong counts and ids. Corrected in place above; each figure re-measured here:

- **The miss (gap 8, UA12.181):** upstream `renderer/main.tsx` is +11/−17 over v0.10.5..v0.13.4 (`git diff --numstat`);
  the manifest's row counted +8/−14 (the Sentry hunks, UA7.3) and hunk 3 — the crash screen's three `crash.*` strings —
  had no row. The manifest row's count and hunk-3 disposition are corrected with UA12.181. The 1.43.0 draft's
  `covered.txt` lists `main.tsx` as covered on the same "premise per hunk" reading as residue 2 (its line 138).
- **`list_background_tools`:** the identifier exists in neither upstream tag (v0.13.4, v0.14.0) nor in our code; the
  COVERED line now names only the chip lifecycle under UA12.18, and `list_background_tasks` keeps its single (c)
  disposition under UA4.11.
- **Absent i18n keys:** 56, not 41 — the upstream v0.13.4 en.json keys absent from v0.10.5 (314) minus ours, by a
  set difference over the three files' top-level keys (`git show <rev>:packages/shared/src/i18n/locales/en.json`),
  read at `c1338c0af`, before UA12.181's keys commit `19fb6fe82` (53 after it, no `crash.*` among them); the 56 match the audit's list key for key. The audit traced a disposition for every one (dead
  upstream, renamed in ours, (a)/(b)/(c), UA12.18, F1.1266, or a 1.43.0 H-list item) except the three `crash.*` keys,
  which are gap 8.
- **The v0.14.0 map:** `d14-map.json` maps 311 paths, equal to `git diff --name-only v0.13.4 v0.14.0 | wc -l`; 0 unmapped.
- **UB ids:** UB3.5–3.7 are re-auth model refresh, the retired-id default guard and the DeepSeek alias; Opus 5.5/GPT-6 in
  the Pi catalogs ride the Pi SDK lift (R14-28 → UB8.2); UB5.3 is the provider pre-stream retries that H7 (Pi
  session-settings retries) maps to.
- **RPC channel fractions:** re-measured as stated in COVERED; every upstream channel of the four families is present
  except the two pages channels dropped with reason (a).
