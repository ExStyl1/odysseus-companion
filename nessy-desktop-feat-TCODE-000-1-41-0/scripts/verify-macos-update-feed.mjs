/**
 * Backward-compatible macOS verifier shim.
 *
 * New code should import or execute `scripts/verify-update-feed.mjs`. This file
 * preserves the old CLI path and named exports used by Phase 5/6 tooling.
 */
import { pathToFileURL } from 'node:url';

export {
  FeedVerificationError,
  parseUpdateMetadata,
  verifyMacUpdateFeed,
} from './verify-update-feed.mjs';

const isMainModule =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  const passthroughArgs = process.argv.slice(2).filter((arg) => arg !== '--platform=mac');
  const childProcess = await import('node:child_process');
  const result = childProcess.spawnSync(
    process.execPath,
    [
      new URL('./verify-update-feed.mjs', import.meta.url).pathname,
      '--platform=mac',
      ...passthroughArgs,
    ],
    { stdio: 'inherit' },
  );
  process.exit(result.status ?? 1);
}
