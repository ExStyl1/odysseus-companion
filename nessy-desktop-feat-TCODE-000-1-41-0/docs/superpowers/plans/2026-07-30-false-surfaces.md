# Three false surfaces — R30b, R11, R3

From the 2026-07-30 re-verification (`2026-07-30-reverification.md`, including
its late-challenge correction). Three fixes with one theme: **a surface the user
or an administrator is told to trust reports something untrue.** A diagnosis
surface that invents a finding, a measurement surface that mislabels 12K tokens,
and a guard surface a caller walks around by spelling the same host as an IP.

All three root causes are already located to the line. Your first job on each is
to reproduce the falsehood, not to re-derive it — then fix it at the named line,
not around it.

---

## 0. Method rules

1. **Fetch every doc page yourself with `curl -s`** — `settings.md`,
   `context-window.md`, `debug-your-config.md`, `tools-reference.md`,
   `mcp.md`. Never a summarising fetch tool; quote whole lines.
2. **Declared ≠ enforced.** Prove on **Pi**, the shipped default.
3. **`rg` skips NUL-containing files silently** — use `grep -a` for absence
   claims, and search the concept, not one guessed identifier.
4. **Two git commands** — pathspec on the `commit`, not only `git add`.
5. **A CDP dev instance may be on port 9223.** Do not kill or drive it.
6. **Run every test from the repository ROOT.** A package-directory run bypasses
   the config-dir isolation preload and destroys the user's real
   `~/.nessy-agent/config.json`.

---

## 1. Task 1 — the doctor stops lying (R30b remainder)

**Commit:** `fix(config): doctor reports only entries the administrator wrote`

`nessy-general-agent doctor` prints an "Invalid managed entries" line naming
`disabledPermissionModes` — a field the administrator never wrote — for **every**
managed policy that omits that key, and sets `hasFindings: true`.
`settings.md:186` makes that list the thing an admin is told to trust; the entry
reported was neither present nor stripped.

Root cause, already located: `managed-policy.ts:1048-1054` calls
`toleratedList(sink, 'disabledPermissionModes', root.disabledPermissionModes, …)`
**unconditionally**, unlike every neighbouring key which guards
`root.X === undefined ? undefined : …` (compare `:1055`, `:1058`). `undefined`
reaches `list()`, throws, and the sink records a drop. The drop list then has two
readers — `storage-runtime.ts:237` (console.warn at every startup) and
`apps/cli/src/doctor.ts` — so the latent bug became a false diagnostic.

- Fix the guard to match its neighbours.
- **Add the test the suite is missing:** the only zero-drop assertion today is
  `storage-runtime-delivered-policy.test.ts:163` against `EVERY_KEY`, which SETS
  `disabledPermissionModes` — so omission was never tested. Assert a valid
  policy **omitting** the key produces zero drops AND `doctor` reports
  `hasFindings: false`. Sweep the sibling keys for the same pattern: test
  omission of **each** optional key, not just this one — this bug class is "the
  one key whose guard differs from its neighbours", and the next one is cheaper
  to catch now.
- Check `git log` for when the unconditional call was introduced; if a sibling
  was added since with the same shape, fix it in the same commit.

**Gate:** a live `doctor` run against a temp config dir with a minimal valid
managed policy prints no "Invalid managed entries" line. **Mutation probe:**
revert the guard → the new omission test goes red.

---

## 2. Task 2 — the /context split stops lying (R11 demotion)

**Commit:** `fix(context): internal session tools are system tools, not MCP tools`

`context-categories.ts:103-104` (in `packages/pi-agent-server/src/`) splits
system vs MCP tools on a bare `mcp__` prefix. Every one of Nessy's ~50 internal
session tools is advertised as `mcp__session__*` (`session-tool-defs.ts:21`), so
with **zero** user MCP servers connected the challenger measured
`mcp_tools` = 11,946 tokens and `system_tools` = 1,065 — inverted.
`context-window.md:43-48` makes the MCP-tools row mean MCP-**server** tools, and
the codebase itself draws the right distinction 450 lines away: `index.ts:1414`
keys `kind` off `mcp__session__`.

- Split on the same predicate `index.ts:1414` uses. **Do not duplicate the
  prefix string a third time** — one exported predicate (or constant) that both
  sites read; the file that owns `mcp__session__` today is where it lives.
- The fixture list in `context-usage.categories.test.ts:70-80` is
  `['read', 'mcp__gitlab__repos']` — never the production shape, which is
  exactly why 4/4 green proved nothing about the split. **Add the production
  shape** (`mcp__session__*` alongside a real `mcp__<server>__*`) and assert
  each lands in its documented category.
- Check whether anything else consumes the same split — a category totals
  consumer, a renderer breakdown — and say in the report what else moved when
  12K tokens changed columns.

**Gate:** the new test distinguishes the three kinds; existing category tests
stay green (the measured-equals-sent property must not change). **Mutation
probe:** revert to the bare-prefix split → the new test goes red.

---

## 3. Task 3 — the network guard stops being walkable by spelling (R3 demotion)

**Commit:** `fix(config): a literal IP is a host — deny rules and allowlists apply`

`tools-reference.md:303`, whole line: "Claude Code denies URLs that point at a
private, link-local, or cloud-metadata address, including hostnames that resolve
to one. It also denies hosts in `sandbox.network.deniedDomains`, and when
`allowManagedDomainsOnly` is set in managed settings, any host outside the
managed allowlist." A raw IP is a host.

The challenger proved through the SHIPPED path (real `authorizeMonitor`, real
`SessionMonitorService`, resolution rigged to throw): with managed posture
`{allowedDomains:['corp.example.test'], allowManagedDomainsOnly:true}`,
`wss://elsewhere.example.test/s` is refused with zero prompts, but
`ws://93.184.216.34/stream` raises a **user-approvable prompt** and opens on
approval. **A managed org's allowlist is downgraded from a documented DENY to a
prompt by writing the address instead of the name.**

Root cause: `network-address-guard.ts:156-159` returns early for any literal IP
— `blockedAddressReason` or ALLOWED — so a public literal IP never reaches the
`deniedDomains` check (`:161`) or the `managedAllowlist` check (`:166-169`).

- Fix the ordering: a literal IP that is not blocked outright must still fall
  through to `deniedDomains` and the managed allowlist. Think about what a
  domain entry means for an IP: an allowlist of NAMES cannot admit a raw IP
  (unless the entry itself is that IP), so under `allowManagedDomainsOnly` a
  literal public IP is **denied** unless the allowlist names it. Assert the
  deny **reason**, not just the verdict — the wildcard-domain fix on this same
  file survived its own mutation probe until the test pinned the reason.
- **Two more documented `ws` field rules are dropped end to end**, and no
  validation exists anywhere: `tools-reference.md:296` (`url`: "no embedded
  credentials or whitespace, using ASCII characters only" — the challenger
  opened `ws://user:secret@93.184.216.34/stream` and the credentials survived
  into `openSocket`) and `:297` (`protocols`: valid subprotocol tokens, no
  duplicates — `['a b','dup','dup']` started a watch). Build ONE pure validator
  in the guard module and enforce it in `session-monitor-service.ts` before any
  socket opens — the last gate before the network, so no caller can route
  around it. `monitor.ts:60-62` (session-tools-core) may also surface the error
  early for a better message, but the *enforcement* lives at the socket.
- **Never log the credentialed URL.** A test fixture URL with embedded
  credentials must not appear in any error message, log line, or thrown string —
  strip or redact before reporting.

**Gate:** the literal-IP forms of the challenger's two probes now refuse with
the managed-deny reason and zero prompts; a credentialed URL and a duplicate
protocol list are refused before `new WebSocket`; hostname behaviour and the
existing 34 guard + 23 monitor tests stay green. **Mutation probes:** (a) revert
the fallthrough → the literal-IP allowlist test goes red on the reason;
(b) remove the socket-side enforcement call → the credentialed-URL test goes red.

---

## 4. Task 4 — what stays open

**Commit:** `docs(audit): category strings for the surfaces this plan leaves open`

Category strings for anything left, in the plan file's own § — in particular any
`tools-reference.md` monitor field rule you did not enforce, and R11's
neighbouring categories if you find more mis-assignment you do not fix.
Unwrapped, unbolded, backtick-terminated, no inline backticks in the reason,
under 400 characters.

Recorded at execution (2026-07-30). Both `ws` field rules of
`tools-reference.md:296`-`:297` are now enforced at the socket gate, so no
monitor FIELD rule stays open; what stays open is the availability rule beside
them, and one redaction belt in a file a concurrent agent owned.

Monitor availability, `tools-reference.md:275`:

`documented, not implemented — Monitor's availability rule that setting DISABLE_TELEMETRY or CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC removes the tool has no reader in this repo: neither variable is consulted anywhere, so an operator who sets them to keep a host quiet still gets command and ws watches; the ws field rules beside that sentence are enforced, this availability gate is what remains`

Raw-URL echoes in the authorize path:

`partial — the ws field rules are enforced in SessionMonitorService.start BEFORE authorize, so through the shipped path a credentialed URL can no longer reach a prompt or an error string; the raw-URL echoes inside SessionManager.authorizeMonitor and its prompt description remain unredacted as a second belt, and that file was owned by a concurrent agent this run, so the belt stays unbuilt`

R11's neighbouring categories were checked and no further mis-assignment was
found: MCP-sourced context resources match no documented category and stay in
the unattributed remainder by recorded decision (`context-categories.ts`), the
renderer breakdown is id-keyed and moved with the fix, and the capability
catalog's session/builtin kind already used the correct predicate, now shared.

---

## 5. Gate

Focused suites for every changed file; `bun run typecheck:all`; `bun run lint`;
`git diff --check`. Permission/network decisions are a named risk trigger — run
the config and server-core aggregates once on the final diff.

Expected pre-existing failures: `2026-07-29-known-failing-tests.md`. Reproduce
on a clean `git worktree`, never `git stash`.

## 6. Constraints

- One commit per task, subjects exactly as given. **No `Co-Authored-By`.**
- No push, MR or tags. No `reset`, `rebase`, `--amend`. Never `git checkout --`
  or `git stash` a file you are editing.
- **DO NOT touch `packages/server-core/src/sessions/SessionManager.ts`,
  `packages/shared/src/agent/pi-agent.ts`, `packages/shared/src/agent/base-agent.ts`,
  or anything under `apps/electron/src/renderer/`** — another agent owns those
  files right now. If a fix genuinely requires one of them, land everything that
  does not, and report the residual instead of editing the file. The same for
  `packages/session-tools-core/src/runtime/filesystem-isolation.ts` and the
  permission-gate/pre-tool-use area (a second agent).
- Do not touch `docs/superpowers/specs/` or `docs/testing/cdp-live-checklist.md`
  (planner-owned), nor `~/.nessy-agent/skills/r17-*` or
  `~/.nessy-agent/mcp/elicit-server.mjs` (CDP fixtures).
- No version bumps, no release notes. Never write to `~/.nessy/dp_auth_creds.json`.
- Never point a probe at a real external host — loopback fixtures only.
- Code, comments and commits in English.

## 7. Report

Commit shas; whether each falsehood reproduced before the fix; the doc line each
fix answers to, quoted whole; what else moved when the 12K tokens changed
columns; which monitor field rules remain unenforced; every correction to this
plan; and all mutation probes with which side went red.
