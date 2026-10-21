/**
 * P2.457 — is the SDK's own tool search observable at all? MEASURED, and the
 * row's premise is REFUTED rather than confirmed.
 *
 * The row asked the question and forbade the answer-shaped reflex: *"The row is
 * not 'build a counter': it is find out whether the SDK exposes this at all**,
 * in the control stream, the usage payload or the transcript, and record the null
 * if it does not."* It expected a null, on the stated premise that when tool
 * search runs *"its searches and its loads happen inside the subprocess, and no
 * context category and no transcript row counts them"*.
 *
 * ## The measurement, three surfaces, one answer each
 *
 * **The transcript: EXPOSED, per search, naming every tool the search loaded.**
 * `SDKAssistantMessage.message` is a `BetaMessage`, and the union its `content`
 * holds — `BetaContentBlock` — includes `BetaServerToolUseBlock`, whose `name`
 * vocabulary contains `'tool_search_tool_regex'` and `'tool_search_tool_bm25'`,
 * and `BetaToolSearchToolResultBlock` (`type: 'tool_search_tool_result'`), whose
 * content is either a four-code error or a
 * `BetaToolSearchToolSearchResultBlock` carrying
 * `tool_references: Array<BetaToolReferenceBlock>` — i.e. the loaded tools by
 * name. So a search IS a transcript row, and so is what it loaded.
 *
 * **The control stream: EXPOSED, as standing state.** `Query.getContextUsage():
 * Promise<SDKControlGetContextUsageResponse>`, and that response carries
 * `categories[].isDeferred`, `mcpTools[].isLoaded` and
 * `deferredBuiltinTools[].isLoaded`. That answers the row's user-facing question
 * directly — whether a tool is deferred, or was loaded — for built-ins and MCP
 * tools alike.
 *
 * **The usage payload: ABSENT, and this is the only true null.** `ModelUsage`
 * counts `webSearchRequests` and has no tool-search analogue, so *how many
 * searches ran* is not totalled anywhere; it can only be derived by counting
 * blocks.
 *
 * ## Why the row believed otherwise, and why that is worth pinning
 *
 * `agent-sdk/tool-search.md` never mentions any of it: `server_tool_use`,
 * `tool_search_tool_result`, `transcript`, `usage`, `getContextUsage`, `isLoaded`
 * and `isDeferred` all score ZERO on that page, against `ENABLE_TOOL_SEARCH` 8
 * and `alwaysLoad` 1 as positive controls. This is `AGENTS.md`'s rule again —
 * the bundle is the denominator for what the runtime can already do — and the
 * shipped native binary agrees: `server_tool_use` 97, `tool_search_tool_result`
 * 6, `tool_search_tool_regex` 4, `tool_search_tool_bm` 4, `isDeferred` 17,
 * `deferredBuiltinTools` 4, `get_context_usage` 14, `web_search_requests` 19,
 * against `PreToolUse` 132 as the positive control and both
 * `tool_search_requests` and `toolSearchRequests` at 0 — the absence with a
 * control beside it.
 *
 * ## What is genuinely missing is on OUR side, and NO COUNTER IS BUILT HERE
 *
 * The row's audit concern stands, but its cause is not the SDK: this backend
 * drops the rows. `event-adapter.ts` reads `block.type === 'text'` and hands the
 * rest to `extractToolStarts`, which opens with `if (block.type !== 'tool_use')
 * continue` — so `server_tool_use` and `tool_search_tool_result` are discarded
 * unread. Per the row, this file records that verdict and stops. The last test
 * is the one a future lane must change deliberately when it wires the rows
 * through, so the finding cannot rot into prose about a surface that has since
 * been read.
 *
 * ## CORRECTION 2026-09-04 (P3.357): `getContextUsage` IS called — elsewhere,
 * and for something else
 *
 * The sentence this paragraph used to carry — *"nothing calls
 * `Query.getContextUsage()` on this path"* — was true of the event adapter and
 * false of the backend, and the known-failing register drew the opposite
 * conclusion from the same red: that a landed commit had FILLED the absence.
 * Both readings are wrong. P3.268 added `ClaudeAgent.refreshSdkContextWindow`
 * (`claude-agent.ts`, one directory up and so outside the last test's readdir
 * scope), which calls `getContextUsage()` at spawn and on a live `setModel` and
 * hands the payload to `applySdkContextUsage`. That consumes a DIFFERENT
 * surface — only `model` and `rawMaxTokens`, for the context meter's
 * denominator. The three fields THIS file is about — `categories[].isDeferred`,
 * `mcpTools[].isLoaded` and `deferredBuiltinTools[].isLoaded` — are read
 * nowhere in our source (measured repo-wide 2026-09-04: the only other hits are
 * Pi's unrelated `isDeferredMcpCandidate` and a renderer avatar's React state).
 *
 * So the verdict above is UNCHANGED, and flipping the pin to `toContain` would
 * have passed on a docblock and recorded a product claim that is false. Inside
 * `backend/claude/` all four `getContextUsage` mentions are comment lines, so
 * that one pin is matched as CODE — P3.256's precedent verbatim, *"a bare
 * `not.toContain` would collide with the comment explaining why the line is
 * gone"* — with a control asserting the prose is still there, so the pin
 * cannot be satisfied by deleting the explanation.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);

/** Same resolution the other SDK-surface pins use: `exports` publishes no `.d.ts`. */
function sdkTypings(): string {
  const entry = require_.resolve('@anthropic-ai/claude-agent-sdk');
  const path = entry.replace(/sdk\.mjs$/, 'sdk.d.ts');
  if (!existsSync(path)) throw new Error(`sdk.d.ts not found beside ${entry}`);
  return readFileSync(path, 'utf8');
}

/**
 * The Anthropic SDK's beta message types, which is where `BetaMessage` — and so
 * `SDKAssistantMessage.message` — actually gets its content-block union.
 * Resolved off `sdk.d.ts`'s own import specifier rather than guessed, so a
 * package layout change fails loudly instead of skipping.
 */
function betaMessageTypings(): string {
  const path = require_.resolve('@anthropic-ai/sdk/resources/beta/messages/messages.js')
    .replace(/messages\.(m?js)$/, 'messages.d.ts');
  if (!existsSync(path)) throw new Error(`beta messages.d.ts not found at ${path}`);
  return readFileSync(path, 'utf8');
}

describe('P2.457 · the transcript carries each search and what it loaded', () => {
  const beta = betaMessageTypings();
  const dts = sdkTypings();

  /** POSITIVE CONTROL, both files, before any presence claim is made. */
  test('both declaration files are the ones we think they are', () => {
    expect(beta.length).toBeGreaterThan(10_000);
    expect(beta).toContain('export interface BetaServerToolUseBlock');
    expect(beta).not.toContain('ZZThisBlockDoesNotExistZZ');
    expect(dts).toContain("import type { BetaMessage } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'");
    expect(dts).toContain('message: BetaMessage;');
  });

  /**
   * KILLS: the row's premise, and any later restatement of it. If both blocks
   * leave `BetaContentBlock`, a search really would be invisible in the stream
   * and the null would be the right answer again — deliberately, not by drift.
   */
  test('BetaContentBlock — what an assistant message holds — includes both tool-search blocks', () => {
    const start = beta.indexOf('export type BetaContentBlock =');
    expect(start).toBeGreaterThan(-1);
    const union = beta.slice(start, beta.indexOf(';', start));
    // The control: a block we already read, in the same union.
    expect(union).toContain('BetaToolUseBlock');
    expect(union).toContain('BetaServerToolUseBlock');
    expect(union).toContain('BetaToolSearchToolResultBlock');
  });

  /** KILLS: the two search-tool names leaving the `server_tool_use` vocabulary. */
  test('a search arrives as server_tool_use under one of two named tools', () => {
    const start = beta.indexOf('export interface BetaServerToolUseBlock {');
    const body = beta.slice(start, beta.indexOf('}', beta.indexOf("type: 'server_tool_use'", start)));
    expect(body).toContain("'tool_search_tool_regex'");
    expect(body).toContain("'tool_search_tool_bm25'");
    // The control: the vocabulary's other members are still there, so a pass
    // above is not an artefact of a window that swallowed the whole file.
    expect(body).toContain("'web_search'");
  });

  /**
   * KILLS: the LOADS half going unobservable. `tool_references` is what makes
   * the row's question answerable at all — it names the tools that search put
   * into context, so "deferred, searched for, or never considered" is
   * distinguishable from the stream alone.
   */
  test('the result block names the tools the search loaded', () => {
    expect(beta).toContain("type: 'tool_search_tool_result';");
    const start = beta.indexOf('export interface BetaToolSearchToolSearchResultBlock {');
    expect(start).toBeGreaterThan(-1);
    expect(beta.slice(start, beta.indexOf('}', start))).toContain('tool_references: Array<BetaToolReferenceBlock>');
    // And a failed search is distinguishable from an empty one.
    expect(beta).toContain("error_code: 'invalid_tool_input' | 'unavailable' | 'too_many_requests' | 'execution_time_exceeded'");
  });
});

describe('P2.457 · the control stream carries the standing deferred/loaded state', () => {
  const dts = sdkTypings();

  /** KILLS: losing the live reader, which is the only route to the state. */
  test('Query exposes getContextUsage', () => {
    expect(dts).toMatch(/getContextUsage\((?:opts\?: \{[^}]*\})?\): Promise<SDKControlGetContextUsageResponse>;/); // opts? since 0.3.267
  });

  /**
   * KILLS: the three fields that make the response an answer rather than a
   * token total. Read out of the response type's own body — the strings appear
   * nowhere else in the file, but anchoring makes that a fact rather than a
   * coincidence.
   */
  test('the response distinguishes deferred from loaded, for MCP and built-in tools', () => {
    const start = dts.indexOf('export declare type SDKControlGetContextUsageResponse = {');
    expect(start).toBeGreaterThan(-1);
    const body = dts.slice(start, dts.indexOf('\n};', start));
    expect(body).toContain('isDeferred?: boolean');
    expect(body).toContain('isLoaded?: boolean');
    expect(body).toContain('deferredBuiltinTools?:');
    expect(body).toContain('isLoaded: boolean');
  });

  /**
   * THE ONE TRUE NULL, with its positive control in the same assertion. The
   * usage payload counts web searches and does not count tool searches, so
   * "how many searches ran this session" is derivable but not reported.
   */
  test('ModelUsage counts web searches and does NOT count tool searches', () => {
    const start = dts.indexOf('export declare type ModelUsage = {');
    expect(start).toBeGreaterThan(-1);
    const body = dts.slice(start, dts.indexOf('\n};', start));
    expect(body).toContain('webSearchRequests: number');
    expect(body).not.toContain('toolSearchRequests');
    expect(body).not.toContain('tool_search');
  });
});

describe('P2.457 · and the rows this backend still drops', () => {
  /**
   * KILLS: this verdict going stale in the direction that matters. The moment a
   * lane starts reading either block on the claude path, this test fails and the
   * finding above has to be rewritten as "wired" instead of quietly surviving as
   * "invisible".
   *
   * Scoped to the claude backend directory rather than the whole repo, because
   * the codex adapter legitimately speaks `server_tool_use` for WEB search and a
   * repo-wide search would report that as coverage.
   */
  test('the claude event adapter reads neither block, and still reads the ones it knows', () => {
    const dir = new URL('../backend/claude/', import.meta.url);
    const sources = readdirSync(dir)
      .filter(name => name.endsWith('.ts'))
      .map(name => readFileSync(new URL(name, dir), 'utf8'))
      .join('\n');
    // POSITIVE CONTROL: the directory was read and does contain block handling.
    expect(sources).toContain("block.type === 'text'");
    expect(sources).toContain('extractToolStarts');
    // THE FINDING. These two are absent from this directory in EVERY form —
    // code and prose alike — so they keep the strongest spelling.
    expect(sources).not.toContain('tool_search_tool_result');
    expect(sources).not.toContain('server_tool_use');
    // THE THIRD ONE IS A COMMENT COLLISION, NOT A READ (P3.357, 2026-09-04).
    // All four `getContextUsage` mentions inside `backend/claude/` are docblock
    // or `//` lines; the one real call site is `refreshSdkContextWindow` in
    // `claude-agent.ts`, one directory up and outside this readdir scope, and it
    // consumes `model`/`rawMaxTokens` rather than the deferral fields this file
    // is about. So this one is matched as CODE — comment-only lines dropped —
    // exactly as P3.256 re-spelled its own absence pin.
    const codeOnly = sources
      .split('\n')
      .filter(line => !/^\s*(?:\/\/|\/\*|\*)/.test(line))
      .join('\n');
    expect(codeOnly).not.toContain('getContextUsage');
    // CONTROL for the line above: the prose that MAKES it a comment collision
    // has to still exist, so the pin cannot be satisfied by deleting the
    // explanation instead of by leaving the surface unread.
    expect(sources).toContain('getContextUsage');
    // CONTROL that `codeOnly` is not vacuous: the comment stripper must leave
    // real code behind. Without this a stripper bug would silently pass the
    // absence pin on an empty string.
    expect(codeOnly).toContain("block.type === 'text'");
  });
});
