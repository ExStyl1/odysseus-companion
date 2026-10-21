# -*- coding: utf-8 -*-
"""The font set: which file is which weight, and what PowerPoint calls it.

Static data plus one pure function. No measurement state, no Pillow, no
per-document lifetime — `textmeasure.FontBook` is the runtime reader and this
is the set it reads. The embed path (`font_embed`) has no `Document` and never
measures, so it takes its names from here and stays free of Pillow.

Two axes meet in this module and they are NOT the same axis:

    CSS / measurement   family 'T-Sans', weights 400 / 500 / 700
    PPTX / typeface     families 'T-Sans' and 'T-Sans Medium', a bold flag

They meet only through the FILE. `T-Sans_Medium.ttf` is weight 500 on the CSS
side and a family of its own on the PPTX side, which is why one table cannot
serve both: `FILE_BY_WEIGHT` is keyed on the CSS axis, and everything on the
PPTX axis is derived from the file itself through `face_info`.

That derivation is the point. `render._style_run` writes `face_info(file)` into
`a:latin/@typeface`, and `embed_faces` names the embedded families the same
way, from the same files — so the two agree by construction rather than by a
comment asking a human to keep two tables in step.
"""
import os

from . import sfnt

# The directory basename, owned here so that `textmeasure`'s candidate search
# and `font_embed.font_dir` derive it instead of repeating the literal. The
# `@import` in the designer-owned `base.css` still spells it out; selftest
# compares the two rather than trying to generate either.
FONT_DIR_NAME = 'T-Sans_2026_TTF'

# (css family, weight) -> filename. Hand-written on purpose: the filenames are
# not derivable from the faces because they are not consistent with each other
# (underscores in Regular/Bold, and the delivered Medium of the condensed cut
# used a hyphen). Weight is the CSS axis — 500 is a weight here, and becomes a
# separate PPTX family only downstream, in `face_info`.
FILE_BY_WEIGHT = {
    ('t-sans', 400): 'T-Sans_Regular.ttf',
    ('t-sans', 500): 'T-Sans_Medium.ttf',
    ('t-sans', 700): 'T-Sans_Bold.ttf',
}

# The brand prefix. A family that starts with it is ours: if it is not in the
# table above, that is a wiring mistake and the build stops (see FontBook).
# Anything else — Arial, sans-serif, whatever a browser would resolve — keeps
# the old fallback, because a font we do not ship cannot be embedded anyway.
BRAND = 't-sans'



def normalize_weight(weight):
    """`bold` / `500` / `normal` → numeric weight from {400, 500, 700}.

    The one reading of a CSS weight in the engine: the layout, the font book,
    the formula metrics and the writer all come through here. It sits with
    the weight table rather than in `textmeasure` so that `formula` can
    read it without importing the module that imports `formula`. Until 2.1 `layout.py` and
    `render.py` each kept a copy that did not snap (600 stayed 600).
    """
    if weight is None:
        return 400
    text = str(weight).strip().lower()
    if text == 'bold':
        return 700
    if text in ('normal', 'regular'):
        return 400
    try:
        num = int(float(text))
    except ValueError:
        return 400
    # Snap to the nearest available weight.
    return min((400, 500, 700), key=lambda w: abs(w - num))

class FontSetError(Exception):
    """A face was requested that this set cannot honour.

    Raised rather than warned because the alternative is a deck measured with
    Arial widths, shipping `a:latin typeface="Arial"` and no embedded font —
    silently, and differently on every machine depending on what is installed.
    """


def is_brand(family):
    """Is this CSS family one of ours?

    Prefix match on a word boundary, so `t-sans condensed` is brand and a
    hypothetical `t-sansation` is not.
    """
    primary = (family or '').strip().lower()
    return primary == BRAND or primary.startswith(BRAND + ' ') or \
        primary.startswith(BRAND + '-')


def face_info(path):
    """Family name and bold flag as PowerPoint sees them.

    PPTX has no numeric weight — only a typeface name and a bold flag.
    Weights are laid out in RIBBI groups: nameID 1 sets the family,
    nameID 2 sets the weight within it. For T-Sans this gives:

        T-Sans_Regular → ('T-Sans', False)
        T-Sans_Bold    → ('T-Sans', True)
        T-Sans_Medium  → ('T-Sans Medium', False)   ← separate family!

    So weight 500 cannot be passed as 'T-Sans without bold' — PowerPoint
    would draw Regular, and card subtitles, metrics and agenda numbers
    would lose their weight.
    """
    if not path:
        return (None, False)
    # There are several name records in the font, by platform. Take Windows
    # (platformID 3) — the one PowerPoint reads. For T-Sans Medium the
    # family='T-Sans Medium', whereas in the Macintosh record it is 'T-Sans'
    # with subfamily='Medium', and the weight would be lost there.
    records = sfnt.names(path)
    family = records.get((3, 1)) or records.get((1, 1))
    subfamily = records.get((3, 2)) or records.get((1, 2))
    if not family:
        return (None, False)
    is_bold = bool(subfamily and 'bold' in subfamily.lower())
    return (family, is_bold)


def embed_faces(font_dir):
    """The faces to embed: `[{'family', 'slot', 'path'}]`, grouped by family.

    Nothing here is a second table. The family comes from the font's own name
    record and the slot from its bold flag, both through `face_info`, which is
    the same function that decides what goes into `a:latin`. For the three real
    files that reproduces what used to be written out by hand:

        T-Sans_Regular.ttf  ->  T-Sans         regular
        T-Sans_Bold.ttf     ->  T-Sans         bold
        T-Sans_Medium.ttf   ->  T-Sans Medium  regular

    Grouped in first-seen family order, which keeps `T-Sans` (met at weight
    400) ahead of `T-Sans Medium` (met at 500) and `regular` ahead of `bold`
    inside the group — the order the embedded font list has always had.
    """
    order = []
    by_family = {}
    for _key, filename in sorted(FILE_BY_WEIGHT.items()):
        path = os.path.join(font_dir, filename)
        if not os.path.isfile(path):
            raise FontSetError('font file not found: %s' % path)
        family, is_bold = face_info(path)
        if not family:
            raise FontSetError('cannot read the typeface name of %s — it would '
                               'be embedded under a name no text run uses' % path)
        slot = 'bold' if is_bold else 'regular'
        group = by_family.get(family)
        if group is None:
            group = by_family[family] = []
            order.append(family)
        taken = [face['slot'] for face in group]
        if slot in taken:
            raise FontSetError(
                'two files claim %s %s: %s and %s' % (
                    family, slot, group[taken.index(slot)]['path'], path))
        group.append({'family': family, 'slot': slot, 'path': path})

    faces = []
    for family in order:
        faces.extend(by_family[family])
    return faces
