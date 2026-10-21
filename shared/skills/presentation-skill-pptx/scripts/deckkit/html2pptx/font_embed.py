# -*- coding: utf-8 -*-
"""Embed T-Sans typefaces into the finished PPTX.

Why. Weight 500 goes into the file as the typeface name "T-Sans Medium" —
there is no numeric weight in PPTX, weight is conveyed only by the name.
In the font this name comes from the legacy record (nameID 1), and on a
machine where T-Sans is installed as a single family, there is no such
typeface: PowerPoint substitutes its own and draws regular weight. Weight 500
is almost all the template's accent typography, so the deck reads as "bold
is gone". Embedding the font removes the dependency on what the reader has
installed.

License permits: all three weights have `OS/2 fsType = 0x0000`.

What the format requires, and where it is easy to go wrong:

- The font data part — extension `.fntdata`, type `application/x-fontdata`.
  The `.bin` extension cannot be used: it is already taken by `printerSettings`,
  and adding a second `Default` for it is either discarded or overrides someone
  else's type.
- `<p:embeddedFont>` is a container, not a reference. Inside, `<p:font
  typeface="…"/>` is mandatory, and the relationship identifier lives in child
  elements `<p:regular>`, `<p:bold>`, `<p:italic>`, `<p:boldItalic>`. The record
  `<p:embeddedFont r:id="…"/>` is invalid per schema: it has no typeface name
  at all, there is nothing to match the data to text runs, and PowerPoint silently
  ignores the whole list — the bytes sit in the file, but to no effect.
- Weights of one family go as one record: Bold is the `bold` slot inside
  "T-Sans", not a separate nameless record. "T-Sans Medium" is a separate family
  with the `regular` slot, because that is exactly how it is named in text runs.
- The order of elements inside `<p:presentation>` is fixed by the schema:
  `embeddedFontLst` goes after `notesSz` and before `defaultTextStyle`. Appending
  to the end makes the document invalid.

Edits are surgical, text against the source XML: a full pass through ElementTree
would rewrite namespace declarations throughout the document.
"""
import os
import re
import tempfile
import zipfile

from . import fonts

_CT_PATH = '[Content_Types].xml'
_RELS_PATH = 'ppt/_rels/presentation.xml.rels'
_PRES_PATH = 'ppt/presentation.xml'

_FONT_EXT = 'fntdata'
_FONT_CONTENT_TYPE = 'application/x-fontdata'
_FONT_REL_TYPE = ('http://schemas.openxmlformats.org/officeDocument/2006/'
                  'relationships/font')


class FontEmbedError(Exception):
    """Embedding failed. Cannot ignore silently: the file would come out without fonts."""


def font_dir(skill_dir):
    return os.path.join(skill_dir, 'assets', 'fonts', fonts.FONT_DIR_NAME)


def embed_fonts(pptx_path, skill_dir):
    """Embed typefaces into `pptx_path` in place. Returns family names.

    The families are not named here. `fonts.embed_faces` reads them out of the
    font files with the same `face_info` that decides what `render` writes into
    `a:latin`, so the two sides cannot drift apart — this module only has to
    know how to get the bytes into the package.
    """
    try:
        faces = fonts.embed_faces(font_dir(skill_dir))
    except fonts.FontSetError as exc:
        raise FontEmbedError(str(exc))

    temp_path = None
    try:
        with zipfile.ZipFile(pptx_path, 'r') as zin:
            names = set(zin.namelist())
            for required in (_CT_PATH, _RELS_PATH, _PRES_PATH):
                if required not in names:
                    raise FontEmbedError('%s is missing from the pptx' % required)
            content_types = zin.read(_CT_PATH).decode('utf-8')
            rels = zin.read(_RELS_PATH).decode('utf-8')
            presentation = zin.read(_PRES_PATH).decode('utf-8')

            if 'embeddedFontLst' in presentation:
                return _family_order(faces)

            rel_id = _next_rel_id(rels)
            for index, face in enumerate(faces, 1):
                face['part'] = 'ppt/fonts/font%d.%s' % (index, _FONT_EXT)
                face['rel_id'] = 'rId%d' % (rel_id + index - 1)
                with open(face['path'], 'rb') as f:
                    face['data'] = f.read()

            content_types = _add_content_type(content_types)
            rels = _add_relationships(rels, faces)
            presentation = _add_embedded_font_list(presentation, faces)

            rewritten = {_CT_PATH: content_types, _RELS_PATH: rels,
                         _PRES_PATH: presentation}
            # Via a temporary file next to the target: cannot overwrite a zip we are
            # still reading from.
            fd, temp_path = tempfile.mkstemp(
                prefix='.font-embed-', suffix='.tmp',
                dir=os.path.dirname(os.path.abspath(pptx_path)))
            os.close(fd)
            with zipfile.ZipFile(temp_path, 'w', zipfile.ZIP_DEFLATED) as zout:
                for item in zin.infolist():
                    replacement = rewritten.get(item.filename)
                    if replacement is None:
                        zout.writestr(item, zin.read(item.filename))
                    else:
                        zout.writestr(item, replacement.encode('utf-8'))
                for face in faces:
                    zout.writestr(face['part'], face['data'])

        os.replace(temp_path, pptx_path)
    finally:
        if temp_path is not None and os.path.exists(temp_path):
            os.remove(temp_path)

    return _family_order(faces)


def _family_order(faces):
    """Distinct families, in the order `embed_faces` grouped them."""
    order = []
    for face in faces:
        if face['family'] not in order:
            order.append(face['family'])
    return order


def _next_rel_id(rels):
    """Free rId number: take used ones from the relationship file itself."""
    used = [int(n) for n in re.findall(r'Id="rId(\d+)"', rels)]
    return (max(used) + 1) if used else 1


def _add_content_type(xml):
    if 'Extension="%s"' % _FONT_EXT in xml:
        return xml
    entry = '<Default Extension="%s" ContentType="%s"/>' % (
        _FONT_EXT, _FONT_CONTENT_TYPE)
    if '</Types>' not in xml:
        raise FontEmbedError('no </Types> in [Content_Types].xml')
    return xml.replace('</Types>', entry + '</Types>', 1)


def _add_relationships(xml, faces):
    # The path is relative to the source part's directory, and the source part
    # here is `ppt/presentation.xml`, so the base is already `ppt/`. Writing
    # `../fonts/…` would send the link to the package root, where there are no
    # fonts: PowerPoint sees a dangling relationship and declares the file
    # corrupted without showing a single slide. All other relationships in this
    # same file go without `../` — `slideMasters/…`, `theme/theme1.xml`; fonts
    # must look the same.
    entries = ''.join(
        '<Relationship Id="%s" Type="%s" Target="fonts/%s"/>'
        % (face['rel_id'], _FONT_REL_TYPE, os.path.basename(face['part']))
        for face in faces)
    if '</Relationships>' not in xml:
        raise FontEmbedError('no </Relationships> in presentation.xml.rels')
    return xml.replace('</Relationships>', entries + '</Relationships>', 1)


def _add_embedded_font_list(xml, faces):
    by_family = {}
    for face in faces:
        by_family.setdefault(face['family'], []).append(face)

    blocks = []
    for family in _family_order(faces):
        group = by_family[family]
        # PowerPoint writes pitchFamily/charset itself; without them it treats
        # the font as an unknown Cyrillic typeface and more readily substitutes
        # its own.
        parts = ['<p:font typeface="%s" pitchFamily="34" charset="0"/>'
                 % _escape(family)]
        for face in group:
            parts.append('<p:%s r:id="%s"/>' % (face['slot'], face['rel_id']))
        blocks.append('<p:embeddedFont>%s</p:embeddedFont>' % ''.join(parts))
    block = '<p:embeddedFontLst>%s</p:embeddedFontLst>' % ''.join(blocks)

    # Schema requires the list after notesSz and before defaultTextStyle.
    anchor = re.search(r'<p:notesSz\b[^>]*/>', xml)
    if anchor:
        cut = anchor.end()
    else:
        tail = re.search(r'<p:defaultTextStyle\b', xml)
        if not tail:
            raise FontEmbedError(
                'neither p:notesSz nor p:defaultTextStyle found - cannot place '
                'embeddedFontLst in schema order')
        cut = tail.start()
    xml = xml[:cut] + block + xml[cut:]

    # Flag by which PowerPoint marks files with embedded fonts.
    if 'embedTrueTypeFonts=' not in xml:
        xml = re.sub(r'(<p:presentation\b[^>]*?)(\s*>)',
                     r'\1 embedTrueTypeFonts="1"\2', xml, count=1)
    return xml


def _escape(text):
    return (text.replace('&', '&amp;').replace('<', '&lt;')
                .replace('>', '&gt;').replace('"', '&quot;'))
