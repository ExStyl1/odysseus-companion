/**
 * F1.161 + F1.174 — the session-MCP argv has a CLASS, and until now nothing said
 * so where the next flag gets added.
 *
 * `buildSessionMcpSpec` is the only place that writes codex's
 * `[mcp_servers.session]` argv, and three sites must agree per flag: that
 * emitter, the argv loop in `session-mcp-server/src/index.ts`, and
 * `createCodexContext`'s binding. Each flag arrived with its own docblock in a
 * different file — `--advisor-consult` (P3.13), `--memory-scope-write` (D1.426),
 * `--working-directory` (D1.372), `--memory-app-write` (F1.118) — and the class
 * they do or do not belong to was never written down. F1.116 was the first bill
 * for that: the turn-head drift check recorded ONE BOOLEAN over the advisor flag
 * and was structurally blind to the other two, so a memory reset and a project
 * directory chosen mid-chat each landed at the next runtime start.
 *
 * F1.116 closed the consequence. This file closes the naming, and it does it
 * with a GUARD rather than a sentence, because a sentence asserting what a
 * neighbouring module does has nothing that can fail (AGENTS.md's
 * `codexDeclinesAgentToolGrant` trap, which cost a size-M plan row).
 *
 * ## What the guard actually decides
 *
 * Every `--flag` the emitter can put on that argv must be classified EXACTLY
 * ONCE in `buildSessionMcpSpec`'s own docblock. A flag added to the emitter and
 * not to the classification turns this file red and asks its author one
 * question: is this the chat's own state, the spawn's shape, a session
 * constant, or an operator setting? That question is the whole of F1.161 —
 * whoever answers it also knows whether the turn-head comparison, the child's
 * argv loop and `createCodexContext` need anything.
 *
 * ## The control that keeps the class real rather than "all flags"
 *
 * `--advisor-consult` and `--host-callback-port` are NOT in the per-chat class:
 * they describe the SPAWN — a channel, and which tools exist on it — not the
 * chat. If every flag were in the class the classification would carry no
 * information at all, so this file asserts both memberships and both
 * non-memberships.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { bracedRegion } from '../../testing/source-regions.ts';

const CODEX_AGENT = fileURLToPath(new URL('../codex-agent.ts', import.meta.url));
const src = readFileSync(CODEX_AGENT, 'utf-8');

/** Every `'--flag'` literal inside a region of the emitter, in source order. */
function flagsIn(region: string): string[] {
  return [...new Set(region.match(/'--[a-z][a-z-]*'/g) ?? [])].map((q) => q.slice(1, -1)).sort();
}

/**
 * The docblock immediately above `buildSessionMcpSpec`, read as the text between
 * the classification heading and the method it documents.
 *
 * Bounded by the METHOD's own declaration rather than by a character count: a
 * window wearing a number is the stale-count guard `source-regions.ts` exists to
 * replace, and this docblock is one a future flag's author will grow.
 */
function classificationBlock(): string {
  const at = src.indexOf('## The argv classification');
  expect(at).toBeGreaterThan(-1);
  const end = src.indexOf('private buildSessionMcpSpec(', at);
  expect(end).toBeGreaterThan(at);
  return src.slice(at, end);
}

/** The flags a `BUCKET:` line of the classification names, in source order. */
function bucket(name: string): string[] {
  const block = classificationBlock();
  const at = block.indexOf(`${name}:`);
  expect(at).toBeGreaterThan(-1);
  // Up to the next bucket label or the end of the block — a bucket is a run of
  // comment lines, so the bound is the next ALL-CAPS label and not a line count.
  const rest = block.slice(at + name.length + 1);
  const next = rest.search(/\n\s*\* [A-Z][A-Z-]+:/);
  return [...new Set((next === -1 ? rest : rest.slice(0, next)).match(/`--[a-z][a-z-]*`/g) ?? [])]
    .map((q) => q.slice(1, -1))
    .sort();
}

const BUCKETS = ['PER-CHAT', 'SPAWN', 'FIXED', 'SETTING'] as const;

describe('F1.161 / F1.174 — the session-MCP argv class is named where the next flag is added', () => {
  it('classifies EVERY flag the emitter can write, exactly once', () => {
    const emitter = bracedRegion(src, src.indexOf('private buildSessionMcpSpec('));
    // THE BOUNDARY CONTROL, naming a declaration BELOW the anchor: a brace scan
    // only runs forward, so a needle from above could never be inside the region
    // and would pass on the very runaway it exists to catch.
    expect(emitter).not.toContain('private codexAppMemoryWriteArgs(');
    // F1.118's flag is emitted through a helper the body calls, so the emitted
    // set is the two regions together — and the call is asserted, so a helper
    // that stopped being called could not hide its flag here.
    expect(emitter).toContain('this.codexAppMemoryWriteArgs()');
    const helper = bracedRegion(src, src.indexOf('private codexAppMemoryWriteArgs('));
    expect(helper).not.toContain('private sessionMcpAdvertisedArgs');
    // F1.196's flags arrive through a second helper, under the same rule: the
    // call is asserted, and the region is bounded by the class's closing brace
    // (the helper is the last member), with the bottom-of-file import below it
    // as the boundary control.
    expect(emitter).toContain('this.codexSandboxReadFloorArgs()');
    const sandboxHelper = bracedRegion(src, src.indexOf('private codexSandboxReadFloorArgs('));
    expect(sandboxHelper).not.toContain("from './pi-harness/session-tool-sandbox-read-floor.ts'");

    // F1.194's flag comes from a module-level helper appended after the class,
    // under the same rule: its call is asserted, and its region is bounded by
    // the import that follows it.
    expect(emitter).toContain('...codexUserMemoryRootArgs()');
    const userRootHelper = bracedRegion(src, src.indexOf('function codexUserMemoryRootArgs('));
    expect(userRootHelper).not.toContain("from './memory/memory-store.ts'");
    const emitted = [...new Set([...flagsIn(emitter), ...flagsIn(helper), ...flagsIn(sandboxHelper), ...flagsIn(userRootHelper)])].sort();
    // The positive control on the same instrument: this really is the emitter,
    // so an empty or tiny set below would be a miss rather than an absence.
    expect(emitted).toContain('--config-root');

    const classified = BUCKETS.flatMap((name) => bucket(name)).sort();
    expect(classified).toEqual(emitted);
    // Exactly once: the union above would also be equal if a flag sat in two
    // buckets and another were missing from a longer emitted list.
    expect(new Set(classified).size).toBe(classified.length);
  });

  it('the per-chat class holds this chat own controls', () => {
    expect(bucket('PER-CHAT')).toEqual(['--memory-scope-write', '--working-directory']);
  });

  it('and the APP-WIDE memory switch is a setting, not this chat control', () => {
    // WJ-k 2026-09-23. `--memory-app-write` is F1.118's APP-WIDE switch, and
    // its own docblocks (the emitter's helper, the child's usage line) say so;
    // it was first filed under PER-CHAT beside the per-chat axis it resembles.
    // SETTING's definition — neither this chat's control nor a constant — is
    // the one it meets. Behaviour is identical either way (the turn-head
    // comparison reads the whole argv), which is why only a pin can hold it.
    expect(bucket('PER-CHAT')).not.toContain('--memory-app-write');
    expect(bucket('SETTING')).toEqual([
      '--memory-app-write', '--plans-folder', '--sandbox-denied-read-root', '--sandbox-reads-fenced', '--user-memory-root',
    ]);
  });

  it('and F1.196 files the latched home as FIXED and the host read policy as SETTING', () => {
    // The latch is captured once per host process, so it cannot drift; the
    // policy is resolved per session from `deniedPaths` and the fence switch,
    // and the turn-head comparison is what re-spawns the child when it moves.
    expect(bucket('FIXED')).toContain('--credential-home');
    expect(bucket('PER-CHAT')).not.toContain('--sandbox-denied-read-root');
    expect(bucket('SPAWN')).not.toContain('--sandbox-reads-fenced');
  });

  it('and NOT the two that describe the spawn — which is what makes it a class', () => {
    const perChat = bucket('PER-CHAT');
    expect(perChat).not.toContain('--advisor-consult');
    expect(perChat).not.toContain('--host-callback-port');
    expect(bucket('SPAWN')).toEqual(['--advisor-consult', '--host-callback-port']);
  });

  it('points at the record the turn-head comparison keeps, so the correction is findable', () => {
    // F1.174's own ask: one link from the emitter to the surface that is
    // compared, so a future flag author reaches the self-correcting half
    // without having to know it exists.
    expect(classificationBlock()).toContain('{@link sessionMcpAdvertisedArgs}');
  });
});
