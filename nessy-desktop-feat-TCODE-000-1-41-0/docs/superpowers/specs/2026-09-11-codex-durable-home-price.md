# What a durable per-workspace `CODEX_HOME` costs — measured 2026-09-11 (C3.180, QL4)

**The question, verbatim from the owner's 2026-09-11 answer to QL4:** codex's native memory is
*"opened IF a durable `CODEX_HOME` costs ≤ M — measure the price, do not refuse."*

**The answer: the price is measured below and it is not ≤ M, so the subsystem stays closed — and the
refusal names what it costs rather than asserting one.** Two premises the question rested on moved
under measurement, and both moved against opening it. Nothing was built on codex for this row; the
OFF direction landed by P6.166 (`[memories] generate_memories = false` when the host switch is off)
is untouched and still the whole of what we write.

Everything here was taken on 2026-09-11 against the binary this repo ships —
`apps/electron/resources/bin/codex/darwin-arm64/codex-app-server`, `rust-v0.150.1`
(`packages/codex-protocol/manifest.json` `upstream.tag`, `scripts/fetch-codex.mjs`) — and against the
source at that same tag, which outranks the page (AGENTS.md §"The two runtimes need different
evidence"). Rig: the real `CodexRuntimeManager` + `AppServerClient` over homes built by the real
`writeCodexConfig`; **no turn was ever run, so no model call and no gateway spend**; load average
14–20.

---

## 1. The mechanism, re-read at the shipped tag

`MemoriesToml` is still exactly twelve fields at `rust-v0.150.1`
(`codex-rs/config/src/types.rs`): `disable_on_external_context`, `generate_memories`, `use_memories`,
`dedicated_tools`, `max_raw_memories_for_consolidation`, `max_unused_days`, `max_rollout_age_days`,
`max_rollouts_per_startup`, `min_rollout_idle_hours`, `min_rate_limit_remaining_percent`,
`extract_model`, `consolidation_model`. `MemoriesConfig::default` is `generate_memories: true`,
`use_memories: true`, and the defaults that bound the pipeline are
`DEFAULT_MEMORIES_MAX_ROLLOUTS_PER_STARTUP = 2`, `MAX_ROLLOUT_AGE_DAYS = 10` (clamped 0–90),
`MIN_ROLLOUT_IDLE_HOURS = 6` (clamped 1–48), `MAX_UNUSED_DAYS = 30`.

The memories root is not configurable and is not a sibling of the home: `codex-memories-write`'s
`memory_root` is literally `codex_home.join("memories")` (`codex-rs/memories/write/src/lib.rs`). So
the ledger's premise — a durable memories directory means a durable `CODEX_HOME` — is correct at the
shipped tag. There is no `CODEX_MEMORIES_DIR`, and `sqlite_home` relocates the state DB, not this.

**Premise correction 1 — the ephemeral home is not the only blocker, and we are not the only
gate.** `Feature::MemoryTool`, key `"memories"`, is `Stage::Stable` with **`default_enabled: false`**
(`codex-rs/features/src/lib.rs`). Measured on the shipped binary through `experimentalFeature/list`
over the real app-server connection, both directions, 124 features listed in one page:

| arm | `memories` entry |
| --- | --- |
| the home this product writes today | `{"name":"memories","stage":"stable","enabled":false,"defaultEnabled":false}` |
| the same home + one inserted `[features] memories = true` | `{…,"enabled":true,"defaultEnabled":false}` |

So opening it is a deliberate act on our side — one key in the `[features]` table the config writer
already emits — and the ledger's *"unreachable for a HOST reason"* is half the story: it is
unreachable for a host reason **and** switched off by codex's own default.

**Premise correction 2 — what the subsystem does is precisely the thing the owner refused to build
by hand.** From `codex-rs/memories/README.md` at the shipped tag: the pipeline *"is triggered when a
root session starts"*; Phase 1 *"claims a bounded set of rollout jobs"*, *"sends each rollout to a
model (in parallel, with a concurrency cap)"* and stores the result; Phase 2 *"spawns an internal
consolidation sub-agent"*, syncs `raw_memories.md` and `rollout_summaries/`, keeps the memories root
as a git baseline under `~/.codex/memories/.git`, and leaves *"consolidated outputs such as
`MEMORY.md`, `memory_summary.md`, and `skills/` … for the agent to update"*. That is background
distillation of finished chats — the posture C3.182 records a refusal of on the host side. Opening
it on codex would not be *enabling a memory store*; it would be adopting, on one runtime, the exact
mechanism declined on the other two. That is a product decision for the owner, not a wiring decision
for a lane, and it is stated here rather than taken quietly.

## 2. What a durable home would actually carry — measured

Three probes, each a real boot of the shipped binary against a home written by `writeCodexConfig`.

**Footprint.** `du -sh` on four homes after one boot each: **2.8 M, 26 M, 52 M, 76 M**. The spread is
not noise: a boot clones a plugin catalogue into `CODEX_HOME/.tmp/plugins-clone-<rand>/` (25 plugin
directories seen at 8 s), and the longer a boot lives the further that clone gets. The stable part is
about 2.5 MB — five sqlite databases with their WALs (`state_5`, `goals_1`, `logs_2`, `memories_1`,
`queue_1`; `state_5.sqlite-wal` alone is 1.7 MB after a bare `thread/start`), the re-extracted
bundled `skills/` tree (39 entries), `shell_snapshots/` (169 KB per thread),
`thread-writer-locks/`, `installation_id`, `.sandbox_migration`, `config.toml`.

> **An instrument correction worth keeping.** A directory walk that sums `statSync().size` reports
> **609 MiB** for the same home, and it is wrong: `CODEX_HOME/tmp/arg0/codex-arg0<rand>/` holds three
> SYMLINKS (`applypatch`, `apply_patch`, `codex-execve-wrapper`) to the 185 MB binary, and `statSync`
> follows them. Read `du`, not a walk.

**What a second boot on the same home changes.** Booting twice against one home added and removed
exactly seven paths — one `thread-writer-locks` lock, one `shell_snapshots` file, and the five
`tmp/arg0` entries — and nothing else: 5491 files / 2404 dirs before and after. So a durable home is
durable in the way that matters: the skills tree is not re-extracted, the plugin clone is not
repeated, and the sqlite set accumulates.

**What that buys, in paired alternating arms** (the trap this repo has paid for: a single
before/after pair measures the page cache). Six boots in one process, binary cache warmed by a
discarded boot first, cold and warm homes alternating:

| arm | `initialize` | `thread/start` |
| --- | --- | --- |
| A cold h1 | 195 ms | 155 ms |
| B warm h1 | 76 ms | 104 ms |
| C cold h2 | 197 ms | 297 ms |
| D warm h2 | 50 ms | 100 ms |
| E warm h1 | 66 ms | 140 ms |
| F warm h2 | 454 ms | 717 ms |

Cold 195/197 against warm 76/50/66 on `initialize`, cold 155/297 against warm 104/100/140 on
`thread/start`, with F an outlier that shows the noise floor is wide at load 20. Call it **roughly
200–250 ms of session startup**, the same direction and order as P3.296's 957 ms → 771 ms reading.
That is the entire measured benefit, and it is available today without memories at all.

## 3. The price, itemised

**(a) The rollout containment is ours, and durability removes it.** `describeCodexRolloutPersistence`
(`packages/shared/src/agent/codex-agent.ts`) is the sentence we ship to operators: codex writes every
turn — prompts, tool arguments and full tool OUTPUT — at mode 0644, and P3.182 measured that codex
offers *no* off switch, *no* retention setting and *no* redaction (no rollout key in its 97-element
`ConfigToml`; every `redact` in the artifact belongs to the vendored AWS SDK). The whole control is
two of our lines — `mkdtempSync` + `chmodSync(0o700)` in `createRuntime`, `rmSync` in
`cleanupRuntimeResources` — and a durable home deletes the second one. Worse, the feature *needs* it
deleted: Phase 1 reads rollouts, `max_rollout_age_days` defaults to 10 and clamps at 90, so the
feature's own selection window IS the retention period we would be committing to. And the floor does
not help: a credential the permission floor stops a tool from READING is a different thing from one a
tool has already read and codex has written down.

**(b) Two documented invariants say the home is per-chat, and a per-workspace home breaks both.**
`CodexConfigOptions.memoriesEnabled` (P6.754) admits a per-CHAT memory value into `config.toml` *"because
the file is per-chat: `CodexAgent.createRuntime` mints a fresh `CODEX_HOME` per runtime"*, and
`CODEX_RULES_DIR` says the projected execpolicy grants are safe to rewrite *"from scratch on every
build (the home is ephemeral)"*. One home per workspace means concurrent chats in that workspace share
one `config.toml`, one `rules/nessy.rules` and one `agent-roles/` — carrying this session's loopback
adapter port, this session's callback-bridge port, this session's grants and this session's roles,
last writer wins. That is a silent-divergence generator of exactly the class this fork keeps paying
for, and it is strictly worse than the capability being absent.

**(c) Isolation.** P3.296 already declined the durable half and priced it: the five sqlite databases
and the skills re-extraction were declined *"against carrying a shared mutable sqlite set across
concurrent sessions that the per-session home exists to keep apart"*, for about 190 ms. Nothing in
the 2026-09-11 measurement changes that trade; the `thread-writer-locks/` directory and the
`.coordination.lock` inside it are codex's own admission that concurrent writers are a thing it
coordinates per home.

**(d) Unrequested model spend, with the guard that would bound it inert for us.** Phase 1 sends
rollouts to `extract_model` with a 150 000-token per-rollout limit and a concurrency cap of 8
(`codex-rs/memories/write/src/lib.rs` constants), and Phase 2 spawns a consolidation sub-agent — all
at session start, in the background, with no user action. The one built-in brake,
`min_rate_limit_remaining_percent`, is **inert in our topology**: `guard::rate_limits_ok` is
`rate_limits_check(...).await.unwrap_or(true)`, and `rate_limits_check` returns `None` the moment
`!auth.uses_codex_backend()` — which is every session this product runs, because our sessions reach a
loopback Responses adapter or a declared provider, never the ChatGPT backend. So the field exists,
we could write it, and it would decide nothing. The spend would land on the user's gateway quota.

**(e) Cleanup has no owner today.** The only thing that ever removes a `CODEX_HOME` is
`cleanupRuntimeResources`. A durable per-workspace home needs a retention policy, a deletion path
(and codex's own `memory/reset` over app-server is per-memory-DB, not per-home), and a disclosure —
none of which exists, and all of which the user pays for if it does not.

**(f) One credential that currently dies with the session.** `NESSY_CODEX_OTLP_HEADERS_ON_DISK`
(P6.488, owner decision Q24) deliberately relaxes the writer's standing invariant and writes OTLP
collector headers into `config.toml` as literals. Today that file is deleted at teardown. A durable
home keeps it.

## 4. The measurement that settles it: the pipeline did not run on our path

With `[features] memories = true` written into the very table our config writer already emits, a
permissive `[memories]` table (`min_rollout_idle_hours = 1`, `max_rollouts_per_startup = 2`), a
non-ephemeral thread and the home reused across boots:

- `CODEX_HOME/memories/` was **never created** — across three boots in two probes, two of them on the
  same reused home. `start_memories_startup_task` calls `ensure_layout(&root)` before any phase runs,
  so the directory is what a spawned pipeline creates first, whether or not it has an eligible
  rollout.
- With `RUST_LOG=debug`, **2043 stderr lines and zero containing `memor`**.
- `sessions/` was never created either, with no turn run.

Controls on the same rig, which is what makes those absences readings rather than a dead probe: the
crate IS linked into the shipped binary (`state db unavailable for memories startup pipeline`,
`failed preparing memories root`, `raw_memories.md`, `rollout_summaries`,
`skipping memories startup because Codex rate limits` all present, 1–24 hits each); the feature
reported `enabled: true` on the same connection; the same boots wrote five sqlite databases including
`memories_1.sqlite`, 194 skills-related and 415 plugin-related log lines; and the thread span itself
prints `ephemeral=false`, twelve times, so the first of the three startup gates is not the one that
closed.

**What is NOT established:** which surface calls `start_memories_startup_task`.
`app-server/src/request_processors/thread_processor.rs` carries `thread/memoryMode/set` and
`memory/reset` but no call to it, and `thread_lifecycle.rs`, `tui/src/lib.rs`, `exec/src/lib.rs` and
`cli/src/main.rs` return zero hits for the symbol. So the honest verdict is: **the mechanism is
present in the binary and did not engage over the app-server protocol this product speaks, with the
feature explicitly on and the home reused.** Finding the entry point is another measurement, and it
is the first thing to do if the owner ever reverses this.

## 5. Verdict

**Refused, with the price named.** The build is not "make the home durable" — that alone is (a)+(b)+(c)+(e),
a retention policy, a disclosure and a per-session/per-workspace split of a file that is currently one
file per chat. Add (d), a background model cost with its only brake inert, and §4's unresolved entry
point, and the honest size is **L with a product posture inside it**, not M. The owner's condition was
"≤ M"; it is not met, and this document is the measurement that says so rather than a refusal that
asserts it.

**What would change the answer**, in the order it would have to be answered:

1. The posture question first: is background distillation acceptable on one runtime when it is
   refused on the other two? (C3.182 records the refusal; this is its mirror.)
2. The entry point: does the pipeline run at all over app-server, and under what session source?
3. Only then the topology: a durable home needs the per-chat `config.toml`, `rules/` and
   `agent-roles/` moved OUT of it, or a home per chat with a shared `memories/` — and codex resolves
   all of them from one root, so that is a fork-side layout, not a setting.

**What stays true today:** the host's memory switch reaches codex in codex's own vocabulary (P6.166,
the OFF direction only), the per-chat scope reaches it on the wire (`thread/memoryMode/set`, P6.754),
and codex's memory writes nothing durable because the home does not survive the session.
