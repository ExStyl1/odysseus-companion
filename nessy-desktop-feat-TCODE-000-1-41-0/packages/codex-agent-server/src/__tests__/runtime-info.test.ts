/**
 * Task 6.6: codex runtime identity for the About page — reads the pinned
 * manifest for the host platform, fail-soft to null for an unknown platform.
 */
import { test, expect, describe } from 'bun:test';
import { getCodexRuntimeInfo } from '../runtime-info.ts';

describe('getCodexRuntimeInfo', () => {
  test('returns tag + sha for darwin-arm64 from the manifest', () => {
    const info = getCodexRuntimeInfo('darwin-arm64');
    expect(info).not.toBeNull();
    expect(info!.tag).toBe('rust-v0.162.0');
    expect(info!.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  test('returns null for a platform not in the manifest', () => {
    expect(getCodexRuntimeInfo('nonexistent-plat')).toBeNull();
  });
});
