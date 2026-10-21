/**
 * R49/f210 — the `/heapdump` writer contract (troubleshooting.md:39-49):
 * `~/Desktop` with a home fallback, `<baseName>.heapsnapshot` +
 * `<baseName>-diagnostics.json` naming, a counters-only JSON, and an error
 * row when the runtime has no `v8.writeHeapSnapshot`.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import v8 from 'node:v8';
import { AGENT_PROVIDERS, runtimesNotDecidedBy } from '../../agent/backend/runtime-vocabulary.ts';
import {
  RUNTIME_HEAPDUMP_CONVERSATION_PROCESS,
  describeHeapdumpConversationCoverage,
  writeHeapdump,
  type HeapdumpConversationProcess,
} from '../heapdump.ts';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeHome(withDesktop: boolean): string {
  const home = mkdtempSync(join(tmpdir(), 'heapdump-home-'));
  roots.push(home);
  if (withDesktop) mkdirSync(join(home, 'Desktop'));
  return home;
}

describe('writeHeapdump', () => {
  it('writes both files to Desktop when it exists, named from baseName, with a counters-only JSON', () => {
    const home = makeHome(true);
    const snapshotWrites: string[] = [];
    const result = writeHeapdump({
      baseName: 'session-abc',
      homeDir: home,
      snapshotWriter: (target) => {
        snapshotWrites.push(target);
        writeFileSync(target, '{"snapshot":true}');
      },
    });

    expect(result.success).toBe(true);
    expect(result.wroteTo).toBe('desktop');
    expect(result.snapshotPath).toBe(join(home, 'Desktop', 'session-abc.heapsnapshot'));
    expect(result.diagnosticsPath).toBe(join(home, 'Desktop', 'session-abc-diagnostics.json'));
    expect(snapshotWrites).toEqual([join(home, 'Desktop', 'session-abc.heapsnapshot')]);
    expect(result.errorMessage).toBeUndefined();

    const diagnostics = JSON.parse(readFileSync(result.diagnosticsPath!, 'utf8'));
    for (const key of ['rss', 'heapUsed', 'heapTotal', 'external', 'arrayBuffers', 'unaccountedNative'] as const) {
      expect(typeof diagnostics[key], key).toBe('number');
      expect(diagnostics[key]).toBeGreaterThanOrEqual(0);
    }
    expect(diagnostics.unaccountedNative)
      .toBe(Math.max(0, diagnostics.rss - diagnostics.heapTotal - diagnostics.external));
    // The result mirrors the same sample so the summary needs no re-read.
    expect(result.memory?.rss).toBeGreaterThan(0);
    // Owner-only: the snapshot holds every string in the process.
    if (process.platform !== 'win32') {
      expect(statSync(result.snapshotPath!).mode & 0o777).toBe(0o600);
      expect(statSync(result.diagnosticsPath!).mode & 0o777).toBe(0o600);
    }
  });

  it('falls back to the home directory when no Desktop folder exists', () => {
    const home = makeHome(false);
    const result = writeHeapdump({
      baseName: 'session-xyz',
      homeDir: home,
      snapshotWriter: (target) => writeFileSync(target, 'snap'),
    });

    expect(result.success).toBe(true);
    expect(result.wroteTo).toBe('home');
    expect(result.snapshotPath).toBe(join(home, 'session-xyz.heapsnapshot'));
    expect(result.diagnosticsPath).toBe(join(home, 'session-xyz-diagnostics.json'));
  });

  it('returns an error row when the runtime has no writeHeapSnapshot, but still writes the breakdown', () => {
    const home = makeHome(false);
    const result = writeHeapdump({ baseName: 'session-err', homeDir: home, snapshotWriter: null });

    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain('writeHeapSnapshot is not available');
    expect(result.snapshotPath).toBeUndefined();
    // The four documented numbers survive so the summary can still print them.
    expect(result.diagnosticsPath).toBe(join(home, 'session-err-diagnostics.json'));
    expect(result.memory?.rss).toBeGreaterThan(0);
    expect(existsSync(join(home, 'session-err.heapsnapshot'))).toBe(false);
  });

  it.skipIf(typeof v8.writeHeapSnapshot !== 'function')(
    'writes a real, non-empty V8 snapshot when the runtime implements it',
    () => {
      const home = makeHome(false);
      const result = writeHeapdump({ baseName: 'session-real', homeDir: home });

      expect(result.success).toBe(true);
      expect(result.snapshotPath).toBe(join(home, 'session-real.heapsnapshot'));
      expect(statSync(result.snapshotPath!).size).toBeGreaterThan(0);
      rmSync(result.snapshotPath!, { force: true });
    },
    // An EXPLICIT budget, because this case's cost is not its own: it writes a
    // REAL V8 snapshot, so it scales with the heap the SURROUNDING RUN has
    // already built. Alone that is a bare module graph — measured 2026-09-19, a
    // `bun -e` process snapshots in 14 ms for 577 KB — and inside the
    // whole-repo `bun test` it is the entire repository's graph. It was killed
    // at the 5 000 ms default on CI job 630550597 while its three sibling cases,
    // which stub `writeHeapSnapshot`, ran in about 1 ms each.
    //
    // Sized against the loaded-process case, never against the alone one: a
    // budget taken here would be set against 14 ms and would say nothing about
    // the only run that has ever failed.
    120_000,
  );
});

/**
 * P6.44 — `/heapdump` snapshots the host and never the process holding a
 * claude conversation.
 *
 * The contract sentence assumes the CLI's ONE-process shape
 * (`troubleshooting.md#high-cpu-or-memory-usage`: *"The `.heapsnapshot` file
 * contains every string in the process, including your full conversation and
 * credentials."*) and this product has three. The decision recorded for the row
 * is not to refuse and not to chase the runtime process — both measured
 * impossible on two of three — but to SAY which process was captured and NAME
 * the one that was not. These hold that the record cannot go quietly stale.
 */
describe('P6.44 · which process holds the conversation', () => {
  it('decides every runtime this build knows, and nothing it does not', () => {
    // The `Record<ModelProvider, …>` is the compiler half; this is the belt on
    // those braces, and it is also what catches a widening to `Partial` or to
    // `string` that the compiler would then wave through.
    expect(runtimesNotDecidedBy(RUNTIME_HEAPDUMP_CONVERSATION_PROCESS)).toEqual([]);
    expect(Object.keys(RUNTIME_HEAPDUMP_CONVERSATION_PROCESS).sort())
      .toEqual([...AGENT_PROVIDERS].sort());
  });

  it('pairs `captured: false` with a reason in BOTH directions', () => {
    // A missing reason would print "which this dump does NOT include: undefined";
    // a reason beside `captured: true` is a claim nobody reads.
    // Read through the DECLARED interface, not the `as const` literal union:
    // the literal type of the one captured arm has no `reason` at all, so the
    // absent-direction assertion would not compile against it.
    const entries = Object.entries(RUNTIME_HEAPDUMP_CONVERSATION_PROCESS) as [string, HeapdumpConversationProcess][];
    for (const [provider, entry] of entries) {
      expect({ provider, hasReason: entry.reason !== undefined })
        .toEqual({ provider, hasReason: !entry.captured });
      expect(entry.process.trim().length).toBeGreaterThan(0);
    }
  });

  it('claims exactly one runtime as captured — the one with a `requestHeapdump`', () => {
    // `PiAgent.requestHeapdump()` is the only implementation in the tree; the
    // day a second backend grows one, this fails and the record is updated
    // rather than drifting into a false "captured".
    const captured = Object.entries(RUNTIME_HEAPDUMP_CONVERSATION_PROCESS)
      .filter(([, entry]) => entry.captured)
      .map(([provider]) => provider);
    expect(captured).toEqual(['pi']);
  });

  it('names the missing process on a runtime it cannot dump, and says the host still holds the conversation', () => {
    const lines = describeHeapdumpConversationCoverage('anthropic');

    expect(lines.join(' ')).toContain("the Claude Agent SDK's native child process");
    expect(lines.join(' ')).toContain('does NOT include');
    // The privacy warning stays TRUE and this must not read as if it were not:
    // the host holds `managed.messages`, so the snapshot really does contain
    // conversation strings.
    expect(lines.join(' ')).toContain('still holds the conversation');
    expect(lines.join(' ')).not.toContain('undefined');
  });

  it('says the subprocess dump is included on the runtime that answers one', () => {
    const lines = describeHeapdumpConversationCoverage('pi');

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('the Pi agent subprocess');
    expect(lines[0]).toContain('included above');
    expect(lines[0]).not.toContain('NOT include');
  });

  it('treats a runtime this build does not know as NOT captured', () => {
    // `getLlmConnections()` returns stored config with no per-field validation,
    // so an unknown provider really can arrive here. Defaulting open would
    // re-create the exact silence the row is about.
    for (const unknown of ['gemini-runtime', undefined]) {
      const lines = describeHeapdumpConversationCoverage(unknown);
      expect(lines.join(' ')).toContain('NOT captured');
      expect(lines.join(' ')).not.toContain('included above');
    }
  });
});

/**
 * P6.453 — the two-sample growth rate.
 *
 * The baseline is module-scoped, so these two tests are written to be
 * order-independent inside this file: neither asserts which call was the first
 * one, only what happens between two consecutive dumps. The threshold is real
 * wall time because the rate is real wall time; 1.1s is the smallest wait that
 * clears the one-second floor without being flaky on a loaded box.
 */
describe('/heapdump growth rate (P6.453)', () => {
  it('a second dump a second later carries a signed rate against the previous one', async () => {
    const home = makeHome(true);
    writeHeapdump({ baseName: 'growth-first', homeDir: home, snapshotWriter: () => undefined });
    await new Promise(resolve => setTimeout(resolve, 1100));
    const second = writeHeapdump({ baseName: 'growth-second', homeDir: home, snapshotWriter: () => undefined });

    expect(second.growth).toBeDefined();
    expect(second.growth!.since).toBe('previous-dump');
    expect(second.growth!.seconds).toBeGreaterThanOrEqual(1);
    // Signed on purpose: a process that gave memory back must read as negative,
    // not be clamped to zero the way `unaccountedNative` is.
    expect(Number.isFinite(second.growth!.rssBytesPerSecond)).toBe(true);
    expect(Number.isFinite(second.growth!.rssDeltaBytes)).toBe(true);

    // …and it reaches the file a user is told to attach, which stays
    // counters-only (troubleshooting.md:49 — no paths, no conversation).
    const payload = JSON.parse(readFileSync(second.diagnosticsPath!, 'utf8'));
    expect(payload.growth.since).toBe('previous-dump');
    expect(JSON.stringify(payload)).not.toContain(home);
  });

  it('two dumps inside the same second report NO rate rather than a fabricated one', () => {
    const home = makeHome(true);
    writeHeapdump({ baseName: 'growth-a', homeDir: home, snapshotWriter: () => undefined });
    const immediate = writeHeapdump({ baseName: 'growth-b', homeDir: home, snapshotWriter: () => undefined });

    // A byte delta over ~0.01s is allocator noise wearing a number's clothes.
    // Absence reads as "not enough time has passed"; a zero would not.
    expect(immediate.growth).toBeUndefined();
    const payload = JSON.parse(readFileSync(immediate.diagnosticsPath!, 'utf8'));
    expect('growth' in payload).toBe(false);
  });
});
