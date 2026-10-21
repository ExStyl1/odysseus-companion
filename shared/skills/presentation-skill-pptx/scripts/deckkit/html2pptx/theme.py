# -*- coding: utf-8 -*-
"""Write the brand colour scheme into the finished PPTX.

Why. The package is assembled on top of the default template that ships inside
python-pptx, and its theme is Office 2007: `4F81BD` blue, `C0504D` red, the
whole set. Nothing on our slides reads it — every shape is painted with a
direct `srgbClr` taken from `assets/base.css`, and there is no `schemeClr`
reference anywhere in the code — so the wrong theme is invisible until the
reader opens the colour dropdown, where «Цвета темы» offers ten colours from
another company. Anything they then draw by hand lands in those colours.

So this changes the gallery and the reader's own objects, and it changes
nothing about the deck. That is the whole scope; a slide that comes out the
wrong colour is a `base.css` question, not this module's.

The colours live in `assets/theme-colors.json`, not here: a palette is a
design value like the type ladder in `assets/typography.json`, and the
repository's rule is that colours are never hardcoded in Python.

Edits are surgical, text against the source XML, for the same reason as in
`font_embed.py`: a full ElementTree pass would rewrite namespace declarations
across the document.
"""
import json
import os
import re
import tempfile
import zipfile

_THEME_DIR = 'ppt/theme/'

# Fixed by the schema, and not the order PowerPoint shows them in — see
# `_gallery_order` in the JSON. All twelve are required; a scheme missing a
# slot makes the file invalid.
_SLOTS = ('dk1', 'lt1', 'dk2', 'lt2',
          'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6',
          'hlink', 'folHlink')

_HEX = re.compile(r'^[0-9A-F]{6}$')
_SCHEME = re.compile(r'<a:clrScheme\b.*?</a:clrScheme>', re.S)
_ACCENT = re.compile(r'<a:(accent[1-6])><a:srgbClr val="([0-9A-F]{6})"/>')


class ThemeError(Exception):
    """Applying the scheme failed. Not ignorable: the file looks intact and
    hands the reader another company's palette."""


def palette_path(skill_dir):
    return os.path.join(skill_dir, 'assets', 'theme-colors.json')


def load_palette(skill_dir):
    """Read the palette. Returns (scheme name, {slot: RRGGBB}).

    Everything is checked here rather than at the XML: a malformed colour
    reaches PowerPoint as a corrupt file with no indication of which slot.
    """
    path = palette_path(skill_dir)
    try:
        with open(path, 'r', encoding='utf-8') as f:
            data = json.load(f)
    except (IOError, OSError) as exc:
        raise ThemeError('cannot read %s: %s' % (path, exc))
    except ValueError as exc:
        raise ThemeError('%s is not valid JSON: %s' % (path, exc))

    name = data.get('name')
    if not name:
        raise ThemeError('%s has no "name" for the colour scheme' % path)
    scheme = data.get('scheme')
    if not isinstance(scheme, dict):
        raise ThemeError('%s has no "scheme" object' % path)

    missing = [slot for slot in _SLOTS if slot not in scheme]
    extra = [slot for slot in scheme if slot not in _SLOTS]
    if missing or extra:
        raise ThemeError(
            '%s: the scheme must name exactly the twelve slots%s%s' % (
                path,
                missing and (', missing: ' + ', '.join(missing)) or '',
                extra and (', unknown: ' + ', '.join(sorted(extra))) or ''))
    for slot in _SLOTS:
        value = scheme[slot]
        if not isinstance(value, str) or not _HEX.match(value):
            raise ThemeError(
                '%s: %s is %r, expected six uppercase hex digits without "#"'
                % (path, slot, value))
    return name, dict(scheme)


def apply_theme_colors(pptx_path, skill_dir):
    """Replace the colour scheme of every theme part in place, a chart's
    theme override included (keeping its accents). Returns the name."""
    name, colours = load_palette(skill_dir)
    block = _scheme_xml(name, colours)

    # Via a temporary file next to the target: cannot overwrite a zip we
    # are still reading from, and os.replace is only atomic within one
    # filesystem. A unique name rather than a fixed `.themetmp`, so two
    # builds writing the same path cannot land in each other's file.
    handle, temp_path = tempfile.mkstemp(
        prefix='.theme-', suffix='.tmp', dir=os.path.dirname(pptx_path)
        or '.')
    os.close(handle)
    try:
        with zipfile.ZipFile(pptx_path, 'r') as zin:
            parts = [n for n in zin.namelist()
                     if n.startswith(_THEME_DIR) and n.endswith('.xml')]
            if not parts:
                raise ThemeError('no theme part in %s' % pptx_path)

            rewritten = {}
            for part in parts:
                xml = zin.read(part).decode('utf-8')
                scheme = block
                if 'themeOverride' in part:
                    # A chart's own theme (chartstyle._theme_override): its
                    # accents are that chart's palette, the rest is the brand's.
                    own = dict(colours)
                    own.update(_ACCENT.findall(xml))
                    scheme = _scheme_xml(name, own)
                # A lambda, not the string: a replacement is scanned for group
                # references, and a palette is not the place to find out.
                new_xml, count = _SCHEME.subn(lambda m: scheme, xml, count=1)
                if count != 1:
                    raise ThemeError('no a:clrScheme in %s' % part)
                rewritten[part] = new_xml

            with zipfile.ZipFile(temp_path, 'w', zipfile.ZIP_DEFLATED) as zout:
                for item in zin.infolist():
                    replacement = rewritten.get(item.filename)
                    if replacement is None:
                        zout.writestr(item, zin.read(item.filename))
                    else:
                        zout.writestr(item, replacement.encode('utf-8'))
        # Close the source archive before replacing it. Windows may reject
        # replacing a file while this process still has its ZIP handle open.
        os.replace(temp_path, pptx_path)
    except BaseException:
        # Otherwise a half-written archive is left sitting beside the
        # author's deck, named like a stray copy of it.
        try:
            os.unlink(temp_path)
        except OSError:
            pass
        raise
    return name


def _scheme_xml(name, colours):
    # The default template writes dk1/lt1 as `sysClr` — the reader's window and
    # window-text colours. Ours are brand values, so all twelve go as srgbClr.
    body = ''.join('<a:%s><a:srgbClr val="%s"/></a:%s>'
                   % (slot, colours[slot], slot) for slot in _SLOTS)
    return '<a:clrScheme name="%s">%s</a:clrScheme>' % (_escape(name), body)


def _escape(text):
    return (text.replace('&', '&amp;').replace('<', '&lt;')
                .replace('>', '&gt;').replace('"', '&quot;'))
