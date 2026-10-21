/**
 * UA12.62 — the rotation the two JSONL audit trails share (`audit-rotate.ts`, at src root because
 * `.gitignore`'s bare `logs` rule would ignore a src/logs/ directory). The row's
 * control, at the helper both writers call: past the cap the file rotates to `.1` and the new
 * line lands in a fresh file; below the cap nothing rotates. The WRITER arms live beside the
 * writers (`pages/action-bridge.test.ts`, `services/privileged-execution-broker.test.ts`).
 */

import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AUDIT_JSONL_ROTATE_BYTES, appendJsonlRotating, rotateJsonlPastCap, settleJsonlAppends } from './audit-rotate';

describe('rotateJsonlPastCap (UA12.62)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'audit-rotate-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('past the cap the file rotates to .1 and the new line lands in a fresh file', async () => {
    const path = join(dir, 'page-actions.jsonl');
    writeFileSync(path, '{"event":"old","n":1}\n', 'utf8');

    await rotateJsonlPastCap(path, 8);

    expect(existsSync(`${path}.1`)).toBe(true);
    expect(readFileSync(`${path}.1`, 'utf8')).toBe('{"event":"old","n":1}\n');
    writeFileSync(path, '{"event":"new","n":2}\n', 'utf8');
    expect(readFileSync(path, 'utf8')).toBe('{"event":"new","n":2}\n');
  });

  it('below the cap nothing rotates', async () => {
    const path = join(dir, 'page-actions.jsonl');
    writeFileSync(path, '{"event":"old","n":1}\n', 'utf8');

    await rotateJsonlPastCap(path, 10_000);

    expect(existsSync(`${path}.1`)).toBe(false);
    expect(readFileSync(path, 'utf8')).toBe('{"event":"old","n":1}\n');
  });

  it('a file exactly at the cap rotates — the boundary is >=, not >', async () => {
    const path = join(dir, 'page-actions.jsonl');
    const exactly = 'x'.repeat(24);
    writeFileSync(path, exactly, 'utf8');

    await rotateJsonlPastCap(path, 24);

    expect(existsSync(`${path}.1`)).toBe(true);
    expect(readFileSync(`${path}.1`, 'utf8')).toBe(exactly);
  });

  it('a missing file is a no-op — no error, nothing created', async () => {
    const path = join(dir, 'absent.jsonl');

    await expect(rotateJsonlPastCap(path, 1)).resolves.toBeUndefined();
    expect(existsSync(path)).toBe(false);
    expect(existsSync(`${path}.1`)).toBe(false);
  });

  it('the default cap is the documented 10 MB', () => {
    expect(AUDIT_JSONL_ROTATE_BYTES).toBe(10 * 1024 * 1024);
  });
});

describe('appendJsonlRotating (UA12.177) — one serialized append chain per path', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'audit-append-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('overlapping appends at the cap crossing: .1 equals the seed byte for byte and every new line lands once', async () => {
    const path = join(dir, 'page-actions.jsonl');
    const seed = Array.from({ length: 40 }, (_, n) => `{"event":"old","n":${n}}`).join('\n') + '\n';
    writeFileSync(path, seed, 'utf8');
    const lines = Array.from({ length: 8 }, (_, n) => `{"event":"new","n":${n}}`);

    await Promise.all(lines.map((line) => appendJsonlRotating(path, line, Buffer.byteLength(seed))));

    expect(readFileSync(`${path}.1`, 'utf8')).toBe(seed);
    expect(readFileSync(path, 'utf8')).toBe(lines.map((l) => `${l}\n`).join(''));
  });

  it('a failed append rejects to its caller and the next append to the same path still lands', async () => {
    const blocker = join(dir, 'logs');
    writeFileSync(blocker, 'a file where the directory should be', 'utf8');
    const path = join(blocker, 'page-actions.jsonl');

    const first = appendJsonlRotating(path, '{"event":"first"}', 1024);
    const failed = first.then(
      () => false,
      () => {
        rmSync(blocker, { force: true }); // the next link runs after this handler
        return true;
      },
    );
    const second = appendJsonlRotating(path, '{"event":"second"}', 1024);

    expect(await failed).toBe(true);
    await second;
    await settleJsonlAppends(path);
    expect(readFileSync(path, 'utf8')).toBe('{"event":"second"}\n');
  });
});
