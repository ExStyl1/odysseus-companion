/**
 * UA1.23 — which file a preview block's "Publish" action names, as a value (the blocks themselves need React and the
 * PDF worker, so the decision lives here and `__tests__/preview-publish-target.test.ts` asserts it).
 *
 * Owner 2026-09-23 («Да»): an extension beyond craft, which has no publish on previews. The rules (plan UA1.23):
 * - only a block whose ACTIVE item's `src` names a file offers the action — inline content without a file does not;
 * - the action exists only where the host wired `onPublishFile` (a session's chat; never the playground's default,
 *   the viewer or a detached preview window, which have no session to publish from);
 * - the renderer sends the PATH, never the bytes it rendered: the host re-reads the file through the UA1.17 guard and
 *   shows the UA1.18 card with a preview of exactly what will be sent.
 */
export function previewPublishTarget(
  activeItem: { src?: unknown } | undefined,
  onPublishFile: ((path: string) => void) | undefined,
): string | null {
  if (!onPublishFile || !activeItem) return null
  const src = activeItem.src
  return typeof src === 'string' && src.trim() !== '' ? src : null
}
