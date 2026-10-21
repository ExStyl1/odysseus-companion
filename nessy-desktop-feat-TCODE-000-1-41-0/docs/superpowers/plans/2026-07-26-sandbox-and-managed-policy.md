> **CLOSED — do not execute.** Landed as `5802cf58`, `06d6cb73`, `ab0d61ab`,
> `174274be`, `7bb75452`, `0cca325b`, `d12241b4`. All five tasks shipped TDD and all
> six diff-review invariants held. **This plan was corrected mid-flight**: it omitted
> `allowUnsandboxedCommands`, the enterprise lock that disables the escape hatch
> entirely, and the executor then found a hole the correction implied but did not
> name — a user could re-open strict mode by adding their own `excludedCommands`, so
> the floor became the tighter side of **every** key. Two managed-policy keys were
> renamed or declined for good reasons; see the audit row. Retained for the
> end-of-series review. Evidence in
> `docs/superpowers/specs/2026-07-25-nessy-claude-parity-audit.md` §0, row P10.

# Sandbox Settings and Managed Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An admin can require, tighten and audit isolation; a connected MCP server can no longer push text into a live turn unasked; and a sandbox that cannot start says what to do about it instead of throwing a colon-delimited string.

**Architecture:** Four independent surfaces on one subsystem, ordered so the security
gate lands before anything that could relax it. The channel gate comes first because
the only reason the "event arrives while you are away" case does not leak today is a
liveness check that a later feature will want to remove. Then the isolation-unavailable
surface, which is diagnosis rather than policy. Then the settings schema. Then the
managed-policy extension, which composes the earlier three under admin control.

**Tech Stack:** TypeScript, Bun test runner. Packages: `@nessy-agent/shared`
(`src/agent/pi-harness`, `src/config`, `src/mcp`), `@nessy-agent/server-core`
(`src/sessions`, `src/pi-harness`), `apps/electron` (Settings surface).

Covers audit shortlist item 12 (§0 row P10) and the §1 rows
`Sandbox configuration surface`, `Sandbox escape hatch and availability` and
`Channel push security`. **This is the last plan from the audit's §5 shortlist** — R1 through R12 each still close a §1 parity row, so it is not the last parity plan. Full research
with anchors is in `§5b` of
`docs/superpowers/specs/2026-07-25-nessy-claude-parity-audit.md` — read it first; it
contains nine corrections to the audit's own row text.

## Before you start: re-verify

Researched read-only on 2026-07-26 (`§5b`); the four starred facts below were
**re-checked at HEAD `74f5fb44`**, after `PX` changed the isolation code.

- [x] ⭐ **The credential-deny half of item 12 is already done.** `PX` shipped
  `credentialDenyRoots(homeDir, configDir)`
  (`session-tools-core/src/runtime/credential-deny-roots.ts:38`, exported at
  `src/index.ts:141`) and seeded **both** call sites —
  `handlers/script-sandbox.ts:83` and `server-core/.../SessionManager.ts:27`. Do not
  re-do it, and do not make the list settings-overridable here without reading Task 3's
  constraint on that.
- [x] ⭐ **No channel gate exists.** `channelsEnabled` and `allowedChannelPlugins`
  have zero occurrences. The handler is installed for **every** pooled connection
  (`shared/src/mcp/mcp-pool.ts:804-806`, `channelServer` set unconditionally at `:868`),
  dispatch at `:828-851` guards only identity and liveness, and it reaches
  `agent.redirect(text)` via `SessionManager.ts:2026-2030`.
- [x] ⭐ **`ManagedPiPolicyV1` accepts exactly eight keys** — `schemaVersion`,
  `disabledPermissionModes`, `permissionDsl`, `allowedPluginKeys`, `deniedPluginKeys`,
  `allowedMcpServers`, `deniedMcpServers`, `allowPluginHooks`
  (`shared/src/agent/pi-harness/managed-policy.ts:20-29`), enforced strict-key by
  `exact()` at `:40-43`. `DISABLEABLE_MODES` (`:30`) deliberately omits `safe` and
  `plan`.
- [x] ⭐ **The loader is fail-closed and aborts startup.** Every non-`ENOENT`
  problem becomes `managed-pi-policy-invalid`
  (`server-core/src/pi-harness/managed-policy-loader.ts:31-33`, `:103-104`), and
  `loadManagedPiPolicy()` is called **unguarded** at
  `bootstrap/storage-runtime.ts:162`. Its host-ownership checks are the whole trust
  story: root-owned, no group/other write, no symlink on file or parent, `realpath`
  identity, `O_NOFOLLOW`, an `fstat` TOCTOU re-check, 256 KiB cap (`:50-101`).
  **Known hole: `:55` returns early on win32, so Windows gets no owner or mode check.**
- [x] **No `sandbox` settings surface of any kind.** Profiles are compile-time
  literals: `'none' | 'read-only' | 'workspace' | 'networked' | 'plugin-mcp' | 'isolated-code'`
  (`shared/src/agent/pi-harness/process-supervisor-port.ts:3`), selected by hardcoded
  literal at every call site.
- [x] **`process-isolation-unavailable` always throws**, from seven sites, with a
  structured `…:<platform>:<profile>[:<reason>]` message but **no remediation text and
  no escape hatch**. `failIfUnavailable`, `dangerouslyDisableSandbox` and
  `excludedCommands` are confirmed absent repo-wide. `isolated-code` throws
  **unconditionally on every platform** (`server-core/src/pi-harness/isolation.ts:70-72`).
- [x] **All three platforms have a working backend**, including a 232-line win32 Codex
  restricted-token implementation with a sha256-pinned toolchain. **There is no startup
  capability probe** — only lazy per-use `spawnSync` probes, and on win32 a binding
  resolution that returns `undefined` **silently**
  (`shared/src/agent/backend/internal/runtime-resolver.ts:145-175`).

## Global Constraints

- **Extend `ManagedPiPolicyV1`; never create a second policy module.** Evidence note 4
  exists because two auditors proposed exactly that. A new key means adding it to
  `POLICY_KEYS` **and** a validator, and the strict-key `exact()` must keep rejecting
  anything unlisted.
- **Do not add a permissive `catch` to the loader.** It aborts startup on a malformed
  policy on purpose. A new key must not be made "optional" by softening that.
- **`safe` and `plan` must remain undisableable** (`DISABLEABLE_MODES`).
- **The IPC profile allowlist must stay narrower than the type.** `pi-agent.ts:3749`
  validates a profile arriving from the subprocess against four values and deliberately
  omits `plugin-mcp`, which grants network and is host-selected only. Widening the
  settings surface must not widen that.
- **Isolation fails closed everywhere today.** If Task 5 adds an escape hatch, the
  fail-closed default must survive: no silent downgrade, an explicit per-invocation
  decision, and the downgrade recorded on the execution receipt. Note
  `tool-executor.ts:203` already falls back to the string `'no-host-isolation'` — an
  escape hatch must not be able to hide behind that marker.
- **No profile is a read boundary.** Every backend grants ambient whole-filesystem
  read; the profile axis is write scope only, which the backend strings state literally.
  A `sandbox.filesystem` schema must **not** be documented as a read boundary unless it
  flips that default-allow posture.
- **The channel gate lands before any liveness relaxation.** Today a push is dropped
  when no turn is in flight (`SessionManager.ts:1999-2004`). That drop is the only thing
  making the current no-gate state survivable. Do not touch it in this plan.
- One commit per task. No `Co-Authored-By` trailers.
- Gates: `bun run typecheck:all`; `bun run lint:i18n:parity`; `bun run lint:i18n:sorted`.
- **Never pass `-r` to `rg`** — it parses as `--replace` and silently rewrites every
  match. Four agents have lost time to this.

## File Structure

| File | Responsibility |
| --- | --- |
| Create `packages/shared/src/config/sandbox-settings.ts` | The `sandbox` schema, prefix resolution, merge. |
| Modify `packages/shared/src/mcp/mcp-pool.ts:804-868` | Channel handler installed only for permitted sources. |
| Modify `packages/server-core/src/sessions/SessionManager.ts` | Channel policy read; capability probe; profile resolution. |
| Modify `packages/server-core/src/pi-harness/isolation.ts` | Remediation text on the unavailable error. |
| Modify `packages/shared/src/agent/pi-harness/managed-policy.ts` | New keys + validators. |
| Modify `apps/electron` Settings + both locale files | Probe result and channel switch. |

---

### Task 1: A connected MCP server cannot push into a turn unasked

**Files:**
- Modify: `packages/shared/src/mcp/mcp-pool.ts:804-806`, `:828-851`, `:868`
- Modify: `packages/server-core/src/sessions/SessionManager.ts:2026-2030`
- Modify: `packages/shared/src/i18n/locales/{en,ru}.json`
- Test: the mcp-pool channel suite and the SessionManager channel suite

**Interfaces:**
- Consumes: nothing.
- Produces: `ChannelPolicy` — `{ enabled: boolean; allowedSources: readonly string[] }`. Task 4 puts this under managed control; name it once here.

- [ ] **Step 1: Write the failing test**

```ts
  it('does not install a channel handler for a source that is not permitted', async () => {
    const pool = poolWith(fakeClient(['one']), { channelPolicy: { enabled: true, allowedSources: ['allowed'] } });
    await pool.sync(desired([{ slug: 'notallowed' }]), 'leaser');
    expect(pool.hasChannelHandler('notallowed')).toBe(false);
  });

  it('installs it for a permitted source', async () => {
    const pool = poolWith(fakeClient(['one']), { channelPolicy: { enabled: true, allowedSources: ['allowed'] } });
    await pool.sync(desired([{ slug: 'allowed' }]), 'leaser');
    expect(pool.hasChannelHandler('allowed')).toBe(true);
  });

  it('installs none at all when the master switch is off', async () => {
    const pool = poolWith(fakeClient(['one']), { channelPolicy: { enabled: false, allowedSources: ['allowed'] } });
    await pool.sync(desired([{ slug: 'allowed' }]), 'leaser');
    expect(pool.hasChannelHandler('allowed')).toBe(false);
  });

  it('drops a push from a source that lost permission mid-session', async () => {
    // Re-arming happens per capability generation; a policy change must take effect
    // on the next generation rather than leaving a live handler behind.
    const pool = poolWith(fakeClient(['one']), { channelPolicy: { enabled: true, allowedSources: ['allowed'] } });
    await pool.sync(desired([{ slug: 'allowed' }]), 'leaser');
    pool.setChannelPolicy({ enabled: true, allowedSources: [] });
    await pool.sync(desired([{ slug: 'allowed' }]), 'leaser');
    expect(pool.hasChannelHandler('allowed')).toBe(false);
  });

  it('still drops a push when no turn is in flight', async () => {
    // Pre-existing invariant (SessionManager.ts:1999-2004). This plan must not
    // change it, and this test is here to prove the gate did not disturb it.
    expect(await deliverWithNoTurnInFlight()).toBe(false);
  });
```

`hasChannelHandler` may not exist — if the suite has no way to observe handler
installation, add the narrowest possible accessor rather than asserting on a private
map, and say so in the commit body.

**Default:** decide and state it. `enabled: false` is the safe default and matches
"opt-in" in the audit row; `enabled: true` with an empty allowlist is equivalent in
effect but reads differently in a config file. Pick one, justify it in the commit body,
and make sure a workspace with no channel config behaves as the safe case.

- [ ] **Step 2: Run test to verify it fails**

Expected: FAIL — the handler is installed unconditionally for every connection.

- [ ] **Step 3: Write minimal implementation**

Gate at **installation**, not at dispatch. A handler that exists but discards is a
weaker guarantee than one that was never registered, and the audit's own framing is
"any connected MCP server *can* push".

Keep the existing identity and liveness guards at `:837-842` exactly as they are.

- [ ] **Step 4-7: green, i18n, no regression, commit**

Run: `bun test packages/shared/src/mcp packages/server-core/src/sessions`
```bash
git commit -m "feat(mcp): gate channel push behind a per-source policy"
```

---

### Task 2: An isolation failure says what to do

**Files:**
- Modify: `packages/server-core/src/pi-harness/isolation.ts:70-111`, and the
  per-platform throw sites (`isolation/darwin.ts:24`, `linux.ts:21`, `:33`,
  `windows.ts:196`, `:200`)
- Create: a startup capability probe — the audit suggests
  `packages/server-core/src/pi-harness/isolation-capabilities.ts`
- Modify: `apps/electron` Settings + both locale files
- Test: the isolation suite

**Interfaces:**
- Consumes: nothing.
- Produces: `probeIsolationCapabilities(): IsolationCapabilityReport` — Task 3 may surface it, Task 4 does not depend on it.

- [ ] **Step 1: Write the failing test**

```ts
  it('names the remediation for each unavailable reason', () => {
    // The message is already structured; what is missing is what to do about it.
    for (const [reason, hint] of [
      ['darwin', /sandbox-exec/],
      ['linux:network', /bwrap|firejail|unshare/],
      ['win32:runtime', /toolchain/],
    ] as const) {
      expect(() => resolveWith(reason)).toThrow(hint);
    }
  });

  it('keeps the structured prefix so existing parsers still work', () => {
    expect(() => resolveWith('darwin')).toThrow(/^process-isolation-unavailable:darwin:/);
  });

  it('reports per-profile availability without spawning a turn', async () => {
    const report = await probeIsolationCapabilities();
    expect(report.platform).toBe(process.platform);
    expect(Object.keys(report.profiles)).toContain('workspace');
  });

  it('reports isolated-code as unavailable on every platform', async () => {
    // It throws unconditionally at isolation.ts:70-72 — the probe must say so rather
    // than implying a platform difference.
    const report = await probeIsolationCapabilities();
    expect(report.profiles['isolated-code']).toMatchObject({ available: false });
  });
```

The second test matters: the structured prefix is what any existing log parser or test
matches on. Append remediation, do not restructure.

- [ ] **Step 2-6: red, implement, green, i18n, commit**

The probe must be cheap enough to run at startup and must not itself throw — an
unavailable backend is a **report**, not an error, at probe time. Surface it read-only
in Settings; do not add a control that changes profiles in this task.

```bash
git commit -m "feat(isolation): report capability at startup and name the remediation"
```

---

### Task 3: A `sandbox` settings schema

**Files:**
- Create: `packages/shared/src/config/sandbox-settings.ts`
- Modify: the profile resolution call site (`process-supervisor.ts:116-130`)
- Test: a new suite beside the module

**Interfaces:**
- Consumes: nothing.
- Produces: `resolveSandboxSettings(layers)` and `SandboxSettingsV1`. Task 4 puts the same shape under managed control.

- [ ] **Step 1: Write the failing test**

```ts
  it('merges list keys by concat-and-dedupe, most-specific last', () => {
    const resolved = resolveSandboxSettings([
      { excludedCommands: ['docker *'] },
      { excludedCommands: ['go *', 'docker *'] },
    ]);
    expect(resolved.excludedCommands).toEqual(['docker *', 'go *']);
  });

  it('refuses a filesystem entry that is relative or a filesystem root', () => {
    // Same two refusals canonicalDeniedReadRoot already enforces. A settings surface
    // must not become a way around them.
    expect(() => resolveSandboxSettings([{ deniedReadRoots: ['relative/x'] }])).toThrow();
    expect(() => resolveSandboxSettings([{ deniedReadRoots: ['/'] }])).toThrow();
  });

  it('cannot remove a credential deny that PX seeded', () => {
    // The seeded list is a floor, not a default. A user setting may add to it and
    // must not be able to subtract from it.
    const resolved = resolveSandboxSettings([{ deniedReadRoots: [] }], { floor: credentialDenyRoots('/home/x', '/home/x/.nessy-agent') });
    expect(resolved.deniedReadRoots).toEqual(expect.arrayContaining([expect.stringContaining('.ssh')]));
  });

  it('rejects an unknown key rather than ignoring it', () => {
    expect(() => resolveSandboxSettings([{ nope: true } as never])).toThrow();
  });
```

The third test is the load-bearing one and encodes the constraint the plan states: the
credential denies `PX` seeded are a **floor**. A settings surface that can subtract
from them re-opens the exposure `PX` closed.

- [ ] **Step 2: Decide and document the read posture**

Before writing any doc comment: no profile restricts reads today. If this schema has a
`filesystem` section, its comment must say it scopes **writes** plus an explicit deny
list, and must not imply a read boundary. Getting this wrong in a comment is how the
next reader ships a false guarantee.

- [ ] **Step 3-6: red, implement, green, commit**

```bash
git commit -m "feat(config): add a sandbox settings schema with a deny floor"
```

---

### Task 4: Extend the managed policy — same module, strict keys

**Files:**
- Modify: `packages/shared/src/agent/pi-harness/managed-policy.ts:20-43`
- Modify: `packages/server-core/src/pi-harness/managed-policy-loader.ts` only if a new
  key needs a bound the loader enforces
- Test: `managed-policy.test.ts`

**Interfaces:**
- Consumes: Task 1's `ChannelPolicy`, Task 3's `SandboxSettingsV1`.
- Produces: nothing.

- [ ] **Step 1: Write the failing test**

```ts
  it('accepts the new admin keys', () => {
    const policy = parseManagedPiPolicy({
      schemaVersion: 1,
      channelsEnabled: false,
      allowedChannelPlugins: ['vendor.plugin'],
      sandbox: { excludedCommands: ['docker *'] },
    });
    expect(policy.channelsEnabled).toBe(false);
  });

  it('still rejects an unknown key', () => {
    expect(() => parseManagedPiPolicy({ schemaVersion: 1, nope: true })).toThrow(/invalid managed Pi policy/);
  });

  it('still refuses to disable safe or plan', () => {
    expect(() => parseManagedPiPolicy({ schemaVersion: 1, disabledPermissionModes: ['safe'] })).toThrow();
  });

  it('lets a managed channel switch override a permissive workspace setting', () => {
    // Deny is terminal: the three existing helpers already work this way.
    expect(isChannelAllowed({ managed: { channelsEnabled: false }, workspace: { enabled: true } })).toBe(false);
  });
```

Add only the keys you can validate and that something reads. A key in `POLICY_KEYS`
with no consumer is worse than no key — it looks like a control and is not one. If you
add fewer than the audit lists, say which and why.

- [ ] **Step 2-6: red, implement, green, full suite, commit**

```bash
git commit -m "feat(policy): extend the managed policy with channel and sandbox keys"
```

---

### Task 5: An escape hatch that cannot hide

**Files:**
- Modify: `packages/server-core/src/pi-harness/process-supervisor.ts:116-130`
- Modify: the bash tool parameter surface
- Test: the supervisor suite

**Interfaces:**
- Consumes: Task 3's `excludedCommands`.
- Produces: nothing.

> **This task loosens enforcement. Read before editing.** Isolation fails closed
> everywhere today, and that is a property worth keeping by default. The audit asks for
> `excludedCommands` and `dangerouslyDisableSandbox` because sandbox-incompatible
> commands (docker, some Go tooling, watchman) fail permanently with no supported
> workaround. Both must be explicit, per-invocation, and **recorded**.

- [ ] **Step 1: Write the failing test**

```ts
  it('runs an excluded command without isolation and records the downgrade', async () => {
    const receipt = await runSupervised({ command: 'docker ps', excludedCommands: ['docker *'] });
    expect(receipt.isolationProfile).toBe('excluded-by-policy');
    expect(receipt.isolationDowngrade).toMatchObject({ reason: 'excludedCommands', pattern: 'docker *' });
  });

  it('does not let the downgrade hide behind the existing no-host-isolation marker', () => {
    // tool-executor.ts:203 already falls back to 'no-host-isolation'. A policy
    // downgrade must be distinguishable from that fallback, or an audit cannot tell
    // an intentional exclusion from a missing backend.
    expect(receiptFor('excluded')).not.toMatchObject({ isolationProfile: 'no-host-isolation' });
  });

  it('requires an explicit decision for dangerouslyDisableSandbox', async () => {
    await expect(runSupervised({ command: 'x', dangerouslyDisableSandbox: true, decision: undefined }))
      .rejects.toThrow();
  });

  it('keeps failing closed for a command that matches nothing', async () => {
    await expect(runSupervised({ command: 'x', excludedCommands: ['docker *'], isolationUnavailable: true }))
      .rejects.toThrow('process-isolation-unavailable');
  });
```

The second and fourth tests are why this task is safe to do at all.

- [ ] **Step 2-6: red, implement, green, full suite, commit**

```bash
git commit -m "feat(isolation): add a recorded escape hatch for excluded commands"
```

---

## Final Verification

- [ ] `bun test packages/shared/src packages/server-core/src packages/session-tools-core/src packages/pi-agent-server/src`
- [ ] `bun run typecheck:all`
- [ ] `bun run lint:i18n:parity`; `bun run lint:i18n:sorted`; `git diff --check`
- [ ] `bun run electron:build`
- [ ] Diff review, specifically: `exact()` still rejects unknown policy keys; the loader
  has no new permissive `catch`; `safe`/`plan` are still undisableable; the IPC profile
  allowlist is still narrower than the type and still omits `plugin-mcp`; the credential
  deny floor cannot be subtracted from; no profile comment claims to bound reads; the
  no-turn-in-flight channel drop is untouched.

### Live verification

- [ ] Confirm an MCP server that is not permitted cannot push into a turn, and that a
  permitted one still can.
- [ ] Confirm the startup probe reports each profile, and that its report matches what
  actually happens when a command runs under that profile.
- [ ] Confirm an excluded command runs and its receipt records the downgrade
  distinguishably from a missing backend.
- [ ] Authorized connections: `pi-api-key` (`pi_compat`) and `nessy-cloud-agent`. The
  Claude and Codex runtimes are flag-off — do not create a connection or enter a
  credential. Note the constraint that blocked three previous plans: the Pi-capable
  connection fills its JWT behind an Electron IPC handler the headless runner cannot
  reach. Verify through the production code path where a model turn is not reachable,
  and report the rest as `blocked: <reason>`.

## Deliberately out of scope

- **Egress proxy and domain policy** (HTTP CONNECT + SOCKS5 per session, wildcard
  allow/deny, first-use approval, `mask` mode). That is a new subsystem, not a settings
  key, and it is the whole of the `Sandbox network policy` row. Its own plan.
- **Flipping the ambient-read posture.** Every backend grants whole-filesystem read
  today. Making reads restricted by default is a design change with a large blast
  radius; this plan only adds an explicit deny list on top.
- **Implementing `isolated-code`.** It throws unconditionally on every platform; Task 2
  makes the probe say so honestly. Implementing or formally retiring it is the B3 batch.
- **The win32 owner/mode hole** in the managed-policy loader (`:55`). Real, recorded in
  `§5b`, and a separate change — widening the policy surface on Windows widens that
  hole, so note it in Task 4's commit body but do not fix it here.

## Tracker

| # | Task | Status | Gate that proves it | Evidence |
| --- | --- | --- | --- | --- |
| 0 | Re-verify (planner, `74f5fb44`; see audit §5b) | **done** | 7 anchors, 4 re-checked after PX | audit §5b |
| 1 | Channel push gate | **done `5802cf58`** | 7 pool tests + 3 SessionManager tests; the no-turn drop still passes **(that drop was REPLACED 2026-08-07 by wave unit R57/f134 — a notification now wakes an idle session holding the lease; this row records the state at the time, not current behaviour)** | `bun test packages/shared/tests/mcp-pool.test.ts` → `37 pass 0 fail`; `bun test packages/server-core/src/sessions/__tests__/mcp-channel-gate.test.ts` → `3 pass 0 fail`. Red first: `TypeError: pool.hasChannelHandler is not a function` (7 fail), and after removing the one production wiring line `Expected: true Received: false` (2 fail). |
| 2 | Capability probe + remediation | **done `06d6cb73`** | 7 tests; structured prefix preserved at every real throw site | `bun test packages/server-core/src/pi-harness/` → `174 pass 0 fail`. Red first: `Cannot find module './isolation-capabilities.ts'`. |
| 3 | Sandbox settings schema | **done `ab0d61ab`** | 13 tests; deny floor cannot be subtracted | `bun test packages/shared/src/config/__tests__/sandbox-settings.test.ts` → `13 pass 0 fail`. Red first: `Cannot find module '../sandbox-settings.ts'`. |
| 4 | Managed policy extension | **done `174274be`** | 7 policy tests + 8 floor/parser tests + 5 consumer tests; `exact()` still rejects unknowns | `bun test packages/shared/src/config/__tests__/sandbox-settings.test.ts packages/shared/src/agent/pi-harness/managed-policy.test.ts` → `32 pass 0 fail`; `bun test .../managed-sandbox-and-channel.test.ts` → `5 pass 0 fail`. Red first: `SyntaxError: Export named 'isManagedChannelServerAllowed' not found`. |
| 5 | Recorded escape hatch | **done `7bb75452`** | 8 tests; still fails closed by default | `bun test packages/server-core/src/pi-harness/process-supervisor-escape-hatch.test.ts` → `8 pass 0 fail`. Red first: `6 fail` — `Expected: "excluded-by-policy" Received: "workspace:stub-backend"`, `Expected promise that rejects / Received promise that resolved`; the 2 fail-closed tests passed from the start, as they should. |
| — | Final Verification | **done** | full list above | `bun test packages/shared/src packages/server-core/src packages/session-tools-core/src packages/pi-agent-server/src` → `5318 pass 7 skip 0 fail` (526 files); `bun run typecheck:all` exit 0; `bun run lint` `0 errors, 4 warnings` (all pre-existing unused-disable warnings); `bun run lint:i18n:parity` → `i18n parity OK (1 locales, 1980 keys each)`; `bun run lint:i18n:sorted` exit 0; `git diff --check` clean; `bun run electron:build` → `✓ built in 20.81s`, resources copied, exit 0. One extra commit `0cca325b` fixes a pre-existing pool fake that the full-suite run surfaced. |
| — | Live verification | **done (model turn blocked)** | production path: real probe, real resolver, real supervisor, real pool | darwin: probe reports `read-only`/`workspace`/`networked`/`plugin-mcp` available on `sandbox-exec`, `isolated-code` unavailable (`declared-input-read-boundary`). A real `workspace` run recorded `workspace:sandbox-exec:host-read:write-workspace+scratch` — byte-identical to the probe's backend string. Excluded command ran (`excluded-run-ok`) with `isolationProfile: excluded-by-policy` and `isolationDowngrade {reason:'excludedCommands',pattern:'/bin/sh -c echo excluded-run-ok'}`, distinct from `no-host-isolation`; a non-matching command under the same config stayed isolated. Strict mode refused with `process-isolation-unsandboxed-commands-disallowed`. A real sandboxed `ls $HOME/.ssh` under the seeded deny printed `DENIED`. Pool: default closed (0 delivered), unpermitted source blocked, permitted source delivered `{"server":"allowed","text":"permitted"}`. `blocked: a real model turn is unreachable headlessly — the Pi-capable connection fills its JWT behind an Electron IPC handler the headless runner cannot reach.` |

Status values: `not started` / `in progress` / `blocked: <why>` / `done <commit>`.

**Stop conditions.** Halt and report rather than working around:

- A task needs a second policy module, or a permissive `catch` in the loader.
- The credential deny floor can be subtracted from by any settings layer.
- The escape hatch cannot be made distinguishable from the existing
  `no-host-isolation` fallback.
- Gating the channel at installation turns out to be impossible without touching the
  no-turn-in-flight drop.
