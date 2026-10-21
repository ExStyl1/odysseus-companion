# Phase 4, section B — what the weekly changelog pages contained

Written 2026-07-29 by the planner, executing section B of
`2026-07-29-unread-doc-pages.md`: read all 17 `whats-new/2026-wNN.md` pages,
filtering only for renames, changed defaults, and new component types.

That filter was chosen because `AGENTS.md` records renames as this fork's
recurring failure mode. It paid immediately: **the first pass produced a live
permission bypass**, fixed in `4af8bd1e` and recorded as S3 below.

---

## S3 — deny rules were defeated by one prefixed word

`whats-new/2026-w16.md:129`:

> Hardened Bash permissions: deny rules now match through `env`/`sudo`/`watch`
> wrappers, and `Bash(find:*)` allow rules no longer auto-approve `-exec` or …

The second half we already had — `claude-bash-rule.ts` flags `find` with
`-exec`/`-execdir`/`-ok`/`-okdir`/`-delete` and refuses to let a glob allow rule
cross an exec wrapper. Someone read `permissions.md` § Wrappers properly.

The first half we did not. Measured on this repo before touching anything:

| Rule | Command | `deny` before | after |
| :-- | :-- | :-- | :-- |
| `Bash(rm:*)` | `rm -rf /tmp/x` | match | match |
| `Bash(rm:*)` | `sudo rm -rf /tmp/x` | **no-match** | match |
| `Bash(rm:*)` | `env rm -rf /tmp/x` | **no-match** | match |
| `Bash(rm:*)` | `watch rm -rf /tmp/x` | **no-match** | match |
| `Bash(curl:*)` | `env HTTPS_PROXY=… curl http://evil` | **no-match** | match |

So an organisation's managed policy denying `curl` was bypassed by writing
`env curl`, and a deny rule on `rm` by writing `sudo rm`. Three words, no
cleverness required.

**The fix is asymmetric on purpose, and inverting it would be the vulnerability.**
Deny and ask now match on either the conservative text or a text stripped through
privilege wrappers (`sudo`, `doas`), `env`, and the exec wrappers. Allow is
unchanged: an allow rule that saw through `sudo` would let `Bash(rm:*)`
auto-approve `sudo rm` and escalate the rule to root. The test file pins both
directions — every wrapped row must deny **and** must still fail to allow.

Two details worth keeping:

- `env -S "rm -rf /"` needed real work rather than flag-skipping. `-S`'s value
  *is* a command line, so consuming it as a flag value would delete the very
  text the deny rule needs. It is unquoted and spliced back into the token
  stream instead. Both spellings are covered, `-S "cmd"` and
  `--split-string=cmd`.
- A rule naming a wrapper itself still matches it. `deny: Bash(sudo:*)` must
  keep matching `sudo rm`, which it cannot if the matcher only ever sees the
  stripped text — hence *either* form, not the stripped one.

Gate: `claude-bash-rule` + `claude-permission-rules` + `monitor-bash-rules`
104 pass / 0 fail; the pi-harness and agent suites 1527 pass / 2 skip / 0 fail;
`typecheck:shared` clean; `git diff --check` clean.

---

## Verified against our code while reading

**Already implemented — `w24`, deny rules accept a glob in the tool-name
position.** `permission-dsl.ts:648` runs `wildcard()` over both `semanticId` and
`toolName`, so `deny: "*"` really does deny every tool. Checked by driving the
parser and the matcher rather than by reading the code, because "parses cleanly"
and "denies anything" are the two things this series keeps finding apart.

**Not implemented — the other half of that same line: "unknown tool names in
deny rules now warn at startup".** `parseClaudeRuleString('NoSuchTool', 'deny')`
returns a rule with **no warning**. A typo in a deny rule is silently a rule that
denies nothing. Low severity, exactly the right shape for this audit: it looks
enforced and is not. Not fixed here — it belongs with the diagnostics surface
R30b just built, which is where a user would look for it.

**CLOSED since (verified 2026-07-30).** The warning branch is
`claude-permission-rules.ts:188-198`, and `knownToolNames` is now supplied at
three production parse sites — `pi-agent.ts:2986`, `permissions-config.ts:529`
and `managed-policy.ts:977` — all passing `PERMISSION_RULE_TOOL_NAMES`. The
branch is deliberately scoped to non-`allow` actions and skips names containing
`_` or `*`, so MCP-qualified and wildcard names do not produce false typo
warnings.

---

## Routed to existing rows

> **Status column added 2026-07-30.** As written, this was a "not yet actioned"
> table, and an executor reads such a table as a queue. It had gone wrong in
> **both** directions: two rows it listed as missing had shipped, while others
> genuinely had not. Each status below is the result of a grep against the tree
> on 2026-07-30, with the evidence inline. Rows marked *not re-checked* were not
> measured in this pass — treat them as unknown, not as open.

| Finding | Page | Row | Status, 2026-07-30 |
| :-- | :-- | :-- | :-- |
| Messages relayed via `SendMessage` from other sessions **no longer carry user authority**, and auto mode blocks them | `w24` | R23 / mailbox. Our `mailbox-service.ts` is a 50-line persistence shim, so where authority is decided is elsewhere and needs a real trace, not a grep. Security-relevant: a cross-session message carrying user authority is a privilege escalation between sessions. | **not re-checked.** The row itself says this needs a real trace, not a grep. |
| Subprocesses (Bash, hooks, MCP, LSP) **no longer inherit `OTEL_*`**, so an instrumented app run via Bash stops picking up the CLI's own OTLP endpoint | `w19` | B2, and the withheld-env classes from R25b/R26. This is a **fifth** class beside transport, routing, credential and our own `execution` — telemetry redirection. | **still open.** `config/managed-env.ts:164-168` classes `OTEL_*` as `immediate` — that is the managed-DELIVERY contract, not a subprocess-inheritance strip. No telemetry-redirection withheld class exists beside transport/routing/credential/execution. |
| `claude mcp` list/get/add **no longer print secrets**: env references unexpanded, credential headers and URL secrets redacted | `w23` | Our MCP surfaces, and the standing rule against logging credentials. Worth a direct check of what our MCP listing prints. | **not re-checked.** Redaction machinery exists (`mcp-pool.ts`, `hook-command.ts`), but whether our MCP LISTING surface redacts was not traced here. |
| OS CA certificate store **trusted by default** (`CLAUDE_CODE_CERT_STORE=bundled` to opt out) | `w15` | R26's trust chain. We inverted a related precedence already (a user `tlsCaPath` overriding a managed value); this is the adjacent default. | **landed.** `certStore` is parsed and applied at `config/network-runtime.ts:124-131` with `bundled`/`system` sources and a warning on an unknown one; `CLAUDE_CODE_CERT_STORE` is classified `transport` at `managed-env.ts:115`. |
| The `default` permission mode is **renamed `Manual`** across CLI, `--help`, VS Code and JetBrains; `--permission-mode manual` accepted alongside `default` | `w27` | Our modes are our own (`dontAsk`/`safe`/`plan`/`ask`/`acceptEdits`/`auto`/`allow-all`), so this is naming, not behaviour — but it is the exact rename shape that cost us the `Task`→`Agent` outage, so it is recorded rather than dismissed. | **no action, by design.** Naming only; recorded so the next reader does not re-file it. |
| New `disableBundledSkills` setting and env var hide bundled skills, workflows and built-in commands from the model | `w24` | Settings parity. We ship bundled skills (`ensureBundledSkills`) with no such switch. | **landed.** `disableBundledSkills` now has 22 hits across 8 files. |
| New `enforceAvailableModels` managed setting makes the `availableModels` allowlist also constrain the Default model | `w24` | R25 managed settings. | **landed.** `enforceAvailableModels` now has 52 hits across 11 files. |
| `AskUserQuestion` dialogs **no longer auto-continue by default**; opt into an idle timeout via config | `w27` | Our ask-user tool. An auto-continuing dialog answers on the user's behalf. | **landed.** `askUserQuestionTimeout` (`config/storage.ts:96-100`, validator `validators.ts:207` = `60s`/`5m`/`10m`/`never`, **default `never`**) drives `AskUserService`'s timer (`server-core/src/pi-harness/ask-user-service.ts:33`), and an expiry is marked `autoContinued` rather than passed off as an answer. |
| A failed Bash command in a parallel tool batch **no longer cancels the others** | `w23` | Tool scheduling. | **not re-checked.** |
| `CLAUDE_CODE_SESSION_ID` is in the Bash subprocess environment, matching the `session_id` passed to hooks | `w19` | Hook/env parity. | **still open.** `CLAUDE_CODE_SESSION_ID` returns **0 hits** across `packages` and `apps`. The one row in this table with nothing built and nothing else tracking it. |
| Streaming tool execution **always enabled**, including with telemetry disabled | `w22` | Wire layer. | **not re-checked.** |
| Default effort level changes (`w15`, `w17`), Opus 4.8 default (`w22`), fast-mode pricing (`w22`) | — | Model/plan facts about their product, no contract for us. Recorded so the next reader does not re-check them. | no action — model/plan facts about their product. |
| `/undo` aliases `/rewind`, `/proactive` aliases `/loop` (`w16`); `/extra-usage` → `/usage-credits` (`w21`); Windsurf → Devin Desktop (`w23`) | — | Renames in surfaces we do not ship. | no action — renames in surfaces we do not ship. |
| `/fork` now copies the session into a new background session; the in-session forked subagent is now `/subtask` | `w29` | **R29** — already the basis of the R29a plan, and this line independently confirms the reading taken from `sub-agents.md`. | **landed.** R29's `/subtask` shipped; see `docs/architecture/fork-subagents.md`. Not live-verified: `AGT-1`..`AGT-5` are still unrun. |

---

## Method note

Seventeen pages, one `curl` loop, one grep for six words
(`renam`, `no longer`, `now defaults`, `is now`, `replaced`, `deprecat`,
`removed`), and the yield was one shipped permission bypass plus eleven routed
findings. The pages had never been cited by any of the ~35 units in this audit.

The lesson is not that changelogs are valuable in general. It is that this fork
tracks a moving upstream and had no mechanism at all for noticing when the
upstream *changed its mind*, as opposed to when we misread it the first time.
Every unit so far has read the current state of a page and compared it to our
code. None had asked what the page used to say.
