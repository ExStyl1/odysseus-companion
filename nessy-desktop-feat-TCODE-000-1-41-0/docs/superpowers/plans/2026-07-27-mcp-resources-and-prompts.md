> **CLOSED 2026-07-27.** Executed and verified; evidence in the parity audit §0 (R5).
> CDP pass 7 proved the negative case live (tools absent with no resource server); the positive
> case needs a live resource-advertising MCP server, deferred to the end-of-series wave.
> Kept until the end-of-series sweep. Do not execute again.

# MCP Resources and Prompts (R5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The two MCP client capabilities beside tools — resources and prompts — in all four documented surfaces: `@<slug>:<uri>` mentions, `/mcp__<slug>__<prompt>` slash commands, the model-facing `list_mcp_resources`/`read_mcp_resource` tools, and the read paths + cache lifecycle underneath them.

**Architecture:** The pool already **discovers** resources and prompts (`listResources`/`listPrompts` on `PoolClient`, `listContextCapability` in `mcp-pool.ts:719`, P5's `_meta`/annotation retention). Missing is everything that *uses* them: the **read** paths (`readResource`, `getPrompt`), the two model-facing tools, and the two user-facing surfaces. Build read on the existing capability-refresh machinery, add the tools through the session-tool registry R2 just made sound, and add the surfaces on the existing `@`-mention and slash-command paths.

> **Task 1 re-verification (2026-07-27) — more is built than the above states.** Two of Task 2's three lifecycle items are ALREADY implemented and must not be re-built:
> - `list_changed` refresh for resources/prompts already rides the tool path. `NessyMcpClient` (`client.ts:193-198`) registers `ResourceListChangedNotificationSchema`/`PromptListChangedNotificationSchema` handlers that fire `capabilitiesChangedHandler('resources'|'prompts')`; `McpClientPool.registerClient` (`mcp-pool.ts:886-889`) wires that for ALL kinds; `refreshConnectionCapabilitiesNow` (`:814-843`) routes non-tool kinds to `refreshContextCapability` (`:845-863`).
> - **Keep-on-failure is already correct.** `refreshContextCapability`'s catch calls `markCapabilityFailure` and leaves `contextCache` untouched — it never overwrites with `[]`. There is also already a public list surface, `McpClientPool.listContextResources` (`:1525`), with per-connection redaction (`redactConfiguredMcpSecrets`) and an `onlyIfMissing` refresh.
> So Task 2's genuine remaining work is (a) the **read paths** (`readResource`/`getPrompt`) — truly absent on `PoolClient`, `NessyMcpClient` (`client.ts`), `ApiSourcePoolClient`, and the pool — and (b) the **retry classification**, also truly absent (`refreshContextCapability` is a single try/catch; the only retry in the pool, `connectWithRetries` at `:1025-1049`, is connect-level, unclassified, and does not cover post-connect discovery).
>
> **Parity fixtures that Task 2/3 MUST update (the plan did not name these):**
> - `pi-harness-baseline.test.ts:795-819` asserts the `PoolClient` source does NOT contain `readResource`/`getPrompt` (`:817-818`) and pins the `PoolClient` method list (`:795-798`) — adding read paths breaks both.
> - `mcp-capabilities.json:12` `absentPiHostMethods` = `["resources/list","resources/read","resources/subscribe","prompts/list","prompts/get","sampling"]`, and the `resources/read`/`prompts/get` protocol rows carry `current: "absent-from-current-Pi-MCP-host"` — these must move to present once read + tools land (post-R5 residual = `resources/subscribe`, `sampling`).
> - `tool-surface.json` (`fixtures/`, 1614 lines) is the pinned tool ledger, keyed by tool with per-tool schema-identity hashes; the two new tools need entries here (Task 3's fifth surface).
>
> **Other confirmed anchors:** `PI_RUNTIME_AGENT_TOOL_ALIASES` lives at `runtime-agent-definition.ts:18` (not `toolNames.ts`); pattern is `lowercased-external-name: [canonical-pi-name, ...aliases]`, so R5 adds `listmcpresourcestool`/`readmcpresourcetool`. `system.ts:835` ALREADY names `list_mcp_resources` in the Pi system prompt (a dangling reference that becomes real in Task 3). Task 5 has a direct precedent: plugin PROMPT commands already implement `/`-command-from-a-prompt via `SessionManager.pluginPromptCommandEntries` / `resolveCustomSlashCommand`'s `prompt-command` binding (`SessionManager.ts:13617,13666-13688`) — mirror that shape for MCP servers rather than inventing one.

**Tech Stack:** TypeScript, Bun test.

**Contract source:** `code.claude.com/docs/en/mcp.md`, `tools-reference.md` (`ListMcpResourcesTool`/`ReadMcpResourceTool`), `slash-commands.md` (`/mcp__server__prompt`). Distilled in `docs/superpowers/specs/2026-07-26-r-queue-doc-verification.md` § R5 — **READ IT FIRST**.

## Global Constraints

- Scope: Pi runtime + app. One commit per task; no `Co-Authored-By`; no MR/tags; never reset/rebase/amend; pathspec-limited commits only; do not touch `docs/superpowers/specs/` (you may edit this plan file); Implementation-First Verification Budget.
- **A new session tool is five surfaces** (R2/R3's finding): descriptor, binding, callback-injection seam, handler, and the pinned `tool-surface.json` fixture with its parity test. `list_mcp_resources`/`read_mcp_resource` are documented as **needing no permission** — mark them `safeMode: 'allow'`, `readOnly: true`, and assert that in the descriptor.
- The pre-committed rename failure class: the model-facing tools are `ListMcpResourcesTool`/`ReadMcpResourceTool` in Claude's permission/agent-tool-list spelling. If an imported agent or rule names them, they must resolve — add the aliases the same way R2 handled `EnterWorktree` (`PI_RUNTIME_AGENT_TOOL_ALIASES`), or record why not.
- **Auto-provide only for servers that advertise the capability.** The tools appear only when at least one connected server lists resources; the `/mcp__…__prompt` commands only for servers with prompts. Do not surface a read tool against a pool that has no resource-bearing server.
- The series' recurring defect is now six instances. For every surface, **assert through the production path**, not a stub above it.
- **The boundary decision is Task 6 and it is a real decision, not a checkbox.** An `@`-mentioned resource is inserted while building the prompt, so no PreToolUse-equivalent fires and no permission rule covers the resource URI. Claude documents a deny rule for file `@` references and *none* for resource URIs. Decide deliberately and record it.

---

### Task 0: Pre-phase — fold in R12 close-out follow-ups

- [x] **Step 1:** Read the R12 close-out (audit §0 entry "R12"). Nothing in R12 touches the MCP pool or the session-tool registry, so no pre-phase commit is expected — confirm that and record "no R12 follow-ups touch MCP" in your Task 1 commit body. R12's one open item (a `retentionDays: 0` release-note flag) is the planner's, not yours. **Do not** chase CDP pass 6's `Session <id> not found` handle race here.
  - **CONFIRMED (2026-07-27):** R12 (audit lines 140-176) is entirely checkpoint/session retention — `cleanupPeriodDays`, checkpoint reference-counted GC, orphaned-worktree removal, transcript sweeps, `fileCheckpointingEnabled`. None of it names the MCP pool, `client.ts`, `mcp-pool.ts`, the session-tool registry, or the `@`-mention/slash surfaces. No pre-phase commit. Recorded in the Task 1 commit body.

### Task 1: Re-verify the plan against current code

- [x] **Step 1:** Confirm anchors:
  - `packages/shared/src/mcp/client.ts:141-156` — `PoolClient` has `listResources?`/`listPrompts?` and **no read methods**; `NessyMcpClient` from `:158`. **CONFIRMED exact.** `NessyMcpClient` (and `ApiSourcePoolClient`) already have concrete `listResources()`/`listPrompts()`; `readResource`/`getPrompt` absent everywhere.
  - `packages/shared/src/mcp/mcp-pool.ts:719-725` — `listContextCapability`; the capability-refresh chain (`enqueueConnectionCapabilityRefresh`, `refreshConnectionCapabilities`) and the `markCapabilityFailure`/`clearCapabilityFailure` pair — the keep-on-failure lifecycle rides these. **CONFIRMED exact** (`:744`, `:760`, `:727`, `:733`). Keep-on-failure already implemented in `refreshContextCapability` (`:845`); `contextCache` + `listContextResources` (`:1525`) already exist.
  - Whether a `list_changed` handler already refreshes tools (`setCapabilitiesChangedHandler`) and whether resources/prompts ride it. **CONFIRMED they ride it** — see the re-verification block under Architecture.
  - The `@`-mention resolution path — **CONFIRMED:** `fuzzyFileSearch` is the autocomplete source (`SessionManager.ts:14052`, RPC at `handlers/rpc/sessions.ts:389`); file mentions arrive resolved as `message.attachments` (`{path,name}`) and are read into `FileAttachment` at send (`SessionManager.ts:10702-10721`). A resource mention needs a server-side resolver (renderer can't read an MCP URI) — a Task 4 design point.
  - The slash-command discovery path (`listCustomSlashCommands`) — **CONFIRMED:** `custom-commands.ts:157`; assembled in `SessionManager.listCustomSlashCommandSummaries` / `resolveCustomSlashCommand` (`:13608`, `:13634`) alongside plugin-prompt and skill commands.
  - The session-tool registry surfaces R2 made sound — **CONFIRMED:** `piToolPresentedNames` (`harness-tool-descriptor.ts:319`), `binding`/`sessionBinding` (`:176`,`:195`), `SessionScopedToolCallbacks` (`session-scoped-tool-callback-registry.ts:23`), `SESSION_TOOL_DEFS`/`SessionToolHandler`/`RegistrySessionToolDef` (`tool-defs.ts:695,716,722`), parity fixture `tool-surface.json` + `pi-harness-baseline.test.ts`.
- [x] **Step 2:** Correct this plan in place; say what changed. **DONE** — added the re-verification block under Architecture (lifecycle already built; the read paths + retry classification are the real Task 2 work; named the three parity fixtures Task 2/3 must update; corrected the alias-map location and the `system.ts:835` dangling reference; recorded the plugin-prompt-command precedent for Task 5). Task 2 lifecycle bullets rewritten below to match.

### Task 2: Read paths on the pool client + the cache lifecycle

**Files:** `packages/shared/src/mcp/client.ts` (`PoolClient` + `NessyMcpClient`), `packages/shared/src/mcp/mcp-pool.ts`
- Test: `packages/shared/src/mcp/__tests__/` (extend the pool suite)

**Interfaces:**
- `PoolClient.readResource?(uri: string): Promise<{ contents: Array<{ uri: string; mimeType?: string; text?: string; blob?: string }> }>`
- `PoolClient.getPrompt?(name: string, args?: Record<string, string>): Promise<{ messages: Array<{ role: string; content: unknown }> }>`
- Pool methods `readResource(slug, uri)` / `getPrompt(slug, name, args)` that route to the connected client for that slug.

Documented lifecycle (each a test):
- `list_changed` refreshes prompts and resources **on the same path as tools**. **ALREADY WIRED** (see re-verification block) — lock it with a regression test on the context path; do not fork `setCapabilitiesChangedHandler`.
- A **failed refresh keeps the previously discovered lists** — never replace with an empty list. **ALREADY IMPLEMENTED** in `refreshContextCapability`'s catch — lock it with a test asserting the prior `contextCache` entries survive a throw (this test is also mutation-probe (a) in Task 7).
- Post-connect `prompts/list`/`resources/list` discovery **retries transient network + 5xx up to three times with short backoff; never retries auth errors, 4xx, or timeouts.** **GENUINELY NEW** — `refreshContextCapability` has no retry today; the only pool retry (`connectWithRetries`) is connect-level and unclassified. Add a classified retry around the discovery call. Classification is best-effort over the MCP SDK error shapes (HTTP status on the streamable-HTTP transport; JSON-RPC/auth error codes otherwise) — assert the buckets through an injectable failing client, not a hand-mocked classifier.

- [ ] **Step 1:** Failing tests: `readResource` routes to the right client and returns its contents; `getPrompt` maps args onto declared parameters; a `list_changed` for resources refreshes the resource list; a refresh that throws keeps the prior list (assert the old entries survive); a discovery 500 retries to 3 and then keeps prior; a discovery 401 does **not** retry.
- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement the read paths on `PoolClient` (`readResource?`/`getPrompt?`), `NessyMcpClient` + `ApiSourcePoolClient` (the SDK `Client` has `readResource({uri})`/`getPrompt({name,arguments})`), and the pool (`readResource(slug,uri)`/`getPrompt(slug,name,args)` routing to the preferred connection for the slug); add the classified discovery retry. **Update the parity fixtures named in the re-verification block:** `pi-harness-baseline.test.ts` (PoolClient method list + the `not.toContain('readResource'|'getPrompt')` assertions) and `mcp-capabilities.json` (`absentPiHostMethods` and the `resources/read`/`prompts/get` `current` fields). **Step 4:** Run — PASS + existing pool suites (`packages/shared/src/mcp/__tests__/`, `packages/shared/tests/mcp-pool.test.ts`) + `pi-harness-baseline.test.ts`. Commit: `feat(mcp): resource/prompt read paths and classified discovery retry`

### Task 3: `list_mcp_resources` and `read_mcp_resource` tools

**Files (the five surfaces, confirmed 2026-07-27):** (1) descriptor — `packages/shared/src/agent/pi-harness/harness-tool-descriptor.ts` (add `sessionBinding` entries + ledger rows); (2) binding — `mcp__session__list_mcp_resources` / `mcp__session__read_mcp_resource` (prefix `mcp__session__`); (3) callback-injection seam — `SessionScopedToolCallbacks` (`packages/shared/src/agent/session-scoped-tool-callback-registry.ts`) + `session-scoped-tools.ts`, threading a pool handle so the handler can call Task 2's `readResource`/`listContextResources`; (4) handler — `packages/session-tools-core/src/tool-defs.ts` (`SESSION_TOOL_DEFS`) + `packages/session-tools-core/src/handlers/`; (5) parity fixture — `packages/pi-agent-server/src/__tests__/harness-contract/fixtures/tool-surface.json` + `pi-harness-baseline.test.ts`. Alias map: add `listmcpresourcestool`/`readmcpresourcetool` to `PI_RUNTIME_AGENT_TOOL_ALIASES` in `packages/shared/src/agent/pi-harness/runtime-agent-definition.ts:18` (NOT `toolNames.ts`). Note: `packages/shared/src/prompts/system.ts:835` already names `list_mcp_resources` — that dangling prompt reference becomes real here.
- Test: colocated + the tool-surface parity test

- `list_mcp_resources`: optional `server` filter; returns the discovered resources (uri, name, mimeType, description) across resource-advertising servers, or one server when filtered.
- `read_mcp_resource`: `server` + `uri`; returns the contents via Task 2's `readResource`.
- Both `safeMode: 'allow'`, `readOnly: true`, and **auto-provided only when a connected server advertises resources** — assert the tools are absent from the surface when no server does.
- Aliases for `ListMcpResourcesTool`/`ReadMcpResourceTool`.

- [ ] **Step 1:** Failing tests: with a resource-advertising server the two tools appear on the Pi surface; with none they are absent; `read_mcp_resource` returns a stub server's contents; both resolve under their Claude alias; the parity test covers them.
- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement (five surfaces each). **Step 4:** Run — PASS. Commit: `feat(session-tools): list_mcp_resources and read_mcp_resource`

### Task 4: `@<slug>:<uri>` resource mentions

**Files:** the `@`-mention resolution path, its autocomplete source
- Test: resolution tests through the production path

- `@<slug>:<protocol>://<path>` resolves against the connected server's resources, fetched via `readResource`, and **inserted as an attachment before the turn is built** — the same insertion point file mentions use.
- Fuzzy-searchable in the `@` autocomplete **alongside files** — resource entries join the existing candidate list, they do not get a separate picker.

- [ ] **Step 1:** Failing tests: `@srv:file:///x` resolves to that server's resource and inserts its contents as an attachment; an unknown slug or uri fails soft (no attachment, no crash); the autocomplete candidate list includes resources from a resource-advertising server.
- [ ] **Step 2:** Implement. **Step 3:** Suites + typecheck. Commit: `feat(sessions): @slug:uri MCP resource mentions`

### Task 5: `/mcp__<slug>__<prompt>` slash commands

**Files:** the slash-command discovery path, the argument parser
- Test: discovery + invocation tests

- Dynamically discovered from servers advertising prompts (`prompts/list`), one command per prompt.
- Arguments **space-separated and quote-aware**, mapped onto the prompt's declared parameters via `getPrompt`.
- Server and prompt names **normalised — spaces to underscores**.
- Results **injected directly into the conversation** (the prompt's returned messages become turn input), not printed.

- [ ] **Step 1:** Failing tests: a prompt-advertising server produces `/mcp__<slug>__<prompt>`; `foo "a b" c` parses to two args mapped onto the declared params; a server named `my server` normalises to `my_server`; invoking injects the returned messages; a server without prompts produces no such command.
- [ ] **Step 2:** Implement. **Step 3:** Suites + typecheck. Commit: `feat(sessions): /mcp__slug__prompt slash commands`

### Task 6: The resource-mention boundary — decide and record

**Files:** wherever the mention is inserted (Task 4); possibly the DSL matcher kinds (R1)
- Test: whichever the decision implies

An `@`-mentioned resource bypasses PreToolUse and permission rules. Claude has a deny rule for file `@` references and none for resource URIs. **Decide:**
- **Option A (match Claude):** no resource-URI deny rule; document that a resource mention is user-initiated content, gated by the mention itself, and that `read_mcp_resource` (the *model*-initiated path) is where a rule would apply — and it is `readOnly`/no-permission by spec anyway.
- **Option B (go further):** add a resource-scoped deny matcher so an admin can block `@srv:secret://…`.

Recommendation in the plan: **Option A**, because R1's parser already governs the model-facing `read_mcp_resource` path and a user typing an `@`-mention is the same trust level as a user typing a file path; a URI deny rule with no model-facing bypass to guard is surface without a threat. But this is the executor's call to confirm against the code — if `read_mcp_resource` turns out ungated, Option B becomes necessary.

- [ ] **Step 1:** Confirm whether `read_mcp_resource` is reachable without a rule check. If it is genuinely no-permission per spec and user `@`-mentions are user-trust, take Option A: add a test asserting a model-emitted resource read is `readOnly` and record the decision in the commit body. If not, take Option B and add the matcher.
- [ ] **Step 2:** Implement the chosen option. Commit: `feat(mcp): resource-mention permission boundary (option <A|B>)`

### Task 7: Close-out

- [ ] **Step 1:** Full gates: `bun run typecheck:all`, `bun run test:shared:all`, server-core + session-tools suites, `bun run lint`, `git diff --check`.
- [ ] **Step 2:** Mutation probes: (a) make a failed refresh replace the list with empty → the keep-on-failure test must fail; (b) retry a 401 → the no-retry-auth test must fail; (c) surface the read tools with no resource-advertising server → that absence test must fail; (d) drop the quote-aware arg split → the slash-arg test must fail. Restore all four.
- [ ] **Step 3:** Report: per-task shas, gate numbers, deviations, probe results, the boundary option you chose and why, and the CDP cases for the next pass (expected: a real MCP server advertising a resource — `read_mcp_resource` returns it, an `@slug:uri` mention inserts it, a `/mcp__slug__prompt` injects the prompt; and the two tools absent when no server advertises resources).
