# S12 — The sandbox network settings must bind something

From the phase-4 sweep (`2026-07-29-phase4-findings.md`,
`sandbox-environments.md`).

`sandbox.network` — `allowedDomains`, `deniedDomains`,
`allowManagedDomainsOnly` — is fully parsed, length-validated and given careful
anti-widening floor semantics, and its **only** consumer is the Monitor
websocket guard. The shell it is supposed to constrain never sees it.

**This is the recurring defect applied to an admin-facing security key**, in the
same settings file whose filesystem half is fully live and enforced.

---

## 0. Scope, and what is NOT in it

**The open-egress default is an owner decision and this unit does not change
it.** Our foreground shell pins `networked` and the profile grants
`(allow network*)`; that was decided deliberately. What this unit fixes is that
an administrator who writes `sandbox.network` today gets **nothing** —
the keys parse, validate, compose, and bind no command.

So: wire the enforcement, keep the default exactly as it is, and record the
default as the owner decision it is. If the wiring makes a different default
obviously correct, **say so in the report and leave it alone** — that is a
decision for the owner, not for this unit.

The `SEATBELT_TESTING_WILDCARD` flip is likewise out of scope: it is a dated
owner decision marked TEMPORARY and due before GA.

---

## 1. Method rules

1. **Fetch the pages yourself**: `curl -s https://code.claude.com/docs/en/sandbox-environments.md`
   and `.../sandboxing.md`. Never a summarising fetch tool — it invented field
   names twice in this series and both shipped. **Read both**: reading one page
   of a documented pair is how this gap survived, and `sandboxing.md` was read
   while this one was not.
2. **The quotation is the identifier, not the line number.** Report where you
   found each, and read the whole line.
3. **Read around each quotation.**
4. **Declared ≠ enforced.** This unit exists because a parsed key has no
   enforcing consumer. Do not add a second one.
5. **Two git commands** — pathspec on the `commit`.
6. Expected pre-existing failures:
   `docs/superpowers/specs/2026-07-29-known-failing-tests.md`; it has been short
   three times and wrong once the other way.
7. **`rg` silently skips files with a NUL byte; eight of ours have one** —
   tracker note 11a. Use `grep -a` for absence claims.

---

## 2. Tasks

### Task 1 — the network settings reach the shell

**Commit:** `feat(sandbox): the network settings bind the sandboxed shell`

Thread `sandbox.network` from the composed settings to the profile the shell
actually runs under.

- **The floor semantics already exist and are correct** — denies are a minimum,
  grants a maximum, `allowManagedDomainsOnly` is a lock. Reuse
  `resolveSandboxSettings`; do not re-derive composition.
- Establish from the page what a domain rule can express, and be honest in the
  report about what a `sandbox-exec` profile can and cannot enforce. If domain
  filtering is not expressible in the platform primitive we use, **say so and
  implement the part that is** rather than shipping a rule that silently does
  nothing — that is the exact failure this unit is fixing.
- Windows and Linux: state what happens there. A setting that binds on one
  platform and silently no-ops on another is the same defect wearing a different
  hat.

**Gate:** a probe that runs a real command under the composed profile and shows
a denied destination refused and an allowed one permitted. If the platform
cannot express it, the gate is instead a test that the setting produces a
**diagnostic** the user can see, and the report says why.

---

### Task 2 — the user can see what applies

**Commit:** `feat(sandbox): the doctor report shows the effective network policy`

R30b built `nessy-general-agent doctor` and it already renders managed sources
and refused entries. Add the effective sandbox network policy to it, reusing
that rendering.

An administrator whose rule does not bind must be able to find that out from the
app rather than from a packet capture.

**Gate:** the doctor output names the effective policy and its source.

---

### Task 3 — the rest of the page

**Commit:** `docs(sandbox): the sandbox-environments rows we do not implement`

Category strings. The sweep counted 12 findings; verify rather than copy. The
ones already known:

- the first-use network-domain prompt, which our profile replaces with
  `(allow network*)` — record it as the owner decision it is, with the date;
- the ambient reads the sweep proved under our own profile
  (`~/Library/Application Support/Google/Chrome/Default/Cookies`,
  `~/.docker/config.json`, `~/.gitconfig` were all readable while `~/.ssh` was
  correctly blocked) — **this one is worth its own row**; say what a credible
  read floor would have to cover.

**Write the strings unwrapped, unbolded and backtick-terminated**, then confirm:
`python3 scripts/regenerate-deviation-register.py | grep -i sandbox`.

---

## 3. Gate

Focused suites for every changed file, plus the sandbox, config and pi-harness
aggregates; `bun run typecheck:all`; `bun run lint`; `git diff --check`.

**Isolation and process lifecycle are named risk triggers.** Run the expanded set
once on the final diff.

**Run every test from the repository ROOT.** A package-directory run bypasses the
config-dir isolation preload and destroys the user's real
`~/.nessy-agent/config.json`.

**Never run a probe that reaches a real external host.** Use a local listener you
started, or assert on the composed profile text. Nothing in this plan needs live
egress.

**Mutation probe:** remove the threading and the Task 1 gate must go red.

---

## 4. Constraints

- One commit per task, subjects exactly as given. **No `Co-Authored-By` trailers.**
  If a review finding forces an extra commit, take it and say so.
- No push, MR or tags. No `reset`, `rebase`, `--amend`. Never `git checkout --`
  or `git stash` a file you are editing.
- Pathspec on the commit itself.
- **Two other agents are working concurrently**: one in
  `packages/shared/src/plugins/`, one in `packages/shared/src/prompts/`. Stay out
  of both.
- Do not touch `docs/superpowers/specs/` or `docs/testing/cdp-live-checklist.md`
  (planner-owned), nor `~/.nessy-agent/skills/r17-*` or
  `~/.nessy-agent/mcp/elicit-server.mjs` (CDP fixtures).
- No version bumps, no release notes. Never write to `~/.nessy/dp_auth_creds.json`.
- Never log a credentialed URL, token or proxy string.
- Code, comments and commits in English.

## 5. Report

Commit shas; the line you found each quotation at; **every correction to this
plan**; exactly what the platform primitive can and cannot enforce, per
platform; whether the wiring makes a different default obviously correct (say it,
do not do it); the category strings with proof they appear in the register; and
the mutation probe.

---

## 6. Deviations recorded (Task 3)

Every row below was re-verified on `fix/renderer` rather than copied from the
sweep. **The sweep's count of 12 does not survive verification: this page yields
nine substantive rows.** Three of the twelve were already recorded elsewhere —
`autoAllowBashIfSandboxed` and `filesystem.disabled` in
`2026-07-29-deviation-unit-5.md`, and `strictAllowlist`/`tlsTerminate`/
`httpProxyPort` in `2026-07-28-egress-proxy.md` — and several more collapse into
the container and organization-enforcement rows rather than standing alone.

Two things the page describes and we do **better** than it are deliberately not
rows here, because a superset is not a deviation: `sandbox-environments.md:76`
says "MCP servers and hooks are separate processes that run unconstrained on the
host", while ours run under the `plugin-mcp` and `workspace` isolation profiles;
and `:124`'s "Deliver the `sandbox` settings keys through managed settings" is
what the managed policy already does, with S12 making the network half of it
bind a command.

1. The first-use network-domain prompt — `documented, not implemented — sandbox-environments.md:69 has the sandbox prompt "the first time a command needs a new network domain". Our foreground shell pins the networked profile and the darwin profile emits (allow network*), an owner decision of 2026-07-28 restated at packages/pi-agent-server/src/index.ts. S12 wired allowManagedDomainsOnly to a total egress deny; the per-domain layer is R19`

2. The ambient read floor under our own profile — `documented, not implemented — sandbox-environments.md:33 warns isolation "does not eliminate risk. Any approach that allows network egress can still leak data the agent can read". Re-probed 2026-07-29 under the real composed profile: Chrome Default/Cookies, ~/.docker/config.json and ~/.gitconfig were readable, ~/.ssh and ~/.aws blocked. A credible floor needs an allowlist read posture, not a longer deny list`

3. The sandbox runtime as a whole-process wrapper — `documented, inapplicable — sandbox-environments.md:82 wraps the whole Claude Code PROCESS by launching it through npx @anthropic-ai/sandbox-runtime, configured in ~/.srt-settings.json. Nessy Desktop is an Electron app and a headless server, neither of which a user launches through npx, and the process it would wrap is the one holding the user's credentials`

4. The dev container — `documented, inapplicable — sandbox-environments.md:96 defines a dev container as a .devcontainer/ directory a user commits to their own repository, and :125 calls it "a convention rather than an enforcement boundary". It is a repository artifact of the project being worked on, not a feature of the agent working on it; nothing in Nessy could implement it on the user's behalf`

5. Running inside an unprivileged container — `documented, not implemented — sandbox-environments.md:106 -- "Unprivileged containers need the nested-sandbox setting", i.e. enableWeakerNestedSandbox, which makes bubblewrap bind-mount the container's existing /proc instead of a fresh one. We have no such key: resolveLinuxIsolation fails closed with process-isolation-unavailable, so Nessy cannot run inside an unprivileged container at all`

6. The dedicated virtual machine — `documented, inapplicable — sandbox-environments.md:110 is user infrastructure -- a cloud instance, a local hypervisor or a microVM the user provisions and installs the app into. There is no code path an application can take to place itself inside one, and the app is already inside whatever VM the user booted`

7. Claude Code on the web — `documented, inapplicable — sandbox-environments.md:116 is an Anthropic-hosted product: sessions run in Anthropic-managed VMs behind an Anthropic egress proxy, reached with a Claude subscription. Nessy has no hosted execution tier and the gateway it does have is an inference endpoint, not a session host`

8. The `/sandbox` panel — `documented, not implemented — sandbox-environments.md:71 enables the per-command sandbox with /sandbox, whose panel carries Mode, Overrides and Config tabs (sandboxing.md:29). Supervised-process isolation here is unconditional rather than opt-in, so Mode and Overrides have no analogue to toggle; the Config tab's "view the resolved sandbox settings" is what S12 added to nessy-general-agent doctor instead`

9. The native-Windows limitation — `documented, inapplicable — sandbox-environments.md:66 says the sandboxed Bash tool "does not support native Windows" and directs Windows hosts to WSL2 or a container. We ship a native Windows isolation backend instead (resolveWindowsIsolation, a verified Codex restricted-token runner with a host-owned permissions profile), so the row's guidance describes a limitation Nessy does not have`

## 7. What the platform primitive can and cannot enforce

Measured on 2026-07-29, not inferred.

| Backend | Expressible | Not expressible |
| :-- | :-- | :-- |
| macOS Seatbelt (`sandbox-exec`) | all egress on/off; port; `localhost` vs `*` | any hostname, and any IP literal — `(remote ip "github.com:443")`, `(remote tcp "github.com:443")` and `(remote ip "140.82.121.4:443")` are all refused with `host must be * or localhost in network address`; `(remote host …)` and `(remote domain …)` are not filters at all |
| Linux `unshare -n` / `firejail --net=none` | all egress on/off | anything narrower — both are whole-namespace switches |
| Windows Codex restricted token | all egress on/off (`[permissions.…network] enabled`) | anything narrower — the profile has one boolean |

So `sandbox.network` binds a command on **all three** platforms, and binds it to
the same single bit on each. There is no platform where the setting silently
no-ops, and none where a domain list is honoured.
