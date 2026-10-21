# Inert unit U-A — permission-prompt truth

Source: `docs/superpowers/specs/2026-07-29-inert-worklist.md` §5 (rows in §2,
security-or-permission). Branch `fix/renderer`, base `b1594c6a`.

Both rows mislead the human at the moment of approval, and both live in one
surface. Row 1 hides a consequence the server already computed; row 2 lets a
prompt outlive the question it was asking.

## Row 1 — `PromptInfo.impact` is computed, carried, persisted, not rendered

**Commit `ee2a6837`** — `fix(permissions): the approval card must say when the
command escapes the sandbox`.

The list is accurate. Verified on base before editing:

| Claim | On `b1594c6a` |
| --- | --- |
| built `pre-tool-use.ts:1880` | exact — the sandbox-escape band |
| type `pre-tool-use.ts:1511`, wire `:1483` | exact |
| emitted `claude-agent.ts:1511` | exact (path is `packages/shared/src/agent/`, not `agent/backend/`) |
| emitted `pi-agent.ts:4386` | **4382** (−4), and a **second producer the list missed at `:3256`** (`impact: band.impact`, the auto-mode band prompt) |
| persisted `SessionManager.ts:5688` | **5686** (−2) |
| read only under `admin_approval`, `ChatDisplay.tsx:1717-1729` | exact — the read is `:1724` |
| `PermissionRequest.tsx` has zero `impact` references | exact |

Neither backend gates `impact` on prompt type, and the renderer carries the
whole request object from the `permission_request` effect into
`pendingPermissions` without a field-by-field copy — so the string reached the
component's props and the component ignored it. One-sided defect, one-sided fix.

Rendered for every prompt that carries one, in its own warning-toned block with
an icon, above the command preview. New key `chat.permissionImpact` in `en`/`ru`.
New playground state `Permission + Impact UI` on the `input-container` entry
(knob option + variant), per the playground-is-the-design-surface rule.

Contract: `sandboxing.md:135` — a command that runs outside the sandbox "goes
through the regular permission flow: in default mode you get a confirmation
prompt". A confirmation prompt that does not say the command left isolation is
the prompt in name only. Category: `documented, implemented`.

### Decision — visually distinct, not merely present

Distinct. A sandbox escape rendered as ordinary body text under the description
is only marginally better than not rendering it: the description already says
"Run shell command", and the eye reads the two as one paragraph. It gets a
bordered `bg-warning/10` block with a warning icon and an `Impact:` label — the
same label the admin card uses, so the two prompts read as one family — and it
sits **above** the command preview, because the command scrolls inside its own
`max-h-24` box and anything below it can be out of view at the moment of the
click. Not `destructive` red: red is the Deny button's colour here, and a
warning that mimics the refusal control is a misread waiting to happen.

## Row 2 — `PiPendingApprovalV1.requestedAt` written once, read never

**Commit `b0f0fa81`** — `fix(permissions): a persisted approval prompt expires
instead of outliving its question`.

List anchors verified on base: write at `SessionManager.ts:5696` exact,
`reprojectPendingApproval` at `:5721` exact, the `admin_approval` carve-outs at
`:5794`/`:5807` exact, broker TTL arithmetic at `privileged-execution-broker.ts`
`:50`/`:63` (list said `:51,63`). Zero reads repo-wide confirmed.

`approvalTtlSeconds` only ever exists on `admin_approval` (set to 120 at
`pre-tool-use.ts` in `classifyAdminApproval`); every other durable prompt
carried no lifetime at all, which is why the ordinary Bash prompt was the one
that could come back from last week.

Now: `isDurableApprovalExpired` (prompt's own `approvalTtlSeconds`, else
`DURABLE_APPROVAL_MAX_AGE_MS` = 24h, and a record with no usable `requestedAt`
counts as expired) gates `reprojectPendingApproval`, and gates an ALLOW again in
`settleDurableApproval`.

**The dated `admin_approval` carve-out at `:5794`/`:5807` is untouched** — those
two conditions are byte-identical to base. The expiry predicate runs before
them and is type-blind, which only ever makes `admin_approval` stricter, never
looser; the broker already fails closed across restarts by design.

**The live path is unchanged.** `reprojectPendingApproval` still returns early
while `pendingPermissionRequests` holds the request, and a live prompt is
answered through the agent branch of `respondToPermission`, which never reaches
`settleDurableApproval`. So the documented "callback can stay pending
indefinitely … execution remains paused until your callback returns"
(`agent-sdk/user-input.md`, quoted in `durable-approvals.test.ts:7-9`) still
holds for every prompt with a live waiter. What expires is only the persisted
re-presentation of a prompt whose waiter died with the previous process —
Nessy's own extension beyond the documented lifetime, not the documented
lifetime itself. Category: `documented, implemented`.

### Decision — an expired prompt is denied, and said so

Three defensible options; they are not equally safe.

- **Re-request** — re-drive the turn so the model asks again. Rejected: the
  re-drive path (`redriveApprovedTurn`) exists and re-issues the model's
  original call, so a clock would end up authorizing an execution. That fails
  toward running.
- **Silently drop** — safe on execution, but it reproduces the pass-11 hang: the
  interrupted turn persisted `isProcessing: true`, so removing the card without
  a terminal event leaves the renderer on "Responding…" forever. It also teaches
  the user nothing about why a card vanished.
- **Chosen: settle it as a denial, and say so.** The record is cleared and
  persisted, the same terminal cleanup as an explicit deny runs
  (`setProcessing(false)` + `complete`), and an `info` line at `warning` level
  names what expired: `Permission request expired before it was answered: <cmd>.
  Nothing was run — ask again if you still want it.` Nothing executes; if the
  model still wants the call it asks again in a new turn, where the human sees
  it with its context instead of out of it.

Checked twice on purpose: a card re-fired while the record was fresh can sit on
screen as long as the window stays open, and the question the lifetime asks is
how old the **request** is, not how long the card has been visible. Both gates
fail toward not executing.

24h, not 5 minutes: the resume window (`DURABLE_APPROVAL_RESUME_WINDOW_MINUTES`)
bridges one resume; this bounds an *unanswered question*. Within a day the human
still knows what the session was doing, which is the only thing that makes an
approval informed. Shorter would discard prompts a returning user could still
answer correctly.

## Verification

Renderer: **both** a component test and a live check.

- Component (`PermissionImpact.test.tsx`, SSR of the real `PermissionRequest`):
  impact present, warning-block classes present, ordered before the command;
  and absent with no impact. 
- Live: `NESSY_CDP_PORT=9223 bun run electron:dev`, playground opened in a plain
  browser at `http://localhost:5173/playground.html`, `input-container` entry,
  `Permission + Impact UI` variant, dark theme. The real `InputContainer`
  rendered
  `Impact: Runs outside the sandbox: matched the administrator's excludedCommands pattern "rsync".`
  inside `border-warning/30 bg-warning/10 … text-warning`, above the command —
  and the label resolved through the real i18n bundle (a missing key would have
  printed `chat.permissionImpact`). Screenshot inspected for the design call
  above.

Row 2 is proven through the real persist → hydrate → open → band path in
`durable-approvals.test.ts` (a new manager over the same on-disk sessions), the
same seam the R7 APR-1 row used.

| Gate | Result |
| --- | --- |
| `bun test .../PermissionImpact.test.tsx .../OutsideRootPermission.test.tsx` | 4 pass / 0 fail / 16 expects |
| `bun test packages/server-core/src/sessions/durable-approvals.test.ts` | 7 pass / 0 fail / 43 expects (5 pre-existing + 2 new) |
| permission suites (24 files, all `*permission*.test.ts[x]`) | 128 pass / 0 fail |
| mode suites (27 files, all `*mode*.test.ts[x]`) | 626 pass / 11 skip / 0 fail |
| session suites (`packages/{server-core,shared}/src/sessions`, 85 files) | 557 pass / **2 fail** — both the known `SessionManager.orchestration` background-authority cases |
| `bun test apps/electron/src/renderer/components/app-shell` (28 files) | 171 pass / 0 fail |
| typecheck `packages/server-core` / `apps/electron` / `packages/shared` | exit 0 / 0 / 0 |
| `bun run lint:electron` | 0 errors, 118 warnings (pre-existing) |
| `bun run lint:i18n:parity` | OK — 2018 keys |
| `bun run lint:i18n:sorted` | exit 0 |
| `git diff --check` | clean |

All suites run from the repo root.

## Propagation found (reported, not fixed)

1. **`pi-agent.ts:3256` is a second `impact` producer** the worklist did not
   record (`impact: band.impact`, auto-mode band). Fixed by the same renderer
   change — noted so the row is not re-opened as half-done.
2. **The Electron-hosted playground crashes on the `input-container` entry**:
   `chat.tsx:629-633` assigns `window.electronAPI.listRecentProjects`, and the
   real preload's `electronAPI` is frozen — `TypeError: Cannot assign to read
   only property 'listRecentProjects'` takes the whole entry down inside the
   app. Pre-existing since the baseline commit `845cf0a4`; the plain-browser
   playground is unaffected, which is why the live check above used it.
3. **`pendingApproval` never leaves the server**: it is confined to the session
   header, the store and `SessionManager`, and reaches a client only through the
   `permission_request` event. So the expiry gate is a genuine single
   chokepoint; no second surface re-presents a stale prompt. `apps/cli`,
   `apps/webui`, `apps/viewer` and the mobile web UI render no permission card
   at all.

## Deviations

None. Both rows are `documented, implemented`.
