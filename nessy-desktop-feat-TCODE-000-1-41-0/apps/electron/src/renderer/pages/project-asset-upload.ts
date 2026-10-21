/**
 * UA5.8 — base64 for the project page's asset upload (`projects:uploadAsset` takes `{ filename, base64 }`, UA5.6).
 *
 * Ours, replacing upstream v0.13.4 `ProjectInfoPage.tsx`'s `btoa(String.fromCharCode(...new Uint8Array(buf)))`,
 * which passes one argument per byte and throws `RangeError` on a file of a few hundred KB (UA-au, wave 6). The
 * bytes go to `String.fromCharCode` in chunks of 32 768, well under every engine's argument limit.
 */

const CHUNK = 0x8000

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

/**
 * UA12.113 — the server's per-upload cap (`PROJECT_ASSET_MAX_BYTES`, `@nessy-agent/shared/projects`), copied
 * here because the renderer must not import the node-side storage module; a test pins the two equal.
 */
export const PROJECT_ASSET_LIMIT_BYTES = 16 * 1024 * 1024

/** The i18n key (and its params) a failed upload is toasted with. */
export type UploadFailureToast =
  | { key: 'projectInfo.assetTooLarge'; params: { limitMiB: number } }
  | { key: 'projectInfo.uploadFailed' }

/**
 * UA12.113 — an upload the server refused for its size (`project-asset-too-large`) names the limit; every other
 * failure keeps upstream's generic toast. Read off the MESSAGE: the code is copied verbatim at every RPC hop,
 * while the wire's own `code` is the generic `HANDLER_ERROR` (the reasoning of `ProjectTrustDialog.tsx`).
 */
export function uploadFailureToast(error: unknown): UploadFailureToast {
  const message = error instanceof Error ? error.message : String(error ?? '')
  if (message.includes('project-asset-too-large')) {
    // The bare number: each locale writes its own unit (ru МиБ), as `capability.instruction.overSizeLimit` does.
    return { key: 'projectInfo.assetTooLarge', params: { limitMiB: PROJECT_ASSET_LIMIT_BYTES / (1024 * 1024) } }
  }
  return { key: 'projectInfo.uploadFailed' }
}
