/**
 * THE tokenizer for a TOOL-GRANT list field, on every path that reads one.
 *
 * SIX readers call it and none may have a copy:
 *
 * 1. a skill's `allowed-tools`/`disallowed-tools` (`parseSkillToolList`, which
 *    adds the absent-vs-empty distinction its enforcement path depends on),
 * 2. a Pi runtime agent's `tools`/`disallowedTools` frontmatter
 *    (`agent/pi-harness/runtime-agent-definition.ts`),
 * 3. a Claude plugin agent's `tools` (`plugins/format-adapters/claude.ts`),
 * 4. a Codex plugin agent's `tools` (`plugins/format-adapters/codex.ts`),
 * 5. a legacy Nessy-extension agent's `tools`
 *    (`plugins/format-adapters.ts:normalizeLegacyAgents`, whose bare comma split
 *    survived two sweeps because `?.split(',')` sat on its own wrapped line),
 * 6. and a USER's or workspace's own hand-written `agents/*.md`
 *    (`agents/definitions.ts:parseFrontmatterValue`, behind `loadAgentDefinitions`
 *    / `resolveAgentDefinition`) — found by a repo-wide sweep after the other
 *    five, and the most live of the six: it is the path an author's own file
 *    takes, with no plugin involved.
 *
 * Each call site's comment records why its format needs no other semantics.
 *
 * **Why it lives in `utils/` and not next to `splitMarkdownFrontmatter`.** It
 * used to live in `plugins/format-adapters/shared.ts`, on the reason that the
 * module already produces the string its readers consume ({@link
 * splitMarkdownFrontmatter} joins a YAML sequence on `', '`) and that every
 * reader already imported from there, "so the shared home costs no new edge".
 * Reader 6 falsified both halves. Measured 2026-08-12 on the import graph:
 * `format-adapters/shared.ts` reaches `agents/definitions.ts` in five hops
 * (`-> skills/storage.ts -> capabilities/runtime-skill-content.ts ->
 * capabilities/materializer.ts -> capabilities/resolver.ts`), so the import would
 * have been a CYCLE, not a new edge. And the weight is the second half:
 * `agents/definitions.ts` is a 7-module leaf whose only externals are `zod` and
 * `node:fs`/`node:path`, while `format-adapters/shared.ts` pulls a 292-module
 * closure including `@anthropic-ai/claude-agent-sdk`,
 * `@modelcontextprotocol/sdk`, `bash-parser`, `croner`, `gray-matter` and
 * `js-yaml`. `packages/pi-agent-server/src/orchestrator/*` imports
 * `agents/index.ts` by relative path, so that edge would have loaded the whole
 * plugin/capability/MCP stack into the Pi subprocess just to read one agent's
 * frontmatter.
 *
 * This module is therefore a zero-import leaf, which is the only shape all six
 * readers can share. `format-adapters/shared.ts` RE-EXPORTS it so readers 1-5
 * keep their existing import specifier — a re-export, not a copy: there is
 * exactly one function body below.
 *
 * Four rules, and the agent readers used to have only the last one (they split
 * on a bare comma) while the skill reader has had the first two since R17b:
 *
 * - Whitespace is a delimiter. `skills.md:259`/`:260`: both skill fields accept
 *   "a space- or comma-separated string, or a YAML list".
 * - A comma INSIDE a parenthesized specifier is not a delimiter. `Bash(a,b)` is
 *   one rule and `Agent(a, b)` is one grant; splitting either produced two
 *   fragments that can never match a tool. Measured on the signed 1.25.0 against
 *   the official `claude-security` plugin, whose agents declare
 *   `Agent(claude-security:scan-inventory, claude-security:scan-researcher)`:
 *   the subagent grant was shredded and then denied by omission, so the agent
 *   silently lost the one tool it was written around. On a `disallowedTools` /
 *   `disallowed-tools` field the same shredding is a permission HOLE rather than
 *   a lost grant — the fragments deny nothing, so what the author wrote down as
 *   forbidden runs.
 * - **A parenthesis inside a QUOTED ARGUMENT is payload, not structure** — the
 *   rule the depth scanner shipped without, and the one whose absence turned
 *   this fix into a second hole (see "Quotes", below).
 * - TRUNCATION MUST NEVER WIDEN (see "Truncation", below).
 *
 * A leading `[`…`]` is stripped: a YAML flow sequence survives the frontmatter
 * splitter as a raw scalar, and the brackets would otherwise glue themselves to
 * the first and last name. Quotes are stripped for the same reason.
 *
 * **TRUNCATION MUST NEVER WIDEN.** The tokenizer used to be one regex,
 * `/[^\s,()]+(?:\([^)]*\))?/g`, and a regex alternation cannot say "this entry
 * did not finish" — it can only fall back to a shorter match. Two ways that
 * produced a grant the author never wrote, both measured end to end on
 * 2026-08-25 before this scanner replaced it:
 *
 * - `allowed-tools: [- Bash(grep -rn " # TODO" *)]` is truncated by YAML at the
 *   ` #` — correctly, it IS a comment — to `Bash(grep -rn "`. The optional
 *   `\(…\)` group then failed to match for want of a `)`, `[^\s,()]+` ATE THE
 *   PARENTHESIS, and one careful entry exploded into `["Bash", "grep", "-rn"]`.
 *   A BARE `Bash` is the widest grant there is: `prerequisite-manager.ts`'s
 *   `skillGrantAllows` reads `if (!patterns) return true`, so the author of one
 *   narrow grep rule silently received blanket prompt-free shell.
 * - `Bash(echo (hi))` lost its trailing `)` to `[^)]*`, so the pattern arrived
 *   as `echo (hi` — a byte short of the call it was written to name.
 *   `runtime-skill-content.ts` documents and unit-tests the whole string
 *   (`parseSkillToolEntry('Bash(echo (hi))')` → `patterns: ['echo (hi)']`); it
 *   was the tokenizer upstream that never delivered it.
 *
 * So this is a depth-tracking SCANNER, not a matcher, and it obeys one
 * invariant: **it decides only WHERE entries are separated — it never edits an
 * entry's characters** (beyond the trim and the end-anchored quote strip). A
 * delimiter is a delimiter only at paren depth 0, so `Agent(a, b)` and
 * `Bash(echo (hi))` both survive whole; and an entry whose `(` never closes is
 * emitted WHOLE, keeping the unbalanced paren.
 *
 * Keeping the paren is the whole point, and the shape is not invented here —
 * `runtime-skill-content.ts`'s `SKILL_TOOL_ENTRY` already assumes it: "Anything
 * that does not close (`Bash(`) simply is not the parameterized form and falls
 * through to the bare branch, where it becomes a tool name no call can ever
 * equal." That parser was DESIGNED to fail closed on an unterminated grant;
 * eating the paren was what defeated it. One authored entry therefore yields at
 * most one entry here, never several, and an unparseable one degrades to a
 * grant that matches NOTHING rather than to a broader one.
 *
 * **QUOTES, and why counting parens without them was a hole of its own.** The
 * first depth scanner counted every `(` and `)`, including the ones inside a
 * quoted shell argument, so a parenthesis the author QUOTED opened a depth they
 * never opened and swallowed the rest of the list. Measured 2026-08-25 through
 * the real `PrerequisiteManager.checkPrerequisites`, before this pass:
 *
 * ```
 * disallowed-tools: Bash(grep "(" *), Write, Edit   denied bash+write+edit -> denied NOTHING
 * disallowed-tools: Bash(sed 's/(//g'), Write       denied bash+write      -> denied NOTHING
 * disallowed-tools: Bash(echo "("), Write           denied bash+write      -> denied NOTHING
 * ```
 *
 * Every paren the author typed was balanced; the only unmatched `(` was a
 * literal character inside a quoted argument. The suite pinned `Bash(echo ")")`
 * and never `Bash(echo "(")` — a one-character gap that hid the whole class.
 *
 * The rule that closes it, and the three conditions that keep it from becoming a
 * THIRD hole. Each condition below is one a MUTANT of this function violates and
 * a test then catches — the list is not decoration:
 *
 * - A quote is shell quoting only when it opens AT DEPTH > 0, i.e. inside a
 *   specifier. A quote at depth 0 is YAML wrapping of a whole entry, and the
 *   parens inside THAT are structure: `["Read", "Agent(a, b)", "Bash(git
 *   diff:*)"]` and the single scalar `"Bash(git add *) Bash(git commit *)"` both
 *   depend on it, and a rule that suppressed structure inside every quote
 *   shredded the first and merged the second.
 * - The partner search STOPS AT THE END OF THE SPECIFIER, which is the condition
 *   that makes an apostrophe safe. `Bash(echo don't), Read` keeps `Read` not
 *   because the lone `'` fails to find a partner — it may well find one three
 *   entries later — but because the `)` after `don't` leaves the specifier first.
 *   This is also why the search runs INSIDE the scan rather than as a pre-pass:
 *   a pre-pass that paired quotes globally let a YAML wrapping quote pair with a
 *   shell quote inside a specifier, and an unbounded in-scan search paired
 *   across entries; a 20 000-input structured differential caught the two of
 *   them collapsing 639 and 665 lists the old regex split correctly.
 *   (Corollary worth knowing before "simplifying" it: the search's OTHER exit,
 *   running out of field without a partner, is behaviourally unobservable —
 *   reaching the end means no `)` lowered the scan depth, so counting the tail
 *   and copying it verbatim leave the same characters and the same depth > 0.
 *   `exhausted` is therefore a linear-time guard, not a rule.)
 * - A backslash-escaped quote cannot be the PARTNER, so `Bash(echo "a\" (b" )`
 *   closes on the real quote rather than the escaped one and its `(` is payload.
 *   The escape is honoured for quote PARTNERS only: an escaped parenthesis still
 *   counts (as it always has), an escaped delimiter still delimits, and an
 *   escaped quote may still OPEN a run. That last asymmetry is deliberate — a
 *   `!escaped` test on the opener measured byte-identical to this over 120 000
 *   randomized inputs and all 79 adversarial rows, because the specifier bound
 *   already covers everything it would have, so it was removed rather than kept
 *   as a branch no test can reach.
 *
 * **THE RESIDUE, and the honest version of the trade.** After the quote rule,
 * every input whose quotes and parens balance tokenizes exactly as it always
 * did, on both fields. What is left is an entry with a genuinely unterminated,
 * unquoted `(` — the shape YAML's ` #` truncation produces — which swallows the
 * rest of the list. On `allowed-tools`/`tools` that is strictly safer: no grant
 * instead of a blanket one. On `disallowed-tools` it LOSES the denies that
 * followed, and the consequence was recorded wrongly here until 2026-08-25.
 *
 * The false sentence said a lost deny "falls back to the ORDINARY permission
 * flow … i.e. the user is asked". It is not one of the ordinary inputs: a
 * skill's `disallowed-tools` is one of the few floors that OUTRANKS
 * `bypassPermissions`. `checkPrerequisites` takes no permission mode at all,
 * `checkSkillDeniedTools` is unconditional, and the gate calls it at step 3 —
 * above every mode branch, with nothing but `block` returns between step 1 and
 * there. Measured end to end through the real `runPreToolUseChecks`, one skill
 * deny present versus the same deny lost:
 *
 * ```
 * tool   mode                deny present         deny lost
 * Bash   default             block(prerequisite)  prompt
 * Bash   acceptEdits         block(prerequisite)  prompt
 * Bash   auto                block(prerequisite)  ALLOW      <- silent
 * Bash   dontAsk             block                block
 * Bash   bypassPermissions   block(prerequisite)  ALLOW      <- silent
 * Write  acceptEdits         block(prerequisite)  ALLOW      <- silent
 * Write  auto/bypass         block(prerequisite)  ALLOW      <- silent
 * ```
 *
 * So "the user is asked" holds in `default` only (and for a non-write tool in
 * `acceptEdits`); in `auto` and `bypassPermissions` a lost deny is SILENT
 * EXECUTION, and it removes the last floor a user who chose those modes still
 * had. That is the real cost of this residue — not a prompt.
 *
 * It is still the only trade a tokenizer can make, and the reason is not
 * rhetorical: one token string cannot mean both "matches nothing" (fail-closed
 * for a grant) and "matches everything" (fail-closed for a deny), and this
 * function cannot see which field it serves. The tempting repair — re-emit the
 * swallowed tail as separate entries so the denies survive — reopens the exact
 * hole this file exists to close: `allowed-tools: Bash(sudo bash # x)` truncates
 * to `Bash(sudo bash`, whose tail is the bare word `bash`, i.e. blanket
 * prompt-free shell again. A field-AWARE fix belongs to the readers, which know
 * which field they are parsing and can refuse the skill outright on an
 * unterminated deny; it does not belong here.
 *
 * **On the empty list, which is NOT the same shape.** `tools: ,,,` (also `,`,
 * `""`, `''`) tokenizes to `[]`, and for the agent readers `[]` resolves to the
 * declared toolset's default — 7 tools including `bash`, `edit` and `write` on
 * `toolset: full` — byte-identical to omitting the field. That is not this
 * function's widening to close: a value made only of delimiters contains no
 * authored token to preserve, so `[]` is the correct tokenization, whereas
 * `tools: (` yields `["("]` because `(` IS a character the author typed. The
 * widening lives one layer down, in a DELIBERATE documented decision —
 * `agents/definitions.ts:normalizeExplicitStringList` maps an empty list to
 * "omitted" on `sub-agents.md:279` ("Inherits every tool available to subagents
 * if omitted"), the A1 decision — and only for the AGENT readers: the skill
 * reader keeps the distinction (`parseSkillToolList` returns `[]`, "present and
 * named nothing"). Changing that mapping is a reader-level decision against a
 * cited doc, not a tokenizer fix.
 *
 * **And it is LOUD, once.** A silent match-nothing grant is safer than a silent
 * blanket one and still leaves the author staring at a tool that will not run.
 * An unterminated `(` therefore writes a warning naming the entry, the ` #`
 * cause, and BOTH field consequences. The default sink is `console.warn` —
 * stderr in the desktop main process, the headless server AND the Pi subprocess
 * — copied deliberately from `config/managed-drops.ts:reportManagedPolicyDrops`,
 * which documents that same choice for the same reason. It is NOT routed to
 * `PluginDiagnostic` / `compatibility.adapter.warnings`: that field is persisted
 * with zero readers repo-wide (verified again on 2026-08-25 — every non-test hit
 * is the `.filter()` that writes it), and this module is a zero-import leaf on
 * purpose, so it cannot reach the plugin types without recreating the cycle the
 * header describes.
 *
 * "Once" is load-bearing, and it is why this leaf carries module state.
 * `loadAgentDefinitions` has NO cache: it re-reads and re-parses agent files per
 * subagent dispatch, per workflow step, per skill fork and per guardian consult.
 * Unbounded, one malformed field wrote a line per dispatch for the life of the
 * session, and because an unterminated `(` swallows the rest of the list the
 * line grew with the field — a 10 KB grant field measured a 10,227-character
 * single stderr line. So the entry is truncated for display and each distinct
 * message is written once per process, with the remembered set capped so the
 * dedupe cannot become the leak it prevents.
 */

/** How much of the offending entry the message may quote. */
const WARNING_ENTRY_CHARS = 120;

/**
 * How many distinct malformed entries the dedupe remembers before starting over.
 * A cap, not a cache: crossing it clears the set, so a long-lived process
 * re-reports rather than growing without bound.
 */
const WARNING_MEMORY_CAP = 64;

const reportedWarnings = new Set<string>();

/**
 * Forget which malformed entries have already been reported.
 *
 * The dedupe is per-process module state, so a test that asserts the warning
 * fires must start from a known one. Production has no reason to call this: the
 * whole point is that one malformed field does not write a line per dispatch.
 */
export function resetToolGrantWarningMemory(): void {
  reportedWarnings.clear();
}

/**
 * Where the quote opened at `openIndex` finds its partner INSIDE THE SAME
 * SPECIFIER, or `-1`.
 *
 * The specifier bound is the whole point. Shell quoting is a claim about the
 * inside of `Name(...)`, so the search gives up the moment the raw paren depth
 * would leave that specifier — which is what keeps the apostrophe in
 * `["Write(echo don't)", "Read(echo ')')"]` from pairing with a quote two
 * entries later and swallowing both. An unbounded search collapsed 665 of 20 000
 * structured differential inputs that the old regex split correctly; bounding it
 * takes that to zero while still recovering every quoted `(`.
 *
 * A backslash-escaped quote is not a partner, so `Bash(echo "a\"b")` closes on
 * the last quote rather than the escaped middle one. `exhausted` records the
 * index from which a quote character ran out entirely (scan reached the end of
 * the field), which is the only case where a later search could repeat the same
 * walk — so the scan stays linear on a field full of lone apostrophes.
 */
function partnerQuoteIndex(
  body: string,
  openIndex: number,
  quote: string,
  depth: number,
  exhausted: Map<string, number>,
): number {
  const known = exhausted.get(quote);
  if (known !== undefined && openIndex >= known) return -1;
  let scanDepth = depth;
  for (let index = openIndex + 1; index < body.length; index += 1) {
    const char = body[index];
    if (char === '\\') {
      index += 1;
      continue;
    }
    if (char === quote) return index;
    if (char === '(') scanDepth += 1;
    else if (char === ')') {
      scanDepth -= 1;
      // Left the specifier before finding a partner: not shell quoting.
      if (scanDepth < 1) return -1;
    }
  }
  exhausted.set(quote, openIndex);
  return -1;
}

export function splitToolGrantList(
  value: string,
  options: { warn?: (message: string) => void } = {},
): string[] {
  const trimmed = value.trim();
  const body = trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed;
  const entries: string[] = [];
  const exhaustedQuotes = new Map<string, number>();
  let current = '';
  let depth = 0;
  const flush = (): void => {
    const entry = current.trim().replace(/^['"]|['"]$/g, '');
    if (entry) entries.push(entry);
    current = '';
  };
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index]!;
    // A quote that OPENS INSIDE a specifier is shell quoting, so everything up
    // to its partner is payload: copied verbatim, with any `(` or `)` in it left
    // uncounted. At depth 0 the same quote is YAML wrapping and the parens
    // inside it are structure, so this deliberately does not fire there — and a
    // quote with no partner falls through to being an ordinary character.
    if (depth > 0 && (char === '"' || char === "'")) {
      const partner = partnerQuoteIndex(body, index, char, depth, exhaustedQuotes);
      if (partner !== -1) {
        current += body.slice(index, partner + 1);
        index = partner;
        continue;
      }
    }
    // Depth 0 is the ONLY place a delimiter delimits. Inside a specifier a
    // comma and a space are payload — that is rule two, and it is now enforced
    // by the depth rather than by a `[^)]*` that stops at the first `)`.
    if (depth === 0 && (char === ',' || /\s/.test(char))) {
      flush();
      continue;
    }
    if (char === '(') depth += 1;
    // A `)` with nothing open is kept as an ordinary character rather than
    // dropped: `parseSkillToolEntry` anchors on the LAST `)`, so handing it the
    // author's bytes verbatim is what lets its own greedy rule decide.
    else if (char === ')' && depth > 0) depth -= 1;
    current += char;
  }
  if (depth > 0) reportUnterminated(current.trim(), options.warn);
  flush();
  return entries;
}

/**
 * Report an entry whose `(` never closed — truncated, and once per process.
 *
 * The message states BOTH field consequences because this function cannot see
 * which field it is serving, and the deny half is the one that used to be
 * described wrongly: it is silent execution wherever prompting is off, not a
 * prompt. It also says that a quoted paren is payload, so an author who DID
 * quote theirs does not go hunting for a parenthesis that is already closed.
 */
function reportUnterminated(entry: string, warn?: (message: string) => void): void {
  const shown = entry.length > WARNING_ENTRY_CHARS
    ? `${JSON.stringify(entry.slice(0, WARNING_ENTRY_CHARS))}… (${entry.length} chars)`
    : JSON.stringify(entry);
  if (reportedWarnings.has(shown)) return;
  if (reportedWarnings.size >= WARNING_MEMORY_CAP) reportedWarnings.clear();
  reportedWarnings.add(shown);
  const write = warn ?? ((message: string) => { console.warn(message); });
  write(
    `[tool-grants] Unterminated "(" in tool grant ${shown} — kept whole with the rest of the list, so it matches no tool: `
    + 'it grants nothing on `allowed-tools`/`tools`, and it DENIES nothing on `disallowed-tools`, where anything the entries '
    + 'after it named runs without a prompt in `auto` and `bypassPermissions`. A "(" inside a quoted argument is payload and '
    + 'needs no closing paren; this one is not quoted. Close it — and if the argument contains " #", quote the whole entry so '
    + 'YAML does not truncate it as a comment.',
  );
}
