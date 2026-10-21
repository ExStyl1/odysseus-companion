# M5, M2, M4 — the MCP surfaces the audit's step 3 left open

Three new rows, ordered by consequence. The first is the only one of the ten
new rows that touches what a user can be tricked by; the second is an admin
lever a bank asks for by name; the third is a transport we silently drop.

## 0. Method rules

1. Fetch pages with `curl -s`: `https://code.claude.com/docs/en/mcp.md`, and
   for elicitation the MCP spec at
   `https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation.md`
   (note the year — `2026-…` 404s; the vendored SDK's `LATEST_PROTOCOL_VERSION`
   is the authority). Quote WHOLE lines.
2. **Declared ≠ enforced, and enforced ≠ reachable.** Name the production
   consumer for anything you claim works. Prove on **Pi**, the shipped default.
3. **Many files here contain NUL bytes** — always `grep -a` for absence claims,
   and never pipe a grep through `head -N` before you know the hit count.
4. **Two git commands** — pathspec on the `commit`. One commit per task.
5. **Run every test from the repository ROOT.** A package-directory run
   destroys the user's real `~/.nessy-agent/config.json`. Check no other
   `bun test` is running before recording a new failure.
6. CDP may be on 9223 — do not kill or drive it; do not run
   `electron:build:servers`.

---

## 1. Task 1 — a spoofed URL cannot look legitimate (M5)

**Commit:** `feat(mcp): the elicitation consent card warns about deceptive URLs`

URL-mode elicitation meets every MUST of the client spec — `mcp/elicitation.ts`
shows the full URL and takes explicit consent — and **neither display SHOULD**:
no domain highlight, no Punycode or suspicious-URI warning, in `elicitation.ts`
or `utils/url-safety.ts`.

The threat is concrete: the URL comes **from the server**, and the user is being
asked to visit it and probably authenticate. A homograph domain or a
`legit.example.com.attacker.net` subdomain suffix is indistinguishable in a
plain full-URL display — that is exactly what these SHOULDs exist for.

- Compute the registrable domain and make it visually dominant in the card;
  the rest of the URL stays visible (the MUST is the full URL — do not truncate
  it away to make room for the highlight).
- Warn when the host contains Punycode (`xn--`) — show the decoded form
  alongside so the user can see what it renders as — and when the host is
  otherwise deceptive (mixed scripts, a label that repeats a well-known domain
  as a suffix). Keep the rule set small and explainable; a warning nobody
  understands is dismissed.
- **This is a decision surface, not a lint**: the warning must be visible before
  the consent action, not after, and must not be dismissible into a state where
  consent is easier than reading it.
- i18n: keys in every locale file, parity + sorted green.
- The playground is a design surface in this repo: add the warning states to the
  elicitation card's canonical entries.

**Gate:** a Punycode host renders the decoded warning; a subdomain-suffix
lookalike is flagged; an ordinary `https://corp.example.com/x` shows the
highlight and no warning; the full URL is still present in every case.
**Mutation:** drop the warning computation → the Punycode test goes red.

---

## 2. Task 2 — `.mcp.json`'s `oauth` object (M2)

**Commit:** `feat(mcp): project config carries the oauth object`

`parseProjectMcpServer` (`shared/src/mcp/project-config.ts:33-88`) reads only
type/url/headers/command/args/env/timeout/alwaysLoad. Two documented fields have
no path in:

- `mcp.md:715`: "Set `authServerMetadataUrl` in the `oauth` object of your
  server's config in `.mcp.json`" — today the discovery chain is hardcoded at
  `auth/oauth.ts:1390-1398`.
- `mcp.md:735`: "`oauth.scopes` … is the supported way to restrict an MCP
  server to a security-team-approved subset when the upstream authorization
  server advertises more scopes than you want to grant" — `prepareMcpOAuth`
  sends no `scope` parameter at all.

Read both sections whole before implementing; quote them in the report.

- Parse the object, thread it to the OAuth flow, and make `authServerMetadataUrl`
  **override** discovery rather than supplement it.
- `oauth.scopes` must narrow, never widen: if the config names a scope the
  server does not advertise, that is a config error worth a diagnostic, not a
  silent request. Say in the report what happens when the two disagree.
- **Never log a token, an authorization code, a client secret, or a full
  callback URL with a code in it.** Existing code in this area already respects
  that; keep it in every new error path.
- An unknown key inside `oauth` should not sink the whole server entry — today
  `parseProjectMcpServer` returns `null` for anything unexpected, which drops
  the server. Check that behaviour and say what you chose.

**Gate:** a `.mcp.json` naming `authServerMetadataUrl` uses it instead of the
well-known chain; `oauth.scopes` reaches the authorization request; a server
without an `oauth` object behaves exactly as before. **Mutation:** ignore
`scopes` at the request site → the scope test goes red.

---

## 3. Task 3 — the WebSocket transport (M4)

**Commit:** `feat(mcp): ws servers are configurable on every path`

`mcp.md:147`: "The `type: \"ws\"` entry accepts the same `url`, `headers`,
`headersHelper`, `timeout`, and `alwaysLoad` fields as `http`." Also the plugin
transport list at `mcp.md:314`.

Today: the `SdkMcpServerConfig` union admits only http/sse/stdio
(`agent/backend/types.ts:678-727`); `.mcp.json` parsing returns `null` and logs
the refusal to **debug only**; the Claude plugin adapter drops such a server
(`format-adapters/claude.ts:960-966`). Our own idle-timeout code already reasons
about WebSocket servers that cannot exist (`mcp-pool.ts:234`).

- Add the transport through the union, the project-config parser, the plugin
  adapter, and the pool's transport construction. The vendored MCP SDK's
  WebSocket transport is the client; do not write a socket by hand.
- **`headersHelper` is listed as a `ws` field and has no implementation
  anywhere** — that is a separate, already-owned register row. Parse it if the
  shape demands, but do NOT build it here; say so.
- The network guard applies: a `ws://` or `wss://` URL for an MCP server goes
  through the same address checks a Monitor `ws` target does
  (`config/network-address-guard.ts` — `validateWsWatchInput` and
  `isDeniedNetworkTarget`). A literal IP, embedded credentials, or a
  managed-denied host must be refused for an MCP server too. **State in the
  report whether the guard was already reached on this path or you wired it.**
- A dropped server should tell the author: today the refusal goes to debug. If
  a `ws` entry is still refused for another reason, the diagnostic must reach
  the same channel other adapter diagnostics use.

**Gate:** a `ws` server in `.mcp.json` connects and contributes tools on Pi; the
same via a Claude plugin bundle imports rather than dropping; a `ws` URL with
embedded credentials or a managed-denied host is refused with a stated reason.
**Mutation:** remove `ws` from the union → the project-config test goes red.

---

## 4. Task 4 — category strings

**Commit:** `docs(audit): what the MCP surface work leaves open`

Unwrapped, unbolded, backtick-terminated, no inline backticks in the reason,
under 400 characters. At minimum `headersHelper` on `ws` if you parsed but did
not implement it.

### 4a. What this plan leaves

Four strings, each measured against the code as committed. Two are fields these
tasks read and report rather than honour, because implementing either would
build a mechanism no transport has. One is a transport that now works from
`.mcp.json` and still cannot arrive through a plugin, blocked by a single line
in another executor's zone. One is a settings input the pool has no layer to
read for itself.

- documented, not implemented — mcp.md:147 lists headersHelper among the fields a ws entry accepts, and mcp.md:759 documents it for http and sse as well. Nessy has no dynamic header generator for any transport: the project-config reader parses the field, warns that it was ignored, and connects with the static headers only: `headersHelper`
- documented, not implemented — mcp.md:147 says a ws entry accepts headers and mcp.md:147 adds that authentication is header-only. The vendored SDK WebSocket transport takes a URL and nothing else, so a ws server's headers are parsed, carried on the config and named in a pool warning, but never sent: `ws headers`
- documented, not implemented — mcp.md:322 lists WebSocket among a plugin's supported MCP transports. The project config now carries ws end to end, but plugin import still refuses it with a named diagnostic, because PluginMcpDescriptor cannot admit the value until the remote arm of SdkMcpServerConfigWithoutSecrets does, and that type lives in another executor's zone: `plugin ws`
- documented, not implemented — settings.md gives sandbox.network deniedDomains and allowManagedDomainsOnly, and the ws MCP guard consults both. The pool has no settings layer, so the values arrive only if its owner passes them, and no owner does yet; the literal-address and resolved-address clauses apply regardless: `ws denied domains`

## 5. Gate

Focused suites per changed file; the `shared/src/mcp`, auth, plugins and
renderer aggregates once on the final diff; `bun run typecheck:all` **exit 0
with zero `error TS`, stated explicitly**; `bun run lint`; i18n parity + sorted
(Task 1 adds strings); `git diff --check`.

Auth and network egress are named risk triggers — run the expanded set once on
the final diff, not after every edit.

Known-failing rows: `docs/superpowers/specs/2026-07-29-known-failing-tests.md`.

## 6. Constraints

- You own `packages/shared/src/mcp/**`, `packages/shared/src/auth/oauth.ts`,
  `packages/shared/src/agent/backend/types.ts`,
  `packages/shared/src/plugins/format-adapters/claude.ts`,
  `packages/shared/src/config/network-address-guard.ts`, and the renderer's
  elicitation/permission card components plus their playground entries.
- **TWO SIBLING EXECUTORS run concurrently.** One owns `pi-agent.ts`,
  `mode-manager.ts`, `agent/core/pre-tool-use.ts`, `permission-dsl.ts`,
  `pi-harness/**`, `SessionManager.ts`, `runtime-agent-definition.ts`. Another
  owns `capabilities/**`, `base-agent.ts`, `pi-agent-server/src/**`,
  `apps/electron/src/main/index.ts`, `config/sandbox-settings.ts`. **Stay out of
  both.** If a fix needs one of their files, land the rest and report the
  residual word for word.
- One commit per task, subjects exactly as given. **No `Co-Authored-By`.** No
  push/MR/tags/reset/rebase/`--amend`/`checkout --`/stash of edited files.
  Restore mutation probes by re-edit or an `.orig` copy, **never git**.
- Do not touch `docs/superpowers/specs/` or `docs/testing/cdp-live-checklist.md`,
  nor `~/.nessy-agent/skills/r17-*` or `~/.nessy-agent/mcp/elicit-server.mjs`
  (live CDP fixtures). No version bumps or release notes. Never write
  `~/.nessy/dp_auth_creds.json`.
- **Never point a probe at a real external host** — loopback fixtures only, and
  never a real OAuth provider.
- Code, comments and commits in English.

## 7. Report

Commit shas; the doc lines quoted whole; the deceptive-URL rule set and why each
rule is explainable to a user; what happens when `oauth.scopes` and the server
disagree; whether the network guard was already reached on the `ws` path;
residuals word for word; corrections to this plan; mutation probes with which
side went red; the explicit typecheck statement.
