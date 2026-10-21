# Pages

Status: accepted, implemented in part (1.42.0, plan `docs/superpowers/plans/2026-09-23-upstream-adoption-0-13-4-board-planning-pages.md`,
Phases 6–9; spec `docs/superpowers/specs/2026-09-23-upstream-0-13-4-board-planning-pages-design.md`). Ported from
craft-agents-oss v0.13.4 (Apache-2.0) and adapted to three runtimes through the host seam.

A Page is an agent-authored, self-contained HTML document stored in `{workspace}/pages/<slug>/` and rendered in a
sandboxed frame inside the app. It has a small data store (key/value plus numeric time series) that the agent writes and
the page reads. The user-facing and model-facing guide is the shipped `apps/electron/resources/docs/pages.md`
(installed as `DOC_REFS.pages`).

## The pieces and where they live

| Piece | Where | Row |
| --- | --- | --- |
| Page types, storage, data store, delete | `packages/shared/src/pages/` (`./pages`, `./pages/types`, `./pages/data-store`; `bun:sqlite` only behind `./pages/data-store`) | UA6.1 |
| The six tools' host closure | `packages/server-core/src/pages/tool-callbacks.ts`, bound per session by `SessionManager.pagesToolCallbacksForAgent` | UA6.2 |
| The delete confirmation | `SessionManager.confirmPageDeleteForAgent` | UA6.2 |
| The six tools | `packages/session-tools-core/src/handlers/pages.ts`, rows in `tool-defs.ts`, types in `context.ts` | UA6.3 |
| Codex reach | six `/page/*` routes in `HOST_CALLBACK_BRIDGE_ROUTES`, the client `createBridgePages`, the codex `session-callback-bridge.ts` handlers | UA6.3 |
| The renderer's channels | `packages/server-core/src/handlers/rpc/pages.ts` (`pages:*`, every handler behind `assertCallerWorkspace`), the `pages:changed` push | UA6.4 |
| Guide and prompt | `apps/electron/resources/docs/pages.md`; `pagesPromptSection()` in `packages/shared/src/prompts/system.ts` | UA6.5 |
| The frame policy | `apps/electron/src/shared/page-frame-csp.ts` (`buildPageSrcdoc`, the only producer of a page's `srcdoc`) | UA7.1 |
| The bridge protocol | `apps/electron/src/shared/page-bridge.ts` (`nessy-pages/v1`) | UA7.2 |
| The UI | `apps/electron/src/renderer/components/pages/` (`PagesHome`, `PageView`, `PageFrame`) | UA7.3 |

## One host closure behind every runtime

Native-first, recorded: none of the three runtimes has a page store or a dashboard surface of its own to enable, so the
host supplies the six tools once (`list_pages`, `get_page`, `create_page`, `update_page`, `write_page_data`,
`delete_page`) and every runtime reaches the SAME closure:

- Pi and Claude resolve it in process through the session-scoped tool-callback registry (the slot `pages`, read by the
  `pages` getter of `attachSessionSelfManagementBindings`).
- Codex reaches it over the per-session host-callback bridge, one route per member of `PagesToolCallbacks`. The bridge
  binds the CALLER: a request names the page, never the workspace or the session, and each route narrows its body to
  the tool's declared fields. A codex spawn without the bridge is not offered the tools at all.

So storage, the watcher poke, the `pages:changed` push and the delete confirmation are uniform by construction, and a
change to any of them is made once.

## Safety model

- **Delete.** `delete_page` raises a one-shot, non-rememberable confirmation card in EVERY permission mode,
  `bypassPermissions` included. When nobody can answer a card (Don't ask, a subagent, a child agent, an automation or
  scheduled turn, no window open on the workspace) the delete is refused with a sentence and no card. An unanswered card
  becomes a decline after 110 s, inside the bridge client's 120 s ceiling, so a page is never deleted after the model was
  told the call failed.
- **Modes.** `list_pages` and `get_page` are read-only; the four mutations are refused in Plan and Don't ask — on Pi
  and Claude before the host, on codex by codex's own MCP tool-call approval (the tools are advertised without
  `readOnlyHint`).
- **The frame.** A page's document always starts with the doctype and a CSP `<meta>` that the page cannot widen:
  `default-src 'none'`, `connect-src 'none'`, images and fonts only from `data:`/`blob:`, no forms, frames, workers or
  plugins; `static` pages get no script. The frame is sandboxed without `allow-same-origin` (opaque origin). The
  renderer's own CSP would otherwise be inherited by a `srcdoc` document, which is why the builder is the only producer.
- **The bridge.** Messages are accepted only from the page's own frame and only with the render's nonce; a link-out
  needs a user gesture inside the frame and the user's confirmation of the full URL.
- **Credentials.** A page never holds credentials. Source actions run in the host under grants kept in the host's
  approvals ledger, never in `page.json` (UA9.2; see "Page actions and grants" below).

## Withheld ranges

None remain. Thumbnails landed with UA7.4 (the offscreen capture behind `pages:getThumbnail` /
`pages:regenerateThumbnail`). The page tools' share state landed with a follow-up of UA6.7: every
`list_pages` / `get_page` summary carries `shared`, and `get_page`'s details carry `shareUrl`, both read from
`LoadedPage.publication` — the workspace artifact registry's `'page'` row, never `page.json` — and a page is shared only
while that row is live (no deletion pending; an expired row is already no publication), as the Pages view's Published
badge. `delete_page` unpublishes a published page first (below) and reports `publicCopyMayRemain` when its copy could
not be taken down.

## Publishing (UA6.7)

The user publishes from PageView's Share entry (`SharePageDialog`); there is no agent path. The page goes through the
ONE publish chain `publish_artifact` uses (`server-core/src/sessions/artifact-publishing.ts` `runArtifactPublish`:
the normaliser, the host card payload, a re-read after the card, one request through the fixed-origin t-artifacts
client, the registry row, an audit line), with the page's own source port (`server-core/src/pages/page-publishing.ts`):
`shared/src/pages/share-bundle.ts` builds ONE self-contained document — the field allowlist, the script-grant refusal,
the view-only acknowledgment, the snapshot parse check, the service's single 16 MiB cap — with the snapshot inlined as
a JSON script and a read-only `nessy-pages/v1` shim (init from the snapshot, no grants, every action "view-only"), and
the UA1.17 scan runs over the HTML and the snapshot separately, then over the built document itself (the snapshot is
inlined re-serialised, so a token its raw file spells with JSON escapes is caught as it is sent). The card is the dialog's review:
`pages:getShareDataScan` runs the chain with a card port that captures the card and declines (nothing sent), the
dialog renders it with the session card's component, and `pages:publish` allows only the card whose sha256 the person
reviewed. `pages:unpublish` is one DELETE through the registry (a retryable failure kept as a pending deletion,
UA1.19), and `pages:delete` / `delete_page` take a published page's copy down before its folder goes. The publication
lives in the workspace's artifact registry (a `'page'` row with the page facet, on the credential read floor), never
in `page.json`; the loaders join it onto `LoadedPage.publication`. Dropped: upstream's share-capabilities flag and its
passwords (reason (a)).

## Scheduled refresh (UA8.2–UA8.4)

`refresh` on `create_page` / `update_page` (and on `pages:create` / `pages:update`) carries the script's CONTENT; the
host writes `pages/<slug>/refresh.ts` and page.json, so no agent-authored path reaches scheduled execution
(`pages/refresh.ts` `setPageRefresh`). A refresh is inert until the person approves the digest of that file in
PageView (`pages:getRefreshStatus` → `pages:approveRefresh`, which names the reviewed digest); the approval is the
MACed host-ledger entry `refresh-approval` / `page:<slug>` bound to `{ path, sha256, args, runtime }`. The
AutomationSystem builds a synthetic `page:<slug>` SchedulerTick matcher only for an approved refresh at its current
bytes, rebuilt from the watcher (page.json and `refresh.ts`), and the run goes through `runApprovedScript` with that
approval, so a script changed between a rebuild and a tick is refused and recorded. `pages:runRefreshNow` runs an
approved refresh at once through the same entry. The existing local-automation policy stops it through its three arms
(the scheduler construction gate, the change subscription, the use-time check). Stated residue: the approval binds the
script, not the schedule.

## Page actions and grants (UA9.1–UA9.4)

A page asks for a grant with `grant-request`; PageFrame opens the approval dialog only for a request that carries user
activation AND frame focus (a click inside the page), one dialog at a time and at most three a minute
(`page-frame-gates.ts` `checkPageGrantRequest`; upstream asks neither). The dialog shows the descriptor the HOST
validated (`pages:describeGrantRequest`, with the sha256 of a script's bytes now) as the authority and the page's
`description` labelled as page-supplied. Approval writes a MACed host-ledger entry `page-grant` /
`page:<slug>#<grantId>` (`pages:issueGrant`) bound to the digest of the page's bytes on disk, with a 30-day expiry, and
for a script the sha256, runtime and args; `page.json` never holds a grant. Every mutating action (anything but an API
`GET`) needs activation and frame focus too (`checkPageAction`: `user-activation-required`, `frame-focus-required`),
then reaches the per-workspace `PageActionBroker` (`pages:executeAction`), which re-reads the grant from the ledger on
every call and refuses a stale, expired, revoked or mismatched one (`grant-stale`, `grant-expired`, `grant-not-found`,
`grant-mismatch`), a changed render (`content-changed`) and a replay. The executors are the host's: MCP leases the
workspace pool as `page:<slug>`, API is refused for a source absent from the capability view, and a script re-hashes
(`grant-script-changed`) and runs only through `runApprovedScript` with the grant as its approval, the base script env
and the managed local-automation policy. Every action that reaches the broker is written to
`logs/page-actions.jsonl` (redacted params), script runs also to `logs/privileged-actions.jsonl`. A request the
RENDERER's gate refuses (user activation, frame focus, nonce, a refused grant request) never reaches the broker, so
PageFrame reports it over `pages:auditRefusal` and the broker writes it with `stage: 'renderer-gate'` (UA12.112) — at
most 30 such lines per page per sliding minute, the overflow counted into `page_gate_refusals_suppressed` lines — at
most one a minute, written by the first report the budget admits a minute after the last one, or when one of the
page's leases is released, expires or is evicted; a count still pending when the app quits is lost (UA12.178 and its
UA12.112 follow-up; host-side, so a renderer that skips its own limiter is held too). Both files rotate to
`<name>.1` at 10 MB, one generation, every append serialized per path
(`audit-rotate.ts`, UA12.62/UA12.177). The user removes a grant from PageView's Approved actions (`pages:revokeGrant`); the agent's guide is
`resources/docs/pages.md` "Source actions" (UA9.4).

## What was not ported

Craft's public share service (its host, its share API and its feature knobs) is cut under reason (a), a Craft external
service; the guard is `sharing-cut.test.ts` (UA6.6). Publishing itself goes to the internal artifact service (UA6.7,
"Publishing" above).
