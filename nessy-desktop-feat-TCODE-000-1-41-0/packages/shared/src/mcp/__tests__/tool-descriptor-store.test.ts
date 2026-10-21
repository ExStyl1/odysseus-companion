import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readdirSync, existsSync, utimesSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { createToolDescriptorStore, TOOL_DESCRIPTOR_STORE_MAX_RECORDS } from '../tool-descriptor-store.ts';

let root: string;
const KEY_A = JSON.stringify(['mcp', 'alpha', 'a'.repeat(64)]);
const KEY_B = JSON.stringify(['mcp', 'alpha', 'b'.repeat(64)]);
const KEY_C = JSON.stringify(['mcp', 'alpha', 'c'.repeat(64)]);

function tools(name: string): Tool[] {
  return [{ name, description: `d:${name}`, inputSchema: { type: 'object', properties: {} } } as Tool];
}

/**
 * D1.440 — the two eviction cases DECIDE their own write order instead of
 * asking the filesystem, and the red that forced it is worth carrying.
 *
 * `enforceCap` sorts by `statSync(…, { bigint: true }).mtimeNs`, and its own
 * docblock records the reason: *"two adjacent writes differ by ~200 000 ns, so
 * the ordering is real at this resolution and a coin toss at the other"*. That
 * measurement was taken on a developer Mac. On the CI runner the two writes TIE
 * — `caps the directory and evicts the least recently written record` failed
 * there with `fresh.read(KEY_A)` returning A's tools, i.e. the store had
 * evicted a different record — so the case was measuring the filesystem's
 * timestamp granularity rather than the rule.
 *
 * Stamping makes the order the case's own. The RESIDUE is real and is a row,
 * not something this helper hides: on a filesystem that ties adjacent writes,
 * which record `enforceCap` drops is arbitrary. It is housekeeping over a
 * rebuildable cache, so the cost is a re-fetch, not a wrong answer.
 */
function recordPath(key: string): string {
  return join(root, `${createHash('sha256').update(key).digest('hex')}.json`);
}

/** Age one record by whole seconds, far beyond any filesystem's granularity. */
function ageRecord(key: string, secondsAgo: number): void {
  const full = recordPath(key);
  // If the store's filename derivation ever moves, this fails LOUDLY here
  // rather than silently ageing nothing and leaving the cases back on the clock.
  expect(existsSync(full)).toBe(true);
  const when = new Date(Date.now() - secondsAgo * 1000);
  utimesSync(full, when, when);
}

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'tool-desc-store-')); });
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });

describe('ToolDescriptorStore', () => {
  it('round-trips descriptors through a fresh store instance', () => {
    createToolDescriptorStore(root).write(KEY_A, tools('one'));
    expect(createToolDescriptorStore(root).read(KEY_A)).toEqual(tools('one'));
  });

  it('keeps records for different connection identities of the same slug apart', () => {
    const store = createToolDescriptorStore(root);
    store.write(KEY_A, tools('one'));
    store.write(KEY_B, tools('two'));
    expect(store.read(KEY_A)).toEqual(tools('one'));
    expect(store.read(KEY_B)).toEqual(tools('two'));
  });

  it('treats an unreadable or foreign-schema record as a miss instead of throwing', () => {
    const store = createToolDescriptorStore(root);
    store.write(KEY_A, tools('one'));
    const [file] = readdirSync(root);
    writeFileSync(join(root, file!), '{ not json');
    expect(createToolDescriptorStore(root).read(KEY_A)).toBeUndefined();
  });

  /**
   * DA3.9 — the bound that replaced `prune(keep)`. The cap is injected rather
   * than exercised at its real value so the case measures the RULE and not the
   * number; `TOOL_DESCRIPTOR_STORE_MAX_RECORDS` is asserted separately below, so
   * a change to the default cannot pass unnoticed either.
   */
  it('caps the directory and evicts the least recently written record', () => {
    const store = createToolDescriptorStore(root, 2);
    store.write(KEY_A, tools('one'));
    ageRecord(KEY_A, 300);
    store.write(KEY_B, tools('two'));
    ageRecord(KEY_B, 200);
    // Still under the cap: nothing is evicted, which is the control that keeps
    // the eviction below from passing on a store that simply deletes.
    expect(readdirSync(root)).toHaveLength(2);
    expect(store.read(KEY_A)).toEqual(tools('one'));

    // C is the newest by 200 s, A the oldest by 100 s — decided here, not by
    // whatever resolution this machine's mtimes happen to have.
    store.write(KEY_C, tools('three'));

    expect(readdirSync(root)).toHaveLength(2);
    const fresh = createToolDescriptorStore(root, 2);
    expect(fresh.read(KEY_A)).toBeUndefined();
    expect(fresh.read(KEY_B)).toEqual(tools('two'));
    expect(fresh.read(KEY_C)).toEqual(tools('three'));
  });

  it('refreshes a record it rewrites, so a server still in use is never the one evicted', () => {
    const store = createToolDescriptorStore(root, 2);
    store.write(KEY_A, tools('one'));
    ageRecord(KEY_A, 300);
    store.write(KEY_B, tools('two'));
    ageRecord(KEY_B, 200);
    // A re-connect rewrites A, which makes B the oldest. The rewrite is NOT
    // aged: it takes the current clock, which is what "refreshes" means.
    store.write(KEY_A, tools('one-again'));

    store.write(KEY_C, tools('three'));

    const fresh = createToolDescriptorStore(root, 2);
    expect(fresh.read(KEY_A)).toEqual(tools('one-again'));
    expect(fresh.read(KEY_B)).toBeUndefined();
  });

  it('states the shipped cap, so a change to it is a deliberate edit', () => {
    expect(TOOL_DESCRIPTOR_STORE_MAX_RECORDS).toBe(200);
  });

  it('reads nothing for a key never written', () => {
    expect(createToolDescriptorStore(root).read(KEY_A)).toBeUndefined();
  });
});
