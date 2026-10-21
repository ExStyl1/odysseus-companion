/**
 * UA1.19 — the one t-artifacts origin and its link test, in a module with NO imports, so the renderer (the artifact
 * chip in `packages/ui`, the Published pages list) can check a link without bundling the client's dp seam
 * (`auth/dp/*`, Node `child_process`). `t-artifacts-client.ts` imports and re-exports both, so there is one
 * definition: the origin is a module constant on purpose (no env, no setting, no model argument moves it — see the
 * client's header, fence 1).
 */

/** The one network target of the artifact publishing chain. */
export const T_ARTIFACTS_ORIGIN = 'https://t-artifacts.t-tech.team';

/** Is this a link on the one origin? Credentials in the URL, or any other scheme/host/port, answer false. */
export function isTArtifactsUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.origin === T_ARTIFACTS_ORIGIN && parsed.username === '' && parsed.password === '';
  } catch {
    return false;
  }
}
