> **CLOSED — do not execute.** Landed as `6a16794e`, `d2c124c8`, `1be2c3e4`,
> `239aca02`. Both fixes shipped and were **verified live**: every denied credential
> path refuses, including the JWT's `.bak` copy that the single-file deny this plan
> originally proposed would have left readable. The extra revert commit exists
> because the planning session swept this plan's staged work into a docs commit;
> the executor reverted and re-landed rather than rewriting history, and the net
> tree is identical. Retained for the end-of-series review. Evidence in
> `docs/superpowers/specs/2026-07-25-nessy-claude-parity-audit.md` §0, row PX.

# Credential Denies and Plugin Skill Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A command the agent runs stops being able to read the user's SSH keys, AWS credentials and the shared gateway JWT — and a plugin skill's `disable-model-invocation` starts being honoured now that the model can invoke skills on its own.

**Architecture:** Two unrelated small fixes, batched because both are one-file-ish,
both are non-parity, and both close something we either just enabled or long
under-used. Neither needs new mechanism: the deny-root pipeline already canonicalises,
resolves symlinks, refuses relative and root paths, and tolerates a missing path — it
is simply seeded with one entry. And P7 already exported a single frontmatter-control
reader; the plugin adapters just never call it.

**Tech Stack:** TypeScript, Bun test runner. Packages: `@nessy-agent/server-core`
(`src/sessions`), `@nessy-agent/session-tools-core` (`src/handlers`),
`@nessy-agent/shared` (`src/plugins/format-adapters`).

**Not a parity plan.** Approved by the user on 2026-07-26 to run ahead of P8 because
one is an exploitable credential read and the other is a control bypass that shipping
P7 activated. Both are recorded in
`docs/superpowers/specs/2026-07-25-nessy-claude-parity-audit.md` — the exposure under
"Not a parity gap", the bypass under "New exposure created by shipping model
invocation".

## Before you start: re-verify

Done by the planning session on 2026-07-26 against HEAD `e527b776`. Re-run if HEAD has
moved past that.

- [x] Every isolation backend allows **ambient read of the whole filesystem**; the
  profile axis is write scope only. darwin `(allow file-read*)`
  (`session-tools-core/src/runtime/filesystem-isolation.ts:56`), linux
  `--ro-bind / /` (`:125`), win32 `":root" = "read"`
  (`server-core/src/pi-harness/isolation/windows.ts:115`). The backend strings say so
  literally: `host-read:write-workspace+scratch`.
- [x] The **only** production read-deny is
  `deniedReadRoots: [join(CONFIG_DIR, 'credentials.enc')]` —
  `server-core/src/sessions/SessionManager.ts:2659`. `CONFIG_DIR` is `~/.nessy-agent`
  (`shared/src/config/paths.ts:18,21`).
- [x] The gateway JWT is at `~/.nessy/dp_auth_creds.json`
  (`shared/src/auth/dp/creds-store.ts:36`) — a **different** directory, so the existing
  deny does not cover it.
- [x] `script_sandbox` passes **no** `deniedReadRoots` at all —
  `session-tools-core/src/handlers/script-sandbox.ts:79,84,101` call
  `applyFilesystemIsolation` without the option.
- [x] `canonicalDeniedReadRoot` (`server-core/src/pi-harness/isolation.ts:35-46`)
  **already tolerates a missing path**: on `ENOENT` it canonicalises the parent and
  re-joins the basename, so a machine without `~/.aws` will not break process spawn.
  It refuses a relative path and refuses a filesystem root. Any other error
  propagates.
- [x] Darwin emits `(deny file-read* (subpath "…"))` per entry
  (`filesystem-isolation.ts:62-65`), which is correct for both a directory and a single
  file. linux uses tmpfs-or-`/dev/null` per node kind (`:128-130`); win32 emits
  `= "deny"` lines (`windows.ts:117`).
- [x] No plugin format adapter parses a skill's `SKILL.md` frontmatter.
  `format-adapters/claude.ts:11` mentions the path only in a comment; `codex.ts:695-762`
  checks existence and builds paths without reading frontmatter. So plugin skills reach
  the runtime with an empty description and no control fields, and the refusal at
  `shared/src/agent/base-agent.ts:1263`
  (`origin === 'model' && runtimeSkill.disableModelInvocation === true`) never fires
  for them.
- [x] P7 exported `readSkillInvocationControls` as the single reader of the control
  field names, precisely so a second parser cannot drift. **Use it. Do not write a
  fourth frontmatter parser.**

## Global Constraints

- **Adding a deny is safe; removing or weakening one is not.** Keep
  `canonicalDeniedReadRoot`'s two refusals (relative path, filesystem root) and its
  symlink resolution. Do not make the list settings-overridable in this plan — a
  user-editable credential deny is a policy decision that belongs with P10's managed
  policy, not here.
- **The list must be one shared constant read by both call sites.** Two hand-written
  lists will drift, and the whole defect is that one call site was forgotten.
- **A missing directory must not break anything.** The ENOENT tolerance above is what
  makes that true; add a test for it rather than assuming it.
- **Do not widen what a skill can do.** Task 2 makes plugin skills carry *restrictions*
  they author. If reading frontmatter would also grant a plugin skill something it does
  not have today, that part is out of scope — `allowed-tools` enforcement in particular
  is P6-adjacent and explicitly deferred.
- One commit per task. No `Co-Authored-By` trailers.
- Gates: `bun run typecheck:shared`; `cd packages/server-core && bun run typecheck`;
  `bun run typecheck:electron`.
- **Never pass `-r` to `rg`** — it parses as `--replace` and silently rewrites every
  match. Three agents have now lost time to this.

## File Structure

| File | Responsibility |
| --- | --- |
| Create `packages/session-tools-core/src/runtime/credential-deny-roots.ts` (or the nearest existing leaf module — see Task 1) | The shared deny list. |
| Modify `packages/server-core/src/sessions/SessionManager.ts:2659` | Seed from the shared list. |
| Modify `packages/session-tools-core/src/handlers/script-sandbox.ts:79,84,101` | Seed from the shared list. |
| Modify `packages/shared/src/plugins/format-adapters/claude.ts`, `codex.ts` (and the Nessy adapter if it has a skills branch) | Read `SKILL.md` frontmatter via `readSkillInvocationControls`. |

---

### Task 1: Credential paths stop being readable from a sandboxed command

**Files:**
- Create: a leaf module exporting the list — put it where **both** consumers can import
  it without dragging a dependency in. `session-tools-core/src/runtime/` is the
  likely home since `filesystem-isolation.ts` already lives there and
  `server-core` already depends on `session-tools-core`. **Verify the direction of
  that dependency before choosing** — if it is the other way, put the constant in
  `shared` instead. P5 hit exactly this and had to move a constant because
  `.mcp.json` parsing started transitively pulling the Claude SDK.
- Modify: `packages/server-core/src/sessions/SessionManager.ts:2659`
- Modify: `packages/session-tools-core/src/handlers/script-sandbox.ts:79,84,101`
- Test: the filesystem-isolation suite and the script-sandbox suite

**Interfaces:**
- Consumes: nothing.
- Produces: `CREDENTIAL_DENY_ROOTS(homeDir: string, configDir: string): string[]` — Task 2 does not depend on it.

- [x] **Step 1: Write the failing test**

```ts
  it('denies the credential paths in the rendered darwin profile', () => {
    const profile = buildDarwinSandboxProfile({
      writableRoot: '/tmp/ws',
      deniedReadRoots: CREDENTIAL_DENY_ROOTS('/Users/x', '/Users/x/.nessy-agent'),
    });
    for (const denied of ['/Users/x/.ssh', '/Users/x/.aws', '/Users/x/.nessy/dp_auth_creds.json']) {
      expect(profile).toContain(`(deny file-read* (subpath "${denied}"))`);
    }
    // The pre-existing deny must survive.
    expect(profile).toContain('credentials.enc');
  });

  it('tolerates a credential path that does not exist on this machine', () => {
    // canonicalDeniedReadRoot canonicalises the parent on ENOENT. A user with no
    // ~/.aws must not have every process spawn fail.
    expect(() => resolveProcessIsolation({
      ...isolationInput(),
      deniedReadRoots: [join(tmpHome, '.aws')], // never created
    })).not.toThrow();
  });

  it('seeds the same list into script_sandbox', async () => {
    // The whole defect is that this call site was forgotten, so assert the argument
    // rather than the behaviour — a behavioural test here would pass on the old code
    // for the wrong reason.
    const spy = spyOnApplyFilesystemIsolation();
    await runScriptSandbox({ code: 'print(1)' });
    expect(spy.mock.calls[0]![0].deniedReadRoots).toEqual(
      expect.arrayContaining([expect.stringContaining('.ssh')]),
    );
  });

  it('still refuses a relative or root deny entry', () => {
    expect(() => resolveProcessIsolation({ ...isolationInput(), deniedReadRoots: ['relative/x'] }))
      .toThrow('process-denied-read-root-not-absolute');
    expect(() => resolveProcessIsolation({ ...isolationInput(), deniedReadRoots: ['/'] }))
      .toThrow('process-denied-read-root-too-broad');
  });
```

The third test is the load-bearing one, and the fourth exists so the fix cannot
accidentally relax the two refusals it depends on. Read the real suites and use their
harness names; the placeholders above are intent.

- [x] **Step 2: Run test to verify it fails**

Run the two suites. Expected: the first and third fail — nothing seeds the list and
`script_sandbox` passes no option. The second and fourth should already pass; if the
second fails, stop and report, because it means the ENOENT tolerance is not what the
re-verify found.

- [x] **Step 3: Write minimal implementation**

```ts
/**
 * Paths a sandboxed command must never read. Necessary because no isolation profile
 * restricts reads — every backend grants ambient whole-filesystem read and scopes only
 * writes (`filesystem-isolation.ts:56`, `:125`, `windows.ts:115`). Until that posture
 * changes, an explicit deny is the only protection these files have.
 *
 * The gateway JWT lives under `~/.nessy`, which is NOT the app's own
 * `~/.nessy-agent` config dir — it is shared with nessy-cli — so the existing
 * `credentials.enc` deny does not cover it.
 */
export function credentialDenyRoots(homeDir: string, configDir: string): string[] {
  return [
    join(configDir, 'credentials.enc'),
    join(homeDir, '.ssh'),
    join(homeDir, '.aws'),
    join(homeDir, '.nessy', 'dp_auth_creds.json'),
  ]
}
```

Then read it at both call sites. Keep `credentials.enc` in the list rather than
appending to the existing literal, so one place defines the set.

**Judgement call to make and state in the commit body:** deny the single JWT file, or
the whole `~/.nessy` directory? The file is what the audit named and is more precise;
the directory is safer if that dir holds other secrets. Check what else lives there
before deciding, and say which you chose and why.

- [x] **Step 4: Run tests to verify they pass**

Expected: 0 fail in both suites.

- [x] **Step 5: Mutation probe**

Remove `.ssh` from the constant and confirm the darwin-profile test fails. Remove the
`script_sandbox` seeding and confirm the third test fails. Revert both — a test that
passes without the seeding proves nothing, and that is exactly the bug being fixed.

- [x] **Step 6: Prove no isolation regression**

Run: `bun test packages/session-tools-core/src packages/server-core/src packages/shared/src/agent`
Expected: 0 fail. Note that `session-branch-rollback.isolated.ts` fails 3 tests on
`e527b776` already — confirm it fails identically and do not chase it.

- [x] **Step 7: Commit**

```bash
git add packages/session-tools-core packages/server-core
git commit -m "fix(isolation): deny credential paths to sandboxed commands"
```

---

### Task 2: A plugin skill's own controls are honoured

**Files:**
- Modify: `packages/shared/src/plugins/format-adapters/claude.ts`,
  `packages/shared/src/plugins/format-adapters/codex.ts`, and the Nessy adapter if it
  has a skills branch — **count the adapters with a skills branch first** and say how
  many in the commit body
- Test: `packages/shared/src/plugins/__tests__/format-adapters.test.ts`

**Interfaces:**
- Consumes: `readSkillInvocationControls` (exported by P7).
- Produces: nothing.

Before P7 this cost nothing: no skill was model-invocable, so a discarded
`disable-model-invocation` was inert. P7 shipped model invocation, which turns the
missing field into a live bypass — on third-party content specifically.

- [x] **Step 1: Write the failing test**

```ts
  it('carries a plugin skill\'s disable-model-invocation into the capability', async () => {
    const bundle = claudeBundle('skilled', {
      manifest: { name: 'skilled' },
      files: {
        'skills/danger/SKILL.md': [
          '---', 'name: danger', 'description: Deploys to production',
          'disable-model-invocation: true', '---', 'Body.',
        ].join('\n'),
      },
    });
    const result = await normalizeClaudePluginBundle(bundle);
    const skill = result.capabilities.find(c => c.kind === 'skill')!;
    expect(skill.skill.description).toBe('Deploys to production');
    expect(skill.skill.disableModelInvocation).toBe(true);
  });

  it('carries user-invocable: false too', async () => { /* same shape */ });

  it('leaves a plugin skill with no frontmatter usable', async () => {
    // The documented contract is lenient: malformed or absent frontmatter loads the
    // body with empty metadata. A plugin skill must not vanish.
    const bundle = claudeBundle('plain', {
      manifest: { name: 'plain' },
      files: { 'skills/plain/SKILL.md': 'Just a body.' },
    });
    const result = await normalizeClaudePluginBundle(bundle);
    expect(result.capabilities.filter(c => c.kind === 'skill')).toHaveLength(1);
  });

  it('does the same for a Codex-format bundle', async () => { /* codex fixture */ });
```

Use the suites' real fixture helpers. Check the exact property name the skill
capability carries — P7 named the runtime-handle field
`skillDisableModelInvocation` in `native-sources.ts:275`, so the IR spelling may
differ from the handle spelling; match what exists rather than inventing.

- [x] **Step 2: Run test to verify it fails**

Expected: FAIL — description empty, control fields undefined.

- [x] **Step 3: Write minimal implementation**

Read the `SKILL.md` frontmatter in each adapter's skills branch and pass the values
through `readSkillInvocationControls`. Do **not** add a parser: P7 exported that reader
specifically so the two existing parsers could not drift, and a third would defeat it.

If an adapter has no convenient place to read file contents at that point, say so in
the commit body rather than restructuring the adapter — a plumbing change there is its
own review.

- [x] **Step 4: Run test to verify it passes**

Expected: 0 fail.

- [x] **Step 5: Prove the refusal actually fires end to end**

Add one test at the `base-agent.ts:1263` level driving a **plugin-provided** skill
handle with `disableModelInvocation: true`, asserting a model-origin marker is refused
and a user-origin reference still resolves. Without this the task proves the field
travels but not that it bites.

- [x] **Step 6: Prove no plugin regression**

Run: `bun test packages/shared/src/plugins packages/shared/src/capabilities packages/shared/src/agent`
Expected: 0 fail.

- [x] **Step 7: Commit**

```bash
git add packages/shared/src/plugins
git commit -m "fix(plugins): honour a plugin skill's own invocation controls"
```

---

### Task 3: Live verification

- [x] **Step 1: Credential denies**

With an isolated `NESSY_CONFIG_DIR` and the `pi-api-key` (`pi_compat`) connection, ask
the agent to run a `bash` command that reads each denied path
(`cat ~/.ssh/id_*`, `cat ~/.aws/credentials`, `cat ~/.nessy/dp_auth_creds.json`).
Record the refusal for each. **Do not paste any file contents into the report** — if a
read succeeds, say which path and stop, do not quote it.

- [x] **Step 2: Confirm the sandbox still works at all**

A deny that breaks ordinary work is not a fix. Confirm a normal workspace read and
write still succeed, and that a machine-missing path (rename `~/.aws` aside if it
exists, or pick one that genuinely does not exist) does not break spawn.

- [x] **Step 3: `script_sandbox` too**

Same reads through `script_sandbox`, which was the forgotten call site.

- [x] **Step 4: Plugin skill control**

Install a plugin whose bundle ships a skill marked `disable-model-invocation: true`
(a local directory-of-plugins registry is how P3 and P7 did this;
`NESSY_BUN` must be exported for install). Confirm the skill appears in the listing
with its **description**, that the model refuses to invoke it when it emits the marker
itself, and that a user-typed `[skill:slug]` still loads it.

- [x] **Step 5: Record and clean up**

Append the evidence to this file. Uninstall the QA plugin, delete QA sessions, stop the
app, remove the isolated dir, leave `git status` clean. Force the dark theme before any
screenshot.

- [x] **Step 6: Commit**

```bash
git commit -m "docs(isolation): record the credential deny and skill control verification"
```

### Live verification — RAN, every denied path refused

Isolated `NESSY_CONFIG_DIR` seeded with the authorized `pi-api-key` (`pi_compat`)
connection (`config.json` + `credentials.enc` copied; the credential store keys off
the machine hardware UUID, not the config path, so **no credential was entered**),
headless server + `apps/cli run`, cleaned up afterwards. `~/.nessy-agent` and
`~/.nessy` both verified untouched by mtime; `git status` clean.

**1. Credential denies, production supervisor path.** `ProcessSupervisor` +
`credentialDenyRoots(homedir(), CONFIG_DIR)` — the exact wiring `SessionManager`
installs — spawning under `workspace:sandbox-exec:host-read:write-workspace+scratch`.
No file contents were read or recorded.

| Probe | Result |
| --- | --- |
| workspace read | `WORKSPACE-READ-OK` |
| workspace write | `WORKSPACE-WRITE-OK` |
| `ls ~/.ssh` | `ls: /Users/…/.ssh: Operation not permitted` exit=1 |
| `~/.ssh/id_ed25519` | `Operation not permitted` exit=1 |
| `~/.ssh/known_hosts` | `Operation not permitted` exit=1 |
| `~/.aws/credentials` (absent here) | `No such file or directory` exit=1 — **spawn still worked** |
| `~/.nessy/dp_auth_creds.json` | `Operation not permitted` exit=1 |
| `~/.nessy/dp_auth_creds.json.bak` | `Operation not permitted` exit=1 |
| `ls ~/.nessy` | `Operation not permitted` exit=1 |
| `CONFIG_DIR/credentials.enc` | `Operation not permitted` exit=1 |
| `ls $HOME` (control) | exit=0 — the deny is scoped, not blanket |

**2. The sandbox still works.** Rows 1–2 and the last row above. The machine-missing
`~/.aws` produced ENOENT from the command, never a spawn failure — the ENOENT
tolerance holds on the production path, which carries its own copy of the
canonicalisation (`process-supervisor.ts`), not only `canonicalDeniedReadRoot`.

**3. `script_sandbox`** (the forgotten call site), real handler: session read
`SESSION-READ-OK`, session write `SESSION-WRITE-OK`, `~/.ssh/id_ed25519` `EPERM`,
`~/.ssh` listing `EPERM`, `~/.aws/credentials` `ENOENT`, gateway JWT `EPERM`, its
`.bak` `EPERM`, `credentials.enc` `EPERM`, `$HOME` listing `HOME-LISTING-OK`.

**4. Agent's own bash tool.** Same deny on the real tool path:
`for p in ~/.ssh ~/.aws ~/.nessy` → all three `blocked exit=1`; a plain-markdown
file inside the denied tree (`~/.nessy/PROJECT_SUMMARY.md`) →
`Operation not permitted`; a workspace read in the same session → fine.

**5. Plugin skill control.** A local Claude-format bundle `qa-deployer` with two
skills — `danger-deploy` (`disable-model-invocation: true`) and `safe-audit` (no
controls) — installed through the real pipeline. The persisted normalized manifest:

```
{"slug":"safe-audit","description":"Reports the pumpkin coefficient of this repository"}
{"slug":"danger-deploy","description":"Deploys the release to production","disableModelInvocation":true}
```

Both carried **no description and no controls** before this change; `safe-audit`
correctly has the control *absent*, not `false`.

- **Listing carries the description.** `capabilities:getCatalog` →
  `safe-audit | "Reports the pumpkin coefficient of this repository" | plugin` and
  `danger-deploy | "Deploys the release to production" | plugin`.
- **The model refuses its own marker.** The model's `<available_skills>` held exactly
  `safe-audit`, `find-skills`, `officecli` — `danger-deploy` omitted. It then found
  the slug in a capability ref, emitted the literal `[skill:danger-deploy]` in its
  OWN output, and the turn ended there: no continuation, no `<invoked-skill>` block,
  no `DANGER-DEPLOY-BODY-LOADED`, and it never answered the question it needed the
  body for. Omission alone would not have stopped it — it had the slug.
- **The user can still invoke it.** A user-typed `[skill:danger-deploy]` returned
  `DANGER-DEPLOY-BODY-LOADED`, a string that exists only inside the skill body.

**Two things the plan did not anticipate.**

- The agent's own safety layer refuses to run a command that reads `~/.ssh`, before
  isolation is reached, and the Guardian judge spawns a `scout:` child session for
  such commands that outlives a 4-minute send timeout. Neither is a fault, but a
  cooperative agent prompt cannot drive a credential-path probe — hence the
  enforcement-layer probes above, plus the non-secret file inside the denied tree to
  prove the agent's real tool path is subject to the same deny.
- `marketplace:addRegistry` is not wired into the **headless** server's handler deps
  (`packages/server/src/index.ts` passes `pluginManagement` but not
  `marketplaceRegistrySource`), and both the RPC proposal path and the agent
  `plugin_install` tool accept only a URL or an opaque proposal id — never a raw
  local path. The QA install therefore ran against the same
  `PluginManagementServiceV2` the RPC handler constructs. Headless-only gap, unrelated
  to this plan.

---

## Final Verification

- [x] `bun test packages/session-tools-core/src packages/server-core/src packages/shared/src`
- [x] `bun run typecheck:shared`; `cd packages/server-core && bun run typecheck`;
  `cd packages/pi-agent-server && bun run typecheck`; `bun run typecheck:electron`
- [x] `git diff --check`; `bun run electron:build`
- [x] Diff review: the two `canonicalDeniedReadRoot` refusals are intact; the deny list
  is defined once and read twice; nothing made the list settings-overridable; Task 2
  granted a plugin skill no new capability, only its own restrictions.

## Deliberately out of scope

- **Making reads restricted by default.** Flipping the ambient-read posture is a
  design change for P10, not a deny-list seed.
- **A settings surface for the deny list.** That is managed policy — P10.
- **`allowed-tools` / `disallowed-tools` enforcement** for skills. Captured by P7,
  enforced with the permission work.
- **The remaining `file_path`-only config guards** (`validateConfigWrite`, the
  automations block) — a separate follow-up with its own policy question.

## Tracker

| # | Task | Status | Gate that proves it | Evidence |
| --- | --- | --- | --- | --- |
| 0 | Re-verify (done by the planner at `e527b776`) | **done** | 8 anchors | in the re-verify section; re-checked at `0cf61335` — the two intervening commits are docs-only, so every code anchor still holds |
| 1 | Credential denies, both call sites | **done `6a16794e`** | 4 tests; both probes re-fail | `bun test packages/session-tools-core/src packages/server-core/src/pi-harness` → **276 pass / 0 fail**. Broad: `bun test packages/session-tools-core/src packages/server-core/src packages/shared/src/agent` → **2314 pass / 3 skip / 0 fail**. New tests: darwin profile renders all four denies (`filesystem-isolation.test.ts`), `script_sandbox` seeds the list into **every** isolation call on its path (`script-sandbox.test.ts` — asserts the argument), ENOENT tolerance on the production supervisor path (`process-supervisor.test.ts`), and the two refusals `process-denied-read-root-not-absolute` / `-too-broad` (`isolation.test.ts`, previously uncovered). Mutation probes: removing `.ssh` from the constant → darwin-profile test fails; removing the `script_sandbox` seeding → argument test fails (`deniedReadRoots: undefined`); both reverted, green restored. `typecheck:shared`, `server-core`, `session-tools-core` clean. |
| 2 | Plugin skill controls honoured | **done `1be2c3e4`** | 4 tests + the end-to-end refusal | `bun test packages/shared/src/plugins/__tests__/format-adapters.test.ts` → **88 pass / 0 fail** (6 new: claude `disable-model-invocation`, claude `user-invocable: false`, claude single-root layout, no-frontmatter still loads, codex bundle, native `plugin.json` bundle). Step 5 end-to-end: `resolver.test.ts` carries a plugin skill's controls onto the runtime handle + omits them when unstated; `base-agent.test.ts` refuses a **plugin-provided** handle on a model-origin marker and still resolves a user-origin reference. Mutation probe: removing the resolver's plugin carry → the handle test fails (`Expected true, Received undefined`); reverted. Broad: `bun test packages/shared/src/plugins packages/shared/src/capabilities packages/shared/src/agent packages/shared/src/skills` → **2109 pass / 4 skip / 0 fail**. `typecheck:shared` clean. **4** adapters have a skills branch (claude, codex, `nessy-plugin-json` via `schema.ts`, legacy Nessy extension); only mcpb has none. Fixed by ONE format-agnostic pass in `normalizePluginBundle`, not per-adapter — `schema.ts` cannot read the file (pure sync, no bundle root) and it is the adapter that handles marketplace/standalone skill installs. |
| 3 | Live verification | **done** | every denied path refused; sandbox still usable | see the Live verification section above — 11 supervisor probes, 9 `script_sandbox` probes, 3 agent-tool probes, all four deny roots refused with `Operation not permitted`/`EPERM`, missing `~/.aws` tolerated, workspace read+write and a non-denied `$HOME` listing still fine. Plugin skill: description in the listing, model-emitted marker refused, user-typed reference loads. No file contents were read, quoted or recorded. |
| — | Final Verification | **done** | full list above | `bun test packages/session-tools-core/src packages/server-core/src packages/shared/src` → **4856 pass / 7 skip / 0 fail** across 467 files. `typecheck:shared`, `packages/server-core`, `packages/pi-agent-server`, `typecheck:electron` all clean. `git diff --check` clean. `bun run electron:build` succeeded. Known-red `session-branch-rollback.isolated.ts` fails the same 3 tests as on `e527b776` (`1 pass / 3 fail`) — predates this work, not chased. **One flake seen once**: the first full sweep reported `4855 pass / 1 fail` on `WorkspaceMcpPoolRegistry > isolates DP state and subscriptions across registries with different host brokers`; that suite passes `25 pass / 0 fail` in isolation and the identical second sweep was clean, so it is order/timing-dependent and touches nothing this plan changed. |

Status values: `not started` / `in progress` / `blocked: <why>` / `done <commit>`.

**Stop conditions.** Halt and report rather than working around:

- The ENOENT tolerance turns out not to hold and a missing `~/.aws` breaks spawn.
- Seeding the list requires touching `canonicalDeniedReadRoot`'s refusals.
- Task 2 cannot read frontmatter without restructuring an adapter's file access.
- A live read of a denied path **succeeds**. Report the path, quote nothing.
