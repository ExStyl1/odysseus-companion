/**
 * The registry of every Electron session partition this process talks through.
 *
 * Chromium sessions are ISOLATED: proxy rules, cookies and cache are per
 * `Session`, so `session.defaultSession.setProxy()` does nothing for a
 * `session.fromPartition(...)` one. Anything that opens its own partition and
 * is not listed here silently egresses direct, which in a proxy-only corporate
 * deployment means a feature that fails while the rest of the app works.
 *
 * The update feed is exactly that case: `electron-updater` issues
 * `electron.net.request({ session })` against its OWN named partition
 * (`electronHttpExecutor.js` — `getNetSession()` /
 * `session.fromPartition(NET_SESSION_NAME, { cache: false })`), so it rides
 * Chromium's network stack rather than Node's. The OS trust store reaches it
 * natively and needs no help from us; the configured proxy does not.
 *
 * The partition name is taken from `electron-updater`'s own export, not
 * copied: a package upgrade that renames it becomes a build/test failure
 * instead of a silent reversion to an unconfigured session.
 *
 * RULE: adding a `session.fromPartition(...)` or a `partition:` anywhere under
 * `apps/electron/src/main` means adding it here too — `session-partitions.test.ts`
 * fails the build otherwise.
 */
import { NET_SESSION_NAME } from 'electron-updater/out/electronHttpExecutor';

/** The browser pane's persistent partition (cookies/logins survive restarts). */
export const BROWSER_PANE_SESSION_PARTITION = 'persist:browser-pane';

/** The partition `electron-updater` fetches the update feed and artifacts on. */
export const UPDATER_SESSION_PARTITION: string = NET_SESSION_NAME;

/**
 * The offscreen page-thumbnail capture window's session (UA7.4): in-memory (no `persist:`
 * prefix, so nothing it caches outlives the process) and separate from every renderer
 * window's, so its request filter binds the thumbnail window alone. Registered 2026-10-10:
 * UA7.4 opened the partition without listing it here and `session-partitions.test.ts`
 * caught it — today its request filter admits only `data:`/`blob:`/`about:` so it cannot
 * egress at all, but this registry is the one place that knows, and the proxy pass covers
 * it the day the filter widens.
 */
export const PAGE_THUMBNAIL_PARTITION = 'nessy-page-thumbnail';

export type ManagedSessionPartition = {
  /** Partition name, or `null` for `session.defaultSession`. */
  readonly partition: string | null;
  /**
   * Creation options. Electron applies these only to the call that CREATES
   * the session, so they must match what the owning code would have passed —
   * configuring a partition before its owner does otherwise changes the
   * session it ends up with (the updater deliberately runs uncached).
   */
  readonly options?: { readonly cache: boolean };
};

/**
 * Every session that must receive the configured proxy and TLS settings.
 * `configureElectronProxy` iterates this list; nothing else enumerates sessions.
 */
export const MANAGED_SESSION_PARTITIONS: readonly ManagedSessionPartition[] = [
  { partition: null },
  { partition: BROWSER_PANE_SESSION_PARTITION },
  { partition: UPDATER_SESSION_PARTITION, options: { cache: false } },
  // No options: `page-thumbnailer.ts` opens the session with a bare
  // `fromPartition(PAGE_THUMBNAIL_PARTITION)`, so a configured creation with
  // `{ cache: ... }` would hand it a DIFFERENT session than its own call makes.
  { partition: PAGE_THUMBNAIL_PARTITION },
];
