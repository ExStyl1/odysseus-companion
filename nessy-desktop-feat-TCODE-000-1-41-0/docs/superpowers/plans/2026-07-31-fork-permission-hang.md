# L5 and L4 — a fork that asks for permission hangs, and the build does not check the interceptor

Two rows, and the first one blocks the release to testers. It was found by
driving the panel, not by reading code, and it had already been recorded — as
the wrong kind of problem.

**L5 in one sentence:** a fork that needs a permission stops forever, and the
window the user is looking at shows nothing at all.

**Measured 2026-07-30**, dev instance on 9224, parent session
`6b671a0b-7dcf-4cbf-bfee-68253d080e85`, fork agent
`f3453d22-c45f-4bd3-bf64-262c0777d529`:

- the fork reached a `Write`, and **ten minutes later** its transcript was still
  14 messages / 2446 assistant characters, unchanged across 20 polls at 15 s;
- the child session read `isProcessing: true` the whole time;
- the parent's `childState` said `running`, so the panel row looked healthy;
- the parent's `security.pendingPermissions` was **`[]`**;
- the CHILD session's own snapshot held the live request:
  `{requestId: 'pi-permission-…', type: 'file_write'}`.

`sub-agents.md:1043` puts a subagent's prompt in the session the user is
watching. Ours filters `pendingPermissions` by exact session id, so a fork's
request is present only on a session that has no window.

**This was already in the deviation register — filed as a missing display.**
That classification is what let it sit: a prompt you cannot see is an
inconvenience, a fork you cannot unblock is a hang, and forks that write files
are the ordinary case rather than the exotic one.

**The delivery half is NOT the defect, and the same run proves it.**
`controlPiHarnessRuntime({action:'steer_child'})` returned `{ok:true}` against a
`running` fork and that fork ended its 18 973-character answer with the probe's
marker on its own line. Do not go looking for a lost message; the message
arrives. What is lost is the permission prompt in the other direction.

## 0. What you must read before touching anything

1. `curl -s https://code.claude.com/docs/en/sub-agents.md` — the permission
   section around `:1043`, and `:1019`/`:1021`/`:1023` for what the panel owes.
   **Quote WHOLE lines**, and read the whole line: defects here have twice hidden
   in the second sentence of a two-sentence line.
2. `curl -s https://code.claude.com/docs/en/permissions.md` — what a pending
   approval is owed while it is pending.
3. `SessionManager.controlPiHarnessRuntime` (`:3157`) and the snapshot builder
   that fills `security.pendingPermissions`. **Find the filter first and
   understand why it is exact** before you widen it.
4. `packages/server-core/src/pi-harness/child-session-service.ts` and the
   `runtime.steer` / `runtime.stop` pair at `SessionManager.ts:10412`.
5. `apps/electron/src/renderer/hooks/useAgentPanel.ts` — the whole file is 110
   lines and every control it issues discards its result.

**The recorded residual this row supersedes**, so you can see what was already
known and what is new (quoted with the category keyword deliberately broken —
"documented, not-implemented-then" — so the register's harvester does not
re-collect a superseded string from this plan):

> documented, not-implemented-then — sub-agents.md:1043 surfaces a subagent
> prompt in the session the user watches. The runtime snapshot filtered
> pendingPermissions by exact session id, so a fork prompt was absent from the
> parent snapshot and present only on the hidden child. SUPERSEDED by this
> plan's Task 1, shipped 0583333c.

## 1. Method rules

1. **Reproduce before fixing, live.** The recipe is below and it works; a fix
   asserted only by unit test is exactly the gap this row exists to close.
2. **Declared ≠ enforced.** Prove on **Pi**, the shipped default.
3. **NUL bytes** — always `grep -a`; never `head -N` a grep whose hit count you
   have not counted.
4. **Two git commands** — pathspec on the `commit`. One commit per task.
5. **Run every test from the repository ROOT.** A package-directory run destroys
   the user's real `~/.nessy-agent/config.json`.
6. A dev instance is live on **9224** and it is the OWNER'S working app — it
   holds their real sessions. Drive it, do not kill or rebuild it, and never
   paste session content into the report. `scripts/cdp/**` is read-and-run only.

### 1a. The reproduction, exactly as it was taken

`electron:dev` runs the host and the Pi subprocess from BUILT bundles. Confirm
the bundle carries your change before you measure it, or you will measure
yesterday's code:

```bash
grep -c "<a string from your fix>" apps/electron/dist/main.cjs
```

The probe: create a fresh session, seed it with one turn (a fork of a never-used
session is refused before it starts), start a fork through the palette with a
task that will write a file, then poll the CHILD session's own
`getPiHarnessRuntime` for `pendingPermissions` while polling the parent's for the
same. `scripts/cdp/lib/` has every helper — `freshSession`, `startFork`,
`piRuntime`, `readChildTranscript`, `waitFor`. `scripts/cdp/cases/agt-3.ts` is
the case this row fails; run it.

**Two ways this reproduction lies, both paid for already:**

- **`/subtask` intermittently does not register a fork at all.** Two of four runs
  produced no child. If you get zero children, that is not your fix failing —
  re-run, and if it persists, report it as a separate finding rather than
  folding it into this one.
- **The composer sometimes refuses focus** (`composer-not-focusable`), which
  aborts the run before it reaches the assertion. Re-run.

---

## 2. Task 1 — a fork's permission prompt reaches the window the user is in (L5)

**Commit:** `fix(agents): a fork's permission request surfaces in the parent session`

- **The filter is exact for a reason: do not simply widen it.** A snapshot that
  returns prompts from unrelated sessions is a worse defect than the one you are
  fixing — a user would answer a request belonging to some other window. Scope
  the addition to the requesting session being a **registered child of this
  session**, established from `childState.children`, not from a name or a
  heuristic.
- **Answering must reach the child.** Surfacing without answering converts a
  silent hang into a visible one. The respond path is keyed by session; work out
  what it needs to route a parent's answer to the child's broker and say so.
- **A prompt must be attributable.** The user sees a request to write a file and
  has to know which fork asked. If nothing in the payload carries the child's
  identity, that is a finding — the residual already notes the snapshot exposes
  no child session id.
- **Say what happens to a fork whose parent window is closed** — the request has
  to survive or the fork has to fail, and a third option (waiting forever) is
  what we are removing.
- **Do not fix this with a timeout.** A fork that gives up after N minutes is a
  different product decision and it hides the same bug.

**Gate:** a fork that hits a `Write` surfaces its request in the parent session,
answering it in the parent unblocks the fork, and the fork completes — proven
live through the harness, before and after. An unrelated session's pending
request is still absent from this session's snapshot. **Mutation:** restore the
exact-id filter → the live case goes red.

---

## 3. Task 2 — a refused follow-up is visible (L5, second half)

**Commit:** `fix(agents): the agent panel reports a follow-up that was refused`

`useAgentPanel.followUp` does `.catch(() => null)` and never reads `ok`, so
`child-session-not-active`, `child-session-not-running` and
`pi-child-service-unavailable` all render as a cleared input box. `dismiss` and
`openTranscript` swallow their results the same way.

- Surface the failure where the user typed, in the panel. Keep it small — this
  is an error path, not a feature.
- **Clearing the input on a refusal loses the user's text.** Decide deliberately
  and state it.
- i18n: keys in every locale, parity + sorted green. The playground is a design
  surface — add the states.

**Gate:** a steer against a settled fork leaves a visible refusal and does not
silently clear; a successful steer is unchanged. **Mutation:** restore the bare
`.catch(() => null)` → its test goes red.

---

## 4. Task 3 — the Electron build asserts the interceptor ships (L4)

**Commit:** `fix(build): the Electron build fails when the interceptor is missing`

`resolveInterceptorBundlePath` preloads the `.ts` source when `!isPackaged` and
`dist/interceptor.cjs` when packaged, and returns `undefined` if the bundle is
missing — the Pi subprocess then starts **unpatched, with no error**. The server
build already has `scripts/build/interceptor-pairing.ts:verifyInterceptorPairing`;
the Electron build has no equivalent.

- Mirror the existing helper rather than writing a second truth.
- **This cannot be caught by driving the app**: the CDP wave runs in
  `electron:dev` by owner decision and dev loads the interceptor from source
  always. It is a build assertion; assert it at build time.

**Gate:** removing `dist/interceptor.cjs` fails the Electron build with a
message naming the file; a normal build is unchanged. **Mutation:** drop the
assertion → the removal test goes red.

---

## 5. Task 4 — category strings

**Commit:** `docs(audit): what the fork-permission work leaves open`

Unwrapped, unbolded, backtick-terminated, no inline backticks in the reason,
under 400 characters. At minimum: the closed-parent-window decision from Task 1,
the input-clearing decision from Task 2, and anything about child identity you
could not carry through.

### 5a. What this work leaves

Nine strings. The first two are the decisions the plan asked for by name, the
third is the identity that could not be carried, and the rest are what the live
runs found — including one retraction of this plan's own premise.

- decided, not a defect — a fork whose parent WINDOW is closed keeps its request: it lives in the session manager, not in the window, and closing a window disposes no session, so the fork stays blocked and stays answerable and the parent snapshot still reports pending-approval. It is denied only by an explicit teardown, which settles the resolver false: `clearPendingPermissionRequestsForSession`
- decided, not a defect — a refused follow-up keeps the text the user typed. Clearing the box is the receipt for a delivered message, and clearing it on a refusal is what made the failure invisible; a caller that reports nothing still clears, so every unchanged success path stays unchanged: `followUpClearsInput`
- shipped, partial — a fork prompt now carries the child agent id on the parent snapshot and the agent label on the card, but neither carries the child SESSION id, so a reader cannot address the child directly and must answer through the parent. The bounded wire summary exposes no session key, by design: `agentId`
- retracted — the recorded finding that the window shows nothing at all is refuted by measurement. A fork prompt DID render in the parent, attributed to its agent, on the bundle that predates this work: the display half was already fixed and only the runtime snapshot was blind: `permissionSurfaceRouting`
- defect, not fixed here — AGT-3 cannot pass on this harness. The click helper takes the first querySelector match and the structured input renders an invisible measuring copy FIRST, whose Allow button sits at a different y, so the click misses. A non-fork positive control failed identically, so it is not fork specific: `clickSelector`
- measured, not verifiable here — the after number could not be taken live. The change is main process, the dev app loads it from a built bundle at start, and the rig is the owner's working application which must not be restarted. Before was reproduced live through the harness; after is unit and wire only: `getPiHarnessRuntimeSnapshot`
- documented, not implemented — the snapshot widening is one level deep. A grandchild's prompt surfaces on its own hidden parent and not on the root session, while the event routing walks all the way to the root, so the two surfaces disagree for a nested subagent: `piChildAgentIdForSession`
- defect, not fixed here — a prompt survives a window close on the server but the card does not come back. The durable record is persisted against the hidden child and re-presented when that session is opened, and a hidden child cannot be opened, so a re-opened parent sees pending-approval and no card: `pendingApproval`
- shipped, contract widened — a parent whose fork awaits an approval now reports permission among its settlement reasons, because the counted list is the one the snapshot publishes. No new unsettled state: an active child already made the parent unsettled, only the reason is newly precise: `computeSessionSettlementV1`

## 6. Gate

Focused suites per changed file; the sessions, pi-harness and renderer aggregates
once on the final diff; `bun run typecheck:all` **exit 0 with zero `error TS`,
stated explicitly**, plus `apps/cli`'s own typecheck separately — `typecheck:all`
does not cover it; `bun run lint`; i18n parity + sorted; `git diff --check`.

**Permission decisions are a named risk trigger** — run the expanded set once on
the final diff, not after every edit.

Known-failing rows: `docs/superpowers/specs/2026-07-29-known-failing-tests.md`.

## 7. Constraints

- The tree is quiet. If a file is dirty with work that is not yours, **report it
  rather than committing it** — a pathspec commit takes the WORKING TREE, not
  your hunks, and two commits crossed that way already.
- One commit per task, subjects exactly as given. **No `Co-Authored-By`.** No
  push/MR/tags/reset/rebase/`--amend`/`checkout --`/stash of edited files.
  Restore mutation probes by re-edit or an `.orig` copy, **never git**.
- `docs/superpowers/specs/` and `docs/testing/cdp-live-checklist.md` are
  planner-owned. No version bumps or release notes. Never write
  `~/.nessy/dp_auth_creds.json`. Never touch `~/.nessy-agent/skills/r17-*` or
  `~/.nessy-agent/mcp/elicit-server.mjs` — live CDP fixtures.
- **Never test permissions against the user's real config dir** — temp dirs you
  created. Never point a probe at a real external host.
- The app on 9224 is signed into a **real corporate gateway** and every measured
  turn costs money: keep runs short, **never log a token, JWT or header value**,
  and do not paste session content into the report.
- Code, comments and commits in English.

## 8. Report

Commit shas; the hang reproduced **through the harness**, before and after, with
the numbers; what routes a parent's answer to the child and how you proved it;
what carries the child's identity into the prompt, or why nothing does; the
closed-parent-window and input-clearing decisions; whether `/subtask`'s
intermittent non-registration reappeared; residuals word for word; corrections to
this plan; mutation probes with which side went red; the explicit typecheck
statement including `apps/cli`.
