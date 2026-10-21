# S16 — Two safety floors: unfiltered `mach-lookup`, and protected paths

From the re-verification sweep (`2026-07-30-reverification.md`). Both are floors
that should exist and do not. The first is probe-proven and reads the user's
clipboard.

---

## 0. Finding 1 — `(allow mach-lookup)`, unfiltered, in every darwin profile

`session-tools-core/src/runtime/filesystem-isolation.ts:70` emits
`(allow mach-lookup)` **unconditionally** for `read-only`, `workspace`,
`networked` and `plugin-mcp` alike — and `:94` emits it a **second time** in the
network branch, whose own comment claims the network profile "must opt those
operations back in explicitly" when `:70` already granted it to everything.

**The probe, which is the finding:** `sandbox-exec -p '<our profile>'
/usr/bin/pbpaste` returns **0**. The identical profile with those two lines
removed returns **1**.

So a sandboxed command reaches any system mach service by name. Demonstrably the
pasteboard — **whatever the user last copied, which is where passwords go** — and
by the same grant `com.apple.coreservices.launchservicesd`.

`mach-lookup` appears **nowhere** in this audit's specs or plans before today.

## 1. Finding 2 — protected paths do not exist

The quoted sentence below is the load-bearing anchor and the reason a deny rule
cannot substitute; the number is a convenience and is the 2026-08-23 fetch's
`permission-modes.md:541` (this row's original `:443` is a blank line there):

> `permissions.allow` rules in settings files do not pre-approve protected-path
> writes. The safety check runs before Claude Code evaluates allow rules from
> settings, so an entry such as `Edit(.claude/**)` … does not change the per-mode
> outcome in the table above.

Ten directories (`.git`, `.config/git`, `.vscode`, `.idea`, `.husky`, `.cargo`,
`.devcontainer`, `.yarn`, `.mvn`, and `.claude` **except** `.claude/worktrees`) and
~30 files: every shell rc and profile plus `.envrc`, `.npmrc`/`.yarnrc`/
`.yarnrc.yml`/`.pnp.cjs`/`.pnp.loader.mjs`/`.pnpmfile.cjs`/`bunfig.toml`/
`.bunfig.toml`, `.bazelrc`/`.bazelversion`/`.bazeliskrc`,
`.pre-commit-config.yaml` and four lefthook spellings,
`gradle-wrapper.properties`, `maven-wrapper.properties`, `.devcontainer.json`,
`.ripgreprc`, `pyrightconfig.json`, `.mcp.json`, `.claude.json`, plus
`.gitconfig`/`.gitmodules`.

Searched as a **concept**, not a name: no permission-gate consumer exists. The
per-mode table at `:435`-`:442` is the behaviour to match, and note that
`dontAsk` **denies** where `bypassPermissions` allows — the two are not the same
answer.

---

## 2. Method rules

1. **Fetch the pages yourself** with `curl -s`:
   `https://code.claude.com/docs/en/permission-modes.md`, `.../permissions.md`,
   `.../sandboxing.md`. Never a summarising fetch tool.
2. **Reproduce both findings first.** The `mach-lookup` one has a one-line probe;
   run it. For protected paths, confirm the absence the way the sweep did — by
   concept, with `grep -a`, not one guessed identifier.
3. **The quotation is the identifier.** Read the **whole line**: `:443` is the
   second sentence of a paragraph whose first sentence sounds weaker.
4. **Declared ≠ enforced.** Prove on **Pi**.
5. **Two git commands** — pathspec on the `commit`.
6. **A CDP dev instance may be on port 9223.** Do not kill or drive it.

---

## 3. Task 1 — narrow `mach-lookup`

**Commit:** `fix(sandbox): a sandboxed command cannot reach arbitrary mach services`

- **Do not simply delete the grant.** Something needed it; find out what. A
  profile that denies every mach service may break ordinary commands, and a
  sandbox that breaks `git` gets switched off, which protects nothing. Establish
  the minimum set the shell genuinely needs and allow that by name.
- **Remove the dead duplicate** at `:94` and fix the comment that misdescribes it.
- **Per-platform:** say what this means on Linux and Windows. If the concept has
  no counterpart, say so rather than leaving the reader to assume parity.
- **This interacts with `SEATBELT_TESTING_WILDCARD`**, which the owner reaffirmed
  as on. With the wildcard on, the whole profile is permissive — so state plainly
  whether your fix has any effect today, or whether it only takes effect at the
  pre-GA flip. **A fix that cannot act yet is still worth landing, but it must not
  be reported as closing the exposure.**

**Gate:** the probe inverts — `pbpaste` under the composed profile is refused —
and a command that legitimately needs a mach service still works. Name that
command in the report.

---

## 4. Task 2 — the protected-path floor

**Commit:** `feat(permissions): protected paths are refused above allow rules`

Build the floor. Requirements, each from the page:

- It runs **before** allow-rule evaluation. An `allow` entry naming a protected
  path must not change the outcome — that is the whole point, and it is what
  makes this different from a deny rule.
- **Per-mode outcomes differ**: `default`/`acceptEdits` prompt, `plan` prompts,
  `auto` routes to the classifier, **`dontAsk` denies**, `bypassPermissions`
  allows. Do not collapse them into one answer.
- `.claude/worktrees` is a **documented exception** inside a protected directory.
  Our equivalent is `.nessy-agent`; decide and state how the mapping works, since
  our config directory has a different name and layout.
- Reuse the `nonNegotiable` shape S4 used for the removal circuit breaker where
  the mode demands a prompt that survives — but **not** blindly: unlike that
  breaker, this floor is explicitly *allowed* under `bypassPermissions`.

**Gate:** a write to a protected path is refused or prompted per its mode; **an
`allow` rule naming that same path does not change the outcome**; a write to
`.claude/worktrees`'s equivalent is permitted; and a sibling path is unaffected.
The second assertion is the one that proves the floor is a floor.

---

## 5. Task 3 — what stays open

**Commit:** `docs(sandbox): the mach and protected-path surfaces we do not cover`

Category strings for anything left — in particular any mach service you had to
keep, and any protected entry whose Nessy equivalent is genuinely ambiguous.

**Unwrapped, unbolded, backtick-terminated, no inline backticks in the reason,
under 400 characters** — five ways of losing half a register row have been found.

### Result — the surfaces S16 leaves open, measured on HEAD

Every string below was written after running the path, not after reading a field
name. The two `implemented` rows are here because a reader of this section would
otherwise assume the opposite.

The mach surface. Ten global-names were requested by the probe battery; nine are
granted, and the tenth is the pasteboard.

1. The one allowlisted name no probe requested.
`documented, not implemented — com.apple.trustd is the system-scope endpoint of the same daemon as com.apple.trustd.agent, and the case that needs it, validating a chain that terminates in the system trust store, cannot be probed without reaching an external host, so it is kept on documented need rather than proven by a run`

2. The narrowing in the Bash profile is inert today.
`documented, not implemented — buildMacosBashSeatbeltProfile returns allow default while SEATBELT_TESTING_WILDCARD is true, so its filtered rule denies nothing until the pre-GA flip; the session-tools-core profile has no wildcard branch, and it is the one the supervised-process isolation and script_sandbox compose, so there the narrowing binds now`

3. The keychain is now refused, and used not to be.
`documented, not implemented — com.apple.SecurityServer stays denied, probe-confirmed against a nonexistent keychain item, so a keychain credential helper such as git credential-osxkeychain fails inside these profiles; the bare grant permitted it, and granting it back would defeat the credential deny roots this package already emits`

4. The other two backends.
`documented, inapplicable — mach is a darwin concept with no counterpart elsewhere: bubblewrap and firejail confine the mount namespace and expose no name-based IPC broker, and the Windows profile has no IPC section, so a D-Bus socket is reached only through the filesystem the mount policy already governs`

The protected-path surface.

5. A shell redirect is not covered.
`documented, not implemented — the floor covers the file-write tools only, since the documented mechanism is a file-write prompt; a shell redirect into a protected path is governed by the sandbox deny roots in isolation/self-config-deny.ts, which name the config directories but not the shell rcs, the wrapper properties or .npmrc`

6. There is no session-scoped grant, which is stricter than documented.
`documented, not implemented — permission-modes.md:527 second half offers Yes, and allow Claude to edit its own settings for this session, which approves later .claude writes without asking again; this floor carries no don't-ask-again at all, so it is stricter than the page and closing it needs a session-scoped grant channel`

7. The `plan` row's two sub-cases are a deliberate refusal, no longer a missing capability.
`documented, inapplicable — permission-modes.md:522 gives plan three outcomes and this floor always takes the third, a prompt, which is the strictest; both conditional ones now have session state behind them (bypassPermissionsAvailable and getUseAutoModeDuringPlan) but neither is read here, because planClassifierEligible admits only the removal breaker's classifier-adjudicated prompt`

**Item 7 restated 2026-08-25 (P2.68/P2.70), because its premise was refuted by
the code rather than by a re-fetch.** The 2026-07-30 string said "there is no
bypass-permissions-available flag and no auto-mode-available-during-planning
notion". Both now exist: `pi-agent.ts`'s `bypassPermissionsAvailable()` and
`getUseAutoModeDuringPlan()`, added for the critical-path breaker's plan-mode
classifier route (P2.21, owner 2026-08-23). Measured on HEAD: neither predicate
is consulted for a protected-path write, because `planClassifierEligible`'s floor
branch requires `promptIsClassifierAdjudicated`, which the gate stamps on the
removal breaker and nowhere else. So the OUTCOME is unchanged — `plan` prompts —
but the REASON changed from "we cannot tell" to "we decline", and only the second
survives a reader asking why. The line numbers moved with the 2026-08-25 fetch
(598 lines, md5 `44fa3a908750c261d5d5282377350a88`): `:541`→`:527`,
`:536`→`:522`.

8. The `auto` row is honoured through the existing classifier.
`documented, implemented` — a `prompt` result in `auto` IS the borderline band
`pi-agent.ts:3924` consults the guardian judge for, so the floor reaching the
classifier needed no new machinery.

9. No protected entry has an ambiguous Nessy equivalent, and the plan's
expectation that some would was wrong. `.claude.json`, `.mcp.json` and
`.config/git` are kept verbatim; our own configuration files all live inside
`.nessy-agent` or `.agents`, which the directory entries already match, so
`<configDir>/config.json` is covered without a per-file mapping.
`documented, implemented`

---

## 6. Gate

Focused suites for every changed file, plus the permissions, sandbox and
pi-harness aggregates; `bun run typecheck:all`; `bun run lint`; i18n
parity/sorted if you add strings; `git diff --check`.

**Permission decisions and isolation are both named risk triggers.** Run the
expanded set once on the final diff.

**Run every test from the repository ROOT.**

**Never run a probe that reaches an external host**, and never test the protected
paths against the user's real files — build fixtures in a temp directory you
created. **Do not write to any real `.npmrc`, shell rc, or `~/.claude.json`.**

**Mutation probe** per task: for Task 2, remove the pre-allow ordering and the
allow-rule assertion must go red.

---

## 7. Constraints

- One commit per task, subjects exactly as given. **No `Co-Authored-By` trailers.**
- No push, MR or tags. No `reset`, `rebase`, `--amend`. Never `git checkout --`
  or `git stash` a file you are editing.
- **Another agent is working on the session-command seam** (`pi-agent.ts`'s
  `chatImpl`, the renderer's send path). Stay out of those.
- Do not touch `docs/superpowers/specs/` or `docs/testing/cdp-live-checklist.md`
  (planner-owned), nor `~/.nessy-agent/skills/r17-*` or
  `~/.nessy-agent/mcp/elicit-server.mjs`.
- No version bumps, no release notes. Never write to `~/.nessy/dp_auth_creds.json`.
- Code, comments and commits in English.

## 8. Report

Commit shas; the line you found each quotation at; **whether both findings
reproduced**; which mach services you kept and why; whether the fix has any effect
while the seatbelt wildcard is on; how the `.claude/worktrees` exception maps to
our layout; **every correction to this plan**; and the mutation probes.
