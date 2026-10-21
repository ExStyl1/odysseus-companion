/**
 * The durable occurrence cursor behind the start/wake missed-run sweep
 * (desktop-scheduled-tasks.md:74).
 *
 * The load-bearing property is the FAIL-CLOSED read: this file decides whether a
 * user's scheduled task fires, so anything unreadable must read as "no cursors"
 * — which the planner turns into "seed, do not fire" — rather than into a burst
 * of catch-up runs.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  mergeScheduleState,
  readScheduleState,
  resolveScheduleStatePath,
  writeScheduleState,
} from './schedule-state.ts';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nessy-schedule-state-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('schedule state', () => {
  it('round-trips cursors and writes atomically at mode 0600', () => {
    writeScheduleState(root, { abc123: 1_700_000_000_000, def456: 42 });

    const path = resolveScheduleStatePath(root);
    expect(path).toBe(join(root, 'automations-schedule-state.json'));
    expect(readScheduleState(root)).toEqual({ abc123: 1_700_000_000_000, def456: 42 });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    // Temp file renamed away, never left behind.
    expect(existsSync(`${path}.tmp`)).toBe(false);
  });

  it('reads a missing file as empty', () => {
    expect(readScheduleState(root)).toEqual({});
  });

  it('reads a corrupt file as empty rather than throwing', () => {
    writeFileSync(resolveScheduleStatePath(root), '{ not json');
    expect(readScheduleState(root)).toEqual({});
  });

  it('drops only the entries that are not finite numbers', () => {
    writeFileSync(
      resolveScheduleStatePath(root),
      JSON.stringify({ schemaVersion: 1, cursors: { good: 5, bad: 'soon', worse: null, nan: Number.NaN } }),
    );
    expect(readScheduleState(root)).toEqual({ good: 5 });
  });

  it('merge keeps cursors neither the sweep nor the tick touched', () => {
    writeScheduleState(root, { kept: 1, replaced: 2 });

    const merged = mergeScheduleState(root, { replaced: 9, added: 3 });

    expect(merged).toEqual({ kept: 1, replaced: 9, added: 3 });
    expect(readScheduleState(root)).toEqual({ kept: 1, replaced: 9, added: 3 });
  });

  it('merging nothing does not rewrite the file', () => {
    writeScheduleState(root, { kept: 1 });
    const before = readFileSync(resolveScheduleStatePath(root), 'utf-8');

    expect(mergeScheduleState(root, {})).toEqual({ kept: 1 });
    expect(readFileSync(resolveScheduleStatePath(root), 'utf-8')).toBe(before);
  });

  it('a write into a missing directory fails soft instead of throwing at the caller', () => {
    const missing = join(root, 'gone', 'deeper');
    expect(() => writeScheduleState(missing, { abc: 1 })).not.toThrow();
    // mkdir -p means this one actually succeeds; the contract is only that the
    // scheduler tick that called it is never taken down by the write.
    expect(readScheduleState(missing)).toEqual({ abc: 1 });
  });
});
