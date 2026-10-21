/**
 * DA3.16 — the one place a fixture puts a fake client into a pool.
 *
 * Seventeen test helpers used to call `McpClientPool.registerClient` directly,
 * which is the shape `DA3.6` retired: `connect` is what resolves the connection
 * identity, and a caller that files a client itself has to know the identity
 * rule. `DA3.8` is what that costs when the rule is got wrong — production
 * `connect` computed the isolated key and then handed `registerClient` only
 * three arguments, filing the client under the SHARED identity while every
 * reconcile looked for the isolated one.
 *
 * The seventeen were benign, because none of them syncs and so nothing looks for
 * an isolated key. They were still the last place in the tree where the retired
 * shape was written down, and a reader copying a fixture copies the shape.
 *
 * WHY A FUNCTION OVER AN INSTANCE, AND NOT A BASE CLASS. The obvious fix is a
 * `FixturePool extends McpClientPool` that overrides `openConnection`. It does
 * not fit: almost every one of these fixtures ALREADY extends the pool for its
 * own reason — a call recorder, a catalog-hash accessor, a slug-conditional
 * transport — and several are declared inside the test body over a closure. A
 * shared base would have to be mixed into each of them, which is a bigger edit
 * at every site than the one line this replaces.
 *
 * WHY IT PATCHES AND RESTORES RATHER THAN HOLDING A MAP. The patch is an OWN
 * property on the instance, installed for the duration of one `connect` and
 * deleted in a `finally` — so the pool is byte-identical afterwards and two
 * fixtures in one file cannot leak a client into each other. A pending-client
 * map would outlive the call and would have to answer what happens when the
 * same slug is seeded twice, which is a question no caller here asks.
 *
 * WHAT CHANGES FOR A CALLER, stated because it is a real difference and not
 * only a spelling. Going through `connect` means the connection key is computed
 * by the pool, `registerClient` receives all four arguments, `activeConfigs` is
 * written, and a SECOND registration of the same identity is refused rather than
 * replacing the first — that last one is `connect`'s own duplicate guard, and a
 * fixture that deliberately re-registers a slug must change the config (or the
 * slug) for the second client, exactly as production would have to open a
 * different connection.
 */
import { McpClientPool, type McpOpenConnectionRequest } from '../mcp-pool.ts';
import type { PoolClient } from '../client.ts';
import type { SdkMcpServerConfig } from '../../agent/backend/types.ts';

/**
 * The config a fixture gets when it does not care — a stdio server, because
 * that is the type every one of these helpers used to pass or leave undefined,
 * and because `sdkConfigToClientConfig` never sees it (the seam below answers
 * before the real `openConnection` runs).
 */
export const FIXTURE_STDIO_CONFIG = { type: 'stdio', command: 'fixture' } as SdkMcpServerConfig;

type OpenConnectionSeam = {
  openConnection?: (request: McpOpenConnectionRequest) => Promise<PoolClient | undefined>;
};

/**
 * Put `client` into `pool` under `slug`, through the REAL `connect`.
 *
 * Returns the connection key the pool filed it under, which two fixtures read.
 */
export async function registerFixtureClient(
  pool: McpClientPool,
  slug: string,
  client: PoolClient,
  config: SdkMcpServerConfig = FIXTURE_STDIO_CONFIG,
): Promise<string> {
  const seam = pool as unknown as OpenConnectionSeam;
  const hadOwn = Object.prototype.hasOwnProperty.call(seam, 'openConnection');
  const previous = seam.openConnection;
  // The key is CAPTURED from the seam rather than recomputed: `mcpConnectionKey`
  // is module-private, and a second spelling of the identity rule in a fixture
  // is the class of duplication `DA3.8` was.
  let filedUnder: string | undefined;
  seam.openConnection = async (request: McpOpenConnectionRequest) => {
    filedUnder = request.connectionKey;
    return client;
  };
  try {
    await pool.connect(slug, config);
  } finally {
    // Restore to the exact prior shape: an own property only if there was one,
    // so the prototype method is reachable again either way.
    if (hadOwn) seam.openConnection = previous;
    else delete seam.openConnection;
  }
  if (filedUnder === undefined) {
    // `connect` returned before the seam ran, which it does for exactly one
    // reason here: this identity is already connected. Loud rather than an
    // empty-string key, because the old `registerClient` path REPLACED the
    // client and a fixture relying on that would otherwise fail somewhere else.
    throw new Error(
      `registerFixtureClient: "${slug}" is already connected under this config — `
      + 'connect() refuses a duplicate identity. Vary the slug or the config.',
    );
  }
  return filedUnder;
}
