# S7 — Rewind must not write through a link

From the phase-4 sweep (`2026-07-29-phase4-findings.md`,
`agent-sdk/file-checkpointing.md`).

**A probe confirmed rewind writes the pre-image straight through a hard link**,
mutating inode aliases the filesystem scope cannot see. Our checkpoint/rewind is
otherwise conformant; this is the one layer missing.

---

## 0. Method rules

1. **Fetch the page yourself**:
   `curl -s https://code.claude.com/docs/en/agent-sdk/file-checkpointing.md`.
   Never a summarising fetch tool.
2. **The quotation is the identifier, not the line number.** Report where you
   found each.
3. **Read around each quotation.**
4. **Declared ≠ enforced.** Name the consumer and prove it runs on Pi.
5. **Two git commands** — pathspec on the `commit`.
6. Expected pre-existing failures:
   `docs/superpowers/specs/2026-07-29-known-failing-tests.md`. That list has been
   short twice running, so still reproduce anything you call pre-existing on a
   clean `git worktree` at your base commit. Never `git stash`.

---

## 1. State

`packages/shared/src/sessions/file-checkpoints.ts`. `readFileState` uses `stat` +
`isFile()`, which **follows symlinks and cannot see hard links**. There is no
`lstat`, no `nlink` check, and no parent-directory re-resolution — we do the
opposite, recreating a missing parent with `mkdir(dirname(entry.filePath), { recursive: true })`.

So a rewind can:

- follow a symlink planted at a tracked path and write outside the workspace;
- write through a hard link, changing a file that shares the inode — the
  filesystem scope never sees a second path, so no scope check can catch it;
- recreate a parent directory that was deliberately removed, or that now
  resolves somewhere else, and restore into it.

Read `file-checkpointing.md`'s v2.1.216 link-safety layer for the documented
shape before designing ours.

---

## 2. Tasks

### Task 1 — see the link before you write

**Commit:** `fix(checkpoints): rewind refuses to restore through a link`

- `lstat` every tracked path before restore or delete.
- Skip symlinks, hard links (`nlink > 1`) and non-regular files.
- Re-resolve the parent directory against its checkpoint-time location; refuse
  when it no longer resolves there rather than recreating it.
- **Skipping is not silence.** A rewind that quietly declines to restore three
  files has told the user their state is back when it is not. Count the skips
  and carry the count out of the API — the page's own shape is a
  `skippedLinks`-style field on the revert result.

Decide and record: is a skip a **refusal of the whole rewind**, or a partial
rewind with a report? The docs describe per-path skipping; a partial rewind that
says so is defensible, a partial rewind that does not is the defect. Say which
you built and why.

**Gate:** construct each hazard in a temp directory — a symlink at a tracked
path, a hard-linked file, a parent directory replaced by a symlink — and assert
the restore is refused **and** that the alias is unchanged. Assert the byte
content of the aliased file before and after; a test that only checks a return
value would pass while the data was corrupted.

---

### Task 2 — surface the skips

**Commit:** `feat(checkpoints): a rewind reports what it would not restore`

Thread the count and reasons to whatever surface reports a rewind, so a user who
rewinds and finds a file unchanged learns why from the app rather than from a
diff.

i18n keys in **all** locale files; keep `lint:i18n:parity` and
`lint:i18n:sorted` green.

---

### Task 3 — the rest of the page

**Commit:** `docs(checkpoints): the file-checkpointing rows we do not implement`

Category string per requirement — `documented, implemented` ·
`documented, impossible on Pi — <equivalent>` ·
`documented, not implemented — <reason>`. The sweep already found the core
contract conformant (tracked tool set, pre-image backup, create-delete and
modify-restore, conversation untouched, subagent and bash exclusions); confirm
each rather than copying that claim, and add the strings so they reach the
deviation register.

---

## 3. Gate

Focused suites for every changed file plus the session/checkpoint aggregates;
`bun run typecheck:all`; `bun run lint`; the two i18n checks if you add keys;
`git diff --check`.

**Run every test from the repository ROOT.** A package-directory run bypasses the
config-dir isolation preload and destroys the user's real
`~/.nessy-agent/config.json`.

**Mutation probe:** remove the `lstat` guard and the hazard tests must go red.

---

## 4. Constraints

- One commit per task, subjects exactly as given. **No `Co-Authored-By` trailers.**
- No push, MR or tags. No `reset`, `rebase`, `--amend`. Never `git checkout --`
  or `git stash` a file you are editing.
- Pathspec on the commit itself.
- **Build every hazard inside a temp directory you created.** Never create a
  symlink or hard link inside the repository, the user's home, or any path you
  did not make for the test.
- Do not touch `docs/superpowers/specs/` or `docs/testing/cdp-live-checklist.md`
  (planner-owned), nor `~/.nessy-agent/skills/r17-*` or
  `~/.nessy-agent/mcp/elicit-server.mjs` (CDP fixtures).
- Another agent may be working in `packages/shared/src/agent/pi-harness/` and
  the LLM-connection/model-catalog code — stay out of those.
- No version bumps, no release notes. Never write to `~/.nessy/dp_auth_creds.json`.
- Code, comments and commits in English.

## 5. Report

Commit shas; the line you found each quotation at; **every correction to this
plan**; the hazard matrix with before/after byte content for the aliased file;
the whole-rewind-versus-partial decision and its reasoning; the category
strings; and the mutation probe.
