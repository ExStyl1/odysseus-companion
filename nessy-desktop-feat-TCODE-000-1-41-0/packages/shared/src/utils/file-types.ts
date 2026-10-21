/**
 * What KIND of thing an attachment is, decided once for every consumer.
 *
 * ## Why this module exists (P3.274)
 *
 * Two classifiers read the same attachment and disagreed about it. `files.ts`
 * (the mapper's side, what the MODEL is sent) knew four extension families
 * including audio and forty text extensions; the composer
 * (`FreeFormInput.tsx`, what the USER is SHOWN) had a five-branch inline chain
 * with a ten-extension regex and no audio family at all. So one file could be
 * `text` to the mapper and `unknown` to the composer — a `.rs`, `.go`,
 * `.yaml`, `.toml`, `.sql` or `.csv` was shown as a nameless "File" and its
 * contents were never decoded, while the same file arriving through the other
 * ingress was read and sent. Same shape as P2.243 (two classifiers read the
 * same code oppositely), one layer up.
 *
 * The tables live here, with NO `node:` imports, because the composer runs in
 * the renderer and cannot import `files.ts` (`fs`, `path`, `child_process`).
 * `files.ts` re-exports them, so there is exactly one list of extensions in the
 * product.
 *
 * ## The one thing this module deliberately does NOT unify
 *
 * The fallback for a name with no recognised extension. `files.ts` answers
 * `text` — "we'll try to read it as text; binary files will show garbled
 * content but at least they'll attach" — and the composer answers `unknown`.
 * Both are deliberate and they are not interchangeable: the composer decodes
 * the WHOLE buffer when it says `text`, with no size cap, where `files.ts`
 * stops at `MAX_TEXT_SIZE` (100 KB). Collapsing them to `text` would put a
 * 20 MB UTF-8 decode of an arbitrary binary in the renderer.
 *
 * So the fallback is a REQUIRED argument rather than a default: each caller
 * states its own, at its own call site, where the reason for it is visible.
 * The residue is real and stated rather than hidden — a file whose extension
 * neither table knows is still classified differently by the two — but it is a
 * much smaller residue than the one this module removes, and it is the half
 * that cannot be closed without a product decision about renderer memory.
 */

/** The attachment kinds. `FileAttachment['type']` in `files.ts` is this type. */
export type FileAttachmentKind = 'image' | 'text' | 'pdf' | 'office' | 'audio' | 'unknown';

/** Supported image types. */
export const IMAGE_EXTENSIONS: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.tiff': 'image/tiff',
  '.tif': 'image/tiff',
  '.ico': 'image/x-icon',
  '.icns': 'image/x-icns',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.svg': 'image/svg+xml',
};

/** Text file extensions. */
export const TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  '.txt', '.md', '.json', '.js', '.ts', '.tsx', '.jsx',
  '.py', '.rb', '.go', '.rs', '.java', '.c', '.cpp', '.h',
  '.css', '.scss', '.html', '.xml', '.yaml', '.yml', '.toml',
  '.sh', '.bash', '.zsh', '.fish', '.sql', '.graphql',
  '.env', '.gitignore', '.dockerfile', '.makefile',
  '.csv', '.log', '.conf', '.ini', '.cfg',
]);

/** Office file extensions (converted to markdown via markitdown-js). */
export const OFFICE_EXTENSIONS: Readonly<Record<string, string>> = {
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.doc': 'application/msword',
  '.xls': 'application/vnd.ms-excel',
  '.ppt': 'application/vnd.ms-powerpoint',
};

/** Audio file extensions (forwarded as base64; backends decide how to handle). */
export const AUDIO_EXTENSIONS: Readonly<Record<string, string>> = {
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.weba': 'audio/webm',
  '.webm': 'audio/webm',
};

/**
 * The lower-cased extension of a file NAME or a path, `''` when there is none.
 *
 * Matches `node:path`'s `extname` — including its two surprises, which the
 * tables above are written against: a dotfile with no second dot (`.env`,
 * `.gitignore`) has NO extension, and only the last dot counts
 * (`archive.tar.gz` is `.gz`). Re-implemented rather than imported because this
 * module has to load in the renderer. Parity with `extname` is pinned in
 * `__tests__/file-types.test.ts`; do not "simplify" it without running that.
 */
export function fileExtension(nameOrPath: string): string {
  const lastSlash = Math.max(nameOrPath.lastIndexOf('/'), nameOrPath.lastIndexOf('\\'));
  const base = nameOrPath.slice(lastSlash + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return '';
  return base.slice(dot).toLowerCase();
}

/**
 * The kind, from the name alone.
 *
 * `fallback` is REQUIRED — see the module header for why the two consumers pass
 * different values and why that is not an oversight.
 */
export function fileTypeForName(
  nameOrPath: string,
  fallback: FileAttachmentKind,
): FileAttachmentKind {
  const ext = fileExtension(nameOrPath);
  if (ext in IMAGE_EXTENSIONS) return 'image';
  if (ext === '.pdf') return 'pdf';
  if (ext in OFFICE_EXTENSIONS) return 'office';
  if (ext in AUDIO_EXTENSIONS) return 'audio';
  if (TEXT_EXTENSIONS.has(ext)) return 'text';
  return fallback;
}

/** The MIME type, from the name alone. `application/octet-stream` when unknown. */
export function mimeTypeForName(nameOrPath: string): string {
  const ext = fileExtension(nameOrPath);
  const imageMime = IMAGE_EXTENSIONS[ext];
  if (imageMime) return imageMime;
  if (ext === '.pdf') return 'application/pdf';
  const officeMime = OFFICE_EXTENSIONS[ext];
  if (officeMime) return officeMime;
  const audioMime = AUDIO_EXTENSIONS[ext];
  if (audioMime) return audioMime;
  if (TEXT_EXTENSIONS.has(ext)) return 'text/plain';
  return 'application/octet-stream';
}

/**
 * The kind for an attachment a BROWSER handed us: a name plus the MIME type the
 * host guessed.
 *
 * The extension tables decide first, so the composer and the mapper agree on
 * every file whose extension is known. The MIME family is consulted only when
 * they do not know it, which is the case the composer used to decide entirely
 * on its own: a pasted blob (`image.png` renamed from a clipboard entry, a
 * screenshot with no name at all) has a useful `file.type` and often no useful
 * name.
 */
export function attachmentKindFromBrowserFile(
  input: { name: string; mimeType?: string | undefined },
  fallback: FileAttachmentKind,
): FileAttachmentKind {
  const byExtension = fileTypeForName(input.name, 'unknown');
  if (byExtension !== 'unknown') return byExtension;
  const mime = (input.mimeType ?? '').toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime === 'application/pdf') return 'pdf';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.includes('officedocument')) return 'office';
  if (mime.startsWith('text/')) return 'text';
  return fallback;
}
