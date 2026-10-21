# D12, D16, D17 — the record the transcript keeps, and the floor Windows lacks

Three rows from the deviation triage. D16 is a destructive-action floor that
does not exist on a platform we ship; D12 and D17 are both the same shape —
**the record of what happened is incomplete, and an incident review is who
finds out.**

## 0. Method rules

1. `curl -s https://code.claude.com/docs/en/hooks.md` (Stop payload) and
   `permissions.md` (the removal breaker's own contract). Quote WHOLE lines.
2. **Declared ≠ enforced.** Reproduce each defect before fixing. Prove on Pi.
3. **NUL bytes** — always `grep -a`; never `head -N` a grep whose hit count you
   have not counted.
4. **Two git commands** — pathspec on the `commit`. One commit per task.
5. **Run every test from the repository ROOT.** A package-directory run
   destroys the user's real `~/.nessy-agent/config.json`. Check no other
   `bun test` is running before recording a failure.
6. CDP may be on 9223 — do not kill or drive it; do not run
   `electron:build:servers`.

---

## 1. Task 1 — the removal breaker exists on every platform we ship (D16)

**Commit:** `fix(permissions): the removal breaker covers every destructive spelling we ship`

`REMOVAL_COMMANDS` is `{rm, rmdir}` (`removal-circuit-breaker.ts:97`). **Nessy
ships a native Windows build**, where the idiomatic spelling is `Remove-Item`,
so on Windows **the one destructive floor that `allow-all` and `auto` cannot
skip does not exist.** `find -delete` and `shred` pass on every platform. What
is lost is a user's files.

- Add the spellings that actually delete on the platforms we ship: the
  PowerShell forms and their aliases (`Remove-Item`, `ri`, `rm` as an alias,
  `del`, `erase`, `rd`), and the POSIX forms the breaker misses (`find … -delete`,
  `shred`, `truncate`, and think about `dd of=`). Enumerate from what the shell
  actually resolves, not from memory — and say in the report how you enumerated.
- **The breaker's own contract must hold**: it produces a `nonNegotiable`
  prompt no mode skips. Today's guardian fix (`8c2990ad`) made the auto-mode
  judge unable to clear a non-negotiable prompt — the new spellings must land
  on that same path, not a parallel one.
- **A wider matcher must not become noisy.** `rm` inside a quoted string, a
  path containing `shred`, or `find` without `-delete` must NOT trip it. A floor
  that fires on innocent commands gets muscle-memory-approved and then protects
  nothing. Assert both directions.
- Windows spawn semantics differ; if a spelling can only be recognized on one
  platform, gate it by platform rather than matching it everywhere.

**Gate:** each new spelling raises the non-negotiable prompt on the platform it
applies to; the innocent counter-cases stay silent; the guardian still cannot
clear it in `auto`. **Mutation:** drop the new spellings → the Windows test goes
red.

---

## 2. Task 2 — a Stop hook can see what was left running (D12)

**Commit:** `fix(agents): a background shell reports its command to the Stop payload`

A Stop hook sees a background shell as
`{id, type: 'shell', description: <the same id>}` because `ProcessStore` never
persists the command line. **A fleet Stop hook cannot log or block on what the
agent left running** — precisely the audit datum the documented field carries,
and the one an incident review asks for first.

- Persist the command at the point the process is registered and thread it to
  the `background_tasks` projection. Read the documented field's meaning whole
  before choosing what to put in it.
- **This is an audit surface and a leak surface at once.** A command line can
  carry a token in an argument. Decide deliberately: full command, or the
  command with the existing redaction applied. Whatever you choose, say why, and
  make sure it is the same rule the transcript already applies to shell
  commands — two different redaction answers for the same string is the defect
  this audit keeps finding.
- Restored/adopted processes are the interesting case: a record written by a
  previous process must still carry it, or the field is empty exactly when an
  incident review needs it.

**Gate:** a Stop hook receives the command for a background shell, including one
adopted across a restart; the redaction rule matches the transcript's.
**Mutation:** stop persisting the command → the Stop-payload test goes red.

---

## 3. Task 3 — a fork's answer lands in the transcript (D17)

**Commit:** `feat(agents): a subtask result is written to the transcript`

After `/subtask` the fork's answer never lands in the main transcript: the user
must know to open the agent panel, and **anyone reading the conversation later —
a reviewer, an incident review — sees a fork start with no result attached.**
The transcript is the record, and it is incomplete.

- Write the result into the transcript when the fork settles, in the shape the
  transcript already uses for a completed sub-run. Do not invent a new message
  kind if one fits.
- Cover the unhappy endings too: a fork that fails, is stopped, or is dismissed
  must leave a legible outcome, not silence. A record that only logs successes
  is worse than none for a review.
- **`/subtask` was dead until today** (`e77e0b35` made it reach the session).
  Read that fix before building on it, and drive the result through the real
  session path rather than injecting a message.
- The agent panel stays the live surface; the transcript entry is the record.
  Say in the report whether they can disagree and what happens if they do.

**Gate:** a completed fork's answer is in the transcript and survives a reload;
a stopped fork leaves a stated outcome; the panel still shows the live view.
**Mutation:** drop the transcript write → the reload test goes red.

---

## 4. Task 4 — category strings

**Commit:** `docs(audit): what the record and floor work leaves open`

Unwrapped, unbolded, backtick-terminated, no inline backticks in the reason,
under 400 characters. At minimum: any destructive spelling you decided not to
match and why.

### 4a. What this plan leaves

Six strings, each measured against the code as committed. Three are removal
spellings the breaker declined or bounded, and each one is a decision about
where a floor stops rather than an omission. One is a Windows reading wider than
the doc's own words. One is the half of D17 the task scoped out. The last is not
about the product at all: it is what four executors sharing one file did to two
commit subjects.

- documented, deliberately not matched — shred, truncate, dd of= and unlink all refuse a directory. Probed against a temp tree rather than recalled: each exits non-zero with "Is a directory", so no spelling of them removes the filesystem root or the home directory. A floor that fires on something that cannot happen is a prompt users learn to clear: `non_directory_removers`
- implemented under a stated bound — find fires only when nothing narrows the traversal, so find ~ -delete and find ~ -exec rm -rf {} + prompt while find ~ -type f -delete does not. Any other primary is the ordinary-cleanup shape the module was right to exclude, and a breaker that fires on find ~ -name "*.pyc" -delete gets approved by reflex and then protects nothing: `find_narrowing`
- documented, not implemented — a removal nested inside ANOTHER interpreter's quoted argument is not reached. powershell -Command "Remove-Item -Recurse -Force $HOME" and cmd /c rd /s /q %USERPROFILE% both hide the removal in one quoted token, and neither scan descends into one. The wrapper stripper, not the breaker, is where that would be fixed: `nested_interpreter`
- implemented, wider than the doc's words — on Windows every drive root classifies as the filesystem root, not only the system drive, because Windows has one root per volume while the doc names a single "filesystem root". Prompting on each is the conservative reading; the alternative silently exempts every non-system volume: `windows_drive_roots`
- documented, not implemented — the /subtask START announcement is still a transient info event, so a reloaded transcript carries the fork's result and not its beginning. The result entry names the fork's task so it reads on its own; persisting the announcement as well would mean string-matching an info message, which is the seam this wave keeps removing: `fork_start_line`
- left open by concurrent execution — two commits carry hunks their subject does not describe, because a pathspec commit takes the whole file and four executors shared SessionManager.ts. bd64fcff carries the hook-verdict unit's mcp_tool and http verdict returns; 9ba4c9ca carries this plan's fork transcript write. Nothing is lost, and no subject is honest: `shared_file_commits`

## 5. Gate

Focused suites per changed file; the permissions, server-core and renderer
aggregates once on the final diff; `bun run typecheck:all` **exit 0 with zero
`error TS`, stated explicitly**; `bun run lint`; i18n parity + sorted if strings
are added; `git diff --check`.

**Permission decisions and process lifecycle are named risk triggers** — run the
expanded set once on the final diff.

Known-failing rows: `docs/superpowers/specs/2026-07-29-known-failing-tests.md`.
Two failures currently in the tree are NOT yours and NOT on that list: the
`pins all MCP rows against the actual current client surface` pin (the MCP
executor's `client.ts` gained six methods) and an orchestration playground
registry count (the MCP executor added three URL-consent states). Leave both.

## 6. Constraints

- You own `packages/shared/src/agent/core/removal-circuit-breaker.ts` and its
  neighbours under `agent/core/`, `packages/server-core/src/**` (the process
  store, the session manager), and `apps/electron/src/renderer/**` **except**
  the context overlay and the elicitation/permission card.
- **THREE SIBLING EXECUTORS run concurrently.** They own
  `packages/shared/src/config/**`, `pi-agent-server/src/**`,
  `apps/electron/src/main/index.ts`, `apps/cli/**`,
  `session-tools-core/src/runtime/**`; `shared/src/mcp/**`, `auth/oauth.ts`,
  `agent/backend/types.ts`, `plugins/format-adapters/**`,
  `config/network-address-guard.ts`, the elicitation card; and
  `packages/shared/src/agent/pi-agent.ts`, `plugins/hooks-automation.ts`,
  `automations/**` (the hook-verdict unit — **it also holds
  `SessionManager.ts`; coordinate by keeping your edits to different regions and
  committing promptly, or report a residual**).
- One commit per task, subjects exactly as given. **No `Co-Authored-By`.** No
  push/MR/tags/reset/rebase/`--amend`/`checkout --`/stash of edited files.
  Restore mutation probes by re-edit or an `.orig` copy, **never git**.
- Do not touch `docs/superpowers/specs/` or `docs/testing/cdp-live-checklist.md`,
  nor `~/.nessy-agent/skills/r17-*` or `~/.nessy-agent/mcp/elicit-server.mjs`.
  No version bumps or release notes. Never write `~/.nessy/dp_auth_creds.json`.
- **Never test a destructive spelling against a real path.** Every removal
  probe asserts on the DECISION, never by running the command; any fixture path
  is inside a temp directory you created.
- Code, comments and commits in English.

## 7. Report

Commit shas; each defect reproduced; how you enumerated the destructive
spellings and which you declined; the redaction rule chosen for the command line
and why it matches the transcript's; whether the panel and the transcript can
disagree; residuals word for word; corrections to this plan; mutation probes
with which side went red; the explicit typecheck statement.
