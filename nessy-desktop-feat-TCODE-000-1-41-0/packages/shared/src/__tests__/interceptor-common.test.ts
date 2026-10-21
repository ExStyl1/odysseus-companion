import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  MAX_LOG_ENTRY_CHARS,
  MAX_LOG_FILE_BYTES,
  _setLogFileForTesting,
  appendLogEntry,
  getLastApiError,
  initLogFile,
  setStoredError,
  toolMetadataStore,
} from '../interceptor-common.ts';

/**
 * UB1.10 (upstream v0.13.6, OSS #1033) — the interceptor log is bounded: a
 * 4 MiB entry cap, 32 MiB size rotation (plus the age rotation that predates
 * this row), and the oversized-log reclaim at init. Every arm writes to a
 * redirected scratch log, never the real user log.
 */
describe('UB1.10 · the interceptor log is bounded', () => {
  let logDir: string;
  let logFile: string;

  beforeEach(() => {
    logDir = mkdtempSync(join(tmpdir(), 'ub10-interceptor-'));
    logFile = join(logDir, 'interceptor.log');
    _setLogFileForTesting(logFile);
  });

  afterEach(() => {
    _setLogFileForTesting(join(tmpdir(), 'ub10-disabled-never-written.log'));
    rmSync(logDir, { recursive: true, force: true });
  });

  it('positive: a normal entry lands with the interceptor prefix, verbatim', () => {
    appendLogEntry('-> REQUEST POST https://api.example.com');
    const text = readFileSync(logFile, 'utf-8');
    expect(text).toContain('-> REQUEST POST https://api.example.com');
    expect(text).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z \[interceptor\] -> REQUEST POST/);
  });

  it('negative: an entry over MAX_LOG_ENTRY_CHARS is cut at the cap with a marker', () => {
    appendLogEntry('x'.repeat(MAX_LOG_ENTRY_CHARS + 1234));
    const text = readFileSync(logFile, 'utf-8');
    expect(text).toContain(`... [ENTRY TRUNCATED at ${MAX_LOG_ENTRY_CHARS} chars]`);
    // The file holds the clipped entry plus the line stamp — far below the input size.
    expect(statSync(logFile).size).toBeLessThan(MAX_LOG_ENTRY_CHARS + 200);
    expect(text).not.toContain('y'.repeat(50));
  });

  it('negative: a log at MAX_LOG_FILE_BYTES rotates to .prev on the next entry', () => {
    writeFileSync(logFile, 'b'.repeat(MAX_LOG_FILE_BYTES));
    appendLogEntry('the first entry after the cap');
    expect(existsSync(logFile + '.prev')).toBe(true);
    expect(statSync(logFile + '.prev').size).toBe(MAX_LOG_FILE_BYTES);
    const active = readFileSync(logFile, 'utf-8');
    expect(active).toContain('the first entry after the cap');
    expect(active).not.toContain('bbbbbb');
  });

  it('boundary: a log one byte below the cap is not rotated', () => {
    writeFileSync(logFile, 'b'.repeat(MAX_LOG_FILE_BYTES - 1));
    appendLogEntry('still under the cap');
    expect(existsSync(logFile + '.prev')).toBe(false);
    expect(readFileSync(logFile, 'utf-8')).toContain('still under the cap');
  });

  it('initLogFile reclaims an oversized log instead of keeping it as .prev', () => {
    writeFileSync(logFile, 'b'.repeat(MAX_LOG_FILE_BYTES + 5));
    initLogFile(logFile);
    expect(existsSync(logFile + '.prev')).toBe(false);
    expect(statSync(logFile).size).toBe(0);
  });
});

describe('interceptor-common', () => {
  let sessionDirA: string;
  let sessionDirB: string;

  beforeEach(() => {
    sessionDirA = mkdtempSync(join(tmpdir(), 'interceptor-a-'));
    sessionDirB = mkdtempSync(join(tmpdir(), 'interceptor-b-'));
  });

  afterEach(() => {
    toolMetadataStore._clearForTesting();
    rmSync(sessionDirA, { recursive: true, force: true });
    rmSync(sessionDirB, { recursive: true, force: true });
  });

  it('keeps API errors session-scoped when session dir is switched', () => {
    toolMetadataStore.setSessionDir(sessionDirA);
    setStoredError({
      status: 401,
      statusText: 'Unauthorized',
      message: 'Session A auth failed',
      timestamp: Date.now(),
    });

    toolMetadataStore.setSessionDir(sessionDirB);
    setStoredError({
      status: 429,
      statusText: 'Too Many Requests',
      message: 'Session B rate limit',
      timestamp: Date.now(),
    });

    toolMetadataStore.setSessionDir(sessionDirA);
    const errA = getLastApiError();
    expect(errA?.status).toBe(401);

    toolMetadataStore.setSessionDir(sessionDirB);
    const errB = getLastApiError();
    expect(errB?.status).toBe(429);
  });

  it('merges new metadata with existing on-disk entries', () => {
    const existing = {
      existingTool: {
        intent: 'Existing',
        displayName: 'Existing Tool',
        timestamp: Date.now() - 1000,
      },
    };

    writeFileSync(join(sessionDirA, 'tool-metadata.json'), JSON.stringify(existing), 'utf-8');
    toolMetadataStore.setSessionDir(sessionDirA);

    toolMetadataStore.set('newTool', {
      intent: 'New intent',
      displayName: 'New Tool',
      timestamp: Date.now(),
    });

    const persisted = JSON.parse(readFileSync(join(sessionDirA, 'tool-metadata.json'), 'utf-8')) as Record<string, unknown>;
    expect(persisted.existingTool).toBeDefined();
    expect(persisted.newTool).toBeDefined();
  });
});
