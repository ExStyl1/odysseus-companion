# D10, D11 — what a sandboxed command can read, and ship

Two rows, one exposure. Every isolation profile grants **ambient
whole-filesystem read** with only additive denies, and the deny list is four
entries long. Under the networked profile — the shipped default for shell — a
prompt-injected repository reads a credential file and ships it to the gateway,
and the first signal is an incident.

D10 is small and buys most of the protection this week. D11 is the architectural
answer and is a quarter, not a sprint. **Do D10 first and completely; treat D11
as a designed increment, not a rewrite attempt.**

## 0. Method rules

1. `curl -s https://code.claude.com/docs/en/sandboxing.md` and `settings.md`.
   Quote WHOLE lines.
2. **Declared ≠ enforced.** Reproduce the exposure before fixing — with a
   PROBE, inside a temp directory you created, never against the user's real
   credential files.
3. **NUL bytes** — always `grep -a`; never `head -N` a grep whose hit count you
   have not counted.
4. **Two git commands** — pathspec on the `commit`. One commit per task.
5. **Run every test from the repository ROOT.** A package-directory run
   destroys the user's real `~/.nessy-agent/config.json`.
6. CDP instances are live on **9223 and 9224** — do not kill, drive or rebuild
   for either. Do not run `electron:build:servers` or `electron:dev`.

---

## 1. Task 1 — the credential deny list covers what an attacker wants (D10)

**Commit:** `fix(sandbox): the credential deny roots cover the files an agent can exfiltrate`

`credentialDenyRoots` is four entries: `credentials.enc`, `~/.ssh`, `~/.aws`,
`~/.nessy`. Under the networked profile the agent still reads **Chrome cookie
stores, `~/.docker/config.json`, `~/.gitconfig` and `~/.netrc`** with open
egress.

- Enumerate from what actually holds credentials on the platforms we ship, not
  from memory. Browser cookie/login stores (Chrome, Chromium, Edge, Firefox,
  Safari), `~/.netrc`, `~/.docker/config.json`, `~/.kube/config`,
  `~/.gnupg`, `~/.config/gh`, `~/.npmrc`, `~/.pypirc`, cloud CLI caches
  (`~/.azure`, `~/.config/gcloud`), and the Windows equivalents. **Say how you
  enumerated** — a list recalled is a list with holes.
- **One shared constant read by both call sites** — the whole point is that the
  two profiles cannot drift. Find both readers before writing the constant.
- **`~/.gitconfig` needs thought, not reflex.** It usually holds no secret but
  can hold a credential helper; and denying it may break `git`. A sandbox that
  breaks `git` gets switched off, and then it protects nothing. Decide, and say
  which way and why.
- **Deny READ, and check whether write matters too** — a writable
  `~/.gitconfig` or `~/.npmrc` is code execution on the next command.
- Probe the before/after on a temp tree: the deny must hold under the
  **networked** profile specifically, since that is the shipped shell default.

**Gate:** each new root is refused under every profile that composes the
credential floor, proven by probe and not only by string comparison; a command
that legitimately needs one of the kept paths still works, named in the report.
**Mutation:** drop the new entries → the probe test goes red.

---

## 2. Task 2 — a read allowlist exists as a designed increment (D11)

**Commit:** `feat(sandbox): an isolation profile can carry a read allowlist`

Every backend grants ambient read: darwin `allow file-read*`, linux
`--ro-bind / /`, win32 `root=read`. There is no allowlist an administrator can
write.

**Scope discipline is the task.** Do NOT attempt three OS backends and a policy
surface in one pass. Deliver, in this order:

1. **The settings shape and its resolution** — the key an admin writes, its
   composition with the existing deny roots, and the doctor line that shows the
   resolved answer. This alone is useful: it makes the posture inspectable.
2. **One backend, fully.** Pick darwin (the platform this repo is developed and
   probed on) and implement the allowlist in the profile it composes, with the
   probe proving both directions.
3. **The other two backends: refuse loudly rather than pretend.** If an
   allowlist is configured and the running platform cannot enforce it, that must
   be a stated, visible refusal — never a silent no-op. **A security control
   that silently does nothing on two of three platforms is worse than none**,
   because the admin who configured it stops looking.

- **Deny still outranks allow.** The credential floor from Task 1 must remain
  unconditional above any allowlist an admin writes — the same ordering the
  protected-path floor uses (S16).
- The workspace itself, the config directory the agent legitimately needs, and
  the toolchain paths must be in the default allowlist or every command breaks.
  Enumerate them from a real run, not from a guess.

**Gate:** with an allowlist configured on darwin, a read inside it succeeds, a
read outside it is refused, and a credential root is refused **even if the
allowlist names it**; on a platform that cannot enforce it, the configuration
produces a visible refusal. **Mutation:** let the allowlist outrank the
credential floor → that assertion goes red.

---

## 3. Task 3 — category strings

**Commit:** `docs(audit): what the read-side exposure work leaves open`

Unwrapped, unbolded, backtick-terminated, no inline backticks in the reason,
under 400 characters. At minimum: the two backends without enforcement, the
`~/.gitconfig` decision, and any credential location you deliberately did not
deny.

### 3a. What this work leaves

Nine strings, each measured against the code as committed. Two are the
architectural half of D11 that one pass cannot close; three are decisions this
work took on purpose and states here rather than in a comment nobody greps; one
is a surface a task could not reach because the file that owns it belongs to
another executor; the rest are bounds the environment or a sibling zone imposes.

- documented, not implemented — a read allowlist resolves from settings, reports in the doctor and binds in the darwin profile, and no host passes it to the supervisor yet. The supervisor option exists; the one line that fills it lives in SessionManager, which is locked to a sibling executor this session: `allowedReadRoots`
- documented, not implemented — linux and win32 REFUSE every supervised spawn when an allowlist is configured, rather than enforcing one. bwrap starts from a whole-root read bind, firejail whitelists writes, and the Windows profile has one value per path with no re-allow. A refusal is loud; it is not the feature: `read-allowlist`
- deliberate divergence, stated — the home git config stays readable while every other candidate on the list is denied. Measured, not reasoned: with the home directory denied, git aborts at status 128 on git --version and does not degrade. It is denied for WRITE instead, because a helper or pager line in it is code execution on the next command: `credentialDenyWriteRoots`
- ours, bounded — the floor denies the kube, npm, docker, gcloud and azure trees whole, so a sandboxed kubectl, a private npm install and a docker registry login stop working inside the sandbox. The floor is unconditional by design, so an administrator cannot re-open one; the escape is excludedCommands or turning the filesystem layer off: `credentialDenyRoots`
- ours, bounded — an operator who keeps a live token in the home git config, in an insteadOf URL or in an http extraHeader line is still exposed, because that file is deliberately readable. The secret git itself stores is in the credentials file beside it, and that one is denied: `http.extraHeader`
- ours, bounded — shell startup files and desktop app session stores are NOT denied. Neither is a credential store by purpose, and denying the shell rc set would break every login shell the agent starts. A chat app token under Application Support remains readable: `~/.zshrc`
- ours, unprobed — the linux bwrap branch now SKIPS a deny root that does not exist, because bwrap has to materialise a mount point and cannot create one under a whole-root read-only bind. Necessary once the floor grew sevenfold, and there is no linux host in this session to run it against: `--ro-bind`
- documented, not implemented — the doctor prints an unenforceable allowlist with a marker and still exits zero, unlike an unenforceable domain rule. The predicate that would change it sits beside a section a sibling executor committed to twice today: `hasFindings`
- ours, stated — N10 stays open. The write floor is still composed unconditionally, so sandbox.filesystem.disabled reports a layer that is off while every deny root binds. Closing it needs the flag threaded through the supervisor into the same locked file, and an unreachable switch that turns the sandbox off is not worth adding during a hardening task: `selfConfigDenyWriteRoots`

## 4. Gate

Focused suites per changed file; the isolation, sandbox and session-tools
aggregates once on the final diff; `bun run typecheck:all` **exit 0 with zero
`error TS`, stated explicitly**; `bun run lint`; `git diff --check`.

**Isolation is a named risk trigger** — run the expanded set once on the final
diff.

Known-failing rows: `docs/superpowers/specs/2026-07-29-known-failing-tests.md`.
Note `Pi harness R0 baseline > executes golden foreground and background process
contracts` fails on `isolationProfile` and is a listed row — do not re-diagnose
it, but DO check your change did not make it worse.

## 5. Constraints

- You own `packages/session-tools-core/src/runtime/**`,
  `packages/server-core/src/pi-harness/isolation.ts` and
  `pi-harness/isolation/**`, and `packages/shared/src/config/sandbox-settings.ts`.
- **N10's residual is yours if you can take it:** `resolveProcessIsolation`
  (`pi-harness/isolation.ts:163`) still composes `selfConfigDenyWriteRoots`
  unconditionally, so `sandbox.filesystem.disabled` reports the layer off while
  every deny root still binds. If Task 1 or 2 puts you in that function anyway,
  close it and say so; if not, leave it and report.
- **A sibling executor owns `managed-policy.ts`, `permissions-config.ts`,
  `permission-dsl.ts`, `server-core/src/bootstrap/**` and `SessionManager.ts`;
  another owns `packages/shared/src/plugins/**` and the renderer's plugin
  pages; a third owns `scripts/cdp/**`.** Stay out of all three.
- **A pathspec commit takes the WORKING TREE, not your hunks.** Two executors
  crossed on one file earlier today and each landed under the other's subject.
  Commit promptly; if a file is dirty with work that is not yours, report it
  rather than committing it.
- One commit per task, subjects exactly as given. **No `Co-Authored-By`.** No
  push/MR/tags/reset/rebase/`--amend`/`checkout --`/stash of edited files.
  Restore mutation probes by re-edit or an `.orig` copy, **never git**.
- Do not touch `docs/superpowers/specs/` or the CDP checklist. No version bumps.
  Never write `~/.nessy/dp_auth_creds.json`.
- **Never probe against the user's real credential files, real browser profile
  or real home-directory secrets.** Build a fake tree in a temp directory and
  point the profile at it. Never point a probe at a real external host. **Never
  print the contents of anything that looks like a credential**, even a fixture.
- Code, comments and commits in English.

## 6. Report

Commit shas; the exposure reproduced by probe, before and after; how you
enumerated the credential locations; the `~/.gitconfig` decision and its reason;
which backend enforces the allowlist and what the other two do; whether you
closed N10's residual; residuals word for word; corrections to this plan;
mutation probes with which side went red; the explicit typecheck statement.
