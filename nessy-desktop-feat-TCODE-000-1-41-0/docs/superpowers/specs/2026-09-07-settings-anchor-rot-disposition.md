# The dead `settings.md:<line>` anchors — census, disposition, and a verified concordance

> **Operational, not historical.** Read this before converting any
> `settings.md:<line>` citation. It says which anchors are worth converting, which
> are deliberately frozen, and — for the most-cited ones — what the successor
> anchor and today's verbatim sentence actually are, so a converting lane copies a
> verified row instead of re-deriving one.

P2.285, measured by lane W8-doc2 on **2026-09-07** at `feat/TCODE-000`. It supersedes
every count written in prose about this problem — this tree has said 827, 828, 835,
767 and 772, each correct on the day it was written.

## 1. The rule, first, because it is the part that keeps being got wrong

`settings.md` **SPLIT** (measured 2026-08-25). It is now scope / precedence /
how-to-edit; the key-by-key reference is `settings-reference.md`; the managed-policy
invalid-value material is `managed-settings.md`; and some of it landed on
`server-managed-settings.md`. So every `settings.md:<line>` citation in this tree is
dead **at the page level**, and **renumbering cannot fix a single one of them.**

The conversion is `page.md` › `#<section>` **plus the verbatim sentence**, and only
for anchors a reader will actually follow. A section anchor is part of the page's
published link contract; a line number has a measured half-life of about two days.

## 2. The census — run it, do not quote it

```sh
R='[A-Za-z0-9_-]*settings\.md:[0-9]+(-[0-9]+)?'
git grep -ahoI -E "$R" | wc -l                       # occurrences
git grep -ahoI -E "$R" | sort -u | wc -l             # distinct citations
git grep -alI  -E "$R" | wc -l                       # files
git grep -ahoI -E "$R" | sed -E 's/:[0-9]+(-[0-9]+)?$//' | sort | uniq -c   # by page spelling
```

`git grep` is byte-honest here and a wrapped `grep -r` is not: the wrapped control
**timed out walking `node_modules`** when a previous pass ran it, and an earlier
comparison found it hiding 25 of 835 hits. Use `git grep -a`.

**Reading of 2026-09-07: 822 occurrences, 140 distinct citations, 172 files**, split
by page spelling as 754 `settings.md`, 64 `server-managed-settings.md`,
4 `managed-settings.md`.

| Bucket | Files | Occurrences | Disposition |
| --- | ---: | ---: | --- |
| `packages/**` source comments | 85 | **291** | **FOLLOWABLE** — a developer reading the comment follows the citation |
| `apps/**` source comments | 9 | **18** | **FOLLOWABLE** |
| `docs/architecture/**` | 1 | 2 | **FOLLOWABLE — already converted** (both carry a live anchor and name the dead one as history) |
| `docs/testing/` outside `cdp-runs/` | 1 | 1 | **FOLLOWABLE — already converted** (same shape) |
| `docs/superpowers/specs/data/**` | 43 | 235 | **FROZEN** — generated sweep artifacts; a regeneration would undo the edit anyway |
| `docs/superpowers/specs/*.md` | 17 | 168 | **FROZEN** — dated spec records |
| `docs/superpowers/plans/*.md` | 15 | 104 | **FROZEN** — plan rows (and the tracker, which no lane writes) |
| `docs/testing/cdp-runs/*.md` | 1 | 3 | **FROZEN** — dated run narratives |
| `AGENTS.md` | 0 | 0 | carries none |
| **total** | **172** | **822** | |

Followable: **312**, of which **309 are source comments** and 3 are live docs already
done. Frozen: **510**.

### Why the frozen buckets are frozen, and it is not laziness

A dated record cites what its author read **on that day**. Rewriting the citation
makes the record claim an anchor its author never followed, and the record then reads
as evidence for a page state nobody checked. The rule this tree already runs on is
*"a dated run narrative is a record, not a document — annotate, never rewrite"*; the
same reasoning covers sweep artifacts, spec records and plan rows. Generated files add
a second reason: the generator wins on the next run.

**What was deliberately left, by name:** everything under
`docs/superpowers/specs/data/`; the 17 dated spec records (largest:
`2026-08-02-claude-doc-sweep-worklist.md` 60, `2026-08-02-claude-doc-sweep-divergences.md`
23, `2026-07-29-deviation-register.md` 9 — itself generated —
`2026-07-25-nessy-claude-parity-audit.md` 8); the 15 plan files (largest:
`2026-07-29-deviation-unit-4.md` 27, `2026-07-29-doctor-surface.md` 22,
`2026-07-29-delivered-policy-enforcement.md` 12); and
`docs/testing/cdp-runs/2026-07-30--2026-08-17-run-narratives.md`.

## 3. The 309 source comments are the whole remaining job, and they are not a docs job

They live in `packages/**` and `apps/**` — product files. Each needs a section anchor
**and** a verified verbatim sentence, and a mechanical rewrite manufactures phantom
quotes at roughly the rate it fixes them (P2.191's measurement; §5 below re-measures
the same effect from the other side). That is why they are converted by the lane that
owns the file, one at a time, using §4.

## 4. The verified concordance

Every successor anchor below was verified against the **RENDERED** page on
**2026-09-07** — `curl -s https://code.claude.com/docs/en/<page>` (no `.md`) piped
through `grep -o 'id="[^"]*"'` — because a slug rule derived by hand is wrong often
enough to have cost this repo four false pins. Ordered by followable occurrences.

| Dead citation | occ. | Successor (rendered-verified) | Today's verbatim sentence |
| --- | ---: | --- | --- |
| `settings.md:241` | 21 | `settings-reference.md#availablemodels` | "Restrict which models people can select for the main session, subagents, skills, and the advisor." |
| `settings.md:886` | 16 | `settings-reference.md#extraknownmarketplaces` | "**Type**: object mapping a marketplace name to an object with a `source` object and an optional `autoUpdate` Boolean" |
| `settings.md:210` | 15 | **TWO successors — see §5.1** | — |
| `settings.md:260` | 14 | `settings-reference.md#disablebundledskills` | "Claude Code removes bundled skills and workflows entirely, while built-in commands such as `/init` stay typable but are hidden from the model." |
| `settings.md:251` | 14 | `settings-reference.md#cleanupperioddays` | "Setting `0` fails validation, so pick a large value such as `3650` for long retention." (with "**Type**: number of days, a whole number, minimum `1`" and "**Default**: `30`" as separate bullets) |
| `settings.md:212` | 14 | `managed-settings.md#keys-that-fail-closed` | "This tolerance applies only to managed settings. User, project, and local settings files remain strict: a file whose JSON or top-level shape fails validation is rejected as a whole and reported, and an individual entry that fails, such as a malformed permission rule, is skipped with a warning while the rest of the file applies." |
| `settings.md:186` | 12 | `managed-settings.md#invalid-entries-in-managed-settings` | **the quoted sentence NO LONGER EXISTS — see §5.2** |
| `settings.md:311` / `:312` | 11 | `settings-reference.md#requiredminimumversion`, `#requiredmaximumversion` | "`claude update`, `claude install`, and `claude doctor` keep working below the floor so users can recover." / "… keep working above the ceiling so users can recover." Fail-open behaviour: "`requiredMinimumVersion` and `requiredMaximumVersion` fail open by design: an invalid value is dropped rather than enforced." (`managed-settings.md#keys-that-fail-closed`) |
| `settings.md:196` | 11 | `managed-settings.md#keys-that-fail-closed` (the `availableModels` row) | "Enforced as an empty allowlist until fixed, so only the Default model is available; a non-string entry is stripped and the valid subset enforced." |
| `server-managed-settings.md:139` | 10 | `server-managed-settings.md#settings-precedence` | "Within the managed tier, Claude Code by default uses the first source that delivers at least one policy key, checking server-managed settings first and then endpoint-managed settings, apart from the exception keys covered next." |
| `settings.md:229` | 9 | `settings-reference.md#allowmanagedpermissionrulesonly` | "Make managed settings the only settings source of permission rules. Claude Code then ignores `allow`, `ask`, and `deny` rules in user, project, local, and `--settings` files, ignores `--allowedTools`, hides the always-allow choices in permission prompts, and stops saving new rules." |
| `settings.md:303` | 8 | `settings-reference.md#pluginsuggestionmarketplaces` | "A name takes effect only when the marketplace is registered on the machine and its registered source is also declared in the same managed settings, either as the `extraKnownMarketplaces` entry for that name or as an entry of `strictKnownMarketplaces`." |
| `settings.md:208` | 8 | `managed-settings.md#invalid-entries-in-managed-settings` | "[`claude doctor`](/docs/en/debug-your-config) lists each invalid entry with its source and field." |

Thirteen rows covering **fourteen** distinct citations (`:311` and `:312` share one row),
**164 of the 309** followable occurrences (53 %). The remaining 60
distinct citations are one to seven occurrences each and are converted the same way:
read what the citing comment quotes, find that material on the successor page, take
the nearest `##`/`###`/`####` heading, verify the id against the rendered page.

Anchors verified this pass, all present: `managed-settings#check-that-a-policy-is-in-force`,
`managed-settings#find-entries-claude-code-dropped`,
`managed-settings#invalid-entries-in-managed-settings` (an explicit `<span id>` a
rename left behind — the heading now reads *Find entries Claude Code dropped*),
`managed-settings#keys-that-fail-closed`, `settings-reference#availablemodels`,
`settings-reference#allowmanagedpermissionrulesonly`,
`settings-reference#cleanupperioddays`, `settings-reference#disablebundledskills`,
`settings-reference#extraknownmarketplaces`,
`settings-reference#pluginsuggestionmarketplaces`,
`settings-reference#requiredminimumversion`, `settings-reference#requiredmaximumversion`,
`server-managed-settings#settings-precedence`,
`server-managed-settings#invalid-entries-in-delivered-settings`.

## 4b. Thirteen more successors, derived and rendered-verified by the wave-11 lanes (2026-09-10)

Lane W11-c2 resolved these against the rendered pages (1 868 ids over the four pages) while converting
its 51; lane W11-c3 met the same ones. Copy them as §4 rows are copied — successor anchor plus today's
sentence found on the page — and never re-derive what is already here.

| Dead citation | Successor (rendered-verified 2026-09-10) |
| --- | --- |
| `settings.md` lines 786, 793, 798 | `settings-reference.md#enabledplugins` |
| line 608 | `settings-reference.md#what-runs-under-allowmanagedhooksonly` |
| lines 1169–1190 (1181, 1185, 1186) | `settings-reference.md#strictpluginonlycustomization` + `-skills` / `-agents` |
| line 413 | `settings-reference.md#sandbox-filesystem` |
| lines 414, 415, 416 | `#sandbox-filesystem-allowwrite` / `-denywrite` / `-denyread` |
| line 452 | `settings-reference.md#sandbox-path-prefixes` |
| lines 460–479 | `settings-reference.md#sandbox-filesystem` (the page's own JSON stanza) |
| lines 194, 195, 197, 199, 202 | `managed-settings.md#keys-that-fail-closed` (per-key rows) — **caveat:** 195/197 cited "a security switch read as `true`" without naming it, and today's table has FOUR "Treated as `true`" rows: name the table and all four, never guess a pair |
| line 200 | `settings-reference.md#invalid-credential-entries-in-managed-settings` |
| line 275 | `settings-reference.md#enforceavailablemodels` |
| line 712 | `settings.md#fix-a-broken-settings-file` |
| `server-managed-settings.md` lines 161–165 | `#fetch-and-caching-behavior` |
| `server-managed-settings.md` lines 187–189, 199 | `#enforce-fail-closed-startup` |

**And one measured trap in the id-extraction recipe (W11-c3, 2026-09-10):** `grep -o 'id="[^"]*"' | sed 's/id="//;s/"//'`
reported **825** ids for `settings-reference` and called `cleanupperioddays`, `disablebundledskills` and
`extraknownmarketplaces` ABSENT — three anchors §4 had verified two days earlier. Anchoring the second
substitution — `sed 's/id="//;s/"$//'` — gives **1 490** and all three present; the other three pages
were identical both ways, so the miscount read as page drift. §5.4's positive-control rule is what caught
it: run the control before believing an absence. Two more readings from that lane: `#cleanupperioddays`
states NO display requirement (the "paused sweep must be shown" claim was ours, not the page's), and four
dead sandbox anchors (binding rule, prefix table, `//path`, the Read/Edit contrast) collapse into the single
`#sandbox-path-prefixes` — §5.1 inverted.

## 4c. Three corrections to §4 itself, measured by lanes W11-c1 and W11-c4 (2026-09-10)

1. **`settings.md` line 251 is a SECOND two-successor citation, and the concordance carried one half.** The
   row above sends it to `settings-reference.md#cleanupperioddays` — right for the VALIDATION claim
   ("Setting `0` fails validation…"). The other claim the same line was cited for — the retention PAUSE,
   *"shows a warning in `/status` until you fix the file"* — is on **no** successor page in §4's list: it
   occurs on exactly one page of the 191-page index, `claude-directory.md#cleaned-up-automatically`,
   reworded to *"…until you fix the settings errors"*. Grep only the four successor pages and the sentence
   reads as deleted (control: `retention` → 0 on `settings.md`, 3 on `settings-reference.md`), and a lane
   would drop a live claim about a destructive sweep. **The absence denominator is the INDEX
   (`scripts/claude-doc-pages.tsv`), never four pages.** Fourteen followable occurrences; sites still to
   meet it include `packages/shared/src/config/storage.ts` and `retention-failsafe.isolated.ts`.
2. **The `server-managed-settings.md` line-139 row needs the quote-GONE mark that the line-186 row has.**
   Its old quote, *"Sources don't merge…"*, is on none of the four successor pages (0 hits; positive
   controls `no-merge rule` → 1 and `first source that delivers` → 1), so the natural copy — new anchor
   beside the old sentence — puts a sentence in this tree that no Claude page contains. Copy the
   successor (`#settings-precedence`) with TODAY's sentence only. One site outside the wave-11 zones still
   carries the old quote: `packages/shared/src/config/__tests__/managed-composition.test.ts` (the SDK
   lift lane's file).
3. **§5.3 gains three rewordings and §4 its first slash-bearing anchor.** Line 798 *cannot* → *can't*;
   lines 712 and 210 re-phrased — each present under new words while a grep calls it absent. And
   `managed-settings.md#read-the-source-in-/status` publishes a **slash** in its id: the hand-derived
   `read-the-source-in-status` is a 404 — the first live confirmation of AGENTS.md's "`/` survives" rule,
   and why the rendered page is curled rather than a slug guessed.

## 4d. The quote column is a READING, the anchor is the contract (W11-c5, 2026-09-10)

Three days after §4 was written its quotes had already moved while every anchor held: the line-886
row's sentence now reads *"When omitted, `claude-plugins-official` and most other official Anthropic
marketplaces default to `true`, and third-party marketplaces default to `false`."*, and the 311/312
recovery sentences sit under the two version entries. So: copy the ANCHOR from §4, and take the
sentence from the page on the day you convert — the quote column is dated 2026-09-07 and is not
re-stamped here. Two more shapes met by that lane: a citation whose CLASS has inverted on the page
(`claudeMd` delivered through managed settings *no longer* requires approval since v2.1.260 —
`server-managed-settings.md#security-approval-dialogs`; the host still classes it approval-requiring,
recorded as a dated posture rather than silently flipped), and three §5.2 sentences genuinely gone with
positive controls (`typo` → 0, `bad policy push` → 0, `plugin-provided` → 0).

## 4e. Nine more rows and a FIFTH page (W11-c6, 2026-09-10)

| Dead citation | Successor (rendered-verified 2026-09-10) |
| --- | --- |
| `settings.md` line 227 | `settings-reference.md#allowmanagedhooksonly` + `#what-runs-under-allowmanagedhooksonly` |
| line 251, the PAUSE / managed-override half | `claude-directory.md#cleaned-up-automatically` — *"When managed settings provide `cleanupPeriodDays`, Claude Code runs the sweep at the managed value in either case."* |
| line 315 | `settings-reference.md#respondtobashcommands` |
| line 385 | `settings-reference.md#permissions-defaultmode` (the dotted key hyphenates) |
| line 696 | `settings.md#lists-merge-instead-of-overriding` |
| line 312 at a site whose own words say *floor* / *minimum* | `settings-reference.md#requiredminimumversion` — §4's `#requiredmaximumversion` row would mis-cite it invisibly; read the SITE's claim, not only the line |
| `server-managed-settings.md` line 9 | the page's opening paragraph, above the first heading — it publishes NO id; cite the page and quote the sentence |
| `server-managed-settings.md` line 205 | `#enforce-fail-closed-startup` (the `claude auth` exemption sentence) |
| `server-managed-settings.md` lines 207–222 | `#security-approval-dialogs` + `#approval-memory` |

**The FIFTH page.** §4's probe fetched four pages; `claude-directory.md#cleaned-up-automatically` owns the
retention PAUSE, the `/status` warning and the managed-tier override — none of which is on the four — and
carries VERBATIM the sentence §5.3 recorded as absent (*"setting `0` fails with a validation error"*). So
one §5.3 row is really *present unchanged, on a page the probe did not read*: §5.4's near-miss recurring,
and the reason §4c says the absence denominator is the INDEX. It also qualifies §4b's reading that
`#cleanupperioddays` states no display requirement — right about that page, not about the corpus.

## 5. Four measured reasons a mechanical conversion fails

### 5.1 One dead line can have TWO live successors, on two different pages

`settings.md:210` is cited 15 times and the sites do not all mean the same thing.

- Sites citing the *check that the policy landed* half → `managed-settings.md#check-that-a-policy-is-in-force`: "Two commands on that machine answer it: `/status` shows which managed source Claude Code selected, and `claude doctor` lists what it dropped."
- Sites citing the *"on a test machine"* half → `server-managed-settings.md#invalid-entries-in-delivered-settings`: "Validate a payload change with `claude doctor` on a test machine before rolling it out to the organization."

A converter that picks one successor for the citation string mis-cites the other half,
**and neither error is visible in the diff.**

### 5.2 A quoted sentence can be GONE, not moved

`settings.md:186` is quoted in 12 source comments as *"A single typo cannot disable
the rest of your settings"*. The word **`typo` occurs 0 times** across all four
successor pages (positive control on the same rig: `tolerance` → 1). The material was
rewritten into the fail-closed table under
`managed-settings.md#invalid-entries-in-managed-settings`, which now states the
per-key fallback instead of the reassurance. **Converting those 12 comments must drop
the old quote, not re-anchor it** — carrying it forward would put a sentence in this
tree that no Claude page contains.

### 5.3 A sentence can survive with its words re-ordered, which reads as absent

Measured, all with positive controls on the same four pages:

| The comments quote | hits | What the page says now | hits |
| --- | ---: | --- | ---: |
| "only takes effect when" | 0 | "takes effect only when" | 1 |
| "removed entirely" | 0 | "removes bundled skills and workflows entirely" | 1 |
| "fails with a validation error" | 0 | "fails validation" | 3 |
| "accepts an optional" | 0 | "an optional `autoUpdate` Boolean" | 1 |
| "(Managed settings only)" | 0 | "**Scope**: `Managed`" bullet | — |

A grep-based verifier reports all five as **absent**, and all five are present. This
is the same class as §5.2 and the opposite verdict, so the two cannot be separated by
a grep — only by reading the section.

### 5.4 Absence needs a positive control, and this document nearly shipped one wrong

Searching for `test machine` across the fetched pages returned **nothing**, and the
first draft of §4 recorded `settings.md:210`'s second half as gone. It was not: the
sentence is on `server-managed-settings.md`, which had not been fetched yet when the
probe ran. The probe was right about the files it read and wrong about the world. Every
absence claim in this document now carries a positive control on the same rig, and §5.1
exists because of that near miss.

## 6. Residue, and who owns it

- **309 source-comment conversions** in `packages/**` (291) and `apps/**` (18), across
  94 files. They are product-file edits and belong to the lane that owns each file;
  this document is the input that makes each one a copy rather than a re-derivation.
  P2.285's own row note records 54 of them as P3.209's; that split was not re-measured here.
- **60 distinct citations** not yet in §4's concordance, 145 occurrences between them.
- Nothing in `docs/**` is owed: the three live-doc citations were converted by an
  earlier pass and re-verified here.
