# Upstream docs are contracts — the full rules

Moved verbatim from the root `AGENTS.md` on 2026-09-25 (from `1a6de488a`) to keep the always-loaded
guide under 300 lines; `AGENTS.md` keeps the summary. Read this before changing plugins, MCP,
skills, hooks, commands, agents or the format adapters, and before citing a Claude or codex page.

## Upstream Docs Are Contracts

Nessy imports Claude Code and Codex plugins, so their docs are contracts.
Consult before changing plugins/MCP/skills/hooks/commands/agents or the
format adapters; cite the page in the plan or commit.

- Claude index: `https://code.claude.com/docs/llms.txt` — and **the pages carry `/en/`:
  `https://code.claude.com/docs/en/<page>.md` returns 200 while
  `https://code.claude.com/docs/<page>.md` returns 404** (measured 2026-08-28; the index's
  own URLs have always carried it, and this line said otherwise, so every lane told to
  verify an anchor by the documented route got a 404); its 210 pages are snapshotted in `scripts/claude-doc-pages.tsv`
  (2026-10-01; the count in this line went 174 → 186 → 191 → 210 while it once still said
  174, so read the TSV's own `Snapshot:` line, not this one) with verdicts in
  `docs/superpowers/specs/2026-07-31-claude-coverage-map.md` —
  citations are checked against that snapshot, and that index is the whole
  corpus. `platform.claude.com/docs` is out of scope (owner 2026-07-31).
- Plugin-format pages, TWENTY-FIVE since the docs moved under `plugins/` (refresh
  2026-10-01, F1.1033): the twenty `plugins/*` pages the index lists
  (`grep -c 'docs/en/plugins/' llms.txt` → 20) plus `plugin-evals.md`, `mcp.md`,
  `settings-reference.md`, `workflows.md` and `channels-reference.md`. **Grown to
  THIRTY-FIVE on 2026-10-17 (UB12.95):** the index gained a `#### Mods` group of ten
  `plugins/mods/*` pages (unique `plugins/` slugs 20 → 30), and a mod is a plugin
  component (`modules` in `hooks/hooks.json`), so they are format pages too. The `grep -c`
  above now reads 37, not 30: the index began listing 36 pages twice, so count unique
  slugs (`grep -o 'docs/en/plugins/[^)]*\.md' llms.txt | sort -u | wc -l`). The FORMAT
  itself is five of them: `plugins/manifest-reference.md` (every `plugin.json`
  key, path rules, user configuration, standard layout), `plugins/marketplace-reference.md`
  (marketplace file, plugin entries, sources, validation messages),
  `plugins/components.md` (what each component does), `plugins/loading.md`
  (stages, versions, auto-update) and `plugins/cli-reference.md` (the `claude plugin`
  commands). The eleven this line named until then mapped onto them: the old
  plugins reference became the manifest reference plus parts of `components`,
  `loading` and `cli-reference`; the marketplaces page became `marketplace-reference`,
  `create-marketplace` and `host-marketplace` (headersHelper, archive auth, release
  channels); `plugins` became `create` and `components`; discover-plugins became
  `install`, `overview`, `anthropic-marketplaces` and `code-intelligence`; and the
  dependencies, relevance and hints pages became `plugins/dependencies.md`,
  `plugins/relevance.md` and `plugins/cli-hints.md`. All seven retired names are
  out of `claude-doc-pages.tsv`, so `check-doc-anchors` calls a citation of any of
  them `page-not-in-corpus`; F1.1033 re-pointed every one (the record docs keep the
  old section as "was <page> § <section>"). History: this line said six until
  2026-08-26, and the omission was not harmless — `workflows.md` is the DEFINITION
  of a field this repo has a constant for.
- A page can SPLIT, and a split is invisible to a page count. `settings.md` did
  (measured 2026-08-25): it is now scope/precedence/how-to-edit, the key-by-key
  reference this line used to point at is `settings-reference.md`, the
  managed-policy invalid-value table is `managed-settings.md`, and some of it
  landed on `server-managed-settings.md`. So every `settings.md:<line>` anchor in
  this repo is dead at the PAGE level, and renumbering cannot fix them. Cite
  `page.md#<section>` plus the verbatim sentence — a section anchor is part of the
  page's published link contract, a line number has a measured half-life of about
  two days. **How MANY are dead is a reading with a date, not a fact** — this line
  said 828 while the tree also said 827, 835, 767 and 772, each correct when
  written. Run the census instead of quoting a number, and use `git grep -a`,
  because a wrapped `grep -r` hid 25 of 835 once and timed out in `node_modules`
  the next time:
  ```sh
  R='[A-Za-z0-9_-]*settings\.md:[0-9]+(-[0-9]+)?'
  git grep -ahoI -E "$R" | wc -l && git grep -ahoI -E "$R" | sort -u | wc -l
  ```
  **The FOLLOWABLE half of that census — `packages/**` + `apps/**`, the source
  comments a developer actually follows — is ratcheted by `lint:settings-line-citations`,
  a `lint:chain` step (`scripts/check-settings-line-citations.ts`, P6.746): it fails when
  the count RISES and asks you to lower its pin when you convert citations.** The pin is a
  constant in that script and appears in no prose, here included, for the reason this
  paragraph already gives. `check-doc-anchors.ts` cannot help — its own §"WHAT THIS GUARD
  CANNOT CATCH" says "it cannot see any line-numbered anchor at all".
  **Which of them are worth converting, which are deliberately frozen, and the
  verified successor anchor plus today's verbatim sentence for the most-cited ones:
  `docs/superpowers/specs/2026-09-07-settings-anchor-rot-disposition.md`.** Read it
  before converting one — it measures three ways a mechanical rewrite goes wrong,
  including one dead line with TWO live successors on two different pages, and a
  sentence quoted in twelve source comments that no Claude page contains any more.
  **And a CORRECTION that spells the dead anchor RE-CREATES the finding it is repairing**
  (measured three times in one sweep, P6.890): the natural way to write *“this anchor was
  wrong”* is to quote it, and every citation guard then reports the corrected cell forever —
  the first draft of each of those three corrections kept the citation form and the gate went
  on listing it. Name the old anchor in WORDS — *line N of `<path>`* — never in the
  `path:line` form the guards match; the same applies to a page anchor you are retiring. **And the rule is wider than a dead anchor** (measured 2026-09-12, W18-d on W18-e's repair): any `<word>.md#<word>` written in a comment — a PLACEHOLDER such as a bracketed 'page not in corpus' spelled in that shape included — IS a citation to `check-doc-anchors`, so a repair that leaves one behind re-creates the finding without ever naming the old anchor. Write the placeholder in words too.
- **How a section anchor is spelled — measured against the RENDERED page, not
  the markdown (2026-08-25).** Guessing it wrong, in both directions, has now
  cost three measurements and four false pins:
  - A dotted key HYPHENATES its dots: a heading `permissions.defaultMode` is
    `#permissions-defaultmode`, and `sandbox.filesystem.allowWrite` is
    `#sandbox-filesystem-allowwrite`. The rule recorded in three places in this
    tree — "the dots are dropped" — is inverted, and it mis-slugs 59 of
    `settings-reference.md`'s 255 headings.
  - `,` `:` `(` `)` drop; spaces and dots hyphenate; `/`, an apostrophe and `+`
    survive (the `+` measured 2026-09-12 on `interactive-mode`'s
    `reverse-search-with-ctrl+r`, C3.330 — the snapshot had dropped it and the guard
    called a live anchor dead); only `##`/`###`/`####` get an id at all — measured over nine pages,
    every one of their 666 h2/h3/h4 headings resolves, while `#` scored 0 of 9
    and `#####` 3 of 24.
  - A DUPLICATE heading takes a numeric suffix, and no slug rule predicts which
    of the two you are looking at: `plugin-marketplaces.md` has two
    `### Required fields` headings and publishes `id="required-fields"` AND
    `id="required-fields-2"` (measured 2026-08-26). A hand-derived anchor for the
    second occurrence of any repeated heading is therefore guaranteed wrong.
  - A page also publishes explicit `<span id="…" />` anchors, which are the ones
    a rename leaves behind, and they are NOT in the markdown's heading list.
    `managed-settings.md#invalid-entries-in-managed-settings` is one, and two
    other corpus pages link to it by that name.
  - So: `curl` the page WITHOUT `.md` and grep `id="…"` — **and that rule is host-specific, measured 2026-08-30: it is right for `code.claude.com` (22–544 ids per page) and WRONG for `learn.chatgpt.com`, whose pages are client-rendered, where it scored 6 of 25 against 24 of 25 for the `.md` twin. For codex pages, read the `.md`.** Anything derived from a
    slug rule — including `bun scripts/check-doc-anchors.ts`'s snapshot — is a
    convenience, and it verified its own wrong rule for one commit.
- Codex publishes a contract too (this guide once said it did not). The useful
  subset of `developers.openai.com/plugins/` is three pages — most of that tree
  is about ChatGPT apps, not Codex plugins:

| Question | Page |
| --- | --- |
| Manifest fields, plugin structure, path rules, bundled MCP/hooks | `plugins/build/plugins.md` |
| The four accepted `hooks` shapes; hook env (`PLUGIN_ROOT` + compat vars — we emit all four); the **TWELVE** events — and this cell is the standing proof of its own advice, because the number has now been wrong in BOTH directions: it said twelve when the enum held eleven (a miscount, corrected 2026-08-28, after it had reached a lane brief), and it said eleven when the enum had grown to twelve (`interrupt`, upstream #40511, arriving with the 2026-09-11 lift to `rust-v0.150.1`). Read them from `packages/codex-protocol/generated/v2/HookEventName.ts`, not from prose: `preToolUse` `permissionRequest` `postToolUse` `preCompact` `postCompact` `sessionStart` `sessionEnd` `userPromptSubmit` `subagentStart` `subagentStop` `stop` `interrupt`. Agreed by `HooksToml`, `ManagedHooksRequirements` and the page at `rust-v0.154.0` (re-verified 2026-09-17, WI-b I2.22: all three still twelve at the tag `codex-protocol/manifest.json` pins). **ELEVEN of the twelve are also one of OUR `AgentEvent`s, name for name; `interrupt` is not, and `CODEX_ONLY_HOOK_EVENTS` (`packages/shared/src/automations/runtime-hook-events.ts`) is where that asymmetry is spelled and declined with its reason.** | `learn.chatgpt.com/docs/hooks.md` |
| Field types/requiredness (~150 named errors — the closest thing to a schema) | `plugins/deploy/submission-errors.md` |

  **`github.com/openai/codex` is the SOURCE, and on this runtime the source outranks the
  page.** Added as a reference 2026-08-28 after we measured the shipped binary behaving
  **opposite to its own Beta-marked documentation twice** — once where a fix written to the
  page would have removed a working credential control, and once where the page says the
  binary "rejects" a bad profile while never promising the rejection is legible (it is not).
  So for codex, read the source to settle behaviour and cite the page only for intent.
  Same standing rule as every other reference: it is **evidence, not authority**.

  `github.com/openai/plugins` (180 real manifests) is practice, and practice
  disagrees with spec — read both; `docs/superpowers/plans/2026-07-29-codex-adapter-spec.md`.
- Agent SDK pages specify behavior our own loop matches — read before assuming
  a behavior is undocumented (that assumption cost a wrong parity assessment):

| Question | Page |
| --- | --- |
| Loop, context, deferred tools, permissions, hooks | `agent-sdk/agent-loop.md`, `context-window.md`, `agent-sdk/tool-search.md`, `agent-sdk/permissions.md`, `agent-sdk/hooks.md` |
| Sessions, subagents, skills/commands/plugins | `agent-sdk/sessions.md`, `agent-sdk/session-storage.md`, `agent-sdk/subagents.md`, `agent-sdk/skills.md` (absorbed `slash-commands.md` — out of the index since 2026-08-09; its URL still 200s, a 200 is not corpus membership), `agent-sdk/plugins.md` |
| System prompt, sandbox, checkpoints, streaming/structured/todos | `agent-sdk/modifying-system-prompts.md`, `sandboxing.md`, `checkpointing.md`, `agent-sdk/streaming-output.md`, `agent-sdk/structured-outputs.md`, `agent-sdk/todo-tracking.md` (the last two were listed unprefixed until 2026-08-25 — both 404 that way; every other page in this table was re-probed the same day and resolves) |

Renames and new component types are the recurring failure mode (two shipped
bugs: `Task`→`Agent`; `lsp` vs `lspServers`). On every touch, diff the page's
component fields against **all three** discovery constants in
`format-adapters/claude.ts`. This used to be two page tables against two constant
pairs, and diffing only the first pair is how a field sat unexplained in the second
for a month (P2.181). Since the upstream plugin-docs reorganisation it is ONE table,
because the entry page now defers to the manifest page. It was four constants until
2026-09-28 (F1.1060): `CLAUDE_MANIFEST_COMPONENT_FIELDS` lost its only reader in
F1.1034 (the `strict: false` conflict now asks the ENTRY, per the marketplace
reference's Strict mode section) and was deleted, not kept for the diff, because a
constant nothing reads can still say "covered" about a field nothing loads. Its
column decided no row: every page row it held is also in `CLAUDE_ENTRY_COMPONENT_FIELDS`,
and the rows in no constant were the same seventeen with and without it (measured
2026-09-28). Its one non-page name, our legacy `lsp`, is no page row.

| Page section (ids read from the rendered pages, 2026-09-28) | Constant |
| --- | --- |
| `plugins/manifest-reference.md#fields`: "The table lists the top-level keys in `plugin.json`." Its `plugins/manifest-reference.md#standard-layout` table succeeds the old file-locations table; its rows are component NAMES with default locations, not keys, so read it by eye. | `CLAUDE_CUSTOM_PATH_FIELDS`, `CLAUDE_RETAINED_SURFACE_FIELDS` |
| The same table, for a marketplace entry: `plugins/marketplace-reference.md#plugin-entries` says "An entry also accepts every `plugin.json` field, such as `description`, `version`, `author`, `commands`, and `hooks`.", and its explicit-id heading "How an entry combines with plugin.json" (`plugins/marketplace-reference.md#entry-and-plugin-json`) names which of them combine. | `CLAUDE_ENTRY_COMPONENT_FIELDS` |

**Where the old two tables went — measured 2026-09-28 (F1.1031, origin DN-220).**
The index (`llms.txt`) no longer lists `plugins-reference.md` or
`plugin-marketplaces.md`; it lists the two `plugins/…` pages above. The old
`plugins-reference.md` URL still answers 200 with bytes identical to the new
manifest reference (`cmp`), and the old `plugin-marketplaces.md` URL now serves
"Create a marketplace" — a 200 is not corpus membership. The section this diff used
to read (the old reference's "Component path fields" heading) and the marketplace
page's "Optional plugin fields" heading are ids on neither rendered page any more, and
the old script's awk printed **no rows and exited 0**: the rule passed silently on an
empty read, and nobody could tell. This repo's two snapshots
(`scripts/claude-doc-pages.tsv`, `scripts/claude-doc-anchors.tsv`) predated the move
until F1.1033 refreshed both on 2026-10-01; the table above was in words until then
and cites the sections now, and every citation of a retired page was re-pointed.

**The table carries rows that are in no constant, so the rule yields false
positives — and a rule that cries wolf is a rule people stop running.** Do not trust
a number written here: this section has said six, thirteen and fourteen about page
tables that kept growing. **Run the diff; it prints the misfires by name, and it
refuses to pass on an empty read** — it exits 1 unless it read the `skills` row, a
component in two of the constants, as a path-typed row. It runs in a subshell, so
the `exit` does not close yours:

```sh
( A=packages/shared/src/plugins/format-adapters/claude.ts
  P=${P:-https://code.claude.com/docs/en/plugins/manifest-reference.md}
  in_const() { sed -n "/^const $1/,/^]/p" "$A" | grep -avE '^[[:space:]]*(//|\*)' | grep -acF "'$2'"; }
  rows=$(curl -sf "$P" | awk '/^## Fields$/{f=1;next} f&&/^## /{exit}
    f&&/^\| \[?`/{split($0,c,"|"); split(c[2],k,"`"); print k[2], (c[3]~/Path/ ? "path" : "other")}')
  printf '%s\n' "$rows" | grep -qx 'skills path' || {
    echo "READ NO ROWS (or lost the skills control) from $P ## Fields: re-anchor, do not pass" >&2; exit 1; }
  printf '%s\n' "$rows" | while read -r k t; do b="${k##*.}"
    c=$(in_const CLAUDE_CUSTOM_PATH_FIELDS "$b"); e=$(in_const CLAUDE_ENTRY_COMPONENT_FIELDS "$b")
    r=$(in_const CLAUDE_RETAINED_SURFACE_FIELDS "$b")
    printf '%-22s %-5s CUSTOM=%s ENTRY=%s RETAINED=%s%s\n' "$k" "$t" "$c" "$e" "$r" \
      "$([ "$c$e$r" = 000 ] && echo '  <- in no constant')"
  done )
```

Each row carries the page's own class: `path` when its Type column accepts a path —
`## Component path forms` (rendered id `component-path-forms`): "Every component key
accepts a path relative to the plugin root." — and `other` for the rest. The counts
skip comment lines, because `CLAUDE_RETAINED_SURFACE_FIELDS` keeps notes about rows
that USED to sit in it: without the filter `settings` scores `RETAINED=2` from two
such notes (measured 2026-09-28), a row the diff would call covered while no
constant holds it. Negative control: `P=https://code.claude.com/docs/en/plugin-marketplaces.md`
exits 1 with the message above.

A row marked `<- in no constant` is the rule misfiring, not a gap —
**each such field has a reader of its own, and that reader is what to diff it
against.** Some sit in a THIRD discovery constant in the same file,
`CLAUDE_RETAINED_SURFACE_FIELDS` (`experimental.themes` as
`externalKind: 'theme'`, `userConfig` as `'user-config'` plus
`normalizeClaudeUserConfig`, `channels` as `{ externalKind: 'channel' }`) — those
show `RETAINED` non-zero. The rest have a normalizer and no constant at all, so
they show zero everywhere and must be resolved by name:
`experimental.monitors` → `normalizeClaudeMonitors` (reading
`experimentalSection?.monitors ?? input.monitors`), `dependencies` →
`normalizeClaudeDependencies`, `settings` → `normalizeClaudePluginDefaultSettings`
(it reads `input.settings` beside the plugin-root `settings.json`), and the
`experimental` container itself, which those readers open. The other `other` rows
are plugin METADATA, not components — on 2026-09-28 `$schema`, `name`,
`displayName`, `version`, `description`, `author`, `homepage`, `repository`,
`license`, `keywords`, `metadata` and `defaultEnabled` — and they misfire by
construction. **A field in none of the three constants AND with no normalizer of its
own, that is not metadata, is the real thing this rule exists to catch.**

Re-run 2026-09-01 (P2.215): thirteen page rows, five misfiring, every one of the
five resolved to the reader named above — so the rule is accurate today and the
five are explained rather than assumed.

Re-run 2026-09-17 (WI-a, I2.2, `a279eb109`) against a freshly fetched `plugins-reference.md`
(200): **fourteen page rows, six misfiring** — the sixth, `experimental.evals`, has neither
a constant nor a normalizer, the exact shape the paragraph above calls "the real thing this
rule exists to catch", and it is explained rather than assumed: the directory holds eval
cases for `claude plugin eval`, a developer command, and admitting it as a retained-surface
row would fire on the mere existence of an `evals/` folder and force
`compatibility.state: 'partial'`, which purges a bundle's durable activation grants — a
plugin would lose its grants for shipping its own tests. A note beside
`CLAUDE_RETAINED_SURFACE_FIELDS` with a test pin records the refusal. The numbers are a
reading with a date, as this section says of its own.

Re-run 2026-09-28 (F1.1031) with the script above, against
`plugins/manifest-reference.md` (200): **twenty-eight rows, eleven of them `path`**.
In no constant: `experimental.monitors` and `experimental.evals` among the `path`
rows, and among the `other` rows the twelve metadata keys, `dependencies`,
`settings` and `experimental`, each resolved by name above. No real gap on the
manifest side; the entry side moved, which the next paragraph records.

Re-run 2026-09-28 (F1.1060) after `CLAUDE_MANIFEST_COMPONENT_FIELDS` was deleted, the
script above extracted verbatim from this file: rc 0 in bash and zsh (identical
output), the same twenty-eight rows and eleven `path` rows, and the same seventeen
rows in no constant, name for name, as the four-constant run just before it; the
negative control still exits 1.

Re-run 2026-10-01 (F1.1033, after the snapshot refresh), the script extracted verbatim
from this file: rc 0 in zsh and bash (identical output), twenty-eight rows, eleven
`path`, and the same seventeen in no constant — the twelve metadata keys, `dependencies`,
`settings`, `experimental`, `experimental.monitors` and `experimental.evals`, each
resolved by name above (`normalizeClaudeDependencies`, `normalizeClaudeMonitors` and
`normalizeClaudePluginDefaultSettings` all still in `claude.ts`). No real gap; the
negative control still exits 1.

Re-run 2026-10-17 (UB12.95), the script extracted verbatim from this file, against
`plugins/manifest-reference.md` (200): rc 0 in zsh, **thirty-four rows, twelve `path`**,
and twenty-three in no constant — the seventeen above plus six new rows. Five are the
directory-listing fields `icon`, `documentationUrl`, `supportUrl`, `privacyPolicyUrl` and
`termsOfServiceUrl`, METADATA by the page's own words (`plugins/manifest-reference.md#directory-listing-fields`:
Anthropic's directory reads them, "Claude Code ignores them at load time"), so the metadata
keys are seventeen now and misfire by construction like the twelve. The sixth is `types`, a
`path` row with no reader — the shape this rule exists to catch — resolved like
`experimental.evals`: "A `.d.ts` file that declares the `$.state` values and `$` nouns of a
mod", added "to let `claude plugin validate` check your code" (Claude's mods interface page),
a developer-time file that runs nothing. **The component it types is the real new surface, and
this diff cannot see it**: a mod is declared by the `modules` key of `hooks/hooks.json`, a
component file, not a manifest field. `addClaudeModDeferral` (`format-adapters/claude.ts`) now
records it as a `mod` deferral with an author diagnostic; before, the reader misread the key as a
hook event or dropped it silently. The reasons for all eight sit beside
`CLAUDE_RETAINED_SURFACE_FIELDS`, pinned by `__tests__/format-adapters.test.ts` "UB12.95" with
`homepage` as the control. No real gap left on the manifest side; the negative control still
exits 1.

**It misfires in the OTHER direction too, and the diff cannot see that one.**
`CLAUDE_ENTRY_COMPONENT_FIELDS` is the detection marker set for a marketplace
entry, and its header records a deliberate documented-SUPERSET (`workflows`) of the
entry table it was measured against on 2026-08-25. **That table is gone.** The
marketplace reference now names six entry component fields, and they are a
different six — "the entry's six component fields, `commands`, `agents`, `skills`,
`hooks`, `outputStyles`, and `themes`" — and for a plugin with its own `plugin.json`
it adds "Entry `mcpServers`, `lspServers`, `userConfig`, and `channels` don't apply.
Declare them in `plugin.json`." (both read 2026-09-28). F1.1032 (`1d4d31201`,
2026-09-28) re-read the header against that page: `outputStyles` and `themes` joined
the constant, and `mcpServers` and `lspServers` stay because detection reads it only
when there is no `plugin.json`, where every entry field applies (the `strict: false`
conflict gate that reads it over a `plugin.json` leaves them and `workflows` out). It
changed detection and component loading, so it was a row with tests, not a tidy —
**read that header before "tidying" a name out of a constant the page does not
mention.**

The `lspServers` row is the one to read twice, because it looks exactly
like the `lsp`/`lspServers` bug above recurring inside the guidance written to
prevent it: it IS in `CLAUDE_ENTRY_COMPONENT_FIELDS` — so the diff stays
silent on it — and absent from `CLAUDE_CUSTOM_PATH_FIELDS`, where both of its "own merge rules"
siblings (`hooks`, `mcpServers`) sit. **Measured, it is not that bug:**
`normalizeClaudeLspServers` resolves its own paths through the same
`resolveClaudeComponentPaths` + `collectClaudeConfigSources`, and on an
uncontained path it reports one diagnostic MORE than `mcpServers`
(`claude_capability_incomplete` on top of `claude_path_invalid`), with a
contained-but-missing path identical on both. Adding it to
`CLAUDE_CUSTOM_PATH_FIELDS` alone would REGRESS: `lsp` is not in
`CLAUDE_FOLLOWED_CONFIG_FIELDS`, so an inline `lspServers` array would start
recording a spurious `inline-lsp-config` deferral. Two lines together, or
neither.

## One qualification, measured 2026-08-28: docs are the contract for BEHAVIOUR, not for MEMBERSHIP

*"For Claude the documentation IS the contract"* holds for **what a thing does**. It does **not** hold
for **what exists** — and treating it as if it did has already cost a shipped egress hole.

Measured: `CLAUDE_CODE_USE_GATEWAY` and `CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD` are real provider
toggles in the shipped bundle — `_GATEWAY` sits **ahead of all six others** in the selector chain and
installs a session with `unpinned: true`, exempt from the TLS-fingerprint pin — and both appear in
**zero of the 191 corpus pages**, along with three `ANTHROPIC_GOOGLE_CLOUD_*` companions. Their five
documented siblings appear in 6–18 pages each; four GCP page spellings 404. **A whole shipped provider
family is undocumented.**

So for any question of the form *"what is the complete set of X?"* — env vars, settings keys, tools,
providers — **the vendored bundle is the denominator and the documentation is a subset of it.** Derive
guards from the bundle's own array and pin them with a test, rather than from an enumeration in prose.
Prose enumerations beside a single-source-of-truth list age silently: three sentences in this repo said
"five" after the list had grown.

**And the rule INVERTS where the bundle lags the docs — measured 2026-08-28, on a surface where trusting
the bundle would have under-implemented.** The vendored bundle was `2.1.223` when this was first written,
`2.1.233` after the 2026-09-03 lift — still five patch versions short of the `headers` surface — and is
`2.1.247` since P7.1 (2026-09-10), which is **past** it: entry `headers` and a `headersHelper` command form
are declared in `sdk.d.ts` at `0.3.247` in all five marketplace shapes, where `headersHelper` scored **0**
dts occurrences at `0.3.233`. So on THIS surface the direction has flipped and the bundle now leads what
this repo implements. **The example is spent; the rule is not** — the marketplace-entry surface it was
checked against had been 25 patch versions newer (`archive` as a source kind arrived in 2.1.224, entry
`headers` in 2.1.238), and the measurement that made the point was `literal("archive")` → **0** and
`x-forwarded` → **0** in the older bundle, with `Cookie` → 1 and `git-subdir` → 3 as the positive controls
that prove the probe reads the file. A guard derived from that bundle would have been **narrower than the
contract**, and a lane trusting "the bundle is the denominator" would have built to the older shape and
called it complete. Expect the next lag to be somewhere else: probe, do not assume the direction.

**But READ that version the right way — the obvious two ways are both wrong, and this section used one of
them (P6.543, re-measured 2026-09-07).** The version that governs behaviour is the one the runtime reports
about ITSELF; the SDK manifest is a packaging artefact that may or may not agree, and a grep of the binary is
not a reading at all.

- **The two self-reports, and today they AGREE.** Run both and quote both:
  ```sh
  grep -o '"claudeCodeVersion"[^,]*' node_modules/@anthropic-ai/claude-agent-sdk/package.json
  ./node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude --version
  ```
  → `"claudeCodeVersion": "2.1.247"` and `2.1.247 (Claude Code)` (re-measured 2026-09-10 after P7.1 lifted
  the bundle `0.3.233` → `0.3.247`; they said `2.1.233` on 2026-09-07 and agreed then too). The
  `claude_code_version` field of the `system`/`init` message a real run emits comes from the same place:
  inside the vendored binary the init object is built as
  `claude_code_version:{… VERSION:"2.1.247" …}.VERSION`, an inlined build constant that also carries
  `BUILD_TIME:"2026-08-26T05:55:19Z"` and `GIT_SHA:"89c726188daf6407b6b57bf67d312f2958e5b9f2"` — locate it
  with `grep -aob 'claude_code_version' <binary>` and read the bytes around the hit. (`BUILD_TIME` is the
  cheaper anchor: it sits in the same object literal and `grep -aob 'BUILD_TIME'` lands directly on it,
  where the first `claude_code_version` hit is inside a compressed table with no readable version beside it.)
- **Grepping the binary for a dotted version is NOT a probe of it.** Re-measured 2026-09-10 over the
  vendored darwin-arm64 `claude` at `0.3.247`: `2.1.247` → **1680** occurrences, `2.1.223` → **2**,
  `2.1.233` → **1**, `2.1.238` → **1**.
  ```sh
  B=node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude
  for v in 2.1.223 2.1.233 2.1.238 2.1.247; do printf '%s -> %s\n' "$v" "$(grep -ao "$v" "$B" | wc -l)"; done
  ```
  Zero does not mean "not that version" and 1680 does not mean "that version" — both are counts of build
  constants, changelog text and vendored strings that happen to spell a number. **The two non-zero
  NEIGHBOURS are the sharpest form of that warning**: the binary that self-reports `2.1.247` also spells
  `2.1.233` and `2.1.238`, the two versions this repo has most recently been wrong about, once each. And the
  headline number is not stable in either direction — it was 374 for `2.1.233` on 2026-09-07 and is 1680 for
  `2.1.247` today, a 4.5x move on a binary that SHRANK 24 %.
- **A version read on a rig OUTSIDE this repo is a version of some other package.** This row was born from a
  measurement that reported the vendored binary self-reporting `2.1.238`; when the tree held `0.3.233` that
  string occurred **zero** times in it and both its own `--version` and its inlined init constant said
  `2.1.233`. The reading is refuted; the nearest measured explanation is the out-of-repo-rig trap in §Traps
  below, where a sibling lane got SDK `0.3.238` auto-installed against the vendored `0.3.233` and nothing
  failed. That rig is gone, so what is recorded here is the refutation and the method — not a cause.
  (Re-read 2026-09-10 at `0.3.247`, where `2.1.238` now occurs **once**: the zero was a reading with a date,
  and quoting it as a standing fact would already be wrong. The refutation stands on the two self-reports,
  which is the whole point of this bullet's neighbour above.)

So the honest form of the rule is **the union, with the direction named**: the bundle is the denominator
for what the runtime *can already do* (an undocumented provider toggle is real and shippable); the
documentation is the denominator for what we *must be able to accept* (a documented field the bundle has
not caught up to is still the contract). **Check the bundle's declared version against the page before
deciding which side governs** — and when they disagree, say which one your guard was derived from.

