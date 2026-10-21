import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
test('application icon has transparent outer corners and the macOS icon contains its full resolution PNG', () => {
  const png = readFileSync(
    new URL('../../integrations/desktop/assets/odysseus-icon.png', import.meta.url),
  );
  assert.equal(png.readUInt32BE(16), 1024);
  assert.equal(png[24], 8);
  assert.equal(png[25], 6);
  const data = [];
  for (let i = 8; i < png.length; ) {
    const size = png.readUInt32BE(i),
      kind = png.toString('ascii', i + 4, i + 8);
    if (kind === 'IDAT') data.push(png.subarray(i + 8, i + 8 + size));
    i += size + 12;
  }
  const row = inflateSync(Buffer.concat(data));
  assert.equal(row[4], 0, 'top-left pixel must be transparent');
  const icns = readFileSync(
    new URL('../../integrations/desktop/assets/odysseus-icon.icns', import.meta.url),
  );
  assert.equal(icns.toString('ascii', 0, 4), 'icns');
  assert.equal(icns.readUInt32BE(4), icns.length);
  let full = false;
  for (let i = 8; i < icns.length; ) {
    const size = icns.readUInt32BE(i + 4);
    assert.ok(size > 8);
    if (icns.toString('ascii', i, i + 4) === 'ic10')
      full = icns
        .subarray(i + 8, i + size)
        .subarray(0, 8)
        .equals(png.subarray(0, 8));
    i += size;
  }
  assert.ok(full);
});
