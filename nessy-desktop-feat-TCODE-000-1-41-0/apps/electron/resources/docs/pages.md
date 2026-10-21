# Pages

A Page is a small HTML app or report that lives in the workspace and opens in the app (sidebar → **Pages**). Use a
Page when the user wants something that outlives the conversation: a dashboard, a report they will come back to, a
tracker you keep feeding with data, or a small calculator. For a one-off rendering inside the chat, use the chat
previews instead (`html-preview.md`, `markdown-preview.md`).

The user can publish a view-only copy of a page from its **Share** button (see Publishing below); you never publish a
page yourself.

The Pages library shows a preview poster of each page. It is captured offscreen, without network access, whenever the
page's content changes; use Refresh preview on a tile or in the page's menu to capture it again.

## Use the page tools, never file edits

| Tool | What it does |
|------|--------------|
| `list_pages` | Compact list: slug, name, kind, project, the last data write, the folder path. Filter by `projectId`. |
| `get_page` | Full details of one page, with absolute paths (`contentPath`, `data.snapshotPath`). `includeContent: true` returns the HTML inline. |
| `create_page` | A new page from a name, an optional kind, description, project, the full HTML and an optional scheduled `refresh`. |
| `update_page` | New name, description, kind, project or `refresh`, and/or a full replacement of the HTML. Only the fields you pass change; `null` clears the description, the project or the refresh. The slug never changes. |
| `write_page_data` | One transactional change to the page's data store (see below). |
| `delete_page` | Removes the page folder with its content and data. The user is always asked to confirm, in every permission mode; when nobody can answer (an automation, a subagent, Don't ask), nothing is deleted. |

A page's files sit in `{workspace}/pages/{slug}/`:

```
pages/{slug}/
├── page.json          # the page's settings, written by the app
├── index.html         # the page content (its sha256 digest is kept in page.json)
├── refresh.ts         # the scheduled refresh script, written by the app from `refresh` (only when there is one)
└── data/
    ├── store.sqlite   # the data store (internal)
    └── snapshot.json  # what the page is given to render
```

Do not write these files with file tools. The page tools keep the content digest, the app's file watcher and every open
view of the page consistent; a direct edit bypasses all three. Reading them is fine — `get_page` gives you the paths.

## Kinds

| Kind | Script | Use for |
|------|--------|---------|
| `static` | none | fixed documents and formatted reports |
| `interactive` (default) | inline JS | calculators, explorers, small tools |
| `live` | inline JS, and receives new data while open | dashboards you keep feeding with `write_page_data` |

## The data store

Each page has a small store with two shapes:

- **kv** — `key → any JSON value` (objects and arrays are fine). Use it for current values: totals, status objects,
  settings, lists.
- **series** — named lists of `{ t: epoch ms, v: number }` points, for anything you would chart over time. Writing a
  point at an existing `(series, t)` replaces its value, so repeating a write is safe.

`write_page_data` applies one patch in one transaction and rebuilds `data/snapshot.json`:

```
write_page_data({
  slug: "build-health",
  set: { summary: { total: 42, failing: 3 } },
  delete: ["old_key"],
  appendSeries: { "ci.duration_ms": [{ v: 84213 }, { t: 1756165200000, v: 79544 }] },
  pruneSeries: { "ci.duration_ms": 1748000000000 }
})
```

`t` defaults to now. `pruneSeries` removes the points older than the given timestamp.

The snapshot a page receives:

```json
{
  "version": 1,
  "generatedAt": 1756191234567,
  "kv": { "summary": { "total": 42, "failing": 3 } },
  "series": { "ci.duration_ms": [ { "t": 1756165200000, "v": 79544 } ] }
}
```

Limits: at most **1000 kv keys** and **100 series** per page, and the snapshot carries the newest **1000 points** of a
series (ascending by `t`). A write that would cross a key or series limit fails as a whole and changes nothing. Use
stable names you update — put a list inside one kv value rather than minting a key per item or a series per day.

## Scheduled refresh

A page can update its own data on a schedule, with no agent session and no tokens: give `create_page` or
`update_page` a `refresh`.

```
update_page({
  slug: "build-health",
  refresh: {
    cron: "*/15 * * * *",
    scriptContent: "…the whole refresh script…"
  }
})
```

- `scriptContent` is the **script itself, not a path**. The app writes it to `pages/{slug}/refresh.ts` and runs that
  file with **Bun**; you never choose where a scheduled script lives. Optional fields: `args` (extra argv), `timezone`
  (IANA; the computer's own when omitted), `timeoutMs` (default 60 s, between 1 s and 15 min), `enabled: false` to
  pause the schedule without removing it. `refresh: null` removes the refresh and its script.
- `cron` has five fields and is checked when you write it: it must parse, it must actually fire, and it may not run
  more often than **every 5 minutes** (`*/5 * * * *` is the fastest). An invalid refresh fails the whole call and
  nothing is written.
- **A refresh does not run until the user approves its script.** The page shows the schedule and "Waiting for your
  approval"; the user reviews the script there and approves it. After that it runs on its schedule, and the user can
  also run it at once ("Run now"). **Any change to the script needs a new approval** — a new `scriptContent`, or an
  edit of `refresh.ts` by anyone — and until then the refresh is stopped. Tell the user when a refresh is waiting
  for them. Changing only `cron`, `timezone`, `timeoutMs` or `enabled` keeps the approval.
- An organisation policy that turns off local automations stops page refreshes as well.

What the script gets:

- **One self-contained file.** It runs from a private copy of the approved bytes, so it cannot import sibling files
  (`./lib.ts`) or the workspace's packages. Put everything in the one script; Bun built-ins (`bun:sqlite`, `fetch`)
  are available.
- **Network: allowed.** The script may call any API it needs.
- **No secrets in its environment.** It sees only `HOME` (on Windows a few system variables), `NESSY_WORKSPACE_PATH`,
  `NESSY_PAGE_SLUG`, `NESSY_PAGE_DIR`, `NESSY_PAGE_DATA_DIR` and the scheduler's event variables (`NESSY_EVENT`,
  `NESSY_EVENT_DATA`, `NESSY_WORKSPACE_ID`, `NESSY_LOCAL_TIME`, …) — no `PATH`, no app tokens, no credentials. A script that needs a key must not have it embedded; ask the user how
  they want to provide it.
- The working directory is the workspace root. The app records each run's outcome on the page (the dot next to its
  name; a failed run shows its error above the page) and in automation history.

The script writes the page's data the way `write_page_data` does: the store `$NESSY_PAGE_DATA_DIR/store.sqlite`
(two tables), then the snapshot `$NESSY_PAGE_DATA_DIR/snapshot.json`, written to a temporary file and renamed into
place:

```ts
// pages/build-health/refresh.ts (Bun) — written by the app from scriptContent
import { Database } from 'bun:sqlite';
import { renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.env.NESSY_PAGE_DATA_DIR!;
const db = new Database(join(dir, 'store.sqlite'));
db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;');
db.exec(`CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
         CREATE TABLE IF NOT EXISTS timeseries (series TEXT NOT NULL, t INTEGER NOT NULL, v REAL NOT NULL,
           PRIMARY KEY (series, t)) WITHOUT ROWID;`);

const summary = await (await fetch('https://ci.example.com/api/summary')).json();
const now = Date.now();
db.run('INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, ?)', ['summary', JSON.stringify(summary), now]);
db.run('INSERT OR REPLACE INTO timeseries (series, t, v) VALUES (?, ?, ?)', ['ci.duration_ms', now, summary.durationMs]);

const kv = Object.fromEntries(db.query('SELECT key, value FROM kv').all().map((r: any) => [r.key, JSON.parse(r.value)]));
const series: Record<string, { t: number; v: number }[]> = {};
for (const { series: name } of db.query('SELECT DISTINCT series FROM timeseries').all() as any[]) {
  series[name] = (db.query('SELECT t, v FROM timeseries WHERE series = ? ORDER BY t DESC LIMIT 1000').all(name) as any[]).reverse();
}
const tmp = join(dir, `.snapshot.json.${process.pid}.tmp`);
writeFileSync(tmp, JSON.stringify({ version: 1, generatedAt: Date.now(), kv, series }));
renameSync(tmp, join(dir, 'snapshot.json'));
```

Keep the limits of the data store (1000 kv keys, 100 series, the newest 1000 points of a series in the snapshot). If the
data does not need a schedule, skip the script: write it yourself with `write_page_data`.

## Writing the HTML

The page runs in a sandboxed frame with a strict content security policy. Three rules follow from it:

1. **One self-contained document.** Inline all CSS and all JS. The frame blocks every network request
   (`connect-src 'none'`, `default-src 'none'`): no CDN scripts, no web fonts, no `fetch()`, no WebSocket, no remote
   images. Images and fonts work only as `data:` or `blob:` URLs. Draw charts yourself with inline SVG or a canvas.
2. **Data comes from the bridge, not from the network.** The app sends the snapshot to the page with `postMessage`;
   `live` pages get a replacement snapshot whenever the data changes.
3. **No storage, no parent access.** The frame has an opaque origin: no cookies, no `localStorage`, no access to the
   app's DOM. Keep state in JS variables. Forms cannot submit anywhere and the page cannot navigate itself or open
   frames, workers or plugins. A `static` page runs no script at all.

### The bridge (`nessy-pages/v1`)

Messages from the app carry `protocol: 'nessy-pages/v1'`:

- `init` — `{ page: { slug, kind }, nonce, snapshot, grants }`, sent after the page loads and again when the page
  posts `ready`. `snapshot` is `null` until data has been written; `grants` is described in
  [Source actions](#source-actions).
- `data` — `{ snapshot }`, the replacement snapshot for a `live` page.
- `grants` and `action-result` — the answers to a page's source actions (below).

```html
<script>
  let nonce = null;

  function render(snapshot) {
    // snapshot = { version, generatedAt, kv, series } or null (no data yet)
  }

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || msg.protocol !== 'nessy-pages/v1') return;
    if (msg.type === 'init') {
      nonce = msg.payload.nonce;
      render(msg.payload.snapshot);
    } else if (msg.type === 'data') {
      render(msg.payload.snapshot);
    }
  });

  // Ask for init (it is also delivered on its own after load).
  window.parent.postMessage({ protocol: 'nessy-pages/v1', type: 'ready' }, '*');
</script>
```

### Opening a link

A page cannot navigate. To open an `http` or `https` URL in the user's browser, ask the app from a click handler; the
app shows the user the full URL and opens it only after they confirm:

```js
window.parent.postMessage({ protocol: 'nessy-pages/v1', type: 'open-url', nonce, url: 'https://example.com' }, '*');
```

## Source actions

A page can ask the app to run an action for it — a call to one of the workspace's sources (an MCP tool or an API
endpoint) or a script in the workspace — without ever holding a credential. The page never runs the action itself: it
asks for an approval (a **grant**), the user approves it in the app, and the app runs each call after checking it
against that grant.

| Kind | What the page asks to approve (descriptor) | What the page sends to run it (invocation) |
|------|--------------------------------------------|---------------------------------------------|
| `api` | `{ kind: 'api', sourceSlug, method, pathPattern }` — `pathPattern` is an anchored regular expression | `{ kind: 'api', method, path, params? }` |
| `mcp` | `{ kind: 'mcp', sourceSlug, toolName }` | `{ kind: 'mcp', toolName, args? }` |
| `script` | `{ kind: 'script', script, runtime?, args? }` — a workspace-relative path; `runtime` is `bun` (default), `node` or `python3` | `{ kind: 'script' }` — nothing else; see [Scripts](#running-a-script-on-the-users-computer) |

### Asking for approval

```js
let grants = [];                               // [{ id, action, expiresAt }] — from init and every `grants` message
const NEEDS = [
  { key: 'read', description: 'Refresh the build list',
    action: { kind: 'mcp', sourceSlug: 'ci', toolName: 'list_builds' } },
];
function grantFor(action) {                    // match by descriptor, never by a remembered id
  return grants.find(({ action: a }) => a.kind === action.kind && (action.kind === 'script'
    ? a.script === action.script && (a.runtime ?? 'bun') === (action.runtime ?? 'bun')
      && JSON.stringify(a.args ?? []) === JSON.stringify(action.args ?? [])
    : a.sourceSlug === action.sourceSlug && (action.kind === 'mcp' ? a.toolName === action.toolName
      : a.method === action.method && a.pathPattern === action.pathPattern)));
}
// In the message listener: init → grants = msg.payload.grants; 'grants' → grants = msg.payload.grants.

document.getElementById('allow').addEventListener('click', () => {   // a button on the page
  const missing = NEEDS.filter(n => !grantFor(n.action));
  if (missing.length) window.parent.postMessage({ protocol: 'nessy-pages/v1', type: 'grant-request', nonce, requests: missing }, '*');
});
```

- **Ask from a click inside the page.** The app shows the approval dialog only for a `grant-request` sent right after
  the user clicked inside the page. A request sent on load, from a timer, or after a click elsewhere in the app opens no
  dialog — the app answers with the current `grants` instead. Give the page an "Allow…" button and ask from its click
  handler; keep the page useful, with its action buttons disabled, until the approval exists.
- Match a grant by its descriptor, field by field: an MCP grant on the source and the tool, an API grant on the
  source, the method and the path pattern, a script grant on `script`, `runtime` (`bun` when absent) and the ordered
  `args` — a script has no `sourceSlug`. Two script actions are two grants; one never stands in for the other.
- One dialog at a time per page and at most three a minute; a descriptor the user declined is not asked again while
  the page stays open. At most 8 entries per request; `key` is your own id for an entry.
- The dialog shows what the app checked as the thing being approved: the source and the tool, or the method and the
  path, or the script with its runtime, arguments and the sha256 of its bytes. Your `description` appears below it,
  marked as written by the page and not verified — say truthfully what the action does; it cannot widen the grant.
- The app answers with `grants` — `{ grants: [{ id, action, expiresAt }] }`, every grant usable right now — and sends it
  again whenever the user approves or removes one; after a change of the page's content the page reloads and `init`
  carries the grants still usable. Drive your buttons from these, not from a list you kept.

### Running an action

```js
const requestId = crypto.randomUUID();
window.parent.postMessage({
  protocol: 'nessy-pages/v1', type: 'action', requestId, nonce,       // nonce from init
  grantId: grantFor(need.action).id,
  invocation: { kind: 'mcp', toolName: 'list_builds', args: { limit: 20 } },  // must fit the grant
}, '*');
// The answer is an 'action-result' message: payload.result = { requestId, ok, status?, body?, error?, durationMs }.
```

- **Every action except an API `GET` needs a click inside the page**: an API call with any other method, every MCP tool
  (it may write) and every script. Send it from the click handler. Sent on load, from a timer, or after a click on the
  app's own toolbar, it is refused with `user-activation-required` or `frame-focus-required` and never runs. Show on
  open what the snapshot already has; make live calls button-driven.
- Per open page: at most 5 actions in flight, one action that may write at a time, 30 a minute. An action is stopped
  after 30 seconds; cancel one yourself with `{ type: 'action-cancel', requestId, nonce }`.
- A refused action's `error` starts with its reason: `grant-not-found` (no such grant — the user removed it),
  `grant-stale` (approved for an older version of the page), `grant-expired`, `grant-mismatch` (the call does not fit
  the grant), `grant-script-changed` (the script changed since it was approved), `content-changed` (the page changed
  under this view; it reloads), `source-auth-required` (the source must be reconnected — the app shows a reconnect
  banner above the page; let the user click again afterwards).

### What a grant binds, and for how long

- **The app keeps grants in its own approvals record**, not in the page's files: a grant written into `page.json` is
  ignored. No tool creates or removes one — the page asks, the user decides. `get_page` lists the page's grants, each
  with a `stale` flag.
- A grant is bound to the page's exact content at approval time and **expires after 30 days**. Any change of the
  page's HTML — `update_page` or anyone else — makes every grant stale; the page simply asks again.
- The user can remove an approval at any time: the page's **⋯** menu → **Approved actions**. Open pages get an updated
  `grants` message at once.
- An organisation policy that turns off local automations also stops page scripts, approved or not.

### Running a script on the user's computer

A script grant is the strongest thing a page can ask for: it runs a command on the user's computer. **It pins the
script's bytes** (their sha256), its runtime and its arguments when the user approves it. The page cannot pass
anything at call time — the invocation is just `{ kind: 'script' }` — and if the file changes afterwards the call is
refused (`grant-script-changed`) until the user approves it again. To vary what runs, approve one wrapper script that
decides.

It runs the way a scheduled refresh does: one self-contained file, run from a private copy of the approved bytes (it
cannot import a sibling file), started directly and never through a shell, from the workspace root, with no secrets in
its environment — only `HOME` (on Windows a few system variables), `NESSY_WORKSPACE_PATH`, `NESSY_PAGE_SLUG`,
`NESSY_PAGE_DIR` and `NESSY_PAGE_DATA_DIR`; no `PATH`, no app tokens. The result `body` is `{ exitCode, stdout, stderr }`
and `ok` is `exitCode === 0`. Running it does not change the page's refresh status. Tell the user what a script action
does before you add one to a page.

### The record of what ran

Every action that reaches the app — run or refused — is written to `logs/page-actions.jsonl` in the app's
configuration folder: the page, the grant, the shape of the call (sensitive values redacted) and the outcome. A request
the app refuses at the page's frame (no click inside the page, a stale nonce, a refused grant request) is written too,
at most 30 lines a minute per page; the rest are counted in a `page_gate_refusals_suppressed` line, at most one a
minute (a count still pending when the app quits is not written). A script run is
also written to `logs/privileged-actions.jsonl`, with the sha256 of the bytes that ran. Each file is rotated when it
reaches 10 MB: it becomes `<name>.1` (replacing the previous `.1`), so one earlier generation is kept.

## Publishing

The user publishes a page from its **Share** button: a view-only copy on the company's internal artifact service
(t-artifacts), open to anyone with the link, kept for 7 days unless the user extends it in Settings → Published pages.
Publishing is the user's action — do not publish page files with `publish_artifact`, and do not promise a link.

- **One self-contained file.** The copy is the page's HTML as it is, plus the current data snapshot only when the user
  includes it. Inside the copy the bridge answers `init` from that snapshot (or `null`); `data` never arrives, because
  the copy does not update; `grants` is always empty; every `action` answers `ok: false` with an error that starts with
  `view-only:`; `open-url` opens the link in a new tab. Write pages that still show something sensible with no grant
  and no data.
- **Refused.** A page with a script approval is never published. A page with approved source actions is published only
  after the user confirms the copy is view-only. A `<form>` or a password field is refused, and so is a page whose HTML
  or data carries a token-shaped value (a JWT, a `Bearer` header, a card number). Keep secrets out of pages and their
  data — the user sees the exact bytes before anything is sent, and the check is not a guarantee.
- **Afterwards.** The copy changes only when the user publishes again ("Publish latest", the same link). Unpublishing
  closes the link for everyone, and deleting a published page takes its copy down first; copies readers saved are not
  recalled.

## Starter template

```html
<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Build Health</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; margin: 24px; }
  .metric { font-size: 40px; font-weight: 700; }
  .muted { opacity: 0.6; font-size: 12px; }
  svg { width: 100%; height: 160px; }
</style>
</head>
<body>
  <h1>Build Health</h1>
  <div class="metric" id="total">—</div>
  <div class="muted" id="updated">waiting for data…</div>
  <svg id="chart" viewBox="0 0 600 160" preserveAspectRatio="none"></svg>
<script>
  function render(snapshot) {
    if (!snapshot) return;
    const summary = snapshot.kv.summary || {};
    document.getElementById('total').textContent = summary.total ?? '—';
    document.getElementById('updated').textContent = 'updated ' + new Date(snapshot.generatedAt).toLocaleString();
    const points = snapshot.series['ci.duration_ms'] || [];
    const max = Math.max(1, ...points.map(p => p.v));
    const w = 600 / Math.max(1, points.length);
    document.getElementById('chart').innerHTML = points
      .map((p, i) => `<rect x="${i * w}" y="${160 - (p.v / max) * 150}" width="${Math.max(1, w - 2)}" height="${(p.v / max) * 150}" fill="#4f7cff"/>`)
      .join('');
  }
  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || msg.protocol !== 'nessy-pages/v1') return;
    if (msg.type === 'init' || msg.type === 'data') render(msg.payload.snapshot);
  });
  window.parent.postMessage({ protocol: 'nessy-pages/v1', type: 'ready' }, '*');
</script>
</body>
</html>
```

## Recipes

- **"Track this number over time"** → a `live` page with a series chart; append a point with `write_page_data` each
  time you learn a new value.
- **"Make a dashboard of X"** → `create_page` (kind `live`, the full HTML), then seed it with `write_page_data` so it is
  not empty when the user opens it.
- **"…that updates every N minutes"** → the same, plus a `refresh` (cron + the script content), then tell the user to
  approve the script on the page — it does not run before that.
- **"Turn this report into a page"** → `create_page` (kind `static`, all styles inline).
- **Changing a page** → `update_page` with the new `content`; it replaces the whole document.
