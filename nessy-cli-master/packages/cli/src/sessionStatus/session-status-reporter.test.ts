/**
 * @license
 * Copyright 2026 Nessy Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  RUNTIME_STATUS_SCHEMA_VERSION,
  writeRuntimeStatus,
} from '@nestor/nessy-cli-core';
import { SessionStatusReporter } from './session-status-reporter.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'nessy-session-status-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

const runtimePath = (name = 'runtime.json') => path.join(tmpDir, name);

const readState = async (name = 'runtime.json') => {
  const data = JSON.parse(await readFile(runtimePath(name), 'utf-8'));
  return data['state'];
};

describe('SessionStatusReporter', () => {
  it('writes the first phase immediately, including the control block', async () => {
    await writeRuntimeStatus(runtimePath(), {
      sessionId: 'abc',
      workDir: '/w',
    });
    const reporter = new SessionStatusReporter(() => runtimePath());
    reporter.setControl({
      events_file: '/ctl/events.jsonl',
      input_file: '/ctl/input.jsonl',
    });
    reporter.setPhase('idle');
    reporter.setPhase('working');
    await reporter.flush();

    const state = await readState();
    expect(state.phase).toBe('working');
    expect(state.control.events_file).toBe('/ctl/events.jsonl');
    expect(state.control.input_file).toBe('/ctl/input.jsonl');
    expect(typeof state.updated_at).toBe('number');
    expect(state.pending_request).toBeNull();
  });

  it('stamps the owning CLI mode into the state block when given', async () => {
    await writeRuntimeStatus(runtimePath('a'), {
      sessionId: 'abc',
      workDir: '/w',
    });
    const withSource = new SessionStatusReporter(() => runtimePath('a'), 'tui');
    withSource.setPhase('idle');
    await withSource.flush();
    await expect(readState('a')).resolves.toMatchObject({
      phase: 'idle',
      source: 'tui',
    });

    // Absent mode stays absent — pre-0.13.13 consumers must not see a
    // surprise field shape change.
    await writeRuntimeStatus(runtimePath('b'), {
      sessionId: 'abc',
      workDir: '/w',
    });
    const withoutSource = new SessionStatusReporter(() => runtimePath('b'));
    withoutSource.setPhase('idle');
    await withoutSource.flush();
    const bare = await readState('b');
    expect(bare.source).toBeUndefined();
  });

  it('does not rewrite an identical consecutive phase', async () => {
    await writeRuntimeStatus(runtimePath(), {
      sessionId: 'abc',
      workDir: '/w',
    });
    let writes = 0;
    const reporter = new SessionStatusReporter(() => {
      writes += 1;
      return runtimePath();
    });
    reporter.setPhase('working');
    reporter.setPhase('working');
    reporter.setPhase('working');
    await reporter.flush();

    expect(writes).toBe(1);
  });

  it('records transitions in order', async () => {
    await writeRuntimeStatus(runtimePath(), {
      sessionId: 'abc',
      workDir: '/w',
    });
    const reporter = new SessionStatusReporter(() => runtimePath());
    reporter.setPhase('working');
    reporter.setPhase('waiting_input');
    reporter.setPhase('done');
    await reporter.flush();

    expect((await readState()).phase).toBe('done');
  });

  it('attaches and clears pending_request with the waiting phase', async () => {
    await writeRuntimeStatus(runtimePath(), {
      sessionId: 'abc',
      workDir: '/w',
    });
    const reporter = new SessionStatusReporter(() => runtimePath());
    const pending = {
      request_id: 'req-1',
      tool_name: 'write_file',
      summary: '/tmp/a.txt',
      options: [{ option_id: 'proceed_once', name: 'Allow once' }],
    };
    reporter.setPhase('waiting_input', pending);
    await reporter.flush();
    expect((await readState()).pending_request.request_id).toBe('req-1');

    reporter.setPhase('working');
    await reporter.flush();
    const state = await readState();
    expect(state.phase).toBe('working');
    expect(state.pending_request).toBeNull();

    // A new waiting phase re-attaches the request details.
    reporter.setPhase('waiting_input', pending);
    await reporter.flush();
    expect((await readState()).pending_request.request_id).toBe('req-1');
  });

  it('re-resolves the path on every write (session swap)', async () => {
    await writeRuntimeStatus(runtimePath('old.runtime.json'), {
      sessionId: 'old',
      workDir: '/w',
    });
    await writeRuntimeStatus(runtimePath('new.runtime.json'), {
      sessionId: 'new',
      workDir: '/w',
    });
    // Model the /clear swap: the resolver returns a different sidecar per
    // call (first write → old session, second → new). Serving paths in
    // order keeps the capture deterministic — a closure over a mutable
    // variable would only flip after the queued ops already ran.
    const targets = [
      runtimePath('old.runtime.json'),
      runtimePath('new.runtime.json'),
    ];
    let next = 0;
    const reporter = new SessionStatusReporter(() => targets[next++]!);
    reporter.setPhase('working');
    reporter.setPhase('done');
    await reporter.flush();

    expect((await readState('new.runtime.json')).phase).toBe('done');
    // The old sidecar keeps the last state written before the swap.
    expect((await readState('old.runtime.json')).phase).toBe('working');
  });

  it('swallows write failures without breaking the chain', async () => {
    // No sidecar exists: updateRuntimeStatusState returns false.
    const reporter = new SessionStatusReporter(() => runtimePath());
    reporter.setPhase('working');
    reporter.setPhase('done');
    await reporter.flush();
    await expect(readFile(runtimePath(), 'utf-8')).rejects.toThrow();

    // The chain still works once the sidecar appears.
    await writeRuntimeStatus(runtimePath(), {
      sessionId: 'abc',
      workDir: '/w',
    });
    reporter.setPhase('idle');
    await reporter.flush();
    expect((await readState()).phase).toBe('idle');
  });

  it('leaves a foreign-schema sidecar untouched', async () => {
    await writeFile(
      runtimePath(),
      JSON.stringify({ schema_version: 9999, session_id: 'x' }),
      'utf-8',
    );
    const reporter = new SessionStatusReporter(() => runtimePath());
    reporter.setPhase('working');
    await reporter.flush();

    const data = JSON.parse(await readFile(runtimePath(), 'utf-8'));
    expect(data.schema_version).toBe(9999);
    expect(data['state']).toBeUndefined();
    expect(RUNTIME_STATUS_SCHEMA_VERSION).toBe(1);
  });
});
