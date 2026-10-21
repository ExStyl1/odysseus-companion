/**
 * Durable per-connection MCP tool descriptors.
 *
 * The pool's in-memory tool cache is only populated after a successful connect,
 * which is why a turn used to have to connect before it could advertise any
 * tool. Persisting the descriptors lets a previously-seen server be advertised
 * with zero network work.
 *
 * Records are keyed by the pool's connection identity WITH ANY PER-SESSION
 * ISOLATION TERM STRIPPED — `toolDescriptorStoreKey` in `mcp-pool.ts`, which on
 * the default shared posture is the connection key unchanged. That identity
 * hashes the whole server config including credentials and the plugin
 * executable, so a changed server addresses a different record by construction
 * and there is no separate invalidation path to get wrong.
 *
 * P3.371 · the STRIPPING is the load-bearing word, and it is a property of the
 * caller rather than of this module, so it is stated here too. What a server
 * reported is a fact about the SERVER; which session held the socket is not. Key
 * these records by an isolated connection identity and every isolated session
 * takes a permanent cache miss — a leaser id is fresh per setup, so no record is
 * ever read twice — while the directory grows by one file per session per server.
 *
 * ## `DA3.9` — how this is BOUNDED, and why not by a keep set
 *
 * This module used to export `prune(keep)` and nothing called it, which is what
 * "grows" meant. It is gone, and the reason is that no caller could ever have
 * supplied `keep` honestly:
 *
 * * **A pool cannot.** One store serves EVERY pool the process creates
 *   (`workspace-mcp-pool-registry.ts` builds it once at module scope), and a pool
 *   knows only its own workspace's desired identities. Pruning to those deletes
 *   another workspace's records.
 * * **The registry cannot either**, and this is the sharper half: the union over
 *   LIVE pools is exactly the set whose records the cache does not need. A record
 *   earns its place by belonging to a server that is NOT connected right now —
 *   that is what "advertised and callable before their first connect" means. A
 *   keep-set prune would delete precisely the records the cache exists to serve.
 *
 * So the bound is a CAP on the number of records, applied by the store itself at
 * write time, evicting the least recently written first. A dropped record is a
 * cache MISS and never a correctness problem: the identity hashes the whole
 * server config, so a record can only ever be read back by the exact server that
 * wrote it, and its absence costs one connect before that server's tools are
 * advertised again. Simple, visible where it happens, and it needs no caller to
 * know anything it cannot know.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

const SCHEMA_VERSION = 1;

interface DescriptorRecord {
  schemaVersion: number;
  connectionKey: string;
  tools: Tool[];
}

export interface ToolDescriptorStore {
  /** Descriptors last reported by this exact connection identity, if any. */
  read(connectionKey: string): Tool[] | undefined;
  /** Record what this connection identity reported. Never throws. */
  write(connectionKey: string, tools: readonly Tool[]): void;
}

/**
 * How many records one store directory keeps — `DA3.9`'s bound.
 *
 * A record is one distinct (slug, whole-config) identity this machine has ever
 * connected to, so the number a real user reaches is the number of MCP servers
 * they have configured plus one per credential or executable change. 200 is far
 * above that and far below "forever", which is what it replaced. It is a
 * constant rather than a setting because the pool has no settings layer of its
 * own, and because nothing an operator could set here is a decision they have
 * information to make: the cost of being wrong is one extra connect.
 */
export const TOOL_DESCRIPTOR_STORE_MAX_RECORDS = 200;

/** Stable, filesystem-safe file name for an opaque connection key. */
function recordFileName(connectionKey: string): string {
  return `${createHash('sha256').update(connectionKey).digest('hex')}.json`;
}

export function createToolDescriptorStore(
  rootDirectory: string,
  maxRecords: number = TOOL_DESCRIPTOR_STORE_MAX_RECORDS,
): ToolDescriptorStore {
  const pathFor = (connectionKey: string) => join(rootDirectory, recordFileName(connectionKey));

  /**
   * Keep the directory at `maxRecords`, oldest written first. `DA3.9`.
   *
   * Runs after a successful write, which is the only moment the count can rise,
   * and reads the directory rather than tracking a counter so a store opened on
   * a directory some earlier process filled is bounded on its first write too.
   * A record's mtime IS its last write: `write` renames a fresh temporary over
   * the target every time, so re-writing an identity refreshes it and a server
   * still in use is never the one evicted. Read in NANOSECONDS (`bigint: true`)
   * rather than `mtimeMs`, because two writes inside one millisecond are ordinary
   * in a reconcile and would otherwise tie — measured on this rig, two adjacent
   * writes differ by ~200 000 ns, so the ordering is real at this resolution and
   * a coin toss at the other.
   */
  const enforceCap = (): void => {
    try {
      const records = readdirSync(rootDirectory).filter(entry => entry.endsWith('.json'));
      if (records.length <= maxRecords) return;
      const byAge = records
        .map(entry => {
          const full = join(rootDirectory, entry);
          return { full, writtenAt: statSync(full, { bigint: true }).mtimeNs };
        })
        .sort((left, right) => (left.writtenAt < right.writtenAt ? -1 : left.writtenAt > right.writtenAt ? 1 : 0));
      for (const stale of byAge.slice(0, records.length - maxRecords)) {
        rmSync(stale.full, { force: true });
      }
    } catch {
      // Housekeeping; never fail a caller over it.
    }
  };

  return {
    read(connectionKey) {
      try {
        const raw = readFileSync(pathFor(connectionKey), 'utf-8');
        const record = JSON.parse(raw) as DescriptorRecord;
        if (record.schemaVersion !== SCHEMA_VERSION) return undefined;
        // A hash collision would otherwise serve another server's tools.
        if (record.connectionKey !== connectionKey) return undefined;
        if (!Array.isArray(record.tools)) return undefined;
        return record.tools;
      } catch {
        return undefined;
      }
    },

    write(connectionKey, tools) {
      try {
        mkdirSync(rootDirectory, { recursive: true });
        const record: DescriptorRecord = {
          schemaVersion: SCHEMA_VERSION,
          connectionKey,
          tools: [...tools],
        };
        const target = pathFor(connectionKey);
        // Atomic: a crash mid-write must not leave a truncated record that a
        // later read would have to distrust.
        const temporary = `${target}.${process.pid}.tmp`;
        writeFileSync(temporary, `${JSON.stringify(record)}\n`, { encoding: 'utf-8', mode: 0o600 });
        renameSync(temporary, target);
      } catch {
        // A cache write failure must never fail a connect.
        return;
      }
      enforceCap();
    },
  };
}
