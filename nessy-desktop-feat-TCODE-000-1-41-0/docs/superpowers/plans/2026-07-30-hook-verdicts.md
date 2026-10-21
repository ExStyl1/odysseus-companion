# D5–D9 — the hook verdicts we throw away

Five rows from the deviation triage, one theme: **a hook runs, the operator is
told it is governed, and its answer is discarded.** Every one of these is
fail-open on a guardrail.

D5 is the entry point because it is the only one on **Pi, the shipped default**.

## 0. Method rules

1. `curl -s https://code.claude.com/docs/en/hooks.md` (and `hooks-guide.md`).
   Quote WHOLE lines; read the whole line — defects in this audit have hidden in
   the second sentence more than once.
2. **Declared ≠ enforced.** Reproduce each defect before fixing. Prove on Pi.
3. **NUL bytes** — always `grep -a` for absence claims; never `head -N` a grep
   whose hit count you have not counted.
4. **Two git commands** — pathspec on the `commit`. One commit per task.
5. **Run every test from the repository ROOT.** A package-directory run
   destroys the user's real `~/.nessy-agent/config.json`. Check no other
   `bun test` is running before recording a failure.
6. CDP may be on 9223 — do not kill or drive it; do not run
   `electron:build:servers`.

---

## 1. Task 1 — a prompt hook's block reaches the prompt (D5)

**Commit:** `fix(hooks): a prompt hook's decision is honored on Pi`

`pi-agent.ts:2244` forwards `UserPromptSubmit`/`UserPromptExpansion` with
`void`, **after the prompt has already been sent**. So a managed prompt-gating
hook — the bank's own DLP or policy gate — returns `block` and the prompt goes
out anyway. The same hook works on Codex and nestor-cloud, which is what makes
this a silent inconsistency rather than a missing feature.

- Await the decision and honor it **before** the prompt leaves. Two things to
  establish first and state in the report: what the documented block does to the
  turn (the user must be told, not left staring at nothing), and what a hook
  timeout must do here — a prompt gate that hangs must fail **closed** or it is
  not a gate.
- `UserPromptExpansion` may have different semantics from `UserPromptSubmit`;
  read both sections whole and say whether they share a decision path.
- The existing deny-loop cap, secret redaction and re-gating (the 🛡
  hook-hardening row) must survive — those tests exist; run them.

**Gate:** on Pi, a hook returning block stops the prompt and the user is told
why; an allow is transparent; a hook that never answers fails closed within a
stated bound. **Mutation:** restore the `void` forward → the block test goes red.

---

## 2. Task 2 — the http and mcp_tool runners return their verdict (D6, D8)

**Commit:** `fix(hooks): http and mcp_tool hooks return a decision`

Two runners, one shape, one commit:

- `PluginHttpHookRunner` is typed `Promise<void>` (`hooks-automation.ts:134`):
  the request fires and the response is dropped, so a central policy webhook
  answering `2xx` with a deny blocks nothing. **The managed containment already
  shipped** — `allowedHttpHookUrls` and `httpHookAllowedEnvVars` are enforced at
  `SessionManager.ts:4822` — which is exactly what makes the silent drop worse
  than not having the feature: the operator is told http hooks are governed.
- `PluginMcpToolHookRunner` returns `void` (`SessionManager.ts:4694`+): the hook
  MCP tool is invoked and its result discarded, so an added-context or deny
  response has no effect, while the plugin imports as supported and the hook
  visibly runs.

- Widen both return types and honor the verdict through the **same** decision
  path the command runner uses — do not add a second merge. The per-event
  decision contract and the dedup/parallel work landed today (`634c33e1`,
  `55200a40`); read how the command runner's result is merged and reuse it.
- An http hook that answers with something unparseable must fail **closed** on a
  decision event and be inert elsewhere — say which you chose and why.
- **Never log a hook's response body, URL query or headers** — a policy webhook
  carries organizational data and may carry credentials.

**Gate:** an http hook answering deny blocks; an mcp_tool hook's context reaches
the turn; both are inert on events whose documented surface carries no decision.
**Mutation:** discard either verdict again → its test goes red.

---

## 3. Task 3 — a command hook can read its input (D7)

**Commit:** `fix(hooks): a command hook receives its payload on stdin`

`runHookCommand` spawns `stdio: ['ignore','pipe','pipe']` and writes no stdin.
Every documented hook that does `input=$(cat)` reads empty and silently allows.
**This is not confined to the flagged runtimes:** `allowDirectCommandRunner` is
set when `provider !== 'pi'`, which includes `nestor-cloud-agent` — on by
default.

- Write the documented payload to stdin and close it. Read the page for the
  exact shape and encoding; quote the line.
- **A hook that does not read stdin must not deadlock** — if the payload is
  larger than the pipe buffer and the child never reads, the write blocks.
  Handle that explicitly and say how.
- Redaction: the payload carries tool input. The existing secret-redaction path
  applies to hook output; establish whether it applies to input too, and say so.

**Gate:** a hook doing `input=$(cat)` sees the documented JSON on Pi and on
nestor-cloud; a hook that ignores stdin still completes. **Mutation:** stop
writing stdin → the payload test goes red.

---

## 4. Task 4 — frontmatter hooks register or are refused (D9)

**Commit:** `fix(plugins): skill and subagent frontmatter hooks register or are refused`

A Claude plugin whose skill or subagent frontmatter declares `hooks:`
(`hooks.md:785`) imports as **fully supported** — no diagnostic, no deferral —
and those hooks never register. The admin who vetted the plugin and the author
who wrote it both believe a guardrail runs.

- **`packages/shared/src/plugins/format-adapters/claude.ts` is LOCKED to a
  sibling executor.** If the adapter half must change there, land everything
  else and report the residual word for word.
- Ship the cheap half first if the seam is contested: **refuse or diagnose the
  declaration** rather than importing it as supported. A loud refusal is a
  legitimate outcome; silent acceptance is not.
- If registration is reachable in files you own, do it fully: the same
  activation, scope and trust gating every other plugin hook gets.

**Gate:** a fixture declaring frontmatter hooks either registers them or
produces an author-facing diagnostic; a fixture without them is unaffected.
**Mutation:** drop the diagnostic → the fixture test goes red.

---

## 5. Task 5 — category strings

**Commit:** `docs(audit): what the hook-verdict work leaves open`

Unwrapped, unbolded, backtick-terminated, no inline backticks in the reason,
under 400 characters.

### 5a. What this plan leaves

Six strings, each measured against the code as committed. Two are divergences
this work chose on purpose and states here rather than in a comment nobody
greps; two are surfaces a task could not reach because the file that owns them
belongs to another executor; one is the request half of a defect whose response
half is now fixed, and one is a bound the environment channel imposes.

- documented, not implemented — an http hook still POSTs whatever body its manifest declared, and the hook input JSON the page sends as the request body never reaches the endpoint. So a policy webhook now has a verdict channel and still no event to judge; the runner request carries no input to send: `http.body`
- documented, not implemented — UserPromptExpansion still fires once per turn at Pi agent start with no expanded command name, so its documented matcher matches nothing and only a matcherless hook reaches the new gate. The lifecycle bridge that emits it is owned by a sibling executor: `command_name`
- documented, not implemented — frontmatter hooks on a skill or subagent are refused with a diagnostic and a deferral instead of registering. Registration needs the component-lifetime scoping the page describes, and the Claude adapter half is locked to a sibling executor: `plugin.deferred.frontmatter_hooks_unregistered`
- deliberate divergence, stated — a prompt gate that never answers fails closed and the prompt is refused, where the page discards a command, http or mcp_tool hook's output and lets the prompt through. The same section's callback rule is the precedent: a gate that can act as policy must not fail open: `PI_PROMPT_GATE_TIMEOUT_MS`
- deliberate divergence, stated — an http or mcp_tool answer that opened a JSON object and could not be parsed blocks on an event whose stdout can decide, where the page would show it as plain text. A broken policy answer is not consent; a body that never opened an object is still context: `isUnreadableHookVerdictBody`
- ours, bounded — the same payload stdin now carries also rides the environment, so a tool input near the OS argument limit fails the spawn with E2BIG before any hook reads a byte. Measured on darwin: 512 KB refuses to spawn, 128 KB spawns and delivers: `NESSY_EVENT_DATA`

## 6. Gate

Focused suites per changed file; the automations, plugins and server-core
aggregates once on the final diff; `bun run typecheck:all` **exit 0 with zero
`error TS`, stated explicitly**; `bun run lint`; i18n parity + sorted if strings
are added; `git diff --check`.

**Hook execution and permission decisions are named risk triggers** — run the
expanded set once on the final diff, not after every edit.

Known-failing rows: `docs/superpowers/specs/2026-07-29-known-failing-tests.md`.
Note one row NOT on that list and not yours: `Pi harness R0 baseline > pins all
MCP rows against the actual current client surface` — `117746a5` added six
`NessyMcpClient` methods without updating the pin. Leave it; it belongs to the
MCP executor.

## 7. Constraints

- You own `packages/shared/src/agent/pi-agent.ts`,
  `packages/shared/src/plugins/hooks-automation.ts` and the rest of
  `plugins/**` **except `format-adapters/**`**,
  `packages/shared/src/automations/**`,
  `packages/server-core/src/sessions/SessionManager.ts`, and their tests.
- **THREE SIBLING EXECUTORS run concurrently.** They own:
  `packages/shared/src/config/**`, `pi-agent-server/src/**`,
  `apps/electron/src/main/index.ts`, `apps/cli/**`,
  `session-tools-core/src/runtime/**` (switches); `shared/src/mcp/**`,
  `auth/oauth.ts`, `agent/backend/types.ts`, `plugins/format-adapters/**`,
  `config/network-address-guard.ts` (MCP); `capabilities/**`, `base-agent.ts`,
  `pi-agent-server/src/context-categories.ts`, the context overlay
  (instructions). **Stay out of all three.** Report residuals instead of editing.
- One commit per task, subjects exactly as given. **No `Co-Authored-By`.** No
  push/MR/tags/reset/rebase/`--amend`/`checkout --`/stash of edited files.
  Restore mutation probes by re-edit or an `.orig` copy, **never git**.
- Do not touch `docs/superpowers/specs/` or `docs/testing/cdp-live-checklist.md`,
  nor `~/.nessy-agent/skills/r17-*` or `~/.nessy-agent/mcp/elicit-server.mjs`.
  No version bumps or release notes. Never write `~/.nessy/dp_auth_creds.json`.
- **Never point a hook probe at a real external host** — loopback only.
- Code, comments and commits in English.

## 8. Report

Commit shas; each defect reproduced; what a blocked prompt shows the user and
what a hook timeout does; how the two runner verdicts merge and where that is
written down; the stdin deadlock handling and whether redaction covers input;
the frontmatter decision and any residual word for word; corrections to this
plan; mutation probes with which side went red; the explicit typecheck
statement.
