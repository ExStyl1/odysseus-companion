/**
 * @license
 * Copyright 2025 Nessy CLI Team
 * SPDX-License-Identifier: Apache-2.0
 */

// [nessy-fork] dp-binary-lifecycle

import { describe, expect, it } from 'vitest';
import { parseDpUpdateInfo } from './dp-updater.js';

describe('parseDpUpdateInfo', () => {
  it('parses the version pair from the marker', () => {
    expect(
      parseDpUpdateInfo(
        'dp update available from 13.65.1 to 13.66.0\nSpirit CLI Version: 13.65.1\n',
      ),
    ).toEqual({ current: '13.65.1', latest: '13.66.0' });
  });

  it('tolerates pty control characters and CRLF', () => {
    expect(
      parseDpUpdateInfo(
        '\u0000\u0008\u0008dp update available from 13.65.1 to 13.66.0\r\n' +
          '   please run: dp update\r\n',
      ),
    ).toEqual({ current: '13.65.1', latest: '13.66.0' });
  });

  it('returns null when no marker is present', () => {
    expect(parseDpUpdateInfo('Spirit CLI Version: 13.65.1\n')).toBeNull();
  });

  it('returns null on empty output', () => {
    expect(parseDpUpdateInfo('')).toBeNull();
  });
});