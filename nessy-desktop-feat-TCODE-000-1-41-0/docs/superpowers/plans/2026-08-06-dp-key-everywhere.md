# One dp Key Everywhere Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The system `dp` CLI's own session key works — and can refresh itself — from every place Nessy Desktop runs dp: the agent's sandboxed Bash, the built-in dp MCP servers, the plugin dp MCP servers, and the gateway auth flow.

**Architecture:** Extract the dp state-root/env knowledge that already exists on the plugin-MCP path into one shared `auth/dp` helper, then wire its three missing consumers: (1) the host sandbox grants write access to dp's state root so `dp` inside a seatbelt-sandboxed shell can refresh its hourly access token; (2) the built-in dp MCP servers get the same non-interactive env the plugin path already sets; (3) the built-in set is gated on a positive `needs-login` verdict from the existing dp session broker and rides the existing `provider: 'dp'` external-auth requirement, so the one-click sign-in row restores them after `dp auth login`.

**Tech Stack:** TypeScript, Bun test, seatbelt/`sandbox-exec` isolation (darwin), MCP SDK stdio transport.

## Owner decisions (2026-08-06, this plan's charter)

- **Use the system dp CLI from work laptops. Do NOT bundle or download dp** the way nessy-cli does (`~/.nessy/dp_latest`, pinned 13.14.1, md5). Desktop keeps `resolveDpBinary()` (PATH → `/usr/local/bin/dp`) as the single seam. nessy-cli's managed-download model is explicitly rejected for Desktop; its *env/runtime* practices (full env, `DP_WORKDIR`, non-interactive switches) are adopted.
- **Use dp's own key and let dp refresh it itself.** dp's access token lives ~1 hour (`~/.dp/access_token.json`, refresh token ~30 days); refresh is a WRITE into the state root. Every Desktop surface that runs dp must allow that write.
- **Built-in dp servers are withheld only on a positive `needs-login`** verdict, never on `unavailable` (the non-Pi session preflight hardcodes `unavailable`, and transient probe failures report it — both must not evict working servers).
- **The sandbox write grant is host-owned** (appended after settings resolution, immune to managed-floor grant caps, like the credential deny floor is host-owned) and **existsSync-gated** (no `~/.dp` is created for users who never ran dp; a mid-session first dp install takes effect on restart).
- Non-goals: dp version-floor *enforcement* (stays warn-only per 00-context decision 5), OAuth-style per-server sign-in for built-ins, any writer of `~/.nessy/dp_auth_creds.json` outside `auth/dp` (contract unchanged).

## Global Constraints

- Token values (dp token or gateway JWT) NEVER appear in logs, errors, statuses, env dumps, or this plan's test fixtures (packages/shared AGENTS.md contract).
- `~/.nessy/dp_auth_creds.json` stays read-only outside `packages/shared/src/auth/dp` (writer: `creds-store.ts` only).
- Empty-by-default invariant: a DEFAULT materialization of the built-in set stays `{}` (all `defaultEnabled: false`); nothing in this plan may make dp-carrying dev machines diverge from CI on unrelated assertions — inject seams (`resolveDpPath`, `runtimeEnv`, `dpStateRoot`) in every test that would otherwise read host state.
- Several source files carry NUL bytes: use `grep -a` / `rg -a` for every absence claim.
- `rm -rf release` before any repo-root `bun test`; never run two `bun test` processes concurrently; `bun run typecheck:all` does not cover `apps/cli`.
- Implementation-First Verification Budget applies: focused tests + affected-package typecheck per task; the full wave runs once at close-out.
- No `Co-Authored-By` trailers. One commit per task. Branch naming `<type>/TCODE-000` fallback applies.
- Seatbelt semantics this plan relies on (verified): profile floor is `(deny file-write*)` with subpath allows for workspaceRoot, scratch, and each `additionalWritableRoots` entry; deny rules are emitted AFTER allows, so denies always win (`packages/session-tools-core/src/runtime/filesystem-isolation.ts:152-191`; cf. Claude `sandboxing.md:176` for the deny-region model).

---

### Task 1: Shared dp runtime helper (`resolveDpStateRoot` / `dpRuntimeEnvironment`)

**Files:**
- Create: `packages/shared/src/auth/dp/dp-runtime.ts`
- Create: `packages/shared/src/auth/dp/__tests__/dp-runtime.test.ts`
- Modify: `packages/shared/src/auth/dp/index.ts` (exports, beside line 24)
- Modify: `packages/shared/src/agent/backend/internal/runtime-resolver.ts:280-306` (consume the helper)

**Interfaces:**
- Produces: `resolveDpStateRoot(env?: NodeJS.ProcessEnv, homeDir?: string): string | undefined` and `dpRuntimeEnvironment(stateRoot?: string | undefined): Record<string, string>` — Tasks 2 and 3 import both from `@nessy-agent/shared/auth/dp`.
- Constraint: helpers never throw, never create directories, never cache, never log paths beside token-bearing state. `auth/dp` must NOT import `agent/backend` types (dependency direction) — the plugin *binding assembly* stays in `runtime-resolver.ts`.

- [ ] **Step 1: Write the failing test**

`packages/shared/src/auth/dp/__tests__/dp-runtime.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { dpRuntimeEnvironment, resolveDpStateRoot } from '../dp-runtime.ts';

describe('resolveDpStateRoot', () => {
  test('DP_WORKDIR wins over the home default and is realpathed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dp-state-'));
    expect(resolveDpStateRoot({ DP_WORKDIR: ` ${dir} ` } as NodeJS.ProcessEnv, '/nonexistent-home'))
      .toBe(realpathSync(dir));
  });

  test('falls back to <home>/.dp only when it exists', () => {
    const home = mkdtempSync(join(tmpdir(), 'dp-home-'));
    expect(resolveDpStateRoot({} as NodeJS.ProcessEnv, home)).toBeUndefined();
    mkdirSync(join(home, '.dp'));
    expect(resolveDpStateRoot({} as NodeJS.ProcessEnv, home))
      .toBe(realpathSync(join(home, '.dp')));
  });

  test('refuses the filesystem root and the home directory itself', () => {
    expect(resolveDpStateRoot({ DP_WORKDIR: '/' } as NodeJS.ProcessEnv, '/nonexistent-home'))
      .toBeUndefined();
    const home = mkdtempSync(join(tmpdir(), 'dp-home-'));
    expect(resolveDpStateRoot({ DP_WORKDIR: home } as NodeJS.ProcessEnv, home)).toBeUndefined();
  });
});

describe('dpRuntimeEnvironment', () => {
  test('carries the non-interactive switches; DP_WORKDIR only with a root', () => {
    expect(dpRuntimeEnvironment(undefined)).toEqual({
      HOME: homedir(),
      DP_NO_WARNINGS: 'true',
      DP_AI_MCP_SKIP_LOGIN: 'true',
    });
    expect(dpRuntimeEnvironment('/x/y')).toEqual({
      HOME: homedir(),
      DP_NO_WARNINGS: 'true',
      DP_AI_MCP_SKIP_LOGIN: 'true',
      DP_WORKDIR: '/x/y',
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/shared/src/auth/dp/__tests__/dp-runtime.test.ts`
Expected: FAIL — `Cannot find module '../dp-runtime.ts'`

- [ ] **Step 3: Write the implementation**

`packages/shared/src/auth/dp/dp-runtime.ts`:

```ts
/**
 * Shared dp runtime facts: where the system dp keeps its mutable state, and
 * the environment a dp subprocess needs under a non-interactive host.
 *
 * Extracted from the plugin dp MCP path (`agent/backend/internal/
 * runtime-resolver.ts`) so the Bash sandbox grant (Task 2), the built-in dp
 * MCP env (Task 3) and the plugin binding all share ONE definition.
 *
 * dp's access token lives ~1 hour and dp refreshes it by WRITING into this
 * state root — which is why the sandbox must grant it (owner decision
 * 2026-08-06: use the system dp everywhere; never bundle one).
 *
 * Token values never appear here; the creds-file writer stays creds-store.ts.
 */

import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/**
 * dp's mutable state root: `$DP_WORKDIR` (trimmed) when set, else `~/.dp`.
 * Undefined when the directory does not exist, cannot be realpathed, or
 * resolves to the filesystem root or the home directory itself (a state root
 * becomes a sandbox WRITE grant in Task 2, so a whole-home grant is refused —
 * deliberate hardening over the pre-extraction plugin path). Never throws,
 * never creates directories, never caches.
 */
export function resolveDpStateRoot(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = homedir(),
): string | undefined {
  try {
    const configured = env.DP_WORKDIR?.trim();
    const candidate = configured ? resolve(configured) : join(homeDir, '.dp');
    if (!existsSync(candidate)) return undefined;
    const stateRoot = realpathSync(candidate);
    if (dirname(stateRoot) === stateRoot) return undefined;
    let home: string | undefined;
    try {
      home = realpathSync(homeDir);
    } catch {
      home = undefined;
    }
    if (home && stateRoot === home) return undefined;
    return stateRoot;
  } catch {
    return undefined;
  }
}

/**
 * Env a dp subprocess needs under a non-interactive host: silence update
 * warnings (stdout noise breaks MCP stdio framing) and never attempt the
 * interactive browser login. `DP_WORKDIR` rides along only when the state
 * root resolved. Carries no token and never will.
 */
export function dpRuntimeEnvironment(
  stateRoot: string | undefined = resolveDpStateRoot(),
): Record<string, string> {
  return {
    HOME: homedir(),
    DP_NO_WARNINGS: 'true',
    DP_AI_MCP_SKIP_LOGIN: 'true',
    ...(stateRoot ? { DP_WORKDIR: stateRoot } : {}),
  };
}
```

Add to `packages/shared/src/auth/dp/index.ts` beside the `resolveDpBinary` export line:

```ts
export { resolveDpStateRoot, dpRuntimeEnvironment } from './dp-runtime.ts';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/shared/src/auth/dp/__tests__/dp-runtime.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Rewrite the plugin path to consume the helper**

In `packages/shared/src/agent/backend/internal/runtime-resolver.ts`, replace the body of the dp runtime resolution at lines 280-306 (keep the function name and return type exactly as they are):

```ts
  try {
    const candidate = resolveDpBinary();
    if (!isAbsolute(candidate) || !existsSync(candidate)) return undefined;
    const command = realpathSync(candidate);
    const stateRoot = resolveDpStateRoot();
    return {
      command,
      externalAuthProvider: 'dp',
      environment: dpRuntimeEnvironment(stateRoot),
      ...(stateRoot ? { writableRoots: [stateRoot] } : {}),
    };
  } catch {
    return undefined;
  }
```

Import: `import { dpRuntimeEnvironment, resolveDpStateRoot } from '../../../auth/dp/dp-runtime.ts';` (deep-import style of the file's existing line 11). Behavioral invariants that must survive byte-for-byte: missing state root → binding still returned WITHOUT `DP_WORKDIR`/`writableRoots`; outer try/catch → `undefined` (swallows `DpNotFound`); `externalAuthProvider: 'dp'` field name unchanged (`runtime-pool-servers.ts:558` and the `ai mcp` argv restriction key off it).

- [ ] **Step 6: Run the guard tests**

Run: `bun test packages/shared/src/agent/backend/__tests__/runtime-resolver.test.ts packages/shared/src/mcp/__tests__/runtime-pool-servers.test.ts`
Expected: PASS, no assertion edits needed (behavior unchanged except the new home-refusal, which no fixture exercises).

- [ ] **Step 7: Typecheck + commit**

```bash
bun run typecheck:shared
git add packages/shared/src/auth/dp packages/shared/src/agent/backend/internal/runtime-resolver.ts
git commit -m "feat(dp): shared dp state-root and runtime-env helpers [DPK-1]"
```

---

### Task 2: Sandboxed shells can write the dp state root

**Files:**
- Modify: `packages/server-core/src/bootstrap/host-sandbox-settings.ts`
- Create/extend: `packages/server-core/src/bootstrap/__tests__/host-sandbox-settings.test.ts`
- Modify (pinned receipt strings): `packages/server-core/src/sessions/SessionManager.process-supervisor.test.ts`, `packages/server-core/src/sessions/__tests__/managed-sandbox-and-channel.test.ts` (and any other test the focused run flags that pins `write-workspace+scratch`)

**Interfaces:**
- Consumes: `resolveDpStateRoot` from Task 1.
- Produces: `withDpStateRootWriteGrant(resolved, onDiagnostic?, dpStateRoot?): ResolvedSandboxSettings` (exported for tests) and a `dpStateRoot?: () => string | undefined` DI seam on `HostSandboxSettingsOptions`.

Why here: `resolveHostSandboxSettings` is the ONE composition read by the single `ProcessSupervisor` construction (`SessionManager.ts:3649`, reached from both electron main and the headless server) AND by the doctor/report consumers (`managed-policy-resolution.ts:219`) — enforcement and diagnosis stay in agreement (the file's own R25c doctrine). A post-resolution append is REQUIRED: a managed floor naming `additionalWritableRoots` caps-and-discards layer grants (`sandbox-settings.ts:550-560`), so a dp root injected as a settings layer would silently vanish.

- [ ] **Step 1: Write the failing test**

In `packages/server-core/src/bootstrap/__tests__/host-sandbox-settings.test.ts` (create the file if absent, following the sibling tests' import style):

```ts
import { describe, expect, test } from 'bun:test';
import { withDpStateRootWriteGrant } from '../host-sandbox-settings.ts';

const base = Object.freeze({
  excludedCommands: Object.freeze([]),
  deniedReadRoots: Object.freeze(['/home/u/.nessy', '/home/u/.ssh']),
  deniedWriteRoots: Object.freeze([]),
  additionalWritableRoots: Object.freeze([]),
  allowUnsandboxedCommands: false,
  network: Object.freeze({}),
  filesystem: Object.freeze({ disabled: false }),
}) as never;

describe('withDpStateRootWriteGrant', () => {
  test('appends the resolved dp state root as a writable root', () => {
    const out = withDpStateRootWriteGrant(base, undefined, () => '/home/u/.dp');
    expect(out.additionalWritableRoots).toEqual(['/home/u/.dp']);
    expect(Object.isFrozen(out)).toBe(true);
    expect(Object.isFrozen(out.additionalWritableRoots)).toBe(true);
  });

  test('no dp root -> settings returned unchanged (same reference)', () => {
    expect(withDpStateRootWriteGrant(base, undefined, () => undefined)).toBe(base);
  });

  test('a dp root inside a denied root is refused with one diagnostic', () => {
    const diags: string[] = [];
    const out = withDpStateRootWriteGrant(base, m => diags.push(m), () => '/home/u/.nessy/dp');
    expect(out).toBe(base);
    expect(diags).toHaveLength(1);
    expect(diags[0]).toContain('/home/u/.nessy');
  });

  test('an already-granted root is not duplicated', () => {
    const granted = Object.freeze({ ...base, additionalWritableRoots: Object.freeze(['/home/u/.dp']) }) as never;
    expect(withDpStateRootWriteGrant(granted, undefined, () => '/home/u/.dp')).toBe(granted);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/server-core/src/bootstrap/__tests__/host-sandbox-settings.test.ts`
Expected: FAIL — `withDpStateRootWriteGrant` is not exported.

- [ ] **Step 3: Implement**

In `packages/server-core/src/bootstrap/host-sandbox-settings.ts`: add `import { resolveDpStateRoot } from '@nessy-agent/shared/auth/dp'`; extend the options interface; append the grant after `resolveSandboxSettings`:

```ts
export interface HostSandboxSettingsOptions {
  onDiagnostic?: (message: string) => void
  /** DI seam for tests only; production resolves the real dp state root. */
  dpStateRoot?: () => string | undefined
}
```

```ts
  const resolved = resolveSandboxSettings([...folded.layers, getUserSandboxSettings()], { floor: folded.floor })
  return withDpStateRootWriteGrant(resolved, options.onDiagnostic, options.dpStateRoot)
```

```ts
/**
 * dp refreshes its ~1-hour access token by WRITING into its state root, so a
 * seatbelt-sandboxed `dp ...` that cannot write there reports "not authorized"
 * while the user's own terminal says they are (the Desktop-vs-terminal split
 * this grant closes; owner decision 2026-08-06). Host-owned like the credential
 * deny floor: appended AFTER resolution, so a managed grant cap cannot discard
 * it. existsSync-gated inside resolveDpStateRoot — no ~/.dp is created for
 * users who never ran dp; a first dp install mid-session binds on restart.
 * The helper guarantees an absolute, realpathed, non-root, non-home path, so
 * skipping filesystemRoots validation here is sound.
 */
export function withDpStateRootWriteGrant(
  resolved: ResolvedSandboxSettings,
  onDiagnostic?: (message: string) => void,
  dpStateRoot: () => string | undefined = resolveDpStateRoot,
): ResolvedSandboxSettings {
  const root = dpStateRoot()
  if (!root || resolved.additionalWritableRoots.includes(root)) return resolved
  const denied = [...resolved.deniedReadRoots, ...resolved.deniedWriteRoots]
    .find(deny => root === deny || root.startsWith(`${deny}/`))
  if (denied) {
    // Seatbelt emits denies after allows, so this grant would never bind —
    // say so once instead of shipping a silent no-op.
    onDiagnostic?.(`dp state root ${root} lies inside the denied root ${denied}; dp commands in sandboxed shells cannot refresh their session.`)
    return resolved
  }
  return Object.freeze({
    ...resolved,
    additionalWritableRoots: Object.freeze([...resolved.additionalWritableRoots, root]),
  }) as ResolvedSandboxSettings
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/server-core/src/bootstrap/__tests__/host-sandbox-settings.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Update pinned isolation-receipt strings**

Any non-shared-git writable root flips isolation backend strings from `write-workspace+scratch` to `write-workspace+scratch+managed-data` (`write-scope-label.ts:25-38`) — but only on hosts where a dp root resolves, which is exactly the CI-green/dev-red trap. In every test that pins the literal, compute the expectation instead:

```ts
import { resolveDpStateRoot } from '@nessy-agent/shared/auth/dp';
const writeScope = resolveDpStateRoot()
  ? 'write-workspace+scratch+managed-data'
  : 'write-workspace+scratch';
```

Run to find every pin: `rg -a -n "write-workspace\+scratch" packages --glob '!**/node_modules/**'` and update each test assertion (production code carries the label builder — do not touch it).

- [ ] **Step 6: Run the affected suites**

Run: `bun test packages/server-core/src/sessions/SessionManager.process-supervisor.test.ts packages/server-core/src/bootstrap/__tests__/`
Expected: PASS on this machine (dp present) — and the dynamic expectation keeps CI (no dp) green.

- [ ] **Step 7: Typecheck + commit**

```bash
bun run typecheck:all
git add packages/server-core/src/bootstrap packages/server-core/src/sessions
git commit -m "feat(dp): sandboxed shells may write the dp state root so dp can refresh its own key [DPK-2]"
```

---

### Task 3: Built-in dp MCP servers get the dp runtime env

**Files:**
- Modify: `packages/shared/src/mcp/builtin-dp-servers.ts` (options + loop + the two "no env" comments at lines ~17-19 and ~244-245)
- Modify: `packages/shared/src/config/builtin-dp-mcp-preferences.ts:100-103` (settings view passes `runtimeEnv: {}`)
- Test: `packages/shared/src/mcp/__tests__/builtin-dp-servers.test.ts`, `packages/shared/src/mcp/__tests__/runtime-pool-servers.test.ts` (A7 arms), `packages/shared/src/config/__tests__/builtin-dp-mcp-settings.test.ts`, `packages/server-core/src/bootstrap/__tests__/builtin-dp-mcp-capability-projection.test.ts`

**Interfaces:**
- Consumes: `dpRuntimeEnvironment` from Task 1.
- Produces: `MaterializeBuiltinDpMcpOptions.runtimeEnv?: Readonly<Record<string, string>>` — Task 4's tests pass `runtimeEnv: {}` through `options.builtinDpMcpServers`.

- [ ] **Step 1: Write the failing test**

Add to `packages/shared/src/mcp/__tests__/builtin-dp-servers.test.ts`:

```ts
test('materialized servers carry an injected runtime env verbatim', () => {
  const result = materializeBuiltinDpMcpServers({
    enabled: { dpGitlab: true },
    resolveDpPath: () => '/fake/dp',
    runtimeEnv: { DP_NO_WARNINGS: 'true' },
  });
  expect(result.servers['dpGitlab']).toEqual({
    type: 'stdio',
    command: '/fake/dp',
    args: ['ai', 'mcp', 'gitlab'],
    env: { DP_NO_WARNINGS: 'true' },
  });
});

test('an empty injected env keeps the config byte-identical to the pre-env shape', () => {
  const result = materializeBuiltinDpMcpServers({
    enabled: { dpGitlab: true },
    resolveDpPath: () => '/fake/dp',
    runtimeEnv: {},
  });
  expect(result.servers['dpGitlab']).toEqual({
    type: 'stdio',
    command: '/fake/dp',
    args: ['ai', 'mcp', 'gitlab'],
  });
});

test('the default env is the dp runtime environment (keys only — value is host state)', () => {
  const result = materializeBuiltinDpMcpServers({
    enabled: { dpGitlab: true },
    resolveDpPath: () => '/fake/dp',
  });
  expect(Object.keys(result.servers['dpGitlab']!.env ?? {}))
    .toEqual(expect.arrayContaining(['HOME', 'DP_NO_WARNINGS', 'DP_AI_MCP_SKIP_LOGIN']));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/shared/src/mcp/__tests__/builtin-dp-servers.test.ts`
Expected: FAIL — `runtimeEnv` unknown / `env` undefined.

- [ ] **Step 3: Implement**

In `packages/shared/src/mcp/builtin-dp-servers.ts` add `import { dpRuntimeEnvironment } from '../auth/dp/dp-runtime.ts';`, extend the options:

```ts
  /**
   * Env attached to every materialized server config. Defaults to
   * `dpRuntimeEnvironment()`: HOME + the non-interactive dp switches
   * (DP_NO_WARNINGS — a dp update banner on stdout breaks MCP stdio framing;
   * DP_AI_MCP_SKIP_LOGIN — an unauthorized dp must fail fast, not open a
   * browser) + DP_WORKDIR when the state root resolves. Surfaces that only
   * need topology (the settings view) and host-independent tests pass `{}`.
   * Never a token, a header, or the gateway JWT — the module contract holds.
   */
  runtimeEnv?: Readonly<Record<string, string>>;
```

and in `materializeBuiltinDpMcpServers`:

```ts
  const runtimeEnv = options.runtimeEnv ?? dpRuntimeEnvironment();
  const servers: Record<string, SdkMcpServerConfig> = {};
  for (const definition of BUILTIN_DP_MCP_SERVERS) {
    if (!isBuiltinDpMcpServerEnabled(definition.name, options.enabled)) continue;
    servers[definition.name] = {
      type: 'stdio',
      command: dpPath,
      args: ['ai', 'mcp', definition.subcommand],
      ...(Object.keys(runtimeEnv).length ? { env: { ...runtimeEnv } } : {}),
    };
  }
```

Reword the module-header and materialize doc comments: the promise is now "no token, header, or credential of any kind — env carries only dp's own runtime switches". In `packages/shared/src/config/builtin-dp-mcp-preferences.ts` pass `runtimeEnv: {}` in `readBuiltinDpMcpSettingsView`'s materialize call (the view is topology-only; keeps the Bun-child JSON-roundtrip test host-independent).

- [ ] **Step 4: Run tests + fix the exact-map arms**

Run: `bun test packages/shared/src/mcp/__tests__/builtin-dp-servers.test.ts packages/shared/src/mcp/__tests__/runtime-pool-servers.test.ts packages/shared/src/config/__tests__/builtin-dp-mcp-settings.test.ts packages/server-core/src/bootstrap/__tests__/builtin-dp-mcp-capability-projection.test.ts`

Existing exact-map arms (builtin-dp-servers.test.ts:50,53,143,233,256; runtime-pool-servers.test.ts:2173,2177,2254,2280; builtin-dp-mcp-settings.test.ts:109; capability-projection.test.ts:208-212): pass `runtimeEnv: {}` through the options they already inject so their asserted shapes stay byte-identical. Do NOT weaken assertions to `toMatchObject`.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/mcp packages/shared/src/config packages/server-core/src/bootstrap/__tests__
git commit -m "feat(dp): builtin dp MCP servers run with the dp runtime env (non-interactive, warning-free, DP_WORKDIR) [DPK-3]"
```

Release-note fact for close-out: enabled built-in servers reconnect ONCE after this update (their `mcpConnectionKey` — sha256 over the whole config — changes when `env` appears). No persisted digest is affected.

---

### Task 4: Built-in dp servers gate on `needs-login` and join the dp sign-in row

**Files:**
- Modify: `packages/shared/src/mcp/runtime-pool-servers.ts` (`foldBuiltinDpMcpServers` ~:305-317, `materializeRuntimePoolServers` ~:269-290)
- Modify: `packages/server-core/src/sessions/SessionManager.ts` (new public method), `packages/server-core/src/handlers/session-manager-interface.ts` (declare it), `packages/server-core/src/handlers/rpc/settings.ts:512-517` (call it)
- Test: `packages/shared/src/mcp/__tests__/runtime-pool-servers.test.ts`, `packages/server-core/src/mcp/__tests__/workspace-mcp-pool-registry.test.ts`

**Interfaces:**
- Consumes: `RuntimeExternalAuthRequirement` (unchanged shape), `options.dpSessionState` (already on `MaterializePoolServersOptions`), Task 3's `runtimeEnv` seam for host-independent tests.
- Produces: `SessionManager.invalidateWorkspaceMcpPools(): void`.
- NO changes to: `workspace-mcp-pool-registry.ts` (its probe loop :508-550, ready-boundary invalidation :552-566 and resync blocked-filter :578-586 operate generically on `requirement.wireNames`), `pending-auth-summary.ts`, `PendingAuthNotice.tsx` — verified; the builtin wire names flow through them as data.

- [ ] **Step 1: Write the failing tests**

Add to the A7 describe in `packages/shared/src/mcp/__tests__/runtime-pool-servers.test.ts` (reuse the block's existing runtime/options fixtures; every arm injects `resolveDpPath` and `runtimeEnv: {}`):

```ts
test('enabled builtin + needs-login: withheld from the map, present in a dp requirement', async () => {
  const result = await materializeRuntimePoolServers(runtime, {
    ...baseOptions,
    dpSessionState: 'needs-login',
    builtinDpMcpServers: { enabled: { dpGitlab: true }, resolveDpPath: () => '/fake/dp', runtimeEnv: {} },
  });
  expect(result.mergedMcpServers['dpGitlab']).toBeUndefined();
  const dp = result.externalAuthRequirements.find(r => r.provider === 'dp');
  expect(dp).toEqual({ provider: 'dp', wireNames: ['dpGitlab'], pluginInstanceIds: [], state: 'needs-login' });
});

test('enabled builtin + ready: present in the map, requirement state ready', async () => {
  const result = await materializeRuntimePoolServers(runtime, {
    ...baseOptions,
    dpSessionState: 'ready',
    builtinDpMcpServers: { enabled: { dpGitlab: true }, resolveDpPath: () => '/fake/dp', runtimeEnv: {} },
  });
  expect(result.mergedMcpServers['dpGitlab']).toBeDefined();
  expect(result.externalAuthRequirements.find(r => r.provider === 'dp')?.state).toBe('ready');
});

test('enabled builtin + unavailable: NOT withheld (non-Pi preflight and probe hiccups must not evict)', async () => {
  const result = await materializeRuntimePoolServers(runtime, {
    ...baseOptions,
    dpSessionState: 'unavailable',
    builtinDpMcpServers: { enabled: { dpGitlab: true }, resolveDpPath: () => '/fake/dp', runtimeEnv: {} },
  });
  expect(result.mergedMcpServers['dpGitlab']).toBeDefined();
});

test('dp missing or nothing enabled: no dp requirement (registry fast path pinned)', async () => {
  const missing = await materializeRuntimePoolServers(runtime, {
    ...baseOptions,
    builtinDpMcpServers: { enabled: { dpGitlab: true }, resolveDpPath: () => null, runtimeEnv: {} },
  });
  expect(missing.externalAuthRequirements).toEqual([]);
  const disabled = await materializeRuntimePoolServers(runtime, {
    ...baseOptions,
    builtinDpMcpServers: { enabled: {}, resolveDpPath: () => '/fake/dp', runtimeEnv: {} },
  });
  expect(disabled.externalAuthRequirements).toEqual([]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/shared/src/mcp/__tests__/runtime-pool-servers.test.ts`
Expected: the four new arms FAIL (no requirement emitted, nothing withheld); every pre-existing arm still PASSES.

- [ ] **Step 3: Implement in `runtime-pool-servers.ts`**

`foldBuiltinDpMcpServers` returns the surviving builtin wire names (a name already configured by the user/plugins was stood down by the merge and must not be gated or reported):

```ts
function foldBuiltinDpMcpServers(
  configured: Record<string, SdkMcpServerConfig>,
  option: MaterializePoolServersOptions['builtinDpMcpServers'],
  debug: (message: string) => void,
): { servers: Record<string, SdkMcpServerConfig>; builtinWireNames: string[] } {
  if (option === false) return { servers: configured, builtinWireNames: [] };
  const builtin = materializeBuiltinDpMcpServers(option ?? {});
  for (const diagnostic of builtin.diagnostics) debug(`${diagnostic.code}: ${diagnostic.message}`);
  if (!builtin.available) return { servers: configured, builtinWireNames: [] };
  const folded = mergeBuiltinDpMcpServers(configured, builtin.servers);
  for (const diagnostic of folded.diagnostics) debug(`${diagnostic.code}: ${diagnostic.message}`);
  return {
    servers: folded.servers,
    builtinWireNames: Object.keys(folded.servers).filter(name => !(name in configured)),
  };
}
```

In `materializeRuntimePoolServers`, replace the `mergedMcpServers` line and the return:

```ts
  const dpSessionState = options.dpSessionState ?? 'unavailable';
  const folded = foldBuiltinDpMcpServers(configuredMcpServers, options.builtinDpMcpServers, debug);
  let mergedMcpServers = folded.servers;
  const externalAuthRequirements = [...snapshot.externalAuthRequirements];
  if (folded.builtinWireNames.length > 0) {
    // Withheld ONLY on a positive needs-login verdict (owner decision
    // 2026-08-06): the non-Pi session preflight hardcodes 'unavailable' and a
    // transient probe failure reports it — neither may evict working servers.
    // Plugin dp servers keep their stricter !== 'ready' gate: they materialize
    // credentials, builtins carry none.
    if (dpSessionState === 'needs-login') {
      const blocked = new Set(folded.builtinWireNames);
      mergedMcpServers = Object.fromEntries(
        Object.entries(mergedMcpServers).filter(([wireName]) => !blocked.has(wireName)),
      );
      debug(`runtime-external-auth-required:dp-builtin:${folded.builtinWireNames.length}`);
    }
    // The requirement is emitted in EVERY state (matching the plugin path), so
    // the registry probes the broker, discovers needs-login, and the
    // one-login-unblocks-N row + post-login resync cover builtins for free.
    const dpIndex = externalAuthRequirements.findIndex(requirement => requirement.provider === 'dp');
    if (dpIndex >= 0) {
      const existing = externalAuthRequirements[dpIndex]!;
      externalAuthRequirements[dpIndex] = {
        ...existing,
        wireNames: [...new Set([...existing.wireNames, ...folded.builtinWireNames])].sort(),
      };
    } else {
      externalAuthRequirements.push({
        provider: 'dp',
        wireNames: [...folded.builtinWireNames].sort(),
        pluginInstanceIds: [],
        state: dpSessionState,
      });
    }
  }
  return {
    sources: runtimeSources.sources,
    mcpServers: runtimeSources.mcpServers,
    apiServers: runtimeSources.apiServers,
    mergedMcpServers,
    externalAuthRequirements,
  };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/shared/src/mcp/__tests__/runtime-pool-servers.test.ts`
Expected: PASS, including the pre-existing arm pinning that `dpSessionState` gates plugin-bound servers only — that boundary is now explicitly two-tier (plugin: `!== 'ready'`; builtin: `=== 'needs-login'`); restate its describe text accordingly.

- [ ] **Step 5: Registry round-trip test + config isolation**

In `packages/server-core/src/mcp/__tests__/workspace-mcp-pool-registry.test.ts`:
1. If the file does not already isolate config, set `process.env.NESSY_CONFIG_DIR` to a fresh `mkdtempSync` dir at module scope BEFORE imports that read it (follow the repo's established pattern in sibling suites; this also shields the suite from dev machines whose real config enables builtins — the documented A7 skew).
2. Add one arm: registry whose fake `dpSessionBroker.probe()` first returns `{ state: 'needs-login', version: null, outdated: false }` — after sync, the enabled builtin (injected via a preference write into the isolated config dir) is absent from the pool's desired set and `entry.externalAuthRequirements` carries `provider: 'dp'` with its name; then flip the fake broker to ready, publish via its `subscribe` listener, and assert the ready-boundary invalidation + resync re-adds the server.

Run: `bun test packages/server-core/src/mcp/__tests__/workspace-mcp-pool-registry.test.ts`
Expected: PASS.

- [ ] **Step 6: Toggle invalidation**

The Settings toggle writes config but never invalidates warm pools. Add to `SessionManager` (beside the other small public accessors):

```ts
  /** Built-in dp MCP toggles change the desired set of every warm pool. */
  invalidateWorkspaceMcpPools(): void {
    this.workspaceMcpPools.invalidateAll()
  }
```

Declare it in `packages/server-core/src/handlers/session-manager-interface.ts`, and in `packages/server-core/src/handlers/rpc/settings.ts` extend the SET_ENABLED handler:

```ts
    setBuiltinDpMcpServerEnabled(name, enabled)
    deps.sessionManager.invalidateWorkspaceMcpPools()
```

Run: `bun test packages/server-core/src/handlers` (focused) — extend the existing settings-handler test with one arm asserting the spy on `invalidateWorkspaceMcpPools` fires on SET_ENABLED.

- [ ] **Step 7: Affected-boundary run + commit**

```bash
bun test packages/shared/src/mcp packages/server-core/src/mcp packages/server-core/src/sessions/SessionManager.dp-auth.test.ts
bun run typecheck:all
git add packages/shared/src/mcp packages/server-core/src
git commit -m "feat(dp): builtin dp MCP servers gate on needs-login and join the one-click dp sign-in row [DPK-4]"
```

Known accepted costs (record in tracker note when landing): every materialization on a dp machine with ≥1 enabled builtin now leaves the registry fast path and probes the broker (5s probe cache bounds it; `MAX_DP_MATERIALIZATION_ATTEMPTS` = 3 guards convergence); a ready-boundary crossing now invalidates every workspace with an enabled builtin (that is the feature).

---

### Task 5: Close-out

**Files:**
- Modify: `package.json` + `apps/electron/package.json` (lockstep version bump from whatever is current at close-out; this is a fix package → patch bump)
- Create: `apps/electron/resources/release-notes/<bumped-version>.md`
- Modify: affected `docs-site/` pages (built-in MCP servers page; `reference/config/environment-variables.md` — document that `DP_WORKDIR` now also scopes the sandbox write grant and the builtin server env) — both EN and RU
- Modify: this plan's Tracker (final sweep)

- [ ] **Step 1:** Full regression per the repo gate: `rm -rf release`, then `bun run typecheck:all` + `bun run lint` + `bun run test:shared:all` + `bun test` (single process) + `bun run lint:i18n:parity` + `bun run lint:i18n:sorted` (no i18n keys were added — the dp row reuses `pendingAuth.*` — so the last two prove nothing broke, not new coverage). `apps/cli` typecheck separately.
- [ ] **Step 2:** Release notes in the house style (`# Nessy Desktop <version>`, date line, `## FIXED` / `## IMPROVED`): dp works from agent shells without re-login (sandbox write grant); built-in dp servers no longer fail silently when dp is signed out — they show the one-click dp sign-in row and reconnect after login; built-in servers now run dp warning-free and non-interactive (note the one-time reconnect).
- [ ] **Step 3:** Update the parity/live checklists only if a row references built-in dp behavior (`docs/testing/cdp-live-checklist.md` — extend the A7 feature rows with the needs-login gate case).
- [ ] **Step 4:** Commit `chore(release): <version> — one dp key everywhere [DPK-5]`.

---

## Tracker

| Task | Status | Commit | Note |
| --- | --- | --- | --- |
| T1 shared dp-runtime helper | ✅ | `62da22b31`, `2551e55dd` | dpRuntimeEnvironment default removed after review — explicit undefined must mean "no root" (hermetic on dp machines) |
| T2 sandbox write grant for dp state root | ✅ | `80d1113db` | host-owned grant via withDpStateRootWriteGrant; receipt pins made dp-aware |
| T3 builtin dp MCP runtime env | ✅ | `6364a6b3f` | runtimeEnv seam; settings view passes {}; default env = dpRuntimeEnvironment(resolveDpStateRoot()) |
| T4 builtin gate + dp sign-in row | ✅ | `cb8abfb4d` | gate=needs-login only; requirement emitted in every state when builtins survive; toggle invalidates pools |
| T5 close-out (version, notes, docs-site) | ✅ | `1bfd51796` | 1.19.1; full regression green |

## Deviations / decisions log

- 2026-08-06 — **System dp only, reaffirmed and extended** (owner, chat): work laptops carry dp; Desktop uses it and its key everywhere instead of bundling a private dp the way nessy-cli does. nessy-cli's runtime practices (full env, `DP_WORKDIR`, non-interactive switches) adopted; its downloader rejected.
- 2026-08-06 — Builtin gate fires on `needs-login` only; `unavailable` keeps servers connected (non-Pi preflight hardcodes it; transient probe failures report it).
- 2026-08-06 — Sandbox dp-root grant is host-owned (post-resolution append; immune to managed grant caps) and existsSync-gated (restart picks up a first dp install). `resolveDpStateRoot` refuses `/` and `$HOME` as roots — hardening added during extraction.
- 2026-08-06 — T1 review: dpRuntimeEnvironment takes the state root explicitly (no parameter default) — a JS default re-resolves on explicit undefined, making the no-root case untestable and the API ambiguous for callers passing a maybe-undefined root. Task 3 will call dpRuntimeEnvironment(resolveDpStateRoot()).
- Category: `product-fix (dp auth reachability)` — not a Claude-parity deviation; no parity-report row.
- 2026-08-06 — final review: the dp requirement now carries builtinWireNames so the session resync filter and the pending-auth row apply the two-tier gate (builtin=needs-login only) instead of re-collapsing it; regression arms added for the requirement-merge branch and the ready→unavailable crossing.
- 2026-08-06 — re-review residual: preflightDpAuth applies the same two-tier condition via builtinWireNames — a builtin-only dp requirement pauses a turn only on needs-login [DPK-7].
