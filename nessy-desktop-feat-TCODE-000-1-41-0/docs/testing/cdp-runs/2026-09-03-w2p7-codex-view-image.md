# 2026-09-03 — W2-p7, packaged 1.33.0: codex's on-demand image read-back (P3.202)

One row, one case. The rig is the sitting described in
[2026-09-03-w2p-packaged-prerequisites.md](2026-09-03-w2p-packaged-prerequisites.md) and unchanged
from it: `release/mac-arm64/Nessy Desktop.app` (1.33.0, unsigned), launched with
`--remote-debugging-port=9333` against the OPERATOR config dir (`~/.nessy-agent`), **no
`NESSY_IS_PACKAGED` lever** — so no application log exists and every reading below comes from the
artefact's own files or from a transcript codex itself wrote. Dark theme confirmed
(`already-dark`). Connection `codex-gateway` / `codex-runtime` on
`tgpt/deepseek-v4-flash-0731`.

**Load while running:** 9.6–11.7 across four sittings (`uptime` read beside each). Nothing in the
verdict is timing-derived; the two rig faults below are, and both are named as such.

## PKG-5 — PASS 11/11 ×2 — **P3.202's suspect REFUTED**

`scripts/cdp/cases/pkg-5.ts`. The row's suspect was a path/permission mismatch: the handover
pointer names the session attachments store, which sits outside the workspace, while
`writeCodexConfig` emits `[permissions.<profile>]` with `extends = ':workspace'` plus a deny map —
so `view_image` might refuse on a path we handed it, and the refusal would read as *the model
declined*.

It does not refuse. Both arms called `view_image` and both got an image back.

| Arm | path | `view_image` calls | output |
| --- | --- | --- | --- |
| attachments store (outside the workspace) | `~/.nessy-agent/sessions/<ws>/<sid>/attachments/pkg5-outside-<nonce>.png` | **1** | `[{"type":"input_image","image_url":"data:image/png;base64,…"}]` |
| workspace (positive control) | `~/nessy-cdp-rts/project/pkg5-inside-<nonce>.png` | **1** | same shape |

**The bytes are the assertion, not the call count.** The two probes are different PNGs — a red
24×24 in the attachments store, a blue one in the workspace — and each arm's
`function_call_output` carries the base64 of *its own* file (`…nGO4IyJCFcQwatBo…` red,
`…nGMQEblDFcQwatBo…` blue). So codex resolved the path it was handed, read the right file, and
returned an image content item rather than bytes — which is the whole of what P3.54's on-demand
design needs from the third runtime.

### Why the suspect looked plausible, and what actually governs

The premise was right and the conclusion was not. Read out of codex's OWN rollout
(`turn_context`), on the packaged artefact:

- `workspace_roots` = `["/Users/i.i.gavrikov/nessy-cdp-rts/project"]`, and the attachments store is
  **not** under it. The row's premise holds — the pointer does target a path outside the workspace.
- the resolved `permission_profile.file_system` is `restricted` with 25 entries, and the second of
  them is `{"path":{"type":"special","value":{"kind":"root"}},"access":"read"}`.

**`root → read` is what `extends = ':workspace'` inherits.** Writes are confined (workspace `write`,
plus the `slash_tmp` and `tmpdir` specials); READS are granted at the filesystem root and then
subtracted by the credential floor's twelve exact-path denies and nine workspace globs. None of
those denies is an ancestor of the attachments store. So the scope reaches it by construction, and
`view_image` was never going to refuse on it.

### The instrument, which is the part worth keeping

`scripts/cdp/lib/runtime-session-log.ts` says of codex: **"Codex — nothing."** That is true *after
teardown* and false *during the run*, and the difference is the whole case. `createRuntime` mints
`CODEX_HOME` with `mkdtempSync` at 0700 and `rmSync`es it in `cleanupRuntimeResources`; while the
runtime is up, that directory holds the `config.toml` we wrote **and**
`sessions/<y>/<m>/<d>/rollout-*.jsonl`, which codex writes itself. Measured: 13 JSONL entries per
arm, carrying `session_meta`, `turn_context`, `world_state`, `response_item` and `event_msg`.

Confirmed ephemeral in the same sitting: immediately after the case process exited, the tmpdir held
**zero** `nessy-codex-home-*`. So the read has to happen inside the live window, which is why the
case reads each arm's home right after that arm's turn rather than once at the end.

The home is matched to its session by the `--session-id` argument the host writes into
`[mcp_servers.session]`, never by mtime — during this sitting up to three homes existed at once,
and "newest" would have handed one arm's rollout to the other.

### Two rig faults found by having a control, both fixed inside the case

1. **The two arms may not share a session, and the first run scored the truth exactly backwards.**
   Run back to back in one conversation, the attachments arm succeeded and the in-workspace control
   that followed produced an **empty** assistant reply and no tool call. Read as a control that
   says *the workspace path is fenced and the attachments path is not* — the inverse of what a
   third run showed. The cause is not the path: it is the first arm's image sitting in the history
   the second turn replays, which this model refuses (`400 Invalid Chat Message Part: Model Does
   Not Support Image Inputs`, P3.114/P3.280). One fresh session per arm is the only form of this
   pair that measures paths rather than the order they were asked in. **The positive control did
   its job by being wrong in a way the mechanism reading could contradict.**

2. **`sessionCommand` times out at 30 s while the previous arm's runtime tears down**, and the
   throw is not the bind failing. The second arm died on
   `updateWorkingDirectory` → `Request timeout: sessions:command (30000ms)`; the very next read
   shows the directory bound. `bindWorkingDirectory` now VERIFIES against the session's own
   `workingDirectory` and retries, and run 3 recorded exactly that shape —
   `{"bound":true,"attempts":1,"lastError":"…Request timeout: sessions:command (30000ms)"}`. A case
   that lets that propagate loses an arm to a queue rather than to a finding.

Per-arm confirmation across the sitting: the attachments arm read back an image in runs 1, 3 and 4;
the workspace arm in runs 2, 3 and 4. Runs 3 and 4 are the final case shape, PASS 11/11 both,
identical.

### Two observations recorded, not chased (out of this row's scope)

- **`sandbox_mode` and the resolved `sandbox_policy` disagree.** `config.toml` says
  `sandbox_mode = "danger-full-access"` (the owner's standing sandbox-off decision) while the same
  turn's `turn_context` reports `sandbox_policy: {"type":"workspace-write","network_access":false,…}`.
  Both readings are from the same live home, seconds apart. The likely reading is that
  `default_permissions = "nessy_runtime"` supersedes the mode, but that is a hypothesis about the
  binary and this case measured neither direction.
- **A `view_image` result ends the turn.** In every arm the last assistant text is a host
  ```image-preview``` block naming the file, not a description of it — consistent with the tool
  returning an image the model then cannot be asked about on this gateway. What P3.202 owed was the
  read-back, and the read-back is proven; whether a gateway model can ever *use* it is P3.114's
  modality wall, already measured.

## Scope note

`scripts/cdp/cases/pkg-4.ts` was found untracked in the working tree and left untouched: it is a
different row's draft (P3.297, skills handed to claude as directories), already carrying its own
first-run learnings. This case took the next free number rather than overwriting it.
