/**
 * Child-process probe for `host-loopback-proxy-exemption.test.ts`.
 *
 * A FILE rather than a string the test writes at run time, for two reasons: a
 * freshly created temp script pays macOS's first-execution scan on every run
 * (measured at 20s+ on this machine, against 1.4s for a file that already
 * exists), and a fixture under `src/` is typechecked like everything else.
 *
 * It must run in a process whose proxy env names have NEVER been deleted —
 * that is the whole point. See the test file's header (P2.261).
 */
import { applyProcessNetworkTrustChain } from '../../network-runtime.ts';

applyProcessNetworkTrustChain({
  settings: { enabled: true, httpsProxy: 'http://proxy.internal:3128' },
  log: { info: () => {}, warn: () => {}, error: () => {} },
});

const spread: Record<string, string | undefined> = { ...process.env };
console.log(JSON.stringify({
  read: process.env.HTTPS_PROXY,
  httpsInSpread: 'HTTPS_PROXY' in spread,
  noProxyInSpread: 'NO_PROXY' in spread,
  noProxyLowerInSpread: 'no_proxy' in spread,
  noProxy: spread.NO_PROXY,
}));
// The config graph leaves the loop alive; exit rather than wait it out.
process.exit(0);
