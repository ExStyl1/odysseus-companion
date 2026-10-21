/**
 * P3.274 — the composer and the mapper classify the same file the same way.
 *
 * Two classifiers read the same attachment and disagreed: `files.ts` knew four
 * extension families including audio and forty text extensions; the composer's
 * inline chain knew a ten-extension regex and no audio at all. The consequence
 * was user-visible in both directions — a `.rs` shown as a nameless "File" and
 * never decoded, an `.mp3` sent as audio and shown as unknown.
 *
 * Three things are pinned here, in the order they can break:
 *   1. `fileExtension` matches `node:path`'s `extname`, because the tables are
 *      written against `extname`'s two surprises and this module cannot import
 *      it (it has to load in the renderer).
 *   2. Every extension in every table classifies, through the SAME function the
 *      composer now calls.
 *   3. The residue is exactly one thing — the fallback for an extension no
 *      table knows — and it is the one the module header says it is.
 */
import { describe, expect, it } from 'bun:test';
import { extname } from 'node:path';
import {
  AUDIO_EXTENSIONS,
  IMAGE_EXTENSIONS,
  OFFICE_EXTENSIONS,
  TEXT_EXTENSIONS,
  attachmentKindFromBrowserFile,
  fileExtension,
  fileTypeForName,
  mimeTypeForName,
  type FileAttachmentKind,
} from '../file-types.ts';
import { getFileType, getMimeType } from '../files.ts';

const EXTNAME_CASES = [
  'plain.txt',
  '/abs/path/to/file.RS',
  'C:\\win\\path\\report.DOCX',
  'archive.tar.gz',
  'no-extension',
  '.env',
  '.gitignore',
  'dir.with.dots/file',
  'trailing.',
  '/a/b/.hidden.md',
];

describe('P3.274 · one classifier, two consumers', () => {
  it('fileExtension agrees with node extname, lower-cased', () => {
    for (const name of EXTNAME_CASES) {
      // `extname` on a Windows path is POSIX-only under bun, so compare on the
      // basename it would see — the divergence being pinned is the DOT rule,
      // not the separator.
      const posix = name.replace(/\\/g, '/');
      expect(fileExtension(name), name).toBe(extname(posix).toLowerCase());
    }
  });

  it('classifies every extension in every table', () => {
    const table: [readonly string[], FileAttachmentKind][] = [
      [Object.keys(IMAGE_EXTENSIONS), 'image'],
      [Object.keys(OFFICE_EXTENSIONS), 'office'],
      [Object.keys(AUDIO_EXTENSIONS), 'audio'],
      [[...TEXT_EXTENSIONS], 'text'],
      [['.pdf'], 'pdf'],
    ];
    for (const [extensions, kind] of table) {
      for (const ext of extensions) {
        // `.env` and `.gitignore` are in the text table and have NO extension by
        // `extname`'s rule, so they only classify with a stem in front — which
        // is how a real attachment arrives (`app.env`). Pinned rather than
        // fixed: changing the table is a behaviour change, and this test's job
        // is that the two consumers agree, not that the table is complete.
        expect(fileTypeForName(`file${ext}`, 'unknown'), ext).toBe(kind);
        expect(mimeTypeForName(`file${ext}`), ext).not.toBe('application/octet-stream');
      }
    }
  });

  /**
   * The whole point of the row: these are the files that used to be classified
   * two different ways. The composer's arm is asked through the function it now
   * calls, the mapper's through `files.ts`'s own exported entry point, so the
   * assertion is about the two CONSUMERS and not about one shared helper called
   * twice.
   */
  it('the composer and the mapper agree on every file with a known extension', () => {
    const previouslyDivergent = [
      'main.rs', 'server.go', 'compose.yaml', 'Cargo.toml', 'query.sql',
      'run.sh', 'rows.csv', 'app.log', 'schema.graphql', 'notes.md',
      'clip.mp3', 'voice.m4a', 'take.wav', 'note.ogg', 'song.flac',
      'photo.heic', 'icon.icns', 'scan.tiff', 'slide.pptx', 'book.xls',
    ];
    for (const name of previouslyDivergent) {
      const composer = attachmentKindFromBrowserFile({ name, mimeType: '' }, 'unknown');
      const mapper = getFileType(name);
      expect(composer, name).toBe(mapper);
      // Not vacuous: `unknown` on both sides would also be "agreement".
      expect(composer, name).not.toBe('unknown');
      expect(getMimeType(name), name).toBe(mimeTypeForName(name));
    }
  });

  it('falls back to the browser MIME only when no table knows the name', () => {
    // A pasted screenshot: no useful name, a useful `file.type`.
    expect(attachmentKindFromBrowserFile({ name: 'blob', mimeType: 'image/png' }, 'unknown')).toBe('image');
    expect(attachmentKindFromBrowserFile({ name: 'blob', mimeType: 'audio/webm' }, 'unknown')).toBe('audio');
    // The extension WINS over a wrong or generic browser guess.
    expect(
      attachmentKindFromBrowserFile({ name: 'main.rs', mimeType: 'application/octet-stream' }, 'unknown'),
    ).toBe('text');
  });

  it('leaves exactly one residue: the fallback for an extension no table knows', () => {
    const name = 'firmware.bin';
    // The composer will not decode an arbitrary binary as UTF-8 with no size
    // cap; `files.ts` reads it as text bounded by MAX_TEXT_SIZE. Both fallbacks
    // are passed explicitly at their call sites, and this is the ONE input
    // shape on which the two still differ.
    expect(attachmentKindFromBrowserFile({ name, mimeType: '' }, 'unknown')).toBe('unknown');
    expect(getFileType(name)).toBe('text');
  });
});
