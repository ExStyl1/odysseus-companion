/**
 * P5: ref-counted external project capability watcher
 * (plan deleted at release 1.2.0; recover with
 * `git show 4d038f04^:docs/current-plans/project-local-nessy-agent-and-workspace-roots.md`).
 *
 * The managed Workspace ConfigWatcher owns only managed Workspace/global
 * state; THIS registry owns external project roots. Watchers are keyed by the
 * immutable (WorkspaceId, ProjectKey) pair — never by display path — and watch
 * only the project root entries plus `.nessy-agent` and retained portable
 * directories, never the whole repository tree.
 *
 * Every event revalidates project identity/trust before any invalidation is
 * emitted. Identity or trust loss emits `identity`; ordinary content changes
 * emit `content` and refresh through the existing resolver lifecycle. Changes
 * under a legacy `.nessy` directory never produce an event.
 */

import { watch, type FSWatcher } from 'node:fs';
import { basename, join, sep } from 'node:path';

export interface ProjectWatchTarget {
  workspaceId: string;
  projectKey: string;
  canonicalPath: string;
  identityFingerprint: string;
}

export interface ProjectRevalidationResult {
  /** Identity fingerprint still matches and the project remains trusted. */
  ok: boolean;
}

export interface ProjectCapabilityWatcherOptions {
  revalidate(target: ProjectWatchTarget): Promise<ProjectRevalidationResult>;
  onInvalidate(target: ProjectWatchTarget, kind: 'content' | 'identity'): void;
  debounceMs?: number;
  /** Test seam over node:fs watch. */
  watchImpl?: typeof watch;
}

/** Project subtrees whose supported configuration participates in refresh. */
const WATCHED_PROJECT_DIRS = ['.nessy-agent', '.agents'];
const INERT_LEGACY_DIR = '.nessy';

interface WatchEntry {
  target: ProjectWatchTarget;
  refCount: number;
  watchers: FSWatcher[];
  debounce?: ReturnType<typeof setTimeout>;
  closed: boolean;
}

function entryKey(workspaceId: string, projectKey: string): string {
  return `${workspaceId}\u0000${projectKey}`;
}

export class ProjectCapabilityWatcherRegistry {
  private readonly entries = new Map<string, WatchEntry>();

  constructor(private readonly options: ProjectCapabilityWatcherOptions) {}

  /** Acquire one reference; returns an idempotent release. */
  acquire(target: ProjectWatchTarget): () => void {
    const key = entryKey(target.workspaceId, target.projectKey);
    let entry = this.entries.get(key);
    if (entry && !entry.closed) {
      entry.refCount += 1;
    } else {
      entry = { target, refCount: 1, watchers: [], closed: false };
      this.entries.set(key, entry);
      this.openWatchers(entry);
    }
    const held = entry;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      held.refCount -= 1;
      if (held.refCount <= 0) this.close(key);
    };
  }

  /** Release everything (server shutdown / workspace drain). */
  closeAll(workspaceId?: string): void {
    for (const [key, entry] of [...this.entries]) {
      if (workspaceId && entry.target.workspaceId !== workspaceId) continue;
      this.close(key);
    }
  }

  /** Live watcher count (tests: descriptor-leak proof). */
  size(): number {
    return this.entries.size;
  }

  /** Test/workaround seam mirroring ConfigWatcher.notifyFileChange. */
  notifyChange(workspaceId: string, projectKey: string, relativePath: string): void {
    const entry = this.entries.get(entryKey(workspaceId, projectKey));
    if (entry) this.handleEvent(entry, relativePath);
  }

  private openWatchers(entry: WatchEntry): void {
    const watchImpl = this.options.watchImpl ?? watch;
    const roots = [
      entry.target.canonicalPath,
      ...WATCHED_PROJECT_DIRS.map(dir => join(entry.target.canonicalPath, dir)),
    ];
    for (const root of roots) {
      try {
        const prefix = root === entry.target.canonicalPath ? '' : basename(root) + sep;
        const watcher = watchImpl(root, (eventType, fileName) => {
          this.handleEvent(entry, prefix + String(fileName ?? ''));
        });
        watcher.on('error', () => {
          // A removed/renamed directory invalidates like any other change;
          // revalidation decides whether identity is gone.
          this.handleEvent(entry, prefix);
        });
        entry.watchers.push(watcher);
      } catch {
        // Missing optional subtree (e.g. no .agents dir): the root watcher
        // observes its creation and the next acquire cycle re-opens it.
      }
    }
  }

  private handleEvent(entry: WatchEntry, relativePath: string): void {
    if (entry.closed) return;
    // Legacy `.nessy` has no product meaning: no event, no generation change.
    const segments = relativePath.split(sep);
    if (segments[0] === INERT_LEGACY_DIR) return;
    if (entry.debounce) clearTimeout(entry.debounce);
    entry.debounce = setTimeout(() => {
      entry.debounce = undefined;
      void this.emit(entry);
    }, this.options.debounceMs ?? 150);
  }

  private async emit(entry: WatchEntry): Promise<void> {
    if (entry.closed) return;
    let ok = false;
    try {
      ok = (await this.options.revalidate(entry.target)).ok;
    } catch {
      ok = false;
    }
    if (entry.closed) return;
    // P2.284 — the eighth floating emission of the class 53849b319/9a95ae0ff
    // swept, and the one nobody could see: this file carries a NUL byte (the
    // key separator at `entryKey`), so the wrapped `grep` returns NOTHING for
    // it while `-a` finds the line.
    //
    // `handleEvent` starts this method as `void this.emit(entry)` from a
    // debounce timer, so `emit` has no caller and no belt: everything it throws
    // is a REJECTION nobody holds. `revalidate` above was already contained;
    // this host callback was not — and it is the half most likely to throw,
    // because it is `SessionManager`'s, which walks every live session and
    // starts a plugin-runtime refresh. Escaping, it reached only
    // `process.on('unhandledRejection')`: a generic `[server] Unhandled
    // rejection` line that names neither the project nor the kind, and in a
    // packaged Electron build no line at all.
    //
    // Containment IS the whole fix here, deliberately, unlike the seven
    // siblings that got a LABEL on a record their class already wrote. This
    // module has no record to label — it imports `node:fs` and `node:path` and
    // nothing else, by design: the host owns all reporting, and the only host
    // that wires it is out of this row's zone. The gap is reported rather than
    // papered over with an `onError` option nothing would pass.
    try {
      this.options.onInvalidate(entry.target, ok ? 'content' : 'identity');
    } catch {
      // A host that throws here has already lost THIS invalidation; the entry
      // stays open, so the next change under the project re-emits.
    }
  }

  private close(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.closed = true;
    if (entry.debounce) clearTimeout(entry.debounce);
    for (const watcher of entry.watchers.splice(0)) {
      try {
        watcher.close();
      } catch {
        // Already-closed descriptors are fine; nothing leaks.
      }
    }
    this.entries.delete(key);
  }
}
