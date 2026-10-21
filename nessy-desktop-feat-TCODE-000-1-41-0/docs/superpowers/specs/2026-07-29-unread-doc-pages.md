# Phase 4 worklist — the documentation pages this audit never read

> **EXECUTED. The title is now false for most of this file — read this banner
> before the list.** Phase 4 ran, and section A is comprehensively read.
> Citations under `docs/superpowers/`, measured 2026-07-30 and excluding this
> file's own mentions: `model-config.md` 44, `output-styles.md` 39,
> `monitoring-usage.md` 33, `sandbox-environments.md` 28, `errors.md` 21,
> `modifying-system-prompts.md` 20, `debug-your-config.md` 15, `hooks-guide.md`
> 11, `plugin-marketplaces.md` 10, `costs.md` 6, `analytics.md` 5,
> `file-checkpointing.md` 5, `managed-mcp.md` 2, `discover-plugins.md` 2,
> `plugin-dependencies.md` 2, `observability.md` 2, `troubleshooting.md` 2.
> **Section B was executed in full** and produced
> `2026-07-29-weekly-changelog-findings.md`.
>
> **What is still true — the residue, and the only live part of this file.**
> These pages return exactly one citation each, which is their own mention here,
> i.e. nothing has been verified against them:
>
> - `plugin-hints.md`, `plugin-relevance.md` — two plugin behaviours with no row.
> - `custom-tools.md` — SDK-side tool definition; our IR is the same shape.
> - `feature-availability.md` — would let rows be marked `inapplicable` on
>   evidence rather than on judgement.
> - `glossary.md` — where a loosely-used term gets pinned.
> - `deep-links.md`, `remote-control.md`, `routines.md`, `goal.md`,
>   `advisor.md`, `artifacts.md`, `channels.md` — features we may not have at
>   all; each needs one line: implemented, inapplicable, or a new row.
> - `security.md`, `security-guidance.md`, `secure-deployment.md`,
>   `admin-setup.md`, `data-usage.md`, `legal-and-compliance.md` — **the
>   enterprise-posture cluster, and the sharpest residue for a bank fork.** We
>   have shipped managed policy, withheld-env classes and a trust chain without
>   citing a single one of the pages that state the intended posture.
> - `streaming-output.md`, `streaming-vs-single-mode.md` — the wire layer.
>
> **Section C's caveat is also unretired:** those pages were classified by title
> and never opened. See the note at the bottom of this file, which still stands.

Written 2026-07-29 by the planner, as the concrete form of programme phase 4
("re-check Claude Code docs from `llms.txt`"). Phase 4 was a sentence; this is
the list it turns into.

## Method

`https://code.claude.com/docs/llms.txt` lists **174** page URLs. Every plan and
spec under `docs/superpowers/` cites **107** distinct `.md` basenames between
them. Diffing the two gives the pages no unit of this audit ever cited.

**Uncited is not the same as unread**, and the difference matters. But this
series' own rule — set in `AGENTS.md` and repeated in the tracker's deviation
rule — is that a plan or commit must cite the page it implements against. By our
own standard, a page nothing cites is a page nothing was verified against.

Two spot-checks confirm the diff is measuring something real rather than an
artefact of how I extracted the citations:

- The tracker carries a row named **"Marketplace schema and lifecycle"**, and
  `plugin-marketplaces.md` has **zero** citations anywhere under
  `docs/superpowers/`.
- The tracker carries **B2, "Observability and cost"**, and `observability.md`,
  `monitoring-usage.md` and `analytics.md` have **zero** citations between them.

So in at least two places we have a parity row whose subject page we never
opened. That is the same failure this audit was created to find, turned on the
audit itself.

> **Both spot-checks are now REVERSED, which is the sharpest evidence phase 4
> actually ran.** Re-measured 2026-07-30: `plugin-marketplaces.md` 10 citations,
> `monitoring-usage.md` 33, `analytics.md` 5, `observability.md` 2. B2's
> `analytics.md` line resolved to a sourced `inapplicable` verdict
> (`plans/2026-07-29-observability-and-cost.md:190`) rather than to silence,
> which is exactly the outcome this file argued for.

---

## A. Contract-bearing, unread — phase 4 must read these

Ordered by what I judge the risk to be, highest first. Each line says why it is
here, so the phase-4 executor can disagree with the ordering on evidence rather
than re-deriving it.

| Page | Why it is load-bearing for us | Row it touches |
| :-- | :-- | :-- |
| `plugin-marketplaces.md` | The marketplace entry schema, including the `source`-resolves-to-marketplace-root case that `plugins-reference.md` calls an **exception** to the `skills` path rule. We implement marketplaces and never read their page. | Marketplace schema and lifecycle, B1, R16 |
| `plugin-dependencies.md` | Semver constraints, transitive enable, disable-blocked-by-dependents, `--prune`. A whole page behind one word in B1's row. | B1 |
| `discover-plugins.md` | Install scopes and **trust**. `AGENTS.md` names this a contract page for our adapters; nothing cites it. | B1, plugin trust gate |
| `observability.md`, `monitoring-usage.md`, `analytics.md`, `costs.md` | B2's entire subject matter. | B2 |
| `managed-mcp.md` | Organisation-controlled MCP. We are a bank fork with managed policy already shipped; this is the page that says what managed MCP is supposed to mean. | R25 family, B1 |
| `output-styles.md` | Cited *by* `sub-agents.md` twice — forks inherit the output style, non-fork subagents do not. R29a has to answer whether we have the concept at all, and it should answer from this page. | R29 |
| `model-config.md` | `sub-agents.md:905` makes subagent thinking inheritance a pointer into this page. We implemented thinking inheritance without reading the page it points at. | P9, R30 |
| `modifying-system-prompts.md` | `AGENTS.md` lists it in the agent-system contract table. System-prompt composition is exactly what a fork inherits. | R29, prompt composition |
| `sandbox-environments.md` | `AGENTS.md` lists it alongside `sandboxing.md`, which we did read. Reading one of a documented pair is how a half-contract ships. | B3 |
| `file-checkpointing.md` | Also in `AGENTS.md`'s table, also unread while `checkpointing.md` was read. Same pattern as the line above. | B3, rewind |
| `security.md`, `security-guidance.md`, `secure-deployment.md`, `admin-setup.md`, `data-usage.md`, `legal-and-compliance.md` | Enterprise posture for a bank fork. We have shipped managed policy, withheld-env classes and a trust chain without reading the pages that state the intended posture. | R25, R26, B3 |
| `hooks-guide.md` | The companion to `hooks.md`, which this series has now read four times and been wrong about twice. A companion page is exactly where the sentence that reverses a reading tends to live. | R9, R24, R27c |
| `plugin-hints.md`, `plugin-relevance.md` | Two plugin behaviours we have no row for at all, which is itself the finding. | unowned |
| `custom-tools.md` | SDK-side tool definition; our IR is the same shape. | tool surface |
| `streaming-output.md`, `streaming-vs-single-mode.md` | `AGENTS.md` lists streaming in the contract table. | wire layer |
| `feature-availability.md` | States which features exist on which surface. Would let us mark rows `inapplicable` on evidence rather than on my judgement. | the whole table |
| `errors.md` neighbours: `troubleshooting.md`, `debug-your-config.md` | `debug-your-config.md` **is** cited (R30b used it), `troubleshooting.md` is not. | R30b |
| `deep-links.md`, `remote-control.md`, `routines.md`, `goal.md`, `advisor.md`, `artifacts.md`, `channels.md` | Features we may not have at all. Each needs one line: implemented, inapplicable, or a new row. Right now they are none of the three. | unowned |
| `glossary.md` | Definitions. Cheap to read and it is where a term we have been using loosely gets pinned. | all |

---

## B. The weekly changelog — 17 pages, none read

> **DONE.** All 17 were read in one pass on 2026-07-29 under exactly the filter
> proposed below, and the write-up is
> `docs/superpowers/specs/2026-07-29-weekly-changelog-findings.md`. The first
> pass produced a live permission bypass (deny rules defeated by an `env`/`sudo`
> prefix), fixed in `4af8bd1e`.

`whats-new/2026-w13.md` through `2026-w29.md`.

These are the highest-value-per-token pages in the whole set and we have read
none of them, which is hard to defend given the specific history:

> Renames and new component types are the recurring failure mode

— `AGENTS.md`, written after Claude renamed its subagent tool `Task` → `Agent`
and every one of our turns failed once a Claude plugin's agent was active.

The weekly pages are where a rename is announced. Two known examples that a
single pass over them would have caught before it cost us anything:

- `2026-w24.md`'s summary line mentions letting subagents spawn their own
  subagents — the depth-limit machinery R29a is now implementing against.
- `2026-w27.md`'s summary line says subagents run in the background **by
  default**, which is the change the agent-parity follow-up plan tracked as S1
  and which we found by other means, later.

Phase 4 should read all 17 in one pass and extract only renames, defaults that
changed, and new component types. That is a narrow enough filter to be quick and
it targets our exact failure mode.

---

## C. Not our surface — recorded once so nobody re-derives it

`amazon-bedrock`, `google-vertex-ai`, `microsoft-foundry`, `claude-platform-on-aws`,
`claude-apps-gateway*` (six pages), `llm-gateway*` (three pages), `gateways`,
`hosting`, `cloud-environments`, `github-actions`, `github-enterprise-server`,
`gitlab-ci-cd`, `devcontainer`, `jetbrains`, `vs-code`, `chrome`, `slack`,
`mobile`, `desktop-linux`, `desktop-wsl`, `desktop-ios-simulator`,
`desktop-quickstart`, `web-quickstart`, `claude-code-on-the-web`, `quickstart`,
`setup`, `troubleshoot-install`, `platforms`, `migration-guide`,
`typescript-v2-preview`, `python`, `overview`, `index`, `best-practices`,
`common-workflows`, `prompt-library`, `champion-kit`, `communications-kit`,
`corporate-launcher`, `claude-code-features`, `claude-security`, `advisor`,
`accessibility`, `voice-dictation`, `fullscreen`, `keybindings`, `statusline`,
`terminal-config`, `code-review`, `ultraplan`, `ultrareview`, `computer-use`,
`third-party-integrations`, `authentication`, `analytics` *(moved to A — it is
B2's subject)*.

**Caveat on this section, stated so it is not mistaken for a verdict.** I
classified these by title and by what I know of our product. I did not open them.
A page about a surface we do not ship can still contain a contract sentence about
one we do — `slash-commands.md` turned out to carry the `/doctor` tier change
that decided R30b's design, and nobody would have predicted that from its title.
If phase 4 has budget after section A and B, sampling section C is the cheapest
place left to find something.

Two in this list deserve a second look despite the classification:
`keybindings.md` and `statusline.md` describe surfaces we do ship in the desktop
app, and `accessibility.md` is the kind of page whose absence is only ever
noticed by the user it fails.

---

## What this list is not

It is not a claim that 110 pages of parity work remain. Most of section C is
genuinely inapplicable and much of section A will resolve to one line of
`inapplicable` or `already implemented`. The value is that each of those lines
will exist, sourced, instead of being absent — which is the state the marketplace
row and B2 are in today.
