# P2.282 — report

**Status:** DONE. Commit `e6f9208f1` on `feat/TCODE-000`. Base SHA recorded before starting:
`f58f66a36f6314384fef1d4c535f7772dd0ca84b`.

---

## 0. The headline: "unknown" resolves as **fail-OPEN — it crosses to remote**

The row offered two possibilities and asked which holds. **Neither does.** There is a third,
and it is the one with teeth.

`RoutedClient` (`apps/electron/src/transport/routed-client.ts:144`) routes on `isLocalOnly()`
alone:

```ts
const isLocal = isLocalOnly(channel)
const target = isLocal ? this.localClient : this.workspaceClient
```

`LOCAL_ONLY` is the only set consulted at runtime. Its **complement — which includes every
unclassified channel — goes to the workspace client.** So an unclassified channel is not
"may not cross" (the safe reading) and not "unreachable" (the larger-finding reading). It
**silently crosses**, behaving exactly as if someone had classified it REMOTE_ELIGIBLE.

Measured, not inferred. I drove the real `RoutedClient` with two distinguishable stub clients
and positive controls on both sides:

```
workspace:importClaudePreview  isLocalOnly=false isRemoteEligible=false -> routed to: WORKSPACE
workspace:importClaudeApply    isLocalOnly=false isRemoteEligible=false -> routed to: WORKSPACE
control LOCAL_ONLY   window:getWorkspace -> LOCAL
control REMOTE_ELIGIBLE sessions:get     -> WORKSPACE
local client received:     ["window:getWorkspace"]
workspace client received: ["workspace:importClaudePreview","workspace:importClaudeApply","sessions:get"]
```

**Consequences, in the order they matter:**

1. **The import feature is NOT broken for remote clients today.** It works. The shipped
   behaviour is byte-identical to the classification I went on to choose deliberately. So this
   is not the larger finding the row braced for.
2. **But it was safe by luck, not by decision** — and the luck ran the *permissive* way. Had
   these two channels needed to be LOCAL_ONLY, the same silence would have shipped a genuine
   remote-crossing hole with a red test as the only signal.
3. **The general property is the real finding.** Any channel added without classification
   becomes remote-crossing by default. The exhaustiveness test is not a tidiness check — it is
   the sole barrier between a forgotten channel and an unmade transport decision. **That
   barrier was already down:** the test has been red on this branch since `e815ad274`.

### `transport-locality.md`'s "Fail closed" does not govern this table

The row's premise was that the doc records a fail-closed rule and asked whether it holds here.
The doc's sentence is true, but it is about a **different mechanism with inverted polarity**:

> **Fail closed.** An unknown or empty capability set reads as REMOTE. That costs a desktop
> nothing (it always advertises) and it means a client we did not anticipate cannot inherit
> local privileges by accident.

— `docs/architecture/transport-locality.md` § "The decision"

That governs the **client capability set** (`isLocalClient`), whose sole production caller is
the permission-mode ceiling at `packages/server-core/src/handlers/rpc/sessions.ts:771`. There,
"unknown → REMOTE" means **fewer** privileges, so it genuinely fails closed.

In the **channel routing table**, "unknown → remote" means **permitted to cross**. The words
are identical; the safety polarity is opposite. A reader consulting that doc to reason about
channel routing draws precisely the wrong conclusion — which is a fair description of how these
two channels arrived unclassified without anyone noticing.

---

## 1. Premise verification — the row is accurate, and for once the count is not a subset

Reproduced on the base SHA before touching anything:

```
Ran 8 tests across 1 file.   6 pass, 2 fail
  (fail) every channel is classified exactly once   — workspace:importClaudePreview
  (fail) total classified equals total channels     — Expected: 350, Received: 348
```

Enumerated the unclassified set programmatically rather than trusting the first name the test
reports (rows on this plan have repeatedly stated a subset):

```
total channels: 350   LOCAL_ONLY: 152   REMOTE_ELIGIBLE: 196
unclassified count: 2
  workspace:importClaudePreview
  workspace:importClaudeApply
in BOTH: []          duplicate channel strings: false
```

Exactly two, no double-classification, no duplicate wire strings. **152 + 196 = 348 vs 350.**
The row's numbers are correct in every particular.

The row's sub-millisecond timing claim also reproduces — in the isolated re-break rig the two
assertions fail in **1.86 ms and 0.80 ms**. (In the shared tree under mutex load they took
197 ms / 134 ms; that is load, not a different phenomenon. Worth knowing that the timing
signature degrades under concurrency, since it is the discriminator the survey relied on.)

---

## 2. The classification decision — REMOTE_ELIGIBLE, argued from the feature

I deliberately did not reason from symmetry with neighbours. What the feature does:

- **Source.** `computeClaudeSetupImportPlan` resolves `const home = options.homeDir ?? homedir()`
  (`packages/shared/src/capabilities/claude-setup-import.ts:160`), reading `<home>/.claude` and
  `<home>/.claude.json`. The handler passes **only** `{ workspaceRootPath }`
  (`packages/server-core/src/handlers/rpc/sources.ts:87`), so `homeDir` is undefined and the
  home directory is **the handler process's own** — i.e. the server that owns the workspace.
- **Destination.** `workspace.workspaceRootPath` on that same server: `<ws>/AGENTS.md`,
  `<ws>/skills/<slug>/`, `<ws>/hooks.json`, and workspace MCP sources. Then
  `notifyCapabilityChange(...)` invalidates that workspace's capability catalog.
- **No client operand anywhere.** No dialog, no shell, no Electron API. The handler lives in
  `server-core`, which runs unchanged in the headless `nessy-server`.

**Therefore REMOTE_ELIGIBLE**, on the file header's own criterion ("Runs on whichever server
owns the workspace").

**LOCAL_ONLY would be wrong, not merely conservative.** The agent that consumes the imported
skills, hooks and MCP sources runs on the workspace owner. Importing on the client would write
the setup onto a machine the agent never reads — the operation would report success and have no
effect. Compare `file.READ_USER_ATTACHMENT`, which *is* LOCAL_ONLY, and whose in-file comment
gives the discriminating reason: its paths "were captured via `webUtils.getPathForFile` in the
renderer, so they point at the user's local machine". That is the test, and this feature fails
it in the opposite direction.

**Checked before accepting a client-supplied argument.** `IMPORT_CLAUDE_APPLY` takes a
`confirmedPlan` over the wire, which would be a path-injection vector if apply trusted it. It
does not: the plan is used **only** as a filter on `identity = kind\0name\0action`, while every
payload and path is re-derived server-side from a fresh scan (`applyClaudeSetupImportPlan`, and
`writeSkill(ws, skill)` takes `skill` from `collected.skills`, never from the client's plan). No
injection path. Safe to accept from a remote caller.

---

## 3. Tests — one positive, one boundary, namespace-scoped

The global exhaustiveness test does detect an omission, but only as an **off-by-two on a total
of 350**, and it says nothing about *which side* the channel belonged on. Since the defect being
guarded is a wrong-side decision, I added guards that name the intent:

- **positive** — every `RPC_CHANNELS.workspace.*` is REMOTE_ELIGIBLE
- **boundary** — every `RPC_CHANNELS.workspaces.*` (plural) is LOCAL_ONLY

The one-letter namespace distinction is real and verified across all 13 channels:
`workspace:*` = content/config *of* a workspace (owner-side, all 8 REMOTE_ELIGIBLE);
`workspaces:*` = the local app's registry of workspaces (all 5 LOCAL_ONLY). Note `SETTINGS_GET`
/`SETTINGS_UPDATE` use the `workspaceSettings:` wire prefix, so the test iterates the
`RPC_CHANNELS.workspace` object (mirroring the existing `server:*` test) rather than string-
prefixing, which would silently miss them.

Both failure messages tell a future dev to **move the channel to a local namespace rather than
make an exception** — a thinking prompt, not a nudge to mis-classify to satisfy a test.

I did **not** add a test pinning the fail-open direction itself: that requires `RoutedClient`
from `apps/electron`, and importing it into `packages/shared` would invert the package
dependency. See recommendation R1.

---

## 4. Gates — all run, with proof of work

| Gate | Result | Proof |
| --- | --- | --- |
| `bun test` routing (mutex, `--label P2.282`) | **PASS** | `Ran 10 tests across 1 file.` `10 pass, 0 fail, 365 expect() calls` (was `Ran 8`, 6 pass / 2 fail) |
| Re-break vs base SHA | **PASS** | `Ran 10 tests across 1 file.` `7 pass, 3 fail` |
| `typecheck:shared` | **RED — not mine** | 4 errors, `0` in `src/protocol/`; see below |
| `eslint` (from `packages/shared`, not repo root) | **PASS** | `files linted: 2` — `routing.ts` 0/0, `routing.test.ts` 0/0 |
| `git diff --check` | **PASS** | exit 0, no output |

No full repo suite, per the brief.

**Re-break method.** `routing.test.ts`, `routing.ts` and `channels.ts` have **zero non-relative
imports** (only `bun:test`), so I ran the **real test file byte-for-byte** against `routing.ts`
and `channels.ts` extracted from the recorded base SHA into an isolated scratch tree — no
worktree, so the symlinked-`node_modules` trap cannot apply, and no `HEAD~1`. Harness verified
before use: old `routing.ts` has 0 `IMPORT_CLAUDE` hits, base `channels.ts` has 2 (the channels
existed; only the classification was missing), new test file present. Result:

```
(fail) every channel is classified exactly once            [1.86ms]
(fail) total classified equals total channels              [0.80ms]
(fail) every workspace:* channel is REMOTE_ELIGIBLE        [0.63ms]
    workspace:* channel "workspace:importClaudePreview" is not REMOTE_ELIGIBLE. …
7 pass, 3 fail
```

The new guard fires and names the channel. The `workspaces:*` boundary test passes at base —
correct, it was never broken; it exists to keep the positive test honest.

**Typecheck, stated precisely so it does not read as either mine or as passed.** `typecheck:shared`
exits 2 with **4 errors in exactly 2 files, both belonging to another lane's uncommitted work**:
`src/agent/__tests__/runtime-capability-drift.test.ts` (` M`, +49/-4 vs base) and
`src/agent/__tests__/session-command-out-of-band-seam.test.ts` (`??` — untracked, brand new).
**Zero errors in `src/protocol/`.** Not pre-existing on the branch, not caused by me, and not
mine to fix — flagging it so the owning lane sees it.

---

## 5. Findings, tagged and classified

**F1 — The channel routing table is fail-OPEN on unknown, and this is nowhere stated.**
`[doc:none]` · **never-looked-at**. `LOCAL_ONLY` is the only runtime-enforced set; its
complement crosses to the workspace server. Nothing in `routing.ts` or
`transport-locality.md` said so; the file's "two sets" framing actively implies both are
enforced. **Partially addressed** — I documented it in `routing.ts`'s header. The structural
half (R1) is out of my zone.

**F2 — Two channels shipped as an unmade transport decision.** `[doc:none]` · **bug**.
`e815ad274`, not on `master`. **FIXED** in `e6f9208f1`. Shipped behaviour was already correct
by accident; the decision now exists and is guarded.

**F3 — `transport-locality.md` reads as governing channel routing, and inverts its polarity.**
`[doc:none]` · **never-looked-at**. Its "Fail closed / unknown reads as REMOTE" is about the
client capability set, where remote = fewer privileges. In routing, remote = allowed to cross.
Same words, opposite safety direction. I added a pointer in `routing.ts`; **the doc itself is
outside my zone and still says nothing about the distinction** — recommend a paragraph there
(R2), because that doc is where someone will go looking.

**F4 — `REMOTE_ELIGIBLE_CHANNELS` and `isRemoteEligible()` have no runtime readers.**
`[doc:none]` · **never-looked-at**. Measured with a positive control on the same rig:
`isRemoteEligible` → 0 call sites outside its definition; `isLocalOnly` → 5 (4 production in
`routed-client.ts`, 1 test). The set is documentation plus the exhaustiveness test's input.
Worth knowing before anyone "hardens" routing by adding to REMOTE_ELIGIBLE and assumes it took
effect.

**F5 — For a remote workspace, the import reads the SERVER OPERATOR's `~/.claude`, not the
user's.** `[doc:none]` · **never-looked-at**. Not a routing defect (the alternative breaks the
feature), but a genuine product question the onboarding copy "import your Claude Code setup"
does not survive: a phone or CLI user driving a remote workspace imports whatever `~/.claude`
exists on the host, and MCP server definitions there can carry credentials in `env`.
**Security severity: low, deliberately.** The same authenticated client can already
`sessions.SEND_MESSAGE` an agent with shell access on that host, so it reads nothing it could
not already read — the trust boundary grants strictly more elsewhere. It is a **correctness and
expectations** issue, not an escalation. Needs an owner call, not a patch.

**F6 — `typecheck:shared` is red from another lane's uncommitted files.** `[doc:none]` ·
observation, not my finding. Detail in §4.

---

## 6. Recommendations (all outside my zone — not actioned)

- **R1** — Pin the fail-open direction with a test in `apps/electron/src/transport/__tests__/routed-client.test.ts`:
  assert an unclassified channel routes to `workspaceClient`. That file already imports
  `isLocalOnly` and has the stub harness; it is a few lines. It converts F1 from a comment into
  a guard. *(Alternatively, make `RoutedClient` throw on a channel in neither set — a genuine
  fail-closed. That is a behaviour change and an owner call, not a lane decision.)*
- **R2** — Add a short section to `docs/architecture/transport-locality.md` distinguishing the
  two mechanisms and their opposite polarities (F3).
- **R3** — Owner decision on F5.

## 7. Housekeeping

No worktrees or clones created (the isolated re-break needed neither), so nothing to prune.
Scratch artefacts confined to the session scratchpad. Commit made by explicit pathspec;
`git show --stat --oneline HEAD` confirms exactly 2 files, 87 insertions, 0 deletions.
