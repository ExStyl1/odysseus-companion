# -*- coding: utf-8 -*-
"""One HTML file, parsed once, with the engine that lays it out.

Everything downstream of the markup wants the same four things from a deck: the
parsed document, the stylesheet, the font metrics, and the box tree of each
slide. Until v1.5 four modules built all four for themselves — the size search,
the validator, the PPTX writer and the PNG preview — six identical lines apiece,
and three of them imported the pieces out of `convert.py`, which never meant to
hand them out; one reached for `_autodetect_css`, private by its own name.

The cost was not only the duplication. Each copy re-read the file, so a build
laid the same deck out three times and threw two of the measurements away: once
to pick the type sizes, once to validate, once to render. The sizes it picked
were discarded too, which is why the self-test used to re-run the size search on
already-fitted HTML to find out what the build had decided.

So the document is what gets handed on, not the path. `Document.open` does the
setup once; `box()` lays a slide out once and remembers it; `measure()` is the
uncached form the size search needs, because it asks the same slide the same
question at every step of the ladder.

Styles change only through `set_style`. The size search rewrites inline sizes
at every step of the ladder, and each rewrite has to reach two caches — the
stylesheet's declared properties for that node and the kept box trees — or
the next reader gets the layout of a step that was already abandoned. Until
2.1 the search reached into `sheet` and cleared both itself, eight calls in
all; one missed call and the validator would have read the last size tried
rather than the one kept. Now the document clears them, so a stale layout
cannot be asked for.

The file on disk stays authoritative in the one way that matters: `save()`
writes the tree back, and the build calls it right after the size search, so
the HTML a reader opens carries the sizes the PPTX carries.
"""
import logging
import os

from lxml import etree
from lxml import html as lhtml

from .assets import AssetResolver
from .cssparse import Stylesheet
from .layout import LayoutEngine
from .textmeasure import FontBook

log = logging.getLogger(__name__)

# Where to look for base.css when the input has no <link rel="stylesheet">.
# That is how the layout fragments in assets/layouts/*.html work: they are cut
# out of the template and inherit its stylesheet by convention, not by markup.
_CSS_CANDIDATES = (
    'base.css',
    '../base.css',
    'assets/base.css',
    '../assets/base.css',
)


def parse_html(path):
    """Parse HTML, forcibly treating it as UTF-8.

    Layout fragments (`assets/layouts/*.html`) contain no `<meta charset>`, and
    lxml by default treats them as windows-1252 — Cyrillic turns into
    'Ð'Ð»Ð¾Ðº'. Encoding is set explicitly: HTML5 prescribes UTF-8 anyway.
    """
    with open(path, 'rb') as f:
        raw = f.read()
    try:
        text = raw.decode('utf-8')
    except UnicodeDecodeError:
        log.warning('[WARN] file not in UTF-8, reading as cp1251: %s', path)
        text = raw.decode('cp1251', errors='replace')
    return lhtml.fromstring(text)


def find_slides(doc):
    """All elements with class `slide` (the class itself, not `slide__number`)."""
    return doc.xpath(
        "//*[contains(concat(' ', normalize-space(@class), ' '), ' slide ')]")


def autodetect_css(base_dir):
    """base.css next to a file that does not link one. None if there is none."""
    for rel in _CSS_CANDIDATES:
        path = os.path.normpath(os.path.join(base_dir, rel))
        if os.path.isfile(path):
            return path
    return None


class Document(object):
    """An open HTML deck: the tree, the engine stack, and the laid-out slides."""

    __slots__ = ('path', 'base_dir', 'fonts', 'elements', 'css_dirs', '_doc',
                 '_sheet', '_engine', '_body_style', '_boxes')

    def __init__(self, path, doc, sheet, fonts, engine, body_style, elements,
                 css_dirs):
        self.path = path
        self.base_dir = os.path.dirname(os.path.abspath(path)) if path else '.'
        self.fonts = fonts
        self.elements = elements
        self.css_dirs = css_dirs
        self._doc = doc
        self._sheet = sheet
        self._engine = engine
        self._body_style = body_style
        self._boxes = {}

    @classmethod
    def open(cls, path, extra_dirs=(), extra_css=None):
        """Parse a file and build everything needed to lay its slides out.

        `extra_dirs` are extra roots for the font search: the deck can be
        written anywhere, while the typefaces live in the skill. The stylesheet
        directories are added to that search on their own, so a caller that
        knows nothing about the skill still finds the fonts through base.css.
        """
        path = os.path.abspath(path)
        if not os.path.isfile(path):
            raise FileNotFoundError(path)

        base_dir = os.path.dirname(path)
        doc = parse_html(path)

        sheet = Stylesheet.from_document(doc, base_dir)
        if not sheet.sources or extra_css:
            css_path = extra_css or autodetect_css(base_dir)
            if css_path:
                sheet.add_file(css_path)
            else:
                log.warning('[WARN] base.css not found — '
                            'layout will use inline styles only')

        css_dirs = [os.path.dirname(p) for p in sheet.sources
                    if isinstance(p, str) and os.path.isfile(p)]
        fonts = FontBook(base_dir, [d for d in extra_dirs if d] + css_dirs)
        engine = LayoutEngine(sheet, fonts)

        # Body styles are inherited by the slides — the T-Sans family is set there.
        body = doc.find('.//body')
        body_style = sheet.computed(body) if body is not None else None

        return cls(path, doc, sheet, fonts, engine, body_style,
                   find_slides(doc), css_dirs)

    # ------------------------------------------------------------ measuring

    def measure(self, element):
        """Lay one element out and return its box tree. Never cached.

        The size search calls this repeatedly on the same slide, once per step
        of the ladder, so caching here would hand it the first step's layout
        every time — the exact failure `Stylesheet.invalidate` exists to avoid.
        """
        root = self._engine.build(element, self._body_style)
        self._engine.layout_slide(root)
        return root

    def box(self, index):
        """Box tree of slide `index` (1-based), laid out once and kept.

        Per slide rather than all at once because the preview usually wants
        two of them out of twenty, and laying out the other eighteen to throw
        them away is most of its running time.
        """
        if index not in self._boxes:
            self._boxes[index] = self.measure(self.elements[index - 1])
        return self._boxes[index]

    def boxes(self):
        """Box trees of every slide, in document order."""
        return [self.box(i) for i in range(1, len(self.elements) + 1)]

    # ------------------------------------------------------------ editing

    def set_style(self, element, prop, value):
        """Set one inline CSS property on an element, keeping the rest.

        The stylesheet forgets what it declared for the element and the kept
        box trees are dropped, so whatever is measured next is measured at
        the new value — there is no separate step for a caller to forget.
        """
        kept = []
        for chunk in (element.get('style') or '').split(';'):
            name = chunk.partition(':')[0].strip()
            if not name or name == prop:
                continue
            kept.append(chunk.strip())
        kept.append('%s: %s' % (prop, value))
        element.set('style', '; '.join(kept) + ';')
        self._sheet.invalidate(element)
        self._boxes = {}

    def set_attribute(self, element, name, value):
        """Set any other attribute - a class, a chart's `data-chart`.

        A class reaches the computed style of every descendant, so the whole
        stylesheet cache goes, with the kept box trees.
        """
        element.set(name, value)
        self._sheet.invalidate()
        self._boxes = {}

    # ------------------------------------------------------------ output

    def assets(self, cache_dir):
        """Asset resolver for this document's directory and stylesheets."""
        return AssetResolver(self.base_dir, cache_dir, self.css_dirs)

    def save(self, path=None):
        """Write the tree back to disk. Returns the path written."""
        target = path or self.path
        with open(target, 'wb') as f:
            f.write(etree.tostring(self._doc, encoding='utf-8', method='html',
                                   doctype='<!DOCTYPE html>'))
        return target

    def __repr__(self):
        return 'Document(%s, %d slides)' % (os.path.basename(self.path or '?'),
                                            len(self.elements))
