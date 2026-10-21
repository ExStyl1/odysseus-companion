/**
 * Child-process probe for `unified-network-interceptor.proxy-precedence.test.ts`
 * (P6.255).
 *
 * A CHILD, and a file rather than a string written at run time, for three
 * reasons that are each recorded in AGENTS.md §Traps:
 *
 *  1. `PROXY_URL` is a module-scope constant read at import time, so a suite
 *     that has already imported the interceptor can never see a different
 *     answer no matter what it writes to `process.env`.
 *  2. `HTTPS_PROXY`, `https_proxy`, `HTTP_PROXY` and `http_proxy` are exactly
 *     the names Bun 1.3.14 pre-creates slots for. `'HTTPS_PROXY' in process.env`
 *     is `true` in a process where it is unset, and once a name is deleted the
 *     unlock is STICKY for the rest of that process — so an in-process rig
 *     reports the fix working with the fix removed. The values here arrive in
 *     the LAUNCH environment, which is the only arrangement that cannot lie.
 *  3. A freshly created temp script pays macOS's first-execution scan on every
 *     run; a fixture under `src/` is also typechecked like everything else.
 *
 * Every side effect is behind `import.meta.main`: a fixture whose module body
 * runs on import kills the runner at import time and reports exit 0 with zero
 * tests executed.
 */
import { getProxyForUrl } from '../../unified-network-interceptor.ts';

if (import.meta.main) {
  console.log(JSON.stringify({
    resolved: getProxyForUrl('https://api.example.com/v1/messages') ?? null,
    // The launch environment as this process actually received it, so a failing
    // assertion says whether the rig or the reader was wrong.
    launch: {
      https_proxy: process.env.https_proxy ?? null,
      HTTPS_PROXY: process.env.HTTPS_PROXY ?? null,
      http_proxy: process.env.http_proxy ?? null,
      HTTP_PROXY: process.env.HTTP_PROXY ?? null,
    },
  }));
  process.exit(0);
}
