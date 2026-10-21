/**
 * The `/heapdump` writer (troubleshooting.md:39-49): two files per process —
 * `<baseName>.heapsnapshot`, a V8 heap snapshot, and
 * `<baseName>-diagnostics.json`, a memory breakdown. Files land in
 * `~/Desktop` when that folder exists, else the home directory (the
 * documented Linux fallback), mode 0600.
 *
 * PRIVACY CONTRACT (troubleshooting.md:41,49): the `.heapsnapshot` contains
 * every string in the process — the full conversation and credentials — and
 * must never be shared; the `-diagnostics.json` carries memory statistics
 * ONLY, so it stays safe to attach to a report. Never add workspace paths,
 * session content, or credential material to the JSON.
 *
 * Shared between the desktop/server host and the Pi subprocess
 * (pi-agent-server bundles it by relative import), so this module must not
 * import server-core.
 */
import { chmodSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import v8 from 'node:v8';
import type { ModelProvider } from '../config/models.ts';
import { getAppVersion } from '../version/index.ts';

/** The four documented counters plus the derived native remainder, in bytes. */
export interface HeapdumpMemoryBreakdown {
  rss: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
  arrayBuffers: number;
  /** max(0, rss − heapTotal − external) — native memory no counter accounts for. */
  unaccountedNative: number;
}

/**
 * P6.453 — the two-sample rate, which a single dump file cannot carry.
 *
 * `troubleshooting.md#high-cpu-or-memory-usage` sends a user here to decide
 * whether memory is GROWING, and every number above is an instant. One
 * snapshot of 900 MB says nothing: a process that has held 900 MB since boot
 * and one gaining 3 MB a second print identically. The second sample is
 * therefore taken from the process itself rather than from the user — the
 * first dump reports growth since the process started, and every later dump
 * reports growth since the previous one, so a reader who runs `/heapdump`
 * twice a minute apart gets the rate without knowing to ask for it.
 *
 * Deliberately NOT a busy-wait for a second sample inside one dump:
 * {@link writeHeapdump} is synchronous because it must work on a wedged
 * process, and a rate measured over a few blocked milliseconds would be noise
 * wearing a number's clothes.
 */
export interface HeapdumpGrowthV1 {
  /** Which baseline the deltas are against — the first dump has only one. */
  since: 'process-start' | 'previous-dump';
  /** Elapsed wall time between the two samples. */
  seconds: number;
  rssDeltaBytes: number;
  heapUsedDeltaBytes: number;
  /** Signed: a process that gave memory back reads as negative, not as zero. */
  rssBytesPerSecond: number;
}

/**
 * One process's dump row. Also the wire shape of the Pi subprocess's
 * `heapdump_result` payload (minus `type`/`id`), so host and subprocess rows
 * render through the same summary formatter.
 */
export interface HeapdumpWriteResult {
  /** True only when BOTH files were written. */
  success: boolean;
  /** Which directory rule matched: the Desktop folder, or the home fallback. */
  wroteTo?: 'desktop' | 'home';
  snapshotPath?: string;
  diagnosticsPath?: string;
  /** Sampled even when a write fails, so the summary can still print numbers. */
  memory?: HeapdumpMemoryBreakdown;
  /** `process.getActiveResourcesInfo()` count, when the runtime provides it. */
  activeResources?: number;
  /**
   * Growth since the previous sample of THIS process. Absent on a dump taken
   * so soon after the baseline that a rate would be meaningless, and absent
   * when the write failed before sampling.
   */
  growth?: HeapdumpGrowthV1;
  errorMessage?: string;
}

/**
 * WHICH PROCESS HOLDS THE CONVERSATION, per runtime — and whether `/heapdump`
 * can snapshot it (P6.44).
 *
 * `troubleshooting.md#high-cpu-or-memory-usage` says of the snapshot:
 * *"The `.heapsnapshot` file contains every string in the process, including
 * your full conversation and credentials."* **That sentence assumes the CLI's
 * one-process shape, and this product has three.** Here the host writes its own
 * dump, one runtime's agent process answers a dump request of its own, and two
 * cannot be dumped at all — so a claude session used to print one host section
 * and say NOTHING about the other process, which is exactly the process you are
 * looking at when memory is high.
 *
 * The decision recorded for that row is *say which process it captured and NAME
 * the one it could not* — not refuse (the host counters are real and the four
 * documented numbers must still print), and not target the runtime process
 * (measured impossible on two of three, see the `reason` fields).
 *
 * It is a `Record<ModelProvider, …>` for the reason
 * `RUNTIME_FILE_CHECKPOINT_PRODUCERS` is: a new runtime must BREAK THE BUILD
 * here rather than inherit a silent "captured". Defaulting open would re-create
 * the lie the row is about.
 *
 * `ModelProvider` and `AgentProvider` are the same union
 * (`agent/backend/types.ts` — `export type AgentProvider = ModelProvider`); the
 * type is taken from `config/models.ts` because `backend/types.ts` imports
 * {@link HeapdumpWriteResult} from THIS file, and a type cycle here would be
 * gratuitous.
 */
export interface HeapdumpConversationProcess {
  /** Where the agent loop, its context window and its transcript actually live. */
  process: string;
  /** Does a `/heapdump` produce a snapshot of THAT process? */
  captured: boolean;
  /**
   * Why not — measured, never assumed. Present exactly when `captured` is
   * false, which the accompanying test asserts in both directions.
   */
  reason?: string;
}

export const RUNTIME_HEAPDUMP_CONVERSATION_PROCESS = Object.freeze({
  // The one runtime that answers a dump request of its own: `PiAgent`
  // implements `requestHeapdump()` and the subprocess writes its pair through
  // this same module, rendered as its own section of the summary.
  pi: Object.freeze({
    process: 'the Pi agent subprocess',
    captured: true,
  }),
  // Measured on the vendored SDK: `heapdump` 0, `writeHeapSnapshot` 0,
  // `memoryUsage` 0, `rss` 0 across the control surface, against the positive
  // controls `getContextUsage` 1 and `rewindFiles` 3.
  anthropic: Object.freeze({
    process: "the Claude Agent SDK's native child process",
    captured: false,
    reason: 'the SDK exposes no heap-snapshot or memory control request',
  }),
  // Measured on the generated protocol: 0 of 278 client-request methods match
  // heap/memory/dump/diagnostics, with three named methods as the controls.
  'codex-runtime': Object.freeze({
    process: 'the codex-app-server child process',
    captured: false,
    reason: 'codex publishes no heap-snapshot or memory request in its protocol',
  }),
  // Not a local process at all: `NestorCloudClient` is an A2A JSON-RPC client
  // over HTTP, so the loop runs on the service and there is nothing on this
  // machine to snapshot.
  'nestor-cloud-agent': Object.freeze({
    process: 'the remote agent service',
    captured: false,
    reason: 'the agent loop runs on the server, so there is no local process to snapshot',
  }),
} as const) satisfies Readonly<Record<ModelProvider, HeapdumpConversationProcess>>;

/**
 * The sentence(s) a `/heapdump` summary appends so it never implies it captured
 * more than it did.
 *
 * Returns lines, not a paragraph, because the caller composes a line-oriented
 * summary. An unknown runtime — `getLlmConnections()` returns stored config
 * with no per-field validation, so one really can arrive — gets the honest
 * "this build does not know" answer rather than being silently treated as
 * captured.
 */
export function describeHeapdumpConversationCoverage(provider: string | undefined): string[] {
  const known = provider === undefined
    ? undefined
    : (RUNTIME_HEAPDUMP_CONVERSATION_PROCESS as Readonly<Record<string, HeapdumpConversationProcess | undefined>>)[provider];

  if (!known) {
    return [
      `This dump covers the host process. This build does not know where the agent loop runs for runtime "${provider ?? 'unknown'}", so assume it was NOT captured.`,
    ];
  }
  if (known.captured) {
    return [`The agent loop for this session runs in ${known.process}, and its own dump is included above.`];
  }
  return [
    `The agent loop for this session runs in ${known.process}, which this dump does NOT include: ${known.reason}.`,
    'The host section above still holds the conversation itself, so the warning below applies to it — what is missing is the agent loop, the context window and the tool state.',
  ];
}

export type HeapdumpSnapshotWriter = (targetPath: string) => void;

export interface WriteHeapdumpOptions {
  /**
   * File base name — the SESSION ID for the host dump
   * (`<session-id>.heapsnapshot`, troubleshooting.md:39), `<session-id>-pi`
   * for the Pi subprocess's own dump.
   */
  baseName: string;
  /** Injected for tests; defaults to os.homedir(). */
  homeDir?: string;
  /**
   * Injected for tests; defaults to `v8.writeHeapSnapshot` when the runtime
   * implements it (Electron's Node does; Bun may not). Pass `null` to
   * simulate a runtime without the API.
   */
  snapshotWriter?: HeapdumpSnapshotWriter | null;
}

/** `~/Desktop` when it exists, else the home directory (troubleshooting.md:39). */
export function resolveHeapdumpDir(homeDir: string = homedir()): { dir: string; wroteTo: 'desktop' | 'home' } {
  const desktop = join(homeDir, 'Desktop');
  try {
    if (statSync(desktop).isDirectory()) return { dir: desktop, wroteTo: 'desktop' };
  } catch {
    // No Desktop folder — the documented home fallback.
  }
  return { dir: homeDir, wroteTo: 'home' };
}

function defaultSnapshotWriter(): HeapdumpSnapshotWriter | null {
  // FEATURE-DETECT: Bun's node:v8 may not implement writeHeapSnapshot; the
  // desktop host's Electron Node does. Absent → the caller gets an error row.
  return typeof v8.writeHeapSnapshot === 'function'
    ? (targetPath: string) => { v8.writeHeapSnapshot(targetPath); }
    : null;
}

function sampleMemory(): HeapdumpMemoryBreakdown {
  const usage = process.memoryUsage();
  return {
    rss: usage.rss,
    heapUsed: usage.heapUsed,
    heapTotal: usage.heapTotal,
    external: usage.external,
    arrayBuffers: usage.arrayBuffers,
    unaccountedNative: Math.max(0, usage.rss - usage.heapTotal - usage.external),
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * P6.453 — the baseline the next dump's rate is measured against.
 *
 * Module scope, so it exists in whichever process imported this module: the
 * desktop/server host has one and the Pi subprocess has its own, and neither
 * can report the other's growth by accident. Seeded at module load, which for
 * both of those is close enough to process start that the first dump's
 * `'process-start'` label is honest — and the label says which baseline it is
 * rather than leaving the reader to assume.
 */
let heapdumpGrowthBaseline: { rss: number; heapUsed: number; atMs: number; kind: 'process-start' | 'previous-dump' } = {
  rss: 0,
  heapUsed: 0,
  atMs: Date.now(),
  kind: 'process-start',
};
try {
  const seed = process.memoryUsage();
  heapdumpGrowthBaseline = { rss: seed.rss, heapUsed: seed.heapUsed, atMs: Date.now(), kind: 'process-start' };
} catch {
  // A runtime without `process.memoryUsage()` cannot produce a breakdown at
  // all, so the dump has bigger problems than a missing rate; leave the zero
  // seed and let the guard below suppress the row.
}

/**
 * A rate needs a floor, and the floor is one second rather than zero: two
 * dumps taken in the same second divide a byte delta by ~0.01 s and produce a
 * "growth rate" of tens of megabytes per second out of ordinary allocator
 * noise. Under the floor the row is ABSENT, which reads as "not enough time
 * has passed" — the honest answer — instead of as a number.
 */
const HEAPDUMP_GROWTH_MIN_SECONDS = 1;

function measureGrowth(current: HeapdumpMemoryBreakdown): HeapdumpGrowthV1 | undefined {
  const now = Date.now();
  const baseline = heapdumpGrowthBaseline;
  heapdumpGrowthBaseline = { rss: current.rss, heapUsed: current.heapUsed, atMs: now, kind: 'previous-dump' };
  const seconds = (now - baseline.atMs) / 1000;
  if (!(seconds >= HEAPDUMP_GROWTH_MIN_SECONDS)) return undefined;
  const rssDeltaBytes = current.rss - baseline.rss;
  return {
    since: baseline.kind,
    seconds: Math.round(seconds),
    rssDeltaBytes,
    heapUsedDeltaBytes: current.heapUsed - baseline.heapUsed,
    rssBytesPerSecond: Math.round(rssDeltaBytes / seconds),
  };
}

/**
 * Write the current process's heap snapshot and memory breakdown. Synchronous
 * on purpose: `v8.writeHeapSnapshot` blocks the event loop anyway, and a dump
 * must work on a wedged process.
 */
export function writeHeapdump(options: WriteHeapdumpOptions): HeapdumpWriteResult {
  const { dir, wroteTo } = resolveHeapdumpDir(options.homeDir);
  const memory = sampleMemory();
  // P6.453 — taken here, beside the sample, so the baseline advances exactly
  // once per dump whether or not either file gets written.
  const growth = measureGrowth(memory);
  const getActiveResourcesInfo = (process as { getActiveResourcesInfo?: () => readonly string[] }).getActiveResourcesInfo;
  const activeResources = typeof getActiveResourcesInfo === 'function'
    ? getActiveResourcesInfo.call(process).length
    : undefined;

  const errors: string[] = [];

  const diagnosticsTarget = join(dir, `${options.baseName}-diagnostics.json`);
  let diagnosticsPath: string | undefined;
  try {
    // Counters only — this file must stay safe to attach to a public report
    // (troubleshooting.md:49: no conversation content, no credentials).
    const payload = {
      ...memory,
      ...(activeResources === undefined ? {} : { activeResources }),
      ...(growth === undefined ? {} : { growth }),
      pid: process.pid,
      uptimeSeconds: Math.round(process.uptime()),
      versions: process.versions,
      appVersion: getAppVersion(),
    };
    writeFileSync(diagnosticsTarget, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    diagnosticsPath = diagnosticsTarget;
  } catch (error) {
    errors.push(`Failed to write ${diagnosticsTarget}: ${describeError(error)}`);
  }

  const snapshotWriter = options.snapshotWriter !== undefined ? options.snapshotWriter : defaultSnapshotWriter();
  let snapshotPath: string | undefined;
  if (!snapshotWriter) {
    errors.push('v8.writeHeapSnapshot is not available in this runtime, so no .heapsnapshot was written');
  } else {
    const snapshotTarget = join(dir, `${options.baseName}.heapsnapshot`);
    try {
      snapshotWriter(snapshotTarget);
      // The snapshot holds every string in the process; keep it owner-only
      // like the JSON (v8 creates the file with the default mode).
      chmodSync(snapshotTarget, 0o600);
      snapshotPath = snapshotTarget;
    } catch (error) {
      errors.push(`Failed to write ${snapshotTarget}: ${describeError(error)}`);
    }
  }

  return {
    success: snapshotPath !== undefined && diagnosticsPath !== undefined,
    wroteTo,
    ...(snapshotPath === undefined ? {} : { snapshotPath }),
    ...(diagnosticsPath === undefined ? {} : { diagnosticsPath }),
    memory,
    ...(activeResources === undefined ? {} : { activeResources }),
    ...(growth === undefined ? {} : { growth }),
    ...(errors.length === 0 ? {} : { errorMessage: errors.join('; ') }),
  };
}
