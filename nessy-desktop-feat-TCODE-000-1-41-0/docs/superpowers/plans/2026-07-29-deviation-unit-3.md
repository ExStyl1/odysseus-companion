# Deviation Unit 3 — MCP configuration fidelity (P5)

**Status:** closed
**Source:** `docs/superpowers/specs/2026-07-29-deviation-worklist.md` § 3, Unit 3
**Branch:** `fix/renderer`
**Base:** `cf9f6b97`

Four P5 rows: how an MCP server's configuration is expanded, how its
availability is decided, which of its documented fields survive import, and what
happens when the same server is defined twice. One commit per row.
`resolver.ts` is touched by rows 2 and 4, which is why they stayed in one unit.

## Contract source — re-fetched raw, every cite verified against the fetched file

```
curl -sL https://code.claude.com/docs/en/mcp.md                 # 1282 lines
curl -sL https://code.claude.com/docs/en/plugins-reference.md   # 1303 lines
```

`mcp.md:449`–`:450` — the two supported forms:

> * `${VAR}`: expands to the value of environment variable `VAR`
> * `${VAR:-default}`: expands to `VAR` if set, otherwise uses `default`

`mcp.md:453`–`:457` — expansion locations: `command`, `args`, `env`, `url`,
`headers`.

`mcp.md:477` — the whole of row 1, verbatim:

> If a referenced environment variable isn't set and has no default value, the
> config still loads: Claude Code reports a missing-variable warning for that
> server in `claude mcp list` output and uses the unexpanded `${VAR}` text
> as-is. Set the variable or add a `:-default` fallback so the server starts
> with the value you intend.

`mcp.md:321` — plugin servers are not a separate expansion regime:

> **User environment access**: access to the same environment variables as
> manually configured servers

`mcp.md:238` — the per-server timeout:

> Set a per-server tool execution timeout by adding a `timeout` field in
> milliseconds to that server's `.mcp.json` entry, for example
> `"timeout": 600000` for ten minutes. This overrides the `MCP_TOOL_TIMEOUT`
> environment variable for that server only

`mcp.md:243` — the floor: "Values below 1000 are ignored and fall through to
`MCP_TOOL_TIMEOUT`". `mcp.md:245` — a per-server timeout of at least 1000 also
floors the idle timeout.

`plugins/manifest-reference.md#mcpservers` (was lines 162-164 of the retired plugins-reference page) — a plugin's MCP config is that same file:

> **Location**: `.mcp.json` in plugin root, or inline in plugin.json
>
> **Format**: Standard MCP server configuration

`mcp.md:431` — the whole of row 4, verbatim:

> When the same server is defined in more than one place, Claude Code connects
> to it once, using the definition from the highest-precedence source. The
> entire server entry from that source is used; fields are not merged across
> scopes.

`mcp.md:433`–`:437` — the order: Local, Project, User, plugin-provided servers,
claude.ai connectors. `mcp.md:439` — how duplicates are matched:

> The three scopes match duplicates by name. Plugins and connectors match by
> endpoint, so one that points at the same URL or command as a server above is
> treated as a duplicate.

`mcp.md:343` — why a plugin never contends for a scoped server's name:

> The server itself registers under the scoped name
> `plugin:<plugin-name>:<server-name>`

## The four rows, in commit order

| # | Row | Commit |
| - | --- | ------ |
| 1 | P5 — unset `${VAR}` expands to `''` in the plugin branch | `5b511846` |
| 2 | P5 — `resolver.ts` stale `${VAR}`-only regex | `e9073dd8` |
| 3 | P5 — per-server MCP `timeout` dropped by the Claude adapter | `4a5de555` |
| 4 | P5 — duplicate MCP source across scopes connects twice | `8e27f1a2` |

Rows 1 and 2 are one mechanism split across two commits: row 1 changes what the
runtime produces and why the availability gate can no longer be fooled by the
literal token; row 2 makes the precompute call that same code instead of its own
copy. Row 3 landed before row 4 because its `canPromoteToOAuth` side effect had
to be settled while the timeout change was still the only thing in the diff.

## Pre-change reproduction

All four rows were reproduced on `cf9f6b97` before any edit.

```
PROBE-A empty-mode:      {"value":"Bearer ","missing":["TOKEN"]}    # .missing discarded
PROBE-A literal-mode:    {"value":"Bearer ${TOKEN}","missing":["TOKEN"]}
PROBE-B precompute:      "${TOKEN:-}"  available=true
PROBE-B runtime:         ""            available=false
PROBE-C capabilities:    [{serverName:"slow", transport:"http", url:…},
                          {serverName:"tiny", transport:"http", url:…}]
PROBE-C deferred:        []
```

Row 4 was already pinned green by `resolver.test.ts:246` (`toHaveLength(2)` with
both entries qualified and both runnable).

## Direction proofs the unit was required to produce

**Row 1 must not let the literal token satisfy a requirement.** The empty
substitution was not an oversight — the code said so in a comment — because
`materializePluginMcpEnvironment` decided availability with
`!environment[name]?.trim()` over the RESOLVED environment, and `${VAR}` is not
blank. Proven by removing the new half and re-running:

```
$ # with `.filter(name => !environment[name]?.trim())` — the old gate
(fail) still withholds a server whose required variable only resolves to a
       literal token
 38 pass, 1 fail
$ # with the unresolved-key half restored
 39 pass, 0 fail
```

**Row 1 must not weaken the two isolation properties its tests guard.** Both
pinning tests were rewritten, and both still prove what they were written for:

- an undeclared host secret (`NESSY_TEST_PLUGIN_UNDECLARED_SECRET=must-not-leak`)
  is not in the reviewed environment, so it cannot resolve; the header is now
  `${NESSY_TEST_PLUGIN_UNDECLARED_SECRET}` instead of `''`, and
  `expect(JSON.stringify(out.mergedMcpServers)).not.toContain('must-not-leak')`
  still holds;
- DP withholds both the forwarded host alias and the credential, so argv carries
  `--host=${SAFE}` instead of `--host=`, and both
  `not.toContain('host-secret')` / `not.toContain('credential-secret')` still
  hold.

The literal token carries no value, and a plugin server's argv is passed as
argv with `inheritProcessEnv: false` — it is not shell-expanded, and a name that
resolves to a literal is by definition absent from the child's environment too,
so there is no new re-expansion path.

**Row 2 must fail against the old pattern.** Proven by temporarily reinstating
the stale regex and the old base-environment order:

```
(fail) precomputes availability over the same expansion the runtime materializes
 43 pass, 1 fail
```

**Row 3's trust-hash impact was measured, not argued.** Same bundle normalized
before and after the change:

| Bundle | `executableHash` | normalized manifest hash |
| --- | --- | --- |
| no `timeout`, before | `8d9f4079…` | `d5a0ab8b…` |
| no `timeout`, after | `8d9f4079…` | `d5a0ab8b…` |
| `timeout: 600000`, before | `8d9f4079…` | `d5a0ab8b…` |
| `timeout: 600000`, after | `3dfcaa0c…` | `484ae9d2…` |

A bundle that declares no timeout is byte-identical and does not re-prompt. A
bundle that declares one moves both hashes and re-prompts once. That is
acceptable, and the third row of the table is the reason it is more than
acceptable: before this change the two bundles hashed the **same**, so a user's
stored consent described a capability whose runtime ceiling was not the one the
bundle asked for. Blast radius is exactly Claude-format bundles carrying a
`timeout` of at least 1000 ms.

**Row 3 must not turn a benign field into a refusal.** `canPromoteToOAuth`
listed `toolTimeoutMs === undefined` among the reasons a remote MCP capability
could not become a connector. Harmless while no Claude bundle could set it;
proven harmful the moment one can:

```
$ # with `&& descriptor.toolTimeoutMs === undefined` restored
(fail) promotes a catalog-authenticated remote MCP carrying a tool timeout,
       keeping the ceiling
 46 pass, 1 fail
```

The list is really "fields the promoted connector cannot carry", so the fix was
to make the connector carry it rather than to ignore it:
`PluginConnectorMcpServerDescriptor.toolTimeoutMs` → `McpSourceConfig.timeoutMs`
→ `SdkMcpServerConfig.toolTimeoutMs` (already wired in `server-builder.ts`).
It is deliberately kept out of the `descriptor` object the connector executable
hash is taken over — that hash pins transport and auth authority, and every
bundle change already moves it through `installed.bundleHash`.

**Row 4 must not suppress a plugin server.** `mcp.md:439` matches plugin
duplicates by endpoint, not by name, and `mcp.md:343` gives plugin servers their
own `plugin:<plugin-name>:<server-name>` namespace, so a plugin can neither take
a scoped server's name nor be displaced by one. The scope-precedence winner is
chosen among `origin !== 'plugin'` entries only; a plugin sharing the bucket
keeps a qualified wire name and stays runnable, which is our equivalent of that
namespace. Pinned by the new test "does not shadow a plugin MCP that shares a
scoped server's name".

Source-transport MCP is inside the precedence rule, not outside it: it
participates in the same one wire namespace by construction (`resolver.ts`
`applyCollisionPolicy`, the `sourceType === 'mcp'` branch), so exempting it
would have left the double-connect alive through the Source half.

## Gate evidence

Run from the repo root.

```
$ bun test packages/shared/src/mcp/__tests__/ \
           packages/shared/src/capabilities/__tests__/ \
           packages/shared/src/plugins/__tests__/
 888 pass, 1 skip, 0 fail, 3621 expect() calls, 57 files

$ bun test packages/shared/src/sources/__tests__/ packages/shared/tests/mcp-pool.test.ts
 200 pass, 0 fail, 419 expect() calls, 15 files
```

Whole-package sweep on the final diff (this unit changes a shared configuration
surface and a trust hash, both risk triggers). Run in a detached worktree at
`8e27f1a2` so concurrent agents' uncommitted edits could not contaminate it, and
again at the baseline `cf9f6b97` to classify every failure:

```
$ bun test packages/shared                # worktree at 8e27f1a2
 5868 pass, 18 skip, 11 fail, 1 error, 6 snapshots, 16521 expect(), 423 files

$ bun test packages/shared                # worktree at cf9f6b97 (baseline)
 5831 pass, 18 skip, 11 fail, 1 error, 6 snapshots, 16411 expect(), 420 files
```

The failure set is identical at both commits, name for name:

```
config path default-root classification > treats an empty override as the default root   (x2)
ensureStorageLayoutV2 > initializes only absent and empty default roots, …
ensureStorageLayoutV2 > quarantines parseable unversioned default state …
ensureStorageLayoutV2 > quarantines v1 default state and blocks unsafe …
ensureStorageLayoutV2 > ignores retained quarantine siblings without a marker …
ensureStorageLayoutV2 > leaves every active collision path inert
ensureStorageLayoutV2 > requires the host lease and resumes only the strict …
ensureStorageLayoutV2 > maps injected Windows sharing failures to a blocked …
managed paths with NESSY_CONFIG_DIR > classifies only an unset override …
```

Nine of those are the known pre-existing set. The eleventh entry in bun's tally
is an unhandled module-init error, not on the known list, and it is **also
present at the baseline** — a circular-import TDZ:

```
# Unhandled error between tests
  packages/shared/src/agent/memory/memory-cleanup.ts:41
  ReferenceError: Cannot access 'AUTO_MEMORY_MARKER_REGEX_SOURCE' before initialization
  (surfaces while loading agent/__tests__/adjacent-backend-frozen-contract.test.ts)
```

`memory-cleanup.ts` last changed in `b0053399`, long before this series, and
nothing in this unit touches `agent/memory/`. Reported, not chased.

Typecheck could not be run in the working tree: concurrent agents' in-flight
edits to `config/storage.ts`, `config/managed-drops.ts` and
`automations/hook-task-registry.ts` break it. Run instead in a detached
worktree at this unit's HEAD (`git worktree add --detach`, `node_modules`
symlinked), per package:

```
packages/core               OK
packages/shared             OK
packages/server-core        OK
packages/server             OK
packages/session-tools-core OK
packages/ui                 OK
packages/pi-agent-server    OK
apps/electron               0 errors excluding one dual-identity error in
                            src/main/__tests__/session-branch-rollback.isolated.ts,
                            caused by the symlinked node_modules resolving
                            @nessy-agent/server-core to the main checkout —
                            a worktree artifact, not a repo error.

$ bun run lint:shared        # same worktree
 0 errors, 4 warnings (all pre-existing unused eslint-disable directives in
 session-scoped-tools.ts, setupI18n.ts, debug.ts — none in a touched file)
```

## Deviations recorded

| Subject | Category |
| --- | --- |
| `${VAR}` / `${VAR:-default}` grammar (`mcp.md:449`–`:450`) | `documented, implemented` |
| Unset reference keeps the literal token and warns (`mcp.md:477`) | `documented, implemented` — now in both the `.mcp.json` reader and the plugin branch |
| Plugin servers share the manually-configured expansion regime (`mcp.md:321`) | `documented, implemented` |
| Missing-variable warning surface | `documented, impossible on Nessy — no `claude mcp list` equivalent; emitted on the same `debug` channel the `.mcp.json` reader already uses, which is where a Nessy operator reads MCP materialization` |
| Per-server `timeout` on a plugin `.mcp.json` (`mcp.md:238`; `plugins/manifest-reference.md#mcpservers` (was lines 162-164 of the retired plugins-reference page)) | `documented, implemented` |
| Sub-1000 `timeout` ignored (`mcp.md:243`) | `documented, implemented` — shared `mcpToolTimeoutMs` floor |
| Per-server timeout floors the idle timeout (`mcp.md:245`) | `documented, implemented` — pre-existing, `mcp-pool.ts:1851` |
| `MCP_TOOL_TIMEOUT` global fallback that the per-server value overrides (`mcp.md:238`, `:243`) | `documented, not implemented — Nessy has no global tool-timeout env var (only `NESSY_MCP_TOOL_IDLE_TIMEOUT`, which is the separate idle window), so there is nothing for a per-server value to override and nothing for a sub-floor value to fall through to; the sub-floor case simply leaves the server unbounded, matching an unset `MCP_TOOL_TIMEOUT`` |
| One connection per duplicated server name across scopes (`mcp.md:431`, `:439`) | `documented, implemented` |
| Precedence order Local > Project > User (`mcp.md:433`–`:435`) | `documented, implemented` — mapped onto our scope model as project > workspace > global > builtin via the existing `preference()` comparator, which the non-MCP branch of the same function already used |
| Plugin servers in their own namespace, never name-matched (`mcp.md:343`, `:439`) | `documented, implemented` — the qualified wire name is our spelling of `plugin:<plugin-name>:<server-name>` |
| Plugin/connector duplicates matched by ENDPOINT (`mcp.md:439`) | `documented, not implemented — see propagation; buckets are keyed by logical name only, so a plugin pointing at the same URL or command as a scoped server is not detected as a duplicate` |

## Worklist claims that were wrong

Every behavioural claim in the four rows reproduced exactly, including the
"measured" one (a real bundle with `"timeout":600000` emits a capability with no
`toolTimeoutMs` and `deferred: []`) and the `${TOKEN:-}` probe. Four **line
cites** are off against the audit's own baseline `cf9f6b97`:

1. **`resolver.ts:1104-1114` for the "stale `${VAR}`-only regex" — materially
   wrong.** The regex is at `:1123`, inside `resolveEnvironmentAvailabilityRecord`
   at `:1116-1127`. The cited range is the *caller* — the merge-and-filter block
   at `:1099-1113`. Worth noting that the range is not empty of bug: it holds a
   second half of the same divergence the row describes, since the precompute
   resolved `environmentDefaults` against the configured-credential layer and
   the runtime did not. Both are fixed.

2. **`resolver.ts:1597-1614` for "qualifies every entry" — wrong by ten lines at
   the head.** The `byMcp` loop is `:1607-1626`; the qualification is
   `:1616-1619`. `:1597-1605` is the tail of the *non*-MCP loop, which correctly
   picks one winner — the opposite of what the row is describing.

3. **`runtime-pool-servers.ts:249,265` for the two plugin debug lines** —
   actually `:252` and `:267`.

4. **`project-config.ts:52,57`** — actually `:51` and `:56`. The third cite in
   that row, `:111-113`, is right (the warning is at `:112`).

Correct as written: `runtime-pool-servers.ts:745-749` (the `'empty'` call is at
`:748`), `server-config-values.ts:27`, `claude.ts:615-638` (push at `:615`,
`alwaysLoad` at `:638`), `codex.ts:1024`, `management-service-v2.ts:737-745`,
`resolver.test.ts:245-249` (the `toHaveLength(2)` is at `:246`), and
`runtime-pool-servers.ts:190-215`.

## Propagation found, not fixed

- **Plugin and connector duplicates are still matched by name, not endpoint.**
  `mcp.md:439` says a plugin "that points at the same URL or command as a server
  above is treated as a duplicate". `applyCollisionPolicy` buckets on
  `(kind, logicalName)` only, so a plugin server named `github` pointing at the
  same URL as a project-scoped `gh` is not detected, and both connect. Row 4
  deliberately did not widen the bucket key: doing so needs an endpoint identity
  for stdio (`command` + `args`? post- or pre-qualification?) that is a design
  decision, not a wiring fix. This is the remaining half of `mcp.md:439`.

- **`unavailableReason` has no label for the new reason.**
  `apps/electron/src/renderer/pages/plugin-components-groups.ts:46-49` maps only
  `capability-disabled` and `unsupported-runtime` to i18n keys; everything else
  renders unlabelled. `CapabilityDetailTemplate.tsx:123` renders the raw string
  as a description. `shadowed-by-mcp-precedence` therefore surfaces raw in
  capability detail. The plugin-components path cannot reach it (plugin MCP is
  exempt from shadowing), and the same rawness already applies to
  `source-disabled`, `session-not-selected`, `environment-missing` and
  `credential-missing`, so this is a pre-existing gap that the new reason joins
  rather than one it creates. It belongs to whatever unit owns capability
  presentation strings.

- **`mcpb.ts` has no equivalent drop.** The `.mcpb` adapter builds one stdio
  server from `server.mcp_config`, not from a `.mcp.json` entry, so there is no
  `timeout` field for it to lose. Checked while sweeping row 3; nothing to do.

- **No global MCP tool-timeout variable.** `mcp.md:238` describes the per-server
  `timeout` as overriding `MCP_TOOL_TIMEOUT`, and `:243` sends sub-1000 values
  "through to `MCP_TOOL_TIMEOUT`, or to its default of about 28 hours when that
  variable is unset". Nessy has no such variable — `NESSY_MCP_TOOL_IDLE_TIMEOUT`
  (`mcp-pool.ts:231`) is the separate idle window from `mcp.md:249`. In practice
  the behaviours coincide (no ceiling ≈ the 28-hour default), so this is a
  configuration surface gap, not a behavioural one. Recorded in the table above.

- **`AUTO_MEMORY_MARKER_REGEX_SOURCE` TDZ.** See the gate section — a
  pre-existing circular import between `agent/memory/memory-cleanup.ts` and
  whatever exports that constant, surfacing as an unhandled error during the
  shared sweep at both this unit's HEAD and its baseline. Unrelated to MCP;
  worth a row of its own.
