/**
 * Marketplace names reserved for official Anthropic use.
 *
 * `plugins/marketplace-reference.md#reserved-names` (re-pointed 2026-10-01, F1.1033:
 * the plugin-marketplaces page whose first required-fields heading held the Note
 * quoted below left the docs index; the quote is as read on that page):
 *
 *   "**Reserved names**: the following marketplace names are reserved for
 *   official Anthropic use and can't be used by third-party marketplaces:
 *   `claude-code-marketplace`, `claude-code-plugins`, `claude-plugins-official`,
 *   `claude-plugins-community`, `claude-community`, `anthropic-marketplace`,
 *   `anthropic-plugins`, `agent-skills`, `anthropic-agent-skills`,
 *   `knowledge-work-plugins`, `life-sciences`, `claude-for-legal`,
 *   `claude-for-financial-services`, `financial-services-plugins`,
 *   `first-party-plugins`, `healthcare`. Names that impersonate official
 *   marketplaces, such as `official-claude-plugins` or `anthropic-plugins-v2`,
 *   are also blocked. Reserving these names prevents a third-party marketplace
 *   from presenting itself as an Anthropic-published source."
 *
 *   "Claude Code re-checks reserved names every time it loads a marketplace, not
 *   only when you add one. A marketplace that was registered under one of these
 *   names before the name became reserved stops loading and reports that it is
 *   [registered from an untrusted source]. Remove that marketplace and re-add it
 *   from the official Anthropic source."
 *
 * WHICH SIDE THIS GUARD IS DERIVED FROM: the DOCUMENTATION, not the vendored
 * bundle. The rule inverts here in the direction AGENTS.md names — the bundle is
 * the denominator for what the runtime can already do, the page is the
 * denominator for what we must be able to REFUSE. The vendored SDK declares
 * `claudeCodeVersion 2.1.223` while the page's own Note dates part of this list
 * to v2.1.205 and the reservation surface has moved since; a list derived from
 * the bundle would be narrower than the contract. So the sixteen names below are
 * transcribed from the page, verbatim and in the page's order.
 *
 * TWO RESIDUES, recorded rather than invented (owner rule: where the
 * documentation is silent, decide TRANSPARENT and SIMPLE):
 *
 *  1. The page states the impersonation rule and gives two examples; it
 *     publishes no algorithm. {@link canonicalMarketplaceName} is the smallest
 *     rule that covers both published examples and nothing else — token-multiset
 *     equality after dropping a trailing version token. It deliberately does NOT
 *     catch supersets (`acme-anthropic-plugins`), near-miss spellings
 *     (`claude-plugins-oficial`), or Unicode confusables. Those are unclosed and
 *     named here rather than guessed at, because a wider rule would refuse
 *     legitimate corporate names — `my-anthropic-plugins-mirror` is a mirror,
 *     not an impersonation — and a rule that refuses honest names is one
 *     operators route around.
 *  2. The page's exemption is "official Anthropic use", and this fork can name
 *     exactly one official source (`anthropics/claude-plugins-official`, via
 *     `isOfficialAnthropicMarketplaceSource`). The other fifteen names have no
 *     source this fork can recognise, so a genuinely official marketplace under
 *     one of them would be refused here. That branch is unreachable in practice:
 *     nothing in this fork registers an official Anthropic marketplace (see the
 *     block comment on `OFFICIAL_ANTHROPIC_MARKETPLACE_NAME`), and the refusal
 *     names the colliding reservation, so an operator who ever meets it can see
 *     exactly what happened.
 *
 * THE POSTURE, stated rather than left silent. The earlier reading of this gap
 * weighed enforcement against the rebrand — a fork whose users may never see an
 * Anthropic marketplace carries less of this risk — and left the decision
 * unmade, which is how it ended up recorded in a single apologetic docblock and
 * nowhere else. It is made here: Nessy ENFORCES the reservation. This fork ships
 * Claude Code as a runtime and lets any user add any marketplace source, so the
 * impersonation the page describes is reachable on a Nessy workstation exactly
 * as it is upstream. The price is a real one and it is paid knowingly: an
 * internal marketplace whose label happens to canonicalise onto one of the
 * sixteen — `healthcare` and `agent-skills` are ordinary words — must be added
 * under a different name. The refusal names the collision and says so, so the
 * cost lands as an instruction rather than as a mystery.
 *
 * ---------------------------------------------------------------------------
 * P2.430 — THE SECOND RESERVATION, AND WHY THIS FORK IS NEITHER OF ITS TWO
 * SURFACES. A different rule with a different owner, kept next to the first so
 * whoever reaches for one meets the other.
 *
 * `plugins/marketplace-reference.md#validation-messages`, under the section's
 * "Warnings (non-blocking)" list, verbatim:
 *
 *   "`Marketplace name "x" is reserved in Claude Desktop`: the marketplace is
 *   named `org`, `org-provisioned`, or `unknown`, in any casing. Claude Code
 *   accepts these names, but Claude Desktop's managed marketplace sync rejects
 *   the whole marketplace. Rename the marketplace. Before v2.1.221,
 *   `claude plugin validate` didn't run this check."
 *
 * (Re-pointed 2026-10-01, F1.1033: the validation-errors section this quoted left
 * the docs index with its page; today's table row reads "`name` is `org`,
 * `org-provisioned`, or `unknown`. Claude Desktop rejects the marketplace".)
 *
 * ONE SENTENCE, TWO SURFACES, AND THEY HAVE DIFFERENT OWNERS. That split is the
 * whole reason this reservation is handled differently from the sixteen above:
 *
 *   - the ENFORCER is Claude DESKTOP's managed marketplace sync, which rejects
 *     the whole marketplace;
 *   - the REPORTER is `claude plugin validate`, which since v2.1.221 emits a
 *     non-blocking WARNING when pointed at a marketplace DIRECTORY;
 *   - and Claude CODE — the runtime this fork ships, and the runtime whose
 *     add/load semantics the gates below imitate — ACCEPTS all three names.
 *
 * NESSY IS NEITHER SURFACE. Written down because "decided not to" and "never
 * noticed" are indistinguishable from outside, and this fork's largest defect
 * class is exactly that confusion:
 *
 *  1. NOT the managed-sync surface. The rejecting mechanism is keyed on a
 *     Claude Desktop managed setting the page never names. The shipped binary
 *     does: "the Claude Desktop managed marketplace sync
 *     (allowedPluginMarketplaces) will reject the whole marketplace".
 *     `allowedPluginMarketplaces` scored 0 in this repo before this block was
 *     written — every hit a `git grep` finds now is one of these paragraphs or
 *     its test, which is why the claim is dated rather than standing — and 0 across
 *     `plugin-marketplaces.md`, `settings-reference.md`, `managed-settings.md`,
 *     `plugins-reference.md`, `plugins.md` and `discover-plugins.md` — with
 *     `extraKnownMarketplaces` (12 on the page, 13 files here) as the positive
 *     control proving both probes read something. Widened to the WHOLE corpus
 *     for P2.442 below, it is still 0: 0 files and 0 hits across all 191 pages
 *     of `scripts/claude-doc-pages.tsv`, against `extraKnownMarketplaces` at 14
 *     files / 52 hits and `strictKnownMarketplaces` at 11 / 50. This fork has no Claude
 *     Desktop integration of any kind; its managed marketplace delivery is
 *     Claude CODE's `extraKnownMarketplaces`/`strictKnownMarketplaces`, a
 *     different mechanism in a different product. No name this registry records
 *     ever reaches the sync that does the rejecting.
 *  2. NOT the validate surface. The page emits the warning from
 *     `claude plugin validate` run against a marketplace DIRECTORY. This fork's
 *     `nessy-general-agent plugin validate` is `createPluginBundleValidator`,
 *     which takes a `PluginInstallSource` and checks a PLUGIN BUNDLE —
 *     `plugin.json`, skill/agent/command frontmatter, `hooks/hooks.json`. It
 *     has no marketplace-directory mode, so a marketplace `name` is never in
 *     its scope to warn about.
 *
 * SO NOTHING IS ENFORCED FOR THESE THREE, AND ENFORCING THEM HERE WOULD BE A
 * DEFECT RATHER THAN A STRICTER FORK. The gates below stand in front of
 * `add()`, load and managed delivery — the Claude CODE positions — and the
 * page's own sentence says Claude Code accepts these names. A refusal there
 * would reject a name a supported surface accepts, in the name of a product
 * this fork does not talk to. `org` is also an ordinary word: a corporate
 * marketplace delivered as `org` is a plausible thing to exist. The three names
 * are pinned as deliberate NON-refusals in
 * `__tests__/reserved-marketplace-names.test.ts` — at the predicate, at `add()`
 * and at managed delivery — so the gap cannot be mistaken for an oversight, and
 * cannot be closed by accident.
 *
 * WHICH SIDE THIS VERDICT CAME FROM, and here the version direction does NOT
 * invert the way it does for the sixteen above. The check landed in
 * `claude plugin validate` at v2.1.221 and the vendored SDK declares
 * `claudeCodeVersion 2.1.223`, so the bundle LEADS the reservation rather than
 * lagging it — and the shipped native binary carries the whole surface, which
 * is what makes the ownership readable rather than inferred. Probed on
 * `@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`, as LINES then
 * OCCURRENCES — `grep -c` counts newline-delimited chunks and `grep -o | wc -l`
 * counts matches, and on a 250 MB binary the two are not the same number:
 * `is reserved in Claude Desktop` 2/2, `org-provisioned` 2/3, `not accepted by
 * Claude Desktop` 3/4, `is not kebab-case` 2/2, `allowedPluginMarketplaces`
 * 3/6, with `impersonates an official` 2/2, `claude-plugins-official` 14/20 and
 * `git-subdir` 12/34 as positive controls. The list recorded here first carried
 * one column and mixed the two instruments inside it (`allowedPluginMarketplaces`
 * 3 was lines, `org-provisioned` 3 was occurrences), so the numbers were not
 * commensurable with each other. Both columns are kept because the ratio is
 * itself the finding: this binary carries every user-visible string TWICE, once
 * in a string-table region and once in the embedded JS source — the six
 * `allowedPluginMarketplaces` hits sit at bytes 128913434/128913703/128931303
 * and 254661658/254661988/254662679, three per region. In the JS core
 * (`sdk.mjs`) all four Desktop-compat strings score 0 while `impersonates an
 * official` and `claude-plugins-official` score 1 each — so the check lives in
 * the native binary only. The rule comes from the PAGE (who owns which half);
 * the MECHANISM is confirmed against the binary (the exact triple, and the
 * settings key the page omits). They agree.
 *
 * NATIVE-FIRST, asked before deciding rather than after: the runtime already
 * has this mechanism and it is `claude plugin validate`'s. There is nothing to
 * enable in this registry, because this registry is not the surface the
 * mechanism guards. The rest of that question is answered in the P2.443 block
 * below, where it turned out that one of the three warnings DOES land on a
 * surface this fork owns.
 *
 * THE SIBLING WARNINGS IN THE SAME LIST are recorded below rather than here,
 * because the claim this paragraph used to make — same owners, same verdict —
 * is true of the owners and FALSE of the verdicts, and measuring which is which
 * is what P2.443 did.
 * ---------------------------------------------------------------------------
 * P2.442 — `allowedPluginMarketplaces`: WHAT IT ACCEPTS, AND WHY NO OPERATOR OF
 * THIS FORK CAN EVER BE SUBJECT TO IT. The key P2.430 found above is recorded
 * here rather than left as a number in a plan row, because an undocumented key
 * nobody has ruled on is indistinguishable from one nobody noticed.
 *
 * WHICH SIDE THIS CAME FROM: the BUNDLE, and only the bundle, because the
 * documentation does not speak at all. `allowedPluginMarketplaces` scores 0
 * files / 0 hits across ALL 191 pages of `scripts/claude-doc-pages.tsv`
 * (2026-08-25 snapshot), and so does every other spelling of the shape —
 * `[A-Za-z]*PluginMarketplace[a-zA-Z]*` matches nothing in the corpus.
 * Positive controls on the same 191 files: `extraKnownMarketplaces` 14 files /
 * 52 hits, `strictKnownMarketplaces` 11 / 50, and 38 pages do discuss "Claude
 * Desktop" — so the corpus is neither empty nor silent about that product. It
 * simply never names this key. `managed-settings.md` and
 * `server-managed-settings.md`, the two pages a managed key would live on,
 * carry `strictKnownMarketplaces` and `blockedMarketplaces` and not this one.
 * (HALF OF THAT LAST SENTENCE WAS WRONG, corrected by P2.467 on a
 * re-measurement of the same two pages: `server-managed-settings.md` carries
 * NEITHER key — 0 hits for both — while `managed-settings.md` carries
 * `strictKnownMarketplaces` 2 and `blockedMarketplaces` 1, and the page that
 * actually defines both is `settings-reference.md` at 18 and 7. The verdict on
 * `allowedPluginMarketplaces` is untouched; what was false was the claim about
 * where its siblings live, which is the half a reader would rely on to find
 * them.)
 *
 * WHAT IT ACCEPTS — the honest answer is that the shipped runtime does not tell
 * us, and cannot, because it never reads the key. All six occurrences in
 * `@anthropic-ai/claude-agent-sdk-darwin-arm64/claude` sit INSIDE warning
 * message text, parenthesised: "the Claude Desktop managed marketplace sync
 * (allowedPluginMarketplaces) will reject the whole marketplace". Probed for the
 * shape a reader would have — `allowedPluginMarketplaces` followed by `:` or
 * `=`, i.e. an object key or an assignment target — the count is 0, against a
 * control of 5 for `extraKnownMarketplaces` (3 `:`, 2 `=`) on the same binary.
 * So the runtime we ship QUOTES this key; it does not consult it. Its shape and
 * its accepted values belong to Claude Desktop, a different product whose
 * documentation is outside this corpus. Recorded as a null rather than guessed
 * at: we could not find what it accepts, and the reason is that the thing that
 * would tell us is not the thing we vendor.
 *
 * MEASURED, not inferred: `claude plugin validate .` run against a marketplace
 * directory named `org` emits the warning WHETHER OR NOT any such key is set —
 * there is no managed policy on the probe machine at all. The warning is
 * unconditional advisory text about another product's behaviour, which is the
 * strongest available evidence that the validate surface does not read it
 * either.
 *
 * THE VERDICT: NO. An operator of this fork can never be subject to
 * `allowedPluginMarketplaces`, for two independent reasons, and either alone
 * would be enough. (1) The runtime this fork ships does not read it. (2) The
 * product that does read it — Claude Desktop's managed marketplace sync — has
 * no integration here of any kind; this fork's managed marketplace delivery is
 * Claude CODE's, and the whole of it is `MarketplaceRegistrySourceOptions` in
 * `registry-source.ts`: `strictKnownMarketplaces` narrows admission,
 * `extraKnownMarketplaces` delivers, `pluginSuggestionMarketplaces` gates
 * suggestion surfacing. That is the closed set, and the enumeration is worth
 * having exactly because a fourth documented key sits outside it —
 * `blockedMarketplaces` (`plugins-reference.md` § `plugin init`) is named in one
 * comment in `plugins/types.ts` and read by nothing, which belongs to whoever
 * owns managed-policy coverage and is recorded here only so the set above is not
 * mistaken for complete coverage of the documented keys. A managed settings blob
 * that also carries `allowedPluginMarketplaces` restricts nothing here, which is
 * pinned in `__tests__/reserved-marketplace-names.test.ts` rather than asserted.
 *
 * THE RESIDUAL, stated because native-first requires the leftover difference to
 * be uniform or HONEST: a marketplace this fork accepts under a name Desktop
 * rejects stays accepted here and would fail to sync for a Desktop operator
 * elsewhere in the same organisation. That is a cross-product divergence, not a
 * Nessy defect, and nothing in this registry can close it — the rejecting side
 * is the side we do not ship. See the P2.443 block for who can see it and with
 * what.
 * ---------------------------------------------------------------------------
 * P2.443 — WHO RUNS THE VALIDATE VERB, AND AGAINST WHAT. The product question
 * the row put before the implementation one, answered by measurement, with one
 * of its premises refuted.
 *
 * THE VERB IS ALREADY SHIPPED, AND IT ALREADY WORKS. Asked before building
 * anything, because native-first says configure before construct:
 * `@anthropic-ai/claude-agent-sdk-darwin-arm64/claude` — a dependency of this
 * repo, in this repo's own `node_modules` — advertises
 * `validate [options] <path>   Validate a plugin or marketplace manifest`.
 * Measured live against a throwaway marketplace directory named `org` holding
 * entries `My_Plugin` and `-bad-start`: seven warnings, all five documented
 * kinds among them, offline, no auth, exit 0, "Validation passed with
 * warnings". So there is no marketplace-directory validate mode to port. The
 * mechanism exists, on disk, in this fork's own dependency tree.
 *
 * WHO RUNS IT: a marketplace or plugin AUTHOR. AGAINST WHAT: a directory they
 * own. Both halves matter, because the marketplace half has neither here —
 * nothing in this fork authors a marketplace manifest. The only write of a file
 * called `marketplace.json` in the tree is `writeMarketplaceMetadataSnapshot`
 * in `plugins/acquisition.ts`, an internal provenance snapshot
 * (`schemaVersion` / `capturedAt` / `marketplace` / `origin`) that is not a
 * `.claude-plugin/marketplace.json` and never reaches a validator. Control on
 * the same probe: eighteen files READ `marketplace.json`. So this fork consumes
 * marketplaces and does not publish them, and a marketplace-name warning has no
 * runner and no target here.
 *
 * THE PREMISE THAT WAS WRONG, and it is the whole reason this block is not a
 * one-line refusal. The row read all three cross-product warnings as belonging
 * to a marketplace-DIRECTORY mode. MEASURED on the shipped binary, one fixture
 * per run, `claude plugin validate .` pointed at a bare PLUGIN directory — a
 * `.claude-plugin/plugin.json` with no marketplace anywhere — still warns
 * `Plugin name "My_Plugin" is not kebab-case`. That is this fork's
 * `createPluginBundleValidator` surface exactly. The ownership table, measured
 * rather than read off the page's section headings:
 *
 *   `Marketplace name "x" is reserved in Claude Desktop`
 *       from `marketplace.json`'s `name` -> Desktop sync rejects the WHOLE
 *       marketplace. NOT our surface.
 *   `Marketplace name "x" is not accepted by Claude Desktop`
 *       from `marketplace.json`'s `name` -> rejects the WHOLE marketplace.
 *       NOT our surface.
 *   `Plugin name "x" is not accepted by Claude Desktop`
 *       from the ENTRY's `plugins[N].name` -> SILENTLY DROPS THAT ENTRY, and
 *       not the marketplace. NOT our surface.
 *   `Plugin name "x" is not kebab-case`
 *       from `plugin.json`'s own `name` -> the claude.ai marketplace sync
 *       rejects it. OURS, and now implemented.
 *
 * Two things in that table were wrong in the paragraph above before it was
 * measured. The plugin-entry warning's consequence is NOT "rejects the whole
 * marketplace" — the page says the sync "rejects a marketplace whose name fails
 * the check and silently drops a plugin entry whose name does", and the binary
 * agrees with two distinct strings ("will reject the whole marketplace" vs
 * "will drop this entry"). And the Desktop CHARSET check never fires from a
 * plugin directory at all: measured, `my$plugin` (outside Desktop's charset) and
 * a 201-character name (past Desktop's 128) produce only the kebab warning or
 * nothing.
 *
 * SO: ONE WARNING BUILT, THREE DECLINED, AND BOTH DECISIONS ARE STATED.
 *  - BUILT: `pluginIdKebabCaseDiagnostics` in `plugins/management-service-v2.ts`,
 *    on the validate path only, so the install path is untouched. It carries its
 *    own reasoning: the RULE from `plugins-reference.md`'s `plugin.json` `name`
 *    row ("Unique identifier in kebab-case"), the SEVERITY from the binary
 *    (non-blocking, exit 0), the exact shape probed rather than guessed, and
 *    `id` rather than `name` because upstream's single field is the identifier
 *    and a Nessy-native manifest's `name` is a caption.
 *  - DECLINED: a marketplace-directory validate mode. No runner, no target, and
 *    the runtime already ships the verb. This is a decision and not a backlog
 *    item; anyone who revisits it should first find the author it serves.
 *
 * WHICH SIDE THIS CAME FROM — and unusually, BOTH, in opposite directions on the
 * same page. The bundle LEADS the page on scope: the page files the kebab-case
 * bullet under § Marketplace validation errors, and the binary emits it with no
 * marketplace present, so the page UNDER-describes the check and a guard derived
 * from the section heading alone would have put it in the wrong place — which is
 * precisely what P2.430 concluded from the page alone. The page LEADS the bundle
 * on content: `plugin-marketplaces.md` documents
 * `Marketplace name cannot contain control or bidirectional-formatting
 * characters` as a BLOCKING error landing at v2.1.247, and that string scores 0
 * in a bundle declaring `claudeCodeVersion 2.1.223` (positive control on the
 * same probe: `impersonates an official` 2). Neither side is the authority on
 * its own; the rule came from the page and the scope and severity from the
 * binary.
 *
 * ONE MEASURED DIVERGENCE LEFT OPEN, recorded because absorbing it silently is
 * the failure this file exists to prevent: `-my-plugin` draws a non-blocking
 * kebab warning upstream and a hard `plugin.manifest.invalid_id` ERROR here. It
 * is not this row's to change — a Nessy plugin id reaches filesystem paths and
 * store keys, which upstream's name does not — and it belongs to whoever owns
 * plugin identifiers. Pinned as a ledger row in
 * `plugins/__tests__/bundle-validation.test.ts` so it stays visible.
 * ---------------------------------------------------------------------------
 * P2.467 — `blockedMarketplaces`: THE ANSWER CAME OUT THE OPPOSITE WAY FROM ITS
 * NEIGHBOUR'S, ON BOTH QUESTIONS. Recorded here beside P2.442 because the two
 * keys look like a pair and are not one, and reading the P2.442 verdict as
 * covering both is the mistake this block exists to prevent.
 *
 * THE SEMANTICS, from `settings-reference.md#blockedmarketplaces` — the heading
 * is published exactly once on the rendered page (`id="blockedmarketplaces"`,
 * one of 2204 ids, no `-2` twin), so it needs no byte-offset disambiguation the
 * way `#required-fields` did. Verbatim:
 *
 *   "Block plugin marketplace sources for your organization. Claude Code checks
 *   the blocklist on marketplace add and on plugin install, update, refresh, and
 *   auto-update, so a marketplace someone added before you set the policy can't
 *   be used to fetch plugins either. Blocked sources are checked before download,
 *   so they never touch the filesystem."
 *
 * and its type: "array of marketplace source objects, in the same forms as
 * `strictKnownMarketplaces`".
 *
 * WHICH SIDE THE GUARD IS DERIVED FROM: the DOCUMENTATION, and here the
 * denominator rule points the OPPOSITE way from P2.442's. That key is in 0 of
 * the 191 corpus pages, so the bundle was the only witness and governed. This one
 * is in SEVEN of them — measured 2026-08-31 over every page of
 * `scripts/claude-doc-pages.tsv`, case-sensitively, 18 hits:
 * `settings-reference.md` 7 (the definition), `changelog.md` 4,
 * `plugin-marketplaces.md` 3, and one each in `plugins-reference.md`,
 * `managed-settings.md`, `claude-apps-gateway-config.md` and `admin-setup.md`,
 * with `server-managed-settings.md`, `plugins.md` and `discover-plugins.md` at 0.
 * The same rig reproduces P2.442's own controls to the digit —
 * `strictKnownMarketplaces` 11 files / 50 hits, `extraKnownMarketplaces` 14 / 52,
 * `allowedPluginMarketplaces` still 0 / 0, `zzzNotARealKeyXQ` 0 / 0 — which is
 * what makes this count comparable with that one rather than merely adjacent to
 * it. (Case matters and in the tolerable direction: `grep -aoi` scores 20 rather
 * than 18, the two extra being lowercase `#blockedmarketplaces` link anchors.)
 * So `AGENTS.md`'s union rule applies in its other direction: the documentation is
 * the denominator for what we must be able to ACCEPT. Three of the rules
 * transcribed into `matchesBlockedMarketplaceEntry` postdate the vendored
 * bundle's declared `claudeCodeVersion 2.1.223` — owner wildcards at v2.1.223,
 * the `url`-entry check against cloned repository URLs at v2.1.232, the
 * `hostPattern` narrowing at v2.1.234 — so a guard derived from the bundle would
 * have been narrower than the contract.
 *
 * THE BINARY DOES READ IT, which is the finding that inverts P2.442's. The
 * reader-shape probe P2.442 built, run on
 * `@anthropic-ai/claude-agent-sdk-darwin-arm64/claude` — the name followed by
 * `:` or `=`, i.e. an object key or an assignment target, rather than a bare
 * occurrence count:
 *
 *   | string                      | occurrences | reader-shape (`:` + `=`) |
 *   | --------------------------- | ----------- | ------------------------ |
 *   | `blockedMarketplaces`       | 21          | 8                        |
 *   | `strictKnownMarketplaces`   | 30          | 8   (live control)       |
 *   | `extraKnownMarketplaces`    | 45          | 5   (live control)       |
 *   | `allowedPluginMarketplaces` | 6           | 0   (P2.442's verdict)   |
 *   | `zzzNotARealKeyXQ`          | 0           | 0   (negative control)   |
 *
 * and the read is not inferred from the count — the reader itself is legible:
 * `function Wfr(){let e=$r("policySettings");if(!e?.blockedMarketplaces)return
 * null;return e.blockedMarketplaces}`, with a github matcher that lower-cases
 * both owners (`i.toLowerCase()===n.toLowerCase()`), strips a `.git` suffix, and
 * logs `Invalid owner-wildcard repo in policy settings blockedMarketplaces` for a
 * form other than `<owner>/*`. So the four "matching rules differ" rows of
 * `settings-reference.md#owner-wildcards` are confirmed against the mechanism and
 * not only read off the page.
 *
 * NATIVE-FIRST TIER 1, ASKED AND ANSWERED WITH A MEASUREMENT — and the answer is
 * that the native mechanism is UNREACHABLE from here, for two independent
 * reasons:
 *
 *  1. THE CHANNEL DROPS IT. The binary reads the key from `$r("policySettings")`,
 *     the OS-level managed-settings tier this fork does not write. The one channel
 *     we do have is `Options.managedSettings`, which the SDK filters
 *     restrictive-only through `Ebg` — the function
 *     `agent/claude-managed-settings.ts` transcribes. Probed over the 4000 bytes
 *     from `parentSettingsBehavior==="merge"`, `Ebg`'s copy set contains
 *     `deniedMcpServers` 3 times (positive control) and `blockedMarketplaces`
 *     ZERO. So a mapped value would be silently discarded — the same reason
 *     `strictKnownMarketplaces` is recorded there as `no-sdk-tier`.
 *  2. IT WOULD GUARD THE WRONG SURFACE, AND ONLY ONE RUNTIME OF THREE. What the
 *     binary's gate protects is the binary's own marketplace registry
 *     (`known_marketplaces.json`, `/plugin marketplace add`). A Nessy user's
 *     marketplace goes through `PluginRegistrySource` instead, which serves Pi,
 *     claude and codex from ONE construction at boot.
 *
 * So tier 2 applies — the host supplies it uniformly for all three — and the gate
 * sits in `registry-source.ts` beside the allowlist's, in the same three
 * positions the page names: `add()`, `upgrade()`, and the one place a catalog is
 * fetched. NOT a second enforcement point beside a working native one; the only
 * one that can fire here.
 *
 * WHAT AN ENTRY MATCHES ON: the SOURCE identity, never the display name. A
 * blocklist keyed on the label would be bypassable by construction — the label is
 * the field a user chooses freely at add time — whereas the reserved-name gate
 * above is keyed on the label precisely because impersonation is a claim made in
 * a label. Same identity classifier, opposite polarity, different field.
 *
 * THE PREMISE THAT WAS WRONG, and it changes what "fails open" means here. The
 * row reads the current state as "an administrator sets it, sees no error".
 * MEASURED: they do see one. `blockedMarketplaces` is not in
 * `MANAGED_PI_POLICY_KEYS`, so `refuseUnknownKeys` records a drop, and
 * `managed-settings.md#find-entries-claude-code-dropped` requires `doctor` to
 * list it with its source and field. What was wrong was the SENTENCE, not the
 * silence: it read `invalid managed Pi policy key: blockedMarketplaces`, which
 * sends an administrator who copied the key off the page hunting for a
 * misspelling that does not exist. P2.467 replaced it with one that says nothing
 * is blocked and names `strictKnownMarketplaces` as the control that works.
 *
 * WHAT IS STILL OPEN — two HANDOFFS rather than residues, both stopped on
 * because the files that would close them belong to other owners, and both
 * measured rather than assumed:
 *
 *  1. THE POLICY SCHEMA does not carry the key, so the gate's production feed is
 *     `createPluginRegistrySource`'s parameter and nothing sets it yet. Adding
 *     `blockedMarketplaces` to `MANAGED_PI_POLICY_KEYS` obliges a `no-sdk-tier` /
 *     `host-gate` entry in `CLAUDE_MANAGED_GAPS`
 *     (`agent/claude-managed-settings.ts`, whose mapper alarms on any key in the
 *     schema and in no mapping) plus an entry in four every-key fixtures.
 *  2. THE BANNER cannot name the blocklist. The load-path refusal deliberately
 *     reuses `marketplace.registry.source_not_allowed` rather than minting a
 *     fifth code: `plugin-registry-load-error.test.ts` extracts every
 *     `marketplace.registry.*` literal from `registry-source.ts` and requires
 *     each to be in the renderer's message table, whose values are locale keys.
 *     So a precise code costs one row in `apps/electron/src/renderer/pages/` and
 *     two locale strings. The entry IS named in the refusal an interactive add or
 *     refresh throws, in the delivery outcome, and in the log line.
 * ---------------------------------------------------------------------------
 *
 * This module is deliberately dependency-free so both the add gate and the load
 * gate can call it without dragging the managed-policy graph in.
 */

/**
 * The sixteen names, in the page's order. Lower-cased at the point of
 * comparison, never here — this array is the transcript.
 */
export const RESERVED_MARKETPLACE_NAMES = [
  'claude-code-marketplace',
  'claude-code-plugins',
  'claude-plugins-official',
  'claude-plugins-community',
  'claude-community',
  'anthropic-marketplace',
  'anthropic-plugins',
  'agent-skills',
  'anthropic-agent-skills',
  'knowledge-work-plugins',
  'life-sciences',
  'claude-for-legal',
  'claude-for-financial-services',
  'financial-services-plugins',
  'first-party-plugins',
  'healthcare',
] as const;

/**
 * A name's comparison form: lower-cased, split on every non-alphanumeric run,
 * trailing version tokens dropped, then SORTED and rejoined.
 *
 * Sorting is what makes `official-claude-plugins` collide with
 * `claude-plugins-official`; dropping a trailing `v2` / `2` is what makes
 * `anthropic-plugins-v2` collide with `anthropic-plugins`. Those are the page's
 * own two examples of an impersonating name, and this function is exactly as
 * wide as they require — see residue 1 in the module comment.
 *
 * Splitting on non-alphanumerics also means a derived `<owner>/<repo>` label
 * carries its owner as a token, so `evil/claude-plugins-official` canonicalises
 * to a four-token name that matches nothing. That is correct rather than
 * accidental: a label that shows the owner is not presenting itself as
 * Anthropic-published.
 */
export function canonicalMarketplaceName(name: string): string {
  const tokens = name.toLowerCase().split(/[^a-z0-9]+/u).filter(Boolean);
  while (tokens.length > 1 && /^v?\d+$/u.test(tokens[tokens.length - 1] ?? '')) tokens.pop();
  return [...tokens].sort().join('-');
}

/** Canonical form -> the reserved name it stands for, built once. */
const RESERVED_BY_CANONICAL = new Map<string, string>(
  RESERVED_MARKETPLACE_NAMES.map(reserved => [canonicalMarketplaceName(reserved), reserved] as const),
);

/**
 * The reserved name `candidate` collides with, or `undefined` when it collides
 * with none. Returns the RESERVED spelling rather than a boolean so the refusal
 * can name it: "reserved" is not actionable, "collides with
 * `claude-plugins-official`" is.
 */
export function reservedMarketplaceNameFor(candidate: string): string | undefined {
  const trimmed = candidate.trim();
  if (!trimmed) return undefined;
  return RESERVED_BY_CANONICAL.get(canonicalMarketplaceName(trimmed));
}
