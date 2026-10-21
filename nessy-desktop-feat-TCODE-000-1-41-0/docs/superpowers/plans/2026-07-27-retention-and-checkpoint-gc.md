> **CLOSED 2026-07-27.** Executed and verified; evidence in the parity audit §0 (R12).
> Upgrade is destructive by documented design (30-day default) — release-notes item recorded in §0.
> Kept until the end-of-series sweep. Do not execute again.

# Retention and Checkpoint GC (R12) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A retention story that actually bounds disk: the reference-counted checkpoint GC with its first-snapshot pin, an age sweep that covers unarchived data and every documented path class, a validated `retentionDays` with the documented default and fail-safe, and the orphaned-worktree half.

**Architecture:** Three independent sweeps behind one policy value. The checkpoint GC is reference-counted, not a ring buffer — the delete predicate is *"referenced by no retained checkpoint AND is not this file's first snapshot"*. The age sweep is a startup pass over named path classes with an explicit never-swept list. Orphan-worktree cleanup rides the same age cutoff and uses the `lastUsedAt` seam R2 just landed.

**Tech Stack:** TypeScript, Bun test.

**Contract source:** `code.claude.com/docs/en/checkpointing.md`, `claude-directory.md` (§ Cleaned up automatically / § Kept until you delete them), `settings.md` (`cleanupPeriodDays`). Distilled in `docs/superpowers/specs/2026-07-26-r-queue-doc-verification.md` § R12 — **READ IT FIRST**; it corrects five things and each one changes the code.

## Global Constraints

- Scope: Pi runtime + app. One commit per task; no `Co-Authored-By`; no MR/tags; never reset/rebase/amend; pathspec-limited commits only; do not touch `docs/superpowers/specs/` (you may edit this plan file); Implementation-First Verification Budget.
- **This plan deletes user data. Every sweep is a destructive action, so:** each one is dry-runnable and logs what it would remove before it removes anything; each has a test that proves the *never-swept* set survives; and no sweep runs at all when the policy value cannot be read (see the fail-safe in Task 4). If a test cannot express a deletion boundary, do not ship that boundary.
- **`lastUsedAt` may be absent, and absent means UNKNOWN, never epoch.** R2 added it stamped going forward; every pre-existing lease has none. A sweep that reads absent as "infinitely old" deletes every lease that existed before this change. Pin that with a test.
- **`sessions/` is a NAME COLLISION, corrected in Task 1.** Claude's never-swept `sessions/` holds live-session marker files. Our `CONFIG_DIR/sessions/` is the transcript store — Claude's `projects/`. Excluding it would make Task 3 a no-op. Our counterpart of Claude's `sessions/` is the live-process marker store `CONFIG_DIR/sessions/.pi-processes/`, and *that* is what must never be swept.
- The series' recurring defect is now five instances (P6 `path`/`file_path`; `ifRule`; the band; Monitor dispatch; nine dead session bindings). Assert through the production path.

---

### Task 0: Pre-phase — fold in R2 close-out follow-ups

- [x] **Step 1:** Read the R2 close-out (audit §0 entry "R2"). Directly relevant: `PiWorktreeLeaseV1.lastUsedAt`, `WorktreeLeaseService.touch()` and `SessionWorktreePort.list()` exist now — that is your enumeration seam, use it rather than adding another. R2 also fixed an R15 seam hole and shipped `bgIsolation: 'none'`; neither needs anything here.
- [x] **Step 2:** CDP pass 6 left an item **for the planner, not for you**: creating a session via `projectHandleId` then immediately `sendMessage` returned `Session <id> not found`. Do not chase it unless your own work touches session creation.

### Task 1: Re-verify the plan against current code

- [x] **Step 1:** Anchors re-verified at `9ca03c21`. All present; four line numbers drifted, and two facts are new:
  - `packages/shared/src/config/storage.ts:**57**` (was `:56`) — `retentionDays?: number; // Days to retain archived sessions. 0 disables cleanup (default: 0)`; `:**139**` (was `:135`) sets `retentionDays: 0`. Bundled default too: `apps/electron/resources/config-defaults.json:19`.
  - `packages/shared/src/config/validators.ts:115` — `.min(0)` in `ConfigDefaultsSchema`. **Second site the spec missed:** `validators.ts:140`, `retentionDays: z.number().int().min(0).optional()` in `StoredConfigSchema`.
  - **NEW, and it is the series' recurring defect again (instance six):** `ConfigDefaultsSchema` and `StoredConfigSchema` are referenced by exactly one file — `config/__tests__/validators-stored-config.test.ts`. Production never validates config through zod: `loadStoredConfig()` hand-rolls its checks and `normalizeRetentionDays()` (`config/storage.ts:308`) clamps anything `<= 0` to `0`. **Changing only the validator changes nothing.** The production path is `getRetentionDays()` / `setRetentionDays()` / `runSessionRetentionSweep()`; assert there.
  - `packages/shared/src/sessions/storage.ts:**780**` (was `:770`) — `deleteOldArchivedSessions(workspaceId, retentionDays)`, still the only sweep entry point, still archived-only, called once from `config/storage.ts:345`.
  - `createFileCheckpoint` lives in `packages/shared/src/sessions/file-checkpoints.ts:262`; no cap constant. Snapshots are written to `<sessionPath>/file_checkpoints/files/<checkpointId>/0-<name>` and indexed by `<sessionPath>/file_checkpoints/manifest.json` (`{version:1, entries:FileCheckpointEntry[]}`, append-only, manifest order = creation order). One entry ↔ at most one `snapshotFile`. `makeCheckpointId` seeds on `entries.length`, so trimming entries can re-issue an index — the GC must keep ids unique.
  - `PiWorktreeLeaseV1` at `packages/shared/src/sessions/types.ts:169`, `lastUsedAt?: string` at `:189`. `WorktreeLeaseService.list()/touch()` at `packages/server-core/src/pi-harness/worktree-lease-service.ts:59,72`.
  - Startup home confirmed: `ensureConfigDir()` (`config/storage.ts:277`) already calls `runSessionRetentionSweepOnce()` once per launch, after `ensureConfigDefaults()`. Callers: `packages/server-core/src/bootstrap/headless-start.ts:338` and electron main.
- [x] **Step 2:** Corrections made to this plan, in place:
  1. **`sessions/` name collision** (Global Constraints, Task 3). See above — following the plan literally would have excluded the transcript store and made Task 3 a no-op.
  2. **Path-class mapping resolved** (Task 3) — the documented thirteen collapse to four sweep classes here, because our session subtree is one directory. Nine have no counterpart. Recorded in Task 3.
  3. **Validator work is not the production change** (Task 4) — the zod schemas are test-only; `normalizeRetentionDays` is the real gate.
  4. **`unpushed commits` needs no adapter change** (Task 5) — `git.inspect` already returns the worktree's HEAD as `baseSha`; HEAD ≠ `lease.baseSha` *is* "holds new commits", and worktree branches are never pushed.
  5. **No `/status` surface exists here** (Task 4) — recorded as a scoped deviation, see Task 4.

### Task 2: Reference-counted checkpoint GC with the first-snapshot pin

**Files:** the checkpoint store (beside `createFileCheckpoint`); a new pure `checkpoint-gc.ts` for the predicate
- Test: colocated, table-driven

Documented: "Claude Code keeps file snapshots for the 100 most recent checkpoints in a session. Discarding an older checkpoint deletes the snapshot files that no remaining checkpoint references, **except each file's first snapshot**, which the VS Code extension uses as the baseline for its session diffs."

- Retain the 100 most recent checkpoints per session (`CHECKPOINT_RETENTION = 100`, one named constant).
- Delete predicate, pure and testable: `referencedByNoRetainedCheckpoint(snapshot) && !isFirstSnapshotOfItsFile(snapshot)`.
- The first-snapshot pin is per **file**, not per session — losing it loses the diff baseline.

- [x] **Step 1:** Failing tests: 101 checkpoints → the oldest is discarded; a snapshot still referenced by a retained checkpoint survives; an unreferenced snapshot is deleted; **a file's first snapshot survives even when unreferenced**; a file whose only snapshot is its first survives; two files interleaved keep one first-snapshot each.
- [x] **Step 2:** Run — FAIL. **Step 3:** Implement (pure predicate + the store call that applies it). **Step 4:** Run — PASS + existing checkpoint suites. Commit: `feat(sessions): reference-counted checkpoint GC with the first-snapshot pin`

### Task 3: The age sweep — path classes, the never-swept list, and unarchived data

**Files:** a new `retention-sweep.ts`; the startup site; `sessions/storage.ts` (the archived-only sweep becomes one caller among several)
- Test: colocated, using a temp directory tree

Documented path classes to sweep, **mapped to our layout in Task 1** (repeat this table in the commit body):

| Documented class | Nessy counterpart |
| --- | --- |
| `projects/<project>/<session>.jsonl` | `sessions/<workspaceId>/<sessionId>/session.jsonl` |
| `projects/<project>/<session>/tool-results/` | `sessions/<workspaceId>/<sessionId>/long_responses/` |
| `file-history/<session>/` | `sessions/<workspaceId>/<sessionId>/file_checkpoints/` |
| `plans/` | `sessions/<workspaceId>/<sessionId>/plans/` |
| `debug/` + legacy `logs/` | `CONFIG_DIR/logs/` (live directory — contents swept, directory kept) |
| `feedback-bundles/` | `CONFIG_DIR/feedback/` |
| "contents and then the empty directory" | `sessions/<workspaceId>/` once its last session is gone |

The first four are **children of one directory** in our layout, so the sweep unit is the whole session directory, not a file per class. That is what makes the archived-only hole closable in one predicate.

**No counterpart here** (say so in the commit body): `projects/<project>/<session>/subagents/` — our subagent turns are inline in the parent `session.jsonl`, there is no per-subagent directory; `paste-cache/`, `image-cache/` — pasted and generated images land in the session's own `attachments/`, which the session-directory sweep already covers; `session-env/`; `tasks/` — R20's task store is not built; `shell-snapshots/`; legacy `todos/`, `statsig/`. And `backups/` deliberately: `CONFIG_DIR/config.json.bak-*` is already **count**-capped at three by `backupConfigFile()` and it is the only disaster-recovery copy of the workspace registry, so age-sweeping it would defeat its purpose. `~/.nessy-agent.legacy-v1.<txid>/` (the v1 quarantine root) is the user's only copy of pre-v2 data and nothing restores from it automatically — **not swept**, recorded so it is not re-derived as a legacy class.

**Never swept**, and each needs a test:
- `CONFIG_DIR/sessions/.pi-processes/` — the live-process marker store, our counterpart of Claude's `sessions/`. It sits *inside* the swept root and its name satisfies `assertStorageId`, so it would read as a workspace id: it needs an explicit exclusion, not just an allowlist.
- `history.jsonl` — no counterpart exists here (we keep no separate prompt-history file; prompts live in the transcript). The sweep is **allowlist-shaped**, so anything unnamed survives by construction; the test pins a literal `CONFIG_DIR/history.jsonl` so a future opt-out refactor fails loudly. A bank will ask about this one by name.
- `CONFIG_DIR/config.json` and the rest of the config root.

**The archived-only hole is the point of this task**: our sweep touches archived sessions only, so raising the default to 30 would still retain every unarchived transcript forever. The sweep is age-based, not archive-based.

- [x] **Step 1:** Failing tests: a file older than the cutoff in each swept class is removed; a file newer survives; `.pi-processes/` survives regardless of age; `history.jsonl` survives regardless of age; an emptied `sessions/<workspaceId>/` is removed **after** its contents; an unarchived session's data older than the cutoff **is** swept (the hole); dry-run mode removes nothing and reports exactly what a real run would remove. Session-tier tests go through the real store (`saveSession` → sweep → `deleteSession`) against `SESSIONS_DIR` with a unique workspace id, the way `config/__tests__/session-retention.test.ts` already does; config-root-tier tests pass a temp `configDir` through the same option production fills with `CONFIG_DIR`.
- [x] **Step 2:** Run — FAIL. **Step 3:** Implement. **Step 4:** Run — PASS. Commit: `feat(storage): age-based retention sweep across the documented path classes`

### Task 4: `retentionDays` validation, the documented default, and the fail-safe

**Files:** `config/storage.ts`, `config/validators.ts`, the startup site, and the status surface
- Test: validator tests + a startup test

Documented: **default `30`, minimum `1`, and `0` fails with a validation error.** Ours is `.min(0)` with `0` as the default — our default is a value Claude's schema rejects.

- Change **both** validator sites (`validators.ts:115` and `:140`) to `.min(1)` and the default to `30` in `config/storage.ts:139`, `config-defaults.json` and `FALLBACK_CONFIG_DEFAULTS`. Remember from Task 1 that the validators are test-only: the production change is `normalizeRetentionDays` + `getRetentionDays` + `setRetentionDays`.
- **Migration matters**: an existing config with `0` must not crash the app on load — treat a persisted `0` as "cleanup disabled" with a one-line warning, and reject `0` only on *new writes*. Say in the commit body which behaviour you chose and why; a validation error on an existing user's config file is a startup crash.
- Fail-safe (v2.1.203+): "If Claude Code can't read or parse a settings file, it pauses the retention cleanup sweep and shows a warning in `/status` until you fix the file, **unless managed settings provide `cleanupPeriodDays`**, in which case the sweep runs at the managed value." Implement both halves: pause + a surfaced warning, and the managed override. The managed key rides the existing managed-policy parse (R22's pattern: validation lives in the shared parser: `agent/pi-harness/managed-policy.ts`).
- **Deviation, recorded:** Nessy has no `/status` surface. The warning ships as a production-reachable status record — `getRetentionSweepStatus()` in `config/storage.ts`, set on every sweep outcome including the paused one — plus an unconditional warn-level log. No IPC channel, renderer panel or locale keys: that is four files of plumbing plus i18n parity for no test the status record does not already give, and the record is what a `/status` equivalent would read. Left for the UI wave; noted for CDP pass 7.
- **Deviation, recorded:** the managed `cleanupPeriodDays` is parsed **fail-closed** (a malformed value throws and aborts the policy load) like every other key in `parseManagedPiPolicyV1`, even though the docs say managed settings are validation-tolerant. R22 established that posture for this parser and diverging for one key would be worse than the divergence from the doc.
- The managed value reaches the shared sweep through a registered provider (`registerManagedRetentionDaysProvider`), because the managed policy is loaded in `server-core` and `ensureConfigDir()` runs in `shared`. Unset provider = no managed value, which is the correct default for every non-managed install.

- [x] **Step 1:** Failing tests: a new config writing `0` is rejected; an existing persisted `0` loads with cleanup disabled and a warning, not a crash; the default is 30 for a fresh install; an unreadable settings file pauses the sweep and surfaces a warning; with a managed `cleanupPeriodDays` the same unreadable file still sweeps at the managed value.
- [x] **Step 2:** Implement. **Step 3:** Suites + `bun run typecheck:all`. Commit: `feat(config): retention default, validation and the unreadable-settings fail-safe`

### Task 5: Orphaned worktrees

**Files:** the sweep, `WorktreeLeaseService`
- Test: colocated

Same age cutoff, tightly scoped so it cannot collide with R2's live leases: a worktree is orphaned when **no live lease references it** and its `lastUsedAt` is older than the cutoff. **An absent `lastUsedAt` means unknown → never swept** (R2's leases predate the field).

Scoping decided in Task 1:
- "Never removes worktrees you create with `--worktree`" holds **by construction**: `WorktreeLeaseService` is the only writer of leases and the sweep walks leases only, so a user-made worktree in the namespace has no lease and is never a candidate. Test it anyway.
- "Skips a worktree that still holds work: changed or untracked files, or unpushed commits" needs **no adapter change**. `git.inspect` already returns `dirty` (changed/untracked) and returns the worktree's *current* HEAD as `baseSha`; `actual.baseSha !== lease.baseSha` is exactly "holds new commits", and these branches (`nessy/<agent>/<leaseId>`) are never pushed.
- Removal goes through the production `release` path so the dirty refusal, the provenance assertion and the `WorktreeRemove` emit are the same ones a manual release uses.

- [x] **Step 1:** Failing tests: an old orphan is removed; a live-leased worktree is never removed regardless of age; a lease with **no** `lastUsedAt` is never removed; a recently-touched lease survives; a dirty worktree is skipped; a worktree holding new commits is skipped; the sweep reports each removal and each skip with its reason; dry-run removes nothing.
- [x] **Step 2:** Implement. **Step 3:** Suites. Commit: `feat(sessions): sweep orphaned worktrees on the retention cutoff`

### Task 6: Close-out

- [x] **Step 1:** Full gates: `bun run typecheck:all`, `bun run test:shared:all`, server-core + session-tools suites, `bun run lint`, `git diff --check`.
- [x] **Step 2:** Mutation probes: (a) drop the first-snapshot pin → that test must fail; (b) sweep `history.jsonl` → that test must fail; (c) treat absent `lastUsedAt` as epoch → the never-swept-orphan test must fail; (d) let the sweep run on an unreadable settings file with no managed value → the fail-safe test must fail. Restore all four.
- [x] **Step 3:** Report: per-task shas, gate numbers, deviations, probe results, the `0`-migration behaviour you chose and why, which documented path classes have no counterpart in our layout, and the CDP cases for pass 7 (expected: a real sweep run on a seeded old tree removing exactly the intended files and leaving `history.jsonl` and `sessions/` intact).

---

## Execution record

| Task | Commit | What it landed |
| --- | --- | --- |
| 0 + 1 | `1042af60` | R2 close-out read; anchors re-verified; five plan corrections |
| 2 | `f3f3b881` | Reference-counted checkpoint GC + the per-file first-snapshot pin |
| 3 | `2baf7ce6` | Age-based sweep across the mapped path classes; archived-only path retired |
| 4 | `21b9f232` | Default 30 / minimum 1 / persisted-0 migration / unreadable-settings fail-safe + managed override |
| 5 | `2dd391dd` | Orphaned-worktree sweep on the same cutoff |

**Gates (final diff).** `bun run typecheck:all` clean, exit 0. `bun run test:shared:all`
5 + 66 + 48 pass / 0 fail. Repo wave `bun test`: **8294 pass / 18 skip / 0 fail**, 6
snapshots, 33 238 expect() calls, 760 files, 212 s. Isolated suites: all green except
`apps/electron/src/main/__tests__/session-branch-rollback.isolated.ts` at 1 pass / 3 fail
— **verified identical on the pre-plan baseline `9ca03c21`** in a detached worktree, so
pre-existing and unrelated (`managed.agent?.setAutomationSystem is not a function`).
`bun run lint` 0 errors / 122 warnings, all pre-existing. `git diff --check` clean.

**Mutation probes — all four killed, all four restored, tree clean afterwards.**

| Probe | Mutation | Result |
| --- | --- | --- |
| a | `isSnapshotDeletable`'s second conjunct forced true (pin dropped) | 6 fail: 5 in `checkpoint-gc.test.ts`, 1 in the store-level `file-checkpoints.test.ts` |
| b | config root added as a sweep class, so `history.jsonl` is swept | 2 fail: the `history.jsonl` pin and the config-root survivors |
| c | absent `lastUsedAt` read as epoch | 2 fail: the never-swept-orphan test and the dry-run parity test |
| d | unreadable settings falls back to the default instead of pausing | 3 fail: 2 in `retention-policy.test.ts`, 1 in the isolated end-to-end fail-safe |

**Deviations.**
1. No `/status` surface exists in Nessy, so the fail-safe warning ships as
   `getRetentionSweepStatus()` plus an unconditional warn-level log rather than a UI
   panel. Recorded in Task 4; left for the UI wave.
2. Managed `cleanupPeriodDays` is parsed fail-closed, unlike the docs' description of
   managed settings as validation-tolerant. R22 set that posture for this parser.
3. `deleteOldArchivedSessions` was removed rather than kept as "one caller among
   several" as the plan suggested — it is fully subsumed on an identical clock, and a
   feature that deletes user data should not have two deletion paths.
4. Task 5's git-adapter change turned out to be unnecessary (see plan correction 4).
5. The orphan sweep is wired at session start rather than at the config-dir startup
   sweep, because leases live on session records in `server-core` and the shared
   startup sweep cannot reach them.

**Release-note risk.** Every existing install has no `retentionDays` key, so the new
30-day default becomes active on the next launch and sweeps every session untouched for
30 days. That is the documented contract and Claude behaves identically, but it is
destructive on upgrade and must be in the release notes.
