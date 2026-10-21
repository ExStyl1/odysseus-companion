# Ledger closure — promotions, already-open pointers and structural cells (2026-09-05)

The non-row output of the ledger-closure sweep: 47 ledger cells CLOSED_AT_HEAD (promote at the next ledger refresh, with the commit), 15 cells already covered by open plan rows, and the E1 structural pair. The 128 tracker rows themselves are in the plan (`P6.61`–`P6.188`).

## Ledger cells to promote at the next refresh

### A. The safety floor (A1, A2, A4, A5, A7)

*(none — no cell in this slice classified `CLOSED_AT_HEAD`. Two ledger `Why absent` narratives ARE stale at HEAD without the cell becoming covered: A7/codex's "the three-tier DSL is projected as two" and "`justification` is never emitted" are both false since P6.1 `9e37e0b6b`+`f34c4a44f` — `partial` survives on a different residue, carried by the A2+A7 row below. A1/codex's narrative never mentions that codex's own `auto_review` reviewer is fully wired and merely default-off.)*

### A. The safety floor (A8, A9, A10, A11, A12)

- A10-pi [pi] — `4dd2cc50d` + `0e106b4f4` + `592596b76` — a preloaded skill's `disallowed-tools` reaches the child and is enforced independently: producer `SessionManager.ts:15943`/`:16275`, transport `child-session-port.ts:179`, install `base-agent.ts:1451`, second enforcement check `prerequisite-manager.ts:448-455`; P2.327/P2.385/P2.402 all ✅, so `partial ᵗ` → `covered ᵗ`. Residue (swept by the A11-codex row below): the comment at `SessionManager.ts:15954-15960` still states P2.327's question as open.
- A10-claude [claude] — `4dd2cc50d` + `0e106b4f4` — the runtime does the subtraction natively and we feed it: `claude-runtime-agents.ts:649-653` unions skill `disallowedTools` into the descriptor's, `:787` and `:840` emit it on the `AgentDefinition`; documented by `sub-agents.md#available-tools`. `partial ᵗ` → `covered ᵗ`.
- A10-host [host] — `f717d95d3` (+ P3.337) — the codex role-drop is not silent: `'codex-agent-roles-dropped:'` is in `CODEX_CONFIG_WRITER_USER_FACING_PREFIXES` (`codex-agent.ts:416-424`), prefix-gated at `:3628-3629`, and `surfaceCodexOperatorNotice` (`:3536-3548`) pushes a real `AgentEvent` `{ type: 'info', level: 'warning' }` onto the turn sink, so a packaged build shows it. Switch cell `SILENT` → `HONEST` (ledger edit only, no code owed).
- A12-pi [pi] — `3353e3215` + `3161332d2` + `7421711dc` + `bcdd3bd71` — both bypasses closed: the gate sits INSIDE the fold (`runtime-pool-servers.ts:462`/`:484`, withheld names logged `:490-491`) and the browse mirror stamps `sourceEnabled: false` (`storage-runtime.ts:1153`, `:1179-1189`); a deny written with the resolved `dp` path now bites via `alternateCommands`. `partial ᵗ` → `covered ᵗ`, switch stays `HOST`.
- A12-claude [claude] — same four commits — runtime-independence MEASURED, not asserted: all six non-test callers of `isManagedMcpServerAllowed` (`runtime-pool-servers.ts:484`, `:540`; `storage-runtime.ts:1085`, `:1179`, `:1209`, `:1224`) sit above the runtime split and none is runtime-conditional. Documented by `managed-mcp.md#how-a-server-is-evaluated`. `partial ᵗ` → `covered ᵗ`.
- A12-codex [codex] — same four commits — codex's servers come through the same `toAgentRuntime` door; no gate call site exists under `packages/codex-responses-adapter` or `codex-agent.ts`, and the plugin-provided arm reaches the same `connectOnce` (`storage-runtime.ts:1197-1205`). `partial ᵗ` → `covered ᵗ`.

### B. What an organisation can actually enforce

- B1-pi [pi] — `3161332d2` — the ledger demotes Pi solely on "P2.368 (open)"; P2.368 is ✅ and the managed-MCP gate is live at `runtime-pool-servers.ts:458` (`applyManagedMcpPolicy`), with residues P3.217 `7421711dc` and P3.218 `bcdd3bd71` closed. Score `covered ᵗ`.
- B6-claude [claude] — `375ed4eb5` (with `f717d95d3`, `9c8cc034c`) — the ledger's "five unbound call sites" was a two-runtime inventory (three codex + two claude), and both halves landed 2026-09-03: `noteSwitchVisibleDegradation` (`claude-agent.ts:4393`) plus bindings at `:4622`, `:4714`, `:5497`. Score `covered ᵗ`.
- B8-pi [pi] — `d4df10ddf` — `getAdminAgentSkillsDirs()` (`skills/storage.ts:100-127`) reads the administrator roots, the loader consumes them highest-priority and not trust-gated (`storage.ts:626-632`), delivered via `base-agent.ts:1464` → `<available_skills>`. Score `covered ᵗ`.
- B8-claude [claude] — `d4df10ddf` (badge `e9764e923`) — same host loader and one capability inventory reach the claude prompt (`claude-agent.ts:7400`/`:7446`); the managed root matches `skills.md#where-skills-live` byte-for-byte at `storage.ts:121-126`, and `SkillSource` already carries `'admin'` (`skills/types.ts:143`). Delivery mechanism itself is sitting §2.3, not this cell. Score `covered ᵗ`.
- B8-codex [codex] — `d4df10ddf` (label `e9764e923`) — `/etc/codex/skills` first on Unix and `ProgramData/OpenAI/Codex/skills` on Windows (`storage.ts:107-127`), tier carried by `SkillSource` (`types.ts:143`, source measurement `:106-142`), delivered at `core/prompt-builder.ts:280` → `codex-agent.ts:5023`. The ledger's `absent ʰ` predates P6.8. Score `covered ᵗ`.

### C. What leaves the machine, and corporate deployment

_None._ No cell in this slice classified `CLOSED_AT_HEAD`. (Two cells are *held but unpinned* — C2/pi, C2/codex — which is a BUILDABLE pin, not a promotion; and two ledger reasons are stale rather than the verdicts: C3/claude's "closed binary" is refuted by P3.352, C2/claude's `—` is refuted by the marker test's own binary grep. Those are recorded in the rows below, not here.)

### D. Switching correctly

*(none — no cell in this slice classified `CLOSED_AT_HEAD`. Two ledger residue sentences ARE stale at
HEAD and one plan premise is refuted at HEAD; because the capabilities themselves stayed `absent`/`partial`
those are not promotions, and they are carried by the last row below.)*

### E. The context window

- E2:pi [pi] — `b09827acf` / `fe26568f5` — Pi already stamps window provenance: `contextWindowSource: 'unavailable' | 'fallback' | 'runtime'` at `packages/pi-agent-server/src/context-usage.ts:134-138`, a SHARED wire field (`packages/core/src/types/message.ts:683-687`) rendered in the composer and transcript (`FreeFormInput.tsx:2700`, `ChatDisplay.usage-format.ts:54-55`); ledger cell is `—`, not `partial`.
- E2:claude [claude] — `fe26568f5` / `1e982b7ea` / `a4bfdaae4` — the unknown-model assumed window is named and surfaced: `CLAUDE_UNKNOWN_MODEL_ASSUMED_WINDOW = 200_000` (`packages/shared/src/agent/claude-agent.ts:2005`), warning built at `:2044`, wired at `:3940` into `postInit`, delivered as a user-visible `info` event at `SessionManager.ts:18333-18340`.
- E4:codex [codex] — `e4c8fd7a1` (title: "the thrash guard named the loop and did not stop it") / `a4bfdaae4` / `cf7ceab19` — the auto-compaction thrash guard now interrupts the turn: `stopThrashingTurn()` at `packages/shared/src/agent/codex-agent.ts:2231` (sets `aborted`, sends `turn/interrupt` at `:2247`), called at `:3480` off `consumeAutoCompactionThrashTrip()`. The ledger's E4 SWITCH narrative still calls "codex's inability to interrupt mid-turn" the residual difference — stale by this same row.

### F. Sessions, checkpoints, recovery (F1, F2, F3, F4)

- F1/host [host] — `b7d3beba1` — the F1 Switch cell should read `HONEST ᵗ`, not `SILENT`: `fileCheckpointsTracked` is minted at `SessionManager.ts:21194`, carried on the RPC result and the `conversation_rewound` event (:21285, :21297) plus the `revertFileCheckpoint` failure path (:21065-21070), typed on the wire (`dto.ts:528`, :718, :1239) and read by two renderer surfaces (`ChatDisplay.tsx:1721`, `useSessionMenuActions.ts:221` via `rewind-report.ts:23`), with strings in both locales (`en.json:2065`, `ru.json:2101`).

### F. Sessions, checkpoints, recovery (F5, F6, F7, F8)

(none — no cell in F5/F6/F7/F8 is delivered at HEAD; the one candidate, F8/claude, was demoted from
`CLOSED_AT_HEAD` to `BUILDABLE M` because the L2 commits deliver the live session, not the capability)

### G. Hooks and automation

- G1 [host] — `325b1dff8` — the switch already names hook events that stop firing (`inertHookEvents` + `nativeHookEventRoutes`, `SessionManager.ts:20276-20292`, rendered `ChatPage.tsx:398-406` → toast `:415`, `en.json:410-411`/`ru.json:420-421`); SILENT → HONEST, the claude/pi silence is the honest refusal of an unmeasured table.
- G2 [host] — `764ee8662` (the `Feat/models fetch` merge; the original `0fca85638` lives on feat/models-fetch and is not an ancestor of HEAD) — the switch-time half is delivered: `inertHookKinds` names prompt/agent/mcp/http lost on the target (`SessionManager.ts:20253-20260`, gated on `peripheralsLost`), rendered `ChatPage.tsx:392-394` / `en.json:412`; SILENT → REPORTED.
- G3 [claude] — `f32ff0672` — component (skill and subagent frontmatter) hooks now dispatch on claude: the `provider !== 'anthropic'` gate is gone, `componentHookLayer` is supplied for every provider (`SessionManager.ts:16591-16596`, premise refutation written at `:16551-16576`) and the SDK path reads it via `buildComponentSdkHooks` (`hooks-automation.ts:586-593`, merged `:541`); `absent ʰ` → `covered ᵗ`.
- G4 [codex] — `0e9eae3ff` — both layers the capability names are the same `PostToolUse` event, and it is minted host-side on codex (`codex-agent.ts:2379-2421`, called `:3471`; `runtime-hook-events.ts:159` `emitted`), with the `command` runner unconditional off-Pi (`SessionManager.ts:16534-16535`); `absent ʰ` → `partial ᵗ` (a `block` decision and `updatedToolOutput` are still only debug-logged, `codex-agent.ts:2406-2418`).
- G4 [host] — `325b1dff8` — F32.2/D1 is answered: a command hook's EVENT does reach a user surface (`SessionManager.ts:20262-20277`, defect quoted verbatim in the comment; `ChatPage.tsx:398-399` → `:415`); SILENT → REPORTED.
- G5 [host] — `e2707e0c2` (+ `325b1dff8`) — the codex projection boundary is stated on three surfaces: session fact + `debug()` on every build (`codex-agent.ts:2036-2037`), the panel notice (`ProjectHooksPanel.tsx:245`, `en.json:1929`/`ru.json:1963`, code at `capabilities/views.ts:570`) and the switch's native-route line (`SessionManager.ts:20282`); SILENT → HONEST.

### H. Subagents, workflows, review (H1-H5)

- H3 [claude] — `b8cda17c8` (P6.15), `1fd3f937e` (P2.421), `720e84d6b` (P2.528) — all three residues the ledger names are gone: `resolveAdvisorModel` (`advisor.ts:491`) returns `{ via: 'refused-capability' }` at :504 judged by `judgeAdvisorPairing` against `advisor.md#choose-an-advisor-model`, the refusal states its reason, and the "ZERO surface" IPC exists at `channel-map.ts:395-396` — dated 2026-09-03, after the ledger's own 2026-09-01 measurement; one host-shared resolver serves all three (`base-agent.ts:5344`, :5551).
- H5 [pi] — `250d3f818` (P6.17), extended by `5f4224bd6` (P3.232) — a zero-tool subagent is refused at spawn: the verdict is minted in the builder (`runtime-agent-definitions.ts:399-405`, carried at :414) and acted on in `spawner.ts:752-755`, with the message at :1058-1068 quoting `errors.md#agent-would-be-spawned-with-zero-tools` verbatim; record BOTH commits, because P3.232 moved the pool-free half into `agents/definitions.ts` so both loaders enforce it.
- H5 [host] — `38426caae` (P3.337) — the switch symptom ("an empty or confusing subagent result") no longer occurs on any runtime: Pi refuses at spawn, claude refuses NATIVELY (`strings -a` on the shipped SDK binary → `spawned with zero tools` 1, `tengu_subagent_zero_tools` 2), codex denies the whole role at config build and names it on a user-facing aggregated notice (`formatCodexAgentRoleDropDiagnostics`, `config-writer.ts:1767` → :3394; prefix listed at `codex-agent.ts:423`). Residue is timing only: codex refuses at session start, the other two at spawn.

### H. Subagents, workflows, review (H6, H7, H8, H9)

- H8/host [host] — `38426caae` (P3.337) + `0d162a6cb` (P3.345) — switch verdict `SILENT` → `REPORTED`: a dropped codex agent-role tool grant reaches the user as one `{ type: 'info', level: 'warning' }` turn notice naming every dropped key, not a `debug` line — `config-writer.ts:1657` `denied.push` → `formatCodexAgentRoleDropDiagnostics` (:1767) → `opts.onDiagnostic` (:3394) → `codex-agent.ts:2871` → `noteCodexConfigWriterDiagnostic` (:3628) → `surfaceCodexOperatorNotice` (:3536), prefix armed at `codex-agent.ts:423`.

### I. Isolation and worktrees

*(none — no cell in this section classified `CLOSED_AT_HEAD`; every ledger verdict in I1–I5 is still true at HEAD `34be43fde`.)*

### J. Tools, MCP, browser, attachments (J1, J2, J4, J5, J6)

- J1/Pi [pi] — `eac393187` (P2.355), `c7434b285` (P2.366+P2.367), `99ce75988` (P3.320) — Bash output ceiling and timeout ceiling both bind on the Pi path: `applyBashOutputLimits` at `local-tools/runtime.ts:334`, ring sized by `resolveBashReadBackChars` at `process-store.ts:93`, `clampSupervisedChildTimeoutMs` at `process-supervisor-port.ts:283-288`; ledger `partial ᵗ` is stale.
- J4/Codex [codex] — `9375472e7` / `a0c4bf5a9` (P3.344) — MCP resources are live on codex: `pool-server.ts:396` declares `resources: {}` unconditionally, `:465-487` serves `resources/list` and `resources/read`; codex's gate is one `context.mcp.has_servers()` and we always emit `[mcp_servers.sources]` (`config-writer.ts:2963`). Two stated residues (`resources/templates/list` method-not-found, alphabetical uri disambiguation).
- J6/host [host] — `86ef06f21` (P2.373), `b0a0b9088` (P2.474), `338f44d4c` (P2.463) — the browser loss IS named to the user: switch-cost row `appActions` (`runtime-switch-costs.ts:583-588`, `on['codex-runtime']: false`) and `en.json:421` / `ru.json:431` name the browser pane. The ledger's `SILENT` should read REPORTED; `honest_surface: present`.

### J. Tools, MCP, browser, attachments (J7-J11)

- J10/host [host] — `589d07c33` + `ca0d0a01b` (P3.342, W5-a 2026-09-04) — the `webSearch` switch-cost row ships at HEAD (`runtime-switch-costs.ts:972-977`), fires Pi→claude and Pi→codex (`:1025`), renders through `RuntimeSwitchDialog.tsx:92`, and both locale strings exist (`en.json:430`, `ru.json:440`); the ledger's `SILENT` is stale.

### K. Models, effort, streaming

- K4-pi [pi] — `e3f0a485c` (P2.309) — the mini-model preference table is Pi's own (`pick-mini-model.ts:75`, `llm-connections.ts:1053` `'openai-codex': ['gpt-5.6-luna','gpt-5.4-mini']`), the ChatGPT card is `providerType: 'pi'`, and the unresolvable candidate is named on stderr by `warnMissingPin` — so the row's `covered ᵗ` belongs under Pi, and the Codex cell must be re-examined because the closing commit touches no codex-runtime path.

### L. Instructions, memory, skills, plugins (L1-L4)

*(none — no cell in this group is delivered at HEAD)*

One ledger-adjacent staleness to fix in whichever lane touches it first, not a promotion:
`docs/architecture/runtime-capability-gaps.md:39` still reads "**The Bash tool has no operator ceiling** | **DEFECT — open** … Pi honours neither", which is stale — `packages/shared/src/agent/pi-harness/process-supervisor-port.ts:202/:214/:270/:283` and the production caller `packages/shared/src/agent/pi-agent.ts:7248` land the ceiling (`3e66f5fbb`, `bab575dd2`). Two further stale lines are named in the L4-pi question below.

### L. Instructions, memory, skills, plugins (L6, L7, L8, L10)

- L8 [pi] — `2ca62756a` — the builtin `Concise` style now carries the page's safety carve-out verbatim (`packages/shared/src/prompts/output-styles.ts:139`); ledger `absent ʰ` -> `covered ᵗ`.
- L8 [claude] — `2ca62756a` — same constant, same commit; builtin styles are runtime-independent (one `resolveOutputStyleComposition`, six builtins at `output-styles.ts:110-202`, all `keepCodingInstructions: true`); `absent ʰ` -> `covered ᵗ`.
- L8 [codex] — `2f19db3ff` + `2ca62756a` — the `n/a` rested on "codex receives no style at all", refuted at `packages/shared/src/agent/codex-agent.ts:3169`/`:4643`/`:4670` (`developerInstructions: codexDeveloperInstructions(this.activeOutputStyle()?.prompt)`); the carve-out reaches codex as the first `developer` item; `n/a` -> `covered ᵗ`.

### L. Instructions, memory, skills, plugins (L11, L12, L13, L15, L16)

None. No cell in this slice is delivered at HEAD. Three cells are *partially* delivered and the delivered
halves are already promoted by their own closed rows — `P6.39` (`7467a72a9`, entry `headers` parsed, filtered,
origin-bound) and `P3.220` (`0d0f8e336`, marketplace `url`-source headers + `disableCommandPluginSources`) for
L12, and `P6.40` (`21664a82b`, the `#ref` pin honoured and `managedMarketplaceSourceIdentity` narrowed) for
L13. What keeps those two ledger rows at `partial` is named in the rows and the questions below, not a stale
verdict.

### M. Observability and diagnostics

- M3 [host] — `de21285c4` + `e21e4a46b` — `/heapdump` names, per runtime, the process it captured and the one it did not; the provider argument is actually passed at `SessionManager.ts:24567`, an unknown provider reads as NOT captured, and a new runtime breaks the build — verdict owed: HONEST, not SILENT.

Two further ledger edits are owed but are not promotions (nothing new landed; the cells were measured and never written back):

- M3 [codex] — `de21285c4` — the `—` is stale: `heapdump.ts:114-119` encodes `captured: false`, reason "codex publishes no heap-snapshot or memory request in its protocol"; re-probed at HEAD (`grep -arl -iE 'heap|memoryusage' packages/codex-protocol/generated/v2/` → 0 of 562 files, control `snapshot` fires). Verdict owed: `absent`, STRUCTURAL, honest.
- M2 [codex] — `1b1a84afb` (P2.422) — the `—` predates the row that wired it: `codex-agent.ts:2720 fetchImpl: gatewaySessionFetch(this.config.session?.id),`. Verdict owed: `partial`; only a packaged run can raise it (see the measure row below).

### N. Cross-session messaging

- N3-host [host] — `eca15b012` (+ `9d76ef12e`) — a bridge-less codex session is told twice over: the model gets `<scheduling_unavailable>` (`codex-agent.ts:1773-1785`) and the user gets a warning-level info notice spliced into the turn via `surfaceCodexOperatorNotice` (`codex-agent.ts:1846` → `:3536-3549` → `flushPendingServerWarnings` `:3700-3705`), string carried in both locales (`en.json:237`, `ru.json:247`) — so the N3 Switch verdict is REPORTED, not SILENT, and the "no diagnostic anywhere" sentence must be deleted.

### O. Notifications, UI, accessibility

- O2 [pi] — `10a95a639` + `55723b171` + `e9764e923` — hotkey overrides persist: writer `hotkey-overrides.ts:286` `HOTKEY_OVERRIDES_PREFERENCE_KEY`, `registry.tsx:166-172` `commitOverrides` → `saveHotkeyOverrides`, 27 rebind rows with collision notice, unbind stores `null`, per-row reset (`ShortcutsPage.tsx:156,188,236,247`); residue is two absent search verbs on `learn.chatgpt.com/docs/reference/settings.md` §Keyboard shortcuts, not a second population of chords.
- O2 [claude] — `10a95a639` + `55723b171` + `e9764e923` — same renderer path, `ˢ` was propagation: `hotkey-overrides.ts`, `registry.tsx`, `ShortcutsPage.tsx` contain no `providerType` / `provider ===` test and the SDK child has no keyboard surface.
- O2 [codex] — `10a95a639` + `55723b171` + `e9764e923` — same commits, no provider branch; codex's own TUI keybindings govern its terminal only and P6.49 measured that sibling before discounting it.
- O3 [pi] — `5f6009b2e` — three notification-timing positions plus two alert-class toggles ship host-side: `notification-timing.ts:23,30,44`, `useNotifications.ts:249`, `App.tsx:882,1059`; 22 files, +732/−52, and `git show 5f6009b2e | grep -ci 'providerType|provider ==='` → 0, so the host claim is measured; the replaced boolean migrates on read.
- O3 [claude] — `5f6009b2e` — same commit and files, `ˢ` stale; Claude Code's own `preferredNotifChannel` is a terminal-bell family a headless SDK child cannot use, so the host layer is the only one available.
- O3 [codex] — `5f6009b2e` — same commit; codex's operator `notify` / `agent-turn-complete` program hook was found, priced and deliberately NOT enabled — no writer emits a `notify` key (`project-config.ts:115` is a passthrough name only) and `strings -a` on both shipped mac `codex-app-server` binaries gives `"notify"` 0 with `agent-turn-complete` 1.
- O4 [pi] — `205965046` — the queue strip's fourth verb is server-authoritative: `QueuedMessageList.tsx:89-104` (two buttons, `disabled` at the ends, `aria-label` `chat.queue.moveUp`/`moveDown`) → `ChatInputZone.tsx:147,209` → `types.ts:410` → `SessionManager.reorderQueuedMessage`, new order returned through `queue_changed`, no-op move broadcasts nothing.
- O4 [claude] — `205965046` — same commit; `reorderQueuedMessage(sessionId, messageId, toIndex, workspaceId?)` takes no provider argument and `sessions.ts:681` passes only `ctxWorkspace(ctx)`; the SDK child never sees the host queue.
- O4 [codex] — `205965046` — same commit; codex's own queue is its TUI's (`learn.chatgpt.com/docs/prompting.md:162-164`, Enter-to-steer / Tab-to-queue), a different surface, and its app-server exposes no queue-reorder request.
- O6 [host] — `443d02b87` + `5afd7772a` + `bf57cd37c` — the honest-divergence surface for notification loss is delivered and rendered by a live dialog: `RuntimeSwitchDialog.tsx:18,92` `runtimeSwitchCosts(fromRuntime, toRuntime)`, row `runtime-switch-costs.ts:797-801`, emission filter `:1025`, copy `en.json:429` + `ru.json:439`; reclassified from STRUCTURAL because the sibling codex cell shows the host CAN close it. Carry: the codex build below must flip `:800` to `true` and update `scripts/cdp/cases/cru-3.ts`, which holds both sentences by value.

## Structural at HEAD — nothing to build, honest surface already present

- E1 [codex] — STRUCTURAL, scope in: confirmed from the fetched Rust source (rust-v0.148.0), not from the host's quotation of it; nothing to build.
- E1 [host] — STRUCTURAL, switch verdict REPORTED is terminal: both locale keys confirmed at HEAD, the copy is rendered rather than declared; no owner input, no build. (Critic (a) listed E1 as unrepresented because a STRUCTURAL cell with its surface present produces neither a row nor a question — recorded here so the ledger row is accounted for, 2026-09-05.)

## Already open

### A. The safety floor (A1, A2, A4, A5, A7)

- A1-claude [claude] → P3.141 (plan `:3309`, ⬜) — ruled OFF in P3.139 under the standing delegation; P3.141's realistic-transcript measurement is the only thing that reopens it. No new row, no new question.

### A. The safety floor (A8, A9, A10, A11, A12)

None. Measured: of the 22 open rows (`⬜`/`⏸`) in the plan, exactly one names a ledger cell (`P6.9` — Ledger C4), and a scan of every open row's note for `useAutoModeDuringPlan`, `--restricted`, `restricted mode`, `skillDisallowedTools`, `disallowedTools`, `composer-permission-modes`, `FullDesc`, `managed-mcp` and `isManagedMcpServerAllowed` returns zero hits. The two neighbouring residues named by the input cells (A2-codex's `bypassPermissions` on-request arm, P2.197's stated cost) sit on ✅ rows, not open ones, so nothing here duplicates an open row.

### B. What an organisation can actually enforce

None. All 22 open plan rows were read (`grep -a '^| P' … | glyph ∈ {⬜,⏸}`); none names a B-row capability.
Checked by mechanism over the open-row text: `policyHelper` 0, `managedMcp` 0, `allowManagedMcpServersOnly` 0,
`disabledPermissionModes` 0, `configRequirements` 0, `getAdminAgentSkillsDirs` 0, `requirements.toml` 0, `newThread` 0.
Two adjacencies read in full and rejected as cover:

- P3.297 (⬜, `df32458af`) is the skills DELIVERY posture (sitting §2.3) and its PKG-4 measurement drove the project cwd, never the enterprise root — so it does not cover B8-host's double-supply question; the new row cites it as the prior.
- P2.318 (⏸) is the `openai-codex` OAuth-card preference list, PARKED as GATED under the owner's 2026-08-29 "do not build, do not delete" ruling — a different surface from B5-codex's machine `requirements.toml`.

### C. What leaves the machine, and corporate deployment

- C4/pi [pi] → P6.9
- C4/claude [claude] → P6.9
- C4/codex [codex] → P6.9

All three are the corporate-launcher seam, `⏸` on P6.9 by the owner's 2026-08-28 DEFERRED-LAST ruling (plan :3567, :31, :672-674). No duplicate row. The one thing P6.9 does **not** cover is the residual announcement cost on claude, which is a separate BUILDABLE surface — row S1 below.

### D. Switching correctly

*(none — the 22 open rows of `docs/superpowers/plans/2026-08-22-runtime-parity-closure.md` were read; not
one of them names hook-event emission columns, the capability-gaps reverse totality, reasoning carry, or
image re-attachment. `P6.13`, `P6.14`, `P6.28`, `P3.57`, `P3.102`, `P3.116`, `P3.280`, `P2.291`, `P2.379`
and `P4.4` all appear in the cells' `plan_rows_read` and are all CLOSED, so no duplicate is created.)*

### E. The context window

None. Every ⬜/⏸ row at HEAD was read (22 rows); `grep -aiE 'compact|context window|autoCompact'` over them returns 0, so no open row covers any E-group cell and no duplicate is created.

### F. Sessions, checkpoints, recovery (F1, F2, F3, F4)

- (none) — every plan row that names F1–F4 is closed at HEAD (`P3.31`, `P3.48`, `P3.59`, `P3.71`, `P2.371`, `P2.500`, `P3.296`, `P6.56` all ✅); none of the ~22 rows still ⬜/⏸ touches rewind, fork, or the runtimes' own session stores.

### F. Sessions, checkpoints, recovery (F5, F6, F7, F8)

(none — `grep -a '^| P'` over the plan, filtered to the 22 rows whose glyph is ⬜ or ⏸, names no F5/F6/F7/F8
cell; the four rows this slice touches — P6.57, P6.58, P2.523, P3.158 — are all ✅. P4.1 and P4.3 are ⬜ panel
rows under the same Phase-4 playground gate that governs F6's FORM, but neither renders this snapshot, so
neither covers an F6 cell)

### G. Hooks and automation

None. The 22 open plan rows were read in full: `grep -ac` over them for
`pluginHttpHookRunner|pluginMcpToolHookRunner|pluginPromptHookRunner|pluginAgentHookRunner|allowedHttpHookUrls`
→ 0 and for `PostCompact|StopFailure|componentHookLayer|inertHookEvents` → 0. Only two open rows mention hooks
at all and neither covers a G cell: **P3.297** is native SKILL delivery on claude (sitting §2.3 — it does not
reopen G3/claude, whose closure is host dispatch), and **P6.9** is ledger C4, the corporate-launcher seam for
hook process launches.

### H. Subagents, workflows, review (H1-H5)

None. Every plan row the twelve cells cite is closed (P2.1, P2.168, P2.202, P2.212, P2.315, P2.341, P2.421, P2.502, P2.528, P3.13, P3.34, P3.86, P3.204, P3.232, P3.276, P3.277, P3.301, P3.337, P3.347, P4.5, P6.15, P6.16, P6.17 — all ✅; P3.275 is 🟨 for `context: fork` on Pi only, a different capability). All 22 open rows (⬜/⏸) were read: none names a subagent, workflow, review, advisor or agent-role surface, so no row here duplicates one.

### H. Subagents, workflows, review (H6, H7, H8, H9)

None. All 22 open rows (`⬜`/`⏸`) were read at HEAD and none covers an H6–H9 cell: `worktree`, `maxBudget`, `isolation` (as subagent isolation), `send_agent_message` and `list_sessions` score zero across their titles and notes, and the three open rows whose text contains "goal" use it in the ordinary sense (P2.335 cloud agent, P3.297 skills, P6.9 launcher seam). The goal chip's own row, P4.2 (`a3cbeed00`), is ✅ as a playground draft, so there is no open row to attach H9 to either.

### I. Isolation and worktrees

*(none — zero of the ~22 open rows (`⬜`/`⏸`) mention `worktree`: `grep -a '^| P' <plan> | awk -F'|' '$4 ~ /⬜|⏸/' | grep -ac worktree` → 0. P2.11 background auto-commit is the nearest-looking row and is a DIFFERENT mechanism — sitting §1.7 / DR-2 — so no row here may absorb it.)*

### J. Tools, MCP, browser, attachments (J1, J2, J4, J5, J6)

*(none — every plan row these five ledger rows cite is closed: P6.14 `cef00cd4e`, P6.23 `a5c4e225e`, P6.25 `11b21607f`, P6.26 `902a4c9f4`, P6.27 `0e328a029`, P6.30 `369603de9`. Checked against the 22 rows whose glyph is ⬜ or ⏸ at HEAD; none names tool search, MCP resources, MCP transport timeouts or the browser bridge. P4.10 is adjacent only — it parks a NEW settings surface, and no row below adds one.)*

### J. Tools, MCP, browser, attachments (J7-J11)

- none. No open plan row (⬜/⏸) covers any J7–J11 cell: the only ledger id among the ~22 open rows is `Ledger C4` (P6.9), and the single `egress` hit is P3.179's `supportsImages` fixture row. J11/codex's network half is plan **OQ-11** (heading line 2303) — an open *question*, not a tracker row, so it is carried into `questions-J2.md` instead of being counted here. P3.330 (⏸, sitting §1.1) measured filesystem containment under the seatbelt wildcard, not shell egress, so it does not cover J11/pi or J11/claude.

### K. Models, effort, streaming

- K4-host [host] → P2.318 (⏸, PARKED as GATED under the owner's 2026-08-29 ruling on the subscription surfaces — plan lines 718-724, 2959). No new row and no new question.

### L. Instructions, memory, skills, plugins (L1-L4)

- L4-codex [codex] → P3.297 (⬜, `df32458af`) — the same host-rendered-skills posture; it is the §2.3 half of what gates the codex `skills/extraRoots/set` arm. No new row.
- L4 [claude] → P3.339 (glyph 🟨, commit `216da994a`, IN PROGRESS — outside every slice's ⬜/⏸ denominator): the `--add-dir`-reaches-the-child-argv measurement with a host-rendered workspace skill as positive control is P3.339's own declared FIRST TASK; the stitched row that restated it was removed (critic (e), 2026-09-05).
- L4 [host] → P3.339 (same row): one `additionalDirectories` setting, three treatments, one diagnostic naming which of the three answers a session got — P3.339's 'minimum honest change' and sitting §1.4's decision; the stitched row that restated it as a `describeAdditionalDirectoriesAcrossRuntimes` report was removed (critic (e), 2026-09-05).

### L. Instructions, memory, skills, plugins (L6, L7, L8, L10)

- (none) — the 22 open plan rows were grepped for `getGuidanceSections`, `runtime-capability-gaps`, `output style` / `output-style`, `keep-coding`, `instructions`, `system prompt`, `guidance`: zero hits. `P3.297` (⬜, sitting §2.3) is skill DELIVERY on claude, not the listing budget, and covers no cell in this slice.

### L. Instructions, memory, skills, plugins (L11, L12, L13, L15, L16)

- L16 [claude] → **P3.297** (`df32458af`, ⬜) — "skills reach claude as host-rendered prompt text, not as the
  filesystem artifacts the runtime loads". Same cell, same posture, already on the sitting page as **§2.3**
  with its 9/9 packaged measurement and two options. No duplicate row.
- The **LSP half** of L15 [claude] and L15 [host] is downstream of that same row: `sdk.d.ts` declares no `lsp`
  option at all (0 occurrences) while the extracted native binary carries `lspServers` 50 times under the
  *plugin manifest* schema, so the only claude route to a plugin-provisioned language server is native plugin
  delivery — P3.297 / sitting §2.3. The rows below therefore close the **monitor** half only and require
  `lostLsp` to keep listing the LSP servers; no duplicate row is created for the LSP half.

### M. Observability and diagnostics

*(none — no open plan row covers M1, M2 or M3. Checked: the 22 rows whose glyph is ⬜/⏸ carry zero hits for `telemetr|otlp|otel|heapdump|CUSTOM_HEADERS|observab`; the only rows naming Ledger M1/M2/M3 are P6.42, P6.43, P6.44, all ✅.)*

### N. Cross-session messaging

_None. `grep -an 'cross-session|send_agent_message|crossSessionInbound|dialogExpiry'` over the plan returns lines 1649, 1654, 1690, 2617, 2664 — all inside closed rows (P6.45/P6.46/P6.47, P2.460, P3.222) or outside the Owner-decisions ranges 11–1148 / 2406–2600. No OPEN plan row covers any cell of section N._

### O. Notifications, UI, accessibility

(none — all four rows that ever named these cells are closed: P6.49, P6.50, P6.51, P6.52, plus P2.441, P2.485, P4.6, P2.512. Over the 22 open plan rows, `grep -ac` for `PushNotification`, `midStream`, `notif`, `hotkey`, `steer`, `Shortcut` returns 0 each; the two `queue` hits are substring noise in unrelated rows.)


## Row-file notes

Verbatim prose the per-group row files carried outside their table (ordering rationale, cells
deliberately without a row, mandated-vs-residue splits). Not tracker rows.

### H. Subagents, workflows, review (H1-H5)

Order is by user-visible value: a live feature the user cannot control, then the review scope the model
actually follows on two runtimes, then the switch honesty surface, then the two measurements (knowledge,
not user-visible change). Rows 1-3 are BUILDABLE; rows 4-5 are MEASURE and must not be turned into
ledger fills before their control runs.
No rows for the three `CLOSED_AT_HEAD` cells (promotions above) or the two `OWNER` cells
(`questions-H1.md`). H2 [codex] is STRUCTURAL with `honest_surface: present` on all four routes
(`WORKFLOW_DISPATCH_SUPPORT` at `runtime-agent-support.ts:229`, `'codex-runtime': false`, and
`base-agent.ts:4694` refusing a `workflowInvocation` by name with `settings.ai.workflows.dispatchUnavailable`),
so it earns no surface row.

### J. Tools, MCP, browser, attachments (J7-J11)

### Cells deliberately without a row
- J10/host — CLOSED_AT_HEAD, promoted above.
- J8/pi, J8/codex — STRUCTURAL with `honest_surface: present` (pre-send grey-out via `composer-capabilities.ts:317` + `modelSupportsImages` at `llm-connections.ts:891-913`; post-send legibility via `errors.ts:575`, P3.138 `a0f377646`; codex's `HANDOFF_IMAGE_NOTE` at `runtime-handoff.ts:138-142`). Nothing to build: the refusal is the endpoint's, and it is already legible. See the already-ruled list in `questions-J2.md`.
- J7/pi, J7/claude, J7/codex — OWNER (one question, three cells; the pane is host-owned, so a split answer would itself be the divergence).
- J8/claude — OWNER (demoted from BUILDABLE: the owner ruled this exact seam on 2026-08-28).
- J11/codex — OWNER (its `honest_surface: missing` residue is covered by the J11/host row above).

### K. Models, effort, streaming

Ordered by user-visible value: a toggle the user pays for when it does not bite (K3), builtin subagents silently running on the expensive session model (K7), live tool-input streaming (K5), alias substitution (K6), then the measurements. Sequencing constraints are named in each note.

### L. Instructions, memory, skills, plugins (L11, L12, L13, L15, L16)

**Two cells deliberately carry no row.** L16 [pi] and L16 [codex] are STRUCTURAL with `honest_surface: n/a`, not
`missing`, so the brief's "a missing surface is itself BUILDABLE S" does not fire: on Pi the harness declares no
`Skill` built-in at all (positive control run, because `n/a` is a removal-shaped verdict —
`packages/pi-agent-server/src/__tests__/harness-contract/fixtures/tool-surface.json`, `grep -aoc '"Skill"'` → 0
while the same file lists `"Bash"`, `"Task"`, `"SlashCommand"`, `"AskUserQuestion"` and 35+ other built-ins), so
nothing is being withheld; on codex, *Claude's* mechanism has no subject because we materialise no skill into
`CODEX_HOME` — that is ledger L9 and the per-session-home decision in **P3.296** (`f717d95d3`), not this row, and
the ledger's `config-writer.ts:664` cite is dead at HEAD (the "no codex counterpart" sentence is
`packages/codex-responses-adapter/src/config-writer.ts:1623` and is about an agent-role descriptor's `skillKeys`).
**One row is owed only if the owner delegates.** The L11 trio's `honest_surface` is `missing`, but the cells are
OWNER, so no row is written ahead of the ruling. Option **B** of that question (detect a vendor spelling and say
so, without resolving it) is the lane-sized surface and is ~S–M host-only; the site deferred **aliases** (option
C) alone — `packages/shared/src/agent/core/prompt-builder.ts:262-292` — so B can be delegated under the standing
transparent-and-simple rule and would then become one row here.


# Denominator sweep (P6.190) — promotions, already-open pointers, structural cells, provenance

The non-row output of the denominator→rows compose (2026-09-05): 14 CLOSED_AT_HEAD promotions, 14 entries already carried by unfinished rows, 10 STRUCTURAL cells with their surface present, and the slice provenance. The 285 rows are P6.191–P6.475 in the plan.

## Promote

### A#0

None. No entry in this slice carries klass `CLOSED_AT_HEAD`. Four entries (A50, A51, A53, A54) are recorded by the sweep as **delivered at HEAD and unrowed**, but each is classified `MEASURE` because the delivery is read from source and never driven, and none carries a commit — they are dispatched below as measurement rows whose done_means is the ledger row plus its switch verdict.

### A#1

- A80 [claude] — `989ff839c` (plan row P3.178, ✅) — the page documents `PostToolUse.classifierContext` and the vendored bundle does not have it; closed with a **version-conditional** contract test that flips when the bundle catches up (`claude-vendored-sdk-contract.test.ts:48-53`, `:206-219`), positive control `updatedToolOutput`. Re-probed at HEAD: the identifier appears in 5 tracked files, all plan/spec prose plus that test. Ledger blind spot, not an open gap. **The bundle CAUGHT UP on 2026-09-11 and the version-conditional test did the one thing it was built to do — it flipped.** Re-measured against the vendored `0.3.247` / `2.1.247`: `classifierContext` scores 1 in `sdk.d.ts` (declared on `PostToolUseHookSpecificOutput`), 0 in `sdk.mjs` and **26** in the native binary, counted with `grep -aoF` against negative control `nessyNotARealSdkKey` → 0 on each artefact; the 0 / 0 / 0 above is the `0.3.233` reading and is kept as the before. P7.14 (`9ecf0be1f`) then wired it end to end — parsed nested-only, kept on `PostToolUse` alone by the contract table, joined across hooks rather than last-writer-wins, and forwarded FRAMED so a third-party hook's sentence cannot borrow the host's weight. The identifier is in **21** tracked files now, and nine of them are source or test rather than prose, so the "all plan/spec prose" clause is dead too. The promotion this entry was holding is therefore SPENT: A80's claude cell is `covered ᵗ` in the ledger as of P6.1055, and so is G25's. One clause no unit test reaches survives — the classifier's own weighting inside the binary — carried as RS-30 on the live checklist.

### B#0

- B37 [pi][claude][codex] — `34be43fde` (built earlier; verified on the production path at HEAD) — `managed-settings.d/` drop-in merge is CLOSED_AT_HEAD under our spelling `managed-policy.d/`: `managed-policy-loader.ts:69-74` `managedPiPolicyDropInDirForPlatform`, `:304-338` `listDropInFragments` with `.sort()`, `:409-437` base-then-fragments through `mergeManagedPolicySources` with per-field provenance, reached in production from `managed-policy-resolution.ts:162` and `apps/electron/src/main/index.ts:1276`; the ledger carries no row for it, so the promotion IS the work. Residue (BUILDABLE S): the page's per-kind combination rules (`managed-settings.md:184`) are not individually pinned against `mergeManagedPolicySources` — carried by the pin row below.
- B38 [pi][claude][codex] — `34be43fde` (built earlier; verified on the production path at HEAD) — entry-by-entry tolerant repair with the ten enforcement keys failing CLOSED is CLOSED_AT_HEAD: `parseManagedPiPolicyTolerantV1` (`managed-policy.ts:2281-2288`) called by `managed-policy-loader.ts:433` inside the loader both hosts use; fail-closed clauses cited to `managed-settings.md#keys-that-fail-closed` at `:52-81`, `:597-599`, `:690`, `:736-740`, `:758`; plan of record `docs/superpowers/plans/2026-07-28-managed-policy-tolerance.md`. Residues: the ten-key table needs re-pinning on each corpus refresh (pin row below), and the non-object fail-OPEN arm is B29's subject, rowed below.

### C#0

- C27 [pi][claude][codex] — HEAD `34be43fde` (no single commit named by the sweep; the mechanism is in place on all three spawn paths) — the corporate-HTTPS-proxy capability is delivered and its residue is already named in code: `packages/codex-agent-server/src/runtime-manager.ts:110-133` (`applyLoopbackNoProxy`) with the residue at `:94`, `packages/shared/src/agent/options.ts:374-389` (`applyLoopbackProxyExemption`, applied last to the MERGED env), `packages/shared/src/agent/pi-agent.ts:211-236` (four measured arms — sink proxy plus no exemption = turn FAILED), `packages/shared/src/config/network-proxy-utils.ts:230-240`; no ledger row enumerates the capability, so it is a promotion, not a build.

### D#0

*(none — no entry in this slice is a STRUCTURAL cell whose honest surface must be promoted separately; both buildable surfaces are carried by the two rows below.)*

### E#0

- E10 [pi] [claude] [codex] — `845cf0a41` (claude `SDK_SLASH_COMMANDS = ['compact']`, `claude-agent.ts:5585`) + `764ee8662` (codex `thread/compact/start`, `codex-agent.ts:5208`) + `845cf0a41` (Pi manual-compaction RPC, `pi-agent.ts:1516`) — manual compaction is delivered on all three through each runtime's own seam and the honest surface is already present (`composer-capabilities.ts:281` WITHDRAWS `/compact` when `contextUsage.compact.manual === false`, re-read at HEAD; host gate `base-agent.ts:4954`/`:5306`); nothing to build — mint the ledger row `covered ᵏ`×3 (code read, not a live run) and let a CDP case upgrade the marker.

### F#0

- F44 [pi] [claude] [codex] — `36c4258f7` (SessionStore mirror contract and failure envelope) + `ce4d8cab4` (wired into persistence with the directory adapter) — mirroring session transcripts to an external store so another host can resume them is DELIVERED and host-supplied once for all three (`packages/shared/src/sessions/mirror/{types,host,envelope,restore,directory,in-memory,conformance,summary-fold}.ts`; refusal envelope at `mirror/host.ts:7` and `SessionManager.ts:4431`; live-proven CDP pass 10, coverage-map row 142). The ledger has no row at all — mint it `covered ᵗ`×3 and carry the TWO deliberate divergences no cell states today: our key is the composite workspace/session key rather than Claude's `projectKey`, and file-checkpoint blobs are not mirrored. Claude's own `sessionStore` option (`sdk.d.ts:1613-1624`, `@alpha`) is deliberately not passed — no shipped runtime consumes it (positive control on the same file: `settingSources` = 5 hits).
- F45 [pi] [claude] [codex] — `985b5916c` (session cron service and scheduled delivery generalized across runtimes) + `fd88c11b9` (the monitor half, `sweepRestoredMonitors`) — restoring unexpired scheduled tasks on resume while NOT restoring background Bash and monitor tasks is delivered on the shared session load path, uniform by construction with no provider branch: `SessionManager.ts:4730` ("a resumed session restores what has not expired"), `:20451` ("its `restore()` re-arms every unexpired record"), monitor retirement of a record left `running` by a previous process at `:10859-10864`. Mint the ledger row `covered ᵏ`×3 — the failure mode it guards (a stale `running` record) is exactly the silent class, so a CDP case may upgrade the marker later.
- F47 [pi] [claude] [codex] — `d182d7061` (feat(electron): /export session transcript) — exporting the conversation to clipboard or a plain-text file is delivered end to end and runtime-agnostic because the transcript is ours on all three: `ChatDisplay.tsx:1275` dispatches `{ type: 'exportTranscript' }`, `packages/shared/src/protocol/dto.ts:782` types it, `packages/server-core/src/handlers/rpc/sessions.ts:865` handles it, with no provider branch. Mint the row `covered ᵏ`×3; it earns a row only because it is an EGRESS path an organisation may want to gate, beside the C-family.

### G#0

(none — no G entry in this slice is delivered at HEAD)

### H#0

None. No H10–H52 entry is delivered at HEAD; the sweep's own probes were run against HEAD and every
entry keeps a live absence, a live divergence or an unmade measurement. (The two entries whose `absent`
readings were REFUTED mid-sweep — H23 claude `memory` and H26 claude `background` — were already
re-graded to `partial` inside the denominator table, so they are rows here, not promotions.)

### I#0

- I27 [pi][claude][codex] — `c76af27c7` + `4c158a801` — confirming a worktree entry outside the project's worktree namespace is delivered as a shared host gate: `packages/shared/src/agent/core/pre-tool-use.ts:1273` returns `'prompt'` for any path failing `isInsideWorktreeNamespace`, and the card is minted at `:2135-2141` with `promptType: 'worktree_approval'` and `nonNegotiable: 'worktreeApproval'` — read verbatim at HEAD, so no rule and no remembered approval clears it and only `bypassPermissions` skips it (`:1594-1601`). Uniform on all three by construction (one `runPreToolUseChecks`), not by three implementations.

### J#0

(none in this slice — the gaps document had already filtered CLOSED_AT_HEAD promotions out of the "Missing features, in scope" table before it reached this lane. The five entries that read as delivered — J52, J53, J54, J55, J56 — each carry one unchecked clause, so the sweep classed them MEASURE and they are rowed as such below rather than promoted bare.)

### J#1

*(none — no entry in this slice is `CLOSED_AT_HEAD`)*

### K#0

None. No group-K entry is delivered on every runtime at HEAD. The two nearest — K33 (`have`/`partial`/`have`) and
K34 (`partial` on all three) — each carry a named residue and are filed as `measure:` rows below, not as promotions.

### L#0

None. No entry in this slice is CLOSED_AT_HEAD — every one was re-checked against the plan's unfinished rows
and against the cited `file:line` at HEAD `34be43fde`, and none is delivered.

### L#1

(none — no entry in this slice was classified CLOSED_AT_HEAD by the sweep)

### L#2

- L129 [pi, claude, codex] — `3b14e2ea9` — the Claude-setup importer is built AND mounted at HEAD: two-phase
  compute-then-apply with a dry-run preview, five kinds (`ClaudeImportKind` = instruction \| permission \| skill \|
  mcp \| hook, `packages/shared/src/capabilities/claude-setup-import.ts:61`), reachable from Settings
  (`apps/electron/src/renderer/pages/settings/settings-pages.ts:39` → `ImportSettingsPage.tsx:34` →
  `ClaudeImportContainer.tsx:25`). Commit re-verified: `git cat-file -t` → commit, `git merge-base --is-ancestor` →
  ancestor of HEAD, subject "fix(import): an import told the user it succeeded and landed in a file no runtime
  reads, and the panel never said which file". The sweep's `BUILDABLE` klass names no residue and its own
  evidence says MOUNTED — so this is a stale klass, not a build.

### M#0

- M15 [pi] [claude] [host] — `e40c1dedd` — `nessy-general-agent doctor` already runs the read-only installation-and-settings checkup session-free and runtime-free (`apps/cli/src/doctor.ts:1-24`, `:223` `collectConfigDoctorInput()`, `:231` `buildConfigDoctorReport`; dispatch `apps/cli/src/index.ts:2567`, help line `:2455`), so the terminal half of `debug-your-config` is delivered and the ledger is silent about it; the residue — no desktop entry point — is the already-open row named under "Already open" below, not a new row.
- M41 [pi] [claude] — `1e1ecb67d` — `OTEL_METRIC_EXPORT_INTERVAL` is read by the host metrics exporter (`packages/shared/src/telemetry/usage-metrics.ts:487`, `parsePositiveMs(env.OTEL_METRIC_EXPORT_INTERVAL, DEFAULT_EXPORT_INTERVAL_MS)`) with a shutdown drain at `:222-231`, it sits on `MANAGED_ENV_SAFE_ALLOWLIST` as a pure batching knob (`packages/shared/src/config/managed-approval.ts:155-162`), and the Pi event exporter needs no interval because it flushes on a microtask and drains on shutdown (`packages/server-core/src/pi-harness/otlp-telemetry.ts:216-222`, `:192-195`); codex is `n/a` — all four citations reproduced at HEAD. It becomes a gap again only when the traces stream of the M29/M30 row below is built, since a span stream does batch — recorded in that row's note.

### N#0

_(none — no entry in this slice is CLOSED_AT_HEAD. Negative controls run at HEAD `34be43fde`:
`MentionItemType` is still the five non-session kinds (`apps/electron/src/renderer/components/ui/mention-menu.tsx:18`);
`SendAgentMessageArgs = { sessionId; message }` (`packages/session-tools-core/src/handlers/send-agent-message.ts:5-8`);
`grep -aci 'archiv' packages/session-tools-core/src/tool-defs.ts` → 0;
`grep -arn '1048576\|1_048_576' packages/session-tools-core/src` → 0 files;
`git grep -ain 'mentionSession\|uniqueSessionName\|sessionNameCollision\|notify_when_idle\|notifyWhenIdle' -- packages apps` → 0.)_

### O#0

- **O18** [pi, claude, codex] — `CLOSED_AT_HEAD` — ledger **O3 is stale on all three cells**; the never/background/always timing and the two separate alert switches are chosen, stored and read at HEAD. Chosen `apps/electron/src/renderer/pages/settings/AppSettingsPage.tsx:355-365` (`NOTIFICATION_TIMINGS` bound to `notificationSettings.timing`); stored `storage.ts:99-102,:260-261,:1132-1160` + `validators.ts:117-118` (`z.enum(['never','background','always'])`); read `apps/electron/src/main/notifications.ts:130` `shouldNotifyAtTiming(...)`, resolver `notification-timing.ts:66-71,:107`, legacy-boolean migration `:73-90`; `config-defaults-schema.ts:22-29` cites the page anchor. Landed as **P6.50 (`5f6009b2e`)**. O3's other residue — no external `notify` program written into the codex config — is untouched and stands.
- **O19** [pi, claude, codex] — `CLOSED_AT_HEAD` — spell-check in the composer ships, by a different mechanism (the Electron renderer's built-in spellchecker rather than aspell/hunspell), host-side and uniform by construction. `apps/electron/resources/config-defaults.json:12` `"spellCheck": false`; toggle `InputSettingsPage.tsx:102-105`; read over IPC into `FreeFormInput`'s `spellCheck` state → `spellCheck={spellCheck}` → `apps/electron/src/renderer/components/ui/rich-text-input.tsx` (the `...restProps` destructure in `RichTextInput`, then the `{...divProps}` spread; props extend `React.HTMLAttributes<HTMLDivElement>`, less three event handlers, in `RichTextInputProps`). **Two residues to carry, not smooth:** our default is `false` where the page calls the setting optional, and the KEY SPELLING differs, so a settings file written against the page does nothing here.

## Already open

### A#0

None. The 172 unfinished rows were read in full; the nearest neighbours are recorded as **file contention**, not as duplicates, inside the row notes that touch their files:

- `P6.64` (guardian `facts` builder, `pi-agent.ts` + `prompts/guardian.ts`) — same two files as the A30+A31 row.
- `P6.65` (four switch-cost surfaces, `runtime-switch-costs.ts` + two locales) — same file as the A24 row.
- `P6.61` (codex `bypassPermissions` mode answer) — its done_means already drives one arm of the A22 measurement; do not buy it twice.
- `P6.62`/`P6.63` (ledger A4, `deniedPaths` answer on codex and search-result leakage on claude) — adjacent read-side floors, different mechanism from the A21 and A27+A28+A29 rows.
- `P6.182` (`admitAgentMessage` hold/refuse, size L) — the same function the A14 row splices a judge into; one lane or strictly sequenced.
- `P3.339` / sitting §1.4 (`additionalDirectories`, three treatments, Pi arm inert) — the A27+A28+A29 row is blocked on that answer.
- `P4.10` (unenforceable `blockedTools` rendering, PARKED for the playground) — same file as the A42–A45 row (`PermissionsSettingsPage.tsx`).
- `P6.129` (codex catalog reports a dropped tool grant as `active`) — the residue beside the A56 structural entry.

### A#1

*(none — no unfinished tracker row delivers any of A58–A87. Nearest neighbours, checked and rejected as
different deliverables, are recorded in the rows below: P3.339 / sitting §1.4 for A62 (spawn-time
`--add-dir` and Pi's inert rule arm, not the mid-turn `updatedPermissions` seam), P3.338 for A59 (a
model-gate the cost table cannot express, not the complement of the tool union), P3.7 for A87 (a parked
feasibility spike, not the posture), the `[codex] Codex ships its own model-backed approval reviewer`
question for A65/A66 (default ON/OFF, not the naming and not the settings surface).)*

### B#0

(none — no unfinished tracker row delivers any of these 30 entries as its own deliverable. The nearest
matches were checked and are distinct: P6.72 measures whether a managed MCP denial stops the SPAWN, it
does not carry `allowManagedMcpServersOnly` in `ManagedPiPolicyV1` (B11); P6.74 scores the enforcement
pole of five managed keys including `allowedChannelServers`, it does not accept or refuse the documented
name `allowedChannelPlugins` (B24); P6.77 records three `#[experimental]` codex fields dropped by ts-rs,
not the five requirement FAMILIES the generated type never carries (B31); P6.76 measures administrator
SKILLS supplied once or twice, not administrator AGENTS or output styles (B20/B21); P6.168 names which
FILE supplied an effective setting, not whether the remote policy fetch happened (B30); P3.7 parks a
Windows RIG, not the Windows managed-policy arm (B10). B15 is the one entry whose question is already
asked — it is placed in `docs/superpowers/specs/2026-09-05-denominator-owner-questions.md` § Already asked, pointing at sitting §1.2 and row P3.373.)

### C#0

- C6 [pi][claude][codex] → P3.330 — same deliverable: P3.330 is the ⏸ row for the seatbelt wrapper's `SEATBELT_TESTING_WILDCARD = true` / `(allow default)`, measured on a real darwin rig (writes outside cwd, to `~` and to `~/.ssh` all succeed on the shipped arm, all `Operation not permitted` on the flip) and parked on owner sitting §1.1 with options (A) keep and disclose / (B) flip. C6's Pi and claude cells ARE that switched-off control; its codex cell is the already-written `network_access` boolean (`packages/codex-responses-adapter/src/config-writer.ts`). C6 adds no new question — its own entry records `sitting_ref: §1.1 — already before the owner`. honest_surface CORRECTED to present: `apps/electron/src/renderer/components/settings/IsolationNetworkPosture.tsx:24-72` and `apps/cli/src/doctor.ts:250-251` both disclose `sandboxEgress` and the unbound network settings. The Pi/claude egress reading the flip needs is P6.150's measurement; the codex legibility half is P6.149.
- C28 [pi][claude][codex] → P6.79 — same deliverable, to the sentence: P6.79 is the honest-surface row for ledger C4/claude and its `done_means` is "wording says the prefix is honoured on **no** runtime (Pi and codex inherit the variable and consult it nowhere)", which is exactly C28's "with either launcher name exported, one operator-visible line says the launcher applies on no runtime". Same site (`packages/shared/src/agent/options.ts:331-340`, the drop loop announced with `debug(...)` alone, re-read at `34be43fde`), same channel (`ClaudeAgent.pendingDegradationNotices`), same key list (`claude-provider-routing-env.ts:272-275`, `CLAUDE_LAUNCHER_ENV_KEYS`). The BUILD half stays deferred at P6.9 (⏸, owner ruling 2026-08-28, last in the queue).

### D#0

*(none. The three nearest unfinished rows were read in full and none delivers D5, D6 or D7:*
*`P6.65` shares the FILE (`runtime-switch-costs.ts` + en/ru) but its four deliverables are ledger A1/A2/A4/A7 — the safety floor, not the feature-flag blackout and not codex's builtin agents;*
*`P6.86` is the hook-event caveat for the D1 honesty half (`MEASURED_HOOK_EVENT_COLUMNS`), a different column;*
*`P6.92` is the reverse-totality guard over `docs/architecture/runtime-capability-gaps.md`'s 68 rows, a test, not a new cost row.*
*`P3.52` ✅ `ab9a5ebdb` `6194b0df9` recorded the D5 trade as a CODE COMMENT and the owner ruled "keep as is" (plan:1127) — the ruling explicitly leaves the user-facing half unpaid.)*

### E#0

- (none — the four unfinished context/compaction rows P6.95–P6.100 all carry ledger E2–E5; `getContextUsage`, `context_usage`, `contextUsage`, `context-overlay`, `resumeFromSummary` and `experimental_mode` each score 0 over all 172 unfinished tracker rows, and the two `experimentalFeature` hits are P6.92 (capability-gaps totality) and P6.93 (`view_image` live case), neither of which is E11.)

### F#0

- F34 [pi] [claude] [codex] → P6.106 — same deliverable, same evidence anchor. F34 asks for a rewind-menu entry that resumes the conversation that was active before `/clear`; P6.106 is "`/clear` ends the runtime lifecycle and the menu's documented `/resume <session-id> (previous session)` reaches no seam on any runtime", and it cites the very marker F34's absence rests on — `rewind-menu.tsx:158-167` — with the per-runtime resume seams already named (claude `resume`, Pi `continueRecent`, codex `thread/resume`) and its `done_means` written as "a session cleared with `/clear` offers a `/resume <previous-runtime-session-id>` entry that reaches the resume seam on the runtime it names". F34's own probe (`previousSessionId`, `resumePreviousSession` → 0 files) is the same absence from the other side; fold its `checkpointing.md` citation and the "entry disappears after switching sessions" clause into P6.106's note rather than minting a second row in the same file.

### G#0

(none — the unfinished tracker rows nearest this group are P6.86/P6.88/P6.89/P6.90 (the switch
report's hook-event COLUMNS), P6.117/P6.118/P6.119/P6.120/P6.121 (which hook EVENTS fire per
runtime), P6.143 (codex `preToolUse` payload), P6.184/P6.185 (the notification TOOL), P4.1/P4.3
(parked playground panels). None of them delivers a G6–G25 capability: those rows are about which
events exist and how the switch reports them, this group is about what a hook may DO once it fires.
Each new row below names its nearest open row so no lane re-litigates one.)

### H#0

- H44 [claude] → P6.125 — the same probe from the other side. P6.125 is `measure: whether the SDK's dynamic Workflows reach a packaged claude session, or are entitlement-gated`, and its own control list already names this measurement verbatim: *"(2) the same probe with `disableWorkflows: true`, which must remove it"*, on the same rig (a packaged claude-runtime gateway session, `.claude/settings.json` written through `claude-settings-store.ts`, one prompt containing `ultracode`). H44 asks whether the SDK's keyword still starts a run when `disableWorkflows` is set — that is P6.125's control run, not a second lane. Fold H44's `workflowKeywordTriggerEnabled` clause and the ledger-cell update into P6.125's note when it dispatches.

### I#0

- I6 [pi][claude][codex][host] → P3.330 — same deliverable, same file, same measurement: `SEATBELT_TESTING_WILDCARD = true` in `wrapBashCommandWithMacosSeatbelt` makes an approved Bash command uncontained, and P3.330 is ⏸ precisely because the flip is the owner call the sitting page carries as §1.1 (`docs/superpowers/specs/2026-09-04-owner-sitting.md` §1.1, options A flip-to-strict / B keep-and-disclose, controller recommendation A). P3.330 also already owns the two in-zone sub-defects (the vacuously-passing containment guard, the `sandbox-settings.ts:869` user-layer-only claim) and the success-path diagnostic. Nothing new to add; I14 and I16 both name it as their ordering prerequisite.
- I33 [pi][claude][codex] → P3.7 — same deliverable: the WSL spike the owner already took (plan `:12` default-take list, tracker `:3176` verbatim *"WSL spike \| ⬜ \| PARKED, not an owner answer (re-glyphed 2026-09-04 per P3.362): no Windows host on any rig; WIN-1 in the CDP table waits for one"*). The decision exists and the blocker is a rig, not an answer, so this is an open row waiting on hardware rather than a new question. The denominator's own re-probe agrees the tree is empty at HEAD (`wsl.exe`/`wsl.localhost` 0 files, controls `win32` 140, `bwrap` 11).

### J#0

- J13 [pi][claude][codex][host] → P6.149 — same deliverable. J13's per-runtime cells are STRUCTURAL by the sweep's own reading (`[features] network_proxy` is gated on `network_sandbox_policy().is_enabled()`, `Restricted` in our shape; `request_permissions_tool` is `Stage::UnderDevelopment, default_enabled: false`), so the only buildable part is the honest surface, recorded `honest_surface: PARTIAL` — `formatCodexSandboxEgressDiagnostics` (`packages/codex-responses-adapter/src/config-writer.ts:1449-1466`) early-returns `[]` on `danger-full-access` and on what `codexSandboxConfigForMode` (`:1043-1067`) returns when the master switch is OFF, the shipped default. P6.149 is titled exactly that residue ("on codex a denied network call reads as a DNS miss, because the diagnostic that would name it returns `[]` in the shipped default", `[host]`, size M). The Pi/claude arms are P6.150 ⬜, and the product decision is already before the owner at `2026-09-05-ledger-closure-owner-questions.md#codex-shell-network-egress-on-codex--deny-legibly-open-with-the-isolation-switch-or-allowlist-domains`. Nothing new to open.
- J24 [claude] → P3.338 ⏸ (`ca0d0a01b`) — same deliverable and same residue. P3.338 is "The SDK we now ship model-gates TaskCreate/Get/Update/List and TodoWrite, and the switch-cost rejection cannot see it"; J24's own note ends "Residue: `RuntimeSwitchClaim` has no model axis, so the Pi→claude cost is currently unstated", which is P3.338's second clause verbatim in substance. The decision half is `sitting §2.1` ("The SDK we ship model-gates the Task and TodoWrite tools, and our default model is an exact threshold match") with its two options and the controller's recommendation already recorded; J24 sets `sitting_ref §2.1` itself and says "not restated". No new row, no new question.

### J#1

*(none)*

### K#0

- K25 [codex] → P2.318 — same deliverable, same surface, already parked with the owner's ruling on it. P2.318 ("the codex model preference list is one-of-seven live", ⏸) IS the refresh of `PI_PREFERRED_DEFAULTS['openai-codex']` at `packages/shared/src/config/llm-connections.ts:977`; its note records the measurement (only `gpt-5.5` exists in the codex catalogue, all three Recommended models absent) and PARKS it as GATED 2026-09-02 under the owner's 2026-08-29 ruling on the ChatGPT Plus/Pro card — *do not build, do not delete, do not clean up*. K25's own klass correction (BUILDABLE→OWNER, `already_ruled`) lands on that row; the byte-identical `openai` neighbour at `:976` is P2.286's, not a new row.

### L#0

- L27 [claude] → P3.297 — same deliverable, same decision. P3.297 (⬜) is the thin-host question in full: the host
  passes `plugins: []` and renders skills into the prompt, and its own recommendation is to "hand claude the skill
  DIRECTORIES the way the page says (`settingSources` / plugin dirs / `--add-dir`)". L27's `Options.plugins?: SdkPluginConfig[]`
  (`sdk.d.ts:1797`, handed `[]` at `claude-agent.ts:5474`) IS that delivery route; the PKG-4 measurement recorded in
  P3.297 (PASS 9/9, packaged, 2026-09-03 — "nothing native sees a directory-delivered skill") is the evidence that
  decides both. Deciding P3.297 decides L27; a second row would re-ask the same posture.
- L39 [pi, claude, codex] → P3.339 — same deliverable, named verbatim. P3.339 (🟨) is "One `additionalDirectories`
  setting, three treatments, and the Pi arm is inert" and its note carries L39's exact subject: "the
  `additionalDirectoryRulesEnabled()` block iterates `context.additionalRuleDirectories`, whose only production
  producer (`toWorkspacePolicyContext`, storage-runtime.ts:1541-1560) never sets it, so
  `NESSY_ADDITIONAL_DIRECTORIES_MEMORY` is a documented opt-in that cannot take effect" — L39's `native-sources.ts:160`
  spelling and its `noticeInertAdditionalDirectoryRules` (`:171-187`). P3.339's first task is L39's own measurement
  (does claude load components from a flag-added root) and its minimum honest change is L39's fix. Also tabled at
  sitting §1.4.

### L#1

(none — checked against all 172 unfinished rows. The nearest neighbours were read and are different deliverables: P6.175/P6.176 turn plugin *monitors* on for claude/codex through `PLUGIN_PERIPHERAL_SUPPORT`, where L81 is the missing `on-skill-invoke` dispatch seam on Pi where monitors already run; P6.120 is the switch report's blindness to component hooks, not L74's session plugin inventory; P3.366 is Pi's native LSP *fallback*, not L82/L83's plugin-LSP supervision; P6.110 is the `/tasks` and `/workflows` command parser, not L65's plugin-namespaced workflow dispatch; P6.177 is L12's archive credential, untouched here. Keyword probes returning zero unfinished rows: `reloadPlugins`, `argumentHint`, `skill-installer`, `refreshAutoUpdate`, `appendPluginBinPath`, `on-skill-invoke`, `additionalMarketplaces`, `contextCost`, `plugin-dir`, `CLAUDE_CODE_PLUGIN_SEED_DIR`, `defaultEnabled`, `trust_level`.)

### L#2

- L121 [pi, claude, codex, host] → P6.168 — same deliverable, not a neighbour. P6.168's done_means is a host-built
  per-FAMILY provenance view "reachable from the desktop app", and its managed family IS L121's subject: it names
  `config-doctor.ts:516-566` as managed-only, carrying the `Managed settings source:` line — which is exactly
  L121's "whether managed settings are in effect and how they reached the machine" — and it records the same reach
  defect L121 found (today CLI-only at `apps/cli/src/index.ts:2567`; `grep -ril doctor apps/electron/src` returns
  nothing). P6.168 also already carries the claude half (a second stack from `settingSources: ['user','project','local']`,
  `claude-agent.ts:1725`), which is L121's "which settings sources are active for this session". Nothing in L121 is
  outside P6.168's stated scope; do not open a second row.

### M#0

- M13 [pi] [claude] [codex] [host] → P6.168 — same deliverable: P6.168's `done_means` is exactly a desktop-reachable, host-built view of which file and scope supplied each effective settings family, and it names `config-doctor.ts:516-566` — the managed-only family carrying `Managed settings source:`, the invalid-entry count and `Rejected settings layers:` — as one of the four families it must render, together with the finding that `grep -ril doctor apps/electron/src` returns nothing. That is M13's "which managed source won, which were shadowed and what the policy dropped", reached from the app, on one host build serving all three runtimes. Delta to fold into P6.168's note rather than into a second row: the checkup's non-settings panes (installation, extensions, skill/context token usage) and the fact that `buildConfigDoctorReport` has exactly one production consumer, `apps/cli/src/doctor.ts:231`. Do NOT open a second desktop-doctor row — P6.168 and this entry are the same file zone (`packages/shared/src/config/config-doctor.ts` plus a new renderer page) and two rows would collide.

### N#0

- N7 [pi][claude][codex] → **P6.182** — same deliverable. N7's first half is already built and load-bearing
  (`packages/session-tools-core/src/handlers/send-agent-message.ts:45-61`, P6.46 `fd0388b05` — anything other than
  `delivered` reports as a FAILED send carrying the receiver's note). N7's residue is the missing channel back to
  the original sender — `releaseHeldCrossSessionMessages` re-delivers via `deliverMonitorEvent` to the RECEIVER's
  key only (`packages/server-core/src/sessions/SessionManager.ts:4384-4391`, import `:129`) — and P6.182's
  `done_means` already owes exactly that channel twice: **(d)** *"unanswered past `dialogExpiry` drops it and
  reports `expired` to the sender"* and **(h)** *"session end reports every still-held message as expired to each
  reachable sender"*, plus **(f)** the release-on-mode-change. One build, one lane, one file zone
  (`SessionManager.ts` + `send-agent-message.ts`) — a second row would be the duplicate this sweep exists to avoid.
  **One addition owed to P6.182's note, not a new row:** its `done_means` **(c)** says *"Deny or dismiss drops it"*
  without saying the sender is told, so the DENY arm of N7's follow-up is the one outcome P6.182 does not yet name;
  fold *"and reports the denial to the original sender"* into (c) when that row dispatches. Denominator N7.

### O#0

(none — no unfinished tracker row delivers any of O7–O21. The nearest neighbours were read and rejected: **P6.184/P6.185** are ledger O6, the model-invocable notification TOOL on codex and claude, not O7's per-category settings and channel; **P6.186/P6.187/P6.188** are ledger O5, the STORED steer-vs-queue default and its two live arms, not O8's interrupt receipt nor O12's per-message override; **P6.49 (`10a95a639` + `55723b171`)** closed ledger O2's write path and is ✅, so O13/O14 are its residues rather than its duplicates.)

## Structural

### A#0

- A56 [claude] [codex] [pi] — STRUCTURAL, surface present: the page scopes the frontmatter tools allowlist to an agent started as the MAIN thread with `--agent`, which we never start, and codex has no per-role tool list at all — the refusal is stated at the type boundary (`packages/codex-responses-adapter/src/config-writer.ts:1600-1606`, "codex has no per-role tool allowlist… Declaring the role anyway would hand a read-only agent `shell` and `apply_patch`. Denied") and the honest turn notice already fires (P3.337); the one dishonest half — the capability catalog still reporting such a role `active` — is already open as `P6.129`, and Pi's `Agent(Name)` deny form (`claude-permission-rules.ts:424-426`) remains the page's other documented route (`sub-agents.md#restrict-which-subagents-can-be-spawned` line 472).

### A#1

*(none — no entry in this slice is STRUCTURAL. A73 and A79 name capabilities that live in a vendor's own
desktop UI rather than in an embedder surface, but in both cases the honest owner is our bundle: A73 is
filed as a host build, A79 as an owner question about whether we build it at all.)*

### B#0

- B32 [pi][claude][codex] — STRUCTURAL, surface present: `managedSourcesBehavior: "merge"` composes the four sources the vendor's own binary reads while our two are composed host-side and handed down resolved, the page dates the key to v2.1.242 against a vendored 2.1.233, and P3.290 (`ae9b1c07a`) already decided to refuse it at parse — `managed-policy.ts:1141` `DOCUMENTED_UNENFORCED_KEYS` with the administrator-facing sentence at `:1193-1198` says composition is first-wins, so the refusal is legible and no row is owed unless the owner wants the six-rule algebra.

### C#0

- C8 [codex] — STRUCTURAL, surface present: `Feature::NetworkProxy` is Experimental/default-off and its gate requires `network_sandbox_policy().is_enabled()`, which is `Restricted` in our sandboxed modes — a no-op exactly where it is wanted and a live egress regression in `danger-full-access`; the deciding argument was auditability (a network denial never becomes a protocol event, so its verdict cannot mint a receipt), and one diagnostic per `writeCodexConfig` names both refused switches and why — `packages/codex-responses-adapter/src/config-writer.ts:1348`, `:1356`, `:1372`, `:1440`, `:1455-1463` (user-facing text at `:1459` and `:1461`), `formatCodexSandboxEgressDiagnostics` covered by `packages/codex-responses-adapter/src/__tests__/config-writer-sandbox-egress.test.ts`. (Pi and claude cells of C8 are `unknown`, not structural; their measurement is P6.150.)

### D#0

*(none in this slice.)*

### E#0

- (none — E6's codex arm is a STRUCTURAL residue whose descriptor surface is already honest (`composer-capabilities.ts:146-160`, `kind:'unavailable'`, `reason:'unsupported'`), but its COMMAND-MENU surface is missing, so it is carried as the second clause of the E6 row below rather than as a standalone structural entry.)

### F#0

- (none standing alone. F15's codex arm IS structural — `shutdown` appears in exactly ONE of 562 generated v2 files, `CollabAgentStatus.ts`, which is a spawned agent's status and not a worker notice, against a positive control of `error` matching 17 files — but its honest surface is MISSING, so per the brief it becomes a BUILDABLE S clause and is carried as the second half of the F15 row below rather than as an entry here. No other F entry in this slice reached a structural verdict: F12/claude, F12/codex, F33/claude, F33/codex, F35/codex and F42/claude, F42/codex are all DERIVATIVE of ledger F1 — no checkpoint producer runs on those two runtimes — which the ledger already scores as DEFECT, not STRUCTURAL, and the owner has already ruled the direction ("Rewind — keep ours; do NOT adopt the SDK's semantics", plan §Owner decisions 2026-08-28 #3).)

### G#0

(none — G16 is klass STRUCTURAL on codex, and its honest surface is MISSING, so per the brief it
lands in `## Rows` as a BUILDABLE S row for the surface)

### H#0

None. Both entries the sweep classed STRUCTURAL — H23 (per-subagent memory store) and H27 (background/
foreground subagent control) — record `honest_surface: missing`, so per the brief each is carried as a
BUILDABLE S surface row instead; both are folded into the codex role-writer row below.

### I#0

- I29 [pi][claude][codex] — STRUCTURAL, surface present: per-domain sandbox egress scoping is impossible on every runtime by construction — every Pi isolation backend is a boolean (`server-core/src/pi-harness/isolation.ts:85-95`), codex's `[features] network_proxy` is `Stage::Experimental` and inert exactly when it would be needed, claude passes no `sandbox` option at all (`git grep 'sandbox:' packages/shared/src/agent/claude-agent.ts` → 0 against control `sdk.d.ts:1936`) — and the honest surface is already present on all three: `unenforceable` entries reach `IsolationNetworkPosture` by name (`isolation-capabilities.ts:137-147`) and codex emits `CODEX_SANDBOX_EGRESS_DENIED_PREFIX` (`config-writer.ts:1448-1462`). Nothing to build.

### J#0

(none in this slice. J13 is the only STRUCTURAL entry and its honest surface is PARTIAL rather than present, which is why it lands in `## Already open` against P6.149 rather than here.)

### J#1

*(none — all three entries are `BUILDABLE`)*

### K#0

None. The one STRUCTURAL entry in this slice, K35, has `honest_surface: missing`, so per the brief it becomes a
BUILDABLE **S** row for the surface (last row in the table below).

### L#0

- L28 [pi, claude, codex] — STRUCTURAL, surface present: acquisition is fetch-only by construction (no git binary,
  no credential helper, no SSH agent, no clone), and the refusal is already named to the user with its alternatives —
  `packages/shared/src/plugins/source-resolver.ts:269` `supportedAlternatives: ['archive', 'npm']`, pinned by
  `source-resolver.test.ts:159`; the credentialed route that does work is entry/marketplace `headers` on a
  url/archive source (L12's closure, P6.39 `7467a72a9`, P3.220 `0d0f8e336`), and P3.219 `5087d9ecd` already ruled
  the forge half a posture.

### L#1

- L65 [claude, codex] — STRUCTURAL, surface present: a non-Pi session is told, in the UI, that workflow dispatch is unavailable — `base-agent.ts:5230-5232` `canDispatchWorkflowCommands()` returns false (overridden only at `pi-agent.ts:8649`) and `base-agent.ts:4694-4700` emits `settings.ai.workflows.dispatchUnavailable`; the adapter still imports the component (`format-adapters/claude.ts:169`, `:3080`) so nothing is silently dropped.
- L70 [pi, claude, codex] — STRUCTURAL, surface present: stacked leading skills are expanded host-side before any backend sees the message, so all three runtimes get the same behaviour and nothing diverges to disclose — `packages/server-core/src/handlers/rpc/sessions.ts:101-166` `resolveStackedSkillCommands` (awaited at `:528`), cap `MAX_STACKED_SKILL_COMMANDS = 6` at `packages/shared/src/slash-commands/custom-commands.ts:347`, doc-correct against `skills.md:490`.
- L71 [pi, claude, codex] — STRUCTURAL, surface present: one host resolver decides scope precedence for all three, with the page cited in its own docblock — `packages/shared/src/capabilities/resolver.ts:1169-1183` `aliasScopeRank` (builtin 5 > global 4 > workspace 3 > project 2 > bundled 1 > plugin −1), `:1133-1146` keeps plugin skills out of contention.
- L94 [pi, claude, codex] — STRUCTURAL, surface present: there is no subject to switch off — `spinnerTips` scores zero first-party hits (only two worklist documents recording the same absence), and `plugins/org.md#recommend-plugins (was line 29 of the retired plugin-relevance page)` states the Discover-tab pin we DO build "is independent of tip settings".

### L#2

- L116 [host] — STRUCTURAL, surface present: nested `gitlab.com` subgroups already resolve
  (`packages/shared/src/plugins/source-resolver.ts:608-623` splits at the `-` separator and joins ALL preceding
  segments via `repoSegments.join('/')`; test `__tests__/source-resolver.test.ts:412`), and the only residue — a
  git host that is neither `github.com` nor a hostname containing `gitlab` — is refused explicitly at `:311`, not
  silently, and is already before the owner as "Should the app gain a route for git repositories on hosts other
  than github.com and `*gitlab*`?" in `docs/superpowers/specs/2026-09-05-ledger-closure-owner-questions.md`.

### M#0

_(none — M23 is the only STRUCTURAL entry in this slice and its honest surface is MISSING, so it is written below as a BUILDABLE S row for the surface.)_

### N#0

_(none — no entry in this slice is class STRUCTURAL. N10 and N11 are the two that look structural and are not:
both are OWNER, because the host owns a server and could build either; what stops them is a posture, not a
runtime limit. Re-read 2026-09-11: still true, and N10's claude arm has since gained a MEASURED native
mechanism — `CLAUDE_CODE_MESSAGING_SOCKET` scores 17 in the `0.3.247` binary against 0 on `0.3.223` and
0 on `0.3.233` — which sharpens the posture question rather than making it structural.)_

### O#0

(none — no entry in this slice is STRUCTURAL. The group's structural cases — the `--ax-screen-reader` alternate TUI renderer and the terminal line-editor/TUI presentation surface — are in the file's own `## Out of scope` section for group O and were not dispatched to this slice.)


## Slice provenance

Each slice file's own preamble — input section, dedup denominator, HEAD at composition — kept verbatim so the
method behind the entries above is not lost in the stitch.

### A#0

# Denominator group A, in-scope entries 1–45 of 75 (A13–A57) — composed rows

Input: `docs/superpowers/specs/2026-09-05-denominator-gaps.md` §"Missing features, in scope" › `### A. The safety floor — what stops a harmful action`, rows A13–A57.
Deduped against every UNFINISHED tracker row (172, `⬜`/`⏸`/`🟨`/`🚧` alike) of `docs/superpowers/plans/2026-08-22-runtime-parity-closure.md`, the ledger's own A1–A12, `2026-09-05-ledger-closure-owner-questions.md` and `2026-09-04-owner-sitting.md`.

45 entries → 28 rows (38 entries), 5 owner questions, 1 already asked, 1 structural, 0 already-open, 0 promotions.

### A#1

# Denominator group A, in-scope entries 46–75 of 75 (A58–A87) — composed rows

Repo HEAD at composition: `2cd628f96` (the brief's `34be43fde` has moved; HEAD facts below are re-read at `2cd628f96`).
Dedup denominator read: all 165 unfinished `| P…` tracker rows of `docs/superpowers/plans/2026-08-22-runtime-parity-closure.md`
(⬜ ⏸ 🟨 🚧 alike), plus the headings of `2026-09-05-ledger-closure-owner-questions.md` and `2026-09-04-owner-sitting.md`.

### B#0

# Denominator group B — "What an organisation can actually enforce" — in-scope entries 1–30 of 30 (slice 1 of 1)

Composed against plan `docs/superpowers/plans/2026-08-22-runtime-parity-closure.md` at HEAD `34be43fde`.
Dedup denominator: all 172 UNFINISHED tracker rows (⬜ ⏸ 🟨 🚧), the headings of
`2026-09-05-ledger-closure-owner-questions.md` and of `2026-09-04-owner-sitting.md`, and the existing
ledger rows `B1`–`B8`.

### C#0

# Denominator group C — slice 1 of 1 (in-scope entries 1–25 of 25)

Group: `### C. What leaves the machine, and corporate deployment`
(`docs/superpowers/specs/2026-09-05-denominator-gaps.md:166`, `## Missing features, in scope`).
Dedup denominator read in full: 172 unfinished tracker rows of
`docs/superpowers/plans/2026-08-22-runtime-parity-closure.md` (⬜ ⏸ 🟨 🚧 alike), the 28 headings of
`docs/superpowers/specs/2026-09-05-ledger-closure-owner-questions.md`, and the 20 headings of
`docs/superpowers/specs/2026-09-04-owner-sitting.md`. Existing ledger rows C1–C5 read; none of the 25
entries is C1–C5.

### D#0

# Denominator group D — switching correctly, the owner's other half (slice 1 of 1, entries D5–D7)

Source: `docs/superpowers/specs/2026-09-05-denominator-gaps.md` §`### D. Switching correctly — the owner's other half`, `#### In scope` table.
Dedup denominator read: all 172 unfinished tracker rows (⬜/⏸/🟨/🚧) of `docs/superpowers/plans/2026-08-22-runtime-parity-closure.md`, both owner-question spec heading lists, ledger rows D1–D4.

### E#0

# Ledger group E — The context window (in-scope entries E6–E11, slice 1 of 1)

### F#0

# Ledger group F — Sessions, checkpoints, recovery (in-scope entries F9–F48, 40 of 40, slice 1 of 1)

### G#0

# Denominator group G (hooks and automation) — in-scope entries G6–G25, slice 1 of 1

20 entries in, 20 placed: 14 tracker rows (covering 19 ledger ids), 1 owner question (G15),
0 already-open pointers, 0 structural-with-surface, 0 CLOSED_AT_HEAD promotions.

Merges (one lane, one file zone, per the brief's file-zoning rule):
G10+G11 (`automations/types.ts` notification vocabulary + its registration diagnostic),
G13+G14 (the scheduled-task store `session-cron-service.ts` + `tool-defs.ts` cron surface),
G18+G19+G21 (one rig: hook OUTPUT fields delivered per runtime),
G20+G23 (one rig: hook MATCHER semantics).

### H#0

# Ledger group H — Subagents, workflows, review — in-scope entries H10–H52 (43 of 43, slice 1 of 1)

Source: `docs/superpowers/specs/2026-09-05-denominator-gaps.md` §H `#### In scope` (lines 289–331).
Dedup denominator read in full: all 172 unfinished tracker rows of
`docs/superpowers/plans/2026-08-22-runtime-parity-closure.md` (⬜ ⏸ 🟨 🚧 alike, P6.61–P6.190 included),
the headings of `docs/superpowers/specs/2026-09-05-ledger-closure-owner-questions.md` and of
`docs/superpowers/specs/2026-09-04-owner-sitting.md`, and the ledger's own H1–H9 rows.

### I#0

# Denominator group I (Isolation and worktrees) — in-scope entries I6–I33, slice 1 of 1

28 entries in, 28 placed: 1 promotion, 2 already open, 1 structural, 20 into 15 new tracker rows,
4 owner questions (in `docs/superpowers/specs/2026-09-05-denominator-owner-questions.md`).

### J#0

# Denominator group J (Tools, MCP, browser, attachments) — in-scope entries 1–45 of 48 (slice 1 of 2)

Source: `docs/superpowers/specs/2026-09-05-denominator-gaps.md` §"Missing features, in scope" → `### J. Tools, MCP, browser, attachments`, rows J12–J56.
Dedup denominator read in full: every UNFINISHED tracker row of `docs/superpowers/plans/2026-08-22-runtime-parity-closure.md` (⬜ ⏸ 🟨 🚧 alike, 172 lines / 168 data rows, P6.61–P6.188 read row by row), plus the headings of `docs/superpowers/specs/2026-09-05-ledger-closure-owner-questions.md` (28) and `docs/superpowers/specs/2026-09-04-owner-sitting.md` (17 sections), plus the existing ledger rows `| J1 |`–`| J11 |` in `docs/superpowers/specs/2026-08-28-capability-ledger.md`.

Disposition of the 45 entries: **34** into `## Rows` as **21 tracker rows** (15 BUILDABLE + 6 MEASURE, grouped where one lane closes them together); **2** into `## Already open`; **9** into `docs/superpowers/specs/2026-09-05-denominator-owner-questions.md` (7 new questions covering 8 ledger ids, plus 1 already asked). Promote 0, Structural 0.

### J#1

# Denominator group J, in-scope entries 46–48 of 48 (slice 2 of 2) — J57, J58, J59

Source: `docs/superpowers/specs/2026-09-05-denominator-gaps.md` §J *Tools, MCP, browser, attachments*.
Dedup denominator read in full: every unfinished tracker row (⬜ ⏸ 🟨 🚧) of
`docs/superpowers/plans/2026-08-22-runtime-parity-closure.md`, plus the headings of
`2026-09-05-ledger-closure-owner-questions.md` and `2026-09-04-owner-sitting.md`, plus the ledger's
existing `J1`–`J11` rows. Nearest unfinished rows checked and rejected as duplicates: **P6.151**
(ledger J9, the interactive terminal — J59 explicitly excludes it), **P3.373** (⏸, user-scope `env`,
sitting §1.2 — a *blocker candidate* for J57, refuted below, not the same deliverable),
**P6.168** (ledger L2, which file supplied an effective setting — a different report and a different
question), **P6.177** (marketplace archive download — a name collision with J58, not this capability).
No unfinished row names ripgrep, a search backend, a browser download location, or a saved project command.

### K#0

# Group K — Models, effort, streaming — in-scope entries K8–K36 (slice 1 of 1, 29 entries)

Source: `docs/superpowers/specs/2026-09-05-denominator-gaps.md` § `### K. Models, effort, streaming` › `#### In scope`.
Dedup denominator read in full: 172 unfinished tracker rows of `docs/superpowers/plans/2026-08-22-runtime-parity-closure.md`
(⬜ ⏸ 🟨 🚧 alike, P6.61–P6.188 included), plus every heading of
`docs/superpowers/specs/2026-09-05-ledger-closure-owner-questions.md` and of
`docs/superpowers/specs/2026-09-04-owner-sitting.md`.

### L#0

# Denominator group L, in-scope entries 1–45 (L17–L61) — composed rows

Source: `docs/superpowers/specs/2026-09-05-denominator-gaps.md` §"Missing features, in scope" › `### L. Instructions, memory, skills, plugins`.
Deduped against every UNFINISHED tracker row of `docs/superpowers/plans/2026-08-22-runtime-parity-closure.md`
(⬜ ⏸ 🟨 🚧 alike, 172 rows), against `docs/superpowers/specs/2026-09-05-ledger-closure-owner-questions.md`
and against `docs/superpowers/specs/2026-09-04-owner-sitting.md`. All 45 entries land exactly once.

### L#1

# Denominator sweep → plan rows — ledger group L (Instructions, memory, skills, plugins), in-scope entries 46–90 of 117 (L62–L106)

Source: `docs/superpowers/specs/2026-09-05-denominator-gaps.md` §"Missing features, in scope" › `### L. Instructions, memory, skills, plugins`.
Dedup denominator: every UNFINISHED tracker row (⬜ ⏸ 🟨 🚧, 172 rows) of `docs/superpowers/plans/2026-08-22-runtime-parity-closure.md`, plus the headings of `2026-09-05-ledger-closure-owner-questions.md` and `2026-09-04-owner-sitting.md`.

### L#2

# Denominator group L, slice 3 of 3 — entries L107–L133 (27 in scope)

Composed against plan `docs/superpowers/plans/2026-08-22-runtime-parity-closure.md` at HEAD `34be43fde`,
branch `feat/TCODE-000`. Dedup denominator: all 165 UNFINISHED tracker rows (⬜ ⏸ 🟨 🚧), read in full
(the first pass truncated notes at 500 chars and was re-run untruncated), plus the headings of
`docs/superpowers/specs/2026-09-05-ledger-closure-owner-questions.md` and
`docs/superpowers/specs/2026-09-04-owner-sitting.md`.

Every one of the 27 entries lands in exactly one section below or in `docs/superpowers/specs/2026-09-05-denominator-owner-questions.md`.

### M#0

# Ledger group M — Observability and diagnostics, in-scope entries M4–M41 (38 of 38, slice 1 of 1)

Source: `docs/superpowers/specs/2026-09-05-denominator-gaps.md` §"Missing features, in scope" › `### M. Observability and diagnostics`.
Dedup denominator: every UNFINISHED tracker row of `docs/superpowers/plans/2026-08-22-runtime-parity-closure.md` (172 rows, ⬜ ⏸ 🟨 🚧 alike), plus the headings of `docs/superpowers/specs/2026-09-05-ledger-closure-owner-questions.md` and `docs/superpowers/specs/2026-09-04-owner-sitting.md`.
Existing ledger group M holds M1–M3 only, so M4–M41 collide with no id.

### N#0

# Group N — Cross-session messaging — in-scope entries 1–8 of 8 (slice 1 of 1)

Source: `docs/superpowers/specs/2026-09-05-denominator-gaps.md` `### N. Cross-session messaging`
(N4–N11; N1–N3 are already ledger rows, N2 → plan row P6.182, N3 → plan row P6.183).

### O#0

# Denominator group O — Notifications, UI, accessibility (entries O7–O21, slice 1 of 1)

Source: `docs/superpowers/specs/2026-09-05-denominator-gaps.md` §"Missing features, in scope" → `### O. Notifications, UI, accessibility`.
Dedup denominator: all 172 unfinished tracker rows of `docs/superpowers/plans/2026-08-22-runtime-parity-closure.md`
(`grep -a '^| P' … | awk -F'|' '$4 !~ /✅/'`, i.e. ⬜ ⏸ 🟨 🚧 alike), plus the headings of
`docs/superpowers/specs/2026-09-05-ledger-closure-owner-questions.md` and `docs/superpowers/specs/2026-09-04-owner-sitting.md`.
15 entries in, 15 entries placed: 2 promotions, 0 already-open, 0 structural, 9 rows (covering 10 entries), 3 questions (all already asked/ruled).
