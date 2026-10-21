# MCP Follow-ups F2–F4 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the three follow-ups the wire-names plan opened — nothing an MCP server does should fail silently, no wire name should be minted that our own parser rejects, and the plugin pipeline should have exactly one path so a pass can never again be wired to a road nobody drives.

**Architecture:** Three independent strands over the same subsystem. F2 and F3 are resolve-time work in `packages/shared/src/capabilities/resolver.ts`: name the plugin content that a dedup decision silently kills, and sanitize every minted wire name so an unparseable proxy tool name cannot exist — with a diagnostic as the net for anything that still slips through. F4 is a de-legacy migration confined to `packages/shared/src/plugins/`: lift the format-agnostic acquisition pipeline out of the V1-era `install-service.ts` into a V2-owned module, then delete the retired V1 store and projection halves and pin the single remaining entry point with a test.

**Tech Stack:** TypeScript, Bun test. No new dependencies.

## Where this comes from

`docs/superpowers/plans/2026-08-10-stable-plugin-mcp-wire-names.md` shipped as 1.24.0 and opened F1–F4 in its "Follow-ups this plan opens" section. F1 ran and is closed (it found the hook-`mcpTool` V1-wiring defect, fixed in `e272e98c6`). This plan executes F2, F3 and F4. Read that plan's follow-up section before starting — it carries the measured surface each task below assumes.

The one-line case for F4, in the words of what actually happened: the hook translation pass existed, had a test, passed three review rounds, and never ran, because it was attached to the projection path real installs do not take. Two paths is the defect generator; this plan removes the second one.

## Global Constraints

- Wire names must match `^[A-Za-z0-9_-]+$`, must never contain a `__` run, and must stay ≤40 chars — the mint's existing invariant (`packages/shared/src/capabilities/mcp-wire-name.ts`). A builtin dp server's wire name must stay byte-equal to its `definition.name`; `packages/shared/src/mcp/__tests__/builtin-dp-servers.test.ts` pins that and must stay green.
- Diagnostics carry names and statuses only. `CapabilityDiagnostic.safeArgs` / `SafeCapabilityDiagnostic.safeArgs` are the path-free interpolation vehicle: no filesystem paths, no commands, no URLs, no credential references, ever.
- Several source files carry NUL bytes: use `rg -a` for every absence claim.
- `rm -rf release` before any repo-root `bun test`; never run two `bun test` processes concurrently; `bun run typecheck:all` does NOT cover `apps/cli`.
- `mock.module` must spread the real module AND restore in `afterAll` (pattern: `claude-gateway-adapter.test.ts:79`).
- i18n: every new user-visible string gets keys in BOTH `en.json` and `ru.json`, alphabetically sorted (`bun run lint:i18n:parity`, `bun run lint:i18n:sorted`).
- Implementation-First Verification Budget applies: focused tests + affected-package typecheck per task; the full wave runs once at close-out.
- No `Co-Authored-By` trailers. One commit per task, message given in the task. Branch: `feature/mobile` (owner override of the `<type>/TCODE-000` convention, continuing the 1.24.0 work).
- G1 and G2 both edit `resolver.ts` — run them in sequence, never in parallel. G3 and G4 are sequential with each other. The two strands may interleave only at task boundaries.

## File map

| File | Role |
| --- | --- |
| `packages/shared/src/capabilities/resolver.ts` | G1 dedup diagnostics gain the inert-content list; G2 sanitizes every minted wire name and adds the unparseable-name diagnostic |
| `packages/shared/src/capabilities/mcp-wire-name.ts` | G2 exports the sanitizer the mint already applies to plugin names, so scoped names can share it |
| `packages/shared/src/i18n/locales/{en,ru}.json` | G1/G2 user-visible strings |
| `apps/electron/src/renderer/components/info/CapabilityDetailTemplate.tsx` | G1/G2 reason rendering, beside the existing `duplicates-builtin` / `duplicates-endpoint` entries |
| `packages/shared/src/plugins/acquisition.ts` | NEW (G3) — the V2-owned download/extract/normalize/resolve pipeline lifted out of `install-service.ts` |
| `packages/shared/src/plugins/management-service-v2.ts` | G3 consumes the new module instead of `PluginInstallService` |
| `packages/shared/src/plugins/{install-service,store,legacy-types}.ts`, V1 half of `projection.ts` | G4 deletes them and their now-orphaned tests |
| `packages/shared/src/plugins/index.ts`, `packages/shared/src/marketplace/registry-source.ts` | G4 re-points the two remaining V1 exports |
| release notes, docs-site, package.jsons | G5 close-out |

---

### Task 1: name the plugin content a dedup decision silently kills (F2)

**Files:**
- Modify: `packages/shared/src/capabilities/resolver.ts` (the T4 builtin-identity pass and the T4b endpoint pass, both just before `applyCollisionPolicy`)
- Modify: `packages/shared/src/i18n/locales/en.json`, `ru.json`
- Modify: the renderer display map that already renders `duplicates-builtin` / `duplicates-endpoint`
- Test: `packages/shared/src/capabilities/__tests__/resolver.test.ts`

**Interfaces:**
- Consumes: the two dedup passes' existing diagnostics (`capability.dedup.builtin-identity` at ~`resolver.ts:2186`, `capability.dedup.endpoint-identity` at ~`:2220`).
- Produces: each dedup diagnostic gains `safeArgs.inertComponents` — a comma-joined list of the stood-down plugin's OWN capability names that referenced the server, in the form `hook:<event or id>` / `skill:<name>` / `agent:<name>`. Absent when nothing references it.

**Why:** when a plugin's MCP server stands down as a duplicate, that plugin's own hooks, skills and agents keep pointing at a server that will never start. Today the row says the server is a duplicate and nothing says which of the plugin's parts went inert with it.

- [ ] **Step 1: Write the failing test.** In `resolver.test.ts`, beside the existing dedup cases: an enabled builtin `t-tracker` plus a plugin declaring its own `t-tracker` server via `dp ai mcp tracker` (so T4 disables it) AND, from the same `pluginInstanceId`, a hook whose `mcpTool` is `mcp__t-tracker__list` and a skill whose `allowed-tools` names `mcp__t-tracker__*`. Assert the `capability.dedup.builtin-identity` diagnostic's `safeArgs.inertComponents` names both. Add the negative arm: the same plugin's hook that references a DIFFERENT server is not listed. Run it, confirm it fails (no `safeArgs` today).

- [ ] **Step 2: Implement.** In both dedup passes, before pushing the diagnostic, scan `entries` for the same `pluginInstanceId` whose content references the server's `logicalName`:
  - `entry.runtimeBinding.kind === 'hook'` with an `mcpTool` that parses (via `tryParsePiDynamicMcpBindingName`) to that logical name or to its minted wire name;
  - `entry.summary.skillAllowedTools` containing a pattern for that name (exact or `__*` wildcard);
  - agent capabilities are resolved later, in `runtime-agent-definition.ts`, and their `mcpServers:` list is not on the summary — if you cannot reach it from here without new plumbing, LEAVE IT OUT and say so in your report and in a code comment. A partial list that says what it covers beats a plumbing detour.
  Build the list as `kind:name` strings, sorted, and attach as `safeArgs.inertComponents`. Names only — no paths.

- [ ] **Step 3: Make it visible.** Find how an existing dedup reason reaches the user (`rg -a "duplicates-builtin" apps/electron/src/renderer`), and extend that surface to show the inert list when present. If the renderer's diagnostic path renders only the code and cannot show `safeArgs`, do NOT build a new UI surface: put the list on the affected row's reason text instead, and record the limitation in your report.

- [ ] **Step 4: i18n.** Both locales, alphabetical. English: "Parts of this plugin that used this server are inactive: {{components}}". Russian: "Части плагина, использовавшие этот сервер, не работают: {{components}}".

- [ ] **Step 5: Gate + commit.**

```bash
bun test packages/shared/src/capabilities/__tests__/
bun run lint:i18n:parity && bun run lint:i18n:sorted
bun run typecheck:all
```

```bash
git commit -m "feat(mcp): a stood-down server says which parts of its plugin went inert"
```

---

### Task 2: no unparseable wire name, and a diagnostic for any that slips through (F3)

**Files:**
- Modify: `packages/shared/src/capabilities/mcp-wire-name.ts` (export the existing `segment` sanitizer under a clear name)
- Modify: `packages/shared/src/capabilities/resolver.ts` (apply it to scoped/native + builtin mint sites; add the unparseable-name diagnostic)
- Modify: `packages/shared/src/i18n/locales/en.json`, `ru.json`; the renderer reason map
- Test: `packages/shared/src/capabilities/__tests__/mcp-wire-name.test.ts`, `resolver.test.ts`

**Interfaces:**
- Produces: `sanitizeMcpNameSegment(value: string): string` exported from `mcp-wire-name.ts` — the same transform `pluginMcpWireName` already applies internally (non-`[A-Za-z0-9_-]` → `_`, `_` runs collapsed, edges trimmed).
- Produces: every wire name assigned in `applyCollisionPolicy`'s `byMcp` branch is sanitized before it is capped.
- Produces: diagnostic `capability.mcp.unusable-wire-name` (severity `warning`, `safeArgs.server`) for any runnable MCP capability whose wire name still cannot form a parseable proxy tool name.

**Why:** `capMcpNameSegment` truncates but does not sanitize, and the sanitizer runs only inside `pluginMcpWireName`. A scoped `.mcp.json` server named `my server.v2` keeps the space and the dot, and `tryParsePiDynamicMcpBindingName`'s `[A-Za-z0-9_-]` regex then rejects every one of its tool names — since T1 that failure is a silent drop instead of a loud throw.

- [ ] **Step 1: Write the failing tests.** (a) In `mcp-wire-name.test.ts`: `sanitizeMcpNameSegment('my server.v2')` → `my_server_v2`, and the result never contains `__`. (b) In `resolver.test.ts`: a scoped/native MCP record whose `logicalName` is `my server.v2` resolves to a wire name matching `^[A-Za-z0-9_-]+$`, and `mcp__<wire>__list` parses via `tryParsePiDynamicMcpBindingName`. (c) A builtin dp record's wire name is byte-unchanged by sanitization (all builtin names are already clean — this is the regression guard that the sanitizer cannot rename a builtin). Confirm (b) fails today.

- [ ] **Step 2: Implement the sanitizer.** Extract the existing internal `segment` helper in `mcp-wire-name.ts` into an exported `sanitizeMcpNameSegment`, and have `pluginMcpWireName` call the exported one — its output must stay byte-identical (assert that in the test).

- [ ] **Step 3: Apply at the mint.** In `applyCollisionPolicy`'s `byMcp` branch, wrap every wire-name assignment so it is sanitized THEN capped: the scoped/builtin winner, the shadowed entry, and the plugin name (already sanitized internally — the outer call must be a proven no-op, assert it).

- [ ] **Step 4: Add the net.** After the mint, for every entry that is runnable and carries an MCP wire name, check `tryParsePiDynamicMcpBindingName(\`mcp__${wireName}__probe\`)`; when it returns null, push a `warning` diagnostic `capability.mcp.unusable-wire-name` with `safeArgs.server` = the logical name. This should now be unreachable through the mint — it is the guard that says so out loud if a future path bypasses it. Add a test that forces it by constructing the condition directly.

- [ ] **Step 5: i18n + renderer.** Both locales, alphabetical. English: "This server's name can't be used in tool names; its tools are unavailable". Russian: "Имя этого сервера нельзя использовать в именах инструментов; его инструменты недоступны".

- [ ] **Step 6: Migration note.** Sanitizing moves a user-visible wire name for any scoped server whose name carried a space, a dot or another rejected character. Record it in this plan's Deviations log now; G5 puts it in the release notes.

- [ ] **Step 7: Gate + commit.**

```bash
bun test packages/shared/src/capabilities/__tests__/ packages/shared/src/mcp/__tests__/
bun run lint:i18n:parity && bun run lint:i18n:sorted
bun run typecheck:all
```

```bash
git commit -m "fix(mcp): sanitize every minted wire name, and say so when one is unusable"
```

---

### Task 3: lift the acquisition pipeline into a V2-owned module (F4, part 1)

**Files:**
- Create: `packages/shared/src/plugins/acquisition.ts`
- Modify: `packages/shared/src/plugins/management-service-v2.ts`
- Modify: `packages/shared/src/plugins/index.ts` (the `listRepositoryTags` export)
- Modify: `packages/shared/src/marketplace/registry-source.ts` if it imports the moved pieces
- Test: the existing install-service tests that cover the moved behavior, re-pointed

**Interfaces:**
- Produces: `acquisition.ts` exporting the format-agnostic bundle-acquisition pipeline currently inside `PluginInstallService` — remote fetch, archive extraction (`tar` / `yauzl`), adapter normalization via `normalizePluginBundle`, semver resolution, and `listRepositoryTags`. Names and signatures stay as close to today's as the move allows; this is a MOVE, not a redesign.

**Why:** `store-v2.ts` already declares itself "the only production plugin store after the W10 cutover", with the v1 store/projection/commit installer retired to test-only. The single thing keeping V1's file alive in production is that `management-service-v2.ts` instantiates `PluginInstallService` for acquisition — plumbing that has nothing to do with V1's model. Move it, and V1 has no production caller left.

- [ ] **Step 1:** Inventory first, and write the inventory into your report before you move anything: every symbol `management-service-v2.ts` uses from `install-service.ts`, and every other non-test importer of that file. `rg -a` only.
- [ ] **Step 2:** Move those symbols into `acquisition.ts` unchanged. Do not rename, do not refactor, do not "improve" them in the same commit — a behavior change hidden in a move is the one thing that makes a move unreviewable.
- [ ] **Step 3:** Re-point `management-service-v2.ts`, `index.ts` and any other non-test importer at `acquisition.ts`. `install-service.ts` keeps whatever V1-only code remains; it must no longer be imported by any production module. Prove that with `rg -a` and put the output in your report.
- [ ] **Step 4:** Re-point the tests that cover the moved code. If a test covers both moved and V1-only behavior, split it rather than duplicating it.
- [ ] **Step 5: Gate + commit.**

```bash
bun test packages/shared/src/plugins/__tests__/
bun run typecheck:all
```

```bash
git commit -m "refactor(plugins): the bundle-acquisition pipeline belongs to V2, not to the V1 installer"
```

---

### Task 4: delete the retired V1 halves and pin the single entry point (F4, part 2)

**Files:**
- Delete: `packages/shared/src/plugins/install-service.ts`, `store.ts`, `legacy-types.ts` and the V1 half of `projection.ts` — whatever of each is genuinely unreachable after G3
- Modify: every remaining importer (`plugin-settings.ts`, `project-config.ts`, `visibility-state.ts`, `hooks-automation.ts`, `hooks-runtime.ts`, `runtime-projection.ts`, `marketplace/registry-source.ts`, `index.ts`)
- Delete: the tests that exist only to pin deleted code
- Test: new conformance test asserting one projection entry point

**Why:** F1's defect was a pass wired to the path installs do not take. Deleting the second path is the only fix that cannot regress.

- [ ] **Step 1:** Map the graph before deleting: for each of the four V1 units, list every importer and mark it "V1-only" or "shared". `rg -a`, output into the report. If something you expected to be dead is alive, STOP and report — do not force the deletion.
- [ ] **Step 2:** Delete bottom-up: the units with no remaining importers first, then their dependents. After each deletion run `bun run typecheck:all` — the compiler is the proof that nothing still speaks V1. `legacy-types.ts` goes LAST, because it is what proves the rest are gone.
- [ ] **Step 3:** Convert any importer that is still alive to the V2 equivalent, one file at a time, keeping its tests green. If a consumer has no V2 equivalent, STOP and report rather than inventing one.
- [ ] **Step 4:** Write the conformance test — the point of the whole task. In `packages/shared/src/plugins/__tests__/`, assert that the plugins package exposes exactly one projection entry point for the capability pipeline (`resolvePluginProjectionCandidates`), e.g. by asserting the module exports and that no production module imports a second projection function. Its failure message must say why: a second path is how a translation pass ends up attached to a road nobody drives.
- [ ] **Step 5: Gate + commit.**

```bash
bun test packages/shared/src/plugins/__tests__/ packages/shared/src/capabilities/__tests__/
bun run typecheck:all
```

```bash
git commit -m "refactor(plugins): delete the retired V1 store and projection, leaving one path"
```

---

### Task 5: close-out

**Files:** root `package.json` + `apps/electron/package.json` (bump to the next minor from whatever both carry — `1.25.0` if still on `1.24.x`, lockstep); new `apps/electron/resources/release-notes/<version>.md`; `docs-site/` pages touched by G1/G2 behavior, both locales; regenerated registers; this plan's tracker.

- [ ] **Step 1:** Versions, release notes (user-facing: inert-parts visibility, the wire-name sanitization and its migration consequence, nothing about the V1 deletion — it is invisible to users), docs-site in both locales.
- [ ] **Step 2:** Regenerate: `python3 scripts/build-parity-report.py > docs/superpowers/specs/2026-07-30-parity-report.md` and `python3 scripts/regenerate-deviation-register.py > docs/superpowers/specs/2026-07-29-deviation-register.md`. Never hand-edit either.
- [ ] **Step 3:** The plan's one full wave, with real recorded output:

```bash
rm -rf release
bun run typecheck:all
bun run lint
bun run lint:i18n:parity && bun run lint:i18n:sorted
bun run test:shared:all
bun test
```
Plus `apps/cli`'s typecheck separately. Compare any failure against `docs/superpowers/specs/2026-07-29-known-failing-tests.md` before recording it as new.

- [ ] **Step 4:** Update the 2026-08-10 plan's F2/F3/F4 tracker rows to point at this plan, then commit:

```bash
git commit -m "chore(release): <version> — MCP follow-ups F2-F4"
```

---

### Task 6: the live gate — prove it in the real app, over CDP

**This task is the plan's acceptance gate and it is written to be handed to a fresh agent with no memory of this work.** Everything it needs is below or cited.

**Why it exists:** every check so far has been offline. The 1.24.0 wire-names work and this plan's G1–G4 were verified by focused tests, by a full repo wave, and by a live pass that drove real plugin bundles through the production pipeline in-process — but never through the shipped application. Four things stayed unverified, and this task closes them:

1. no live network MCP call ever happened (every server in the bundles used was OAuth-gated);
2. no live model turn ever invoked an MCP tool end to end — verification stopped at "which names reach the model";
3. the packaged app was never driven (the CDP scenario from the 1.24.0 plan's close-out was marked reviewer-owned and never run);
4. two different marketplaces serving one plugin name at once was not reproducible in-process (local-path installs collapse to a single instance).

**Read before starting:** `scripts/cdp/README.md` (the harness, how to start the app for a run, how a case reports), `docs/testing/cdp-live-checklist.md` (the case format and the existing cases), and the two plans this gate covers — `docs/superpowers/plans/2026-08-10-stable-plugin-mcp-wire-names.md` and this one.

**Two traps from AGENTS.md that have each cost a real measurement here:**
- `electron:dev` runs the host AND the Pi subprocess from BUILT bundles. A main-process change on disk is NOT in the running app until `bun run electron:build:servers` and a relaunch. A run against a stale bundle measures yesterday's code and reports it as today's — confirm the bundle carries the code under test before trusting a result (e.g. `grep -c <a symbol this work added> apps/electron/dist/main.cjs`).
- A dev build is not the shipped artifact: `resolveInterceptorBundlePath` preloads the `.ts` source when `!isPackaged` and `dist/interceptor.cjs` when packaged. Evidence that a user's installed app behaves this way must come from a packaged build.

**Files:** new case(s) under `scripts/cdp/cases/`, registered in `scripts/cdp/run.ts`; a row per case in `docs/testing/cdp-live-checklist.md`.

- [ ] **Step 1: Fixtures.** Prepare, in an isolated `NESSY_CONFIG_DIR`, a state that reproduces the incident shape: an enabled built-in dp server (`t-tracker`) plus an installed plugin bundling an MCP server of the same name, plus one plugin whose MCP server is reachable WITHOUT credentials so a real tool call is possible. If no credential-free real server is available, stand up a trivial local MCP server as the fixture and say so — a local server still proves the runtime path; an OAuth wall proves nothing. Never enter, invent or fabricate a credential.
- [ ] **Step 2: Case — names in the real app.** Drive the running app: the Sources list shows the built-in under `t-tracker` and the plugin's copy under its qualified name (or as stood down with a visible reason, if the dedup passes apply to your fixture). Record what the UI actually shows, not what the code should produce.
- [ ] **Step 3: Case — a real turn calls a real tool.** Start a session and get the model to invoke one MCP tool from the fixture server; assert the call reaches the server and its result reaches the turn. This is the item nothing so far has covered.
- [ ] **Step 4: Repeat for all three runtimes.** Pi, the Claude runtime, and the Codex runtime each consume names through the same pool but by different mechanics. Run steps 2–3 against each, switching the session's connection. If a runtime cannot be exercised here (no credentials for its provider, a binary absent from the dev build), record that as an explicit gap with the reason — do not silently cover two and imply three.
- [ ] **Step 5: The two-marketplaces case, or an honest negative.** Attempt the same `pluginId` from two marketplaces at once. If the environment still collapses them to one instance, write down exactly what you tried and why it collapsed, and leave the case BLOCKED. A documented blocked case is a result; a quietly dropped one is not.
- [ ] **Step 6: Packaged-build confirmation.** Repeat the single most important assertion (a real tool call succeeding under the new naming) against a packaged build, per the interceptor caveat above.
- [ ] **Step 7:** Record every case's real output in `docs/testing/cdp-live-checklist.md`, update this plan's Tracker row, and commit:

```bash
git commit -m "test(cdp): live gate for MCP naming across the three runtimes"
```

**What a PASS means here, precisely:** the names a user sees and the tools a model can actually call agree with the mint, in the shipped app, for every runtime you were able to exercise — and every runtime you could not exercise is named. A gate that reports green while silently skipping a runtime is worse than no gate, because the next person will trust it.

---

## Tracker

| Task | Status | Commit | Note |
| --- | --- | --- | --- |
| G1 inert-content naming (F2) | ✅ | `a3b89d827` | Hooks + skills covered via a shared `entries` scan in both dedup passes; agents left out (their `mcpServers:` resolves later in `runtime-agent-definition.ts`, off the capability summary) per the brief. Surfaced by extending the existing reason-text surface (`unavailableReasonText`/`CapabilityDetailTemplate.tsx`), not the raw-code diagnostics list (pre-existing gap, left alone). |
| G2 sanitize wire names + unusable-name diagnostic (F3) | ✅ | `a2051dcb3` + fix `85e132920` | Review found 2 Important, both fixed in `85e132920`: an all-disallowed logical name (e.g. Cyrillic) minted an EMPTY wire name — now falls back to a stable `server-<hash>` (keyed on the entry's stable `summary.key`, distinct per entry, inert for any name with one allowed char); and the builtin guard now pins `sanitizeMcpNameSegment(name) === name` over the real `BUILTIN_DP_MCP_SERVERS` list beside the 40-cap. Re-review Approved. `sanitizeMcpNameSegment` exported from `mcp-wire-name.ts` (`pluginMcpWireName` now calls it; output pinned byte-identical); applied sanitize-THEN-cap at all three `applyCollisionPolicy` `byMcp` mint sites (scoped/builtin winner, shadowed entry, plugin name — the last a proven no-op, pinned in `mcp-wire-name.test.ts`). Net diagnostic `capability.mcp.unusable-wire-name` (`diagnoseUnusableMcpWireNames`, exported) runs after the mint for every runnable MCP-carrying entry; forced directly in `resolver.test.ts` since the mint now makes it unreachable through `resolve()`. i18n both locales; renderer reads the diagnostic directly (`CapabilityDetailTemplate.tsx`'s `unavailableReasonText`) since this diagnostic never sets `unavailableReason` — see Deviations log for why, and for the migration consequence. |
| G3 acquisition pipeline to V2 (F4 part 1) | ✅ | `de1bdfb1c` | `acquisition.ts` created; `management-service-v2.ts`, `index.ts`'s `listRepositoryTags` export and `registry-source.ts` re-pointed. `install-service.ts` has no production importer left — composes with `acquisition.ts` internally so its own V1-commit tests (`installFromSource`/`rootDirectory`) needed zero edits; two pure-acquisition test blocks (`selectNpmVersionName`, `listRepositoryTags`) extracted to a new `acquisition.test.ts`, five acquisition-only test files re-pointed. |
| G4 delete retired V1 + single-entry-point test (F4 part 2) | ✅ | `74400bdb8` + fix `add6c9697` | Deleted: `install-service.ts`, `projection.ts`, `legacy-types.ts`, plus two production-dead modules the graph map surfaced (`runtime-projection.ts`, `visibility-state.ts`), `hooks-runtime.ts`'s executor and `hooks-automation.ts`'s V1 registration bridge (47 files, −5 679). Kept-and-renamed (alive): `store.ts` → `marketplace-registry-store.ts` (marketplaces.json is live), `hooks-runtime.ts` types → `hook-events.ts`. Conformance test `one-projection-entry-point.test.ts` pins `resolvePluginProjectionCandidates` as the only entry point via a shape census over plugins/capabilities/server-core/server roots, proven RED two ways. Four-lens adversarial review (24 agents) found 1 Important — two dangling `repo://` evidence refs turned `claude-parity-evidence.test.ts` red under CI's bare `bun test`, invisible to the task gate — fixed in `add6c9697` with 7 minors; re-review Approved. Owner decisions D1–D3 recorded in the Deviations log. |
| G5 close-out | ✅ | `efb82e298` + fix `b7461c241` | 1.25.0 lockstep in both package.jsons; new `1.25.0.md` (G1 inert-parts visibility, G2 sanitization + both migration consequences, unusable-name marker hedged; nothing about the V1 deletion); docs-site mcp-servers + plugins overviews in both locales; 2026-08-10 plan's F2/F3/F4 rows → ✅ with residuals named; both registers regenerated. Full wave green: typecheck:all 0, apps/cli 0, lint 0 errors, i18n parity/sorted OK, test:shared:all 305/0, repo-root `bun test` (after `rm -rf release`) 12 682 pass / 18 skip / 0 fail. Review found 1 Critical (migration note pointed at a name the panel never shows — the panel keeps the typed name; real surface is `mcp__<wire>__<tool>` in permission prompts) + 2 Important (reason renders on the DETAIL page, not the row; parity report regenerated before its register input) — fixed in `b7461c241`, re-review Approved; D4 follow-up recorded (wire name in detail-page metadata, deferred). |
| G6 live CDP gate (all three runtimes, packaged build) | ✅ | `a775e714b` + fix `42117d7ec` | Acceptance gate RUN, dev + packaged `.app` (dmg step failed on `NESSY_DESKTOP_UPDATE_URL` — recorded). Cases MCP-W1/W2/W3 committed + registered, rows in `docs/testing/cdp-live-checklist.md` with real output. Names in the real UI: builtin keeps bare `t-tracker`, plugin copy stands down with the rendered en/ru reason; `my server.v2` → `my_server_v2` and `мой сервер` → `server-<hash>` both CONNECT, and after the fix both F3 names are asserted against the model's own tool list (Pi dev re-run 8/8). Real tool call with per-call nonce: Pi PASS dev+packaged, Claude runtime PASS packaged (dev lacks the managed Node runtime — build artifact; enumeration self-report failed there and is recorded as weak evidence, nondeterministic prose), Codex runtime FAIL both builds (TOOLS=NONE / Unknown tool) — named gap, follow-up in the Deviations log. Two-marketplaces shape reproduced (MCP-W3 6/6): two local-folder registries, one `pluginId` twice, T4b stands one down pre-collision. THE GATE'S CATCH, review-confirmed: `normalizePluginCapability` strips `skill.allowedTools`+`paths`, so G1's skill arm is dead for every installed plugin (hook arm + invocation ceiling proven live) — follow-up in the Deviations log. Review Approved after the checklist-evidence fix. |

## Deviations / decisions log

- 2026-08-11 — plan authored at owner request to execute F2–F4 from the 2026-08-10 wire-names plan, after F1's live verification found a defect that two-paths made possible.
- Category: `product-fix (silent MCP failures)` — G1 and G2 make two silent paths speak.
- Category: `de-legacy (single plugin path)` — G3 and G4 remove the second projection path.
- 2026-08-11 (G2/F3) — migration consequence: sanitizing the scoped/native/builtin mint (`applyCollisionPolicy`'s `byMcp` branch, `resolver.ts`) moves the wire name of any scoped `.mcp.json`/native server whose logical name carried a character outside `[A-Za-z0-9_-]` (a space, a dot, etc.) — e.g. `my server.v2` now mints `my_server_v2` instead of keeping the raw name. That server's proxy tool names change (`mcp__my server.v2__<tool>` was never actually reachable — `tryParsePiDynamicMcpBindingName` rejected it outright — but it did appear literally in the pool key and in any managed allow/deny `serverName` entry naming it by the old raw string), so a managed MCP allow/deny rule or a hand-written permission naming the old raw server name needs rewriting to the sanitized name. Builtin dp servers are unaffected (`packages/shared/src/mcp/__tests__/builtin-dp-servers.test.ts` — every name is already clean) and plugin wire names are unaffected (`pluginMcpWireName` already sanitized). Follow-up on the same day (review finding 1): a scoped/native server whose name lies ENTIRELY outside `[A-Za-z0-9_-]` — `мой сервер`, `日本語` — previously minted an unusable empty wire name, which the runtime pool drops outright, and now mints a stable `server-<10 hex of the capability key>` name instead. G5 puts this in the release notes.
- 2026-08-11 (G4 review, D1) — the two production renames that rode G4 are KEPT: `packages/shared/src/plugins/store.ts` → `marketplace-registry-store.ts`, and `packages/shared/src/plugins/hooks-runtime.ts` → `hook-events.ts`. The G4 report justified them with "all via `git mv`, so history follows"; that is FALSE, and it is written down here because the lost provenance is otherwise unfindable. Measured on 74400bdb8: git scores the first rename R022 and the second R010, both under the 50% similarity `--follow` uses by default, so plain `git log --follow` returns only 74400bdb8 for either new path and `git blame` attributes every line of both new files to 74400bdb8. Recovery: `git log --follow -M20% -- packages/shared/src/plugins/marketplace-registry-store.ts` reaches b0053399e, and `git log --follow -M10% -- packages/shared/src/plugins/hook-events.ts` reaches 831b833fd — `-M10%` recovers both. (The review brief called the second rename undetectable at any threshold; measurement says otherwise — it is detected from `-M10%` down, which is why an incantation can be given at all.)
- Category: `de-legacy (rename below the follow threshold) — a rename whose similarity score falls under the default 50 percent silently costs both git log --follow and git blame, and the only cure is knowing the old path, so the old path belongs in the record rather than in a reviewer memory.`
- 2026-08-11 (G4 review, D2) — the author-facing plugin hook diagnostics G4 deleted are an ACCEPTED V2 gap, not a regression, and nothing is restored now. 21 `plugin.hooks.*` codes were emitted at the parent revision and zero are emitted on HEAD, but every deleted emitter was ALREADY production-unreachable at the parent: `buildTrustedPluginHookAutomations` had test-only callers and `hooks-runtime.ts`'s executor had none, so no author lost a message any author was receiving. The RULES all survive on the live path and enforce silently — `pluginHookAction` (`capabilities/runtime-automations.ts:296-319`) returns `null` for each malformed declaration, `pluginHookConfig` drops an `if` rule carried on a non-tool event, and the hook type/event matrix is re-enforced at dispatch (`plugins/hooks-automation.ts:721-725`).
- Category: `documented, not implemented — a plugin author whose hook declaration is malformed, or whose once or asyncRewake field is ignored, receives no message at all and the hook is simply inert, which is the one failure mode an author cannot diagnose from outside the app.`
- Follow-up scope for D2, if a later task restores the surface: all 16 registration codes, NOT the 11 the G4 report listed. The 5 the report omitted are `missing_command`, `missing_prompt`, `missing_agent`, `missing_mcp_tool` and `missing_http_url` — the malformed-declaration arm, and the arm an author is most likely to hit. Restoring only the 11 would re-ship the surface with its most common case still silent.
- 2026-08-11 (G4 review, D3) — `defaultEnabled: false` stays UNIMPLEMENTED on the V2 install path. `management-service-v2.ts:180-181` activates unconditionally whenever `options.activateIn` is set, and `marketplace/service.ts:183` always supplies one (`request.activateIn ?? { kind: 'global' }`), so a bundle shipped opt-in installs ENABLED. The acquisition pipeline does carry the field through to the store, and that half is tested. This is PRE-EXISTING rather than caused by G4: V1's gate was itself dead code, so deleting V1 removed nothing that ran. Recorded as a follow-up; the only thing fixed under this review is the comment in `plugins/__tests__/acquisition-pipeline.test.ts`, which pointed the reader at `management-service-v2.test.ts` for coverage that does not exist there.
- Category: `documented, not implemented — a plugin manifest asking to install disabled is honoured as far as the store and then ignored at activation, so an author who ships opt-in gets the opposite of what the manifest requested and no test covers the gap.`
- 2026-08-11 (G5 review, D4) — the minted wire name is NOT visible anywhere a user can read it without making the server run a tool, and this release does not change that. The renderer never renders it: a row's label is `capabilityDisplayName` = `mention?.label ?? displayName ?? logicalName` (`apps/electron/src/renderer/lib/capability-catalog.ts:11-13`), which for a scoped `.mcp.json` server is the raw JSON key, and `rg -a "wireName" apps/electron/src/renderer --glob '!__tests__'` returns nothing. The one place the minted name reaches a user is a tool name — `mcp__<wire>__<tool>` — as it appears in the session transcript and in permission prompts, so someone rewriting a rule against a generated `server-<short code>` name has to trigger a tool call first. FOLLOW-UP, deferred and not shipped here: put the minted wire name in the capability detail page's metadata section (`CapabilityDetailTemplate.tsx:183`), where a permission-rule author can read and copy it without a tool call. G5 is docs-only, so its release notes point at the tool-name surface instead and say plainly that the panel keeps showing the original name. Note that 1.24.0's release notes carried the same "the shortened name Sources now shows" phrasing for the 40-character cap; release-notes files are append-only history and stay unedited, so that line is left exactly as it shipped.
- Category: `documented, not implemented — the wire name a permission rule must be written against is never rendered in the app, so a user told to rewrite a rule against the generated name can obtain it only by making the server run a tool and reading the name out of the tool name in the transcript or a permission prompt.`
- 2026-08-11 (G6 live gate, confirmed by independent review) — G1's SKILL arm is dead for every INSTALLED plugin, and this plan ships it that way, found only because the live gate drove a real bundle through the real install pipeline. `normalizePluginCapability` (`packages/shared/src/plugins/schema.ts:596-606`) rebuilds the `skill` object and copies neither `allowedTools` nor `paths`, although `PluginSkillDescriptor` declares both and the adapter fills them from SKILL.md (`format-adapters.ts:601-619`) — the second normalize pass on install (`management-service-v2.ts:857`) then strips what the first pass produced. Downstream, `pluginSkillInvocationControls` (`capabilities/resolver.ts:1185`) is the only producer of `summary.skillAllowedTools` for a plugin entry, so G1's skill scan (`resolver.ts:2328`) never fires for an installed plugin, T3's bare→wire `allowed-tools` translation is dead on the same path, and `views.ts:224-225` under-reports both fields for every installed plugin. G1's tests stayed green because they hand-build the summary and never cross the normalize step — the exact "pass wired to a road nobody drives" shape F4 exists to kill, one layer down. What still works, proven live: the HOOK arm (`schema.ts:792` copies `mcpTool`), and the skill invocation-time ceiling itself (`runtime-skill-content.ts:1304` reads SKILL.md directly; the live case measured the refusal). FOLLOW-UP: copy `allowedTools` + `paths` in `normalizePluginCapability`'s skill branch, with a normalize-round-trip test and a live re-check of MCP-W1's failing check 11. RESOLVED same day, commit `4844f3a79` (reviewed: Approved): the skill branch now copies both fields (both manifest spellings for `allowedTools`), RED was proven through the REAL `normalizeNessyPluginManifest` → `resolvePluginProjectionCandidates` → resolver road — the shape the original G1 tests bypassed. Two review riders, recorded as decisions: (1) the fix also brings the `paths` invocation gate to life for installed plugin skills — such a skill was previously always model-invocable and now activates only when a matching file is in play (`base-agent.ts` pathGatedSkills; correct per `skills.md:267`), and the manifest-over-SKILL.md precedence at `format-adapters.ts:601-605` was dead for these two fields and is now live — both said out loud in the 1.25.0 release notes; (2) NOT retroactive by decision — an already-installed plugin keeps its stripped manifest until update/repair re-materializes it (`store-v2` stores manifests verbatim and never re-normalizes on read); a startup backfill in the shape of `backfillRuntimeCompatibilityOnStartup` was considered and declined, because healing requires re-reading each installed bundle's SKILL.md at startup and the pre-fix behavior is the status quo for old installs, not a regression. The release notes carry the update/Repair pointer.
- Category: `documented, not implemented — the release notes promise that a stood-down server's row names the plugin skills that went inert with it, but the install-path normalizer strips the skill fields the resolver's inert-parts scan reads, so the promised list stays empty for every real installed plugin while every offline test passes.`
- 2026-08-11 (G6 live gate) — the CODEX runtime sees no plugin MCP tools at all: on both the dev and packaged builds the model reported TOOLS=NONE for the fixture plugin's server and the forced call returned "Unknown tool", while the same fixtures passed on Pi (dev + packaged) and on the packaged Claude runtime. Recorded as an undiagnosed named gap per the gate's honesty rule — no product code was touched and no diagnosis attempted inside G6. FOLLOW-UP: its own investigation case — determine where the pool-to-Codex handoff drops plugin-minted names (the same pool serves all three runtimes, so the drop is Codex-side mechanics), then extend MCP-W2's Codex arm from named-gap to measured PASS. RESOLVED 2026-08-12 in two layers, both live-measured:
  1. **The "Unknown tool" was the gate's own detector** — the AGENTS.md trap, one more time. Codex consumes the WHOLE pool through one aggregating HTTP bridge (`McpPoolServer`), declared in its config.toml as `[mcp_servers.sources]`; the bridge exposes pool names with `mcp__` stripped and codex-app-server prefixes its own server key, so the real name is `mcp__sources__<wire>__<tool>` (`pool-server.ts:205-208` documents exactly this shape). The case forced the Pi shape and "Unknown tool" was the correct answer to a wrong question. `proxyToolName` is runtime-aware now, and the re-run proved naming holds end to end: the pool log maps the bridge-stripped name back onto the mint (`plugin_cdp-echo-probe_echo__whoami → mcp__plugin_cdp-echo-probe_echo__whoami`).
  2. **Behind the corrected name sat a REAL defect of exactly this plan's class — a silent refusal.** codex-app-server asks for MCP tool-call approval via `mcpServer/elicitation/request`; the approval bridge did not recognize the method, `codex-agent.ts` answered the generic `{}`, codex failed to deserialize (`missing field 'action'`) and auto-rejected every MCP tool call with `awaitingApprovalCount=0` — nothing shown to any user, `TOOL-FAILED: user rejected MCP tool call` in the transcript. Fixed in `90ca1e4fe` + review round `290546a20`: the method joins the bridge, allow → `{action:"accept", content:{…}}` per the schema (the `{"approval_mode":"approve"}` form recovered from the bundled binary's own strings, not guessed), deny → decline, abort → cancel, asking modes surface the same permission card as exec/patch approvals — with `noAlwaysAllow` (neither side can honour a persist) and the arguments shown from `_meta.tool_params_display`. Live re-measure: nonce `3838e8c49e87` returned through the model's reply, zero deserialize errors in the whole run. Fact recorded by the review: on the Codex runtime EVERY mode except `dontAsk` maps to `approval_policy: 'on-request'`, so a card appears even under `bypassPermissions` — mode-based auto-approve does not exist on this path. Two deliberate fail-closed gaps shipped with the review round, both resolved by the same future Pi-port: a `mode:"url"` elicitation (an OAuth/consent link) is DECLINED rather than falsely accepted — nothing opens or shows the URL on Codex today, while the Pi path (`packages/shared/src/mcp/elicitation.ts`, `safeHttpUrl` + completed/cancel ask) already does this right; and a form whose `required` fields the filler cannot answer (free string/number without a default) is DECLINED even after a human allow, mirroring the Pi path's refusal, because an `accept` with fabricated or missing required content is the same lie the `{}` answer was. Known limitation, recorded rather than fixed: a FILLABLE third-party form is still auto-answered with its first non-sentinel option and reported as the user's choice — the card only asked "Allow?", so a server offering `environment: [prod, dev]` gets `prod` from a user who never saw the question; treating every elicitation as an approval is the modeling gap, and the same Pi-port follow-up (real form rendering) is its resolution.
- Still open after the resolution, each recorded from the same live runs: the Codex path writes NO tool row into the transcript (the pool served the call; `codex-mcp-tool-calls: []`), so a completed MCP call is invisible in the UI; the model's self-reported TOOLS= line said NONE in the turn before a turn that successfully called the tool (self-report and capability disagree within one session — the tools/list half remains unexplained); and the fixture plugin's skill is not available on Codex (`SKILL=NO`) while Pi lists it — RESOLVED 2026-08-12: the skills listing rides the STABLE context part (`base-agent.ts:639-643` feeds `promptBuilder.setRuntimeSkills`), and codex-agent never called PromptBuilder at all, so no context parts — the skills listing, session state, sources, workspace capabilities — ever reached a codex conversation; `SKILL=NO` was the truth, not a self-report artifact. Fixed by composing `buildContextParts` into the outgoing codex turn in Claude's exact shape (one composition per chatImpl, parts before the user text; thread/fork, clearHistory and queued sends verified part-free), live re-measure pending in this wave's gate.
- Both remaining live gaps above are RESOLVED, live-proven 2026-08-12 on the full three-runtime matrix (checklist commits `e528d041e` and predecessors): the transcript row exists on Codex — `{tool: "mcp__sources__plugin_cdp-echo-probe_echo__whoami", status: "completed"}` with the result text behind it (`6fd6abeee`); and the skill is available on all THREE runtimes — Pi/Claude/Codex all YES, where Codex was NO (`7f1315bb9`: the skills listing rides the codex turn now). The same run round-tripped a fresh per-call nonce on every runtime (Pi `2d90822d9ce1`, Claude `9205df943d47`, Codex `a3ced445219a`) — a plugin's MCP tool call works end-to-end on all three. One sub-claim stays offline-proven only: the codex row's display meta resolving the real server behind the bridge (`4a2b38d67`, 5/5 offline) could not be read off the DOM in that run — recorded as unverified, not refuted. The model's self-report of its own tool list (`TOOLS=` line) failed on ALL three runtimes in the same run in which every independent read and every real call succeeded — final confirmation that the self-report is the weakest instrument in the table and never evidence on its own.
- 2026-08-12 (elicitation-bridge review) — the same malformed-response class exists on SIX more codex server-initiated methods, one of them already reachable: `item/permissions/requestApproval` IS in `isApprovalMethod`, surfaces a card, and is answered `{decision}` while its schema requires `permissions` (a `GrantedPermissionProfile`) — the user's decision is then lost to the same deserialize failure the MCP fix just closed. Five more (`item/tool/requestUserInput`, `item/tool/call`, `attestation/generate`, two legacy v1 approvals) still receive the generic `{}` against schemas with required fields. FOLLOW-UP: answer each per its schema, `item/permissions/requestApproval` first because a human decision is being discarded today. RESOLVED same day, wave commits `8655c5ced` (requestApproval: the RED was worse than the audit said — the card also mislabeled a sandbox-widening grant as a shell command; allow now echoes the requested `GrantedPermissionProfile` verbatim at `scope:"turn"` — echoed because the app-server localizes granted paths and interrupts the turn on invalid ones, so the only safe paths are the ones it just sent, binary-verified; deny is `{permissions:{}}`, the whole denial vocabulary the shape has) and `188d1a868` (requestUserInput → `{answers:{}}`; item/tool/call → the schema's own failure shape; both legacy v1 approvals → real cards answering the V1 `ReviewDecision` enum, which is NOT the v2 vocabulary). Independent wave review verified every shape against the schemas and the binary. TWO methods stay `{}` BY DECISION, pinned in a test table with their reasons: `account/chatgptAuthTokens/refresh` (required fields are `accessToken`+`chatgptAccountId` — any answer is a forged credential the app-server would then use) and `attestation/generate` (required `token`, same class, and we send `requestAttestation: false` so it should never arrive). The review notes a JSON-RPC error frame as a possibly-more-legible third option for those two — recorded here for the next pass at this seam, not adopted.
- Category: `documented, not implemented — codex asks this client for chatgpt auth tokens or an attestation token, whose response schemas require credential values, and receives an empty object by decision, because any well-formed answer would be a fabricated credential.`
- The url-mode decline above is RESOLVED 2026-08-12, commit `ee3493054`: the same `safeHttpUrl` gate Pi uses (imported, not copied) runs BEFORE anything is shown, a permission card presents the validated href with `noAlwaysAllow`, and an allow opens the link through the injectable opener seam and answers `{action:"accept", content:null}`. ONE step, deliberately diverging from Pi's two-step confirm, on binary evidence the wave review re-verified: codex receives flow completion out-of-band (`notifications/elicitation/complete`, whose params carry exactly `elicitationId`, and url is the only mode requiring one), so `accept` means "opened", not "finished", and a second dialog would hold the response open for a confirmation codex is not waiting for. Headless still declines — auto-approve must not mean auto-launching a browser at an unattended machine; an opener failure declines, never accepts; abort cancels with nothing opened. Not portable live evidence (no fixture server asks for a url elicitation) — proven by the seam tests and the wave review's own binary reading. Residual, recorded: Pi's `urlConsent` panel (domain highlight + suspicious-URI warning) has no home on the plain permission card, so the card shows the full validated URL without that risk annotation.
- 2026-08-12 (wave-2, owner mandate «стабильная и корректная работа на всех трёх рантаймах») — seven commits, each independently reviewed and then reviewed once more as one diff (verdict: Approved): `7f1315bb9`+`3cf87f08f` (codex receives the PromptBuilder context parts — the skills listing rides every turn; session commands go out bare, citing the `/compact`-as-prose bug class at `base-agent.ts:3311-3322`), `6fd6abeee` (codex `mcpToolCall` items become transcript tool rows, named `mcp__<server>__<tool>` verbatim — deliberately NOT `buildMcpToolName`, which strips the bridge segment Pi-style and would print a name this runtime's model never used), `8655c5ced`+`188d1a868` (every codex server-initiated method answers its own schema — see the resolved entry above), `4a2b38d67` (`resolveToolDisplayMeta` shifts one segment behind the `sources` bridge so a codex row carries the real server's icon; known edge, recorded: a Pi source literally named `sources` whose tool name contains `__` would misroute — wire names never contain `__`, but the bridge's mount name is not reserved against user sources), `ee3493054` (url elicitation — resolved entry above). Owner decision recorded the same day: plugins installed before the skill-metadata fix will be REINSTALLED by their users at the owner's request; built-in dp MCP servers and native skills never cross the plugin normalizer and are unaffected, so no startup backfill ships.
- Incident, recorded for future bisects on this range: `3cf87f08f` and `6fd6abeee` DO NOT BUILD standalone — a controller zoning error let two agents write `packages/shared/src/agent/codex-agent.ts` concurrently, and a `git commit <pathspec>` took the working tree's state, landing W5's seam hunks (imports of bridge exports that did not exist yet) under `3cf87f08f`'s subject; `188d1a868` supplies the exports and HEAD is whole. History was deliberately NOT rewritten: the commits were local but the per-commit review mapping and the incident's own evidence were judged worth more than bisectability of a 3-commit window. A red `bun test`/typecheck at exactly those two commits is this record, not a product regression.
- Category: `documented, not implemented — the headless codex path auto-approves a sandbox-widening permissions request at turn scope the way it auto-approves every unattended approval, which is the one place the unattended posture is broader in kind than a single action, bounded by granting only what was asked for one turn.`
- 2026-08-12 (wave-2 tail, owner-triggered) — the renderer's own MCP label split carried the same single-underscore bug in three sites: `TurnCard` split `mcp__<server>__<tool>` with `[^_]+`, so a sanitized wire name with `_` in it (`my_server_v2` — the very names 1.24.0/1.25.0 mint) fell back to the raw internal name, and a codex `sources` row leaked the wire name into the tool half; `InlineExecution` title-cased the same mistake into `Mcp My Server V2 Whoami`. Fixed in `d2f18ca43` + `2332fa34f`: one pure module (`packages/ui/src/components/chat/mcp-tool-name.ts`) splits on the `__` boundary and mirrors `resolveToolDisplayMeta`'s `sources` shift and degenerate fallback exactly, so the renderer and server-core can no longer disagree about a row's name; `rg -a` confirms no single-underscore MCP split remains in `packages/ui`.
