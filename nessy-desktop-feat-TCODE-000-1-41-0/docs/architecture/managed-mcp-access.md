# Organization control over MCP servers

Claude Code's contract is `managed-mcp.md`. **The 34 bare `` `:NNN` `` line
continuations this page used to cite are gone as of 2026-08-29 (`P3.68`/`P2.285`),
replaced by that page's own section anchors** — a section anchor is part of the
published link contract; a line number has a measured half-life of about two days,
and a bare continuation is additionally invisible to `scripts/check-doc-anchors.ts`
and to any page-qualified grep, which is how these survived the pass that converted
this file's `settings.md` anchors.

Every replacement anchor was read off the RENDERED page (`curl` the URL WITHOUT
`.md`, grep `id="…"`), not derived from a slug rule: 14 of 14 live, with
`#exclusive-control-with-managed-mcp-json` live and the dot-dropped
`#exclusive-control-with-managed-mcpjson` absent — the hyphenate-the-dots rule
proved in place rather than restated — and a negative control (`#not-a-section-control`)
absent on the same fetch. `managed-mcp.md` is not in `scripts/claude-doc-anchors.tsv`'s
2026-08-25 snapshot, so the guard now reports these as `page-not-snapshotted`. That
is the conversion working: the citations were unverifiable-and-silent before and are
unverified-and-loud now. A `--refresh` was deliberately NOT run, because it re-fetches
every corpus-cited page in the tree and would sweep other lanes' pending findings
green without anyone measuring them.

Nessy's engine is `allowedMcpServers`/`deniedMcpServers` on the managed Pi policy
(`packages/shared/src/agent/pi-harness/managed-policy.ts`). The entry schema and
the matcher live beside it in `managed-mcp-entries.ts`; the gate is
`isManagedMcpServerAllowed`, and it runs in the capability-input filter
(`packages/server-core/src/bootstrap/storage-runtime.ts`) before any denied
server is materialized.

**MCP is not the only thing managed policy controls, and a reader who assumes it
is will miss a delivered surface.** Managed policy also DELIVERS a plugin
marketplace (`packages/shared/src/agent/pi-harness/managed-marketplace-entries.ts`),
so an admin can put an install source in front of users, not merely allow or deny
servers they add themselves. The plugin-side keys — `allowedPluginKeys`,
`deniedPluginKeys`, `enabledPlugins`, `allowPluginHooks`,
`allowManagedHooksOnly`, `disableAllHooks` — live on the same
`ManagedPiPolicyV1` object and are applied at the same `storage-runtime.ts`
capability-candidate filter, so an admin's plugin containment and their MCP
containment share one seam and one set of failure modes.

## What we implement

| Surface | Category | Where |
| :-- | :-- | :-- |
| The entry object (`serverUrl`/`serverCommand`/`serverName`, one key each), `managed-mcp.md#match-servers-by-url-command-or-name` | `documented, implemented` | `managed-mcp-entries.ts` |
| A bare string read as `{ serverName }` | Nessy extension — our deployed shape | `parseManagedMcpEntry` |
| Per-list `serverName` validation, `managed-mcp.md#match-servers-by-url-command-or-name` | `documented, implemented` — allowlist charset is the documented set plus `.`, see below | `validateServerName` |
| Unset vs `[]` vs populated, `managed-mcp.md#match-servers-by-url-command-or-name` | `documented, implemented` | `evaluateManagedMcpServer` |
| Denylist first, "Nothing overrides a denylist match", `managed-mcp.md#how-a-server-is-evaluated` | `documented, implemented` | `evaluateManagedMcpServer` |
| Type-dependent allowlist, `managed-mcp.md#how-a-server-is-evaluated` | `documented, implemented` | `evaluateManagedMcpServer` |
| Exact argv command match, `managed-mcp.md#how-a-server-is-evaluated` | `documented, implemented` | `matchesCommandPattern` |
| URL `*` wildcards, host case-insensitivity, trailing FQDN dot, case-sensitive paths, `managed-mcp.md#how-a-server-is-evaluated` | `documented, implemented` | `matchesManagedMcpUrlPattern` |
| `${VAR}`/`${VAR:-default}` expansion on both sides, `managed-mcp.md#how-a-server-is-evaluated` | `documented, implemented` | reuses `mcp/server-config-values.ts` |
| The two expansion fail-directions — an allowlist URL entry ignored, a denylist URL entry still matching, `managed-mcp.md#how-policy-entries-expand` | `documented, implemented` (P2.375) | `urlEntryScopeIsVariableDetermined` + `matchesManagedMcpEntry`'s `list` pole; the PINNED environment of the same section is still divergent, see below |
| `strictPluginOnlyCustomization` with `mcp` in the list, `managed-mcp.md#choose-a-pattern` (canonically `settings-reference.md#strictpluginonlycustomization`) | `documented, implemented` | `managed-policy.ts` parses the key; the origin lock runs in `buildCapabilityResolutionInputsV2`'s discovered-record filter |

The allowlist `serverName` charset is the one place we are WIDER than the page.
`managed-mcp.md#match-servers-by-url-command-or-name` limits it to "letters, numbers, hyphens, and underscores"; we additionally
accept `.`, because that is the charset our deployed `allowedMcpServers` has
always used and this list is a grant — narrowing the validator would strip an
existing `{"serverName":"my.server"}` and stop that server loading fleet-wide, to
satisfy a restriction the page gives no reason for. We also keep our
leading-alphanumeric rule, so a name beginning with `-` is still refused.

## The `${VAR}` bypass

**This section's premise moved upstream, measured 2026-08-29.** It used to quote a
`settings.md`-era line as "Because `${VAR}` expansion reads Claude Code's own
process environment, a `serverCommand` or `serverUrl` policy entry that references
a variable expands to whatever value a user sets. Use literal URLs and commands
for entries you rely on for enforcement." That sentence is on no page today, and
neither is the fragment "reads Claude Code's own process environment" (positive
control on the same fetch: "Nothing overrides a denylist match" and "letters,
numbers, hyphens, and underscores" both live on `managed-mcp.md`). The bypass was
not merely reworded — it was **narrowed**, and the page says so by version.

`managed-mcp.md#how-policy-entries-expand`, which closes with "Requires Claude Code
v2.1.219 or later": "The server's configured value expands from the live process
environment, like the rest of `.mcp.json`. A policy entry expands from a pinned
environment instead, so a variable set by a project or user settings file can't
change what an allowlist entry means. Because a policy entry still depends on the
launching shell's value for any variable it references, use literal URLs and
commands for entries you rely on for enforcement." Its table adds two asymmetries:
an `allowedMcpServers` entry whose expansion "would change a URL entry's scheme,
host, or path scope" is IGNORED, while the same expansion on a `deniedMcpServers`
entry means "the entry still matches", and a denylist variable with no startup
value and no `:-default` may fill from settings files outside the repository,
"which only ever widens what the entry matches".

### The two fail-directions: implemented (P2.375)

`documented, implemented` — `matchesManagedMcpEntry`, via
`urlEntryScopeIsVariableDetermined`. Both cells of that table's third column,
landed together, because the asymmetry IS the mechanism and half of it reads as
done to everyone who comes after.

The shared predicate answers the column's own question — "Expansion that would
change a URL entry's scheme, host, or path scope" — by comparing the entry AS
WRITTEN against the entry AS EXPANDED through the same `splitUrl` /
`normalizeAuthority` decomposition the matcher uses. Then:

| List | Cell | What we do |
| :-- | :-- | :-- |
| `allowedMcpServers` | "Claude Code ignores the entry" | The entry admits nothing, so no value of the variable can widen the grant |
| `deniedMcpServers` | "The entry still matches" | The span the VARIABLE owns is neutralized to `*`; every literal character the administrator typed still has to match |

Three decisions inside that the page does not make for us, recorded here rather
than left to be re-derived:

- **A literal entry can never trip the predicate.** That is what keeps this
  guard off every policy already deployed, and it is the same resolution the
  page prescribes: "use literal URLs and commands for entries you rely on for
  enforcement."
- **An UNRESOLVABLE reference is not exempt.** `expandConfigVariables` leaves
  `${VAR}` literal when nothing supplies it, so as-written and as-expanded are
  then identical and a pure text comparison would call it unchanged. Exempting
  it would make UNSETTING the variable the cheapest escape of all — cheaper than
  steering it — and would invert the guard on the deny side.
- **An ignored allow entry is ignored as a MATCH, not removed from the list.**
  `managed-mcp.md#how-a-server-is-evaluated` lets a `serverName` entry stand in
  only "when the allowlist contains no `serverUrl` entries", so dropping the
  ignored entry from that count would admit through the name what the URL entry
  was guarding — a variable widening the allowlist by the other door.

### What is still divergent here

- **The pinned environment.** `documented, DIVERGENT.` We still expand both
  sides through `mcp/server-config-values.ts`, i.e. the LIVE process
  environment, which is what the pinned-environment rule forbids for the policy
  side. Closing it needs "the environment Claude Code started with, plus `env`
  values from managed settings" captured at startup and threaded to the gate,
  and every call site is in `packages/server-core/src/bootstrap/storage-runtime.ts`
  — outside the matcher, and outside P2.375. The two fail-directions above do
  not depend on it: they are guards on WHAT the expansion did, not on WHICH
  environment supplied it, so they hold under either.
- **`serverCommand` entries.** `documented, implemented` — and it moved out of
  this list on 2026-09-03 (P2.397), because the measurement says our behaviour
  is PARITY with the vendor rather than a gap. A `${VAR}` argv entry still
  expands and matches with no guard, deliberately. Both sources were read:

  - **The page is silent.** `managed-mcp.md#how-policy-entries-expand`'s third
    column still reads "Expansion that would change a URL entry's scheme, host,
    or path scope", with no command-side column and no command-side row.
  - **The bundle is silent, structurally.** In the shipped `claude` binary
    (`claudeCodeVersion 2.1.247` — AHEAD of the section's "Requires Claude Code
    v2.1.219 or later", so this is not the bundle lagging the page) the URL
    expander returns an `unsafeExpansion` verdict and the allowlist loop skips
    an entry on it; the COMMAND expander returns `{ expanded, missingVars }`
    and no such verdict exists for an argv. The allowlist's command branch
    reports its telemetry pair with that flag hard-coded false. A missing
    variable is logged on both sides and changes no verdict on either.

  So there is no argv analogue to implement, and adding one would make our
  allowlist NARROWER than the vendor's on a policy the vendor accepts. The
  verdict is recorded at `urlEntryScopeIsVariableDetermined` and pinned by
  `managed-mcp-entries.test.ts`'s *"P2.397 — the guard is URL-ONLY"*.
- **Telling the administrator.** A `${VAR}` policy entry is still accepted
  silently; nothing says the guard fired. A warning would need a "retained with
  a caveat" disposition on `ManagedPolicyDropV1`, whose existing three values
  all mean the entry was not applied, and whose summary heading says so — that
  is a separate unit, and it is now more worth having, since the deny widening
  is something an administrator should be able to see.

## Invalid entries, and why the denylist is different

`managed-settings.md#keys-that-fail-closed`'s `allowedMcpServers` and
`deniedMcpServers` rows react to the same defect in opposite directions, and the
denylist is the sharp one: stripping an allowlist entry NARROWS, stripping a
denylist entry UN-BLOCKS a server the administrator wrote down.

| Defect | `allowedMcpServers` | `deniedMcpServers` |
| :-- | :-- | :-- |
| Whole value invalid | enforced as `[]`, admits nothing | field dropped, blocks nothing ("A wholly invalid value is dropped with a warning, since denying every server would block servers the policy never named") |
| One entry with nothing usable in it | stripped | stripped, and the drop reason says the server is NOT blocked |
| One entry with two recognised keys, or a good key beside a typo | stripped | every valid key it carries is enforced as its own deny, recorded `tightened` |

That last row is the deliberate decision this unit exists to make. Every key an
entry carries names a server the administrator wrote by hand, so honouring all of
them blocks nothing "the policy never named" — the exact bound the
`deniedMcpServers` row sets — while stripping the entry would restore the
fail-open. The two alternatives are both ruled out by the page: reading a broken
deny as "block everything", and refusing the document, which
`managed-settings.md#find-entries-claude-code-dropped` forbids — Claude Code
"first skips the individual entries it can repair, such as one invalid permission
rule, with a warning for each, then drops any top-level key whose value still
fails and keeps enforcing every remaining valid key". (That sentence replaced the
one this page quoted as `settings.md:186`, "A single typo cannot disable the rest
of your organization's policy", which occurs on no page today. The rule survives;
the sentence did not.)

Every one of those outcomes is a drop, and `nessy-general-agent doctor` lists it
with its source and field — the same section's "`claude doctor` lists each
invalid entry with its source and field".

## What we do not implement

| Surface | Category | Why |
| :-- | :-- | :-- |
| `managed-mcp.json` fixed deployment, `managed-mcp.md#exclusive-control-with-managed-mcp-json` | `documented, not implemented — a separate deployment channel` | A file that DEPLOYS a fixed server set and takes exclusive control, not a filter over what a user configured. It needs the system-path reader, the exclusive-control mode that suppresses plugin servers, and the `claude mcp add` refusal. The same section also puts it outside server-managed settings, so it cannot ride our existing delivery. None of that is matching, which is what this unit is about. |
| Disable MCP entirely (`managed-mcp.json` with `{}`), `managed-mcp.md#disable-mcp-entirely` | `documented, not implemented — falls out of the row above` | It is one value of that file, not an independent switch. `deniedMcpServers` cannot express it: `managed-mcp.md#match-servers-by-url-command-or-name` makes a populated denylist block only what it matches, and there is no "deny all" entry. |
| claude.ai connectors, `allowAllClaudeAiMcps` (`managed-mcp.md#allow-claude-ai-connectors-alongside-the-managed-set`), `disableClaudeAiConnectors` (`mcp.md#disable-claude-ai-connectors`) | `inapplicable` | We have no claude.ai account-side MCP connectors. Nessy's "connector Sources" are materialized from PLUGIN manifests, are governed by `allowedPluginKeys`/`deniedPluginKeys` plus the MCP lists, and have no claude.ai origin to suppress. `managed-composition.ts` already records `allowAllClaudeAiMcps` as having no counterpart in our schema. The `deniedMcpServers` display-name form of `managed-mcp.md#match-servers-by-url-command-or-name` is still implemented, because it costs nothing and a future connector surface would want it. |
| `allowManagedMcpServersOnly`, `managed-mcp.md#policy-based-control-with-allowlists-and-denylists` and `managed-mcp.md#restrict-the-allowlist-to-managed-settings-only` | `inapplicable — one tier carries these keys` | The key exists to stop a USER allowlist from broadening a managed one. Nessy has no user, project or local settings surface that carries `allowedMcpServers` or `deniedMcpServers` at all: they exist only on the managed Pi policy, so the lock's `true` state is already our permanent state. Its companion clause — "the denylist always merges from every source" — is about the tiers below the managed one; within the managed tier `managed-settings.md#how-claude-code-combines-managed-sources` is explicit that under the default `"first-wins"` Claude Code "uses the highest-ranked source that delivers at least one policy key and ignores the rest rather than merging them", which is what `composeManagedPolicySources` does for our delivered and file sources. (Cited as `settings.md:663` until 2026-08-28: `settings.md` SPLIT, and the successor sentence is no longer absolute — it carries an exception for the cross-source keys, and `managedSourcesBehavior: "merge"` opts out wholesale. Neither reaches the MCP lists, so the conclusion is unchanged.) Adding the key would declare a lock that enforces nothing. |
| `--mcp-config` / `--strict-mcp-config` filtering, `managed-mcp.md#exclusive-control-with-managed-mcp-json` | `documented, not implemented — the channel exists and we leave it open` | **Corrected 2026-09-07 (P6.528); this row said `inapplicable` and "we have no such CLI flags; there is no additional configuration file channel for the lists to filter", and the code contradicted it.** The SDK exposes the flag as `Options.strictMcpConfig`, whose own typing says what it does verbatim: *"Only use MCP servers passed via the `mcpServers` option (and servers declared by explicitly-passed agent definitions in `agents`), ignoring all other MCP configurations: project `.mcp.json`, user settings, plugins, and on-disk agent frontmatter — including subagent frontmatter MCP."* We leave it UNSET, so on the Claude runtime the CLI runs that whole discovery beside the servers we hand it, and `onElicitation` is wired at the spawn precisely because anything it finds that way is a real server. That is a per-runtime configuration channel Pi and codex do not have, and the lists in this document do not filter it. Delegated decision 2026-09-05 (Q-den 65) chose to REPORT rather than to lock: a claude session now names every server in the init message's `mcp_servers` that our own `mcpServers` option did not supply (`claudeCliDiscoveredMcpNotice`, `claude-agent.ts`). Setting `strictMcpConfig: true` would stop a user's own `.mcp.json` working on one runtime only and make the elicitation wiring dead code; the report is that decision's precondition, because the cost cannot be judged until the discovered set is visible. |
| The `claude mcp add` refusals, `managed-mcp.md#how-restrictions-appear-to-users` | `documented, not implemented — enforcement is at load, feedback is not` | A denied server is filtered out of the capability inputs, so it never runs; but `sources.CREATE` (`packages/server-core/src/handlers/rpc/sources.ts`) does not consult the policy, so a user can still CREATE an MCP Source the policy denies and gets no error. That section's silent-disappearance row is what they see instead. This is a feedback gap, not a boundary gap, and closing it needs a new refusal path plus i18n strings. |
| `OTEL_LOG_TOOL_DETAILS` MCP usage monitoring, `managed-mcp.md#monitor-mcp-usage` | `documented, not implemented` | Belongs to the telemetry surface (`packages/server-core/src/pi-harness/otlp-telemetry.ts`), not to access control. |

## The provider guard, and what it leaves open

This applies to the identity LISTS. `strictPluginOnlyCustomization`'s `mcp`
surface is deliberately outside it: the origin lock sits ahead of the
`provider === 'pi'` early return in the same filter, so it holds on a Claude or
Codex turn too. An origin lock that lapsed per provider would be the same
"declared on one path, enforced on another" defect this document keeps naming.

The gate runs only when `context.provider === 'pi'`
(`buildCapabilityResolutionInputsV2`). Pi is the shipped default runtime — the
Claude and Codex providers are off unless a build enables them — so the guard
covers every shipped agent turn, and the Claude backend has its own managed
settings channel.

Neither the lists nor the origin lock covers the workspace BROWSE pool.
`WorkspaceMcpPoolRegistry.buildResolveContext` "deliberately omit[s] the internal
provider discriminator: browse is provider-neutral", and that pool connects the
servers it resolves. So a server on the managed denylist is still contacted, and
its tools listed, when the Sources UI warms the pool. The agent cannot call it —
a Pi turn resolves its own filtered snapshot — but the connection itself is
something the administrator denied. Recorded here rather than changed, because
the provider-neutral snapshot identity is pinned by its own contract test and
widening the guard is a decision about that contract, not about this schema.

## Organisation-delivered servers — `managedMcpServers` (F1.593, 2026-09-24)

The ADDITIVE half of organisation-provided MCP servers, owner answer C4.4 (QB2 =
C) once the bundle passed the key's v2.1.259 floor.
`settings-reference.md#managedmcpservers`: *"Provide remote MCP servers to every
user from managed settings. Users keep the servers they add themselves and can't
edit or remove the ones you provide."* Exclusive control (`managed-mcp.json`,
the first row of the table above) stays refused by its own ruling.

An administrator writes it in `managed-policy.json` as a map from server name to
the `.mcp.json` remote shape:

```json
{ "schemaVersion": 1,
  "managedMcpServers": { "corp-docs": { "type": "http", "url": "https://mcp.corp.example/docs" } } }
```

- Only `http` and `sse` entries are carried, with an http(s) `url` and optional
  string `headers`; nothing that names a program, no `${VAR}` reference, and a
  name the pool can key (`[A-Za-z0-9_-]`, at most 64). Anything else is a named
  drop, one entry at a time, listed by `doctor`.
- A drop-in fragment that names a server replaces that server whole.
- `deniedMcpServers` still applies to them; an `allowedMcpServers` list does not
  have to name them.
- A user server under the same name is displaced — the organisation's entry wins
  the name.

**All three runtimes receive them from the HOST pool**
(`foldManagedOrgMcpServers`, `packages/shared/src/mcp/runtime-pool-servers.ts`),
the same way they receive any pool server. The decided design projected the key
into claude's own managed settings instead, and that was measured before it was
built: on the vendored 2.1.267, a server handed over `Options.managedSettings`
(the SDK parent tier, the only managed channel an embedding application has)
received no connection at all, while the same server handed over
`Options.mcpServers` connected — the parent tier is filtered restrictive-only,
and an additive key does not survive the filter. So there is no per-runtime
difference to report at a switch.

What the key cannot carry, stated rather than discovered: the servers have no
row in the Sources list and no credential slot, so static `headers` are the only
authentication they can use.
