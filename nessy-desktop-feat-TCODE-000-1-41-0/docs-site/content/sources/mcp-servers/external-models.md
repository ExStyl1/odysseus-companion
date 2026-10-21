# External models and your MCP tools

Some connections point at a model that answers from outside Nessy Gateway — a BYO endpoint at
a model vendor, or a model whose id names a vendor namespace such as `anthropic/…` or
`openai/…`. When a session runs on such a target, the names and JSON schemas of every MCP tool
the session offers are part of the request that leaves the corporate boundary, exactly as they
are for any other model. Nessy Desktop does two things about it: it tells you, and — since
2026-09-17 — it withholds every MCP server that is not on a short allowed list.

## What you see

- **A mark on the connection row.** In the model picker, a connection whose default model
  answers from an external vendor carries the badge **external model**. The mark is computed
  from the connection's default model, so a row with no default model also carries it — the
  direction errs toward telling you more.
- **One line under the model list.** For the model actually picked, the line reads:
  *This model answers from `<host>`, outside Nessy Gateway. The names and schemas of your MCP
  tools are sent there with every turn.* Only the parsed host name appears — never a path, a
  query string or a credential. A subscription card stores no endpoint, so the line names the
  provider's own host, the one the app withholds servers for: `chatgpt.com` on both ChatGPT
  cards (ChatGPT Plus on Pi and ChatGPT (Codex)), `api.anthropic.com` on a direct Anthropic
  connection such as Claude Pro/Max. Any other connection without an endpoint says *the
  provider's own service* in place of a host.
- **A second line, directly under it, saying what is held back.** It reads: *MCP servers
  outside the allowed list are not offered to this model. Your own, project and plugin servers
  are included; a short list of corporate servers still works.* It appears under exactly the
  same condition as the line above — the picker classifies once and both lines follow that one
  verdict — so a target that withholds nothing shows neither. It deliberately names **no
  count**: the picker holds no server list, and a number that can be wrong is worse than none
  where you are deciding whether to trust a model with your tools.

Both surfaces are computed per session from the connection and the model id. Nothing is
logged, and nothing depends on a notice having been shown once before.

## What is classified as external

The rule is **namespace-only** and it is deliberate: the model id's namespace (the part before
the first `/`) and the endpoint's host decide, and the *kind* of connection does not. A BYO
endpoint at a vendor is external and gets the disclosure like any other target, because the
connection kind cannot separate the populations the policy names — the corporate proxy channel
is also the BYO card's default endpoint. The loopback adapter, the gateway itself, and
vendor-internal hosts are not external.

**And the rule is fail-closed on anything it cannot place.** A model id whose
namespace this app does not recognise — including a plain, unprefixed id such as
`gpt-4o` or `claude-sonnet-4-5` against a vendor's own API — is treated exactly
as a known external vendor is: it gets the disclosure and it loses the same
servers. That is deliberate, because an unprefixed id is the *common* spelling at
a vendor rather than the odd one, and a list of vendor namespaces can never be
complete. The cost is stated rather than hidden: a self-hosted endpoint inside
your own perimeter serving unprefixed ids is treated as external too, and the
list of vendor namespaces only changes the wording of the notice, never whether
one appears.

## What is withheld

A session whose model answers from an external target keeps only the MCP servers on a short
list and loses the rest — **every** other server, not only the corporate ones. The list is
`dpJira`, `dpGitlab`, `dpWiki`, `t-tracker`, `dpFinedog`, `dpSage` and `dpAllure`: the set the
reference implementation allows, minus `context7`, which Nessy Desktop does not ship as a
built-in dp server at all.

What the rule does:

- **Every connection kind, BYO included.** A BYO endpoint at a vendor loses the same servers the
  corporate proxy channel does. The earlier exemption for BYO and subscription connections was
  withdrawn on 2026-09-17, for the reason in the section above: the connection kind cannot
  separate the two populations, because the corporate proxy channel is also the BYO card's own
  default endpoint.
- **Every runtime.** Pi, Claude and Codex sessions all lease their MCP servers from one pool
  through one code path, so the rule reaches the three identically.
- **Per model, not per workspace.** Pick a gateway model again and the servers come back on the
  next turn. Editing the connection's endpoint while a chat is open is decided the same way:
  pointing it at an outside vendor withholds the servers from the next turn, and pointing it
  back inside returns them. Nothing is uninstalled, nothing is disabled, and the server lists in Settings and in
  the MCP panel are unchanged — they show what this workspace has, not what this model gets.

What the rule does *not* do:

- It does **not** reach the session's own tools (`mcp__session__*`). Those are served in-process,
  not from the MCP pool, so no pool-level rule can withhold them.
- It does **not** filter native tools. `Bash`, `Read` and their siblings carry no `mcp__` prefix
  and are not part of this rule.
- It does **not** hold back the conversation itself. File contents and pasted text are in the
  request before any tool is offered; this rule is about tool names and schemas.
- It does **not** filter the request on the wire. Every tool that reaches the request adapter was
  configured for that session by the host, so a second filter there would decide the same thing
  twice — and on the untranslated Anthropic route the gateway protocol forbids rewriting the body
  at all.

**For operators.** Every materialization that withholds writes one line to the session log naming
the servers it withheld and the target class that caused it (`external_model_mcp.withheld:…`).
A packaged build drops the session log, so the same line also goes to standard error when the
app runs with `NESSY_DEBUG=1`. Nothing is thrown, and no turn fails because of this rule.

## Honest scope statement

The following is the owner-approved scope of this feature, quoted verbatim from the plan that
delivered it, with its 2026-09-12 corrections folded in.

> 1. What the whitelist promises: *a corp-proxy external model is not handed tools that act on
>    internal systems* (dpJira, dpGitlab, …). It does NOT promise *internal data cannot reach an
>    external model*: native `Bash` and `Read` carry no `mcp__` prefix and are not filtered,
>    isolation is off by default (standing owner decision), and the conversation body itself —
>    file contents, ticket text — is in the request before any tool is offered.
> 2. The whitelist alone does not unblock anthropic-on-llm-proxy: the guardrail on the messages
>    route refuses ANY tool-carrying request (the measured 403 lists even our own session
>    tools). That route needs ODR-1 and DA2.4. What the whitelist DOES close is the silent leak:
>    today the full dp, plugin and session tool array rides unfiltered to the proxy on the Pi
>    and codex arms, where there is no guardrail, unlogged.
> 3. **CORRECTED 2026-09-12 — the third deliverable of this phase is already DONE and the
>    promise has shrunk accordingly.** The guardrail-403 misdiagnosis fixes landed in the parity
>    plan (DA2.7), and the DISCLOSURE half of the visibility work landed with them. What Phase 2
>    still owes is the withholding half, and the owner deferred exactly that on 2026-09-05 to
>    the plan you are reading. **Until DA2.1 settles the DP-5 collision, nothing in this phase
>    may withhold a tool.**

Both halves have since been settled and built. DA2.1 resolved the collision as namespace-only,
and on 2026-09-17 the owner decided the withholding half the same way — with the BYO exemption
in point 1's premise withdrawn, so "a corp-proxy external model" in that quote now reads as
"an external model, whatever the connection". Points 1 and 2 stand unchanged otherwise: the list
still promises only that internal-system tools are not offered to an external model, and it still
does not unblock the Anthropic-on-llm-proxy route.

## Related

- [MCP overview](./overview) — how tools are namespaced and offered.
- [MCP authentication](./authentication) — how a server's own credentials are handled.
- [Permissions](../../core-concepts/permissions) — the permission rules that govern tool calls.
