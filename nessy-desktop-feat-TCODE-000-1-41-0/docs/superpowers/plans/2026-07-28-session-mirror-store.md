# Session Mirror Store (R6) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `SessionStore` **mirror** contract for session transcripts — local disk stays first and authoritative; a configured mirror receives best-effort batched appends with the documented failure envelope, and provides load-fallback before resume.

**THE DECISION THIS PLAN ENCODES (from doc-verification § R6 — READ IT FIRST, it corrects the audit row):** we build the documented **mirror** (`append`/`load` + optional `listSessions`/`listSessionSummaries`/`delete`/`listSubkeys`), NOT `@earendil-works/pi-agent-core`'s ten-method `SessionStorage`/`SessionRepo` (that is a primary-storage replacement; drop-and-continue is only sound for a mirror). No shipped runtime consumes Claude's SDK option — the page is a design template, so the interface shape is portability guidance, not a compatibility surface.

**Architecture (verified 2026-07-28 at `7f499437`; re-verified at `32e4d61d` — corrections below marked ✎):**
- Host persistence seam (where the mirror hooks): `saveSession` enqueues via `sessionPersistenceQueue` (`packages/shared/src/sessions/storage.ts:304`); ✎ the atomic local write on the production save path is `SessionPersistenceQueue.writePending` (`packages/shared/src/sessions/persistence-queue.ts:135` — inline tmp+rename, header line 1, messages 2+), NOT `writeSessionJsonl` (`jsonl.ts:173`), which the ordinary save path never calls (its only production caller is the session-bundle import, `SessionManager.ts:16811`); readers: `readSessionJsonl:127`, `readSessionHeader:83`, `readSessionMessages:315`; production session-open read: `loadSession` (`storage.ts:320`).
- Pi subprocess is NOT in scope: ✎ `packages/pi-agent-server/src/compat/pi-runtime-adapter.ts` (sessionManager bindings at :36/:166/:186-189, strategies inMemory|continueRecent|open|forkFrom) — the subprocess keeps writing what it writes; the mirror rides the HOST's persistence of the session JSONL.
- ✎ Prior art correction: `packages/shared/src/sessions/store-v2.ts` already exports an interface named `SessionStore` (the W5 LOCAL storage facade, re-exported from the sessions barrel, consumed by `packages/server-core/src/bootstrap/storage-runtime.ts`). To avoid the collision the mirror contract uses OUR names — `SessionMirrorStore`, `MirrorSessionKey`, `SessionMirrorEntry`, `MirrorEvent` — with the documented method shape (`append`/`load` + the four optional methods). Sound because no shipped runtime consumes Claude's SDK option; the page is portability guidance, not a compatibility surface.
- Wire/event precedent for surfacing errors: `OutboundError`/`OutboundEvent` shapes (`packages/pi-agent-server/src/index.ts:455/:349`) are subprocess-side; the mirror is host-side, so `mirror_error` surfaces as a session system message + log, not a new subprocess RPC.
- Resume: `branchFromSdkSessionId` / `branchContextStrategy` (`SessionManager.ts:1274/:7487`); local-load happens through `readSessionJsonl` — the fallback slots in front of that read.

**Contract source:** `code.claude.com/docs/en/agent-sdk/session-storage.md` (the whole envelope), `agent-sdk/sessions.md`, `agent-sdk/hosting.md`. Distilled with 13 numbered facts in doc-verification § R6 — the plan below names the ones that bind.

## Global Constraints

- One commit per task; no `Co-Authored-By`; no MR/tags; never reset/rebase/amend; pathspec-limited commits; do not touch `docs/superpowers/specs/`; you may edit this plan file. Implementation-First Verification Budget. Tests from the repo root (CONFIG_DIR guard).
- **Local disk is written FIRST and stays authoritative.** A mirror failure must never fail, delay-block, or reorder the local write. The mirror consumes the persistence queue's output, not its input.
- **The failure envelope, exactly** (session-storage.md): at most **3 attempts** on rejection with short backoff; a **timed-out call is NOT retried**; on giving up the batch is **dropped**, a `{type:'system', subtype:'mirror_error'}` session message is emitted, and the session continues; `append` must **dedupe by entry uuid** (a retried batch can re-deliver).
- **`SessionKey { projectKey, sessionId, subpath? }`** — absent `subpath` = main transcript; `subpath: 'subagents/agent-<id>'` addresses subagent transcripts. OUR projectKey equivalent is the composite workspace/session key — a deliberate divergence; the conformance suite must parameterize the key, not assume Claude's shape (doc-verification § R6 fact 13).
- **File checkpointing position (fact 3), stated in code comment + plan:** the mirror carries transcripts only; file-history checkpoint blobs are NOT mirrored. We do not adopt Claude's throw-on-combination — we ship digest-verified checkpoints as a separate subsystem; document that a mirror restore does not restore checkpoint blobs.
- **Retention is the adapter's own** (fact 5): the host never deletes from a mirror on its sweep; R12's local sweep is untouched.
- **`load` returns ordered, deep-equal entries** (byte equality NOT required); used only on the fallback path before resume.
- Renderer strings (if any) i18n'd in ALL locales; parity+sorted green.
- The recurring defect count is ELEVEN. The mirror sits between the persistence queue (shared), SessionManager (server-core) and configuration (settings). Assert through the production `saveSession`/flush path — a mirror that a unit calls directly but the queue never invokes is the defect again.

---

### Task 0: Pre-phase — R11 polish: humanize LOADED FILES labels

CDP pass 9 (checklist § Context breakdown): the overlay renders raw resource keys (`instruction::project::<ws>::<key>::::AGENTS.mdINSTRUCTIONS`). Render the file name + a scope badge (project/user/memory) instead; keep the token count. i18n for the scope labels.

- [x] **Step 1:** Failing overlay test: a loadedFiles entry with a raw layer key renders `AGENTS.md` + scope, not the raw key. **Step 2:** Implement + i18n. Commit: `fix(context): humanize loaded-file labels in the /context overlay` (done: `32e4d61d`)

### Task 1: Re-verify the plan against current code

- [x] **Step 1:** Re-check every anchor above on HEAD; correct the plan file where drifted; record corrections in the Task 2 commit body. Confirm where `sessionPersistenceQueue` flushes (the exact call site the mirror taps) and what entry granularity it sees (whole-session write vs per-message append — this decides how mirror batches are diffed; write down the answer in this plan file).

**Task 1 answer (verified at `32e4d61d`).** Flush call sites: (a) `saveSession` (`storage.ts:305-306`, enqueue + immediate `flush`), (b) the 500 ms debounce timer inside `enqueue` (`persistence-queue.ts:104-106` → `write(key)`), (c) `flushAll` on app quit. Every path funnels into `writePending` (`persistence-queue.ts:135`), which writes a **whole-session snapshot** (header line 1 + all messages) atomically each time — there is NO per-message append at this seam. Therefore the HOST diffs mirror batches itself: a per-session in-memory cache of already-mirrored entry uuids; each successful local write converts the written JSONL lines to mirror entries and appends only the not-yet-mirrored ones. Entry uuids are **content-addressed** — message entries `uuid = <messageId>#<hash8(json)>` (a mutated message re-mirrors as a new revision; store-side uuid dedup still kills true re-deliveries), header entries `uuid = header#<hash8(header minus volatile lastUsedAt)>` (metadata-stable flushes re-mirror nothing). Rebuild on `load`: entries in order; last header revision wins; per message id the last revision wins at first-occurrence position; a `session_reset` marker entry (emitted when a previously-mirrored message id disappears from the snapshot, e.g. clear/recovery) resets the id baseline so cleared messages are not resurrected. After a given-up (dropped) batch the uuid cache is NOT advanced, so later flushes may re-deliver the same entries — a deliberate superset of Claude's drop semantics (drop abandons the delivery, never the data; local-first is unaffected).

### Task 2: The contract module (pure, shared)

**Files:** new `packages/shared/src/sessions/mirror/` — `types.ts` (SessionStore, SessionKey, SessionStoreEntry, MirrorEvent), `envelope.ts` (the retry/timeout/dedup engine), `summary-fold.ts`, plus an `InMemorySessionStore` for tests
- Test: colocated; injectable clock/timeout; table-driven

- The envelope: batch append → on rejection retry ≤2 more times with backoff; timeout → no retry; give-up → drop + emit `mirror_error` callback; uuid dedup on the store side of the boundary.
- Summary sidecar (fact 1): `foldSessionSummary` applied inside `append` for main-transcript batches (skip `subpath` batches), `mtime` stamped at persist time, serialized under a per-session lock (compare-and-swap or lock — pick one, test the race).

- [x] **Step 1:** Failing tests: 3-attempts-then-drop; timeout-no-retry; dedup on re-delivered batch; `mirror_error` carries the giving-up reason; summary folds only main-transcript batches; two concurrent appends for one session serialize the sidecar.
- [x] **Step 2:** Run — FAIL. **Step 3:** Implement. **Step 4:** PASS. Commit: `feat(sessions): SessionStore mirror contract and failure envelope` (done: `36c4258f`)

### Task 3: Production wiring + configuration

**Files:** the persistence seam (`storage.ts` / SessionManager flush path), a `sessionMirror` settings key (strict parser beside sandbox/worktree/workflow — REMEMBER the R4 lesson: add the key to `StoredConfigKnownFields` in `validators.ts`, and prove it with a disk round-trip through `loadStoredConfig`), a built-in `directory` adapter (mirror into a second root; enough to prove the chain e2e without a network dependency)
- Test: through the production `saveSession` → queue → flush path; plus the validators round-trip

- Local write first, mirror after, never blocking; `mirror_error` lands as a session system message (visible in transcript) + log line.
- Config: `sessionMirror: { adapter: 'directory', path: ... }` (absent = no mirror, zero overhead); managed layer may set it; unknown adapter names fail closed with a clear diagnostic.

- [x] **Step 1:** Failing tests: a saved session appears in the mirror directory after flush (production path); local write succeeds when the mirror path is unwritable AND the session gains a `mirror_error` system message; config round-trips `loadStoredConfig` (the R4 envelope regression class); unknown adapter → clear error, session persistence unaffected.
- [x] **Step 2:** Implement. Commit: `feat(sessions): wire the mirror into persistence with the directory adapter`

  Note (scope): the managed-policy layer for `sessionMirror` is NOT wired in this
  task — the parser is layer-agnostic (`parseSessionMirrorSettingsV1` accepts any
  layer), so a later managed hookup is additive; only the user `config.json`
  layer ships here, matching the Step 1 test manifest.

### Task 4: Load-fallback before resume

**Files:** the resume read path (in front of `readSessionJsonl` on session open/restore)
- Test: production resume seam

- If the local transcript is missing or unreadable AND a mirror is configured: `load(key)` → ordered entries → rebuild the local JSONL (atomic write) → resume proceeds; mirror still not authoritative (a later local write wins as usual). Checkpoint blobs are not restored — state that in the emitted log line.

- [x] **Step 1:** Failing tests: deleted local JSONL + populated mirror → session opens with full history through the production open path; corrupt local JSONL → same; no mirror → today's behavior byte-for-byte.
- [x] **Step 2:** Implement. Commit: `feat(sessions): mirror load-fallback before resume`

  Note (scope): subagent-transcript restore via `listSubkeys` is contract-ready
  in the adapters but has no host producer yet — the queue mirrors only the main
  session JSONL today, so only the main transcript is restored (exactly the
  documented consequence of the missing half).

  **CDP pass 10 fix (recurring-defect instance twelve):** the renderer resolves
  sessions through the LISTING built at boot (`initialize` →
  `loadSessionsFromDisk` → `sessionStore.list`), which skips a session
  directory without a readable jsonl — so the open-path fallback above was
  never reached and ChatPage showed `chat.sessionNoLongerExists`
  (ChatPage.tsx:779). Decision: **restore at list time** —
  `restoreMissingMirroredSessions` sweeps every workspace's session
  DIRECTORIES before listing in `SessionManager.initialize()` and rebuilds any
  missing/unreadable jsonl from the mirror, so listing/open/renderer all work
  on the ordinary local file afterwards. Chosen over synthesizing list entries
  from mirror summaries (two seams, phantom risk). A fully DELETED session
  directory is deliberately NOT resurrected — local deletion stays
  authoritative; with no mirror configured the sweep is a no-op (no phantoms).
  The Task 4 open fallback remains as the second net for jsonl loss while the
  app is running.

### Task 5: Conformance suite

**Files:** `packages/shared/src/sessions/mirror/conformance.ts` (exported helper running the envelope contract against any adapter) + runs against `InMemorySessionStore` and the `directory` adapter
- Portable: parameterized SessionKey shape (fact 13). Do NOT vendor Claude's example suite (licence unchecked — fact 8); write ours from the documented contract.

- [x] **Step 1:** Failing conformance run on a deliberately broken adapter (drops entries) — proves the suite bites. **Step 2:** Green on both shipped adapters. Commit: `test(sessions): portable mirror conformance suite`

### Task 6: Close-out

- [x] **Step 1:** Full gates (run 2026-07-28 at `07bd2e36`): `bun run typecheck:all` clean (all 8 packages); `bun run test:shared:all` 48 pass / 0 fail; server-core suite 870 pass / 0 fail (124 files); pi-agent-server suite 429 pass / 0 fail (58 files); `bun run lint` 0 errors (4 pre-existing warnings in untouched files); i18n parity OK (2004 keys) + sorted OK; `git diff --check` clean. Full `bun test packages/shared` additionally run: 5292 pass / 10 fail — all 10 failures (storage-readiness / paths-default-root / restore-portability) reproduce identically on the pre-plan base `424d0479`, i.e. pre-existing environment failures, not this plan's.
- [x] **Step 2:** Mutation probes — all four bit and all four restored to green: (a) retrying timed-out calls → `a timed-out call is NOT retried` FAILED; (b) mirror append moved before the local write → `an unwritable mirror never fails the local write` FAILED; (c) uuid dedup removed → `append dedupes by entry uuid` FAILED (and the conformance suite failed on both InMemory-backed adapters); (d) `sessionMirror` dropped from `StoredConfigKnownFields` → both subprocess round-trip tests FAILED with the R4 envelope error.
- [x] **Step 3:** Report: per-task shas, real gate numbers, deviations, probe results, and the CDP cases for the planning session — expected: with a `directory` mirror configured, a live chat's JSONL appears mirrored after a turn; deleting the local JSONL and reopening the session restores history from the mirror; an unwritable mirror shows the `mirror_error` system message in the transcript while chat keeps working; `/context` LOADED FILES shows humanized labels. (Delivered in the executor's final report; CDP pass 10 is the planner's.)
