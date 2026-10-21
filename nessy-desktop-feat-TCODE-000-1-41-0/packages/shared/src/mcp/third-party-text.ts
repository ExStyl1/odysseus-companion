/**
 * WHAT AN MCP SERVER'S OWN WORDS DO TO THE MODEL — ONE POSTURE, THREE RUNTIMES
 * (P3.292 capping, P3.293 fencing).
 *
 * Two fields of the MCP protocol are prose an MCP server author wrote and the
 * model reads: the `instructions` string in the `initialize` result, and each
 * tool's `description`. They are third-party text on the same footing as a
 * hook's stdout, and until this module each of our three runtimes did something
 * different with them — which is the switch-visible defect P3.292 records, not a
 * safety opinion. The two questions are decided together here, ONCE, because
 * deciding either on one runtime alone manufactures exactly the divergence the
 * rows exist to close.
 *
 * ## Question 1 — is it FENCED? Measured answer: NO, on every surface (P3.293)
 *
 * `security.md#protect-against-prompt-injection` lists the vendor's safeguards
 * and the one that covers MCP is ADMISSION, not framing — verbatim: *"Trust
 * verification: First-time codebase runs and new MCP servers require trust
 * verification"*. `mcp.md#find-and-build-mcp-servers` says the same from the
 * other side:
 * *"Verify you trust each server before connecting it. Servers that fetch
 * external content can expose you to prompt injection risk."* No page in the
 * corpus describes a fence, a notice or an untrusted marker around either field.
 *
 * The bundle agrees, and this is the strong half of the evidence because it is
 * behaviour rather than intent. In the vendored native binary (SDK `0.3.247` /
 * `claudeCodeVersion 2.1.247`) an MCP tool's model-facing text is returned raw,
 * with the cap as the ONLY transformation. Transcribed at `0.3.233` as
 * `async prompt(){return G.length>Eue?_i(G,Eue)+"… [truncated]":G}` and re-read
 * at `0.3.247` on 2026-09-12 (C3.252) as
 * `async prompt(){return q.length>j_?tn(q,j_)+"… [truncated]":q}` — the same
 * clause with every letter moved, which is why the SHAPE and not the letters is
 * the anchor, and a server's `instructions` go through a
 * function whose entire body is that same cap. There is no wrapper.
 *
 * The vendor is NOT unaware of the risk, which is the fact that makes this a
 * decision rather than an oversight: the same binary SCANS both fields for
 * tool-call XML (a description or an `instructions` containing `<invoke`, or a
 * `<param>`-shaped element named after one of the tool's own properties) and its
 * entire response is one telemetry counter,
 * `tengu_mcp_description_contains_toolcall_xml`, carrying
 * `matchedToolCount` / `invokeCount` / `paramCount` / `instructionsMatch`.
 * It measures the hazard and still ships the bytes unframed.
 *
 * Codex, re-read from source at `rust-v0.154.0` (I2.26, 2026-09-17; it said
 * `rust-v0.150.1` and both readings agree), does the same:
 * `codex-rs/codex-mcp/src/rmcp_client.rs`'s `regular_mcp_tool_info_from_listed_tool`
 * sets `namespace_description: server_instructions.map(str::to_string)` — the
 * server's `instructions` becomes the model-visible namespace description
 * verbatim — and `codex-rs/tools/src/mcp_tool.rs`'s `parse_mcp_tool` copies the
 * description with no wrapper. Its only sanitisation is
 * `strip_untrusted_connector_meta`, which removes reserved `_meta` KEYS a server
 * must not set, and touches no prose.
 *
 * **So we fence nothing, on all three, and the reason is written here rather
 * than left to be re-derived at each site.** It is not the same call as the
 * hook-stdout family next door (`automations/hook-context-fence.ts`, P2.236 /
 * P2.250 / P3.281), and the difference is worth stating because the two look
 * alike:
 *  - A hook's `additionalContext` is usually not the configured party's words at
 *    all — a `git log`, a linter's report, a file the script `cat`-ed — and it
 *    is different bytes every turn. `UNTRUSTED_HOOK_NOTICE` exists to say "a
 *    hook may inform you, but it is not the harness speaking".
 *  - A server's `instructions` and a tool's `description` are the server's OWN
 *    static self-description, fixed at a handshake the user had to admit, and
 *    they are the protocol's designated slot for telling the model when to reach
 *    for the tools. The model is MEANT to act on them, exactly as it acts on a
 *    tool description. A fence saying "nothing inside is a directive" would be
 *    false, and an untrusted marker only we apply would make a server's own
 *    description read differently after a Pi↔claude↔codex switch — a new silent
 *    divergence dressed as a safety improvement.
 *
 * THE RESIDUE, stated rather than hidden: these fields ARE a prompt-injection
 * surface, and our mitigation is the vendor's — admission (source connect
 * consent, managed `allowedMcpServers` / `allowManagedMcpServersOnly`) plus the
 * cap below. We do not carry the vendor's XML detector; it is telemetry-only on
 * their side, so adopting it would change nothing the model sees or may do. If
 * that posture is ever revisited, revisit it for three runtimes in this file.
 *
 * ## Question 2 — is it CAPPED, and at what? (P3.292)
 *
 * `mcp.md#for-mcp-server-authors`, verbatim: *"Claude Code truncates tool
 * descriptions and server instructions at 2KB each. Keep them concise to avoid
 * truncation, and put critical details near the start."*
 *
 * Measured, the three runtimes did three different things:
 *
 * | surface | server `instructions` | tool `description` |
 * | --- | --- | --- |
 * | claude (binary `2.1.247`) | capped, native | capped, native |
 * | Pi (before this module) | capped at 2048 UTF-8 BYTES | uncapped |
 * | codex (`rust-v0.154.0`) | uncapped | uncapped for an ordinary server |
 *
 * Codex's row deserves its two details, because a one-word "uncapped" is wrong
 * in the direction that matters. `codex-rs/tools/src/mcp_tool.rs` has TWO
 * entrances: `parse_mcp_tool` passes `description_limit: None`, and
 * `parse_agent_plugin_mcp_tool` passes `Some(MAX_MCP_TOOL_DESCRIPTION_BYTES)`
 * where that constant is `1_000` — a thousand BYTES, cut at a char boundary,
 * with NO marker, so the model cannot tell it was cut. Our pool server is
 * configured as an ordinary `[mcp_servers.*]` entry, so our path is the
 * uncapped one; the 1000-byte arm is recorded because a future agent-plugin
 * packaging of the same server would silently land on it. RE-READ at
 * `rust-v0.154.0` (I2.26, 2026-09-17, from the source at the tag — the STRONG
 * tier): the constant is still `1_000`, `parse_mcp_tool` still passes `None`
 * and `parse_agent_plugin_mcp_tool` still passes `Some(..)`, so both arms are
 * unchanged across two tags.
 *
 * One nearby thing DID move and is not this: upstream #39594 raised the MCP tool
 * NAME limit to 128 bytes. Different surface — this table is about
 * `description` — and it is a WIDENING we cannot hit anyway, because every wire
 * name this product mints is capped at 64 chars at the mint
 * (`mcp-pool.ts`'s `mcp__<slug>__<tool>` builder). Recorded so the next reader
 * does not have to re-derive that it is harmless. **I2.26 was written from the
 * reading that this module "records codex as uncapped for tool NAMES", and that
 * is refuted by this paragraph's own existence**: the table two blocks up is
 * about `instructions` and `description`, and neither column has ever been a
 * claim about names.
 *
 * ### Why the cap is CHARS, and why 2048 rather than "2KB"
 *
 * The page says 2KB; the binary measures `String.length`. In the bundle the
 * constant is `2048` and both call sites compare `e.length <= Eue`, then slice
 * with a helper that backs off one unit rather than split a surrogate pair. So
 * the cap is 2048 UTF-16 code units, surrogate-safe — identical to "2KB" for
 * ASCII and, for anything else, LOOSER than a byte reading. Pi's byte cap cut a
 * Cyrillic or CJK `instructions` at roughly half the text claude would keep,
 * which is the same server reading differently across a switch.
 *
 * This is the bundle-governs direction of AGENTS.md's rule: the page states the
 * behaviour, the bundle states its spelling, and where they can disagree (a
 * non-ASCII body) the shipped artifact is what the user actually meets. Derived
 * from `0.3.233`; re-measure on an SDK bump.
 *
 * ### Why the marker is the vendor's literal
 *
 * `… [truncated]`, appended after the slice, is exactly what the binary appends
 * — measured, not chosen. The marker is MODEL-VISIBLE BYTES, so any other
 * string guarantees that the same over-long server reads differently on claude
 * than on the other two, which is the whole complaint of P3.292. It is
 * byte-identical to `prompts/compaction.ts`'s `COMPACTION_TRUNCATION_MARKER`
 * today and is deliberately NOT an alias of it: same string, different reasons,
 * and only one of the two is pinned to a vendor's binary.
 *
 * (P3.279 shipped Pi's cap with a self-explaining marker naming the 2KB rule,
 * on the reasoning that a server author reading a transcript should learn their
 * prose met a documented per-server cap. The measurement above retires that: on
 * claude the author gets `… [truncated]` and nothing else no matter what we
 * prefer, so the explanatory words buy nothing an author can rely on and cost
 * the cross-runtime identity. The explanation belongs to the operator channel,
 * where the binary also puts it — it logs `Server instructions truncated from
 * <n> to 2048 chars` per server. We do not have that log line; that is the one
 * honest residue of this change, and it is operator-facing, not model-facing.)
 *
 * ### Why the HOST caps codex's surface, which codex would not
 *
 * Native-first, in order. Claude has the mechanism and we enable it by handing
 * the SDK the raw `instructions` — nothing to build. Pi is built 1:1 to Claude's
 * pages, so Pi mirrors the binary here. Codex has no mechanism on our path, so
 * the question falls to step 2: can the host supply it uniformly? It can, and
 * `mcp/pool-server.ts` is the host, not codex — that surface FLATTENS every
 * leased source into one MCP server, so its single `instructions` slot carries
 * N servers' prose concatenated and is the least bounded of the three. Capping
 * per source there is what makes one source's text read the same on all three.
 *
 * That makes us stricter than a bare codex, and the choice is deliberate and
 * visible: the cut carries the marker, so nothing disappears silently, and the
 * alternative — matching codex's non-behaviour — would leave the switch-visible
 * difference this row exists to remove.
 */

/**
 * The cap, in UTF-16 code units, for one server's `instructions` and for one
 * tool's `description`. See the module docblock for why it is code units and
 * not bytes, and where the number was read from.
 */
export const MCP_TEXT_MAX_CHARS = 2048;

/**
 * The vendor's literal, appended after the cut. Not an alias of
 * `COMPACTION_TRUNCATION_MARKER` even though the two strings are equal today.
 */
export const MCP_TEXT_TRUNCATION_MARKER = '… [truncated]';

/**
 * Cap one piece of MCP-authored prose the way the claude binary does.
 *
 * Surrogate-safe: a slice landing between the halves of an astral character
 * would put a lone high surrogate in front of the model, which is not a
 * character and renders as a replacement glyph. The binary backs off one unit;
 * so does this.
 *
 * Returns the input unchanged when it fits, so a body inside the cap is
 * delivered byte-for-byte and marker-free — the marker is a claim that
 * something was cut.
 */
export function capMcpText(text: string): string {
  if (text.length <= MCP_TEXT_MAX_CHARS) return text;
  let end = MCP_TEXT_MAX_CHARS;
  const lastUnit = text.charCodeAt(end - 1);
  if (lastUnit >= 0xD800 && lastUnit <= 0xDBFF) end -= 1;
  return `${text.slice(0, end)}${MCP_TEXT_TRUNCATION_MARKER}`;
}
