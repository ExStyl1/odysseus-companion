# S5 — Managed MCP entries: the documented schema

From the phase-4 sweep (`2026-07-29-phase4-findings.md`). **An administrator who
deploys the documented denylist syntax today gets a policy that denies nothing.**

---

## 0. Method rules

1. **Fetch the page yourself**: `curl -s https://code.claude.com/docs/en/managed-mcp.md`.
   Never a summarising fetch tool — it invented field names twice in this series
   and both shipped.
2. **The quotation is the identifier, not the line number.** Report the line you
   found each quoted sentence at.
3. **Read around each quotation.** A sentence between two quoted ones can reverse
   their meaning; that produced a wrong composition premise in R25c.
4. **Declared ≠ enforced.** Name the consumer and prove it runs on **Pi**, the
   shipped default.
5. **Two git commands** — pathspec on the `commit`, not only `git add`.
6. Before calling any test failure pre-existing, reproduce it on a clean worktree
   at your base commit. Expect the ones in
   `docs/superpowers/specs/2026-07-29-known-failing-tests.md`.

---

## 1. What is wrong today, measured

Our `allowedMcpServers`/`deniedMcpServers` are `readonly string[]` validated by a
name regex (`managed-policy.ts`, the `MCP_SERVER` pattern). The documented entry
is an **object**. Probed against the real parser: a policy whose
`deniedMcpServers` is the page's own example —

```json
[{"serverName":"dangerous-server"},
 {"serverCommand":["npx","-y","unapproved-package"]},
 {"serverUrl":"https://*.untrusted.example.com/*"}]
```

— parses to an **empty** denylist, and `isManagedMcpServerAllowed` returns `true`
for all three. The admin sees an accepted policy file and one console warning;
the servers they meant to block keep loading.

**Fail-open on a deny path is the wrong direction to fail**, and it is the
direction we currently fail in. The allowlist fails the other way: the page's
example strips to `[]`, which admits nothing and blocks MCP fleet-wide.

Structurally worse: name is the only dimension we have, and the page says so in
terms — a `serverName` entry "is not a security control … To enforce which
servers actually run, add `serverCommand` or `serverUrl` entries." A user renames
a denied server and escapes; a user names any server `github` and satisfies an
allowlist.

---

## 2. The contract

Quote each of these by text and report where you found it.

**Entry shape** — § *Match servers by URL, command, or name*: the lists are
"lists of entries. Each entry is an object with a single key that identifies
servers by their URL, their command, or their name", the three keys being
`serverUrl`, `serverCommand`, `serverName`.

**Unset versus empty**, from the same section's table: for `allowedMcpServers`,
unset means all servers allowed, `[]` means **no** servers allowed, populated
means only matching ones. For `deniedMcpServers`, unset **and** `[]` both mean
nothing blocked.

**Evaluation order** — § *How a server is evaluated*, three checks in order:
merge the lists from every settings source; check the denylist, where "Nothing
overrides a denylist match"; then check the allowlist.

**Type-dependent allowlist**, the table in that section: a remote server is
allowed when it matches a `serverUrl` entry, "A `serverName` match counts only
when the allowlist contains no `serverUrl` entries"; a stdio server needs a
`serverCommand` entry, with the same name-only-if-absent rule.

**Matching rules**, the three bullets after that table:
- commands match exactly, "Every argument, in order";
- `serverCommand` and `serverUrl` values **expand** `${VAR}` and `${VAR:-default}`
  on *both* sides before matching, while "`serverName` values match literally and
  never expand";
- URLs support `*` wildcards "anywhere in the pattern, including the scheme",
  hostname matching is case-insensitive and ignores a trailing FQDN dot, and
  "Paths stay case-sensitive". The pattern table gives the cases to test,
  including that a pattern with no path matches any path.

**The expansion caveat**, immediately after: because `${VAR}` reads the process
environment, an entry referencing a variable "expands to whatever value a user
sets. Use literal URLs and commands for entries you rely on for enforcement."
**This is a warning about a real bypass** — decide what we do about it and say
so; a policy entry a user can redirect is not enforcement.

**`serverName` validation differs by list**: in `deniedMcpServers` it accepts any
non-empty string (so a connector display name can be blocked); in
`allowedMcpServers` it is limited to letters, numbers, hyphens and underscores.

**`allowManagedMcpServersOnly`**: when true, only the managed allowlist is kept —
"the denylist always merges from every source."

---

## 3. Tasks

### Task 1 — the entry type, parsed both ways

**Commit:** `feat(managed): the documented MCP entry schema, with the bare-string form kept`

Replace the `readonly string[]` lists with the discriminated entry. Requirements:

- **Exactly one key per entry.** An object with two of the three is invalid.
- **Keep reading a bare string** as `{ serverName: … }`. Our existing form is
  deployed; silently dropping it would break the admins we have to gain the ones
  we do not.
- **Per-list `serverName` validation**, as documented: permissive in deny,
  restricted in allow.
- **Invalid-entry posture is the sharp edge.** R25a made the managed tier
  tolerant, stripping bad values with a drop record, and its per-field polarity
  rule was: implement the pole that **enforces**. For an allowlist, stripping an
  entry narrows — safe. For a **denylist, stripping an entry un-blocks a server**,
  which is the fail-open we are here to fix. Decide the denylist's invalid-entry
  posture deliberately, state it, and make the drop record visible in
  `nessy-general-agent doctor` (R30b built that surface). "One console warn" is
  what we have now and it is not enough.

**Gate:** parse the page's own example policy verbatim and assert all three deny
entries survive. That single fixture is the whole point of the unit.

---

### Task 2 — match on what the server actually is

**Commit:** `feat(managed): match managed MCP entries by URL and command, not only name`

`isManagedMcpServerAllowed(policy, serverName)` receives only a name. Give it the
server's identity — transport, URL, command argv — and implement the three
matching rules.

- **Commands: exact argv, in order.** The doc's own negative cases are the test:
  `["npx","-y","server"]` matches neither `["npx","server"]` nor
  `["npx","-y","server","--flag"]`.
- **URL wildcards** anywhere including the scheme; host case-insensitive;
  trailing FQDN dot ignored; **paths case-sensitive**. Test every row of the
  documented pattern table, including the no-path pattern matching any path.
- **`${VAR}` expansion on both sides** for URL and command, never for name.
  Reuse whatever `.mcp.json` expansion we already have rather than writing a
  second one — find it first.
- Then the **type-dependent allowlist**: a `serverName` match counts only when
  the allowlist contains no entry of the stricter kind for that server's type.
  This is a property of the whole list, not of one entry, so it cannot be
  decided inside a per-entry predicate.

Find every call site. The current one is in `storage-runtime.ts`'s candidate
filter, and it is guarded by `isPiCapabilityTurn` — establish whether that is
still correct and report it.

**Gate:** a table driven from the documented examples, both poles. Include a
renamed-server case proving that a `serverUrl` deny survives the rename, since
that is the whole reason the URL dimension exists.

---

### Task 3 — evaluation order, and the unset/empty distinction

**Commit:** `feat(managed): denylist first, and an empty allowlist admits nothing`

- Denylist is checked first and **nothing overrides a match**.
- `allowedMcpServers` unset ⇒ all allowed; `[]` ⇒ none; populated ⇒ only
  matching. `deniedMcpServers` unset **and** `[]` ⇒ nothing blocked.
- `allowManagedMcpServersOnly`: only the managed allowlist survives; the denylist
  still merges from every source.

Check what we do today for the unset-versus-empty distinction on both lists —
R25a's tolerant parsing already emits `[]` for an invalid list, so an invalid
allowlist may already mean "admit nothing", and if so that is correct and should
be pinned by a test rather than rediscovered.

**Gate:** one fixture per row of the documented unset/empty/populated table.

---

### Task 4 — what we do not build

**Commit:** `docs(managed): the managed-MCP surfaces we do not implement`

Category strings for the rest of the page:

- **`managed-mcp.json` fixed deployment** and the disable-MCP-entirely form. This
  is a separate deployment channel, not a filter; almost certainly
  `documented, not implemented — <cost>`, and worth its own row.
- **claude.ai connectors** and `disableClaudeAiConnectors` — likely
  `inapplicable`, but say why.
- **The `${VAR}` bypass caveat** — whichever way you resolve it in Task 2.
- Anything else on the page you touch and deliberately leave.

---

## 4. Gate

Focused suites for every changed file; the managed-policy and permission
aggregates; `bun run typecheck:all`; `bun run lint`; `git diff --check`.

This is **managed policy and a permission decision** — two named risk triggers in
`AGENTS.md`. Run the expanded permission/policy set once on the final diff.

**Run every test from the repository ROOT.** A run from inside a package
directory bypasses the config-dir isolation preload and destroys the user's real
`~/.nessy-agent/config.json`.

**Mutation-probe the deny path specifically**: with the new matcher removed, the
page's own example policy must fail its test. A green suite that would also be
green with the fix absent proves nothing.

---

## 5. Constraints

- One commit per task, subjects exactly as given. **No `Co-Authored-By` trailers.**
- No push, MR or tags. No `reset`, `rebase`, `--amend`. Never `git checkout --`
  or `git stash` a file you are editing.
- Pathspec on the commit itself.
- Do not touch `docs/superpowers/specs/` or `docs/testing/cdp-live-checklist.md`
  (planner-owned), nor `~/.nessy-agent/skills/r17-*` or
  `~/.nessy-agent/mcp/elicit-server.mjs` (CDP fixtures).
- No version bumps, no release notes. Never write to `~/.nessy/dp_auth_creds.json`.
- **Never log a policy payload, token, credential or credentialed URL** — this
  unit handles managed policy, which carries server URLs and commands.
- Code, comments and commits in English.

## 6. Report

Commit shas; the line you found each quotation at; **every correction to this
plan**; the parse result for the page's verbatim example policy before and after;
the matching table; the call sites you found for `isManagedMcpServerAllowed` and
whether the `isPiCapabilityTurn` guard is still right; the Task 4 category
strings; and the deny-path mutation probe.
