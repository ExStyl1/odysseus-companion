# P2.306 — report

**STATUS: STOPPED BEFORE ANY CODE CHANGE, AS THE BRIEF INSTRUCTS.**

**THE DENY IS HONOURED LIVE.** In the exact config we ship, on the pinned binary, on both the
`command/exec` path and a real model-driven agent turn. The row's central premise — "on codex that
deny is, per the documented contract, not in effect" — is **refuted by measurement**.

Nothing in `packages/codex-responses-adapter/` was edited. `git status` on the zone is empty.

- Measured at `5a6e9bb43` (`docs(sweep): codex triage…`); HEAD at report time `9dfb39f286c94e701fd232192e24465488c5770c` (another lane committed mid-run).
- `git diff 5a6e9bb43 9dfb39f28 -- config-writer.ts` = **empty**; the three `deniedReadPaths: [join(CONFIG_DIR, 'credentials.enc')]` call sites are still 3 at current HEAD. The tree move does not touch what was measured.

---

## 1. The measurement

Binary: `apps/electron/resources/bin/codex/darwin-arm64/codex-app-server`, `openai/codex rust-v0.148.0`
(`packages/codex-protocol/manifest.json`), macOS arm64 (Seatbelt backend). Isolated `CODEX_HOME` per
variant, containing only a `config.toml`. No `requirements.toml` anywhere on the host
(`find` over `~/.codex`, `~/Library/Application Support/Codex`, `/Library/Application Support` → only
`~/.codex/config.toml`, which an isolated `CODEX_HOME` does not load — proven by the controls below,
where variants without a profile read the secret).

### 1a. Round 3 — the one that settles it: a real agent turn

Rig: the in-tree `startStubAdapter` (`packages/codex-responses-adapter/src/stub-server.ts`) as the
Responses upstream, canned to call codex's native `exec_command` tool with `cat <decoy credential>`;
the config is the **verbatim output of `buildCodexConfigToml`**. `approval_policy = "never"` deliberately —
under `on-request` a sandbox denial can escalate into an approval that reruns the command
*unsandboxed*, which would confound the reading. Server→client requests were answered `denied`
anyway, and none arrived.

| Variant | Emitted keys | Tool result seen by the model | Secret leaked |
| --- | --- | --- | --- |
| **T_A** shipped, sandbox ON | `sandbox_mode="workspace-write"` + `default_permissions="nessy_runtime"` + profile deny | `Process exited with code 1 … Operation not permitted` | **no** |
| **T_C** control, no profile | `sandbox_mode="workspace-write"` only | `exited with code 0 … NESSY-DENY-PROBE-SECRET-9f3a` | yes |
| **T_E** shipped DEFAULT, sandbox OFF | `sandbox_mode="danger-full-access"` + profile deny | `code 1 … Operation not permitted` | **no** |
| **T_D** control, no profile | `sandbox_mode="danger-full-access"` only | `code 0 … NESSY-DENY-PROBE-SECRET-9f3a` | yes |

The leak detector discriminates in both directions (T_C/T_D are its positive controls), and the
refusal is observed on the wire the model actually reads — the `function_call_output` of the second
Responses request.

### 1b. Rounds 1–2 — precedence, isolated

Same rig via `command/exec` ("Run a standalone command … in the server sandbox without creating a
thread or turn … defaults to the user's configured policy when omitted" —
`packages/codex-protocol/generated/v2/CommandExecParams.ts`).

| Variant | `sandbox_mode` | profile `extends` | read denied path | write **inside** ws | write **outside** ws |
| --- | --- | --- | --- | --- | --- |
| A_both | workspace-write | `:workspace` | **refused** | ok | refused |
| B_profile_only | *(absent)* | `:workspace` | **refused** | ok | refused |
| C_sandbox_only | workspace-write | *(no profile)* | **read** | ok | refused |
| E_dangerfull+profile | danger-full-access | `:workspace` | **refused** | ok | **refused** |
| **F_disagree** | workspace-write | **`:read-only`** | refused | **REFUSED** | refused |
| **G_disagree** | **read-only** | `:workspace` | refused | **ok** | refused |

**F and G are the precedence experiment.** They make the two systems disagree on one axis and ask
which answer the binary gives. In F the legacy key says "you may write the workspace" and the profile
says read-only → **the write is refused**. In G the legacy key says read-only and the profile says
workspace → **the write succeeds**. The profile governs, both directions.

Round 1 is retained only as a cautionary note: its "sandbox is enforcing writes" control was
**invalid**, because its fixtures lived under `/tmp`, which `workspace-write` treats as writable by
default (`exclude_slash_tmp`). Round 2 moved every fixture out of `/tmp` and the control then
discriminated. Recording this because it is exactly the shape of error that reads as a finding.

### 1c. Attribution — is the refusal really *our* `deny` line?

| Variant | profile filesystem table | read decoy |
| --- | --- | --- |
| H1 | none at all | **read** |
| H2 | denies an *unrelated* path | **read** |
| H3 | denies the decoy (shipped shape) | **refused** |

Plus, in every denying variant, `ls <dir containing the decoy>` **succeeded** — so the block is
path-specific, not a directory-level read restriction inherited from `:workspace`.

### 1d. The other producer — `writablePaths` — is live too

The sweep held that both producers of `policy.filesystem` were inert. Both work:

| Variant | write outside workspace |
| --- | --- |
| W1 `sandbox_mode` only, no profile | refused |
| W2 profile grants `"<dir>" = "write"` | **succeeds, file landed** |

So the plugin `runtime.dataPath` write grant (`codex-agent.ts:2330`) also takes effect.

---

## 2. Findings

### F1 — `[doc:codex]` · kind: **forgotten against the documentation, inverted** — the page is wrong about the binary, our code is right

The citation the sweep took is accurate and I re-verified it against the **rendered** page
(`curl https://learn.chatgpt.com/docs/permissions`, `grep id="…"`; `developers.openai.com/codex/permissions`
308-redirects there). The anchor `#migrate-from-older-sandbox-settings` **does exist**.

`learn.chatgpt.com/docs/permissions.md#migrate-from-older-sandbox-settings` — verbatim:

> "Use one system or the other for a session, not both."

and the page intro (before the first heading, so no anchor covers it), verbatim:

> "If `sandbox_mode` appears in any loaded config file, you pass `--sandbox`, or the selected config
> profile sets `sandbox_mode`, Codex uses those older sandbox settings instead of `default_permissions`."

**The binary does the opposite.** `default_permissions` + `[permissions]` beat `sandbox_mode` on
rust-v0.148.0 (F/G above). The documented escape hatch is not what rescues us: managed
`allowed_permission_profiles` is in **zero** files, no `requirements.toml` existed on the host, and
`permissionProfile/list` still reported `nessy_runtime` with `allowed: true`. Profiles are simply
honoured, allowlist or not.

The page carries its own caveat — "Beta. Permission profiles are under active development and may
change." — and names 0.138.0 as the floor while we pin 0.148.0. The most likely reading is that the
precedence paragraph is stale relative to the shipped binary. **What it is not is a reason to change
our config.** The sweep's §0.1 recommendation ("stop emitting `sandbox_mode` … or drop the profile as
decoration") would, on this evidence, have removed a working credential control on the strength of a
doc paragraph the binary does not implement.

**Sweep §5 hole #1 is now CLOSED.** Hole #2 (`requirements.toml` from `$CODEX_HOME`) is **moot for
this row** — it gated option (b), and option (b) is not needed.

### F2 — `[doc:none]` · kind: **bug** — "sandbox off" does not mean sandbox off, and nobody has looked

This is the finding I would put in front of the owner, and it is the inverse of the row as written.

`codexSandboxConfigForMode` returns `sandbox_mode: 'danger-full-access'` when the master switch is off
(`config-writer.ts:400`, recorded deviation `codex-danger-full-access-when-sandbox-off`). But
`resolveRuntimePolicy` (`:806-812`) derives the profile parent as
`sandboxMode === 'read-only' ? ':read-only' : ':workspace'` — so `danger-full-access` maps to
**`:workspace`**, never to `:danger-full-access`. And `deniedReadPaths` is unconditional at all three
call sites, so `hasFilesystemPolicy` is always true and the profile is **always** emitted.

Since the profile wins, the shipped default configuration runs under a `:workspace` sandbox.
Measured (E, T_E): with `sandbox_mode = "danger-full-access"`, writes outside the workspace are
**refused** and the credential read is **refused**.

Two consequences, opposite in sign, both unmeasured until now:

1. **Good:** the credential deny is in effect *today*, in the default configuration. The sweep's
   "the deny was never enforced in the default configuration" is wrong.
2. **Bad:** an operator who deliberately turns the sandbox master switch OFF still gets a workspace
   sandbox. A codex session cannot write outside the workspace even though the product told it it is
   running with full access. That is a live user-facing constraint that no code comment, test or doc
   in this tree describes.

The code says one thing and does another either way. Which direction to correct is an owner call, and
it is precisely the shape question the brief told me not to pre-empt — so I did not touch it.

### F3 — `[doc:codex]` · kind: **never looked at** — the control works *because* the binary contradicts its own docs, and nothing would notice if that changed

Our credential protection currently depends on undocumented behaviour that the governing page
explicitly contradicts, on a page marked Beta. If a future codex pin implements the documented
precedence, the deny dies **silently**: no unit test would fail (they assert on emitted TOML, not on
enforcement), and `git grep -a -i -E 'credentials\.enc|permission profile|default_permissions'` over
`docs/testing` still returns nothing about the codex profile.

The actionable item is therefore **a regression detector, not a config rewrite** — and it is cheap,
because the rig already exists (see F5). This is the one piece of the sweep's §0.1 that survives
intact: "the live case is part of the fix."

### F4 — `[doc:none]` · kind: **never looked at** — `packages/codex-responses-adapter` is outside the repo's lint graph

There is no `eslint.config.*` or `.eslintrc*` in the package, and root `lint` runs only
`lint:electron`, `lint:shared`, `lint:server-core`, `lint:ui`, `lint:scripts`. Positive control:
`packages/shared/eslint.config.mjs` exists. So a package holding the security-path config writer and
12 test files is never linted. Small, but it is why the eslint gate below is NOT-RUN rather than green.

> **SUPERSEDED 2026-08-28 (P3.185) — the finding was true when measured and is now false. Do not
> read it as permission to skip the eslint gate on this package.** `9f4f15d31` (P2.319, *"eleven of
> fifteen packages could not be linted, and nothing failed"*) added
> `packages/codex-responses-adapter/eslint.config.mjs` and the root script
> `lint:codex-responses-adapter`. Root `lint` is now a chain of **seventeen** scripts, not five, and
> this package is one of them. Re-measured today: `cd packages/codex-responses-adapter && npx eslint .`
> exits **0** with no output. The eslint gate on this package is runnable and green.

### F5 — method, worth keeping: two model-free sandbox oracles already in this tree

Both settle sandbox questions in seconds with no gateway auth and no model spend:

- `command/exec` — a standalone command under the session's resolved policy. Answers "which config
  key wins" directly.
- `startStubAdapter` + `toolName: 'exec_command'` — a full `turn/start` over the agent's native shell
  tool, against canned SSE. Answers "what does the agent actually get to do".

The sweep called the live confirmation expensive and deferred it; it costs about a minute.

---

## 3. Gates — with proof of work, per the standing rule

| Gate | Result | Proof |
| --- | --- | --- |
| Zone tests (mutex) | **PASS** | `Ran 28 tests across 2 files. [437.00ms]` · `28 pass`, `0 fail`, `204 expect() calls` — `config-writer.test.ts` + `sandbox-regression.test.ts`, via `bun scripts/bun-test-lock.ts run --label p2306` (waited out P2.301-zone and P2.296-rebreak3) |
| Package typecheck | **PASS** | `bun x tsc -p packages/codex-responses-adapter/tsconfig.json --noEmit` → exit 0, **0 lines of output** |
| eslint on zone | **NOT-RUN** | No eslint config exists for this package and no root lint script covers it — see F4. Not a skip for convenience; there is nothing to run. |
| `git diff --check` | **PASS (vacuous)** | exit 0 over the zone — there is no diff |

These are a **baseline, not verification of a change**: I made no code change, so nothing here proves
a contract I altered. Recording them as green would otherwise overstate what they mean.

---

## 4. What I did NOT measure

- **macOS arm64 only** (Seatbelt). Linux (Landlock/bwrap) and the Windows sandbox were not probed, and
  precedence is implemented per-backend — it could differ. This is the residual hole and it is real.
- **rust-v0.148.0 only.** The behaviour is a property of this pin, which is the point of F3.
- The **network** half of permission profiles.
- Whether an `on-request` approval escalation reruns a profile-denied command unsandboxed — I removed
  that variable with `approval_policy = "never"` rather than characterising it. Worth its own row:
  if escalation bypasses the profile, an accepted approval could still surface `credentials.enc`.

---

## 5. Artefacts

Harness in `<scratchpad>/p2306/` (kept out of the repo — outside my zone, and whether it becomes a
durable detector is an owner call per F3):
`probe.ts` (round 1, invalid control — retained as the cautionary case), `probe2.ts` (precedence
matrix), `probe3.ts` (real agent turn), `probe4.ts` (deny attribution), `probe5.ts` (write grant),
`emit.ts` (shipped-config dump), plus each run's `*-out.json` and the fetched `permissions.md` /
`permissions.html`. Host fixtures under `~/.cache/nessy-p2306-probe*` were deleted.
