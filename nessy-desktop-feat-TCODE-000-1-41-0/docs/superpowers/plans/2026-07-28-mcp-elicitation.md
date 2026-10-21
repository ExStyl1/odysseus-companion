# R24 — MCP elicitation

**Status:** ready for execution
**Parity row:** R24 (Ord 9)
**Branch:** `fix/renderer`
**Base:** `9d12834f`

## The gap is narrower and sharper than the audit row says

The row reads "not started". That is wrong, and the correction matters: form-mode
elicitation already works end to end. `packages/shared/src/mcp/client.ts`
advertises `elicitation: { form: {} }` and registers an `ElicitRequestSchema`
handler; `packages/shared/src/mcp/elicitation.ts` maps a request onto the generic
ask-user question channel. **Do not rebuild that.** Read it first — the whole
module is 162 lines.

What is actually missing, in priority order:

1. **URL mode is dead code that always declines.**
   `elicitation.ts:104-114` — for `params.mode === 'url'` the plan is
   `options: ['Open separately', 'Cancel']` with `mapAnswer: () => null`, and
   `handleMcpElicitationWithAskUser:157` turns a null content into
   `{ action: 'decline' }`. So a user who picks "Open separately" gets a decline
   sent to the server, and **nothing ever opens the URL**. The documented
   behaviour (`mcp.md`, "Respond to MCP elicitation requests") is: "Claude Code
   opens a browser URL for authentication or approval. Complete the flow in the
   browser, then confirm in the CLI."
2. **Multi-field forms degrade to raw JSON.** Any schema that is not a single
   enum/`oneOf`/boolean/string field falls through to
   `elicitation.ts:126-131`: the user is asked to "Reply with a JSON object
   matching the requested MCP schema" as free text, and a parse failure silently
   becomes a decline with no feedback to anyone. The documented behaviour is a
   dialog "with form fields defined by the server (for example, a username and
   password prompt)".
3. **The `Elicitation` and `ElicitationResult` hooks do not exist.** Both are in
   Claude's documented event list (28 and 29 of 30).
4. **The auto-backgrounding interaction is unowned.** `mcp.md:261`: "A call
   waiting on an open elicitation dialog isn't backgrounded while the dialog is
   open; the server is blocked on your input, not slow." We shipped auto-
   backgrounding in R10, so this interaction is now ours and is untested.

## Contract source

`code.claude.com/docs/en/mcp.md` §"Respond to MCP elicitation requests" and
`:261`; `code.claude.com/docs/en/hooks.md` §`Elicitation`, §`ElicitationResult`.
Cite the specific line in each commit body.

Hook payloads, verbatim from the docs — implement these field names exactly:

```
Elicitation:        mcp_server, form_schema, form_state
                    + the common fields (session_id, prompt_id, transcript_path,
                      cwd, permission_mode, hook_event_name, tool_name,
                      tool_input, tool_use_id)
ElicitationResult:  mcp_server, form_schema, user_response
```

Both answer with:

```json
{ "hookSpecificOutput": { "hookEventName": "...",
    "action": "accept|decline|cancel", "content": { "field": "value" } } }
```

- `Elicitation`, `accept`: `content` must carry every required field of
  `form_schema`; the dialog is skipped entirely.
- `ElicitationResult`, `accept`: `content` **partially** overrides
  `user_response` — fields absent from `content` keep the user's value.
- `ElicitationResult`, exit code 2: blocks, and the action becomes `decline`.
- Matcher for both: the MCP server name.

## Decisions already made — do not relitigate

1. **Do not build a new modal system for the form.** R7 shipped a batched
   question card (checklist ASK-1: "Batched 2-question card renders; answers land
   in the documented envelope"). Find it, and render an elicitation form through
   it. If it genuinely cannot carry a server-defined field set, say so with the
   file and the reason in your report rather than forking a second surface.
2. **URL mode opens the URL through the existing app shell seam**, whatever
   already opens external links in this repo — not a new dependency, not
   `child_process open`. Confirm-in-app after the browser flow, per the doc.
3. **Advertise only what is implemented.** If URL mode lands, the client
   capability changes with it; if you cannot verify the correct spec key for URL
   mode against `@modelcontextprotocol/sdk`'s own types, keep `{ form: {} }` and
   report that as the blocker. A capability we advertise and cannot honour is
   worse than one we omit.
4. **A hook decision replaces the dialog; it does not race it.** The dialog must
   never open when an `Elicitation` hook returns an action. Prove it, do not
   assume it.

## Tasks

### Task 1 — URL mode actually opens the URL

Fix the always-decline path. "Open separately" opens the URL and then keeps the
elicitation open for the confirm step; only the explicit cancel returns
`decline`/`cancel`. Cover: no URL in params, a non-`http(s)` scheme (refuse —
this is a server-supplied string and it must not reach a URL opener unchecked),
and the user cancelling after the browser step.

**Commit:** `fix(mcp): open the URL in URL-mode elicitation instead of declining`

### Task 2 — the `Elicitation` hook

Fires before any dialog, matcher = server name, payload and output exactly as
above. An `accept` skips the dialog and answers the server directly. Wire it
through the repo's existing hook dispatcher — do not add a second dispatch path.

**Commit:** `feat(hooks): the Elicitation hook can answer a server directly`

### Task 3 — the `ElicitationResult` hook

Fires after the user answers, before the response reaches the server. Partial
override semantics (unspecified fields keep the user's value) and the exit-code-2
→ `decline` mapping both need a test; the partial-override rule is the one most
likely to be implemented as a full replacement by accident.

**Commit:** `feat(hooks): the ElicitationResult hook can amend a user's answer`

### Task 4 — a real form for multi-field schemas

Replace the raw-JSON fallback with a rendered form over the server's
`requestedSchema`. Keep every existing single-field shortcut working exactly as
it does today — those are good UX and there are tests on them. Required-field
validation belongs in the dialog, not in a silent decline.

State in the commit body which surface you reused (decision 1) and what happens
to a schema shape the form cannot render — it must be an explicit, visible
decline with a reason, never a silent one.

**Commit:** `feat(mcp): render server-defined elicitation forms`

### Task 5 — do not background a call blocked on a dialog

`mcp.md:261`. Find where R10's auto-backgrounding decides to detach, and make an
open elicitation dialog suppress it until the dialog closes. One positive test
(dialog open past the threshold → still attached) and one negative (no dialog →
detaches as it does today).

**Commit:** `fix(mcp): never background a call waiting on an elicitation dialog`

### Task 6 — close-out

Append per-task shas, real gate numbers, and answers to: which question-card
surface Task 4 reused; which URL-opening seam Task 1 used; and whether the SDK
exposes a URL-mode capability key (decision 3).

**Commit:** `docs(plans): close R24 with gate evidence`

## Gate

Affected packages during the loop: the `mcp` suites, the hook suites, the
permission/ask-user suites, `typecheck:all`, `lint`, `git diff --check`. This
touches a shared wire shape (hook payloads) and opens an external URL from
server-supplied input — two listed immediate risk triggers — so run the hook
contract test and the mcp+sources aggregate once on the final diff.

Tests from the REPO ROOT. Running a suite from a package directory bypasses the
config-dir isolation preload and will destroy the real `~/.nessy-agent/config.json`;
a guard fails the run, do not work around it.

## Live cases for the planner (do not run these yourself)

1. A server requesting a two-field form (username + password) renders a form with
   both fields, not a JSON prompt.
2. URL mode opens the browser and the confirm step returns `accept` to the server.
3. An `Elicitation` hook returning `accept` answers with no dialog at all.
4. An `ElicitationResult` hook overriding ONE field leaves the other as typed.
5. A tool call sitting on an open dialog past the auto-background threshold stays
   attached.

## Execution constraints

One commit per task with the subjects above; no `Co-Authored-By`; no push, MR or
tag; never `reset`/`rebase`/`amend`; pathspec-limited commits; no version bump or
release notes. Never `git checkout --` or `git stash` a file you are editing.
Do not touch `docs/superpowers/specs/` or `docs/testing/cdp-live-checklist.md`.
You may edit this plan file.

If you find the same contract broken on another path (the Codex adapter, the
plugin format adapters, `skill_validate`-style validation), **report it, do not
fix it** — carrying those out is how this series tracks the recurring defect.

---

## Close-out

### Commits

| Task | Sha | Subject |
| --- | --- | --- |
| 1 | `39657933` | `fix(mcp): open the URL in URL-mode elicitation instead of declining` |
| 2 | `f2b8cf4f` | `feat(hooks): the Elicitation hook can answer a server directly` |
| 3 | `5956442a` | `feat(hooks): the ElicitationResult hook can amend a user's answer` |
| 4 | `9c26cb5b` | `feat(mcp): render server-defined elicitation forms` |
| 5 | `562e4c63` | `fix(mcp): never background a call waiting on an elicitation dialog` |
| 6 | this commit | `docs(plans): close R24 with gate evidence` |

### Gate numbers (final diff)

| Gate | Result |
| --- | --- |
| `bun run typecheck:all` | exit 0 |
| `bun run lint` | exit 0 — 122 warnings, **0 errors** (all pre-existing) |
| `git diff --check` | clean |
| Hook contract aggregate | 217 pass / 0 fail, 951 assertions |
| `mcp` + `sources` aggregate | 372 pass / 0 fail, 815 assertions |
| `bun test` (whole repo) | 8847 pass / 18 skip / **11 fail**, 35760 assertions, 828 files |

Hook contract aggregate = `hook-decision-contract`, `hook-command`,
`lifecycle-bridge`, `extension-first/behavior-contract`, `hooks-automation`,
`format-adapters`.

**All 11 repo failures are pre-existing**, proven on a clean worktree at the
plan's base `9d12834f`: 8 × `ensureStorageLayoutV2`, `config path default-root
classification`, `managed paths with NESSY_CONFIG_DIR` (storage-layout-v2, all
in `workspaces/__tests__/storage-readiness.test.ts`,
`config/__tests__/paths-default-root.test.ts`,
`workspaces/__tests__/paths-env.isolated.ts`), and `Pi harness R0 baseline >
executes golden foreground and background process contracts`
(`isolationProfile: networked` vs the pinned `workspace`). None touch
elicitation, hooks or MCP.

### Task 6 answers

**Which question-card surface Task 4 reused.** R7's batched question card —
`AskUserPermissionRequest.questions` (`packages/core/src/types/message.ts:655`),
rendered by `BatchedAskUser` in
`apps/electron/src/renderer/components/app-shell/input/structured/AskUserRequest.tsx:101`.
An all-choice schema of up to four fields becomes one card, and a test asserts
the questions this module builds pass `validateAskUserQuestions` — the same
check `pi-agent.ts:4213` and
`server-core/src/pi-harness/vendor/rpiv-interactions/ask-user-reducer.ts:12`
run before the card is shown, so the reuse is real rather than nominal.

**It cannot carry a free-text field.** Two structural reasons, not a styling
gap: the batched envelope's answers ARE option labels (keyed by question text
→ selected label), and `validateAskUserQuestions`
(`packages/core/src/utils/ask-user.ts:44`) requires 2-4 options on EVERY
question. A `username`/`password` field has no legal representation there.
Rather than fork a second surface or weaken R7's documented bound, such forms
are asked field by field through the single-question surface this module
already uses for a lone `string` field. This means live case 1 renders as two
labelled prompts, not one card.

**Which URL-opening seam Task 1 used.** `packages/shared/src/utils/open-url.ts`
(`openUrl`) — the repo's single opener, already used by all three OAuth flows,
Electron `shell.openExternal` first with the `open` package as the non-Electron
fallback. No new dependency, no `child_process`. It is injectable through
`McpElicitationOptions.openUrl` so tests never launch a browser.

**Does the SDK expose a URL-mode capability key — yes.**
`node_modules/@modelcontextprotocol/sdk/dist/esm/types.js:335`
`ElicitationCapabilitySchema` is `z.intersection(z.object({ form: …optional(),
url: AssertObjectSchema.optional() }), …)`. Verified against the SDK's own
types, not guessed, so decision 3 is resolved rather than blocked: the client
now advertises `{ elicitation: { form: {}, url: {} } }`. This is load-bearing
— a spec-compliant server that checks `elicitation.url` before sending
`mode: "url"` would otherwise never send one, leaving Task 1 unreachable.

### Corrections to this plan

1. **The hook payload field names in this plan are not the documented ones —
   and neither was this section's first attempt at correcting them.**

   The plan says `Elicitation: mcp_server, form_schema, form_state` and
   `ElicitationResult: mcp_server, form_schema, user_response`. That is wrong.
   The first correction written here replaced it with `mcp_server`,
   `tool_name`, `tool_use_id`, `elicitation_id`, `schema` / `user_response` —
   **also wrong**. Both sets came from `WebFetch`, which summarises a page
   through a small model rather than returning it; the "verbatim" JSON examples
   it produced were reconstructions. The names below come from
   `curl -sL https://code.claude.com/docs/en/hooks.md` (3162 lines), read
   directly at `:2688-2802`:

   > `:2696` In addition to the common input fields, Elicitation hooks receive
   > `mcp_server_name`, `message`, and optional `mode`, `url`,
   > `elicitation_id`, and `requested_schema` fields.

   > `:2766` In addition to the common input fields, ElicitationResult hooks
   > receive `mcp_server_name`, `action`, and optional `mode`,
   > `elicitation_id`, and `content` fields.

   So: `mcp_server_name` (not `mcp_server`), `requested_schema` (not `schema`
   or `form_schema`), and the user's values arrive in `content` — the same key
   the output uses to override them — not `user_response`. `message`, `mode`,
   `url` and `action` all exist and were missing entirely. There is no
   `form_state`. **Neither event carries `tool_name`, `tool_input` or
   `tool_use_id`**, and `ElicitationResult` carries no `message`; nothing in
   the tree ever emitted those, so they were plan text only, not code.

   Lesson recorded because it cost two revisions: for an external contract,
   fetch the raw page. A summariser will invent plausible field names and a
   worked JSON example to go with them, and a confidently wrong comment about
   someone else's contract is worse than none.
2. **The hooks were not absent.** Gap 3 says both hooks "do not exist". The
   EVENTS existed — `McpElicitation` is this codebase's spelling of Claude's
   `Elicitation` (`plugins/format-adapters.ts:146`), and both are registered in
   `AGENT_EVENT_CONTRACTS_V1`, `hooks-runtime.ts` and `hooks-automation.ts`.
   What was missing was every decision layer: the contract table projected
   `{action, content}` away, the stdout parser never read it, and the matcher
   returned `''`.
3. **Exit 2 applies to BOTH events**, not only `ElicitationResult` as the plan
   states. Implemented for both.
4. The claims about the always-declining URL path (`elicitation.ts:104-114`,
   `:157`) and the raw-JSON fallback (`:126-131`) were **verified correct**.
5. **`ElicitationResult` fires on a user decline, not only an accept.** The
   documented input carries `action` and the documented output "Overrides the
   user's action" (`:2799`), so a hook that only ever saw accepts would see a
   constant. It still does not fire for the module's `cancel`, which is the
   abort/teardown path rather than a user choice, nor for refusals generated
   instead of an answer (unrenderable schema, missing required field).
6. **`content` on `ElicitationResult` output is a per-field override.**
   `:2800` says only "Overrides form field values", which does not settle it.
   Decided per-field because (a) `Elicitation`'s `content` is worded "Form
   field values **to submit**" against `ElicitationResult`'s "**Overrides**
   form field values", (b) the doc's own example passes `content: {}` as inert
   filler, which is only harmless under a per-field reading, and (c) it is the
   safer reading if a hook author guesses wrong: an author who assumed
   replacement and lists every field still gets what they intended, whereas
   under replacement an author who assumed per-field silently drops everything
   the user typed. The mirror risk — a hook cannot REMOVE a field — has its own
   documented answer, `action: "decline"`.
7. **Both elicitation events are now `kind: 'decision'`** in
   `AGENT_EVENT_CONTRACTS_V1`, owned by `pi-agent`, following R20's precedent
   for the task events. Two guard lists moved with them
   (`task-hooks.test.ts`, `lifecycle-bridge.test.ts`). `redactedPayload` on
   both rows now lists the documented field names; it has no consumer and no
   fixture pins it, so nothing else had to move.
