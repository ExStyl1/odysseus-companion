import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { handleSendUserFile, SEND_USER_FILE_MAX_BYTES, type DeliveredFile } from './send-user-file.ts';
import type { SessionToolContext } from '../context.ts';

let root: string;
let workingDirectory: string;
let sessionPath: string;
let outside: string;
let ctx: SessionToolContext;

beforeAll(() => {
  // realpath'd: on macOS `tmpdir()` is itself reached through a symlink, and
  // the assertions below compare the reported absolute paths.
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'nessy-send-user-file-')));
  workingDirectory = join(root, 'project');
  sessionPath = join(root, 'session');
  outside = join(root, 'elsewhere');
  for (const dir of [workingDirectory, sessionPath, outside]) mkdirSync(dir, { recursive: true });

  writeFileSync(join(workingDirectory, 'diagram.svg'), '<svg/>');
  writeFileSync(join(sessionPath, 'report.md'), '# report');
  writeFileSync(join(outside, 'secret.txt'), 'not yours');
  writeFileSync(join(workingDirectory, 'huge.bin'), Buffer.alloc(SEND_USER_FILE_MAX_BYTES + 1));
  // A symlink inside the contained root pointing out of it: lexical
  // containment alone would accept this.
  symlinkSync(join(outside, 'secret.txt'), join(workingDirectory, 'escape.txt'));
  // …and one pointing back IN, to prove the symlink handling is a containment
  // decision on the real target, not a blanket refusal of links.
  symlinkSync(workingDirectory, join(root, 'project-link'));

  ctx = { sessionId: 'sess-1', workingDirectory, sessionPath } as SessionToolContext;
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('SendUserFile', () => {
  test('carries all three display states, with unset distinct from attach', async () => {
    const render = await handleSendUserFile(ctx, { paths: ['diagram.svg'], display: 'render' });
    const attach = await handleSendUserFile(ctx, { paths: ['diagram.svg'], display: 'attach' });
    const unset = await handleSendUserFile(ctx, { paths: ['diagram.svg'] });

    expect(render.structuredContent!.display).toBe('render');
    expect(attach.structuredContent!.display).toBe('attach');
    // Unset must NOT collapse into `attach`: "when unset the client decides by
    // file type" is a third instruction, not a default.
    expect(Object.hasOwn(unset.structuredContent!, 'display')).toBe(false);
    expect(unset.content[0]!.text).toContain('presented by file type');
    for (const result of [render, attach, unset]) expect(result.isError).toBe(false);
  });

  test('delivers several files with a caption and resolves them to absolute paths', async () => {
    const result = await handleSendUserFile(ctx, {
      paths: ['diagram.svg', join(sessionPath, 'report.md')],
      caption: 'The rendered architecture and its write-up.',
    });

    expect(result.isError).toBe(false);
    const files = result.structuredContent!.files as DeliveredFile[];
    expect(files.map(file => file.name)).toEqual(['diagram.svg', 'report.md']);
    expect(files[0]!.path).toBe(join(workingDirectory, 'diagram.svg'));
    expect(files[0]!.extension).toBe('.svg');
    expect(files[0]!.bytes).toBe(6);
    expect(result.structuredContent!.caption).toBe('The rendered architecture and its write-up.');
  });

  test('refuses a path outside the contained roots', async () => {
    const absolute = await handleSendUserFile(ctx, { paths: [join(outside, 'secret.txt')] });
    expect(absolute.isError).toBe(true);
    expect(absolute.content[0]!.text).toContain('outside this session');

    const traversal = await handleSendUserFile(ctx, { paths: ['../elsewhere/secret.txt'] });
    expect(traversal.isError).toBe(true);

    // A symlink that lands outside is refused too: containment is symlink-aware
    // because the model chose the path.
    const symlinked = await handleSendUserFile(ctx, { paths: ['escape.txt'] });
    expect(symlinked.isError).toBe(true);
    expect(symlinked.content[0]!.text).toContain('outside this session');

    // A link that resolves back INSIDE a reachable root is accepted and
    // reported at the real path — the check is on where the path lands, not on
    // whether a link was involved.
    const inward = await handleSendUserFile(ctx, { paths: [join(root, 'project-link', 'diagram.svg')] });
    expect(inward.isError).toBe(false);
    expect((inward.structuredContent!.files as DeliveredFile[])[0]!.path)
      .toBe(join(workingDirectory, 'diagram.svg'));
  });

  test('refuses an over-size file and reports a missing one', async () => {
    const oversize = await handleSendUserFile(ctx, { paths: ['huge.bin'] });
    expect(oversize.isError).toBe(true);
    expect(oversize.content[0]!.text).toContain(`${SEND_USER_FILE_MAX_BYTES}-byte limit`);

    const missing = await handleSendUserFile(ctx, { paths: ['nope.pdf'] });
    expect(missing.isError).toBe(true);
    expect(missing.content[0]!.text).toContain('could not find');

    const directory = await handleSendUserFile(ctx, { paths: ['.'] });
    expect(directory.isError).toBe(true);
    expect(directory.content[0]!.text).toContain('directory');
  });

  test('one bad path fails the whole call, so no partial delivery is reported', async () => {
    const result = await handleSendUserFile(ctx, { paths: ['diagram.svg', 'nope.pdf'] });
    expect(result.isError).toBe(true);
    // Nothing delivered, so nothing structured to carry. P3.11 — the field is
    // now ABSENT rather than an empty object: an empty one would replace the
    // refusal text with `{}` for a codex model (`response.ts`).
    expect(result.structuredContent).toBeUndefined();
  });

  test('reports unavailability when the session has no reachable directory', async () => {
    const result = await handleSendUserFile({ sessionId: 'sess-1' } as SessionToolContext, {
      paths: ['diagram.svg'],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('no reachable directory');
  });

  test('does not claim a delivery no surface performs', async () => {
    // The tool used to answer "Sent 1 file to the user, opened inline." Nothing
    // in `apps/electron/src` or `packages/ui/src` reads its result, so no file
    // reached anyone — the model relayed the claim faithfully and the product
    // told the user it had sent a file it had not sent.
    //
    // This pins the honesty property, not the wording: the success text must not
    // assert that the user received anything, and must say where the file is.
    // When a surface renders the record, change the text AND this test together.
    const result = await handleSendUserFile(ctx, { paths: ['diagram.svg'], display: 'render' });

    expect(result.isError).toBe(false);
    const text = result.content[0]!.text;
    expect(text).not.toMatch(/\bSent\b.*\bto the user\b/);
    expect(text).toContain('NOT received');
  });
});
