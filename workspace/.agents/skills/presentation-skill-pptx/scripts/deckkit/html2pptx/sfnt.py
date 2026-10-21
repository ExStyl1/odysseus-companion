# -*- coding: utf-8 -*-
"""The two things we need out of a TrueType file, read with the stdlib only.

This module exists because of a bug, and the bug is worth stating plainly.

Both jobs below used to go through `fontTools`, which is not part of the
standard library and is not declared anywhere as a requirement. On a machine
that has it the deck is correct. On one that does not, both calls returned
"no data" and the build carried on:

- `face_info` fell back to the CSS family name, so every weight-500 run went
  into the PPTX as plain `T-Sans` instead of `T-Sans Medium`. Since PPTX has
  no numeric weight, that IS the weight - the file came out with the whole
  accent typography in the regular face. The embedded font list was still
  written, so the bytes of T-Sans Medium sat in the package with nothing
  referring to them.
- `_Advances` fell back to PIL, which rounds each glyph's advance to a whole
  pixel; at 144 px that is about ten pixels across a line and can add a line
  break the layout was never measured with.

Neither said anything. The PNG preview looked right either way, because the
rasteriser reads the TTF through PIL and never needed fontTools at all - which
is exactly why this went unnoticed: the visual check the skill recommends
cannot see it.

So the dependency is gone rather than merely reported. A skill whose output
depends on what happens to be installed next to it produces different decks in
different places, and no amount of warning text fixes that.

Reference: the OpenType spec, tables `name`, `head`, `maxp`, `hhea`, `hmtx`
and `cmap` (subtable formats 4 and 12, which is everything a Latin/Cyrillic
face uses).
"""
import logging
import struct

log = logging.getLogger(__name__)

# A malformed or hostile cmap could describe billions of mappings. No real
# text face needs more than this, and it keeps a bad file from eating memory.
_MAX_MAPPINGS = 200000


def _u16(data, at):
    return struct.unpack_from('>H', data, at)[0]


def _i16(data, at):
    return struct.unpack_from('>h', data, at)[0]


def _u32(data, at):
    return struct.unpack_from('>I', data, at)[0]


def _tables(data, font_number=0):
    """Tag -> (offset, length) for one font in the file.

    A `.ttc` collection puts several sfnt headers in one file, so the offset
    of the requested one has to be read first.
    """
    base = 0
    if data[:4] == b'ttcf':
        count = _u32(data, 8)
        if not 0 <= font_number < count:
            raise ValueError('font %d not in collection of %d' % (font_number, count))
        base = _u32(data, 12 + 4 * font_number)
    count = _u16(data, base + 4)
    out = {}
    for i in range(count):
        at = base + 12 + 16 * i
        tag = data[at:at + 4].decode('latin-1')
        out[tag] = (_u32(data, at + 8), _u32(data, at + 12))
    return out


def _read(path):
    with open(path, 'rb') as f:
        return f.read()


# ------------------------------------------------------------------ name

# platformID -> the encoding its strings are in. Windows and the deprecated
# Unicode platform are both UTF-16BE; Macintosh is MacRoman for the Roman
# language IDs, which is all we ever read.
_ENCODING = {0: 'utf-16-be', 1: 'mac-roman', 3: 'utf-16-be'}


def names(path, font_number=0):
    """{(platformID, nameID): string} for the file's `name` table.

    Only the first record of each (platform, nameID) pair is kept, matching
    what the previous fontTools-based reader did.
    """
    try:
        data = _read(path)
        offset, _length = _tables(data, font_number)['name']
    except Exception as exc:                                   # noqa: BLE001
        log.debug('no name table in %s: %s', path, exc)
        return {}

    out = {}
    try:
        count = _u16(data, offset + 2)
        strings = offset + _u16(data, offset + 4)
        for i in range(count):
            at = offset + 6 + 12 * i
            platform = _u16(data, at)
            name_id = _u16(data, at + 6)
            length = _u16(data, at + 8)
            start = strings + _u16(data, at + 10)
            key = (platform, name_id)
            if key in out:
                continue
            raw = data[start:start + length]
            try:
                out[key] = raw.decode(_ENCODING.get(platform, 'utf-16-be'))
            except (UnicodeDecodeError, LookupError):
                continue
    except Exception as exc:                                   # noqa: BLE001
        log.debug('malformed name table in %s: %s', path, exc)
    return out


# ------------------------------------------------------------------ cmap

def _cmap_format4(data, at):
    seg_x2 = _u16(data, at + 6)
    segs = seg_x2 // 2
    ends = at + 14
    starts = ends + seg_x2 + 2          # +2 skips reservedPad
    deltas = starts + seg_x2
    ranges = deltas + seg_x2

    out = {}
    for i in range(segs):
        end = _u16(data, ends + 2 * i)
        start = _u16(data, starts + 2 * i)
        delta = _i16(data, deltas + 2 * i)
        range_offset = _u16(data, ranges + 2 * i)
        if start > end:
            continue
        for code in range(start, min(end, 0xFFFE) + 1):
            if range_offset == 0:
                gid = (code + delta) & 0xFFFF
            else:
                # The offset is counted from the idRangeOffset slot itself -
                # the one piece of this format that is not an array index.
                slot = ranges + 2 * i + range_offset + 2 * (code - start)
                if slot + 1 >= len(data):
                    continue
                gid = _u16(data, slot)
                if gid:
                    gid = (gid + delta) & 0xFFFF
            if gid:
                out[code] = gid
            if len(out) > _MAX_MAPPINGS:
                return out
    return out


def _cmap_format12(data, at):
    groups = _u32(data, at + 12)
    out = {}
    for i in range(groups):
        rec = at + 16 + 12 * i
        first, last, gid = _u32(data, rec), _u32(data, rec + 4), _u32(data, rec + 8)
        if first > last:
            continue
        for code in range(first, last + 1):
            out[code] = gid + (code - first)
            if len(out) > _MAX_MAPPINGS:
                return out
    return out


# Best subtable first: full Unicode before the basic plane, Windows before the
# deprecated Unicode platform.
_CMAP_PREFERENCE = ((3, 10), (0, 4), (0, 6), (3, 1), (0, 3), (0, 2), (0, 1), (0, 0))


def _charmap(data, tables):
    entry = tables.get('cmap')
    if entry is None:
        return {}
    base = entry[0]
    count = _u16(data, base + 2)
    found = {}
    for i in range(count):
        at = base + 4 + 8 * i
        key = (_u16(data, at), _u16(data, at + 2))
        found.setdefault(key, base + _u32(data, at + 4))

    for key in _CMAP_PREFERENCE:
        at = found.get(key)
        if at is None:
            continue
        fmt = _u16(data, at)
        if fmt == 4:
            return _cmap_format4(data, at)
        if fmt == 12:
            return _cmap_format12(data, at)
    return {}


# ------------------------------------------------------------------ metrics

def metrics(path, font_number=0):
    """(units_per_em, {codepoint: advance}, default_advance) or None.

    Advances are in font units; the caller scales them by the pixel size.
    Going straight from codepoint to glyph id keeps this independent of the
    `post` table, which some fonts ship stripped of glyph names.
    """
    try:
        data = _read(path)
        tables = _tables(data, font_number)
        upem = _u16(data, tables['head'][0] + 18)
        num_glyphs = _u16(data, tables['maxp'][0] + 4)
        num_h_metrics = _u16(data, tables['hhea'][0] + 34)
        hmtx = tables['hmtx'][0]
    except Exception as exc:                                   # noqa: BLE001
        log.debug('no metric tables in %s: %s', path, exc)
        return None

    if not upem or not num_h_metrics:
        return None

    def advance(gid):
        # After the first `num_h_metrics` entries the table stops repeating the
        # advance: every remaining glyph shares the last one. Monospaced and
        # heavily-subset fonts rely on this.
        if gid >= num_glyphs:
            return None
        index = min(gid, num_h_metrics - 1)
        return _u16(data, hmtx + 4 * index)

    try:
        charmap = _charmap(data, tables)
        widths = {}
        for code, gid in charmap.items():
            value = advance(gid)
            if value is not None:
                widths[code] = value
    except Exception as exc:                                   # noqa: BLE001
        log.debug('malformed cmap in %s: %s', path, exc)
        return None

    if not widths:
        return None
    default = widths.get(0x20, upem // 2)
    return upem, widths, default
