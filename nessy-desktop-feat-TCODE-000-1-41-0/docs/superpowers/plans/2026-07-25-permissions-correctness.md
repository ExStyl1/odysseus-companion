> **CLOSED — do not execute.** Landed as `de8dc2f6`, `9a739957`, `b4f7920d`,
> `63f65f73`, `32303ab4`, `014cb061`, `97a73227`, `52afaf9a`. All tasks shipped.
> **This plan's proposed `dontAsk` order index was wrong** and the executor placed
> it at 0 with a better argument — see the audit row. Live verification caught a P0
> the unit suites could not (Pi sends `path`, not `file_path`). Two config-write
> guards remain fail-open on Pi; that is in the audit's `Known follow-ups`.
> Retained for the end-of-series review; every checkbox below is finished work.
> Evidence lives in
> `docs/superpowers/specs/2026-07-25-nessy-claude-parity-audit.md` §0, row P6.

# Permissions Correctness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The multi-repo permission code that already exists starts being called, `acceptEdits` stops auto-approving writes outside the workspace, a tool that declares it needs a human gets one, and an unattended session can fail closed.

**Architecture:** Four independent gaps in one subsystem plus one small carry-over.
`shouldAllowToolInMode` already implements `additionalDirectories` end to end and no
production caller passes it, so Task 1 is wiring, not design. Task 2 narrows
`acceptEdits` to that same root set. Task 3 consumes the descriptor metadata P5
makes survive. Task 4 adds a seventh permission mode, which is the one task here
that must land atomically across the enum, the order table, the renderer and i18n.

**Tech Stack:** TypeScript, Bun test runner. Packages: `@nessy-agent/shared`
(`src/agent`), `@nessy-agent/core` (mode types), `apps/electron` (renderer badges).

Covers audit shortlist item 7 minus its floor/band half, which is **R15** with its
own security review (`2026-07-25-nessy-claude-parity-audit.md` §0 row P6).

## Dependency

**Task 3 requires P5's Task 2 to have landed** — `requiresUserInteraction` reaches
no consumer until `annotations`/`_meta` survive the pool's two projections. If P5 is
not closed when you reach Task 3, do Tasks 1, 2 and 4 first and report Task 3 as
`blocked: waiting on P5 task 2`. Do not re-implement the projection here.

## Before you start: re-verify

Done by the planning session on 2026-07-25 against HEAD `4eb6342a`. Re-run if HEAD
has moved past that, and note that **P5 is landing in `packages/shared/src/mcp`
concurrently** — that is a different subsystem, but re-read `mcp-pool.ts` rather
than trusting a line number in it.

- [x] `shouldAllowToolInMode` (`mode-manager.ts:1990-2000`) accepts
  `options.additionalDirectories` and uses it at `:2078-2079`, `:2136`, `:2156-2164`,
  `:2213`, `:2243-2244`. **No production caller passes it** — every occurrence in
  `packages/` outside that function is the declaration or its own reads. The
  capability is complete and unfed.
- [x] `PermissionMode = 'safe' | 'plan' | 'ask' | 'acceptEdits' | 'auto' | 'allow-all'`
  (`mode-types.ts:27`), ordered least-to-most permissive in
  `PERMISSION_MODE_ORDER` (`:43`). `dontAsk` appears nowhere in `packages/`.
- [x] **`packages/shared/AGENTS.md` is stale on this point** — it says "Permission
  modes are fixed: `safe`, `plan`, `ask`, `acceptEdits`, `allow-all`" and omits
  `auto`. Task 4 must update that line in the same commit, or the next reader plans
  against a five-mode vocabulary.

## Global Constraints

- **The deny floor does not move in this plan.** A hook `allow` still cannot reopen
  a denied path; hooks still run after the centralized gate. Giving `allow` a band
  where it works is **R15**, deliberately split out because §3 records our stronger
  floor as a place we are ahead. If a task here seems to need the band, stop.
- **Widening a root is a permission decision, not a convenience.** `additionalDirectories`
  must come from an explicit, persisted, user-visible setting — never inferred from
  a path the model asked about. The existing outside-root approval flow
  (`local-tools/runtime.ts:275-289`, `requestOutsideRootApproval`) is the model's
  route to a new root; Task 1 is about roots a **human** configured up front.
- **Mode changes are atomic.** A seventh mode touches `PermissionMode`,
  `PERMISSION_MODE_ORDER`, the renderer badges, the mode menu and both locale files.
  Repo history records a mode-enum change breaking typecheck when split across
  commits — land Task 4 as one commit.
- **Badge width.** `packages/shared/AGENTS.md` caps permission-mode badges at 3-5
  characters. `dontAsk` needs a short label in both locales; check the badge
  component before choosing the string.
- One commit per task, except Task 4 which is one atomic commit by design. No
  `Co-Authored-By` trailers.
- Gates: `bun run typecheck:shared`; `bun run typecheck:electron`;
  `bun run lint:i18n:parity`; `bun run lint:i18n:sorted`.

## File Structure

| File | Responsibility |
| --- | --- |
| Modify `packages/shared/src/agent/pi-agent.ts` | Task 0: the terminal reason on a Pi budget breach. |
| Modify `packages/shared/src/agent/mode-manager.ts` | `acceptEdits` scoping; the new mode's behavior. |
| Modify `packages/shared/src/agent/mode-types.ts` | The `dontAsk` mode and its order position. |
| Modify the permission-gate call sites | Feed `additionalDirectories` from config. |
| Modify `packages/shared/src/config/` | Persist the configured extra roots. |
| Modify `packages/shared/src/i18n/locales/{en,ru}.json` | Mode label. |
| Modify `packages/shared/AGENTS.md` | The stale mode list. |

---

### Task 0: A Pi budget breach names its reason

**Files:**
- Modify: `packages/shared/src/agent/pi-agent.ts:5017-5033`
- Test: the Pi budget suite (`rg -l maxBudgetUsd packages/shared/src --glob '*.test.ts'`)

**Interfaces:**
- Consumes: `AgentTerminalReason` (landed in P4).
- Produces: nothing.

Carried here because it is ten lines and P6 is the next agent-layer plan; queueing
it behind nine plans would leave the backend most sessions actually use unable to
say why it stopped. P4 made the stop legible on the shared base-agent path
(`base-agent.ts:1537-1545`) which Claude, Codex and Nestor Cloud take; `PiAgent`
opts out at `:747` and enforces in its own loop, where `:5031-5033` only calls
`forceAbort(AbortReason.MaxBudgetUsd)`.

- [ ] **Step 1: Write the failing test**

```ts
  it('names the budget on the complete when the Pi loop stops a turn', async () => {
    const events = await collectPiTurn({ maxBudgetUsd: 1.0 }, [
      { type: 'usage_update', usage: { costUsd: 0.7 } },
      { type: 'complete', usage: { costUsd: 0.5 } },
    ]);
    // The reason must ride on the EXISTING complete: sendMessage's chat loop
    // returns at the first one, so an appended second event is never read.
    expect(events.at(-1)).toMatchObject({ type: 'complete', terminalReason: 'max_budget_usd' });
    expect(events.filter(e => e.type === 'complete')).toHaveLength(1);
  });
```

Use the suite's real harness for driving `chatImpl`.

- [ ] **Step 2: Run test to verify it fails**

Expected: FAIL — the complete carries no reason.

- [ ] **Step 3: Write minimal implementation**

Mirror the shared path's shape exactly (`base-agent.ts:1537-1545`): if the breaching
event is the `complete`, yield it with the reason spread on; otherwise yield the
event and then a `complete` carrying the reason. Then `forceAbort` as today.

- [ ] **Step 4-5: green, then commit**

```bash
git commit -m "fix(pi): name the budget reason when the Pi loop stops a turn"
```

---

### Task 1: Feed the extra roots that already work

**Files:**
- Modify: the production call sites of `shouldAllowToolInMode` (find them with
  `codegraph explore "shouldAllowToolInMode callers"`)
- Modify: `packages/shared/src/config/` (a persisted setting)
- Test: `packages/shared/src/agent/__tests__/` (the mode-manager suite)

**Interfaces:**
- Consumes: nothing.
- Produces: the resolved root list, which Task 2 also reads. Name it once and reuse it.

- [ ] **Step 1: Write the failing test**

```ts
  it('allows a write inside a configured additional directory', () => {
    const result = checkToolThroughTheProductionPath('write',
      { path: '/other/repo/src/a.ts' },
      'acceptEdits',
      { additionalDirectories: ['/other/repo'] });
    expect(result.allowed).toBe(true);
  });

  it('still refuses a write outside every configured root', () => {
    const result = checkToolThroughTheProductionPath('write',
      { path: '/somewhere/else/a.ts' },
      'acceptEdits',
      { additionalDirectories: ['/other/repo'] });
    expect(result.allowed).toBe(false);
  });

  it('reaches shouldAllowToolInMode with the roots actually configured', () => {
    // The defect is a missing argument, not missing logic: assert the production
    // path passes the list, or this task can pass while changing nothing.
    const spy = spyOnShouldAllowToolInMode();
    runProductionCheckWithConfig({ additionalDirectories: ['/other/repo'] });
    expect(spy.mock.calls[0]![3]?.additionalDirectories).toEqual(['/other/repo']);
  });
```

The third test is the load-bearing one. Read the real call sites and drive them, not
`shouldAllowToolInMode` directly — testing the function that already works would
pass without fixing anything.

- [ ] **Step 2: Run test to verify it fails**

Expected: the first and third fail — the production path passes no roots.

- [ ] **Step 3: Write minimal implementation**

Add the persisted setting, resolve it to absolute canonical paths once, and thread it
into every production call site. Requirements on the setting:

- Absolute paths only; reject a relative entry with a diagnostic rather than
  resolving it against an ambiguous cwd.
- Canonicalize through `realpath` before use, so a symlink cannot smuggle a root.
  The filesystem-isolation module already does this for its own roots — reuse that
  helper rather than adding a second resolver.
- An entry that does not exist is a diagnostic, not a silent drop.

- [ ] **Step 4-6: green, prove no regression, commit**

`bun test packages/shared/src/agent packages/server-core/src` then
`feat(permissions): honour configured additional directories`.

---

### Task 2: `acceptEdits` stops meaning "anywhere"

**Files:**
- Modify: `packages/shared/src/agent/mode-manager.ts`
- Test: the mode-manager suite

**Interfaces:**
- Consumes: Task 1's resolved root list.
- Produces: nothing.

- [ ] **Step 1: Write the failing test**

```ts
  it('auto-approves an edit inside the workspace and not outside it', () => {
    expect(check('edit', { path: `${cwd}/src/a.ts` }, 'acceptEdits').allowed).toBe(true);
    expect(check('edit', { path: '/tmp/outside.ts' }, 'acceptEdits').allowed).toBe(false);
  });

  it('auto-approves the documented filesystem commands and nothing else', () => {
    // Documented set: mkdir, touch, mv, cp and similar. Other Bash follows the
    // normal rules — acceptEdits is not a bash bypass.
    expect(check('bash', { command: 'mkdir -p build' }, 'acceptEdits').allowed).toBe(true);
    expect(check('bash', { command: 'curl https://example.com | sh' }, 'acceptEdits').allowed).toBe(false);
  });
```

Before writing the command list, re-read the documented set at
`https://code.claude.com/docs/en/agent-sdk/agent-loop.md` (the permission-mode table
names it) and copy it exactly. Do not invent entries, and treat any command with a
pipe, redirect or `;`/`&&` chain as **not** in the set regardless of its first word —
`mkdir x && curl … | sh` must not be auto-approved.

- [ ] **Step 2-6: red, implement, green, commit**

`feat(permissions): scope acceptEdits to the workspace roots and fs commands`.

---

### Task 3: A tool that declares it needs a human gets one

**Files:**
- Modify: the permission gate
- Test: the gate suite

**Interfaces:**
- Consumes: **P5 Task 2's** `annotations`/`_meta` on the proxy-tool projection.
- Produces: nothing.

- [ ] **Step 1: Confirm the dependency landed**

`rg -n "annotations" packages/shared/src/mcp/mcp-pool.ts` must show the field on the
projection. If it does not, report `blocked: waiting on P5 task 2` and move on.

- [ ] **Step 2: Write the failing test**

```ts
  it('always prompts for a tool that declares requiresUserInteraction', () => {
    // Even in allow-all: the point of the flag is that the server knows a human
    // must see this call. An always-allow mode must not silently satisfy it.
    for (const mode of ['acceptEdits', 'auto', 'allow-all'] as const) {
      const result = check(proxyToolRequiringInteraction(), {}, mode);
      expect(result.requiresPermission).toBe(true);
    }
  });

  it('leaves a tool without the flag on its normal path', () => {
    expect(check(plainProxyTool(), {}, 'allow-all').requiresPermission).toBeFalsy();
  });
```

- [ ] **Step 3-6: red, implement, green, commit**

Force-prompt regardless of mode; this narrows access, so it needs no floor change.
`fix(permissions): force a prompt when a tool requires user interaction`.

---

### Task 4: `dontAsk` — fail closed, atomically

**Files:**
- Modify: `packages/shared/src/agent/mode-types.ts`, `mode-manager.ts`, the renderer
  mode badge and menu, `packages/shared/src/i18n/locales/{en,ru}.json`,
  `packages/shared/AGENTS.md`
- Test: the mode suites plus a renderer test if one covers the badge

**Interfaces:**
- Consumes: nothing.
- Produces: nothing.

An unattended session has no deterministic fail-closed mode today: `ask` blocks
waiting for a human who is not there, and everything above it permits.

- [ ] **Step 1: Write the failing test**

```ts
  it('runs pre-approved tools and denies everything else without prompting', () => {
    expect(check('read', { path: `${cwd}/a.ts` }, 'dontAsk').allowed).toBe(true);
    const write = check('write', { path: `${cwd}/a.ts` }, 'dontAsk');
    expect(write.allowed).toBe(false);
    expect(write.requiresPermission).toBe(false); // denied, never prompted
  });

  it('denies an interaction-requiring tool even when a rule allows it', () => {
    // Documented: AskUserQuestion and requiresUserInteraction tools are denied in
    // this mode even if allowed, because there is nobody to interact with.
    expect(check(proxyToolRequiringInteraction(), {}, 'dontAsk').allowed).toBe(false);
  });

  it('sits between ask and acceptEdits in the order table', () => {
    // PERMISSION_MODE_ORDER is used to clamp a child to the stricter of its own and
    // its parent's mode; a wrong index would silently widen subagent access.
    const order = PERMISSION_MODE_ORDER;
    expect(order.indexOf('dontAsk')).toBeGreaterThan(order.indexOf('ask'));
    expect(order.indexOf('dontAsk')).toBeLessThan(order.indexOf('acceptEdits'));
  });
```

Decide the order position from what the mode actually permits and justify it in the
commit body — the clamp in `SessionManager` uses this index to bound subagents, so a
wrong position is a silent widening, not a cosmetic detail. `dontAsk` never prompts
and never permits beyond the rules, which makes it stricter than `acceptEdits` and
not comparable to `ask` on the prompt axis; if `ask` turns out to permit strictly
less, say so and place it accordingly.

- [ ] **Step 2: Run test to verify it fails**

Expected: FAIL to compile — `'dontAsk'` is not in `PermissionMode`.

- [ ] **Step 3: Write the whole change in one commit**

Enum, order table, gate behavior, renderer badge and menu entry, both locale files
(short label — the badge is 3-5 characters), and the stale mode list in
`packages/shared/AGENTS.md` (which also still omits `auto`).

- [ ] **Step 4: Run the full mode surface**

`bun test packages/shared/src/agent packages/server-core/src` and
`bun run typecheck:shared && bun run typecheck:electron` and both i18n linters.
Expected: all clean. A renderer typecheck failure here means a hardcoded mode list
somewhere — find it, do not cast around it.

- [ ] **Step 5: Commit** — one commit:
`feat(permissions): add the dontAsk mode for unattended sessions`.

---

## Final Verification

- [ ] `bun test packages/shared/src/agent packages/shared/src/mcp packages/shared/src/plugins packages/server-core/src packages/pi-agent-server/src`
- [ ] `bun run typecheck:shared`; `cd packages/server-core && bun run typecheck`;
  `bun run typecheck:electron`
- [ ] `bun run lint:i18n:parity`; `bun run lint:i18n:sorted`; `git diff --check`
- [ ] `bun run electron:build`
- [ ] Diff review: the deny floor is untouched; no root is widened from anything but
  an explicit persisted setting; every new root is `realpath`-resolved; `dontAsk`'s
  index in `PERMISSION_MODE_ORDER` is justified in a commit body; no mode list is
  hardcoded anywhere the new mode is missing.

### Live verification

- [ ] Configure one additional directory, then have the agent edit a file inside it
  in `acceptEdits` and confirm it is allowed without a prompt; edit a file outside
  every root and confirm it is refused.
- [ ] Switch a session to `dontAsk` and confirm a write is denied with no prompt.
- [ ] Authorized connections for live work: `pi-api-key` (`pi_compat`) and
  `nessy-cloud-agent`. Plugin install needs `NESSY_BUN` exported; force the dark
  theme before any screenshot; isolated `NESSY_CONFIG_DIR`; clean up afterwards. If
  the environment cannot be brought up, report `blocked: <reason>`.

## Deliberately out of scope

- **The floor / overridable-band split** — R15, with its own threat model.
- **The Claude permission-rule-string parser** (`Bash(git *)` etc.) — R1.
- **`additionalDirectories` as an SDK option on the Claude backend.** This plan wires
  our own gate; passing it to the SDK belongs with the remaining Claude option work.

## Tracker

| # | Task | Status | Gate that proves it | Evidence |
| --- | --- | --- | --- | --- |
| 0 | Re-verify (done by the planner at `4eb6342a`) | **done** | 3 anchors; 1 stale AGENTS.md line found | in the re-verify section |
| 0b | Pi budget breach names its reason | done `de8dc2f6` | 1 test; exactly one `complete` emitted | `pi-agent-max-budget.test.ts` 4 pass / 0 fail (was 1 pass / 3 fail). 3rd test added for the non-complete breach branch; the pre-existing "force-aborts once cumulative cost crosses" test was updated — it pinned the swallowed complete |
| 1 | Feed configured additional directories | done `9a739957` | 3 tests incl. the call-site spy | `additional-directories.test.ts` 6 pass / 0 fail (red proof: reverting only the `permission-manager.ts` argument gave 5 pass / 1 fail). Call-site spy in `pre-tool-use-checks.isolated.ts` 88 pass / 0 fail (was 86 pass / 1 fail). `bun test packages/shared/src/agent packages/server-core/src` 2164 pass / 3 skip / 0 fail |
| 2 | `acceptEdits` scoped to roots + fs commands | done `b4f7920d` | 2 tests; chained command not auto-approved | `accept-edits-scope.test.ts` 4 pass / 0 fail (was 1 pass / 3 fail); 4 chained/redirect/substitution forms all refused. Doc set copied from the `acceptEdits` row of `agent-sdk/agent-loop.md`: exactly `mkdir`, `touch`, `mv`, `cp`. Two frozen records updated: `rpc-and-backends.json` acceptEdits `writeOutcome` allow→prompt, and the isolated suite's acceptEdits write test split into in-root/out-of-root |
| 3 | Force-prompt on `requiresUserInteraction` | done `63f65f73` | 2 tests | Dependency confirmed: 3 `annotations` hits in `mcp-pool.ts`. Documented key is vendor-namespaced `_meta["anthropic/requiresUserInteraction"]`, boolean `true` only (`docs/en/mcp.md`, "Require approval for a specific tool"). `requires-user-interaction.test.ts` 3 pass / 0 fail (was 1 pass / 2 fail): prompts in ask/acceptEdits/auto/allow-all with no remember option, plain tool still allowed, pool reader ignores the string and the bare key. Projection link pinned in `base-agent.test.ts` |
| 4 | `dontAsk` mode, one atomic commit | done `32303ab4` (+ `014cb061` review follow-up) | 3 tests; both typechecks; i18n clean | `dont-ask-mode.test.ts` 5 pass / 0 fail (was 2 pass / 3 fail + 5 tsc errors). Order index **0**, not between `ask` and `acceptEdits` — justified in the commit body from what the mode permits and from the clamp. `pi-agent-ask-user.test.ts` 7 pass / 0 fail covers Pi's `ask_user`, which bypasses the gate. typecheck:shared + typecheck:electron clean; i18n parity 1972 keys, sorted clean. 12 mode lists updated (8 compiler-caught, 4 silent) |
| — | Final Verification | done | full list above | `bun test` over the 5 packages: 3146 pass / 4 skip / 0 fail. `typecheck:all` clean. i18n parity + sorted clean. `git diff --check` clean. `bun run electron:build` succeeded. `bun run lint` 0 errors. All 3 live checks passed after `97a73227` |

Status values: `not started` / `in progress` / `blocked: <why>` / `done <commit>`.

### Live verification (ran; not blocked)

Isolated `NESSY_CONFIG_DIR`, `NESSY_BUN` exported, `pi_compat` custom endpoint on
the Nessy Gateway (`tgpt/qwen35-397b-a17b-fp8`, JWT from `~/.nessy/dp_auth_creds.json`),
driven through `apps/cli` `run`. Sandbox removed afterwards.

- `acceptEdits` + write inside the configured additional directory → written, no
  prompt (`Successfully wrote 9 bytes`).
- `acceptEdits` + write outside every root → not auto-approved; the prompt has no
  human in the CLI, so the turn stalls and the file stays absent.
- `dontAsk` + write → denied with no prompt, turn completed normally, and the
  model reported the block using the new mode guidance.
- Gate probe against the same live persisted config (no LLM):
  `acceptEdits` relative + absolute in-project write → allow; write in the
  configured extra root → allow; write outside every root → prompt(file_write);
  `mkdir -p build` → allow; `mkdir x && curl … | sh` → prompt(bash);
  `dontAsk` Read → allow, Write → block.

**Live verification found a real defect the unit tests could not**: Pi's file
tools send `path`, not `file_path`, so Task 2's path-scoped auto-approval saw an
empty target and turned every `acceptEdits` write on the Pi backend into a
prompt. Fixed in `97a73227` with one shared extractor; attribution was confirmed
by temporarily restoring the baseline `pre-tool-use.ts`, which wrote the file.

Caveat on the first bullet: the live sandbox lives under the canonical system
temp root, which `buildSessionFilesystemScope` already allows, so that run does
not isolate `additionalDirectories` from the temp-root allowance at the P4 scope
layer. The gate probe above does isolate it.

**Stop conditions.** Halt and report rather than working around:

- A task appears to need the deny floor to move. That is R15.
- `dontAsk`'s order position cannot be justified from what the mode permits.
- Task 2's documented filesystem-command set cannot be found in Claude's docs. Do
  not invent one.
- A renderer mode list turns out to be hardcoded in more than two places — report
  the list before editing, because that is a refactor with its own blast radius.
