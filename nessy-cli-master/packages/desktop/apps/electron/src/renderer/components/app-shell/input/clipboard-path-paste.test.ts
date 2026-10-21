// [nessy-fork] desktop-clipboard-path-paste
import { describe, expect, it } from 'bun:test';
import { resolveClipboardPathPaste } from './clipboard-path-paste';

const file = {} as File;

describe('resolveClipboardPathPaste', () => {
  it('uses paths exposed directly by Electron', () => {
    expect(
      resolveClipboardPathPaste(
        [file],
        { getFilePath: () => '/Users/me/report.xlsx' },
        true,
      ),
    ).toEqual(['/Users/me/report.xlsx']);
  });

  it('falls back to Finder or Explorer clipboard paths', () => {
    expect(
      resolveClipboardPathPaste(
        [file],
        {
          getFilePath: () => null,
          getClipboardFilePaths: () => [
            'C:\\Users\\me\\report.xlsx',
            '\\\\server\\share\\folder',
          ],
        },
        true,
      ),
    ).toEqual(['C:\\Users\\me\\report.xlsx', '\\\\server\\share\\folder']);
  });

  it('can resolve a copied folder when the browser FileList is empty', () => {
    expect(
      resolveClipboardPathPaste(
        [],
        { getClipboardFilePaths: () => ['/Users/me/Documents'] },
        true,
      ),
    ).toEqual(['/Users/me/Documents']);
  });

  it('keeps remote workspace files as attachments', () => {
    expect(
      resolveClipboardPathPaste(
        [file],
        { getFilePath: () => '/Users/me/report.xlsx' },
        false,
      ),
    ).toBeNull();
  });

  it('keeps content-only clipboard files as attachments', () => {
    expect(
      resolveClipboardPathPaste(
        [file],
        {
          getFilePath: () => null,
          getClipboardFilePaths: () => [],
        },
        true,
      ),
    ).toBeNull();
  });

  it('keeps mixed path-backed and content-only files as attachments', () => {
    const pathBackedFile = {} as File;
    const contentOnlyFile = {} as File;
    expect(
      resolveClipboardPathPaste(
        [pathBackedFile, contentOnlyFile],
        {
          getFilePath: (item) =>
            item === pathBackedFile ? '/Users/me/report.xlsx' : null,
          getClipboardFilePaths: () => ['/Users/me/report.xlsx'],
        },
        true,
      ),
    ).toBeNull();
  });
});
