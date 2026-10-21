/**
 * [nessy-fork] desktop-pet-session-aggregation
 *
 * Watches the per-session runtime.json sidecars written by external Nessy CLI
 * processes (terminal TUI and ACP modes, MR1/MR3) and pushes normalized
 * {@link PetSessionUpdate} snapshots. Direct port of the proven Swift
 * RuntimeStatusMonitor from nessy-session-notifier:
 *
 * - polling (not fs.watch): the sidecar is rewritten via temp+rename, so
 *   mtime polling is the reliable trigger;
 * - dedup by (phase, requestId, updatedAt) — identical states are not
 *   re-emitted;
 * - liveness by pid (`kill(pid, 0)`) re-checked every cycle for shown
 *   sessions — a killed CLI never rewrites its sidecar, so mtime alone
 *   would never notice; ESRCH ⇒ emit `gone` so the renderer drops the card;
 * - staleness by updated_at: terminal states (idle/done) hide after 6h
 *   (a finished CLI leaves the sidecar on disk by design), live phases
 *   (working/waiting_input) after 24h — the pid-reuse backstop; a live
 *   session may legitimately sit in one phase for hours (no heartbeat,
 *   writes are edge-triggered on transitions);
 * - sessions owned by desktop in-app agents are filtered out: the desktop
 *   spawns `nessy --acp` children whose sidecars would otherwise
 *   double-report alongside `session:event`.
 */

import * as fs from 'node:fs/promises';
import type { Stats } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import type { PetSessionPhase, PetSessionUpdate } from '@craft-agent/shared/protocol';

export const PET_SESSION_POLL_INTERVAL_MS = 2_000;
export const PET_SESSION_IDLE_HIDE_MS = 6 * 60 * 60 * 1000;
/**
 * Staleness window for LIVE phases (working/waiting_input): the
 * pid-reuse backstop only. Generous on purpose — a session may legitimately
 * sit in one phase for hours (an overnight permission prompt, a long tool
 * call); sidecar writes are edge-triggered on transitions, no heartbeat.
 */
export const PET_SESSION_LIVE_STALE_HIDE_MS = 24 * 60 * 60 * 1000;

export interface TerminalSessionWatcherDeps {
  /** Push a normalized snapshot to the renderer (pet:sessionUpdate). */
  emit: (update: PetSessionUpdate) => void;
  /** Live desktop in-app session ids — their sidecars are skipped. */
  getDesktopSessionIds: () => Set<string>;
  /** Source gates; read every cycle so settings toggles apply within ≤2s. */
  getTerminalSessionsEnabled?: () => boolean;
  getAcpSessionsEnabled?: () => boolean;
  /** Epoch ms; injectable for tests. */
  now?: () => number;
  /**
   * Full command line of a pid (default: `ps -o command= -p <pid>`); used to
   * classify ACP sessions (`--acp` flag). Returns null when unavailable —
   * callers then assume a terminal session.
   */
  readProcessCommand?: (pid: number) => Promise<string | null>;
}

interface TrackedSession {
  /** Prefixed renderer-facing id (`terminal:<raw>`). */
  sessionId: string;
  source: 'terminal' | 'acp';
  phase: PetSessionPhase;
  requestId?: string;
  updatedAt?: number;
  pid?: number;
  /** Unprefixed CLI session id — the desktop-ownership recheck key. */
  rawSessionId: string;
}

/** Raw runtime.json state block as written by the CLI (snake_case). */
interface RuntimeSidecar {
  schema_version?: number;
  pid?: number;
  session_id?: string;
  work_dir?: string;
  state?: {
    phase?: string;
    updated_at?: number;
    /** Owning CLI mode ('tui' | 'acp'), 0.13.13+; absent on older CLIs. */
    source?: string;
    pending_request?: {
      request_id?: string;
      tool_name?: string;
      summary?: string;
      options?: Array<{ option_id?: string; name?: string }>;
      questionnaire?: boolean;
    } | null;
    control?: { input_file?: string } | null;
  };
}

const isProcessAlive = (pid: number | undefined): boolean => {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to another user — still alive.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

export class TerminalSessionWatcher {
  private readonly nessyProjectsDir: string;
  private readonly deps: TerminalSessionWatcherDeps;
  private readonly tracked = new Map<string, TrackedSession>();
  private readonly mtimeCache = new Map<string, string>();
  private readonly commandCache = new Map<number, string | null>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;

  constructor(nessyDir: string, deps: TerminalSessionWatcherDeps) {
    this.nessyProjectsDir = path.join(nessyDir, 'projects');
    this.deps = deps;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(
      () => void this.poll(),
      PET_SESSION_POLL_INTERVAL_MS,
    );
    // Never keep the host process alive on our own account (matters in
    // tests, which register handlers but exit right after).
    this.timer.unref?.();
    void this.poll();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * One scan cycle. Safe to call directly from tests; concurrent re-entry
   * (interval firing while a slow scan is in flight) is ignored.
   */
  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const terminalEnabled = this.deps.getTerminalSessionsEnabled?.() ?? true;
      const acpEnabled = this.deps.getAcpSessionsEnabled?.() ?? false;
      if (!terminalEnabled && !acpEnabled) {
        // Even with both gates off, previously shown cards must drop within
        // one poll interval — forgetting tracked files emits their `gone`.
        for (const file of [...this.tracked.keys()]) this.forget(file);
        return;
      }

      const files = await this.listSidecarFiles();
      const listed = new Set(files);
      for (const file of files) {
        await this.pollFile(file, terminalEnabled, acpEnabled);
      }
      // Shown sessions whose sidecar vanished from disk between scans (a
      // deleted/rotated session) are not in `files` — sweep them so their
      // cards get a `gone` too.
      for (const file of [...this.tracked.keys()]) {
        if (!listed.has(file)) this.forget(file);
      }
    } catch {
      // ~.nessy/projects may not exist yet (fresh install) — nothing to watch.
    } finally {
      this.polling = false;
    }
  }

  private async listSidecarFiles(): Promise<string[]> {
    const projects = await fs.readdir(this.nessyProjectsDir, {
      withFileTypes: true,
    });
    const files: string[] = [];
    for (const project of projects) {
      if (!project.isDirectory()) continue;
      const chatsDir = path.join(this.nessyProjectsDir, project.name, 'chats');
      let entries;
      try {
        entries = await fs.readdir(chatsDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith('.runtime.json')) {
          files.push(path.join(chatsDir, entry.name));
        }
      }
    }
    return files;
  }

  private async pollFile(
    file: string,
    terminalEnabled: boolean,
    acpEnabled: boolean,
  ): Promise<void> {
    const prev = this.tracked.get(file);

    let stat: Stats | null = null;
    try {
      stat = await fs.stat(file);
    } catch {
      stat = null;
    }

    // A killed CLI never rewrites its sidecar, so liveness of an already
    // shown session is re-checked every cycle — not only on mtime change —
    // or its card would linger forever. A vanished sidecar means the same.
    if (prev && (!stat || !isProcessAlive(prev.pid))) {
      this.forget(file);
      return;
    }

    if (!stat) {
      // Never tracked (or already cleared above) — just forget the cache so
      // a recreated sidecar re-parses from scratch.
      this.mtimeCache.delete(file);
      return;
    }

    // The cache key embeds the gate state: an unchanged file with flipped
    // gates must be re-evaluated once (≤ one poll interval contract), while
    // an unchanged file under unchanged gates never re-parses — neither the
    // stale re-parse loop for gated-off sidecars nor re-emitted cards.
    const fingerprint = `${stat.mtimeMs}:${stat.size}|${terminalEnabled ? 1 : 0}${acpEnabled ? 1 : 0}`;
    if (this.mtimeCache.get(file) === fingerprint) {
      // Unchanged file and gates — the cheap pass over the tracked state
      // covers what the parse path would re-decide: desktop ownership
      // (session adopted by the app mid-life), gate-off, staleness
      // (pid-reuse backstop: a dead CLI's card whose pid got recycled
      // never rewrites the sidecar).
      if (
        prev &&
        this.#superseded(
          prev.source,
          prev.phase,
          prev.updatedAt,
          prev.rawSessionId,
          terminalEnabled,
          acpEnabled,
        )
      ) {
        this.forget(file);
      }
      return;
    }

    let sidecar: RuntimeSidecar;
    try {
      sidecar = JSON.parse(await fs.readFile(file, 'utf-8')) as RuntimeSidecar;
    } catch {
      // Torn read of a temp+rename cycle — the fingerprint is deliberately
      // not cached, so the next poll re-reads the file.
      return;
    }
    this.mtimeCache.set(file, fingerprint);
    if (
      sidecar.schema_version !== 1 ||
      !sidecar.state ||
      typeof sidecar.state.phase !== 'string'
    ) {
      return; // pre-MR1 sidecar without a state block — not our concern.
    }

    const rawSessionId = sidecar.session_id;
    if (!rawSessionId) return;

    const alive = isProcessAlive(sidecar.pid);
    const state = sidecar.state!;
    const updatedAt =
      typeof state.updated_at === 'number' ? state.updated_at : undefined;
    const phase = state.phase as PetSessionPhase;

    // Desktop in-app agents own their `nessy --acp` child sidecars; their
    // cards already arrive via session:event — never double-report. A
    // session that becomes desktop-owned mid-life (race window) must drop
    // its previously shown card the same way liveness does — a bare
    // tracked.delete would strand the card forever (every later `gone`
    // path iterates tracked).
    if (
      !alive ||
      this.#superseded(
        null,
        phase,
        updatedAt,
        rawSessionId,
        terminalEnabled,
        acpEnabled,
      )
    ) {
      this.forget(file);
      return;
    }

    const source = await this.classifySource(
      sidecar.pid!,
      state.source,
    );
    if (
      this.#superseded(
        source,
        phase,
        updatedAt,
        rawSessionId,
        terminalEnabled,
        acpEnabled,
      )
    ) {
      // Gate off (or a post-classification eviction — #superseded is the
      // single predicate). The fingerprint cache keeps the gate-keyed
      // value, so the file is NOT re-parsed every cycle; re-enabling the
      // gate changes the key and the session re-shows.
      if (prev) this.forget(file);
      return;
    }

    const pending = state.pending_request ?? null;
    const requestId = pending?.request_id;

    if (
      prev &&
      prev.phase === phase &&
      prev.requestId === requestId &&
      prev.updatedAt === updatedAt
    ) {
      return; // dedup: nothing changed since the last emission
    }

    const update: PetSessionUpdate = {
      sessionId: `terminal:${rawSessionId}`,
      source,
      phase,
      title: sidecar.work_dir
        ? path.basename(sidecar.work_dir) || sidecar.work_dir
        : undefined,
      workDir: sidecar.work_dir,
      pid: sidecar.pid,
      requestId,
      toolName: pending?.tool_name,
      summary: pending?.summary,
      options: pending?.options
        ?.filter((o) => typeof o.option_id === 'string')
        .map((o) => ({
          optionId: o.option_id!,
          name: typeof o.name === 'string' ? o.name : o.option_id!,
        })),
      questionnaire: pending?.questionnaire,
      controlInputFile: state.control?.input_file ?? undefined,
      updatedAt,
    };
    this.tracked.set(file, {
      sessionId: update.sessionId,
      source,
      phase,
      requestId,
      updatedAt,
      pid: sidecar.pid,
      rawSessionId,
    });
    this.deps.emit(update);
  }

  /**
   * The single eviction predicate shared by the fingerprint-hit path
   * (prev-based) and the parse path (freshly parsed). `source === null`
   * means the parse path (gates checked separately there after
   * classification). Returns true when the session must be dropped now:
   * desktop-owned, gate off, or stale for its phase.
   */
  #superseded(
    source: 'terminal' | 'acp' | null,
    phase: PetSessionPhase,
    updatedAt: number | undefined,
    rawSessionId: string | undefined,
    terminalEnabled: boolean,
    acpEnabled: boolean,
  ): boolean {
    if (
      rawSessionId !== undefined &&
      this.deps.getDesktopSessionIds().has(rawSessionId)
    ) {
      return true;
    }
    if (source !== null) {
      const gateOff = source === 'terminal' ? !terminalEnabled : !acpEnabled;
      if (gateOff) return true;
    }
    if (updatedAt === undefined) return false;
    const age = this.now() - updatedAt * 1000;
    // Terminal states (idle/done) are clutter after 6h; live phases only
    // after 24h (pid-reuse backstop — see PET_SESSION_LIVE_STALE_HIDE_MS).
    const window =
      phase === 'working' || phase === 'waiting_input'
        ? PET_SESSION_LIVE_STALE_HIDE_MS
        : PET_SESSION_IDLE_HIDE_MS;
    return age > window;
  }

  /** Drop a session from tracking and tell the renderer to drop its card. */
  private forget(file: string): void {
    const tracked = this.tracked.get(file);
    if (!tracked) return;
    this.tracked.delete(file);
    this.mtimeCache.delete(file);
    // The pid's command cache would go stale if the OS reuses the pid.
    if (tracked.pid !== undefined) this.commandCache.delete(tracked.pid);
    this.deps.emit({
      sessionId: tracked.sessionId,
      source: tracked.source,
      phase: 'gone',
      updatedAt: this.now() / 1000,
    });
  }

  private async classifySource(
    pid: number,
    stateSource?: string,
  ): Promise<'terminal' | 'acp'> {
    // The CLI stamps its mode into the state block (0.13.13+) —
    // authoritative and cross-platform (`ps` does not exist on Windows).
    if (stateSource === 'acp') return 'acp';
    if (stateSource === 'tui') return 'terminal';
    // Older CLIs: fall back to the `ps` command-line heuristic.
    if (this.commandCache.has(pid)) {
      return this.commandCache.get(pid)!.includes('--acp') ? 'acp' : 'terminal';
    }
    const command = await this.readProcessCommand(pid);
    this.commandCache.set(pid, command);
    return command?.includes('--acp') ? 'acp' : 'terminal';
  }

  private readProcessCommand(pid: number): Promise<string | null> {
    if (this.deps.readProcessCommand) {
      return this.deps.readProcessCommand(pid);
    }
    return new Promise((resolve) => {
      execFile(
        'ps',
        ['-o', 'command=', '-p', String(pid)],
        { timeout: 2_000 },
        (err, stdout) => {
          resolve(err ? null : stdout);
        },
      );
    });
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
}

/** Resolve the nessy home the same way the CLI does (NESSY_HOME override). */
export function resolveNessyDir(): string {
  return process.env['NESSY_HOME'] ?? path.join(os.homedir(), '.nessy');
}
