/**
 * Bundled codex runtime identity for diagnostics (About page). Reads the pinned
 * `manifest.json` for the host platform. Fail-soft to `null` when the runtime
 * isn't bundled (default build) so the UI simply hides the row.
 */
import { hostCodexPlatformDir, loadCodexManifest } from './manifest-verifier.ts';

export interface CodexRuntimeInfo {
  /** Upstream release tag, e.g. `rust-v0.147.0`. */
  tag: string;
  /** sha256 of the bundled binary for the host platform. */
  sha256: string;
}

export function getCodexRuntimeInfo(platformDir: string = hostCodexPlatformDir()): CodexRuntimeInfo | null {
  try {
    const manifest = loadCodexManifest();
    const tag = manifest.upstream?.tag;
    const sha256 = manifest.binaries?.[platformDir]?.binarySha256;
    if (!tag || !sha256) return null;
    return { tag, sha256 };
  } catch {
    return null;
  }
}
