# B3 — Isolation hardening

Parity row **B3**. Seven named sub-items, and they are genuinely independent —
this is the most splittable row left. **Two I have already checked for you:**

- **The startup capability probe is NOT done.** The row said "check whether P10
  already did it"; I checked — `capabilityProbe`/`startupProbe` have zero
  occurrences outside tests. It is real work.
- **`isolated-code` is already an honest deferral.** `isolation.ts` throws and
  `isolation-remediation.ts` returns "the isolated-code profile is not
  implemented on any platform; use `workspace` for a write-scoped run or
  `read-only` for a scratch-only one". So the row's "implement or formally
  retire" is cheap on the retire side — see Task 4, which needs an owner
  decision, not a build.

---

## 0. Method rules

1. **Fetch the pages yourself** with `curl -s`:
   `https://code.claude.com/docs/en/sandboxing.md` and
   `.../sandbox-environments.md`. **Read both** — S12 established that either one
   alone gives a wrong answer, because `sandboxing.md` names the proxy design and
   `sandbox-environments.md` names the primitives it is not. Never a summarising
   fetch tool.
2. **The quotation is the identifier, not the line number.** Read the whole line.
3. **Declared ≠ enforced.** Name the consumer and prove it runs on **Pi**.
4. **Two git commands** — pathspec on the `commit`.
5. Expected pre-existing failures:
   `docs/superpowers/specs/2026-07-29-known-failing-tests.md`; short three times,
   wrong once the other way. Reproduce on a clean `git worktree`, never
   `git stash`. A worktree needs its `node_modules/@nessy-agent/*` links
   repointed at the worktree's own packages, or a typecheck resolves back into
   the real repo — that cost an executor a wrong reading today.
6. **`rg` skips NUL-containing files silently; eight of ours have one** — tracker
   note 11a; use `grep -a`.
7. **S12 just landed in this neighbourhood** (`c563aae8`, `31154607`,
   `813fd3fe`): `sandbox.network` now binds, `allowManagedDomainsOnly` is a total
   egress deny, and the doctor renders the effective policy. Read that diff
   before touching isolation composition, and reuse its seams rather than adding
   parallel ones.

---

## 1. Tasks

### Task 1 — the write-deny set, with symlinks resolved

**Commit:** `feat(sandbox): deny writes to our own config and the Windows system set`

The row asks for the Windows and self-config write-deny set **with symlink
resolution**. The symlink half is the whole difficulty: a deny list that matches
on the path as written is bypassed by a symlink pointing into the denied
directory, which is precisely the class S7 fixed for rewind (`lstat`, `nlink`,
no `O_NOFOLLOW`-less writes). **Read `sessions/file-checkpoints.ts`'s
link-safety layer before designing this** — the reasoning transfers even though
the mechanism differs.

State the per-platform story. A deny that binds on macOS and silently no-ops on
Windows is the defect S12 was written to remove, wearing a different hat.

**Gate:** a write to the denied path is refused; a write **through a symlink** to
the same path is also refused; a write to a sibling path is permitted. The middle
case is the one that fails today.

---

### Task 2 — shared `.git` when the root is a linked worktree

**Commit:** `feat(sandbox): a linked worktree can write the shared git directory`

When the workspace root is a linked worktree, `.git` is a **file** pointing at
the real directory elsewhere, so a write-scope confined to the workspace root
breaks ordinary git operations. Grant the shared directory, and no more than it.

**Gate:** build a real linked worktree in a temp directory you created, and show
a git write succeeding under the composed profile while a write outside both the
worktree and the shared git directory is still refused.

---

### Task 3 — per-workspace config dir, and the concurrency ceiling

**Commit:** `feat(sessions): per-workspace config isolation and a live-agent ceiling`

Two items, one commit, because both are about one workspace not reaching another.

- **Per-workspace `CLAUDE_CONFIG_DIR`.** We already redirect it per plugin
  (`plugins/data-paths.ts`: `codexCompatPluginEnv`/`claudeCompatPluginEnv` set
  `CLAUDE_CONFIG_DIR` to the managed data path). Find whether a *workspace*-level
  redirect exists and, if not, add it in the same shape.
- **The live-agent concurrency ceiling with LRU eviction.** Decide what happens
  to an evicted agent mid-turn — **eviction that silently drops a turn is worse
  than refusing to start one.** Say which you chose.

**Gate:** two workspaces do not see each other's config; the ceiling evicts the
least-recently-used agent and the user learns that it happened.

---

### Task 4 — `isolated-code`, and seccomp: decide, do not guess

**Commit:** `docs(sandbox): the isolation items we do not build, and why`

Neither of these should be built blind.

- **`isolated-code`** already refuses with a useful message naming the two
  working alternatives. **Do not implement it in this unit.** Write the case for
  retiring versus building — what it would give us that `workspace` and
  `read-only` do not — and leave the decision to the owner as a category string.
- **seccomp `AF_UNIX` on Linux.** We develop on macOS; you cannot verify a
  seccomp filter here. **Do not ship an unverifiable filter.** Either implement it
  behind a test that runs only on Linux and say it is unverified locally, or
  record it as `documented, not implemented — unverifiable on the development
  platform` with what verifying it would take.

The honest outcome for this task may be entirely category strings. That is a
result, not a failure.

**Unwrapped, unbolded, backtick-terminated**, then confirm:
`python3 scripts/regenerate-deviation-register.py | grep -iE "isolat|seccomp"`.

---

## 2. Gate

Focused suites for every changed file, plus the sandbox, pi-harness, config and
session aggregates; `bun run typecheck:all`; `bun run lint`; i18n if you add
strings; `git diff --check`.

**Isolation and process lifecycle are named risk triggers.** Run the expanded set
once on the final diff.

**Run every test from the repository ROOT.**

**Never build a symlink or worktree outside a temp directory you created**, and
never point a probe at a real external host.

**Mutation probe** per task; for Task 1 specifically, remove the symlink
resolution and the middle case must go red.

---

## 3. Constraints

- One commit per task, subjects exactly as given. **No `Co-Authored-By` trailers.**
  If a review finding forces an extra commit, take it and say so.
- No push, MR or tags. No `reset`, `rebase`, `--amend`. Never `git checkout --`
  or `git stash` a file you are editing.
- Pathspec on the commit itself.
- **Two other agents are working concurrently**: one on telemetry
  (`agent/backend/*/event-adapter.ts`, server-core bootstrap), one in
  `agent/backend/nestor-cloud/`. Stay out of both.
- Do not touch `docs/superpowers/specs/` or `docs/testing/cdp-live-checklist.md`
  (planner-owned), nor `~/.nessy-agent/skills/r17-*` or
  `~/.nessy-agent/mcp/elicit-server.mjs` (CDP fixtures).
- No version bumps, no release notes. Never write to `~/.nessy/dp_auth_creds.json`.
- Code, comments and commits in English.

## 4. Report

Commit shas; the line you found each quotation at; **every correction to this
plan**; the per-platform story for Tasks 1 and 2; what you chose for mid-turn
eviction; the `isolated-code` and seccomp recommendations with their reasoning;
the category strings with proof they appear in the register; and the mutation
probes.

---

## 5. Task 4 outcome — the two we do not build

Both recommendations are **do not build**, and neither is a shrug. The case for
each is below, then the category string the register picks up.

### 5a. `isolated-code` — retire it, and route what it names elsewhere

**What it promises.** The throw reason is the whole specification:
`declared-input-read-boundary`. `isolated-code` is the only profile that would
bound *reads* — everything else bounds writes and leaves reads ambient, which
`credential-deny-roots.ts` states outright ("no isolation profile restricts
reads") and which the backend strings say literally (`host-read:`).

**What it would give us that `workspace` and `read-only` do not.** Exactly one
thing, and it is a real thing: running code we did not write — a downloaded skill,
a marketplace plugin script — without letting it read `~/.aws`, browser cookies,
or a `.env` anywhere on disk. Today the only protection is an enumerated deny
list, and the register already records the measurement that this is not enough:
a re-probe on 2026-07-29 under the real composed profile found Chrome
`Default/Cookies`, `~/.docker/config.json` and `~/.gitconfig` readable, with only
`~/.ssh` and `~/.aws` blocked.

**Why a fifth profile is still the wrong shape for it.** Two reasons, and the
second is the decisive one.

1. Upstream does not solve this with a profile. `sandbox-environments.md:24`
   assigns the whole-process boundary to the sandbox runtime, and `:78` says that
   to put "built-in tools, MCP servers, and hooks all behind one OS boundary" you
   run the whole process inside the runtime, a dev container or a custom
   container. `:82` adds that the runtime "denies all write and network access by
   default" — a posture, not a per-command opt-in. The nearest thing upstream has
   to `isolated-code` is a *deployment choice*, and we already have the same
   choice available.
2. The leak is in the **default** posture. A profile only some callers ask for
   leaves every other command reading the whole disk, so the fifth profile would
   make the audit row green while the measured leak stayed exactly where it is.
   The register's own conclusion on that row is the one to follow: "A credible
   floor needs an allowlist read posture, not a longer deny list."

**So: retire.** Concretely, for the owner — remove `isolated-code` from
`ProcessIsolationProfile` and from the child-request allowlist at
`pi-agent.ts:4957`, which today lets a Pi subprocess ask for a profile that has
never once succeeded, and keep `PROBED_ISOLATION_PROFILES` reporting it as
unavailable until the union changes so the Settings panel does not silently lose
a row. Not done here: the union is a wire type, and this task was scoped to the
decision.

Unwrapped, unbolded, backtick-terminated:

`documented, not implemented — sandbox-environments.md:24 and :78 put the whole-process boundary in the sandbox runtime or a container, never in a fifth per-command profile. isolated-code promises the declared-input READ boundary no backend has, and the leak it would answer sits in the DEFAULT read posture, which an opt-in profile leaves exactly where it is. Retire it in favour of the read-allowlist posture`

### 5b. seccomp `AF_UNIX` on Linux — documented, not built, and not guessed

**What the contract is.** `sandboxing.md:80` — "The seccomp filter is optional and
adds Unix domain socket blocking. Install it with
`npm install -g @anthropic-ai/sandbox-runtime` if it is missing."
`:459` is stronger — "the seccomp filter is required to block Unix domain
sockets" — and `:474` names the stake: "allowing access to
`/var/run/docker.sock` effectively grants access to the host system through the
Docker socket." `:112` shows the same mechanism from the other side: on WSL2 a
sandboxed command cannot launch `cmd.exe` because "WSL hands these off to the
Windows host over a Unix socket, which the sandbox blocks."

**Where we stand.** `applyFilesystemIsolation`'s bwrap argv is `--die-with-parent`,
`--ro-bind / /`, a writable bind per root, `--proc`, `--dev`. No `--seccomp`. The
filesystem-mediated half is *incidentally* narrowed — `connect()` on a Unix
socket needs write permission on the socket inode, and the whole tree is
read-only bound — but Linux's **abstract** namespace is not filesystem-mediated at
all and is unaffected by anything in that argv, because bwrap only isolates it
under `--unshare-net`, which the `networked` profile by definition does not take.

**Why it is not shipped here.** The development platform is macOS, so a filter
written here would be a filter nobody has run. That is the exact defect S12 was
written to remove — a security key that binds nothing — wearing the opposite hat,
and it would be worse than the gap because the capability probe would start
reporting a protection that was never measured. Upstream treats the filter as
optional and surfaces its absence as a Dependencies-tab row rather than a hard
failure (`sandboxing.md:82`), so the honest posture is the same: say it is
missing, do not pretend.

**What verifying it would take**, so the next agent does not re-derive it: a Linux
host or CI runner with `bubblewrap`; a compiled BPF program passed on a file
descriptor via `bwrap --seccomp`; and a test that proves three things rather than
one — that a filesystem socket is refused, that an ABSTRACT socket is refused, and
that `dbus`, `nscd` and the CLIs that dial a socket for DNS or credentials still
work under the filter. The third is the one that decides whether the filter is
shippable, and it cannot be answered from macOS at all.

Unwrapped, unbolded, backtick-terminated:

`documented, not implemented — sandboxing.md:80 makes the seccomp filter the only thing that blocks Unix domain sockets and ships it as an optional npm helper, and :474 names docker.sock as the escalation it stops. Our bwrap argv passes no seccomp option, and the abstract namespace is unreachable by ro-bind. Unverifiable on the development platform: proving it needs a Linux host`
