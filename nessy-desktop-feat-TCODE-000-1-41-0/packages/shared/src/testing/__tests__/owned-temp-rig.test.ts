/**
 * F1.850 — the positive control for the absence `createOwnedRigBase` asserts:
 * the probe finds each marker the detector would read above a rig, and nothing
 * where there is none, with the home stop placed where the detector places it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createOwnedRigBase, RIG_ANCESTOR_MARKERS, rigAncestorMarkers } from '../owned-temp-rig.ts';

let base = '';
beforeAll(() => {
  base = realpathSync(createOwnedRigBase('otr-'));
});
afterAll(() => {
  if (base) rmSync(base, { recursive: true, force: true });
});

function plant(dir: string, marker: string): void {
  mkdirSync(dir, { recursive: true });
  if (marker === '.git' || marker === '.claude') mkdirSync(join(dir, marker));
  else writeFileSync(join(dir, marker), '');
}

describe('rigAncestorMarkers (F1.850)', () => {
  it('names each marker planted above a rig, and nothing for a clean ancestry', () => {
    for (const marker of RIG_ANCESTOR_MARKERS) {
      const outer = join(base, `case-${marker}`);
      const rig = join(outer, 'a', 'rig');
      mkdirSync(rig, { recursive: true });
      expect(rigAncestorMarkers(rig)).toEqual([]);
      plant(join(outer, 'a'), marker);
      expect(rigAncestorMarkers(rig)).toEqual([join(outer, 'a', marker)]);
      // The rig's own markers are the rig's business, not its ancestry's.
      plant(rig, marker === '.git' ? '.mcp.json' : '.git');
      expect(rigAncestorMarkers(rig)).toEqual([join(outer, 'a', marker)]);
    }
  });

  it('with a home, reads only .git at the home directory and above for a rig under it (the detector\'s home stop)', () => {
    const home = join(base, 'home');
    const rig = join(home, 'work', 'rig');
    mkdirSync(rig, { recursive: true });
    plant(home, '.claude');
    plant(home, 'CLAUDE.md');
    expect(rigAncestorMarkers(rig, home)).toEqual([]);
    expect(rigAncestorMarkers(rig)).toEqual([join(home, 'CLAUDE.md'), join(home, '.claude')]);
    plant(home, '.git');
    expect(rigAncestorMarkers(rig, home)).toEqual([join(home, '.git')]);
    plant(join(home, 'work'), '.mcp.json');
    expect(rigAncestorMarkers(rig, home)).toEqual([join(home, 'work', '.mcp.json'), join(home, '.git')]);
  });
});
