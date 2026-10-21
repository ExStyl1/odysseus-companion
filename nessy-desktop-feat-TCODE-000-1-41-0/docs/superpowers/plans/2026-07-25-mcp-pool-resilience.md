> **CLOSED — do not execute.** Landed as `1da90020`, `0a7ff0f5`, `66289ae4`,
> `4cc1a1ba`, `ebe1e7fa`, `71a0959b`, `851eb149`. All six tasks shipped; three were
> **narrowed against the real contract** (task 3's `_meta` key is vendor-namespaced
> and its semantics are the inverse of what this plan guessed; task 4's per-server
> timeout already existed as `toolTimeoutMs`; task 5 found `.mcp.json` expanded
> nothing at all). The Architecture's promised mid-session **reconnect was not
> delivered** — only the initial retry; that shortfall is in the audit's
> `Known follow-ups`. Retained for the end-of-series review; every checkbox below
> is finished work. Evidence lives in
> `docs/superpowers/specs/2026-07-25-nessy-claude-parity-audit.md` §0, row P5.

# MCP Pool Resilience and Descriptor Metadata Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One transient failure stops costing a server its whole session, and the metadata an MCP server ships about its own tools stops being thrown away one layer below the cache that already stores it.

**Architecture:** Two independent halves. The connect path gains a bounded initial
retry and a backoff reconnect, so `failedConnections` stops being a permanent
verdict. The descriptor path stops truncating: the store already persists whole
`Tool` objects, but both downstream projections rebuild them from `description` +
`inputSchema` only, so `annotations` and `_meta` never reach any consumer — which is
why `requiresUserInteraction` and `maxResultSizeChars` cannot be honoured today.

**Tech Stack:** TypeScript, Bun test runner. Package: `@nessy-agent/shared`
(`src/mcp`, `src/sources`).

Covers audit shortlist item 6 (`2026-07-25-nessy-claude-parity-audit.md` §0 row P5,
§1 rows `MCP reconnection` and part of `MCP config, scopes and auth extras`).
**P6 depends on Task 2 of this plan** — it cannot force a prompt on
`requiresUserInteraction` until the flag survives the projection.

## Before you start: re-verify

Done by the planning session on 2026-07-25 against HEAD `fa01deb8`. Re-run only if
HEAD has moved past that. **One audit imprecision found and corrected — read it
before Task 2.**

- [x] `mcp-pool.ts:369` `private failedConnections = new Set<string>()`, added at
  `:812`, `:1056`, `:1100`, `:1119`, `:1132`, `:1547` and consulted at `:1261`,
  `:1264`, `:1301`, `:1543`. There is no retry, no backoff and no timer anywhere on
  that path: once a connection key is in the set, the only exits are an explicit
  `delete` on a later successful connect or a pool teardown.
- [x] **The audit's "retain `_meta` and `annotations` on cached descriptors" is
  imprecise.** `tool-descriptor-store.ts:22-26` stores `tools: Tool[]` — whole MCP
  SDK `Tool` objects, so `annotations` and `_meta` already survive to disk and back.
  The loss is one layer down, in **both** projections, which rebuild a tool from two
  fields and drop everything else:
  - `mcp-pool.ts:501-509` — the proxy-tool entries feeding the catalog/manifest.
  - `mcp-pool.ts:1400-1408` — `getToolDefsAsJsonSchema`, the defs handed to the Pi
    subprocess.

  So Task 2 is "stop the projections truncating", not "make the cache remember".
- [x] `requiresUserInteraction` and `maxResultSizeChars` appear **nowhere** in
  `packages/` — zero occurrences including tests.
- [x] `sources/types.ts` carries no per-server `timeout`.
- [x] `alwaysLoad` appears nowhere in `packages/` (re-confirmed; it is also audit
  evidence note 11).

## Global Constraints

- **A retry must not widen access.** The DP-gated servers are withheld until
  `dpSessionState === 'ready'` (P1's Task 3). A reconnect must re-check the same
  gate, never resurrect a server whose authorization has since lapsed.
- **A retry must not stall a turn.** The connect deadline
  (`MCP_CONNECT_TIMEOUT_MS = 30_000`) and the concurrent connect from P1 exist
  because serial connects made a turn hang. Retries run **off** the turn's critical
  path or inside the existing deadline — never as additional serial latency before
  `servers.applied`.
- **`connectOnce` dedupe must survive.** P1 added in-flight dedupe because a probe
  proved four transports were opened for one server. A retry loop that bypasses it
  reintroduces the leak; there is a test for this — do not delete it.
- **Do not change `effectiveToolCatalogHash` inputs by accident.** The manifest is
  content-addressed; adding a field to the projection changes the hash and forces a
  Pi session recreation. That may be correct, but it must be a **deliberate,
  stated** decision with the baseline fixture re-pinned, not a surprise.
- **`getTools` stays a pure read.** P1 moved descriptor hydration into `sync` for
  exactly this reason: `effectiveToolCatalogHash` iterates `proxyTools` and reads
  `toolCache` directly, so mutating either from a read path corrupts the hash.
- One commit per task. No `Co-Authored-By` trailers.
- Gates: `bun run typecheck:shared`; `bun test packages/shared/src/mcp packages/shared/tests/mcp-pool.test.ts`.

## File Structure

| File | Responsibility |
| --- | --- |
| Modify `packages/shared/src/mcp/mcp-pool.ts` | Retry/backoff; carry metadata through both projections; per-server timeout; idle abort. |
| Modify `packages/shared/src/mcp/tool-descriptor-store.ts` | Only if a record shape change proves necessary — it should not. |
| Modify `packages/shared/src/sources/types.ts` | Per-server `timeout`, `alwaysLoad`. |
| Modify `packages/shared/src/mcp/__tests__/` | Per-behavior contract tests. |

---

### Task 1: A failed connection stops being a life sentence

**Files:**
- Modify: `packages/shared/src/mcp/mcp-pool.ts` (`failedConnections`, `connectOnce`, `reconcileUnion`)
- Test: `packages/shared/src/mcp/__tests__/` (the suite covering connect failures — find it with `rg -l failedConnections packages/shared/src/mcp/__tests__ packages/shared/tests`)

**Interfaces:**
- Consumes: nothing.
- Produces: `McpClientPoolOptions.retry?: { attempts: number; baseDelayMs: number }` — Tasks 2-6 do not depend on it.

- [x] **Step 1: Write the failing test**

```ts
  it('retries a failing initial connect a bounded number of times', async () => {
    let attempts = 0;
    const pool = poolWith(async () => { attempts += 1; throw new Error('502'); },
      { retry: { attempts: 3, baseDelayMs: 1 } });
    await pool.sync(desiredOneServer(), 'leaser');
    expect(attempts).toBe(3);
    expect(pool.health('leaser').failed).toContain('srv');
  });

  it('serves the server once a later attempt succeeds', async () => {
    let attempts = 0;
    const pool = poolWith(async () => {
      attempts += 1;
      if (attempts < 2) throw new Error('502');
      return fakeClient(['one']);
    }, { retry: { attempts: 3, baseDelayMs: 1 } });
    await pool.sync(desiredOneServer(), 'leaser');
    expect(pool.isConnected('srv', 'leaser')).toBe(true);
  });

  it('still opens exactly one transport per server across retries', async () => {
    // P1 added connectOnce because a probe showed four transports for one server.
    // A retry loop must not reintroduce that.
    const opened: string[] = [];
    const pool = poolWith(async () => { opened.push('t'); throw new Error('502'); },
      { retry: { attempts: 3, baseDelayMs: 1 } });
    await Promise.all([pool.sync(desiredOneServer(), 'a'), pool.sync(desiredOneServer(), 'b')]);
    expect(opened.length).toBe(3); // three attempts, not six
  });

  it('does not retry a server the DP gate is withholding', async () => {
    // P1's Task 3 invariant: a server whose authorization lapsed must not come back.
    const pool = poolWith(async () => fakeClient(['one']), { retry: { attempts: 3, baseDelayMs: 1 } });
    await pool.sync(desiredOneServer({ dpSessionState: 'needs-login' }), 'leaser');
    expect(pool.isConnected('srv', 'leaser')).toBe(false);
  });
```

`poolWith` / `desiredOneServer` / `fakeClient` are stand-ins — read the existing
suite and use its real harness. It already builds pools with injected connect
functions for the P1 tests; reuse that.

- [x] **Step 2: Run test to verify it fails**

Run: `bun test <that suite path>`
Expected: FAIL — one attempt, no retry.

- [x] **Step 3: Write minimal implementation**

Add the option, default it to a single attempt so existing behavior is unchanged
unless a caller opts in, and wrap the attempt inside `connectOnce` so the dedupe
still owns one in-flight promise per connection key:

```ts
  /**
   * Bounded initial-connect retry. Default is one attempt, so a caller that does
   * not opt in behaves exactly as before. The retry lives INSIDE `connectOnce`, so
   * concurrent leasers still share one in-flight attempt chain and one transport —
   * the leak `connectOnce` was added to close.
   */
  retry?: { attempts: number; baseDelayMs: number };
```

Delay between attempts is `baseDelayMs * 2 ** (attempt - 1)`, and the whole chain
stays inside the existing `MCP_CONNECT_TIMEOUT_MS` deadline — do not extend the
deadline to fit the retries, or a turn waits longer than P1 allowed.

For the DP case: the gate is applied where the desired set is built, before
`reconcileUnion` sees the server. Confirm that is still true and that no retry path
re-adds a filtered key; if the retry sits after the filter, the fourth test passes
without new code and you should say so rather than adding a redundant check.

- [x] **Step 4: Run test to verify it passes**

Run: `bun test <that suite path>`
Expected: 0 fail.

- [x] **Step 5: Mutation probe**

Move the retry loop outside `connectOnce` and confirm the transport-count test
fails. Revert. Then set the default to 3 attempts and confirm nothing else in the
suite changes — if something does, the default is not as inert as claimed and must
stay 1.

- [x] **Step 6: Prove no pool regression**

Run: `bun test packages/shared/src/mcp packages/shared/tests/mcp-pool.test.ts packages/shared/src/capabilities`
Expected: 0 fail.

- [x] **Step 7: Commit**

```bash
git add packages/shared/src/mcp
git commit -m "feat(mcp): retry a failing initial connect with bounded backoff"
```

---

### Task 2: Metadata survives the projection

**Files:**
- Modify: `packages/shared/src/mcp/mcp-pool.ts:501-509`, `:1400-1408`
- Test: `packages/shared/src/mcp/__tests__/proxy-tool-names.test.ts` and the descriptor-cache suite

**Interfaces:**
- Consumes: nothing.
- Produces: proxy-tool entries and `getToolDefsAsJsonSchema` defs both carry `annotations?: Tool['annotations']` and `_meta?: Tool['_meta']`. **P6 consumes these.**

This is the task P6 is blocked on. Both projections rebuild a tool from
`description` + `inputSchema`, so a server's `annotations.readOnlyHint`, its
`_meta`, and any vendor flag inside them are discarded before any consumer sees
them.

- [x] **Step 1: Write the failing test**

```ts
  it('carries annotations and _meta from the descriptor into the proxy entry', async () => {
    const pool = poolWith(async () => fakeClient([{
      name: 'write', description: 'w', inputSchema: { type: 'object' },
      annotations: { readOnlyHint: false, title: 'Write' },
      _meta: { 'io.modelcontextprotocol/requiresUserInteraction': true },
    }]));
    await pool.sync(desiredOneServer(), 'leaser');
    const entry = pool.getTools('leaser').find(t => t.proxyName.endsWith('__write'))!;
    expect(entry.annotations?.readOnlyHint).toBe(false);
    expect(entry._meta).toBeDefined();
  });

  it('carries them into the defs handed to the Pi subprocess', async () => {
    // getToolDefsAsJsonSchema is a second, independent projection — fixing only
    // the first would leave the subprocess blind.
    const pool = poolWith(async () => fakeClient([{
      name: 'write', description: 'w', inputSchema: { type: 'object' },
      annotations: { readOnlyHint: false },
    }]));
    await pool.sync(desiredOneServer(), 'leaser');
    const def = pool.getToolDefsAsJsonSchema('leaser').find(d => d.name.endsWith('__write'))!;
    expect(def.annotations?.readOnlyHint).toBe(false);
  });

  it('omits the keys entirely when the server sends none', async () => {
    // Absent, not `undefined` — the manifest is content-addressed and an explicit
    // undefined would change the hash for every server that ships no annotations.
    const pool = poolWith(async () => fakeClient(['plain']));
    await pool.sync(desiredOneServer(), 'leaser');
    const entry = pool.getTools('leaser')[0]!;
    expect('annotations' in entry).toBe(false);
    expect('_meta' in entry).toBe(false);
  });

  it('round-trips them through the durable descriptor cache', async () => {
    // The store already persists whole Tool objects; this pins that a hydrated
    // descriptor projects the same metadata as a live one.
    …build a pool with a tool-descriptor store, sync, then build a second pool
    over the same store directory with a connect fn that never succeeds, and assert
    the hydrated entry still carries annotations…
  });
```

- [x] **Step 2: Run test to verify it fails**

Run: `bun test packages/shared/src/mcp`
Expected: FAIL — every metadata assertion is `undefined`.

- [x] **Step 3: Write minimal implementation**

At both sites, spread the optional keys conditionally so an absent value stays
absent:

```ts
          ...(tool.annotations ? { annotations: tool.annotations } : {}),
          ...(tool._meta ? { _meta: tool._meta } : {}),
```

Widen the entry/def types to carry them. Keep the `$schema` strip and the
empty-schema fallback exactly as they are — both exist for AJV in the Pi agent.

- [x] **Step 4: Decide the hash question explicitly**

Adding fields to the projection **may** change `effectiveToolCatalogHash` and force
a Pi session recreation on first run after the upgrade. Determine which:

- If the hash reads only `proxyName`/`description`/`inputSchema`, nothing changes —
  say so in the commit body.
- If it hashes the whole entry, the hash changes for every server shipping
  annotations. That is acceptable **once**, but it must be stated in the commit body
  and the `pi-harness-baseline` fixture re-pinned in the same commit.

Do not "avoid" the question by excluding the fields from the projection the manifest
reads — that would defeat the task.

- [x] **Step 5: Run test to verify it passes**

Run: `bun test packages/shared/src/mcp packages/shared/tests/mcp-pool.test.ts packages/pi-agent-server/src`
Expected: 0 fail. The `pi-agent-server` path is included because it owns the
baseline fixture.

- [x] **Step 6: Commit**

```bash
git add packages/shared/src/mcp
git commit -m "fix(mcp): carry tool annotations and _meta through both projections"
```

---

### Task 3: Honour `maxResultSizeChars`

**Files:**
- Modify: `packages/shared/src/mcp/mcp-pool.ts` (`callTool`)
- Test: the `callTool` suite

**Interfaces:**
- Consumes: Task 2's metadata.
- Produces: nothing later tasks depend on.

With Task 2 the flag finally arrives. `requiresUserInteraction` is enforced by P6
(it needs the permission gate); `maxResultSizeChars` is ours to honour here, and it
composes with the existing large-result guard rather than replacing it.

- [x] **Step 1: Write the failing test**

```ts
  it('truncates a tool result past the server-declared maxResultSizeChars', async () => {
    const pool = poolWith(async () => fakeClientReturning('x'.repeat(5_000), {
      _meta: { maxResultSizeChars: 100 },
    }));
    await pool.sync(desiredOneServer(), 'leaser');
    const result = await pool.callTool('mcp__srv__big', {}, undefined, { leaserId: 'leaser' });
    expect(result.content!.length).toBeLessThanOrEqual(100 + TRUNCATION_NOTICE_MAX);
    expect(result.content).toContain('truncated');
  });

  it('leaves a result alone when the server declares no limit', async () => {
    const pool = poolWith(async () => fakeClientReturning('y'.repeat(5_000)));
    await pool.sync(desiredOneServer(), 'leaser');
    const result = await pool.callTool('mcp__srv__big', {}, undefined, { leaserId: 'leaser' });
    expect(result.content!.length).toBe(5_000);
  });
```

Read the docs for the exact `_meta` key before writing this — the key name above is
a guess and must be replaced with the documented one. Check
`https://code.claude.com/docs/en/mcp.md` and the MCP SDK typings. **If neither
documents it, stop and report**: implementing a guessed metadata key is worse than
leaving it unimplemented, and the audit item is only worth doing against a real
contract.

- [x] **Step 2-5: red, implement, green, commit**

Compose with the existing guard: whichever limit is smaller wins, and the notice
says which one applied. Commit:
`fix(mcp): honour a server-declared result size limit`.

---

### Task 4: Per-server timeout and an idle-progress abort

**Files:**
- Modify: `packages/shared/src/sources/types.ts`, `packages/shared/src/mcp/mcp-pool.ts`
- Test: the `callTool` suite

**Interfaces:**
- Consumes: nothing.
- Produces: `McpSourceConfig.timeoutMs?: number`.

Today a hung MCP call has no per-server ceiling. P1 measured a server that never
resolved and hung a turn indefinitely; the fix then was a connect deadline, and the
call path still has none.

- [x] **Step 1: Write the failing test**

```ts
  it('aborts a call that exceeds the per-server timeout', async () => {
    const pool = poolWith(async () => fakeClientHanging(), { });
    await pool.sync(desiredOneServer({ timeoutMs: 20 }), 'leaser');
    const result = await pool.callTool('mcp__srv__hang', {}, undefined, { leaserId: 'leaser' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('timed out');
  });

  it('resets the idle timer while the server reports progress', async () => {
    // A long call that is demonstrably alive must not be killed: MCP progress
    // notifications are the liveness signal.
    const pool = poolWith(async () => fakeClientWithProgress({ everyMs: 10, forMs: 60 }), {});
    await pool.sync(desiredOneServer({ timeoutMs: 30 }), 'leaser');
    const result = await pool.callTool('mcp__srv__slow', {}, undefined, { leaserId: 'leaser' });
    expect(result.isError).toBeFalsy();
  });
```

The second test is the load-bearing one: a plain timeout would kill a healthy long
call, which is why the audit specifies an **idle** abort rather than a deadline.
Verify the SDK surfaces progress notifications on the call path before implementing;
if it does not, implement the plain timeout, and say in the commit body that the
idle half is unimplemented and why.

- [x] **Step 2-5: red, implement, green, commit**

`feat(mcp): add a per-server call timeout with an idle-progress reset`.

---

### Task 5: `${VAR:-default}` expansion

**Files:**
- Modify: wherever MCP server env/args are resolved — locate it first with
  `codegraph explore "MCP server env resolution, where are config env values read before spawning a stdio server"`
- Test: the suite covering that resolver

**Interfaces:**
- Consumes: nothing.
- Produces: nothing.

- [x] **Step 1: Establish today's behavior before writing anything**

`AGENTS.md` records "bare `${VAR}` (unexpanded for `.mcp.json`)". Confirm exactly
which branch expands and which does not, and write it into this task before
implementing — a fix aimed at the wrong branch is a no-op that looks green.

**Established before any edit (executor, on `6ac79b66`):** there are exactly two
disjoint branches, and `AGENTS.md` names the right one.

| Branch | Where | Today |
| --- | --- | --- |
| Plugin / pinned-snapshot MCP | `mcp/runtime-pool-servers.ts` → `resolveRuntimeString` (was `:731`) | Expands `${VAR}` **only** — its regex was `/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g`, which `${VAR:-default}` does not match at all, so that form shipped as a literal token. An unset bare name became the **empty string** (`environment[name] ?? ''`). |
| Project `.mcp.json` / `mcp.json` | `mcp/project-config.ts` → `parseProjectMcpServer` | Expanded **nothing**. `command`, `args`, `env`, `url`, `headers` were copied verbatim. |

They cannot reach each other: `materializeSnapshotMcpServers` routes a
`.mcp.json`-sourced server through `parseMcpServersDocument` and `continue`s
before `resolveRuntimeString` is ever called. The documented contract (five
expansion locations, `${VAR:-default}`, warn-and-keep-the-token on an unset
reference) is about the second branch, so a fix confined to the first would have
been the exact no-op this step exists to prevent. Both were changed; the plugin
branch deliberately keeps empty substitution for a bare unresolvable `${VAR}`
because `materializePluginMcpEnvironment` reads the RESOLVED environment for its
`missingRequiredNames` gate, and a literal token there would make an unset
REQUIRED variable look satisfied.

- [x] **Step 2-6: red, implement, green, commit**

Support `${VAR}` and `${VAR:-default}`. An unset variable with no default must
produce a **diagnostic**, not an empty string silently substituted into a command
line — a blank auth header that yields a 401 is much harder to diagnose than a
refused start. Commit: `feat(mcp): expand ${VAR:-default} in server configuration`.

---

### Task 6: `alwaysLoad` parsing and candidate exclusion

**Files:**
- Modify: `packages/shared/src/sources/types.ts`, `packages/shared/src/plugins/format-adapters/claude.ts`, `packages/pi-agent-server/src/deferred-mcp-tools.ts`
- Test: the deferred-surface suite and the adapter suite

**Interfaces:**
- Consumes: nothing.
- Produces: nothing.

A core server cannot be pinned out of deferral today, so tool search can hide the
one server the session exists to use.

- [x] **Step 1: Write the failing test**

Assert that a server (and a per-tool entry) marked `alwaysLoad` is excluded from
`candidatePiNames` and stays in the registered tool set even when deferral is on.
Reuse P2's surface tests as the shape.

- [x] **Step 2-6: red, implement, green, commit**

`feat(mcp): honour alwaysLoad and exclude pinned tools from deferral`.

Note P2's contract while editing `deferred-mcp-tools.ts`: **the manifest decides
enablement**, and the surface must not re-derive it. Excluding candidates is fine;
re-introducing a local threshold check is not.

---

## Final Verification

- [x] `bun test packages/shared/src/mcp packages/shared/tests/mcp-pool.test.ts packages/shared/src/capabilities packages/shared/src/plugins packages/shared/src/agent packages/server-core/src packages/pi-agent-server/src`
- [x] `bun run typecheck:shared`; `cd packages/server-core && bun run typecheck`;
  `cd packages/pi-agent-server && bun run typecheck`; `bun run typecheck:electron`
- [x] `git diff --check`; `bun run electron:build`
- [x] Diff review: no retry resurrects a server the DP gate withholds; no retry
  opens a second transport; `getTools` is still a pure read; the catalog-hash
  decision from Task 2 Step 4 is stated in a commit body.

### Live verification

- [x] With a real MCP server, kill it mid-session and confirm the pool reconnects
  rather than reporting "nothing matched" for the rest of the session.
- [x] Confirm a plugin MCP server's tools still appear on the first turn (P2's
  descriptor-cache behavior must be intact).
- [x] Note: plugin install in this tree needs `NESSY_BUN` exported. Force the dark
  theme before any screenshot. If the environment cannot be brought up, report
  `blocked: <reason>` rather than claiming verification.

## Deliberately out of scope

- **Token-budget activation for tool search (≈10% of context) and an env
  override.** Audit evidence note 10 is explicit that flipping this needs a
  **measurement**, not an argument: on the pinned Pi `0.80.3`, mid-session
  `registerTool` invalidates the cached prompt prefix, so trading tool-definition
  tokens for cache misses may be a net loss and nobody has measured which. It also
  sits behind precondition P0U, whose target version is itself unverified. Stays
  unowned until that measurement exists.
- **Enforcing `requiresUserInteraction`.** Task 2 makes the flag reach consumers;
  forcing a prompt is P6's, because it needs the permission gate.
- **MCP user scope across all workspaces.** Belongs with the scopes/precedence work,
  not the pool.
- **MCP call auto-backgrounding** past a threshold — that is R10.

## Tracker

| # | Task | Status | Gate that proves it | Evidence |
| --- | --- | --- | --- | --- |
| 0 | Re-verify (done by the planner at `fa01deb8`) | **done** | 5 anchors; 1 audit imprecision corrected | HEAD moved to `6ac79b66`, docs-only (`git show --stat`), so all five code anchors still hold. Re-confirmed `requiresUserInteraction`/`maxResultSizeChars`/`alwaysLoad` absent from `packages/**/src` — they DO appear in vendored Pi SDK `dist/index.js`, where `timeout`/`alwaysLoad` are part of Pi's own MCP config schema. |
| 1 | Bounded connect retry with backoff | **done `1da90020`** | 4 tests pass; both probes re-fail | 6 tests, 16 assertions, 0 fail. Probe A (retry outside `connectOnce`): transport count 3 → 7 AND one-deadline test 278ms vs 160ms bound. Probe B (default 1 → 3): **NOT inert** — `packages/shared/tests/mcp-pool.test.ts:364` fails (expected 1 attempt, got 3), so the pool default stays 1 and production opts in at `defaultCreatePool`. Regression: 298 pass / 0 fail over `src/mcp` + `tests/mcp-pool.test.ts` + `src/capabilities`. |
| 2 | `annotations`/`_meta` survive both projections | **done `0a7ff0f5`** | 4 tests pass; hash decision stated | 4 new tests (3 red first: metadata `undefined`), 158 pass / 0 fail. Hash answer in the commit body: `effectiveToolCatalogHash` inputs widen **deliberately** (process-local change detection only, never persisted — a metadata-only change must now fire `emitToolsChanged`); the Pi **manifest** hash does NOT change because `pi-agent.ts` builds `PiDynamicToolDefinition` from an explicit field allowlist. `pi-harness-baseline` re-pinned `b41cc35a` → `5e5b5b03`; moved key = `poolProjection` (it digests `getProxyToolDefs` source text). No cascade. Third truncating projection found and fixed: `pool-server.ts` ListTools. |
| 3 | `maxResultSizeChars` honoured | **done `66289ae4`** (narrowed) | 2 tests pass, **or** reported blocked if the key is undocumented | Key IS documented, so not blocked — but it is `_meta["anthropic/maxResultSizeChars"]`, not the plan's guessed bare spelling, and its semantics are **inverted** vs the plan: it RAISES the persist-to-disk threshold, ceiling 500,000 chars, text only. MCP SDK 1.29.0 types `_meta` as `Record<string, unknown>` only, so the doc is the sole authority. Tests assert the documented direction: 200,000 declared → 120,000-char result inline; 2,000,000 declared → clamped, 600,000-char result still persisted. Fixture re-pinned `5e5b5b03` → `e2fbe47b`. |
| 4 | Per-server timeout + idle-progress reset | **done `4cc1a1ba`** (first half narrowed) | 2 tests pass; a live long call is not killed | Per-server timeout already existed as `SdkMcpServerConfig.toolTimeoutMs`, honoured in `callTool` and pinned by `mcp-pool-connect-on-demand.test.ts:196` — a second `timeoutMs` mechanism would have been a duplicate. Real gap was that only plugin servers could SET it; `McpSourceConfig.timeoutMs` and `.mcp.json`'s `timeout` now map onto it (sub-1000ms ignored per the docs). Idle half implemented: SDK 1.29.0 verified to expose `timeout` + `resetTimeoutOnProgress` + `onprogress`, and `Protocol._onprogress` → `_resetTimeout`. Both probes re-fail (drop `resetTimeoutOnProgress` → liveness test fails; drop `onprogress` → same, because no progressToken is attached). 4 idle tests + 5 config tests, 339 pass / 0 fail. Fixture re-pinned `e2fbe47b` → `1fd3f8d5`; the `toContain('{ signal }')` client-surface assertion was replaced with a strictly stronger one. |
| 5 | `${VAR:-default}` expansion | **done `ebe1e7fa`** | today's behavior written down first, then red/green | Behavior established before any edit and recorded in the commit body + test header: **plugin/snapshot branch** (`runtime-pool-servers.ts:resolveRuntimeString`) expanded bare `${VAR}` only and substituted the EMPTY STRING when unset; **`.mcp.json` branch** (`project-config.ts`) expanded NOTHING at all — the branch `AGENTS.md` names, and the one the documented contract is about. Both fixed via one leaf helper; `.mcp.json` warns and keeps the literal token, the plugin branch keeps empty substitution because `materializePluginMcpEnvironment` reads the RESOLVED env for its required-name gate. Each branch independently pinned: full revert → 3 fail, reverting only `resolveRuntimeString` → exactly 1 fail. 352 pass / 0 fail. |
| 6 | `alwaysLoad` exclusion | **done `71a0959b`** | pinned server stays registered under deferral | Both documented forms: server-level config and per-tool `_meta["anthropic/alwaysLoad"] === true`. Full chain wired (`McpSourceConfig`, `.mcp.json`, Claude adapter → schema → types → resolver → runtime-pool-servers, `SdkMcpServerConfig`, `alwaysLoadProxyToolNames`, `PiDynamicToolDefinition`, manifest). P2 honoured: `deferred-mcp-tools.ts` gained no `alwaysLoad` logic and no threshold check — it reads `manifest.deferredMcp.candidatePiNames`. Claude-adapter hop probe-verified (removing the spread fails its test). 2356 pass / 0 fail across `src/mcp`+`sources`+`plugins`+`capabilities`+`agent`; 398 pass / 0 fail for `pi-agent-server`+`server-core/src/mcp`. Fixture re-pinned `1fd3f8d5` → `4f955846`. |
| — | Final Verification | **done** | full list above | `bun test` over the plan's seven paths: **3296 pass, 4 skip, 0 fail** (348 files, 19896 assertions). Four typechecks clean (`typecheck:shared`, `server-core`, `pi-agent-server`, `typecheck:electron`). `git diff --check` clean. `bun run electron:build` ✓ built in 21.04s + resources copied. `bun run lint`: 0 errors (4 pre-existing warnings in untouched files). Diff review: retry sits after the DP filter and never re-adds a filtered key; retry lives inside `connectOnce` and `expired()` stops an abandoned chain; `getTools` unchanged and `alwaysLoadProxyToolNames`/`declaredResultSizeChars` are pure reads; hash decision stated in `0a7ff0f5`. |
| — | Live verification | **done** | 3 checks | Real stdio MCP subprocess, isolated `NESSY_CONFIG_DIR`, cleaned up. (1) Server refused its first two launches; pool logged `Retrying connect for live in 250ms (attempt 2/3)` then `in 500ms (attempt 3/3)`, launched 3×, connected, `failed=[]`, call returned `pong:<pid>` — one transient failure is no longer a life sentence. (2) `SIGKILL` mid-session: `Connection closed unexpectedly`, `health.failed=["live"]`, then the next turn's re-sync reconnected (new pid) and the call succeeded. Caveat below. (3) With the executable deleted, a fresh pool's first sync reported `connected=false failed=["copied"]` yet still advertised `mcp__copied__ping` **with** `annotations` and `_meta` from the durable store — P2 intact and metadata round-trips. `NESSY_BUN` not needed: no plugin install was involved, and no screenshot was taken. |

Status values: `not started` / `in progress` / `blocked: <why>` / `done <commit>`.

**Delivered vs. the Architecture sentence.** The architecture promised "a bounded
initial retry **and a backoff reconnect**". Task 1's steps, tests and gate only
cover the INITIAL connect, and that is what shipped. There is still no
timer-driven reconnect: `handleUnexpectedConnectionClose` adds the key to
`failedConnections` and deletes its proxy routes, so while a server is down
`callTool` answers `Unknown MCP proxy tool` and recovery waits for the next
turn's reconcile (which pre-dates this plan, and each of its attempts is now a
bounded 3-attempt chain). Autonomous mid-session reconnection with backoff —
Claude documents 5 attempts, 1s doubling, HTTP/SSE only — remains unowned.

**Stop conditions.** Halt and report rather than working around:

- A test shows a server reconnecting while its DP authorization is `needs-login`.
- The transport-count probe cannot be made to pass without bypassing `connectOnce`.
- Task 3's `_meta` key turns out to be undocumented in both Claude's MCP page and
  the MCP SDK typings. Report; do not implement a guessed key.
- Task 2's hash change cascades beyond re-pinning one baseline fixture.
